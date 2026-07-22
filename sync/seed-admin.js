/**
 * One-time bootstrap: seeds config/access.admins -- the list of emails
 * allowed to manage per-user page access (Settings page). Kept out of
 * firestore.rules and every client file on purpose (that file is committed
 * to a public repo and never contains real email addresses -- same reason
 * allowedEmails lives in Firestore instead of being hardcoded there).
 * syncAllowlist() in sync.js writes this same document with merge:true, so
 * it won't wipe this field on later runs.
 *
 * Usage (from the sync/ directory, with dependencies already installed via
 * `npm install`):
 *   $env:FIREBASE_SA = Get-Content "path\to\firebase-service-account.json" -Raw
 *   $env:ADMIN_EMAILS = "someone@example.com,someoneelse@example.com"
 *   node seed-admin.js
 */
import admin from "firebase-admin";

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore();

const admins = (process.env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
if (!admins.length) {
  console.error("Set ADMIN_EMAILS to a comma-separated list first.");
  process.exit(1);
}

await db.doc("config/access").set({ admins }, { merge: true });
console.log(`Seeded config/access.admins: ${admins.join(", ")}`);
process.exit(0);
