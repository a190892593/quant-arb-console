import { config } from "./config.js";
import { Repository } from "./db/repository.js";
import { MarketService } from "./market/service.js";
import { Engine } from "./engine/engine.js";
import { ensureDefaults, ensureRuleDefaults, resetLiveBaseline, seedTradingData } from "./seed/index.js";
import { buildServer } from "./server/app.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const repo = new Repository(config.dbPath);
  ensureDefaults(repo);
  if (!config.seedTestFixture && repo.metaGet("liveBaselineV3") !== "1") resetLiveBaseline(repo);
  ensureRuleDefaults(repo);

  const market = new MarketService(repo);
  await market.init();
  if (config.seedTestFixture) seedTradingData(repo, market);
  if (!repo.metaGet("engineStartedAt")) repo.metaSet("engineStartedAt", Date.now());

  const engine = new Engine(repo, market);
  engine.start();

  const server = await buildServer({ repo, market, engine });
  await server.listen({ port: config.port, host: config.host });

  const address = server.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  logger.info({
    url: `http://${config.host}:${port}`,
    marketDataMode: config.marketDataMode,
    tradingMode: config.tradingMode,
    catalogMode: market.catalogMode,
    negRisk: market.negRisk.length,
    mmUniverse: market.mmUniverse.length
  }, "CONVERGENCE server ready");

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, "shutting down");
    engine.stop();
    await server.close();
    repo.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(err => {
  logger.fatal({ err }, "failed to start");
  process.exit(1);
});
