import type { Repository } from "./db/repository.js";
import { DEFAULT_COST } from "./domain/pricing.js";
import type { AccountId, AccountSettings, CostConfig } from "./domain/types.js";
import { accountDef, defaultAccountSettings, mergeAccountSettings } from "./domain/accounts.js";

/** Global, non-financial settings shared by the process (market data, scan cadence, cost model). */
export interface AppSettings {
  scanIntervalMs: number;
  cost: CostConfig;
  liveTradingEnabled: boolean;
  paperTradingEnabled: boolean;
  startedAt: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  scanIntervalMs: 2500,
  cost: { ...DEFAULT_COST },
  liveTradingEnabled: false,
  paperTradingEnabled: true,
  startedAt: Date.now()
};

export function getSettings(repo: Repository): AppSettings {
  const stored = repo.settingGet<Partial<AppSettings>>("app", {});
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    cost: { ...DEFAULT_COST, ...(stored.cost ?? {}) }
  };
}

export function saveSettings(repo: Repository, patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(repo), ...patch };
  next.cost = { ...DEFAULT_COST, ...next.cost };
  repo.settingSet("app", next);
  return next;
}

/**
 * Two independent desks. Equity, auto-execution, kill switch, min edge and paper-fill
 * latency are per account; only the shared market/cost configuration lives globally.
 */
export function accountsAll(repo: Repository): AccountSettings[] {
  const stored = repo.settingGet<Array<Partial<AccountSettings>> | null>("accounts", null);
  if (!stored) {
    const legacy = repo.settingGet<{ auto?: boolean; kill?: boolean; minEdge?: number; paperFillMs?: number } | null>("app", null);
    // Only the NegRisk desk inherits the old single-book switches; market making starts on its own defaults.
    const seeded = defaultAccountSettings().map(a => a.id !== "negrisk" ? a : {
      ...a,
      auto: typeof legacy?.auto === "boolean" ? legacy.auto : a.auto,
      kill: typeof legacy?.kill === "boolean" ? legacy.kill : a.kill,
      minEdge: Number.isFinite(legacy?.minEdge) ? Number(legacy!.minEdge) : a.minEdge,
      paperFillMs: Number.isFinite(legacy?.paperFillMs) ? Number(legacy!.paperFillMs) : a.paperFillMs
    });
    repo.settingSet("accounts", seeded);
    return seeded;
  }
  return mergeAccountSettings(stored);
}

export function accountSettings(repo: Repository, id: AccountId): AccountSettings {
  return accountsAll(repo).find(a => a.id === id) ?? {
    ...defaultAccountSettings().find(a => a.id === id)!,
    ...accountDef(id)
  };
}

export function saveAccountSettings(repo: Repository, id: AccountId, patch: Partial<AccountSettings>): AccountSettings {
  const next = accountsAll(repo).map(a => a.id === id ? { ...a, ...patch, id } : a);
  repo.settingSet("accounts", mergeAccountSettings(next));
  return next.find(a => a.id === id)!;
}

export function saveAccounts(repo: Repository, accounts: AccountSettings[]): AccountSettings[] {
  const merged = mergeAccountSettings(accounts);
  repo.settingSet("accounts", merged);
  return merged;
}

export function totalEquity(accounts: AccountSettings[]): number {
  return accounts.reduce((sum, a) => sum + a.equity, 0);
}

export function dailyLossPct(repo: Repository, accountId: AccountId, currentEquity: number): number {
  const points = repo.equityAll(accountId);
  if (!points.length) return 0;
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const base = points.find(p => p.t >= dayStart.getTime()) ?? points[0]!;
  if (!(base.v > 0)) return 0;
  return (currentEquity / base.v - 1) * 100;
}
