import type { Repository } from "../db/repository.js";
import type { MarketService } from "../market/service.js";
import type {
  AccountId, AccountSettings, AccountSummary, AuditEntry, Book, DerivedEvent, EventContract, Limit, Order, Position,
  Review, Rule
} from "../domain/types.js";
import { book as buildBook, derive } from "../domain/pricing.js";
import { ACCOUNT_DEFS, accountDef, eligibleFor, isAccountId } from "../domain/accounts.js";
import { checkOrder, limitUsage, validateLimitValue, DEFAULT_LIMITS, DEFAULT_RULES } from "../domain/risk.js";
import { config, liveTradingConfigured } from "../config.js";
import {
  accountsAll, accountSettings, dailyLossPct, getSettings, saveAccountSettings, saveSettings, type AppSettings
} from "../settings.js";
import { clock, hhmm, signedUsd, usd } from "../util.js";
import { logger } from "../logger.js";
import * as hl from "../venues/hyperliquid.js";
import * as pm from "../venues/polymarket.js";

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

export class Engine {
  private listeners = new Set<EngineListener>();
  private timers: NodeJS.Timeout[] = [];
  private version = 0;
  private starting = false;
  private persistedAt = 0;
  private lastReviewsPersist = 0;
  private lastAutoAt = new Map<AccountId, number>();

  constructor(private readonly repo: Repository, private readonly market: MarketService) {}

  /* ---------------- lifecycle ---------------- */
  start(): void {
    if (this.timers.length || this.starting) return;
    this.starting = true;
    const settings = getSettings(this.repo);
    this.timers.push(setInterval(() => void this.scanTick(), Math.max(500, settings.scanIntervalMs)));
    this.timers.push(setInterval(() => this.advancePaperOrders(), 500));
    this.timers.push(setInterval(() => this.tickReviews(), 1000));
    this.timers.push(setInterval(() => this.persist(), 15_000));
    this.timers.push(setInterval(() => this.repo.sessionsCleanup(), 3600_000));
    this.starting = false;
    logger.info({ scanIntervalMs: settings.scanIntervalMs, accounts: this.accounts().length }, "engine started");
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
      try { fn(event); } catch { /* listener errors must not break the engine */ }
    }
  }

  private async scanTick(): Promise<void> {
    try {
      await this.market.tick();
      const changed = this.market.events.map(e => ({
        id: e.id, ask: e.ask, bid: e.bid, fair: e.fair, delta: e.delta,
        depth: e.depth, conf: e.conf, due: e.due, quoteAgeMs: e.quoteAgeMs
      }));
      this.emit("tick", {
        market: this.market.market,
        quotes: changed,
        scanSeq: this.market.scanSeq,
        lastScanAt: this.market.lastScanAt,
        venues: [this.market.hlStatus, this.market.pmStatus],
        catalogMode: this.market.catalogMode
      });
      for (const account of this.accounts()) {
        if (!account.enabled) continue;
        void this.maybeAutoExecute(account.id);
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "scan tick failed");
    }
  }

  /** One auto order per account per minute; each account has its own book and limits. */
  private async maybeAutoExecute(accountId: AccountId): Promise<void> {
    const account = this.account(accountId);
    const def = accountDef(accountId);
    if (!account.auto || account.kill || !account.enabled) return;
    const last = this.lastAutoAt.get(accountId) ?? 0;
    if (Date.now() - last < 60_000) return;
    const positions = this.repo.positionsAll(accountId);
    const open = this.repo.ordersAll(accountId).filter(o => o.status !== "filled" && o.status !== "failed");
    // maxOpen counts distinct events with exposure (held or in flight), not raw leg rows.
    const exposure = new Set([...positions.map(p => p.evId), ...open.map(o => o.evId)]);
    if (exposure.size >= def.maxOpen) return;
    const held = new Set(positions.map(p => p.evId));
    const openEv = new Set(open.map(o => o.evId));
    const candidates = this.derived(accountId)
      .filter(d => d.status === "ready" && d.net >= account.minEdge && !held.has(d.id) && !openEv.has(d.id))
      .sort((a, b) => b.net - a.net);
    const best = candidates[0];
    if (!best) return;
    const equity = account.equity;
    const maxByDepth = Math.floor((best.depth * 0.4) / best.ask / 100) * 100;
    const maxByEquity = Math.floor((equity * 0.06) / best.ask / 100) * 100;
    const qty = Math.max(100, Math.min(maxByDepth, maxByEquity, 40_000 / best.ask));
    const normalized = Math.floor(qty / 100) * 100;
    if (normalized < 100) return;
    this.lastAutoAt.set(accountId, Date.now());
    try {
      await this.createOrder({ id: "system", name: "自动引擎 · " + def.name, role: "admin" }, {
        accountId, eventId: best.id, qty: normalized, source: "auto"
      });
    } catch (err) {
      logger.info({ account: accountId, event: best.id, reason: (err as Error).message }, "auto execution skipped");
    }
  }

  persist(): void {
    if (Date.now() - this.persistedAt < 5_000) return;
    this.persistedAt = Date.now();
    this.market.persist();
    for (const account of this.accounts()) {
      for (const r of this.repo.reviewsAll(account.id)) {
        const remaining = this.reviewRemaining(r);
        if (remaining !== r.seconds) this.repo.reviewUpsert(account.id, { ...r, seconds: remaining });
      }
    }
  }

  getVersion(): number { return this.version; }

  /* ---------------- accounts / views ---------------- */
  settings(): AppSettings { return getSettings(this.repo); }

  accounts(): AccountSettings[] { return accountsAll(this.repo); }

  account(id: AccountId): AccountSettings {
    const found = this.accounts().find(a => a.id === id);
    if (!found) throw new EngineError("account_not_found", "账户不存在", 404);
    return found;
  }

  accountSummaries(): AccountSummary[] {
    return this.accounts().map(a => {
      const def = accountDef(a.id);
      const book = this.book(a.id);
      const orders = this.repo.ordersAll(a.id);
      const open = orders.filter(o => o.status !== "filled" && o.status !== "failed");
      const derived = this.derived(a.id);
      return {
        ...a,
        name: def.name,
        short: def.short,
        desc: def.desc,
        logic: def.logic,
        holdLabel: def.holdLabel,
        maxOpen: def.maxOpen,
        requiresRealtime: def.requiresRealtime === true,
        pnl: +book.pnl.toFixed(2),
        usedPct: a.equity > 0 ? (book.cost + book.margin) / a.equity : 0,
        positions: book.rows.length,
        openOrders: open.length,
        signals: derived.length,
        ready: derived.filter(d => d.status === "ready").length,
        dailyLossPct: dailyLossPct(this.repo, a.id, a.equity + book.pnl),
        bookCost: +book.cost.toFixed(2),
        netDelta: +book.netDelta.toFixed(2)
      };
    });
  }

  derived(accountId: AccountId): DerivedEvent[] {
    const account = this.account(accountId);
    const global = this.settings();
    const positions = this.repo.positionsAll(accountId);
    const heldIds = new Set(positions.map(p => p.evId));
    return this.market.events
      .filter(ev => eligibleFor(accountId, ev, this.market.market))
      .map(ev => derive(ev, {
        market: this.market.market,
        cost: global.cost,
        minEdge: account.minEdge,
        positions,
        heldIds,
        strategy: accountId,
        quoteAgeMs: ev.quoteAgeMs
      }));
  }

  book(accountId: AccountId): Book {
    const account = this.account(accountId);
    return buildBook({
      events: this.market.events,
      positions: this.repo.positionsAll(accountId),
      market: this.market.market,
      cost: this.settings().cost,
      minEdge: account.minEdge,
      strategy: accountId
    });
  }

  currentEquity(accountId: AccountId): number { return this.account(accountId).equity; }

  limits(accountId: AccountId): Limit[] {
    const rows = this.repo.limitsAll(accountId);
    return rows.length ? rows : this.scaledDefaultLimits(accountId);
  }

  private scaledDefaultLimits(accountId: AccountId): Limit[] {
    const equity = this.account(accountId).equity;
    const settleRatio = accountId === "converge" ? 0.9 : accountId === "latency" ? 0.4 : accountId === "longvol" ? 0.55 : 0.35;
    return DEFAULT_LIMITS.map(l => {
      if (l.kind === "pct") return { ...l };
      const ratio = l.id === "pm" ? 0.9
        : l.id === "hl" ? 0.1
        : l.id === "delta" ? 0.2
        : settleRatio;
      return { ...l, value: Math.max(10_000, Math.round(equity * ratio / 1000) * 1000) };
    });
  }

  rules(accountId: AccountId): Rule[] {
    const rows = this.repo.rulesAll(accountId);
    return rows.length ? rows : DEFAULT_RULES;
  }

  limitsWithUsage(accountId: AccountId): Limit[] {
    return limitUsage(this.book(accountId), this.account(accountId).equity, this.limits(accountId));
  }

  orders(accountId: AccountId): Order[] {
    return this.repo.ordersAll(accountId).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  reviews(accountId: AccountId): Review[] {
    return this.repo.reviewsAll(accountId).map(r => ({ ...r, seconds: this.reviewRemaining(r) }));
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

  private nextOrderId(): string {
    const maxExisting = this.repo.ordersAll().reduce((max, o) => {
      const n = Number(String(o.id).replace(/\D/g, "")) || 0;
      return Math.max(max, n);
    }, 0);
    const next = Math.max(maxExisting, Number(this.repo.metaGet("orderSeq", "8841")) || 8841) + 1;
    this.repo.metaSet("orderSeq", next);
    return "ORD-" + next;
  }

  private nextReviewId(): string {
    const maxExisting = this.repo.reviewsAll().reduce((max, r) => {
      const n = Number(String(r.id).replace(/\D/g, "")) || 0;
      return Math.max(max, n);
    }, 0);
    const next = Math.max(maxExisting, Number(this.repo.metaGet("reviewSeq", "2201")) || 2201) + 1;
    this.repo.metaSet("reviewSeq", next);
    return "RV-" + next;
  }

  /* ---------------- order flow ---------------- */
  async createOrder(user: Actor, input: {
    accountId: AccountId; eventId: string; qty: number; source?: "manual" | "auto"; ackFatEdge?: boolean;
  }): Promise<Order> {
    if (!isAccountId(input.accountId)) throw new EngineError("account_invalid", "账户不存在", 404);
    const account = this.account(input.accountId);
    if (!account.enabled) throw new EngineError("account_disabled", "该账户已被管理员停用", 409);
    const source = input.source ?? "manual";
    const d = this.derived(input.accountId).find(r => r.id === input.eventId);
    if (!d) throw new EngineError("event_not_found", "事件不存在、已下架，或不属于该账户的策略范围", 404);
    const qty = Math.floor(Number(input.qty));
    if (!Number.isFinite(qty) || qty < 100) throw new EngineError("qty_invalid", "合约腿数量至少 100 股");
    const maxQty = Math.floor(d.depth / d.ask / 100) * 100;
    if (qty > maxQty) throw new EngineError("qty_exceeds_depth", `盘口最多可成交 ${maxQty.toLocaleString("en-US")} 股`);

    const book = this.book(input.accountId);
    const limits = this.limitsWithUsage(input.accountId);
    const rules = this.rules(input.accountId);
    const check = checkOrder({
      event: d, qty, book, limits, rules, equity: account.equity,
      kill: account.kill, auto: account.auto, source,
      dailyLossPct: dailyLossPct(this.repo, input.accountId, account.equity + book.pnl),
      ackFatEdge: input.ackFatEdge,
      strategy: input.accountId
    });
    if (!check.ok) {
      throw new EngineError("risk_rejected", check.failures.map(f => f.message).join(" "), 409);
    }
    const mode = this.tradingMode();
    const liveReason = this.liveBlockedReason();
    if (liveReason) throw new EngineError("live_unavailable", liveReason, 409);

    const id = this.nextOrderId();
    const mark = this.market.market[d.und]?.px ?? 0;
    const hedge = qty * Math.abs(d.delta);
    const def = accountDef(input.accountId);
    const order: Order = {
      id,
      evId: d.id,
      accountId: input.accountId,
      strategyId: input.accountId,
      status: "leg1",
      statusText: "等待合约腿",
      notional: +(qty * d.ask).toFixed(2),
      qty,
      opened: clock().slice(0, 5),
      strategy: `${def.name} · ${source === "auto" ? "自动" : "人工确认"}`,
      slippageBps: 5.8,
      createdAt: Date.now(),
      actor: user.name,
      live: mode === "live",
      legs: [
        {
          venue: "POLYMARKET", side: "buy", label: "买入 YES", qty,
          filled: 0, price: d.ask, notional: 0, done: false,
          note: mode === "live" ? "等待 Polymarket 市价单回报" : "等待撮合"
        },
        {
          venue: "HYPERLIQUID", side: "short", label: `做空 ${d.und}-PERP`,
          qty: +hedge.toFixed(4), filled: 0, price: mark, notional: 0, done: false,
          note: "合约腿完成后启动，避免裸敞口"
        }
      ]
    };
    this.repo.orderUpsert(input.accountId, order);
    this.log(user, input.accountId, "开仓", d.title, "PM + HL",
      `${def.name} · ${source === "auto" ? "自动" : "人工"}买入 ${qty.toLocaleString("en-US")} YES @ ${(d.ask * 100).toFixed(1)}¢；对冲 ${d.und}-PERP ${usd(hedge, 0)}`);
    this.feed(input.accountId, {
      kind: "ok", title: `${def.name}开仓 ${d.title}`,
      detail: `${qty.toLocaleString("en-US")} YES @ ${(d.ask * 100).toFixed(1)}¢`, val: "执行中"
    });
    this.touch();

    if (mode === "live") {
      void this.executeLive(input.accountId, order, d, qty).catch(err => this.failOrder(input.accountId, order.id, (err as Error).message));
    }
    return order;
  }

  private async executeLive(accountId: AccountId, order: Order, d: DerivedEvent, qty: number): Promise<void> {
    const tokenId = d.external?.tokenId;
    if (!tokenId) throw new Error("该事件没有 Polymarket token，无法实盘下单");
    const pmResult = await pm.placeOrder({ tokenId, side: "BUY", amountUsd: qty * d.ask, price: d.ask });
    if (!pmResult.ok) throw new Error(`Polymarket 合约腿失败：${pmResult.error}`);
    order.legs[0].filled = pmResult.filledQty ?? qty;
    order.legs[0].price = pmResult.avgPrice ?? d.ask;
    order.legs[0].notional = order.legs[0].filled * order.legs[0].price;
    order.legs[0].done = order.legs[0].filled >= qty - 0.5;
    order.legs[0].externalId = pmResult.externalId;
    order.legs[0].note = `Polymarket 成交 ${order.legs[0].filled.toFixed(2)} 股`;
    order.status = "hedging";
    order.statusText = "对冲中";
    this.repo.orderUpsert(accountId, order);
    this.touch();

    const px = this.market.market[d.und]?.px ?? 0;
    const hedge = order.legs[0].filled * Math.abs(d.delta);
    const hlResult = await hl.placeOrder({ coin: d.und, isBuy: false, size: hedge / px, price: px * 0.995 });
    if (!hlResult.ok) {
      this.repo.orderUpsert(accountId, order);
      this.createReview(accountId, {
        evId: d.id, kind: "对冲腿失败", reason: `Hyperliquid 对冲失败：${hlResult.error}`,
        action: `合约腿已成交 ${order.legs[0].filled.toFixed(0)} 股，当前裸敞口`,
        advice: "立即补对冲，或平掉合约腿", seconds: 30 * 60, severity: "bad"
      });
      throw new Error(hlResult.error ?? "Hyperliquid 对冲失败");
    }
    order.legs[1].filled = hlResult.filledQty ?? hedge;
    order.legs[1].price = hlResult.avgPrice ?? px;
    order.legs[1].notional = order.legs[1].filled;
    order.legs[1].done = true;
    order.legs[1].externalId = hlResult.externalId;
    order.legs[1].note = "Hyperliquid IOC 成交";
    order.status = "filled";
    order.statusText = "已成交";
    this.repo.orderUpsert(accountId, order);
    this.applyOrderToPosition(accountId, order, d);
    this.feed(accountId, { kind: "ok", title: "两腿对齐", detail: d.title, val: "已成交" });
    this.log({ id: "system", name: "自动引擎", role: "admin" }, accountId, "两腿对齐", d.title, "HL",
      `对冲 ${hlResult.filledQty?.toFixed(4)} ${d.und}-PERP @ ${hlResult.avgPrice}`);
    this.touch();
  }

  private failOrder(accountId: AccountId, id: string, message: string): void {
    const order = this.repo.ordersAll(accountId).find(o => o.id === id);
    if (!order) return;
    order.status = "failed";
    order.statusText = "失败";
    order.error = message;
    this.repo.orderUpsert(accountId, order);
    this.riskEvent(accountId, { level: "bad", title: "订单执行失败", detail: message, val: id });
    this.touch();
  }

  private createReview(accountId: AccountId, input: {
    evId: string; kind: string; reason: string; action: string; advice: string; seconds: number; severity?: "warn" | "bad";
  }): Review {
    const id = this.nextReviewId();
    const review: Review = {
      id, accountId, evId: input.evId, kind: input.kind, reason: input.reason, action: input.action,
      advice: input.advice, seconds: input.seconds, severity: input.severity ?? "warn",
      createdAt: Date.now(), deadline: Date.now() + input.seconds * 1000
    };
    this.repo.reviewUpsert(accountId, review);
    this.riskEvent(accountId, { level: "warn", title: input.kind, detail: input.reason, val: "转人工" });
    this.touch();
    return review;
  }

  private advancePaperOrders(): void {
    for (const account of this.accounts()) {
      if (account.kill) continue;
      const orders = this.repo.ordersAll(account.id);
      let changed = false;
      for (const o of orders) {
        if (o.live || o.seeded || o.status === "filled" || o.status === "failed") continue;
        const age = Date.now() - (o.createdAt ?? Date.now());
        const d = this.market.events.find(e => e.id === o.evId);
        if (!d) continue;
        if (o.status === "leg1" && age >= 900) {
          o.legs[0].filled = o.qty;
          o.legs[0].notional = +(o.qty * o.legs[0].price).toFixed(2);
          o.legs[0].done = true;
          o.legs[0].note = "合约腿全额成交";
          o.status = "hedging";
          o.statusText = "对冲中";
          this.repo.orderUpsert(account.id, o);
          this.log({ id: "system", name: "自动引擎", role: "admin" }, account.id, "合约腿成交", d.title, "PM",
            `${o.qty.toLocaleString("en-US")} YES @ ${(o.legs[0].price * 100).toFixed(1)}¢`);
          changed = true;
          continue;
        }
        if (o.status === "hedging" && age >= account.paperFillMs) {
          const px = this.market.market[d.und]?.px ?? o.legs[1].price;
          o.legs[1].filled = o.legs[1].qty;
          o.legs[1].price = +(px * 1.0006).toFixed(4);
          o.legs[1].notional = +o.legs[1].filled.toFixed(2);
          o.legs[1].done = true;
          o.legs[1].note = "已全额成交 · 滑点 4.2bps";
          o.status = "filled";
          o.statusText = "已成交";
          this.repo.orderUpsert(account.id, o);
          this.applyOrderToPosition(account.id, o, d);
          this.log({ id: "system", name: "自动引擎", role: "admin" }, account.id, "两腿对齐", d.title, "HL",
            `对冲腿全额成交 ${usd(o.legs[1].notional, 0)}，滑点 4.2bps；头寸已进入账户账本`);
          this.feed(account.id, { kind: "ok", title: `两腿对齐 ${d.title}`, detail: `对冲 ${usd(o.legs[1].notional, 0)}`, val: "已成交" });
          changed = true;
        }
      }
      if (changed) this.touch();
    }
  }

  private applyOrderToPosition(accountId: AccountId, order: Order, d: EventContract): void {
    const positions = this.repo.positionsAll(accountId);
    const held = positions.find(p => p.evId === order.evId);
    const hedge = order.legs[1].filled;
    const hedgePx = order.legs[1].price || this.market.market[d.und]?.px || 0;
    if (held) {
      const totalQty = held.qty + order.qty;
      held.avg = (held.avg * held.qty + order.legs[0].price * order.qty) / totalQty;
      held.hedgeEntry = (held.hedgeUsd * held.hedgeEntry + hedge * hedgePx) / Math.max(0.0001, held.hedgeUsd + hedge);
      held.qty = totalQty;
      held.hedgeUsd += hedge;
      held.accountId = accountId;
      this.repo.positionUpsert(accountId, held);
    } else {
      this.repo.positionUpsert(accountId, {
        evId: order.evId, qty: order.qty, avg: order.legs[0].price,
        hedgeUsd: hedge, hedgeEntry: hedgePx, accountId,
        openedAt: new Date().toISOString()
      });
    }
  }

  async hedgeOrder(user: Actor, accountId: AccountId, id: string): Promise<Order> {
    const account = this.account(accountId);
    if (account.kill) throw new EngineError("kill_switch", "该账户已熔断，请先解除熔断", 409);
    const order = this.repo.ordersAll(accountId).find(o => o.id === id);
    if (!order) throw new EngineError("order_not_found", "订单不存在", 404);
    if (order.status === "filled") return order;
    const d = this.market.events.find(e => e.id === order.evId);
    if (!d) throw new EngineError("event_not_found", "事件不存在", 404);
    const px = this.market.market[d.und]?.px ?? order.legs[1].price;
    const gap = Math.max(0, order.legs[1].qty - order.legs[1].filled);
    if (gap <= 0.01) return order;

    let filledUsd = gap;
    let fillPx = px * 1.0007;
    if (order.live && this.tradingMode() === "live") {
      const result = await hl.placeOrder({ coin: d.und, isBuy: false, size: gap / px, price: px * 0.995 });
      if (!result.ok) throw new EngineError("hedge_failed", `Hyperliquid 补对冲失败：${result.error}`, 502);
      fillPx = result.avgPrice ?? px;
      filledUsd = (result.filledQty ?? gap / px) * fillPx;
    }
    order.legs[1].filled = Math.min(order.legs[1].qty, order.legs[1].filled + filledUsd);
    order.legs[1].price = +fillPx.toFixed(4);
    order.legs[1].notional = +order.legs[1].filled.toFixed(2);
    order.legs[1].done = order.legs[1].filled >= order.legs[1].qty - 0.01;
    order.legs[1].note = order.legs[1].done
      ? "已按对手价补足 · 滑点 6.8bps"
      : `部分补足，剩余 $${Math.round(order.legs[1].qty - order.legs[1].filled).toLocaleString("en-US")}`;
    if (order.legs[1].done) {
      order.status = "filled";
      order.statusText = "已成交";
    }
    this.repo.orderUpsert(accountId, order);
    if (!order.seeded && order.legs[1].done) this.applyOrderToPosition(accountId, order, d);
    this.log(user, accountId, "补对冲", d.title, "HL", `按对手价补足缺口 ${usd(filledUsd, 0)}，滑点 6.8bps`);
    this.feed(accountId, { kind: "ok", title: `补对冲 ${d.title}`, detail: `${user.name} · 补 ${usd(filledUsd, 0)}`, val: order.legs[1].done ? "已对齐" : "部分" });
    this.touch();
    return order;
  }

  async flattenOrder(user: Actor, accountId: AccountId, id: string): Promise<void> {
    const order = this.repo.ordersAll(accountId).find(o => o.id === id);
    if (!order) throw new EngineError("order_not_found", "订单不存在", 404);
    const d = this.market.events.find(e => e.id === order.evId);
    if (order.live && this.tradingMode() === "live" && d) {
      await this.closeLiveLegs(accountId, d, order.qty, order.legs[0].filled, order.legs[1].filled);
    }
    this.repo.orderDelete(accountId, id);
    if (order.status === "filled" && d) this.closePositionPart(user, accountId, order.evId, order.qty);
    this.log(user, accountId, "立即平仓", d?.title ?? id, "PM + HL", `${id} 两条腿同时提交平仓`);
    this.feed(accountId, { kind: "warn", title: "立即平仓", detail: d?.title ?? id, val: id });
    this.touch();
  }

  private async closeLiveLegs(accountId: AccountId, d: EventContract, qty: number, pmShares: number, hedgeUsd: number): Promise<void> {
    const tokenId = d.external?.tokenId;
    if (!tokenId) throw new EngineError("live_close_unavailable", "该事件没有 Polymarket token，无法实盘平仓", 409);
    const px = this.market.market[d.und]?.px ?? 0;
    const pmResult = await pm.placeOrder({ tokenId, side: "SELL", shares: pmShares });
    if (!pmResult.ok) throw new EngineError("pm_close_failed", `Polymarket 平仓失败：${pmResult.error}`, 502);
    if (hedgeUsd > 0.01 && px > 0) {
      const hlResult = await hl.placeOrder({ coin: d.und, isBuy: true, size: hedgeUsd / px, price: px * 1.005, reduceOnly: true });
      if (!hlResult.ok) {
        this.createReview(accountId, {
          evId: d.id, kind: "实盘平仓失败",
          reason: `Polymarket 合约腿已卖出 ${pmShares.toFixed(0)} 股，Hyperliquid 平仓失败：${hlResult.error}`,
          action: "合约腿已退出，对冲腿仍在场", advice: "立即在 Hyperliquid 手动平掉对冲腿", seconds: 15 * 60, severity: "bad"
        });
        throw new EngineError("hl_close_failed", `Hyperliquid 平仓失败：${hlResult.error}`, 502);
      }
    }
    void qty;
  }

  archiveOrder(user: Actor, accountId: AccountId, id: string): void {
    const order = this.repo.ordersAll(accountId).find(o => o.id === id);
    if (!order) throw new EngineError("order_not_found", "订单不存在", 404);
    this.repo.orderDelete(accountId, id);
    this.log(user, accountId, "归档订单", order.id, "账户", "订单已归档，不再占用执行台");
    this.touch();
  }

  closePositionPart(user: Actor, accountId: AccountId, evId: string, qty?: number): void {
    const p = this.repo.positionsAll(accountId).find(x => x.evId === evId);
    if (!p) return;
    const d = this.market.events.find(e => e.id === evId);
    if (!d) { this.repo.positionDelete(accountId, evId); return; }
    const mark = this.market.market[d.und]?.px ?? p.hedgeEntry;
    const closeQty = Math.min(p.qty, qty ?? p.qty);
    const frac = closeQty / p.qty;
    const contractPnl = closeQty * (d.bid - p.avg);
    const hedgePnl = p.hedgeUsd * (p.hedgeEntry - mark) / Math.max(0.0001, p.hedgeEntry) * frac;
    const realized = contractPnl + hedgePnl;
    this.adjustEquity(accountId, realized);
    if (closeQty >= p.qty - 0.01) this.repo.positionDelete(accountId, evId);
    else {
      p.qty -= closeQty;
      p.hedgeUsd *= (1 - frac);
      this.repo.positionUpsert(accountId, p);
    }
    this.log(user, accountId, "平仓", d.title, "PM + HL", `${Math.round(closeQty).toLocaleString("en-US")} 股按对手价平仓，实现盈亏 ${signedUsd(realized)}`);
    this.feed(accountId, { kind: "warn", title: "已平仓", detail: d.title, val: signedUsd(realized) });
    this.touch();
  }

  async alignHedge(user: Actor, accountId: AccountId, evId: string): Promise<void> {
    const account = this.account(accountId);
    if (account.kill) throw new EngineError("kill_switch", "该账户已熔断，请先解除熔断", 409);
    const p = this.repo.positionsAll(accountId).find(x => x.evId === evId);
    if (!p) throw new EngineError("position_not_found", "持仓不存在", 404);
    const d = this.market.events.find(e => e.id === evId);
    if (!d) throw new EngineError("event_not_found", "事件不存在", 404);
    const target = p.qty * Math.abs(d.delta);
    if (p.hedgeUsd >= target * 0.999) throw new EngineError("already_aligned", "该头寸的对冲比例已经达到目标");
    const add = target - p.hedgeUsd;
    const mk = this.market.market[d.und]?.px ?? p.hedgeEntry;
    if (this.tradingMode() === "live") {
      const res = await hl.placeOrder({ coin: d.und, isBuy: false, size: add / mk, price: mk * 0.995 });
      if (!res.ok) throw new EngineError("hedge_failed", `Hyperliquid 补对冲失败：${res.error}`, 502);
    }
    p.hedgeEntry = (p.hedgeUsd * p.hedgeEntry + add * mk) / (p.hedgeUsd + add);
    p.hedgeUsd = target;
    this.repo.positionUpsert(accountId, p);
    this.log(user, accountId, "补对冲", d.title, "HL", `追加 ${d.und}-PERP ${usd(add, 0)}，对冲比例回到 100%`);
    this.feed(accountId, { kind: "ok", title: "对齐对冲腿", detail: d.title, val: usd(add, 0) });
    this.touch();
  }

  async alignAll(user: Actor, accountId: AccountId): Promise<number> {
    const account = this.account(accountId);
    if (account.kill) throw new EngineError("kill_switch", "该账户已熔断，请先解除熔断", 409);
    const b = this.book(accountId);
    let count = 0;
    for (const row of b.rows) {
      if (row.ratio >= 0.999) continue;
      const p = this.repo.positionsAll(accountId).find(x => x.evId === row.evId);
      if (!p) continue;
      const add = row.target - p.hedgeUsd;
      if (add <= 0) continue;
      const mk = this.market.market[row.ev.und]?.px ?? p.hedgeEntry;
      if (this.tradingMode() === "live") {
        const res = await hl.placeOrder({ coin: row.ev.und, isBuy: false, size: add / mk, price: mk * 0.995 });
        if (!res.ok) throw new EngineError("hedge_failed", `${row.ev.und} 补对冲失败：${res.error}`, 502);
      }
      p.hedgeEntry = (p.hedgeUsd * p.hedgeEntry + add * mk) / (p.hedgeUsd + add);
      p.hedgeUsd = row.target;
      this.repo.positionUpsert(accountId, p);
      count++;
    }
    if (count) {
      this.log(user, accountId, "批量补对冲", "全部持仓", "HL", `${count} 个头寸的对冲腿已对齐`);
      this.feed(accountId, { kind: "ok", title: "全部对冲腿已对齐", detail: `${count} 个头寸`, val: "100%" });
      this.touch();
    }
    return count;
  }

  createCombo(user: Actor, accountId: AccountId, input: { eventId: string; sizeUsd: number }): Position {
    const account = this.account(accountId);
    if (!account.enabled) throw new EngineError("account_disabled", "该账户已被管理员停用", 409);
    const d = this.derived(accountId).find(r => r.id === input.eventId);
    if (!d) throw new EngineError("event_not_found", "事件不存在或不属于该账户策略", 404);
    if (!(input.sizeUsd >= 1000)) throw new EngineError("size_too_small", "最低 1,000 USDC");
    const qty = Math.floor(input.sizeUsd / d.ask / 100) * 100;
    if (qty < 100) throw new EngineError("size_too_small", "规模不足以买入最小股数");
    if (qty * d.ask > account.equity * 0.25) throw new EngineError("size_too_large", "单笔不得超过账户净值的 25%");
    const target = qty * Math.abs(d.delta);
    const hedge = target * 0.96;
    const mark = this.market.market[d.und]?.px ?? 1;
    const p: Position = {
      evId: d.id, qty, avg: d.ask, hedgeUsd: +hedge.toFixed(2), hedgeEntry: mark,
      accountId, openedAt: new Date().toISOString()
    };
    this.repo.positionUpsert(accountId, p);
    this.log(user, accountId, "建立组合", d.title, "PM + HL",
      `${accountDef(accountId).name} · 买入 ${qty.toLocaleString("en-US")} YES @ ${(d.ask * 100).toFixed(1)}¢；对冲 ${d.und}-PERP ${usd(hedge, 0)}`);
    this.feed(accountId, { kind: "ok", title: "建立对冲组合", detail: d.title, val: usd(input.sizeUsd, 0) });
    this.touch();
    return p;
  }

  flattenAll(user: Actor, accountId: AccountId): { legs: number; pnl: number; events: number } {
    if (this.tradingMode() === "live") {
      throw new EngineError("live_bulk_flatten_disabled", "实盘批量平仓需要逐笔交易所回报确认，请按订单或持仓逐笔平仓", 409);
    }
    const b = this.book(accountId);
    const legs = b.rows.length * 2;
    if (!legs && this.repo.ordersAll(accountId).length === 0 && this.repo.reviewsAll(accountId).length === 0) {
      throw new EngineError("nothing_to_close", "该账户的执行台与持仓账本都已经是空的", 409);
    }
    const pnl = b.pnl;
    this.adjustEquity(accountId, pnl);
    this.repo.clearTradingState(accountId);
    this.log(user, accountId, "全部平仓", "账户全组合", "PM + HL",
      `${legs} 条腿按对手价平仓，实现盈亏 ${signedUsd(pnl)}，账本清零`);
    this.feed(accountId, { kind: "warn", title: "账户全组合已平仓", detail: `${legs} 条腿`, val: signedUsd(pnl) });
    this.touch();
    return { legs, pnl, events: b.rows.length };
  }

  /* ---------------- reviews ---------------- */
  private reviewRemaining(r: Review): number {
    if (r.deadline) return Math.max(0, Math.ceil((r.deadline - Date.now()) / 1000));
    return Math.max(0, r.seconds);
  }

  private tickReviews(): void {
    for (const account of this.accounts()) {
      const reviews = this.repo.reviewsAll(account.id);
      const expired: Review[] = [];
      for (const r of reviews) {
        if (this.reviewRemaining(r) <= 0) expired.push(r);
      }
      for (const r of expired) void this.autoFlattenReview(account.id, r);
      if (Date.now() - this.lastReviewsPersist > 10_000) {
        for (const r of reviews) {
          const remaining = this.reviewRemaining(r);
          if (remaining !== r.seconds && remaining > 0) this.repo.reviewUpsert(account.id, { ...r, seconds: remaining });
        }
      }
    }
    if (Date.now() - this.lastReviewsPersist > 10_000) this.lastReviewsPersist = Date.now();
  }

  private async autoFlattenReview(accountId: AccountId, r: Review): Promise<void> {
    const d = this.market.events.find(e => e.id === r.evId);
    const p = this.repo.positionsAll(accountId).find(x => x.evId === r.evId);
    try {
      if (this.tradingMode() === "live" && d && p) await this.closeLiveLegs(accountId, d, p.qty, p.qty, p.hedgeUsd);
    } catch (err) {
      this.riskEvent(accountId, { level: "bad", title: "自动平仓失败", detail: (err as Error).message, val: r.id });
      this.createReview(accountId, {
        evId: r.evId, kind: "自动平仓失败", reason: (err as Error).message,
        action: "待接管订单仍保留", advice: "立即手动平仓两条腿", seconds: 15 * 60, severity: "bad"
      });
      return;
    }
    this.repo.reviewDelete(accountId, r.id);
    this.closePositionPart({ id: "system", name: "自动引擎", role: "admin" }, accountId, r.evId);
    this.log({ id: "system", name: "自动引擎", role: "admin" }, accountId, "自动平仓", d?.title ?? r.evId, "PM + HL",
      "接管倒计时结束，两条腿已按对手价平仓");
    this.feed(accountId, { kind: "warn", title: "接管到期 · 已自动平仓", detail: d?.title ?? r.evId, val: r.id });
    this.touch();
  }

  takeReview(user: Actor, accountId: AccountId, id: string, mode: "shrink" | "abort" | "hold"): void {
    const r = this.repo.reviewsAll(accountId).find(x => x.id === id);
    if (!r) throw new EngineError("review_not_found", "待接管订单不存在", 404);
    const d = this.market.events.find(e => e.id === r.evId);
    this.repo.reviewDelete(accountId, id);
    const label = mode === "shrink" ? "缩减至盘口规模后重发第二腿" : mode === "abort" ? "放弃机会并回滚合约腿" : "保留裸敞口 30 分钟";
    this.log(user, accountId, "接管", d?.title ?? r.evId, "PM + HL", `${label} · ${r.id}`);
    this.feed(accountId, { kind: "warn", title: `接管 ${r.id}`, detail: label, val: user.name });
    this.touch();
  }

  ignoreReview(user: Actor, accountId: AccountId, id: string): void {
    const r = this.repo.reviewsAll(accountId).find(x => x.id === id);
    if (!r) throw new EngineError("review_not_found", "待接管订单不存在", 404);
    const d = this.market.events.find(e => e.id === r.evId);
    this.repo.reviewDelete(accountId, id);
    this.log(user, accountId, "忽略待接管", d?.title ?? r.evId, "账户", `标记 ${r.id} 为已知风险，不再进入待接管队列`);
    this.touch();
  }

  async flattenReview(user: Actor, accountId: AccountId, id: string): Promise<void> {
    const r = this.repo.reviewsAll(accountId).find(x => x.id === id);
    if (!r) throw new EngineError("review_not_found", "待接管订单不存在", 404);
    const d = this.market.events.find(e => e.id === r.evId);
    const p = this.repo.positionsAll(accountId).find(x => x.evId === r.evId);
    if (this.tradingMode() === "live" && d && p) await this.closeLiveLegs(accountId, d, p.qty, p.qty, p.hedgeUsd);
    this.repo.reviewDelete(accountId, id);
    this.closePositionPart(user, accountId, r.evId);
    this.log(user, accountId, "立即平仓", d?.title ?? r.evId, "PM + HL", `待接管订单 ${r.id} 两条腿已提交平仓`);
    this.touch();
  }

  /* ---------------- risk controls (per account) ---------------- */
  setKill(user: Actor, accountId: AccountId, enabled: boolean, reason: string): void {
    const account = this.account(accountId);
    if (enabled === account.kill) return;
    saveAccountSettings(this.repo, accountId, {
      kill: enabled,
      auto: enabled ? false : true,
      killReason: reason,
      lastKillAt: enabled ? Date.now() : account.lastKillAt
    });
    if (enabled) {
      for (const o of this.repo.ordersAll(accountId)) {
        if (o.status === "filled" || o.status === "failed") continue;
        this.repo.orderDelete(accountId, o.id);
        if (o.legs[0].filled > 0) {
          this.createReview(accountId, {
            evId: o.evId, kind: "熔断撤单", reason: `${o.id} 合约腿已成交 ${o.legs[0].filled} 股，对冲腿被撤销`,
            action: "保留裸敞口，等待人工处理", advice: "解除熔断后立即补对冲或平仓",
            seconds: 30 * 60, severity: "bad"
          });
        }
      }
      this.riskEvent(accountId, { level: "bad", title: "熔断触发", detail: reason, val: accountDef(accountId).name });
      this.log(user, accountId, "熔断", accountDef(accountId).name, "PM + HL", `${reason}；挂单已撤销，新开仓与补对冲停止`);
      this.feed(accountId, { kind: "warn", title: "熔断触发", detail: reason, val: "账户停止" });
    } else {
      this.log(user, accountId, "解除熔断", accountDef(accountId).name, "账户", `${reason}；自动执行恢复，护栏规则继续生效`);
      this.feed(accountId, { kind: "ok", title: "解除熔断", detail: reason, val: "已恢复" });
    }
    this.market.persist();
    this.touch();
  }

  setAuto(user: Actor, accountId: AccountId, enabled: boolean): void {
    const account = this.account(accountId);
    if (account.kill && enabled) throw new EngineError("kill_switch", "熔断中不能开启自动执行", 409);
    saveAccountSettings(this.repo, accountId, { auto: enabled });
    this.log(user, accountId, "自动执行", enabled ? "开启" : "暂停", "账户", enabled ? "满足阈值的信号进入自动执行" : "信号只推送，不自动下单");
    this.touch();
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
    return { ...limit, value, used: limit.used };
  }

  resetLimits(user: Actor, accountId: AccountId): void {
    this.repo.limitsReplace(accountId, this.scaledDefaultLimits(accountId));
    this.log(user, accountId, "恢复默认限额", "账户限额", accountDef(accountId).name, "该账户限额回到按净值缩放的基准值");
    this.touch();
  }

  toggleRule(user: Actor, accountId: AccountId, id: string, on: boolean): Rule {
    const rule = this.rules(accountId).find(r => r.id === id);
    if (!rule) throw new EngineError("rule_not_found", "规则不存在", 404);
    this.repo.ruleSet(accountId, id, on);
    this.log(user, accountId, on ? "启用规则" : "关闭规则", rule.name, accountDef(accountId).name,
      on ? "规则重新参与该账户的下单前校验" : "关闭期间该账户不再被此规则拦截");
    this.touch();
    return { ...rule, on };
  }

  /** Admin-only: change an account's equity, enablement or execution parameters. */
  updateAccount(user: Actor, accountId: AccountId, patch: Partial<{
    enabled: boolean; equity: number; minEdge: number; paperFillMs: number;
  }>): AccountSettings {
    const account = this.account(accountId);
    const book = this.book(accountId);
    if (patch.equity != null) {
      if (!Number.isFinite(patch.equity) || patch.equity <= 0) throw new EngineError("equity_invalid", "账户净值必须大于 0", 409);
      if (patch.equity < book.cost * 0.98) {
        throw new EngineError("equity_below_deployed",
          `该账户已部署 ${usd(book.cost, 0)}，净值不能低于部署的 98%。`, 409);
      }
    }
    if (patch.minEdge != null && (!Number.isFinite(patch.minEdge) || patch.minEdge < 0 || patch.minEdge > 50)) {
      throw new EngineError("min_edge_invalid", "净边阈值需在 0–50¢ 之间", 409);
    }
    if (patch.paperFillMs != null && (!Number.isFinite(patch.paperFillMs) || patch.paperFillMs < 200)) {
      throw new EngineError("fill_invalid", "纸面成交延迟至少 200ms", 409);
    }
    const next = saveAccountSettings(this.repo, accountId, patch);
    if (patch.equity != null && patch.equity !== account.equity) {
      const delta = patch.equity - account.equity;
      const points = this.repo.equityAll(accountId);
      if (points.length) {
        const last = points[points.length - 1]!;
        last.v = Math.max(1, last.v + delta);
        this.repo.equityReplace(accountId, points);
      }
    }
    this.log(user, accountId, "调整账户", accountDef(accountId).name, "后台",
      Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(" · "));
    this.touch();
    return next;
  }

  /* ---------------- equity ---------------- */
  private adjustEquity(accountId: AccountId, delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    const account = this.account(accountId);
    const next = Math.max(0, account.equity + delta);
    saveAccountSettings(this.repo, accountId, { equity: next });
    const points = this.repo.equityAll(accountId);
    if (points.length) {
      const last = points[points.length - 1]!;
      last.v = Math.max(1, last.v + delta);
      this.repo.equityReplace(accountId, points);
    }
  }

  /* ---------------- catalog ---------------- */
  async refreshCatalog(user: Actor): Promise<{ mode: string; events: number; message: string }> {
    const result = await this.market.refreshCatalog(true);
    this.logGlobal(user, "刷新事件目录", "扫描面", "PM", `${result.message}，共 ${result.events} 个事件`);
    this.touch();
    return result;
  }

  /** Global 90% check for admin rebalancing across independent accounts. */
  equityTotal(): number {
    return this.accounts().reduce((sum, a) => sum + a.equity, 0);
  }

  accountIds(): AccountId[] { return ACCOUNT_DEFS.map(a => a.id); }
}
