/**
 * One-time migration: assignments.assignedTo was a single string; the new
 * multi-assignee feature makes it a list. Existing docs still have the old
 * string shape, and the new firestore.rules use `email in resource.data.
 * assignedTo` for read/update checks -- `in` on a string (not a list) fails
 * rule evaluation, which would silently lock every existing assignee out of
 * their own tickets the moment the new rules deploy. This wraps every
 * string-shaped assignedTo into a single-element array so nothing breaks.
 *
 * Safe to re-run -- docs already shaped as a list are skipped untouched.
 *
 * Env: FIREBASE_SA
 * Usage: node migrate-assignments.js
 */
import admin from "firebase-admin";

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA)) });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("assignments").get();
  console.log(`Scanning ${snap.size} assignment(s)…`);

  let batch = db.batch();
  let count = 0;
  let migrated = 0;
  for (const doc of snap.docs) {
    const assignedTo = doc.data().assignedTo;
    if (typeof assignedTo === "string" && assignedTo) {
      batch.update(doc.ref, { assignedTo: [assignedTo] });
      migrated++;
      count++;
      console.log(`  ${doc.id}: "${assignedTo}" -> ["${assignedTo}"]`);
      if (count >= 400) { await batch.commit(); batch = db.batch(); count = 0; }
    }
  }
  if (count > 0) await batch.commit();
  console.log(`Done. Migrated ${migrated} of ${snap.size} document(s).`);
})().catch((e) => {
  console.error("migrate-assignments failed:", e);
  process.exit(1);
});
