// Does the product backfill actually emit `lost`? Drives the REAL
// bucketOrders() from sync/backfill-products.js with synthetic orders.
//   node scripts/test-backfill-lost.js
import { bucketOrders } from "../sync/backfill-products.js";

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => Number(n) || 0;
const myDateStr = (d) => new Date(new Date(d).getTime() + 8 * 3600e3).toISOString().slice(0, 10);
const isExcluded = () => false;
const getServiceCategory = () => null;

// Copied from sync.js so the test exercises the same shaping the real run does.
function lostForDay(bucket) {
  const rows = (m) => Object.entries(m || {})
    .map(([pid, p]) => ({ pid, title: p.title, units: p.units, revenue: money(p.revenue) }))
    .sort((a, b) => b.revenue - a.revenue);
  const sum = (list, key) => list.reduce((n, x) => n + x[key], 0);
  const cancelled = rows(bucket?.cancelled);
  const returned = rows(bucket?.returned);
  return {
    cancelledOrders: bucket?.cancelledOrders || 0,
    returnOrders: bucket?.returnOrders || 0,
    cancelledUnits: sum(cancelled, "units"), cancelledValue: money(sum(cancelled, "revenue")),
    returnedUnits: sum(returned, "units"), returnedValue: money(sum(returned, "revenue")),
    cancelled, returned,
  };
}
const deps = { myDateStr, num, money, isExcluded, getServiceCategory, lostForDay };

const line = (title, qty, amount) => ({
  quantity: qty, sku: `SKU-${title}`,
  discountedTotalSet: { shopMoney: { amount: String(amount) } },
  product: { id: `gid://p/${title}`, title },
  variant: { id: `gid://v/${title}` },
});
const order = (over) => ({
  createdAt: "2026-08-30T04:00:00Z",       // noon MYT on the 30th
  cancelledAt: null, fulfillments: [],
  totalRefundedSet: { shopMoney: { amount: "0" } },
  lineItems: { nodes: [line("Knife", 1, 500)] },
  ...over,
});

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? (pass++, console.log(`  ok    ${name}`))
     : (fail++, console.log(`  FAIL  ${name}\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`));
};

console.log("\nbucketOrders -> lost");
{
  const { lost, products } = bucketOrders([
    order({}),                                                    // a normal sale
    order({ cancelledAt: "2026-08-30T05:00:00Z",                  // cancelled, never shipped
            lineItems: { nodes: [line("Axe", 2, 700)] } }),
    order({ fulfillments: [{ id: "f1" }],                         // shipped then refunded = RETURN
            cancelledAt: "2026-08-30T06:00:00Z",
            totalRefundedSet: { shopMoney: { amount: "300" } },
            lineItems: { nodes: [line("Saw", 1, 300)] } }),
  ], new Map(), deps);

  const day = lost["2026-08-30"];
  check("a lost bucket exists for the day", !!day, true);
  check("one cancelled order", day?.cancelledOrders, 1);
  check("one returned order", day?.returnOrders, 1);
  check("cancelled value", day?.cancelledValue, 700);
  check("cancelled units", day?.cancelledUnits, 2);
  check("returned value", day?.returnedValue, 300);
  check("cancelled product named", day?.cancelled?.[0]?.title, "Axe");
  check("returned product named", day?.returned?.[0]?.title, "Saw");
  // products stays the GROSS book -- all three orders' line items.
  check("products still counts everything", products["2026-08-30"].length, 3);
}

console.log("\nA day with no cancellations");
{
  const { lost } = bucketOrders([order({})], new Map(), deps);
  check("no bucket is created", Object.keys(lost).length, 0);
  check("but lostForDay(null) still writes zeros", lostForDay(null).cancelledOrders, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
