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
            inventoryItem { unitCost { amount } }
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

// ---------- pull ----------
const num = (x) => Number(x || 0);
function daysAgoISO(n) { return new Date(Date.now() - n * 864e5).toISOString(); }

async function pull() {
  console.log("Fetching products + cost + stock…");
  const products = await paginate(Q_PRODUCTS, (d) => d.products);

  // variant GID -> details (incl. cost from inventoryItem.unitCost — inline, no extra call)
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
      });
    }
  }

  console.log("Fetching orders (last 90 days)…");
  const q = `created_at:>=${daysAgoISO(DEADSTOCK_DAYS)}`;
  const orders = await paginate(Q_ORDERS, (d) => d.orders, { q });

  return { variantMap, orders };
}

// ---------- compute ----------
function money(n) { return Math.round(n * 100) / 100; }

// ---------- Malaysia timezone (UTC+8) helpers ----------
// Net sales matches Shopify Analytics:
//   • sales (subtotal after discount) counted on the ORDER's created date (MYT)
//   • returns counted on the REFUND's own created/processed date (MYT), NOT the order's date
//   • order count INCLUDES cancelled orders (to match Shopify's order count)
const MY_OFFSET_MS = 8 * 60 * 60 * 1000;
function toMYT(dateInput) { return new Date(new Date(dateInput).getTime() + MY_OFFSET_MS); }
function myDateStr(dateInput) { return toMYT(dateInput).toISOString().slice(0, 10); }
function myMonthKey(dateInput) { return toMYT(dateInput).toISOString().slice(0, 7); }

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
  const profitByProduct = {};
  const dailySubtotal = {}, dailyOrders = {}, dailyRefunds = {}; // per MYT day, for the trend chart

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
    }
  }

  const todaySales = todaySubtotal - todayRefunds;
  const mtdSales = mtdSubtotal - mtdRefunds;

  // Recomputed fresh from Shopify on every run (not just today) so a day's numbers
  // self-correct if a refund lands on it after the fact — see dailyRefunds above.
  const dailyTrend = Object.keys({ ...dailySubtotal, ...dailyRefunds })
    .sort()
    .map((d) => ({
      date: d,
      todaySales: money((dailySubtotal[d] || 0) - (dailyRefunds[d] || 0)),
      orders: dailyOrders[d] || 0,
    }));

  const grossProfit = mtdSales - mtdCost;
  const margin = mtdSales ? (grossProfit / mtdSales) * 100 : 0;
  const returnsRate = grossTotal ? (refundTotal / grossTotal) * 100 : 0;

  const topProducts = Object.values(profitByProduct)
    .sort((a, b) => b.profit - a.profit).slice(0, 20)
    .map((p) => ({
      title: p.title, profit: money(p.profit), revenue: money(p.revenue), units: p.units,
      margin: p.revenue ? money((p.profit / p.revenue) * 100) : 0,
    }));

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
    topProducts, deadStock: deadStock.slice(0, 20), stockAlerts: stockAlerts.slice(0, 20),
    byRegion, byChannel, // both scoped to this month (MTD) — same window as mtd.sales
    dailyTrend,
    insights: buildInsights({ mtdSales, margin, deadStock, stockAlerts, target: TARGET }),
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
async function sendEmail(m) {
  const { EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY, REPORT_TO } = process.env;
  if (!EMAILJS_SERVICE_ID || !REPORT_TO) { console.log("Email skipped (not configured)."); return; }

  const body = [
    `Good morning Boss.`, ``,
    `Jualan hari ini: RM${m.today.sales} (${m.today.orders} order)`,
    `Bulan ini: RM${m.mtd.sales} / RM${m.mtd.target} (${m.mtd.targetPct}%)`,
    `Margin: ${m.mtd.margin}%   Untung kasar: RM${m.mtd.grossProfit}`,
    `AOV: RM${m.mtd.aov}   Pulangan: ${m.returnsRate}%`, ``,
    `Top produk untung: ${m.topProducts[0]?.title || "-"} (RM${m.topProducts[0]?.profit || 0})`,
    m.stockAlerts.length ? `⚠️ Stock warning: ${m.stockAlerts.length} SKU bawah paras` : ``, ``,
    `Cadangan:`, ...m.insights.map((i) => `• ${i}`),
  ].filter(Boolean).join("\n");

  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY,
      template_params: { to_email: REPORT_TO, subject: `Gearevo Report ${m.date}`, message: body },
    }),
  });
  console.log(res.ok ? "Email sent." : `Email failed: ${res.status} ${await res.text()}`);
}

// ---------- main ----------
(async () => {
  const raw = await pull();
  const metrics = compute(raw);
  const { dailyTrend, ...latest } = metrics;

  // Re-write every day in the fetched window (not just today), so a day's doc
  // self-corrects on later runs (e.g. a refund processed a day or two after the
  // order) instead of staying frozen at whatever it looked like when it was "today".
  const batch = db.batch();
  batch.set(db.doc("dashboard/latest"), latest);
  for (const day of dailyTrend) {
    batch.set(db.doc(`daily/${day.date}`), day);
  }
  await batch.commit();
  console.log(`Firestore updated (dashboard/latest + ${dailyTrend.length} daily docs).`);
  await sendEmail(metrics);
  console.log("Done ✅");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
