import { config, type MarketDataMode } from "../config.js";
import type { Repository } from "../db/repository.js";
import { digitalFair, hedgeDelta, clamp } from "../domain/pricing.js";
import type { EventContract, Market, MarketTick, VenueStatus } from "../domain/types.js";
import { DAY_MS } from "../util.js";
import { generateDemoCatalog } from "./demo-catalog.js";
import * as hl from "../venues/hyperliquid.js";
import * as pm from "../venues/polymarket.js";
import { logger } from "../logger.js";

const FALLBACK_MARKET: Market = {
  BTC: { px: 64_115, chg: 0.82 },
  ETH: { px: 1_794.9, chg: 1.14 },
  SOL: { px: 74.25, chg: 0.41 },
  HYPE: { px: 68.55, chg: -0.36 }
};

const DEFAULT_VOLS: Record<string, number> = {
  BTC: 0.55, ETH: 0.65, SOL: 0.85, HYPE: 0.95, XRP: 0.8, DOGE: 0.9, BNB: 0.7, AVAX: 0.85, LINK: 0.8
};

const TRACKED = ["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE", "BNB", "AVAX", "LINK"];

export class MarketService {
  market: Market = structuredClone(FALLBACK_MARKET);
  events: EventContract[] = [];
  vols: Record<string, number> = { ...DEFAULT_VOLS };
  hlStatus: VenueStatus;
  pmStatus: VenueStatus;
  catalogMode: "live" | "demo" = "demo";
  scanSeq = 48_219;
  lastScanAt = Date.now();
  lastCatalogAt = 0;
  lastHlAt = 0;
  lastFullHlAt = 0;
  private hlFailures = 0;
  private hlCooldownUntil = 0;
  private nextCatalogAt = 0;
  private refreshing = false;

  constructor(private readonly repo: Repository) {
    this.hlStatus = {
      id: "hyperliquid", label: "Hyperliquid 永续", state: "degraded", latencyMs: null,
      message: "尚未连接", lastOkAt: null, mode: "live"
    };
    this.pmStatus = {
      id: "polymarket", label: "Polymarket CLOB", state: "degraded", latencyMs: null,
      message: "尚未连接", lastOkAt: null, mode: "demo"
    };
  }

  get mode(): MarketDataMode { return config.marketDataMode; }

  async init(): Promise<void> {
    await this.refreshHyperliquid();
    await this.refreshVols();

    const persisted = this.repo.eventsAll(true);
    if (persisted.length >= 12) {
      this.events = persisted;
      this.catalogMode = persisted.some(e => e.source === "polymarket") ? "live" : "demo";
      this.pmStatus.mode = this.catalogMode;
    } else {
      await this.buildCatalog(true);
    }

    // If the operator explicitly asked for live data, try a catalog refresh in
    // the background; an unreachable venue must never prevent the terminal from starting.
    if (this.mode !== "demo" && this.catalogMode !== "live") {
      void this.tryLiveCatalog();
    }

    this.updateModelSpots();
    this.recomputeFair();
    this.lastScanAt = Date.now();
  }

  async refreshHyperliquid(light = false): Promise<void> {
    if (!config.hl.enabled) {
      this.hlStatus = {
        ...this.hlStatus, state: "disabled", message: "HL_ENABLED=false", latencyMs: null
      };
      return;
    }
    if (Date.now() < this.hlCooldownUntil) return;
    const fullDue = !this.lastFullHlAt || Date.now() - this.lastFullHlAt > 8_000;
    try {
      if (!light || fullDue) {
        const snap = await hl.fetchSnapshot();
        for (const [coin, tick] of Object.entries(snap.market)) {
          if (TRACKED.includes(coin) || this.events.some(e => e.und === coin)) this.market[coin] = tick;
        }
        this.lastFullHlAt = Date.now();
        this.lastHlAt = Date.now();
        this.hlStatus = {
          id: "hyperliquid", label: "Hyperliquid 永续", state: "ok",
          latencyMs: snap.latencyMs, message: config.hl.testnet ? "测试网连接正常" : "主网连接正常",
          lastOkAt: Date.now(), mode: "live"
        };
      } else {
        const { mids, latencyMs } = await hl.fetchMids();
        for (const [coin, px] of Object.entries(mids)) {
          const current = this.market[coin];
          if (!current) continue;
          current.px = px;
          if (current.prevDayPx && current.prevDayPx > 0) current.chg = (px / current.prevDayPx - 1) * 100;
        }
        this.lastHlAt = Date.now();
        this.hlStatus = {
          ...this.hlStatus, state: "ok", latencyMs,
          message: config.hl.testnet ? "测试网连接正常" : "主网连接正常", lastOkAt: Date.now()
        };
      }
      this.hlFailures = 0;
      this.hlCooldownUntil = 0;
    } catch (err) {
      this.hlFailures += 1;
      const backoff = Math.min(60_000, 5_000 * 2 ** Math.min(4, this.hlFailures));
      this.hlCooldownUntil = Date.now() + backoff;
      logger.warn({ err: (err as Error).message, backoff }, "Hyperliquid snapshot failed");
      this.hlStatus = {
        ...this.hlStatus, state: "down", latencyMs: null,
        message: `行情不可达：${(err as Error).message}`
      };
    }
  }

  async refreshVols(): Promise<void> {
    if (!config.hl.enabled) return;
    const coins = Object.keys(DEFAULT_VOLS);
    const settled = await Promise.allSettled(coins.map(c => hl.realisedVol(c, DEFAULT_VOLS[c] ?? 0.7)));
    settled.forEach((r, i) => {
      const coin = coins[i]!;
      if (r.status === "fulfilled") this.vols[coin] = r.value;
    });
  }

  private updateModelSpots(): void {
    for (const ev of this.events) {
      if (!ev.model) continue;
      const spot = this.market[ev.und]?.px;
      if (spot) ev.model.spot = spot;
      ev.model.vol = this.vols[ev.und] ?? ev.model.vol;
    }
  }

  recomputeFair(): void {
    const now = Date.now();
    for (const ev of this.events) {
      if (ev.model) {
        const days = Math.max(0.25, (Date.parse(ev.due) - now) / DAY_MS);
        const fair = digitalFair({
          spot: ev.model.spot ?? this.market[ev.und]?.px ?? 0,
          strike: ev.model.strike,
          vol: ev.model.vol,
          days,
          direction: ev.model.direction
        });
        if (fair != null) ev.fair = +fair.toFixed(4);
        ev.delta = hedgeDelta({
          spot: ev.model.spot ?? this.market[ev.und]?.px ?? 0,
          strike: ev.model.strike,
          vol: ev.model.vol,
          days,
          direction: ev.model.direction
        });
      }
    }
  }

  /** Mean-reverting quote jitter for demo books; real PM books are left untouched. */
  private jitterDemoQuotes(): void {
    const now = Date.now();
    for (const ev of this.events) {
      if (ev.source !== "demo") continue;
      const age = now - (ev.quoteAt ?? now);
      // Only part of the book refreshes each tick, so a handful of quotes genuinely go stale.
      // Anything older than 11s is forced to refresh, keeping the demo bounded.
      if (age < 11_000 && Math.random() < 0.55) {
        ev.quoteAgeMs = age;
        continue;
      }
      const baseAsk = ev.baseAsk ?? ev.ask;
      const baseBid = ev.baseBid ?? ev.bid;
      const baseFair = ev.baseFair ?? ev.fair;
      const spread = Math.max(0.002, baseAsk - baseBid);
      const baseGross = baseFair - (baseAsk + baseBid) / 2;
      const desiredAsk = clamp(ev.fair - baseGross + spread / 2, 0.021, 0.96);
      const noise = (Math.random() - 0.5) * 0.0016;
      ev.ask = clamp(ev.ask + (desiredAsk - ev.ask) * 0.16 + noise, 0.02, 0.96);
      ev.bid = clamp(ev.ask - spread, 0.01, ev.ask - 0.002);
      ev.quoteAt = now;
      ev.quoteRefPx = this.market[ev.und]?.px;
      ev.quoteAgeMs = 0;
    }
  }

  async tick(): Promise<void> {
    await this.refreshHyperliquid();
    this.updateModelSpots();
    this.recomputeFair();
    const now = Date.now();
    for (const ev of this.events) {
      // Live PM quotes are a polling snapshot; we do not claim per-tick staleness for them.
      ev.quoteAgeMs = ev.source === "demo" ? Math.max(0, now - (ev.quoteAt ?? now)) : 0;
    }
    this.jitterDemoQuotes();
    this.scanSeq += 1;
    this.lastScanAt = Date.now();

    const shouldRefresh = this.mode !== "demo"
      && config.pm.enabled
      && Date.now() > this.nextCatalogAt
      && !this.refreshing;
    if (shouldRefresh) void this.tryLiveCatalog();
  }

  private async buildCatalog(force: boolean): Promise<void> {
    const generated = generateDemoCatalog({
      market: this.market,
      vols: this.vols,
      size: 140
    });
    const held = new Set(this.repo.positionsAll().map(p => p.evId));
    const incoming = new Set(generated.map(e => e.id));
    const preserved = this.events.filter(e => held.has(e.id) && !incoming.has(e.id)).map(e => ({ ...e, stale: true }));
    this.events = [...generated, ...preserved];
    for (const ev of this.events) {
      ev.quoteAt = ev.quoteAt ?? Date.now();
      ev.quoteRefPx = ev.quoteRefPx ?? this.market[ev.und]?.px;
    }
    this.catalogMode = "demo";
    this.pmStatus = {
      id: "polymarket", label: "Polymarket CLOB", state: config.pm.enabled ? "degraded" : "disabled",
      latencyMs: null,
      message: config.pm.enabled
        ? (this.mode === "demo" ? "MARKET_DATA_MODE=demo，使用示例盘口（HL 行情为实时）" : "Polymarket 不可达，使用示例盘口（HL 行情为实时）")
        : "PM_ENABLED=false，使用示例盘口",
      lastOkAt: null, mode: "demo"
    };
    this.repo.eventsReplace(this.events, true);
    this.lastCatalogAt = Date.now();
    if (force) logger.warn({ events: this.events.length }, "using demo Polymarket catalog");
  }

  private async tryLiveCatalog(): Promise<boolean> {
    if (this.refreshing) return false;
    this.refreshing = true;
    try {
      const catalog = await pm.fetchCatalog(this.market, this.vols);
      if (catalog.events.length < 6) throw new Error(`仅解析到 ${catalog.events.length} 个可交易市场`);
      const held = new Set(this.repo.positionsAll().map(p => p.evId));
      const incoming = new Set(catalog.events.map(e => e.id));
      const preserved = this.events.filter(e => held.has(e.id) && !incoming.has(e.id)).map(e => ({ ...e, stale: true }));
      const merged = [...catalog.events, ...preserved];
      const now = Date.now();
      for (const ev of merged) {
        // A fresh PM catalog snapshot: quote age starts at zero for every live event.
        ev.quoteAt = now;
        ev.quoteRefPx = this.market[ev.und]?.px;
        ev.quoteAgeMs = 0;
      }
      this.events = merged;
      this.catalogMode = "live";
      this.repo.eventsReplace(merged, true);
      this.pmStatus = {
        id: "polymarket", label: "Polymarket CLOB", state: "ok",
        latencyMs: null, message: `已接入 ${catalog.events.length} 个可交易市场（扫描 ${catalog.scanned}）`,
        lastOkAt: Date.now(), mode: "live"
      };
      this.lastCatalogAt = Date.now();
      this.nextCatalogAt = Date.now() + 3 * 60_000;
      logger.info({ events: catalog.events.length, scanned: catalog.scanned }, "Polymarket catalog loaded");
      return true;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Polymarket catalog unavailable");
      this.pmStatus = {
        id: "polymarket", label: "Polymarket CLOB", state: config.pm.enabled ? "degraded" : "disabled",
        latencyMs: null, message: `数据源不可达：${(err as Error).message}`,
        lastOkAt: this.pmStatus.lastOkAt, mode: this.catalogMode
      };
      this.lastCatalogAt = Date.now();
      this.nextCatalogAt = Date.now() + 15 * 60_000;
      if (!this.events.length) await this.buildCatalog(true);
      return false;
    } finally {
      this.refreshing = false;
    }
  }

  async refreshCatalog(force = false): Promise<{ mode: "live" | "demo"; events: number; message: string }> {
    if (this.mode === "demo") {
      await this.buildCatalog(force);
      return { mode: "demo", events: this.events.length, message: "已重建示例目录" };
    }
    const ok = await this.tryLiveCatalog();
    if (!ok && force && this.mode === "auto") {
      await this.buildCatalog(true);
      return { mode: "demo", events: this.events.length, message: "Polymarket 不可达，已回退示例目录" };
    }
    return { mode: this.catalogMode, events: this.events.length, message: this.pmStatus.message };
  }

  persist(): void {
    this.repo.eventsReplace(this.events, true);
  }

  snapshot() {
    return {
      market: this.market,
      events: this.events,
      vols: this.vols,
      catalogMode: this.catalogMode,
      scanSeq: this.scanSeq,
      lastScanAt: this.lastScanAt,
      venues: [this.hlStatus, this.pmStatus],
      universe: this.events.length
    };
  }

  setMarketForTest(market: Market, vols: Record<string, number> = {}): void {
    this.market = { ...this.market, ...market };
    this.vols = { ...this.vols, ...vols };
  }

  static fallbackMarket(): Market { return structuredClone(FALLBACK_MARKET); }
  static tracked(): string[] { return [...TRACKED]; }
}

export type { MarketTick };
