import type {
  AccountId, Conversion, Limit, MmMarket, MmParams, MmPosition, NegRiskOpportunity, Rule
} from "./types.js";

/* ============================================================
   Limits — one set per desk, usage computed from real exposure
   ============================================================ */

export const DEFAULT_LIMITS: Limit[] = [
  { id: "gross", name: "总敞口上限", desc: "按占用资金口径：转换=当日已转换成本，做市=全部库存市值", value: 8_000, used: 0, kind: "usd" },
  { id: "market", name: "单标的上限", desc: "单个事件/市场的最大占用", value: 2_500, used: 0, kind: "usd" },
  { id: "quote", name: "双边报价名义", desc: "做市台同时在场的双边报价名义合计；转换账户为 0", value: 1_600, used: 0, kind: "usd" },
  { id: "daily", name: "当日亏损上限", desc: "当日已实现加未实现亏损的绝对金额", value: 300, used: 0, kind: "usd" },
  { id: "conc", name: "单标占净值", desc: "最大单一事件/市场占账户净值的比例", value: 20, used: 0, kind: "pct" }
];

export function scaledDefaultLimits(accountId: AccountId, equity: number): Limit[] {
  const neg = accountId === "negrisk";
  return DEFAULT_LIMITS.map(l => {
    const pctOfEquity = (p: number) => Math.max(100, Math.round(equity * p / 100 / 10) * 10);
    if (l.kind === "pct") return { ...l, value: neg ? 25 : 12 };
    const value = l.id === "gross" ? pctOfEquity(neg ? 80 : 40)
      : l.id === "market" ? pctOfEquity(neg ? 25 : 12)
      : l.id === "quote" ? (neg ? 100 : pctOfEquity(50))
      : pctOfEquity(3);
    return { ...l, value };
  });
}

/* ============================================================
   Rules — guardrails and the knobs that drive each desk
   ============================================================ */

const COMMON_RULES: Rule[] = [
  { id: "daily-loss", name: "日亏损降档", desc: "当日回撤达到阈值时停止新开仓/新报价，仅允许减仓", on: true, value: 1.5, unit: "pct", min: 0.2, max: 20, step: 0.1, category: "账户护栏" },
  { id: "latency", name: "报价延迟熔断", desc: "Polymarket 心跳超过阈值时暂停新开仓与新报价", on: true, value: 1500, unit: "ms", min: 100, max: 10_000, step: 50, category: "账户护栏" },
  { id: "min-profit", name: "最低锁定利润", desc: "NegRisk 每组的最低净利；做市台不使用", on: true, value: 0.01, unit: "usd", min: 0, max: 5, step: 0.01, category: "信号过滤" }
];

const NEGRISK_RULES: Rule[] = [
  { id: "min-depth", name: "单腿最低流动性", desc: "任一结果盘口流动性低于阈值时只观察不转换", on: true, value: 20_000, unit: "usd", min: 0, max: 1_000_000, step: 1000, category: "信号过滤" },
  { id: "max-sets", name: "单次最大组数", desc: "一次转换最多买入的 NO 组数；硬约束", on: true, value: 500, unit: "shares", min: 10, max: 5_000, step: 10, category: "执行阈值", hard: true },
  { id: "fee-buffer", name: "费用缓冲", desc: "按转换成本与卖出收入计提的综合费率", on: true, value: 20, unit: "bps", min: 0, max: 200, step: 5, category: "执行阈值" },
  { id: "settle-freeze", name: "结算前冻结", desc: "距结算小于阈值的事件禁止新转换", on: true, value: 1, unit: "days", min: 0, max: 14, step: 0.5, category: "账户护栏" }
];

const MM_RULES: Rule[] = [
  { id: "target-edge", name: "目标价差", desc: "双边报价相对中价的目标半价差", on: true, value: 55, unit: "bps", min: 5, max: 500, step: 5, category: "做市参数" },
  { id: "min-spread", name: "最低盘口价差", desc: "市场自身价差低于该值时停止报价", on: true, value: 120, unit: "bps", min: 10, max: 2_000, step: 10, category: "做市参数" },
  { id: "quote-size", name: "单边报价名义", desc: "每个市场每条边的报价名义", on: true, value: 240, unit: "usd", min: 20, max: 20_000, step: 10, category: "做市参数" },
  { id: "max-inventory", name: "单市场库存上限", desc: "单市场库存市值上限，触及后只报减仓方向", on: true, value: 1_200, unit: "usd", min: 100, max: 100_000, step: 100, category: "库存管理" },
  { id: "max-markets", name: "同时报价市场数", desc: "做市台同时报价的市场数量上限", on: true, value: 8, unit: "count", min: 1, max: 30, step: 1, category: "做市参数" },
  { id: "min-liquidity", name: "最低盘口流动性", desc: "低于该流动性的市场不进入做市池", on: true, value: 25_000, unit: "usd", min: 0, max: 1_000_000, step: 1000, category: "信号过滤" },
  { id: "skew", name: "库存偏斜强度", desc: "库存偏离中线时报价平移的比例；0 为不偏斜", on: true, value: 85, unit: "pct", min: 0, max: 150, step: 5, category: "库存管理" },
  { id: "adverse-stop", name: "逆向波动熔断", desc: "中价在 1 分钟内反向超过该幅度时暂停该市场报价", on: true, value: 300, unit: "bps", min: 50, max: 3_000, step: 10, category: "账户护栏" },
  { id: "flatten-pct", name: "减仓线", desc: "库存达到上限的比例时只报减仓方向", on: true, value: 92, unit: "pct", min: 50, max: 100, step: 1, category: "库存管理" }
];

export function ruleDefsFor(accountId: AccountId): Rule[] {
  return [...COMMON_RULES, ...(accountId === "negrisk" ? NEGRISK_RULES : MM_RULES)].map(r => ({ ...r }));
}

export function defaultRulesFor(accountId: AccountId): Rule[] {
  return ruleDefsFor(accountId);
}

export function ruleValue(rules: Rule[], id: string, fallback: number): number {
  const rule = rules.find(r => r.id === id);
  return Number.isFinite(rule?.value) ? Number(rule!.value) : fallback;
}

export function ruleEnabled(rules: Rule[], id: string): boolean {
  return rules.find(r => r.id === id)?.on === true;
}

export function mmParamsFromRules(rules: Rule[]): MmParams {
  const value = (id: string, fallback: number) => ruleEnabled(rules, id) ? ruleValue(rules, id, fallback) : fallback;
  return {
    targetEdgeBps: value("target-edge", 55),
    minSpreadBps: value("min-spread", 120),
    quoteNotional: value("quote-size", 240),
    maxInventoryUsd: value("max-inventory", 1_200),
    maxMarkets: Math.max(1, Math.round(value("max-markets", 8))),
    minLiquidity: value("min-liquidity", 25_000),
    skewStrength: value("skew", 85) / 100,
    adverseStopBps: value("adverse-stop", 300),
    flattenPct: value("flatten-pct", 92),
    feeBps: 0
  };
}

/* ============================================================
   Usage
   ============================================================ */

export function negRiskLimitUsage(input: {
  conversions: Conversion[]; equity: number; limits: Limit[];
}): Limit[] {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todays = input.conversions.filter(c => c.createdAt >= today.getTime());
  const gross = todays.reduce((s, c) => s + c.cost, 0);
  const maxOne = todays.reduce((m, c) => Math.max(m, c.cost), 0);
  const pnl = todays.reduce((s, c) => s + c.profit, 0);
  return input.limits.map(l => {
    let used = 0;
    if (l.id === "gross") used = gross;
    if (l.id === "market") used = maxOne;
    if (l.id === "quote") used = 0;
    if (l.id === "daily") used = Math.max(0, -pnl);
    if (l.id === "conc") used = input.equity > 0 ? maxOne / input.equity * 100 : 0;
    return { ...l, used };
  });
}

export function mmLimitUsage(input: {
  markets: MmMarket[]; positions: MmPosition[]; equity: number; limits: Limit[];
}): Limit[] {
  const byId = new Map(input.markets.map(m => [m.id, m]));
  const exposure = input.positions.map(p => {
    const m = byId.get(p.marketId);
    return Math.abs(p.inventory) * (m?.mid ?? p.avg);
  });
  const gross = exposure.reduce((s, v) => s + v, 0);
  const maxOne = exposure.reduce((m, v) => Math.max(m, v), 0);
  const quote = input.markets.reduce((s, m) => s + (m.quoteBid > 0 ? m.quoteNotional : 0) + (m.quoteAsk > 0 ? m.quoteNotional : 0), 0);
  const realized = input.positions.reduce((s, p) => s + p.realized, 0);
  const unrealized = input.positions.reduce((s, p) => {
    const m = byId.get(p.marketId);
    return s + (m ? p.inventory * (m.mid - p.avg) : 0);
  }, 0);
  const dailyLoss = Math.max(0, -(realized + unrealized));
  return input.limits.map(l => {
    let used = 0;
    if (l.id === "gross") used = gross;
    if (l.id === "market") used = maxOne;
    if (l.id === "quote") used = quote;
    if (l.id === "daily") used = dailyLoss;
    if (l.id === "conc") used = input.equity > 0 ? maxOne / input.equity * 100 : 0;
    return { ...l, used };
  });
}

/* ============================================================
   Pre-trade check · NegRisk conversion
   ============================================================ */

export interface CheckFailure { code: string; message: string }

export interface ConversionCheckInput {
  opp: NegRiskOpportunity;
  sets: number;
  equity: number;
  conversions: Conversion[];
  limits: Limit[];
  rules: Rule[];
  kill: boolean;
  paperEnabled: boolean;
  dailyLossPct: number;
}

export function checkConversion(input: ConversionCheckInput): { ok: boolean; failures: CheckFailure[] } {
  const { opp, sets, equity, limits, rules } = input;
  const failures: CheckFailure[] = [];
  if (!input.paperEnabled) failures.push({ code: "simulation_paused", message: "模拟交易已暂停，无法执行转换。" });
  if (input.kill) failures.push({ code: "kill_switch", message: "该账户已熔断，转换已停止。" });
  if (!Number.isInteger(sets) || sets < 1) failures.push({ code: "sets_invalid", message: "转换组数必须是正整数。" });
  const maxSets = Math.round(ruleValue(rules, "max-sets", 500));
  if (sets > maxSets) failures.push({ code: "sets_limit", message: `单次最多转换 ${maxSets.toLocaleString("en-US")} 组。` });
  if (sets > opp.maxSets) failures.push({ code: "depth", message: `按盘口流动性最多 ${opp.maxSets} 组。` });
  const cost = opp.basketCost * sets;
  const profit = opp.profit * sets;
  const minProfit = ruleValue(rules, "min-profit", 0.01);
  if (profit < minProfit * sets) failures.push({ code: "profit_too_small", message: `每组锁定利润低于 ${minProfit} USDC。` });
  if (ruleEnabled(rules, "min-depth") && opp.outcomes.some(o => o.liquidity < ruleValue(rules, "min-depth", 20_000))) {
    failures.push({ code: "liquidity", message: "至少一个结果的盘口流动性低于该账户阈值。" });
  }
  const settleDays = ruleEnabled(rules, "settle-freeze") ? ruleValue(rules, "settle-freeze", 1) : 0;
  const days = (Date.parse(opp.due) - Date.now()) / 86_400_000;
  if (Number.isFinite(days) && days < settleDays) failures.push({ code: "settle_freeze", message: `距结算不足 ${settleDays} 天，禁止新转换。` });
  if (ruleEnabled(rules, "daily-loss") && input.dailyLossPct <= -ruleValue(rules, "daily-loss", 1.5)) {
    failures.push({ code: "daily_loss", message: `当日回撤 ${input.dailyLossPct.toFixed(2)}%，已触发日亏损降档。` });
  }
  if (cost > equity) failures.push({ code: "capital", message: `篮子成本 ${fmtUsd(cost)} 超过账户净值 ${fmtUsd(equity)}。` });
  const limit = (id: string) => limits.find(l => l.id === id);
  const gross = negRiskLimitUsage({ conversions: input.conversions, equity, limits }).find(l => l.id === "gross");
  if (limit("gross") && gross && gross.used + cost > limit("gross")!.value) {
    failures.push({ code: "limit_gross", message: `当日转换成本将达 ${fmtUsd(gross.used + cost)}，超过限额 ${fmtUsd(limit("gross")!.value)}。` });
  }
  const market = limit("market");
  if (market && cost > market.value) failures.push({ code: "limit_market", message: `单事件成本 ${fmtUsd(cost)} 超过单标的上限 ${fmtUsd(market.value)}。` });
  const conc = limit("conc");
  if (conc && equity > 0 && cost / equity * 100 > conc.value) {
    failures.push({ code: "limit_conc", message: `单事件占净值 ${(cost / equity * 100).toFixed(1)}%，超过 ${conc.value}%。` });
  }
  return { ok: failures.length === 0, failures };
}

export function validateLimitValue(limit: Limit, used: number, value: number): CheckFailure | null {
  if (!Number.isFinite(value) || value <= 0) return { code: "limit_invalid", message: "限额必须大于 0。" };
  if (limit.kind === "pct" && value > 100) return { code: "limit_invalid", message: "百分比限额不能超过 100%。" };
  if (value < used * 1.02) {
    return {
      code: "limit_below_usage",
      message: `当前占用 ${limit.kind === "pct" ? used.toFixed(1) + "%" : fmtUsd(used)}，请留出至少 2% 缓冲。`
    };
  }
  return null;
}

function fmtUsd(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}
