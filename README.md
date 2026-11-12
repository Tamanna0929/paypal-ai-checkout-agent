# AI Checkout Agent

An AI finance agent that operates a **PayPal** account through plain language. Tell it "Bill Acme Co $450 for logo design plus 2 revisions at $45, 8% tax" and it creates a real PayPal sandbox checkout, tracks the payment, writes the receipt, and files refund requests that a human must approve.

Built for the *Build What's Next with PayPal and AI* hackathon.

## What it does

| Capability | PayPal | AI |
|---|---|---|
| Natural-language billing: one sentence becomes an itemized checkout, several clients at once | Orders v2 `create` with item and tax breakdown | LLM function calling extracts customer, items, currency, tax |
| Collect payment | Buyer approves in PayPal, the app captures via Orders v2 `capture` | n/a |
| Receipts | Capture result | The LLM writes a personalised receipt, stored in the ledger |
| Refunds with a human in the loop | Payments v2 `refund` | The agent can only *request* a refund; a person approves or rejects it in the UI |
| Business questions ("what's outstanding?", "top customers?") | Live order status via Orders v2 `get` | The agent calls `revenue_summary` and `list_payments`, answers with real numbers and suggestions |
| Dashboard | n/a | KPIs, 14-day revenue chart, ledger, and approval queue |

### Agent safety design
- **Money math is never done by the model.** The model supplies item names, quantities and unit prices. The server computes subtotal, tax and total in integer cents.
- **Spending policy:** the server rejects any checkout above `MAX_CHECKOUT_USD`, whatever the model says.
- **Refunds cannot be executed by the agent.** The `request_refund` tool only creates a pending approval; the PayPal refund call happens only when a human clicks Approve. Approvals can't be replayed.
- Order IDs come from the ledger, and the agent is instructed never to guess them.

## Architecture

```
Browser (chat + dashboard)
   │  POST /api/agent
   ▼
Express server ──► lib/agent.js: LLM tool-calling loop (max 8 steps)
   │                 tools: create_checkout, list_payments, check_payment_status,
   │                        request_refund, revenue_summary
   ├──► lib/paypal.js: OAuth, Orders v2 (create/get/capture), Payments v2 (refund)
   ├──► lib/store.js: JSON ledger + approval queue
   └──► GET /return: PayPal redirect target, captures the payment, then the LLM writes the receipt
```

## Run it

Requirements: Node 18+, a free [PayPal Developer](https://developer.paypal.com) account, and a free Google Gemini API key from [AI Studio](https://aistudio.google.com/apikey) (no card needed). Any OpenAI-compatible provider also works.

1. **Get sandbox credentials.** In the PayPal Developer Dashboard go to *Apps & Credentials*, switch to **Sandbox**, create an app, and copy the Client ID and Secret. Under *Sandbox accounts* note the **personal (buyer)** account's email and password; you'll use it to pay.
2. **Install and configure:**
   ```bash
   git clone <this repo>
   cd paypal-ai-checkout-agent
   npm install
   cp .env.example .env     # then fill in PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, AI_API_KEY
   npm start
   ```
3. Open http://localhost:3000. The header should show `PayPal ✓ · AI ✓`.
4. Type a request, click **Pay with PayPal (sandbox)**, log in with the sandbox buyer account, and approve. You land back in the app with the payment captured and an AI-written receipt in the ledger.
5. Try *"Refund the most recent paid order, customer was unhappy"*, then approve it in the **Needs your approval** panel.

### Tests (no keys or network needed)
```bash
npm test
```
Runs the full flow (checkout, policy block, capture, receipt, refund approval, replay protection) against local mocks of the PayPal and AI APIs.

### Deploy (Render)
`render.yaml` is included. Create a Render Web Service from the repo, set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `AI_API_KEY`, and deploy. `BASE_URL` is picked up automatically from Render. The ledger is a JSON file, so it resets when the free instance restarts.

## Tools and services used
- **PayPal REST APIs (sandbox):** OAuth 2.0, Orders v2 (create, get, capture), Payments v2 (refund)
- **Google Gemini API (free tier, via its OpenAI-compatible endpoint, model `gemini-flash-latest`):** function-calling agent for billing and analysis, plus receipt generation. Swap provider by changing `AI_BASE_URL`, `AI_MODEL` and `AI_API_KEY`.
- **Render:** hosting for the demo
- Node.js, Express, vanilla JS front end

## Limitations
Sandbox only. Single-user prototype with no authentication, and the JSON-file ledger is not meant for production. Webhooks are not wired up; payments are captured on the buyer's return redirect, and `check_payment_status` can sync a status on demand.

## License
MIT. See [LICENSE](LICENSE).
