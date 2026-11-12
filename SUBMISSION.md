# Submission kit (paste into the hackathon form)

## Project name
AI Checkout Agent

## Tagline
Tell an AI agent who to bill. It creates the PayPal checkout, writes the receipt, and asks you before it refunds anything.

## Text description
AI Checkout Agent lets freelancers and small businesses run their PayPal account in plain language. Type "Bill Acme Co $450 for logo design and 2 revisions at $45, 8% tax" and an AI agent turns it into a real PayPal sandbox checkout with an itemized breakdown. The buyer pays through PayPal, the app captures the payment, and the AI writes a personalised receipt. The agent also answers business questions ("what's outstanding? who are my top customers?") by calling tools over the live ledger and PayPal order status, and a dashboard shows KPIs, a 14-day revenue chart and the ledger.

The core idea is safe agentic payments. The model never does the money math: it supplies items and prices and the server computes totals in integer cents. A server-side spending policy caps any single checkout. The agent cannot move money out: refunds are only *requested*, then wait in an approval queue until a human approves, at which point the PayPal refund is executed. Approvals cannot be replayed.

## How PayPal is used
PayPal OAuth, Orders v2 (create with item and tax breakdown, get, capture), and Payments v2 (refund), all against the sandbox. PayPal is the payment rail for every feature in the app.

## How AI is used
Google Gemini (free tier, model gemini-flash-latest, via its OpenAI-compatible API) runs a multi-step function-calling loop with five tools (create_checkout, list_payments, check_payment_status, request_refund, revenue_summary) to execute billing and answer business questions, and separately generates receipts after capture.

## Tools / sponsors
PayPal REST sandbox, Google Gemini API, Render (hosting), Node.js + Express.

## Demo video script (about 2:15, record screen + voice, no music)
0:00 Problem: "Billing clients and chasing payments is manual. What if you could just tell an agent?" Show the app (10 s).
0:10 Type: "Bill Acme Co $450 for logo design and 2 revisions at $45 each, 8% tax." Show the tool chip and the Pay with PayPal button. Mention totals are computed by the server, not the model (25 s).
0:35 Click the button, log in with the sandbox buyer, approve. You land back in the app: ledger shows PAID plus the AI-written receipt (30 s).
1:05 Type: "Bill Globex $900 website audit and Initech EUR 300 consulting." Show two checkouts created in one turn (15 s).
1:20 Ask: "What's outstanding and who are my top customers?" Show the answer using real numbers and the dashboard (15 s).
1:35 Type: "Refund the most recent paid order, customer was unhappy." Show it lands in "Needs your approval" with nothing refunded yet. Click Approve, show the ledger change to refunded (30 s).
2:05 Closing line: "PayPal moves the money, AI operates it, and a human stays in control. Code is open source on GitHub." (10 s)

## Final checklist
- [ ] Repo is public with LICENSE visible in the About section
- [ ] README setup steps work from a fresh clone
- [ ] Hosted demo URL (Render) loads and header shows PayPal ✓ and AI ✓
- [ ] Demo video under 3 min, uploaded to YouTube as Public
- [ ] No API keys committed (.env is gitignored)
- [ ] Submission form: description, tools used, repo URL, demo URL, YouTube URL
