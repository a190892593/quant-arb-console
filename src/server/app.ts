import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z, ZodError } from "zod";
import { ROOT, config, liveTradingConfigured, publicConfig } from "../config.js";
import {
  COOKIE, createSession, deleteSessionByToken, hashPassword, loginAllowed, noteLoginFailure,
  clearLoginFailures, publicUser, roleAtLeast, sessionFromToken, verifyPassword, type AuthContext
} from "../auth.js";
import type { Repository } from "../db/repository.js";
import type { MarketService } from "../market/service.js";
import { EngineError, type Engine } from "../engine/engine.js";
import { buildState } from "../state.js";
import { accountSettings, accountsAll, getSettings, saveSettings, type AppSettings } from "../settings.js";
import type { AccountId } from "../domain/types.js";
import { ACCOUNT_IDS, isAccountId } from "../domain/accounts.js";
import { resetLiveBaseline } from "../seed/index.js";
import { clock } from "../util.js";
import { logger } from "../logger.js";
import * as hl from "../venues/hyperliquid.js";
import * as pm from "../venues/polymarket.js";

export interface ServerDeps {
  repo: Repository;
  market: MarketService;
  engine: Engine;
}

const publicApi = new Set([
  "POST /api/auth/login",
  "GET /api/auth/me",
  "GET /api/health"
]);

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw Object.assign(new Error("请求参数校验失败"), {
      statusCode: 422,
      code: "validation_error",
      issues: result.error.issues.map(i => ({ path: i.path.join("."), message: i.message }))
    });
  }
  return result.data as z.infer<T>;
}

function html(name: string): string {
  return readFileSync(join(ROOT, "public", name), "utf8");
}

function sendHtml(reply: FastifyReply, body: string): FastifyReply {
  return reply.header("cache-control", "no-store").type("text/html; charset=utf-8").send(body);
}

function actorOf(auth: AuthContext) {
  return { id: auth.user.id, name: auth.user.name, role: auth.user.role };
}

function nowClock(): string { return clock(); }

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { repo, market, engine } = deps;
  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: 1_000_000
  });

  await app.register(fastifyCookie);
  await app.register(rateLimit, {
    global: true,
    max: 800,
    timeWindow: "1 minute",
    keyGenerator: req => req.ip,
    errorResponseBuilder: () => ({ error: { code: "rate_limited", message: "请求过于频繁，请稍后再试" } })
  });
  await app.register(fastifyStatic, {
    root: join(ROOT, "public", "assets"),
    prefix: "/assets/",
    index: false,
    cacheControl: false
  });

  app.decorateRequest("auth", null);

  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  });

  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const host = req.headers.host;
        if (!host || new URL(origin).host !== host) {
          return reply.code(403).send({ error: { code: "bad_origin", message: "跨站请求被拒绝" } });
        }
      } catch {
        return reply.code(403).send({ error: { code: "bad_origin", message: "来源不合法" } });
      }
    }
    const token = req.cookies[COOKIE];
    req.auth = sessionFromToken(repo, token);

    const method = req.method.toUpperCase();
    const path = req.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) return;
    if (publicApi.has(`${method} ${path}`)) return;
    if (!req.auth) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "请先登录" } });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const csrf = req.headers["x-csrf-token"];
      if (typeof csrf !== "string" || csrf !== req.auth.csrf) {
        return reply.code(403).send({ error: { code: "csrf", message: "CSRF 校验失败，请刷新页面" } });
      }
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof EngineError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply.code(422).send({
        error: {
          code: "validation_error",
          message: "请求参数校验失败",
          issues: err.issues.map(i => ({ path: i.path.join("."), message: i.message }))
        }
      });
    }
    const anyErr = err as Error & { statusCode?: number; code?: string; issues?: unknown; error?: { code?: string } };
    // @fastify/rate-limit surfaces the built body, not a statusCode; keep it a real 429.
    if (anyErr.error?.code === "rate_limited") {
      return reply.code(429).send({ error: { code: "rate_limited", message: "请求过于频繁，请稍后再试" } });
    }
    if (anyErr.statusCode && anyErr.statusCode < 500) {
      return reply.code(anyErr.statusCode).send({
        error: { code: anyErr.code ?? "bad_request", message: anyErr.message, issues: anyErr.issues }
      });
    }
    logger.error({ err: anyErr, url: req.url, method: req.method }, "unhandled request error");
    return reply.code(500).send({ error: { code: "internal_error", message: "服务内部错误，请查看服务端日志" } });
  });

  const auth = (req: FastifyRequest): AuthContext => {
    if (!req.auth) throw Object.assign(new Error("请先登录"), { statusCode: 401, code: "unauthorized" });
    return req.auth;
  };
  const requireAdmin = (req: FastifyRequest): AuthContext => {
    const a = auth(req);
    if (!roleAtLeast(a.user, "admin")) {
      throw Object.assign(new Error("需要管理员权限"), { statusCode: 403, code: "forbidden" });
    }
    return a;
  };
  const requireTrader = (req: FastifyRequest): AuthContext => {
    const a = auth(req);
    if (!roleAtLeast(a.user, "trader")) {
      throw Object.assign(new Error("当前账户为只读角色"), { statusCode: 403, code: "read_only" });
    }
    return a;
  };
  const stateFor = (a: AuthContext, accountId: AccountId = "prob") => buildState(repo, market, engine, {
    id: a.user.id, email: a.user.email, name: a.user.name, role: a.user.role, csrf: a.csrf
  }, accountId);
  const accountEnum = z.enum(["prob", "converge", "latency", "longvol"]);
  const accountFrom = (req: FastifyRequest, body?: unknown): AccountId => {
    const q = (req.query as Record<string, unknown> | undefined)?.account;
    if (isAccountId(q)) return q;
    const b = (body ?? req.body) as { accountId?: unknown } | undefined;
    if (b && isAccountId(b.accountId)) return b.accountId;
    return "prob";
  };

  /* ---------------- HTML ---------------- */
  app.get("/", async (req, reply) => {
    const a = sessionFromToken(repo, req.cookies[COOKIE]);
    if (!a) return reply.redirect("/login");
    return sendHtml(reply, html("index.html"));
  });
  app.get("/login", async (req, reply) => {
    const a = sessionFromToken(repo, req.cookies[COOKIE]);
    if (a) return reply.redirect("/");
    return sendHtml(reply, html("login.html"));
  });
  app.get("/admin", async (req, reply) => {
    const a = sessionFromToken(repo, req.cookies[COOKIE]);
    if (!a) return reply.redirect("/login?next=" + encodeURIComponent("/#/admin"));
    if (!roleAtLeast(a.user, "admin")) return reply.redirect("/");
    return reply.redirect("/#/admin");
  });
  app.get("/admin.html", async (_req, reply) => reply.redirect("/#/admin"));
  app.get("/index.html", async (_req, reply) => reply.redirect("/"));
  app.get("/event-arb-console.html", async (_req, reply) => reply.redirect("/"));
  app.get("/favicon.ico", async (_req, reply) => reply.code(204).send());

  /* ---------------- auth ---------------- */
  app.post("/api/auth/login", {
    config: { rateLimit: { max: 12, timeWindow: "15 minutes" } }
  }, async (req, reply) => {
    const body = parse(z.object({
      email: z.string().trim().email().max(200),
      password: z.string().min(1).max(300)
    }), req.body);
    const ip = req.ip;
    if (!loginAllowed(ip)) {
      return reply.code(429).send({ error: { code: "login_locked", message: "登录尝试过多，请 15 分钟后再试" } });
    }
    const user = repo.userByEmail(body.email);
    if (!user || !verifyPassword(body.password, user.password_hash) || !user.active) {
      noteLoginFailure(ip);
      return reply.code(401).send({ error: { code: "bad_credentials", message: "邮箱或密码错误" } });
    }
    clearLoginFailures(ip);
    repo.userTouchLogin(user.id);
    const session = createSession(repo, user.id);
    reply.setCookie(COOKIE, session.token, {
      path: "/", httpOnly: true, sameSite: "strict",
      maxAge: Math.floor(config.sessionTtlMs / 1000), secure: config.cookieSecure
    });
    repo.auditAdd({ t: nowClock(), actor: user.name, actorId: user.id, action: "登录", obj: user.email, venue: "控制台", detail: "登录成功" });
    return { user: publicUser(user), csrf: session.csrf };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const a = auth(req);
    deleteSessionByToken(repo, a.token);
    repo.auditAdd({ t: nowClock(), actor: a.user.name, actorId: a.user.id, action: "登出", obj: a.user.email, venue: "控制台", detail: "会话已注销" });
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    const a = req.auth;
    return a ? { user: publicUser(a.user), csrf: a.csrf } : { user: null };
  });

  app.post("/api/auth/password", async (req, reply) => {
    const a = auth(req);
    const body = parse(z.object({
      current: z.string().min(1).max(300),
      next: z.string().min(8, "新密码至少 8 位").max(300)
    }), req.body);
    if (!verifyPassword(body.current, a.user.password_hash)) {
      return reply.code(401).send({ error: { code: "bad_password", message: "当前密码不正确" } });
    }
    repo.userUpdate(a.user.id, { passwordHash: hashPassword(body.next) });
    repo.sessionsDeleteForUser(a.user.id);
    repo.auditAdd({ t: nowClock(), actor: a.user.name, actorId: a.user.id, action: "修改密码", obj: a.user.email, venue: "控制台", detail: "密码已更新，其他会话已注销" });
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  /* ---------------- state / stream ---------------- */
  app.get("/api/state", async (req) => {
    const a = auth(req);
    return { state: stateFor(a, accountFrom(req)), serverTime: Date.now() };
  });

  app.get("/api/stream", async (req, reply) => {
    const a = auth(req);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no"
    });
    reply.raw.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ user: a.user.email, version: engine.getVersion() })}\n\n`);
    let closed = false;
    const send = (event: { type: string; version: number; payload?: unknown }) => {
      if (closed) return;
      try { reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); } catch { closed = true; }
    };
    const off = engine.onChange(send);
    const heartbeat = setInterval(() => {
      if (closed) return;
      try { reply.raw.write(`event: ping\ndata: ${Date.now()}\n\n`); } catch { closed = true; }
    }, 20_000);
    const cleanup = () => {
      closed = true;
      clearInterval(heartbeat);
      off();
      try { reply.raw.end(); } catch { /* ignore */ }
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
  });

  app.get("/api/health", async () => ({
    ok: true,
    version: "2.2.0",
    uptime: Math.round(process.uptime()),
    time: new Date().toISOString(),
    venues: [market.hlStatus, market.pmStatus],
    catalogMode: market.catalogMode,
    universe: market.events.length
  }));

  /* ---------------- scanner / export ---------------- */
  app.post("/api/scanner/refresh", async (req) => {
    const a = requireTrader(req);
    const result = await engine.refreshCatalog(actorOf(a));
    return { ok: true, result, state: stateFor(a, accountFrom(req)) };
  });

  app.get("/api/export/opportunities.csv", async (req, reply) => {
    auth(req);
    const account = accountFrom(req);
    const q = String((req.query as Record<string, unknown>)?.q ?? "").toLowerCase();
    const cat = String((req.query as Record<string, unknown>)?.cat ?? "all");
    const minEdge = Number((req.query as Record<string, unknown>)?.minEdge ?? 2.5);
    const horizon = String((req.query as Record<string, unknown>)?.horizon ?? "all");
    const onlyReady = String((req.query as Record<string, unknown>)?.onlyReady ?? "") === "true";
    let rows = engine.derived(account);
    if (q) rows = rows.filter(r => (r.title + r.cat + r.und + r.src).toLowerCase().includes(q));
    if (cat !== "all") rows = rows.filter(r => r.cat === cat);
    rows = rows.filter(r => r.net >= (Number.isFinite(minEdge) ? minEdge : 2.5));
    if (horizon !== "all") rows = rows.filter(r => r.days <= Number(horizon));
    if (onlyReady) rows = rows.filter(r => r.status === "ready");
    const accountName = engine.accountSummaries().find(x => x.id === account)?.name ?? account;
    const header = ["账户", "事件", "类别", "标的", "结算日", "剩余天数", "PM买价", "PM卖价", "HL公允", "毛边bps", "成本bps", "净边bps",
      "持有期回报%", "简单年化%", "可成交USDC", "对冲USDC", "置信度", "状态"];
    const lines = rows.map(r => [
      accountName, `"${r.title.replace(/"/g, '""')}"`, r.cat, r.und, r.due.slice(0, 10), r.days.toFixed(1),
      (r.bid * 100).toFixed(1), (r.ask * 100).toFixed(1), (r.fair * 100).toFixed(1),
      Math.round(r.grossBps), Math.round(r.costBps), Math.round(r.netBps),
      (r.holdReturn * 100).toFixed(2), (r.annualized > 999 ? ">999" : r.annualized.toFixed(1)),
      Math.round(r.depth), Math.round(r.hedgeUsd), r.conf, r.statusText
    ].join(","));
    const csv = "\ufeff" + [header.join(","), ...lines].join("\r\n");
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="convergence-opportunities-${new Date().toISOString().slice(0, 10)}.csv"`);
    return reply.send(csv);
  });

  /* ---------------- orders ---------------- */
  app.post("/api/orders", async (req) => {
    const a = requireTrader(req);
    const body = parse(z.object({
      accountId: accountEnum,
      eventId: z.string().min(1).max(200),
      qty: z.number().int().positive(),
      source: z.enum(["manual", "auto"]).optional(),
      ackFatEdge: z.boolean().optional()
    }), req.body);
    const order = await engine.createOrder(actorOf(a), body);
    return { ok: true, order, state: stateFor(a, body.accountId) };
  });

  app.post("/api/orders/:id/hedge", async (req) => {
    const a = requireTrader(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(80) }), req.params);
    const body = parse(z.object({ accountId: accountEnum }), req.body);
    const order = await engine.hedgeOrder(actorOf(a), body.accountId, id);
    return { ok: true, order, state: stateFor(a, body.accountId) };
  });

  app.post("/api/orders/:id/flatten", async (req) => {
    const a = requireTrader(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(80) }), req.params);
    const body = parse(z.object({ accountId: accountEnum }), req.body);
    await engine.flattenOrder(actorOf(a), body.accountId, id);
    return { ok: true, state: stateFor(a, body.accountId) };
  });

  app.post("/api/orders/:id/archive", async (req) => {
    const a = requireTrader(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(80) }), req.params);
    const body = parse(z.object({ accountId: accountEnum }), req.body);
    engine.archiveOrder(actorOf(a), body.accountId, id);
    return { ok: true, state: stateFor(a, body.accountId) };
  });

  /* ---------------- positions ---------------- */
  app.post("/api/positions", async (req) => {
    const a = requireTrader(req);
    const body = parse(z.object({
      accountId: accountEnum,
      eventId: z.string().min(1).max(200),
      sizeUsd: z.number().positive().max(50_000_000)
    }), req.body);
    const position = engine.createCombo(actorOf(a), body.accountId, body);
    return { ok: true, position, state: stateFor(a, body.accountId) };
  });

  app.post("/api/positions/align-all", async (req) => {
    const a = requireTrader(req);
    const body = parse(z.object({ accountId: accountEnum }), req.body);
    const count = await engine.alignAll(actorOf(a), body.accountId);
    return { ok: true, count, state: stateFor(a, body.accountId) };
  });

  app.post("/api/positions/:evId/align", async (req) => {
    const a = requireTrader(req);
    const { evId } = parse(z.object({ evId: z.string().min(1).max(200) }), req.params);
    const body = parse(z.object({ accountId: accountEnum }), req.body);
    await engine.alignHedge(actorOf(a), body.accountId, evId);
    return { ok: true, state: stateFor(a, body.accountId) };
  });

  app.post("/api/flatten-all", async (req) => {
    const a = requireTrader(req);
    const body = parse(z.object({ accountId: accountEnum }), req.body);
    const result = engine.flattenAll(actorOf(a), body.accountId);
    return { ok: true, result, state: stateFor(a, body.accountId) };
  });

  /* ---------------- reviews ---------------- */
  app.post("/api/reviews/:id/take", async (req) => {
    const a = requireTrader(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(80) }), req.params);
    const body = parse(z.object({ accountId: accountEnum, mode: z.enum(["shrink", "abort", "hold"]) }), req.body);
    engine.takeReview(actorOf(a), body.accountId, id, body.mode);
    return { ok: true, state: stateFor(a, body.accountId) };
  });

  app.post("/api/reviews/:id/ignore", async (req) => {
    const a = requireTrader(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(80) }), req.params);
    const body = parse(z.object({ accountId: accountEnum }), req.body);
    engine.ignoreReview(actorOf(a), body.accountId, id);
    return { ok: true, state: stateFor(a, body.accountId) };
  });

  app.post("/api/reviews/:id/flatten", async (req) => {
    const a = requireTrader(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(80) }), req.params);
    const body = parse(z.object({ accountId: accountEnum }), req.body);
    await engine.flattenReview(actorOf(a), body.accountId, id);
    return { ok: true, state: stateFor(a, body.accountId) };
  });

  /* ---------------- risk ---------------- */
  app.post("/api/risk/kill", async (req) => {
    const a = requireTrader(req);
    const body = parse(z.object({
      accountId: accountEnum, enabled: z.boolean(), reason: z.string().max(300).optional()
    }), req.body);
    engine.setKill(actorOf(a), body.accountId, body.enabled, body.reason || (body.enabled ? "人工触发" : "人工确认"));
    return { ok: true, state: stateFor(a, body.accountId) };
  });

  app.post("/api/risk/auto", async (req) => {
    const a = requireTrader(req);
    const body = parse(z.object({ accountId: accountEnum, enabled: z.boolean() }), req.body);
    engine.setAuto(actorOf(a), body.accountId, body.enabled);
    return { ok: true, state: stateFor(a, body.accountId) };
  });

  app.post("/api/simulation", async (req) => {
    const a = requireTrader(req);
    const body = parse(z.object({ accountId: accountEnum, enabled: z.boolean() }), req.body);
    const next = engine.setPaperTrading(actorOf(a), body.accountId, body.enabled);
    return { ok: true, paperTradingEnabled: next.paperTradingEnabled, state: stateFor(a, body.accountId) };
  });

  app.put("/api/risk/limits/:id", async (req) => {
    const a = requireTrader(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(40) }), req.params);
    const body = parse(z.object({
      accountId: accountEnum, value: z.number().positive().max(1_000_000_000)
    }), req.body);
    const limit = engine.updateLimit(actorOf(a), body.accountId, id, body.value);
    return { ok: true, limit, state: stateFor(a, body.accountId) };
  });

  app.post("/api/risk/limits/reset", async (req) => {
    const a = requireTrader(req);
    const body = parse(z.object({ accountId: accountEnum }), req.body);
    engine.resetLimits(actorOf(a), body.accountId);
    return { ok: true, state: stateFor(a, body.accountId) };
  });

  app.patch("/api/risk/rules/:id", async (req) => {
    const a = requireTrader(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(40) }), req.params);
    const body = parse(z.object({
      accountId: accountEnum, on: z.boolean().optional(), value: z.number().optional()
    }).refine(v => v.on !== undefined || v.value !== undefined, { message: "至少提供 on 或 value" }), req.body);
    const rule = engine.updateRule(actorOf(a), body.accountId, id, { on: body.on, value: body.value });
    return { ok: true, rule, state: stateFor(a, body.accountId) };
  });

  /* ---------------- accounts (self-service) ---------------- */
  app.get("/api/accounts", async (req) => {
    auth(req);
    return { accounts: engine.accountSummaries() };
  });

  app.patch("/api/accounts/:id", async (req) => {
    const a = requireTrader(req);
    const { id } = parse(z.object({ id: accountEnum }), req.params);
    const body = parse(z.object({
      auto: z.boolean().optional(),
      minEdge: z.number().min(0).max(50).optional()
    }), req.body);
    if (body.auto == null && body.minEdge == null) throw new EngineError("no_changes", "至少提供一个字段", 400);
    if (body.auto != null) engine.setAuto(actorOf(a), id, body.auto);
    if (body.minEdge != null) engine.updateAccount(actorOf(a), id, { minEdge: body.minEdge });
    return { ok: true, state: stateFor(a, id) };
  });

  /* ---------------- admin: users ---------------- */
  app.get("/api/admin/users", async (req) => {
    requireAdmin(req);
    return { users: repo.usersAll() };
  });

  app.post("/api/admin/users", async (req) => {
    const a = requireAdmin(req);
    const body = parse(z.object({
      email: z.string().trim().email().max(200),
      name: z.string().trim().min(1).max(80),
      role: z.enum(["admin", "trader", "analyst"]),
      password: z.string().min(8).max(300)
    }), req.body);
    if (repo.userByEmail(body.email)) throw new EngineError("email_exists", "该邮箱已存在", 409);
    const id = randomUUID();
    repo.userInsert({
      id, email: body.email, name: body.name, role: body.role,
      passwordHash: hashPassword(body.password), active: true, createdAt: new Date().toISOString()
    });
    repo.auditAdd({ t: nowClock(), actor: a.user.name, actorId: a.user.id, action: "创建用户", obj: body.email, venue: "后台", detail: `角色 ${body.role}` });
    return { ok: true, users: repo.usersAll() };
  });

  app.patch("/api/admin/users/:id", async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(80) }), req.params);
    const body = parse(z.object({
      name: z.string().trim().min(1).max(80).optional(),
      role: z.enum(["admin", "trader", "analyst"]).optional(),
      active: z.boolean().optional()
    }), req.body);
    const target = repo.userById(id);
    if (!target) throw new EngineError("user_not_found", "用户不存在", 404);
    if (id === a.user.id && ((body.role && body.role !== "admin") || body.active === false)) {
      throw new EngineError("self_lockout", "不能降级或停用当前登录的管理员", 409);
    }
    if (target.role === "admin" && (body.role && body.role !== "admin" || body.active === false) && repo.adminCount() <= 1) {
      throw new EngineError("last_admin", "至少保留一个启用的管理员", 409);
    }
    repo.userUpdate(id, body);
    if (body.active === false) repo.sessionsDeleteForUser(id);
    repo.auditAdd({ t: nowClock(), actor: a.user.name, actorId: a.user.id, action: "修改用户", obj: target.email, venue: "后台", detail: JSON.stringify(body) });
    return { ok: true, users: repo.usersAll() };
  });

  app.post("/api/admin/users/:id/reset-password", async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(80) }), req.params);
    const body = parse(z.object({ password: z.string().min(8).max(300) }), req.body);
    const target = repo.userById(id);
    if (!target) throw new EngineError("user_not_found", "用户不存在", 404);
    repo.userUpdate(id, { passwordHash: hashPassword(body.password) });
    repo.sessionsDeleteForUser(id);
    repo.auditAdd({ t: nowClock(), actor: a.user.name, actorId: a.user.id, action: "重置密码", obj: target.email, venue: "后台", detail: "该用户其他会话已注销" });
    return { ok: true };
  });

  app.delete("/api/admin/users/:id", async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(80) }), req.params);
    const target = repo.userById(id);
    if (!target) throw new EngineError("user_not_found", "用户不存在", 404);
    if (id === a.user.id) throw new EngineError("self_delete", "不能删除当前登录账户", 409);
    if (target.role === "admin" && repo.adminCount() <= 1) throw new EngineError("last_admin", "至少保留一个启用的管理员", 409);
    repo.userDelete(id);
    repo.auditAdd({ t: nowClock(), actor: a.user.name, actorId: a.user.id, action: "删除用户", obj: target.email, venue: "后台", detail: "账户已删除" });
    return { ok: true, users: repo.usersAll() };
  });

  /* ---------------- admin: settings / audit / ops ---------------- */
  app.get("/api/admin/settings", async (req) => {
    requireAdmin(req);
    const accountId = accountFrom(req);
    return {
      settings: getSettings(repo),
      accountId,
      accounts: engine.accountSummaries(),
      limits: engine.limitsWithUsage(accountId),
      rules: engine.rules(accountId),
      config: {
        ...publicConfig(),
        live: liveTradingConfigured()
      }
    };
  });

  app.put("/api/admin/settings", async (req) => {
    const a = requireAdmin(req);
    const body = parse(z.object({
      scanIntervalMs: z.number().int().min(500).max(60_000).optional(),
      liveTradingEnabled: z.boolean().optional(),
      cost: z.object({
        hlFeeBps: z.number().min(0).max(1000).optional(),
        hedgeSlipBps: z.number().min(0).max(1000).optional(),
        resolutionBps: z.number().min(0).max(1000).optional(),
        fundingBpsDay: z.number().min(0).max(1000).optional(),
        fundingCapBps: z.number().min(0).max(10_000).optional()
      }).optional()
    }), req.body);
    if (body.liveTradingEnabled) {
      const live = liveTradingConfigured();
      if (!live.all) throw new EngineError("live_not_configured", "交易所私有凭据未配置，不能启用实盘执行", 409);
      if (!live.acknowledged) throw new EngineError("live_not_acknowledged", "缺少 LIVE_TRADING_ACK 确认", 409);
    }
    const current = getSettings(repo);
    const next: Partial<AppSettings> = { ...body, cost: { ...current.cost, ...(body.cost ?? {}) } };
    saveSettings(repo, next);
    if (body.scanIntervalMs) engine.restartTimers();
    repo.auditAdd({ t: nowClock(), actor: a.user.name, actorId: a.user.id, action: "调整引擎", obj: "全局参数", venue: "后台", detail: JSON.stringify(body) });
    engine.emit("state");
    return { ok: true, settings: getSettings(repo) };
  });

  /* ---------------- admin: independent accounts ---------------- */
  app.get("/api/admin/accounts", async (req) => {
    requireAdmin(req);
    return { accounts: engine.accountSummaries(), portfolio: {
      equity: engine.equityTotal(),
      accounts: engine.accountSummaries().length
    } };
  });

  app.patch("/api/admin/accounts/:id", async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(z.object({ id: accountEnum }), req.params);
    const body = parse(z.object({
      enabled: z.boolean().optional(),
      equity: z.number().positive().max(1_000_000_000).optional(),
      minEdge: z.number().min(0).max(50).optional(),
      paperFillMs: z.number().int().min(200).max(60_000).optional()
    }), req.body);
    if (Object.values(body).every(v => v == null)) throw new EngineError("no_changes", "至少提供一个字段", 400);
    const updated = engine.updateAccount(actorOf(a), id, body);
    return { ok: true, account: updated, accounts: engine.accountSummaries(), state: stateFor(a, id) };
  });

  app.post("/api/admin/accounts/:id/kill", async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(z.object({ id: accountEnum }), req.params);
    const body = parse(z.object({ enabled: z.boolean(), reason: z.string().max(300).optional() }), req.body);
    engine.setKill(actorOf(a), id, body.enabled, body.reason || "管理员操作");
    return { ok: true, accounts: engine.accountSummaries(), state: stateFor(a, id) };
  });

  app.get("/api/admin/audit", async (req) => {
    requireAdmin(req);
    const qs = req.query as Record<string, unknown>;
    return {
      audit: repo.auditAll({
        limit: Math.min(1000, Math.max(1, Number(qs.limit) || 200)),
        actor: qs.actor ? String(qs.actor) : null,
        q: qs.q ? String(qs.q) : null
      })
    };
  });

  app.get("/api/admin/events", async (req) => {
    requireAdmin(req);
    return { events: market.events };
  });

  app.get("/api/admin/status", async (req) => {
    requireAdmin(req);
    return {
      version: "2.2.0",
      uptime: Math.round(process.uptime()),
      pid: process.pid,
      node: process.version,
      memory: process.memoryUsage(),
      counts: {
        users: repo.userCount(),
        events: market.events.length,
        positions: repo.positionsAll().length,
        orders: repo.ordersAll().length,
        reviews: repo.reviewsAll().length,
        audit: repo.auditAll({ limit: 1000 }).length
      },
      venues: [market.hlStatus, market.pmStatus],
      catalogMode: market.catalogMode,
      tradingMode: engine.tradingMode(),
      liveBlockedReason: engine.liveBlockedReason(),
      lastScanAt: market.lastScanAt,
      scanSeq: market.scanSeq
    };
  });

  app.post("/api/admin/venues/test", async (req) => {
    requireAdmin(req);
    const [hlStatus, pmStatus] = await Promise.all([hl.health(), pm.health()]);
    return { ok: true, venues: [hlStatus, pmStatus] };
  });

  app.post("/api/admin/catalog/refresh", async (req) => {
    const a = requireAdmin(req);
    const result = await engine.refreshCatalog(actorOf(a));
    return { ok: true, result, state: stateFor(a, accountFrom(req)) };
  });

  app.post("/api/admin/data/reset", async (req) => {
    const a = requireAdmin(req);
    parse(z.object({ confirm: z.literal("RESET") }), req.body);
    if (engine.tradingMode() === "live" && repo.positionsAll().length > 0) {
      throw new EngineError("live_reset_blocked", "实盘模式下不能直接重置账本，请先在交易所平掉全部头寸", 409);
    }
    resetLiveBaseline(repo);
    await engine.refreshCatalog(actorOf(a));
    repo.auditAdd({ t: nowClock(), actor: a.user.name, actorId: a.user.id, action: "重置数据", obj: "四账户纸面账本", venue: "管理", detail: "已清空纸面交易，四个账户各重置为 10,000 USDC，并重新拉取实时 Polymarket 目录" });
    engine.emit("state");
    return { ok: true, state: stateFor(a, accountFrom(req)) };
  });

  app.get("/api/admin/export", async (req, reply) => {
    const a = requireAdmin(req);
    const accountId = accountFrom(req);
    const payload = {
      exportedAt: new Date().toISOString(),
      state: stateFor(a, accountId),
      accounts: engine.accountSummaries(),
      users: repo.usersAll(),
      limits: engine.limitsWithUsage(accountId),
      rules: engine.rules(accountId),
      audit: repo.auditAll({ limit: 1000 })
    };
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="convergence-export-${new Date().toISOString().slice(0, 10)}.json"`);
    return reply.send(JSON.stringify(payload, null, 2));
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      return reply.code(404).send({ error: { code: "not_found", message: "接口不存在" } });
    }
    return reply.code(404).type("text/html; charset=utf-8").send(
      "<!doctype html><meta charset=utf-8><title>404</title><body style=\"background:#0b0e13;color:#dfe7ef;font:14px system-ui;padding:48px\">" +
      "<h1>404 · 页面不存在</h1><a style=\"color:#5ee0e8\" href=\"/\">返回交易终端</a></body>"
    );
  });

  return app;
}
