import test from "node:test";
import assert from "node:assert/strict";
import { derive, book } from "../dist/domain/pricing.js";
import { checkOrder, DEFAULT_LIMITS, DEFAULT_RULES, validateLimitValue } from "../dist/domain/risk.js";

const day = 86_400_000;
const now = Date.parse("2026-11-19T00:00:00Z");
const event = {
  id: "e1", title: "BTC ≥ $100,000", cat: "BTC 价格", und: "BTC",
  due: new Date(now + 30 * day).toISOString(), ask: 0.4, bid: 0.39, fair: 0.46,
  depth: 100_000, conf: 90, delta: -0.2, src: "test", source: "demo"
};
const market = { BTC: { px: 64_000, chg: 0 } };
const d = derive(event, { now, market });
const emptyBook = book({ events: [event], positions: [], market, now });
const limits = DEFAULT_LIMITS.map(l => ({ ...l }));
const rules = DEFAULT_RULES.map(r => ({ ...r }));

function check(overrides = {}) {
  return checkOrder({
    event: d, qty: 10_000, book: emptyBook, limits, rules, equity: 1_284_930,
    kill: false, auto: true, source: "manual", dailyLossPct: 0, ...overrides
  });
}

test("risk: a normal order passes", () => {
  const r = check();
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test("risk: kill switch blocks every new order", () => {
  const r = check({ kill: true });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some(f => f.code === "kill_switch"));
});

test("risk: per-venue limit blocks an oversized order", () => {
  const tight = limits.map(l => l.id === "pm" ? { ...l, value: 1000 } : l);
  const r = check({ limits: tight });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some(f => f.code === "limit_pm"));
});

test("risk: settle freeze blocks adds inside 48h", () => {
  const soon = derive({ ...event, due: new Date(now + day).toISOString() }, { now, market });
  const r = check({ event: soon });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some(f => f.code === "settle_freeze"));
});

test("risk: fat edge blocks automatic execution but not an acknowledged manual order", () => {
  const fat = derive({ ...event, ask: 0.5, bid: 0.49, fair: 0.62 }, { now, market });
  const blocked = check({ event: fat, source: "auto" });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.failures.some(f => f.code === "fat_edge"));
  const allowed = check({ event: fat, source: "manual", ackFatEdge: true });
  assert.equal(allowed.ok, true);
});

test("risk: limit cannot be set below current usage + 2%", () => {
  const limit = { id: "pm", name: "PM", desc: "", value: 1000, used: 500, kind: "usd" };
  assert.ok(validateLimitValue(limit, 500, 505));
  assert.equal(validateLimitValue(limit, 500, 600), null);
});

test("risk: bounded-tail blocks short-perp structures with unlimited upside loss", () => {
  const up = derive({ ...event, delta: 0.2 }, { now, market });
  const r = check({ event: up, source: "manual" });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some(f => f.code === "unbounded_tail"));
});
