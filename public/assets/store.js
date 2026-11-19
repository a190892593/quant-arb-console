/* ============================================================
   CONVERGENCE · API-backed client store
   The server is the single source of truth. This module keeps the
   last snapshot, exposes the same synchronous facade the renderer
   expects, and refreshes it over SSE / polling.
   ============================================================ */

const emptyState = {
  version: 0,
  serverTime: Date.now(),
  now: { clock: "18:42:03", date: "2026-11-18", weekday: "周三", timezone: "Asia/Taipei" },
  user: null,
  csrf: "",
  config: {},
  accountId: "prob",
  accounts: [],
  portfolio: { equity: 0, pnl: 0, deployed: 0, usedPct: 0, accounts: 0, active: 0 },
  account: { id: "prob", name: "概率偏差", short: "S1", equity: 0, pnl: 0, usedPct: 0, dailyLossPct: 0 },
  settings: { auto: true, kill: false, killReason: "", minEdge: 2.5, scanIntervalMs: 2500, cost: {} },
  engine: {},
  venues: [],
  market: {},
  events: [],
  negRisk: [],
  bookEvents: [],
  positions: [],
  book: { rows: [], face: 0, cost: 0, hedge: 0, target: 0, pnl: 0, margin: 0, settle7: 0, maxCost: 0, byUnd: {}, netDelta: 0, unhedged: 0, undehedged: 0, nowMs: Date.now() },
  orders: [],
  reviews: [],
  audit: [],
  limits: [],
  rules: [],
  feed: [],
  riskEvents: [],
  calendar: [],
  equity: []
};

let state = structuredClone(emptyState);
let derived = new Map();
let clockSkew = 0;
let receivedAt = Date.now();
let refreshPromise = null;
let stream = null;
let pollTimer = null;
let refreshTimer = null;
let lastStateVersion = 0;
// The account the operator asked for; `state.accountId` is the account actually applied.
let desiredAccount = localStorage.getItem("conv.account") || "prob";
const listeners = new Set();

export class ApiError extends Error {
  constructor(message, code, status, details) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function applyState(next) {
  if (!next || typeof next !== "object") return;
  const prevVersion = state.version;
  const prevAccount = state.accountId;
  state = { ...emptyState, ...next };
  state.book = { ...emptyState.book, ...(next.book || {}) };
  state.settings = { ...emptyState.settings, ...(next.settings || {}) };
  state.account = { ...emptyState.account, ...(next.account || {}) };
  state.portfolio = { ...emptyState.portfolio, ...(next.portfolio || {}) };
  state.engine = { ...(next.engine || {}) };
  state.accounts = next.accounts || [];
  derived = new Map([...(state.events || []), ...(state.bookEvents || [])].map(e => [e.id, e]));
  clockSkew = state.serverTime - Date.now();
  receivedAt = Date.now();
  lastStateVersion = state.version;
  const changed = state.version !== prevVersion || state.accountId !== prevAccount;
  for (const fn of listeners) {
    try { fn({ type: changed ? "state" : "tick", state }); } catch (err) { console.error("state listener failed", err); }
  }
}

function scheduleRefresh(delay = 150) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { void refresh(); }, delay);
}

export async function refresh(options = {}) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    // Loop until the account fetched matches the account the operator last selected.
    for (;;) {
      const requested = desiredAccount;
      const res = await fetch("/api/state?account=" + encodeURIComponent(requested), {
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store"
      });
      if (res.status === 401) {
        location.href = "/login?next=" + encodeURIComponent(location.pathname + location.hash);
        throw new ApiError("登录已过期", "unauthorized", 401);
      }
      if (!res.ok) throw new ApiError("状态加载失败", "state_failed", res.status);
      const data = await res.json();
      if (requested !== desiredAccount) continue;
      applyState(data.state);
      return state;
    }
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function request(method, path, body, opts = {}) {
  const headers = { accept: "application/json" };
  let payload = body;
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      payload = { accountId: state.accountId || "prob", ...payload };
    }
  }
  if (state.csrf) headers["x-csrf-token"] = state.csrf;
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  if (res.status === 401) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname + location.hash);
    throw new ApiError("登录已过期", "unauthorized", 401);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.error || {};
    throw new ApiError(err.message || "请求失败", err.code || "request_failed", res.status, err.issues);
  }
  if (data.state && opts.apply !== false) applyState(data.state);
  return data;
}

export const api = {
  get: path => request("GET", path),
  post: (path, body) => request("POST", path, body ?? {}),
  put: (path, body) => request("PUT", path, body ?? {}),
  patch: (path, body) => request("PATCH", path, body ?? {}),
  del: path => request("DELETE", path),
  /** Fire an action on another account without switching the terminal to it. */
  postSilent: (path, body) => request("POST", path, body ?? {}, { apply: false }),
  patchSilent: (path, body) => request("PATCH", path, body ?? {}, { apply: false })
};

export async function download(path, filename) {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) throw new ApiError("导出失败", "download_failed", res.status);
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function connectStream() {
  if (stream || typeof EventSource === "undefined") return;
  stream = new EventSource("/api/stream");
  stream.addEventListener("tick", () => scheduleRefresh(220));
  stream.addEventListener("state", () => scheduleRefresh(80));
  stream.addEventListener("hello", () => scheduleRefresh(0));
  stream.addEventListener("error", () => {
    // EventSource retries automatically; polling keeps the screen fresh meanwhile.
    if (!pollTimer) pollTimer = setInterval(() => void refresh({ silent: true }).catch(() => {}), 6000);
  });
  stream.addEventListener("open", () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  });
}

export const CONV = {
  /* lifecycle */
  async ready() {
    await refresh({ silent: true });
    connectStream();
    if (!pollTimer) pollTimer = setInterval(() => void refresh({ silent: true }).catch(() => {}), 5000);
    return CONV;
  },
  refresh,
  applyState,
  api,
  download,
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  /* identity */
  get user() { return state.user; },
  get csrf() { return state.csrf; },
  get config() { return state.config; },
  get engine() { return state.engine; },
  get settings() { return state.settings; },
  get account() { return state.account; },
  get accountId() { return state.accountId || "prob"; },
  get accounts() { return state.accounts; },
  get portfolio() { return state.portfolio; },
  async setAccount(id) {
    if (!id) return state;
    if (id === desiredAccount && state.accountId === id) return state;
    desiredAccount = id;
    localStorage.setItem("conv.account", id);
    await refresh();
    // If the previous snapshot had already resolved before the switch, run one fresh fetch.
    if (state.accountId !== id) await refresh();
    return state;
  },
  get venues() { return state.venues; },
  get meta() { return state.now; },
  get version() { return state.version; },

  /* market / data */
  get market() { return state.market; },
  get events() { return state.events; },
  get bookEvents() { return state.bookEvents || []; },
  event(id) { return derived.get(id) || null; },
  get positions() { return state.positions; },
  get orders() { return state.orders; },
  get reviews() { return state.reviews; },
  get audit() { return state.audit; },
  get limits() { return state.limits; },
  get limitDefaults() { return state.limits.map(({ used, ...rest }) => rest); },
  get rules() { return state.rules; },
  get feed() { return state.feed; },
  get riskEvents() { return state.riskEvents; },
  get calendar() { return state.calendar; },
  get equity() { return state.equity; },
  get equityNow() { return state.account.equity; },
  get book() { return () => state.book; },
  get COST() { return state.settings.cost; },
  get MIN_EDGE_CENTS() { return state.settings.minEdge; },
  get SIM_BASE() { return state.serverTime; },
  get base() { return { market: state.market, quotes: [] }; },
  get CURATED_COUNT() { return state.events.length; },
  get UNIVERSE_SIZE() { return state.events.length; },

  now() { return Date.now() + clockSkew; },
  derive(ev) {
    const id = typeof ev === "string" ? ev : ev && ev.id;
    return derived.get(id) || (ev && ev.id ? ev : null);
  },
  positionView(p) {
    if (!p) return null;
    return state.book.rows.find(r => r.evId === p.evId) || null;
  },
  bookFor() { return state.book; },
  lastUpdatedAt() { return receivedAt; }
};

export default CONV;
