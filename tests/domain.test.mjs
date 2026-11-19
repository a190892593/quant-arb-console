import test from "node:test";
import assert from "node:assert/strict";
import { digitalFair, touchFair, hedgeDelta } from "../dist/domain/pricing.js";
import { microprice, computeQuote, applyFill, matchTrades, DEFAULT_MM_PARAMS } from "../dist/domain/mm.js";

const day = 86_400_000;
void day;

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

test("hedgeDelta returns a positive up-delta and mirrors it for the down side", () => {
  const up = hedgeDelta({ spot: 100, strike: 105, vol: 0.6, days: 30, direction: 1 });
  const down = hedgeDelta({ spot: 100, strike: 105, vol: 0.6, days: 30, direction: -1 });
  assert.ok(up > 0 && down < 0);
  assert.ok(up > 0.5 && up <= 10, String(up));
  assert.ok(Math.abs(up + down) < 1e-9);
});

const top = { bestBid: 0.48, bestAsk: 0.5, bidSize: 900, askSize: 100 };

test("microprice leans toward the thicker side", () => {
  const mid = microprice(top);
  assert.ok(mid > 0.49 && mid < 0.5, String(mid));
});

test("market-making quote stays inside the book and earns the target edge", () => {
  const q = computeQuote({ top, inventory: 0, params: DEFAULT_MM_PARAMS, paused: false });
  assert.equal(q.status, "quoting");
  assert.ok(q.bid > top.bestBid && q.ask < top.bestAsk + 0.001, `${q.bid}/${q.ask}`);
  assert.ok(q.ask > q.bid);
  assert.ok(q.size > 0);
});

test("inventory skew shifts both quotes against the position", () => {
  const flat = computeQuote({ top, inventory: 0, params: DEFAULT_MM_PARAMS, paused: false });
  const long = computeQuote({ top, inventory: 2_000, params: DEFAULT_MM_PARAMS, paused: false });
  assert.ok(long.skewBps < 0);
  assert.ok(long.bid < flat.bid && long.ask < flat.ask);
  assert.ok(long.status === "inventory" || long.bid === 0 || long.bid < flat.bid);
});

test("two-sided fills realize spread on a round trip", () => {
  const pos = { marketId: "m", title: "t", inventory: 0, avg: 0, realized: 0, fees: 0, fills: 0, paused: false, lastFillAt: null, updatedAt: 0 };
  const bought = applyFill(pos, "buy", 0.48, 100, 0, 1);
  assert.equal(bought.inventory, 100);
  assert.ok(Math.abs(bought.avg - 0.48) < 1e-9);
  const sold = applyFill(bought, "sell", 0.5, 100, 0, 2);
  assert.equal(sold.inventory, 0);
  assert.ok(Math.abs(sold.realized - 2) < 1e-6, String(sold.realized));
});

test("a trade must print through the resting quote to fill it", () => {
  const quote = { bid: 0.48, ask: 0.5, size: 100, quoteAt: 1_000 };
  const fills = matchTrades(quote, [
    { conditionId: "c", side: "SELL", price: 0.49, size: 50, ts: 1_100 },
    { conditionId: "c", side: "SELL", price: 0.48, size: 30, ts: 1_200 },
    { conditionId: "c", side: "BUY", price: 0.5, size: 40, ts: 900 }
  ]);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].side, "buy");
  assert.equal(fills[0].size, 30);
});
