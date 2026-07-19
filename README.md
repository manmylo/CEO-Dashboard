# Gearevo BI — Starter Kit

Low-cost (basically **RM0/month**) business intelligence dashboard.
Pulls Shopify (Shopee + TikTok Shop synced through Shopify) → computes metrics →
Firestore → dashboard + daily email.

```
cron-job.org (~every 2 min)  →  GitHub Actions (workflow_dispatch)  →  Shopify GraphQL  →  compute  →  Firestore  →  EmailJS
                                                                                                            ↓
                                                                                                Firebase Hosting dashboard
                                                                                                            ↑
                                                                                        Cloudflare Worker (worker/) — live
                                                                                        chat + order/month drill-downs,
                                                                                        called directly from the browser
```

No servers, no Cloud Functions (those force the paid plan). GitHub Actions is the
"server" for the sync job; Cloudflare Workers (also free tier) is the "server" for
anything the dashboard needs *live*, faster than the sync job's own cadence — see
`worker/README.md`.

The sync workflow (`.github/workflows/sync.yml`) has no `schedule:` trigger of its
own — GitHub doesn't reliably honor sub-5-minute schedules. It's triggered
externally instead, by a free [cron-job.org](https://cron-job.org) job calling
GitHub's `workflow_dispatch` REST API roughly every 2 minutes. Each run decides for
itself whether to do a full sync (once per MYT day) or a quick sync (every other
run) — see "Quick vs. full sync" below.

---

## Step 0 — BEFORE you code (penting!)

Margin & profit numbers only work if **"Cost per item"** is filled in for your
products in Shopify (Product → variant → *Cost per item*). Kalau kosong, dashboard
can only show revenue, not untung. Fill these in first for your active SKUs.

---

## Step 1 — Shopify custom app + token

> Note: after Jan 2026 you create custom apps in the **Shopify Dev Dashboard**
> (dev.shopify.com), not the old Admin → "Develop apps" menu.

1. Create a custom app for your store.
2. Give it **Admin API** scopes: `read_orders`, `read_products`, `read_inventory`.
3. Install it on your store, then copy the **Admin API access token** (`shpat_...`).
   You only see it once — save it.
4. Note your store domain, e.g. `gearevo.myshopify.com`.

## Step 2 — Firebase project (free Spark plan)

1. console.firebase.google.com → create project. **Stay on Spark (free).**
2. **Firestore Database** → Create (production mode).
3. **Authentication** → enable **Google** sign-in provider.
4. Paste `firestore.rules` into the Rules tab. Put your allowed email(s) inside.
5. **Project settings → Service accounts → Generate new private key** → downloads a
   JSON. This is your `FIREBASE_SA`. Minify to one line:
   `cat key.json | tr -d '\n'`
6. **Project settings → Your apps → Web app** → copy the config object into
   `public/index.html` (the `firebaseConfig`).

## Step 3 — GitHub repo + secrets

1. Push this folder to a **private** GitHub repo.
2. Repo → Settings → Secrets and variables → Actions → add these secrets:

   | Secret | Value |
   |---|---|
   | `SHOP_DOMAIN` | gearevo.myshopify.com |
   | `SHOP_TOKEN` | shpat_... |
   | `SHOP_API_VERSION` | 2026-01 |
   | `FIREBASE_SA` | the one-line service-account JSON |
   | `EMAILJS_*`, `REPORT_TO` | optional (see Step 5) |

   The monthly sales target is **not** a secret — set it by dragging a
   Target card onto the current month in the dashboard's Calendar (Year
   view). If no Target card exists for a month, the dashboard shows "no
   target set" instead of comparing against a number nobody chose.

3. Repo → Actions tab → run **"Gearevo BI sync"** manually once
   (`workflow_dispatch`, tick "Force a full sync") to test. Check the logs.
4. Set up the external trigger so it actually runs on a schedule — cron-job.org
   (free) → new cron job → POST to
   `https://api.github.com/repos/OWNER/REPO/actions/workflows/sync.yml/dispatches`
   with header `Authorization: Bearer <a GitHub PAT with repo:actions write>` and
   body `{"ref":"main"}`, every 1-2 minutes.

## Step 4 — Deploy the dashboard

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only hosting
firebase deploy --only firestore:indexes   # composite indexes — see firestore.indexes.json
```
Dashboard lives at `https://YOUR-PROJECT.web.app`. Only your allowed Google
accounts can read it.

## Step 4b — Cloudflare Worker (live chat + order/month drill-downs)

The dashboard's chat panel and its "click a KPI card for the live breakdown"
features (Today's Orders, Returns/Cancelled This Month, Gross Profit's live cost
pull) aren't served by the sync job — they call a small Cloudflare Worker directly
from the browser, since those need to be fresher than the sync job's own cadence.
See `worker/README.md` for full setup; short version:

```bash
cd worker
wrangler login
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put SHOP_DOMAIN
wrangler secret put SHOP_TOKEN
wrangler deploy
```
Copy the printed `*.workers.dev` URL into `CHATBOT_WORKER_URL` near the top of
`public/app.js` and `public/calendar.js`, then redeploy hosting.

## Step 5 — Email report (optional, EmailJS)

1. emailjs.com → add an email service + a template with variables
   `{{to_email}}`, `{{subject}}`, `{{message}}`.
2. **Account → Security → enable "Allow EmailJS API for non-browser applications"**
   (required to send from GitHub Actions).
3. Add secrets `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY`,
   `EMAILJS_PRIVATE_KEY`, `REPORT_TO`.
   Free tier = 200 emails/month (daily report = ~30). Cukup.

---

## Quick vs. full sync, and the run lock

Every trigger (~every 2 min) runs `sync.js` in one of two modes:
- **Quick** — refreshes today's sales/orders (from the Gearevo sales dashboard's
  own Firestore) and live inventory value. Fast, cheap, safe to run constantly.
- **Full** — the complete Shopify pull: margin, dead stock, stock alerts, basket
  analysis, customer segments, AI advisor commentary, Business Analysis. Runs
  automatically once per MYT calendar day (the first trigger after midnight);
  force one anytime via `workflow_dispatch`'s "Force a full sync" input.

A Firestore doc (`sync/lock`) prevents two runs from overlapping — without it, an
overlapping quick sync could race a full sync's writes. `sync.yml`'s `concurrency`
block backs this up at the GitHub Actions level, so overlapping triggers queue
instead of running in parallel and potentially getting cancelled mid-flight (a
cancelled run never reaches the code that releases the lock, which leaves it stuck
for up to `LOCK_STALE_MS` — 20 min — silently no-op'ing every trigger in between).
A manually-triggered full sync (`FORCE_FULL=true`) bypasses the lock's staleness
check entirely, so it's never blocked by a leftover stuck lock either.

## Local test (optional)

```bash
cd sync
cp .env.example .env      # fill it in
node --env-file=.env sync.js
```

---

## Roadmap

- **Phase 1 (this kit):** Shopify sales, margin, dead stock, stockout, daily email. Done.
- **Phase 2:** add cost/expense + ad spend (Facebook/TikTok ROAS) — needs their
  own APIs, messier. For now type ad spend into Firestore manually if you want ROAS. Not started.
- **Phase 3:** customer segmentation (RFM/VIP), basket analysis, real LLM advisor. Done —
  VIP/at-risk segmentation, concentration risk, basket analysis ("frequently bought
  together" with lift), and a Claude-powered daily + strategic advisor are all live.

## Excluded SKUs

`sync/excluded-skus.js` lists service / add-on SKUs (Sharpening, Engraving, Kydex,
etc.) plus the `GE-OID-1`…`GE-OID-100` range. These are dropped from **product
analytics** (top products, profit, dead stock, slow moving, stock alerts, velocity) so services
don't pollute the numbers with fake 100% margins. They are **still counted in total
sales / order counts** because that's real revenue. To exclude more later, just add
the SKU string to `SERVICE_SKUS` in that file.

## Tuning

In `sync/sync.js` top constants:
- `ORDER_PULL_DAYS` — how far back Shopify orders are pulled each sync (margin/
  products/customers/basket analysis/Business Analysis all need this window).
- `SLOWMOVING_DSI_DAYS` — slow moving uses DSI (Days Sales of Inventory: on-hand
  units ÷ the same weighted 7/30-day velocity the stockout forecast already
  computes) rather than a flat units-sold count, so severity scales with how
  much stock is actually sitting there. A SKU that did sell but would take more
  than `SLOWMOVING_DSI_DAYS` (90, matching `DEADSTOCK_WINDOW_DAYS` below on
  purpose — one consistent 90-day standard) to clear at its current pace is
  slow moving.
- `DEADSTOCK_WINDOW_DAYS` / `RESTOCK_LOOKBACK_DAYS` — dead stock ("modal tidur")
  is anchored to each SKU's own last-restocked date, not a shared window from
  today: 0 units sold in `DEADSTOCK_WINDOW_DAYS` (90) since it was last
  restocked. Restock date comes from ShopifyQL's `inventory_adjustment_history`
  (a real Purchase Order "Shipment received" event if one exists, else a manual
  adjustment that took the SKU from 0 to positive stock, else unknown/">180d"
  if nothing shows up within `RESTOCK_LOOKBACK_DAYS` — Shopify's own hard cap
  on how far back that history is queryable). See `getRestockDates()`.
- `LOW_STOCK_DAYS` — stockout warning threshold.
- Channel split uses `order.source_name` — depends on how your Shopee/TikTok
  sync app tags orders; adjust the mapping if the labels look off.

## Notes on Shopify API

This uses the **GraphQL Admin API** (Shopify's current + future-proof direction;
REST is now legacy). You don't need to know GraphQL — the two queries are already
written in `sync.js` (`Q_PRODUCTS`, `Q_ORDERS`). Highlights:

- **Cost per item** comes inline from `inventoryItem.unitCost` — no extra call.
- **Stock on hand** from `variant.inventoryQuantity`.
- **Channel** (Shopee / TikTok / web) from `channelInformation.channelDefinition.channelName`.
  If some orders show as "Lain-lain", check that field's real values and adjust.
- Rate limiting is **cost-based** (a leaky bucket, not request count). The
  `graphql()` helper reads `extensions.cost.throttleStatus` and backs off
  automatically, so you won't get throttled.
- Scopes are the same as REST: `read_orders`, `read_products`, `read_inventory`.

If you ever want to test a query by hand, use the **GraphiQL explorer** in your
Shopify app, or `/admin/api/{version}/graphql.json` with a POST.
