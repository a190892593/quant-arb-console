import { config } from "../config.js";
import type { MarketTick, VenueStatus } from "../domain/types.js";

interface HlUniverseAsset { name: string; szDecimals: number; maxLeverage: number }
interface HlCtx {
  funding: string; openInterest: string; prevDayPx: string; dayNtlVlm: string;
  premium: string; oraclePx: string; markPx: string; midPx: string;
}
interface HlCandle { t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number }

export interface HlSnapshot {
  market: Record<string, MarketTick>;
  universe: HlUniverseAsset[];
  fetchedAt: number;
  latencyMs: number;
}

const TIMEOUT = 8_000;

async function post<T>(body: unknown): Promise<T> {
  const res = await fetch(`${config.hl.apiUrl}/info`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "convergence-terminal/2.0" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT)
  });
  if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`);
  return (await res.json()) as T;
}

let lastSnapshot: HlSnapshot | null = null;
const volCache = new Map<string, { vol: number; at: number }>();

export async function fetchSnapshot(): Promise<HlSnapshot> {
  const started = Date.now();
  const raw = await post<[ { universe: HlUniverseAsset[] }, HlCtx[] ]>({ type: "metaAndAssetCtxs" });
  const [meta, ctxs] = raw;
  const market: Record<string, MarketTick> = {};
  meta.universe.forEach((asset, i) => {
    const c = ctxs[i];
    if (!c) return;
    const px = Number(c.markPx);
    const prev = Number(c.prevDayPx);
    if (!Number.isFinite(px) || px <= 0) return;
    market[asset.name] = {
      px,
      chg: prev > 0 ? (px / prev - 1) * 100 : 0,
      funding: Number(c.funding),
      openInterest: Number(c.openInterest),
      dayVolume: Number(c.dayNtlVlm),
      prevDayPx: prev
    };
  });
  lastSnapshot = { market, universe: meta.universe, fetchedAt: Date.now(), latencyMs: Date.now() - started };
  return lastSnapshot;
}

/** Lightweight price refresh used between full metadata snapshots. */
export async function fetchMids(): Promise<{ mids: Record<string, number>; latencyMs: number }> {
  const started = Date.now();
  const raw = await post<Record<string, string>>({ type: "allMids" });
  const mids: Record<string, number> = {};
  for (const [coin, value] of Object.entries(raw)) {
    const px = Number(value);
    if (Number.isFinite(px) && px > 0) mids[coin] = px;
  }
  return { mids, latencyMs: Date.now() - started };
}

export function getSnapshot(): HlSnapshot | null { return lastSnapshot; }

export async function fetchCandles(coin: string, days = 90): Promise<HlCandle[]> {
  const end = Date.now();
  return post<HlCandle[]>({
    type: "candleSnapshot",
    req: { coin, interval: "1d", startTime: end - days * 86_400_000, endTime: end }
  });
}

/** Annualised realised volatility from daily candles, blended with a floor. */
export async function realisedVol(coin: string, fallback = 0.65): Promise<number> {
  const hit = volCache.get(coin);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.vol;
  try {
    const candles = await fetchCandles(coin, 90);
    const closes = candles.map(c => Number(c.c)).filter(n => n > 0);
    if (closes.length < 12) return fallback;
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i]! / closes[i - 1]!));
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1));
    const annual = sd * Math.sqrt(365);
    const vol = Math.min(2.5, Math.max(0.2, annual * 1.08));
    volCache.set(coin, { vol, at: Date.now() });
    return vol;
  } catch {
    return fallback;
  }
}

export async function health(): Promise<VenueStatus> {
  const started = Date.now();
  try {
    await post({ type: "allMids" });
    return {
      id: "hyperliquid", label: "Hyperliquid 永续", state: "ok",
      latencyMs: Date.now() - started, message: config.hl.testnet ? "测试网连接正常" : "主网连接正常",
      lastOkAt: Date.now(), mode: "live"
    };
  } catch (err) {
    return {
      id: "hyperliquid", label: "Hyperliquid 永续", state: config.hl.enabled ? "down" : "disabled",
      latencyMs: null, message: (err as Error).message, lastOkAt: null, mode: "live"
    };
  }
}

/* ---------------- live trading ---------------- */

export interface HlOrderRequest {
  coin: string;
  isBuy: boolean;
  size: number;
  price: number;
  reduceOnly?: boolean;
}

export interface VenueFill {
  ok: boolean;
  externalId?: string;
  filledQty?: number;
  avgPrice?: number;
  raw?: unknown;
  error?: string;
}

interface HlExchange {
  order(params: unknown): Promise<unknown>;
}

let exchangeClient: HlExchange | null = null;
let metaCache: { universe: HlUniverseAsset[]; at: number } | null = null;

async function getExchange(): Promise<HlExchange> {
  if (exchangeClient) return exchangeClient;
  if (!config.hl.privateKey || !config.hl.walletAddress) throw new Error("Hyperliquid 交易凭据未配置");
  const [{ HttpTransport, ExchangeClient }, { privateKeyToAccount }] = await Promise.all([
    import("@nktkas/hyperliquid"),
    import("viem/accounts")
  ]);
  const wallet = privateKeyToAccount(config.hl.privateKey as `0x${string}`);
  const transport = new HttpTransport({ apiUrl: config.hl.apiUrl, isTestnet: config.hl.testnet, timeout: 10_000 });
  exchangeClient = new ExchangeClient({ transport, wallet }) as unknown as HlExchange;
  return exchangeClient;
}

async function assetIndex(coin: string): Promise<{ index: number; szDecimals: number }> {
  if (!metaCache || Date.now() - metaCache.at > 5 * 60_000) {
    const meta = await post<{ universe: HlUniverseAsset[] }>({ type: "meta" });
    metaCache = { universe: meta.universe, at: Date.now() };
  }
  const index = metaCache.universe.findIndex(a => a.name === coin);
  if (index < 0) throw new Error(`Hyperliquid 没有 ${coin} 永续合约`);
  return { index, szDecimals: metaCache.universe[index]!.szDecimals };
}

export async function placeOrder(req: HlOrderRequest): Promise<VenueFill> {
  try {
    const exchange = await getExchange();
    const { index, szDecimals } = await assetIndex(req.coin);
    const size = Number(req.size.toFixed(Math.max(0, Math.min(6, szDecimals))));
    if (!(size > 0)) throw new Error("对冲数量过小");
    const price = Number(req.price.toPrecision(6));
    const result = await exchange.order({
      orders: [{
        a: index,
        b: req.isBuy,
        p: String(price),
        s: String(size),
        r: !!req.reduceOnly,
        t: { limit: { tif: "Ioc" } }
      }],
      grouping: "na"
    });
    const statuses = (result as { response?: { data?: { statuses?: unknown[] } } })?.response?.data?.statuses ?? [];
    const first = statuses[0] as { filled?: { totalSz?: string; avgPx?: string; oid?: number }; resting?: { oid?: number }; error?: string } | undefined;
    if (first?.filled) {
      return {
        ok: true,
        externalId: String(first.filled.oid ?? ""),
        filledQty: Number(first.filled.totalSz),
        avgPrice: Number(first.filled.avgPx),
        raw: result
      };
    }
    if (first?.error) return { ok: false, error: first.error, raw: result };
    return { ok: false, error: "订单未被成交（IOC）", raw: result };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function userState(address: string): Promise<unknown> {
  return post({ type: "clearinghouseState", user: address });
}
