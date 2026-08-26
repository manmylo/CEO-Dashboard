// One-off backfill of per-day PRODUCT data for dates older than the sync's
// rolling 90-day window.
//
// Two different sources feed a daily/{date} doc:
//
//   todaySales, orders    relayed from the Gearevo dashboard -- ALL history
//   products, services    computed from Shopify line items -- last 90 days only
//
// So an older day has its headline figures but no breakdown, which is what
// the Day view shows as "Nothing sold on this date" beside a real sales
// number. This recovers the missing half for an explicit date range.
//
// Requires the Shopify app to hold read_all_orders -- without it the Orders
// API silently returns nothing beyond 60 days, and this would cheerfully
// write empty product lists over good data. Hence the guard in run().
//
// Run manually, never on the cron:
//   BACKFILL_PRODUCTS_FROM=2026-03-28 BACKFILL_PRODUCTS_TO=2026-05-31
//
// Writes with merge:true and only ever sets `products`/`services` -- the sales
// and order figures already on those docs are the ONLY record of them, and
// must not be touched.

// Orders are fetched a month at a time. Five months in one query is a lot of
// pagination to lose if it fails near the end, and Shopify's cursor pages are
// happier with bounded windows.
const CHUNK_DAYS = 31;

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function chunks(fromIso, toIso) {
  const out = [];
  let cursor = fromIso;
  while (cursor <= toIso) {
    const end = addDays(cursor, CHUNK_DAYS - 1);
    out.push({ from: cursor, to: end > toIso ? toIso : end });
    cursor = addDays(end, 1);
  }
  return out;
}

// The same per-day bucketing compute() does, lifted out so both agree on what
// a "product day" means. Deliberately NOT re-deriving sales or order counts --
// those come from the dashboard relay and are already correct.
function bucketOrders(orders, variantMap, deps) {
  const { myDateStr, num, money, isExcluded, getServiceCategory } = deps;
  const products = {};   // date -> pid -> { title, profit, revenue, units }
  const services = {};   // date -> category -> { units, revenue }

  for (const o of orders) {
    const created = new Date(o.createdAt);
    const dateStr = myDateStr(created);
    for (const li of o.lineItems?.nodes || []) {
      if (isExcluded(li.sku)) {
        const category = getServiceCategory(li.sku) || "Other Services";
        const bucket = services[dateStr] || (services[dateStr] = {});
        const s = bucket[category] || (bucket[category] = { units: 0, revenue: 0 });
        s.units += num(li.quantity);
        s.revenue += num(li.discountedTotalSet?.shopMoney?.amount);
        continue;
      }
      const vid = li.variant?.id;
      const v = vid ? variantMap.get(vid) : null;
      const qty = num(li.quantity);
      const lineRev = num(li.discountedTotalSet?.shopMoney?.amount);
      const lineCost = (v?.cost || 0) * qty;
      const pid = v?.productId || li.product?.id || li.product?.title || "unknown";
      const title = v?.productTitle || li.product?.title || "Unknown";
      const bucket = products[dateStr] || (products[dateStr] = {});
      const p = bucket[pid] || (bucket[pid] = { title, profit: 0, revenue: 0, units: 0 });
      p.profit += lineRev - lineCost;
      p.revenue += lineRev;
      p.units += qty;
    }
  }
  // money() rounds the same way the live path does, so a backfilled day and a
  // freshly-synced one are byte-identical in shape.
  const outProducts = {};
  for (const [date, byPid] of Object.entries(products)) {
    outProducts[date] = Object.entries(byPid).map(([pid, p]) => ({
      pid, title: p.title, profit: money(p.profit), revenue: money(p.revenue), units: p.units,
    }));
  }
  const outServices = {};
  for (const [date, byCat] of Object.entries(services)) {
    outServices[date] = Object.entries(byCat).map(([category, s]) => ({
      category, units: s.units, revenue: money(s.revenue),
    }));
  }
  return { products: outProducts, services: outServices };
}

async function run(deps) {
  const {
    db, paginate, Q_ORDERS, pullProducts,
    myDateStr, num, money, isExcluded, getServiceCategory,
  } = deps;
  const from = process.env.BACKFILL_PRODUCTS_FROM;
  const to = process.env.BACKFILL_PRODUCTS_TO || myDateStr(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "")) {
    throw new Error("BACKFILL_PRODUCTS_FROM must be set to a YYYY-MM-DD date.");
  }
  if (to < from) throw new Error(`BACKFILL_PRODUCTS_TO (${to}) is before FROM (${from}).`);

  console.log(`Product backfill — ${from} to ${to}`);
  console.log("Fetching product costs…");
  const variantMap = await pullProducts();

  let allProducts = {}, allServices = {}, totalOrders = 0;
  for (const c of chunks(from, to)) {
    // created_at is inclusive on both ends here; the <= end date needs the
    // next day's boundary because Shopify compares full timestamps.
    const q = `created_at:>=${c.from} created_at:<${addDays(c.to, 1)} status:any`;
    process.stdout.write(`  ${c.from} .. ${c.to} — `);
    const orders = await paginate(Q_ORDERS, (d) => d.orders, { q });
    totalOrders += orders.length;
    console.log(`${orders.length} order(s)`);
    const { products, services } = bucketOrders(orders, variantMap, { myDateStr, num, money, isExcluded, getServiceCategory });
    allProducts = { ...allProducts, ...products };
    allServices = { ...allServices, ...services };
  }

  // The guard this whole thing hangs on. Without read_all_orders Shopify
  // returns an empty list for anything past 60 days -- no error, just
  // nothing -- and writing that would replace real days with empty product
  // lists. Zero orders across a multi-month window is never legitimate.
  if (totalOrders === 0) {
    throw new Error(
      "Shopify returned 0 orders for the whole range. That usually means the app "
      + "lacks the read_all_orders scope, which caps the Orders API at 60 days. "
      + "Nothing was written.");
  }

  const dates = [...new Set([...Object.keys(allProducts), ...Object.keys(allServices)])]
    .filter((d) => d >= from && d <= to)     // orders near a boundary can land outside
    .sort();

  let batch = db.batch(), inBatch = 0, written = 0;
  for (const date of dates) {
    // merge:true, and ONLY these two fields. todaySales/orders on these docs
    // came from the dashboard relay and are the only record of them.
    batch.set(db.doc(`daily/${date}`), {
      products: allProducts[date] || [],
      services: allServices[date] || [],
      productsBackfilledAt: new Date().toISOString(),
    }, { merge: true });
    inBatch++; written++;
    if (inBatch >= 400) { await batch.commit(); batch = db.batch(); inBatch = 0; }
  }
  if (inBatch > 0) await batch.commit();

  console.log(`Product backfill — ${totalOrders} order(s) across ${written} day(s) written.`);
  return { totalOrders, days: written, from, to };
}

export { run, chunks, bucketOrders, addDays };
