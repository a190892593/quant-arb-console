export type Role = "admin" | "trader" | "analyst";
export type EventStatus = "ready" | "watch" | "review" | "active";
export type EventSource = "demo" | "polymarket";
export type AccountId = "prob" | "converge" | "latency" | "longvol";
export type StrategyId = AccountId;

export interface AccountSettings {
  id: AccountId;
  enabled: boolean;
  /** Starting capital. Realized P&L is accumulated separately; current equity is derived. */
  equity: number;
  auto: boolean;
  kill: boolean;
  killReason: string;
  minEdge: number;
  paperFillMs: number;
  lastKillAt: number | null;
  realizedPnl: number;
  closedTrades: number;
  wins: number;
}

export interface AccountSummary extends AccountSettings {
  name: string;
  short: string;
  desc: string;
  logic: string;
  holdLabel: string;
  maxOpen: number;
  requiresRealtime: boolean;
  /** Current mark-to-market equity = starting capital + realized + unrealized. */
  equity: number;
  startingEquity: number;
  realizedPnl: number;
  totalPnl: number;
  returnPct: number;
  pnl: number;
  usedPct: number;
  positions: number;
  openOrders: number;
  signals: number;
  ready: number;
  dailyLossPct: number;
  bookCost: number;
  netDelta: number;
  closedTrades: number;
  wins: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  createdAt: string;
  lastLogin: string | null;
}

export interface UserRow extends Omit<User, "active" | "createdAt" | "lastLogin"> {
  password_hash: string;
  active: number;
  created_at: string;
  last_login: string | null;
}

export interface MarketTick {
  px: number;
  chg: number;
  funding?: number;
  openInterest?: number;
  dayVolume?: number;
  prevDayPx?: number;
}

export type Market = Record<string, MarketTick>;

export interface ModelSpec {
  spot?: number;
  strike: number;
  vol: number;
  direction: 1 | -1;
  kind: "digital" | "touch";
}

export interface ExternalRef {
  conditionId?: string;
  tokenId?: string;
  noTokenId?: string;
  slug?: string;
  volume?: number;
  liquidity?: number;
}

export interface EventContract {
  id: string;
  title: string;
  cat: string;
  und: string;
  due: string;
  ask: number;
  bid: number;
  fair: number;
  depth: number;
  conf: number;
  delta: number;
  src: string;
  source: EventSource;
  model?: ModelSpec;
  external?: ExternalRef;
  baseAsk?: number;
  baseBid?: number;
  baseFair?: number;
  active?: boolean;
  stale?: boolean;
  /** Age of the Polymarket quote used for this event (ms). Only measured for demo books today. */
  quoteAgeMs?: number;
  /** Hyperliquid mark when the quote was last refreshed. */
  quoteRefPx?: number;
  quoteAt?: number;
}

export interface DerivedEvent extends EventContract {
  strategy: StrategyId;
  strategyName: string;
  quoteAgeMs: number;
  lagPct: number;
  days: number;
  mid: number;
  gross: number;
  grossBps: number;
  costBps: number;
  netBps: number;
  net: number;
  hedgeUsd: number;
  holdReturn: number;
  annualized: number;
  status: EventStatus;
  statusText: string;
  spreadBps: number;
  feeBps: number;
  slipBps: number;
  fundingBps: number;
  resBps: number;
  edgeWidth: number;
  markPx: number | null;
}

export interface CostConfig {
  hlFeeBps: number;
  hedgeSlipBps: number;
  resolutionBps: number;
  fundingBpsDay: number;
  fundingCapBps: number;
}

export interface Position {
  evId: string;
  qty: number;
  avg: number;
  hedgeUsd: number;
  hedgeEntry: number;
  hedgeSide?: "long" | "short";
  accountId?: AccountId;
  strategyId?: AccountId;
  openedAt?: string;
  side?: "YES" | "NO";
}

export interface PositionView extends Position {
  ev: EventContract;
  d: DerivedEvent;
  mark: number;
  cost: number;
  target: number;
  ratio: number;
  contractPnl: number;
  hedgePnl: number;
  pnl: number;
  deltaUsd: number;
  signedDelta: number;
  hedgeSigned: number;
  targetSide: "long" | "short";
  mk: MarketTick;
}

export interface Book {
  rows: PositionView[];
  face: number;
  cost: number;
  hedge: number;
  target: number;
  pnl: number;
  margin: number;
  settle7: number;
  maxCost: number;
  byUnd: Record<string, { face: number; cost: number; pnl: number }>;
  netDelta: number;
  grossDelta: number;
  unhedged: number;
  undehedged: number;
  nowMs: number;
}

export interface OrderLeg {
  venue: "POLYMARKET" | "HYPERLIQUID";
  side: "buy" | "short" | "long" | "sell";
  label: string;
  qty: number;
  filled: number;
  price: number;
  notional: number;
  done: boolean;
  note?: string;
  externalId?: string;
}

export type OrderStatus = "leg1" | "hedging" | "filled" | "settling" | "failed";

export interface Order {
  id: string;
  evId: string;
  status: OrderStatus;
  statusText: string;
  notional: number;
  qty: number;
  opened: string;
  strategy: string;
  strategyId?: AccountId;
  accountId?: AccountId;
  slippageBps: number;
  legs: [OrderLeg, OrderLeg];
  createdAt: number;
  actor?: string;
  live?: boolean;
  seeded?: boolean;
  error?: string;
}

export interface Review {
  id: string;
  evId: string;
  accountId?: AccountId;
  kind: string;
  reason: string;
  action: string;
  advice: string;
  seconds: number;
  severity: "warn" | "bad";
  createdAt: number;
  deadline?: number;
}

export interface AuditEntry {
  t: string;
  actor: string;
  action: string;
  obj: string;
  venue: string;
  detail: string;
  accountId?: AccountId;
}

export interface RiskEvent {
  t: string;
  level: "ok" | "warn" | "bad";
  title: string;
  detail: string;
  val: string;
  accountId?: AccountId;
}

export interface FeedItem {
  t: string;
  kind: "ok" | "warn";
  title: string;
  detail: string;
  val: string;
  accountId?: AccountId;
}

export interface Limit {
  id: string;
  name: string;
  desc: string;
  value: number;
  used: number;
  kind: "usd" | "pct";
}

export interface Rule {
  id: string;
  name: string;
  desc: string;
  on: boolean;
}

export interface EquityPoint {
  t: number;
  v: number;
}

export interface CalendarItem {
  evId: string;
  exposure: number;
  note: string;
}

export interface VenueStatus {
  id: "polymarket" | "hyperliquid";
  label: string;
  state: "ok" | "degraded" | "down" | "disabled";
  latencyMs: number | null;
  message: string;
  lastOkAt: number | null;
  mode: "live" | "demo" | "offline" | "paper";
}

export interface EngineStatus {
  marketDataMode: "live" | "demo" | "auto";
  tradingMode: "paper" | "live";
  paperTradingEnabled: boolean;
  liveConfigured: boolean;
  liveAcknowledged: boolean;
  liveEnabled: boolean;
  scanSeq: number;
  lastScanAt: number;
  universe: number;
  version: string;
  startedAt: number;
}

export interface SessionUser extends User {
  csrf: string;
}
