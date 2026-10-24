import test from "node:test";
import assert from "node:assert/strict";
import { loadHistoricalBaselines } from "./historicalBaselines.js";

function mockDb({ eventDays, revenueDays }) {
  let call = 0;
  const queries = [];
  return {
    async query(sql) {
      queries.push(sql);
      call += 1;
      return { rows: call === 1 ? eventDays : revenueDays };
    },
    get callCount() { return call; },
    get queries() { return queries; },
  };
}

const eventDay = (local_date, page_view_sessions, overrides = {}) => ({
  local_date,
  page_view_sessions,
  product_view_sessions: page_view_sessions,
  add_to_cart_sessions: Math.floor(page_view_sessions * 0.4),
  checkout_sessions: Math.floor(page_view_sessions * 0.2),
  purchase_sessions: Math.floor(page_view_sessions * 0.1),
  purchase_event_sessions: Math.floor(page_view_sessions * 0.1),
  ...overrides,
});

const revenueDay = (local_date, revenue, purchased_sessions = 1) => ({
  local_date, revenue, purchased_sessions,
});

const input = {
  siteId: "site-test",
  timeZone: "Africa/Lagos",
  baselineStartUTC: new Date("2026-10-17T23:00:00.000Z"),
  startUTC: new Date("2026-10-24T23:00:00.000Z"),
  endUTC: new Date("2026-10-25T23:00:00.000Z"),
  localDate: "2026-10-24",
  localTime: "12:00:00",
};

test("baseline queries are tenant-scoped and require two read-only queries", async () => {
  const db = mockDb({ eventDays: [], revenueDays: [] });
  const result = await loadHistoricalBaselines({ db, ...input });
  assert.equal(db.callCount, 2);
  assert.match(db.queries[1], /JOIN purchase_sessions ps/i);
  assert.match(db.queries[1], /ps\.session_id = ss\.session_id/i);
  assert.equal(result.revenueBaseline.status, "purchase_tracking_unconfirmed");
  assert.equal(result.funnelBaseline.status, "insufficient_history");
});

test("funnel baseline requires five prior days with recorded page-view sessions", async () => {
  const eventDays = [
    ...Array.from({ length: 5 }, (_, i) =>
      eventDay(`2026-10-${String(19 + i).padStart(2, "0")}`, 20)
    ),
    eventDay("2026-10-24", 20, {
      product_view_sessions: 2,
      add_to_cart_sessions: 1,
      checkout_sessions: 1,
      purchase_sessions: 1,
      purchase_event_sessions: 1,
    }),
  ];
  const revenueDays = [
    ...Array.from({ length: 5 }, (_, i) =>
      revenueDay(`2026-10-${String(19 + i).padStart(2, "0")}`, 1000)
    ),
    revenueDay("2026-10-24", 100),
  ];
  const result = await loadHistoricalBaselines({
    db: mockDb({ eventDays, revenueDays }), ...input,
  });
  assert.equal(result.funnelBaseline.daysWithTraffic, 5);
  assert.equal(result.funnelBaseline.status, "below_baseline");
  assert.ok(result.funnelBaseline.lowStages.includes("productView"));
  assert.equal(result.revenueBaseline.status, "below_baseline");
  assert.equal(result.revenueBaseline.averageRevenue, 1000);
});

test("does not treat missing purchase events as zero revenue or a confirmed decline", async () => {
  const eventDays = [
    ...Array.from({ length: 5 }, (_, i) =>
      eventDay(`2026-10-${String(19 + i).padStart(2, "0")}`, 20)
    ),
    eventDay("2026-10-24", 20, {
      purchase_event_sessions: 0,
      purchase_sessions: 0,
    }),
  ];
  const revenueDays = [
    ...Array.from({ length: 5 }, (_, i) =>
      revenueDay(`2026-10-${String(19 + i).padStart(2, "0")}`, 1000)
    ),
  ];
  const result = await loadHistoricalBaselines({
    db: mockDb({ eventDays, revenueDays }), ...input,
  });
  assert.equal(result.revenueBaseline.status, "purchase_tracking_unconfirmed");
  assert.equal(result.revenueBaseline.currentRevenue, null);
});

test("does not classify zero stage counts as confirmed funnel declines", async () => {
  const eventDays = [
    ...Array.from({ length: 5 }, (_, i) =>
      eventDay(`2026-10-${String(19 + i).padStart(2, "0")}`, 20)
    ),
    eventDay("2026-10-24", 20, {
      product_view_sessions: 0,
      add_to_cart_sessions: 0,
      checkout_sessions: 0,
      purchase_sessions: 0,
      purchase_event_sessions: 0,
    }),
  ];
  const result = await loadHistoricalBaselines({
    db: mockDb({ eventDays, revenueDays: [] }), ...input,
  });
  assert.equal(result.funnelBaseline.status, "available");
  assert.deepEqual(result.funnelBaseline.lowStages, []);
});


test("funnel rates use the immediately preceding stage as the denominator", async () => {
  const historical = Array.from({ length: 5 }, (_, i) => eventDay(
    \`2026-10-\${String(19 + i).padStart(2, "0")}\`,
    20,
    {
      product_view_sessions: 10,
      add_to_cart_sessions: 5,
      checkout_sessions: 2,
      purchase_sessions: 1,
      purchase_event_sessions: 1,
    }
  ));
  const current = eventDay("2026-10-24", 20, {
    product_view_sessions: 10,
    add_to_cart_sessions: 5,
    checkout_sessions: 2,
    purchase_sessions: 1,
    purchase_event_sessions: 1,
  });
  const result = await loadHistoricalBaselines({
    db: mockDb({
      eventDays: [...historical, current],
      revenueDays: [],
    }),
    ...input,
  });
  assert.equal(result.funnelBaseline.current.rates.productView, 0.5);
  assert.equal(result.funnelBaseline.current.rates.addToCart, 0.5);
  assert.equal(result.funnelBaseline.current.rates.checkout, 0.4);
  assert.equal(result.funnelBaseline.current.rates.purchase, 0.5);
  assert.equal(result.funnelBaseline.averages.productView, 0.5);
  assert.equal(result.funnelBaseline.averages.addToCart, 0.5);
  assert.equal(result.funnelBaseline.averages.checkout, 0.4);
  assert.equal(result.funnelBaseline.averages.purchase, 0.5);
});

test("historical zero stage rates are included when the preceding stage has traffic", async () => {
  const historical = Array.from({ length: 5 }, (_, i) => eventDay(
    \`2026-10-\${String(19 + i).padStart(2, "0")}\`,
    20,
    i === 0
      ? {
          product_view_sessions: 0,
          add_to_cart_sessions: 0,
          checkout_sessions: 0,
          purchase_sessions: 0,
          purchase_event_sessions: 0,
        }
      : {
          product_view_sessions: 20,
          add_to_cart_sessions: 8,
          checkout_sessions: 4,
          purchase_sessions: 2,
          purchase_event_sessions: 2,
        }
  ));
  const current = eventDay("2026-10-24", 20, {
    product_view_sessions: 20,
    add_to_cart_sessions: 8,
    checkout_sessions: 4,
    purchase_sessions: 2,
    purchase_event_sessions: 2,
  });
  const result = await loadHistoricalBaselines({
    db: mockDb({
      eventDays: [...historical, current],
      revenueDays: [],
    }),
    ...input,
  });
  assert.equal(result.funnelBaseline.averages.productView, 0.8);
  assert.equal(result.funnelBaseline.daysByStage.productView, 5);
});
