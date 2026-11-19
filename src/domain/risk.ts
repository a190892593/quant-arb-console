import type { Book, DerivedEvent, Limit, Rule, AccountId } from "./types.js";

export const DEFAULT_LIMITS: Limit[] = [
  { id: "pm", name: "单场所敞口 · Polymarket", desc: "按合约成本口径，含未结算头寸", value: 1_200_000, used: 0, kind: "usd" },
  { id: "hl", name: "Hyperliquid 保证金占用", desc: "维持保证金 + 缓冲，按 4.8x 折算", value: 120_000, used: 0, kind: "usd" },
  { id: "delta", name: "组合净 Delta", desc: "两腿差额的标的等值敞口", value: 250_000, used: 0, kind: "usd" },
  { id: "settle", name: "7 日内结算敞口", desc: "临近结算事件的合约成本合计", value: 300_000, used: 0, kind: "usd" },
  { id: "conc", name: "单事件集中度", desc: "最大单一事件成本占净值比例", value: 15, used: 0, kind: "pct" }
];

export const RULE_DEFS: Rule[] = [
  { id: "daily-loss", name: "日亏损降档", desc: "当日回撤达到阈值时停止开新仓，仅允许平仓与补对冲", on: true, value: 1.5, unit: "pct", min: 0.2, max: 20, step: 0.1, category: "账户护栏" },
  { id: "latency", name: "报价延迟熔断", desc: "任一场所心跳超过阈值立即暂停开仓，保留已有对冲", on: true, value: 1500, unit: "ms", min: 100, max: 10_000, step: 50, category: "账户护栏" },
  { id: "settle-freeze", name: "结算前冻结加仓", desc: "距结算小于阈值的事件只减不加；S2/S3 默认关闭，可在本账户打开", on: true, value: 2, unit: "days", min: 0, max: 14, step: 0.5, category: "账户护栏" },
  { id: "fat-edge", name: "巨边人工复核", desc: "毛边超过阈值时不自动执行，需人工确认以排除陈旧报价", on: true, value: 800, unit: "bps", min: 100, max: 10_000, step: 50, category: "账户护栏" },
  { id: "gap-fill", name: "对冲缺口自动补足", desc: "对冲缺口超过 max(本阈值, 目标对冲 × 比例阈值) 时自动补单", on: true, value: 500, unit: "usd", min: 0, max: 100_000, step: 100, category: "对冲规则" },
  { id: "gap-fill-pct", name: "对冲缺口比例阈值", desc: "目标对冲名义的比例阈值，与固定金额阈值取较大值", on: true, value: 3, unit: "pct", min: 0, max: 50, step: 0.5, category: "对冲规则" },
  { id: "max-delta", name: "单事件最大真实 Delta", desc: "事件真实 Delta 超过该倍数额度时拒绝建仓", on: true, value: 25, unit: "x", min: 1, max: 50, step: 1, category: "执行阈值" },
  { id: "bounded-tail", name: "仅允许有界尾部", desc: "拒绝空头永续 + 二元 YES 这类结算亏损无上限的结构；关闭后才会允许方向性尾部", on: true, category: "尾部风险" },
  { id: "min-qty", name: "最小合约腿数量", desc: "低于该股数的订单直接拒绝；这是硬约束", on: true, value: 100, unit: "shares", min: 100, max: 100_000, step: 100, category: "执行阈值", hard: true },
  { id: "max-order-pct", name: "单笔最大净值占比", desc: "单笔订单合约成本不得超过账户当前净值的比例", on: true, value: 25, unit: "pct", min: 1, max: 100, step: 1, category: "执行阈值" },
  { id: "manual-depth-pct", name: "人工下单盘口占比", desc: "人工执行默认使用的 Polymarket 盘口深度比例", on: true, value: 65, unit: "pct", min: 5, max: 100, step: 5, category: "执行阈值" },
  { id: "auto-size-pct", name: "自动执行单笔净值占比", desc: "自动引擎单笔目标成本占账户净值的比例", on: true, value: 6, unit: "pct", min: 0.5, max: 25, step: 0.5, category: "自动执行" },
  { id: "auto-max-notional", name: "自动单笔名义上限", desc: "自动引擎单笔合约成本上限，避免高净值时单笔过大", on: true, value: 40_000, unit: "usd", min: 100, max: 10_000_000, step: 100, category: "自动执行" },
  { id: "depth-utilization-pct", name: "盘口深度使用上限", desc: "自动订单最多使用 Polymarket 盘口深度的比例", on: true, value: 40, unit: "pct", min: 5, max: 100, step: 5, category: "自动执行" },
  { id: "auto-cooldown-sec", name: "自动执行冷却", desc: "同一账户两笔自动开仓之间的最小间隔", on: true, value: 60, unit: "sec", min: 10, max: 3600, step: 10, category: "自动执行" },
  { id: "min-confidence", name: "最低置信度", desc: "信号置信度低于该分数时只观察，不进入可执行队列", on: true, value: 62, unit: "score", min: 0, max: 100, step: 1, category: "信号过滤" },
  { id: "min-depth", name: "最低盘口深度", desc: "Polymarket 可成交深度低于该金额时只观察", on: true, value: 15_000, unit: "usd", min: 0, max: 1_000_000, step: 1000, category: "信号过滤" }
];

export const DEFAULT_RULES: Rule[] = RULE_DEFS.map(r => ({ ...r }));

/** S2/S3 trade the final convergence window, so the settlement freeze is off by default. */
export function defaultRulesFor(accountId: AccountId): Rule[] {
  return RULE_DEFS.map(r => ({
    ...r,
    on: r.id === "settle-freeze"
      ? accountId !== "converge" && accountId !== "latency"
      : r.on
  }));
}

export function ruleValue(rules: Rule[], id: string, fallback: number): number {
  const rule = rules.find(r => r.id === id);
  return Number.isFinite(rule?.value) ? Number(rule!.value) : fallback;
}

export function ruleEnabled(rules: Rule[], id: string): boolean {
  return rules.find(r => r.id === id)?.on === true;
}


export function limitUsage(book: Book, equity: number, limits: Limit[]): Limit[] {
  return limits.map(l => {
    let used = 0;
    if (l.id === "pm") used = book.cost;
    if (l.id === "hl") used = book.margin;
    if (l.id === "delta") used = Math.abs(book.netDelta);
    if (l.id === "settle") used = book.settle7;
    if (l.id === "conc") used = equity > 0 ? book.maxCost / equity * 100 : 0;
    return { ...l, used };
  });
}

export interface OrderCheckInput {
  event: DerivedEvent;
  qty: number;
  book: Book;
  limits: Limit[];
  rules: Rule[];
  equity: number;
  kill: boolean;
  auto: boolean;
  source: "manual" | "auto";
  dailyLossPct: number;
  ackFatEdge?: boolean;
  strategy?: AccountId;
}

export interface CheckFailure {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CheckResult {
  ok: boolean;
  failures: CheckFailure[];
  projected: {
    pmCost: number;
    hedgeUsd: number;
    margin: number;
    delta: number;
    settle7: number;
    concPct: number;
  };
}

export function checkOrder(input: OrderCheckInput): CheckResult {
  const { event: d, qty, book, limits, rules, equity, kill, source, dailyLossPct, ackFatEdge } = input;
  const failures: CheckFailure[] = [];  const newCost = qty * d.ask;
  const newSignedDelta = qty * d.delta;
  const newHedge = Math.abs(newSignedDelta);
  const newMargin = newHedge / 4.8;
  const pmCost = book.cost + newCost;
  const margin = book.margin + newMargin;
  // A properly filled pair adds no residual delta; the execution window is tracked separately.
  const delta = book.netDelta;
  const settle7 = book.settle7 + (d.days <= 7 ? newCost : 0);
  const concPct = equity > 0 ? Math.max(book.maxCost, newCost) / equity * 100 : 100;

  const minQty = Math.max(1, ruleValue(rules, "min-qty", 100));
  const maxDelta = ruleEnabled(rules, "max-delta") ? ruleValue(rules, "max-delta", 25) : Infinity;
  if (kill) failures.push({ code: "kill_switch", message: "熔断已触发，新开仓与补对冲均已停止。" });
  if (!(qty >= minQty)) failures.push({ code: "qty_invalid", message: `合约腿数量至少 ${minQty.toLocaleString("en-US")} 股。` });
  if (Math.abs(d.delta) > maxDelta) {
    failures.push({ code: "delta_too_large", message: `该事件真实 Delta 为 ${d.delta.toFixed(1)}x 面值，超过 ${maxDelta}x 上限，拒绝建仓。` });
  }
  if (qty > 0 && newCost > d.depth) {
    failures.push({ code: "depth_exceeded", message: `计划 ${fmtUsd(newCost)} 超过盘口可成交 ${fmtUsd(d.depth)}。` });
  }
  if (d.net <= 0 && source === "auto") {
    failures.push({ code: "negative_edge", message: "净边为负，自动执行已拒绝。" });
  }

  const rule = (id: string) => ruleEnabled(rules, id);
  if (rule("settle-freeze") && d.days < ruleValue(rules, "settle-freeze", 2)) {
    failures.push({ code: "settle_freeze", message: `结算前 ${ruleValue(rules, "settle-freeze", 2)} 天冻结加仓，只允许减仓。` });
  }
  if (rule("bounded-tail") && d.delta > 0) {
    failures.push({
      code: "unbounded_tail",
      message: "该结构使用空头永续对冲看涨二元合约，标的上涨时亏损无上限；低风险模式只允许有界尾部。"
    });
  }
  if (rule("fat-edge") && d.grossBps > ruleValue(rules, "fat-edge", 800) && source === "auto" && !ackFatEdge) {
    failures.push({ code: "fat_edge", message: `毛边超过 ${ruleValue(rules, "fat-edge", 800)}bps，需人工复核后才可执行。` });
  }
  if (rule("daily-loss") && dailyLossPct <= -ruleValue(rules, "daily-loss", 1.5)) {
    failures.push({ code: "daily_loss", message: `当日回撤 ${dailyLossPct.toFixed(2)}%，已触发日亏损降档（阈值 ${ruleValue(rules, "daily-loss", 1.5)}%）。` });
  }

  const limit = (id: string) => limits.find(l => l.id === id);
  const pm = limit("pm"), hl = limit("hl"), dl = limit("delta"), st = limit("settle"), cc = limit("conc");
  if (pm && pmCost > pm.value) failures.push({ code: "limit_pm", message: `Polymarket 敞口将达 ${fmtUsd(pmCost)}，超过限额 ${fmtUsd(pm.value)}。` });
  if (hl && margin > hl.value) failures.push({ code: "limit_hl", message: `Hyperliquid 保证金将达 ${fmtUsd(margin)}，超过限额 ${fmtUsd(hl.value)}。` });
  if (dl && Math.abs(delta) > dl.value) failures.push({ code: "limit_delta", message: `净 Delta 将达 ${fmtUsd(Math.abs(delta))}，超过限额 ${fmtUsd(dl.value)}。` });
  if (st && settle7 > st.value) failures.push({ code: "limit_settle", message: `7 日内结算敞口将达 ${fmtUsd(settle7)}，超过限额 ${fmtUsd(st.value)}。` });
  if (cc && concPct > cc.value) failures.push({ code: "limit_conc", message: `单事件集中度将达 ${concPct.toFixed(1)}%，超过限额 ${cc.value}%。` });

  return {
    ok: failures.length === 0,
    failures,
    projected: { pmCost, hedgeUsd: newHedge, margin, delta, settle7, concPct }
  };
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
