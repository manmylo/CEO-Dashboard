# Gearevo BI chatbot — Cloudflare Worker

Backend for the dashboard's chat panel, plus the live click-to-drill-down
features (order breakdowns, this month's Returns/Cancelled lists, live product
cost for Gross Profit). Runs on Cloudflare Workers (free tier), not Firebase —
see the chat with Claude in the main project history for why. Holds no Firebase
credentials for reading the dashboard's own data: every request forwards the
caller's own Firebase Auth ID token straight to Firestore's REST API, so the
existing `firestore.rules` allowlist enforces access — nothing to duplicate or
keep in sync here. It does need its own Shopify credentials though (below),
since the order/month endpoints call Shopify directly.

## Endpoints

- `POST /` — chat (Claude, using `dashboard/latest` as context).
- `POST /orders` — a single day's order-level breakdown (`{date}`), used by the
  Calendar's Target cards and the Home page's "Today's Sales" card.
- `POST /month-orders` — a month's Returns/Cancelled lists + live product cost
  (`{month}`), used by the Home page's Returns/Cancelled/Gross Profit cards.

## One-time setup

1. Create a free Cloudflare account at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) if you don't have one.
2. Install Wrangler (Cloudflare's CLI) and log in:
   ```bash
   npm install -g wrangler
   wrangler login
   ```
   This opens a browser window to authorize the CLI against your Cloudflare account.
3. From this `worker/` folder, set these secrets (never committed to git):
   ```bash
   wrangler secret put ANTHROPIC_API_KEY
   wrangler secret put SHOP_DOMAIN          # e.g. gearevo.myshopify.com — same as sync.js's SHOP_DOMAIN
   wrangler secret put SHOP_TOKEN           # same Shopify Admin API token sync.js uses
   wrangler secret put SHOP_API_VERSION     # optional, e.g. 2026-01 — defaults to 2026-01 if unset
   ```
4. Deploy:
   ```bash
   wrangler deploy
   ```
   This prints a URL like `https://gearevo-chatbot.YOUR_SUBDOMAIN.workers.dev`.
5. Copy that URL into `CHATBOT_WORKER_URL` near the top of **both**
   `public/app.js` and `public/calendar.js`.
6. Redeploy the dashboard: `firebase deploy --only hosting` (from the project root).

## Redeploying after code changes

```bash
cd worker
wrangler deploy
```
No need to touch secrets again — they persist across deploys.
