import type { Book, CostConfig, DerivedEvent, EventContract, Market, Position, PositionView, AccountId } from "./types.js";
import { accountDef, CONVERGE_MIN_FAIR, LATENCY_MIN_AGE_MS } from "./accounts.js";

export const DEFAULT_COST: CostConfig = {
  hlFeeBps: 4.5,
  hedgeSlipBps: 6,
  resolutionBps: 8,
  fundingBpsDay: 0.45,
  fundingCapBps: 24
};

export const MIN_EDGE_CENTS = 2.5;
export const DAY_MS = 86_400_000;

export interface DeriveContext {
  now?: number;
  market?: Market;
  cost?: Partial<CostConfig>;
  minEdge?: number;
  positions?: Position[];
  heldIds?: Set<string>;
  strategy?: AccountId;
  quoteAgeMs?: number;
}

export function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v));
}

export function costConfig(cost?: Partial<CostConfig>): CostConfig {
  return { ...DEFAULT_COST, ...(cost ?? {}) };
}

export function eventMap(events: EventContract[]): Map<string, EventContract> {
  return new Map(events.map(e => [e.id, e]));
}

export function derive(ev: EventContract, ctx: DeriveContext = {}): DerivedEvent {
  const nowMs = ctx.now ?? Date.now();
  const market = ctx.market ?? {};
  const cost = costConfig(ctx.cost);
  const strategy = ctx.strategy ?? "prob";
  const minEdge = ctx.minEdge ?? MIN_EDGE_CENTS;
  const quoteAgeMs = Math.max(0, ctx.quoteAgeMs ?? ev.quoteAgeMs ?? 0);
  const dueMs = Date.parse(ev.due);
  const days = Math.max(0.25, (dueMs - nowMs) / DAY_MS);
  const mid = (ev.ask + ev.bid) / 2;
  const gross = (ev.fair - mid) * 100;
  const halfSpread = Math.max(0, (ev.ask - ev.bid) / 2);
  const spreadBps = halfSpread * 10_000;
  const hedgeRatio = Math.abs(ev.delta);
  const feeBps = cost.hlFeeBps * hedgeRatio;
  const slipBps = cost.hedgeSlipBps * hedgeRatio;
  const fundingBps = strategy === "latency"
    ? 0
    : Math.min(cost.fundingCapBps, cost.fundingBpsDay * days) * hedgeRatio;
  const resBps = cost.resolutionBps;
  const costBps = spreadBps + feeBps + slipBps + fundingBps + resBps;
  const grossBps = gross * 100;
  const netBps = grossBps - costBps;
  const net = netBps / 100;
  const hedgeUsd = (ev.depth / Math.max(0.01, ev.ask)) * Math.abs(ev.delta);
  const holdReturn = net > 0 ? (net / 100) / ev.ask : 0;
  const annualized = holdReturn > 0 ? holdReturn * (365 / days) * 100 : 0;
  const spot = market[ev.und]?.px ?? 0;
  const lagPct = ev.quoteRefPx && spot ? (spot / ev.quoteRefPx - 1) * 100 : 0;

  let status: DerivedEvent["status"] = "ready";
  let statusText = "可执行";
  if (grossBps > 800) {
    status = "review";
    statusText = "待复核";
  } else if (strategy === "converge" && ev.fair < CONVERGE_MIN_FAIR) {
    status = "watch";
    statusText = "未进入收敛区";
  } else if (strategy === "latency" && quoteAgeMs < LATENCY_MIN_AGE_MS) {
    status = "watch";
    statusText = "报价已追平";
  } else if (strategy === "longvol" && days <= 60) {
    status = "watch";
    statusText = "不在长端区间";
  } else if (days < 1.2 && strategy === "prob") {
    status = "watch";
    statusText = "临近结算";
  } else if (net < minEdge || ev.conf < 62 || ev.depth < 15_000) {
    status = "watch";
    statusText = "观察";
  }

  const held = ctx.heldIds
    ? ctx.heldIds.has(ev.id)
    : (ctx.positions ?? []).some(p => p.evId === ev.id);
  if (held) {
    status = "active";
    statusText = "执行中";
  }

  return {
    ...ev,
    strategy,
    strategyName: accountDef(strategy).name,
    quoteAgeMs,
    lagPct,
    days,
    mid,
    gross,
    grossBps,
    costBps,
    netBps,
    net,
    hedgeUsd,
    holdReturn,
    annualized,
    status,
    statusText,
    spreadBps,
    feeBps,
    slipBps,
    fundingBps,
    resBps,
    edgeWidth: Math.max(4, Math.min(100, netBps / 6)),
    markPx: market[ev.und]?.px ?? null
  };
}

export interface BookContext extends DeriveContext {
  events: EventContract[];
  positions: Position[];
  eventMap?: Map<string, EventContract>;
}

export function deriveAll(events: EventContract[], ctx: DeriveContext = {}): DerivedEvent[] {
  const heldIds = new Set((ctx.positions ?? []).map(p => p.evId));
  return events.map(e => derive(e, { ...ctx, heldIds }));
}

export function positionView(p: Position, ctx: BookContext): PositionView | null {
  const map = ctx.eventMap ?? eventMap(ctx.events);
  const ev = map.get(p.evId);
  if (!ev) return null;
  const d = derive(ev, ctx);
  const mk = ctx.market?.[ev.und] ?? { px: 0, chg: 0 };
  const contractPnl = p.qty * (ev.bid - p.avg);
  const hedgePnl = p.hedgeEntry > 0 ? p.hedgeUsd * (p.hedgeEntry - mk.px) / p.hedgeEntry : 0;
  const target = p.qty * Math.abs(ev.delta);
  const ratio = target > 0 ? p.hedgeUsd / target : 1;
  const cost = p.qty * p.avg;
  const deltaUsd = target - p.hedgeUsd;
  return {
    ...p,
    ev,
    d,
    mark: ev.bid,
    cost,
    target,
    ratio,
    contractPnl,
    hedgePnl,
    pnl: contractPnl + hedgePnl,
    deltaUsd,
    mk
  };
}

export function book(ctx: BookContext): Book {
  const map = ctx.eventMap ?? eventMap(ctx.events);
  const rows = ctx.positions
    .map(p => positionView(p, { ...ctx, eventMap: map }))
    .filter((r): r is PositionView => r !== null);
  const face = rows.reduce((s, r) => s + r.qty, 0);
  const cost = rows.reduce((s, r) => s + r.cost, 0);
  const hedge = rows.reduce((s, r) => s + r.hedgeUsd, 0);
  const target = rows.reduce((s, r) => s + r.target, 0);
  const pnl = rows.reduce((s, r) => s + r.pnl, 0);
  const margin = hedge / 4.8;
  const settle7 = rows.filter(r => Math.round(r.d.days) <= 7).reduce((s, r) => s + r.cost, 0);
  const maxCost = rows.reduce((m, r) => Math.max(m, r.cost), 0);
  const byUnd: Book["byUnd"] = {};
  for (const r of rows) {
    const key = r.ev.und;
    const item = byUnd[key] ?? { face: 0, cost: 0, pnl: 0 };
    item.face += r.qty;
    item.cost += r.cost;
    item.pnl += r.pnl;
    byUnd[key] = item;
  }
  const unhedged = rows.filter(r => r.ratio < 0.9).length;
  return {
    rows,
    face,
    cost,
    hedge,
    target,
    pnl,
    margin,
    settle7,
    maxCost,
    byUnd,
    netDelta: Math.max(0, target - hedge),
    unhedged,
    undehedged: unhedged,
    nowMs: ctx.now ?? Date.now()
  };
}

export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export function normalPdf(x: number): number {
  return 0.3989422804014327 * Math.exp(-x * x / 2);
}

/** Acklam's inverse normal CDF, accurate to ~1e-9. */
export function normalInv(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -8 : 8;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

export function digitalFair(input: { spot: number; strike: number; vol: number; days: number; direction: 1 | -1 }): number | null {
  const { spot, strike, vol, days, direction } = input;
  if (!(spot > 0) || !(strike > 0)) return null;
  const T = Math.max(1 / 365, days / 365);
  const sigma = Math.max(0.01, vol);
  const d2 = (Math.log(spot / strike) - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  const call = clamp(normalCdf(d2), 0.001, 0.999);
  return direction < 0 ? 1 - call : call;
}

/**
 * Probability that the spot ever touches the strike before expiry (continuous
 * monitoring, zero drift). Polymarket's "reach / hit" markets are touch options,
 * not terminal digital options; using the digital price systematically underprices them.
 */
export function touchFair(input: { spot: number; strike: number; vol: number; days: number }): number | null {
  const { spot, strike, vol, days } = input;
  if (!(spot > 0) || !(strike > 0)) return null;
  const T = Math.max(1 / 365, days / 365);
  const sigma = Math.max(0.01, vol);
  const distance = Math.abs(Math.log(strike / spot)) / (sigma * Math.sqrt(T));
  return clamp(2 * normalCdf(-distance), 0.001, 0.999);
}

/** Normalised hedge ratio used for perp sizing (0.5%–60% of contract face). */
export function hedgeDelta(input: { spot: number; strike: number; vol: number; days: number; direction: 1 | -1 }): number {
  const { spot, strike, vol, days, direction } = input;
  if (!(spot > 0) || !(strike > 0)) return 0;
  const T = Math.max(1 / 365, days / 365);
  const sigma = Math.max(0.01, vol);
  const d2 = (Math.log(spot / strike) - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  const raw = 0.42 * normalPdf(d2) / 0.3989422804014327 * Math.sqrt(Math.min(1, T * 4));
  return clamp(raw, 0.005, 0.6) * (direction < 0 ? -1 : 1);
}
