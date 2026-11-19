import test from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_DEFS, eligibleFor, accountDef, isAccountId, defaultAccountSettings, mergeAccountSettings } from "../dist/domain/accounts.js";

const day = 86_400_000;
const now = Date.parse("2026-11-19T00:00:00Z");
const market = { BTC: { px: 100.1, chg: 0 } };

function ev(days) {
  return {
    id: "e1", title: "BTC ≥ $100,000", cat: "BTC 价格", und: "BTC",
    due: new Date(now + days * day).toISOString(),
    ask: 0.48, bid: 0.47, fair: 0.5, depth: 100_000, conf: 90, delta: 0.2,
    src: "test", source: "demo"
  };
}

test("accounts: exactly two deterministic desks", () => {
  assert.equal(ACCOUNT_DEFS.length, 2);
  assert.deepEqual(ACCOUNT_DEFS.map(a => a.id), ["negrisk", "marketmaking"]);
  const sum = ACCOUNT_DEFS.reduce((s, a) => s + a.defaultEquity, 0);
  assert.ok(Math.abs(sum - 20_000) < 0.005, String(sum));
  assert.equal(accountDef("negrisk").name, "NegRisk 转换");
  assert.equal(accountDef("marketmaking").short, "MM");
  assert.ok(isAccountId("marketmaking"));
  assert.equal(isAccountId("prob"), false);
});

test("accounts: the retired directional scanner never qualifies an event", () => {
  for (const id of ["negrisk", "marketmaking"]) {
    assert.equal(eligibleFor(id, ev(30), market, now), false, id);
    assert.equal(eligibleFor(id, ev(-1), market, now), false, id);
  }
});

test("accounts: persisted books merge onto the two current definitions", () => {
  const seeded = defaultAccountSettings();
  const merged = mergeAccountSettings([
    { id: "negrisk", equity: 12_000, auto: false },
    { id: "prob", equity: 99_999 }
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].equity, 12_000);
  assert.equal(merged[0].auto, false);
  assert.equal(merged[1].equity, seeded[1].equity);
});
