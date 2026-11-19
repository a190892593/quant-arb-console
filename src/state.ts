import type { Repository } from "./db/repository.js";
import type { MarketService } from "./market/service.js";
import type { Engine } from "./engine/engine.js";
import type { AccountId, User } from "./domain/types.js";
import { publicConfig, liveTradingConfigured } from "./config.js";
import { dailyLossPct, getSettings } from "./settings.js";
import { clock, dateStr, weekday } from "./util.js";

export interface StateUser {
  id: string;
  email: string;
  name: string;
  role: User["role"];
  csrf: string;
}

/**
 * One snapshot for the selected account plus both desks' live working sets.
 * The NegRisk ledger and the market-making book belong to their own desks, so
 * the overview can show both regardless of which account is selected.
 */
export function buildState(
  repo: Repository,
  market: MarketService,
  engine: Engine,
  user: StateUser,
  accountId: AccountId
): Record<string, unknown> {
  const accounts = engine.accountSummaries();
  const selected = accounts.find(a => a.id === accountId) ?? accounts[0]!;
  const limits = engine.limitsWithUsage(selected.id);
  const rules = engine.rules(selected.id);
  const global = engine.settings();
  const live = liveTradingConfigured();
  const equitySeries = repo.equityAll(selected.id);
  if (!equitySeries.length || Math.abs(equitySeries[equitySeries.length - 1]!.v - selected.equity) > 0.005) {
    equitySeries.push({ t: Date.now(), v: +selected.equity.toFixed(2) });
  }
  const mm = engine.mmSnapshot("marketmaking");
  const conversions = engine.conversions("negrisk");

  return {
    version: "3.0.0",
    serverTime: Date.now(),
    now: { clock: clock(), date: dateStr(), weekday: weekday(), timezone: "Asia/Taipei" },
    user,
    csrf: user.csrf,
    config: publicConfig(),
    accountId: selected.id,
    accounts,
    negRisk: engine.negRiskOpportunities(),
    conversions,
    mm,
    portfolio: {
      equity: +accounts.reduce((s, a) => s + a.equity, 0).toFixed(2),
      startingEquity: +accounts.reduce((s, a) => s + a.startingEquity, 0).toFixed(2),
      pnl: +accounts.reduce((s, a) => s + a.pnl, 0).toFixed(2),
      realizedPnl: +accounts.reduce((s, a) => s + a.realizedPnl, 0).toFixed(2),
      totalPnl: +accounts.reduce((s, a) => s + a.totalPnl, 0).toFixed(2),
      deployed: +accounts.reduce((s, a) => s + a.bookCost, 0).toFixed(2),
      usedPct: 0,
      accounts: accounts.length,
      active: accounts.filter(a => a.enabled && !a.kill).length
    },
    account: {
      id: selected.id,
      name: selected.name,
      short: selected.short,
      equity: selected.equity,
      startingEquity: selected.startingEquity,
      realizedPnl: selected.realizedPnl,
      totalPnl: selected.totalPnl,
      returnPct: selected.returnPct,
      closedTrades: selected.closedTrades,
      wins: selected.wins,
      pnl: selected.pnl,
      usedPct: selected.usedPct,
      dailyLossPct: dailyLossPct(repo, selected.id, selected.equity)
    },
    settings: {
      auto: selected.auto,
      kill: selected.kill,
      killReason: selected.killReason,
      minEdge: selected.minEdge,
      paperFillMs: selected.paperFillMs,
      scanIntervalMs: global.scanIntervalMs,
      liveTradingEnabled: global.liveTradingEnabled,
      paperTradingEnabled: global.paperTradingEnabled,
      cost: global.cost
    },
    engine: {
      marketDataMode: market.mode,
      catalogMode: market.catalogMode,
      tradingMode: engine.tradingMode(),
      paperTradingEnabled: global.paperTradingEnabled,
      liveBlockedReason: engine.liveBlockedReason(),
      liveConfigured: live.all,
      liveAcknowledged: live.acknowledged,
      scanSeq: market.scanSeq,
      lastScanAt: market.lastScanAt,
      universe: market.mmUniverse.length,
      version: "3.0.0",
      startedAt: Number(repo.metaGet("engineStartedAt", String(Date.now())))
    },
    venues: [market.hlStatus, market.pmStatus],
    market: market.market,
    limits,
    rules,
    audit: engine.audit(selected.id, 200),
    feed: repo.feedAll(selected.id, 20),
    riskEvents: repo.riskEventsAll(selected.id, 20),
    equity: equitySeries
  };
}

export function settingsSummary(repo: Repository): Record<string, unknown> {
  const s = getSettings(repo);
  return { ...s, cost: s.cost };
}
