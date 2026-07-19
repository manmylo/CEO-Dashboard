/**
 * SKUs to EXCLUDE from product analytics (top products, profit, dead stock,
 * stock alerts, velocity). These are services / add-ons, not stock items.
 *
 * NOTE: excluded SKUs are dropped from PRODUCT-level metrics only. Order-level
 * totals (jualan hari ini / bulan ini, order count, region, channel) still
 * include them, because that money is real revenue. Their own revenue is
 * tracked separately, grouped by the category below — see the "Services"
 * card in sync.js's compute().
 *
 * Category is the label shown on the Services card (Sharpening, Engraving,
 * Kydex, and their "Add-on" variants). To add more later: add the SKU with
 * its category to SERVICE_SKU_CATEGORY below.
 * The GE-OID-1 .. GE-OID-100 range is handled by pattern (no need to list
 * 100) -- these have no category, just excluded like the rest.
 */

export const SERVICE_SKU_CATEGORY = new Map([
  ["GE-AA.TP", "Sharpening Add-on"],
  ["GE-AON:EXPRESS", "Sharpening Add-on"],
  ["GE-PS.6-9", "Sharpening"],
  ["GE-PS.10-14", "Sharpening"],
  ["GE-PS.0-6", "Sharpening"],
  ["GE-AA.0-6", "Sharpening"],
  ["GE-AA.6-9", "Sharpening"],
  ["GE-AA.10-14", "Sharpening"],
  ["GE-LENG", "Engraving"],
  ["GE-LENG1", "Engraving"],
  ["GE-LEADROW", "Engraving Add-on"],
  ["GE-LEARAB", "Engraving"],
  ["GE-LEARAB-4TO50", "Engraving"],
  ["GE-LELOGO", "Engraving"],
  ["GE-LELOGO-4TO50", "Engraving"],
  ["GE-KYIGRN.8-9", "Kydex"],
  ["GE-KYIGRN.5-7", "Kydex"],
  ["GE-KYIGRN.10-14", "Kydex"],
  ["GE-KYHO.8-9", "Kydex"],
  ["GE-KYHO.5-7", "Kydex"],
  ["GE-KYHO.10-14", "Kydex"],
  ["GE-KYOD.8-9", "Kydex"],
  ["GE-KYOD.5-7", "Kydex"],
  ["GE-KYOD.10-14", "Kydex"],
  ["GE-KYRBWN.8-9", "Kydex"],
  ["GE-KYRBWN.5-7", "Kydex"],
  ["GE-KYRBWN.10-14", "Kydex"],
  ["GE-KYCB.8-9", "Kydex"],
  ["GE-KYCB.5-7", "Kydex"],
  ["GE-KYCB.10-14", "Kydex"],
  ["GE-KYCHOB.8-9", "Kydex"],
  ["GE-KYCHOB.5-7", "Kydex"],
  ["GE-KYCHOB.10-14", "Kydex"],
  ["GE-KYSC.8-9", "Kydex"],
  ["GE-KYSC.5-7", "Kydex"],
  ["GE-KYSC.10-14", "Kydex"],
  ["GE-KYRBLK.10-14", "Kydex"],
  ["GE-KYRBLK.5-7", "Kydex"],
  ["GE-KYRBLK.8-9", "Kydex"],
  ["GE-KYCF.8-9", "Kydex"],
  ["GE-KYCF.5-7", "Kydex"],
  ["GE-KYCF.10-14", "Kydex"],
  ["GE-KYBLK.8-9", "Kydex"],
  ["GE-KYBLK.10-14", "Kydex"],
  ["GE-KYBLK.5-7", "Kydex"],
  ["GE-KYBLT.A", "Kydex Add-on"],
  ["GE-KYBLT.B", "Kydex Add-on"],
  ["GE-KYBLT.C", "Kydex Add-on"],
  ["GE-SAND.8-9", "Kydex Add-on"],
  ["GE-SAND.5-7", "Kydex Add-on"],
  ["GE-SAND.10-14", "Kydex Add-on"],
  ["GE-KYKWIN", "Kydex Add-on"],
  ["GE-KYBLTCLP", "Kydex Add-on"],
]);

export function isExcluded(sku) {
  if (!sku) return false;
  if (SERVICE_SKU_CATEGORY.has(sku)) return true;
  // GE-OID-1 through GE-OID-100
  const m = /^GE-OID-(\d+)$/.exec(sku);
  if (m) { const n = Number(m[1]); return n >= 1 && n <= 100; }
  return false;
}

export function getServiceCategory(sku) {
  return SERVICE_SKU_CATEGORY.get(sku) || null;
}

// Some services are sold under many size/finish/tier variants that don't
// share individual SKU codes worth listing one by one (e.g. "Servis Asah
// Pisau (Mirror Finish - Bilah 10-14 Inci)" vs "... (Re-Profile - Bilah
// 10-14 Inci)", or "LASER ENGRAVING - 1ST TO 3RD KNIFE" vs "LASER ENGRAVING
// SERVICE - 4TH TO 50TH KNIFE SAME NAME") -- excluded by TITLE PREFIX
// instead, case-insensitive, as a fallback safety net for any future variant
// not yet added to SERVICE_SKU_CATEGORY above. Same treatment as excluded
// SKUs: these are services, always "available" regardless of any on-hand
// count, so they shouldn't show up as dead/slow-moving/low/out-of-stock, or
// skew inventory value or profit rankings.
export const SERVICE_TITLE_PREFIXES = [
  "Servis Asah Pisau",
  "LASER ENGRAVING",
];

export function isExcludedTitle(title) {
  if (!title) return false;
  const t = title.toUpperCase();
  return SERVICE_TITLE_PREFIXES.some((p) => t.startsWith(p.toUpperCase()));
}
