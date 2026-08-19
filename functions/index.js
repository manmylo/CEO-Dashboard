/**
 * Mirrors every new notifications/{id} doc out as a Windows/OS push via
 * FCM, on top of the in-app bell (page-shell.js's own onSnapshot listener
 * on this same collection, which stays the source of truth either way --
 * this is purely an additional delivery channel, not a replacement).
 *
 * One notifications doc == one recipient (see page-shell.js's
 * notifyUsers(), which writes one doc per target email) == one invocation
 * here == one push send. FCM itself is free at any volume; this Function
 * needs the Blaze (pay-as-you-go) plan to run at all, but sits nowhere
 * near its free tier (2M invocations/month) at this app's real scale.
 */
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

const HOSTING_ORIGIN = "https://ceo-dashboard-9e9b4.web.app";

exports.sendPushOnNotification = onDocumentCreated("notifications/{id}", async (event) => {
  const data = event.data?.data();
  const toEmail = (data?.toEmail || "").toLowerCase();
  if (!toEmail) {
    logger.warn("sendPushOnNotification: doc has no toEmail, skipping", { id: event.params.id });
    return;
  }

  const tokenSnap = await admin.firestore().doc(`fcmTokens/${toEmail}`).get();
  // Deduped by token string -- a client bug (fixed in page-shell.js's own
  // saveFcmToken(), but this guards any already-polluted doc from before
  // that fix, and any future duplicate source) could leave several entries
  // pointing at the exact same token. Sending once per ENTRY rather than
  // once per DISTINCT token was firing the same OS notification several
  // times over for one real event. Keeps the most recent entry for a given
  // token (last one wins) since that's the freshest addedAt/userAgent.
  const rawEntries = tokenSnap.exists ? (tokenSnap.data().tokens || []) : [];
  const tokenEntries = [...new Map(rawEntries.map((e) => [e.token, e])).values()];
  if (rawEntries.length !== tokenEntries.length) {
    await admin.firestore().doc(`fcmTokens/${toEmail}`).set({ tokens: tokenEntries });
    logger.info(`sendPushOnNotification: collapsed ${rawEntries.length - tokenEntries.length} duplicate token entr${rawEntries.length - tokenEntries.length === 1 ? "y" : "ies"} for ${toEmail}`);
  }
  if (!tokenEntries.length) {
    logger.info(`sendPushOnNotification: ${toEmail} has no registered push tokens (never opted in, or fcmTokens/${toEmail} doesn't exist) -- skipping`);
    return;
  }

  const link = data.link ? `${HOSTING_ORIGIN}/${data.link}` : HOSTING_ORIGIN;
  const message = {
    notification: {
      title: data.title || "Gearevo Dashboard",
      body: data.body || "",
    },
    webpush: {
      fcmOptions: { link },
    },
    tokens: tokenEntries.map((e) => e.token),
  };

  const result = await admin.messaging().sendEachForMulticast(message);
  logger.info(`sendPushOnNotification: sent to ${toEmail} -- ${result.successCount} succeeded, ${result.failureCount} failed`, {
    failures: result.responses
      .map((r, i) => (r.success ? null : { token: tokenEntries[i].token.slice(0, 12) + "…", code: r.error?.code, message: r.error?.message }))
      .filter(Boolean),
  });

  // Prune tokens FCM reports as permanently dead so this list doesn't grow
  // stale and so future sends don't keep paying for (invocation-wise)
  // doomed deliveries. mismatched-credential included -- confirmed via a
  // real send that it means "this token was subscribed under a VAPID key
  // that isn't the project's current one" (e.g. a leftover token from
  // before the Web Push certificate got fixed), which is just as
  // permanently unrecoverable as an expired/unregistered token.
  const deadTokens = new Set();
  result.responses.forEach((r, i) => {
    if (r.success) return;
    const code = r.error?.code || "";
    if (code === "messaging/invalid-registration-token" || code === "messaging/registration-token-not-registered" || code === "messaging/mismatched-credential") {
      deadTokens.add(tokenEntries[i].token);
    }
  });
  if (deadTokens.size) {
    const survivors = tokenEntries.filter((e) => !deadTokens.has(e.token));
    await admin.firestore().doc(`fcmTokens/${toEmail}`).set({ tokens: survivors });
    logger.info(`sendPushOnNotification: pruned ${deadTokens.size} dead token(s) for ${toEmail}`);
  }
});

/**
 * Changes a staff member's login email everywhere at once -- their Google
 * account changed (new company address, personal->work Gmail, etc.), and
 * without this every collection keyed or filtered by their OLD email would
 * silently orphan: they'd sign in as a brand-new nobody with zero history,
 * while all their past assignments/memos/leave records/ratings/etc. stayed
 * invisible under an address they can no longer sign in as.
 *
 * Must run as an Admin SDK Cloud Function, not a client-side batch of
 * Firestore writes -- several of the collections below are FLATLY
 * unwritable from the browser for exactly this kind of cross-user edit
 * (comments have no update rule at all; config/access.admins has no client
 * write path ever, by design; chatThreads/notifications/fcmTokens/
 * announcements' seenBy are all self-scoped to request.auth.token.email,
 * so even an admin acting on someone ELSE's behalf couldn't touch them from
 * the client). This bypasses all of that deliberately, which is exactly why
 * the caller-is-actually-an-admin check below is re-verified server-side
 * against Firestore, never trusted from the client payload.
 *
 * config/pageAccess, config/departmentAccess, and config/orgChart are each
 * a SINGLE doc keyed by email at the top level -- moving a key there is
 * read-the-whole-doc, delete the old key / add the new one in a plain JS
 * object, then .set() the WHOLE doc back, never .update() with a computed
 * dotted path string. Emails contain dots, and Firestore's update() parses
 * dots in a field-path STRING as nested-field navigation, not a literal
 * character in a key name -- exactly the bug settings.js/access.js already
 * dodge client-side via setDoc(...,{merge:true}) instead of updateDoc()
 * for these same three docs. A literal object key survives a full .set()
 * untouched either way, so reading-mutating-writing the whole doc sidesteps
 * the problem entirely rather than fighting FieldPath objects for it.
 *
 * fcmTokens/{oldEmail} is deliberately DELETED, not migrated -- a push
 * token is tied to one browser's own subscription, re-registered
 * automatically (page-shell.js's registerPushToken()) the next time that
 * same browser signs in under the new email. Carrying the raw token over
 * would just be dead weight pointing at a subscription keyed server-side
 * to a VAPID/origin pairing that re-registration recreates for free anyway.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function makeBatcher(db) {
  let batch = db.batch();
  let count = 0;
  let total = 0;
  async function flushIfFull() {
    if (count >= 400) { await batch.commit(); batch = db.batch(); count = 0; }
  }
  return {
    async update(ref, data) { batch.update(ref, data); count++; total++; await flushIfFull(); },
    async delete(ref) { batch.delete(ref); count++; total++; await flushIfFull(); },
    async flush() { if (count > 0) await batch.commit(); },
    get total() { return total; },
  };
}

// Renames `oldEmail` to `newEmail` as an object KEY inside a single
// email-keyed config doc (pageAccess/departmentAccess), preserving
// whatever value it held. No-op if the doc or the key doesn't exist.
async function renameEmailKeyInDoc(db, docPath, oldEmail, newEmail) {
  const ref = db.doc(docPath);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const data = snap.data();
  if (!(oldEmail in data)) return false;
  const next = { ...data };
  next[newEmail] = next[oldEmail];
  delete next[oldEmail];
  await ref.set(next);
  return true;
}

exports.changeUserEmail = onCall({ timeoutSeconds: 300 }, async (request) => {
  const callerEmail = (request.auth?.token?.email || "").toLowerCase();
  if (!request.auth || !request.auth.token.email_verified || !callerEmail) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const db = admin.firestore();
  const accessSnap = await db.doc("config/access").get();
  const accessData = accessSnap.exists ? accessSnap.data() : {};
  const realAdmins = (accessData.admins || []).map((e) => e.toLowerCase());
  const pageAccessSnap = await db.doc("config/pageAccess").get();
  const pageAccessData = pageAccessSnap.exists ? pageAccessSnap.data() : {};
  const callerCaps = pageAccessData[callerEmail] || [];
  const isAdmin = realAdmins.includes(callerEmail) || callerCaps.includes("settings");
  if (!isAdmin) {
    throw new HttpsError("permission-denied", "Only a full admin can change someone's email.");
  }

  const oldEmail = (request.data?.oldEmail || "").trim().toLowerCase();
  const newEmail = (request.data?.newEmail || "").trim().toLowerCase();
  if (!EMAIL_RE.test(oldEmail) || !EMAIL_RE.test(newEmail)) {
    throw new HttpsError("invalid-argument", "Both the old and new email must look like real email addresses.");
  }
  if (oldEmail === newEmail) {
    throw new HttpsError("invalid-argument", "The new email is the same as the old one.");
  }
  const allowedEmails = (accessData.allowedEmails || []).map((e) => e.toLowerCase());
  if (!allowedEmails.includes(oldEmail)) {
    throw new HttpsError("failed-precondition", `${oldEmail} isn't on the login allowlist.`);
  }
  if (allowedEmails.includes(newEmail)) {
    throw new HttpsError("failed-precondition", `${newEmail} is already on the login allowlist -- pick an email nobody else is using.`);
  }

  logger.info(`changeUserEmail: ${callerEmail} renaming ${oldEmail} -> ${newEmail}`);
  const batcher = makeBatcher(db);

  // ---- config/access: allowlist + admins + report recipients (arrays --
  // no dotted-key concern, arrayRemove/arrayUnion is safe here). ----
  const accessUpdate = {
    allowedEmails: admin.firestore.FieldValue.arrayRemove(oldEmail),
    updatedAt: new Date().toISOString(),
  };
  await db.doc("config/access").update(accessUpdate);
  await db.doc("config/access").update({ allowedEmails: admin.firestore.FieldValue.arrayUnion(newEmail) });
  if (realAdmins.includes(oldEmail)) {
    await db.doc("config/access").update({
      admins: admin.firestore.FieldValue.arrayRemove(oldEmail),
    });
    await db.doc("config/access").update({
      admins: admin.firestore.FieldValue.arrayUnion(newEmail),
    });
  }
  if ((accessData.reportRecipients || []).map((e) => e.toLowerCase()).includes(oldEmail)) {
    await db.doc("config/access").update({ reportRecipients: admin.firestore.FieldValue.arrayRemove(oldEmail) });
    await db.doc("config/access").update({ reportRecipients: admin.firestore.FieldValue.arrayUnion(newEmail) });
  }

  // ---- single email-keyed config docs (see the dotted-key comment above) ----
  await renameEmailKeyInDoc(db, "config/pageAccess", oldEmail, newEmail);
  await renameEmailKeyInDoc(db, "config/departmentAccess", oldEmail, newEmail);

  // ---- config/orgChart: placements[*].email, placements[*].members[*].email,
  // and the top-level <email>: {descendants} roll-up entries -- read the
  // whole doc, substitute the email string everywhere it appears, write the
  // whole doc back (same reasoning as renameEmailKeyInDoc above). ----
  const orgSnap = await db.doc("config/orgChart").get();
  if (orgSnap.exists) {
    const org = orgSnap.data();
    const placements = org.placements || {};
    let orgChanged = false;
    for (const pid of Object.keys(placements)) {
      const p = placements[pid];
      if (p.email === oldEmail) { p.email = newEmail; orgChanged = true; }
      if (Array.isArray(p.members)) {
        p.members.forEach((m) => { if (m.email === oldEmail) { m.email = newEmail; orgChanged = true; } });
      }
    }
    if (oldEmail in org) {
      org[newEmail] = org[oldEmail];
      delete org[oldEmail];
      orgChanged = true;
    }
    for (const key of Object.keys(org)) {
      if (key === "placements" || key === newEmail) continue;
      const entry = org[key];
      if (entry && Array.isArray(entry.descendants) && entry.descendants.includes(oldEmail)) {
        entry.descendants = entry.descendants.map((e) => (e === oldEmail ? newEmail : e));
        orgChanged = true;
      }
    }
    if (orgChanged) await db.doc("config/orgChart").set(org);
  }

  // ---- doc-ID-keyed collections: read old, write new, delete old ----
  for (const coll of ["profiles", "staffProfiles", "assignmentStats"]) {
    const oldRef = db.collection(coll).doc(oldEmail);
    const oldSnap = await oldRef.get();
    if (!oldSnap.exists) continue;
    const newRef = db.collection(coll).doc(newEmail);
    const newSnap = await newRef.get();
    if (coll === "assignmentStats" && newSnap.exists) {
      // Shouldn't normally happen (newEmail was just proven not to be on
      // the allowlist), but if it somehow already has stats, add rather
      // than clobber -- ratingSum/ratingCount are running totals.
      const oldData = oldSnap.data(), newData = newSnap.data();
      await newRef.set({
        ratingSum: (newData.ratingSum || 0) + (oldData.ratingSum || 0),
        ratingCount: (newData.ratingCount || 0) + (oldData.ratingCount || 0),
      });
    } else {
      await newRef.set(oldSnap.data());
    }
    await oldRef.delete();
  }
  // Not migrated -- see the function's own top comment for why.
  await db.collection("fcmTokens").doc(oldEmail).delete().catch(() => {});

  // ---- field/array-keyed collections: query, batch-update ----
  const calendarCards = await db.collection("calendarCards").where("editedBy", "==", oldEmail).get();
  for (const doc of calendarCards.docs) await batcher.update(doc.ref, { editedBy: newEmail });
  const yearlyCards = await db.collection("yearlyCards").where("editedBy", "==", oldEmail).get();
  for (const doc of yearlyCards.docs) await batcher.update(doc.ref, { editedBy: newEmail });

  const annByCreated = await db.collection("announcements").where("createdBy", "==", oldEmail).get();
  for (const doc of annByCreated.docs) await batcher.update(doc.ref, { createdBy: newEmail });
  const annByEdited = await db.collection("announcements").where("editedBy", "==", oldEmail).get();
  for (const doc of annByEdited.docs) await batcher.update(doc.ref, { editedBy: newEmail });
  const annByEditor = await db.collection("announcements").where("allowedEditors", "array-contains", oldEmail).get();
  for (const doc of annByEditor.docs) {
    await batcher.update(doc.ref, {
      allowedEditors: admin.firestore.FieldValue.arrayRemove(oldEmail),
    });
    await batcher.update(doc.ref, {
      allowedEditors: admin.firestore.FieldValue.arrayUnion(newEmail),
    });
  }
  // seenBy docs are keyed by email (doc ID) same as profiles/staffProfiles,
  // but scattered one subcollection per announcement -- a collectionGroup
  // query finds every one across every parent in a single pass instead of
  // enumerating announcements first.
  const seenByDocs = await db.collectionGroup("seenBy").where("email", "==", oldEmail).get();
  for (const doc of seenByDocs.docs) {
    await batcher.delete(doc.ref);
    // parent().parent() = the announcement doc; re-create seenBy/{newEmail}
    // under the SAME parent, not a top-level guess at the path.
    await batcher.update(doc.ref.parent.doc(newEmail), { email: newEmail });
  }

  const asgByCreator = await db.collection("assignments").where("assignedBy", "==", oldEmail).get();
  for (const doc of asgByCreator.docs) await batcher.update(doc.ref, { assignedBy: newEmail });
  const asgByAssignee = await db.collection("assignments").where("assignedTo", "array-contains", oldEmail).get();
  for (const doc of asgByAssignee.docs) {
    await batcher.update(doc.ref, { assignedTo: admin.firestore.FieldValue.arrayRemove(oldEmail) });
    await batcher.update(doc.ref, { assignedTo: admin.firestore.FieldValue.arrayUnion(newEmail) });
  }
  const asgByWatcher = await db.collection("assignments").where("watchers", "array-contains", oldEmail).get();
  for (const doc of asgByWatcher.docs) {
    await batcher.update(doc.ref, { watchers: admin.firestore.FieldValue.arrayRemove(oldEmail) });
    await batcher.update(doc.ref, { watchers: admin.firestore.FieldValue.arrayUnion(newEmail) });
  }
  const comments = await db.collectionGroup("comments").where("authorEmail", "==", oldEmail).get();
  for (const doc of comments.docs) await batcher.update(doc.ref, { authorEmail: newEmail });

  const memoBySender = await db.collection("memos").where("senderEmail", "==", oldEmail).get();
  for (const doc of memoBySender.docs) await batcher.update(doc.ref, { senderEmail: newEmail });
  const memoByRecipient = await db.collection("memos").where("recipientEmails", "array-contains", oldEmail).get();
  for (const doc of memoByRecipient.docs) {
    await batcher.update(doc.ref, { recipientEmails: admin.firestore.FieldValue.arrayRemove(oldEmail) });
    await batcher.update(doc.ref, { recipientEmails: admin.firestore.FieldValue.arrayUnion(newEmail) });
  }
  const memoByCc = await db.collection("memos").where("ccEmails", "array-contains", oldEmail).get();
  for (const doc of memoByCc.docs) {
    await batcher.update(doc.ref, { ccEmails: admin.firestore.FieldValue.arrayRemove(oldEmail) });
    await batcher.update(doc.ref, { ccEmails: admin.firestore.FieldValue.arrayUnion(newEmail) });
  }
  const memoByAck = await db.collection("memos").where("acknowledgedBy", "array-contains", oldEmail).get();
  for (const doc of memoByAck.docs) {
    await batcher.update(doc.ref, { acknowledgedBy: admin.firestore.FieldValue.arrayRemove(oldEmail) });
    await batcher.update(doc.ref, { acknowledgedBy: admin.firestore.FieldValue.arrayUnion(newEmail) });
  }

  const todos = await db.collection("todos").where("owner", "==", oldEmail).get();
  for (const doc of todos.docs) await batcher.update(doc.ref, { owner: newEmail });
  const chatThreads = await db.collection("chatThreads").where("owner", "==", oldEmail).get();
  for (const doc of chatThreads.docs) await batcher.update(doc.ref, { owner: newEmail });
  const notifications = await db.collection("notifications").where("toEmail", "==", oldEmail).get();
  for (const doc of notifications.docs) await batcher.update(doc.ref, { toEmail: newEmail });
  const leaveRecords = await db.collection("leaveRecords").where("staffEmail", "==", oldEmail).get();
  for (const doc of leaveRecords.docs) await batcher.update(doc.ref, { staffEmail: newEmail });

  await batcher.flush();
  logger.info(`changeUserEmail: ${oldEmail} -> ${newEmail} done, ${batcher.total} document(s) touched across queried collections`);
  return { ok: true, documentsUpdated: batcher.total };
});
