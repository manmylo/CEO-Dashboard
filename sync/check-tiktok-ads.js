/**
 * Standalone TikTok Ads reporting diagnostic -- confirms which metric field
 * names the account's report/integrated/get endpoint actually accepts
 * before any of this gets wired into sync.js. "spend" is safe/documented;
 * ROAS/gross-revenue field names for Shop Ads are NOT confirmed from docs
 * alone (TikTok's own help articles describe "ROAS (Shop)" and "Gross
 * revenue" as UI labels, not API field names), so this tests a list of
 * candidates one at a time -- an invalid metric name fails the WHOLE
 * request, so bundling untested names together would hide which one broke
 * it.
 *
 * Env: TIKTOK_ADVERTISER_ID, FIREBASE_SA (to read the seeded access_token
 * from config/tiktokAuth)
 * Optional: METRICS="spend,gross_revenue,..." to override the candidate list
 *
 * Usage: node check-tiktok-ads.js
 */
import admin from "firebase-admin";

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore();

const ADVERTISER_ID = process.env.TIKTOK_ADVERTISER_ID;
if (!ADVERTISER_ID) { console.error("Missing TIKTOK_ADVERTISER_ID."); process.exit(1); }

const CANDIDATE_METRICS = (process.env.METRICS || [
  "spend", "impressions", "clicks",
  "gross_revenue", "total_onsite_shopping_value", "onsite_shopping_roas",
  "roas", "shopping_roas", "cost_per_conversion", "conversion",
  "total_complete_payment_rate", "complete_payment",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);

// Last 14 days, YYYY-MM-DD
const end = new Date();
const start = new Date(Date.now() - 13 * 86400000);
const iso = (d) => d.toISOString().slice(0, 10);

async function report(metrics) {
  const auth = (await db.doc("config/tiktokAuth").get()).data();
  if (!auth?.accessToken) throw new Error("config/tiktokAuth has no accessToken -- run the seed workflow first.");

  const url = new URL("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/");
  url.searchParams.set("advertiser_id", ADVERTISER_ID);
  url.searchParams.set("report_type", "BASIC");
  url.searchParams.set("data_level", "AUCTION_ADVERTISER");
  url.searchParams.set("dimensions", JSON.stringify(["advertiser_id", "stat_time_day"]));
  url.searchParams.set("metrics", JSON.stringify(metrics));
  url.searchParams.set("start_date", iso(start));
  url.searchParams.set("end_date", iso(end));
  url.searchParams.set("page_size", "50");

  const res = await fetch(url, { headers: { "Access-Token": auth.accessToken } });
  return res.json();
}

(async () => {
  console.log(`Advertiser: ${ADVERTISER_ID} | window: ${iso(start)} -> ${iso(end)}\n`);

  console.log("--- Baseline (spend/impressions/clicks) ---");
  const baseline = await report(["spend", "impressions", "clicks"]);
  console.log(JSON.stringify(baseline, null, 2));

  console.log("\n--- Testing candidate metrics one at a time ---");
  for (const m of CANDIDATE_METRICS) {
    if (["spend", "impressions", "clicks"].includes(m)) continue; // already confirmed via baseline
    try {
      const data = await report(["spend", m]);
      if (data.code !== 0) {
        console.log(`"${m}": REJECTED — ${data.message || JSON.stringify(data)}`);
      } else {
        const rows = data.data?.list || [];
        console.log(`"${m}": OK — ${rows.length} row(s). Sample: ${JSON.stringify(rows[0]?.metrics || rows[0] || {})}`);
      }
    } catch (e) {
      console.log(`"${m}": ERROR — ${e.message}`);
    }
  }
})().catch((e) => {
  console.error("check-tiktok-ads failed:", e);
  process.exit(1);
});
