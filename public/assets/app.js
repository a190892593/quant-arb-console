/* ============================================================
   CONVERGENCE · 双策略确定性套利台
   NegRisk conversion + high-liquidity market making.
   ============================================================ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const S = {
  data: null,
  account: localStorage.getItem("conv.account") || "negrisk",
  route: null,
  timer: null,
  polling: false,
  modalOpen: false
};

/* ---------------- formatting ---------------- */
const usd = (n, dp = 0) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const signedUsd = (n, dp = 0) => (n >= 0 ? "+" : "−") + "$" + Math.abs(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const cents = n => (Number(n) * 100).toFixed(1) + "¢";
const pct = (n, dp = 1) => (Number(n) * 100).toFixed(dp) + "%";
const bps = n => (Math.round(Number(n)) >= 0 ? "+" : "−") + Math.abs(Math.round(Number(n))).toLocaleString("en-US");
const share = n => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dateShort = iso => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? (d.getMonth() + 1) + "-" + String(d.getDate()).padStart(2, "0") : "—";
};
const timeShort = ts => {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
};
const acctCode = id => {
  const i = (S.data?.accounts || []).findIndex(a => a.id === id);
  return i >= 0 ? "S" + (i + 1) : "S?";
};
const acct = id => (S.data?.accounts || []).find(a => a.id === (id || S.account)) || null;
const mm = () => S.data?.mm || { markets: [], fills: [], positions: [], totals: {}, params: {}, halted: false };
const neg = () => S.data?.negRisk || [];
const conversions = () => S.data?.conversions || [];

/* ---------------- api ---------------- */
async function api(path, { method = "GET", body } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && S.data?.csrf) headers["x-csrf-token"] = S.data.csrf;
  const res = await fetch(path, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  if (res.status === 401) { location.href = "/login"; throw new Error("登录已失效"); }
  if (!res.ok) throw new Error(json?.error?.message || text || ("HTTP " + res.status));
  return json;
}

async function loadState({ silent = false } = {}) {
  if (S.polling) return;
  S.polling = true;
  try {
    const res = await api("/api/state?account=" + encodeURIComponent(S.account));
    S.data = res.state;
    if (!S.data?.accounts?.some(a => a.id === S.account)) S.account = S.data.accounts[0]?.id || "negrisk";
    renderChrome();
    renderView();
  } catch (err) {
    if (!silent) toast("加载失败", err.message, "neg");
    if (/登录/.test(err.message)) location.href = "/login";
  } finally {
    S.polling = false;
  }
}

/* ---------------- toast / modal ---------------- */
function toast(title, msg, kind = "ok") {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = "<b>" + esc(title) + "</b>" + (msg ? "<span>" + esc(msg) + "</span>" : "");
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateY(6px)"; }, 4400);
  setTimeout(() => el.remove(), 4900);
}

function openModal({ eyebrow = "确认", title, body, actions = [], onOpen }) {
  S.modalOpen = true;
  $("#modal-eyebrow").textContent = eyebrow;
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = body;
  const foot = $("#modal-actions");
  foot.innerHTML = "";
  for (const a of actions) {
    const b = document.createElement("button");
    b.className = "btn " + (a.kind || "btn-ghost");
    b.textContent = a.label;
    b.addEventListener("click", async () => {
      if (a.keepOpen) { await a.onClick?.(); return; }
      closeModal();
      await a.onClick?.();
    });
    foot.appendChild(b);
  }
  $("#modal-root").hidden = false;
  onOpen?.();
}
function closeModal() {
  S.modalOpen = false;
  $("#modal-root").hidden = true;
}
$("#modal-x").addEventListener("click", closeModal);
$("#modal-root").addEventListener("click", e => { if (e.target === $("#modal-root")) closeModal(); });

/* ---------------- chrome ---------------- */
function renderChrome() {
  const d = S.data;
  if (!d) return;
  const a = acct() || d.accounts[0];
  if (!a) return;
  $("#rail-acct-label").textContent = acctCode(a.id) + " · " + a.name;
  $("#rail-equity").textContent = usd(a.equity, 2);
  $("#rail-sub").innerHTML = '<span class="dot ' + (a.kill ? "bad" : "ok") + '"></span>' + (a.kill ? "已熔断" : "纸面账本 · 独立核算");
  $("#acct-code").textContent = acctCode(a.id);
  $("#acct-name").textContent = a.name;
  $("#acct-equity").textContent = usd(a.equity, 0);

  $("#acct-menu").innerHTML = d.accounts.map(x =>
    '<button class="acct-opt' + (x.id === a.id ? " is-on" : "") + '" data-act="switch-account" data-id="' + x.id + '">' +
      '<span class="acct-code">' + acctCode(x.id) + "</span>" +
      '<span class="meta"><b>' + esc(x.name) + "</b><small>" + usd(x.equity, 0) + " · " + (x.kill ? "熔断" : x.auto ? "自动" : "手动") + "</small></span>" +
      '<span class="dot ' + (x.kill ? "bad" : "ok") + '"></span>' +
    "</button>").join("");

  const m = d.market || {};
  if (m.BTC) {
    $("#px-btc").textContent = Number(m.BTC.px).toLocaleString("en-US", { maximumFractionDigits: 0 });
    $("#chg-btc").textContent = (m.BTC.chg >= 0 ? "+" : "−") + Math.abs(m.BTC.chg).toFixed(2) + "%";
    $("#chg-btc").className = m.BTC.chg >= 0 ? "pos" : "neg";
  }
  if (m.ETH) {
    $("#px-eth").textContent = Number(m.ETH.px).toLocaleString("en-US", { maximumFractionDigits: 0 });
    $("#chg-eth").textContent = (m.ETH.chg >= 0 ? "+" : "−") + Math.abs(m.ETH.chg).toFixed(2) + "%";
    $("#chg-eth").className = m.ETH.chg >= 0 ? "pos" : "neg";
  }

  const pm = (d.venues || []).find(v => v.id === "polymarket");
  const hl = (d.venues || []).find(v => v.id === "hyperliquid");
  paintVenue($("#venue-pm"), pm);
  paintVenue($("#venue-hl"), hl);
  paintDot($("#rail-pm-dot"), $("#rail-pm"), pm);
  paintDot($("#rail-hl-dot"), $("#rail-hl"), hl);

  $("#sim-switch").setAttribute("aria-checked", String(d.settings.paperTradingEnabled !== false));
  $("#auto-switch").setAttribute("aria-checked", String(!!a.auto));
  $("#auto-switch").disabled = !!a.kill;
  const killBtn = $("#kill-btn");
  killBtn.textContent = a.kill ? "解除熔断" : "熔断";
  killBtn.classList.toggle("btn-danger-ghost", !a.kill);
  killBtn.classList.toggle("btn-primary", !!a.kill);

  const banner = $("#banner");
  if (a.kill || d.settings.paperTradingEnabled === false) {
    banner.hidden = false;
    $("#banner-title").textContent = a.kill ? acctCode(a.id) + " 已熔断" : "模拟交易已暂停";
    $("#banner-text").textContent = a.kill ? "新转换与新报价停止；已有做市库存保留。" : "只允许平仓，不再产生新成交。";
  } else {
    banner.hidden = true;
  }

  $("#nav-neg").textContent = neg().filter(o => o.status === "ready").length;
  $("#nav-neg").classList.toggle("is-hot", neg().some(o => o.status === "ready"));
  $("#nav-mm").textContent = mm().totals?.quoted ?? 0;

  const user = d.user || {};
  $("#user-name").textContent = user.name || "—";
  $("#user-email").textContent = user.email || "—";
  $("#user-avatar").textContent = (user.name || "U").slice(0, 1);
  $("#nav-admin").hidden = user.role !== "admin";
}
function paintVenue(btn, v) {
  if (!btn || !v) return;
  const ok = v.state === "ok";
  btn.querySelector(".dot").className = "dot " + (ok ? "ok" : v.state === "down" ? "bad" : v.state === "disabled" ? "" : "warn");
  btn.title = v.label + " · " + v.message;
}
function paintDot(dot, label, v) {
  if (!dot || !v) return;
  dot.className = "dot " + (v.state === "ok" ? "ok" : v.state === "down" ? "bad" : "warn");
  if (label) label.textContent = v.label + (v.mode === "demo" ? " · 示例" : v.state === "ok" ? " · 在线" : "");
}

/* ---------------- charts ---------------- */
function sparkline(points) {
  const vals = (points || []).map(p => p.v);
  if (vals.length < 2) return "";
  const w = 600, h = 56, min = Math.min(...vals), max = Math.max(...vals);
  const span = Math.max(0.0001, max - min);
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - 4 - ((v - min) / span) * (h - 10)]);
  const line = pts.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const area = "0," + h + " " + line + " " + w + "," + h;
  return '<svg viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" aria-hidden="true">' +
    '<polygon points="' + area + '" fill="rgba(94,224,232,.10)"/>' +
    '<polyline points="' + line + '" fill="none" stroke="#5ee0e8" stroke-width="1.6"/>' +
    "</svg>";
}

/* ---------------- router ---------------- */
const routes = ["overview", "accounts", "negrisk", "mm", "risk", "admin"];
const titles = { overview: "总览", accounts: "策略账户", negrisk: "NegRisk 转换", mm: "做市台", risk: "风控", admin: "管理" };

function routeFromHash() {
  const part = (location.hash || "#/overview").replace(/^#\//, "").split("/")[0];
  return routes.includes(part) ? part : "overview";
}
function go(route, push = true) {
  if (!routes.includes(route)) route = "overview";
  if (route === "admin" && S.data?.user?.role !== "admin") {
    toast("仅管理员", "当前账号没有管理权限。", "neg");
    route = "overview";
  }
  S.route = route;
  $$(".view").forEach(v => { v.hidden = v.dataset.view !== route; });
  $$(".nav-item").forEach(n => n.classList.toggle("is-active", n.dataset.route === route));
  document.title = "CONVERGENCE · " + (titles[route] || "");
  if (push) history.replaceState(null, "", "#/" + route);
  $("#viewport").scrollTop = 0;
  renderView();
}

/* ---------------- render dispatcher ---------------- */
function renderView() {
  if (!S.data) return;
  const view = $("#view-" + S.route);
  if (!view) return;
  const html = {
    overview: renderOverview,
    accounts: renderAccounts,
    negrisk: renderNegrisk,
    mm: renderMm,
    risk: renderRisk,
    admin: renderAdmin
  }[S.route]?.();
  if (html != null) view.innerHTML = html;
}

/* ============================================================
   Overview
   ============================================================ */
function pageHead(eyebrow, title, sub, actions) {
  return '<div class="page-head"><div class="page-head-main"><span class="eyebrow">' + esc(eyebrow) + "</span>" +
    "<h1>" + esc(title) + '</h1><p class="page-sub">' + esc(sub) + "</p></div>" +
    '<div class="page-actions">' + (actions || "") + "</div></div>";
}

function renderOverview() {
  const d = S.data;
  const p = d.portfolio || {};
  const n = acct("negrisk");
  const m = acct("marketmaking");
  const totals = mm().totals || {};
  const ready = neg().filter(o => o.status === "ready");
  const best = ready[0];
  const equityPts = d.equity || [];
  const top = ready.slice(0, 3);
  const quotes = (mm().markets || []).filter(x => x.quoteBid > 0 || x.quoteAsk > 0).slice(0, 5);
  const today = new Date();
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dayPnl = (d.accounts || []).reduce((s, a) => s + (a.totalPnl || 0), 0);
  void dayStart;

  return pageHead("OVERVIEW · 双策略确定性台", "总览",
    "只做两类可验证的价差：NegRisk 协议层转换，与高流动性市场双边报价。没有方向性赌注。",
    '<button class="btn btn-ghost" data-act="refresh-all">刷新</button><button class="btn btn-primary" data-act="nav" data-id="negrisk">查看篮子</button>') +
    '<div class="grid-hero">' +
      '<div class="card">' +
        '<span class="eyebrow">双账户合计净值 · USDC</span>' +
        '<div class="hero-value num">' + usd(p.equity || 0, 2) + "</div>" +
        '<div class="hero-delta"><span class="' + (dayPnl >= 0 ? "pos" : "neg") + '">合计盈亏 ' + signedUsd(dayPnl, 2) + "</span>" +
          "<span class=\"muted\">已实现 <b class=\"num\">" + signedUsd(p.realizedPnl || 0, 2) + "</b></span>" +
          "<span class=\"muted\">未实现 <b class=\"num\">" + signedUsd(p.pnl || 0, 2) + "</b></span></div>" +
        '<div class="hero-spark">' + sparkline(equityPts) + "</div>" +
      "</div>" +
      '<div class="card desk-card">' +
        '<div class="desk-top"><div class="desk-title"><span class="acct-code">S1</span><b>NegRisk 转换</b></div>' +
          '<span class="chip ' + (n?.kill ? "chip-neg" : "chip-ok") + '">' + (n?.kill ? "已熔断" : "运行中") + "</span></div>" +
        '<div class="desk-eq num">' + usd(n?.equity || 0, 2) + "</div>" +
        '<div class="desk-meta"><div>已锁定<b class="' + ((n?.realizedPnl || 0) >= 0 ? "pos" : "neg") + '">' + signedUsd(n?.realizedPnl || 0, 2) + "</b></div>" +
          "<div>可转换<b>" + ready.length + " 个</b></div><div>累计转换<b>" + conversions().length + " 笔</b></div></div>" +
        '<div class="desk-desc">' + (best ? "当前最佳：" + esc(best.title) + " · 每组成交即锁定 " + usd(best.profit, 3) : "当前没有 ΣYES买价 > 100¢ 的篮子，保持空仓。") + "</div>" +
        '<div class="actions-row"><button class="btn btn-sm btn-primary" data-act="nav" data-id="negrisk">打开转换台</button></div>' +
      "</div>" +
    "</div>" +
    '<div class="grid-hero">' +
      '<div class="card desk-card">' +
        '<div class="desk-top"><div class="desk-title"><span class="acct-code">S2</span><b>高流动性做市</b></div>' +
          '<span class="chip ' + (m?.kill ? "chip-neg" : "chip-ok") + '">' + (m?.kill ? "已熔断" : "运行中") + "</span></div>" +
        '<div class="desk-eq num">' + usd(m?.equity || 0, 2) + "</div>" +
        '<div class="desk-meta"><div>价差收入<b class="' + ((totals.realized || 0) >= 0 ? "pos" : "neg") + '">' + signedUsd(totals.realized || 0, 2) + "</b></div>" +
          "<div>库存盯市<b class=\"" + ((totals.unrealized || 0) >= 0 ? "pos" : "neg") + "\">" + signedUsd(totals.unrealized || 0, 2) + "</b></div>" +
          "<div>在场报价<b>" + (totals.quoted || 0) + " 个</b></div></div>" +
        '<div class="desk-desc">库存 ' + usd(totals.inventoryUsd || 0, 0) + " · 成交 " + (totals.fills || 0) + " 笔 · 报价名义 " + usd(totals.quoteNotional || 0, 0) + "。库存偏斜会自动压低加仓方向的报价。</div>" +
        '<div class="actions-row"><button class="btn btn-sm btn-primary" data-act="nav" data-id="mm">打开做市台</button></div>' +
      "</div>" +
      '<div class="card">' +
        '<div class="card-h"><div><span class="eyebrow">风险预算</span><h3>护栏占用</h3></div><a class="link" href="#/risk">调整</a></div>' +
        (d.limits || []).map(l => limitCompact(l)).join("") +
      "</div>" +
    "</div>" +
    '<div class="table-card"><div class="table-head"><div><span class="eyebrow">NEGRISK · READY</span><h2>可转换篮子</h2></div>' +
      '<button class="link" data-act="nav" data-id="negrisk">全部 ' + neg().length + " 个</button></div><div class=\"table-scroll\"><table><thead><tr>" +
      "<th>事件</th><th class=\"num-col\">结果</th><th class=\"num-col\">ΣYES 买价</th><th class=\"num-col\">篮子成本</th><th class=\"num-col\">转换卖出</th><th class=\"num-col\">每组净利</th><th class=\"num-col\">可转组数</th><th>状态</th></tr></thead><tbody>" +
      (top.length ? top.map(o => negRow(o)).join("") : '<tr><td colspan="8"><div class="empty"><b>暂无折价篮子</b>当 ΣYES买价 > 100¢ 时，NO 篮子才会出现协议层折价。</div></td></tr>') +
      "</tbody></table></div></div>" +
    '<div class="table-card"><div class="table-head"><div><span class="eyebrow">MARKET MAKING · LIVE QUOTES</span><h2>在场报价</h2></div>' +
      '<button class="link" data-act="nav" data-id="mm">做市台</button></div><div class="table-scroll"><table><thead><tr>' +
      "<th>市场</th><th class=\"num-col\">中价</th><th class=\"num-col\">盘口价差</th><th class=\"num-col\">买价</th><th class=\"num-col\">卖价</th><th class=\"num-col\">库存</th><th class=\"num-col\">库存盈亏</th><th>状态</th></tr></thead><tbody>" +
      (quotes.length ? quotes.map(x => mmRowCompact(x)).join("") : '<tr><td colspan="8"><div class="empty"><b>做市台尚未报价</b>自动执行开启后 6 秒内会生成双边报价。</div></td></tr>') +
      "</tbody></table></div></div>";
}

function limitCompact(l) {
  const ratio = l.value > 0 ? Math.min(1, l.used / l.value) : 0;
  const cls = ratio > .9 ? "neg" : ratio > .72 ? "warn" : "";
  const used = l.kind === "pct" ? (l.used || 0).toFixed(1) + "%" : usd(l.used || 0, 0);
  const val = l.kind === "pct" ? l.value + "%" : usd(l.value, 0);
  return '<div style="margin:10px 0"><div class="kv"><span>' + esc(l.name) + "</span><b>" + used + " / " + val + "</b></div>" +
    '<div class="bar"><i class="' + cls + '" style="width:' + (ratio * 100).toFixed(1) + '%"></i></div></div>';
}
function negRow(o) {
  return '<tr><td><b>' + esc(o.title) + "</b><small>" + o.n + " 个互斥结果 · 到期 " + dateShort(o.due) + "</small></td>" +
    '<td class="num-col">' + o.n + '</td><td class="num-col">' + (o.sumYesBid * 100).toFixed(2) + "¢</td>" +
    '<td class="num-col">' + usd(o.basketCost, 3) + '</td><td class="num-col">' + usd(o.conversionProceeds, 3) + "</td>" +
    '<td class="num-col ' + (o.profit > 0 ? "pos" : "neg") + '"><b>' + signedUsd(o.profit, 3) + "</b><small>" + bps(o.edgeBps) + " bps</small></td>" +
    '<td class="num-col">' + share(o.maxSets) + "</td>" +
    '<td><span class="chip ' + (o.status === "ready" ? "chip-ok" : "chip-mute") + '">' + (o.status === "ready" ? "可转换" : "观察") + "</span></td></tr>";
}
function mmRowCompact(x) {
  return "<tr><td><b>" + esc(x.title) + "</b><small>" + esc(x.category) + " · 24h " + usd(x.volume24h, 0) + "</small></td>" +
    '<td class="num-col">' + cents(x.mid) + '</td><td class="num-col">' + Math.round(x.spreadBps) + "bps</td>" +
    '<td class="num-col pos">' + (x.quoteBid ? cents(x.quoteBid) : "—") + '</td><td class="num-col neg">' + (x.quoteAsk ? cents(x.quoteAsk) : "—") + "</td>" +
    '<td class="num-col">' + share(x.inventory) + '</td><td class="num-col ' + (x.unrealized >= 0 ? "pos" : "neg") + '">' + signedUsd(x.unrealized, 2) + "</td>" +
    '<td><span class="chip ' + chipFor(x.status) + '">' + esc(x.statusText) + "</span></td></tr>";
}

/* ============================================================
   Accounts
   ============================================================ */
function renderAccounts() {
  const d = S.data;
  const p = d.portfolio || {};
  return pageHead("ACCOUNTS · 独立账本", "策略账户",
    "两个账户各自持有净值、持仓、限额、规则与熔断；切换账户只改变当前操作台，不共享任何资金。",
    '<button class="btn btn-ghost" data-act="refresh-all">刷新</button>') +
    '<div class="kpi-strip"><div class="kpi"><span class="eyebrow">合计净值</span><b>' + usd(p.equity, 2) + '</b><small>起始 ' + usd(p.startingEquity, 0) + "</small></div>" +
      '<div class="kpi"><span class="eyebrow">已实现</span><b class="' + ((p.realizedPnl || 0) >= 0 ? "pos" : "neg") + '">' + signedUsd(p.realizedPnl, 2) + "</b><small>两本账合计</small></div>" +
      '<div class="kpi"><span class="eyebrow">未实现</span><b class="' + ((p.pnl || 0) >= 0 ? "pos" : "neg") + '">' + signedUsd(p.pnl, 2) + "</b><small>做市库存盯市</small></div>" +
      '<div class="kpi"><span class="eyebrow">运行账户</span><b>' + (p.active || 0) + " / " + (p.accounts || 0) + "</b><small>未熔断且启用</small></div>" +
      '<div class="kpi"><span class="eyebrow">资金占用</span><b>' + pct(p.usedPct || 0) + "</b><small>库存 + 转换成本</small></div></div>" +
    '<div class="grid-two">' + d.accounts.map(accountCard).join("") + "</div>" +
    '<div class="table-card"><div class="table-head"><div><span class="eyebrow">MATRIX</span><h2>账户矩阵</h2></div></div><div class="table-scroll"><table><thead><tr>' +
      '<th>账户</th><th class="num-col">净值</th><th class="num-col">已实现</th><th class="num-col">未实现</th><th class="num-col">占用</th><th class="num-col">持仓/报价</th><th class="num-col">信号</th><th>状态</th></tr></thead><tbody>' +
      d.accounts.map(a => '<tr><td><b>' + acctCode(a.id) + " · " + esc(a.name) + "</b><small>" + esc(a.short) + "</small></td>" +
        '<td class="num-col">' + usd(a.equity, 2) + '</td><td class="num-col ' + (a.realizedPnl >= 0 ? "pos" : "neg") + '">' + signedUsd(a.realizedPnl, 2) + "</td>" +
        '<td class="num-col ' + (a.pnl >= 0 ? "pos" : "neg") + '">' + signedUsd(a.pnl, 2) + '</td><td class="num-col">' + pct(a.usedPct || 0) + "</td>" +
        '<td class="num-col">' + (a.positions || 0) + '</td><td class="num-col">' + (a.ready || 0) + " / " + (a.signals || 0) + "</td>" +
        '<td><span class="chip ' + (a.kill ? "chip-neg" : !a.enabled ? "chip-mute" : a.auto ? "chip-ok" : "chip-warn") + '">' + (a.kill ? "熔断" : !a.enabled ? "停用" : a.auto ? "自动" : "手动") + "</span></td></tr>").join("") +
      "</tbody></table></div></div>";
}
function accountCard(a) {
  const isOn = a.id === S.account;
  const used = Math.min(1, a.usedPct || 0);
  return '<div class="card desk-card" style="' + (isOn ? "border-color:rgba(94,224,232,.55);box-shadow:0 0 0 1px rgba(94,224,232,.25) inset" : "") + '">' +
    '<div class="desk-top"><div class="desk-title"><span class="acct-code">' + acctCode(a.id) + "</span><b>" + esc(a.name) + "</b></div>" +
      '<span class="chip ' + (a.kill ? "chip-neg" : "chip-ok") + '">' + (a.kill ? "已熔断" : "运行中") + "</span></div>" +
    '<div class="desk-eq num">' + usd(a.equity, 2) + "</div>" +
    '<div class="desk-meta"><div>已实现<b class="' + (a.realizedPnl >= 0 ? "pos" : "neg") + '">' + signedUsd(a.realizedPnl, 2) + "</b></div>" +
      "<div>未实现<b class=\"" + (a.pnl >= 0 ? "pos" : "neg") + "\">" + signedUsd(a.pnl, 2) + "</b></div>" +
      "<div>占用<b>" + pct(a.usedPct || 0) + "</b></div></div>" +
    '<div class="bar"><i class="' + (used > .9 ? "neg" : used > .72 ? "warn" : "") + '" style="width:' + (used * 100).toFixed(1) + '%"></i></div>' +
    '<div class="desk-desc">' + esc(a.logic) + "</div>" +
    '<div class="actions-row"><button class="btn btn-sm ' + (isOn ? "btn-ghost" : "btn-primary") + '" data-act="switch-account" data-id="' + a.id + '">' + (isOn ? "当前账户" : "进入账户") + "</button>" +
      '<button class="btn btn-sm btn-ghost" data-act="toggle-auto" data-id="' + a.id + '">' + (a.auto ? "暂停自动" : "恢复自动") + "</button>" +
      '<button class="btn btn-sm btn-danger-ghost" data-act="kill-acct" data-id="' + a.id + '">' + (a.kill ? "解除熔断" : "熔断") + "</button></div>" +
    "</div>";
}

/* ============================================================
   NegRisk
   ============================================================ */
function renderNegrisk() {
  const rows = neg();
  const ready = rows.filter(o => o.status === "ready");
  const best = ready[0];
  const totalLocked = conversions().reduce((s, c) => s + c.profit, 0);
  return pageHead("NEGRISK · PROTOCOL ARBITRAGE", "NegRisk 转换",
    "买入每个结果的 1 份 NO，经 Adapter 转换为其他结果的 YES，再按买价卖出。成交瞬间锁定 n × (ΣYES买价 − 1)，账本不留方向敞口。",
    '<button class="btn btn-ghost" data-act="refresh-negrisk">刷新扫描</button><button class="btn btn-ghost" data-act="export-negrisk">导出 CSV</button>') +
    '<div class="kpi-strip">' +
      '<div class="kpi"><span class="eyebrow">扫描事件</span><b>' + rows.length + '</b><small>活跃 NegRisk 事件</small></div>' +
      '<div class="kpi"><span class="eyebrow">可转换</span><b class="pos">' + ready.length + '</b><small>ΣYES买价 &gt; 100¢</small></div>' +
      '<div class="kpi"><span class="eyebrow">最佳每组净利</span><b class="pos">' + (best ? usd(best.profit, 3) : "—") + "</b><small>" + (best ? bps(best.edgeBps) + " bps · " + best.n + " 个结果" : "无折价") + "</small></div>" +
      '<div class="kpi"><span class="eyebrow">累计锁定</span><b class="' + (totalLocked >= 0 ? "pos" : "neg") + '">' + signedUsd(totalLocked, 2) + "</b><small>" + conversions().length + " 笔成交</small></div>" +
      '<div class="kpi"><span class="eyebrow">账户净值</span><b>' + usd(acct("negrisk")?.equity || 0, 2) + '</b><small>起始 $10,000</small></div></div>' +
    '<div class="table-card"><div class="table-head"><div><span class="eyebrow">BASKETS</span><h2>转换篮子</h2></div><span class="chip chip-mute">' + rows.length + " 个事件</span></div>" +
      '<div class="table-scroll"><table><thead><tr><th>事件</th><th class="num-col">结果</th><th class="num-col">ΣYES 买价</th><th class="num-col">NO 篮子成本</th><th class="num-col">转换卖出</th><th class="num-col">每组净利</th><th class="num-col">可转组数</th><th class="num-col">到期</th><th>状态</th><th></th></tr></thead><tbody>' +
      (rows.length ? rows.map(o => '<tr><td><b>' + esc(o.title) + "</b><small>" + esc(o.reason) + "</small></td>" +
        '<td class="num-col">' + o.n + '</td><td class="num-col">' + (o.sumYesBid * 100).toFixed(2) + "¢</td>" +
        '<td class="num-col">' + usd(o.basketCost, 3) + '</td><td class="num-col">' + usd(o.conversionProceeds, 3) + "</td>" +
        '<td class="num-col ' + (o.profit > 0 ? "pos" : "neg") + '"><b>' + signedUsd(o.profit, 3) + "</b><small>" + bps(o.edgeBps) + " bps</small></td>" +
        '<td class="num-col">' + share(o.maxSets) + "</td><td class=\"num-col\">" + dateShort(o.due) + "</td>" +
        '<td><span class="chip ' + (o.status === "ready" ? "chip-ok" : "chip-mute") + '">' + (o.status === "ready" ? "可转换" : "观察") + "</span></td>" +
        '<td><button class="btn btn-sm ' + (o.status === "ready" ? "btn-primary" : "btn-ghost") + '" data-act="convert" data-id="' + esc(o.id) + '" ' + (o.status === "ready" ? "" : "disabled") + ">转换</button></td></tr>").join("")
        : '<tr><td colspan="10"><div class="empty"><b>暂无 NegRisk 事件</b>点击「刷新扫描」重新拉取 Polymarket Gamma。</div></td></tr>') +
      "</tbody></table></div></div>" +
    ledgerCard();
}
function ledgerCard() {
  const rows = conversions();
  return '<div class="table-card"><div class="table-head"><div><span class="eyebrow">LEDGER</span><h2>转换台账</h2></div><span class="chip chip-mute">' + rows.length + " 笔</span></div>" +
    '<div class="table-scroll"><table><thead><tr><th>时间</th><th>事件</th><th class="num-col">组数</th><th class="num-col">篮子成本</th><th class="num-col">转换卖出</th><th class="num-col">净锁定</th><th>状态</th></tr></thead><tbody>' +
    (rows.length ? rows.map(c => '<tr><td class="num">' + timeShort(c.createdAt) + " · " + dateShort(c.createdAt) + "</td><td><b>" + esc(c.title) + "</b><small>" + c.n + " 个结果 · " + esc(c.id) + "</small></td>" +
      '<td class="num-col">' + share(c.sets) + '</td><td class="num-col">' + usd(c.cost, 2) + '</td><td class="num-col">' + usd(c.proceeds, 2) + "</td>" +
      '<td class="num-col pos"><b>' + signedUsd(c.profit, 2) + "</b><small>费用 " + usd(c.fee, 2) + "</small></td>" +
      '<td><span class="chip chip-ok">已锁定</span></td></tr>').join("")
      : '<tr><td colspan="7"><div class="empty"><b>还没有转换成交</b>选择上方可转换篮子，输入组数后会立即锁定利润。</div></td></tr>') +
    "</tbody></table></div></div>";
}

function openConvert(id) {
  const o = neg().find(x => x.id === id);
  if (!o) return;
  const maxSets = Math.min(500, o.maxSets);
  const defSets = Math.max(1, Math.min(100, maxSets));
  const rows = o.outcomes.map(x => '<tr><td>' + esc(x.name) + "</td><td class=\"num-col\">" + cents(x.noAsk) + "</td><td class=\"num-col\">" + cents(x.yesBid) + "</td><td class=\"num-col\">" + (o.n - 1) + " YES</td></tr>").join("");
  openModal({
    eyebrow: "NEGRISK · 转换",
    title: o.title,
    body: '<div class="table-scroll" style="margin-bottom:12px"><table><thead><tr><th>结果</th><th class="num-col">NO 买价</th><th class="num-col">YES 卖价</th><th class="num-col">每组获得</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
      '<div class="form-grid"><div class="field"><label>转换组数（1 组 = 每个结果 1 份 NO）</label><input id="cv-sets" type="number" min="1" max="' + maxSets + '" step="1" value="' + defSets + '"></div>' +
      '<div class="field"><label>可转上限</label><input value="' + share(maxSets) + ' 组" disabled></div></div>' +
      '<div class="kv"><span>篮子成本</span><b id="cv-cost">—</b></div>' +
      '<div class="kv"><span>转换卖出收入</span><b id="cv-proceeds">—</b></div>' +
      '<div class="kv"><span>费用 / Gas 缓冲</span><b id="cv-fee">—</b></div>' +
      '<div class="kv total"><span>锁定净利</span><b id="cv-profit">—</b></div>' +
      '<p class="note" style="margin-top:10px">纸上转换按当前盘口立即锁定，不发送链上交易。实盘执行需要 Polygon 钱包、USDC 授权与 NegRiskAdapter。</p>',
    actions: [
      { label: "取消", kind: "btn-ghost" },
      { label: "确认转换", kind: "btn-primary", onClick: () => submitConversion(o, maxSets) }
    ],
    onOpen: () => {
      const input = $("#cv-sets");
      const recalc = () => {
        const sets = Math.max(1, Math.min(maxSets, Math.floor(Number(input.value) || 1)));
        const cost = o.basketCost * sets;
        const proceeds = o.conversionProceeds * sets;
        const fee = (cost + proceeds) * o.feeBps / 10000 + 0.02;
        $("#cv-cost").textContent = usd(cost, 3);
        $("#cv-proceeds").textContent = usd(proceeds, 3);
        $("#cv-fee").textContent = usd(fee, 3);
        $("#cv-profit").textContent = signedUsd(proceeds - cost - fee, 3);
      };
      input.addEventListener("input", recalc);
      recalc();
    }
  });
}

async function submitConversion(o, maxSets) {
  const el = $("#cv-sets");
  if (!el) return;
  const sets = Math.max(1, Math.min(maxSets, Math.floor(Number(el.value) || 0)));
  try {
    const res = await api("/api/negrisk/convert", { method: "POST", body: { accountId: "negrisk", opportunityId: o.id, sets } });
    toast("转换已锁定", res.conversion.sets + " 组 · 净利 " + signedUsd(res.conversion.profit, 2), "ok");
    await loadState({ silent: true });
  } catch (err) {
    toast("转换被拒绝", err.message, "neg");
  }
}

/* ============================================================
   Market making
   ============================================================ */
function renderMm() {
  const d = S.data;
  const m = mm();
  const t = m.totals || {};
  const markets = m.markets || [];
  const account = acct("marketmaking");
  const halt = m.halted || account?.kill || d.settings.paperTradingEnabled === false;
  return pageHead("MARKET MAKING · INVENTORY GAME", "做市台",
    "在高流动性二元市场双边报价：目标价差覆盖费用，库存偏斜压低加仓方向，库存触及减仓线时只报减仓方向。",
    '<button class="btn btn-ghost" data-act="refresh-mm">刷新报价</button><button class="btn btn-ghost" data-act="mm-params">调整参数</button><button class="btn btn-danger-ghost" data-act="flatten-all">全部平仓</button>') +
    (halt ? '<div class="warn-box" style="margin-bottom:14px">' + (account?.kill ? "账户已熔断" : d.settings.paperTradingEnabled === false ? "模拟交易已暂停" : "做市台已停止") + "：不再生成新报价；已有库存可在下方逐市场平仓。</div>" : "") +
    '<div class="kpi-strip">' +
      '<div class="kpi"><span class="eyebrow">在场报价</span><b>' + (t.quoted || 0) + '</b><small>' + (m.params?.maxMarkets || 0) + " 个市场配额</small></div>" +
      '<div class="kpi"><span class="eyebrow">库存市值</span><b>' + usd(t.inventoryUsd || 0, 2) + '</b><small>净额 ' + signedUsd(t.grossInventoryUsd || 0, 2) + "</small></div>" +
      '<div class="kpi"><span class="eyebrow">价差收入</span><b class="' + ((t.realized || 0) >= 0 ? "pos" : "neg") + '">' + signedUsd(t.realized || 0, 2) + '</b><small>已实现 · 含减仓</small></div>' +
      '<div class="kpi"><span class="eyebrow">库存盯市</span><b class="' + ((t.unrealized || 0) >= 0 ? "pos" : "neg") + '">' + signedUsd(t.unrealized || 0, 2) + '</b><small>未实现</small></div>' +
      '<div class="kpi"><span class="eyebrow">成交</span><b>' + (t.fills || 0) + '</b><small>报价名义 ' + usd(t.quoteNotional || 0, 0) + "</small></div></div>" +
    '<div class="table-card"><div class="table-head"><div><span class="eyebrow">QUOTES</span><h2>报价与库存</h2></div><span class="chip chip-mute">目标价差 ' + (m.params?.targetEdgeBps || 0) + "bps · 单边 " + usd(m.params?.quoteNotional || 0, 0) + "</span></div>" +
      '<div class="table-scroll"><table><thead><tr><th>市场</th><th class="num-col">盘口</th><th class="num-col">价差</th><th class="num-col">我们的买价</th><th class="num-col">我们的卖价</th><th class="num-col">规模</th><th class="num-col">库存</th><th class="num-col">库存盈亏</th><th>状态</th><th></th></tr></thead><tbody>' +
      (markets.length ? markets.map(mmRow).join("") : '<tr><td colspan="10"><div class="empty"><b>做市池为空</b>点击刷新报价，或检查 Polymarket 连接。</div></td></tr>') +
      "</tbody></table></div></div>" +
    '<div class="table-card"><div class="table-head"><div><span class="eyebrow">FILLS</span><h2>做市成交</h2></div><span class="chip chip-mute">' + (m.fills || []).length + " 笔</span></div>" +
      '<div class="table-scroll"><table><thead><tr><th>时间</th><th>市场</th><th>方向</th><th class="num-col">价格</th><th class="num-col">数量</th><th class="num-col">名义</th><th class="num-col">实现盈亏</th><th class="num-col">成交后库存</th><th>类型</th></tr></thead><tbody>' +
      ((m.fills || []).length ? m.fills.map(f => '<tr><td class="num">' + timeShort(f.createdAt) + ' · ' + dateShort(f.createdAt) + "</td><td><b>" + esc(f.title) + "</b></td>" +
        '<td class="' + (f.side === "buy" ? "pos" : "neg") + '">' + (f.side === "buy" ? "买入" : "卖出") + '</td><td class="num-col">' + cents(f.price) + '</td><td class="num-col">' + share(f.size) + "</td>" +
        '<td class="num-col">' + usd(f.notional, 2) + '</td><td class="num-col ' + (f.realized >= 0 ? "pos" : "neg") + '">' + signedUsd(f.realized, 3) + '</td><td class="num-col">' + share(f.inventoryAfter) + "</td>" +
        '<td><span class="chip ' + (f.kind === "flatten" ? "chip-warn" : "chip-ok") + '">' + (f.kind === "flatten" ? "减仓" : "被动成交") + "</span></td></tr>").join("")
        : '<tr><td colspan="9"><div class="empty"><b>还没有成交</b>报价挂在盘口内，真实 taker 打印穿过报价时才会成交。</div></td></tr>') +
      "</tbody></table></div></div>" +
    '<p class="note">成交回放使用 Polymarket 公共 taker tape：主动卖单打印在买价或以下才填补我们的买价，主动买单打印在卖价或以上才填补我们的卖价。演示模式使用合成打印，仅用于验收。</p>';
}
function mmRow(x) {
  const canPause = x.paused;
  return "<tr><td><b>" + esc(x.title) + "</b><small>" + esc(x.category) + " · 24h " + usd(x.volume24h, 0) + " · 流动性 " + usd(x.liquidity, 0) + "</small></td>" +
    '<td class="num-col">' + cents(x.bestBid) + " / " + cents(x.bestAsk) + "<small>中价 " + cents(x.mid) + "</small></td>" +
    '<td class="num-col">' + Math.round(x.spreadBps) + "bps</td>" +
    '<td class="num-col pos">' + (x.quoteBid ? cents(x.quoteBid) : "—") + '</td><td class="num-col neg">' + (x.quoteAsk ? cents(x.quoteAsk) : "—") + "</td>" +
    '<td class="num-col">' + share(x.quoteSize) + '</td><td class="num-col">' + share(x.inventory) + '<small>均价 ' + (x.avg ? cents(x.avg) : "—") + "</small></td>" +
    '<td class="num-col ' + (x.unrealized >= 0 ? "pos" : "neg") + '">' + signedUsd(x.unrealized, 2) + "<small>已实现 " + signedUsd(x.realized, 2) + "</small></td>" +
    '<td><span class="chip ' + chipFor(x.status) + '">' + esc(x.statusText) + "</span>" + (x.skewBps ? '<small>偏斜 ' + bps(x.skewBps) + "bps</small>" : "") + "</td>" +
    '<td><div class="actions-row"><button class="btn btn-sm btn-ghost" data-act="mm-pause" data-id="' + esc(x.id) + '" data-paused="' + (!canPause) + '">' + (canPause ? "恢复" : "暂停") + "</button>" +
      (x.inventory ? '<button class="btn btn-sm btn-danger-ghost" data-act="mm-flatten" data-id="' + esc(x.id) + '">平仓</button>' : "") + "</div></td></tr>";
}
function chipFor(status) {
  return status === "quoting" ? "chip-ok" : status === "inventory" ? "chip-warn" : status === "paused" || status === "halted" ? "chip-neg" : "chip-mute";
}

function openMmParams() {
  const p = mm().params || {};
  const fields = [
    ["target-edge", "目标半价差（bps）", p.targetEdgeBps],
    ["min-spread", "最低盘口价差（bps）", p.minSpreadBps],
    ["quote-size", "单边报价名义（USDC）", p.quoteNotional],
    ["max-inventory", "单市场库存上限（USDC）", p.maxInventoryUsd],
    ["max-markets", "同时报价市场数", p.maxMarkets],
    ["skew", "库存偏斜强度（%）", Math.round((p.skewStrength || 0) * 100)],
    ["flatten-pct", "减仓线（库存上限 %）", p.flattenPct]
  ];
  openModal({
    eyebrow: "MARKET MAKING · 参数",
    title: "做市参数",
    body: '<div class="form-grid">' + fields.map(([id, label, value]) =>
      '<div class="field"><label>' + label + '</label><input class="mm-param" data-rule="' + id + '" type="number" step="1" value="' + esc(value) + '"></div>').join("") + "</div>" +
      '<p class="note">参数写入该账户的规则表；保存后下一次报价周期生效。</p>',
    actions: [
      { label: "取消", kind: "btn-ghost" },
      { label: "保存", kind: "btn-primary", onClick: saveMmParams }
    ]
  });
}
async function saveMmParams() {
  const inputs = $$(".mm-param");
  try {
    for (const el of inputs) {
      const value = Number(el.value);
      if (!Number.isFinite(value)) continue;
      await api("/api/risk/rules/" + el.dataset.rule, { method: "PATCH", body: { accountId: "marketmaking", value } });
    }
    toast("参数已保存", "下一次报价周期生效。");
    await loadState({ silent: true });
  } catch (err) {
    toast("保存失败", err.message, "neg");
  }
}

/* ============================================================
   Risk
   ============================================================ */
function renderRisk() {
  const a = acct();
  const d = S.data;
  const limits = d.limits || [];
  const rules = d.rules || [];
  return pageHead("RISK · " + acctCode(a.id) + " " + a.name, "风控",
    "限额与规则只作用于当前账户；熔断停止新转换与新报价，不触碰已有做市库存。",
    '<button class="btn btn-ghost" data-act="reset-limits">恢复默认限额</button><button class="btn ' + (a.kill ? "btn-primary" : "btn-danger-ghost") + '" data-act="kill">' + (a.kill ? "解除熔断" : "触发熔断") + "</button>") +
    '<div class="risk-grid">' +
      riskCell("账户净值", usd(a.equity, 2), "起始 " + usd(a.startingEquity, 0)) +
      riskCell("已实现盈亏", signedUsd(a.realizedPnl, 2), "两腿 / 转换已落账") +
      riskCell("未实现盈亏", signedUsd(a.pnl, 2), "做市库存按中价盯市") +
      riskCell("总占用", pct(a.usedPct || 0), "库存 + 转换成本") +
      riskCell("当日回撤", pct((a.dailyLossPct || 0) / 100, 2), "触发日亏损降档") +
      riskCell("熔断状态", a.kill ? "已熔断" : "正常", a.killReason || "无") +
    "</div>" +
    '<div class="card" style="margin-bottom:14px"><div class="card-h"><div><span class="eyebrow">LIMITS</span><h3>限额</h3></div><span class="chip chip-mute">' + limits.length + " 项</span></div>" +
      limits.map(l => limitRow(l)).join("") + "</div>" +
    '<div class="card" style="margin-bottom:14px"><div class="card-h"><div><span class="eyebrow">RULES</span><h3>规则与阈值</h3></div><span class="chip chip-mute">' + rules.length + " 条</span></div>" +
      rules.map(r => ruleRow(r)).join("") + "</div>" +
    '<div class="grid-two"><div class="card"><div class="card-h"><div><span class="eyebrow">EVENTS</span><h3>风险事件</h3></div></div>' +
      ((d.riskEvents || []).length ? d.riskEvents.map(e => '<div class="kv"><span><b class="' + (e.level === "bad" ? "neg" : e.level === "warn" ? "warn" : "pos") + '">' + esc(e.title) + "</b><small>" + esc(e.detail) + "</small></span><b>" + esc(e.t) + "</b></div>").join("") : '<p class="note">没有风险事件。</p>') +
      '</div><div class="card"><div class="card-h"><div><span class="eyebrow">AUDIT</span><h3>最近审计</h3></div></div>' +
      ((d.audit || []).slice(0, 10).map(x => '<div class="kv"><span>' + esc(x.action) + " · " + esc(x.obj) + "<small>" + esc(x.detail) + "</small></span><b>" + esc(x.t) + "</b></div>").join("") || '<p class="note">没有审计记录。</p>') +
      "</div></div>";
}
function riskCell(label, value, sub) {
  return '<div class="risk-cell"><span class="eyebrow">' + esc(label) + '</span><b class="num">' + esc(value) + "</b><small>" + esc(sub) + "</small></div>";
}
function limitRow(l) {
  const ratio = l.value > 0 ? Math.min(1, (l.used || 0) / l.value) : 0;
  const used = l.kind === "pct" ? (l.used || 0).toFixed(1) + "%" : usd(l.used || 0, 0);
  const val = l.kind === "pct" ? l.value + "%" : usd(l.value, 0);
  return '<div class="limit-row"><div><b>' + esc(l.name) + "</b><small>" + esc(l.desc) + '</small><div class="bar"><i class="' + (ratio > .9 ? "neg" : ratio > .72 ? "warn" : "") + '" style="width:' + (ratio * 100).toFixed(1) + '%"></i></div></div>' +
    '<span class="num">' + used + " / " + val + "</span>" +
    '<span class="muted">' + (l.kind === "pct" ? "比例占用" : "资金占用") + "</span>" +
    '<button class="btn btn-sm btn-ghost" data-act="edit-limit" data-id="' + esc(l.id) + '">调整</button></div>';
}
function ruleRow(r) {
  return '<div class="rule-row"><div><b>' + esc(r.name) + "</b><small>" + esc(r.desc) + "</small></div>" +
    '<span class="chip ' + (r.category === "库存管理" ? "chip-warn" : "chip-mute") + '">' + esc(r.category || "规则") + "</span>" +
    '<input class="rule-value" type="number" min="' + (r.min ?? 0) + '" max="' + (r.max ?? 999999) + '" step="' + (r.step ?? 1) + '" value="' + esc(r.value ?? "") + '" data-rule="' + esc(r.id) + '">' +
    '<button class="switch" data-act="rule-toggle" data-id="' + esc(r.id) + '" data-on="' + (!r.on) + '" aria-checked="' + !!r.on + '"><i></i></button>' +
    "</div>";
}

/* ============================================================
   Admin
   ============================================================ */
function renderAdmin() {
  const d = S.data;
  if (d.user?.role !== "admin") return pageHead("ADMIN", "管理", "仅管理员可见。", "") + '<div class="card"><p class="note">当前账号没有管理权限。</p></div>';
  return pageHead("ADMIN · WORKSPACE", "管理", "账户、场所、审计与纸面数据重置。",
    '<button class="btn btn-ghost" data-act="refresh-all">刷新</button><button class="btn btn-danger-ghost" data-act="admin-reset">重置纸面数据</button>') +
    '<div class="kpi-strip"><div class="kpi"><span class="eyebrow">版本</span><b>' + esc(d.version) + "</b><small>双策略引擎</small></div>" +
      '<div class="kpi"><span class="eyebrow">NegRisk 事件</span><b>' + neg().length + "</b><small>做市池 " + (d.engine?.universe || 0) + "</small></div>" +
      '<div class="kpi"><span class="eyebrow">运行时长</span><b>' + Math.round((Date.now() - (d.engine?.startedAt || Date.now())) / 60000) + " 分</b><small>扫描 " + (d.engine?.scanSeq || 0) + " 次</small></div>" +
      '<div class="kpi"><span class="eyebrow">交易模式</span><b>' + (d.engine?.tradingMode === "live" ? "实盘" : "纸面") + "</b><small>" + esc(d.engine?.marketDataMode || "") + "</small></div>" +
      '<div class="kpi"><span class="eyebrow">用户</span><b>' + (d.user?.name ? "3" : "—") + "</b><small>管理员 / 交易员 / 只读</small></div></div>" +
    '<div class="grid-two"><div class="card"><div class="card-h"><div><span class="eyebrow">VENUES</span><h3>场所连接</h3></div></div>' +
      (d.venues || []).map(v => '<div class="kv"><span><b>' + esc(v.label) + "</b><small>" + esc(v.message) + "</small></span><b>" + (v.latencyMs != null ? v.latencyMs + "ms" : v.state) + "</b></div>").join("") +
      '</div><div class="card"><div class="card-h"><div><span class="eyebrow">AUDIT</span><h3>全局审计</h3></div></div>' +
      ((d.audit || []).slice(0, 8).map(x => '<div class="kv"><span>' + esc(x.actor) + " · " + esc(x.action) + "<small>" + esc(x.obj) + "</small></span><b>" + esc(x.t) + "</b></div>").join("") || '<p class="note">暂无审计。</p>') +
      "</div></div>" +
    '<div class="table-card"><div class="table-head"><div><span class="eyebrow">ACCOUNTS</span><h2>账户参数</h2></div></div><div class="table-scroll"><table><thead><tr><th>账户</th><th class="num-col">净值</th><th class="num-col">已实现</th><th class="num-col">未实现</th><th class="num-col">占用</th><th>自动</th><th>状态</th></tr></thead><tbody>' +
      d.accounts.map(a => "<tr><td><b>" + acctCode(a.id) + " · " + esc(a.name) + "</b><small>" + esc(a.short) + "</small></td>" +
        '<td class="num-col">' + usd(a.equity, 2) + '</td><td class="num-col">' + signedUsd(a.realizedPnl, 2) + '</td><td class="num-col">' + signedUsd(a.pnl, 2) + "</td>" +
        '<td class="num-col">' + pct(a.usedPct || 0) + "</td><td>" + (a.auto ? "是" : "否") + "</td><td>" + (a.kill ? "熔断" : "正常") + "</td></tr>").join("") +
      "</tbody></table></div></div>";
}

/* ============================================================
   Actions
   ============================================================ */
async function switchAccount(id) {
  if (id === S.account) { go("overview"); return; }
  S.account = id;
  localStorage.setItem("conv.account", id);
  $("#acct-menu").hidden = true;
  await loadState();
  toast("已切换账户", acctCode(id) + " " + acct(id)?.name + " · 独立账本");
}

async function toggleAuto(id) {
  const a = acct(id);
  try {
    await api("/api/risk/auto", { method: "POST", body: { accountId: id, enabled: !a.auto } });
    toast(a.auto ? "已暂停自动执行" : "已恢复自动执行", acctCode(id) + " " + a.name, a.auto ? "warn" : "ok");
    await loadState({ silent: true });
  } catch (err) { toast("操作失败", err.message, "neg"); }
}

function killConfirm(id) {
  const a = acct(id);
  const releasing = a.kill;
  openModal({
    eyebrow: "RISK · " + acctCode(id),
    title: releasing ? "解除该账户熔断？" : "熔断该账户？",
    body: '<p class="note">' + esc(a.name) + " · 净值 " + usd(a.equity, 2) + " · 只影响该账户。</p>" +
      (releasing ? "" : '<div class="warn-box" style="margin-top:10px">熔断会停止新转换与新报价；已有做市库存保留，需要手动平仓。</div>'),
    actions: [
      { label: "取消", kind: "btn-ghost" },
      { label: releasing ? "确认解除" : "确认熔断", kind: releasing ? "btn-primary" : "btn-danger", onClick: async () => {
        try {
          await api("/api/risk/kill", { method: "POST", body: { accountId: id, enabled: !releasing, reason: releasing ? "人工解除" : "人工熔断" } });
          toast(releasing ? "已解除熔断" : "已熔断", acctCode(id) + " " + a.name, releasing ? "ok" : "warn");
          await loadState({ silent: true });
        } catch (err) { toast("操作失败", err.message, "neg"); }
      } }
    ]
  });
}

function openEditLimit(id) {
  const l = (S.data.limits || []).find(x => x.id === id);
  if (!l) return;
  openModal({
    eyebrow: "RISK · 限额",
    title: "调整 " + l.name,
    body: '<div class="field"><label>新上限（' + (l.kind === "pct" ? "%" : "USDC") + "）</label><input id=\"limit-value\" type=\"number\" value=\"" + esc(l.value) + "\"></div>" +
      '<p class="note">当前占用 ' + (l.kind === "pct" ? (l.used || 0).toFixed(1) + "%" : usd(l.used || 0, 0)) + "；新上限必须高于当前占用并留出 2% 缓冲。</p>",
    actions: [
      { label: "取消", kind: "btn-ghost" },
      { label: "保存", kind: "btn-primary", onClick: async () => {
        try {
          await api("/api/risk/limits/" + l.id, { method: "PUT", body: { accountId: S.account, value: Number($("#limit-value").value) } });
          toast("限额已更新", l.name);
          await loadState({ silent: true });
        } catch (err) { toast("调整失败", err.message, "neg"); }
      } }
    ]
  });
}

async function setRule(id, patch) {
  try {
    await api("/api/risk/rules/" + id, { method: "PATCH", body: { accountId: S.account, ...patch } });
    await loadState({ silent: true });
  } catch (err) { toast("规则更新失败", err.message, "neg"); }
}

/* ---------------- event delegation ---------------- */
document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]");
  if (!el) {
    if (!e.target.closest("#acct-switch")) $("#acct-menu").hidden = true;
    return;
  }
  const act = el.dataset.act;
  const id = el.dataset.id;
  try {
    if (act === "nav") go(id);
    else if (act === "switch-account") await switchAccount(id);
    else if (act === "toggle-auto") await toggleAuto(id);
    else if (act === "kill-acct") killConfirm(id);
    else if (act === "kill") killConfirm(S.account);
    else if (act === "refresh-all") { await loadState(); toast("已刷新", "行情、两个策略台与账户快照已更新。"); }
    else if (act === "refresh-negrisk") { const r = await api("/api/negrisk/refresh", { method: "POST", body: { accountId: "negrisk" } }); toast("NegRisk 已刷新", r.negRisk + " 个事件"); await loadState({ silent: true }); }
    else if (act === "refresh-mm") { await api("/api/mm/refresh", { method: "POST", body: { accountId: "marketmaking" } }); toast("做市报价已刷新"); await loadState({ silent: true }); }
    else if (act === "export-negrisk") downloadCsv();
    else if (act === "convert") openConvert(id);
    else if (act === "mm-params") openMmParams();
    else if (act === "mm-pause") {
      const paused = el.dataset.paused === "true";
      await api("/api/mm/pause", { method: "POST", body: { accountId: "marketmaking", marketId: id, paused } });
      toast(paused ? "已暂停该市场" : "已恢复该市场", "", "warn");
      await loadState({ silent: true });
    } else if (act === "mm-flatten") {
      await api("/api/mm/flatten", { method: "POST", body: { accountId: "marketmaking", marketId: id } });
      toast("该市场库存已平", "", "warn");
      await loadState({ silent: true });
    } else if (act === "flatten-all") {
      const has = (mm().positions || []).some(p => p.inventory !== 0);
      if (!has) { toast("没有库存", "做市台当前是空仓。", "warn"); return; }
      openModal({
        eyebrow: "MARKET MAKING · 平仓", title: "平掉全部做市库存？",
        body: '<p class="note">会按当前对手价逐市场平仓：多头卖在买价，空头买在卖价。已实现盈亏立即落账。</p>',
        actions: [
          { label: "取消", kind: "btn-ghost" },
          { label: "确认平仓", kind: "btn-danger", onClick: async () => {
            try { await api("/api/mm/flatten", { method: "POST", body: { accountId: "marketmaking" } }); toast("全部做市库存已平", "", "warn"); await loadState({ silent: true }); }
            catch (err) { toast("平仓失败", err.message, "neg"); }
          } }
        ]
      });
    } else if (act === "edit-limit") openEditLimit(id);
    else if (act === "reset-limits") { await api("/api/risk/limits/reset", { method: "POST", body: { accountId: S.account } }); toast("限额已恢复默认"); await loadState({ silent: true }); }
    else if (act === "rule-toggle") await setRule(id, { on: el.dataset.on === "true" });
    else if (act === "admin-reset") {
      openModal({
        eyebrow: "ADMIN · 危险操作", title: "重置全部纸面数据？",
        body: '<p class="note">清空两本账的转换、做市库存、成交、审计与净值曲线，两个账户回到各 10,000 USDC。用户与设置保留。</p>',
        actions: [
          { label: "取消", kind: "btn-ghost" },
          { label: "确认重置", kind: "btn-danger", onClick: async () => {
            try { await api("/api/admin/data/reset", { method: "POST", body: { confirm: "RESET" } }); toast("纸面数据已重置"); await loadState(); }
            catch (err) { toast("重置失败", err.message, "neg"); }
          } }
        ]
      });
    }
  } catch (err) {
    toast("操作失败", err.message, "neg");
  }
});

document.addEventListener("change", e => {
  const input = e.target.closest("input[data-rule]");
  if (!input) return;
  const value = Number(input.value);
  if (Number.isFinite(value)) setRule(input.dataset.rule, { value });
});

function downloadCsv() {
  const a = document.createElement("a");
  a.href = "/api/export/opportunities.csv?account=negrisk";
  a.download = "negrisk-baskets.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

$("#acct-btn").addEventListener("click", e => {
  e.stopPropagation();
  const menu = $("#acct-menu");
  menu.hidden = !menu.hidden;
  $("#acct-btn").setAttribute("aria-expanded", String(!menu.hidden));
});
$("#logout-btn").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch { /* ignore */ }
  location.href = "/login";
});
$("#sim-switch").addEventListener("click", async () => {
  const next = S.data.settings.paperTradingEnabled === false;
  try {
    await api("/api/simulation", { method: "POST", body: { accountId: S.account, enabled: next } });
    toast(next ? "模拟交易已开启" : "模拟交易已暂停", next ? "做市成交与转换恢复" : "只允许平仓", next ? "ok" : "warn");
    await loadState({ silent: true });
  } catch (err) { toast("操作失败", err.message, "neg"); }
});
$("#auto-switch").addEventListener("click", () => toggleAuto(S.account));
$("#kill-btn").addEventListener("click", () => killConfirm(S.account));
$("#banner-action").addEventListener("click", () => go("risk"));
$("#nav-admin").addEventListener("click", e => { e.preventDefault(); go("admin"); });

/* ---------------- boot ---------------- */
window.addEventListener("hashchange", () => {
  const route = routeFromHash();
  if (route !== S.route) go(route, false);
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadState({ silent: true }); });

async function boot() {
  const me = await fetch("/api/auth/me", { credentials: "same-origin" }).then(r => r.json()).catch(() => null);
  if (!me?.user) { location.href = "/login"; return; }
  go(routeFromHash(), false);
  await loadState();
  setInterval(() => {
    $("#clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }, 1000);
  setInterval(() => {
    if (!document.hidden && !S.modalOpen) loadState({ silent: true });
  }, 5000);
}
boot();
