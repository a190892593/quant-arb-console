/* CONVERGENCE · environment doctor: `npm run doctor` */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const envFile = join(ROOT, ".env");
const env = { ...process.env };
if (existsSync(envFile)) {
  for (const raw of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i > 0 && !(line.slice(0, i) in env)) env[line.slice(0, i)] = line.slice(i + 1).trim();
  }
}

const rows = [];
const add = (name, ok, detail) => rows.push({ name, ok, detail });

const major = Number(process.versions.node.split(".")[0]);
const minor = Number(process.versions.node.split(".")[1]);
add("Node.js >= 22.5", major > 22 || (major === 22 && minor >= 5), process.version);
add("dist/ 已构建", existsSync(join(ROOT, "dist", "index.js")), existsSync(join(ROOT, "dist", "index.js")) ? "dist/index.js" : "运行 npm run build");
add("SQLite 内置模块", true, "node:sqlite");

async function probe(url, init) {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(9000) });
    return { ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err.message, ms: Date.now() - started };
  }
}

const hl = await probe((env.HL_API_URL || "https://api.hyperliquid.xyz") + "/info", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" })
});
add("Hyperliquid 公共行情可达", hl.ok, hl.ok ? hl.ms + "ms" : hl.error);

const pm = await probe((env.PM_GAMMA_URL || "https://gamma-api.polymarket.com") + "/markets?limit=1&active=true&closed=false");
add("Polymarket Gamma 可达", pm.ok, pm.ok ? pm.ms + "ms" : pm.error + "（服务会自动降级到示例目录）");

const mode = (env.MARKET_DATA_MODE || "auto").toLowerCase();
add("MARKET_DATA_MODE", ["auto", "live", "demo"].includes(mode), mode);

const hlLive = Boolean(env.HL_PRIVATE_KEY && env.HL_WALLET_ADDRESS);
const pmLive = Boolean(env.PM_PRIVATE_KEY && env.PM_API_KEY && env.PM_API_SECRET && env.PM_API_PASSPHRASE);
const tradeMode = (env.TRADING_MODE || "paper").toLowerCase();
add("Hyperliquid 私有凭据", hlLive || tradeMode !== "live", hlLive ? "已配置" : "未配置（纸面交易不受影响）");
add("Polymarket 私有凭据", pmLive || tradeMode !== "live", pmLive ? "已配置" : "未配置（纸面交易不受影响）");
add("实盘确认短语", env.LIVE_TRADING_ACK === "I_UNDERSTAND_LIVE_TRADING" || tradeMode !== "live", env.LIVE_TRADING_ACK ? "已设置" : "未设置");
add("TRADING_MODE", tradeMode === "paper" || tradeMode === "live", tradeMode);
if (tradeMode === "live") {
  add("实盘前置条件", hlLive && pmLive && env.LIVE_TRADING_ACK === "I_UNDERSTAND_LIVE_TRADING",
    hlLive && pmLive && env.LIVE_TRADING_ACK === "I_UNDERSTAND_LIVE_TRADING" ? "齐全" : "缺少凭据或确认短语，服务不会发送真实订单");
}

console.log("\nCONVERGENCE · 环境检查\n");
for (const r of rows) {
  console.log(`  ${r.ok ? "✓" : "!"} ${r.name.padEnd(30)} ${r.detail || ""}`);
}
const failures = rows.filter(r => !r.ok && !r.name.includes("Polymarket Gamma") && !r.name.includes("节点"));
console.log("\n提示：Polymarket 在部分地区/网络不可达，服务会自动使用按 Hyperliquid 实时价格生成的示例盘口；这不是实盘数据。");
if (failures.length) {
  console.log(`\n${failures.length} 项需要处理。`);
  process.exitCode = 1;
}
