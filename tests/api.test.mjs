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
saveSettings(repo, { auto: false });
const market = new MarketService(repo);
await market.init();
seedTradingData(repo, market);
const engine = new Engine(repo, market);
engine.start();
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

test("login issues a session and state exposes the full dashboard", async () => {
  const { res, json } = await request("GET", "/api/state", { cookie: admin.cookie });
  assert.equal(res.status, 200);
  assert.ok(json.state.events.length > 20);
  assert.equal(json.state.user.role, "admin");
  assert.ok(json.state.limits.length === 5);
  assert.ok(json.state.rules.length >= 16);
  assert.ok(json.state.book.rows.length >= 1);
  assert.ok(Array.isArray(json.state.equity) && json.state.equity.length >= 1);
});

test("four independent accounts share no equity or positions", async () => {
  const prob = (await request("GET", "/api/state?account=prob", { cookie: admin.cookie })).json.state;
  const converge = (await request("GET", "/api/state?account=converge", { cookie: admin.cookie })).json.state;
  assert.equal(prob.accounts.length, 5);
  assert.equal(converge.accounts.length, 5);
  assert.equal(prob.accountId, "prob");
  assert.equal(converge.accountId, "converge");
  assert.notEqual(prob.account.equity, converge.account.equity);
  assert.equal(prob.portfolio.equity, prob.accounts.reduce((s, a) => s + a.equity, 0));
  const probIds = new Set(prob.positions.map(p => p.evId));
  assert.ok(converge.positions.every(p => !probIds.has(p.evId) || p.accountId === "converge"));
  assert.ok(prob.accounts.some(a => a.id === "latency") && prob.accounts.some(a => a.id === "longvol"));
});

test("mutations require a CSRF token", async () => {
  const { res } = await request("POST", "/api/risk/auto", {
    cookie: admin.cookie, body: { accountId: "prob", enabled: false }
  });
  assert.equal(res.status, 403);
});

test("admin can tune one account without touching the others", async () => {
  const before = (await request("GET", "/api/state?account=converge", { cookie: admin.cookie })).json.state.settings.paperFillMs;
  const { res, json } = await request("PATCH", "/api/admin/accounts/prob", {
    cookie: admin.cookie, csrf: admin.csrf, body: { paperFillMs: 700, minEdge: 2.5 }
  });
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.account.paperFillMs, 700);
  const converge = (await request("GET", "/api/state?account=converge", { cookie: admin.cookie })).json.state;
  assert.equal(converge.settings.paperFillMs, before);
});

test("order lifecycle: create, paper fill, position appears, archive", async () => {
  const state = (await request("GET", "/api/state?account=prob", { cookie: admin.cookie })).json.state;
  const target = state.events.find(e => e.status === "ready" && e.days > 2 && e.delta < 0 && e.depth > 20_000);
  assert.ok(target, "expected a ready event");
  const beforeIds = state.orders.map(o => o.id);
  const created = await request("POST", "/api/orders", {
    cookie: admin.cookie, csrf: admin.csrf,
    body: { accountId: "prob", eventId: target.id, qty: Math.min(2_000, Math.floor(target.depth / target.ask / 100) * 100) }
  });
  assert.equal(created.res.status, 200, JSON.stringify(created.json));
  const id = created.json.order.id;
  assert.ok(!beforeIds.includes(id), "new order must not overwrite an existing order id");
  assert.equal(new Set(created.json.state.orders.map(o => o.id)).size, created.json.state.orders.length);
  let filled = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 200));
    const s = (await request("GET", "/api/state?account=prob", { cookie: admin.cookie })).json.state;
    const o = s.orders.find(x => x.id === id);
    if (o?.status === "filled") { filled = s; break; }
  }
  assert.ok(filled, "order did not fill");
  assert.ok(filled.positions.some(p => p.evId === target.id));
  const archived = await request("POST", `/api/orders/${id}/archive`, {
    cookie: admin.cookie, csrf: admin.csrf, body: { accountId: "prob" }
  });
  assert.equal(archived.res.status, 200);
  assert.ok(!archived.json.state.orders.some(o => o.id === id));
});

test("kill switch blocks new orders until released", async () => {
  await request("POST", "/api/risk/kill", {
    cookie: admin.cookie, csrf: admin.csrf, body: { accountId: "prob", enabled: true, reason: "test" }
  });
  const state = (await request("GET", "/api/state?account=prob", { cookie: admin.cookie })).json.state;
  assert.equal(state.settings.kill, true);
  const other = (await request("GET", "/api/state?account=converge", { cookie: admin.cookie })).json.state;
  assert.equal(other.settings.kill, false);
  const target = state.events.find(e => e.status === "ready" && e.delta < 0 && e.depth > 20_000);
  const blocked = await request("POST", "/api/orders", {
    cookie: admin.cookie, csrf: admin.csrf, body: { accountId: "prob", eventId: target.id, qty: 100 }
  });
  assert.equal(blocked.res.status, 409);
  assert.match(blocked.json.error.message, /熔断/);
  await request("POST", "/api/risk/kill", {
    cookie: admin.cookie, csrf: admin.csrf, body: { accountId: "prob", enabled: false, reason: "release" }
  });
});

test("analyst is read-only", async () => {
  const analyst = await login("analyst@convergence.local", "Analyst!2345");
  const state = (await request("GET", "/api/state", { cookie: analyst.cookie })).json.state;
  const target = state.events.find(e => e.status === "ready" && e.delta < 0 && e.depth > 20_000);
  const res = await request("POST", "/api/orders", {
    cookie: analyst.cookie, csrf: analyst.csrf, body: { accountId: "prob", eventId: target.id, qty: 100 }
  });
  assert.equal(res.res.status, 403);
});

test("admin user management and live-mode gate", async () => {
  const email = `test-${Date.now()}@convergence.local`;
  const created = await request("POST", "/api/admin/users", {
    cookie: admin.cookie, csrf: admin.csrf,
    body: { email, name: "测试用户", role: "trader", password: "Passw0rd!" }
  });
  assert.equal(created.res.status, 200, JSON.stringify(created.json));
  assert.ok(created.json.users.some(u => u.email === email));

  const blocked = await request("PUT", "/api/admin/settings", {
    cookie: admin.cookie, csrf: admin.csrf, body: { liveTradingEnabled: true }
  });
  assert.equal(blocked.res.status, 409);

  const listed = await request("GET", "/api/admin/users", { cookie: admin.cookie });
  assert.ok(listed.json.users.length >= 4);
});

test("CSV export and audit log work", async () => {
  const csv = await request("GET", "/api/export/opportunities.csv", { cookie: admin.cookie });
  assert.equal(csv.res.status, 200);
  assert.match(csv.res.headers.get("content-type"), /text\/csv/);
  assert.ok(csv.text.includes("净边bps"));
  const audit = await request("GET", "/api/admin/audit?limit=50", { cookie: admin.cookie });
  assert.equal(audit.res.status, 200);
  assert.ok(audit.json.audit.length > 0);
});

test("logout invalidates the session", async () => {
  const session = await login("trader@convergence.local", "Trader!2345");
  const out = await request("POST", "/api/auth/logout", { cookie: session.cookie, csrf: session.csrf });
  assert.equal(out.res.status, 200);
  const after = await request("GET", "/api/state", { cookie: session.cookie });
  assert.equal(after.res.status, 401);
});

test("cleanup", async () => {
  engine.stop();
  await app.close();
  repo.close();
});
