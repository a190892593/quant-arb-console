import test from "node:test";
import assert from "node:assert/strict";
import { checkConversion, defaultRulesFor, mmParamsFromRules, scaledDefaultLimits, validateLimitValue } from "../dist/domain/risk.js";
import { evaluateNegRisk } from "../dist/domain/negrisk.js";

const day = 86_400_000;
const due = () => new Date(Date.now() + 30 * day).toISOString();
const outcomes = [
  { name: "A", yesTokenId: "a", noTokenId: "an", yesBid: 0.40, yesAsk: 0.41, noAsk: 0.60, noBid: 0.39, liquidity: 90_000 },
  { name: "B", yesTokenId: "b", noTokenId: "bn", yesBid: 0.45, yesAsk: 0.46, noAsk: 0.55, noBid: 0.44, liquidity: 80_000 },
  { name: "C", yesTokenId: "c", noTokenId: "cn", yesBid: 0.30, yesAsk: 0.31, noAsk: 0.70, noBid: 0.29, liquidity: 70_000 }
];
const opp = evaluateNegRisk({ id: "e", title: "A/B/C", slug: "abc", negRiskMarketId: "0x", due: due(), outcomes });
const rules = defaultRulesFor("negrisk");
const limits = scaledDefaultLimits("negrisk", 10_000);

function check(overrides = {}) {
  return checkConversion({
    opp, sets: 20, equity: 10_000, conversions: [], limits, rules,
    kill: false, paperEnabled: true, dailyLossPct: 0, ...overrides
  });
}

test("risk: a normal conversion passes every guardrail", () => {
  const r = check();
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test("risk: simulation pause and kill switch block new conversions", () => {
  assert.equal(check({ paperEnabled: false }).ok, false);
  assert.equal(check({ kill: true }).ok, false);
});

test("risk: sets beyond the scanned liquidity are rejected", () => {
  const r = check({ sets: opp.maxSets + 10 });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some(f => f.code === "depth"));
});

test("risk: a per-event cap blocks an oversized basket", () => {
  const tight = limits.map(l => l.id === "market" ? { ...l, value: 10 } : l);
  const r = check({ limits: tight });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some(f => f.code === "limit_market"));
});

test("risk: settlement freeze blocks conversions close to resolution", () => {
  const soon = evaluateNegRisk({ id: "e", title: "A/B/C", slug: "abc", negRiskMarketId: "0x", due: new Date(Date.now() + 3_600_000 * 20).toISOString(), outcomes });
  const r = check({ opp: soon });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some(f => f.code === "opportunity_not_ready" || f.code === "settle_freeze" || f.code === "depth"));
});

test("risk: a negative-edge basket fails the minimum profit rule", () => {
  const flat = evaluateNegRisk({
    id: "e", title: "A/B/C", slug: "abc", negRiskMarketId: "0x", due: due(),
    outcomes: outcomes.map((o, i) => {
      const yesBid = i === 0 ? 0.34 : 0.33;
      return { ...o, yesBid, noAsk: 1 - yesBid };
    })
  });
  const r = check({ opp: flat });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some(f => f.code === "profit_too_small"));
});

test("risk: limits cannot be set below current usage + 2%", () => {
  const limit = { id: "gross", name: "G", desc: "", value: 1_000, used: 500, kind: "usd" };
  assert.ok(validateLimitValue(limit, 500, 505));
  assert.equal(validateLimitValue(limit, 500, 600), null);
});

test("risk: market-making parameters come from the account rules", () => {
  const params = mmParamsFromRules(defaultRulesFor("marketmaking"));
  assert.equal(params.maxMarkets, 8);
  assert.ok(params.targetEdgeBps > 0);
  assert.ok(params.maxInventoryUsd >= 100);
});
