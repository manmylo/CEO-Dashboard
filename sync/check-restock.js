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
})().catch((e) => {
  console.error("check-restock failed:", e);
  process.exit(1);
});
