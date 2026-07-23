/**
 * One-time bootstrap: exchanges a TikTok OAuth auth_code (obtained by
 * visiting the advertiser authorization URL and approving access -- see
 * public/tiktok-callback.html, which displays the auth_code after redirect)
 * for an access_token, and seeds config/tiktokAuth so a future
 * syncTikTokAds() in sync.js can read it directly.
 *
 * Unlike Shopee (seed-shopee-token.js), TikTok's Marketing API access_token
 * from this endpoint is long-lived -- it does not expire on a daily/hourly
 * cycle and needs no refresh_token rotation (confirmed against TikTok's own
 * docs; only their separate, unrelated Login Kit/Creator API has short-lived
 * tokens). Re-authorization is only needed if the advertiser revokes access.
 * So this script is the whole bootstrap -- there's no equivalent of
 * getShopeeAccessToken()'s rotation needed on the sync.js side.
 *
 * Usage: run via the "Seed TikTok token" GitHub Action (workflow_dispatch),
 * passing the auth_code copied from tiktok-callback.html as input.
 */
import admin from "firebase-admin";

const APP_ID = process.env.TIKTOK_APP_ID;
const APP_SECRET = process.env.TIKTOK_APP_SECRET;
const AUTH_CODE = process.env.AUTH_CODE;
const EXPECTED_ADVERTISER_ID = process.env.TIKTOK_ADVERTISER_ID;

if (!APP_ID || !APP_SECRET || !AUTH_CODE) {
  console.error("Missing TIKTOK_APP_ID, TIKTOK_APP_SECRET, or AUTH_CODE.");
  process.exit(1);
}

const res = await fetch("https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ app_id: APP_ID, secret: APP_SECRET, auth_code: AUTH_CODE }),
});
const body = await res.json();
if (body.code !== 0) {
  console.error("TikTok token exchange failed:", JSON.stringify(body));
  process.exit(1);
}

const { access_token, advertiser_ids, scope } = body.data;
console.log(`Got access_token, authorized for advertiser_ids: ${(advertiser_ids || []).join(", ")}`);

if (EXPECTED_ADVERTISER_ID) {
  if ((advertiser_ids || []).includes(EXPECTED_ADVERTISER_ID)) {
    console.log(`Confirmed: TIKTOK_ADVERTISER_ID (${EXPECTED_ADVERTISER_ID}) is in the authorized list.`);
  } else {
    console.warn(`[WARN] TIKTOK_ADVERTISER_ID (${EXPECTED_ADVERTISER_ID}) is NOT in the advertiser_ids TikTok returned `
      + `(${(advertiser_ids || []).join(", ") || "none"}) -- double check the secret's value.`);
  }
}

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore();
await db.doc("config/tiktokAuth").set({
  accessToken: access_token,
  advertiserIds: advertiser_ids || [],
  scope: scope || [],
  obtainedAt: new Date().toISOString(),
}, { merge: true });

console.log("Seeded config/tiktokAuth.");
process.exit(0);
