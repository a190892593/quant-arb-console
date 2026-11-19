import { config } from "../config.js";
import { digitalFair, hedgeDelta, touchDelta, clamp, touchFair } from "../domain/pricing.js";
import type { EventContract, Market, VenueStatus } from "../domain/types.js";

const TIMEOUT = 15_000;

interface GammaMarket {
  id?: string;
  question?: string;
  conditionId?: string;
  slug?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  lastTradePrice?: number;
  liquidity?: number | string;
  liquidityNum?: number;
  volume?: number | string;
  volumeNum?: number;
  volume24hr?: number;
  category?: string;
  tags?: Array<{ label?: string; slug?: string }>;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "user-agent": "convergence-terminal/2.0", accept: "application/json" },
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

const UNDERLYINGS: Array<{ coin: string; names: string[]; cat: string }> = [
  { coin: "BTC", names: ["bitcoin", "btc"], cat: "BTC 价格" },
  { coin: "ETH", names: ["ethereum", "eth", "ether"], cat: "ETH 价格" },
  { coin: "SOL", names: ["solana", "sol"], cat: "山寨币" },
  { coin: "HYPE", names: ["hyperliquid", "hype"], cat: "山寨币" },
  { coin: "XRP", names: ["xrp", "ripple"], cat: "山寨币" },
  { coin: "DOGE", names: ["dogecoin", "doge"], cat: "山寨币" },
  { coin: "BNB", names: ["bnb", "binance coin"], cat: "山寨币" },
  { coin: "AVAX", names: ["avalanche", "avax"], cat: "山寨币" },
  { coin: "LINK", names: ["chainlink", "link"], cat: "山寨币" }
];

export interface PmCatalog {
  events: EventContract[];
  fetchedAt: number;
  scanned: number;
  parsed: number;
}

interface GammaEvent {
  id?: string;
  title?: string;
  markets?: GammaMarket[];
}

interface ParsedQuestion {
  coin: string;
  cat: string;
  strike: number;
  direction: 1 | -1;
  kind: "digital" | "touch";
}

function parseQuestion(question: string): ParsedQuestion | null {
  const q = question.toLowerCase();
  const und = UNDERLYINGS.find(u => u.names.some(n => q.includes(n)));
  if (!und) return null;

  const amount = "\\$?\\s*([\\d,]+(?:\\.\\d+)?)\\s*(k|m|thousand|million)?";
  const patterns: Array<{ re: RegExp; direction: 1 | -1; kind: "digital" | "touch" }> = [
    // Intraday touch language must win over the generic above/below wording.
    { re: new RegExp(`(?:trade below|dip below|drop below|fall below)\\s+${amount}`, "i"), direction: -1, kind: "touch" },
    { re: new RegExp(`(?:reach|hit|exceed|touch|trade above|trade higher)\\s+${amount}`, "i"), direction: 1, kind: "touch" },
    { re: new RegExp(`(?:above|over|greater than|at least|≥|>)\\s+${amount}`, "i"), direction: 1, kind: "digital" },
    { re: new RegExp(`(?:below|under|less than|at most|≤|<)\\s+${amount}`, "i"), direction: -1, kind: "digital" },
    { re: new RegExp(`(?:close above|close higher than)\\s+${amount}`, "i"), direction: 1, kind: "digital" },
    { re: new RegExp(`(?:close below|close lower than)\\s+${amount}`, "i"), direction: -1, kind: "digital" },
    { re: new RegExp(`${amount}\\s+(?:or higher|or above)`, "i"), direction: 1, kind: "digital" },
    { re: new RegExp(`${amount}\\s+(?:or lower|or below)`, "i"), direction: -1, kind: "digital" }
  ];
  for (const p of patterns) {
    const m = q.match(p.re);
    if (!m) continue;
    let n = Number(String(m[1]).replace(/,/g, ""));
    const suffix = (m[2] || "").toLowerCase();
    if (suffix === "k" || suffix === "thousand") n *= 1_000;
    if (suffix === "m" || suffix === "million") n *= 1_000_000;
    if (!Number.isFinite(n) || n <= 0) continue;
    return { coin: und.coin, cat: und.cat, strike: n, direction: p.direction, kind: p.kind };
  }
  return null;
}

function parseJsonArray(text: string | undefined): string[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

/**
 * Build the live scanner universe from Polymarket Gamma.
 *
 * The generic /markets feed is dominated by sports and politics; price-threshold crypto
 * markets live under the crypto tag. Fetch those events, flatten their markets, and only
 * keep quotes that Gamma actually reports (both bid and ask), so nothing is synthesised.
 */
export async function fetchCatalog(market: Market, vols: Record<string, number>): Promise<PmCatalog> {
  const PAGE = 50;
  const MAX_PAGES = 5;
  const list: GammaMarket[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${config.pm.gammaUrl}/events?tag_slug=crypto&active=true&closed=false&limit=${PAGE}&offset=${page * PAGE}&order=volume24hr&ascending=false`;
    let batch: GammaEvent[];
    try {
      const raw = await getJson<GammaEvent[] | { data?: GammaEvent[] }>(url);
      batch = Array.isArray(raw) ? raw : (raw.data ?? []);
    } catch (err) {
      // A later page may be throttled; the earlier real pages are still a valid catalog.
      if (list.length) break;
      throw err;
    }
    for (const ev of batch) {
      for (const m of ev.markets ?? []) list.push(m);
    }
    if (batch.length < PAGE) break;
  }

  const events: EventContract[] = [];
  const seen = new Set<string>();
  let parsed = 0;

  for (const m of list) {
    if (!m.question || m.closed || m.archived || m.active === false) continue;
    const key = m.conditionId ?? m.id ?? "";
    if (!key || seen.has(key)) continue;
    const p = parseQuestion(m.question);
    if (!p) continue;
    parsed++;
    const spot = market[p.coin]?.px;
    if (!spot) continue;
    const dueMs = Date.parse(m.endDate ?? "");
    if (!Number.isFinite(dueMs) || dueMs <= Date.now() + 3600_000) continue;
    const days = (dueMs - Date.now()) / 86_400_000;
    if (days > 400 || days < 0.5) continue;

    const outcomes = parseJsonArray(m.outcomes);
    const yesIndex = outcomes.findIndex(o => /^yes$/i.test(o.trim()));
    if (outcomes.length !== 2 || yesIndex < 0) continue;
    const tokens = parseJsonArray(m.clobTokenIds);
    const tokenId = tokens[yesIndex] ?? tokens[0];

    const ask = Number(m.bestAsk);
    const bid = Number(m.bestBid);
    if (!(ask > 0 && ask < 1 && bid > 0 && bid < ask)) continue;
    const depth = Math.max(Number(m.liquidityNum ?? m.liquidity ?? 0), 0);
    if (depth < 2_000) continue;

    const vol = vols[p.coin] ?? 0.7;
    const fair = p.kind === "touch"
      ? touchFair({ spot, strike: p.strike, vol, days })
      : digitalFair({ spot, strike: p.strike, vol, days, direction: p.direction });
    if (fair == null) continue;

    const spread = Math.max(0.001, ask - bid);
    const delta = hedgeDelta({ spot, strike: p.strike, vol, days, direction: p.direction });
    const conf = Math.round(clamp(58 + Math.log10(Math.max(1, depth / 1000)) * 6 - spread * 400, 45, 96));
    seen.add(key);
    events.push({
      id: "pm-" + key,
      title: m.question.trim(),
      cat: p.cat,
      und: p.coin,
      due: new Date(dueMs).toISOString(),
      ask: clamp(ask, 0.01, 0.99),
      bid: clamp(bid, 0.01, 0.985),
      fair,
      depth: Math.round(depth),
      conf,
      delta,
      src: `${p.coin} · Polymarket`,
      source: "polymarket",
      model: { spot, strike: p.strike, vol, direction: p.direction, kind: p.kind },
      external: {
        conditionId: m.conditionId,
        tokenId,
        noTokenId: tokens[yesIndex === 0 ? 1 : 0],
        slug: m.slug,
        volume: Number(m.volumeNum ?? m.volume ?? 0),
        liquidity: depth
      }
    });
    if (events.length >= 240) break;
  }

  events.sort((a, b) => b.depth - a.depth);
  return { events, fetchedAt: Date.now(), scanned: list.length, parsed };
}

/* ---------------- live trading ---------------- */

export interface PmOrderRequest {
  tokenId: string;
  amountUsd?: number;
  shares?: number;
  side: "BUY" | "SELL";
  price?: number;
}

export interface VenueFill {
  ok: boolean;
  externalId?: string;
  filledQty?: number;
  avgPrice?: number;
  raw?: unknown;
  error?: string;
}

interface PmClient {
  createAndPostMarketOrder(params: unknown, options?: unknown, orderType?: unknown): Promise<unknown>;
}

let client: PmClient | null = null;

async function getClient(): Promise<PmClient> {
  if (client) return client;
  if (!config.pm.privateKey || !config.pm.apiKey) throw new Error("Polymarket 交易凭据未配置");
  const [{ ClobClient, Side, OrderType }, { privateKeyToAccount }, { createWalletClient, http }] = await Promise.all([
    import("@polymarket/clob-client"),
    import("viem/accounts"),
    import("viem")
  ]);
  const account = privateKeyToAccount(config.pm.privateKey as `0x${string}`);
  const wallet = createWalletClient({ account, transport: http(config.pm.rpcUrl) });
  client = new ClobClient(
    config.pm.clobUrl,
    config.pm.chainId as 137,
    wallet,
    { key: config.pm.apiKey, secret: config.pm.apiSecret, passphrase: config.pm.apiPassphrase },
    config.pm.signatureType,
    config.pm.funder || undefined
  ) as unknown as PmClient;
  void Side; void OrderType;
  return client;
}

export async function placeOrder(req: PmOrderRequest): Promise<VenueFill> {
  try {
    const c = await getClient();
    const { Side, OrderType } = await import("@polymarket/clob-client");
    const amount = req.side === "BUY" ? (req.amountUsd ?? 0) : (req.shares ?? 0);
    if (!(amount > 0)) throw new Error("订单金额无效");
    const result = await c.createAndPostMarketOrder(
      { tokenID: req.tokenId, amount, side: req.side === "BUY" ? Side.BUY : Side.SELL, orderType: OrderType.FAK },
      req.price ? { price: req.price } : undefined,
      OrderType.FAK
    );
    const r = result as {
      success?: boolean; orderID?: string; status?: string; errorMsg?: string;
      takingAmount?: string; makingAmount?: string;
    };
    if (r.success === false || r.errorMsg) return { ok: false, error: r.errorMsg ?? "下单失败", raw: result };
    const taking = Number(r.takingAmount ?? 0);
    const making = Number(r.makingAmount ?? 0);
    const shares = req.side === "BUY" ? taking : making;
    const usd = req.side === "BUY" ? making : taking;
    return {
      ok: true,
      externalId: r.orderID ?? "",
      filledQty: shares,
      avgPrice: shares > 0 ? usd / shares : req.price,
      raw: result
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
