import type { MmParams, MmPosition } from "./types.js";

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

export const DEFAULT_MM_PARAMS: MmParams = {
  targetEdgeBps: 55,
  minSpreadBps: 120,
  quoteNotional: 240,
  maxInventoryUsd: 1_200,
  maxMarkets: 8,
  minLiquidity: 25_000,
  skewStrength: 0.85,
  adverseStopBps: 300,
  flattenPct: 92,
  feeBps: 0
};

export interface MmBookTop {
  bestBid: number;
  bestAsk: number;
  bidSize: number;
  askSize: number;
}

/** Size-weighted mid. Falls back to the plain mid when either side is empty. */
export function microprice(top: MmBookTop): number {
  const { bestBid, bestAsk, bidSize, askSize } = top;
  if (!(bestBid > 0 && bestAsk > bestBid)) return 0;
  const total = bidSize + askSize;
  if (!(total > 0)) return (bestBid + bestAsk) / 2;
  return (bestBid * askSize + bestAsk * bidSize) / total;
}

export interface QuoteInput {
  top: MmBookTop;
  inventory: number;
  params: MmParams;
  paused: boolean;
  inventoryUsd?: number;
}

export interface Quote {
  mid: number;
  fair: number;
  bid: number;
  ask: number;
  size: number;
  notional: number;
  skewBps: number;
  edgeBps: number;
  status: "quoting" | "paused" | "inventory" | "idle" | "halted";
  statusText: string;
}

/**
 * Inventory-aware two-sided quote.
 *
 * Reservation price = mid − inventory/max × targetEdge × skew. The desk earns
 * `targetEdge` on each passive round trip, gives up part of it as inventory grows,
 * and pulls the side that would push inventory through the cap.
 */
export function computeQuote(input: QuoteInput): Quote {
  const { top, params } = input;
  const mid = microprice(top);
  if (!(mid > 0)) {
    return { mid: 0, fair: 0, bid: 0, ask: 0, size: 0, notional: 0, skewBps: 0, edgeBps: 0, status: "idle", statusText: "盘口无有效买卖价" };
  }
  const spread = top.bestBid > 0 ? ((top.bestAsk - top.bestBid) / mid) * 10_000 : 0;
  const inventoryUsd = input.inventoryUsd ?? input.inventory * mid;
  const ratio = clamp(inventoryUsd / Math.max(1, params.maxInventoryUsd), -1, 1);
  const skewBps = -ratio * params.targetEdgeBps * params.skewStrength;
  const shift = mid * skewBps / 10_000;
  const edge = mid * params.targetEdgeBps / 10_000;

  let bid = clamp(mid - edge + shift, 0.01, 0.97);
  let ask = clamp(mid + edge + shift, 0.03, 0.99);
  if (ask - bid < 0.004) ask = Math.min(0.99, bid + 0.004);
  if (ask <= bid) bid = Math.max(0.01, ask - 0.004);

  const size = Math.max(0, params.quoteNotional) / Math.max(mid, 0.01);
  const atCap = Math.abs(inventoryUsd) >= params.maxInventoryUsd * params.flattenPct / 100;
  let status: Quote["status"] = "quoting";
  let statusText = "双边报价";
  if (input.paused) {
    status = "paused"; statusText = "已暂停";
  } else if (atCap) {
    status = "inventory"; statusText = inventoryUsd > 0 ? "库存满 · 只卖不买" : "库存满 · 只买不卖";
  } else if (spread < params.minSpreadBps) {
    status = "idle"; statusText = `盘口价差 ${spread.toFixed(0)}bps 低于 ${params.minSpreadBps}bps`;
  }
  if (status === "paused") { bid = 0; ask = 0; }
  else if (inventoryUsd >= params.maxInventoryUsd * params.flattenPct / 100) bid = 0;
  else if (inventoryUsd <= -params.maxInventoryUsd * params.flattenPct / 100) ask = 0;

  return {
    mid: round(mid, 6),
    fair: round(mid, 6),
    bid: round(bid, 4),
    ask: round(ask, 4),
    size: Math.round(size),
    notional: round(size * mid, 2),
    skewBps: round(skewBps, 1),
    edgeBps: round(params.targetEdgeBps, 1),
    status,
    statusText
  };
}

/** Average-cost inventory accounting for a passive fill. */
export function applyFill(position: MmPosition, side: "buy" | "sell", price: number, size: number, feeBps: number, now = Date.now()): MmPosition {
  const fee = price * size * feeBps / 10_000;
  let inv = position.inventory;
  let avg = position.avg;
  let realized = position.realized;
  let remaining = size;

  if (side === "buy") {
    if (inv < 0) {
      const close = Math.min(remaining, -inv);
      realized += (avg - price) * close;
      inv += close;
      remaining -= close;
      if (Math.abs(inv) < 1e-9) { inv = 0; avg = 0; }
    }
    if (remaining > 0) {
      avg = (avg * inv + price * remaining) / (inv + remaining);
      inv += remaining;
    }
  } else {
    if (inv > 0) {
      const close = Math.min(remaining, inv);
      realized += (price - avg) * close;
      inv -= close;
      remaining -= close;
      if (Math.abs(inv) < 1e-9) { inv = 0; avg = 0; }
    }
    if (remaining > 0) {
      const short = -inv;
      avg = (avg * short + price * remaining) / (short + remaining);
      inv -= remaining;
    }
  }
  realized -= fee;
  return {
    ...position,
    inventory: round(inv, 4),
    avg: round(avg, 6),
    realized: round(realized, 6),
    fees: round(position.fees + fee, 6),
    fills: position.fills + 1,
    lastFillAt: now,
    updatedAt: now
  };
}

export function unrealizedPnl(position: MmPosition, mid: number): number {
  if (!position.inventory) return 0;
  return round(position.inventory * (mid - position.avg), 6);
}

/** Only quote liquid, live, binary markets with enough spread to pay for the risk. */
export function marketEligible(input: {
  bestBid: number; bestAsk: number; liquidity: number; due: string; spreadBps: number;
}, params: MmParams, now = Date.now()): boolean {
  const { bestBid, bestAsk, liquidity, spreadBps } = input;
  if (!(bestBid > 0.02 && bestAsk < 0.98 && bestAsk > bestBid)) return false;
  if (spreadBps < params.minSpreadBps) return false;
  if (liquidity < params.minLiquidity) return false;
  const due = Date.parse(input.due);
  if (!Number.isFinite(due) || due <= now + 86_400_000) return false;
  return true;
}

export interface MmTrade {
  conditionId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  ts: number;
}

/**
 * Deterministic paper fill rule: a resting bid is filled by an aggressive SELL
 * printed at or below it, and a resting ask by an aggressive BUY printed at or
 * above it. Trades older than the quote cannot fill it.
 */
export function matchTrades(
  quote: { bid: number; ask: number; size: number; quoteAt: number },
  trades: MmTrade[],
  maxFills = 4
): Array<{ side: "buy" | "sell"; price: number; size: number; ts: number }> {
  const fills: Array<{ side: "buy" | "sell"; price: number; size: number; ts: number }> = [];
  let bidLeft = quote.bid > 0 ? quote.size : 0;
  let askLeft = quote.ask > 0 ? quote.size : 0;
  for (const t of [...trades].sort((a, b) => a.ts - b.ts)) {
    if (fills.length >= maxFills) break;
    if (t.ts < quote.quoteAt) continue;
    if (t.side === "SELL" && quote.bid > 0 && bidLeft > 0 && t.price <= quote.bid + 1e-9) {
      const size = Math.min(bidLeft, t.size);
      bidLeft -= size;
      fills.push({ side: "buy", price: quote.bid, size, ts: t.ts });
    } else if (t.side === "BUY" && quote.ask > 0 && askLeft > 0 && t.price >= quote.ask - 1e-9) {
      const size = Math.min(askLeft, t.size);
      askLeft -= size;
      fills.push({ side: "sell", price: quote.ask, size, ts: t.ts });
    }
  }
  return fills;
}

export function spreadBps(bestBid: number, bestAsk: number, mid: number): number {
  if (!(mid > 0) || !(bestAsk > bestBid)) return 0;
  return ((bestAsk - bestBid) / mid) * 10_000;
}
