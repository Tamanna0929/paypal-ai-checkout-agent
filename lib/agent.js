// LLM tool-use agent that operates PayPal on the user's behalf, with server-side guardrails.
const crypto = require('crypto');
const store = require('./store');
const paypal = require('./paypal');

// Any OpenAI-compatible chat-completions API works (Gemini free tier by default; also Groq, OpenRouter, OpenAI...).
const API = () => (process.env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
const MODEL = () => process.env.AI_MODEL || 'gemini-flash-latest';
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'];
const MAX_CHECKOUT_CENTS = () => Math.round(Number(process.env.MAX_CHECKOUT_USD || 5000) * 100);
const baseUrl = () => process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

const SYSTEM = () => `You are the AI Checkout Agent: a careful finance assistant for a freelancer or small business, operating a PayPal sandbox account through tools.

Rules:
- Never invent amounts, customers or order IDs. If a price, customer or currency is missing, ask one short question instead of guessing (default currency is USD only if the user doesn't say).
- Use create_checkout to bill someone. You supply item names, quantities and unit prices; the server computes totals and tax.
- To find an order ID, call list_payments first. Never guess an ID.
- Refunds NEVER execute immediately. request_refund only files a request that a human must approve in the UI. Tell the user it is waiting for their approval.
- For questions about revenue, outstanding invoices, or advice, call revenue_summary and/or list_payments, then answer with concrete numbers and one or two actionable insights.
- You may call several tools in one turn (e.g. bill three clients). Keep replies short and plain. Show amounts with currency codes.
Today is ${new Date().toISOString().slice(0, 10)}.`;

const TOOLS = [
  {
    name: 'create_checkout',
    description: 'Create a real PayPal sandbox checkout for a customer. Returns an approve_url the customer opens to pay.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string' },
        currency: { type: 'string', enum: CURRENCIES },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              quantity: { type: 'integer', minimum: 1 },
              unit_price: { type: 'number', description: 'Price per unit in the major currency unit, e.g. 450.00' },
            },
            required: ['name', 'quantity', 'unit_price'],
          },
        },
        tax_percent: { type: 'number', minimum: 0, maximum: 50 },
        note: { type: 'string', description: 'Short description shown on the PayPal checkout' },
      },
      required: ['customer_name', 'currency', 'items'],
    },
  },
  {
    name: 'list_payments',
    description: 'List payment requests in the ledger (newest first). Statuses: CREATED (unpaid), PAID, PARTIALLY_REFUNDED, REFUNDED.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['CREATED', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
        customer: { type: 'string', description: 'Case-insensitive substring match' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: 'check_payment_status',
    description: 'Fetch the live status of an order from PayPal and sync the ledger.',
    input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
  },
  {
    name: 'request_refund',
    description: 'File a refund request for a PAID order. It will NOT execute until a human approves it in the UI.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        amount: { type: 'number', description: 'Amount to refund; omit for the full remaining amount' },
        reason: { type: 'string' },
      },
      required: ['order_id', 'reason'],
    },
  },
  {
    name: 'revenue_summary',
    description: 'Aggregate stats: counts by status, paid/outstanding/refunded/net by currency, top customers, last 14 days.',
    input_schema: { type: 'object', properties: {} },
  },
];

const view = (p) => ({
  order_id: p.id,
  customer: p.customer,
  status: p.status,
  currency: p.currency,
  total: store.fmt(p.totalCents),
  refunded: store.fmt(p.refundedCents || 0),
  items: p.items.map((i) => `${i.quantity} x ${i.name} @ ${store.fmt(i.unitCents)}`),
  created: p.createdAt,
  paid: p.paidAt || null,
});

async function runTool(name, input) {
  switch (name) {
    case 'create_checkout': {
      const currency = String(input.currency || 'USD').toUpperCase();
      if (!CURRENCIES.includes(currency)) throw new Error(`Unsupported currency ${currency}. Use one of ${CURRENCIES.join(', ')}.`);
      if (!input.customer_name?.trim()) throw new Error('customer_name is required');
      if (!Array.isArray(input.items) || !input.items.length) throw new Error('At least one item is required');
      const items = input.items.map((i) => {
        const quantity = Math.floor(Number(i.quantity));
        const unitCents = store.cents(i.unit_price);
        if (!i.name || !(quantity >= 1) || !(unitCents > 0)) throw new Error(`Invalid item: ${JSON.stringify(i)}`);
        return { name: String(i.name), quantity, unitCents };
      });
      const subtotalCents = items.reduce((s, i) => s + i.unitCents * i.quantity, 0);
      const taxPct = Math.min(Math.max(Number(input.tax_percent) || 0, 0), 50);
      const taxCents = Math.round((subtotalCents * taxPct) / 100);
      const totalCents = subtotalCents + taxCents;
      if (totalCents > MAX_CHECKOUT_CENTS()) {
        throw new Error(`Policy: a single checkout may not exceed ${store.fmt(MAX_CHECKOUT_CENTS())} (MAX_CHECKOUT_USD). Total was ${store.fmt(totalCents)}.`);
      }
      const order = await paypal.createOrder({
        referenceId: crypto.randomUUID().slice(0, 8),
        customer: input.customer_name,
        currency, items, subtotalCents, taxCents, totalCents,
        note: input.note, baseUrl: baseUrl(),
      });
      if (!order.approveUrl) throw new Error('PayPal did not return an approval link');
      const p = store.addPayment({
        id: order.id, customer: input.customer_name.trim(), currency, items,
        subtotalCents, taxCents, taxPercent: taxPct, totalCents, note: input.note || '',
        status: 'CREATED', approveUrl: order.approveUrl, refundedCents: 0,
        createdAt: new Date().toISOString(),
      });
      return { ...view(p), subtotal: store.fmt(subtotalCents), tax: store.fmt(taxCents), approve_url: order.approveUrl };
    }
    case 'list_payments': {
      let list = store.payments();
      if (input.status) list = list.filter((p) => p.status === input.status);
      if (input.customer) list = list.filter((p) => p.customer.toLowerCase().includes(String(input.customer).toLowerCase()));
      return { count: list.length, payments: list.slice(0, input.limit || 20).map(view) };
    }
    case 'check_payment_status': {
      const p = store.getPayment(input.order_id);
      if (!p) throw new Error(`No order ${input.order_id} in the ledger`);
      const live = await paypal.getOrder(p.id);
      if (live.status === 'COMPLETED' && p.status === 'CREATED') {
        const cap = live.purchase_units?.[0]?.payments?.captures?.[0];
        store.updatePayment(p.id, { status: 'PAID', captureId: cap?.id, paidAt: new Date().toISOString() });
      }
      return { paypal_status: live.status, ledger: view(store.getPayment(p.id)) };
    }
    case 'request_refund': {
      const p = store.getPayment(input.order_id);
      if (!p) throw new Error(`No order ${input.order_id} in the ledger`);
      if (!['PAID', 'PARTIALLY_REFUNDED'].includes(p.status) || !p.captureId) throw new Error(`Order ${p.id} is ${p.status}; only paid orders can be refunded`);
      const remaining = p.totalCents - (p.refundedCents || 0);
      const amountCents = input.amount ? store.cents(input.amount) : remaining;
      if (!(amountCents > 0) || amountCents > remaining) throw new Error(`Refund must be between 0.01 and ${store.fmt(remaining)} ${p.currency}`);
      const a = store.addApproval({
        id: crypto.randomUUID().slice(0, 8), type: 'refund', orderId: p.id, customer: p.customer,
        currency: p.currency, amountCents, reason: input.reason, status: 'PENDING', createdAt: new Date().toISOString(),
      });
      return { status: 'PENDING_HUMAN_APPROVAL', approval_id: a.id, amount: store.fmt(amountCents), currency: p.currency };
    }
    case 'revenue_summary':
      return store.summary();
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

const toolDefs = () =>
  TOOLS.map((t) => {
    const fn = { name: t.name, description: t.description };
    if (Object.keys(t.input_schema.properties || {}).length) fn.parameters = t.input_schema; // some providers reject empty schemas
    return { type: 'function', function: fn };
  });

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Calls the model; retries transient errors (e.g. 503 "high demand") and falls back to backup models.
async function llm(body) {
  const key = process.env.AI_API_KEY;
  if (!key) throw new Error('AI_API_KEY is not set');
  const fallbacks = (process.env.AI_FALLBACK_MODELS || 'gemini-flash-lite-latest,gemini-2.5-flash').split(',').map((m) => m.trim()).filter(Boolean);
  const models = [...new Set([MODEL(), ...fallbacks])];
  const delay = Number(process.env.AI_RETRY_DELAY_MS || 1500);
  let lastErr;
  for (const [mi, model] of models.entries()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let res, data;
      try {
        res = await fetch(`${API()}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ max_tokens: 1500, temperature: 0.2, ...body, model }),
        });
        data = await res.json().catch(() => ({}));
      } catch (e) {
        lastErr = new Error(`AI API network error: ${e.message}`);
        await sleep(delay * (attempt + 1));
        continue;
      }
      if (res.ok) return data.choices[0].message;
      const e = Array.isArray(data) ? data[0]?.error : data.error;
      lastErr = new Error(`AI API error (${res.status}): ${e?.message || JSON.stringify(data).slice(0, 200)}`);
      if (RETRYABLE.has(res.status)) {
        await sleep(delay * (attempt + 1));
        continue; // retry same model
      }
      if (mi === 0 && res.status !== 404) throw lastErr; // real error on the main model (bad key, bad request): don't mask it
      break; // unknown/unavailable fallback model: try the next one
    }
  }
  throw lastErr;
}

// history: [{role:'user'|'assistant', content:string}, ...]; last item is the new user message.
async function chat(history) {
  const messages = [{ role: 'system', content: SYSTEM() }, ...history.slice(-12).map((m) => ({ role: m.role, content: String(m.content) }))];
  const calls = [];
  for (let step = 0; step < 8; step++) {
    const msg = await llm({ messages, tools: toolDefs() });
    const toolCalls = msg.tool_calls || [];
    messages.push(msg);
    if (!toolCalls.length) return { reply: (msg.content || '').trim() || 'Done.', calls };
    for (const [i, tc] of toolCalls.entries()) {
      const id = tc.id || `call_${step}_${i}`;
      tc.id = id;
      let input = {}, result, isError = false;
      try {
        input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        result = await runTool(tc.function.name, input);
      } catch (e) {
        result = { error: e.message };
        isError = true;
      }
      calls.push({ name: tc.function.name, input, result, error: isError });
      messages.push({ role: 'tool', tool_call_id: id, name: tc.function.name, content: JSON.stringify(result) });
    }
  }
  return { reply: 'I hit my step limit for this request. Please try a smaller request.', calls };
}

async function writeReceipt(p, payerName) {
  const fallback = `Thanks${payerName ? ', ' + payerName : ''}! We received your payment of ${store.fmt(p.totalCents)} ${p.currency} (order ${p.id}).`;
  try {
    const msg = await llm({
      max_tokens: 200,
      messages: [
        { role: 'system', content: 'Write a warm, concise (2-3 sentences) payment receipt message from a small business. Plain text, no markdown, no emojis. Mention the amount and what was purchased.' },
        { role: 'user', content: `Customer: ${payerName || p.customer}\nAmount: ${store.fmt(p.totalCents)} ${p.currency}\nItems: ${p.items.map((i) => `${i.quantity} x ${i.name}`).join(', ')}\nOrder: ${p.id}` },
      ],
    });
    return (msg.content || '').trim() || fallback;
  } catch {
    return fallback;
  }
}

module.exports = { chat, writeReceipt, TOOLS };
