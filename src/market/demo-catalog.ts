import { digitalFair, hedgeDelta, normalInv } from "../domain/pricing.js";
import type { EventContract, Market } from "../domain/types.js";
import { mulberry32 } from "../util.js";

const UNDERLYINGS: Array<{ coin: string; cat: string; src: string; vol: number; step: number }> = [
  { coin: "BTC", cat: "BTC 价格", src: "BRTI · UMA", vol: 0.55, step: 1_000 },
  { coin: "ETH", cat: "ETH 价格", src: "CF Ether-Dollar · UMA", vol: 0.65, step: 50 },
  { coin: "SOL", cat: "山寨币", src: "CF SOL-Dollar · UMA", vol: 0.85, step: 5 },
  { coin: "HYPE", cat: "山寨币", src: "HL 标记价 · UMA", vol: 0.95, step: 2 },
  { coin: "XRP", cat: "山寨币", src: "CF XRP-Dollar · UMA", vol: 0.8, step: 0.05 },
  { coin: "DOGE", cat: "山寨币", src: "CF DOGE-Dollar · UMA", vol: 0.9, step: 0.005 }
];

const TENORS = [7, 14, 30, 60, 90, 120, 180];
const MONEYNESS = [0.65, 0.8, 0.92, 1, 1.08, 1.25, 1.5];

function niceStrike(px: number, factor: number, step: number): number {
  const raw = px * factor;
  return Math.max(step, Math.round(raw / step) * step);
}

function expiry(days: number, now: number): string {
  const d = new Date(now + days * 86_400_000);
  d.setUTCHours(15, 0, 0, 0);
  return d.toISOString();
}

export interface DemoCatalogOptions {
  market: Market;
  vols: Record<string, number>;
  now?: number;
  size?: number;
}

/**
 * Build a deterministic demo Polymarket catalog around live Hyperliquid prices.
 * It is used when Polymarket is unreachable, or when MARKET_DATA_MODE=demo.
 * The prices are synthetic and every such event is marked source="demo".
 */
export function generateDemoCatalog(opts: DemoCatalogOptions): EventContract[] {
  const now = opts.now ?? Date.now();
  const rand = mulberry32(20_261_118);
  const size = opts.size ?? 120;
  const events: EventContract[] = [];

  for (const meta of UNDERLYINGS) {
    const spot = opts.market[meta.coin]?.px;
    if (!spot) continue;
    const vol = opts.vols[meta.coin] ?? meta.vol;
    for (const tenor of TENORS) {
      const due = expiry(tenor, now);
      const days = (Date.parse(due) - now) / 86_400_000;
      for (const factor of MONEYNESS) {
        const strike = niceStrike(spot, factor, meta.step);
        for (const direction of [1, -1] as const) {
          if (events.length >= size) break;
          const fair = digitalFair({ spot, strike, vol, days, direction });
          if (fair == null || fair < 0.06 || fair > 0.94) continue;
          const tasty = fair > 0.16 && fair < 0.86;
          const intendedGross = tasty ? 3.1 + rand() * 4.4 : 1.2 + rand() * 2.2;
          const gross = Math.min(intendedGross / 100, Math.max(0.008, fair - 0.022));
          const halfSpread = 0.0025 + rand() * 0.0055;
          const ask = Math.min(0.965, Math.max(0.021, fair - gross + halfSpread));
          const bid = Math.max(0.01, ask - halfSpread * 2);
          const depth = Math.round((8_000 + rand() * 240_000) / 500) * 500;
          const conf = Math.round(Math.min(96, Math.max(48, 68 + rand() * 30 - (tenor > 90 ? 8 : 0))));
          const delta = hedgeDelta({ spot, strike, vol, days, direction });
          const label = direction > 0 ? "≥" : "≤";
          const date = new Date(due);
          const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
          const dd = String(date.getUTCDate()).padStart(2, "0");
          events.push({
            id: `demo-${meta.coin.toLowerCase()}-${tenor}-${strike}-${direction > 0 ? "g" : "l"}`.replace(/\./g, "_"),
            title: `${meta.coin} ${label} $${strike.toLocaleString("en-US")}（${mm}-${dd} 结算）`,
            cat: meta.cat,
            und: meta.coin,
            due,
            ask: +ask.toFixed(4),
            bid: +bid.toFixed(4),
            fair: +fair.toFixed(4),
            depth,
            conf,
            delta,
            src: meta.src,
            source: "demo",
            model: { spot, strike, vol, direction, kind: "digital" },
            baseAsk: +ask.toFixed(4),
            baseBid: +bid.toFixed(4),
            baseFair: +fair.toFixed(4)
          });
        }
      }
    }
  }

  // Relative-value flavour: ratio contracts are synthetic but priced coherently.
  const pairs: Array<[string, string, number, string]> = [
    ["ETH", "BTC", 0.028, "ETH/BTC"], ["SOL", "ETH", 0.041, "SOL/ETH"], ["HYPE", "SOL", 0.92, "HYPE/SOL"]
  ];
  for (const [a, b, ratio, label] of pairs) {
    const pa = opts.market[a]?.px, pb = opts.market[b]?.px;
    if (!pa || !pb) continue;
    const actual = pa / pb;
    for (const cmp of [1, -1] as const) {
      const fair = Math.min(0.92, Math.max(0.08, 0.5 + cmp * (actual / ratio - 1) * 0.9));
      const halfSpread = 0.006;
      const ask = Math.min(0.95, fair - 0.035 + halfSpread);
      const bid = Math.max(0.02, ask - halfSpread * 2);
      const due = expiry(30, now);
      events.push({
        id: `demo-rv-${label.toLowerCase().replace(/\//g, "-")}-${cmp}`,
        title: `${label} ${cmp > 0 ? "≥" : "≤"} ${ratio}（30 天）`,
        cat: "相对价值",
        und: a,
        due,
        ask: +ask.toFixed(4),
        bid: +bid.toFixed(4),
        fair: +fair.toFixed(4),
        depth: 9_000 + Math.round(rand() * 18_000),
        conf: 58 + Math.round(rand() * 18),
        delta: cmp * 0.03,
        src: "指数比值 · UMA",
        source: "demo",
        baseAsk: +ask.toFixed(4),
        baseBid: +bid.toFixed(4),
        baseFair: +fair.toFixed(4)
      });
    }
  }

  // Settlement-convergence flavour: 12–36h to expiry, outcome already 88–96% likely,
  // but the displayed ask still trades a few cents below that fair value.
  for (const meta of UNDERLYINGS.slice(0, 3)) {
    const spot = opts.market[meta.coin]?.px;
    if (!spot) continue;
    const vol = opts.vols[meta.coin] ?? meta.vol;
    for (const tenor of [0.5, 1.5]) {
      for (const target of [0.9, 0.95]) {
        const T = Math.max(1 / 365, tenor / 365);
        const z = normalInv(target);
        const rawStrike = spot * Math.exp(-(z * vol * Math.sqrt(T) + 0.5 * vol * vol * T));
        const strike = niceStrike(rawStrike, 1, target > 0.92 ? meta.step / 2 : meta.step);
        const fair = digitalFair({ spot, strike, vol, days: tenor, direction: 1 });
        if (fair == null || fair < 0.86 || fair > 0.985) continue;
        const halfSpread = 0.003 + rand() * 0.002;
        const discount = 0.026 + rand() * 0.016;
        const ask = Math.min(0.982, Math.max(0.5, fair - discount + halfSpread));
        const bid = Math.max(0.45, ask - halfSpread * 2);
        const due = expiry(tenor, now);
        const date = new Date(due);
        const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(date.getUTCDate()).padStart(2, "0");
        events.push({
          id: `demo-conv-${meta.coin.toLowerCase()}-${tenor}-${Math.round(target * 100)}-${strike}`.replace(/\./g, "_"),
          title: `${meta.coin} ≥ $${strike.toLocaleString("en-US")}（${mm}-${dd} 结算）`,
          cat: meta.cat,
          und: meta.coin,
          due,
          ask: +ask.toFixed(4),
          bid: +bid.toFixed(4),
          fair: +fair.toFixed(4),
          depth: Math.round((25_000 + rand() * 70_000) / 500) * 500,
          conf: Math.round(88 + rand() * 8),
          delta: hedgeDelta({ spot, strike, vol, days: tenor, direction: 1 }),
          src: meta.src,
          source: "demo",
          model: { spot, strike, vol, direction: 1, kind: "digital" },
          baseAsk: +ask.toFixed(4),
          baseBid: +bid.toFixed(4),
          baseFair: +fair.toFixed(4)
        });
      }
    }
  }

  // Quote-age bookkeeping: the market service ages these timestamps on every tick,
  // which is what the latency engine reads.
  for (const ev of events) {
    ev.quoteAt = now;
    ev.quoteRefPx = opts.market[ev.und]?.px;
    ev.quoteAgeMs = Math.round(rand() * 4_500);
  }

  // Never let two synthetic events share an id: the repository keys by id.
  const seen = new Set<string>();
  return events.filter(ev => {
    if (seen.has(ev.id)) return false;
    seen.add(ev.id);
    return true;
  });
}
