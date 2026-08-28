// Exercises sync/assignment-notify.js against a fake Firestore.
//
// The thing worth proving is the timing: a 6pm deadline has to notify on the
// first cron tick at or after 6pm, to the creator AND the assignees, exactly
// once, and never a tick early. That is unobservable in production without
// waiting for 6pm, so it is driven here instead -- these import the REAL
// module, so the test cannot drift away from the shipped logic.
//
//   node scripts/test-due-notify.js
import { scanDueNow, scanDaily, checkAssignmentNotifications } from "../sync/assignment-notify.js";

const MY_OFFSET_MS = 8 * 60 * 60 * 1000;
const toMYT = (d) => new Date(new Date(d).getTime() + MY_OFFSET_MS);
const myDateStr = (d) => toMYT(d).toISOString().slice(0, 10);
const deps = { toMYT, myDateStr };

// A Malaysian wall-clock time as a real instant, the way the cron sees it.
const at = (hhmm, day = "2026-08-28") => new Date(`${day}T${hhmm}:00+08:00`);

// ---------- the fake ----------
function makeDb(assignments) {
  const notes = [];
  let state = {};
  const docs = assignments.map((a, i) => {
    const id = a.id || `a${i}`;
    const self = {
      id,
      data: () => a,
      ref: { update: async (patch) => Object.assign(a, patch) },
    };
    return self;
  });

  const collection = (name) => {
    if (name === "notifications") return { add: async (n) => { notes.push(n); } };
    if (name !== "assignments") throw new Error(`unexpected collection ${name}`);
    // Only dueDate is ever filtered on, so the fake implements exactly that.
    const q = (filters) => ({
      where: (f, op, v) => {
        if (f !== "dueDate") throw new Error(`unexpected filter field ${f}`);
        return q([...filters, [op, v]]);
      },
      get: async () => {
        const hits = docs.filter((d) => {
          const v = d.data().dueDate;
          if (!v) return false;
          return filters.every(([op, x]) =>
            op === ">" ? v > x : op === ">=" ? v >= x : op === "<=" ? v <= x
              : (() => { throw new Error(`unexpected op ${op}`); })());
        });
        return { docs: hits, size: hits.length, empty: !hits.length };
      },
    });
    return q([]);
  };

  return {
    notes,
    peekState: () => state,
    collection,
    doc: (path) => {
      if (path !== "sync/state") throw new Error(`unexpected doc ${path}`);
      return {
        get: async () => ({ exists: Object.keys(state).length > 0, data: () => state }),
        set: async (patch) => { state = { ...state, ...patch }; },
      };
    },
  };
}

// ---------- assertions ----------
let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`); }
}
const recipients = (db) => db.notes.map((n) => n.toEmail).sort();
const titles = (db) => db.notes.map((n) => n.title).sort();

const task = (over) => ({
  title: "Stock count", assignedBy: "Boss@gearevo.com",
  assignedTo: ["staff@gearevo.com"], status: "open", dueDate: "2026-08-28T18:00", ...over,
});

// ---------- 1. fires on the first tick at or after the deadline ----------
console.log("\nTiming — deadline 18:00, cron every 2 minutes");
{
  const db = makeDb([task()]);
  let state = {};
  const fired = [];
  for (const t of ["17:56", "17:58", "18:00", "18:02", "18:04"]) {
    const before = db.notes.length;
    await scanDueNow(db, state, at(t), deps);
    state = db.peekState();
    if (db.notes.length > before) fired.push(t);
  }
  check("fires once, on the 18:00 tick", fired, ["18:00"]);
  check("creator and assignee both told", recipients(db), ["boss@gearevo.com", "staff@gearevo.com"]);
  check("each gets the right wording", titles(db), ["Assignment due", "Assignment due now"]);
}

// A tick that lands slightly late must still catch it -- the runner is not
// punctual, and the sweeper that cancels stuck runs makes gaps likelier.
{
  const db = makeDb([task()]);
  let state = {};
  const fired = [];
  for (const t of ["17:51", "18:07", "18:21"]) {     // a 16-minute gap over the deadline
    const before = db.notes.length;
    await scanDueNow(db, state, at(t), deps);
    state = db.peekState();
    if (db.notes.length > before) fired.push(t);
  }
  check("a late tick still catches it, once", fired, ["18:07"]);
}

// ---------- 2. who gets told ----------
// A cursor sitting just before the deadline. Without one, scanDueNow starts
// the cursor at "now" and scans nothing -- which is the first-run rule
// proven further down, not what these four are about.
const before18 = { lastDueScan: "2026-08-28T17:58" };
console.log("\nRecipients");
{
  const db = makeDb([task({ assignedTo: ["a@x.com", "b@x.com", "c@x.com"] })]);
  await scanDueNow(db, before18, at("18:02"), deps);
  check("every assignee, plus the creator", recipients(db), ["a@x.com", "b@x.com", "boss@gearevo.com", "c@x.com"]);
}
{
  const db = makeDb([task({ assignedTo: ["BOSS@gearevo.com"] })]);   // assigned to self
  await scanDueNow(db, before18, at("18:02"), deps);
  check("self-assigned is not told twice", recipients(db), ["boss@gearevo.com"]);
}
{
  const db = makeDb([task({ status: "done" })]);
  await scanDueNow(db, before18, at("18:02"), deps);
  check("finished — creator only", recipients(db), ["boss@gearevo.com"]);
}
{
  const db = makeDb([task({ markedDoneAt: "2026-08-27T09:00:00Z" })]);
  await scanDueNow(db, before18, at("18:02"), deps);
  check("handed in for review — creator only", recipients(db), ["boss@gearevo.com"]);
}

// ---------- 3. the cursor ----------
console.log("\nCursor");
{
  // Six assignments that came due days ago. A first run must not flood.
  const old = Array.from({ length: 6 }, (_, i) => task({ id: `o${i}`, dueDate: "2026-08-20T18:00" }));
  const db = makeDb(old);
  await scanDueNow(db, {}, at("10:00"), deps);
  check("first run ever sends nothing", db.notes.length, 0);
  check("but it does plant the cursor", db.peekState().lastDueScan, "2026-08-28T10:00");
}
{
  const db = makeDb([task()]);
  let state = {};
  for (const t of ["09:00", "09:02", "09:04"]) {
    await scanDueNow(db, state, at(t), deps);
    state = db.peekState();
  }
  check("quiet ticks keep advancing the cursor", state.lastDueScan, "2026-08-28T09:04");
}

// ---------- 4. the safety net ----------
console.log("\nSafety net — deadlines the forward window cannot see");
{
  // Created at 4pm with a deadline of 2pm the same day: it is already behind
  // the cursor, so scanDueNow will never match it.
  const db = makeDb([task({ dueDate: "2026-08-28T14:00" })]);
  await scanDueNow(db, { lastDueScan: "2026-08-28T15:58" }, at("16:00"), deps);
  check("forward scan misses a backdated deadline", db.notes.length, 0);
  await scanDaily(db, at("16:00"), deps);
  check("daily scan catches it", recipients(db), ["boss@gearevo.com", "staff@gearevo.com"]);
  const n = db.notes.length;
  await scanDaily(db, at("16:15"), deps);
  check("and does not repeat it", db.notes.length, n);
}

// ---------- 5. end to end, through the throttle ----------
console.log("\nWhole check, ticking every 2 minutes from 17:50 to 18:10");
{
  const db = makeDb([task()]);
  const fired = [];
  for (let m = 50; m <= 70; m += 2) {
    const t = m < 60 ? `17:${m}` : `18:${String(m - 60).padStart(2, "0")}`;
    const before = db.notes.length;
    await checkAssignmentNotifications(db, deps, at(t));
    if (db.notes.length > before) fired.push(t);
  }
  check("exactly one round of notifications, at 18:00", fired, ["18:00"]);
  check("two people, once each", recipients(db), ["boss@gearevo.com", "staff@gearevo.com"]);
  check("links point at the assignment", [...new Set(db.notes.map((n) => n.link))], ["assignments.html?id=a0"]);
  check("assignee is told the time it was due", db.notes.find((n) => n.toEmail === "staff@gearevo.com").body,
    '"Stock count" was due at 6:00 pm.');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
