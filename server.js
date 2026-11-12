require('dotenv').config();
const path = require('path');
const express = require('express');
const store = require('./lib/store');
const paypal = require('./lib/paypal');
const agent = require('./lib/agent');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(500).json({ error: e.message });
  });

app.get('/api/health', (req, res) =>
  res.json({
    ok: true,
    paypal_base: paypal.MOCK() ? 'SIMULATED' : paypal.BASE,
    paypal_mock: paypal.MOCK(),
    paypal_configured: paypal.MOCK() || Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
    ai_configured: Boolean(process.env.AI_API_KEY),
  })
);

// Chat with the agent. Body: { messages: [{role, content}] }
app.post('/api/agent', wrap(async (req, res) => {
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || !messages.length || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'messages must end with a user message' });
  }
  res.json(await agent.chat(messages));
}));

app.get('/api/ledger', (req, res) => {
  res.json({
    payments: store.payments(),
    approvals: store.approvals(),
    summary: store.summary(),
  });
});

// Human-in-the-loop gate for money leaving the account.
app.post('/api/approvals/:id/:decision', wrap(async (req, res) => {
  const a = store.getApproval(req.params.id);
  if (!a) return res.status(404).json({ error: 'Approval not found' });
  if (a.status !== 'PENDING') return res.status(409).json({ error: `Already ${a.status}` });
  if (req.params.decision === 'reject') {
    return res.json(store.updateApproval(a.id, { status: 'REJECTED', decidedAt: new Date().toISOString() }));
  }
  if (req.params.decision !== 'approve') return res.status(400).json({ error: 'decision must be approve or reject' });

  const p = store.getPayment(a.orderId);
  try {
    const r = await paypal.refundCapture(p.captureId, a.amountCents, p.currency, a.reason);
    const refunded = (p.refundedCents || 0) + a.amountCents;
    store.updatePayment(p.id, {
      refundedCents: refunded,
      status: refunded >= p.totalCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
    });
    res.json(store.updateApproval(a.id, { status: 'APPROVED', decidedAt: new Date().toISOString(), result: r }));
  } catch (e) {
    store.updateApproval(a.id, { status: 'FAILED', decidedAt: new Date().toISOString(), result: { error: e.message } });
    res.status(502).json({ error: e.message });
  }
}));

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Simulated PayPal approval page (only when PAYPAL_MOCK=1). Not PayPal; clearly labelled.
app.get('/mock-paypal', (req, res) => {
  if (!paypal.MOCK()) return res.status(404).send('Not found');
  const p = store.getPayment(req.query.token);
  if (!p) return res.status(404).send('Unknown order');
  const id = encodeURIComponent(p.id);
  res.send(`<!doctype html><meta charset="utf-8"><title>Simulated checkout</title>
<body style="font:16px system-ui;background:#0f1420;color:#e8ecf5;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="max-width:420px;background:#171e2e;border:1px solid #26304a;border-radius:14px;padding:28px">
<div style="background:#78350f;color:#fde68a;padding:8px 12px;border-radius:8px;font-size:13px;margin-bottom:18px"><b>SIMULATION</b>: this is a local stand-in for the PayPal sandbox checkout. No real PayPal account or money is involved.</div>
<h2 style="margin:0 0 6px">Pay ${esc((p.totalCents / 100).toFixed(2))} ${esc(p.currency)}</h2>
<p style="color:#8d98b3;margin:0 0 20px">to AI Checkout Agent for ${esc(p.customer)}<br>Order ${esc(p.id)}</p>
<a href="/return?token=${id}" style="display:block;text-align:center;background:#ffc439;color:#111;font-weight:700;padding:12px;border-radius:99px;text-decoration:none">Approve payment (simulated)</a>
<a href="/cancel" style="display:block;text-align:center;color:#8d98b3;margin-top:14px">Cancel</a></div></body>`);
});

// PayPal redirects the buyer here after they approve the payment: capture it, then AI writes the receipt.
app.get('/return', wrap(async (req, res) => {
  const id = req.query.token;
  const p = id && store.getPayment(id);
  if (!p) return res.redirect('/?error=' + encodeURIComponent('Unknown order'));
  if (p.status !== 'CREATED') return res.redirect('/?paid=' + encodeURIComponent(p.id));
  try {
    const cap = await paypal.captureOrder(p.id);
    if (cap.status !== 'COMPLETED') throw new Error(`Capture status ${cap.status}`);
    const paid = store.updatePayment(p.id, { status: 'PAID', captureId: cap.captureId, paidAt: new Date().toISOString(), payerEmail: cap.payerEmail });
    const receipt = await agent.writeReceipt(paid, cap.payerName);
    store.updatePayment(p.id, { receipt });
    res.redirect('/?paid=' + encodeURIComponent(p.id));
  } catch (e) {
    console.error(e);
    res.redirect('/?error=' + encodeURIComponent(e.message));
  }
}));

app.get('/cancel', (req, res) => res.redirect('/?error=' + encodeURIComponent('Payment cancelled by buyer')));

const port = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(port, () => {
    console.log(`AI Checkout Agent on http://localhost:${port}  (PayPal: ${paypal.BASE})`);
  });
}
module.exports = app;
