import { randomUUID } from "node:crypto";
import type { Repository } from "../db/repository.js";
import type { AccountId } from "../domain/types.js";
import { defaultRulesFor, scaledDefaultLimits } from "../domain/risk.js";
import { ACCOUNT_DEFS, accountDef } from "../domain/accounts.js";
import { accountsAll, saveAccounts, saveSettings } from "../settings.js";
import { hashPassword } from "../auth.js";
import type { MarketService } from "../market/service.js";
import { logger } from "../logger.js";

export interface SeedAccount {
  email: string;
  password: string;
  role: "admin" | "trader" | "analyst";
  name: string;
}

export const DEFAULT_ACCOUNTS: SeedAccount[] = [
  { email: "admin@convergence.local", password: "Admin!2345", role: "admin", name: "林 · 自营" },
  { email: "trader@convergence.local", password: "Trader!2345", role: "trader", name: "陈 · 交易" },
  { email: "analyst@convergence.local", password: "Analyst!2345", role: "analyst", name: "周 · 研究" }
];

export function ensureDefaults(repo: Repository): void {
  if (repo.userCount() === 0) {
    for (const acct of DEFAULT_ACCOUNTS) {
      repo.userInsert({
        id: randomUUID(), email: acct.email, name: acct.name, role: acct.role,
        passwordHash: hashPassword(acct.password), active: true, createdAt: new Date().toISOString()
      });
    }
    logger.info({ accounts: DEFAULT_ACCOUNTS.map(a => a.email) }, "seeded default accounts");
  }
  if (!repo.settingGet<unknown>("app", null)) saveSettings(repo, { startedAt: Date.now() });
  const accounts = accountsAll(repo);
  for (const acct of accounts) {
    if (repo.limitsAll(acct.id).length === 0) repo.limitsReplace(acct.id, scaledDefaultLimits(acct.id, acct.equity));
    if (repo.rulesStored(acct.id).length === 0) repo.rulesReplace(acct.id, defaultRulesFor(acct.id));
    if (repo.equityAll(acct.id).length === 0) seedStartPoint(repo, acct.id, acct.equity);
  }
}

/**
 * Add newly introduced parameters and drop rules that no longer belong to a desk.
 * Existing on/off switches and thresholds for matching rule ids are preserved.
 */
export function ensureRuleDefaults(repo: Repository): void {
  for (const acct of ACCOUNT_DEFS) {
    const stored = new Map(repo.rulesStored(acct.id).map(r => [r.id, r]));
    const defs = defaultRulesFor(acct.id).map(def => {
      const row = stored.get(def.id);
      if (!row) return def;
      return {
        ...def,
        on: typeof row.on === "boolean" ? row.on : def.on,
        value: Number.isFinite(row.value) ? row.value : def.value
      };
    });
    repo.rulesReplace(acct.id, defs);
  }
  repo.metaSet("ruleDefaultsV4", "1");
}

/** A real account starts with one honest point: its starting capital right now. */
export function seedStartPoint(repo: Repository, accountId: AccountId, equityNow: number, t = Date.now()): void {
  repo.equityReplace(accountId, [{ t, v: +equityNow.toFixed(2) }]);
}

/**
 * One-time transition to the two-desk product: clear the retired directional
 * book and restart both desks at their own 10,000 USDC.
 */
export const STARTING_EQUITY = 10_000;

export function resetLiveBaseline(repo: Repository): void {
  repo.resetBusinessData();
  repo.eventsReplace([], true);
  const accounts = accountsAll(repo).map(a => ({
    ...a,
    equity: accountDef(a.id).defaultEquity,
    realizedPnl: 0,
    closedTrades: 0,
    wins: 0,
    enabled: true,
    auto: true,
    kill: false,
    killReason: "",
    lastKillAt: null
  }));
  saveAccounts(repo, accounts);
  const now = Date.now();
  for (const acct of accounts) {
    const start = accountDef(acct.id).defaultEquity;
    repo.limitsReplace(acct.id, scaledDefaultLimits(acct.id, start));
    repo.rulesReplace(acct.id, defaultRulesFor(acct.id));
    repo.equityReplace(acct.id, [{ t: now, v: start }]);
  }
  repo.metaSet("liveBaselineV1", "1");
  repo.metaSet("liveBaselineV2", "1");
  repo.metaSet("liveBaselineV3", "1");
  logger.info({ accounts: accounts.length, equity: accounts.map(a => a.equity) }, "baseline: rebuilt two-desk paper books");
}

/**
 * The deterministic fixture is used by tests only. The two desks run against
 * the synthetic demo universe created by MarketService; nothing is pre-seeded
 * so every conversion and fill in the fixture is produced by the real code path.
 */
export function seedTradingData(repo: Repository, _market: MarketService): void {
  if (repo.metaGet("seededTrading") === "1") return;
  repo.metaSet("seededTrading", "1");
  logger.info({ accounts: accountsAll(repo).length }, "test fixture ready; desks run from the demo universe");
}
