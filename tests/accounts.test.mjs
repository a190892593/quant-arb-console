import test from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_DEFS, eligibleFor, accountDef, LATENCY_MAX_DAYS } from "../dist/domain/accounts.js";

const day = 86_400_000;
const now = Date.parse("2026-11-19T00:00:00Z");
const market = { BTC: { px: 100.1, chg: 0 }, ETH: { px: 2_000, chg: 0 } };

function ev(days, overrides = {}) {
  return {
    id: "e1", title: "BTC ≥ $100,000", cat: "BTC 价格", und: "BTC",
    due: new Date(now + days * day).toISOString(),
    ask: 0.48, bid: 0.47, fair: 0.5, depth: 100_000, conf: 90, delta: 0.2,
    src: "test", source: "demo",
    ...overrides
  };
}

test("accounts: exactly four defs and equities sum to the desk total", () => {
  assert.equal(ACCOUNT_DEFS.length, 4);
  assert.deepEqual(ACCOUNT_DEFS.map(a => a.id), ["prob", "converge", "latency", "longvol"]);
  const sum = ACCOUNT_DEFS.reduce((s, a) => s + a.defaultEquity, 0);
  assert.ok(Math.abs(sum - 1_284_930.22) < 0.005, String(sum));
  assert.equal(accountDef("latency").name, "报价滞后");
});

test("eligibility: probability desk only trades 1.2–60 days", () => {
  assert.equal(eligibleFor("prob", ev(30), market, now), true);
  assert.equal(eligibleFor("prob", ev(1), market, now), false);
  assert.equal(eligibleFor("prob", ev(90), market, now), false);
});

test("eligibility: convergence desk needs ≤3 days and high fair", () => {
  assert.equal(eligibleFor("converge", ev(2, { fair: 0.9 }), market, now), true);
  assert.equal(eligibleFor("converge", ev(5, { fair: 0.9 }), market, now), false);
  assert.equal(eligibleFor("converge", ev(2, { fair: 0.5 }), market, now), false);
  assert.equal(eligibleFor("converge", ev(2, { fair: 0.999 }), market, now), false);
});

test("eligibility: latency desk needs stale quote, edge and a price move", () => {
  const stale = { quoteAgeMs: 7_000, quoteRefPx: 100 };
  assert.equal(eligibleFor("latency", ev(5, stale), market, now), true);
  assert.equal(eligibleFor("latency", ev(5, { ...stale, quoteAgeMs: 1_000 }), market, now), false);
  assert.equal(eligibleFor("latency", ev(LATENCY_MAX_DAYS + 1, stale), market, now), false);
  assert.equal(eligibleFor("latency", ev(5, { ...stale, quoteRefPx: 100.1, fair: 0.49 }), market, now), false);
  assert.equal(eligibleFor("latency", ev(5, { ...stale, fair: 0.485 }), market, now), false);
});

test("eligibility: long-vol desk only trades beyond 60 days", () => {
  assert.equal(eligibleFor("longvol", ev(90), market, now), true);
  assert.equal(eligibleFor("longvol", ev(61), market, now), true);
  assert.equal(eligibleFor("longvol", ev(30), market, now), false);
});

test("eligibility: an expired contract is never eligible", () => {
  for (const id of ["prob", "converge", "latency", "longvol"]) {
    assert.equal(eligibleFor(id, ev(-1), market, now), false, id);
  }
});
