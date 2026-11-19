import { evaluateNegRisk } from "../domain/negrisk.js";
import type { NegRiskOpportunity } from "../domain/types.js";
import type { PmBookTop, PmMmMarket, PmTrade } from "../venues/polymarket.js";

const DAY = 86_400_000;

/** Deterministic demo desk universe, used only with MARKET_DATA_MODE=demo / SEED_TEST_FIXTURE. */
export function demoMmUniverse(now = Date.now()): PmMmMarket[] {
  const specs: Array<[string, string, number]> = [
    ["BTC 本周收盘高于 $105,000？", "加密", 0.58],
    ["ETH 本月收盘高于 $4,500？", "加密", 0.42],
    ["美联储 12 月降息 25bp？", "宏观", 0.71],
    ["2026 年 NBA 总冠军是凯尔特人？", "体育", 0.29],
    ["美国 2026 年陷入衰退？", "宏观", 0.36],
    ["SOL 年底前突破 $300？", "加密", 0.24],
    ["2026 年奥斯卡最佳影片是《沙丘 3》？", "娱乐", 0.33],
    ["英国 2026 年举行大选？", "政治", 0.18],
    ["AI 监管法案 2026 年通过？", "政治", 0.47],
    ["黄金 2026 年站上 $3,500？", "商品", 0.62],
    ["特斯拉 2026 年交付超 250 万辆？", "公司", 0.27],
    ["2026 年超级碗冠军是酋长队？", "体育", 0.21]
  ];
  return specs.map(([title, category, mid], i) => {
    const spread = 0.012 + (i % 3) * 0.004;
    const bestBid = Math.max(0.03, +(mid - spread / 2).toFixed(3));
    const bestAsk = Math.min(0.97, +(mid + spread / 2).toFixed(3));
    return {
      id: "demo-mm-" + (i + 1),
      conditionId: "demo-condition-" + (i + 1),
      title,
      slug: "demo-mm-" + (i + 1),
      category,
      due: new Date(now + (20 + i * 3) * DAY).toISOString(),
      yesTokenId: "demo-yes-" + (i + 1),
      noTokenId: "demo-no-" + (i + 1),
      bestBid,
      bestAsk,
      liquidity: 60_000 + i * 12_000,
      volume24h: 320_000 - i * 18_000
    };
  });
}

export function demoBooks(universe: PmMmMarket[], now = Date.now()): Record<string, PmBookTop> {
  const t = now / 1000;
  const out: Record<string, PmBookTop> = {};
  universe.forEach((m, i) => {
    const drift = Math.sin(t / 7 + i * 1.7) * 0.0035;
    const mid = (m.bestBid + m.bestAsk) / 2 + drift;
    const half = (m.bestAsk - m.bestBid) / 2;
    out[m.yesTokenId] = {
      bestBid: Math.max(0.02, +(mid - half).toFixed(4)),
      bestAsk: Math.min(0.98, +(mid + half).toFixed(4)),
      bidSize: 400 + (i % 4) * 120,
      askSize: 380 + (i % 3) * 140,
      depthUsd: m.liquidity
    };
  });
  return out;
}

/**
 * Synthetic taker prints for the demo fixture only. Every call produces one
 * small SELL at the touch for the first market and one BUY for the second, so
 * the verification suite exercises both fill directions deterministically.
 */
export function demoTrades(universe: PmMmMarket[], books: Record<string, PmBookTop>, now = Date.now()): PmTrade[] {
  return universe.slice(0, 2).map((m, i) => {
    const b = books[m.yesTokenId]!;
    const side: "BUY" | "SELL" = i === 0 ? "SELL" : "BUY";
    return {
      conditionId: m.conditionId,
      side,
      price: side === "SELL" ? b.bestBid : b.bestAsk,
      size: 40 + (Math.floor(now / 6000) % 5) * 20,
      ts: now
    };
  });
}

export function demoNegRisk(now = Date.now()): NegRiskOpportunity[] {
  const mk = (id: string, title: string, names: string[], dueDays: number, bids: number[]) => {
    const due = new Date(now + dueDays * DAY).toISOString();
    return evaluateNegRisk({
      id,
      title,
      slug: id,
      negRiskMarketId: "0x" + id.padEnd(8, "0"),
      due,
      outcomes: bids.map((bid, i) => ({
        name: names[i] ?? "结果 " + (i + 1),
        yesTokenId: `demo-${id}-yes-${i}`,
        noTokenId: `demo-${id}-no-${i}`,
        yesBid: bid,
        yesAsk: +(bid + 0.006).toFixed(3),
        noAsk: +(1 - bid).toFixed(3),
        noBid: +(1 - bid - 0.006).toFixed(3),
        liquidity: 48_000 + i * 7_000
      }))
    }, 20, now);
  };
  return [
    mk("demo-negrisk-election", "2028 年民主党总统候选人",
      ["纽森", "哈里斯", "夏皮罗", "惠特默", "布蒂吉格"], 420, [0.31, 0.27, 0.24, 0.15, 0.11]),
    mk("demo-negrisk-worldcup", "2026 年世界杯冠军",
      ["法国", "巴西", "英格兰", "西班牙"], 210, [0.34, 0.3, 0.26, 0.18]),
    mk("demo-negrisk-euro", "下一任教宗来自欧洲？",
      ["意大利", "西班牙", "法国", "德国"], 150, [0.28, 0.25, 0.22, 0.2])
  ].filter((o): o is NegRiskOpportunity => o !== null);
}
