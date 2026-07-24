/**
 * Standalone diagnostic -- dumps config/access.allowedEmails with each
 * entry's exact JSON representation and character length, so an invisible
 * problem (trailing space, wrong case, a stray character, an accidental
 * duplicate) is actually visible instead of guessed at. Triggered by a
 * CORS failure on the announcement email that only reproduces for one
 * specific team member's account -- same origin, same code, same EmailJS
 * template as the working case, so the most likely remaining variable is
 * the stored email value itself.
 *
 * Env: FIREBASE_SA
 * Usage: node check-allowlist.js
 */
import admin from "firebase-admin";

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore();

(async () => {
  const snap = await db.doc("config/access").get();
  if (!snap.exists) { console.log("config/access does not exist."); return; }
  const data = snap.data();
  const emails = data.allowedEmails || [];
  console.log(`config/access.allowedEmails -- ${emails.length} entries:\n`);
  emails.forEach((e, i) => {
    const trimmed = e.trim();
    const flag = trimmed !== e ? "  <-- HAS LEADING/TRAILING WHITESPACE" : (/[A-Z]/.test(e) ? "  <-- HAS UPPERCASE" : "");
    console.log(`${String(i + 1).padStart(2)}. ${JSON.stringify(e)} (length ${e.length})${flag}`);
  });
  console.log(`\nadmins: ${JSON.stringify(data.admins || [])}`);
})().catch((e) => {
  console.error("check-allowlist failed:", e);
  process.exit(1);
});
