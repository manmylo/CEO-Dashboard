/**
 * Standalone restock-date diagnostic — fetches ONLY the current on-hand
 * quantity + inventory_adjustment_history restock date for a small list of
 * SKUs, via the exact same graphql()/getRestockDates() code sync.js uses
 * (shared from restock-lookup.js, not a copy). No Firestore, no products/
 * orders pull, no email — a full sync takes minutes; this takes seconds,
 * so the restock-date logic can be checked directly against real Shopify
 * data without waiting on (or spending API quota on) a full sync run.
 *
 * Env: SHOP_DOMAIN, SHOP_TOKEN, SHOP_API_VERSION
 * Optional: SKUS="SKU1,SKU2,..." (comma-separated). Defaults to a short
 * list of SKUs known to have been reported as still wrong.
 *
 * Usage: node check-restock.js
 */

import { graphql, getRestockDates } from "./restock-lookup.js";

const DEFAULT_SKUS = ["ESDARIEN"];
const skus = (process.env.SKUS || DEFAULT_SKUS.join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);

async function fetchOnHand(sku) {
  const q = `sku:'${sku.replace(/'/g, "\\'")}'`;
  const data = await graphql(
    `query($q: String!) { productVariants(first: 5, query: $q) {
      nodes { sku inventoryQuantity product { title } } } }`,
    { q }
  );
  const nodes = data.productVariants?.nodes || [];
  // productVariants' `sku:` search can return near-matches, not just exact
  // hits -- filter down to the exact SKU string so this matches what
  // getRestockDates()'s own product_variant_sku WHERE...IN clause expects.
  const exact = nodes.find((n) => n.sku === sku);
  if (!exact) {
    console.log(`   [WARN] "${sku}" — no exact-match variant found via productVariants(sku:'${sku}'). `
      + `${nodes.length} near-match(es) returned: ${nodes.map((n) => `"${n.sku}"`).join(", ") || "none"}`);
    return null;
  }
  return { title: exact.product?.title, onHand: exact.inventoryQuantity };
}

(async () => {
  console.log(`Checking restock data for ${skus.length} SKU(s): ${skus.join(", ")}\n`);

  const candidates = [];
  for (const sku of skus) {
    const info = await fetchOnHand(sku);
    if (!info) { candidates.push({ sku, onHand: null, title: null }); continue; }
    candidates.push({ sku, onHand: info.onHand, title: info.title });
    console.log(`${sku} — "${info.title}" — on hand: ${info.onHand}`);
  }

  console.log("\nRunning getRestockDates()…\n");
  const results = await getRestockDates(candidates.map((c) => ({ sku: c.sku, onHand: c.onHand })));

  console.log("\n--- Results ---");
  for (const c of candidates) {
    const r = results.get(c.sku);
    console.log(`${c.sku.padEnd(20)} onHand=${String(c.onHand).padEnd(6)} restockDate=${r?.date || "null (>180d / unknown)"}`);
  }

  // Raw diagnostic: getRestockDates()'s query GROUPs BY day/sku/type only,
  // which SUMS inventory_adjustment_change across every inventory state
  // (on_hand, incoming, available, committed...) in that bucket. A transfer
  // "received" event moves stock from incoming -> on_hand at the same
  // moment, under the same reference_document_type -- if that shows up as
  // two rows (on_hand +N, incoming -N) collapsed into one GROUP BY bucket,
  // they could cancel out and the real on_hand increase goes invisible.
  // User wants the fix to key specifically off "Shipment received" (not
  // "marked as in transit" or other transfer sub-events), so this dumps the
  // raw rows grouped by two candidate dimension names -- "inventory_state"
  // and "inventory_change_reason" (both mentioned in Shopify's own docs for
  // this dataset) -- to find which one actually distinguishes "received"
  // from "in transit" against real data, instead of guessing the field name.
  console.log("\n--- Raw rows by inventory_state (last 30d, diagnostic only) ---");
  for (const sku of skus) {
    const ql = `FROM inventory_adjustment_history SHOW inventory_adjustment_change `
      + `GROUP BY day, product_variant_sku, reference_document_type, inventory_state `
      + `WHERE product_variant_sku = '${sku.replace(/'/g, "\\'")}' `
      + `SINCE -30d UNTIL today ORDER BY day ASC`;
    try {
      const data = await graphql(
        `query($q: String!) { shopifyqlQuery(query: $q) { tableData { rows } parseErrors } }`,
        { q: ql }
      );
      const result = data.shopifyqlQuery;
      if (result?.parseErrors?.length) {
        console.log(`${sku}: parseErrors (likely wrong dimension name) — ${JSON.stringify(result.parseErrors)}`);
      } else {
        console.log(`${sku}: ${JSON.stringify(result?.tableData?.rows || [], null, 2)}`);
      }
    } catch (e) {
      console.log(`${sku}: raw query failed — ${e.message}`);
    }
  }

  console.log("\n--- Raw rows by inventory_change_reason (last 30d, diagnostic only) ---");
  for (const sku of skus) {
    const ql = `FROM inventory_adjustment_history SHOW inventory_adjustment_change `
      + `GROUP BY day, product_variant_sku, reference_document_type, inventory_change_reason `
      + `WHERE product_variant_sku = '${sku.replace(/'/g, "\\'")}' `
      + `SINCE -30d UNTIL today ORDER BY day ASC`;
    try {
      const data = await graphql(
        `query($q: String!) { shopifyqlQuery(query: $q) { tableData { rows } parseErrors } }`,
        { q: ql }
      );
      const result = data.shopifyqlQuery;
      if (result?.parseErrors?.length) {
        console.log(`${sku}: parseErrors (likely wrong dimension name) — ${JSON.stringify(result.parseErrors)}`);
      } else {
        console.log(`${sku}: ${JSON.stringify(result?.tableData?.rows || [], null, 2)}`);
      }
    } catch (e) {
      console.log(`${sku}: raw query failed — ${e.message}`);
    }
  }
})().catch((e) => {
  console.error("check-restock failed:", e);
  process.exit(1);
});
