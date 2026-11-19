import test from "node:test";
import assert from "node:assert/strict";
import { evaluateNegRisk, quoteConversion } from "../dist/domain/negrisk.js";

const outcomes = [
  { name: "A", yesTokenId: "a-y", noTokenId: "a-n", yesBid: 0.40, yesAsk: 0.41, noAsk: 0.60, noBid: 0.39, liquidity: 90_000 },
  { name: "B", yesTokenId: "b-y", noTokenId: "b-n", yesBid: 0.45, yesAsk: 0.46, noAsk: 0.55, noBid: 0.44, liquidity: 80_000 },
  { name: "C", yesTokenId: "c-y", noTokenId: "c-n", yesBid: 0.30, yesAsk: 0.31, noAsk: 0.70, noBid: 0.29, liquidity: 70_000 }
];
const due = () => new Date(Date.now() + 86_400_000 * 30).toISOString();

test("NegRisk: three NOs at 60/55/70 cents produce a locked conversion edge", () => {
  const o = evaluateNegRisk({ id: "e", title: "A/B/C", slug: "abc", negRiskMarketId: "0x", due: due(), outcomes });
  assert.ok(o);
  assert.equal(o.n, 3);
  assert.ok(Math.abs(o.sumYesBid - 1.15) < 1e-9);
  assert.ok(Math.abs(o.basketCost - 1.85) < 1e-9);
  assert.ok(Math.abs(o.conversionProceeds - 2.30) < 1e-9);
  assert.ok(o.profit > 0.4, String(o.profit));
  assert.equal(o.status, "ready");
  assert.ok(o.maxSets >= 10);
});

test("NegRisk: no edge when YES bids sum to exactly 1", () => {
  const flat = outcomes.map((o, i) => {
    const yesBid = i === 0 ? 0.34 : 0.33;
    return { ...o, yesBid, noAsk: 1 - yesBid };
  });
  const o = evaluateNegRisk({ id: "e", title: "A/B/C", slug: "abc", negRiskMarketId: "0x", due: due(), outcomes: flat });
  assert.ok(o);
  assert.ok(Math.abs(o.sumYesBid - 1) < 1e-9);
  assert.ok(o.profit <= 0);
  assert.equal(o.status, "watch");
});

test("NegRisk: fewer than three outcomes is not a conversion basket", () => {
  assert.equal(evaluateNegRisk({ id: "e", title: "A/B", slug: "ab", negRiskMarketId: "0x", due: due(), outcomes: outcomes.slice(0, 2) }), null);
});

test("NegRisk: an expired event cannot be ready", () => {
  const o = evaluateNegRisk({ id: "e", title: "A/B/C", slug: "abc", negRiskMarketId: "0x", due: new Date(Date.now() + 60_000).toISOString(), outcomes });
  assert.ok(o);
  assert.equal(o.status, "watch");
});

test("NegRisk: basket math scales linearly with sets and charges fees", () => {
  const o = evaluateNegRisk({ id: "e", title: "A/B/C", slug: "abc", negRiskMarketId: "0x", due: due(), outcomes });
  assert.ok(o);
  const q = quoteConversion(o, 100);
  assert.ok(Math.abs(q.cost - o.basketCost * 100) < 1e-6);
  assert.ok(Math.abs(q.proceeds - o.conversionProceeds * 100) < 1e-6);
  assert.ok(q.fee > 0);
  assert.ok(Math.abs(q.profit - (q.proceeds - q.cost - q.fee)) < 1e-6);
  assert.equal(q.legs.length, 3);
  assert.equal(q.legs[0].yesShares, 200);
});
