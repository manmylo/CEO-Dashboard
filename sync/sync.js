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
 *   EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY
 *   (daily-report recipients are config/access.reportRecipients, managed from the Access page -- not a secret)
 *   ROOTSYS_API_KEY (optional — AI-generated advisor insights via rootsys.cloud's
 *   OpenAI-compatible endpoint, model hy3-tencent; falls back to
 *   rule-based buildInsights() if unset or the call fails)
 *   TIKTOK_ADVERTISER_ID (optional — TikTok Ads spend/sales/ROAS card; skipped
 *   entirely if unset. The access token itself is NOT an env var -- it's
 *   long-lived and seeded once into config/tiktokAuth via the "Seed TikTok
 *   token" GitHub Action, see seed-tiktok-token.js)
 *
 * The monthly sales target is NOT an env var — it's set by staff via a
 * Target card dropped on the current month in the dashboard's Calendar
 * (Year view). See getCurrentMonthTarget() below. If no Target card exists
 * for the current month, target is 0 and the dashboard shows "no target set".
 */

import admin from "firebase-admin";
import OpenAI from "openai";
import crypto from "crypto";
import { isExcluded, isExcludedTitle, getServiceCategory } from "./excluded-skus.js";
import { graphql, paginate, getRestockDates } from "./restock-lookup.js";
import { publishCalendarSlide } from "./calendar-slide.js";

// ---------- config ----------
// SHOP_DOMAIN/SHOP_TOKEN/SHOP_API_VERSION are read directly by
// restock-lookup.js (imported above) for the Shopify GraphQL endpoint.
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
// RESTOCK_LOOKBACK_DAYS itself now lives in restock-lookup.js (imported above)
// alongside the lookup logic that uses it.
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
//
// Eid Adha's Gregorian date is given explicitly (not left for the model to
// guess) because it's a lunar-calendar holiday that shifts ~11 days earlier
// every Gregorian year -- without a real date, the model has no way to know
// whether asOfDate (given in the user turn) falls before, during, or months
// after it, and was observed calling a report "before Raya Korban" when
// asOfDate was actually ~2 months AFTER it had already passed. The explicit
// "only mention it if asOfDate is actually near it" rule is what prevents
// that -- MUST be re-dated every year, this is not a fixed calendar day.
const BUSINESS_CONTEXT = `Gearevo sells across several distinct categories, not just butcher knives: (1) Kitchen & butcher knives/tools — knives, cleavers, boning/skinning tools, kitchen sets (F. Herder, Giesser, F. Dick, Victorinox Butcher, Wüsthof, Pirge, Icel, Swibo); (2) EDC & outdoor knives — folding/survival knives (Spyderco, Benchmade, CRKT, Kershaw, Civivi, Cold Steel, and more); (3) Parangs/machetes, a distinct Malaysian-market category; (4) sharpening tools and services (stones, sharpeners, honing rods, a sharpening class); (5) sheaths and carry gear (custom/ready-made Kydex, bags, cases).

Sales are NOT flat year-round — there's a real promotional/seasonal calendar:
- Eid Adha (Hari Raya Haji / Qurban / "Raya Korban") drives a hard spike in butcher/slaughter knife sales, followed by 1-2 months of tiered post-season clearance sales. Eid Adha 2026 falls around 27 May 2026 (±1 day for moon sighting) — it is a LUNAR calendar holiday and moves ~11 days earlier every Gregorian year, so this exact date applies to 2026 ONLY and must not be reused for other years. A spike in butcher-knife sales/concentration in the weeks before that date, or a drop in the 1-2 months after, is EXPECTED, not a red flag.
- The store also runs recurring PAYDAY SALES (tied to Malaysian salary payout dates, roughly monthly) plus Merdeka Day (Aug 31, fixed every year) and Christmas promotions. A short-term order/sales spike may simply be one of these routine promo events, not organic growth, a one-off anomaly, or a structural risk — don't over-read a single promotional month.

CRITICAL: before mentioning Eid Adha/Raya Korban at all, compare it against asOfDate (given in the data below). Only reference it if asOfDate actually falls within its run-up (roughly 6 weeks before) or its 1-2 month post-season clearance window. If asOfDate is well before or well after that window, do NOT call the current period "before Raya Korban" or otherwise imply it's imminent or ongoing — instead name whichever period actually matches asOfDate (a payday sale, Merdeka, Christmas, or just normal trading with no seasonal event nearby).

When you see a spike or drop that could be tied to any of the above (Eid Adha, a payday sale, Merdeka, Christmas, or post-season clearance) AND the timing genuinely lines up with asOfDate, say so explicitly rather than treating it as a structural risk, decline, or a problem to fix.`;

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

// The login allowlist (config/access.allowedEmails) used to be synced here
// from an ALLOWED_EMAILS GitHub Actions secret every run. It's now managed
// directly from the Access page (admin-only) instead, so an admin can
// add/remove staff without touching GitHub at all -- see firestore.rules'
// config/access update rule. The ALLOWED_EMAILS secret is unused as of this
// change and can be deleted from the repo's GitHub Actions secrets.

// graphql()/paginate() (Shopify GraphQL helper + cursor pagination) now live
// in restock-lookup.js (imported above), shared with check-restock.js.

// ---------- queries ----------
const Q_PRODUCTS = `
  query($cursor: String) {
    products(first: 25, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title productType vendor status
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
        // ACTIVE | DRAFT | ARCHIVED. Kept on every variant rather than
        // filtered out at the source on purpose -- computeInventory() MUST
        // still see drafts to match Shopify's own ending_inventory_retail_value
        // (see its comment: filtering by status there was tried and
        // undercounted). Only the sellable-stock lists skip them.
        status: p.status || "ACTIVE",
        category: p.productType || "Uncategorized",
        vendor: p.vendor || "",
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

// getRestockDates() (dead-stock restock-date lookup) now lives in
// restock-lookup.js (imported above), shared with check-restock.js.

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

// ---------- Assignment Sheet deadline reminders ----------
// Runs on every invocation (see the bottom of this file), independent of
// the sales-sync lock below -- these are time-sensitive (fire at a specific
// moment) and an unrelated concern from the Shopify sync work, so they
// shouldn't wait on or get skipped by that lock. Each notification is
// one-shot per assignment, tracked via a flag written onto the assignment
// doc itself (overdueNotifiedAt/dueSoonNotifiedAt) so re-running this every
// ~2 minutes (the external cron cadence -- see sync.yml) never double-sends.
//
// dueDate is stored as a naive "YYYY-MM-DDTHH:MM" local string (no
// timezone) -- see assignments.js's New/Edit modal -- meaning it's always
// Malaysia wall-clock time by convention, never a real UTC instant on its
// own. Appending "+08:00" is what turns it into one for comparison against
// Date.now().
function dueDateInstant(dueDate) { return new Date(`${dueDate.slice(0, 16)}:00+08:00`); }
function fmtDueTime(dueDate) {
  return dueDateInstant(dueDate).toLocaleString("en-MY", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kuala_Lumpur" });
}
// Kept in step with page-shell.js's NOTIF_TTL_DAYS -- notifications written
// from here and from the browser must expire on the same schedule, or the
// pile would only half-clear.
const NOTIF_TTL_DAYS = 10;
async function notifyOne(toEmail, { type, title, body, link }) {
  await db.collection("notifications").add({
    toEmail: (toEmail || "").toLowerCase(), type, title, body: body || "", link: link || "",
    createdAt: new Date().toISOString(), read: false,
    // Real Date -> Firestore Timestamp, which is what the TTL policy on this
    // collection needs (a string field can't be used for TTL). Matches
    // page-shell.js's notifExpiry() -- both must stay on the same window.
    expireAt: new Date(Date.now() + NOTIF_TTL_DAYS * 864e5),
  });
}
// Throttled to once every 15 min, not every single ~2-minute cron tick --
// neither reminder needs to-the-minute precision (nobody needs to know
// their task is overdue within 2 minutes of it happening), but the query
// below reads every matching assignment on every call, and running it 720
// times/day blew through the entire 50K/day Spark-plan Firestore read quota
// in a single day on its own once this shipped. sync/state.lastNotifyCheck
// tracks the last time this actually ran (not the sales-sync's own
// lastFullSyncDate/lastEmailDate fields -- a separate concern, same doc).
const NOTIFY_CHECK_INTERVAL_MS = 15 * 60 * 1000;
async function checkAssignmentNotifications() {
  const now = new Date();
  const stateSnap = await db.doc("sync/state").get();
  const lastCheck = stateSnap.exists ? stateSnap.data().lastNotifyCheck : null;
  if (lastCheck && now.getTime() - new Date(lastCheck).getTime() < NOTIFY_CHECK_INTERVAL_MS) {
    return; // too soon -- skip the read entirely, not just the notifications
  }
  await db.doc("sync/state").set({ lastNotifyCheck: now.toISOString() }, { merge: true });

  const nowMy = toMYT(now);
  const isPast8am = nowMy.getUTCHours() >= 8; // toMYT() shifts the instant so UTC getters read as MYT wall-clock, same trick as myDateStr()
  const tomorrowStr = myDateStr(new Date(now.getTime() + 24 * 60 * 60 * 1000));

  // Bounded to roughly "recent past + near future" via a plain range query
  // on dueDate itself (its YYYY-MM-DD... shape sorts correctly as a plain
  // string) -- both checks below only ever care about a due date within
  // about a day of now, so there's no reason to keep re-reading the FULL
  // assignments history (which only grows) on every single ~2-minute run.
  // No composite index needed -- a single inequality filter is auto-indexed.
  const cutoff = myDateStr(new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000));
  const snap = await db.collection("assignments").where("dueDate", ">=", cutoff).get();

  for (const docSnap of snap.docs) {
    const a = docSnap.data();
    if (!a.dueDate) continue;

    // 1. Deadline has passed -- nudge the CREATOR to go review/rate it,
    // once, regardless of current status (an unfinished overdue task still
    // deserves the nudge, not just a finished-but-unreviewed one).
    if (!a.overdueNotifiedAt && dueDateInstant(a.dueDate) <= now) {
      await notifyOne(a.assignedBy, {
        type: "assignment",
        title: "Assignment due",
        body: `"${a.title}" is due already — please review and rate it.`,
        link: `assignments.html?id=${docSnap.id}`,
      });
      await docSnap.ref.update({ overdueNotifiedAt: now.toISOString() });
    }

    // 2. Due tomorrow -- nudge every ASSIGNEE, once, from 8am MYT the day
    // before (not necessarily exactly at 8:00:00 -- whenever the next
    // ~2-minute check lands at/after that point, or immediately if the
    // assignment was only created later that same day). Skipped once
    // already done -- nothing left to remind them about.
    if (!a.dueSoonNotifiedAt && a.status !== "done" && a.dueDate.slice(0, 10) === tomorrowStr && isPast8am) {
      const time = fmtDueTime(a.dueDate);
      await Promise.all((a.assignedTo || []).map((email) => notifyOne(email, {
        type: "assignment",
        title: "Assignment due tomorrow",
        body: `"${a.title}" is due tomorrow at ${time}.`,
        link: `assignments.html?id=${docSnap.id}`,
      })));
      await docSnap.ref.update({ dueSoonNotifiedAt: now.toISOString() });
    }
  }
}

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
  const unitsBySkuDate = {}; // sku -> "YYYY-MM-DD" -> units, for D90's auto-filled windows
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
      // Per-SKU units per calendar day -- what auto-fills the D90 page's
      // W1/W2/W4 windows (see updateD90Tracking). Deliberately keyed by SKU
      // rather than product id: the existing daily/{date}.products array is
      // product-level, so it can't answer "how many of THIS variant sold",
      // which is exactly what a D90 entry tracks.
      if (v?.sku) {
        const bySku = unitsBySkuDate[v.sku] || (unitsBySkuDate[v.sku] = {});
        bySku[createdDateStr] = (bySku[createdDateStr] || 0) + qty;
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

  // Uncapped -- app.js's own "Show more" expand already handles an
  // arbitrarily long list fine (same reasoning as the Date Range table's own
  // aggregateProductsInRange(), which dropped its matching 20-item cap for
  // the same reason). totalProfit90/productConcentration below both
  // recompute from the raw byProduct object directly rather than reading
  // this array, so removing the cap here doesn't touch either of them.
  const rankProducts = (byProduct) => Object.values(byProduct)
    .sort((a, b) => b.profit - a.profit)
    .map((p) => ({
      title: p.title, profit: money(p.profit), revenue: money(p.revenue), units: p.units,
      margin: p.revenue ? money((p.profit / p.revenue) * 100) : 0,
    }));
  const topProducts = rankProducts(profitByProduct);
  const topProductsMTD = rankProducts(profitByProductMTD);
  // Full 90-day profit total, independent of topProducts' own length either
  // way -- concentration ratios (e.g. "top 5 = X% of profit") must divide by
  // this, not by summing whatever topProducts happens to hold.
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
    // Draft/archived products aren't on sale, so they can't be "dead"
    // stock, slow moving, overstocked, or an out-of-stock revenue risk --
    // every list built in this loop is about SELLABLE stock, and a draft
    // was showing up as dead purely because it had never sold (it can't).
    // Deliberately NOT filtered out of variantMap itself: computeInventory()
    // still counts drafts, which is what keeps it matching Shopify's own
    // ending_inventory_retail_value report (see its comment).
    if (v.status && v.status !== "ACTIVE") continue;
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
        vendor: v.vendor, cost: money(v.cost), price: money(v.price),
        capital: money(v.inventory * v.cost) });
    } else if (v.inventory > 0 && sold90 > 0 && dsi > SLOWMOVING_DSI_DAYS) {
      // vendor/cost/price included alongside dead stock's own candidates now
      // (same free lookup off the already-fetched variant, no extra API
      // call) so the dashboard's Slow Moving / Overstock exports can carry
      // the exact same rich column set Dead Stock's own export does.
      slowMoving.push({ title: v.productTitle, sku: v.sku, onHand: v.inventory,
        vendor: v.vendor, cost: money(v.cost), price: money(v.price),
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
  // One combined lookup for BOTH Dead Stock's own candidates and every
  // Slow Moving item (Overstock needs no separate lookup at all -- see
  // app.js's overstockRows(), a client-side filter over this exact
  // slowMoving array) -- a SKU only ever needs its restock history fetched
  // once, even though the two lists use the result differently below.
  console.log(`Checking restock dates for ${deadStockCandidates.length + slowMoving.length} candidate SKUs…`);
  const restockDates = await getRestockDates([...deadStockCandidates, ...slowMoving]);
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
  // Same "too new to judge" grace period Dead Stock gets, on purpose --
  // DSI (on-hand ÷ recent velocity) reads artificially high right after a
  // restock, since on-hand just jumped but velocity hasn't had
  // SLOWMOVING_DSI_DAYS to reflect any selling-through of the fresh stock
  // yet. Without this, a SKU that was fine before restocking looked
  // "overstocked" the moment new stock landed, purely from the timing of
  // the DSI math, not genuine slow-moving behavior. Previously exempted on
  // the reasoning that a SKU here already DID sell (unlike Dead Stock's
  // 0-sold rule) so a recent restock "doesn't disqualify" it -- but that
  // missed that the on-hand half of DSI is exactly what a restock changes.
  const slowMovingFiltered = [];
  let slowMovingExcluded = 0;
  for (const s of slowMoving) {
    const info = restockDates.get(s.sku) || { date: null };
    s.restockDate = info.date;
    const daysSinceRestock = info.date ? Math.floor((nowMs - new Date(info.date).getTime()) / 864e5) : null;
    if (info.date && daysSinceRestock < SLOWMOVING_DSI_DAYS) { slowMovingExcluded++; continue; }
    slowMovingFiltered.push(s);
  }
  slowMoving.splice(0, slowMoving.length, ...slowMovingFiltered);
  console.log(`Slow moving: ${slowMoving.length} of ${slowMoving.length + slowMovingExcluded} candidates `
    + `(${slowMovingExcluded} excluded — restocked too recently to judge).`);

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
    dailyTrend, monthlyOrderTrend, concentrationByPeriod, unitsBySkuDate, // all merged into businessAnalysis in runFull(), not written to dashboard/latest directly
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

// Despite requesting response_format: json_schema (strict) below, rootsys.cloud's
// hy3-tencent doesn't reliably honor it -- confirmed live: real responses have come
// back as prose ("Here's a summary of...") wrapping the actual JSON instead of pure
// JSON, which a plain JSON.parse(content) chokes on immediately (SyntaxError:
// Unexpected token 'H'...). Rather than trust the constraint blindly, this tries a
// direct parse first (the common/fast case when the model DOES behave), then falls
// back to slicing out the substring between the first "{" and the last "}" in the
// response and parsing THAT -- recovers the JSON even when the model wraps it in a
// sentence either side. Still throws (letting the caller's existing rule-based
// fallback take over) if neither parse succeeds, so a genuinely broken/empty
// response doesn't silently produce garbage.
function extractJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) throw new Error(`No JSON object found in response: ${content.slice(0, 80)}...`);
    return JSON.parse(content.slice(start, end + 1));
  }
}

// ---------- AI-generated advisor commentary (rootsys.cloud) ----------
// Replaces the rule-based buildInsights() output above when available, using
// the exact same array-of-strings shape so the dashboard's Advisor panel
// and the email's Recommendations section need no changes either way. Falls back to
// the rule-based insights (already computed) if the key isn't configured or
// the call fails — the sync never breaks because of an AI outage.
async function generateAIInsights(context) {
  if (!process.env.ROOTSYS_API_KEY) {
    console.log("AI insights skipped (ROOTSYS_API_KEY not configured).");
    return null;
  }

  try {
    const rootsys = new OpenAI({ baseURL: "https://rootsys.cloud/v1", apiKey: process.env.ROOTSYS_API_KEY });
    const response = await rootsys.chat.completions.create({
      model: "hy3-tencent",
      // hy3-tencent is a reasoning model -- left enabled, a single call here
      // burned 150-180K reasoning tokens and took ~60s for output that's
      // just a handful of short strings. Disabling it (verified live: same
      // output quality, ~4s instead of ~60s) is the actual fix; this is a
      // fast tactical summary, not a task that needs deliberation.
      reasoning: { enabled: false },
      max_tokens: 4096,
      messages: [
        {
          role: "system",
          content: `You are a business advisor (Chief Data Officer) for Gearevo, a knife/gear retailer in Malaysia selling through Shopify, Shopee, and TikTok Shop.

${BUSINESS_CONTEXT}

Write 3-6 concise observations in casual, everyday Bahasa Malaysia (Malay) — how a Malaysian shop staff member actually TEXTS a colleague on WhatsApp, not how a report or news article is written. NOT baku/standard Malay, NOT formal, NOT bombastic. Example style: "Jualan bulan ni baru RM99,439, 26% je dari target RM380,000. Kena push lagi sebab baki masa dah tak banyak." Not: "Jualan bulan ini baharu mencapai..." / "Perlu ditingkatkan segera kerana..." — that register is exactly what to avoid.

Concretely: use "ni"/"tu" not "ini"/"itu", "tak"/"x" not "tidak", "nak" not "hendak", "je"/"aje" not "sahaja", "dah" not "sudah", "kat" not "di", "bagi"/"kasi" not "berikan", "kena" for "perlu/harus", contractions like "tak yah" over "tidak perlu". Sprinkle natural particles (lah, kan, kot, ni) where a real person would. Mixing in English business words as-is (target, stock, promo, restock, tracking) is normal Malaysian speech, not a mistake to avoid. Keep it consistent line to line — don't let it drift back into formal Malay partway through a sentence.

Strict rules:
- Casual Malay throughout, but NEVER translate product names, SKUs, or brand names — keep them exactly as given in the data (e.g. "F. Herder 8" Broadblade" stays exactly as-is, don't Malay-ify it). Numbers, RM figures, and percentages also stay in their original format.
- Only use the numbers given below. DO NOT invent figures, trends, or product names that aren't in the data.
- Don't force an observation for a metric that has no issue — prioritize the most important and actionable points first.
- Keep each sentence short (1-2 sentences), including a suggested action where relevant.
- Also mention something positive if there is one, not just problems.
- All figures below (yesterday, mtdThroughYesterday, weekOverWeek) are through the end of asOfDate, a fully completed day — NOT a live, still-accumulating "today." Phrase observations that way (e.g. "jualan MTD sehingga [date]" or "jualan semalam"), never as "setakat ini hari ini" or "buat masa ini."

OUTPUT FORMAT — this overrides any instinct to write a readable report:
Reply with a raw JSON object and NOTHING else. No preamble ("Here's a summary…"), no markdown headings, no code fences, no commentary after it. The very first character of your reply must be { and the very last must be }.
Exact shape (each observation is one string in the array):
{"insights": ["observation satu di sini", "observation dua di sini"]}`,
        },
        {
          role: "user",
          content: `Gearevo business data as of the end of ${context.asOfDate}:\n\n${JSON.stringify(context, null, 2)}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "insights",
          strict: true,
          schema: {
            type: "object",
            properties: { insights: { type: "array", items: { type: "string" } } },
            required: ["insights"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      console.log(`AI insights skipped: no content in response (finish_reason: ${response.choices?.[0]?.finish_reason}), using rule-based fallback.`);
      return null;
    }
    const parsed = extractJson(content);
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
  if (!process.env.ROOTSYS_API_KEY) return null;

  try {
    const rootsys = new OpenAI({ baseURL: "https://rootsys.cloud/v1", apiKey: process.env.ROOTSYS_API_KEY });
    const response = await rootsys.chat.completions.create({
      model: "hy3-tencent",
      // See generateAIInsights()'s comment above -- reasoning left enabled
      // turns this into a ~60s call for no quality gain.
      reasoning: { enabled: false },
      max_tokens: 4096,
      messages: [
        {
          role: "system",
          content: `You are the Managing Director of Gearevo, a knife/gear retailer in Malaysia selling through Shopify, Shopee, and TikTok Shop. You are reviewing this snapshot to decide what to do next — not to describe the numbers, but to act on them.

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
- Don't repeat the same sentence format as the daily tactical report ("Recommendations") — this should read like an executive is deciding, not a dashboard summarizing.

OUTPUT FORMAT — this overrides any instinct to write a readable report:
Reply with a raw JSON object and NOTHING else. No preamble ("Here's a structured analysis…"), no markdown headings (no "# Gearevo Business Analysis"), no code fences, no commentary after it. The very first character of your reply must be { and the very last must be }.
Exact shape (each observation is one string in the array; put the DECIDE NOW / WATCH OR ACT ON TREND tier inside the string itself):
{"analysis": ["DECIDE NOW — first observation here", "WATCH OR ACT ON TREND — second observation here"]}`,
        },
        {
          role: "user",
          content: `Gearevo business analysis data (snapshot ${context.date}):\n\n${JSON.stringify(context, null, 2)}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "analysis",
          strict: true,
          schema: {
            type: "object",
            properties: { analysis: { type: "array", items: { type: "string" } } },
            required: ["analysis"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      console.log(`Strategic analysis skipped: no content in response (finish_reason: ${response.choices?.[0]?.finish_reason}).`);
      return null;
    }
    const parsed = extractJson(content);
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

// ---------- D90 auto-fill ----------
// Fills each D90 entry's W1/W2/W4 with UNITS SOLD of that SKU inside the
// window, so the inventory team doesn't key them in by hand.
//
// Windows are contiguous and non-overlapping, each ending the day before
// the next begins, so no sale is counted twice:
//   W1: arrival day        -> arrival + 6   (the 7 days up to W1)
//   W2: arrival + 7        -> arrival + 13  (the 7 days up to W2)
//   W4: arrival + 14       -> arrival + 28  (W2 through to W4)
// A window is only written once it has FULLY elapsed -- a half-finished
// week would otherwise look like a genuinely weak one.
const D90_WINDOWS = [
  { key: "w1", from: 0, to: 6 },
  { key: "w2", from: 7, to: 13 },
  { key: "w4", from: 14, to: 28 },
];
function addDaysStr(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
async function updateD90Tracking(unitsBySkuDate) {
  if (!unitsBySkuDate) return;
  const snap = await db.collection("d90Tracking").get();
  if (snap.empty) { console.log("D90 auto-fill: no entries."); return; }
  const today = myDateStr(new Date());
  let touched = 0;

  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    const start = data.startDate;
    if (!start || !Array.isArray(data.items)) continue;

    let changed = false;
    const items = data.items.map((it) => {
      if (!it.sku) return it;
      const byDate = unitsBySkuDate[it.sku] || {};
      const sold = { ...(it.sold || {}) };
      for (const w of D90_WINDOWS) {
        const from = addDaysStr(start, w.from);
        const to = addDaysStr(start, w.to);
        if (today <= to) continue; // window still running -- leave it blank
        let units = 0;
        for (let d = from; d <= to; d = addDaysStr(d, 1)) units += byDate[d] || 0;
        if (sold[w.key] !== units) { sold[w.key] = units; changed = true; }
      }
      return { ...it, sold };
    });

    if (!changed) continue;
    await docSnap.ref.update({ items, autoFilledAt: new Date().toISOString() });
    touched++;
  }
  console.log(`D90 auto-fill: updated ${touched} of ${snap.size} entr${snap.size === 1 ? "y" : "ies"}.`);
}

// ---------- email (EmailJS, server-side) ----------
// Sent at 8am MYT, so "today" is barely a few hours old — the report is about
// YESTERDAY's finished day (from daily/{yesterday}), not the in-progress today.
// Returns whether an email was actually sent -- sendDailyEmailIfDue() below
// only marks the day as done when this is true, so an empty-recipients (or
// unconfigured-EmailJS) run doesn't get silently marked "sent" for the day
// and then skip the real send once recipients are actually ticked later.
// Yesterday's own daily target -- a Calendar "Sales Target" card
// (calendarCards, the same docs the Target Planner's Export to Calendar
// writes). getCurrentMonthTarget() above is the MONTHLY figure from
// yearlyCards and can't answer "did we hit it yesterday", which is what
// decides whether the email's headline goes red.
async function getDailyTargetFor(dateStr) {
  try {
    const snap = await db.collection("calendarCards")
      .where("cardType", "==", "target").where("date", "==", dateStr).limit(1).get();
    return snap.empty ? 0 : Number(snap.docs[0].data().targetAmount) || 0;
  } catch (err) {
    console.log(`Couldn't read the daily target for ${dateStr}: ${err.message}`);
    return 0;
  }
}
// "2026-08-21" -> "21 Aug 2026". Built from the parts rather than a Date
// object, which would re-interpret the string in UTC and can show the day
// before in a positive-offset timezone.
const EMAIL_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtEmailDate(dateStr) {
  const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(dateStr || "");
  return `${Number(m[3])} ${EMAIL_MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}
function emailEscape(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function sendEmail(m, yesterday) {
  const { EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY } = process.env;
  if (!EMAILJS_SERVICE_ID) { console.log("Email skipped (not configured)."); return false; }

  // Recipients used to be a single REPORT_TO GitHub Actions secret -- now
  // managed from the Access page instead (config/access.reportRecipients),
  // same reasoning as the allowedEmails move: an admin shouldn't need
  // GitHub access to add/remove who gets the report. Only ever people
  // already on allowedEmails -- the Access page's tick list is the only way
  // to add someone here.
  const accessSnap = await db.doc("config/access").get();
  const reportRecipients = (accessSnap.exists ? accessSnap.data().reportRecipients : []) || [];
  if (!reportRecipients.length) { console.log("Email skipped (no report recipients configured)."); return false; }
  const [to_email, ...bccList] = reportRecipients;

  const topMTD = m.topProductsMTD?.[0] || m.topProducts?.[0]; // fall back for older cached metrics
  const changeStr = yesterday.changePct == null ? "" :
    ` (${yesterday.changePct >= 0 ? "↑" : "↓"}${Math.abs(yesterday.changePct).toFixed(0)}%)`;

  // `null` = conditionally omitted (e.g. no stock alerts); `""` = an
  // intentional blank line for section spacing. Filtering strictly on `null`
  // (not the old .filter(Boolean)) keeps the blank-line spacers — .filter(Boolean)
  // was silently stripping every "" spacer too, which is why the email had no
  // breathing room between sections at all.
  // Did yesterday hit its own target? Drives the red headline below. No
  // target card for that day = nothing to judge against, so it just reads
  // as a plain figure rather than guessing a pass/fail.
  const dailyTarget = await getDailyTargetFor(yesterday.date);
  const missedTarget = dailyTarget > 0 && yesterday.todaySales < dailyTarget;
  const shortfall = missedTarget ? dailyTarget - yesterday.todaySales : 0;
  const surplus = dailyTarget > 0 && !missedTarget ? yesterday.todaySales - dailyTarget : 0;
  const targetSuffix = dailyTarget ? ` | Target ${rm(dailyTarget)}` : "";
  const verdictLine = dailyTarget
    ? (missedTarget ? `⚠️ BELOW TARGET by ${rm(shortfall)}` : `✅ Target achieved`)
    : null;

  const lines = [
    `Good morning Boss.`,
    ``,
    `📊 SALES`,
    `Yesterday (${yesterday.date}): ${rm(yesterday.todaySales)}${changeStr} — ${yesterday.orders} orders${targetSuffix}`,
    verdictLine,
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

  // A SECOND, styled copy of the same report -- big headline figure, red
  // when yesterday missed its target. Sent as its own template param rather
  // than replacing `message`, because the EmailJS template renders
  // {{message}} (double braces = HTML-escaped), so putting tags in there
  // would print a literal <span style=...> in the email. Nothing breaks
  // while the template still uses {{message}}: this param is simply
  // ignored. Swap the template to {{{message_html}}} (TRIPLE braces, raw)
  // to switch the report over to the styled version.
  // ---- HTML body ----------------------------------------------------
  // The same report, laid out properly instead of a wall of pre-formatted
  // text. Table-based and fully inline-styled: Gmail/Outlook strip <style>
  // blocks and have no flex/grid support, so this deliberately avoids both.
  //
  // Colour carries meaning and nothing else -- red only for a missed
  // target or an out-of-stock line, amber only for a warning, green only
  // for a target genuinely met. NEUTRAL when there's no target for the day:
  // green there would read as "hit it" when the truth is "nothing to hit".
  const OK = "#1a7f37", BAD = "#c0392b", WARN = "#b45309", INK = "#111827", MUTE = "#6b7280", LINE = "#e5e7eb";
  const headlineColour = !dailyTarget ? INK : (missedTarget ? BAD : OK);
  const section = (label, inner) => `<tr><td style="padding:18px 0 0">`
    + `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${MUTE};padding-bottom:7px;border-bottom:1px solid ${LINE};margin-bottom:10px">${label}</div>`
    + inner + `</td></tr>`;
  // Label/value pair rendered as a table row -- the only layout primitive
  // that behaves the same in every mail client.
  const stat = (label, value, colour) => `<td style="padding:4px 0">`
    + `<div style="font-size:11px;color:${MUTE}">${label}</div>`
    + `<div style="font-size:15px;font-weight:700;color:${colour || INK}">${value}</div></td>`;
  const note = (text, colour, bg) => `<div style="margin-top:8px;padding:9px 11px;border-radius:7px;`
    + `background:${bg};border-left:3px solid ${colour};font-size:13px;line-height:1.5;color:${INK}">${text}</div>`;

  const stockOutHtml = m.stockOut?.length ? (() => {
    const withDemand = m.stockOut.filter((s) => s.sold30 > 0).length;
    const worst = m.stockOut[0];
    return note(`<b style="color:${BAD}">${m.stockOut.length} SKUs out of stock</b>`
      + (withDemand ? ` — ${withDemand} sold in the last 30 days` : "")
      + `<br><span style="color:${MUTE}">Worst: ${emailEscape(worst.title)} · ${worst.sold30} units/30d · order ~${worst.reorderQty}</span>`, BAD, "#fef2f2");
  })() : "";
  const lowStockHtml = m.stockAlerts?.length ? (() => {
    const critical = m.stockAlerts.filter((a) => a.urgency === "critical").length;
    const worst = m.stockAlerts[0];
    const daysStr = worst.daysLeft === 0 ? "already out" : `${worst.daysLeft} days left`;
    return note(`<b style="color:${WARN}">${m.stockAlerts.length} SKUs low</b>`
      + (critical ? ` — ${critical} critical` : "")
      + `<br><span style="color:${MUTE}">Most urgent: ${emailEscape(worst.title)} · ${daysStr} · order ~${worst.reorderQty}</span>`, WARN, "#fffbeb");
  })() : "";

  const messageHtmlRaw = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK}">
  <p style="margin:0 0 16px;font-size:14px">Good morning Boss.</p>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">
    <tr><td style="border:1px solid ${LINE};border-left:4px solid ${headlineColour};border-radius:10px;padding:15px 17px;background:#fcfcfd">
      <div style="font-size:10.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:${MUTE}">Yesterday's Sales · ${emailEscape(fmtEmailDate(yesterday.date))}</div>
      <div style="font-size:34px;line-height:1.15;font-weight:800;color:${headlineColour};margin:7px 0 3px">${emailEscape(rm(yesterday.todaySales))}</div>
      <div style="font-size:12.5px;color:${MUTE}">${emailEscape(changeStr.trim())}${changeStr ? " · " : ""}${yesterday.orders} orders${dailyTarget ? ` · Target ${emailEscape(rm(dailyTarget))}` : ""}</div>
      ${dailyTarget
        ? `<div style="margin-top:9px;font-size:13.5px;font-weight:700;color:${headlineColour}">${missedTarget ? `Below target by ${emailEscape(rm(shortfall))}` : `Target achieved${surplus > 0 ? ` — ${emailEscape(rm(surplus))} over` : ""}`}</div>`
        : `<div style="margin-top:9px;font-size:12.5px;color:${MUTE}">No daily target set for this date.</div>`}
    </td></tr>

    ${section("This Month", `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
      ${stat("Sales", emailEscape(rm(m.mtd.sales)))}
      ${m.mtd.target ? stat("of Target", `${m.mtd.targetPct}%`, m.mtd.targetPct >= 100 ? OK : (m.mtd.targetPct < 50 ? BAD : WARN)) : stat("Target", "not set", MUTE)}
      ${m.mtd.target ? stat("Target", emailEscape(rm(m.mtd.target))) : ""}
    </tr></table>`)}

    ${section("Profit", `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
      ${stat("Margin", `${m.mtd.margin}%`)}
      ${stat("Gross Profit", emailEscape(rm(m.mtd.grossProfit)))}
      ${stat("AOV", emailEscape(rm(m.mtd.aov)))}
      ${stat("Returns", `${m.returnsRate}%`)}
    </tr></table>`)}

    ${section("Top Product This Month", `<div style="font-size:13.5px;line-height:1.5">${emailEscape(topMTD?.title || "—")}`
      + `<span style="color:${OK};font-weight:700"> · ${emailEscape(rm(topMTD?.profit || 0))} profit</span></div>`)}

    ${(stockOutHtml || lowStockHtml) ? section("Stock", stockOutHtml + lowStockHtml) : ""}

    ${m.insights?.length ? section("Recommendations",
      `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">`
      + m.insights.map((i) => `<tr>
          <td valign="top" style="width:14px;color:${MUTE};font-size:13px;line-height:1.6">•</td>
          <td style="font-size:13px;line-height:1.6;padding-bottom:4px">${emailEscape(i)}</td>
        </tr>`).join("")
      + `</table>`) : ""}
  </table>
</div>`;
  // Safe against the report text: emailEscape() has already turned every
  // < and > in it into entities, so this can only ever match the gaps
  // BETWEEN real tags, never inside the message body itself.
  const messageHtml = messageHtmlRaw.replace(/>\s+</g, "><");

  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY,
      template_params: { to_email, bcc_emails: bccList.join(","), subject: `Gearevo Report ${yesterday.date}`, message: body, message_html: messageHtml, header: "DAILY REPORT",
        link: "https://ceo-dashboard-9e9b4.web.app/index.html", link_label: "Open Dashboard" },
    }),
  });
  console.log(res.ok ? "Email sent." : `Email failed: ${res.status} ${await res.text()}`);
  return res.ok;
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

// ---------- TikTok Ads (Marketing API, report/integrated/get) ----------
// config/tiktokAuth.accessToken is long-lived (seeded once via the "Seed
// TikTok token" GitHub Action / seed-tiktok-token.js) -- unlike Shopee,
// there's no daily/hourly refresh_token rotation needed here.
// Metric field names confirmed live via check-tiktok-ads.js -- some
// documented-sounding names are REJECTED by the actual API (roas,
// shopping_roas, gross_revenue all failed); the ones actually used below
// are confirmed working: spend, total_onsite_shopping_value (ad-attributed
// sales), complete_payment (count of completed-payment conversion events --
// the closest available stand-in for "orders via ads"; TikTok's Shop Ads
// report has no confirmed item-quantity metric, unlike Shopee's
// broad_item_sold).
async function fetchTikTokAdsRange(accessToken, advertiserId, startDate, endDate) {
  const url = new URL("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/");
  url.searchParams.set("advertiser_id", advertiserId);
  url.searchParams.set("report_type", "BASIC");
  url.searchParams.set("data_level", "AUCTION_ADVERTISER");
  url.searchParams.set("dimensions", JSON.stringify(["advertiser_id", "stat_time_day"]));
  url.searchParams.set("metrics", JSON.stringify(["spend", "total_onsite_shopping_value", "complete_payment"]));
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("page_size", "100");

  const byDate = new Map();
  const res = await fetch(url, { headers: { "Access-Token": accessToken } });
  const data = await res.json();
  if (data.code !== 0) {
    console.log(`   TikTok ads range fetch (${startDate} -> ${endDate}) — ${JSON.stringify(data)}`);
    return byDate;
  }
  // Days with zero ad activity aren't returned as rows at all (confirmed
  // live -- a 14-day window with spend on only 6 of those days returned
  // exactly 6 rows), so a missing day means genuinely no spend, not a
  // fetch failure.
  for (const row of data.data?.list || []) {
    const dateStr = (row.dimensions.stat_time_day || "").slice(0, 10); // "YYYY-MM-DD 00:00:00" -> "YYYY-MM-DD"
    const spend = Number(row.metrics.spend || 0);
    const sales = Number(row.metrics.total_onsite_shopping_value || 0);
    byDate.set(dateStr, {
      adSpend: money(spend),
      adSales: money(sales),
      adOrders: Number(row.metrics.complete_payment || 0),
      adRoas: spend ? money(sales / spend) : 0,
    });
  }
  return byDate;
}

// Best-effort, matching syncShopeeAds()'s conventions exactly -- a TikTok
// outage should never take down the actual sales sync. Writes to its own
// tiktokAds/{date} collection. Same month/today scope split as Shopee ads
// (see that function's comment) for the same reasons. TIKTOK_ADVERTISER_ID
// unset just means the integration isn't configured yet -- skip quietly,
// same treatment as EMAILJS_SERVICE_ID/ROOTSYS_API_KEY being optional.
async function syncTikTokAds(scope = "month") {
  const advertiserId = process.env.TIKTOK_ADVERTISER_ID;
  if (!advertiserId) return;
  try {
    const authSnap = await db.doc("config/tiktokAuth").get();
    const accessToken = authSnap.exists ? authSnap.data().accessToken : null;
    if (!accessToken) { console.log("TikTok ads — no accessToken seeded yet, skipping."); return; }

    const end = myDateStr(new Date());
    const start = scope === "today" ? end : `${myMonthKey(new Date())}-01`;
    const byDate = await fetchTikTokAdsRange(accessToken, advertiserId, start, end);
    if (byDate.size === 0) {
      console.log("TikTok ads — no data returned for the window, skipping writes.");
      return;
    }
    let batch = db.batch();
    let count = 0;
    for (const [dateStr, ads] of byDate) {
      batch.set(db.doc(`tiktokAds/${dateStr}`), { date: dateStr, ...ads, syncedAt: new Date().toISOString() }, { merge: true });
      count++;
      if (count >= 400) { await batch.commit(); batch = db.batch(); count = 0; }
    }
    if (count > 0) await batch.commit();
    console.log(`TikTok ads — synced ${byDate.size} days.`);
  } catch (e) {
    console.error(`TikTok ads sync failed (non-fatal): ${e.message}`);
  }
}

async function runFull() {
  const raw = await pull();
  const metrics = await compute(raw);
  const { dailyTrend, monthlyOrderTrend, concentrationByPeriod, unitsBySkuDate, ...latest } = metrics;

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
  // Non-fatal on purpose -- D90 is a side feature, and a failure here must
  // never take down the sales sync that just finished writing.
  try {
    await updateD90Tracking(unitsBySkuDate);
  } catch (e) {
    console.error(`D90 auto-fill failed (non-fatal): ${e.message}`);
  }

  await syncShopeeAds();
  await syncTikTokAds();

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
  await syncTikTokAds("today");
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

  const sent = await sendEmail(metrics, yesterday);

  if (force) { console.log("Email — forced test send."); return; }

  // Only mark today done when an email actually went out -- otherwise a run
  // with no recipients configured yet (or EmailJS unconfigured) would mark
  // the day "sent" and permanently skip the real send once recipients are
  // ticked later today, since this only ever fires once per MYT day.
  if (!sent) { console.log("Email — not marking today done (nothing was actually sent)."); return; }

  const todayStr = myDateStr(new Date());
  await db.doc("sync/state").set({ lastEmailDate: todayStr }, { merge: true });
  console.log(`Email — sent for ${todayStr}.`);
}

// ---------- main ----------
(async () => {
  // Independent of the sales-sync lock below on purpose -- see
  // checkAssignmentNotifications()'s own comment. A failure here shouldn't
  // block the sales sync from running (or vice versa), so it's wrapped in
  // its own try/catch rather than sharing the outer one.
  try {
    await checkAssignmentNotifications();
  } catch (e) {
    console.error("Assignment notification check failed:", e);
  }

  const forceFull = process.env.FORCE_FULL === "true";
  const gotLock = await acquireLock(forceFull);
  if (!gotLock) {
    console.log("Another sync run is already in progress — skipping this run (no lock, no Shopify calls, no writes).");
    return;
  }

  try {
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
