import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.MARKET_DATA_MODE = "demo";
process.env.HL_ENABLED = "false";
process.env.PM_ENABLED = "false";
process.env.TRADING_MODE = "paper";

const { Repository } = await import("../dist/db/repository.js");
const { MarketService } = await import("../dist/market/service.js");
const { Engine } = await import("../dist/engine/engine.js");
const { ensureDefaults, seedTradingData } = await import("../dist/seed/index.js");
const { saveSettings } = await import("../dist/settings.js");
const { buildServer } = await import("../dist/server/app.js");

const repo = new Repository(":memory:");
ensureDefaults(repo);
saveSettings(repo, { paperTradingEnabled: true });
const market = new MarketService(repo);
await market.init();
seedTradingData(repo, market);
const engine = new Engine(repo, market);
await engine.refreshMm("marketmaking");
const app = await buildServer({ repo, market, engine });
await app.listen({ port: 0, host: "127.0.0.1" });
const address = app.server.address();
const base = `http://127.0.0.1:${address.port}`;

async function request(method, path, { body, cookie, csrf, headers = {} } = {}) {
  const h = { accept: "application/json", ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  if (csrf) h["x-csrf-token"] = csrf;
  const res = await fetch(base + path, {
    method, headers: h, redirect: "manual",
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv/html */ }
  return { res, json, text };
}

async function login(email, password) {
  const { res, json } = await request("POST", "/api/auth/login", { body: { email, password } });
  assert.equal(res.status, 200, JSON.stringify(json));
  const cookie = res.headers.getSetCookie()[0].split(";")[0];
  return { cookie, csrf: json.csrf, user: json.user };
}

const admin = await login("admin@convergence.local", "Admin!2345");

test.after(() => app.close());

test("login issues a session and the state exposes both desks", async () => {
  const { res, json } = await request("GET", "/api/state", { cookie: admin.cookie });
  assert.equal(res.status, 200);
  assert.equal(json.state.user.role, "admin");
  assert.equal(json.state.accounts.length, 2);
  assert.deepEqual(json.state.accounts.map(a => a.id), ["negrisk", "marketmaking"]);
  assert.equal(json.state.negRisk.length, 3);
  assert.ok(json.state.mm.markets.length >= 8);
  assert.equal(json.state.limits.length, 5);
  assert.equal(json.state.rules.length, 7);
  assert.ok(Array.isArray(json.state.equity) && json.state.equity.length >= 1);
});

test("account switch swaps the rule set without leaking the other desk", async () => {
  const neg = (await request("GET", "/api/state?account=negrisk", { cookie: admin.cookie })).json.state;
  const mm = (await request("GET", "/api/state?account=marketmaking", { cookie: admin.cookie })).json.state;
  assert.equal(neg.accountId, "negrisk");
  assert.equal(mm.accountId, "marketmaking");
  assert.equal(neg.rules.length, 7);
  assert.equal(mm.rules.length, 12);
  assert.ok(mm.mm.markets.filter(m => m.quoteBid > 0).length >= 1);
});

test("NegRisk conversion locks profit and debits nothing after the sell", async () => {
  const state = (await request("GET", "/api/state?account=negrisk", { cookie: admin.cookie })).json.state;
  const opp = state.negRisk.find(o => o.status === "ready");
  assert.ok(opp, "expected a ready demo basket");
  const before = state.accounts.find(a => a.id === "negrisk").equity;
  const { res, json } = await request("POST", "/api/negrisk/convert", {
    cookie: admin.cookie, csrf: admin.csrf,
    body: { accountId: "negrisk", opportunityId: opp.id, sets: 20 }
  });
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.ok(json.conversion.profit > 0);
  assert.equal(json.conversion.sets, 20);
  assert.equal(json.conversion.legs.length, opp.n);
  const after = json.state.accounts.find(a => a.id === "negrisk");
  assert.ok(after.equity > before, `${after.equity} vs ${before}`);
  assert.equal(json.state.conversions.length, 1);
  assert.equal(json.state.conversions[0].status, "locked");
});

test("NegRisk conversion rejects more baskets than the book can absorb", async () => {
  const state = (await request("GET", "/api/state?account=negrisk", { cookie: admin.cookie })).json.state;
  const opp = state.negRisk.find(o => o.status === "ready");
  const { res, json } = await request("POST", "/api/negrisk/convert", {
    cookie: admin.cookie, csrf: admin.csrf,
    body: { accountId: "negrisk", opportunityId: opp.id, sets: 501 }
  });
  assert.equal(res.status, 409);
  assert.match(json.error.message, /最多|组/);
});

test("market making fills both sides of its quotes and tracks inventory", async () => {
  const first = await request("POST", "/api/mm/refresh", {
    cookie: admin.cookie, csrf: admin.csrf, body: { accountId: "marketmaking" }
  });
  assert.equal(first.res.status, 200, JSON.stringify(first.json));
  await new Promise(r => setTimeout(r, 30));
  const second = await request("POST", "/api/mm/refresh", {
    cookie: admin.cookie, csrf: admin.csrf, body: { accountId: "marketmaking" }
  });
  assert.equal(second.res.status, 200);
  const mm = second.json.state.mm;
  assert.ok(mm.totals.fills > 0, JSON.stringify(mm.totals));
  assert.ok(mm.markets.some(m => m.inventory !== 0));
  const account = second.json.state.accounts.find(a => a.id === "marketmaking");
  assert.ok(Math.abs(account.equity - 10_000) > 0);
});

test("market making can pause one market and flatten inventory", async () => {
  const state = (await request("GET", "/api/state?account=marketmaking", { cookie: admin.cookie })).json.state;
  const held = state.mm.markets.find(m => m.inventory !== 0) ?? state.mm.markets[0];
  const paused = await request("POST", "/api/mm/pause", {
    cookie: admin.cookie, csrf: admin.csrf,
    body: { accountId: "marketmaking", marketId: held.id, paused: true }
  });
  assert.equal(paused.res.status, 200);
  const pausedRow = paused.json.state.mm.markets.find(m => m.id === held.id);
  assert.equal(pausedRow.paused, true);
  const flat = await request("POST", "/api/mm/flatten", {
    cookie: admin.cookie, csrf: admin.csrf, body: { accountId: "marketmaking", marketId: held.id }
  });
  assert.equal(flat.res.status, 200, JSON.stringify(flat.json));
  const row = flat.json.state.mm.markets.find(m => m.id === held.id);
  assert.equal(row.inventory, 0);
});

test("kill switch stops new conversions", async () => {
  const killed = await request("POST", "/api/risk/kill", {
    cookie: admin.cookie, csrf: admin.csrf,
    body: { accountId: "negrisk", enabled: true, reason: "test" }
  });
  assert.equal(killed.res.status, 200);
  const state = killed.json.state;
  const opp = state.negRisk.find(o => o.status === "ready");
  const blocked = await request("POST", "/api/negrisk/convert", {
    cookie: admin.cookie, csrf: admin.csrf,
    body: { accountId: "negrisk", opportunityId: opp.id, sets: 5 }
  });
  assert.equal(blocked.res.status, 409);
  await request("POST", "/api/risk/kill", {
    cookie: admin.cookie, csrf: admin.csrf,
    body: { accountId: "negrisk", enabled: false, reason: "release" }
  });
});

test("an analyst can read but cannot trade", async () => {
  const analyst = await login("analyst@convergence.local", "Analyst!2345");
  const read = await request("GET", "/api/state", { cookie: analyst.cookie });
  assert.equal(read.res.status, 200);
  const state = read.json.state;
  const opp = state.negRisk.find(o => o.status === "ready");
  const write = await request("POST", "/api/negrisk/convert", {
    cookie: analyst.cookie, csrf: analyst.csrf,
    body: { accountId: "negrisk", opportunityId: opp.id, sets: 5 }
  });
  assert.equal(write.res.status, 403);
});

test("opportunity export is a real NegRisk CSV", async () => {
  const { res, text } = await request("GET", "/api/export/opportunities.csv", { cookie: admin.cookie });
  assert.equal(res.status, 200);
  assert.match(text, /ΣYES买价/);
  assert.match(text, /NegRisk|事件/);
});
