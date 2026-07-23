/**
 * Gearevo BI — nightly sync (Shopify GraphQL Admin API)
 * GraphQL -> compute metrics -> Firestore -> EmailJS
 *
 * Runs in GitHub Actions (Node 20+, global fetch). No Cloud Functions -> Firebase free plan.
 *
 * All Shopee + TikTok Shop + web orders live in Shopify, so one API covers all channels.
 *
 * Env (GitHub repo Secrets):
 *   SHOP_DOMAIN, SHOP_TOKEN, SHOP_API_VERSION (e.g. 2026-01),
 *   FIREBASE_SA,
 *   EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY, REPORT_TO
 *   ANTHROPIC_API_KEY (optional — AI-generated advisor insights; falls back to
 *   rule-based buildInsights() if unset or the call fails)
 *
 * The monthly sales target is NOT an env var — it's set by staff via a
 * Target card dropped on the current month in the dashboard's Calendar
 * (Year view). See getCurrentMonthTarget() below. If no Target card exists
 * for the current month, target is 0 and the dashboard shows "no target set".
 */

import admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import { isExcluded, isExcludedTitle, getServiceCategory } from "./excluded-skus.js";

// ---------- config ----------
const SHOP = process.env.SHOP_DOMAIN;
const TOKEN = process.env.SHOP_TOKEN;
const VER = process.env.SHOP_API_VERSION || "2026-01";
const ENDPOINT = `https://${SHOP}/admin/api/${VER}/graphql.json`;

const ORDER_PULL_DAYS = 90;      // how far back Shopify orders are pulled — margin/products/customers/basket/business-analysis all need this window
// Slow moving uses DSI (Days Sales of Inventory) — on-hand units divided by
// the same weighted 7/30-day velocity the stockout forecast already computes
// (0.6 * 7-day rate + 0.4 * 30-day rate), giving "estimated days to sell
// through current stock at the current pace." SLOWMOVING_DSI_DAYS matches
// DEADSTOCK_WINDOW_DAYS below on purpose — the two are meant to be one
// consistent 90-day standard: DSI > 90 = slow moving (it did sell, just too
// slowly to clear in that timeframe); 0 sold at all within 90 days of
// restock = dead stock. DSI can't apply to a SKU with 0 velocity (divide by
// zero) — that's exactly why dead stock stays its own separate 0-sold rule.
const SLOWMOVING_DSI_DAYS = 90;
// Dead stock ("modal tidur") is anchored to each SKU's own restock date, not a
// shared rolling window from today — see getRestockDates()/classifyDeadStock().
// DEADSTOCK_WINDOW_DAYS = must have 0 sales in this many days since restock
// (or since today, if no restock event is found at all) to count as dead.
// RESTOCK_LOOKBACK_DAYS = Shopify's own hard cap on how far back
// inventory_adjustment_history is queryable — can't see further than this,
// so a SKU with no visible restock event beyond this window just falls back
// to "0 sold in DEADSTOCK_WINDOW_DAYS from today," same as before.
const DEADSTOCK_WINDOW_DAYS = 90;
const RESTOCK_LOOKBACK_DAYS = 180;
const LOW_STOCK_DAYS = 14;      // stockout warning threshold (inclusion cutoff)
const CRITICAL_STOCK_DAYS = 7;  // <= this many days left = "kritikal" tier, else "amaran"
const REORDER_LEAD_DAYS = 14;   // assumed supplier lead time for reorder-quantity suggestion
const REORDER_BUFFER_DAYS = 30; // extra buffer stock to hold on top of lead time
const EMAIL_HOUR_MYT = 8;       // send the daily report on the first run at/after this MYT hour
const AT_RISK_DAYS = 180;       // repeat customer with no order in this long = at-risk (~6 months)
const VIP_COUNT = 25;           // top N customers by lifetime spend
const BASKET_MIN_COUNT = 3;     // pair must co-occur at least this many times to surface (noise floor)
const BASKET_MAX_PAIRS = 15;    // cap on how many "frequently bought together" pairs to keep

// Business is NOT uniform year-round, and sells across more categories than
// just butcher knives — fed to both AI prompts so seasonal/promotional
// swings aren't misread as "the business is declining" or "over-dependent on
// one product." Derived from the actual gearevo.com collection catalog
// (2026-07). Update this note (not code logic) if the catalog or promo
// calendar changes.
const BUSINESS_CONTEXT = `Gearevo sells across several distinct categories, not just butcher knives: (1) Kitchen & butcher knives/tools — knives, cleavers, boning/skinning tools, kitchen sets (F. Herder, Giesser, F. Dick, Victorinox Butcher, Wüsthof, Pirge, Icel, Swibo); (2) EDC & outdoor knives — folding/survival knives (Spyderco, Benchmade, CRKT, Kershaw, Civivi, Cold Steel, and more); (3) Parangs/machetes, a distinct Malaysian-market category; (4) sharpening tools and services (stones, sharpeners, honing rods, a sharpening class); (5) sheaths and carry gear (custom/ready-made Kydex, bags, cases).

Sales are NOT flat year-round — there's a real promotional/seasonal calendar:
- Eid Adha (Hari Raya Haji / Qurban / "Raya Korban") drives a hard spike in butcher/slaughter knife sales, followed by 1-2 months of tiered post-season clearance sales. A spike in butcher-knife sales/concentration around this time, or a drop afterward, is EXPECTED, not a red flag.
- The store also runs recurring PAYDAY SALES (tied to Malaysian salary payout dates, roughly monthly) plus Merdeka Day (Aug 31) and Christmas promotions. A short-term order/sales spike may simply be one of these routine promo events, not organic growth, a one-off anomaly, or a structural risk — don't over-read a single promotional month.

When you see a spike or drop that could be tied to any of the above (Eid Adha, a payday sale, Merdeka, Christmas, or post-season clearance), say so explicitly rather than treating it as a structural risk, decline, or a problem to fix.`;

// Ending inventory retail value only (not margin/dead-stock) — mirrors the
// ShopifyQL query behind Shopify Analytics' own inventory report:
//   FROM inventory SHOW ending_inventory_retail_value
//   WHERE product_title NOT CONTAINS '...' HAVING ending_inventory_units >= 1
// Case-sensitive substring match against the product title, same as ShopifyQL's
// NOT CONTAINS. Verified against Shopify's own Analytics export.
const INVENTORY_EXCLUDED_TITLES = [
  "USED", "Test", "Hidden", "Gearevo Kydex", "PRE-ORDER", "Gearevo Belt",
  "Servis Asah", "Service Asah", "Laser Engraving", "T-Shirt",
  "Personalize Stylish", "Gearevo Cap", "Knife Sheath", "Kydex sheath for F. Herder",
];
function isInventoryExcludedTitle(title) {
  return INVENTORY_EXCLUDED_TITLES.some((ex) => (title || "").includes(ex));
}

// ---------- firebase ----------
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore();

// ---------- Shopee Ads (ROAS) ----------
const SHOPEE_PARTNER_ID = process.env.SHOPEE_PARTNER_ID;
const SHOPEE_PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY;
const SHOPEE_SHOP_ID = process.env.SHOPEE_SHOP_ID;

// ---------- run lock ----------
// The external cron (cronjobs.org) can trigger a new run while a previous one
// (especially a full sync, which can take up to ~15 minutes) is still in
// flight — without this, an overlapping quick sync would race the full
// sync's Firestore writes, and worse, since mode selection is based on
// sync/state.lastFullSyncDate (which the in-flight full sync hasn't written
// yet), the overlapping run would ALSO decide to run "full" and double up
// Shopify API calls. A Firestore transaction makes lock acquisition atomic
// even if two runs start within moments of each other. LOCK_STALE_MS is a
// safety net so a crashed/killed run (which never reaches the finally block)
// doesn't permanently wedge every future run.
const LOCK_STALE_MS = 20 * 60 * 1000; // comfortably longer than a full sync takes
// `force` bypasses the staleness check entirely — for a manually-triggered
// full sync (FORCE_FULL=true), the person running it already knows they're
// the only thing running right now, so a leftover lock from an earlier run
// that crashed before its finally block (workflow cancelled, timeout, OOM)
// shouldn't block them from re-running immediately instead of waiting out
// LOCK_STALE_MS.
async function acquireLock(force) {
  const lockRef = db.doc("sync/lock");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(lockRef);
    const lockedAt = snap.exists ? snap.data().lockedAt : null;
    const isStale = !lockedAt || (Date.now() - new Date(lockedAt).getTime()) > LOCK_STALE_MS;
    if (lockedAt && !isStale && !force) return false;
    tx.set(lockRef, { lockedAt: new Date().toISOString() });
    return true;
  });
}
async function releaseLock() {
  await db.doc("sync/lock").set({ lockedAt: null }, { merge: true });
}

// ---------- dashboard access allowlist ----------
// Firestore rules check email membership against config/access, not a
// hardcoded list in firestore.rules, since that file is committed to a
// public repo. The real list lives only in this GitHub Actions secret.
async function syncAllowlist() {
  const raw = process.env.ALLOWED_EMAILS;
  if (!raw) return; // secret not set yet — don't wipe an existing allowlist
  const allowedEmails = raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!allowedEmails.length) return;
  // merge:true -- this doc also carries an `admins` field (who can manage
  // per-user page access), seeded once via sync/seed-admin.js, not from this
  // secret. A plain .set() here would silently wipe it on every sync tick.
  await db.doc("config/access").set({ allowedEmails, updatedAt: new Date().toISOString() }, { merge: true });
}

// ---------- graphql helper (cost-aware throttling + pagination) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function graphql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) { await sleep(2000); return graphql(query, variables); }
  const body = await res.json();
  if (body.errors) throw new Error("GraphQL errors: " + JSON.stringify(body.errors));

  // cost-based rate limit: back off if the leaky bucket is running low
  const cost = body.extensions?.cost;
  const t = cost?.throttleStatus;
  if (t && t.currentlyAvailable < (cost.requestedQueryCost || 0)) {
    const need = (cost.requestedQueryCost || 0) - t.currentlyAvailable;
    await sleep(Math.min(Math.ceil(need / (t.restoreRate || 50)) * 1000, 5000));
  } else {
    await sleep(300);
  }
  return body.data;
}

// walk a cursor-paginated connection; `pick` returns the connection object from data
async function paginate(query, pick, variables = {}) {
  const out = [];
  let cursor = null;
  do {
    const data = await graphql(query, { ...variables, cursor });
    const conn = pick(data);
    out.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

// ---------- queries ----------
const Q_PRODUCTS = `
  query($cursor: String) {
    products(first: 25, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title productType
        variants(first: 100) {
          nodes {
            id sku price inventoryQuantity
            inventoryItem { unitCost { amount } tracked }
          }
        }
      }
    }
  }`;

const Q_ORDERS = `
  query($cursor: String, $q: String) {
    orders(first: 50, after: $cursor, query: $q, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id createdAt displayFinancialStatus cancelledAt
        fulfillments(first: 1) { id }
        totalPriceSet { shopMoney { amount } }
        subtotalPriceSet { shopMoney { amount } }
        totalRefundedSet { shopMoney { amount } }
        shippingAddress { province }
        channelInformation { channelDefinition { channelName } }
        customer { id }
        refunds {
          createdAt
          processedAt
          refundLineItems(first: 250) {
            nodes { subtotalSet { shopMoney { amount } } }
          }
        }
        lineItems(first: 50) {
          nodes {
            quantity
            sku
            discountedTotalSet { shopMoney { amount } }
            product { id title }
            variant { id }
          }
        }
      }
    }
  }`;

// amountSpent/numberOfOrders are Shopify's own LIFETIME aggregates per customer —
// not limited to the 90-day order window used elsewhere, so VIP ranking and
// revenue concentration reflect true customer value, not just recent activity.
const Q_CUSTOMERS = `
  query($cursor: String) {
    customers(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        displayName
        email
        createdAt
        numberOfOrders
        amountSpent { amount }
        orders(first: 1, sortKey: CREATED_AT, reverse: true) {
          nodes { createdAt }
        }
      }
    }
  }`;

// ---------- pull ----------
const num = (x) => Number(x || 0);
function daysAgoISO(n) { return new Date(Date.now() - n * 864e5).toISOString(); }

// variant GID -> details (incl. cost from inventoryItem.unitCost — inline, no extra call).
// Products/inventory are LIVE Shopify state (not tied to the 90-day order window),
// so this runs on every sync — quick and full — not just once a day.
async function pullProducts() {
  const products = await paginate(Q_PRODUCTS, (d) => d.products);
  const variantMap = new Map();
  for (const p of products) {
    for (const v of p.variants.nodes) {
      if (isExcluded(v.sku) || isExcludedTitle(p.title)) continue; // services/add-ons: not stock items
      variantMap.set(v.id, {
        productId: p.id,
        productTitle: p.title,
        category: p.productType || "Uncategorized",
        sku: v.sku || "",
        price: num(v.price),
        inventory: num(v.inventoryQuantity),
        cost: num(v.inventoryItem?.unitCost?.amount),
        tracked: v.inventoryItem?.tracked !== false,
      });
    }
  }
  return variantMap;
}

// Customer segmentation — full-sync only (once/day), same cadence as margin/
// dead-stock/top-products. Independent of the order/product pull above.
async function pullCustomers() {
  const customers = await paginate(Q_CUSTOMERS, (d) => d.customers);
  return customers.map((c) => ({
    name: c.displayName || "Customer",
    email: c.email || "",
    createdAt: c.createdAt,
    orders: Number(c.numberOfOrders || 0),
    spent: num(c.amountSpent?.amount),
    lastOrderAt: c.orders?.nodes?.[0]?.createdAt || null,
  }));
}

// Reads the current month's sales target from the Target card staff drop on
// the Calendar's Year view (yearlyCards, keyed by "YYYY-MM") — not an env
// var. Admin SDK bypasses Firestore rules, so this works regardless of who's
// signed in. Returns 0 if no Target card exists for the current month yet.
async function getCurrentMonthTarget() {
  const monthKey = myMonthKey(new Date());
  const snap = await db.collection("yearlyCards")
    .where("month", "==", monthKey)
    .where("cardType", "==", "target")
    .limit(1)
    .get();
  if (snap.empty) return 0;
  return Number(snap.docs[0].data().targetAmount) || 0;
}

async function pull() {
  console.log("Fetching products + cost + stock…");
  const variantMap = await pullProducts();

  // Orders are still pulled from Shopify — margin/cost/products/customers/
  // channels/regions/dead-stock/basket analysis all need line-item-level
  // data the sales dashboard doesn't have. Only sales $ and order counts
  // (today/month/daily trend) come from dashboardDaily below — see compute().
  console.log("Fetching orders (last 90 days)…");
  // status:any is required — Shopify's Admin API excludes cancelled/closed
  // orders by default when no status filter is given, which would silently
  // break the "count cancelled orders" logic below.
  const q = `created_at:>=${daysAgoISO(ORDER_PULL_DAYS)} status:any`;
  const orders = await paginate(Q_ORDERS, (d) => d.orders, { q });

  console.log(`Fetching daily sales history from ${OTHER_PROJECT_ID}...`);
  const dashboardDaily = await fetchAllDailySalesFromDashboard();
  console.log(`Sales dashboard — ${dashboardDaily.size} days of history.`);

  const monthlyTarget = await getCurrentMonthTarget();
  console.log(`Monthly target: ${monthlyTarget ? "RM" + monthlyTarget : "not set for this month"}`);

  return { variantMap, orders, monthlyTarget, dashboardDaily };
}

// ---------- compute ----------
function money(n) { return Math.round(n * 100) / 100; }
// Always exactly 2 decimal places (RM45.60, not RM46) — used everywhere a
// ringgit figure is rendered into insight text or the email body.
function rm(n) { return `RM${Number(n || 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

// Ending inventory retail value = on-hand qty × price, tracked, non-excluded-
// title variants only — mirrors the ShopifyQL report verbatim (see
// INVENTORY_EXCLUDED_TITLES above): that WHERE clause has NO product-status
// condition, so draft/archived products with stock are counted too — only
// title and tracked/qty>=1 matter. Do not add a status filter here; that was
// tried and undercounted vs. the real ShopifyQL "ending_inventory_retail_value".
// This filtering is intentionally scoped to inventory value only — margin,
// dead-stock and top-products keep using the unfiltered variantMap.
// Shared by full and quick syncs since it's live Shopify state, not order history.
function computeInventory(variantMap) {
  let value = 0;
  for (const v of variantMap.values()) {
    if (isInventoryExcludedTitle(v.productTitle)) continue;
    if (v.tracked && v.inventory >= 1) value += v.inventory * v.price;
  }
  return { endingInventoryRetailValue: money(value) };
}

// Customer segmentation from Shopify's own lifetime aggregates (see Q_CUSTOMERS).
// VIP = top spenders overall; at-risk = repeat customers (2+ orders) quiet for
// AT_RISK_DAYS; revenue concentration = what share of all-time revenue the top
// 5% of paying customers represent.
function computeCustomerSegments(customers) {
  const now = new Date();
  const monthKey = myMonthKey(now);

  const paying = customers.filter((c) => c.spent > 0);
  const totalRevenue = paying.reduce((s, c) => s + c.spent, 0);
  const bySpendDesc = [...paying].sort((a, b) => b.spent - a.spent);

  const vip = bySpendDesc.slice(0, VIP_COUNT)
    .map((c) => ({ name: c.name, email: c.email, spent: money(c.spent), orders: c.orders }));

  const atRisk = customers
    .filter((c) => c.orders >= 2 && c.lastOrderAt && (now - new Date(c.lastOrderAt)) / 864e5 >= AT_RISK_DAYS)
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 20)
    .map((c) => ({ name: c.name, email: c.email, spent: money(c.spent), lastOrderAt: myDateStr(c.lastOrderAt) }));

  const newThisMonth = customers.filter((c) => c.createdAt && myMonthKey(c.createdAt) === monthKey).length;

  const top5Count = Math.max(1, Math.ceil(bySpendDesc.length * 0.05));
  const top5Revenue = bySpendDesc.slice(0, top5Count).reduce((s, c) => s + c.spent, 0);
  const top5RevenuePct = totalRevenue ? money((top5Revenue / totalRevenue) * 100) : 0;

  return { vip, atRisk, newThisMonth, top5RevenuePct, totalCustomers: customers.length };
}

// ---------- dead-stock restock-date lookup ----------
// Shopify has no "last restocked" field anywhere — the only way to derive
// one is ShopifyQL's inventory_adjustment_history dataset, which tracks
// daily inventory changes per SKU with a reference_document_type. Two tiers:
//   Tier 1 — reference_document_type is non-null (any documented/tracked
//     source, not a specific type string). Originally gated on an exact
//     match against "Inventory::PurchaseOrder", which broke: receiving a PO
//     shows up in the Admin's own Inventory History as "Shipment received",
//     and confirmed real store data shows other tracked types too (e.g.
//     "Inventory::Transfer") — there's no single confirmed enum value for
//     "this was a real restock." Chasing the exact string was the wrong
//     approach and silently made recently-restocked SKUs show as "no
//     restock found" (>180d). The concept that actually matters is
//     documented vs. undocumented, not which specific document type.
//   Tier 2 — reference_document_type is null (a fully untracked manual
//     quantity edit in the Admin), used only as a fallback for pre-PO-
//     workflow stock (this store started using Purchase Orders in April
//     2026): specifically a manual adjustment that takes the running
//     on-hand balance from <=0 up to positive (a genuine "back in stock"
//     event), not just any manual tweak/correction.
// Only queried for dead-stock CANDIDATES (already known to have 0 sales in
// DEADSTOCK_WINDOW_DAYS from today), not the whole catalog — shopifyqlQuery
// has no pagination, so an unscoped store-wide query risks silent
// truncation; scoping to a WHERE...IN list of specific SKUs keeps each
// query small and complete. Shopify's own hard cap on how far back this
// data exists is RESTOCK_LOOKBACK_DAYS (180) — a SKU with no visible
// restock event at all in that window returns { date: null }, meaning
// "unknown, or genuinely more than 180 days ago" (displayed as ">180d").
const RESTOCK_QUERY_CHUNK = 50; // SKUs per ShopifyQL call
async function getRestockDates(candidates) {
  const results = new Map(); // sku -> { date: "YYYY-MM-DD" | null }
  const onHandBySku = new Map(candidates.map((c) => [c.sku, c.onHand]));
  const skus = candidates.map((c) => c.sku).filter(Boolean);

  for (let i = 0; i < skus.length; i += RESTOCK_QUERY_CHUNK) {
    const chunk = skus.slice(i, i + RESTOCK_QUERY_CHUNK);
    const skuList = chunk.map((s) => `'${s.replace(/'/g, "\\'")}'`).join(", ");
    const ql = `FROM inventory_adjustment_history SHOW inventory_adjustment_change `
      + `GROUP BY day, product_variant_sku, reference_document_type `
      + `WHERE product_variant_sku IN (${skuList}) `
      + `SINCE -${RESTOCK_LOOKBACK_DAYS}d UNTIL today ORDER BY day ASC`;

    let data;
    try {
      data = await graphql(
        `query($q: String!) { shopifyqlQuery(query: $q) { tableData { rows } parseErrors } }`,
        { q: ql }
      );
    } catch (e) {
      console.log(`Restock-date lookup failed for a chunk, treating as unknown: ${e.message}`);
      for (const sku of chunk) results.set(sku, { date: null });
      continue;
    }
    const result = data.shopifyqlQuery;
    if (result?.parseErrors?.length) {
      console.log(`Restock-date lookup — ShopifyQL parse error: ${JSON.stringify(result.parseErrors)}`);
      for (const sku of chunk) results.set(sku, { date: null });
      continue;
    }

    // Group by SKU, then by day, summing every type's change that day (needed
    // for accurate running-balance reconstruction) while separately flagging
    // days that had a documented (tracked) or manual positive delta.
    //
    // Originally gated Tier 1 on reference_document_type === "Inventory::
    // PurchaseOrder" specifically. Real store data showed that's wrong: a PO
    // shipment being received shows up in the Admin UI as "Shipment
    // received", and Shopify's own community docs show OTHER tracked types
    // too (e.g. "Inventory::Transfer") -- there's no single confirmed string
    // for "this was a real restock." Chasing the exact enum was the wrong
    // approach, and it silently broke real restocks (recently-restocked
    // SKUs showing as "no restock found", >180d).
    //
    // Fixed by matching on the concept that actually matters: ANY documented/
    // tracked source (reference_document_type is non-null, whatever the
    // specific type) is a real, attributable stock movement -- PO shipment,
    // transfer, or otherwise. Only a fully untracked manual edit (type is
    // null) needs the stricter Tier 2 fallback (a balance crossing from
    // zero, not just any tweak). seenTypes is still logged so the actual
    // values this store produces are visible if this ever needs revisiting.
    const seenTypes = new Set();
    const bySku = new Map();
    for (const r of result?.tableData?.rows || []) {
      const sku = r.product_variant_sku;
      if (!sku) continue;
      if (r.reference_document_type) seenTypes.add(r.reference_document_type);
      const perDay = bySku.get(sku) || bySku.set(sku, new Map()).get(sku);
      const day = perDay.get(r.day) || perDay.set(r.day, { total: 0, documentedPositive: false, manualPositive: false }).get(r.day);
      const change = Number(r.inventory_adjustment_change || 0);
      day.total += change;
      if (r.reference_document_type != null && change > 0) day.documentedPositive = true;
      if (r.reference_document_type == null && change > 0) day.manualPositive = true;
    }
    if (seenTypes.size) console.log(`   [INFO] Restock lookup — reference_document_type values seen: ${[...seenTypes].join(", ")}`);

    // SKUs with zero rows returned at all are a DIFFERENT failure mode from
    // "rows exist but no documented-positive day" -- this is either a
    // genuine no-restock-in-window SKU, OR a query/matching problem: ShopifyQL's
    // product_variant_sku not exactly matching the candidate's own SKU string
    // (case, whitespace, or a variant using a different SKU field than
    // expected). Logged explicitly so a "still shows >180d after the fix"
    // report can be diagnosed by which bucket it's actually in, instead of
    // guessing a third time.
    const noRowsAtAll = chunk.filter((sku) => !bySku.get(sku)?.size);
    if (noRowsAtAll.length) console.log(`   [INFO] Restock lookup — ${noRowsAtAll.length} SKU(s) had ZERO inventory_adjustment_history rows in the ${RESTOCK_LOOKBACK_DAYS}d window: ${noRowsAtAll.join(", ")}`);

    for (const sku of chunk) {
      const perDay = bySku.get(sku);
      if (!perDay || !perDay.size) { results.set(sku, { date: null }); continue; }
      const days = [...perDay.keys()].sort(); // "YYYY-MM-DD" strings sort chronologically

      // Tier 1: most recent documented (tracked) positive day — unambiguous
      // on its own, no balance reconstruction needed.
      let tier1Date = null;
      for (const d of days) if (perDay.get(d).documentedPositive) tier1Date = d; // ascending order, last match wins
      if (tier1Date) { results.set(sku, { date: tier1Date }); continue; }

      // Tier 2: most recent manual adjustment that crossed the running
      // balance from <=0 to >0. Reconstructed by walking forward from a
      // start-of-window balance derived from today's live on-hand quantity
      // minus the window's total net change (no absolute balance is directly
      // queryable — only daily deltas — so this is the only way to know what
      // the balance was on any given day in the window).
      const onHand = onHandBySku.get(sku);
      let tier2Date = null;
      if (onHand != null) {
        const totalWindowDelta = days.reduce((s, d) => s + perDay.get(d).total, 0);
        let balance = onHand - totalWindowDelta;
        for (const d of days) {
          const before = balance;
          balance += perDay.get(d).total;
          if (perDay.get(d).manualPositive && before <= 0 && balance > 0) tier2Date = d;
        }
      }
      results.set(sku, { date: tier2Date });
    }
  }
  return results;
}

// ---------- Malaysia timezone (UTC+8) helpers ----------
// Net sales matches Shopify Analytics:
//   • sales (subtotal after discount) counted on the ORDER's created date (MYT)
//   • returns counted on the REFUND's own created/processed date (MYT), NOT the order's date
//   • order count INCLUDES cancelled orders (to match Shopify's order count)
const MY_OFFSET_MS = 8 * 60 * 60 * 1000;
function toMYT(dateInput) { return new Date(new Date(dateInput).getTime() + MY_OFFSET_MS); }
function myDateStr(dateInput) { return toMYT(dateInput).toISOString().slice(0, 10); }
function myMonthKey(dateInput) { return toMYT(dateInput).toISOString().slice(0, 7); }
function myYesterdayStr() { return myDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000)); }

async function compute({ variantMap, orders, monthlyTarget, dashboardDaily }) {
  const TARGET = monthlyTarget || 0;
  const now = new Date();
  const nowMy = toMYT(now);
  const todayStr = nowMy.toISOString().slice(0, 10);
  const monthKey = nowMy.toISOString().slice(0, 7);
  // Previous calendar month, computed by decrementing rather than subtracting
  // days, so it can't drift onto the wrong month across DST/day-boundary edge
  // cases. Always well within the 90-day pull (last month is at most ~60 days back).
  let lmYear = nowMy.getUTCFullYear(), lmMonth = nowMy.getUTCMonth() - 1;
  if (lmMonth < 0) { lmMonth = 11; lmYear -= 1; }
  const lastMonthKey = `${lmYear}-${String(lmMonth + 1).padStart(2, "0")}`;

  let mtdCost = 0;
  let refundTotal = 0, grossTotal = 0, cancelledOrders = 0;
  const byChannel = {}; // scoped to this month (MTD) — feeds channelConcentration() below
  // Additional period buckets purely for the Business Analysis concentration
  // filter (This Month / Last Month / Last 90 Days) — This Month reuses
  // byChannel/profitByProductMTD above; these three are the missing periods.
  const byChannelLastMonth = {}, byChannel90d = {};
  const profitByProductLastMonth = {};
  const customerRevMTD = {}, customerRevLastMonth = {}, customerRev90d = {}; // customerId -> revenue
  // Per-order-month counts (orders/returns/cancellations) across the whole
  // 90-day pull, not just the current month — this seeds up to ~3 months of
  // real history for the Business Analysis trend chart immediately, and gets
  // persisted to Firestore's monthly/{month} collection each full sync so
  // months keep their final numbers after they age out of the 90-day window.
  const monthlyOrderStats = {};
  const soldUnits7 = {}, soldUnits30 = {}, soldUnits90 = {}; // 7/30 feed the DSI velocity blend; 90 gates dead-stock candidacy/slow-moving
  const profitByProduct = {};    // full 90-day window — dashboard's default "All" view
  const profitByProductMTD = {}; // this month only — used by the email report
  // Services (Sharpening/Engraving/Kydex/etc.) are excluded from all product
  // analytics above (no meaningful "Cost per item" in Shopify for a service,
  // so profit/margin would be fake) — tracked here instead, by category, per
  // day, matching the client-side date-range-aggregation trick
  // dailyProductProfit below already uses (the dashboard's Services card has
  // no server-computed "This Month"/full-window total anymore -- both are
  // summed client-side from these per-day buckets).
  const dailyServiceStats = {}; // { [date]: { [category]: {units, revenue} } }
  const dailyProductProfit = {}; // { [date]: { [pid]: {title, profit, revenue, units} } } — lets the
                                  // dashboard's "date range" filter aggregate any custom range client-side
  // Basket analysis ("frequently bought together") — pair co-occurrence counts
  // plus per-product order counts, so lift (co-occurrence vs. what you'd expect
  // if the two products were bought independently) can be computed after the
  // loop. basketTotalOrders is the denominator: orders with >=1 qualifying
  // (non-excluded) product, not all 90-day orders.
  const basketPairCounts = {}, basketProductOrders = {};
  let basketTotalOrders = 0;

  for (const o of orders) {
    const created = new Date(o.createdAt);
    const createdDateStr = myDateStr(created);
    const createdMonthKey = myMonthKey(created);
    const total = num(o.totalPriceSet?.shopMoney?.amount);
    const subtotal = num(o.subtotalPriceSet?.shopMoney?.amount);
    const ageDays = (now - created) / 864e5;
    grossTotal += total;
    refundTotal += num(o.totalRefundedSet?.shopMoney?.amount);
    // This store also marks genuine post-delivery returns as "cancelled" in
    // Shopify (not just pre-shipment cancellations), so cancelledAt alone
    // can't separate the two — fulfillment history can, since it's an
    // independent, objective fact a later cancellation can't erase.
    // "Cancelled" = never shipped. "Return" = shipped, then refunded.
    const shipped = (o.fulfillments || []).length > 0;
    if (o.cancelledAt && !shipped) cancelledOrders++;

    const mstat = monthlyOrderStats[createdMonthKey] || (monthlyOrderStats[createdMonthKey] =
      { month: createdMonthKey, orders: 0, returnOrders: 0, cancelledOrders: 0 });
    mstat.orders++;
    if (o.cancelledAt && !shipped) mstat.cancelledOrders++;
    // Shopify also creates a $0 refund record on some cancellations, which
    // totalRefundedSet > 0 excludes.
    if (shipped && num(o.totalRefundedSet?.shopMoney?.amount) > 0) mstat.returnOrders++;

    const ch = o.channelInformation?.channelDefinition?.channelName || "Other";
    byChannel90d[ch] = (byChannel90d[ch] || 0) + total;

    const custId = o.customer?.id || null; // guest/no-account orders are excluded from customer concentration
    if (custId) customerRev90d[custId] = (customerRev90d[custId] || 0) + subtotal;

    if (createdMonthKey === monthKey) {
      byChannel[ch] = (byChannel[ch] || 0) + total;
      if (custId) customerRevMTD[custId] = (customerRevMTD[custId] || 0) + subtotal;
    } else if (createdMonthKey === lastMonthKey) {
      byChannelLastMonth[ch] = (byChannelLastMonth[ch] || 0) + total;
      if (custId) customerRevLastMonth[custId] = (customerRevLastMonth[custId] || 0) + subtotal;
    }

    const basketSet = new Set(); // distinct qualifying pids in this order — see basket tally below
    for (const li of o.lineItems?.nodes || []) {
      if (isExcluded(li.sku) || isExcludedTitle(li.product?.title)) {
        // Excluded from all product analytics below — tracked here instead,
        // by category (falls back to "Other Services" if a title-matched
        // item has no explicit SKU category yet).
        const category = getServiceCategory(li.sku) || "Other Services";
        const lineQty = num(li.quantity);
        const lineAmt = num(li.discountedTotalSet?.shopMoney?.amount);

        const svcDayBucket = dailyServiceStats[createdDateStr] || (dailyServiceStats[createdDateStr] = {});
        const svcDay = svcDayBucket[category] || (svcDayBucket[category] = { units: 0, revenue: 0 });
        svcDay.units += lineQty;
        svcDay.revenue += lineAmt;
        continue;
      }
      const vid = li.variant?.id;
      const v = vid ? variantMap.get(vid) : null;
      const qty = num(li.quantity);
      const lineRev = num(li.discountedTotalSet?.shopMoney?.amount);
      const lineCost = (v?.cost || 0) * qty;
      if (createdMonthKey === monthKey) mtdCost += lineCost;

      if (vid) {
        if (ageDays <= 7) soldUnits7[vid] = (soldUnits7[vid] || 0) + qty;
        if (ageDays <= 30) soldUnits30[vid] = (soldUnits30[vid] || 0) + qty;
        if (ageDays <= DEADSTOCK_WINDOW_DAYS) soldUnits90[vid] = (soldUnits90[vid] || 0) + qty;
      }

      const pid = v?.productId || li.product?.id || li.product?.title || "unknown";
      const title = v?.productTitle || li.product?.title || "Unknown";
      basketSet.add(pid);
      profitByProduct[pid] = profitByProduct[pid] || { title, profit: 0, revenue: 0, units: 0 };
      profitByProduct[pid].profit += lineRev - lineCost;
      profitByProduct[pid].revenue += lineRev;
      profitByProduct[pid].units += qty;

      if (createdMonthKey === monthKey) {
        profitByProductMTD[pid] = profitByProductMTD[pid] || { title, profit: 0, revenue: 0, units: 0 };
        profitByProductMTD[pid].profit += lineRev - lineCost;
        profitByProductMTD[pid].revenue += lineRev;
        profitByProductMTD[pid].units += qty;
      } else if (createdMonthKey === lastMonthKey) {
        profitByProductLastMonth[pid] = profitByProductLastMonth[pid] || { title, profit: 0, revenue: 0, units: 0 };
        profitByProductLastMonth[pid].profit += lineRev - lineCost;
        profitByProductLastMonth[pid].revenue += lineRev;
        profitByProductLastMonth[pid].units += qty;
      }

      const dayBucket = dailyProductProfit[createdDateStr] || (dailyProductProfit[createdDateStr] = {});
      const dp = dayBucket[pid] || (dayBucket[pid] = { title, profit: 0, revenue: 0, units: 0 });
      dp.profit += lineRev - lineCost;
      dp.revenue += lineRev;
      dp.units += qty;
    }

    if (basketSet.size > 0) {
      basketTotalOrders++;
      for (const pid of basketSet) basketProductOrders[pid] = (basketProductOrders[pid] || 0) + 1;
    }
    if (basketSet.size >= 2) {
      const items = [...basketSet].sort();
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const key = `${items[i]}\u0000${items[j]}`;
          basketPairCounts[key] = (basketPairCounts[key] || 0) + 1;
        }
      }
    }
  }

  // Lift = how much more often A and B are bought together than you'd expect
  // if they were purchased independently (1.0 = pure chance, >1 = genuine
  // association). Filters out pairs that just co-occur because both are
  // bestsellers on their own — that's popularity, not a real cross-sell signal.
  const basketAnalysis = Object.entries(basketPairCounts)
    .map(([key, count]) => {
      const [pidA, pidB] = key.split("\u0000");
      const countA = basketProductOrders[pidA] || 0;
      const countB = basketProductOrders[pidB] || 0;
      const lift = basketTotalOrders && countA && countB
        ? (count * basketTotalOrders) / (countA * countB) : 0;
      return {
        a: profitByProduct[pidA]?.title || "Unknown",
        b: profitByProduct[pidB]?.title || "Unknown",
        count, lift: money(lift),
      };
    })
    .filter((p) => p.count >= BASKET_MIN_COUNT && p.lift > 1)
    .sort((a, b) => b.lift - a.lift || b.count - a.count)
    .slice(0, BASKET_MAX_PAIRS);

  // Sales and order counts (today, this month, and every day in the trend)
  // come from the Gearevo sales dashboard's own Firestore now, not from a
  // second, independently-computed Shopify pull — see pull() and
  // fetchAllDailySalesFromDashboard(). Only margin/cost/products/customers
  // below still need our own line-item-level Shopify pull, since the sales
  // dashboard doesn't have that data.
  const todayEntry = dashboardDaily.get(todayStr);
  const todaySales = todayEntry ? todayEntry.sales : 0;
  const todayOrders = todayEntry ? todayEntry.orders : 0;

  let mtdSales = 0, mtdOrders = 0;
  for (const [d, v] of dashboardDaily) {
    if (d.slice(0, 7) === monthKey) { mtdSales += v.sales; mtdOrders += v.orders; }
  }

  // `products` lets the dashboard's date-range filter sum any custom range
  // client-side without a fresh Shopify pull — refreshed once/day (full sync).
  const dailyTrend = Array.from(dashboardDaily.keys())
    .sort()
    .map((d) => ({
      date: d,
      todaySales: money(dashboardDaily.get(d)?.sales || 0),
      orders: dashboardDaily.get(d)?.orders || 0,
      products: Object.entries(dailyProductProfit[d] || {}).map(([pid, p]) => ({
        pid, title: p.title, profit: money(p.profit), revenue: money(p.revenue), units: p.units,
      })),
      services: Object.entries(dailyServiceStats[d] || {}).map(([category, s]) => ({
        category, units: s.units, revenue: money(s.revenue),
      })),
    }));

  // Yesterday's finished total, for the dashboard's live "vs semalam" comparison
  // — pulled from dailyTrend (already computed above) instead of a second
  // Firestore read. A fixed top-level field (not nested under `today`) so
  // quick syncs' merge writes to `today` don't wipe it between full syncs.
  const yesterdayEntry = dailyTrend.find((d) => d.date === myYesterdayStr());
  const yesterdaySales = yesterdayEntry ? yesterdayEntry.todaySales : 0;
  const yesterdayOrders = yesterdayEntry ? yesterdayEntry.orders : 0;

  // MTD through yesterday only (excludes today entirely) — for the AI advisor
  // commentary. Full sync runs once per MYT day, at the first sync after
  // midnight, so "today" has barely any sales yet at that moment; basing the
  // advisor's MTD figure on `mtd` above made its commentary a near-empty
  // snapshot that then stayed frozen (wrong) for the rest of the day while
  // the dashboard's own KPIs kept updating live. This is fully finalized and
  // never goes stale during the day.
  let mtdSalesThroughYesterday = 0, mtdOrdersThroughYesterday = 0;
  for (const [d, v] of dashboardDaily) {
    if (d.slice(0, 7) === monthKey && d !== todayStr) { mtdSalesThroughYesterday += v.sales; mtdOrdersThroughYesterday += v.orders; }
  }

  const grossProfit = mtdSales - mtdCost;
  const margin = mtdSales ? (grossProfit / mtdSales) * 100 : 0;
  const returnsRate = grossTotal ? (refundTotal / grossTotal) * 100 : 0; // 90-day, value-based — kept for AI context

  // This month's Returns %/Cancelled % KPI cards are now live off the Worker
  // (see app.js's loadMonthOrderSummary) — no MTD returns/cancelled fields
  // computed here anymore. monthlyOrderStats itself is still needed below for
  // monthlyOrderTrend (the Business Analysis chart's per-month history).
  const monthlyOrderTrend = Object.values(monthlyOrderStats).sort((a, b) => a.month.localeCompare(b.month));

  const rankProducts = (byProduct) => Object.values(byProduct)
    .sort((a, b) => b.profit - a.profit).slice(0, 20)
    .map((p) => ({
      title: p.title, profit: money(p.profit), revenue: money(p.revenue), units: p.units,
      margin: p.revenue ? money((p.profit / p.revenue) * 100) : 0,
    }));
  const topProducts = rankProducts(profitByProduct);
  const topProductsMTD = rankProducts(profitByProductMTD);
  // Full (untruncated) 90-day profit total — topProducts above is capped at
  // 20, so concentration ratios (e.g. "top 5 = X% of profit") must divide by
  // this, not by summing the already-capped array.
  const totalProfit90 = Object.values(profitByProduct).reduce((s, p) => s + p.profit, 0);

  // Concentration risk, computed identically for each of the three periods —
  // "how dependent is the business on its single biggest product/customer/
  // channel," which only means something read against a specific window
  // (a one-off big customer this month reads very differently from the same
  // concentration holding steady over 90 days).
  const productConcentration = (byProduct) => {
    const total = Object.values(byProduct).reduce((s, p) => s + p.profit, 0);
    const top5 = Object.values(byProduct).sort((a, b) => b.profit - a.profit).slice(0, 5)
      .reduce((s, p) => s + p.profit, 0);
    return total ? money((top5 / total) * 100) : 0;
  };
  const channelConcentration = (chans) => {
    const entries = Object.entries(chans);
    const total = entries.reduce((s, [, v]) => s + v, 0);
    const top = entries.sort((a, b) => b[1] - a[1])[0];
    return top && total ? { name: top[0], pct: money((top[1] / total) * 100) } : null;
  };
  const customerConcentration = (revByCustomer) => {
    const entries = Object.entries(revByCustomer);
    const total = entries.reduce((s, [, v]) => s + v, 0);
    const sorted = entries.sort((a, b) => b[1] - a[1]);
    const top5Count = Math.max(1, Math.ceil(sorted.length * 0.05));
    const top5Rev = sorted.slice(0, top5Count).reduce((s, [, v]) => s + v, 0);
    return total ? money((top5Rev / total) * 100) : 0;
  };
  const concentrationByPeriod = {
    thisMonth: {
      productPct: productConcentration(profitByProductMTD),
      customerPct: customerConcentration(customerRevMTD),
      channel: channelConcentration(byChannel),
    },
    lastMonth: {
      productPct: productConcentration(profitByProductLastMonth),
      customerPct: customerConcentration(customerRevLastMonth),
      channel: channelConcentration(byChannelLastMonth),
    },
    last90d: {
      productPct: productConcentration(profitByProduct),
      customerPct: customerConcentration(customerRev90d),
      channel: channelConcentration(byChannel90d),
    },
  };

  const deadStockCandidates = [], slowMoving = [], stockAlerts = [], stockOut = [];
  for (const [vid, v] of variantMap) {
    const sold90 = soldUnits90[vid] || 0;
    const sold30 = soldUnits30[vid] || 0;
    const sold7 = soldUnits7[vid] || 0;

    const velocity7 = sold7 / 7;
    const velocity30 = sold30 / 30;
    const velocity = 0.6 * velocity7 + 0.4 * velocity30;
    // DSI (Days Sales of Inventory) = on-hand ÷ current daily sales pace —
    // "how many days to sell through what's on the shelf right now." A SKU
    // with 0 velocity has infinite DSI (never clears at this pace), but that
    // case is handled by the dead-stock branch below instead, not here.
    const dsi = velocity > 0 ? v.inventory / velocity : Infinity;

    // Dead-stock CANDIDATES only here — zero sales in DEADSTOCK_WINDOW_DAYS
    // from today is a necessary but not sufficient condition; getRestockDates()
    // below narrows this down further (a SKU restocked recently hasn't had a
    // fair chance to sell yet, even if it shows 0 sold from today's vantage
    // point). Slow moving = it DID sell, just not fast enough to clear
    // current stock within SLOWMOVING_DSI_DAYS at that pace — the same
    // 90-day standard dead stock uses, applied via DSI instead of a raw
    // sold-units count so it scales with how much stock is actually sitting
    // there (5 sold against 10 on hand isn't the same problem as 5 sold
    // against 500 on hand).
    if (v.inventory > 0 && sold90 === 0) {
      deadStockCandidates.push({ title: v.productTitle, sku: v.sku, onHand: v.inventory,
        capital: money(v.inventory * v.cost) });
    } else if (v.inventory > 0 && sold90 > 0 && dsi > SLOWMOVING_DSI_DAYS) {
      slowMoving.push({ title: v.productTitle, sku: v.sku, onHand: v.inventory,
        capital: money(v.inventory * v.cost), sold90, dsi: Math.round(dsi) });
    }

    // Already out of stock (zero or negative — Shopify allows negative
    // on-hand via oversold / "continue selling when out of stock") is a
    // distinct, more urgent state than "running low" — it's not a forecast,
    // it's a fact, and it deserves its own list rather than a nonsensical
    // "-70 days left" row in the forecasting table. Deliberately NOT gated on
    // v.tracked — some real physical SKUs (e.g. consumables like Camellia
    // Oil) have inventory tracking disabled in Shopify yet still carry a
    // meaningful on-hand count the owner wants to see. Only known non-stock
    // titles (services, kydex, etc.) are excluded, same scope as the
    // inventory-value calc.
    if (v.inventory <= 0 && !isInventoryExcludedTitle(v.productTitle)) {
      const targetStock = velocity > 0 ? Math.ceil(velocity * (REORDER_LEAD_DAYS + REORDER_BUFFER_DAYS)) : 0;
      stockOut.push({
        title: v.productTitle, sku: v.sku, onHand: v.inventory, sold30,
        reorderQty: Math.max(0, targetStock - v.inventory),
        price: v.price, // kept for the business-analysis "revenue at risk" estimate; not shown in the table
      });
      continue;
    }

    // Forecasting proper: only for items that still HAVE stock, projecting
    // when they'll run out based on recency-weighted velocity (60% last-7-
    // days, 40% last-30-days) so a genuine acceleration/slowdown shows up
    // faster than a flat 30-day average would.
    if (sold30 > 0 && v.inventory > 0) {
      const daysLeft = Math.floor(v.inventory / velocity);
      if (daysLeft <= LOW_STOCK_DAYS) {
        const trend = velocity7 > velocity30 * 1.2 ? "up" : velocity7 < velocity30 * 0.8 ? "down" : "steady";
        const stockoutDate = myDateStr(new Date(now.getTime() + daysLeft * 864e5));
        const targetStock = Math.ceil(velocity * (REORDER_LEAD_DAYS + REORDER_BUFFER_DAYS));
        const reorderQty = Math.max(0, targetStock - v.inventory);
        stockAlerts.push({
          title: v.productTitle, sku: v.sku, onHand: v.inventory, daysLeft, stockoutDate, trend,
          urgency: daysLeft <= CRITICAL_STOCK_DAYS ? "critical" : "warning",
          reorderQty,
        });
      }
    }
  }
  console.log(`Checking restock dates for ${deadStockCandidates.length} dead-stock candidate SKUs…`);
  const restockDates = await getRestockDates(deadStockCandidates);
  const nowMs = Date.now();
  const deadStock = [];
  for (const c of deadStockCandidates) {
    const info = restockDates.get(c.sku) || { date: null };
    const daysSinceRestock = info.date ? Math.floor((nowMs - new Date(info.date).getTime()) / 864e5) : null;
    // Restocked recently enough that it hasn't had a fair DEADSTOCK_WINDOW_DAYS
    // chance to sell yet — not dead, just new. Skip it this cycle.
    if (info.date && daysSinceRestock < DEADSTOCK_WINDOW_DAYS) continue;
    deadStock.push({ ...c, sold90: 0, restockDate: info.date });
  }
  console.log(`Dead stock: ${deadStock.length} of ${deadStockCandidates.length} candidates `
    + `(${deadStockCandidates.length - deadStock.length} excluded — restocked too recently to judge).`);

  deadStock.sort((a, b) => b.capital - a.capital);
  slowMoving.sort((a, b) => b.capital - a.capital);
  stockAlerts.sort((a, b) => a.daysLeft - b.daysLeft);
  // Most in-demand out-of-stock items first — that's the real restock priority
  // once something's already at zero, not how far negative it happens to be.
  stockOut.sort((a, b) => b.sold30 - a.sold30);

  return {
    generatedAt: now.toISOString(), date: todayStr,
    today: { sales: money(todaySales), orders: todayOrders },
    yesterdaySales: money(yesterdaySales), // top-level — see note above dailyTrend/yesterdayEntry
    yesterday: { sales: money(yesterdaySales), orders: yesterdayOrders }, // AI advisor context only
    mtdThroughYesterday: {
      sales: money(mtdSalesThroughYesterday), orders: mtdOrdersThroughYesterday,
      target: TARGET, targetPct: TARGET ? money((mtdSalesThroughYesterday / TARGET) * 100) : 0,
    }, // AI advisor context only — see note above mtdSalesThroughYesterday
    mtd: {
      sales: money(mtdSales), orders: mtdOrders,
      aov: mtdOrders ? money(mtdSales / mtdOrders) : 0,
      target: TARGET, targetPct: TARGET ? money((mtdSales / TARGET) * 100) : 0,
      grossProfit: money(grossProfit), margin: money(margin),
    },
    returnsRate: money(returnsRate), cancelledOrders, // 90-day, kept for the AI insights context only
    topProducts, topProductsMTD, totalProfit90: money(totalProfit90), // topProducts = full 90-day window (dashboard default); MTD = email only
    deadStock, slowMoving, stockAlerts: stockAlerts.slice(0, 20),
    stockOut, // deadStock/stockOut unsliced — dashboard shows first 20 with a "see more" toggle for the rest
    basketAnalysis, // "frequently bought together" — top pairs by lift, 90-day window
    ...computeInventory(variantMap),
    dailyTrend, monthlyOrderTrend, concentrationByPeriod, // all merged into businessAnalysis in runFull(), not written to dashboard/latest directly
    insights: buildInsights({ mtdSales, margin, deadStock, stockAlerts, stockOut, target: TARGET }),
  };
}

// ---------- quick sync (today only — reads the sales dashboard's own live
// Shopify pull instead of re-fetching Shopify ourselves) ----------
// The Gearevo sales dashboard (gearevo-dashboard-7f782) already computes
// today's net sales + order count on its own cron, using the same net-sales
// definition (status:any, refunds dated by processedAt). Rather than run a
// second, independently-drifting Shopify fetch here just for the "today"
// tile, quick sync reads that project's own sales/today doc directly — its
// Firestore rules allow open reads, no credentials needed. If that read
// fails for any reason, this run is skipped entirely (today's tile just
// keeps its last known value until the next successful run) rather than
// falling back to a second, possibly-diverging Shopify fetch.
const OTHER_PROJECT_ID = "gearevo-dashboard-7f782";

// Full history from the sales dashboard's sales/daily/days collection, as a
// Map<dateStr, {sales, orders}> — used by pull() to source every day's sales
// figure (see compute() below) and by the standalone backfill mode. Paginates
// through the whole collection via Firestore's REST API (open rules, no
// credentials needed).
async function fetchAllDailySalesFromDashboard() {
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${OTHER_PROJECT_ID}/databases/(default)/documents/sales/daily/days`;
  let pageToken = null;
  const map = new Map();

  do {
    const url = new URL(baseUrl);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Sales dashboard fetch failed: ${res.status}`);
    const body = await res.json();

    for (const doc of body.documents || []) {
      const fields = doc.fields || {};
      const numField = (k) => Number(fields[k]?.doubleValue ?? fields[k]?.integerValue ?? 0);
      const dateStr = fields.date?.stringValue || doc.name.split("/").pop();
      if (!dateStr) continue;
      map.set(dateStr, { sales: numField("currentSale"), orders: numField("totalOrders") });
    }
    pageToken = body.nextPageToken || null;
  } while (pageToken);

  return map;
}

function buildInsights({ mtdSales, margin, deadStock, stockAlerts, stockOut, target }) {
  const out = [];
  if (target) {
    const pace = (mtdSales / target) * 100;
    if (pace < 70) out.push(`Sales this month are only ${pace.toFixed(0)}% of the ${rm(target)} target. Needs a push.`);
    else if (pace >= 100) out.push(`Monthly target reached (${pace.toFixed(0)}%). Great work!`);
  }
  if (margin < 40) out.push(`Margin at ${margin.toFixed(1)}% is low — check discounts or costs.`);
  if (stockOut?.length) {
    const withDemand = stockOut.filter((s) => s.sold30 > 0).length;
    out.push(withDemand
      ? `${stockOut.length} SKUs are out of stock (${withDemand} had sales in the last 30 days) — reorder urgently.`
      : `${stockOut.length} SKUs are out of stock — check whether to reorder or discontinue.`);
  }
  if (stockAlerts.length) {
    const critical = stockAlerts.filter((a) => a.urgency === "critical").length;
    out.push(critical
      ? `${stockAlerts.length} SKUs will run out within ${LOW_STOCK_DAYS} days (${critical} critical, ≤${CRITICAL_STOCK_DAYS} days) — place an order.`
      : `${stockAlerts.length} SKUs will run out within ${LOW_STOCK_DAYS} days — place an order.`);
  }
  if (deadStock.length) {
    const tied = deadStock.reduce((s, d) => s + d.capital, 0);
    out.push(`${rm(tied)} of capital is tied up in ${deadStock.length} dead-stock SKUs — consider clearance.`);
  }
  return out;
}

// ---------- business analysis (director-level sustainability view) ----------
// Synthesizes trend/concentration signals from data already computed elsewhere
// into a single "can this business sustain itself" snapshot — distinct from
// the daily tactical Recommendations insights above. Full-sync only (needs
// customerSegments, which requires the separate customer pull).
function computeBusinessAnalysis({ dailyTrend, monthlyOrderTrend, deadStock, stockOut,
  customerSegments, endingInventoryRetailValue }) {
  // Monthly trend: bucket the (up to 90-day) daily trend by calendar month.
  // Edge months are necessarily partial (whatever's inside the 90-day pull
  // window) — good enough for a direction-of-travel read, not a precise MoM %.
  const monthly = {};
  for (const d of dailyTrend) {
    const mk = d.date.slice(0, 7);
    const bucket = monthly[mk] || (monthly[mk] = { month: mk, sales: 0, orders: 0, profit: 0, revenue: 0 });
    bucket.sales += d.todaySales;
    bucket.orders += d.orders;
    for (const p of d.products || []) { bucket.profit += p.profit; bucket.revenue += p.revenue; }
  }
  // returnOrders/cancelledOrders come from the raw per-order pull (monthlyOrderTrend),
  // not the daily-aggregated rows above, since refund/cancellation status isn't
  // part of the per-day dashboard trend doc.
  const monthlyTrend = Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month)).map((m) => {
    const orderStats = (monthlyOrderTrend || []).find((o) => o.month === m.month) || {};
    return {
      month: m.month, sales: money(m.sales), orders: m.orders,
      margin: m.revenue ? money((m.profit / m.revenue) * 100) : 0,
      returnOrders: orderStats.returnOrders || 0,
      cancelledOrders: orderStats.cancelledOrders || 0,
    };
  });

  // Growth: rolling last-30-vs-prior-30 days (not calendar months), so it's
  // meaningful regardless of where in the month the sync happens to run.
  const sorted = [...dailyTrend].sort((a, b) => a.date.localeCompare(b.date));
  const last30 = sorted.slice(-30).reduce((s, d) => s + d.todaySales, 0);
  const prev30 = sorted.slice(-60, -30).reduce((s, d) => s + d.todaySales, 0);

  const deadStockValue = deadStock.reduce((s, d) => s + d.capital, 0);
  // Proxy for revenue exposed by items currently unavailable: what their last
  // 30 days of demand would have been worth at their normal price — not an
  // exact lost-sales figure (some of that demand may have gone to a
  // substitute item instead), but a useful order-of-magnitude signal.
  const stockOutRevenueAtRisk = stockOut.reduce((s, d) => s + d.sold30 * (d.price || 0), 0);
  const atRiskValue = customerSegments.atRisk.reduce((s, c) => s + c.spent, 0);

  // Product/customer/channel concentration are computed separately per period
  // (This Month / Last Month / Last 90 Days) in compute() — see
  // concentrationByPeriod, merged in by the caller — since a concentration
  // figure only means something read against a specific window.
  return {
    monthlyTrend,
    growth: {
      last30Sales: money(last30), prev30Sales: money(prev30),
      changePct: prev30 ? money(((last30 - prev30) / prev30) * 100) : null,
    },
    deadStockPct: endingInventoryRetailValue ? money((deadStockValue / endingInventoryRetailValue) * 100) : 0,
    stockOutRevenueAtRisk: money(stockOutRevenueAtRisk),
    atRiskValue: money(atRiskValue),
    atRiskCount: customerSegments.atRisk.length,
  };
}

// ---------- AI-generated advisor commentary (Claude) ----------
// Replaces the rule-based buildInsights() output above when available, using
// the exact same array-of-strings shape so the dashboard's Advisor panel
// and the email's Recommendations section need no changes either way. Falls back to
// the rule-based insights (already computed) if the key isn't configured or
// the call fails — the sync never breaks because of an AI outage.
async function generateAIInsights(context) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("AI insights skipped (ANTHROPIC_API_KEY not configured).");
    return null;
  }

  try {
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: "claude-opus-4-8",
      // 1024 was too tight once thinking tokens (adaptive) share this same
      // budget — could truncate the JSON output mid-string before it
      // finished (same failure mode already fixed in generateStrategicAnalysis
      // below by raising its max_tokens; applying the same fix here).
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system: `You are a business advisor (Chief Data Officer) for Gearevo, a knife/gear retailer in Malaysia selling through Shopify, Shopee, and TikTok Shop.

${BUSINESS_CONTEXT}

Write 3-6 concise observations in casual, everyday Bahasa Malaysia (Malay) — how a Malaysian shop staff member actually TEXTS a colleague on WhatsApp, not how a report or news article is written. NOT baku/standard Malay, NOT formal, NOT bombastic. Example style: "Jualan bulan ni baru RM99,439, 26% je dari target RM380,000. Kena push lagi sebab baki masa dah tak banyak." Not: "Jualan bulan ini baharu mencapai..." / "Perlu ditingkatkan segera kerana..." — that register is exactly what to avoid.

Concretely: use "ni"/"tu" not "ini"/"itu", "tak"/"x" not "tidak", "nak" not "hendak", "je"/"aje" not "sahaja", "dah" not "sudah", "kat" not "di", "bagi"/"kasi" not "berikan", "kena" for "perlu/harus", contractions like "tak yah" over "tidak perlu". Sprinkle natural particles (lah, kan, kot, ni) where a real person would. Mixing in English business words as-is (target, stock, promo, restock, tracking) is normal Malaysian speech, not a mistake to avoid. Keep it consistent line to line — don't let it drift back into formal Malay partway through a sentence.

Strict rules:
- Casual Malay throughout, but NEVER translate product names, SKUs, or brand names — keep them exactly as given in the data (e.g. "F. Herder 8" Broadblade" stays exactly as-is, don't Malay-ify it). Numbers, RM figures, and percentages also stay in their original format.
- Only use the numbers given below. DO NOT invent figures, trends, or product names that aren't in the data.
- Don't force an observation for a metric that has no issue — prioritize the most important and actionable points first.
- Keep each sentence short (1-2 sentences), including a suggested action where relevant.
- Also mention something positive if there is one, not just problems.
- All figures below (yesterday, mtdThroughYesterday, weekOverWeek) are through the end of asOfDate, a fully completed day — NOT a live, still-accumulating "today." Phrase observations that way (e.g. "jualan MTD sehingga [date]" or "jualan semalam"), never as "setakat ini hari ini" or "buat masa ini."`,
      messages: [{
        role: "user",
        content: `Gearevo business data as of the end of ${context.asOfDate}:\n\n${JSON.stringify(context, null, 2)}`,
      }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { insights: { type: "array", items: { type: "string" } } },
            required: ["insights"],
            additionalProperties: false,
          },
        },
      },
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) {
      console.log(`AI insights skipped: no text block in response (stop_reason: ${response.stop_reason}), using rule-based fallback.`);
      return null;
    }
    const parsed = JSON.parse(textBlock.text);
    if (!parsed || !Array.isArray(parsed.insights) || !parsed.insights.length) {
      console.log(`AI insights skipped: response had no usable "insights" array, using rule-based fallback.`);
      return null;
    }
    return parsed.insights;
  } catch (e) {
    console.log(`AI insights failed, using rule-based fallback: ${e.message}`);
    return null;
  }
}

// Director-level strategic narrative for the "Business Analysis" tab —
// deliberately a separate call/prompt from generateAIInsights above: that one
// is daily/tactical ("what to do today"), this one is sustainability-focused
// ("is the business on a path that survives"). No rule-based fallback exists
// for this one (unlike the daily insights) since it's a new, optional section —
// if the key isn't configured or the call fails, the tab just omits the
// narrative and shows the data/charts on their own.
async function generateStrategicAnalysis(context) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  try {
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system: `You are the Managing Director of Gearevo, a knife/gear retailer in Malaysia selling through Shopify, Shopee, and TikTok Shop. You are reviewing this snapshot to decide what to do next — not to describe the numbers, but to act on them.

${BUSINESS_CONTEXT}

Think in two tiers, and make the tier explicit in what you write:
1. DECIDE NOW — real-time/point-in-time facts that describe the business's current state and may need action this week (out-of-stock revenue exposure, dead stock capital, at-risk customer value). These aren't trends, they're the situation as of today. Before flagging dead stock or a slow product as a problem, consider whether it's a seasonal item currently between seasons rather than genuinely dead.
2. WATCH OR ACT ON TREND — anything given across multiple periods (concentrationByPeriod has thisMonth/lastMonth/last90d for product, customer, and channel concentration; monthlyTrend has multiple months of sales/margin/orders). For these, EXPLICITLY compare periods before concluding anything:
   - First check whether a spike or drop lines up with the seasonal/promotional pattern above (Eid Adha, a payday sale, Merdeka, Christmas, post-season clearance) — if so, call it seasonal/promotional and move on, don't recommend restructuring the business over an expected cycle.
   - If a concentration figure is high this month but was normal last month and over the 90-day baseline, AND it isn't explained by seasonality or a promo, call it a one-off, not a structural risk.
   - If it's consistently high across this month, last month, AND the 90-day window, and isn't seasonal/promotional, call it a real structural dependency and treat it as higher priority.
   - If growth or margin is moving consistently in one direction across the months given, say so plainly (growing/stagnant/declining) rather than hedging — but check first whether that direction matches the expected seasonal/promotional cycle.

Write 5-8 observations in plain business English, each 1-3 sentences. Cover, where the data supports it:
- Overall trajectory verdict (growing/stagnant/declining) from monthlyTrend.
- Which concentration risks (product/customer/channel) are one-off vs structural, per the period-comparison rule above.
- Capital efficiency: dead stock tied-up capital vs. revenue exposure from being out of stock — which is the bigger problem right now.
- Customer base health: new customers vs. at-risk value, and whether the lifetime customer concentration figure suggests a different risk profile than the short-term ones.
- If basketAnalysis has entries, call out the strongest cross-sell/bundle opportunity (highest lift) as a concrete action — e.g. bundling, "frequently bought together" placement, or a suggested promo pairing. Skip this if basketAnalysis is empty; don't force it.
- 2-3 concrete, specific actions to take THIS MONTH, each tied to a specific number from the data (not generic advice like "monitor closely").

Strict rules:
- Only use the numbers given. DO NOT invent figures, trends, or product/customer names that aren't in the data.
- Be honest if the data shows risk — don't be overly positive if the numbers don't support it. Equally, don't manufacture urgency out of a single noisy data point.
- Don't repeat the same sentence format as the daily tactical report ("Recommendations") — this should read like an executive is deciding, not a dashboard summarizing.`,
      messages: [{
        role: "user",
        content: `Gearevo business analysis data (snapshot ${context.date}):\n\n${JSON.stringify(context, null, 2)}`,
      }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { analysis: { type: "array", items: { type: "string" } } },
            required: ["analysis"],
            additionalProperties: false,
          },
        },
      },
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) {
      console.log(`Strategic analysis skipped: no text block in response (stop_reason: ${response.stop_reason}).`);
      return null;
    }
    const parsed = JSON.parse(textBlock.text);
    if (!parsed || !Array.isArray(parsed.analysis) || !parsed.analysis.length) {
      console.log(`Strategic analysis skipped: response had no usable "analysis" array.`);
      return null;
    }
    return parsed.analysis;
  } catch (e) {
    console.log(`Strategic analysis failed: ${e.message}`);
    return null;
  }
}

// ---------- email (EmailJS, server-side) ----------
// Sent at 8am MYT, so "today" is barely a few hours old — the report is about
// YESTERDAY's finished day (from daily/{yesterday}), not the in-progress today.
async function sendEmail(m, yesterday) {
  const { EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY, REPORT_TO } = process.env;
  if (!EMAILJS_SERVICE_ID || !REPORT_TO) { console.log("Email skipped (not configured)."); return; }

  const topMTD = m.topProductsMTD?.[0] || m.topProducts?.[0]; // fall back for older cached metrics
  const changeStr = yesterday.changePct == null ? "" :
    ` (${yesterday.changePct >= 0 ? "↑" : "↓"}${Math.abs(yesterday.changePct).toFixed(0)}%)`;

  // `null` = conditionally omitted (e.g. no stock alerts); `""` = an
  // intentional blank line for section spacing. Filtering strictly on `null`
  // (not the old .filter(Boolean)) keeps the blank-line spacers — .filter(Boolean)
  // was silently stripping every "" spacer too, which is why the email had no
  // breathing room between sections at all.
  const lines = [
    `Good morning Boss.`,
    ``,
    `📊 SALES`,
    `Yesterday (${yesterday.date}): ${rm(yesterday.todaySales)}${changeStr} — ${yesterday.orders} orders`,
    `This month: ${rm(m.mtd.sales)}${m.mtd.target ? ` / ${rm(m.mtd.target)} (${m.mtd.targetPct}%)` : " (no target set for this month)"}`,
    ``,
    `💰 PROFIT`,
    `Margin: ${m.mtd.margin}%   Gross Profit: ${rm(m.mtd.grossProfit)}`,
    `AOV: ${rm(m.mtd.aov)}   Returns: ${m.returnsRate}%`,
    ``,
    `🏆 PRODUCTS`,
    `Top product (this month): ${topMTD?.title || "-"} — ${rm(topMTD?.profit || 0)} profit`,
    (m.stockAlerts.length || m.stockOut?.length) ? `` : null,
    (m.stockAlerts.length || m.stockOut?.length) ? `⚠️ STOCK` : null,
    m.stockOut?.length ? (() => {
      const withDemand = m.stockOut.filter((s) => s.sold30 > 0).length;
      const worst = m.stockOut[0]; // pre-sorted by sold30 descending
      const demandStr = withDemand ? ` (${withDemand} with sales in last 30 days)` : "";
      return `Out of stock: ${m.stockOut.length} SKUs${demandStr} — best seller: ${worst.title} (${worst.sold30} units/30d, suggest ordering ${worst.reorderQty} units)`;
    })() : null,
    m.stockAlerts.length ? (() => {
      const critical = m.stockAlerts.filter((a) => a.urgency === "critical").length;
      const worst = m.stockAlerts[0]; // pre-sorted by daysLeft ascending
      const tierStr = critical ? `Low stock: ${m.stockAlerts.length} SKUs (${critical} critical)` : `Low stock: ${m.stockAlerts.length} SKUs`;
      const daysStr = worst.daysLeft === 0 ? "already out" : `${worst.daysLeft} days left`;
      return `${tierStr} — most urgent: ${worst.title} (${daysStr}, runs out ~${worst.stockoutDate}, suggest ordering ${worst.reorderQty} units)`;
    })() : null,
    ``,
    `📋 RECOMMENDATIONS`,
    ...m.insights.map((i) => `• ${i}`),
  ];
  const body = lines.filter((line) => line !== null).join("\n");

  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY,
      template_params: { to_email: REPORT_TO, subject: `Gearevo Report ${yesterday.date}`, message: body },
    }),
  });
  console.log(res.ok ? "Email sent." : `Email failed: ${res.status} ${await res.text()}`);
}

// ---------- run modes ----------
// FULL: once a day — full product + 90-day order pull, recomputes everything
//   (mtd, margin, dead stock, top products, byRegion/byChannel, and the whole
//   90-day daily trend so any day self-corrects for late refunds).
// QUICK: every other run — today's orders only, updates just today.sales/orders.
// Which mode runs is decided by a Firestore flag (sync/state.lastFullSyncDate),
// not by wall-clock time, so a missed/failed run can't skip the day's full sync.
// The daily EmailJS report is separate from both — see sendDailyEmailIfDue —
// since the CEO wants it at 8am MYT specifically, not whenever the full
// analytics recompute happens to land (currently just after MYT midnight).
// Deliberately independent of the Gearevo sales dashboard/pipeline -- this
// project's own Firestore (`db`, already ceo-dashboard-9e9b4 via FIREBASE_SA
// above) is both where the rotating OAuth token lives (config/shopeeAuth)
// and where the resulting ad-spend numbers land (shopeeAds/{date}), so this
// whole feature has no dependency on Gearevo's Firestore or its own sync.py.
const SHOPEE_HOST = "https://partner.shopeemobile.com";
// Shopee's WAF silently 403s the default fetch User-Agent.
const SHOPEE_HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Content-Type": "application/json" };

function shopeeSign(path, timestamp, accessToken) {
  let base = `${SHOPEE_PARTNER_ID}${path}${timestamp}`;
  if (accessToken) base += `${accessToken}${SHOPEE_SHOP_ID}`;
  return crypto.createHmac("sha256", SHOPEE_PARTNER_KEY).update(base).digest("hex");
}

// Returns a live access_token, refreshing only when the cached one is
// stale/near-expiry. The rotated refresh_token is persisted back to
// Firestore BEFORE returning -- Shopee kills the old refresh_token the
// instant it issues a new one, so a crash after this call but before the
// write would strand the pipeline until someone re-authorizes by hand.
// Throws if config/shopeeAuth hasn't been seeded -- see shopee_seed_token.py.
async function getShopeeAccessToken() {
  const authRef = db.doc("config/shopeeAuth");
  const snap = await authRef.get();
  if (!snap.exists) throw new Error("config/shopeeAuth not seeded -- run shopee_seed_token.py once first");
  const auth = snap.data();

  if (auth.accessToken && Date.now() < auth.expiresAt - 5 * 60 * 1000) {
    return auth.accessToken;
  }

  const path = "/api/v2/auth/access_token/get";
  const ts = Math.floor(Date.now() / 1000);
  const url = new URL(SHOPEE_HOST + path);
  url.searchParams.set("partner_id", SHOPEE_PARTNER_ID);
  url.searchParams.set("timestamp", ts);
  url.searchParams.set("sign", shopeeSign(path, ts));

  const res = await fetch(url, {
    method: "POST",
    headers: SHOPEE_HEADERS,
    body: JSON.stringify({ partner_id: Number(SHOPEE_PARTNER_ID), refresh_token: auth.refreshToken, shop_id: Number(SHOPEE_SHOP_ID) }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Shopee token refresh failed: ${JSON.stringify(data)}`);

  await authRef.set({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expire_in * 1000,
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  return data.access_token;
}

// One call covers the whole window (unlike Shopify, Shopee's ads report
// takes start_date/end_date directly) -- returns Map<"YYYY-MM-DD", {...}>.
// Only expense/broad_gmv/broad_item_sold/broad_roas are used. broad_order
// was tried and dropped: summed across a range it ran ~10-20% above Seller
// Center's own "Orders" tile (an order touching multiple ad campaigns
// appears to get counted once per campaign), while these four fields
// matched Seller Center exactly during verification.
async function fetchShopeeAdsRange(accessToken, startDate, endDate) {
  const toDDMMYYYY = (iso) => { const [y, m, d] = iso.split("-"); return `${d}-${m}-${y}`; };
  const path = "/api/v2/ads/get_all_cpc_ads_daily_performance";
  const ts = Math.floor(Date.now() / 1000);
  const url = new URL(SHOPEE_HOST + path);
  url.searchParams.set("partner_id", SHOPEE_PARTNER_ID);
  url.searchParams.set("timestamp", ts);
  url.searchParams.set("sign", shopeeSign(path, ts, accessToken));
  url.searchParams.set("shop_id", SHOPEE_SHOP_ID);
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("start_date", toDDMMYYYY(startDate));
  url.searchParams.set("end_date", toDDMMYYYY(endDate));

  const byDate = new Map();
  const res = await fetch(url, { headers: SHOPEE_HEADERS });
  const data = await res.json();
  if (data.error || !data.response) {
    console.log(`   Shopee ads range fetch (${startDate} -> ${endDate}) — HTTP ${res.status}: ${JSON.stringify(data)}`);
    return byDate;
  }

  for (const row of data.response) {
    const expense = Number(row.expense || 0);
    const sales = Number(row.broad_gmv || 0);
    const [d, m, y] = row.date.split("-"); // Shopee returns DD-MM-YYYY
    byDate.set(`${y}-${m}-${d}`, {
      adSpend: money(expense),
      adSales: money(sales),
      adItemsSold: Number(row.broad_item_sold || 0),
      adRoas: expense ? money(sales / expense) : 0,
    });
  }
  return byDate;
}

// Best-effort, matching the rest of runFull()'s Shopify-side conventions --
// a Shopee outage or dead refresh_token should never take down the actual
// sales sync. Writes to its own shopeeAds/{date} collection, independent of
// daily/{date} (which is Shopify-sourced sales, a different concern).
//
// scope="month" (runFull, once/day) fetches from the 1st of the current MYT
// month through today -- calendar-month-to-date, which is both exactly what
// the "This Month" card needs AND, by construction, never exceeds ~31 days,
// safely under Shopee's hard "date range can't be longer than 1 month" cap
// (a fixed rolling window doesn't guarantee that -- 90 days blew past it
// outright, and 30 still hit it since the inclusive span came to 31 days).
// scope="today" (runQuick, every ~2 min) fetches just today, since
// re-fetching+rewriting the whole month on every tick would be pure waste
// against both Shopee's API and Firestore's write quota.
async function syncShopeeAds(scope = "month") {
  try {
    const accessToken = await getShopeeAccessToken();
    const end = myDateStr(new Date());
    const start = scope === "today" ? end : `${myMonthKey(new Date())}-01`;
    const byDate = await fetchShopeeAdsRange(accessToken, start, end);
    if (byDate.size === 0) {
      console.log("Shopee ads — no data returned for the window, skipping writes.");
      return;
    }
    let batch = db.batch();
    let count = 0;
    for (const [dateStr, ads] of byDate) {
      batch.set(db.doc(`shopeeAds/${dateStr}`), { date: dateStr, ...ads, syncedAt: new Date().toISOString() }, { merge: true });
      count++;
      if (count >= 400) { await batch.commit(); batch = db.batch(); count = 0; }
    }
    if (count > 0) await batch.commit();
    console.log(`Shopee ads — synced ${byDate.size} days.`);
  } catch (e) {
    console.error(`Shopee ads sync failed (non-fatal): ${e.message}`);
  }
}

async function runFull() {
  const raw = await pull();
  const metrics = await compute(raw);
  const { dailyTrend, monthlyOrderTrend, concentrationByPeriod, ...latest } = metrics;

  const customers = await pullCustomers();
  latest.customerSegments = computeCustomerSegments(customers);
  if (latest.customerSegments.newThisMonth > 0) {
    latest.insights.push(`${latest.customerSegments.newThisMonth} new customers this month.`);
  }
  if (latest.customerSegments.top5RevenuePct > 0) {
    latest.insights.push(`${latest.customerSegments.top5RevenuePct}% of all-time sales come from the top 5% of customers.`);
  }
  if (latest.customerSegments.atRisk.length > 0) {
    latest.insights.push(`${latest.customerSegments.atRisk.length} repeat customers haven't ordered in >6 months — consider reaching out.`);
  }

  // Excludes today from both windows — full sync runs once per MYT day, right
  // after midnight, so today's entry is still ~empty at that point and would
  // otherwise silently drag last7DaysSales down by a full day's worth of
  // sales for no real reason. See mtdThroughYesterday's comment in compute().
  const trendThroughYesterday = dailyTrend.filter((d) => d.date !== latest.date);
  const last7 = trendThroughYesterday.slice(-7).reduce((s, d) => s + d.todaySales, 0);
  const prev7 = trendThroughYesterday.slice(-14, -7).reduce((s, d) => s + d.todaySales, 0);
  const aiInsights = await generateAIInsights({
    // Everything here is "as of the end of yesterday," not "as of right now" —
    // full sync (and this AI call) runs once per MYT day, at the first sync
    // after midnight, when today has barely started. Using live/today figures
    // made the advisor's commentary a near-empty snapshot that then stayed
    // frozen (and increasingly wrong) for the rest of the day while the
    // dashboard's own KPIs kept updating live from the sales dashboard.
    asOfDate: myYesterdayStr(),
    yesterday: latest.yesterday,
    mtdThroughYesterday: latest.mtdThroughYesterday,
    returnsRate: latest.returnsRate,
    weekOverWeek: {
      last7DaysSales: money(last7),
      prev7DaysSales: money(prev7),
      changePct: prev7 ? money(((last7 - prev7) / prev7) * 100) : null,
    },
    topProductsMTD: (latest.topProductsMTD || []).slice(0, 5),
    deadStock: {
      count: latest.deadStock.length,
      totalValue: money(latest.deadStock.reduce((s, d) => s + d.capital, 0)),
    },
    stockAlerts: (latest.stockAlerts || []).slice(0, 5),
    stockOut: {
      count: (latest.stockOut || []).length,
      withRecentDemand: (latest.stockOut || []).filter((s) => s.sold30 > 0).length,
      topDemand: (latest.stockOut || []).slice(0, 5),
    },
    customerSegments: {
      newThisMonth: latest.customerSegments.newThisMonth,
      atRiskCount: latest.customerSegments.atRisk.length,
      top5RevenuePct: latest.customerSegments.top5RevenuePct,
    },
    endingInventoryRetailValue: latest.endingInventoryRetailValue,
  });
  if (aiInsights) latest.insights = aiInsights;

  latest.businessAnalysis = computeBusinessAnalysis({
    dailyTrend, monthlyOrderTrend, deadStock: latest.deadStock, stockOut: latest.stockOut,
    customerSegments: latest.customerSegments, endingInventoryRetailValue: latest.endingInventoryRetailValue,
  });
  latest.businessAnalysis.concentrationByPeriod = concentrationByPeriod;

  const strategicAnalysis = await generateStrategicAnalysis({
    date: latest.date,
    growth: latest.businessAnalysis.growth,
    monthlyTrend: latest.businessAnalysis.monthlyTrend,
    margin: latest.mtd.margin,
    // All three periods, so Claude can distinguish a one-off this month from
    // a persistent 90-day pattern — see concentrationByPeriod's own comment.
    concentrationByPeriod,
    lifetimeCustomerConcentrationPct: latest.customerSegments.top5RevenuePct,
    deadStockPct: latest.businessAnalysis.deadStockPct,
    stockOutRevenueAtRisk: latest.businessAnalysis.stockOutRevenueAtRisk,
    atRiskValue: latest.businessAnalysis.atRiskValue,
    atRiskCount: latest.businessAnalysis.atRiskCount,
    newThisMonth: latest.customerSegments.newThisMonth,
    totalCustomers: latest.customerSegments.totalCustomers,
    endingInventoryRetailValue: latest.endingInventoryRetailValue,
    basketAnalysis: (latest.basketAnalysis || []).slice(0, 5), // top cross-sell/bundle pairs, if any
  });
  if (strategicAnalysis) latest.businessAnalysis.strategicAnalysis = strategicAnalysis;

  // dailyTrend now spans the sales dashboard's entire history (not capped at
  // 90 days), so it's chunked into its own batches — Firestore caps a single
  // batch at 500 writes, and this collection only grows over time.
  let dailyBatch = db.batch();
  let dailyBatchCount = 0;
  for (const day of dailyTrend) {
    dailyBatch.set(db.doc(`daily/${day.date}`), day);
    dailyBatchCount++;
    if (dailyBatchCount >= 400) {
      await dailyBatch.commit();
      dailyBatch = db.batch();
      dailyBatchCount = 0;
    }
  }
  if (dailyBatchCount > 0) await dailyBatch.commit();

  const batch = db.batch();
  batch.set(db.doc("dashboard/latest"), latest);
  // Persisted separately from dashboard/latest (which only holds whatever's in
  // the current 90-day pull) so a month keeps its final orders/returns/
  // cancellations numbers permanently, even after it ages out of that window —
  // this is what lets later months compare against it.
  for (const monthRow of latest.businessAnalysis.monthlyTrend) {
    batch.set(db.doc(`monthly/${monthRow.month}`), monthRow, { merge: true });
  }
  batch.set(db.doc("sync/state"), { lastFullSyncDate: metrics.date, lastFullSyncAt: metrics.generatedAt });
  await batch.commit();
  console.log(`Full sync — dashboard/latest + ${dailyTrend.length} daily docs + ${latest.businessAnalysis.monthlyTrend.length} monthly docs.`);

  await syncShopeeAds();

  return metrics;
}

// One-off: bulk-copy the sales dashboard's entire daily history into our own
// daily/{date} collection (todaySales/orders only — that's all it has). Full
// sync already does this as part of every run (see pull()); this mode exists
// to refresh daily/{date} on demand without waiting for/triggering a full
// Shopify pull too.
async function runBackfillFromDashboard() {
  console.log(`Backfill — fetching all daily docs from ${OTHER_PROJECT_ID}...`);
  const dashboardDaily = await fetchAllDailySalesFromDashboard();

  let batch = db.batch();
  let inBatch = 0, synced = 0;
  for (const [dateStr, { sales, orders }] of dashboardDaily) {
    batch.set(db.doc(`daily/${dateStr}`), { date: dateStr, todaySales: sales, orders }, { merge: true });
    inBatch++;
    synced++;
    if (inBatch >= 400) {
      await batch.commit();
      batch = db.batch();
      inBatch = 0;
    }
  }
  if (inBatch > 0) await batch.commit();

  console.log(`Backfill — synced ${synced} daily docs from the sales dashboard.`);
  return null;
}

// Today's Sales/Sales This Month/Order Count (app.js's direct live listener
// on the Gearevo sales dashboard's own Firestore) and Returns/Cancelled/
// Gross Profit (fetched live from the Worker) are no longer relayed through
// here at all — both already read live from their real source, so writing a
// second, slower-to-update copy into dashboard/latest would just be a
// redundant, potentially-conflicting shadow of data that's already correct
// elsewhere. Quick sync now does the one thing nothing else covers: live
// inventory value, which only a Shopify products pull can compute. The
// monthly target is also not fetched here — the dashboard reads the Target
// card straight from Firestore itself (live onSnapshot listener).
async function runQuick() {
  const variantMap = await pullProducts();
  const inv = computeInventory(variantMap);
  await db.doc("dashboard/latest").set(inv, { merge: true });
  await syncShopeeAds("today"); // see syncShopeeAds()'s comment on scope
  console.log(`Quick sync — inventory RM${inv.endingInventoryRetailValue}.`);
  return null;
}

// Sends the EmailJS report once per MYT calendar day, on the first run at/after
// EMAIL_HOUR_MYT — tracked via sync/state.lastEmailDate so a missed run just
// catches up on the next tick instead of skipping the day. Uses this run's
// freshly computed full metrics if available (full-sync runs), otherwise reads
// whatever's already sitting in dashboard/latest (quick-sync runs) — no extra
// Shopify calls either way. `force` bypasses both the hour and once-per-day
// checks for manual testing (FORCE_EMAIL=true) and never touches the flag.
async function sendDailyEmailIfDue(freshMetrics, force) {
  if (!force) {
    const hourMy = toMYT(new Date()).getUTCHours();
    if (hourMy < EMAIL_HOUR_MYT) {
      console.log(`Email — not due yet (MYT hour ${hourMy} < ${EMAIL_HOUR_MYT}).`);
      return;
    }

    const todayStr = myDateStr(new Date());
    const state = (await db.doc("sync/state").get()).data() || {};
    if (state.lastEmailDate === todayStr) {
      console.log("Email — already sent today.");
      return;
    }
  }

  const metrics = freshMetrics || (await db.doc("dashboard/latest").get()).data();
  if (!metrics) { console.log("Email — no dashboard data yet, skipping."); return; }

  const yesterdayStr = myYesterdayStr();
  const dayBeforeStr = myDateStr(new Date(Date.now() - 48 * 60 * 60 * 1000));
  const [yesterdaySnap, dayBeforeSnap] = await Promise.all([
    db.doc(`daily/${yesterdayStr}`).get(),
    db.doc(`daily/${dayBeforeStr}`).get(),
  ]);
  const yesterday = yesterdaySnap.exists
    ? yesterdaySnap.data()
    : { date: yesterdayStr, todaySales: 0, orders: 0 };
  const dayBeforeSales = dayBeforeSnap.exists ? dayBeforeSnap.data().todaySales : 0;
  // Finished day vs. finished day — always a fair comparison, unlike "today" mid-day.
  yesterday.changePct = dayBeforeSales ? money(((yesterday.todaySales - dayBeforeSales) / dayBeforeSales) * 100) : null;

  await sendEmail(metrics, yesterday);

  if (force) { console.log("Email — forced test send."); return; }

  const todayStr = myDateStr(new Date());
  await db.doc("sync/state").set({ lastEmailDate: todayStr }, { merge: true });
  console.log(`Email — sent for ${todayStr}.`);
}

// ---------- main ----------
(async () => {
  const forceFull = process.env.FORCE_FULL === "true";
  const gotLock = await acquireLock(forceFull);
  if (!gotLock) {
    console.log("Another sync run is already in progress — skipping this run (no lock, no Shopify calls, no writes).");
    return;
  }

  try {
    await syncAllowlist();

    if (process.env.FORCE_BACKFILL === "true") {
      console.log("Mode: BACKFILL (from sales dashboard) — skipping Shopify + email.");
      await runBackfillFromDashboard();
      console.log("Done ✅");
      return;
    }

    const forceEmail = process.env.FORCE_EMAIL === "true";
    const todayStr = myDateStr(new Date());

    let mode = "quick";
    if (forceFull) {
      mode = "full";
    } else {
      const state = await db.doc("sync/state").get();
      const lastFullSyncDate = state.exists ? state.data().lastFullSyncDate : null;
      if (lastFullSyncDate !== todayStr) mode = "full";
    }

    console.log(`Mode: ${mode.toUpperCase()}${forceFull ? " (forced)" : ""}`);
    const metrics = mode === "full" ? await runFull() : await runQuick();
    await sendDailyEmailIfDue(metrics, forceEmail);

    console.log("Done ✅");
  } finally {
    await releaseLock();
  }
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
