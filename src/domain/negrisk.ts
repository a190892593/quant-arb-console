import type { Conversion, ConversionLeg, NegRiskOpportunity, NegRiskOutcome } from "./types.js";

/** Conservative all-in cost: taker fee on both legs plus a per-conversion settlement buffer. */
export const NEGRISK_FEE_BPS = 20;
const GAS_USD = 0.02;
/** Only the most conservative slice of reported liquidity is assumed executable. */
const LIQUIDITY_USE = 0.1;

const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

export interface NegRiskInput {
  id: string;
  title: string;
  slug: string;
  negRiskMarketId: string;
  due: string;
  outcomes: NegRiskOutcome[];
}

/**
 * NegRisk conversion basket of `n` mutually exclusive outcomes:
 *
 *   buy 1 NO_i for every outcome i          cost     = Σ noAsk_i
 *   convert NO_i into YES_j for every j≠i   position = (n−1) YES_j
 *   sell all YES_j at the bid               proceeds = (n−1) · Σ yesBid_j
 *
 * With complement books (noAsk_i = 1 − yesBid_i) this is
 *   profit = n · (Σ yesBid − 1) − fees
 * and is strictly positive only when the YES bid basket trades above 100¢.
 * The position is flat after the sell; there is no directional exposure.
 */
export function evaluateNegRisk(input: NegRiskInput, feeBps = NEGRISK_FEE_BPS, now = Date.now()): NegRiskOpportunity | null {
  const outcomes = input.outcomes.filter(o =>
    Number.isFinite(o.yesBid) && Number.isFinite(o.yesAsk) && Number.isFinite(o.noAsk) &&
    o.yesBid > 0 && o.yesBid < 1 && o.noAsk > 0 && o.noAsk < 1
  );
  const n = outcomes.length;
  if (n < 3) return null;

  const sumYesBid = outcomes.reduce((s, o) => s + o.yesBid, 0);
  const sumNoAsk = outcomes.reduce((s, o) => s + o.noAsk, 0);
  const basketCost = sumNoAsk;
  const conversionProceeds = (n - 1) * sumYesBid;
  const gross = conversionProceeds - basketCost;
  const fee = (basketCost + conversionProceeds) * feeBps / 10_000 + GAS_USD;
  const profit = gross - fee;
  const profitPct = basketCost > 0 ? profit / basketCost : 0;
  const edgeBps = profitPct * 10_000;
  const maxSets = Math.max(0, Math.floor(Math.min(
    ...outcomes.map(o => (Math.max(0, o.liquidity) * LIQUIDITY_USE) / Math.max(o.noAsk, 0.01))
  ) / 10) * 10);

  const dueMs = Date.parse(input.due);
  const expired = Number.isFinite(dueMs) && dueMs <= now + 3600_000;
  const ready = profit > 0.005 && maxSets >= 10 && !expired;
  return {
    ...input,
    outcomes,
    n,
    sumYesBid: round(sumYesBid),
    sumNoAsk: round(sumNoAsk),
    basketCost: round(basketCost, 4),
    conversionProceeds: round(conversionProceeds, 4),
    profit: round(profit, 4),
    profitPct: round(profitPct, 6),
    edgeBps: round(edgeBps, 1),
    maxSets,
    feeBps,
    status: ready ? "ready" : "watch",
    updatedAt: now,
    reason: expired
      ? "事件将在 1 小时内结算，转换与卖出无法完成"
      : sumYesBid <= 1
        ? `YES 买价合计 ${(sumYesBid * 100).toFixed(2)}¢ ≤ 100¢，NO 篮子没有折价`
        : profit <= 0.005
          ? `毛价差 ${gross.toFixed(3)} USDC/组被费用 ${fee.toFixed(3)} 吞掉`
          : `YES 买价合计 ${(sumYesBid * 100).toFixed(2)}¢ > 100¢，每组建仓即锁定 ${profit.toFixed(3)} USDC`
  };
}

export function quoteConversion(opp: NegRiskOpportunity, sets: number): {
  cost: number; proceeds: number; fee: number; profit: number; legs: ConversionLeg[];
} {
  const cost = opp.basketCost * sets;
  const proceeds = opp.conversionProceeds * sets;
  const fee = (cost + proceeds) * opp.feeBps / 10_000 + GAS_USD;
  return {
    cost: round(cost, 6),
    proceeds: round(proceeds, 6),
    fee: round(fee, 6),
    profit: round(proceeds - cost - fee, 6),
    legs: opp.outcomes.map(o => ({
      outcome: o.name,
      noAsk: o.noAsk,
      yesBid: o.yesBid,
      noShares: sets,
      yesShares: sets * (opp.n - 1)
    }))
  };
}

export function buildConversion(input: {
  id: string; accountId: Conversion["accountId"]; opp: NegRiskOpportunity; sets: number;
}): Conversion {
  const q = quoteConversion(input.opp, input.sets);
  return {
    id: input.id,
    accountId: input.accountId,
    opportunityId: input.opp.id,
    title: input.opp.title,
    slug: input.opp.slug,
    due: input.opp.due,
    n: input.opp.n,
    sets: input.sets,
    cost: q.cost,
    proceeds: q.proceeds,
    fee: q.fee,
    profit: q.profit,
    edgeBps: input.opp.edgeBps,
    createdAt: Date.now(),
    legs: q.legs,
    status: "locked",
    mode: "paper",
    note: "买入全部 NO → NegRisk Adapter 转换 → 按买价卖出全部 YES；价差在成交瞬间锁定"
  };
}
