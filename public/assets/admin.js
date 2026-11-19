/* ============================================================
   CONVERGENCE · admin console
   ============================================================ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = n => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const compact = n => {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (v >= 1000) return "$" + Math.round(n / 1e3) + "k";
  return usd(n);
};
const dt = iso => iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—";

const S = {
  me: null,
  csrf: "",
  status: null,
  settings: null,
  users: [],
  accounts: [],
  portfolio: {},
  events: [],
  audit: [],
  view: "overview",
  riskAccount: "prob",
  auditAccount: "",
  eventQuery: ""
};

const titles = {
  overview: "概览", users: "用户与权限", accounts: "策略账户", venues: "场所连接", strategy: "策略与引擎",
  events: "事件目录", risk: "风控配置", audit: "审计日志", data: "数据与导出"
};

class AdminError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

async function api(method, path, body) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (S.csrf) headers["x-csrf-token"] = S.csrf;
  const res = await fetch(path, {
    method, headers, credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 401) { location.href = "/login?next=/admin"; throw new AdminError("登录已过期", "unauthorized", 401); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AdminError(data.error?.message || "请求失败", data.error?.code, res.status);
  return data;
}

function toast(message, kind = "ok") {
  const box = $("#admin-toasts");
  const el = document.createElement("div");
  el.className = "admin-toast " + (kind === "ok" ? "" : kind);
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateY(4px)"; }, 4200);
  setTimeout(() => el.remove(), 4600);
}

async function loadAll(showToast = false) {
  try {
    const [status, settings, users, accounts, events, audit] = await Promise.all([
      api("GET", "/api/admin/status"),
      api("GET", "/api/admin/settings?account=" + encodeURIComponent(S.riskAccount)),
      api("GET", "/api/admin/users"),
      api("GET", "/api/admin/accounts"),
      api("GET", "/api/admin/events"),
      api("GET", "/api/admin/audit?limit=300")
    ]);
    S.status = status;
    S.settings = settings;
    S.users = users.users;
    S.accounts = accounts.accounts;
    S.portfolio = accounts.portfolio;
    S.events = events.events;
    S.audit = audit.audit;
    renderAll();
    if (showToast) toast("已刷新");
  } catch (err) {
    toast("加载失败：" + err.message, "bad");
  }
}

/* ---------------- rendering ---------------- */
function renderAll() {
  renderHeader();
  renderOverview();
  renderUsers();
  renderAccounts();
  renderVenues();
  renderStrategy();
  renderEvents();
  renderRisk();
  renderAudit();
  renderData();
}

function renderHeader() {
  const name = $("#admin-name");
  if (name) name.textContent = S.me.name;
  const email = $("#admin-email");
  if (email) email.textContent = S.me.email;
  const avatar = $("#admin-avatar");
  if (avatar) avatar.textContent = (S.me.name || "A").slice(0, 1).toUpperCase();
  const pill = $("#env-pill");
  if (pill) {
    const live = S.status?.catalogMode === "live";
    const offline = S.status?.catalogMode === "offline";
    const mode = live ? "实时目录" : offline ? "PM 离线" : "测试目录";
    pill.innerHTML = '<span class="dot ' + (live ? "ok" : offline ? "bad" : "warn") + '"></span>' + mode + " · " + (S.status?.tradingMode === "live" ? "实盘" : "纸面");
  }
  const title = $("#admin-title");
  if (title) title.textContent = "管理 · " + (titles[S.view] || "概览");
}

function renderOverview() {
  const st = S.status;
  if (!st) return;
  const live = st.catalogMode === "live";
  const venuesOk = st.venues.every(v => v.state === "ok");
  const running = S.accounts.filter(a => a.enabled && !a.kill).length;
  const autoOn = S.accounts.filter(a => a.enabled && !a.kill && a.auto).length;
  const kpis = [
    { label: "引擎", value: live ? "LIVE" : st.catalogMode === "offline" ? "OFFLINE" : "TEST", sub: "目录 " + st.catalogMode + " · " + (st.tradingMode === "live" ? "实盘执行" : "纸面撮合"), cls: live ? "is-ok" : "is-warn" },
    { label: "扫描面", value: String(st.counts.events), sub: "扫描序号 #" + Number(st.scanSeq || 0).toLocaleString("en-US"), cls: "" },
    { label: "独立账户", value: String(S.accounts.length), sub: running + " 运行 · " + (S.accounts.length - running) + " 熔断或停用", cls: running === S.accounts.length ? "is-ok" : "is-warn" },
    { label: "场所", value: venuesOk ? "OK" : "DEGRADED", sub: st.venues.map(v => v.label.split(" ")[0] + " " + v.state).join(" · "), cls: venuesOk ? "is-ok" : "is-warn" }
  ];
  $("#overview-kpis").innerHTML = kpis.map(k =>
    '<article class="admin-kpi ' + k.cls + '"><span class="eyebrow">' + esc(k.label) + "</span><b>" + esc(k.value) + "</b><small>" + esc(k.sub) + "</small></article>"
  ).join("");

  $("#overview-venues").innerHTML = st.venues.map(v => venueRow(v)).join("");
  $("#overview-facts").innerHTML = [
    ["运行时长", Math.floor(st.uptime / 60) + " 分 " + (st.uptime % 60) + " 秒"],
    ["Node", st.node],
    ["内存 RSS", Math.round(st.memory.rss / 1048576) + " MB"],
    ["扫描序号", "#" + Number(st.scanSeq || 0).toLocaleString("en-US")],
    ["持仓 / 订单", st.counts.positions + " / " + st.counts.orders],
    ["待接管", String(st.counts.reviews)],
    ["自动执行", autoOn + " / " + S.accounts.length + " 账户开启"],
    ["实盘状态", st.liveBlockedReason || (st.tradingMode === "live" ? "已启用" : "纸面模式")]
  ].map(([k, v]) => "<div><dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd></div>").join("");

  $("#overview-audit").innerHTML = auditTable(S.audit.slice(0, 8));
}

function venueRow(v) {
  const cls = v.state === "ok" ? "ok" : v.state === "down" ? "bad" : "warn";
  return '<div class="admin-venue"><div><b>' + esc(v.label) + "</b></div>" +
    '<span class="admin-tag ' + cls + '"><span class="dot ' + (v.state === "ok" ? "ok" : v.state === "down" ? "bad" : "warn") + '"></span>' +
    esc(v.state.toUpperCase()) + (v.latencyMs != null ? " · " + v.latencyMs + "ms" : "") + "</span>" +
    "<p>" + esc(v.message) + "</p></div>";
}

function renderUsers() {
  $("#users-count").textContent = S.users.length + " 个账号";
  $("#users-table").innerHTML = '<table class="admin-table"><thead><tr>' +
    "<th>用户</th><th>邮箱</th><th>角色</th><th>状态</th><th>最近登录</th><th></th></tr></thead><tbody>" +
    S.users.map(u =>
      "<tr><td><b>" + esc(u.name) + "</b></td><td class=\"muted\">" + esc(u.email) + "</td>" +
      '<td><span class="admin-tag ' + (u.role === "admin" ? "warn" : u.role === "trader" ? "ok" : "") + '">' + esc(u.role) + "</span></td>" +
      "<td>" + (u.active ? '<span class="admin-tag ok">启用</span>' : '<span class="admin-tag bad">停用</span>') + "</td>" +
      '<td class="num muted">' + esc(dt(u.lastLogin)) + "</td>" +
      '<td><div class="actions">' +
        '<button class="admin-btn admin-btn-sm" data-user-edit="' + esc(u.id) + '">编辑</button>' +
        '<button class="admin-btn admin-btn-sm" data-user-pass="' + esc(u.id) + '">重置密码</button>' +
        '<button class="admin-btn admin-btn-sm admin-btn-danger" data-user-del="' + esc(u.id) + '">删除</button>' +
      "</div></td></tr>"
    ).join("") + "</tbody></table>";
}

function renderAccounts() {
  const accounts = S.accounts || [];
  const equity = accounts.reduce((s, a) => s + (a.equity || 0), 0);
  const pnl = accounts.reduce((s, a) => s + (a.pnl || 0), 0);
  const deployed = accounts.reduce((s, a) => s + (a.bookCost || 0), 0);
  const usedPct = equity > 0 ? deployed / equity : 0;
  const accountOptions = accounts.map(a => '<option value="' + a.id + '">' + esc(a.name) + " · " + esc(a.id) + "</option>").join("");
  for (const selector of ["#strategy-account", "#risk-account"]) {
    const el = $(selector);
    if (!el) continue;
    el.innerHTML = accountOptions;
    el.value = S.riskAccount;
  }
  const auditSel = $("#audit-account");
  if (auditSel) {
    auditSel.innerHTML = '<option value="">全部账户</option>' +
      accounts.map(a => '<option value="' + a.id + '">' + esc(a.short || "") + " " + esc(a.name) + "</option>").join("");
    auditSel.value = S.auditAccount;
  }
  $("#accounts-kpis").innerHTML = [
    { label: "组合净值", value: usd(equity), sub: accounts.length + " 个独立账户", cls: "" },
    { label: "未实现盈亏", value: (pnl >= 0 ? "+" : "−") + usd(Math.abs(pnl)), sub: "各账户独立计算", cls: pnl >= 0 ? "is-ok" : "is-bad" },
    { label: "已部署", value: usd(deployed), sub: "占组合净值 " + (usedPct * 100).toFixed(1) + "%", cls: "" },
    { label: "运行中", value: accounts.filter(a => a.enabled && !a.kill).length + " / " + accounts.length, sub: "熔断或停用即退出自动执行", cls: "" }
  ].map(k => '<article class="admin-kpi ' + k.cls + '"><span class="eyebrow">' + esc(k.label) + "</span><b>" + esc(k.value) + "</b><small>" + esc(k.sub) + "</small></article>").join("");

  $("#accounts-grid").innerHTML = accounts.map(a => {
    const cls = !a.enabled ? "warn" : a.kill ? "bad" : a.auto ? "ok" : "warn";
    const label = !a.enabled ? "已停用" : a.kill ? "已熔断" : a.auto ? "运行中" : "自动暂停";
    return '<article class="admin-account-card"><header class="admin-account-h"><div><b>' + esc(a.name) + "</b><small>" + esc(a.id) + " · " + esc(a.short || "") + " · " + esc(a.holdLabel || "") + "</small></div>" +
      '<span class="admin-tag ' + cls + '">' + label + "</span></header>" +
      '<div class="admin-account-eq">' + usd(a.equity, 2) + "</div>" +
      '<div class="admin-account-meta">' +
        "<div><span>未实现</span><b>" + ((a.pnl || 0) >= 0 ? "+" : "−") + usd(Math.abs(a.pnl || 0)) + "</b></div>" +
        "<div><span>已部署</span><b>" + usd(a.bookCost || 0) + "</b></div>" +
        "<div><span>持仓 / 在途</span><b>" + a.positions + " / " + a.openOrders + "</b></div>" +
        "<div><span>信号 / 可执行</span><b>" + a.signals + " / " + a.ready + "</b></div>" +
      "</div>" +
      '<p class="admin-p" style="min-height:38px">' + esc(a.logic || a.desc || "") + "</p>" +
      '<div class="admin-account-actions">' +
        '<button class="admin-btn admin-btn-sm" data-account-enter="' + a.id + '">在终端查看</button>' +
        '<button class="admin-btn admin-btn-sm" data-account-edit="' + a.id + '">调整参数</button>' +
        '<button class="admin-btn admin-btn-sm" data-account-auto="' + a.id + '">' + (a.auto ? "暂停自动" : "恢复自动") + "</button>" +
        '<button class="admin-btn admin-btn-sm" data-account-enabled="' + a.id + '" data-enabled="' + a.enabled + '">' + (a.enabled ? "停用" : "启用") + "</button>" +
        '<button class="admin-btn admin-btn-sm ' + (a.kill ? "" : "admin-btn-danger") + '" data-account-kill="' + a.id + '" data-kill="' + a.kill + '">' + (a.kill ? "解除熔断" : "熔断") + "</button>" +
      "</div></article>";
  }).join("");

  $("#accounts-table").innerHTML = '<table class="admin-table"><thead><tr><th>账户</th><th>净值</th><th>已部署</th><th>未实现</th><th>持仓/在途</th><th>信号</th><th>状态</th><th></th></tr></thead><tbody>' +
    accounts.map(a => '<tr data-account-row="' + a.id + '"><td><b>' + esc(a.name) + "</b><br><span class=\"muted\">" + esc(a.id) + "</span></td>" +
      '<td class="num">' + usd(a.equity) + '</td><td class="num">' + usd(a.bookCost || 0) + '</td>' +
      '<td class="num">' + ((a.pnl || 0) >= 0 ? "+" : "−") + usd(Math.abs(a.pnl || 0)) + "</td>" +
      '<td class="num">' + a.positions + " / " + a.openOrders + '</td><td class="num">' + a.signals + " / " + a.ready + "</td>" +
      "<td>" + (!a.enabled ? '<span class="admin-tag warn">停用</span>' : a.kill ? '<span class="admin-tag bad">熔断</span>' : a.auto ? '<span class="admin-tag ok">运行</span>' : '<span class="admin-tag warn">暂停</span>') + "</td>" +
      '<td><button class="admin-btn admin-btn-sm" data-account-enter="' + a.id + '">进入</button></td></tr>').join("") +
    "</tbody></table>";
}

function renderVenues() {
  const st = S.status;
  if (!st) return;
  $("#venue-cards").innerHTML = st.venues.map(v => {
    const cls = v.state === "ok" ? "ok" : v.state === "down" ? "bad" : "warn";
    return '<article class="admin-card"><header><span class="eyebrow">' + esc(v.id) + "</span>" +
      '<span class="admin-tag ' + cls + '">' + esc(v.state) + "</span></header>" +
      "<div class=\"admin-venue\" style=\"border:0;background:none;padding:0\"><div><b>" + esc(v.label) + "</b></div>" +
      "<div class=\"admin-muted\">" + (v.latencyMs != null ? v.latencyMs + " ms" : "无延迟数据") + "</div>" +
      "<p>" + esc(v.message) + "</p></div>" +
      '<dl class="admin-facts" style="margin-top:12px"><div><dt>模式</dt><dd>' + esc(v.mode) + "</dd></div>" +
      "<div><dt>最近成功</dt><dd>" + esc(v.lastOkAt ? new Date(v.lastOkAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—") + "</dd></div></dl></article>";
  }).join("");

  const cfg = S.settings?.config;
  if (!cfg) return;
  const live = cfg.live;
  $("#venue-config").innerHTML = [
    ["MARKET_DATA_MODE", cfg.marketDataMode],
    ["TRADING_MODE", cfg.tradingMode],
    ["Hyperliquid 凭据", live.hl ? "已配置" : "未配置"],
    ["Polymarket 凭据", live.pm ? "已配置" : "未配置"],
    ["实盘确认短语", live.acknowledged ? "已确认" : "未确认"],
    ["Polymarket Chain", String(cfg.pm.chainId)],
    ["HL 测试网", cfg.hl.testnet ? "是" : "否"],
    ["PM CLOB", cfg.pm.clobUrl]
  ].map(([k, v]) => "<div><dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd></div>").join("");
}

function renderStrategy() {
  if (!S.settings) return;
  const s = S.settings.settings;
  const cfg = S.settings.config;
  const canLive = cfg.live.all && cfg.live.acknowledged;
  const field = (name, label, value, step = "any", hint = "") =>
    '<label class="admin-field"><span>' + label + "</span><input name=\"" + name + '" type="number" step="' + step + '" value="' + value + '">' +
    (hint ? "<small>" + hint + "</small>" : "") + "</label>";
  const toggle = (name, label, desc, on, disabled = false) =>
    '<div class="admin-switch-row"><div><b>' + label + "</b><span>" + desc + "</span></div>" +
    '<button type="button" class="admin-switch" role="switch" data-setting-toggle="' + name + '" aria-checked="' + String(on) + '"' +
    (disabled ? " disabled" : "") + "></button></div>";

  $("#settings-fields").innerHTML =
    '<div class="admin-field" style="grid-column:1/-1">' +
      toggle("liveTradingEnabled", "启用实盘执行", canLive ? "已具备凭据与确认短语，打开后真实订单将发往交易所。" : "凭据或 LIVE_TRADING_ACK 未就绪，无法启用。", s.liveTradingEnabled, !canLive) +
    "</div>" +
    field("scanIntervalMs", "扫描间隔（ms）", s.scanIntervalMs, "100", "500–60000，全局生效") +
    field("hlFeeBps", "HL 手续费（bps）", s.cost.hlFeeBps, "0.1") +
    field("hedgeSlipBps", "对冲滑点（bps）", s.cost.hedgeSlipBps, "0.1") +
    field("resolutionBps", "结算缓冲（bps）", s.cost.resolutionBps, "0.1") +
    field("fundingBpsDay", "资金费率/日（bps）", s.cost.fundingBpsDay, "0.01") +
    field("fundingCapBps", "资金费率上限（bps）", s.cost.fundingCapBps, "0.1") +
    '<div class="admin-note" style="grid-column:1/-1">自动执行、净边阈值与纸面成交延迟按账户独立配置，见「策略账户」；本页只保留全局扫描节奏与成本模型。</div>';

  $("#strategy-limits").innerHTML = limitsTable(S.settings.limits);
}

function limitsTable(limits) {
  if (!limits?.length) return '<div class="admin-empty">没有限额配置</div>';
  return '<table class="admin-table"><thead><tr><th>限额</th><th>占用</th><th>上限</th><th></th></tr></thead><tbody>' +
    limits.map(l => {
      const used = l.kind === "pct" ? l.used.toFixed(1) + "%" : compact(l.used);
      const val = l.kind === "pct" ? l.value + "%" : compact(l.value);
      return "<tr><td><b>" + esc(l.name) + '</b><br><span class="muted">' + esc(l.desc) + "</span></td>" +
        '<td class="num">' + used + '</td><td class="num">' + val + "</td>" +
        '<td><div class="actions"><button class="admin-btn admin-btn-sm" data-limit="' + esc(l.id) + '">修改</button></div></td></tr>';
    }).join("") + "</tbody></table>";
}

function renderEvents() {
  const q = S.eventQuery.toLowerCase();
  const rows = S.events.filter(e => !q || (e.title + e.und + e.src + e.cat).toLowerCase().includes(q));
  $("#events-count").textContent = rows.length + " / " + S.events.length + " 个事件";
  $("#events-table").innerHTML = '<table class="admin-table"><thead><tr>' +
    "<th>事件</th><th>标的</th><th>结算</th><th>PM 卖价</th><th>HL 公允</th><th>盘口</th><th>置信</th><th>来源</th></tr></thead><tbody>" +
    rows.slice(0, 300).map(e =>
      "<tr><td><b>" + esc(e.title) + '</b><br><span class="muted">' + esc(e.cat) + " · " + esc(e.src) + "</span></td>" +
      "<td>" + esc(e.und) + '</td><td class="num">' + esc(String(e.due).slice(0, 10)) + "</td>" +
      '<td class="num">' + (e.ask * 100).toFixed(1) + "¢</td>" +
      '<td class="num">' + (e.fair * 100).toFixed(1) + "¢</td>" +
      '<td class="num">' + compact(e.depth) + "</td>" +
      '<td class="num">' + e.conf + "</td>" +
      '<td><span class="admin-tag ' + (e.source === "polymarket" ? "ok" : "warn") + '">' + esc(e.source) + "</span></td></tr>"
    ).join("") + "</tbody></table>";
}

function renderRisk() {
  $("#risk-limits").innerHTML = limitsTable(S.settings?.limits);
  const rules = S.settings?.rules || [];
  $("#rules-count").textContent = rules.filter(r => r.on).length + " / " + rules.length + " 启用";
  const unit = r => r.unit === "days" ? "天" : r.unit === "pct" ? "%" : r.unit === "usd" ? "USDC" : r.unit === "ms" ? "ms" : r.unit === "bps" ? "bps" : r.unit === "shares" ? "股" : r.unit === "x" ? "x" : r.unit === "sec" ? "秒" : "/100";
  $("#rules-list").innerHTML = rules.map(r =>
    '<div class="admin-rule"><div><b>' + esc(r.name) + (r.hard ? ' <span class="admin-tag">硬约束</span>' : "") + "</b><span>" + esc(r.desc) + "</span></div>" +
    '<div class="admin-rule-side">' +
      (r.value != null ? '<label class="admin-rule-param"><input type="number" data-rule-value="' + esc(r.id) + '" value="' + r.value + '" min="' + (r.min ?? 0) + '" max="' + (r.max ?? 1e9) + '" step="' + (r.step ?? 1) + '"><span>' + unit(r) + "</span></label>" : "") +
      '<button type="button" class="admin-switch" role="switch" data-rule="' + esc(r.id) + '" aria-checked="' + String(r.on) + '"' + (r.hard ? " disabled" : "") + "></button>" +
    "</div></div>"
  ).join("");
}

function auditTable(rows) {
  if (!rows.length) return '<div class="admin-empty">没有符合条件的审计记录</div>';
  const accountName = id => S.accounts.find(a => a.id === id)?.name || id || "全局";
  return '<table class="admin-table"><thead><tr><th>时间</th><th>账户</th><th>主体</th><th>动作</th><th>对象</th><th>场所</th><th>详情</th></tr></thead><tbody>' +
    rows.map(a => '<tr><td class="num">' + esc(a.t) + "</td><td>" +
      (a.accountId ? '<span class="admin-tag">' + esc(accountName(a.accountId)) + "</span>" : '<span class="muted">全局</span>') +
      '</td><td><span class="admin-tag">' + esc(a.actor) + "</span></td>" +
      "<td>" + esc(a.action) + "</td><td>" + esc(a.obj) + '</td><td class="muted">' + esc(a.venue) + "</td>" +
      '<td class="muted">' + esc(a.detail) + "</td></tr>").join("") + "</tbody></table>";
}

function renderAudit() {
  const actor = $("#audit-actor")?.value || "";
  const q = ($("#audit-search")?.value || "").toLowerCase();
  const rows = S.audit.filter(a =>
    (!actor || a.actor === actor) &&
    (!S.auditAccount || a.accountId === S.auditAccount) &&
    (!q || (a.obj + a.detail + a.action).toLowerCase().includes(q))
  );
  $("#audit-count").textContent = rows.length + " 条";
  $("#audit-table").innerHTML = auditTable(rows.slice(0, 300));
}

function renderData() {
  const st = S.status;
  if (!st) return;
  $("#data-facts").innerHTML = [
    ["版本", st.version],
    ["Node", st.node],
    ["进程", String(st.pid)],
    ["运行时长", Math.floor(st.uptime / 3600) + "h " + Math.floor((st.uptime % 3600) / 60) + "m"],
    ["内存 RSS", Math.round(st.memory.rss / 1048576) + " MB"],
    ["事件", String(st.counts.events)],
    ["持仓", String(st.counts.positions)],
    ["订单", String(st.counts.orders)],
    ["待接管", String(st.counts.reviews)],
    ["审计", String(st.counts.audit)]
  ].map(([k, v]) => "<div><dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd></div>").join("");
}

/* ---------------- navigation ---------------- */
function setView(view, syncHash = true) {
  if (!titles[view]) view = "overview";
  S.view = view;
  $$(".admin-nav-item").forEach(b => b.classList.toggle("is-on", b.dataset.adminTab === view));
  $$("[data-admin-view]").forEach(sec => { sec.hidden = sec.dataset.adminView !== view; });
  const title = $("#admin-title");
  if (title) title.textContent = "管理 · " + (titles[view] || "概览");
  if (syncHash) history.replaceState(null, "", "#/admin/" + view);
  if (view === "audit") renderAudit();
}

$$(".admin-nav-item").forEach(b => b.addEventListener("click", () => setView(b.dataset.adminTab)));
$$("[data-goto]").forEach(a => a.addEventListener("click", e => { e.preventDefault(); setView(a.dataset.goto); }));

/* ---------------- modal ---------------- */
function openModal({ title, body, actions }) {
  $("#admin-modal-title").textContent = title;
  $("#admin-modal-body").innerHTML = body;
  const foot = $("#admin-modal-foot");
  foot.innerHTML = "";
  (actions || [{ label: "关闭" }]).forEach((a, i) => {
    const btn = document.createElement("button");
    btn.className = "admin-btn " + (a.kind === "primary" ? "admin-btn-primary" : a.kind === "danger" ? "admin-btn-danger" : "");
    btn.textContent = a.label;
    btn.addEventListener("click", async () => {
      if (a.onClick) {
        btn.disabled = true;
        try {
          const keep = await a.onClick();
          if (keep === false) { btn.disabled = false; return; }
        } catch (err) {
          toast(err.message, "bad");
          btn.disabled = false;
          return;
        }
      }
      closeModal();
    });
    foot.appendChild(btn);
  });
  $("#admin-modal").hidden = false;
}
function closeModal() { $("#admin-modal").hidden = true; }
$$("[data-modal-close]").forEach(el => el.addEventListener("click", closeModal));
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

/* ---------------- actions ---------------- */
$("#refresh-all").addEventListener("click", () => loadAll(true));
$("#admin-logout")?.addEventListener("click", async () => {
  try { await api("POST", "/api/auth/logout"); } catch { /* ignore */ }
  location.href = "/login";
});

$("#new-user").addEventListener("click", () => {
  openModal({
    title: "新建用户",
    body: '<div class="admin-field"><span>姓名</span><input id="nu-name" placeholder="陈 · 交易"></div>' +
      '<div class="admin-field"><span>邮箱</span><input id="nu-email" type="email" placeholder="name@convergence.local"></div>' +
      '<div class="admin-field"><span>角色</span><select id="nu-role"><option value="trader">交易员</option><option value="analyst">只读分析</option><option value="admin">管理员</option></select></div>' +
      '<div class="admin-field"><span>初始密码</span><input id="nu-pass" type="password" placeholder="至少 8 位"></div>',
    actions: [
      { label: "取消" },
      { label: "创建", kind: "primary", onClick: async () => {
          const name = $("#nu-name").value.trim();
          const email = $("#nu-email").value.trim();
          const role = $("#nu-role").value;
          const password = $("#nu-pass").value;
          if (!name || !email || password.length < 8) { toast("请填写姓名、邮箱与至少 8 位密码", "warn"); return false; }
          await api("POST", "/api/admin/users", { name, email, role, password });
          toast("用户已创建");
          await loadAll();
        } }
    ]
  });
});

$("#users-table").addEventListener("click", e => {
  const edit = e.target.closest("[data-user-edit]");
  const pass = e.target.closest("[data-user-pass]");
  const del = e.target.closest("[data-user-del]");
  if (edit) {
    const u = S.users.find(x => x.id === edit.dataset.userEdit);
    if (!u) return;
    openModal({
      title: "编辑 " + u.name,
      body: '<div class="admin-field"><span>姓名</span><input id="eu-name" value="' + esc(u.name) + '"></div>' +
        '<div class="admin-field"><span>邮箱</span><input value="' + esc(u.email) + '" disabled></div>' +
        '<div class="admin-field"><span>角色</span><select id="eu-role">' +
          ["admin", "trader", "analyst"].map(r => '<option value="' + r + '"' + (r === u.role ? " selected" : "") + ">" + r + "</option>").join("") +
        "</select></div>" +
        '<div class="admin-field"><span>状态</span><select id="eu-active"><option value="1"' + (u.active ? " selected" : "") + ">启用</option><option value=\"0\"" + (!u.active ? " selected" : "") + ">停用</option></select></div>",
      actions: [
        { label: "取消" },
        { label: "保存", kind: "primary", onClick: async () => {
            await api("PATCH", "/api/admin/users/" + u.id, {
              name: $("#eu-name").value.trim(),
              role: $("#eu-role").value,
              active: $("#eu-active").value === "1"
            });
            toast("用户已更新");
            await loadAll();
          } }
      ]
    });
  } else if (pass) {
    const u = S.users.find(x => x.id === pass.dataset.userPass);
    openModal({
      title: "重置密码 · " + u.name,
      body: '<div class="admin-field"><span>新密码</span><input id="rp-pass" type="password" placeholder="至少 8 位"></div>' +
        '<p class="admin-p">该用户的其他会话会立即注销。</p>',
      actions: [
        { label: "取消" },
        { label: "重置", kind: "danger", onClick: async () => {
            const password = $("#rp-pass").value;
            if (password.length < 8) { toast("密码至少 8 位", "warn"); return false; }
            await api("POST", "/api/admin/users/" + u.id + "/reset-password", { password });
            toast("密码已重置");
          } }
      ]
    });
  } else if (del) {
    const u = S.users.find(x => x.id === del.dataset.userDel);
    openModal({
      title: "删除用户？",
      body: '<p class="admin-p">将删除 <b>' + esc(u.name) + "</b>（" + esc(u.email) + "）。该操作不可撤销。</p>",
      actions: [
        { label: "取消" },
        { label: "删除", kind: "danger", onClick: async () => {
            await api("DELETE", "/api/admin/users/" + u.id);
            toast("用户已删除");
            await loadAll();
          } }
      ]
    });
  }
});

$("#accounts-grid").addEventListener("click", handleAccountAction);
$("#accounts-table").addEventListener("click", handleAccountAction);

async function handleAccountAction(e) {
  const enter = e.target.closest("[data-account-enter]");
  const row = e.target.closest("[data-account-row]");
  const edit = e.target.closest("[data-account-edit]");
  const auto = e.target.closest("[data-account-auto]");
  const enabled = e.target.closest("[data-account-enabled]");
  const kill = e.target.closest("[data-account-kill]");
  if (enter || (row && !e.target.closest("button"))) {
    const accountId = enter ? enter.dataset.accountEnter : row.dataset.accountRow;
    localStorage.setItem("conv.account", accountId);
    document.dispatchEvent(new CustomEvent("conv:open-account", { detail: { id: accountId } }));
    return;
  }
  const id = (edit || auto || enabled || kill)?.dataset[edit ? "accountEdit" : auto ? "accountAuto" : enabled ? "accountEnabled" : "accountKill"];
  const account = S.accounts.find(a => a.id === id);
  if (!account) return;
  try {
    if (edit) {
      openModal({
        title: "调整 " + account.name,
        body: '<div class="admin-field"><span>初始净值（USDC）</span><input id="ae-equity" type="number" value="' + (account.startingEquity ?? account.equity) + '"></div>' +
          '<div class="admin-field"><span>最小净边（¢）</span><input id="ae-edge" type="number" step="0.1" value="' + account.minEdge + '"></div>' +
          '<div class="admin-field"><span>纸面成交延迟（ms）</span><input id="ae-fill" type="number" step="100" value="' + account.paperFillMs + '"></div>' +
          '<p class="admin-p">已实现盈亏独立累计；初始净值不能低于该账户已部署资金的 98%。所有修改立即生效并写入审计。</p>',
        actions: [
          { label: "取消" },
          { label: "保存", kind: "primary", onClick: async () => {
              await api("PATCH", "/api/admin/accounts/" + id, {
                equity: Number($("#ae-equity").value),
                minEdge: Number($("#ae-edge").value),
                paperFillMs: Math.round(Number($("#ae-fill").value))
              });
              toast(account.name + " 参数已更新");
              await loadAll();
            } }
        ]
      });
    } else if (auto) {
      await api("PATCH", "/api/accounts/" + id, { auto: !account.auto });
      toast(account.name + (account.auto ? " 已暂停自动执行" : " 已恢复自动执行"));
      await loadAll();
    } else if (enabled) {
      await api("PATCH", "/api/admin/accounts/" + id, { enabled: !account.enabled });
      toast(account.name + (account.enabled ? " 已停用" : " 已启用"));
      await loadAll();
    } else if (kill) {
      const releasing = account.kill;
      openModal({
        title: releasing ? "解除 " + account.name + " 熔断？" : "熔断 " + account.name + "？",
        body: '<p class="admin-p">' + (releasing ? "解除后该账户恢复自动执行，不影响其他账户。" : "会撤销该账户未成交挂单并停止新开仓；不会平掉已有头寸，也不影响其他账户。") + "</p>",
        actions: [
          { label: "取消" },
          { label: releasing ? "确认解除" : "确认熔断", kind: releasing ? "primary" : "danger", onClick: async () => {
              await api("POST", "/api/admin/accounts/" + id + "/kill", { enabled: !releasing, reason: "管理员操作" });
              toast(account.name + (releasing ? " 已解除熔断" : " 已熔断"));
              await loadAll();
            } }
        ]
      });
    }
  } catch (err) {
    toast("操作失败：" + err.message, "bad");
  }
}

$("#refresh-accounts")?.addEventListener("click", () => loadAll(true));

$("#test-venues").addEventListener("click", async () => {
  try {
    const res = await api("POST", "/api/admin/venues/test");
    toast(res.venues.map(v => v.label + "：" + (v.latencyMs != null ? v.latencyMs + "ms" : v.message)).join(" · "));
    await loadAll();
  } catch (err) { toast("测试失败：" + err.message, "bad"); }
});

$("#venue-cards").addEventListener("click", () => {});

$("#refresh-catalog").addEventListener("click", async () => {
  try {
    const res = await api("POST", "/api/admin/catalog/refresh");
    toast("目录已更新：" + res.result.events + " 个事件（" + res.result.mode + "）");
    await loadAll();
  } catch (err) { toast("重建失败：" + err.message, "bad"); }
});

$("#settings-form").addEventListener("submit", e => e.preventDefault());

async function switchRiskAccount(id) {
  if (!id || id === S.riskAccount) return;
  S.riskAccount = id;
  try {
    const res = await api("GET", "/api/admin/settings?account=" + encodeURIComponent(id));
    S.settings.limits = res.limits;
    S.settings.rules = res.rules;
    for (const selector of ["#strategy-account", "#risk-account"]) {
      const el = $(selector);
      if (el) el.value = id;
    }
    renderStrategy();
    renderRisk();
    toast("已切换到 " + (S.accounts.find(a => a.id === id)?.name || id) + " 的风控配置");
  } catch (err) {
    toast("加载账户风控失败：" + err.message, "bad");
  }
}
$("#strategy-account")?.addEventListener("change", e => switchRiskAccount(e.target.value));
$("#risk-account")?.addEventListener("change", e => switchRiskAccount(e.target.value));

$("#settings-form").addEventListener("click", e => {
  const t = e.target.closest("[data-setting-toggle]");
  if (!t || t.disabled) return;
  t.setAttribute("aria-checked", t.getAttribute("aria-checked") === "true" ? "false" : "true");
});

$("#save-settings").addEventListener("click", async () => {
  const form = $("#settings-form");
  const val = name => Number(form.querySelector('[name="' + name + '"]')?.value);
  const toggle = name => form.querySelector('[data-setting-toggle="' + name + '"]')?.getAttribute("aria-checked") === "true";
  try {
    await api("PUT", "/api/admin/settings", {
      liveTradingEnabled: toggle("liveTradingEnabled"),
      scanIntervalMs: Math.round(val("scanIntervalMs")),
      cost: {
        hlFeeBps: val("hlFeeBps"),
        hedgeSlipBps: val("hedgeSlipBps"),
        resolutionBps: val("resolutionBps"),
        fundingBpsDay: val("fundingBpsDay"),
        fundingCapBps: val("fundingCapBps")
      }
    });
    toast("设置已保存并生效");
    await loadAll();
  } catch (err) { toast("保存失败：" + err.message, "bad"); }
});

$("#strategy-limits").addEventListener("click", e => {
  const b = e.target.closest("[data-limit]");
  if (b) editLimit(b.dataset.limit);
});
$("#risk-limits").addEventListener("click", e => {
  const b = e.target.closest("[data-limit]");
  if (b) editLimit(b.dataset.limit);
});

function editLimit(id) {
  const l = S.settings.limits.find(x => x.id === id);
  if (!l) return;
  openModal({
    title: "修改限额 · " + l.name,
    body: '<div class="admin-field"><span>上限（' + (l.kind === "pct" ? "%" : "USDC") + "）</span>" +
      '<input id="lim-val" type="number" value="' + l.value + '"></div>' +
      '<p class="admin-p">当前占用 ' + (l.kind === "pct" ? l.used.toFixed(1) + "%" : usd(l.used)) + "。新上限不得低于占用 + 2% 缓冲。</p>",
    actions: [
      { label: "取消" },
      { label: "保存", kind: "primary", onClick: async () => {
          await api("PUT", "/api/risk/limits/" + id, { accountId: S.riskAccount, value: Number($("#lim-val").value) });
          toast("限额已更新");
          await loadAll();
        } }
    ]
  });
}

$("#reset-limits-admin").addEventListener("click", async () => {
  try {
    await api("POST", "/api/risk/limits/reset", { accountId: S.riskAccount });
    toast("限额已恢复默认");
    await loadAll();
  } catch (err) { toast("恢复失败：" + err.message, "bad"); }
});

$("#rules-list").addEventListener("click", async e => {
  const b = e.target.closest("[data-rule]");
  if (!b) return;
  const on = b.getAttribute("aria-checked") !== "true";
  try {
    await api("PATCH", "/api/risk/rules/" + b.dataset.rule, { accountId: S.riskAccount, on });
    b.setAttribute("aria-checked", String(on));
    toast(on ? "规则已启用" : "规则已关闭", on ? "ok" : "warn");
    await loadAll();
  } catch (err) { toast("更新失败：" + err.message, "bad"); }
});

$("#rules-list").addEventListener("change", async e => {
  const input = e.target.closest("[data-rule-value]");
  if (!input) return;
  const value = Number(input.value);
  if (!Number.isFinite(value)) { toast("阈值必须是数字", "bad"); return; }
  try {
    await api("PATCH", "/api/risk/rules/" + input.dataset.ruleValue, { accountId: S.riskAccount, value });
    toast("阈值已更新", "ok");
    await loadAll();
  } catch (err) { toast("更新失败：" + err.message, "bad"); }
});

$("#event-search").addEventListener("input", e => {
  S.eventQuery = e.target.value;
  renderEvents();
});

$("#audit-actor").addEventListener("change", renderAudit);
$("#audit-account").addEventListener("change", e => { S.auditAccount = e.target.value; renderAudit(); });
$("#audit-search").addEventListener("input", renderAudit);

$("#export-audit").addEventListener("click", () => {
  const header = ["时间", "账户", "主体", "动作", "对象", "场所", "详情"];
  const accountName = id => S.accounts.find(a => a.id === id)?.name || id || "全局";
  const rows = S.audit.map(a => [a.t, accountName(a.accountId), a.actor, a.action, a.obj, a.venue, a.detail].map(v => '"' + String(v ?? "").replace(/"/g, '""') + '"').join(","));
  const blob = new Blob(["\ufeff" + [header.join(","), ...rows].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "convergence-audit-" + new Date().toISOString().slice(0, 10) + ".csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("审计日志已导出");
});

$("#export-json").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/admin/export", { credentials: "same-origin" });
    if (!res.ok) throw new Error("导出失败");
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "convergence-export-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("完整导出已下载");
  } catch (err) { toast(err.message, "bad"); }
});

$("#reset-data").addEventListener("click", () => {
  openModal({
    title: "重置交易账本？",
    body: '<p class="admin-p">将清空持仓、订单、待接管、审计与净值曲线，四个账户回到起始资金，并重新拉取实时目录。用户、限额与规则保留。</p>' +
      '<div class="admin-field"><span>输入 RESET 确认</span><input id="reset-confirm" placeholder="RESET"></div>',
    actions: [
      { label: "取消" },
      { label: "确认重置", kind: "danger", onClick: async () => {
          if ($("#reset-confirm").value !== "RESET") { toast("确认短语不正确", "warn"); return false; }
          await api("POST", "/api/admin/data/reset", { confirm: "RESET" });
          toast("纸面账本已重置");
          await loadAll();
        } }
    ]
  });
});

/* ---------------- clock + boot ---------------- */
function tickClock() {
  const el = $("#admin-clock");
  if (el) el.textContent = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Taipei", hour12: false });
}

async function boot() {
  tickClock();
  setInterval(tickClock, 1000);
  try {
    const me = await api("GET", "/api/auth/me");
    if (!me.user || me.user.role !== "admin") return;
    S.me = me.user;
    S.csrf = me.csrf || "";
    await loadAll();
    const m = (location.hash.match(/^#\/admin\/([a-z]+)/) || [])[1];
    setView(titles[m] ? m : "overview", false);
  } catch (err) {
    toast("管理数据加载失败：" + err.message, "bad");
  }
}

window.__adminShow = view => {
  if (!S.me) return;
  setView(titles[view] ? view : "overview", false);
};
window.__adminRefresh = () => { if (S.me) void loadAll(true); };
void boot();
