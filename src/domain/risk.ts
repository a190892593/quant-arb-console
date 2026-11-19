import type { Book, DerivedEvent, Limit, Rule, AccountId } from "./types.js";

export const DEFAULT_LIMITS: Limit[] = [
  { id: "pm", name: "单场所敞口 · Polymarket", desc: "按合约成本口径，含未结算头寸", value: 1_200_000, used: 0, kind: "usd" },
  { id: "hl", name: "Hyperliquid 保证金占用", desc: "维持保证金 + 缓冲，按 4.8x 折算", value: 120_000, used: 0, kind: "usd" },
  { id: "delta", name: "组合净 Delta", desc: "两腿差额的标的等值敞口", value: 250_000, used: 0, kind: "usd" },
  { id: "settle", name: "7 日内结算敞口", desc: "临近结算事件的合约成本合计", value: 300_000, used: 0, kind: "usd" },
  { id: "conc", name: "单事件集中度", desc: "最大单一事件成本占净值比例", value: 15, used: 0, kind: "pct" }
];

export const DEFAULT_RULES: Rule[] = [
  { id: "daily-loss", name: "日亏损降档", desc: "当日回撤 ≥ 1.5% 时停止开新仓，仅允许平仓与补对冲", on: true },
  { id: "latency", name: "报价延迟熔断", desc: "任一场所心跳 > 800ms 立即暂停开仓，保留已有对冲", on: true },
  { id: "settle-freeze", name: "结算前冻结加仓", desc: "48 小时内结算的事件只减不加，避免结算滑点", on: true },
  { id: "fat-edge", name: "巨边人工复核", desc: "净边 > 800bps 不自动执行，先排除陈旧报价", on: true },
  { id: "gap-fill", name: "对冲缺口自动补足", desc: "缺口 > $2,500 时按对手价补单，最多追 3 次", on: true }
];

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

  if (kill) failures.push({ code: "kill_switch", message: "熔断已触发，新开仓与补对冲均已停止。" });
  if (!(qty >= 100)) failures.push({ code: "qty_invalid", message: "合约腿数量至少 100 股。" });
  if (Math.abs(d.delta) > 25) {
    failures.push({ code: "delta_too_large", message: `该事件真实 Delta 为 ${d.delta.toFixed(1)}x 面值，超过 25x 上限，拒绝建仓。` });
  }
  if (qty > 0 && newCost > d.depth) {
    failures.push({ code: "depth_exceeded", message: `计划 ${fmtUsd(newCost)} 超过盘口可成交 ${fmtUsd(d.depth)}。` });
  }
  if (d.net <= 0 && source === "auto") {
    failures.push({ code: "negative_edge", message: "净边为负，自动执行已拒绝。" });
  }

  const rule = (id: string) => rules.find(r => r.id === id)?.on === true;
  const nearExpiryDesk = input.strategy === "converge" || input.strategy === "latency";
  if (rule("settle-freeze") && d.days < 2 && !nearExpiryDesk) {
    failures.push({ code: "settle_freeze", message: "结算前 48 小时冻结加仓，只允许减仓。" });
  }
  if (rule("fat-edge") && d.grossBps > 800 && source === "auto" && !ackFatEdge) {
    failures.push({ code: "fat_edge", message: "毛边超过 800bps，需人工复核后才可执行。" });
  }
  if (rule("daily-loss") && dailyLossPct <= -1.5) {
    failures.push({ code: "daily_loss", message: `当日回撤 ${dailyLossPct.toFixed(2)}%，已触发日亏损降档。` });
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
