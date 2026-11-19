import { config, type MarketDataMode } from "../config.js";
import type { Repository } from "../db/repository.js";
import type { Market, MarketTick, NegRiskOpportunity, VenueStatus } from "../domain/types.js";
import type { PmBookTop, PmMmMarket, PmTrade } from "../venues/polymarket.js";
import { demoBooks, demoMmUniverse, demoNegRisk, demoTrades } from "./demo-desks.js";
import * as hl from "../venues/hyperliquid.js";
import * as pm from "../venues/polymarket.js";
import { logger } from "../logger.js";

const FALLBACK_MARKET: Market = {
  BTC: { px: 64_115, chg: 0.82 },
  ETH: { px: 1_794.9, chg: 1.14 },
  SOL: { px: 74.25, chg: 0.41 },
  HYPE: { px: 68.55, chg: -0.36 }
};

const TRACKED = ["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE", "BNB", "AVAX", "LINK"];

/**
 * Venue service for the two desks:
 *  - Hyperliquid supplies the macro price strip only; it is not traded.
 *  - Polymarket supplies the NegRisk basket scan, the high-liquidity market
 *    universe, live top-of-book for quoted YES tokens, and the taker tape.
 */
export class MarketService {
  market: Market = structuredClone(FALLBACK_MARKET);
  negRisk: NegRiskOpportunity[] = [];
  negRiskAt = 0;
  mmUniverse: PmMmMarket[] = [];
  mmBooks: Record<string, PmBookTop> = {};
  mmUniverseAt = 0;
  mmBooksAt = 0;
  hlStatus: VenueStatus;
  pmStatus: VenueStatus;
  catalogMode: "live" | "demo" | "offline" = "offline";
  scanSeq = 0;
  lastScanAt = Date.now();
  lastHlAt = 0;
  lastFullHlAt = 0;
  private hlFailures = 0;
  private hlCooldownUntil = 0;

  constructor(private readonly repo: Repository) {
    this.hlStatus = {
      id: "hyperliquid", label: "Hyperliquid 行情", state: "degraded", latencyMs: null,
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
    await this.refreshDesks(true);
    this.lastScanAt = Date.now();
    void this.repo;
  }

  async refreshHyperliquid(): Promise<void> {
    if (!config.hl.enabled) {
      this.hlStatus = { ...this.hlStatus, state: "disabled", message: "HL_ENABLED=false", latencyMs: null };
      return;
    }
    if (Date.now() < this.hlCooldownUntil) return;
    const fullDue = !this.lastFullHlAt || Date.now() - this.lastFullHlAt > 8_000;
    try {
      if (fullDue) {
        const snap = await hl.fetchSnapshot();
        for (const [coin, tick] of Object.entries(snap.market)) {
          if (TRACKED.includes(coin)) this.market[coin] = tick;
        }
        this.lastFullHlAt = Date.now();
        this.lastHlAt = Date.now();
        this.hlStatus = {
          id: "hyperliquid", label: "Hyperliquid 行情", state: "ok",
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
        this.hlStatus = { ...this.hlStatus, state: "ok", latencyMs, lastOkAt: Date.now() };
      }
      this.hlFailures = 0;
      this.hlCooldownUntil = 0;
    } catch (err) {
      this.hlFailures += 1;
      const backoff = Math.min(60_000, 5_000 * 2 ** Math.min(4, this.hlFailures));
      this.hlCooldownUntil = Date.now() + backoff;
      logger.warn({ err: (err as Error).message, backoff }, "Hyperliquid snapshot failed");
      this.hlStatus = { ...this.hlStatus, state: "down", latencyMs: null, message: `行情不可达：${(err as Error).message}` };
    }
  }

  /**
   * NegRisk is rescanned every 90s; the market-making pool every 5 minutes.
   * Demo/test mode rebuilds both deterministically and never claims live data.
   */
  async refreshDesks(force = false): Promise<void> {
    const demo = config.seedTestFixture || this.mode === "demo" || !config.pm.enabled;
    const now = Date.now();
    if (demo) {
      this.negRisk = demoNegRisk(now);
      this.negRiskAt = now;
      this.mmUniverse = demoMmUniverse(now);
      this.mmUniverseAt = now;
      this.mmBooks = demoBooks(this.mmUniverse, now);
      this.mmBooksAt = now;
      this.catalogMode = "demo";
      this.pmStatus = {
        id: "polymarket", label: "Polymarket CLOB",
        state: config.pm.enabled ? "degraded" : "disabled", latencyMs: null,
        message: "示例盘口：仅用于测试夹具 / 演示模式，不代表真实盘口",
        lastOkAt: null, mode: "demo"
      };
      return;
    }
    if (!force && now - this.negRiskAt < 90_000 && now - this.mmUniverseAt < 5 * 60_000) return;
    try {
      if (force || now - this.negRiskAt >= 90_000) {
        this.negRisk = await pm.fetchNegRiskOpportunities();
        this.negRiskAt = now;
      }
      if (force || now - this.mmUniverseAt >= 5 * 60_000) {
        this.mmUniverse = await pm.fetchMmUniverse(60);
        this.mmUniverseAt = now;
      }
      this.catalogMode = this.mmUniverse.length || this.negRisk.length ? "live" : "offline";
      this.pmStatus = {
        ...this.pmStatus, state: "ok", lastOkAt: now, mode: "live",
        message: `NegRisk ${this.negRisk.length} 个事件 · 做市池 ${this.mmUniverse.length} 个市场`
      };
      logger.info({ negRisk: this.negRisk.length, ready: this.negRisk.filter(o => o.status === "ready").length, mm: this.mmUniverse.length }, "desk universe refreshed");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "desk universe refresh failed");
      this.pmStatus = {
        ...this.pmStatus, state: "degraded",
        message: `Polymarket 目录不可达：${(err as Error).message}${this.mmUniverse.length ? " · 沿用最近快照" : ""}`
      };
    }
  }

  async refreshMmBooks(tokenIds: string[]): Promise<Record<string, PmBookTop>> {
    if (!tokenIds.length) return {};
    const demo = config.seedTestFixture || this.mode === "demo" || !config.pm.enabled;
    if (demo) {
      this.mmBooks = demoBooks(this.mmUniverse, Date.now());
      this.mmBooksAt = Date.now();
      return this.mmBooks;
    }
    try {
      const fresh = await pm.fetchMmBooks(tokenIds);
      this.mmBooks = { ...this.mmBooks, ...fresh };
      this.mmBooksAt = Date.now();
      return fresh;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "CLOB books refresh failed");
      return {};
    }
  }

  async recentMmTrades(sinceMs: number): Promise<PmTrade[]> {
    const demo = config.seedTestFixture || this.mode === "demo" || !config.pm.enabled;
    if (demo) {
      return demoTrades(this.mmUniverse, this.mmBooks, Date.now()).filter(t => t.ts >= sinceMs);
    }
    try {
      const all = await pm.fetchMmTrades(500);
      return all.filter(t => t.ts > sinceMs);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "trade tape unavailable");
      return [];
    }
  }

  async refreshNegRisk(force = false): Promise<void> {
    await this.refreshDesks(force);
  }

  async tick(): Promise<void> {
    await this.refreshHyperliquid();
    await this.refreshDesks(false);
    this.scanSeq += 1;
    this.lastScanAt = Date.now();
  }

  async refreshCatalog(force = false): Promise<{ mode: string; events: number; message: string }> {
    await this.refreshDesks(force);
    return {
      mode: this.catalogMode,
      events: this.negRisk.length + this.mmUniverse.length,
      message: this.pmStatus.message
    };
  }

  persist(): void {
    void this.repo;
  }

  snapshot() {
    return {
      market: this.market,
      negRisk: this.negRisk,
      mmUniverse: this.mmUniverse,
      mmBooks: this.mmBooks,
      catalogMode: this.catalogMode,
      scanSeq: this.scanSeq,
      lastScanAt: this.lastScanAt,
      venues: [this.hlStatus, this.pmStatus]
    };
  }

  setMarketForTest(market: Market): void {
    this.market = { ...this.market, ...market };
  }

  static fallbackMarket(): Market { return structuredClone(FALLBACK_MARKET); }
  static tracked(): string[] { return [...TRACKED]; }
}

export type { MarketTick };
