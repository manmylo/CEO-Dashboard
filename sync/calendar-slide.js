// Publishes this week's Calendar slide to the Gearevo kiosk dashboard.
//
// This used to happen ONLY in a browser: calendar.js relayed the week
// whenever a card changed, which meant the wall display was only as fresh as
// the last time somebody happened to have the Calendar page open. That was
// tolerable while the slide carried meetings and stock arrivals -- they don't
// change silently. It stopped being tolerable once the slide started carrying
// LEAVE, which comes from the duty roster: nobody needs to open the Calendar
// for the week to roll over, so on a Monday morning the display would happily
// show last week's absences as though they were today's.
//
// Running it from the sync (every ~2 minutes) makes the slide correct whether
// or not anyone is looking. The browser relay stays as well -- it reacts
// instantly to an edit, where this closes the gap in between.
//
// Writes go over the Firestore REST API rather than a second Admin SDK app:
// sales/calendarSlide is world-writable by design (see the Gearevo project's
// firestore.rules -- it's a kiosk that can't authenticate into this project),
// and sync.js already reads that project the same way.

const OTHER_PROJECT_ID = "gearevo-dashboard-7f782";
const SLIDE_URL = `https://firestore.googleapis.com/v1/projects/${OTHER_PROJECT_ID}/databases/(default)/documents/sales/calendarSlide`;

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Mirrors calendar.js's ROSTER_LEAVE_CODE. Actual time off only -- OFF DAY
// and CLOSED are scheduled non-working days, and AM/PM/1/2 DAY are shifts.
const LEAVE_CODE = /^(a\/?l|annual( leave)?|mc|sick|el|emergency( leave)?|ul|unpaid( leave)?|cuti|leave|maternity|paternity)$/i;
const LEAVE_SHORT = { "A/L": "AL", "AL": "AL", "MC": "MC", "EL": "EL", "UL": "Unpaid" };

// Monday-to-Sunday, in Malaysian time -- the sync box runs in UTC, so using
// its own local day would roll the week over eight hours early.
function currentWeekDates(myDateStr, toMYT) {
  const nowMy = toMYT(new Date());
  const dow = (nowMy.getUTCDay() + 6) % 7;   // 0 = Mon
  const monday = new Date(nowMy);
  monday.setUTCDate(monday.getUTCDate() - dow);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

// Firestore's REST shape. Only the types this payload actually uses.
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toValue(x)])) } };
}

async function buildLeaveByDate(db, weekDates) {
  const names = {};
  try {
    const snap = await db.collection("profiles").get();
    snap.forEach((d) => { if (d.data().displayName) names[d.id.toLowerCase()] = d.data().displayName; });
  } catch (err) {
    // Names are a nicety; a roster row still shows under its own spelling.
    console.warn("Calendar slide: couldn't read display names —", err.message);
  }

  const byDate = new Map();
  // Newest rosters only. One doc per week, so an unbounded read would grow
  // forever -- same bound the Duty Roster page and calendar.js both use.
  const rosters = await db.collection("dutyRoster").orderBy("startDate", "desc").limit(12).get();
  rosters.forEach((docSnap) => {
    for (const row of docSnap.data().rows || []) {
      if (row.type !== "staff") continue;          // section bands aren't people
      for (const [date, code] of Object.entries(row.days || {})) {
        if (!weekDates.includes(date)) continue;
        if (!LEAVE_CODE.test(String(code).trim())) continue;
        const short = LEAVE_SHORT[String(code).toUpperCase().trim()] || code;
        const who = (row.email && names[row.email.toLowerCase()]) || row.name || row.email || "";
        byDate.set(date, [...(byDate.get(date) || []), `${who} (${short})`]);
      }
    }
  });
  return byDate;
}

// Returns a short line for the run log, or "" when there was nothing to do.
async function publishCalendarSlide(db, { myDateStr, toMYT }) {
  const weekDates = currentWeekDates(myDateStr, toMYT);
  const startKey = weekDates[0], endKey = weekDates[6];

  const cardsByDate = new Map();
  const snap = await db.collection("calendarCards")
    .where("date", ">=", startKey).where("date", "<=", endKey).get();
  snap.forEach((docSnap) => {
    const d = docSnap.data();
    if ((d.cardType || "task") === "target") return;   // Target has its own slide
    cardsByDate.set(d.date, [...(cardsByDate.get(d.date) || []), {
      cardType: d.cardType || "task",
      title: d.title || "",
      description: d.description || "",
      time: d.time || "",
      // Count + total only; the slide has no room for a whole PO table.
      itemCount: (d.items || []).length || null,
      grandTotal: d.grandTotal || null,
    }]);
  });

  const leaveByDate = await buildLeaveByDate(db, weekDates);
  const payload = {
    weekStart: startKey,
    days: weekDates.map((date, i) => ({ date, dayName: DAY_NAMES[i], cards: cardsByDate.get(date) || [] })),
    // Its own field, not folded into cards[], so the browser relay and this
    // one can never clobber each other's half. An ARRAY because Firestore
    // merges maps DEEP -- a keyed object would accumulate old dates forever.
    leave: weekDates.map((date) => {
      const people = leaveByDate.get(date);
      if (!people || !people.length) return null;
      return {
        date,
        title: people.length === 1 ? people[0] : `${people.length} on leave`,
        description: people.join("\n"),
      };
    }).filter(Boolean),
    updatedAt: new Date().toISOString(),
  };

  // updateMask makes this a MERGE of exactly these fields, matching the
  // browser relay's setDoc({merge:true}) -- without it, REST replaces the
  // whole document and anything else living on it would be dropped.
  const mask = Object.keys(payload).map((f) => `updateMask.fieldPaths=${f}`).join("&");
  const res = await fetch(`${SLIDE_URL}?${mask}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, toValue(v)])) }),
  });
  if (!res.ok) throw new Error(`calendarSlide write failed: ${res.status} ${(await res.text()).slice(0, 200)}`);

  const cardCount = [...cardsByDate.values()].reduce((n, a) => n + a.length, 0);
  return `Calendar slide — week of ${startKey}: ${cardCount} card(s), ${payload.leave.length} day(s) with leave.`;
}

export { publishCalendarSlide, currentWeekDates, LEAVE_CODE, LEAVE_SHORT, toValue };
