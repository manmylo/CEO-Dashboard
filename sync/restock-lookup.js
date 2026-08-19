/**
 * Shopify GraphQL + restock-date lookup — shared by sync.js (full BI sync)
 * and check-restock.js (standalone, Firestore-free diagnostic). Kept in one
 * file so the two can never drift out of sync with each other: whatever is
 * verified correct via check-restock.js IS what sync.js runs, not a copy of it.
 *
 * Env: SHOP_DOMAIN, SHOP_TOKEN, SHOP_API_VERSION (e.g. 2026-01)
 */

const SHOP = process.env.SHOP_DOMAIN;
const TOKEN = process.env.SHOP_TOKEN;
const VER = process.env.SHOP_API_VERSION || "2026-01";
const ENDPOINT = `https://${SHOP}/admin/api/${VER}/graphql.json`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function graphql(query, variables = {}, attempt = 0) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) { await sleep(2000); return graphql(query, variables, attempt); }
  const body = await res.json();
  if (body.errors) {
    // Shopify can throttle at the GraphQL layer (HTTP 200, but a THROTTLED
    // error in the body) as well as at the HTTP layer (429, handled above).
    // Without this retry, a throttled call was thrown away entirely by
    // callers like getRestockDates(), silently marking every SKU in that
    // chunk as "no restock data found" -- looking identical to a real
    // no-data SKU even though Shopify never actually answered the query.
    const throttled = body.errors.find((e) => e.extensions?.code === "THROTTLED");
    if (throttled && attempt < 5) {
      const resetAt = throttled.extensions?.cost?.windowResetAt;
      const waitMs = resetAt
        ? Math.min(Math.max(new Date(resetAt).getTime() - Date.now(), 500), 20000)
        : 2000 * (attempt + 1);
      console.log(`   [INFO] GraphQL THROTTLED, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/5)…`);
      await sleep(waitMs);
      return graphql(query, variables, attempt + 1);
    }
    throw new Error("GraphQL errors: " + JSON.stringify(body.errors));
  }

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
export async function paginate(query, pick, variables = {}) {
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

// Dead stock ("modal tidur") is anchored to each SKU's own restock date.
// RESTOCK_LOOKBACK_DAYS = Shopify's own hard cap on how far back
// inventory_adjustment_history is queryable — can't see further than this,
// so a SKU with no visible restock event beyond this window just falls back
// to "0 sold in DEADSTOCK_WINDOW_DAYS from today," same as before.
export const RESTOCK_LOOKBACK_DAYS = 180;

// Restock-date detection, three tiers, in priority order -- NOT just
// whichever documented event happens to be most recent. Confirmed against
// real store data (see check-restock.js output) that inventory_change_reason
// actually distinguishes "shipment_received" (a Transfer landing) from
// "purchase_order_received" (a PO landing) from a bare "received" (some
// other tracked receiving flow) as genuinely different reason strings, not
// variants of the same one -- so they're no longer treated as
// interchangeable "any received-ish event, most recent wins."
//   Tier 1 — inventory_change_reason === "shipment_received" specifically.
//     The store's current/primary restock workflow (per real usage) --
//     always wins over the other two tiers if present at all, regardless of
//     whether an older Tier 2/3 event is chronologically closer to today.
//   Tier 2 — any OTHER documented/tracked receiving signal: reason ===
//     "purchase_order_received", reason === "received", or
//     reference_document_type is non-null with a positive change (the
//     store's older PO-only workflow, or any other tracked type Shopify's
//     docs mention, e.g. "Inventory::Transfer" with a genuinely positive
//     delta). Only consulted when Tier 1 has no match at all.
//   Tier 3 — reference_document_type is null (a fully untracked manual
//     quantity edit in the Admin), used only as a last-resort fallback for
//     pre-PO-workflow stock (this store started using Purchase Orders in
//     April 2026): specifically a manual adjustment that takes the running
//     on-hand balance from <=0 up to positive (a genuine "back in stock"
//     event), not just any manual tweak/correction. Only consulted when
//     NEITHER Tier 1 nor Tier 2 has any match.
// Only queried for dead-stock CANDIDATES (already known to have 0 sales in
// DEADSTOCK_WINDOW_DAYS from today), not the whole catalog — shopifyqlQuery
// has no pagination, so an unscoped store-wide query risks silent
// truncation; scoping to a WHERE...IN list of specific SKUs keeps each
// query small and complete. Shopify's own hard cap on how far back this
// data exists is RESTOCK_LOOKBACK_DAYS (180) — a SKU with no visible
// restock event at all in that window returns { date: null }, meaning
// "unknown, or genuinely more than 180 days ago" (displayed as ">180d").
const RESTOCK_QUERY_CHUNK = 50; // SKUs per ShopifyQL call
export async function getRestockDates(candidates) {
  const results = new Map(); // sku -> { date: "YYYY-MM-DD" | null }
  const onHandBySku = new Map(candidates.map((c) => [c.sku, c.onHand]));
  const skus = candidates.map((c) => c.sku).filter(Boolean);

  for (let i = 0; i < skus.length; i += RESTOCK_QUERY_CHUNK) {
    const chunk = skus.slice(i, i + RESTOCK_QUERY_CHUNK);
    const skuList = chunk.map((s) => `'${s.replace(/'/g, "\\'")}'`).join(", ");
    const ql = `FROM inventory_adjustment_history SHOW inventory_adjustment_change `
      + `GROUP BY day, product_variant_sku, reference_document_type, inventory_change_reason `
      + `WHERE product_variant_sku IN (${skuList}) `
      + `SINCE -${RESTOCK_LOOKBACK_DAYS}d UNTIL today ORDER BY day ASC`;

    let data;
    try {
      data = await graphql(
        `query($q: String!) { shopifyqlQuery(query: $q) { tableData { rows } parseErrors } }`,
        { q: ql }
      );
    } catch (e) {
      console.log(`Restock-date lookup failed for a chunk of ${chunk.length} SKU(s), treating as unknown: ${e.message}`);
      console.log(`   [INFO] Restock lookup — affected SKUs: ${chunk.join(", ")}`);
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
    // days that had a documented (tracked) or manual positive delta, or a
    // "received" event by inventory_change_reason.
    //
    // Confirmed via check-restock.js's raw diagnostic against real data: for
    // a Transfer receipt, Shopify's inventory_adjustment_history reports
    // inventory_change_reason "shipment_received" with a NEGATIVE
    // inventory_adjustment_change (the pipeline draining as stock lands),
    // not the positive on-hand gain the Admin UI displays -- so the
    // change > 0 check above can never catch a transfer-based restock, no
    // matter how reference_document_type is matched. inventory_change_reason
    // is checked for "received" (not an exact match) on the same principle
    // as the reference_document_type fix: match the concept ("stock was
    // received"), not one specific string -- a PO's own received-reason
    // string hasn't been confirmed and may differ (e.g. "purchase_order_
    // received"), but should also contain "received".
    const seenTypes = new Set();
    const seenReasons = new Set();
    const bySku = new Map();
    for (const r of result?.tableData?.rows || []) {
      const sku = r.product_variant_sku;
      if (!sku) continue;
      if (r.reference_document_type) seenTypes.add(r.reference_document_type);
      if (r.inventory_change_reason) seenReasons.add(r.inventory_change_reason);
      const perDay = bySku.get(sku) || bySku.set(sku, new Map()).get(sku);
      const day = perDay.get(r.day) || perDay.set(r.day, {
        total: 0, shipmentReceived: false, otherDocumented: false, manualPositive: false,
      }).get(r.day);
      const change = Number(r.inventory_adjustment_change || 0);
      day.total += change;
      const reason = r.inventory_change_reason || "";
      if (reason === "shipment_received") day.shipmentReceived = true;
      // Tier 2's catch-all -- a named receiving reason OTHER than
      // shipment_received, or any documented type with a genuinely positive
      // delta (covers doc types with no specific reason match, e.g. a
      // straightforward Transfer/PO receipt that isn't the pipeline-drain
      // quirk shipment_received's own negative-change case is).
      else if (reason === "purchase_order_received" || reason === "received") day.otherDocumented = true;
      else if (r.reference_document_type != null && change > 0) day.otherDocumented = true;
      if (r.reference_document_type == null && change > 0) day.manualPositive = true;
    }
    if (seenTypes.size) console.log(`   [INFO] Restock lookup — reference_document_type values seen: ${[...seenTypes].join(", ")}`);
    if (seenReasons.size) console.log(`   [INFO] Restock lookup — inventory_change_reason values seen: ${[...seenReasons].join(", ")}`);

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

    // SKUs that HAD rows (unlike noRowsAtAll above) but still resolved to no
    // date at all -- a genuinely different, previously-invisible failure
    // mode from either "no rows" or "found a date." Distinguishing this
    // from a silent null is what actually tells you whether a SKU that
    // still shows up somewhere it shouldn't (e.g. still-restocked-but-
    // showing-in-Overstock) is a real "no receiving event in this window"
    // case or a data/matching gap worth chasing further.
    const rowsButNoDate = [];
    for (const sku of chunk) {
      const perDay = bySku.get(sku);
      if (!perDay || !perDay.size) { results.set(sku, { date: null }); continue; }
      const days = [...perDay.keys()].sort(); // "YYYY-MM-DD" strings sort chronologically

      // Tier 1: most recent shipment_received day -- wins outright if
      // present, never overridden by an older Tier 1 day existing alongside
      // a more-recent-looking Tier 2/3 signal (there isn't one to compare
      // against here; this tier is checked to exhaustion FIRST, in full
      // isolation from the other two).
      let tier1Date = null;
      for (const d of days) if (perDay.get(d).shipmentReceived) tier1Date = d; // ascending order, last match wins
      if (tier1Date) { results.set(sku, { date: tier1Date }); continue; }

      // Tier 2: most recent OTHER documented/tracked receiving day (PO
      // received, bare "received", or any other tracked type with a real
      // positive delta) -- only reached when Tier 1 found nothing at all.
      let tier2Date = null;
      for (const d of days) if (perDay.get(d).otherDocumented) tier2Date = d;
      if (tier2Date) { results.set(sku, { date: tier2Date }); continue; }

      // Tier 3: most recent manual adjustment that crossed the running
      // balance from <=0 to >0 -- last resort, only reached when NEITHER
      // Tier 1 nor Tier 2 found anything. Reconstructed by walking forward
      // from a start-of-window balance derived from today's live on-hand
      // quantity minus the window's total net change (no absolute balance
      // is directly queryable — only daily deltas — so this is the only way
      // to know what the balance was on any given day in the window).
      const onHand = onHandBySku.get(sku);
      let tier3Date = null;
      if (onHand != null) {
        const totalWindowDelta = days.reduce((s, d) => s + perDay.get(d).total, 0);
        let balance = onHand - totalWindowDelta;
        for (const d of days) {
          const before = balance;
          balance += perDay.get(d).total;
          if (perDay.get(d).manualPositive && before <= 0 && balance > 0) tier3Date = d;
        }
      }
      results.set(sku, { date: tier3Date });
      if (!tier3Date) rowsButNoDate.push(sku);
    }
    if (rowsButNoDate.length) console.log(`   [INFO] Restock lookup — ${rowsButNoDate.length} SKU(s) had history rows but NO receiving event matched any tier (resolved to null): ${rowsButNoDate.join(", ")}`);
  }
  return results;
}
