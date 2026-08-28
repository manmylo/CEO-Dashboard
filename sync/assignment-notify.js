// Assignment Sheet deadline reminders.
//
// Lifted out of sync.js so the timing rules -- the part that is easy to get
// subtly wrong and impossible to eyeball -- can be exercised directly by
// scripts/test-due-notify.js against a fake Firestore, instead of being
// verified by waiting for 6pm and hoping. Same reason calendar-slide.js and
// backfill-products.js are their own files.
//
// Two reminders go out, on two different budgets, because they want
// opposite things:
//
//   DUE NOW      the deadline has just landed. Runs on EVERY ~2-minute tick,
//                because "due at 6pm" has to arrive at 6pm -- a 15-minute
//                window would deliver it at 6:14 and read as broken. Goes to
//                the CREATOR (who now has something to review and rate) and
//                to the ASSIGNEES (whose time is up).
//
//   DUE TOMORROW a heads-up to the assignees, once, from 8am the day before.
//                Keeps the 15-minute throttle: it doesn't need to-the-minute
//                precision, and it re-reads every assignment in a two-day
//                window -- running THAT 720 times a day is what once ate the
//                entire 50K/day Spark-plan read quota by itself.
//
// dueDate is stored as a naive "YYYY-MM-DDTHH:MM" local string with no
// timezone (see assignments.js's New/Edit modal), meaning it is Malaysian
// wall-clock time by convention and never a real instant on its own.
// Appending "+08:00" is what turns it into one.

const MY_TZ = "Asia/Kuala_Lumpur";
const NOTIFY_CHECK_INTERVAL_MS = 15 * 60 * 1000;

// Kept in step with page-shell.js's NOTIF_TTL_DAYS -- notifications written
// from here and from the browser must expire on the same schedule, or the
// pile would only half-clear.
const NOTIF_TTL_DAYS = 10;

function dueDateInstant(dueDate) { return new Date(`${dueDate.slice(0, 16)}:00+08:00`); }
function fmtDueTime(dueDate) {
  return dueDateInstant(dueDate).toLocaleString("en-MY", { hour: "numeric", minute: "2-digit", timeZone: MY_TZ });
}

// The cursor that walks dueDate has to be in dueDate's own units. Comparing
// it against a UTC instant would fire every reminder eight hours out.
function myLocalStamp(toMYT, d) { return toMYT(d).toISOString().slice(0, 16); }

async function notifyOne(db, toEmail, { type, title, body, link }) {
  await db.collection("notifications").add({
    toEmail: (toEmail || "").toLowerCase(), type, title, body: body || "", link: link || "",
    createdAt: new Date().toISOString(), read: false,
    // Real Date -> Firestore Timestamp, which is what the TTL policy on this
    // collection needs (a string field can't be used for TTL). Matches
    // page-shell.js's notifExpiry() -- both must stay on the same window.
    expireAt: new Date(Date.now() + NOTIF_TTL_DAYS * 864e5),
  });
}

// The deadline has landed: one shared moment, two different things to say
// about it. One-shot per assignment, flagged with overdueNotifiedAt on the
// doc itself, which is what lets both scans below reach the same assignment
// without it going out twice.
async function notifyDue(db, docSnap, a, now) {
  if (!a.dueDate || a.overdueNotifiedAt) return 0;
  if (dueDateInstant(a.dueDate) > now) return 0;

  const link = `assignments.html?id=${docSnap.id}`;
  const time = fmtDueTime(a.dueDate);
  const sends = [notifyOne(db, a.assignedBy, {
    type: "assignment",
    title: "Assignment due",
    body: `"${a.title}" is due already — please review and rate it.`,
    link,
  })];

  // The people actually holding the work. Skipped once it is finished or
  // handed in for review: "your deadline has arrived" is noise to someone
  // who submitted days ago, and by then the ball is with the creator -- who
  // is nudged above regardless of status either way.
  if (a.status !== "done" && !a.markedDoneAt) {
    const creator = (a.assignedBy || "").toLowerCase();
    for (const email of a.assignedTo || []) {
      if ((email || "").toLowerCase() === creator) continue;   // don't tell one person twice
      sends.push(notifyOne(db, email, {
        type: "assignment",
        title: "Assignment due now",
        body: `"${a.title}" was due at ${time}.`,
        link,
      }));
    }
  }
  await Promise.all(sends);
  await docSnap.ref.update({ overdueNotifiedAt: now.toISOString() });
  return sends.length;
}

// Reads only the sliver of deadlines that fell between the last tick and
// this one, so it costs one document per assignment that just came due and
// nothing else. An empty result still bills a single read, which is ~720 a
// day rather than 720 x (every assignment).
async function scanDueNow(db, state, now, { toMYT }) {
  const nowLocal = myLocalStamp(toMYT, now);
  // A first run starts the cursor HERE, not at the epoch -- otherwise every
  // assignment that ever had a deadline fires at once.
  const since = state.lastDueScan || nowLocal;
  // Move the cursor even when nothing matches, or a quiet stretch keeps
  // widening the window until it is scanning history again.
  await db.doc("sync/state").set({ lastDueScan: nowLocal }, { merge: true });
  if (since >= nowLocal) return 0;

  // Both bounds on one field, so no composite index is needed.
  const snap = await db.collection("assignments")
    .where("dueDate", ">", since).where("dueDate", "<=", nowLocal).get();
  let sent = 0;
  for (const docSnap of snap.docs) sent += await notifyDue(db, docSnap, docSnap.data(), now);
  if (sent) console.log(`Assignments — ${snap.size} deadline(s) reached by ${nowLocal}, ${sent} notification(s).`);
  return sent;
}

async function scanDaily(db, now, { toMYT, myDateStr }) {
  const nowMy = toMYT(now);
  const isPast8am = nowMy.getUTCHours() >= 8; // toMYT() shifts the instant so UTC getters read as MYT wall-clock
  const tomorrowStr = myDateStr(new Date(now.getTime() + 24 * 60 * 60 * 1000));

  // Bounded to roughly "recent past + near future" via a plain range query
  // on dueDate itself (its YYYY-MM-DD... shape sorts correctly as a plain
  // string) -- both checks below only ever care about a due date within
  // about a day of now, so there is no reason to keep re-reading the FULL
  // assignments history, which only grows.
  const cutoff = myDateStr(new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000));
  const snap = await db.collection("assignments").where("dueDate", ">=", cutoff).get();

  let sent = 0;
  for (const docSnap of snap.docs) {
    const a = docSnap.data();
    if (!a.dueDate) continue;

    // Safety net for scanDueNow. An assignment created -- or edited -- with
    // a deadline ALREADY behind it never falls inside that scan's forward
    // window, and a tick that died after moving the cursor but before
    // sending would have stepped over it. notifyDue is one-shot, so a
    // deadline already caught on time costs nothing here.
    sent += await notifyDue(db, docSnap, a, now);

    // Due tomorrow -- nudge every ASSIGNEE, once, from 8am MYT the day
    // before (not necessarily at 8:00:00 exactly: whenever the next check
    // lands at or after that point, or immediately if the assignment was
    // only created later that same day). Skipped once already done --
    // nothing left to remind them about.
    if (!a.dueSoonNotifiedAt && a.status !== "done" && a.dueDate.slice(0, 10) === tomorrowStr && isPast8am) {
      const time = fmtDueTime(a.dueDate);
      await Promise.all((a.assignedTo || []).map((email) => notifyOne(db, email, {
        type: "assignment",
        title: "Assignment due tomorrow",
        body: `"${a.title}" is due tomorrow at ${time}.`,
        link: `assignments.html?id=${docSnap.id}`,
      })));
      await docSnap.ref.update({ dueSoonNotifiedAt: now.toISOString() });
      sent += (a.assignedTo || []).length;
    }
  }
  return sent;
}

async function checkAssignmentNotifications(db, deps, now = new Date()) {
  // One read of sync/state feeds both scans. lastDueScan and lastNotifyCheck
  // are separate cursors on the same doc, sitting alongside the sales sync's
  // own lastFullSyncDate/lastEmailDate -- different concerns, one document.
  const stateSnap = await db.doc("sync/state").get();
  const state = stateSnap.exists ? stateSnap.data() : {};

  await scanDueNow(db, state, now, deps);

  const lastCheck = state.lastNotifyCheck;
  if (lastCheck && now.getTime() - new Date(lastCheck).getTime() < NOTIFY_CHECK_INTERVAL_MS) {
    return; // too soon -- skip the broad read entirely, not just the notifications
  }
  await db.doc("sync/state").set({ lastNotifyCheck: now.toISOString() }, { merge: true });
  await scanDaily(db, now, deps);
}

export {
  checkAssignmentNotifications, scanDueNow, scanDaily, notifyDue, notifyOne,
  dueDateInstant, fmtDueTime, myLocalStamp,
  NOTIFY_CHECK_INTERVAL_MS, NOTIF_TTL_DAYS,
};
