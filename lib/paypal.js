// Minimal PayPal REST client (Orders v2 + Payments v2) using fetch. Sandbox by default.
const crypto = require('crypto');

const BASE =
  process.env.PAYPAL_API_BASE ||
  (process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

// PAYPAL_MOCK=1: simulated PayPal (no network, no real money, no PayPal account needed).
// Used only when sandbox credentials are unavailable; the UI and README label it clearly as SIMULATED.
const MOCK = () => process.env.PAYPAL_MOCK === '1';
const mockOrders = new Map();

let tokenCache = { value: null, exp: 0 };

async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.exp - 30000) return tokenCache.value;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${data.error_description || data.error || 'unknown'}`);
  tokenCache = { value: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return tokenCache.value;
}

async function api(method, path, body) {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': crypto.randomUUID(),
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.details?.map((d) => d.description || d.issue).join('; ');
    const err = new Error(`PayPal ${method} ${path} failed (${res.status}): ${data.message || data.name || ''} ${detail || ''}`.trim());
    err.status = res.status;
    err.issue = data.details?.[0]?.issue || data.name;
    throw err;
  }
  return data;
}

const money = (cents, currency) => ({ currency_code: currency, value: (cents / 100).toFixed(2) });

async function createOrder({ referenceId, customer, currency, items, subtotalCents, taxCents, totalCents, note, baseUrl }) {
  if (MOCK()) {
    const id = 'SIM-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    mockOrders.set(id, { status: 'PAYER_ACTION_REQUIRED' });
    return { id, status: 'PAYER_ACTION_REQUIRED', approveUrl: `${baseUrl}/mock-paypal?token=${id}` };
  }
  const order = await api('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: referenceId,
        description: (note || `Payment request for ${customer}`).slice(0, 127),
        amount: {
          ...money(totalCents, currency),
          breakdown: {
            item_total: money(subtotalCents, currency),
            tax_total: money(taxCents, currency),
          },
        },
        items: items.map((i) => ({
          name: i.name.slice(0, 127),
          quantity: String(i.quantity),
          unit_amount: money(i.unitCents, currency),
          category: 'DIGITAL_GOODS',
        })),
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'AI Checkout Agent',
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: `${baseUrl}/return`,
          cancel_url: `${baseUrl}/cancel`,
        },
      },
    },
  });
  const link = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  return { id: order.id, status: order.status, approveUrl: link?.href };
}

const getOrder = async (id) => {
  if (MOCK()) {
    const o = mockOrders.get(id);
    return { id, status: o ? o.status : 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'SIMCAP-' + id }] } }] };
  }
  return api('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`);
};

async function captureOrder(id) {
  if (MOCK()) {
    mockOrders.set(id, { status: 'COMPLETED' });
    return { status: 'COMPLETED', captureId: 'SIMCAP-' + id, payerEmail: 'simulated-buyer@example.com', payerName: 'Sam' };
  }
  const r = await api('POST', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {});
  const cap = r.purchase_units?.[0]?.payments?.captures?.[0];
  return { status: r.status, captureId: cap?.id, payerEmail: r.payer?.email_address, payerName: r.payer?.name?.given_name };
}

async function refundCapture(captureId, cents, currency, note) {
  if (MOCK()) return { id: 'SIMREF-' + crypto.randomBytes(4).toString('hex').toUpperCase(), status: 'COMPLETED' };
  const r = await api('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    amount: money(cents, currency),
    note_to_payer: (note || 'Refund').slice(0, 255),
  });
  return { id: r.id, status: r.status };
}

module.exports = { createOrder, getOrder, captureOrder, refundCapture, BASE, MOCK };
