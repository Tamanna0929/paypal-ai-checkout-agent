// Tiny JSON-file ledger. Good enough for a hackathon prototype; swap for a DB in production.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'ledger.json');

let state = { payments: [], approvals: [] };

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.error('Could not load ledger, starting empty:', e.message);
  }
}
function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Could not save ledger:', e.message);
  }
}
load();

const cents = (n) => Math.round(Number(n) * 100);
const fmt = (c) => (c / 100).toFixed(2);

function payments() {
  return [...state.payments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function getPayment(id) {
  return state.payments.find((p) => p.id === id);
}
function addPayment(p) {
  state.payments.push(p);
  save();
  return p;
}
function updatePayment(id, patch) {
  const p = getPayment(id);
  if (!p) return null;
  Object.assign(p, patch);
  save();
  return p;
}

function approvals() {
  return [...state.approvals].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function getApproval(id) {
  return state.approvals.find((a) => a.id === id);
}
function addApproval(a) {
  state.approvals.push(a);
  save();
  return a;
}
function updateApproval(id, patch) {
  const a = getApproval(id);
  if (!a) return null;
  Object.assign(a, patch);
  save();
  return a;
}

function summary() {
  const out = {
    counts: { CREATED: 0, PAID: 0, PARTIALLY_REFUNDED: 0, REFUNDED: 0 },
    by_currency: {},
    top_customers: [],
    last_14_days: [],
    pending_approvals: state.approvals.filter((a) => a.status === 'PENDING').length,
  };
  const cust = {};
  const days = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days[d] = 0;
  }
  for (const p of state.payments) {
    out.counts[p.status] = (out.counts[p.status] || 0) + 1;
    const c = (out.by_currency[p.currency] ||= { paid: 0, outstanding: 0, refunded: 0, net: 0 });
    if (p.status === 'CREATED') c.outstanding += p.totalCents;
    if (['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status)) {
      c.paid += p.totalCents;
      c.refunded += p.refundedCents || 0;
      c.net += p.totalCents - (p.refundedCents || 0);
      const key = `${p.customer}|${p.currency}`;
      cust[key] = (cust[key] || 0) + p.totalCents - (p.refundedCents || 0);
      const day = (p.paidAt || p.createdAt).slice(0, 10);
      if (day in days) days[day] += p.totalCents - (p.refundedCents || 0);
    }
  }
  for (const cur of Object.values(out.by_currency)) {
    for (const k of Object.keys(cur)) cur[k] = fmt(cur[k]);
  }
  out.top_customers = Object.entries(cust)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => {
      const [name, currency] = k.split('|');
      return { name, currency, net: fmt(v) };
    });
  out.last_14_days = Object.entries(days).map(([date, c]) => ({ date, net_cents: c }));
  return out;
}

module.exports = {
  cents, fmt, payments, getPayment, addPayment, updatePayment,
  approvals, getApproval, addApproval, updateApproval, summary,
};
