# Gearevo BI — Starter Kit

Low-cost (basically **RM0/month**) business intelligence dashboard.
Pulls Shopify (Shopee + TikTok Shop synced through Shopify) → computes metrics →
Firestore → dashboard + daily email.

```
GitHub Actions (nightly cron)  →  Shopify REST  →  compute  →  Firestore  →  EmailJS
                                                                    ↓
                                                        Firebase Hosting dashboard
```

No servers, no Cloud Functions (those force the paid plan). GitHub Actions is the "server".

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
   | `MONTHLY_TARGET` | 120000 |
   | `EMAILJS_*`, `REPORT_TO` | optional (see Step 5) |

3. Repo → Actions tab → run **"Gearevo BI nightly sync"** manually once
   (`workflow_dispatch`) to test. Check the logs.

## Step 4 — Deploy the dashboard

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only hosting
```
Dashboard lives at `https://YOUR-PROJECT.web.app`. Only your allowed Google
accounts can read it.

## Step 5 — Email report (optional, EmailJS)

1. emailjs.com → add an email service + a template with variables
   `{{to_email}}`, `{{subject}}`, `{{message}}`.
2. **Account → Security → enable "Allow EmailJS API for non-browser applications"**
   (required to send from GitHub Actions).
3. Add secrets `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY`,
   `EMAILJS_PRIVATE_KEY`, `REPORT_TO`.
   Free tier = 200 emails/month (daily report = ~30). Cukup.

---

## Local test (optional)

```bash
cd sync
cp .env.example .env      # fill it in
node --env-file=.env sync.js
```

---

## Roadmap

- **Phase 1 (this kit):** Shopify sales, margin, dead stock, stockout, daily email.
- **Phase 2:** add cost/expense + ad spend (Facebook/TikTok ROAS) — needs their
  own APIs, messier. For now type ad spend into Firestore manually if you want ROAS.
- **Phase 3:** customer segmentation (RFM/VIP), basket analysis, real LLM advisor
  (pipe the numbers to Gemini Flash free tier or Claude Haiku).

## Tuning

In `sync/sync.js` top constants:
- `DEADSTOCK_DAYS` / `DEADSTOCK_MIN_UNITS` — what counts as "modal tidur".
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
