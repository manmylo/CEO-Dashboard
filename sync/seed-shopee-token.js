/**
 * One-time bootstrap (also useful for recovery if the refresh_token ever
 * dies from the pipeline not running for 30+ days straight): seeds
 * config/shopeeAuth with a refresh_token, so sync.js's getShopeeAccessToken()
 * can take over rotation from here. expiresAt is deliberately 0 (already
 * "expired") so the very next runFull() immediately does its own
 * refresh+persist cycle, rather than trusting a token issued outside the
 * pipeline.
 *
 * Get a refresh_token by running the Shopee Open Platform authorization flow
 * (shop_auth_partner -> redirect -> exchange code for token) -- see the repo
 * notes/chat history for the one-off scripts used to do that.
 *
 * Usage (from the sync/ directory, with FIREBASE_SA already installed via
 * `npm install`):
 *   $env:FIREBASE_SA = Get-Content "path\to\firebase-service-account.json" -Raw
 *   $env:SHOPEE_REFRESH_TOKEN = "your_refresh_token"
 *   node seed-shopee-token.js
 */
import admin from "firebase-admin";

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore();

await db.doc("config/shopeeAuth").set({
  refreshToken: process.env.SHOPEE_REFRESH_TOKEN,
  accessToken: null,
  expiresAt: 0,
}, { merge: true });

console.log("Seeded config/shopeeAuth. sync.js will refresh it into a real access_token on its next full sync.");
process.exit(0);
