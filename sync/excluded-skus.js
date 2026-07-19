/**
 * SKUs to EXCLUDE from product analytics (top products, profit, dead stock,
 * stock alerts, velocity). These are services / add-ons, not stock items.
 *
 * NOTE: excluded SKUs are dropped from PRODUCT-level metrics only. Order-level
 * totals (jualan hari ini / bulan ini, order count, region, channel) still
 * include them, because that money is real revenue.
 *
 * To add more later: just add the SKU string to SERVICE_SKUS below.
 * The GE-OID-1 .. GE-OID-100 range is handled by pattern (no need to list 100).
 */

export const SERVICE_SKUS = new Set([
  "GE-AA.TP",
  "GE-AON:EXPRESS",
  "GE-PS.6-9",
  "GE-PS.10-14",
  "GE-PS.0-6",
  "GE-AA.0-6",
  "GE-AA.6-9",
  "GE-AA.10-14",
  "GE-LENG",
  "GE-LENG1",
  "GE-LEADROW",
  "GE-LEARAB",
  "GE-LEARAB-4TO50",
  "GE-LELOGO",
  "GE-LELOGO-4TO50",
  "GE-KYIGRN.8-9",
  "GE-KYIGRN.5-7",
  "GE-KYIGRN.10-14",
  "GE-KYHO.8-9",
  "GE-KYHO.5-7",
  "GE-KYHO.10-14",
  "GE-KYOD.8-9",
  "GE-KYOD.5-7",
  "GE-KYOD.10-14",
  "GE-KYRBWN.8-9",
  "GE-KYRBWN.5-7",
  "GE-KYRBWN.10-14",
  "GE-KYCB.8-9",
  "GE-KYCB.5-7",
  "GE-KYCB.10-14",
  "GE-KYCHOB.8-9",
  "GE-KYCHOB.5-7",
  "GE-KYCHOB.10-14",
  "GE-KYSC.8-9",
  "GE-KYSC.5-7",
  "GE-KYSC.10-14",
  "GE-KYRBLK.10-14",
  "GE-KYRBLK.5-7",
  "GE-KYRBLK.8-9",
  "GE-KYCF.8-9",
  "GE-KYCF.5-7",
  "GE-KYCF.10-14",
  "GE-KYBLK.8-9",
  "GE-KYBLK.10-14",
  "GE-KYBLK.5-7",
  "GE-KYBLT.A",
  "GE-KYBLT.B",
  "GE-KYBLT.C",
  "GE-SAND.8-9",
  "GE-SAND.5-7",
  "GE-SAND.10-14",
  "GE-KYKWIN",
  "GE-KYBLTCLP"
]);

export function isExcluded(sku) {
  if (!sku) return false;
  if (SERVICE_SKUS.has(sku)) return true;
  // GE-OID-1 through GE-OID-100
  const m = /^GE-OID-(\d+)$/.exec(sku);
  if (m) { const n = Number(m[1]); return n >= 1 && n <= 100; }
  return false;
}

// Some services are sold under many size/finish/tier variants that don't
// share individual SKU codes worth listing one by one (e.g. "Servis Asah
// Pisau (Mirror Finish - Bilah 10-14 Inci)" vs "... (Re-Profile - Bilah
// 10-14 Inci)", or "LASER ENGRAVING - 1ST TO 3RD KNIFE" vs "LASER ENGRAVING
// SERVICE - 4TH TO 50TH KNIFE SAME NAME") -- excluded by TITLE PREFIX
// instead, case-insensitive. Same treatment as excluded SKUs above: these
// are services, always "available" regardless of any on-hand count, so they
// shouldn't show up as dead/slow-moving/low/out-of-stock, or skew inventory
// value or profit rankings.
export const SERVICE_TITLE_PREFIXES = [
  "Servis Asah Pisau",
  "LASER ENGRAVING",
];

export function isExcludedTitle(title) {
  if (!title) return false;
  const t = title.toUpperCase();
  return SERVICE_TITLE_PREFIXES.some((p) => t.startsWith(p.toUpperCase()));
}
