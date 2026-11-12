// End-to-end test against local mocks of the Anthropic and PayPal APIs (no keys or network needed).
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let orderN = 0;
const orders = {};
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const body = raw && raw.startsWith('{') ? JSON.parse(raw) : {};
    const url = req.url;
    // ---- PayPal mock ----
    if (url === '/v1/oauth2/token') return send(200, { access_token: 't', expires_in: 3600 });
    if (url === '/v2/checkout/orders' && req.method === 'POST') {
      const id = 'ORD' + ++orderN;
      const pu = body.purchase_units[0];
      const sum = Number(pu.amount.breakdown.item_total.value) + Number(pu.amount.breakdown.tax_total.value);
      assert.strictEqual(sum.toFixed(2), pu.amount.value, 'breakdown must add up to total');
      orders[id] = { id, status: 'PAYER_ACTION_REQUIRED', body };
      return send(201, { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://sandbox.paypal.com/checkoutnow?token=${id}` }] });
    }
    let m;
    if ((m = url.match(/^\/v2\/checkout\/orders\/(\w+)\/capture$/))) {
      orders[m[1]].status = 'COMPLETED';
      return send(201, { status: 'COMPLETED', payer: { email_address: 'buyer@example.com', name: { given_name: 'Pat' } }, purchase_units: [{ payments: { captures: [{ id: 'CAP_' + m[1] }] } }] });
    }
    if ((m = url.match(/^\/v2\/checkout\/orders\/(\w+)$/))) return send(200, { id: m[1], status: orders[m[1]].status, purchase_units: [{ payments: { captures: [{ id: 'CAP_' + m[1] }] } }] });
    if (url.match(/^\/v2\/payments\/captures\/\w+\/refund$/)) return send(201, { id: 'REF1', status: 'COMPLETED' });
    // ---- AI mock (OpenAI-compatible chat completions) ----
    if (url === '/chat/completions') {
      const reply = (message) => send(200, { choices: [{ message: { role: 'assistant', ...message } }] });
      if (!body.tools) return reply({ content: 'Thanks Pat, your payment of 583.20 USD for logo design was received.' });
      const last = body.messages[body.messages.length - 1];
      if (last.role === 'tool') return reply({ content: 'All done.' });
      const t = last.content;
      let call;
      if (t.startsWith('huge')) call = { name: 'create_checkout', input: { customer_name: 'Big Co', currency: 'USD', items: [{ name: 'Gold', quantity: 1, unit_price: 99999 }] } };
      else if (t.startsWith('bill')) call = { name: 'create_checkout', input: { customer_name: 'Acme Co', currency: 'USD', items: [{ name: 'Logo design', quantity: 1, unit_price: 450 }, { name: 'Revision', quantity: 2, unit_price: 45 }], tax_percent: 8 } };
      else if (t.startsWith('refund')) call = { name: 'request_refund', input: { order_id: t.split(' ')[1], amount: 100, reason: 'unhappy' } };
      else call = { name: 'revenue_summary', input: {} };
      return reply({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] });
    }
    send(404, { error: 'nope' });
  });
});

(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;
  Object.assign(process.env, {
    PAYPAL_API_BASE: mockUrl, AI_BASE_URL: mockUrl, PAYPAL_CLIENT_ID: 'x', PAYPAL_CLIENT_SECRET: 'y',
    AI_API_KEY: 'z', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), MAX_CHECKOUT_USD: '5000', BASE_URL: 'http://localhost:3000',
  });
  const app = require('../server');
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const ledger = () => fetch(base + '/api/ledger').then((r) => r.json());
  const ok = (name) => console.log('  ✓', name);

  // 1. agent creates a checkout; server computes totals (450 + 90 = 540, 8% tax = 43.20)
  let r = await post('/api/agent', { messages: [{ role: 'user', content: 'bill Acme' }] });
  assert.strictEqual(r.status, 200);
  const c = r.body.calls[0];
  assert.strictEqual(c.name, 'create_checkout');
  assert.strictEqual(c.result.total, '583.20');
  assert.ok(c.result.approve_url.includes('ORD1'));
  ok('create_checkout computes totals server-side and returns PayPal link');

  // 2. guardrail
  r = await post('/api/agent', { messages: [{ role: 'user', content: 'huge' }] });
  assert.ok(r.body.calls[0].error && /Policy/.test(r.body.calls[0].result.error));
  ok('spending policy blocks oversized checkout');

  // 3. buyer returns from PayPal -> capture + AI receipt
  const ret = await fetch(`${base}/return?token=ORD1&PayerID=P`, { redirect: 'manual' });
  assert.strictEqual(ret.status, 302);
  assert.ok(ret.headers.get('location').startsWith('/?paid=ORD1'));
  let l = await ledger();
  assert.strictEqual(l.payments[0].status, 'PAID');
  assert.ok(l.payments[0].receipt.includes('received'));
  ok('return route captures payment and stores AI-written receipt');

  // 4. refund requires human approval
  r = await post('/api/agent', { messages: [{ role: 'user', content: 'refund ORD1' }] });
  assert.strictEqual(r.body.calls[0].result.status, 'PENDING_HUMAN_APPROVAL');
  l = await ledger();
  assert.strictEqual(l.payments[0].refundedCents, 0);
  assert.strictEqual(l.approvals[0].status, 'PENDING');
  ok('refund request is held for approval (nothing refunded yet)');

  // 5. human approves -> refund executes
  r = await post(`/api/approvals/${l.approvals[0].id}/approve`, {});
  assert.strictEqual(r.body.status, 'APPROVED');
  l = await ledger();
  assert.strictEqual(l.payments[0].status, 'PARTIALLY_REFUNDED');
  assert.strictEqual(l.payments[0].refundedCents, 10000);
  assert.strictEqual(l.summary.by_currency.USD.net, '483.20');
  ok('approval executes PayPal refund; ledger and summary update');

  // 6. double approval blocked
  r = await post(`/api/approvals/${l.approvals[0].id}/approve`, {});
  assert.strictEqual(r.status, 409);
  ok('approvals cannot be replayed');

  srv.close(); mock.close();
  console.log('\nAll tests passed');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
