import type { Repository } from "./db/repository.js";
import type { MarketService } from "./market/service.js";
import type { Engine } from "./engine/engine.js";
import type { AccountId, User } from "./domain/types.js";
import { publicConfig, liveTradingConfigured } from "./config.js";
import { dailyLossPct, getSettings, totalEquity } from "./settings.js";
import { clock, dateStr, weekday } from "./util.js";

export interface StateUser {
  id: string;
  email: string;
  name: string;
  role: User["role"];
  csrf: string;
}

/**
 * One snapshot per account. The account switcher simply asks the server for a different slice;
 * nothing is pooled except the shared market catalog and the cost model.
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
  const book = engine.book(selected.id);
  const limits = engine.limitsWithUsage(selected.id);
  const rules = engine.rules(selected.id);
  const global = engine.settings();
  const live = liveTradingConfigured();
  const positions = repo.positionsAll(selected.id);
  const exposureByEvent = new Map(book.rows.map(r => [r.evId, r.cost]));
  const equity = selected.equity;
  const portfolioEquity = totalEquity(accounts);

  return {
    version: engine.getVersion(),
    serverTime: Date.now(),
    now: {
      clock: clock(),
      date: dateStr(),
      weekday: weekday(),
      timezone: "Asia/Taipei"
    },
    user,
    csrf: user.csrf,
    config: publicConfig(),
    accountId: selected.id,
    accounts,
    portfolio: {
      equity: portfolioEquity,
      pnl: +accounts.reduce((sum, a) => sum + a.pnl, 0).toFixed(2),
      deployed: +accounts.reduce((sum, a) => sum + a.bookCost, 0).toFixed(2),
      usedPct: portfolioEquity > 0 ? accounts.reduce((sum, a) => sum + a.bookCost, 0) / portfolioEquity : 0,
      accounts: accounts.length,
      active: accounts.filter(a => a.enabled && !a.kill).length
    },
    account: {
      id: selected.id,
      name: selected.name,
      short: selected.short,
      equity,
      pnl: book.pnl,
      usedPct: equity > 0 ? (book.cost + book.margin) / equity : 0,
      dailyLossPct: dailyLossPct(repo, selected.id, equity + book.pnl)
    },
    settings: {
      auto: selected.auto,
      kill: selected.kill,
      killReason: selected.killReason,
      minEdge: selected.minEdge,
      paperFillMs: selected.paperFillMs,
      scanIntervalMs: global.scanIntervalMs,
      allowDemoFallback: global.allowDemoFallback,
      liveTradingEnabled: global.liveTradingEnabled,
      cost: global.cost
    },
    engine: {
      marketDataMode: market.mode,
      catalogMode: market.catalogMode,
      tradingMode: engine.tradingMode(),
      liveBlockedReason: engine.liveBlockedReason(),
      liveConfigured: live.all,
      liveAcknowledged: live.acknowledged,
      scanSeq: market.scanSeq,
      lastScanAt: market.lastScanAt,
      universe: market.events.length,
      version: "2.1.0",
      startedAt: Number(repo.metaGet("engineStartedAt", String(Date.now())))
    },
    venues: [market.hlStatus, market.pmStatus],
    market: market.market,
    events: engine.derived(selected.id),
    positions,
    book,
    orders: engine.orders(selected.id),
    reviews: engine.reviews(selected.id),
    audit: engine.audit(selected.id, 200),
    limits,
    rules,
    feed: repo.feedAll(selected.id, 12),
    riskEvents: repo.riskEventsAll(selected.id, 12),
    calendar: repo.calendarAll(selected.id).map(c => ({ ...c, exposure: exposureByEvent.get(c.evId) ?? c.exposure })),
    equity: repo.equityAll(selected.id)
  };
}

export function settingsSummary(repo: Repository): Record<string, unknown> {
  const s = getSettings(repo);
  return { ...s, cost: s.cost };
}
