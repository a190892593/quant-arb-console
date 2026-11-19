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
 * Two deterministic desks, one account each: protocol-level NegRisk conversion
 * and high-liquidity market making. The retired directional strategies are gone.
 */
export const ACCOUNT_DEFS: readonly AccountDef[] = [
  {
    id: "negrisk",
    name: "NegRisk 转换",
    short: "NEG",
    desc: "多结果互斥事件中，所有结果的 YES 买价合计高于 100¢ 时，买入全部 NO 篮子，经 NegRisk Adapter 转换为 YES 后按买价卖出。",
    logic: "只做 NegRisk 多结果事件；一次买入每个结果的 1 份 NO，转换后卖出全部 YES，成交瞬间锁定 n × (ΣYES买价 − 1) 的协议层价差，账本不留方向敞口。",
    holdLabel: "成交即锁定",
    paperFillMs: 400,
    maxOpen: 6,
    defaultEquity: 10_000,
    defaultMinEdge: 0.5
  },
  {
    id: "marketmaking",
    name: "高流动性做市",
    short: "MM",
    desc: "在成交最活跃、盘口最厚的二元市场双边报价，赚取买卖价差；用库存偏斜与减仓线管理方向风险。",
    logic: "只做 24h 成交额与盘口深度达标、价差足够覆盖风险的市场；按库存偏移双边报价，成交后按中价盯市，库存触及减仓线时只报减仓方向或直接平仓。",
    holdLabel: "秒–分钟",
    paperFillMs: 200,
    maxOpen: 8,
    defaultEquity: 10_000,
    defaultMinEdge: 0
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
    lastKillAt: null,
    realizedPnl: 0,
    closedTrades: 0,
    wins: 0
  }));
}

/** Merge persisted accounts with the current definitions so new desks appear automatically. */
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
      lastKillAt: Number.isFinite(s?.lastKillAt) ? (s!.lastKillAt as number) : null,
      realizedPnl: Number.isFinite(s?.realizedPnl) ? (s!.realizedPnl as number) : 0,
      closedTrades: Number.isFinite(s?.closedTrades) ? Math.max(0, Math.round(s!.closedTrades as number)) : 0,
      wins: Number.isFinite(s?.wins) ? Math.max(0, Math.round(s!.wins as number)) : 0
    };
  });
}

/** Neither desk uses the retired single-event directional screen. */
export function eligibleFor(_id: AccountId, _ev: EventContract, _market: Market, _now = Date.now()): boolean {
  return false;
}

export function assertAccountWithinBudget(equity: number, deployed: number, nextEquity: number): string | null {
  if (!Number.isFinite(nextEquity) || nextEquity < 0) return "账户净值必须为非负数";
  if (nextEquity < deployed * 0.98) return "账户净值不能低于已部署资金的 98%";
  return null;
}
