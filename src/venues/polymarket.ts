import { config } from "../config.js";
import type { NegRiskOpportunity, VenueStatus } from "../domain/types.js";

const TIMEOUT = 15_000;

interface GammaMarket {
  id?: string;
  question?: string;
  groupItemTitle?: string;
  conditionId?: string;
  slug?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  outcomes?: string;
  clobTokenIds?: string;
  bestBid?: number;
  bestAsk?: number;
  liquidity?: number | string;
  liquidityNum?: number;
  volume?: number | string;
  volumeNum?: number;
  volume24hr?: number;
  tags?: Array<{ label?: string; slug?: string }>;
}

interface GammaEvent {
  id?: string;
  title?: string;
  slug?: string;
  endDate?: string;
  negRisk?: boolean;
  negRiskMarketID?: string;
  volume24hr?: number;
  tags?: Array<{ label?: string; slug?: string }>;
  markets?: GammaMarket[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "user-agent": "convergence-terminal/3.0", accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT)
  });
  if (!res.ok) throw new Error(`Polymarket HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function health(): Promise<VenueStatus> {
  const started = Date.now();
  try {
    await getJson(`${config.pm.gammaUrl}/markets?limit=1&active=true&closed=false`);
    return {
      id: "polymarket", label: "Polymarket CLOB", state: "ok",
      latencyMs: Date.now() - started, message: "Gamma / CLOB 连接正常",
      lastOkAt: Date.now(), mode: "live"
    };
  } catch (err) {
    return {
      id: "polymarket", label: "Polymarket CLOB", state: config.pm.enabled ? "degraded" : "disabled",
      latencyMs: null, message: (err as Error).message, lastOkAt: null, mode: "demo"
    };
  }
}

function parseJsonArray(text: string | undefined): string[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

function yesIndex(m: GammaMarket): number {
  const outcomes = parseJsonArray(m.outcomes);
  const i = outcomes.findIndex(o => /^yes$/i.test(o.trim()));
  return i >= 0 ? i : 0;
}

/* ============================================================
   Desk 1 · NegRisk basket scan
   ============================================================ */

/**
 * Live NegRisk events. Each outcome is a binary YES/NO market; the
 * multi-outcome structure lives at the event level. Both actionable and
 * merely observed baskets are returned so the desk can explain idle states.
 */
export async function fetchNegRiskOpportunities(): Promise<NegRiskOpportunity[]> {
  if (!config.pm.enabled) return [];
  const url = config.pm.gammaUrl + "/events?closed=false&active=true&limit=100&order=volume24hr&ascending=false";
  const raw = await getJson<GammaEvent[]>(url);
  const { evaluateNegRisk } = await import("../domain/negrisk.js");
  const out: NegRiskOpportunity[] = [];
  const now = Date.now();
  for (const ev of raw) {
    if (!ev.negRisk || !ev.markets || ev.markets.length < 3) continue;
    const dueMs = Date.parse(ev.endDate ?? "");
    if (!Number.isFinite(dueMs) || dueMs <= now + 3600_000) continue;
    const outcomes = ev.markets
      .filter(m => m.active !== false && m.closed !== true && m.archived !== true)
      .map(m => {
        const tokens = parseJsonArray(m.clobTokenIds);
        const yi = yesIndex(m);
        const yesBid = Number(m.bestBid);
        const yesAsk = Number(m.bestAsk);
        return {
          name: (m.groupItemTitle || m.question || m.slug || "outcome").trim(),
          yesTokenId: tokens[yi] ?? "",
          noTokenId: tokens[yi === 0 ? 1 : 0] ?? "",
          yesBid,
          yesAsk,
          noAsk: 1 - yesBid,
          noBid: 1 - yesAsk,
          liquidity: Math.max(Number(m.liquidityNum ?? m.liquidity ?? 0), 0)
        };
      })
      .filter(o => Number.isFinite(o.yesBid) && o.yesBid > 0.001 && o.yesBid < 0.999);
    if (outcomes.length < 3) continue;
    const opp = evaluateNegRisk({
      id: ev.id ?? ev.slug ?? "negrisk",
      title: ev.title ?? "NegRisk event",
      slug: ev.slug ?? "",
      negRiskMarketId: ev.negRiskMarketID ?? "",
      due: new Date(dueMs).toISOString(),
      outcomes
    });
    if (opp) out.push(opp);
  }
  out.sort((a, b) => b.edgeBps - a.edgeBps);
  return out.slice(0, 40);
}

/* ============================================================
   Desk 2 · Market-making universe + live book/trade tape
   ============================================================ */

export interface PmMmMarket {
  id: string;
  conditionId: string;
  title: string;
  slug: string;
  category: string;
  due: string;
  yesTokenId: string;
  noTokenId: string;
  bestBid: number;
  bestAsk: number;
  liquidity: number;
  volume24h: number;
}

export interface PmBookTop {
  bestBid: number;
  bestAsk: number;
  bidSize: number;
  askSize: number;
  depthUsd: number;
}

export interface PmTrade {
  conditionId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  ts: number;
}

/**
 * High-liquidity binary universe: top events by 24h volume, flattened to
 * two-outcome markets with a live two-sided quote and meaningful depth.
 */
export async function fetchMmUniverse(limit = 60): Promise<PmMmMarket[]> {
  if (!config.pm.enabled) return [];
  const url = config.pm.gammaUrl + "/events?active=true&closed=false&limit=80&order=volume24hr&ascending=false";
  const raw = await getJson<GammaEvent[]>(url);
  const now = Date.now();
  const seen = new Set<string>();
  const out: PmMmMarket[] = [];
  for (const ev of raw) {
    for (const m of ev.markets ?? []) {
      if (!m.question || m.closed || m.archived || m.active === false) continue;
      const conditionId = m.conditionId ?? "";
      if (!conditionId || seen.has(conditionId)) continue;
      const outcomes = parseJsonArray(m.outcomes);
      if (outcomes.length !== 2) continue;
      const yi = outcomes.findIndex(o => /^yes$/i.test(o.trim()));
      if (yi < 0) continue;
      const tokens = parseJsonArray(m.clobTokenIds);
      if (tokens.length < 2) continue;
      const bid = Number(m.bestBid);
      const ask = Number(m.bestAsk);
      if (!(bid > 0.02 && ask < 0.98 && ask > bid)) continue;
      const dueMs = Date.parse(m.endDate ?? "");
      if (!Number.isFinite(dueMs) || dueMs <= now + 86_400_000) continue;
      const liquidity = Math.max(Number(m.liquidityNum ?? m.liquidity ?? 0), 0);
      const volume24h = Math.max(Number(m.volume24hr ?? 0), 0);
      if (liquidity < 5_000) continue;
      seen.add(conditionId);
      out.push({
        id: "mm-" + conditionId,
        conditionId,
        title: m.question.trim(),
        slug: m.slug ?? "",
        category: ev.tags?.[0]?.label ?? "事件",
        due: new Date(dueMs).toISOString(),
        yesTokenId: tokens[yi] ?? "",
        noTokenId: tokens[yi === 0 ? 1 : 0] ?? "",
        bestBid: bid,
        bestAsk: ask,
        liquidity: Math.round(liquidity),
        volume24h: Math.round(volume24h)
      });
    }
  }
  out.sort((a, b) => b.volume24h - a.volume24h || b.liquidity - a.liquidity);
  return out.slice(0, limit);
}

/** Batch best bid/ask + top-of-book depth for YES tokens. */
export async function fetchMmBooks(tokenIds: string[]): Promise<Record<string, PmBookTop>> {
  const out: Record<string, PmBookTop> = {};
  if (!config.pm.enabled || !tokenIds.length) return out;
  const res = await fetch(config.pm.clobUrl + "/books", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(tokenIds.map(id => ({ token_id: id }))),
    signal: AbortSignal.timeout(TIMEOUT)
  });
  if (!res.ok) throw new Error(`CLOB /books HTTP ${res.status}`);
  const raw = (await res.json()) as unknown;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const item of list) {
    const book = item as {
      asset_id?: string;
      bids?: Array<{ price?: string; size?: string }>;
      asks?: Array<{ price?: string; size?: string }>;
    };
    const tokenId = book.asset_id ?? "";
    if (!tokenId) continue;
    const bids = (book.bids ?? []).map(l => ({ px: Number(l.price), sz: Number(l.size) }))
      .filter(l => l.px > 0 && l.sz > 0).sort((a, b) => b.px - a.px);
    const asks = (book.asks ?? []).map(l => ({ px: Number(l.price), sz: Number(l.size) }))
      .filter(l => l.px > 0 && l.sz > 0).sort((a, b) => a.px - b.px);
    if (!bids.length || !asks.length) continue;
    const depthUsd = [...bids.slice(0, 12), ...asks.slice(0, 12)].reduce((s, l) => s + l.px * l.sz, 0);
    out[tokenId] = {
      bestBid: bids[0]!.px,
      bestAsk: asks[0]!.px,
      bidSize: bids[0]!.sz,
      askSize: asks[0]!.sz,
      depthUsd: Math.round(depthUsd * 100) / 100
    };
  }
  return out;
}

/**
 * Global taker tape (all markets, newest first). One request drives every
 * quoted market; the caller filters by condition id.
 */
export async function fetchMmTrades(limit = 500): Promise<PmTrade[]> {
  if (!config.pm.enabled) return [];
  const res = await fetch(`https://data-api.polymarket.com/v2/trades?limit=${limit}`, {
    signal: AbortSignal.timeout(TIMEOUT)
  });
  if (!res.ok) throw new Error(`data-api trades HTTP ${res.status}`);
  const raw = (await res.json()) as { data?: unknown[] } | unknown[];
  const rows = Array.isArray(raw) ? raw : (raw.data ?? []);
  const out: PmTrade[] = [];
  for (const row of rows) {
    const t = row as {
      condition_id?: string; side?: string; price?: number | string; size?: number | string; timestamp?: number | string;
    };
    const conditionId = t.condition_id ?? "";
    const side = String(t.side ?? "").toUpperCase();
    const price = Number(t.price);
    const size = Number(t.size);
    const ts = Number(t.timestamp) * 1000;
    if (!conditionId || (side !== "BUY" && side !== "SELL")) continue;
    if (!(price > 0 && price < 1 && size > 0 && ts > 0)) continue;
    out.push({ conditionId, side, price, size, ts });
  }
  return out;
}
