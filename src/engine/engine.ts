import type { Repository } from "../db/repository.js";
import type { MarketService } from "../market/service.js";
import type {
  AccountId, AccountSettings, AccountSummary, AuditEntry, Conversion, Limit, MmFill, MmMarket,
  MmParams, MmPosition, MmSnapshot, MmTotals, NegRiskOpportunity, Rule
} from "../domain/types.js";
import { ACCOUNT_DEFS, accountDef, isAccountId } from "../domain/accounts.js";
import {
  checkConversion, defaultRulesFor, mmLimitUsage, mmParamsFromRules, negRiskLimitUsage, ruleEnabled, ruleValue,
  scaledDefaultLimits, validateLimitValue, type CheckFailure
} from "../domain/risk.js";
import { buildConversion, evaluateNegRisk } from "../domain/negrisk.js";
import { applyFill, computeQuote, marketEligible, matchTrades, microprice, spreadBps, unrealizedPnl } from "../domain/mm.js";
import { config, liveTradingConfigured } from "../config.js";
import { accountsAll, dailyLossPct, getSettings, saveAccountSettings, saveSettings, type AppSettings } from "../settings.js";
import { clock, hhmm, signedUsd, usd } from "../util.js";
import { logger } from "../logger.js";

export interface EngineEvent {
  type: "state" | "tick" | "toast";
  version: number;
  payload?: unknown;
}

export type EngineListener = (event: EngineEvent) => void;

export interface Actor {
  id: string;
  name: string;
  role: "admin" | "trader" | "analyst";
}

export class EngineError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = "EngineError";
  }
}

interface QuoteState {
  bid: number;
  ask: number;
  size: number;
  mid: number;
  quoteAt: number;
  status: MmMarket["status"];
  statusText: string;
  skewBps: number;
}

function emptyPosition(marketId: string, title: string): MmPosition {
  return {
    marketId, title, inventory: 0, avg: 0, realized: 0, fees: 0, fills: 0,
    paused: false, lastFillAt: null, updatedAt: Date.now()
  };
}

export class Engine {
  private listeners = new Set<EngineListener>();
  private timers: NodeJS.Timeout[] = [];
  private version = 0;
  private persistedAt = 0;
  private mmBusy = false;
  private mmQuotes = new Map<string, QuoteState>();
  private mmHaltUntil = new Map<string, number>();
  private mmMids = new Map<string, number>();
  private mmLastTradeTs = 0;

  constructor(private readonly repo: Repository, private readonly market: MarketService) {}

  /* ---------------- lifecycle ---------------- */
  start(): void {
    if (this.timers.length) return;
    const settings = getSettings(this.repo);
    this.timers.push(setInterval(() => void this.scanTick(), Math.max(1000, settings.scanIntervalMs)));
    this.timers.push(setInterval(() => void this.mmTick(), 6_000));
    this.timers.push(setInterval(() => this.persist(), 15_000));
    this.timers.push(setInterval(() => this.repo.sessionsCleanup(), 3_600_000));
    logger.info({ scanIntervalMs: settings.scanIntervalMs, accounts: this.accounts().length }, "two-desk engine started");
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.persist();
  }

  restartTimers(): void {
    this.stop();
    this.start();
  }

  onChange(fn: EngineListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type: EngineEvent["type"], payload?: unknown): void {
    if (type === "state") this.version += 1;
    const event = { type, version: this.version, payload };
    for (const fn of this.listeners) {
      try { fn(event); } catch { /* listeners must not break the engine */ }
    }
  }

  private async scanTick(): Promise<void> {
    try {
      await this.market.tick();
      this.emit("tick", {
        market: this.market.market,
        scanSeq: this.market.scanSeq,
        lastScanAt: this.market.lastScanAt,
        venues: [this.market.hlStatus, this.market.pmStatus],
        catalogMode: this.market.catalogMode,
        negRisk: this.market.negRisk.length,
        mmUniverse: this.market.mmUniverse.length
      });
      for (const account of this.accounts()) this.sampleEquity(account.id);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "scan tick failed");
    }
  }

  persist(): void {
    if (Date.now() - this.persistedAt < 5_000) return;
    this.persistedAt = Date.now();
    this.market.persist();
  }

  getVersion(): number { return this.version; }

  /* ---------------- accounts ---------------- */
  settings(): AppSettings { return getSettings(this.repo); }

  accounts(): AccountSettings[] { return accountsAll(this.repo); }

  account(id: AccountId): AccountSettings {
    const found = this.accounts().find(a => a.id === id);
    if (!found) throw new EngineError("account_not_found", "账户不存在", 404);
    return found;
  }

  accountSummaries(): AccountSummary[] {
    return this.accounts().map(a => this.summary(a));
  }

  private summary(a: AccountSettings): AccountSummary {
    const def = accountDef(a.id);
    const realized = a.realizedPnl ?? 0;
    let unrealized = 0;
    let bookCost = 0;
    let netDelta = 0;
    let positions = 0;
    let signals = 0;
    let ready = 0;
    let closedTrades = a.closedTrades ?? 0;

    if (a.id === "negrisk") {
      const conversions = this.repo.conversionsAll(a.id, 1000);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      bookCost = conversions.filter(c => c.createdAt >= today.getTime()).reduce((s, c) => s + c.cost, 0);
      signals = this.market.negRisk.length;
      ready = this.market.negRisk.filter(o => o.status === "ready").length;
      closedTrades = conversions.length;
    } else {
      const positionsRows = this.repo.mmPositionsAll(a.id);
      const byMarket = new Map(this.market.mmUniverse.map(m => [m.id, m]));
      for (const p of positionsRows) {
        if (!p.inventory) continue;
        const m = byMarket.get(p.marketId);
        const top = m ? this.market.mmBooks[m.yesTokenId] : undefined;
        const mid = m ? microprice({
          bestBid: top?.bestBid ?? m.bestBid, bestAsk: top?.bestAsk ?? m.bestAsk,
          bidSize: top?.bidSize ?? 0, askSize: top?.askSize ?? 0
        }) || (m.bestBid + m.bestAsk) / 2 : p.avg;
        unrealized += p.inventory * (mid - p.avg);
        bookCost += Math.abs(p.inventory) * mid;
        netDelta += p.inventory * mid;
        positions += 1;
      }
      signals = this.market.mmUniverse.length;
      ready = [...this.mmQuotes.values()].filter(q => q.bid > 0 || q.ask > 0).length;
      closedTrades = positionsRows.reduce((s, p) => s + p.fills, 0);
    }

    const equity = Math.max(0, a.equity + realized + unrealized);
    const totalPnl = realized + unrealized;
    return {
      ...a,
      name: def.name, short: def.short, desc: def.desc, logic: def.logic, holdLabel: def.holdLabel,
      maxOpen: def.maxOpen, requiresRealtime: def.requiresRealtime === true,
      equity: +equity.toFixed(2),
      startingEquity: a.equity,
      realizedPnl: +realized.toFixed(2),
      totalPnl: +totalPnl.toFixed(2),
      returnPct: a.equity > 0 ? totalPnl / a.equity : 0,
      pnl: +unrealized.toFixed(2),
      usedPct: equity > 0 ? bookCost / equity : 0,
      positions,
      openOrders: 0,
      signals,
      ready,
      dailyLossPct: dailyLossPct(this.repo, a.id, equity),
      bookCost: +bookCost.toFixed(2),
      netDelta: +netDelta.toFixed(2),
      closedTrades,
      wins: a.wins ?? 0
    };
  }

  derived(): never[] { return []; }

  currentEquity(accountId: AccountId): number {
    return this.summary(this.account(accountId)).equity;
  }

  limits(accountId: AccountId): Limit[] {
    const rows = this.repo.limitsAll(accountId);
    return rows.length ? rows : scaledDefaultLimits(accountId, this.account(accountId).equity);
  }

  rules(accountId: AccountId): Rule[] {
    const defs = defaultRulesFor(accountId);
    const stored = new Map(this.repo.rulesAll(accountId).map(r => [r.id, r]));
    return defs.map(def => {
      const row = stored.get(def.id);
      return row ? { ...def, on: row.on, value: Number.isFinite(row.value) ? row.value : def.value } : def;
    });
  }

  limitsWithUsage(accountId: AccountId): Limit[] {
    const equity = this.currentEquity(accountId);
    const limits = this.limits(accountId);
    if (accountId === "negrisk") {
      return negRiskLimitUsage({ conversions: this.repo.conversionsAll(accountId, 1000), equity, limits });
    }
    return mmLimitUsage({
      markets: this.mmMarkets(accountId), positions: this.repo.mmPositionsAll(accountId), equity, limits
    });
  }

  audit(accountId?: AccountId | null, limit = 200): AuditEntry[] {
    return this.repo.auditAll({ accountId: accountId ?? null, limit });
  }

  tradingMode(): "paper" | "live" {
    if (config.tradingMode !== "live") return "paper";
    const live = liveTradingConfigured();
    const settings = getSettings(this.repo);
    if (live.all && live.acknowledged && settings.liveTradingEnabled) return "live";
    return "paper";
  }

  liveBlockedReason(): string | null {
    if (config.tradingMode !== "live") return null;
    const live = liveTradingConfigured();
    if (!live.all) return "TRADING_MODE=live，但交易所私有凭据不完整";
    if (!live.acknowledged) return "缺少 LIVE_TRADING_ACK=I_UNDERSTAND_LIVE_TRADING";
    if (!getSettings(this.repo).liveTradingEnabled) return "管理后台尚未启用实盘执行";
    return null;
  }

  /* ---------------- audit / feed ---------------- */
  log(actor: Actor, accountId: AccountId, action: string, obj: string, venue: string, detail: string): void {
    this.repo.auditAdd({
      accountId, t: clock(), actor: actor.name, actorId: actor.id,
      action, obj, venue, detail
    });
  }

  logGlobal(actor: Actor, action: string, obj: string, venue: string, detail: string): void {
    this.repo.auditAdd({ t: clock(), actor: actor.name, actorId: actor.id, action, obj, venue, detail });
  }

  feed(accountId: AccountId, item: { kind: "ok" | "warn"; title: string; detail: string; val: string }): void {
    this.repo.feedAdd({ accountId, t: hhmm(), ...item });
  }

  riskEvent(accountId: AccountId, item: { level: "ok" | "warn" | "bad"; title: string; detail: string; val: string }): void {
    this.repo.riskEventAdd({ accountId, t: hhmm(), ...item });
  }

  private touch(): void { this.emit("state"); }

  /* ============================================================
     Desk 1 · NegRisk conversion
     ============================================================ */

  negRiskOpportunities(): NegRiskOpportunity[] { return this.market.negRisk; }

  conversions(accountId: AccountId): Conversion[] {
    return this.repo.conversionsAll(accountId, 200);
  }

  executeConversion(user: Actor, accountId: AccountId, opportunityId: string, sets: number): Conversion {
    if (!isAccountId(accountId) || accountId !== "negrisk") {
      throw new EngineError("desk_mismatch", "NegRisk 转换只能在 NegRisk 账户执行", 409);
    }
    const account = this.account(accountId);
    if (!account.enabled) throw new EngineError("account_disabled", "该账户已被管理员停用", 409);
    if (!this.paperTradingEnabled()) throw new EngineError("simulation_paused", "模拟交易已暂停，无法执行转换", 409);
    const raw = this.market.negRisk.find(o => o.id === opportunityId);
    if (!raw) throw new EngineError("opportunity_not_found", "该 NegRisk 事件已不在扫描面，请刷新后重试", 404);
    const rules = this.rules(accountId);
    const feeBps = ruleEnabled(rules, "fee-buffer") ? ruleValue(rules, "fee-buffer", 20) : raw.feeBps;
    const opp = evaluateNegRisk({
      id: raw.id, title: raw.title, slug: raw.slug, negRiskMarketId: raw.negRiskMarketId,
      due: raw.due, outcomes: raw.outcomes
    }, feeBps) ?? raw;
    if (opp.status !== "ready") throw new EngineError("opportunity_not_ready", opp.reason || "该篮子暂时不可执行", 409);
    const qty = Math.floor(Number(sets));
    const equity = this.currentEquity(accountId);
    const check = checkConversion({
      opp, sets: qty, equity, conversions: this.repo.conversionsAll(accountId, 1000),
      limits: this.limitsWithUsage(accountId), rules,
      kill: account.kill, paperEnabled: this.paperTradingEnabled(),
      dailyLossPct: dailyLossPct(this.repo, accountId, equity)
    });
    if (!check.ok) throw new EngineError("risk_rejected", check.failures.map((f: CheckFailure) => f.message).join(" "), 409);

    const conv = buildConversion({ id: "CV-" + this.repo.nextSeq("conversionSeq", 1001), accountId, opp, sets: qty });
    this.repo.conversionAdd(conv);
    this.realizePnl(accountId, conv.profit, 1, conv.profit > 0 ? 1 : 0);
    this.log(user, accountId, "NegRisk 转换", conv.title, "PM · NegRisk Adapter",
      `${qty} 组 × ${conv.n} 个结果：成本 ${usd(conv.cost, 2)}，卖出 ${usd(conv.proceeds, 2)}，费用 ${usd(conv.fee, 2)}，锁定 ${signedUsd(conv.profit, 2)}`);
    this.feed(accountId, { kind: "ok", title: `转换锁定 ${conv.title}`, detail: `${qty} 组 · 净利 ${signedUsd(conv.profit, 2)}`, val: "已锁定" });
    this.touch();
    return conv;
  }

  /* ============================================================
     Desk 2 · Market making
     ============================================================ */

  mmParams(accountId: AccountId): MmParams {
    return mmParamsFromRules(this.rules(accountId));
  }

  mmMarkets(accountId: AccountId): MmMarket[] {
    const positions = this.repo.mmPositionsAll(accountId);
    const byId = new Map(positions.map(p => [p.marketId, p]));
    const now = Date.now();
    const prices = this.market.mmBooks;
    const params = this.mmParams(accountId);
    const rows: MmMarket[] = [];
    for (const m of this.market.mmUniverse) {
      const pos = byId.get(m.id);
      const top = prices[m.yesTokenId];
      const bestBid = top?.bestBid ?? m.bestBid;
      const bestAsk = top?.bestAsk ?? m.bestAsk;
      const mid = microprice({ bestBid, bestAsk, bidSize: top?.bidSize ?? 0, askSize: top?.askSize ?? 0 })
        || (bestBid + bestAsk) / 2;
      const q = this.mmQuotes.get(m.id);
      const fallback = q ? null : computeQuote({
        top: { bestBid, bestAsk, bidSize: top?.bidSize ?? 0, askSize: top?.askSize ?? 0 },
        inventory: pos?.inventory ?? 0, params, paused: pos?.paused ?? false
      });
      const quote = q ?? fallback!;
      rows.push({
        id: m.id, conditionId: m.conditionId, title: m.title, slug: m.slug, category: m.category, due: m.due,
        yesTokenId: m.yesTokenId, noTokenId: m.noTokenId,
        bestBid, bestAsk, bidSize: top?.bidSize ?? 0, askSize: top?.askSize ?? 0,
        mid: +mid.toFixed(6), fair: +(q?.mid ?? mid).toFixed(6),
        spreadBps: +spreadBps(bestBid, bestAsk, mid).toFixed(1),
        depthUsd: Math.round(top?.depthUsd ?? m.liquidity),
        liquidity: m.liquidity, volume24h: m.volume24h,
        quoteBid: quote.bid, quoteAsk: quote.ask, quoteSize: quote.size,
        quoteNotional: +((quote.size) * mid).toFixed(2), quoteAt: q?.quoteAt ?? 0,
        inventory: pos?.inventory ?? 0, avg: pos?.avg ?? 0, realized: +(pos?.realized ?? 0).toFixed(6),
        unrealized: +unrealizedPnl(pos ?? emptyPosition(m.id, m.title), mid).toFixed(6),
        fills: pos?.fills ?? 0, skewBps: quote.skewBps, edgeBps: params.targetEdgeBps,
        paused: pos?.paused ?? false,
        status: q ? quote.status : "idle",
        statusText: q ? quote.statusText : "等待首次报价",
        lastFillAt: pos?.lastFillAt ?? null,
        updatedAt: now
      });
    }
    return rows.sort((a, b) => {
      const held = Math.abs(b.inventory) - Math.abs(a.inventory);
      if (held !== 0) return held;
      return b.volume24h - a.volume24h;
    });
  }

  mmSnapshot(accountId: AccountId): MmSnapshot {
    const markets = this.mmMarkets(accountId);
    const positions = this.repo.mmPositionsAll(accountId);
    const max = this.mmParams(accountId).maxMarkets;
    const scoped = markets.filter((m, i) => i < max || m.inventory !== 0);
    const totals: MmTotals = {
      quoted: scoped.filter(m => m.quoteBid > 0 || m.quoteAsk > 0).length,
      markets: scoped.length,
      inventoryUsd: +scoped.reduce((s, m) => s + Math.abs(m.inventory * m.mid), 0).toFixed(2),
      grossInventoryUsd: +scoped.reduce((s, m) => s + m.inventory * m.mid, 0).toFixed(2),
      realized: +positions.reduce((s, p) => s + p.realized, 0).toFixed(2),
      unrealized: +scoped.reduce((s, m) => s + m.unrealized, 0).toFixed(2),
      fills: positions.reduce((s, p) => s + p.fills, 0),
      quoteNotional: +scoped.reduce((s, m) => s + m.quoteNotional * ((m.quoteBid > 0 ? 1 : 0) + (m.quoteAsk > 0 ? 1 : 0)), 0).toFixed(2)
    };
    return {
      markets: scoped, fills: this.repo.mmFillsAll(accountId, 100), positions, totals,
      params: this.mmParams(accountId), updatedAt: Math.max(0, ...scoped.map(m => m.quoteAt)),
      halted: this.account(accountId).kill || !this.paperTradingEnabled()
    };
  }

  private async mmTick(): Promise<void> {
    if (this.mmBusy) return;
    this.mmBusy = true;
    try {
      await this.refreshMm("marketmaking");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "market-making tick failed");
    } finally {
      this.mmBusy = false;
    }
  }

  /** Public for tests/manual refresh. */
  async refreshMm(accountId: AccountId): Promise<void> {
    const account = this.account(accountId);
    if (!account.enabled) return;
    const now = Date.now();
    const rules = this.rules(accountId);
    const params = mmParamsFromRules(rules);
    const positions = this.repo.mmPositionsAll(accountId);
    const byId = new Map(positions.map(p => [p.marketId, p]));
    const halted = account.kill || !this.paperTradingEnabled() || !account.auto;
    const haltReason = account.kill ? "熔断中" : !this.paperTradingEnabled() ? "模拟交易暂停" : "自动执行关闭";

    const eligible = this.market.mmUniverse
      .filter(m => marketEligible({
        bestBid: m.bestBid, bestAsk: m.bestAsk, liquidity: m.liquidity, due: m.due,
        spreadBps: spreadBps(m.bestBid, m.bestAsk, (m.bestBid + m.bestAsk) / 2)
      }, params, now))
      .sort((a, b) => b.volume24h - a.volume24h || b.liquidity - a.liquidity)
      .slice(0, params.maxMarkets);
    const held = this.market.mmUniverse.filter(m => Math.abs(byId.get(m.id)?.inventory ?? 0) > 0);
    const active = [...new Map([...eligible, ...held].map(m => [m.id, m])).values()];

    const books = await this.market.refreshMmBooks(active.map(m => m.yesTokenId));
    if (!this.mmLastTradeTs) this.mmLastTradeTs = now - 8_000;
    const trades = await this.market.recentMmTrades(this.mmLastTradeTs);
    const maxTradeTs = trades.reduce((m, t) => Math.max(m, t.ts), this.mmLastTradeTs);

    for (const m of active) {
      const top = books[m.yesTokenId] ?? {
        bestBid: m.bestBid, bestAsk: m.bestAsk, bidSize: 0, askSize: 0, depthUsd: m.liquidity
      };
      const mid = microprice(top) || (top.bestBid + top.bestAsk) / 2;
      if (!(mid > 0)) continue;
      const prevMid = this.mmMids.get(m.id);
      if (prevMid && params.adverseStopBps > 0 && Math.abs(mid / prevMid - 1) * 10_000 > params.adverseStopBps) {
        this.mmHaltUntil.set(m.id, now + 30_000);
        this.riskEvent(accountId, {
          level: "warn", title: "逆向波动 · 暂停报价",
          detail: `${m.title} 中价 ${(prevMid * 100).toFixed(1)}¢ → ${(mid * 100).toFixed(1)}¢，暂停 30 秒`, val: "MM"
        });
      }
      this.mmMids.set(m.id, mid);

      let pos = byId.get(m.id) ?? emptyPosition(m.id, m.title);
      const prevQuote = this.mmQuotes.get(m.id);
      const marketTrades = trades.filter(t => t.conditionId === m.conditionId);
      if (prevQuote && !halted && !pos.paused && marketTrades.length) {
        for (const f of matchTrades(prevQuote, marketTrades)) {
          const before = pos.realized;
          pos = applyFill(pos, f.side, f.price, f.size, params.feeBps, f.ts);
          this.recordMmFill(accountId, m, pos, f.side, f.price, f.size, pos.realized - before, "maker");
        }
        byId.set(m.id, pos);
        this.repo.mmPositionUpsert(accountId, pos);
      }

      const adverse = now < (this.mmHaltUntil.get(m.id) ?? 0);
      const quote = computeQuote({ top, inventory: pos.inventory, params, paused: halted || pos.paused || adverse });
      if (halted) {
        quote.status = "halted"; quote.statusText = haltReason; quote.bid = 0; quote.ask = 0;
      } else if (adverse) {
        quote.status = "paused"; quote.statusText = "逆向波动暂停"; quote.bid = 0; quote.ask = 0;
      }
      this.mmQuotes.set(m.id, {
        bid: quote.bid, ask: quote.ask, size: quote.size, mid: quote.mid,
        quoteAt: now, status: quote.status, statusText: quote.statusText, skewBps: quote.skewBps
      });
      if (pos.inventory !== 0 || pos.fills > 0 || pos.paused) {
        this.repo.mmPositionUpsert(accountId, { ...pos, title: m.title, updatedAt: now });
      }
    }

    this.mmLastTradeTs = maxTradeTs;
    this.sampleEquity(accountId);
    this.emit("tick", { mmUpdatedAt: now, quoted: [...this.mmQuotes.values()].filter(q => q.bid > 0 || q.ask > 0).length });
  }

  private recordMmFill(
    accountId: AccountId, m: { id: string; title: string }, pos: MmPosition,
    side: "buy" | "sell", price: number, size: number, realizedDelta: number, kind: MmFill["kind"]
  ): void {
    const fill: MmFill = {
      id: "MMF-" + this.repo.nextSeq("mmFillSeq", 5001), accountId, marketId: m.id, title: m.title,
      side, price: +price.toFixed(4), size: +size.toFixed(2), notional: +(price * size).toFixed(2),
      edgeBps: pos.avg > 0 ? +(((side === "sell" ? price - pos.avg : pos.avg - price) / pos.avg) * 10_000).toFixed(1) : 0,
      inventoryAfter: pos.inventory, fee: 0, realized: +realizedDelta.toFixed(6), kind, createdAt: Date.now()
    };
    this.repo.mmFillAdd(fill);
    if (Math.abs(realizedDelta) > 0.0001) this.realizePnl(accountId, realizedDelta);
    this.log({ id: "system", name: "做市引擎", role: "admin" }, accountId,
      kind === "flatten" ? "做市减仓" : "做市成交", m.title, "POLYMARKET",
      `${side === "buy" ? "买入" : "卖出"} ${size.toFixed(0)} 股 @ ${(price * 100).toFixed(1)}¢，库存 ${pos.inventory.toFixed(0)} 股`);
    this.feed(accountId, {
      kind: "ok", title: `${kind === "flatten" ? "减仓" : "做市成交"} ${m.title}`,
      detail: `${side === "buy" ? "买" : "卖"} ${size.toFixed(0)} @ ${(price * 100).toFixed(1)}¢`, val: signedUsd(realizedDelta, 2)
    });
  }

  setMmPaused(user: Actor, accountId: AccountId, marketId: string, paused: boolean): void {
    if (accountId !== "marketmaking") throw new EngineError("desk_mismatch", "只有做市台可以暂停报价", 409);
    const rows = this.repo.mmPositionsAll(accountId);
    const found = rows.find(p => p.marketId === marketId);
    const title = this.market.mmUniverse.find(m => m.id === marketId)?.title ?? found?.title ?? marketId;
    const pos = found ?? emptyPosition(marketId, title);
    this.repo.mmPositionUpsert(accountId, { ...pos, paused, updatedAt: Date.now() });
    if (paused) this.mmQuotes.delete(marketId);
    this.log(user, accountId, paused ? "暂停报价" : "恢复报价", title, "POLYMARKET",
      paused ? "该市场停止双边报价；已有库存保留，可手动平仓" : "该市场恢复双边报价");
    this.touch();
  }

  flattenMm(user: Actor, accountId: AccountId, marketId?: string): number {
    if (accountId !== "marketmaking") throw new EngineError("desk_mismatch", "只有做市台有库存可平", 409);
    const positions = this.repo.mmPositionsAll(accountId).filter(p => p.inventory !== 0);
    const targets = marketId ? positions.filter(p => p.marketId === marketId) : positions;
    if (!targets.length) throw new EngineError("no_inventory", "没有需要平掉的做市库存", 409);
    for (const pos of targets) {
      const m = this.market.mmUniverse.find(x => x.id === pos.marketId);
      const top = m ? this.market.mmBooks[m.yesTokenId] : undefined;
      const bestBid = top?.bestBid ?? m?.bestBid ?? pos.avg;
      const bestAsk = top?.bestAsk ?? m?.bestAsk ?? pos.avg;
      // Cross the spread: long inventory sells at the bid, short inventory buys at the ask.
      const price = pos.inventory > 0 ? bestBid : bestAsk;
      const side: "buy" | "sell" = pos.inventory > 0 ? "sell" : "buy";
      const size = Math.abs(pos.inventory);
      const before = pos.realized;
      const next = applyFill(pos, side, price, size, 0, Date.now());
      this.repo.mmPositionUpsert(accountId, { ...next, paused: true, updatedAt: Date.now() });
      this.recordMmFill(accountId, { id: pos.marketId, title: pos.title }, next, side, price, size, next.realized - before, "flatten");
      this.mmQuotes.delete(pos.marketId);
    }
    this.log(user, accountId, "做市平仓", marketId ? (targets[0]?.title ?? marketId) : "全部做市库存", "POLYMARKET",
      `${targets.length} 个市场按对手价平仓，库存归零`);
    this.feed(accountId, { kind: "warn", title: "做市库存已平", detail: `${targets.length} 个市场`, val: "已减仓" });
    this.touch();
    return targets.length;
  }

  /* ---------------- controls ---------------- */
  setKill(user: Actor, accountId: AccountId, enabled: boolean, reason: string): void {
    const account = this.account(accountId);
    if (enabled === account.kill) return;
    saveAccountSettings(this.repo, accountId, {
      kill: enabled, auto: enabled ? false : true, killReason: reason,
      lastKillAt: enabled ? Date.now() : account.lastKillAt
    });
    if (enabled) {
      this.mmQuotes.clear();
      this.riskEvent(accountId, { level: "bad", title: "熔断触发", detail: reason, val: accountDef(accountId).name });
      this.log(user, accountId, "熔断", accountDef(accountId).name, "双策略台", `${reason}；新转换与新报价停止，已有库存保留`);
      this.feed(accountId, { kind: "warn", title: "熔断触发", detail: reason, val: "账户停止" });
    } else {
      this.log(user, accountId, "解除熔断", accountDef(accountId).name, "账户", `${reason}；转换与报价恢复，护栏规则继续生效`);
      this.feed(accountId, { kind: "ok", title: "解除熔断", detail: reason, val: "已恢复" });
    }
    this.touch();
  }

  setAuto(user: Actor, accountId: AccountId, enabled: boolean): void {
    const account = this.account(accountId);
    if (account.kill && enabled) throw new EngineError("kill_switch", "熔断中不能开启自动执行", 409);
    saveAccountSettings(this.repo, accountId, { auto: enabled });
    if (!enabled) this.mmQuotes.clear();
    this.log(user, accountId, "自动执行", enabled ? "开启" : "暂停", "账户",
      enabled ? "做市报价与 NegRisk 自动转换恢复" : "做市停止报价，NegRisk 只观察不自动转换");
    this.touch();
  }

  setPaperTrading(user: Actor, accountId: AccountId, enabled: boolean): AppSettings {
    const next = saveSettings(this.repo, { paperTradingEnabled: enabled });
    if (!enabled) this.mmQuotes.clear();
    this.log(user, accountId, enabled ? "开启模拟交易" : "暂停模拟交易", "全局模拟引擎", "纸面",
      enabled ? "做市成交与 NegRisk 转换按真实盘口仿真" : "新成交暂停；已有库存仍可平仓");
    this.feed(accountId, {
      kind: enabled ? "ok" : "warn",
      title: enabled ? "模拟交易已开启" : "模拟交易已暂停",
      detail: enabled ? "报价与转换按真实盘口仿真" : "只允许平仓，不再产生新成交",
      val: enabled ? "ON" : "OFF"
    });
    this.touch();
    return next;
  }

  private paperTradingEnabled(): boolean {
    return getSettings(this.repo).paperTradingEnabled !== false;
  }

  updateLimit(user: Actor, accountId: AccountId, id: string, value: number): Limit {
    const limits = this.limitsWithUsage(accountId);
    const limit = limits.find(l => l.id === id);
    if (!limit) throw new EngineError("limit_not_found", "限额不存在", 404);
    const fail = validateLimitValue(limit, limit.used, value);
    if (fail) throw new EngineError(fail.code, fail.message, 409);
    this.repo.limitUpdate(accountId, id, value);
    this.log(user, accountId, "调整限额", limit.name, accountDef(accountId).name,
      `新上限 ${limit.kind === "pct" ? value + "%" : usd(value)}，仅作用于该账户`);
    this.touch();
    return { ...limit, value };
  }

  resetLimits(user: Actor, accountId: AccountId): void {
    this.repo.limitsReplace(accountId, scaledDefaultLimits(accountId, this.account(accountId).equity));
    this.log(user, accountId, "恢复默认限额", "账户限额", accountDef(accountId).name, "该账户限额回到按净值缩放的基准值");
    this.touch();
  }

  toggleRule(user: Actor, accountId: AccountId, id: string, on: boolean): Rule {
    const rule = this.rules(accountId).find(r => r.id === id);
    if (!rule) throw new EngineError("rule_not_found", "规则不存在", 404);
    if (rule.hard && !on) throw new EngineError("rule_hard", `${rule.name} 是硬约束，不能关闭`, 409);
    this.repo.ruleUpsert(accountId, { ...rule, on });
    this.log(user, accountId, on ? "启用规则" : "关闭规则", rule.name, accountDef(accountId).name,
      `${on ? "重新参与该账户校验" : "关闭期间该账户不再被此规则拦截"}${rule.value != null ? `；阈值 ${rule.value}${rule.unit ?? ""}` : ""}`);
    this.touch();
    return { ...rule, on };
  }

  updateRule(user: Actor, accountId: AccountId, id: string, patch: { on?: boolean; value?: number }): Rule {
    const rule = this.rules(accountId).find(r => r.id === id);
    if (!rule) throw new EngineError("rule_not_found", "规则不存在", 404);
    if (rule.hard && patch.on === false) throw new EngineError("rule_hard", `${rule.name} 是硬约束，不能关闭`, 409);
    const next = { ...rule };
    if (patch.on !== undefined) next.on = patch.on;
    if (patch.value !== undefined) {
      if (!Number.isFinite(patch.value)) throw new EngineError("rule_value_invalid", "规则阈值必须是数字", 409);
      const min = rule.min ?? 0;
      const max = rule.max ?? Number.MAX_SAFE_INTEGER;
      if (patch.value < min || patch.value > max) {
        throw new EngineError("rule_value_invalid", `${rule.name} 阈值需在 ${min}–${max}${rule.unit ?? ""} 之间`, 409);
      }
      next.value = +patch.value.toFixed(4);
    }
    this.repo.ruleUpsert(accountId, next);
    const changes: string[] = [];
    if (patch.on !== undefined && patch.on !== rule.on) changes.push(patch.on ? "启用" : "关闭");
    if (patch.value !== undefined && patch.value !== rule.value) changes.push(`阈值 ${rule.value ?? "—"} → ${next.value}${rule.unit ?? ""}`);
    this.log(user, accountId, "调整规则", rule.name, accountDef(accountId).name, changes.join("；") || "无变化");
    this.touch();
    return next;
  }

  updateAccount(user: Actor, accountId: AccountId, patch: Partial<{
    enabled: boolean; equity: number; minEdge: number; paperFillMs: number;
  }>): AccountSettings {
    const account = this.account(accountId);
    const summary = this.summary(account);
    if (patch.equity != null) {
      if (!Number.isFinite(patch.equity) || patch.equity <= 0) throw new EngineError("equity_invalid", "账户净值必须大于 0", 409);
      if (patch.equity < summary.bookCost * 0.98) {
        throw new EngineError("equity_below_deployed", `该账户已部署 ${usd(summary.bookCost, 0)}，净值不能低于部署的 98%。`, 409);
      }
    }
    if (patch.minEdge != null && (!Number.isFinite(patch.minEdge) || patch.minEdge < 0 || patch.minEdge > 50)) {
      throw new EngineError("min_edge_invalid", "净边阈值需在 0–50¢ 之间", 409);
    }
    const next = saveAccountSettings(this.repo, accountId, patch);
    if (patch.equity != null && patch.equity !== account.equity) this.sampleEquity(accountId, true);
    this.log(user, accountId, "调整账户", accountDef(accountId).name, "后台",
      Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(" · "));
    this.touch();
    return next;
  }

  /* ---------------- equity / realized pnl ---------------- */
  private realizePnl(accountId: AccountId, delta: number, trades = 0, wins = 0): void {
    if (!Number.isFinite(delta) && trades === 0) return;
    const account = this.account(accountId);
    const realized = +((account.realizedPnl ?? 0) + (Number.isFinite(delta) ? delta : 0)).toFixed(6);
    saveAccountSettings(this.repo, accountId, {
      realizedPnl: realized,
      closedTrades: (account.closedTrades ?? 0) + trades,
      wins: (account.wins ?? 0) + wins
    });
    this.sampleEquity(accountId, true);
  }

  private sampleEquity(accountId: AccountId, force = false): void {
    const current = this.currentEquity(accountId);
    const points = this.repo.equityAll(accountId);
    const last = points[points.length - 1];
    const now = Date.now();
    if (!force && last && now - last.t < 5 * 60_000) return;
    this.repo.equityAppend(accountId, { t: now, v: +current.toFixed(2) });
    this.repo.equityTrim(accountId, 5000);
  }

  /* ---------------- catalog ---------------- */
  async refreshCatalog(user: Actor): Promise<{ mode: string; events: number; message: string }> {
    await this.market.refreshDesks(true);
    this.logGlobal(user, "刷新扫描面", "NegRisk + 做市池", "PM",
      `NegRisk ${this.market.negRisk.length} 个事件，做市池 ${this.market.mmUniverse.length} 个市场`);
    this.touch();
    return {
      mode: this.market.catalogMode,
      events: this.market.negRisk.length + this.market.mmUniverse.length,
      message: `NegRisk ${this.market.negRisk.length} 个事件 · 做市池 ${this.market.mmUniverse.length} 个市场`
    };
  }

  equityTotal(): number {
    return this.accounts().reduce((sum, a) => sum + a.equity, 0);
  }

  accountIds(): AccountId[] { return ACCOUNT_DEFS.map(a => a.id); }

  flattenAll(user: Actor, accountId: AccountId): { legs: number; pnl: number; events: number } {
    if (accountId === "marketmaking") {
      const pnl = this.mmSnapshot(accountId).totals.realized;
      const count = this.flattenMm(user, accountId);
      return { legs: count, pnl, events: count };
    }
    throw new EngineError("nothing_to_close", "NegRisk 转换在成交时已锁定，没有可平仓位", 409);
  }
}
