import test from "node:test";
import assert from "node:assert/strict";
import { derive, book, digitalFair, touchFair, hedgeDelta, DEFAULT_COST } from "../dist/domain/pricing.js";

const day = 86_400_000;
const now = Date.parse("2026-11-19T00:00:00Z");

function event(overrides = {}) {
  return {
    id: "e1", title: "BTC ≥ $100,000", cat: "BTC 价格", und: "BTC",
    due: new Date(now + 30 * day).toISOString(), ask: 0.4, bid: 0.39, fair: 0.46,
    depth: 100_000, conf: 90, delta: 0.2, src: "test", source: "demo",
    ...overrides
  };
}

test("derive: positive edge survives the two-leg cost model", () => {
  const d = derive(event(), { now, market: { BTC: { px: 64_000, chg: 0 } }, cost: DEFAULT_COST });
  assert.ok(d.grossBps > d.costBps);
  assert.ok(d.net > 2.5);
  assert.equal(d.status, "ready");
  assert.equal(d.hedgeUsd, (100_000 / 0.4) * 0.2);
  assert.ok(d.annualized > 0);
});

test("derive: negative gross is clamped to a watch state", () => {
  const d = derive(event({ fair: 0.3 }), { now, market: { BTC: { px: 64_000, chg: 0 } } });
  assert.ok(d.net < 0);
  assert.equal(d.status, "watch");
});

test("derive: fat edge asks for manual review", () => {
  const d = derive(event({ ask: 0.5, bid: 0.49, fair: 0.62 }), { now, market: { BTC: { px: 64_000, chg: 0 } } });
  assert.ok(d.grossBps > 800);
  assert.equal(d.status, "review");
});

test("derive: held event is marked active", () => {
  const d = derive(event(), { now, heldIds: new Set(["e1"]) });
  assert.equal(d.status, "active");
});

test("book: aggregates cost, target and pnl from the same ledger", () => {
  const ctx = {
    now,
    market: { BTC: { px: 64_000, chg: 0 }, ETH: { px: 1_800, chg: 0 } },
    events: [
      event(),
      event({ id: "e2", und: "ETH", ask: 0.2, bid: 0.19, fair: 0.24, delta: -0.1 })
    ],
    positions: [
      { evId: "e1", qty: 100_000, avg: 0.38, hedgeUsd: 20_000, hedgeEntry: 66_000 },
      { evId: "e2", qty: 50_000, avg: 0.18, hedgeUsd: 5_000, hedgeEntry: 1_700 }
    ]
  };
  const b = book(ctx);
  assert.equal(b.rows.length, 2);
  assert.ok(b.cost > 0);
  assert.ok(b.pnl > 0);
  assert.equal(b.netDelta, Math.max(0, b.target - b.hedge));
  assert.ok(b.byUnd.BTC.face > 0 && b.byUnd.ETH.face > 0);
});

test("digitalFair: ATM digital is near 50% and reverses for the other side", () => {
  const up = digitalFair({ spot: 100, strike: 100, vol: 0.6, days: 30, direction: 1 });
  const down = digitalFair({ spot: 100, strike: 100, vol: 0.6, days: 30, direction: -1 });
  assert.ok(up > 0.4 && up < 0.55, String(up));
  assert.ok(Math.abs(up + down - 1) < 1e-9);
});

test("touchFair prices a reach market above the terminal digital price", () => {
  const args = { spot: 63_000, strike: 70_000, vol: 0.55, days: 11 };
  const touch = touchFair(args);
  const digital = digitalFair({ ...args, direction: 1 });
  assert.ok(touch > digital, `${touch} vs ${digital}`);
  assert.ok(touch > 0.25 && touch < 0.45, String(touch));
});

test("hedgeDelta keeps the direction sign and stays within the sizing band", () => {
  const up = hedgeDelta({ spot: 100, strike: 105, vol: 0.6, days: 30, direction: 1 });
  const down = hedgeDelta({ spot: 100, strike: 105, vol: 0.6, days: 30, direction: -1 });
  assert.ok(up > 0 && down < 0);
  assert.ok(Math.abs(up) >= 0.005 && Math.abs(up) <= 0.6);
});
