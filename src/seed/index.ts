import { randomUUID } from "node:crypto";
import type { Repository } from "../db/repository.js";
import { derive } from "../domain/pricing.js";
import type {
  AccountId, AuditEntry, CalendarItem, DerivedEvent, EquityPoint, FeedItem, Limit, Order, Position, Review, RiskEvent, Rule
} from "../domain/types.js";
import { DEFAULT_LIMITS, DEFAULT_RULES } from "../domain/risk.js";
import { ACCOUNT_DEFS, accountDef, eligibleFor } from "../domain/accounts.js";
import { accountsAll, getSettings, saveSettings } from "../settings.js";
import { clock, dateShort, hhmm, mulberry32, simParts } from "../util.js";
import { hashPassword } from "../auth.js";
import type { MarketService } from "../market/service.js";
import { logger } from "../logger.js";

const DAY = 86_400_000;

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

function scaledLimits(equity: number, accountId: AccountId): Limit[] {
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
    if (repo.limitsAll(acct.id).length === 0) repo.limitsReplace(acct.id, scaledLimits(acct.equity, acct.id));
    if (repo.rulesAll(acct.id).length === 0) repo.rulesReplace(acct.id, DEFAULT_RULES);
    if (repo.equityAll(acct.id).length === 0) seedEquity(repo, acct.id, acct.equity);
  }
}

/** Each account gets its own 365-day curve, ending at its own equity. */
export function seedEquity(repo: Repository, accountId: AccountId, equityNow: number, seed = 20_261_118): void {
  const def = accountDef(accountId);
  const rand = mulberry32(seed + def.short.charCodeAt(0) * 31);
  const n = 365;
  const raw: number[] = [1];
  const vol = accountId === "latency" ? 0.0022 : accountId === "converge" ? 0.0038 : 0.0062;
  const drift = accountId === "prob" ? 0.0009 : accountId === "converge" ? 0.0006 : accountId === "latency" ? 0.0005 : 0.0007;
  for (let i = 1; i < n; i++) {
    let r = drift + (rand() - 0.5) * vol;
    if (i === 296 || i === 297 || i === 298) r -= vol * 1.4;
    if (i === 214) r -= vol * 2;
    raw.push(raw[i - 1]! * (1 + r));
  }
  const factor = equityNow / raw[n - 1]!;
  const p = simParts();
  const end = Date.UTC(p.y, p.m - 1, p.d);
  const points: EquityPoint[] = raw.map((v, i) => ({ t: end - (n - 1 - i) * DAY, v: v * factor }));
  repo.equityReplace(accountId, points);
}

function pickEvents(market: MarketService, repo: Repository, accountId: AccountId, limit: number): DerivedEvent[] {
  const account = accountsAll(repo).find(a => a.id === accountId)!;
  const rows = market.events
    .filter(ev => eligibleFor(accountId, ev, market.market))
    .map(ev => derive(ev, {
      market: market.market, cost: getSettings(repo).cost, minEdge: account.minEdge,
      strategy: accountId, quoteAgeMs: ev.quoteAgeMs
    }))
    .filter(r => r.status === "ready")
    .sort((a, b) => b.net - a.net);
  const chosen: DerivedEvent[] = [];
  for (const row of rows) {
    if (chosen.length >= limit) break;
    if (chosen.some(c => c.und === row.und && Math.abs(c.days - row.days) < 3)) continue;
    chosen.push(row);
  }
  for (const row of rows) {
    if (chosen.length >= limit) break;
    if (!chosen.some(c => c.id === row.id)) chosen.push(row);
  }
  return chosen;
}

function forceStaleQuotes(market: MarketService, n = 4): void {
  const demos = market.events.filter(e => e.source === "demo" && Date.parse(e.due) > Date.now() + DAY);
  const step = Math.max(1, Math.floor(demos.length / n));
  for (let i = 0; i < n && i * step < demos.length; i++) {
    const ev = demos[i * step]!;
    const spot = market.market[ev.und]?.px;
    if (!spot) continue;
    ev.quoteAgeMs = 8_500;
    ev.quoteRefPx = spot * 0.9988;
  }
}

/**
 * Seed one independent book per account. Nothing is shared: sizes, limits, orders,
 * reviews and audit entries all carry the account id.
 */
export function seedTradingData(repo: Repository, market: MarketService): void {
  if (repo.metaGet("seededTrading") === "1") return;
  forceStaleQuotes(market);
  const accounts = accountsAll(repo);
  const settings = getSettings(repo);
  const rand = mulberry32(77_412);
  let orderNum = 8841;
  let reviewNum = 2201;
  let totalPositions = 0;
  let totalOrders = 0;

  for (const account of accounts) {
    const def = accountDef(account.id);
    // Leave one slot under each account's maxOpen cap so the first scan can demonstrate auto entry.
    const limit = account.id === "prob" ? 2 : 1;
    const chosen = pickEvents(market, repo, account.id, limit);
    if (!chosen.length) {
      logger.warn({ account: account.id }, "no tradable events for account; skipping seed book");
      continue;
    }

    const positions: Position[] = chosen.map((d, i) => {
      const share = account.id === "prob" ? 0.09 : account.id === "converge" ? 0.11 : account.id === "latency" ? 0.07 : 0.1;
      const budget = account.equity * share * (0.85 + rand() * 0.3);
      const qty = Math.max(100, Math.floor(budget / d.ask / 100) * 100);
      const mark = market.market[d.und]?.px ?? 1;
      const hedge = qty * Math.abs(d.delta) * (0.9 + rand() * 0.1);
      return {
        evId: d.id,
        qty,
        avg: +(Math.max(0.01, d.ask - (0.01 + rand() * 0.008))).toFixed(4),
        hedgeUsd: +hedge.toFixed(2),
        hedgeEntry: +(mark * (1.008 + rand() * 0.03)).toFixed(4),
        accountId: account.id,
        openedAt: new Date(Date.now() - (1 + i * 2) * DAY).toISOString()
      };
    }).filter(p => p.qty > 0);
    for (const p of positions) repo.positionUpsert(account.id, p);
    totalPositions += positions.length;

    const specs = account.id === "prob"
      ? [{ status: "hedging", text: "对冲中", fill: 0.62 }, { status: "filled", text: "已成交", fill: 1 }]
      : account.id === "converge"
        ? [{ status: "leg1", text: "等待合约腿", fill: 0 }]
        : account.id === "latency"
          ? [{ status: "filled", text: "已成交", fill: 1 }]
          : [{ status: "filled", text: "已成交", fill: 1 }];
    const orderEvents = chosen.slice(0, specs.length);
    orderEvents.forEach((d, i) => {
      const spec = specs[i]!;
      const qty = Math.max(100, Math.floor((account.equity * 0.045) / d.ask / 100) * 100);
      const hedge = qty * Math.abs(d.delta);
      const filled = Math.round(hedge * spec.fill);
      const order: Order = {
        id: `ORD-${orderNum--}`,
        evId: d.id,
        accountId: account.id,
        strategyId: account.id,
        status: spec.status as Order["status"],
        statusText: spec.text,
        notional: +(qty * d.ask).toFixed(2),
        qty,
        opened: hhmm(Date.now() - (62 - i * 17) * 60_000),
        strategy: `${def.name} · 自动`,
        slippageBps: 4.1 + i * 0.9,
        createdAt: Date.now() - (62 - i * 17) * 60_000,
        seeded: true,
        legs: [
          {
            venue: "POLYMARKET", side: "buy", label: "买入 YES", qty, filled: qty,
            price: d.ask, notional: +(qty * d.ask).toFixed(2), done: true
          },
          {
            venue: "HYPERLIQUID", side: "short", label: `做空 ${d.und}-PERP`,
            qty: +hedge.toFixed(4), filled, price: market.market[d.und]?.px ?? 0,
            notional: +filled.toFixed(2), done: filled >= hedge - 0.01,
            note: filled < hedge ? `缺口 $${Math.round(hedge - filled).toLocaleString("en-US")} · 已排队补单` : undefined
          }
        ]
      };
      repo.orderUpsert(account.id, order);
      totalOrders++;
    });

    if (account.id === "prob" || account.id === "converge") {
      const d = chosen[0]!;
      const review: Review = {
        id: `RV-${reviewNum--}`,
        accountId: account.id,
        evId: d.id,
        kind: account.id === "converge" ? "深度不足" : "资金费率异常",
        reason: account.id === "converge"
          ? `计划 ${Math.round(d.depth * 1.6).toLocaleString("en-US")} YES，盘口仅可成交 ${d.depth.toLocaleString("en-US")}`
          : "Hyperliquid 永续资金费率异常，持有 3 天将吞掉大部分净边",
        action: account.id === "converge" ? "已暂停对冲腿，保留已成交部分的裸敞口" : "已挂起对冲腿，未建立任何头寸",
        advice: account.id === "converge" ? "缩减至盘口规模后继续，或放弃本次机会" : "等待费率回落，或改用滚动对冲",
        seconds: (account.id === "converge" ? 4 : 12) * 3600 + Math.round(rand() * 3000),
        severity: "warn",
        createdAt: Date.now() - 900_000,
        deadline: Date.now() + 4 * 3600_000
      };
      repo.reviewUpsert(account.id, review);
    }

    const audit: AuditEntry[] = [
      { accountId: account.id, t: clock(Date.now() - 40_000), actor: "自动引擎", action: "开仓", obj: chosen[0]!.title, venue: "PM + HL", detail: `${def.name} · 买入 YES @ ${(chosen[0]!.ask * 100).toFixed(1)}¢；对冲已发送` },
      { accountId: account.id, t: clock(Date.now() - 26 * 60_000), actor: "林 · 自营", action: "调整账户", obj: def.name, venue: "后台", detail: `净边阈值 ${account.minEdge.toFixed(1)}¢ · 成交延迟 ${account.paperFillMs}ms` },
      { accountId: account.id, t: clock(Date.now() - 3 * 3600_000), actor: "风控", action: "限额复核", obj: def.name, venue: "账户", detail: "5 项限额均在账户净值内" }
    ];
    for (const a of audit) repo.auditAdd(a);

    const feed: FeedItem[] = [
      { accountId: account.id, t: hhmm(Date.now() - 40_000), kind: "ok", title: `开仓 ${chosen[0]!.title}`, detail: `${def.name} · 合约腿已成交`, val: "执行中" },
      { accountId: account.id, t: hhmm(Date.now() - 26 * 60_000), kind: "ok", title: `${def.name} 账户参数更新`, detail: "阈值 / 延迟已同步", val: "后台" },
      { accountId: account.id, t: hhmm(Date.now() - 3 * 3600_000), kind: "ok", title: "限额复核通过", detail: `${def.name} · 5 项限额`, val: "5/5" }
    ];
    for (const f of feed) repo.feedAdd(f);

    const risk: RiskEvent[] = [
      { accountId: account.id, t: hhmm(Date.now() - 90 * 60_000), level: "warn", title: "对冲缺口告警", detail: `${chosen[0]!.title} · 缺口在预算内`, val: "监控" },
      { accountId: account.id, t: hhmm(Date.now() - 5 * 3600_000), level: "ok", title: "账户净值同步", detail: `${def.name} · 独立账本`, val: "正常" }
    ];
    for (const e of risk) repo.riskEventAdd(e);

    const calendarRows: CalendarItem[] = chosen.slice(0, 3).map((d, i) => ({
      evId: d.id,
      exposure: Math.round(d.depth * (0.2 + i * 0.1)),
      note: i === 0 ? "近端事件，Delta 抬升中" : "UMA 争议窗口 2h"
    }));
    repo.calendarReplace(account.id, calendarRows);
  }

  repo.metaSet("seededTrading", "1");
  saveSettings(repo, { startedAt: settings.startedAt });
  logger.info({ accounts: accounts.length, positions: totalPositions, orders: totalOrders }, "seeded independent account books");
}

export function eventTitle(market: MarketService, evId: string): string {
  return market.events.find(e => e.id === evId)?.title ?? evId;
}
