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
 *   FIREBASE_SA, MONTHLY_TARGET,
 *   EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY, REPORT_TO
 */

import admin from "firebase-admin";
import { isExcluded } from "./excluded-skus.js";

// ---------- config ----------
const SHOP = process.env.SHOP_DOMAIN;
const TOKEN = process.env.SHOP_TOKEN;
const VER = process.env.SHOP_API_VERSION || "2026-01";
const TARGET = Number(process.env.MONTHLY_TARGET || 120000);
const ENDPOINT = `https://${SHOP}/admin/api/${VER}/graphql.json`;

const DEADSTOCK_DAYS = 90;      // window for "modal tidur" detection
const DEADSTOCK_MIN_UNITS = 5;  // sold <= this in window = suspect
const LOW_STOCK_DAYS = 14;      // stockout warning threshold
const EMAIL_HOUR_MYT = 8;       // send the daily report on the first run at/after this MYT hour

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
        id createdAt displayFinancialStatus
        totalPriceSet { shopMoney { amount } }
        subtotalPriceSet { shopMoney { amount } }
        totalRefundedSet { shopMoney { amount } }
        shippingAddress { province }
        channelInformation { channelDefinition { channelName } }
        refunds {
          createdAt
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

// Lean order shape for quick (today-only) syncs — no lineItems/cost, since quick
// runs only need net sales + order count, not margin/product analytics.
const Q_ORDERS_QUICK = `
  query($cursor: String, $q: String) {
    orders(first: 50, after: $cursor, query: $q, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id createdAt
        subtotalPriceSet { shopMoney { amount } }
        refunds {
          createdAt
          refundLineItems(first: 250) {
            nodes { subtotalSet { shopMoney { amount } } }
          }
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
      if (isExcluded(v.sku)) continue; // services/add-ons: not stock items
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

async function pull() {
  console.log("Fetching products + cost + stock…");
  const variantMap = await pullProducts();

  console.log("Fetching orders (last 90 days)…");
  const q = `created_at:>=${daysAgoISO(DEADSTOCK_DAYS)}`;
  const orders = await paginate(Q_ORDERS, (d) => d.orders, { q });

  return { variantMap, orders };
}

// ---------- compute ----------
function money(n) { return Math.round(n * 100) / 100; }

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
// The UTC instant corresponding to 00:00 MYT today — used to scope quick-sync's
// Shopify query to "today only" instead of re-fetching 90 days of orders.
function todayStartUtcISO() {
  const nowMy = toMYT(new Date());
  const wallClockUtcMs = Date.UTC(nowMy.getUTCFullYear(), nowMy.getUTCMonth(), nowMy.getUTCDate());
  return new Date(wallClockUtcMs - MY_OFFSET_MS).toISOString();
}

function compute({ variantMap, orders }) {
  const now = new Date();
  const nowMy = toMYT(now);
  const todayStr = nowMy.toISOString().slice(0, 10);
  const monthKey = nowMy.toISOString().slice(0, 7);

  let todaySubtotal = 0, todayOrders = 0, todayRefunds = 0;
  let mtdSubtotal = 0, mtdOrders = 0, mtdCost = 0, mtdRefunds = 0;
  let refundTotal = 0, grossTotal = 0;
  const byRegion = {}, byChannel = {}; // scoped to this month (MTD) — see targetPct-style window below
  const soldUnits30 = {}, soldUnits90 = {};
  const profitByProduct = {};    // full 90-day window — dashboard's default "All" view
  const profitByProductMTD = {}; // this month only — used by the email report
  const dailySubtotal = {}, dailyOrders = {}, dailyRefunds = {}; // per MYT day, for the trend chart
  const dailyProductProfit = {}; // { [date]: { [pid]: {title, profit, revenue, units} } } — lets the
                                  // dashboard's "date range" filter aggregate any custom range client-side

  for (const o of orders) {
    const created = new Date(o.createdAt);
    const createdDateStr = myDateStr(created);
    const createdMonthKey = myMonthKey(created);
    const total = num(o.totalPriceSet?.shopMoney?.amount);
    const subtotal = num(o.subtotalPriceSet?.shopMoney?.amount);
    const ageDays = (now - created) / 864e5;
    grossTotal += total;
    refundTotal += num(o.totalRefundedSet?.shopMoney?.amount);

    if (createdMonthKey === monthKey) {
      const prov = o.shippingAddress?.province || "Unknown";
      byRegion[prov] = (byRegion[prov] || 0) + total;
      const ch = o.channelInformation?.channelDefinition?.channelName || "Lain-lain";
      byChannel[ch] = (byChannel[ch] || 0) + total;
    }

    // Sales: every order placed in the window counts on its ORDER date, incl. later-cancelled
    // ones — exactly like Shopify. A cancellation nets out via its refund below.
    dailySubtotal[createdDateStr] = (dailySubtotal[createdDateStr] || 0) + subtotal;
    dailyOrders[createdDateStr] = (dailyOrders[createdDateStr] || 0) + 1;
    if (createdDateStr === todayStr) { todaySubtotal += subtotal; todayOrders++; }
    if (createdMonthKey === monthKey) { mtdSubtotal += subtotal; mtdOrders++; }

    // Refunds: dated by the REFUND's own date, regardless of which day the order was created.
    for (const r of o.refunds || []) {
      const refundAmt = (r.refundLineItems?.nodes || []).reduce(
        (s, rli) => s + num(rli.subtotalSet?.shopMoney?.amount), 0
      );
      const refundDateStr = myDateStr(r.createdAt);
      dailyRefunds[refundDateStr] = (dailyRefunds[refundDateStr] || 0) + refundAmt;
      if (refundDateStr === todayStr) todayRefunds += refundAmt;
      if (myMonthKey(r.createdAt) === monthKey) mtdRefunds += refundAmt;
    }

    for (const li of o.lineItems?.nodes || []) {
      if (isExcluded(li.sku)) continue; // exclude services from product analytics
      const vid = li.variant?.id;
      const v = vid ? variantMap.get(vid) : null;
      const qty = num(li.quantity);
      const lineRev = num(li.discountedTotalSet?.shopMoney?.amount);
      const lineCost = (v?.cost || 0) * qty;
      if (createdMonthKey === monthKey) mtdCost += lineCost;

      if (vid) {
        if (ageDays <= 30) soldUnits30[vid] = (soldUnits30[vid] || 0) + qty;
        soldUnits90[vid] = (soldUnits90[vid] || 0) + qty;
      }

      const pid = v?.productId || li.product?.id || li.product?.title || "unknown";
      const title = v?.productTitle || li.product?.title || "Unknown";
      profitByProduct[pid] = profitByProduct[pid] || { title, profit: 0, revenue: 0, units: 0 };
      profitByProduct[pid].profit += lineRev - lineCost;
      profitByProduct[pid].revenue += lineRev;
      profitByProduct[pid].units += qty;

      if (createdMonthKey === monthKey) {
        profitByProductMTD[pid] = profitByProductMTD[pid] || { title, profit: 0, revenue: 0, units: 0 };
        profitByProductMTD[pid].profit += lineRev - lineCost;
        profitByProductMTD[pid].revenue += lineRev;
        profitByProductMTD[pid].units += qty;
      }

      const dayBucket = dailyProductProfit[createdDateStr] || (dailyProductProfit[createdDateStr] = {});
      const dp = dayBucket[pid] || (dayBucket[pid] = { title, profit: 0, revenue: 0, units: 0 });
      dp.profit += lineRev - lineCost;
      dp.revenue += lineRev;
      dp.units += qty;
    }
  }

  const todaySales = todaySubtotal - todayRefunds;
  const mtdSales = mtdSubtotal - mtdRefunds;

  // Recomputed fresh from Shopify on every run (not just today) so a day's numbers
  // self-correct if a refund lands on it after the fact — see dailyRefunds above.
  // `products` lets the dashboard's date-range filter sum any custom range
  // client-side without a fresh Shopify pull — refreshed once/day (full sync).
  const dailyTrend = Object.keys({ ...dailySubtotal, ...dailyRefunds })
    .sort()
    .map((d) => ({
      date: d,
      todaySales: money((dailySubtotal[d] || 0) - (dailyRefunds[d] || 0)),
      orders: dailyOrders[d] || 0,
      products: Object.entries(dailyProductProfit[d] || {}).map(([pid, p]) => ({
        pid, title: p.title, profit: money(p.profit), revenue: money(p.revenue), units: p.units,
      })),
    }));

  const grossProfit = mtdSales - mtdCost;
  const margin = mtdSales ? (grossProfit / mtdSales) * 100 : 0;
  const returnsRate = grossTotal ? (refundTotal / grossTotal) * 100 : 0;

  const rankProducts = (byProduct) => Object.values(byProduct)
    .sort((a, b) => b.profit - a.profit).slice(0, 20)
    .map((p) => ({
      title: p.title, profit: money(p.profit), revenue: money(p.revenue), units: p.units,
      margin: p.revenue ? money((p.profit / p.revenue) * 100) : 0,
    }));
  const topProducts = rankProducts(profitByProduct);
  const topProductsMTD = rankProducts(profitByProductMTD);

  const deadStock = [], stockAlerts = [];
  for (const [vid, v] of variantMap) {
    const sold90 = soldUnits90[vid] || 0;
    const sold30 = soldUnits30[vid] || 0;
    if (v.inventory > 0 && sold90 <= DEADSTOCK_MIN_UNITS) {
      deadStock.push({ title: v.productTitle, sku: v.sku, onHand: v.inventory,
        capital: money(v.inventory * v.cost), sold90d: sold90 });
    }
    if (sold30 > 0) {
      const daysLeft = Math.floor(v.inventory / (sold30 / 30));
      if (daysLeft <= LOW_STOCK_DAYS) {
        stockAlerts.push({ title: v.productTitle, sku: v.sku, onHand: v.inventory, daysLeft });
      }
    }
  }
  deadStock.sort((a, b) => b.capital - a.capital);
  stockAlerts.sort((a, b) => a.daysLeft - b.daysLeft);

  return {
    generatedAt: now.toISOString(), date: todayStr,
    today: { sales: money(todaySales), orders: todayOrders },
    mtd: {
      sales: money(mtdSales), orders: mtdOrders,
      aov: mtdOrders ? money(mtdSales / mtdOrders) : 0,
      target: TARGET, targetPct: money((mtdSales / TARGET) * 100),
      grossProfit: money(grossProfit), margin: money(margin),
    },
    returnsRate: money(returnsRate),
    topProducts, topProductsMTD, // topProducts = full 90-day window (dashboard default); MTD = email only
    deadStock: deadStock.slice(0, 20), stockAlerts: stockAlerts.slice(0, 20),
    byRegion, byChannel, // both scoped to this month (MTD) — same window as mtd.sales
    ...computeInventory(variantMap),
    dailyTrend,
    insights: buildInsights({ mtdSales, margin, deadStock, stockAlerts, target: TARGET }),
  };
}

// ---------- quick sync (today only — no product/90-day pull) ----------
async function pullQuickToday() {
  const startIso = todayStartUtcISO();
  console.log(`Quick sync — fetching today's orders (since ${startIso})…`);
  const created = await paginate(Q_ORDERS_QUICK, (d) => d.orders, { q: `created_at:>=${startIso}` });
  const updated = await paginate(Q_ORDERS_QUICK, (d) => d.orders, { q: `updated_at:>=${startIso}` });
  return { created, updated };
}

function computeQuickToday({ created, updated }) {
  const todayStr = myDateStr(new Date());

  let todaySubtotal = 0, todayOrders = 0;
  for (const o of created) {
    if (myDateStr(o.createdAt) !== todayStr) continue;
    todaySubtotal += num(o.subtotalPriceSet?.shopMoney?.amount);
    todayOrders++;
  }

  let todayRefunds = 0;
  for (const o of updated) {
    for (const r of o.refunds || []) {
      if (myDateStr(r.createdAt) !== todayStr) continue;
      todayRefunds += (r.refundLineItems?.nodes || []).reduce(
        (s, rli) => s + num(rli.subtotalSet?.shopMoney?.amount), 0
      );
    }
  }

  return {
    date: todayStr,
    generatedAt: new Date().toISOString(),
    today: { sales: money(todaySubtotal - todayRefunds), orders: todayOrders },
  };
}

function buildInsights({ mtdSales, margin, deadStock, stockAlerts, target }) {
  const out = [];
  const pace = (mtdSales / target) * 100;
  if (pace < 70) out.push(`Jualan bulan ini baru ${pace.toFixed(0)}% dari sasaran RM${target.toLocaleString()}. Perlu push.`);
  else if (pace >= 100) out.push(`Sasaran bulanan dah tercapai (${pace.toFixed(0)}%). Bagus!`);
  if (margin < 40) out.push(`Margin ${margin.toFixed(1)}% rendah — semak diskaun atau kos.`);
  if (stockAlerts.length) out.push(`${stockAlerts.length} SKU akan habis stok dalam ${LOW_STOCK_DAYS} hari — buat pesanan.`);
  if (deadStock.length) {
    const tied = deadStock.reduce((s, d) => s + d.capital, 0);
    out.push(`RM${Math.round(tied).toLocaleString()} modal tidur dalam ${deadStock.length} SKU slow-moving — pertimbang clearance.`);
  }
  return out;
}

// ---------- email (EmailJS, server-side) ----------
// Sent at 8am MYT, so "today" is barely a few hours old — the report is about
// YESTERDAY's finished day (from daily/{yesterday}), not the in-progress today.
async function sendEmail(m, yesterday) {
  const { EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY, REPORT_TO } = process.env;
  if (!EMAILJS_SERVICE_ID || !REPORT_TO) { console.log("Email skipped (not configured)."); return; }

  const topMTD = m.topProductsMTD?.[0] || m.topProducts?.[0]; // fall back for older cached metrics
  const body = [
    `Good morning Boss.`, ``,
    `Jualan semalam (${yesterday.date}): RM${yesterday.todaySales} (${yesterday.orders} order)`,
    `Bulan ini: RM${m.mtd.sales} / RM${m.mtd.target} (${m.mtd.targetPct}%)`,
    `Margin: ${m.mtd.margin}%   Untung kasar: RM${m.mtd.grossProfit}`,
    `AOV: RM${m.mtd.aov}   Pulangan: ${m.returnsRate}%`, ``,
    `Top produk untung (bulan ini): ${topMTD?.title || "-"} (RM${topMTD?.profit || 0})`,
    m.stockAlerts.length ? `⚠️ Stock warning: ${m.stockAlerts.length} SKU bawah paras` : ``, ``,
    `Cadangan:`, ...m.insights.map((i) => `• ${i}`),
  ].filter(Boolean).join("\n");

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
async function runFull() {
  const raw = await pull();
  const metrics = compute(raw);
  const { dailyTrend, ...latest } = metrics;

  const batch = db.batch();
  batch.set(db.doc("dashboard/latest"), latest);
  for (const day of dailyTrend) {
    batch.set(db.doc(`daily/${day.date}`), day);
  }
  batch.set(db.doc("sync/state"), { lastFullSyncDate: metrics.date, lastFullSyncAt: metrics.generatedAt });
  await batch.commit();
  console.log(`Full sync — dashboard/latest + ${dailyTrend.length} daily docs.`);
  return metrics;
}

async function runQuick() {
  // Orders (today only) and products/inventory (always live, not tied to the
  // 90-day order window) both refresh every quick run.
  const [todayRaw, variantMap] = await Promise.all([pullQuickToday(), pullProducts()]);
  const q = computeQuickToday(todayRaw);
  const inv = computeInventory(variantMap);

  // dashboard/latest always gets a fresh write — Firestore bills per document
  // touched, not per field, so writing every run costs exactly the same as
  // writing conditionally, and it keeps "last synced" honest (a stale stamp
  // otherwise looks indistinguishable from a broken/skipped run). The one
  // write that's actually worth skipping is the separate daily/{date} doc,
  // since that's a second, genuinely avoidable write when nothing sold.
  const prevSnap = await db.doc("dashboard/latest").get();
  const prev = prevSnap.exists ? prevSnap.data() : {};
  const salesChanged = prev.today?.sales !== q.today.sales || prev.today?.orders !== q.today.orders;

  const batch = db.batch();
  batch.set(db.doc("dashboard/latest"),
    { date: q.date, generatedAt: q.generatedAt, today: q.today, ...inv }, { merge: true });
  if (salesChanged) {
    batch.set(db.doc(`daily/${q.date}`),
      { date: q.date, todaySales: q.today.sales, orders: q.today.orders }, { merge: true });
  }
  await batch.commit();
  console.log(`Quick sync — today RM${q.today.sales} (${q.today.orders} orders), `
    + `inventory RM${inv.endingInventoryRetailValue}${salesChanged ? "" : " (sales unchanged, daily doc write skipped)"}.`);
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
  const yesterdaySnap = await db.doc(`daily/${yesterdayStr}`).get();
  const yesterday = yesterdaySnap.exists
    ? yesterdaySnap.data()
    : { date: yesterdayStr, todaySales: 0, orders: 0 };

  await sendEmail(metrics, yesterday);

  if (force) { console.log("Email — forced test send."); return; }

  const todayStr = myDateStr(new Date());
  await db.doc("sync/state").set({ lastEmailDate: todayStr }, { merge: true });
  console.log(`Email — sent for ${todayStr}.`);
}

// ---------- main ----------
(async () => {
  const forceFull = process.env.FORCE_FULL === "true";
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
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
