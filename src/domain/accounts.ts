import type { AccountId, AccountSettings, EventContract, Market } from "./types.js";

export interface AccountDef {
  id: AccountId;
  name: string;
  short: string;
  desc: string;
  logic: string;
  holdLabel: string;
  paperFillMs: number;
  maxOpen: number;
  defaultEquity: number;
  defaultMinEdge: number;
  requiresRealtime?: boolean;
}

/**
 * One strategy, one account. Accounts never share equity, positions, limits or kill switches.
 * The four definitions below are the only place where the desk is configured.
 */
export const ACCOUNT_DEFS: readonly AccountDef[] = [
  {
    id: "prob",
    name: "概率偏差",
    short: "PROB",
    desc: "Polymarket 二元合约与 Hyperliquid 数字期权公允值之间的概率差。",
    logic: "只做 2–60 天事件；买入被低估的 YES，用永续空头对冲 Delta，持有到收敛或结算。",
    holdLabel: "2–60 天",
    paperFillMs: 4200,
    maxOpen: 3,
    defaultEquity: 620_000,
    defaultMinEdge: 2.5
  },
  {
    id: "converge",
    name: "结算收敛",
    short: "CONV",
    desc: "临近结算、结果已高度确定的合约仍以折价成交，赚取最后一档收敛。",
    logic: "只买公充概率 ≥ 82% 且剩余 ≤ 72 小时的合约；尾部用永续做小比例对冲。",
    holdLabel: "< 72 小时",
    paperFillMs: 2200,
    maxOpen: 2,
    defaultEquity: 300_000,
    defaultMinEdge: 1.2
  },
  {
    id: "latency",
    name: "报价滞后",
    short: "LAG",
    desc: "Hyperliquid 标记价已经移动，Polymarket 报价仍是数秒前的陈旧盘口。",
    logic: "只做 14 天内事件；抢陈旧卖价并立刻用永续对冲，吃报价追平前的瞬时差；持有以分钟计。",
    holdLabel: "秒–分钟",
    paperFillMs: 600,
    maxOpen: 2,
    defaultEquity: 140_000,
    defaultMinEdge: 1.5,
    requiresRealtime: true
  },
  {
    id: "longvol",
    name: "长端波动率",
    short: "VOL",
    desc: "长周期数字期权对波动率假设最敏感，模型与长端报价的偏差更持久。",
    logic: "只做 60 天以上事件；按 90 日已实现波动率加溢价建模，买入低估 YES 并用永续对冲。",
    holdLabel: "60–365 天",
    paperFillMs: 5200,
    maxOpen: 2,
    defaultEquity: 224_930.22,
    defaultMinEdge: 3.0
  }
];

export const ACCOUNT_IDS: readonly AccountId[] = ACCOUNT_DEFS.map(a => a.id);

export function accountDef(id: AccountId): AccountDef {
  return ACCOUNT_DEFS.find(a => a.id === id) ?? ACCOUNT_DEFS[0]!;
}

export function isAccountId(value: unknown): value is AccountId {
  return typeof value === "string" && ACCOUNT_IDS.includes(value as AccountId);
}

export function defaultAccountSettings(): AccountSettings[] {
  return ACCOUNT_DEFS.map(def => ({
    id: def.id,
    enabled: true,
    equity: def.defaultEquity,
    auto: true,
    kill: false,
    killReason: "",
    minEdge: def.defaultMinEdge,
    paperFillMs: def.paperFillMs,
    lastKillAt: null
  }));
}

/** Merge persisted accounts with the current definitions so new accounts appear automatically. */
export function mergeAccountSettings(stored?: Array<Partial<AccountSettings>> | null): AccountSettings[] {
  const byId = new Map((stored ?? []).filter(a => isAccountId(a.id)).map(a => [a.id as AccountId, a]));
  return ACCOUNT_DEFS.map(def => {
    const s = byId.get(def.id);
    return {
      id: def.id,
      enabled: typeof s?.enabled === "boolean" ? s.enabled : true,
      equity: Number.isFinite(s?.equity) && (s!.equity as number) >= 0 ? (s!.equity as number) : def.defaultEquity,
      auto: typeof s?.auto === "boolean" ? s.auto : true,
      kill: typeof s?.kill === "boolean" ? s.kill : false,
      killReason: typeof s?.killReason === "string" ? s.killReason : "",
      minEdge: Number.isFinite(s?.minEdge) && (s!.minEdge as number) >= 0 ? (s!.minEdge as number) : def.defaultMinEdge,
      paperFillMs: Number.isFinite(s?.paperFillMs) && (s!.paperFillMs as number) >= 200 ? (s!.paperFillMs as number) : def.paperFillMs,
      lastKillAt: Number.isFinite(s?.lastKillAt) ? (s!.lastKillAt as number) : null
    };
  });
}

export const LATENCY_MIN_AGE_MS = 6_000;
export const LATENCY_MAX_DAYS = 14;
export const CONVERGE_MAX_DAYS = 3;
export const CONVERGE_MIN_FAIR = 0.82;

/**
 * Each account scans the whole market with its own eligibility rule. Accounts are independent,
 * so the same event may legitimately be traded by more than one desk.
 */
export function eligibleFor(id: AccountId, ev: EventContract, market: Market, now = Date.now()): boolean {
  const days = (Date.parse(ev.due) - now) / 86_400_000;
  if (days <= 0) return false;
  switch (id) {
    case "converge":
      return days <= CONVERGE_MAX_DAYS && ev.fair >= CONVERGE_MIN_FAIR && ev.fair <= 0.995;
    case "latency": {
      if (days > LATENCY_MAX_DAYS) return false;
      const gross = (ev.fair - (ev.ask + ev.bid) / 2) * 100;
      const age = ev.quoteAgeMs ?? 0;
      const moved = ev.quoteRefPx && market[ev.und]?.px
        ? Math.abs(market[ev.und]!.px / ev.quoteRefPx - 1)
        : 0;
      return age >= LATENCY_MIN_AGE_MS && gross >= 1.2 && (moved >= 0.0004 || gross >= 2);
    }
    case "longvol":
      return days > 60;
    case "prob":
    default:
      return days > 1.2 && days <= 60;
  }
}

export function assertAccountWithinBudget(equity: number, deployed: number, nextEquity: number): string | null {
  if (!Number.isFinite(nextEquity) || nextEquity < 0) return "账户净值必须为非负数";
  if (nextEquity < deployed * 0.98) return "账户净值不能低于已部署资金的 98%";
  return null;
}
