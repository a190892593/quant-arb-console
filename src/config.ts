import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(file = resolve(ROOT, ".env")): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const bool = (v: string | undefined, d = false): boolean =>
  v == null || v === "" ? d : /^(1|true|yes|on)$/i.test(v);
const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export type MarketDataMode = "auto" | "live" | "demo";
export type TradingMode = "paper" | "live";

export interface AppConfig {
  root: string;
  port: number;
  host: string;
  dbPath: string;
  sessionTtlMs: number;
  marketDataMode: MarketDataMode;
  tradingMode: TradingMode;
  liveAck: string;
  cookieSecure: boolean;
  hl: {
    apiUrl: string;
    enabled: boolean;
    privateKey: string;
    walletAddress: string;
    testnet: boolean;
  };
  pm: {
    gammaUrl: string;
    clobUrl: string;
    enabled: boolean;
    privateKey: string;
    funder: string;
    apiKey: string;
    apiSecret: string;
    apiPassphrase: string;
    signatureType: number;
    chainId: number;
    rpcUrl: string;
  };
  alertWebhookUrl: string;
  /** Deterministic demo fixture for tests only; never used by the production start path. */
  seedTestFixture: boolean;
}

const mode = (process.env.MARKET_DATA_MODE ?? "live").toLowerCase();

export const config: AppConfig = {
  root: ROOT,
  port: num(process.env.PORT, 8787),
  host: process.env.HOST ?? "127.0.0.1",
  dbPath: resolve(ROOT, process.env.DB_PATH ?? "data/convergence.db"),
  sessionTtlMs: num(process.env.SESSION_TTL_HOURS, 168) * 3_600_000,
  marketDataMode: (["auto", "live", "demo"].includes(mode) ? mode : "live") as MarketDataMode,
  tradingMode: (process.env.TRADING_MODE === "live" ? "live" : "paper") as TradingMode,
  liveAck: process.env.LIVE_TRADING_ACK ?? "",
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  hl: {
    apiUrl: process.env.HL_API_URL ?? "https://api.hyperliquid.xyz",
    enabled: bool(process.env.HL_ENABLED, true),
    privateKey: process.env.HL_PRIVATE_KEY ?? "",
    walletAddress: process.env.HL_WALLET_ADDRESS ?? "",
    testnet: bool(process.env.HL_TESTNET, false)
  },
  pm: {
    gammaUrl: process.env.PM_GAMMA_URL ?? "https://gamma-api.polymarket.com",
    clobUrl: process.env.PM_CLOB_URL ?? "https://clob.polymarket.com",
    enabled: bool(process.env.PM_ENABLED, true),
    privateKey: process.env.PM_PRIVATE_KEY ?? "",
    funder: process.env.PM_FUNDER_ADDRESS ?? "",
    apiKey: process.env.PM_API_KEY ?? "",
    apiSecret: process.env.PM_API_SECRET ?? "",
    apiPassphrase: process.env.PM_API_PASSPHRASE ?? "",
    signatureType: num(process.env.PM_SIGNATURE_TYPE, 1),
    chainId: num(process.env.PM_CHAIN_ID, 137),
    rpcUrl: process.env.PM_RPC_URL ?? "https://polygon-rpc.com"
  },
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL ?? "",
  seedTestFixture: bool(process.env.SEED_TEST_FIXTURE, false)
};

export interface LiveConfigStatus {
  hl: boolean;
  pm: boolean;
  all: boolean;
  acknowledged: boolean;
}

export function liveTradingConfigured(): LiveConfigStatus {
  const hl = Boolean(config.hl.privateKey && config.hl.walletAddress);
  const pm = Boolean(config.pm.privateKey && config.pm.apiKey && config.pm.apiSecret && config.pm.apiPassphrase);
  return { hl, pm, all: hl && pm, acknowledged: config.liveAck === "I_UNDERSTAND_LIVE_TRADING" };
}

export function publicConfig() {
  return {
    version: "2.2.0",
    marketDataMode: config.marketDataMode,
    tradingMode: config.tradingMode,
    hl: { enabled: config.hl.enabled, testnet: config.hl.testnet, apiUrl: config.hl.apiUrl },
    pm: { enabled: config.pm.enabled, gammaUrl: config.pm.gammaUrl, clobUrl: config.pm.clobUrl, chainId: config.pm.chainId },
    live: liveTradingConfigured()
  };
}
