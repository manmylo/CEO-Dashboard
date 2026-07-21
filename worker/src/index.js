/**
 * Gearevo BI chatbot + order-lookup backend (Cloudflare Worker).
 *
 * Security model: this Worker holds no Firebase credentials of its own.
 * Every request must carry the caller's own Firebase Auth ID token, which
 * gets forwarded as-is to Firestore's REST API. Firestore's existing
 * security rules (signed-in + email in config/access) enforce who can read
 * dashboard data — if the token is invalid or the email isn't allowlisted,
 * the Firestore read fails and this Worker never calls Claude/Shopify. No
 * duplicate auth/allowlist logic to keep in sync with firestore.rules.
 *
 * Secrets (set via `wrangler secret put`):
 *   ANTHROPIC_API_KEY
 *   SHOP_DOMAIN, SHOP_TOKEN, SHOP_API_VERSION (optional, e.g. 2026-01) —
 *   same Shopify store/credentials sync.js uses, needed for POST /orders.
 */

const FIREBASE_PROJECT_ID = "ceo-dashboard-9e9b4";
const GEAREVO_PROJECT_ID = "gearevo-dashboard-7f782";
const ALLOWED_ORIGIN = "https://ceo-dashboard-9e9b4.web.app";

const BUSINESS_CONTEXT = `Gearevo sells across several distinct categories, not just butcher knives: (1) Kitchen & butcher knives/tools — knives, cleavers, boning/skinning tools, kitchen sets (F. Herder, Giesser, F. Dick, Victorinox Butcher, Wüsthof, Pirge, Icel, Swibo); (2) EDC & outdoor knives — folding/survival knives (Spyderco, Benchmade, CRKT, Kershaw, Civivi, Cold Steel, and more); (3) Parangs/machetes, a distinct Malaysian-market category; (4) sharpening tools and services (stones, sharpeners, honing rods, a sharpening class); (5) sheaths and carry gear (custom/ready-made Kydex, bags, cases).

Sales are NOT flat year-round — there's a real promotional/seasonal calendar:
- Eid Adha (Hari Raya Haji / Qurban / "Raya Korban") drives a hard spike in butcher/slaughter knife sales, followed by 1-2 months of tiered post-season clearance sales. A spike in butcher-knife sales/concentration around this time, or a drop afterward, is EXPECTED, not a red flag.
- The store also runs recurring PAYDAY SALES (tied to Malaysian salary payout dates, roughly monthly) plus Merdeka Day (Aug 31) and Christmas promotions.`;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// Firestore REST API returns typed-wrapper values, e.g. {"stringValue":"x"},
// {"integerValue":"5"}, {"mapValue":{"fields":{...}}}. Unwrap to plain JSON.
function unwrapFirestoreValue(value) {
  if (value == null) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("nullValue" in value) return null;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(unwrapFirestoreValue);
  if ("mapValue" in value) return unwrapFirestoreFields(value.mapValue.fields || {});
  return null;
}
function unwrapFirestoreFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) out[key] = unwrapFirestoreValue(value);
  return out;
}

async function fetchDashboardLatest(idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/dashboard/latest`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, text };
  }
  const body = await res.json();
  return { ok: true, data: unwrapFirestoreFields(body.fields || {}) };
}

// dashboard/latest only gets its sales figures refreshed by the once-a-day
// full sync (runQuick only touches inventory) -- so on its own it can be
// close to 24h stale for "today"/"this month". This reads Gearevo's own
// sales/today doc directly instead (open rules, no auth needed), the exact
// same live source the dashboard's own "Today's Sales" KPI reads from, so
// the chatbot's view of "today" is never older than a couple minutes.
// Best-effort -- if it fails, the rest of the snapshot still answers fine.
async function fetchGearevoTodayLive() {
  const url = `https://firestore.googleapis.com/v1/projects/${GEAREVO_PROJECT_ID}/databases/(default)/documents/sales/today`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.json();
    const f = unwrapFirestoreFields(body.fields || {});
    return {
      currentSaleToday: Number(f.currentSale || 0),
      ordersToday: Number(f.totalOrders || 0),
      channelsToday: f.channels || {},
      regionsToday: f.regions || {},
      lastUpdated: f.updatedAt || f.syncedAt || null,
    };
  } catch {
    return null;
  }
}

// Shared runQuery helper for this project's own collections (calendarCards,
// announcements) -- fetchDailyRange above has its own copy since it predates
// this and isn't worth touching working code to dedupe.
async function runFirestoreQuery(idToken, structuredQuery) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) throw new Error(`Firestore query failed: ${res.status} ${await res.text().catch(() => "")}`);
  const rows = await res.json();
  return (rows || []).filter((r) => r.document).map((r) => unwrapFirestoreFields(r.document.fields || {}));
}

// Same collection/fields the Calendar page itself reads (calendarCards, one
// doc per card, keyed by an exact "date" field) -- real scheduled
// tasks/meetings/reminders/events, not a snapshot baked into dashboard/latest.
async function fetchCalendarEvents(idToken, from, to) {
  const rows = await runFirestoreQuery(idToken, {
    from: [{ collectionId: "calendarCards" }],
    where: {
      compositeFilter: {
        op: "AND",
        filters: [
          { fieldFilter: { field: { fieldPath: "date" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: from } } },
          { fieldFilter: { field: { fieldPath: "date" }, op: "LESS_THAN_OR_EQUAL", value: { stringValue: to } } },
        ],
      },
    },
    orderBy: [{ field: { fieldPath: "date" }, direction: "ASCENDING" }],
  });
  return rows
    .filter((r) => (r.cardType || "task") !== "target") // Target cards are monthly sales goals, not events
    .map((r) => ({ date: r.date, cardType: r.cardType || "task", title: r.title || "", description: r.description || "", time: r.time || "" }));
}

// Same collection the Announcement page itself reads. Defaults to hiding
// expired posts (matching what staff would actually see by default on that
// page) unless the question is specifically about past/expired ones.
async function fetchAnnouncements(idToken, includeExpired) {
  const rows = await runFirestoreQuery(idToken, {
    from: [{ collectionId: "announcements" }],
    orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
    limit: 50,
  });
  const todayStr = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return rows
    .filter((p) => includeExpired || !p.expiresAt || p.expiresAt >= todayStr)
    .map((p) => ({
      title: p.title || "", message: p.message || "", category: p.category || "general",
      pinned: !!p.pinned, postedAt: p.editedAt || p.createdAt || "", expiresAt: p.expiresAt || null,
    }));
}

// Firestore's own runQuery endpoint — used by the get_sales_by_date_range
// tool below, live per-call (not a fixed snapshot). Reads the same `daily`
// collection app.js's own trend chart/date-range filters already read
// (sync.js writes one doc per date, each carrying that day's per-product
// and per-service breakdown), so this is real data, not a reconstruction.
// A single-field range (>= and <= on the same "date" field) doesn't need a
// composite index — Firestore's automatic single-field index covers it.
async function fetchDailyRange(idToken, from, to) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const structuredQuery = {
    from: [{ collectionId: "daily" }],
    where: {
      compositeFilter: {
        op: "AND",
        filters: [
          { fieldFilter: { field: { fieldPath: "date" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: from } } },
          { fieldFilter: { field: { fieldPath: "date" }, op: "LESS_THAN_OR_EQUAL", value: { stringValue: to } } },
        ],
      },
    },
    orderBy: [{ field: { fieldPath: "date" }, direction: "ASCENDING" }],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) throw new Error(`Firestore range query failed: ${res.status} ${await res.text().catch(() => "")}`);
  const rows = await res.json();
  return (rows || [])
    .filter((r) => r.document)
    .map((r) => unwrapFirestoreFields(r.document.fields || {}));
}

// Sums each day's per-product/per-service breakdown across the picked range
// — same aggregation app.js does client-side for its own date-range filters,
// just server-side here since the tool result needs to be compact enough to
// hand back to Claude as JSON (not the raw day-by-day array).
function aggregateDailyRange(days) {
  const byProduct = {}, byService = {};
  let totalSales = 0, totalOrders = 0;
  for (const day of days) {
    totalSales += Number(day.todaySales || 0);
    totalOrders += Number(day.orders || 0);
    for (const p of day.products || []) {
      const e = byProduct[p.pid] || (byProduct[p.pid] = { title: p.title, revenue: 0, profit: 0, units: 0 });
      e.revenue += Number(p.revenue || 0);
      e.profit += Number(p.profit || 0);
      e.units += Number(p.units || 0);
    }
    for (const s of day.services || []) {
      const e = byService[s.category] || (byService[s.category] = { category: s.category, revenue: 0, units: 0 });
      e.revenue += Number(s.revenue || 0);
      e.units += Number(s.units || 0);
    }
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  const topProducts = Object.values(byProduct)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 20)
    .map((p) => ({ title: p.title, revenue: round2(p.revenue), profit: round2(p.profit), units: p.units }));
  const topServices = Object.values(byService)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)
    .map((s) => ({ category: s.category, revenue: round2(s.revenue), units: s.units }));
  return { daysInRange: days.length, totalSales: round2(totalSales), totalOrders, topProducts, topServices };
}

// Channel/region breakdown lives in the Gearevo dashboard's OWN Firestore
// project now (open read rules on sales/*, no auth needed), not this
// project's `daily` collection — app.js's own Sales by Channel/Region cards
// read it the same way, live, since sync.py (Gearevo-side) computes it from
// Shopify's real per-order channel/shipping data. Paginated GET + client-side
// date filter, same shape sync.js's own fetchAllDailySalesFromDashboard()
// already uses successfully against this same collection.
async function fetchGearevoChannelRegion(from, to) {
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${GEAREVO_PROJECT_ID}/databases/(default)/documents/sales/daily/days`;
  const byChannel = {}, byRegion = {};
  let daysInRange = 0;
  let pageToken = null;
  do {
    const url = new URL(baseUrl);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gearevo Firestore fetch failed: ${res.status}`);
    const page = await res.json();
    for (const doc of page.documents || []) {
      const fields = unwrapFirestoreFields(doc.fields || {});
      const date = fields.date || doc.name.split("/").pop();
      if (!date || date < from || date > to) continue;
      daysInRange++;
      for (const [name, val] of Object.entries(fields.channels || {})) {
        byChannel[name] = (byChannel[name] || 0) + Number(val || 0);
      }
      for (const [name, val] of Object.entries(fields.regions || {})) {
        byRegion[name] = (byRegion[name] || 0) + Number(val || 0);
      }
    }
    pageToken = page.nextPageToken || null;
  } while (pageToken);

  const round2 = (n) => Math.round(n * 100) / 100;
  const sortDesc = (obj) => Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => ({ name, value: round2(value) }));
  return { daysInRange, channels: sortDesc(byChannel), regions: sortDesc(byRegion) };
}

const SALES_RANGE_TOOL = {
  name: "get_sales_by_date_range",
  description: "Aggregates real sales data (total sales, order count, top products by revenue, top services by revenue) for any specific date range you choose — not limited to the pre-computed 90-day/this-month figures in the dashboard snapshot. Use this for ANY question about a period the snapshot doesn't already cover (e.g. \"this week\", \"last 14 days\", \"last Ramadan\", a specific date range) instead of saying the data isn't available.",
  input_schema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Start date, inclusive, format YYYY-MM-DD" },
      to: { type: "string", description: "End date, inclusive, format YYYY-MM-DD" },
    },
    required: ["from", "to"],
  },
};

const CHANNEL_REGION_TOOL = {
  name: "get_channel_region_by_date_range",
  description: "Aggregates real sales by sales channel (Shopee, TikTok, Online Store, Point of Sale, etc.) and by Malaysian region/state, for any date range you choose. Use this for any question about which channel or region something sold through/in — the main dashboard snapshot does not include this.",
  input_schema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Start date, inclusive, format YYYY-MM-DD" },
      to: { type: "string", description: "End date, inclusive, format YYYY-MM-DD" },
    },
    required: ["from", "to"],
  },
};

const RETURNS_CANCELLED_TOOL = {
  name: "get_returns_and_cancelled",
  description: "Fetches the live, order-level list of returns (shipped then refunded) and cancellations (never shipped) for one calendar month, with order numbers and values. Use this for any question about returns/refunds/cancellations, including which specific orders were involved — the dashboard snapshot only has a single 90-day rate, not order-level detail or other months.",
  input_schema: {
    type: "object",
    properties: {
      month: { type: "string", description: "Calendar month, format YYYY-MM" },
    },
    required: ["month"],
  },
};

const CALENDAR_TOOL = {
  name: "get_calendar_events",
  description: "Fetches real Calendar cards (tasks, meetings, reminders, events — not sales targets) for a specific date range from the company calendar. Use this for any question about what's scheduled, planned, or happening on specific dates.",
  input_schema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Start date, inclusive, format YYYY-MM-DD" },
      to: { type: "string", description: "End date, inclusive, format YYYY-MM-DD" },
    },
    required: ["from", "to"],
  },
};

const ANNOUNCEMENTS_TOOL = {
  name: "get_announcements",
  description: "Fetches real company announcements/bulletin posts (title, message, category, pinned status, posted date). Defaults to only currently-active (non-expired) ones. Use this for any question about announcements, promos, or policies that were posted.",
  input_schema: {
    type: "object",
    properties: {
      includeExpired: { type: "boolean", description: "Set true to also include expired announcements. Defaults to false." },
    },
  },
};

// One retry on a 429/5xx (covers the "Overloaded" 529 Anthropic returns
// under load) — everything else (bad request, auth) fails immediately since
// retrying won't change the outcome.
async function callAnthropic(payload, apiKey) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) return res.json();
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    const text = await res.text().catch(() => "");
    throw new Error(`Claude API error ${res.status}: ${text}`);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

// Runs one tool call and returns its JSON-serializable result. `env` is only
// needed by get_returns_and_cancelled (Shopify credentials); the other two
// read Firestore directly.
// CEO Dashboard's own `daily/{date}` docs are only written by its once-a-day
// full sync, so today's row in there can be hours stale -- or, right after
// midnight MYT, not written for today at all yet. Whenever a requested range
// includes today, this overwrites (or adds) today's slice with the genuinely
// live sales/orders total from fetchGearevoTodayLive() instead. A brand-new
// day with zero orders so far is handled the same way as any other value --
// the live doc correctly reports 0, so the range total just reflects that.
// Per-product/per-service breakdown for today isn't correctable this way
// (Gearevo's sales/today doc has no line-item detail) -- whatever the stale
// daily/{today} doc already had for those, if anything, is left as-is; only
// the sales/orders TOTAL is guaranteed live-accurate.
async function spliceLiveToday(days, todayMYT) {
  const live = await fetchGearevoTodayLive();
  if (!live) return false; // best-effort -- leave days untouched if this fetch fails
  const idx = days.findIndex((d) => d.date === todayMYT);
  const existing = idx >= 0 ? days[idx] : null;
  const todayEntry = {
    date: todayMYT,
    todaySales: live.currentSaleToday,
    orders: live.ordersToday,
    products: existing?.products || [],
    services: existing?.services || [],
  };
  if (idx >= 0) days[idx] = todayEntry; else days.push(todayEntry);
  // True whenever today has real live sales but no product/service line
  // items to show for it yet (products/services aren't correctable from the
  // live doc) -- lets the caller flag that top products/services for the
  // range may be missing today's items even though the sales total itself
  // now correctly includes them.
  return live.currentSaleToday > 0 && !(existing?.products?.length) && !(existing?.services?.length);
}

async function runTool(call, idToken, env) {
  const input = call.input || {};
  if (call.name === "get_sales_by_date_range") {
    if (!DATE_RE.test(input.from || "") || !DATE_RE.test(input.to || "")) throw new Error("from/to must be YYYY-MM-DD");
    const days = await fetchDailyRange(idToken, input.from, input.to);
    const todayMYT = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let todayItemsIncomplete = false;
    if (input.from <= todayMYT && input.to >= todayMYT) todayItemsIncomplete = await spliceLiveToday(days, todayMYT);
    const result = aggregateDailyRange(days);
    if (todayItemsIncomplete) {
      result.note = "Today's sales total is live-accurate, but today's individual products/services aren't reflected in topProducts/topServices yet (only settled from previous syncs) -- mention this if today's contribution to the ranking matters.";
    }
    return result;
  }
  if (call.name === "get_channel_region_by_date_range") {
    if (!DATE_RE.test(input.from || "") || !DATE_RE.test(input.to || "")) throw new Error("from/to must be YYYY-MM-DD");
    return fetchGearevoChannelRegion(input.from, input.to);
  }
  if (call.name === "get_returns_and_cancelled") {
    if (!MONTH_RE.test(input.month || "")) throw new Error("month must be YYYY-MM");
    return fetchMonthOrderSummary(input.month, env);
  }
  if (call.name === "get_calendar_events") {
    if (!DATE_RE.test(input.from || "") || !DATE_RE.test(input.to || "")) throw new Error("from/to must be YYYY-MM-DD");
    return { events: await fetchCalendarEvents(idToken, input.from, input.to) };
  }
  if (call.name === "get_announcements") {
    return { announcements: await fetchAnnouncements(idToken, !!input.includeExpired) };
  }
  throw new Error(`Unknown tool: ${call.name}`);
}

async function askClaude(question, history, dashboardData, liveToday, idToken, apiKey, env) {
  const todayMYT = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const messages = [
    ...(history || []).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: question },
  ];

  // Split into blocks ordered stable -> volatile, with cache_control on the
  // two that are worth caching. Prompt caching is a PREFIX match -- anything
  // after a changed block can't hit cache -- so the least-often-changing
  // content has to come first:
  //   1. instructions/business context -- only changes when this file is
  //      edited and redeployed; cached with a 1h TTL.
  //   2. dashboard snapshot -- only changes when sync.js's full sync runs
  //      (roughly daily); cached with the default 5m TTL, so bursts of
  //      questions against the same snapshot mostly hit cache without
  //      paying to keep an hour of a soon-to-be-stale snapshot alive.
  //   3. live-today -- changes every couple of minutes; never cached,
  //      always sent fresh, and it's small so the token cost is trivial.
  // See shared/prompt-caching.md -- this is the standard "frozen prefix,
  // volatile suffix" placement pattern.
  const instructions = `You are a business analyst assistant for Gearevo, a Malaysian knife/gear retailer selling through Shopify, Shopee, and TikTok Shop. You're answering questions from Gearevo's own staff about their business data, shown inside their internal dashboard.

${BUSINESS_CONTEXT}

Today's date (MYT): ${todayMYT}. Weeks run Monday-Sunday.

You are given a snapshot of the dashboard's current data as JSON, covering the last 90 days and this month specifically (sales, margin, top products, dead/slow-moving/out-of-stock, customer segments, basket analysis), plus a separate live-today block that's always current (updated within minutes, not tied to the snapshot's own refresh schedule). For anything neither of those covers, use a tool instead of saying the data isn't available:
- A different time period (this week, last 14 days, a past promotion, etc.) → get_sales_by_date_range for sales/products/services totals.
- Which sales channel or region something sold through → get_channel_region_by_date_range (the snapshot has no channel/region breakdown at all).
- Returns, refunds, or cancellations — especially order-level detail or any month other than a rolling 90-day rate → get_returns_and_cancelled.
- What's on the calendar (tasks, meetings, reminders, events) for specific dates → get_calendar_events.
- Company announcements/bulletin posts → get_announcements.
Combine tools if a question needs more than one. Answer using only real data (the snapshot, the live-today block, or a tool result) — never invent figures, trends, product names, or calendar/announcement content. If something genuinely can't be answered (e.g. a metric with no historical tracking at all, like stock levels from months ago), say so plainly rather than guessing. Keep answers concise and business-focused, in plain English. Use RM for currency figures, formatted to 2 decimal places.`;

  const system = [
    { type: "text", text: instructions, cache_control: { type: "ephemeral", ttl: "1h" } },
    {
      type: "text",
      text: `Dashboard snapshot (90-day/this-month window):\n${JSON.stringify(dashboardData)}`,
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: `Live today (always current):\n${JSON.stringify(liveToday)}` },
  ];

  // Agentic loop: Claude may ask for a tool, we run it and feed the result
  // back, repeat until it gives a final text answer. Capped so a stuck model
  // can't loop forever.
  for (let round = 0; round < 4; round++) {
    const body = await callAnthropic({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system,
      tools: [SALES_RANGE_TOOL, CHANNEL_REGION_TOOL, RETURNS_CANCELLED_TOOL, CALENDAR_TOOL, ANNOUNCEMENTS_TOOL],
      messages,
    }, apiKey);

    // Best-effort visibility into whether caching is actually landing --
    // check `wrangler tail` for this if cache_read_input_tokens stays 0
    // across back-to-back questions when it shouldn't.
    if (body.usage) {
      console.log(`Cache: read=${body.usage.cache_read_input_tokens || 0} write=${body.usage.cache_creation_input_tokens || 0} fresh=${body.usage.input_tokens || 0}`);
    }

    const toolUses = (body.content || []).filter((b) => b.type === "tool_use");
    if (body.stop_reason === "tool_use" && toolUses.length) {
      messages.push({ role: "assistant", content: body.content });
      const toolResults = [];
      for (const call of toolUses) {
        let resultPayload;
        try {
          resultPayload = await runTool(call, idToken, env);
        } catch (e) {
          resultPayload = { error: e.message || "Lookup failed" };
        }
        toolResults.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(resultPayload) });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    const textBlock = (body.content || []).find((b) => b.type === "text");
    if (!textBlock) {
      const blockTypes = (body.content || []).map((b) => b.type).join(",") || "none";
      throw new Error(`No text block in Claude response (stop_reason: ${body.stop_reason}, blocks: ${blockTypes})`);
    }
    return textBlock.text;
  }
  throw new Error("Assistant made too many tool calls without answering.");
}

// Uses ShopifyQL (the `sales` table — Shopify's actual sales ledger, same
// thing that powers Shopify's own Analytics), not a reconstruction from
// Orders REST/GraphQL fields.
//
// Reconstructing "today's orders" from Orders fields can only ever see two
// kinds of event: an order's original creation, and formal refunds. There's
// no Orders-API field for a THIRD kind of event — items added to an
// ALREADY-PLACED order via an edit/exchange. Root-caused directly against
// Shopify's own "Net sales by order" ShopifyQL report: one edited order
// (items swapped after the order was placed on an earlier day) accounted
// for the entire gap between this Worker's number and Shopify's own. The
// `sales` table records all three event types individually, each dated by
// when it actually happened, matching Shopify's own dashboards exactly —
// same query shape used to diagnose this in the first place.
// Requires the read_reports scope on the SHOP_TOKEN.
async function fetchOrdersForDate(dateStr, env) {
  const shop = env.SHOP_DOMAIN;
  const token = env.SHOP_TOKEN;
  if (!shop || !token) throw new Error("Shopify credentials not configured on this Worker.");
  const ver = env.SHOP_API_VERSION || "2026-01";

  const ql = `FROM sales SHOW net_sales GROUP BY hour, sale_id, order_name, `
    + `product_title_at_time_of_sale SINCE ${dateStr} UNTIL ${dateStr} ORDER BY hour ASC LIMIT 1000`;
  const res = await fetch(`https://${shop}/admin/api/${ver}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({
      query: `query($q: String!) { shopifyqlQuery(query: $q) { tableData { columns { name } rows } parseErrors } }`,
      variables: { q: ql },
    }),
  });
  if (!res.ok) throw new Error(`Shopify API error ${res.status}: ${await res.text().catch(() => "")}`);
  const body = await res.json();
  if (body.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors)}`);
  const result = body.data?.shopifyqlQuery;
  if (result?.parseErrors?.length) throw new Error(`ShopifyQL parse error: ${JSON.stringify(result.parseErrors)}`);
  const rows = result?.tableData?.rows || [];

  // Rows with no order_name are empty hour buckets (no sale that hour) —
  // GROUP BY hour still emits a placeholder row for them.
  const orders = rows
    .filter((r) => r.order_name)
    .map((r) => ({
      orderNumber: r.order_name,
      productTitle: r.product_title_at_time_of_sale || null,
      value: Number(r.net_sales || 0),
      type: Number(r.net_sales) < 0 ? "refund" : "sale",
      // Store's timezone is confirmed GMT+08:00 Kuala Lumpur, and ShopifyQL's
      // SINCE/UNTIL and GROUP BY hour both operate in that timezone, so this
      // is already MYT — do not re-apply a +8h conversion on top of it.
      timestampMYT: r.hour,
    }));

  return { orders };
}

// Same exclusion list as sync/excluded-skus.js (services/add-ons, not real
// stock items — excluded from product-cost math there too). Duplicated here
// rather than imported since the Worker and sync.js are separate deployable
// units; keep the two lists in sync manually if it ever changes.
const SERVICE_SKUS = new Set([
  "GE-AA.TP", "GE-AON:EXPRESS", "GE-PS.6-9", "GE-PS.10-14", "GE-PS.0-6",
  "GE-AA.0-6", "GE-AA.6-9", "GE-AA.10-14", "GE-LENG", "GE-LENG1",
  "GE-LEADROW", "GE-LEARAB", "GE-LEARAB-4TO50", "GE-LELOGO", "GE-LELOGO-4TO50",
  "GE-KYIGRN.8-9", "GE-KYIGRN.5-7", "GE-KYIGRN.10-14",
  "GE-KYHO.8-9", "GE-KYHO.5-7", "GE-KYHO.10-14",
  "GE-KYOD.8-9", "GE-KYOD.5-7", "GE-KYOD.10-14",
  "GE-KYRBWN.8-9", "GE-KYRBWN.5-7", "GE-KYRBWN.10-14",
  "GE-KYCB.8-9", "GE-KYCB.5-7", "GE-KYCB.10-14",
  "GE-KYCHOB.8-9", "GE-KYCHOB.5-7", "GE-KYCHOB.10-14",
  "GE-KYSC.8-9", "GE-KYSC.5-7", "GE-KYSC.10-14",
  "GE-KYRBLK.10-14", "GE-KYRBLK.5-7", "GE-KYRBLK.8-9",
  "GE-KYCF.8-9", "GE-KYCF.5-7", "GE-KYCF.10-14",
  "GE-KYBLK.8-9", "GE-KYBLK.10-14", "GE-KYBLK.5-7",
  "GE-KYBLT.A", "GE-KYBLT.B", "GE-KYBLT.C",
  "GE-SAND.8-9", "GE-SAND.5-7", "GE-SAND.10-14",
  "GE-KYKWIN", "GE-KYBLTCLP",
]);
function isExcludedSku(sku) {
  if (!sku) return false;
  if (SERVICE_SKUS.has(sku)) return true;
  const m = /^GE-OID-(\d+)$/.exec(sku);
  if (m) { const n = Number(m[1]); return n >= 1 && n <= 100; }
  return false;
}

// Live order-level lists behind the "Returns This Month"/"Cancelled This
// Month" KPI cards' click-to-drill-down. Unlike fetchOrdersForDate, this uses
// plain Orders GraphQL (not ShopifyQL) — cancelledAt and the refunds array
// are genuine order fields, unaffected by the order-edit invisibility issue
// ShopifyQL was introduced to fix, and Orders GraphQL is what sync.js's own
// "N of M orders" counts are already computed from, so this matches exactly.
//
// Only a single created_at: search clause is used (lower bound) — a second
// created_at: clause for the upper bound previously broke Shopify's search
// parser (colon inside the timestamp value collides with the field:value
// separator, see fetchOrdersForDate's history). The upper bound is filtered
// client-side instead, using Date.getTime() comparisons (not string
// comparison — Shopify's returned offset format isn't guaranteed to match
// the boundary strings we construct, and lexicographic ISO comparison only
// works when both sides use the same offset).
async function fetchMonthOrderSummary(monthKey, env) {
  const shop = env.SHOP_DOMAIN;
  const token = env.SHOP_TOKEN;
  if (!shop || !token) throw new Error("Shopify credentials not configured on this Worker.");
  const ver = env.SHOP_API_VERSION || "2026-01";

  const [y, mo] = monthKey.split("-").map(Number);
  const monthStart = new Date(`${monthKey}-01T00:00:00+08:00`); // MYT midnight, month start
  let nextY = y, nextMo = mo + 1;
  if (nextMo > 12) { nextMo = 1; nextY += 1; }
  const monthEnd = new Date(`${nextY}-${String(nextMo).padStart(2, "0")}-01T00:00:00+08:00`); // exclusive
  const monthStartMs = monthStart.getTime();
  const monthEndMs = monthEnd.getTime();

  // status:any required — Shopify excludes cancelled/closed orders by default.
  const q = `created_at:>=${monthStart.toISOString()} status:any`;
  const query = `query($cursor: String, $q: String) {
    orders(first: 50, after: $cursor, query: $q, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name createdAt cancelledAt
        totalPriceSet { shopMoney { amount } }
        totalRefundedSet { shopMoney { amount } }
        fulfillments(first: 1) { id }
        lineItems(first: 50) { nodes { quantity sku variant { id } } }
      }
    }
  }`;

  const orders = [];
  let cursor = null;
  do {
    const res = await fetch(`https://${shop}/admin/api/${ver}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables: { cursor, q } }),
    });
    if (!res.ok) throw new Error(`Shopify API error ${res.status}: ${await res.text().catch(() => "")}`);
    const body = await res.json();
    if (body.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors)}`);
    const page = body.data?.orders;
    for (const o of page?.nodes || []) {
      const createdMs = new Date(o.createdAt).getTime();
      if (createdMs >= monthStartMs && createdMs < monthEndMs) orders.push(o);
    }
    cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  const myDate = (iso) => new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let grossSales = 0;
  const returns = [], cancelled = [];
  for (const o of orders) {
    grossSales += Number(o.totalPriceSet?.shopMoney?.amount || 0);

    // This store also marks genuine post-delivery returns as "cancelled" in
    // Shopify (not just pre-shipment cancellations), so cancelledAt alone
    // can't separate the two — fulfillment history can, since it's an
    // independent, objective fact a later cancellation can't erase.
    // "Cancelled" = never shipped. "Return" = shipped, then refunded (real
    // money — Shopify also auto-creates a $0 refund record on some
    // cancellations, which the > 0 check excludes).
    const shipped = (o.fulfillments || []).length > 0;
    const refundedAmount = Number(o.totalRefundedSet?.shopMoney?.amount || 0);
    if (shipped && refundedAmount > 0) {
      returns.push({ orderNumber: o.name, value: refundedAmount, date: myDate(o.createdAt) });
    } else if (o.cancelledAt && !shipped) {
      cancelled.push({ orderNumber: o.name, value: Number(o.totalPriceSet?.shopMoney?.amount || 0), date: myDate(o.createdAt) });
    }
  }
  returns.sort((a, b) => b.date.localeCompare(a.date));
  cancelled.sort((a, b) => b.date.localeCompare(a.date));
  const sum = (list) => list.reduce((s, o) => s + o.value, 0);

  // Product cost (COGS) for "Gross Profit This Month" — same definition as
  // sync.js's mtdCost: every line item this month (cancelled orders included,
  // matching the once-a-day figure), excluding service/add-on SKUs. Revenue
  // itself is NOT recomputed here — the frontend already has a live net-sales
  // figure (from the Gearevo dashboard) for "Sales This Month"; this endpoint
  // only supplies the cost side so grossProfit = that live revenue − this cost.
  const lineItems = orders.flatMap((o) => o.lineItems?.nodes || []);
  const variantIds = [...new Set(lineItems.map((li) => li.variant?.id).filter(Boolean))];
  const costByVariant = new Map();
  // Batch by variant id (up to 250 per call, Shopify's node-lookup limit) —
  // only variants that actually sold this month, not the whole catalog.
  for (let i = 0; i < variantIds.length; i += 250) {
    const idsBatch = variantIds.slice(i, i + 250);
    const res = await fetch(`https://${shop}/admin/api/${ver}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({
        query: `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id inventoryItem { unitCost { amount } } } } }`,
        variables: { ids: idsBatch },
      }),
    });
    if (!res.ok) throw new Error(`Shopify API error ${res.status}: ${await res.text().catch(() => "")}`);
    const body = await res.json();
    if (body.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors)}`);
    for (const n of body.data?.nodes || []) {
      if (n?.id) costByVariant.set(n.id, Number(n.inventoryItem?.unitCost?.amount || 0));
    }
  }
  let cost = 0;
  for (const li of lineItems) {
    if (isExcludedSku(li.sku)) continue;
    cost += (costByVariant.get(li.variant?.id) || 0) * Number(li.quantity || 0);
  }

  return {
    orderCount: orders.length,
    grossSales,
    cost,
    returns: { count: returns.length, value: sum(returns), orders: returns },
    cancelled: { count: cancelled.length, value: sum(cancelled), orders: cancelled },
  };
}

async function verifyAuth(idToken) {
  const firestoreResult = await fetchDashboardLatest(idToken);
  return firestoreResult.ok;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const authHeader = request.headers.get("Authorization") || "";
    const idToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!idToken) return jsonResponse({ error: "Missing Authorization header" }, 401);

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const pathname = new URL(request.url).pathname;

    if (pathname === "/orders") {
      const date = (body.date || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ error: "Missing or invalid date" }, 400);
      if (!(await verifyAuth(idToken))) return jsonResponse({ error: "Not authorized." }, 403);
      try {
        const result = await fetchOrdersForDate(date, env);
        return jsonResponse({ date, ...result });
      } catch (e) {
        return jsonResponse({ error: e.message || "Order lookup failed." }, 500);
      }
    }

    if (pathname === "/month-orders") {
      const month = (body.month || "").trim();
      if (!/^\d{4}-\d{2}$/.test(month)) return jsonResponse({ error: "Missing or invalid month" }, 400);
      if (!(await verifyAuth(idToken))) return jsonResponse({ error: "Not authorized." }, 403);
      try {
        const result = await fetchMonthOrderSummary(month, env);
        return jsonResponse({ month, ...result });
      } catch (e) {
        return jsonResponse({ error: e.message || "Order lookup failed." }, 500);
      }
    }

    const question = (body.message || "").trim();
    if (!question) return jsonResponse({ error: "Missing message" }, 400);

    const firestoreResult = await fetchDashboardLatest(idToken);
    if (!firestoreResult.ok) {
      // Mirrors Firestore's own verdict — invalid token or not on the
      // allowlist both surface as 401/403 here, no separate check needed.
      return jsonResponse(
        { error: "Not authorized to read dashboard data." },
        firestoreResult.status === 404 ? 404 : 403
      );
    }

    try {
      const liveToday = await fetchGearevoTodayLive();
      const reply = await askClaude(question, body.history, firestoreResult.data, liveToday, idToken, env.ANTHROPIC_API_KEY, env);
      return jsonResponse({ reply });
    } catch (e) {
      return jsonResponse({ error: e.message || "Chat failed." }, 500);
    }
  },
};
