/* ============================================================
   CONVERGENCE · 终端交互层
   ============================================================ */

(function () {
  "use strict";

  const D = window.CONV;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  if (location.search.indexOf("debug=1") > -1) {
    window.addEventListener("error", function (e) {
      const box = document.createElement("div");
      box.style.cssText = "position:fixed;z-index:9999;left:0;right:0;top:0;background:#a3212b;color:#fff;padding:10px 14px;font:12px/1.5 monospace;white-space:pre-wrap";
      box.textContent = "JS ERROR: " + e.message + "  @" + (e.filename || "") + ":" + e.lineno;
      document.body.appendChild(box);
    });
  }

  /* ---------------- state ---------------- */
  const app = {
    route: "overview",
    kill: false,
    auto: true,
    scanSeq: 48219,
    lastScan: Date.now(),
    sel: null,
    expanded: null,
    editingLimit: null,
    auditActor: "all",
    posFilter: "all",
    range: 30,
    limits: D.limitDefaults.map(l => ({ ...l })),
    rules: D.rules.map(r => ({ ...r })),
    reviews: D.reviews.map(r => ({ ...r })),
    // legs 必须深拷贝：浅拷贝会让补单/平仓直接改写 D.orders 这份"原始账本"。
    orders: D.orders.map(o => ({ ...o, legs: o.legs.map(l => ({ ...l })) })),
    audit: D.audit.map(a => ({ ...a })),
    opp: { q: "", cat: "all", minEdge: 2.5, horizon: "all", onlyReady: false, sortKey: "edge", sortDir: "desc" }
  };

  // 订单号单调递增：用 orders.length 推号，归档后再开仓会撞到已存在的号。
  let ordSeq = D.orders.reduce((m, o) => Math.max(m, Number(String(o.id).replace(/\D/g, "")) || 0), 8841);

  // ?debug=1 时把内部状态挂到 window 上，方便自动化验收脚本驱动倒计时、账本等场景。
  const DEBUG = location.search.indexOf("debug=1") > -1;
  if (DEBUG) window.__convApp = app;

  /* ---------------- formatting ---------------- */
  const pad = n => String(n).padStart(2, "0");
  const simDate = ms => new Date((ms || D.now()) + 8 * 3600000);
  const clockStr = () => {
    const d = simDate();
    return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds());
  };
  const dateStr = () => {
    const d = simDate();
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  };
  const dateShort = ms => {
    const d = simDate(ms);
    return pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  };
  const dateFull = ms => {
    const d = simDate(ms);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  };
  const weekday = () => ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][simDate().getUTCDay()];
  const usd = (n, dp) => "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 });
  const signedUsd = (n, dp) => (n >= 0 ? "+" : "−") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 });
  const cents = n => (n * 100).toFixed(1) + "¢";
  const signedCents = n => Math.abs(n) < 0.005 ? "0.00¢" : (n > 0 ? "+" : "−") + Math.abs(n).toFixed(2) + "¢";
  const bps = n => {
    const v = Math.round(n);
    return v === 0 ? "0" : (v > 0 ? "+" : "−") + Math.abs(v).toLocaleString("en-US");
  };
  const bpsFine = n => (n >= 0 ? "+" : "−") + (Math.abs(n) >= 10 ? Math.round(Math.abs(n)) : Math.abs(n).toFixed(1));
  const pct = (n, dp) => (n * 100).toFixed(dp == null ? 1 : dp) + "%";
  const signedPct = (n, dp) => (n >= 0 ? "+" : "−") + Math.abs(n * 100).toFixed(dp == null ? 1 : dp) + "%";
  const compactUsd = n => {
    const v = Math.abs(n);
    if (v < 1) return "$0";
    if (v >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    if (v >= 1000) return "$" + Math.round(n / 1e3) + "k";
    return "$" + Math.round(n).toLocaleString("en-US");
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const daysText = d => d < 1 ? Math.max(1, Math.round(d * 24)) + " 小时" : Math.round(d) + " 天";
  const countdown = s => pad(Math.floor(s / 3600)) + ":" + pad(Math.floor((s % 3600) / 60)) + ":" + pad(Math.floor(s % 60));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const statusChip = d => {
    if (app.kill && (d.status === "ready" || d.status === "active")) return '<span class="chip chip-neg">熔断中</span>';
    if (!app.auto && d.status === "ready") return '<span class="chip chip-mute">待执行</span>';
    const map = {
      ready: '<span class="chip chip-accent">可执行</span>',
      watch: '<span class="chip chip-mute">观察</span>',
      review: '<span class="chip chip-warn">待复核</span>',
      active: '<span class="chip chip-ok">执行中</span>'
    };
    return map[d.status] || map.watch;
  };

  const computed = () => D.events.map(e => D.derive(e));

  function book() { return D.book(); }

  /* ---------------- audit trail ----------------
     操作台里的每个动作都要在审计流里留痕，否则"审计日志"只是一段静态样例。
  */
  function logAudit(actor, action, obj, venue, detail) {
    app.audit.unshift({ t: clockStr(), actor, action, obj, venue, detail });
    if (app.audit.length > 80) app.audit.length = 80;
    if ($("#audit-body")) renderAudit();
  }

  /* ---------------- focus containment ---------------- */
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function trapFocus(root, restoreTo) {
    const onKey = e => {
      if (e.key !== "Tab" || !root) return;
      const items = $$(FOCUSABLE, root).filter(el => el.offsetWidth || el.offsetHeight || el === document.activeElement);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
        e.preventDefault(); first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      if (restoreTo && restoreTo.focus && document.contains(restoreTo)) restoreTo.focus();
    };
  }

  /* ---------------- system state ---------------- */
  function updateSystem() {
    const banner = $("#global-banner");
    const killBtn = $("#kill-btn");
    const sw = $("#auto-switch");

    if (app.kill) {
      banner.hidden = false;
      banner.classList.add("is-kill");
      $("#banner-title").textContent = "熔断已触发 · 全部自动执行停止";
      $("#banner-text").textContent = "新开仓与对冲腿已暂停，已有头寸保留。解除需要人工确认。";
      $("#banner-action").textContent = "去解除";
      killBtn.classList.add("is-armed");
      killBtn.querySelector("span").textContent = "已熔断";
    } else if (!app.auto) {
      banner.hidden = false;
      banner.classList.remove("is-kill");
      $("#banner-title").textContent = "自动执行已暂停";
      $("#banner-text").textContent = "扫描与监控继续运行，信号只推送不执行。";
      $("#banner-action").textContent = "查看执行台";
      killBtn.classList.remove("is-armed");
      killBtn.querySelector("span").textContent = "熔断";
    } else {
      banner.hidden = true;
      banner.classList.remove("is-kill");
      killBtn.classList.remove("is-armed");
      killBtn.querySelector("span").textContent = "熔断";
    }

    sw.setAttribute("aria-checked", String(app.auto));
    sw.disabled = app.kill;
    if (sw.parentElement.querySelector(".auto-label")) {
      sw.parentElement.querySelector(".auto-label").textContent = app.kill ? "已停止" : "自动执行";
    }

    $("#sys-mode").textContent = app.kill ? "已熔断 · 人工接管" : app.auto ? "全自动 · 可接管" : "暂停执行 · 仅监控";
    $("#sys-mode").className = app.kill ? "neg" : app.auto ? "ok" : "warn";
    const chip = $("#sys-chip");
    chip.className = "chip " + (app.kill ? "chip-neg" : app.auto ? "chip-ok" : "chip-warn");
    chip.innerHTML = '<span class="dot ' + (app.kill ? "bad" : app.auto ? "ok" : "warn") + '"></span>' + (app.kill ? "已熔断" : app.auto ? "全部正常" : "自动执行暂停");

    $("#risk-state").innerHTML = '<span class="dot ' + (app.kill ? "bad" : "ok") + '"></span>' +
      (app.kill ? "已熔断 · 等待人工解除" : "系统正常 · 全档运行");
    $("#risk-state").className = "risk-state" + (app.kill ? " neg" : "");

    const kp = $("#kill-panel");
    kp.classList.toggle("is-killed", app.kill);
    $("#kp-title").textContent = app.kill ? "全部交易已停止" : "全部护栏已启用";
    $("#kp-desc").textContent = app.kill
      ? "新开仓、补对冲、自动降档全部停止。已成交头寸保留在场，需要人工平仓或解除熔断。"
      : "下单前校验限额与延迟；任一场所报价中断超过 800ms 将暂停新开仓并保留已有对冲。";
    $("#kp-count").textContent = app.kill ? "1" : "0";
    const pageKill = $("#kill-page-btn");
    pageKill.innerHTML = app.kill
      ? '<svg class="ic"><use href="#i-check"/></svg>解除熔断'
      : '<svg class="ic"><use href="#i-power"/></svg>立即熔断';
    pageKill.className = "btn " + (app.kill ? "btn-primary" : "btn-danger-ghost");

    $("#nav-risk-dot").className = "dot " + (app.kill ? "bad" : "ok") + " nav-dot";
  }

  function guard() {
    if (app.kill) { toast("已熔断", "请先在风控页解除熔断，再执行新的套利。", "neg"); return false; }
    return true;
  }

  /* ---------------- toast / modal ---------------- */
  function toast(title, msg, kind, actionLabel, actionFn) {
    const box = $("#toasts");
    const el = document.createElement("div");
    el.className = "toast " + (kind && kind !== "ok" ? kind : "");
    const icon = kind === "neg" || kind === "warn" ? "alert" : "check";
    el.innerHTML =
      '<svg class="ic"><use href="#i-' + icon + '"/></svg>' +
      '<div class="toast-body"><b>' + esc(title) + "</b><span>" + esc(msg) + "</span></div>" +
      (actionLabel ? '<button class="mini-btn" data-taction>' + esc(actionLabel) + "</button>" : "") +
      '<button class="toast-x" aria-label="关闭通知"><svg class="ic"><use href="#i-x"/></svg></button>';
    const close = () => { el.classList.add("is-out"); setTimeout(() => el.remove(), 200); };
    el.querySelector(".toast-x").addEventListener("click", close);
    if (actionLabel) {
      el.querySelector("[data-taction]").addEventListener("click", () => { close(); if (actionFn) actionFn(); });
    }
    box.appendChild(el);
    if (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(close, 5600);
  }

  let modalCloser = null;
  let drawerUntrap = null;

  function openModal(opts) {
    const root = $("#modal-root");
    const actions = opts.actions || [{ label: "关闭", kind: "btn-ghost" }];
    $("#modal").innerHTML =
      '<div class="modal-h"><div class="modal-title" id="modal-title">' + esc(opts.title) + "</div>" +
      (opts.sub ? '<div class="modal-sub">' + opts.sub + "</div>" : "") + "</div>" +
      '<div class="modal-b">' + (opts.body || "") + "</div>" +
      '<div class="modal-f">' + actions.map((a, i) =>
        '<button class="btn ' + (a.kind || "btn-ghost") + '" data-act="' + i + '"' + (a.disabled ? " disabled" : "") + ">" + a.label + "</button>"
      ).join("") + "</div>";

    root.hidden = false;
    const prevFocus = document.activeElement;
    const untrap = trapFocus($("#modal"), prevFocus);

    $$("[data-act]", $("#modal")).forEach(btn => {
      btn.addEventListener("click", () => {
        const act = actions[Number(btn.dataset.act)];
        if (!act) return;
        if (act.onClick) {
          const keep = act.onClick();
          if (keep === false) return;
        }
        closeModal();
        if (act.after) act.after();
      });
    });

    const first = $("#modal .modal-f .btn") || $("#modal button");
    if (first) first.focus();

    modalCloser = () => {
      root.hidden = true;
      modalCloser = null;
      untrap();
    };
    if (opts.onMount) opts.onMount($("#modal"));
  }

  function closeModal() { if (modalCloser) modalCloser(); }

  /* ---------------- drawer ---------------- */
  function openDrawer(id) {
    const ev = D.events.find(e => e.id === id);
    if (!ev) return;
    const d = D.derive(ev);
    app.sel = id;
    const prevFocus = document.activeElement;

    const qty = Math.max(100, Math.round(d.depth * 0.65 / d.ask / 100) * 100);
    const planProfit = qty * d.net / 100;
    // 净边为负时不放行：能点开详情不等于应该下单。
    const canExecute = !app.kill && d.net > 0;
    const costs = [
      ["PM 点差", d.spreadBps],
      ["HL 手续费", d.feeBps],
      ["对冲滑点", d.slipBps],
      ["资金费率", d.fundingBps],
      ["结算缓冲", d.resBps]
    ];
    const costTotal = costs.reduce((s, c) => s + c[1], 0);
    const costSheen = i => 0.72 - i * 0.11;
    const costStack = costs.map((c, i) =>
      '<i style="width:' + (c[1] / costTotal * 100).toFixed(1) + "%;background:oklch(0.695 0.168 25 / " + costSheen(i).toFixed(2) + ')" title="' + c[0] + " " + Math.round(c[1]) + ' bps"></i>'
    ).join("");

    // 公允价可能低于卖价（负毛边）：区间要按两端包住，不能假设 fair 一定在右。
    const zoneNeg = d.fair < d.ask;
    const zoneLeft = Math.min(d.ask, d.fair) * 100;
    const zoneWidth = Math.max(0.4, Math.abs(d.fair - d.ask) * 100);
    const costShare = d.grossBps > 0 ? (costTotal / d.grossBps * 100).toFixed(1) + "%" : "—";
    const netShare = d.gross > 0 ? clamp(d.net / d.gross * 100, 0, 100) : 0;

    $("#drawer").innerHTML =
      '<div class="drawer-h">' +
        '<div class="drawer-h-top">' +
          '<div class="eyebrow">机会拆解 · ' + esc(d.cat) + "</div>" +
          '<button class="x-btn" data-close-drawer aria-label="关闭"><svg class="ic"><use href="#i-x"/></svg></button>' +
        "</div>" +
        '<h2 class="drawer-title" id="drawer-title">' + esc(d.title) + "</h2>" +
        '<div class="drawer-meta">' + statusChip(d) +
          '<span class="chip">' + esc(d.und) + " 永续对冲</span>" +
          "<span class=\"muted\" style=\"font-size:10.5px\">" + daysText(d.days) + "后结算 · " + esc(d.src) + "</span>" +
        "</div>" +
      "</div>" +
      '<div class="drawer-b">' +

        '<section class="dsection">' +
          '<div class="dsection-h"><span class="eyebrow">概率标尺</span><small>市场卖价 vs HL 公允 · 0–100¢</small></div>' +
          '<div class="ruler">' +
            '<div class="ruler-track"></div>' +
            '<div class="ruler-zone' + (zoneNeg ? " is-neg" : "") + '" style="left:' + zoneLeft.toFixed(2) + "%;width:" + zoneWidth.toFixed(2) + '%"></div>' +
            '<div class="ruler-mark is-fair" style="left:' + (d.fair * 100) + '%"><i></i><span>公允 ' + cents(d.fair) + "</span></div>" +
            '<div class="ruler-mark is-ask" style="left:' + (d.ask * 100) + '%"><i></i><span>卖价 ' + cents(d.ask) + "</span></div>" +
            '<div class="ruler-axis"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div>' +
          "</div>" +
          '<div class="price-cols">' +
            '<div class="price-col"><span>PM 最优买价</span><b>' + cents(d.bid) + "</b></div>" +
            '<div class="price-col"><span>PM 最优卖价</span><b>' + cents(d.ask) + "</b></div>" +
            '<div class="price-col is-fair"><span>HL 隐含公允</span><b>' + cents(d.fair) + "</b></div>" +
          "</div>" +
        "</section>" +

        '<section class="dsection">' +
          '<div class="dsection-h"><span class="eyebrow">净边拆解</span><small>单位 bps · 相对合约面值</small></div>' +
          '<div class="decomp">' +
            '<div class="dc-row"><span class="dc-k">毛概率差</span><span class="dc-bar"><i style="width:100%"></i></span>' +
              '<span class="dc-v">' + bps(d.grossBps) + '</span><span class="dc-share">100%</span></div>' +
            '<div class="dc-cost">' +
              '<div class="dc-cost-h"><span>两腿成本</span><b>' + bps(-costTotal) + " bps</b><em>占毛边 " + costShare + "</em></div>" +
              '<div class="dc-stack">' + costStack + "</div>" +
              '<ul class="dc-legend">' + costs.map((c, i) => {
                const share = c[1] / costTotal * 100;
                return '<li><i style="background:oklch(0.695 0.168 25 / ' + costSheen(i).toFixed(2) + ')"></i><span>' + c[0] +
                  "</span><b>" + bpsFine(-c[1]) + "</b><em>" + (share < 2 ? share.toFixed(1) : Math.round(share)) + "%</em></li>";
              }).join("") +
              "</ul>" +
            "</div>" +
            '<div class="dc-row total"><span class="dc-k">净边</span>' +
              '<span class="dc-bar"><i style="width:' + Math.max(2, netShare) + '%"></i></span>' +
              '<span class="dc-v">' + bps(d.netBps) + '</span><span class="dc-share">' + Math.round(netShare) + "%</span></div>" +
          "</div>" +
          '<p class="note" style="margin-top:10px"><svg class="ic"><use href="#i-bolt"/></svg><span>' +
            (d.net > 0
              ? "净边 " + signedCents(d.net) + "，按卖价计的持有期回报 " + pct(d.holdReturn, 1) +
                "，持有 " + daysText(d.days) + " 的简单年化 " + (d.annualized > 999 ? ">999%" : Math.round(d.annualized) + "%") + "。"
              : "净边 " + signedCents(d.net) + "，扣除两腿成本后没有可用收益，只保留在观察列表。") +
            " 成本按两腿同时成交估算。</span></p>" +
        "</section>" +

        '<section class="dsection">' +
          '<div class="dsection-h"><span class="eyebrow">两腿执行计划</span><small>默认 ' + Math.round(0.65 * 100) + "% 盘口深度</small></div>" +
          '<div class="plan">' +
            '<div class="plan-leg">' +
              '<div class="plan-src"><b>POLYMARKET</b><span>合约腿</span></div>' +
              '<div class="plan-mid"><b>买入 YES · ' + qty.toLocaleString("en-US") + " 股</b><span>" + cents(d.ask) + " · 成本 " + usd(qty * d.ask, 2) + "</span></div>" +
              '<div class="plan-num"><b>' + usd(qty * d.ask, 0) + "</b><span>最大损失</span></div>" +
            "</div>" +
            '<div class="plan-leg">' +
              '<div class="plan-src"><b>HYPERLIQUID</b><span>对冲腿</span></div>' +
              '<div class="plan-mid"><b>做空 ' + esc(d.und) + "-PERP · 约 " + usd(qty * Math.abs(d.delta), 0) + "</b><span>" + esc(d.und) + " " +
                usd(D.market[d.und].px, 2) + " · Delta " + (d.delta * 100).toFixed(1) + "%</span></div>" +
              '<div class="plan-num"><b>' + usd(qty * Math.abs(d.delta) * D.COST.hlFeeBps / 10000, 2) + "</b><span>手续费</span></div>" +
            "</div>" +
          "</div>" +
        "</section>" +

        '<section class="dsection">' +
          '<div class="dsection-h"><span class="eyebrow">结算与模型风险</span><small>模型 lognormal-iv v3.2</small></div>' +
          '<div class="notes">' +
            note("来源", "结算价取自 " + esc(d.src) + "，UMA 乐观预言机有 2 小时争议窗口；争议期间头寸无法提前退出。") +
            note("模型", "公允概率由 HL 永续与期权曲面反推的数字期权价格，置信度 <b>" + d.conf + "/100</b>；低于 62 不自动执行。") +
            note("流动性", "盘口资金 <b>" + usd(d.depth, 0) + "</b>，超过该规模的订单预计滑点上升 3–8bps。") +
          "</div>" +
        "</section>" +

      "</div>" +
      '<div class="drawer-f">' +
        '<div class="df-sum"><span>预计净边捕获 · ' + qty.toLocaleString("en-US") + " 股</span><b" +
          (planProfit < 0 ? ' class="neg"' : "") + ">" + signedUsd(planProfit, 0) + "</b></div>" +
        '<button class="btn btn-ghost btn-sm" id="simulate-btn">模拟</button>' +
        '<button class="btn btn-primary" id="execute-btn"' + (canExecute ? "" : " disabled") + ">" +
          (app.kill ? "熔断中" : d.net <= 0 ? "净边为负" : "执行套利") + "</button>" +
      "</div>";

    $("#drawer-root").hidden = false;
    document.body.classList.add("has-drawer");
    $("#drawer").focus();
    drawerUntrap = trapFocus($("#drawer"), prevFocus);
    if (app.route === "scanner") history.replaceState(null, "", "#/scanner/" + id);

    const close = () => closeDrawer(prevFocus);
    $("#drawer .x-btn").addEventListener("click", close);
    $("#simulate-btn").addEventListener("click", () => {
      toast("模拟完成", "两条腿按当前盘口可成交 " + qty.toLocaleString("en-US") + " 股，预计滑点 5.8bps，净边捕获 " + signedUsd(planProfit, 0) + "。");
    });
    $("#execute-btn").addEventListener("click", () => {
      if (!guard()) return;
      if (d.net <= 0) { toast("净边为负", "扣除两腿成本后没有正收益，这里不会替你开这个仓。", "neg"); return; }
      executeModal(d, qty, planProfit);
    });
  }

  function note(k, text) {
    return '<div class="note"><svg class="ic"><use href="#i-alert"/></svg><span><b>' + k + "</b> · " + text + "</span></div>";
  }

  function closeDrawer(focus) {
    if ($("#drawer-root").hidden) return;
    $("#drawer-root").hidden = true;
    document.body.classList.remove("has-drawer");
    $("#drawer").innerHTML = "";
    app.sel = null;
    if (drawerUntrap) { drawerUntrap(); drawerUntrap = null; }
    if (app.route === "scanner") history.replaceState(null, "", "#/scanner");
    if (focus && focus.focus && document.contains(focus)) focus.focus();
  }

  /* ---------------- execute flow ---------------- */
  function executeModal(d, qty, profit) {
    const maxQty = Math.floor(d.depth / d.ask / 100) * 100;
    openModal({
      title: "执行套利",
      sub: esc(d.title),
      body:
        '<div class="field"><label>合约腿数量（YES 股）</label>' +
          '<div class="size-input"><input type="number" id="size-qty" value="' + qty + '" min="100" max="' + maxQty + '" step="100">' +
          '<button class="btn btn-ghost" data-size="0.25">25%</button>' +
          '<button class="btn btn-ghost" data-size="0.5">50%</button>' +
          '<button class="btn btn-ghost" data-size="1">盘口</button></div>' +
          '<span class="hint">盘口可成交 ' + maxQty.toLocaleString("en-US") + " 股 · 超出后按对手价分批</span></div>" +
        '<div class="kvbox" id="exec-preview"></div>' +
        '<div class="warn-box"><svg class="ic"><use href="#i-alert"/></svg><p><b>两腿同时提交。</b>' +
          "合约腿成交后 800ms 内发送对冲单；若对冲腿 30 秒未成交，系统自动撤单并把缺口转入待接管队列。</p></div>",
      actions: [
        { label: "取消", kind: "btn-ghost" },
        {
          label: "确认下单", kind: "btn-primary",
          onClick: function () {
            const input = $("#size-qty");
            const q = Number(input.value);
            if (!q || q < 100 || q > maxQty) {
              input.closest(".field").classList.add("err");
              toast("数量无效", "合约腿数量需在 100 至 " + maxQty.toLocaleString("en-US") + " 股之间。", "neg");
              return false;
            }
            submitArb(d, q);
          }
        }
      ],
      onMount: function (modal) {
        const input = $("#size-qty", modal);
        const update = () => {
          let q = Number(input.value) || 0;
          q = clamp(q, 0, maxQty);
          const cost = q * d.ask;
          const hedge = q * Math.abs(d.delta);
          const fees = hedge * D.COST.hlFeeBps / 10000;
          const expect = q * d.net / 100;
          $("#exec-preview", modal).innerHTML =
            "<div><span>合约腿成本</span><b>" + usd(cost, 2) + "</b></div>" +
            "<div><span>对冲腿规模</span><b>" + usd(hedge, 0) + " " + esc(d.und) + "-PERP</b></div>" +
            "<div><span>预计费用（两腿）</span><b>" + usd(fees, 2) + "</b></div>" +
            "<div><span>预计滑点</span><b>5.8 bps</b></div>" +
            '<div class="total"><span>净边捕获</span><b>' + signedUsd(expect, 2) + "</b></div>";
        };
        input.addEventListener("input", update);
        $$("[data-size]", modal).forEach(b => b.addEventListener("click", () => {
          input.value = Math.max(100, Math.round(maxQty * Number(b.dataset.size) / 100) * 100);
          update();
        }));
        update();
      }
    });
  }

  function submitArb(d, qty) {
    const id = "ORD-" + (++ordSeq);
    const hedge = qty * Math.abs(d.delta);
    app.orders.unshift({
      id: id, evId: d.id, status: "hedging", statusText: "对冲中", notional: qty * d.ask, qty: qty,
      opened: clockStr().slice(0, 5), strategy: "概率差 · 人工确认", slippageBps: 5.8,
      legs: [
        { venue: "POLYMARKET", side: "buy", label: "买入 YES", qty: qty, filled: qty, price: d.ask, notional: qty * d.ask, done: true },
        { venue: "HYPERLIQUID", side: "short", label: "做空 " + d.und + "-PERP", qty: hedge, filled: 0, price: D.market[d.und].px, notional: 0, done: false, note: "已发送，等待对手方" }
      ]
    });
    closeDrawer();
    renderOrders();
    renderNav();
    logAudit("林 · 自营", "开仓", d.title, "PM + HL",
      "买入 " + qty.toLocaleString("en-US") + " YES @ " + cents(d.ask) + "；对冲 " + d.und + "-PERP " + usd(hedge, 0));
    toast("套利已提交", "合约腿 " + qty.toLocaleString("en-US") + " YES 已成交；对冲腿 " + usd(hedge, 0) + " 已发送至 Hyperliquid。", "ok", "查看执行台", () => go("execution"));

    setTimeout(() => {
      const order = app.orders.find(o => o.id === id);
      if (!order || app.kill) return;
      order.legs[1].filled = hedge;
      order.legs[1].notional = hedge;
      order.legs[1].done = true;
      order.legs[1].note = "已全额成交 · 滑点 4.2bps";
      order.status = "filled";
      order.statusText = "已成交";
      // 两腿对齐后进入持仓账本：执行台是过程，持仓页是结果，两者不能各记一套。
      const px = D.market[d.und].px;
      const held = D.positions.find(p => p.evId === d.id);
      if (held) {
        held.avg = (held.avg * held.qty + d.ask * qty) / (held.qty + qty);
        held.hedgeEntry = (held.hedgeUsd * held.hedgeEntry + hedge * px) / (held.hedgeUsd + hedge);
        held.qty += qty;
        held.hedgeUsd += hedge;
      } else {
        D.positions.push({ evId: d.id, qty: qty, avg: d.ask, hedgeUsd: hedge, hedgeEntry: px });
      }
      renderOrders();
      renderPositions();
      renderTable();
      renderOverview();
      renderNav();
      logAudit("自动引擎", "两腿对齐", d.title, "HL",
        "对冲腿全额成交 " + usd(hedge, 0) + "，滑点 4.2bps；头寸已进入持仓账本");
      toast("对冲腿已成交", d.title + " 的两条腿已对齐，净边锁定，头寸已进入持仓。");
    }, 4200);
  }

  /* ---------------- rendering: topbar / nav ---------------- */
  function renderNav() {
    const rows = computed();
    const signals = rows.filter(r => r.net >= D.MIN_EDGE_CENTS).length;
    const ready = rows.filter(r => r.status === "ready").length;
    const active = rows.filter(r => r.status === "active").length;
    $("#nav-scan-count").textContent = signals;
    $("#nav-exec-count").textContent = app.reviews.length;
    $("#nav-exec-count").style.display = app.reviews.length ? "" : "none";
    $("#kpi-opps").textContent = signals;
    $("#kpi-ready").textContent = ready;
    $("#kpi-active").textContent = active;
    $("#sm-pass").textContent = signals;
    if ($("#sm-covered")) $("#sm-covered").textContent = D.events.length;
    if ($("#scan-universe")) $("#scan-universe").textContent = D.events.length;
    $("#tab-review-count").textContent = app.reviews.length;
    $("#ex-review").textContent = app.reviews.length;
    $("#ex-active").textContent = app.orders.filter(o => o.status !== "filled").length;
  }

  function renderPulse() {
    const m = D.market;
    $("#px-btc").textContent = m.BTC.px.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    $("#px-eth").textContent = m.ETH.px.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    $("#px-hype").textContent = m.HYPE.px.toFixed(2);
    const chg = (el, v) => {
      const node = $(el);
      node.textContent = (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2) + "%";
      node.className = "delta " + (v >= 0 ? "up" : "down");
    };
    chg("#chg-btc", m.BTC.chg);
    chg("#chg-eth", m.ETH.chg);
    chg("#chg-hype", m.HYPE.chg);
  }

  /* ---------------- overview ---------------- */
  function meterWidth(used, limit) { return clamp(used / limit * 100, 0, 100); }

  function renderOverview() {
    const b = book();
    const rows = computed();
    const signals = rows.filter(r => r.net >= D.MIN_EDGE_CENTS).length;
    const ready = rows.filter(r => r.status === "ready").length;
    const active = rows.filter(r => r.status === "active").length;
    const netEdges = rows.filter(r => r.net >= D.MIN_EDGE_CENTS).map(r => r.net).sort((a, z) => a - z);
    const median = netEdges.length ? netEdges[Math.floor(netEdges.length / 2)] : 0;
    const series = D.equity;
    const last = series[series.length - 1].v;
    const r30 = last / series[series.length - 31].v - 1;
    const r12 = last / series[0].v - 1;
    let peak90 = 0, dd90 = 0;
    series.slice(-90).forEach(d => { peak90 = Math.max(peak90, d.v); dd90 = Math.min(dd90, d.v / peak90 - 1); });

    $("#today-line").textContent = "OVERVIEW · " + dateStr() + " " + weekday();
    $("#hero-equity").textContent = usd(D.equityNow, 2);
    $("#rail-equity").textContent = usd(D.equityNow, 2);
    $("#hero-30d").textContent = signedPct(r30, 2);
    $("#hero-12m").textContent = signedPct(r12, 1);
    $("#hero-30d").className = r30 >= 0 ? "pos" : "neg";
    $("#hero-12m").className = r12 >= 0 ? "pos" : "neg";
    $("#kpi-dd").innerHTML = "−" + Math.abs(dd90 * 100).toFixed(1) + '<i class="unit">%</i>';
    $("#kpi-opps").textContent = signals;
    $("#kpi-ready").textContent = ready;
    $("#kpi-active").textContent = active;
    $("#kpi-delta").textContent = usd(b.netDelta, 0);
    const dl = limitMap().delta;
    $("#kpi-delta-meta").textContent = "限额 " + usd(dl.value, 0) + " · 占用 " + pct(b.netDelta / dl.value);
    $("#kpi-median").innerHTML = median.toFixed(1) + '<i class="unit">¢</i>';
    const medOf = arr => {
      const s = arr.slice().sort((x, y) => x - y);
      return s.length ? s[Math.floor(s.length / 2)] : 0;
    };
    const activeRows = rows.filter(r => r.net >= D.MIN_EDGE_CENTS);
    $("#kpi-gross").textContent = medOf(activeRows.map(r => r.gross)).toFixed(1) + "¢";
    $("#kpi-cost").textContent = medOf(activeRows.map(r => r.costBps / 100)).toFixed(1) + "¢";

    const unhedged = b.netDelta;
    $("#hero-unhedged").textContent = usd(unhedged, 0);
    $("#hero-unhedged").className = "num " + (unhedged > 40000 ? "warn" : "");
    $("#hero-pnl").textContent = signedUsd(b.pnl, 0);
    const util = (b.cost + b.margin) / D.equityNow;
    $("#hero-util").textContent = pct(util);

    // radar
    const top = rows.slice().sort((a, z) => z.net - a.net).slice(0, 5);
    $("#radar-list").innerHTML = top.map((d, i) =>
      '<button class="radar-row" data-open="' + d.id + '">' +
        '<span class="radar-rank">' + pad(i + 1) + "</span>" +
        '<span class="radar-main"><span class="radar-title">' + esc(d.title) + "</span>" +
          '<span class="radar-meta"><span class="chip">' + esc(d.cat) + "</span><span>" + daysText(d.days) + "</span><span>·</span><span>可成交 " + compactUsd(d.depth) + "</span></span></span>" +
        '<span class="radar-pair"><span class="pair-mini"><span data-radar="ask">' + cents(d.ask) + "</span><em>PM</em></span>" +
          '<span class="pair-link"></span><span class="pair-mini"><span data-radar="fair">' + cents(d.fair) + "</span><em>HL</em></span></span>" +
        '<span class="radar-edge"><b data-radar="edge">' + signedCents(d.net) + "</b><small data-radar=\"bps\">" + bps(d.netBps) + " bps</small></span>" +
        '<span class="radar-go"><svg class="ic"><use href="#i-arrow"/></svg></span>' +
      "</button>"
    ).join("");

    // budget
    const limits = limitMap();
    $("#budget-list").innerHTML = ["pm", "hl", "delta", "settle", "conc"].map(id => {
      const l = limits[id];
      const w = meterWidth(l.used, l.value);
      const cls = w > 90 ? "is-neg" : w > 72 ? "is-warn" : "";
      return '<div class="budget-item"><div class="budget-top"><span>' + esc(l.name.replace(" · Polymarket", "")) +
        "</span><b>" + (l.kind === "pct" ? l.used.toFixed(1) + "% / " + l.value + "%" : compactUsd(l.used) + " <em>/ " + compactUsd(l.value) + "</em>") +
        '</b></div><div class="meter"><i class="' + cls + '" style="width:' + w + '%"></i></div></div>';
    }).join("");

    $("#feed").innerHTML = D.feed.map(f =>
      '<li><span class="feed-time">' + f.t + "</span>" +
        '<span class="dot ' + (f.kind === "warn" ? "warn" : "ok") + ' feed-dot"></span>' +
        '<div class="feed-body"><p>' + esc(f.title) + "</p><small>" + esc(f.detail) + "</small></div>" +
        '<span class="feed-val ' + (f.kind === "warn" ? "warn" : "pos") + '">' + esc(f.val) + "</span></li>"
    ).join("");

    $("#radar-updated").textContent = "0.6s";
    renderSpark();
  }

  function limitMap() {
    const b = book();
    const map = {};
    app.limits.forEach(l => {
      let used = 0;
      if (l.id === "pm") used = b.cost;
      if (l.id === "hl") used = b.margin;
      if (l.id === "delta") used = b.netDelta;
      if (l.id === "settle") used = b.settle7;
      if (l.id === "conc") used = b.maxCost / D.equityNow * 100;
      map[l.id] = { ...l, used };
    });
    return map;
  }

  function sparkSVG() {
    const pts = D.equity.slice(-30);
    const w = 220, h = 76, p = 3;
    const vals = pts.map(d => d.v);
    const min = Math.min(...vals), max = Math.max(...vals);
    const x = i => p + i / (vals.length - 1) * (w - p * 2);
    const y = v => p + (1 - (v - min) / (max - min || 1)) * (h - p * 2);
    const line = vals.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1)).join(" ");
    const area = line + " L" + x(vals.length - 1) + "," + (h - p) + " L" + x(0) + "," + (h - p) + " Z";
    return '<svg class="chart-svg" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="oklch(0.84 0.105 200)" stop-opacity=".26"/>' +
        '<stop offset="100%" stop-color="oklch(0.84 0.105 200)" stop-opacity="0"/>' +
      "</linearGradient></defs>" +
      '<path d="' + area + '" fill="url(#sparkFill)"/>' +
      '<path d="' + line + '" fill="none" stroke="oklch(0.84 0.105 200)" stroke-width="1.4" stroke-linejoin="round"/>' +
      '<circle cx="' + x(vals.length - 1) + '" cy="' + y(vals[vals.length - 1]) + '" r="2.4" fill="oklch(0.84 0.105 200)"/>' +
      "</svg>";
  }

  function renderSpark() { $("#hero-spark").innerHTML = sparkSVG(); }

  /* ---------------- equity chart ---------------- */
  function renderChart() {
    const host = $("#equity-chart");
    if (!host) return;
    const width = Math.max(280, host.clientWidth - 8);
    const height = 268;
    const pad = { l: 6, r: 54, t: 14, b: 24 };
    const n = app.range;
    const data = D.equity.slice(-(n + 1));
    const vals = data.map(d => d.v);
    let min = Math.min(...vals), max = Math.max(...vals);
    const span0 = max - min || 1;
    min -= span0 * 0.14; max += span0 * 0.10;
    const x = i => pad.l + i / (data.length - 1) * (width - pad.l - pad.r);
    const y = v => pad.t + (1 - (v - min) / (max - min)) * (height - pad.t - pad.b);
    const bottom = height - pad.b;

    let line = "";
    data.forEach((d, i) => { line += (i ? "L" : "M") + x(i).toFixed(1) + "," + y(d.v).toFixed(1); });
    const area = line + " L" + x(data.length - 1).toFixed(1) + "," + bottom + " L" + x(0).toFixed(1) + "," + bottom + " Z";

    let grid = "";
    for (let i = 0; i < 4; i++) {
      const v = min + (max - min) * (i / 3);
      const yy = y(v);
      grid += '<line x1="' + pad.l + '" y1="' + yy + '" x2="' + (width - pad.r) + '" y2="' + yy + '" stroke="oklch(0.45 0.013 255 / .22)" stroke-dasharray="2 4"/>' +
        '<text x="' + (width - pad.r + 8) + '" y="' + (yy + 3) + '" fill="oklch(0.6 0.01 255)" font-size="9" font-family="Cascadia Mono, Consolas, monospace">' + compactUsd(v) + "</text>";
    }

    let xs = "";
    [0, 0.33, 0.66, 1].forEach(f => {
      const i = Math.round((data.length - 1) * f);
      xs += '<text x="' + x(i) + '" y="' + (height - 6) + '" fill="oklch(0.58 0.01 255)" font-size="9" font-family="Cascadia Mono, Consolas, monospace" text-anchor="' + (f === 0 ? "start" : f === 1 ? "end" : "middle") + '">' + dateShort(data[i].t) + "</text>";
    });

    host.innerHTML =
      '<svg class="chart-svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="组合净值曲线">' +
        "<defs><linearGradient id=\"eqFill\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">" +
          '<stop offset="0%" stop-color="oklch(0.84 0.105 200)" stop-opacity=".20"/>' +
          '<stop offset="100%" stop-color="oklch(0.84 0.105 200)" stop-opacity="0.01"/>' +
        "</linearGradient></defs>" +
        grid +
        '<path d="' + area + '" fill="url(#eqFill)"/>' +
        '<path d="' + line + '" fill="none" stroke="oklch(0.84 0.105 200)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<circle cx="' + x(data.length - 1) + '" cy="' + y(vals[vals.length - 1]) + '" r="3" fill="oklch(0.84 0.105 200)"/>' +
        '<circle cx="' + x(data.length - 1) + '" cy="' + y(vals[vals.length - 1]) + '" r="7" fill="oklch(0.84 0.105 200)" opacity=".18"/>' +
        xs +
        '<line id="eq-cross" x1="0" y1="' + pad.t + '" x2="0" y2="' + bottom + '" stroke="oklch(0.84 0.105 200 / .45)" stroke-width="1" opacity="0"/>' +
        '<circle id="eq-dot" r="3.2" fill="oklch(0.135 0.006 255)" stroke="oklch(0.84 0.105 200)" stroke-width="1.6" opacity="0"/>' +
        '<rect id="eq-hit" x="' + pad.l + '" y="' + pad.t + '" width="' + (width - pad.l - pad.r) + '" height="' + (height - pad.t - pad.b) + '" fill="transparent"/>' +
      "</svg>";
    host.insertAdjacentHTML("beforeend", '<div class="chart-tip" id="eq-tip"></div>');

    const svg = host.querySelector("svg");
    const hit = host.querySelector("#eq-hit");
    const cross = host.querySelector("#eq-cross");
    const dot = host.querySelector("#eq-dot");
    const tip = host.querySelector("#eq-tip");

    const move = e => {
      const rect = svg.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (width / rect.width);
      const i = clamp(Math.round((px - pad.l) / (width - pad.l - pad.r) * (data.length - 1)), 0, data.length - 1);
      const cx = x(i), cy = y(data[i].v);
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("opacity", "1");
      dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("opacity", "1");
      const ret = data[i].v / data[0].v - 1;
      tip.innerHTML = "<b>" + usd(data[i].v, 0) + "</b><span>" + dateShort(data[i].t) + " · " + signedPct(ret, 2) + "</span>";
      const scale = rect.width / width;
      tip.style.left = (svg.offsetLeft + clamp(cx, 54, width - 54) * scale) + "px";
      tip.style.top = (svg.offsetTop + cy * scale - 8) + "px";
      tip.classList.add("is-on");
    };
    hit.addEventListener("mousemove", move);
    hit.addEventListener("mouseleave", () => {
      cross.setAttribute("opacity", "0");
      dot.setAttribute("opacity", "0");
      tip.classList.remove("is-on");
    });

    const ret = vals[vals.length - 1] / vals[0] - 1;
    const rets = [];
    for (let i = 1; i < vals.length; i++) rets.push(vals[i] / vals[i - 1] - 1);
    const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / rets.length) || 0.0001;
    let peak = vals[0], dd = 0;
    vals.forEach(v => { peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); });
    $("#eq-ret").textContent = signedPct(ret, 2);
    $("#eq-ret").className = "num " + (ret >= 0 ? "pos" : "neg");
    $("#eq-sharpe").textContent = (mean / sd * Math.sqrt(365)).toFixed(2);
    $("#eq-dd").textContent = "−" + Math.abs(dd * 100).toFixed(2) + "%";
    $("#eq-trades").textContent = Math.round(n * 6.13);
  }

  /* ---------------- scanner ---------------- */
  function filterRows() {
    const o = app.opp;
    let rows = computed();
    if (o.q) {
      const q = o.q.toLowerCase();
      rows = rows.filter(r => (r.title + r.cat + r.und + r.src).toLowerCase().indexOf(q) > -1);
    }
    if (o.cat !== "all") rows = rows.filter(r => r.cat === o.cat);
    rows = rows.filter(r => r.net >= o.minEdge);
    if (o.horizon !== "all") rows = rows.filter(r => r.days <= Number(o.horizon));
    if (o.onlyReady) rows = rows.filter(r => r.status === "ready");

    const dir = o.sortDir === "asc" ? 1 : -1;
    const key = o.sortKey;
    rows.sort((a, z) => {
      let va, vz;
      if (key === "title") { va = a.title; vz = z.title; return va.localeCompare(vz, "zh") * dir; }
      if (key === "pair") { va = a.fair - a.ask; vz = z.fair - z.ask; }
      if (key === "edge") { va = a.netBps; vz = z.netBps; }
      if (key === "depth") { va = a.depth; vz = z.depth; }
      if (key === "hedge") { va = a.hedgeUsd; vz = z.hedgeUsd; }
      if (key === "conf") { va = a.conf; vz = z.conf; }
      if (key === "due") { va = a.days; vz = z.days; return (va - vz) * (o.sortDir === "asc" ? 1 : -1); }
      return (va - vz) * dir;
    });
    return rows;
  }

  function renderTable() {
    const rows = filterRows();
    const tbody = $("#opp-body");
    tbody.innerHTML = rows.map(d =>
      '<tr data-id="' + d.id + '" tabindex="0">' +
        '<td><div class="ev-cell"><div class="ev-title">' + esc(d.title) + "</div>" +
          '<div class="ev-meta"><span class="chip">' + esc(d.cat) + "</span><span>" + daysText(d.days) + "</span>" +
          '<span class="sep"></span><span class="src">' + esc(d.src) + "</span></div></div></td>" +
        '<td class="num-col"><div class="pair-cell">' +
          '<div class="pair-line"><span class="pair-l">PM</span><span class="pair-v" data-f="ask">' + cents(d.ask) + "</span></div>" +
          '<div class="pair-line is-fair"><span class="pair-l">HL</span><span class="pair-v" data-f="fair">' + cents(d.fair) + "</span></div>" +
        "</div></td>" +
        '<td class="num-col"><div class="edge-cell"><b data-f="net"' + (d.net < -0.005 ? ' class="neg"' : "") + ">" + signedCents(d.net) + "</b>" +
          '<span class="edge-mini"><i data-f="bar"' + (d.net < -0.005 ? ' class="neg"' : "") + ' style="width:' + d.edgeWidth + '%"></i></span>' +
          '<small data-f="bps">' + bps(d.netBps) + " bps</small></div></td>" +
        '<td class="num-col size-cell"><b>' + compactUsd(d.depth) + "</b><small>盘口 " + Math.round(d.depth / Math.max(1, d.ask * 1e3)) + "k 股</small></td>" +
        '<td class="num-col"><div class="hedge-cell">' + compactUsd(d.hedgeUsd) + "<small>Delta " + (d.delta * 100).toFixed(1) + "%</small></div></td>" +
        '<td class="num-col"><div class="conf"><span class="conf-num">' + d.conf + '</span><span class="conf-bar"><i class="' + (d.conf >= 80 ? "hi" : d.conf >= 65 ? "" : "lo") + '" style="width:' + d.conf + '%"></i></span></div></td>' +
        '<td class="num-col"><div class="due-cell' + (d.days <= 7 ? " is-soon" : "") + '">' + dateShort(Date.parse(d.due)) + "<small>" + daysText(d.days) + "</small></div></td>" +
        '<td data-f="status">' + statusChip(d) + "</td>" +
        '<td><button class="row-go" data-open="' + d.id + '" aria-label="查看 ' + esc(d.title) + '"><svg class="ic"><use href="#i-arrow"/></svg></button></td>' +
      "</tr>"
    ).join("");

    const cards = $("#opp-cards");
    if (cards) {
      cards.innerHTML = rows.map(d =>
        '<button class="opp-card" data-id="' + d.id + '">' +
          '<span class="oc-top"><span class="oc-title">' + esc(d.title) + "</span>" + statusChip(d) + "</span>" +
          '<span class="oc-meta"><span class="chip">' + esc(d.cat) + "</span><span>" + daysText(d.days) + "</span><span>·</span><span>可成交 " + compactUsd(d.depth) + "</span></span>" +
          '<span class="oc-bottom"><span class="oc-pair">PM <b>' + cents(d.ask) + '</b><span class="oc-arrow">→</span>HL <b>' + cents(d.fair) + "</b></span>" +
            '<span class="oc-edge"><b' + (d.net < -0.005 ? ' class="neg"' : "") + ">" + signedCents(d.net) + "</b><small>" + bps(d.netBps) + " bps</small></span></span>" +
        "</button>"
      ).join("");
    }
    const tableCard = $("#view-scanner .table-card");
    if (tableCard) tableCard.classList.toggle("is-filled", rows.length > 0);

    const sumDepth = rows.reduce((s, r) => s + r.depth, 0);
    const sumEdge = rows.reduce((s, r) => s + r.net / 100 * (r.depth / r.ask), 0);

    $("#sum-count").textContent = rows.length;
    $("#sum-depth").textContent = sumDepth ? "$" + (sumDepth / 1e6).toFixed(2) + "M" : "$0";
    $("#sum-edge").textContent = "$" + Math.round(sumEdge).toLocaleString("en-US");

    const sigRows = computed().filter(r => r.net >= D.MIN_EDGE_CENTS);
    const sigDepth = sigRows.reduce((s, r) => s + r.depth, 0);
    const sigNets = sigRows.map(r => r.net).sort((a, z) => a - z);
    $("#sm-pass").textContent = sigRows.length;
    $("#sm-depth").textContent = "$" + (sigDepth / 1e6).toFixed(2) + "M";
    $("#sm-edge").textContent = cents((sigNets.length ? sigNets[Math.floor(sigNets.length / 2)] : 0) / 100);

    const empty = rows.length === 0;
    $("#opp-empty").hidden = !empty;
    const oppScroll = $("#view-scanner .table-card .tbl-scroll");
    if (oppScroll) oppScroll.style.display = empty ? "none" : "";

    $$("#opp-table thead th").forEach(th => {
      const k = th.dataset.sort;
      th.classList.toggle("is-sorted", k === app.opp.sortKey);
      th.classList.toggle("is-asc", k === app.opp.sortKey && app.opp.sortDir === "asc");
      if (k) th.setAttribute("aria-sort", k === app.opp.sortKey ? (app.opp.sortDir === "asc" ? "ascending" : "descending") : "none");
    });
    renderNav();
  }

  function updateLiveCells() {
    const tbody = $("#opp-body");
    if (!tbody.children.length) return;
    Array.from(tbody.children).forEach(tr => {
      const ev = D.events.find(e => e.id === tr.dataset.id);
      if (!ev) return;
      const d = D.derive(ev);
      const set = (f, txt) => { const n = tr.querySelector('[data-f="' + f + '"]'); if (n) n.textContent = txt; };
      const askNode = tr.querySelector('[data-f="ask"]');
      const prevAsk = askNode ? parseFloat(askNode.textContent) : d.ask * 100;
      set("ask", cents(d.ask));
      set("fair", cents(d.fair));
      set("bps", bps(d.netBps) + " bps");
      const netNode = tr.querySelector('[data-f="net"]');
      if (netNode) {
        netNode.textContent = signedCents(d.net);
        netNode.classList.toggle("neg", d.net < -0.005);
      }
      const bar = tr.querySelector('[data-f="bar"]');
      if (bar) {
        bar.style.width = d.edgeWidth + "%";
        bar.classList.toggle("neg", d.net < -0.005);
      }
      const st = tr.querySelector('[data-f="status"]');
      if (st && st.innerHTML !== statusChip(d)) st.innerHTML = statusChip(d);
      if (Math.abs(prevAsk - d.ask * 100) > 0.05) {
        tr.classList.remove("flash-up", "flash-down");
        void tr.offsetWidth;
        tr.classList.add(d.ask * 100 > prevAsk ? "flash-up" : "flash-down");
      }
    });
  }

  function updateRadarCells() {
    $$("#radar-list .radar-row").forEach(row => {
      const ev = D.events.find(e => e.id === row.dataset.open);
      if (!ev) return;
      const d = D.derive(ev);
      const ask = row.querySelector('[data-radar="ask"]');
      const fair = row.querySelector('[data-radar="fair"]');
      const edge = row.querySelector('[data-radar="edge"]');
      const bp = row.querySelector('[data-radar="bps"]');
      if (ask) ask.textContent = cents(d.ask);
      if (fair) fair.textContent = cents(d.fair);
      if (edge) edge.textContent = signedCents(d.net);
      if (bp) bp.textContent = bps(d.netBps) + " bps";
    });
  }

  /* ---------------- execution ---------------- */
  function legHTML(leg) {
    const pctFill = leg.qty ? clamp(leg.filled / leg.qty * 100, 0, 100) : 0;
    const cls = pctFill >= 99.5 ? "full" : pctFill > 0 ? "partial" : "";
    return '<div class="leg ' + cls + '">' +
      '<div class="leg-h"><span class="venue"><span class="dot ' + (pctFill > 0 ? "ok" : "") + '"></span>' + leg.venue + "</span>" +
      '<span class="leg-side ' + leg.side + '">' + (leg.side === "buy" ? "买入" : "做空") + "</span></div>" +
      '<div class="leg-bar"><i style="width:' + pctFill + '%"></i></div>' +
      '<div class="leg-stats"><span>' + Math.round(leg.filled).toLocaleString("en-US") + " / " + Math.round(leg.qty).toLocaleString("en-US") + "</span>" +
        "<b>" + (leg.price ? (leg.venue === "POLYMARKET" ? cents(leg.price) : usd(leg.price, 1)) : "—") + "</b></div>" +
      (leg.note ? '<div class="leg-note"><svg class="ic"><use href="#i-alert"/></svg>' + esc(leg.note) + "</div>" : "") +
      "</div>";
  }

  function renderOrders() {
    const host = $("#order-list");
    if (!host) return;
    host.innerHTML = app.orders.map(o => {
      const ev = D.events.find(e => e.id === o.evId);
      const d = D.derive(ev);
      const hedge = o.legs[1];
      const gap = Math.max(0, hedge.qty - hedge.filled);
      const chip = o.status === "filled"
        ? '<span class="chip chip-ok">已成交</span>'
        : o.status === "leg1"
          ? '<span class="chip chip-warn">等待合约腿</span>'
          : o.status === "settling"
            ? '<span class="chip chip-accent">收尾</span>'
            : '<span class="chip chip-warn">对冲中</span>';
      return '<article class="order">' +
        '<div class="order-top"><div>' +
          '<div class="order-id">' + o.id + " · " + o.opened + " · " + esc(o.strategy) + "</div>" +
          '<div class="order-title">' + esc(ev.title) + "</div>" +
          '<div class="order-sub">' + chip + "<span>" + esc(ev.cat) + "</span><span>·</span><span>" + daysText(d.days) + "后结算</span></div>" +
        "</div>" +
        '<div class="order-right"><div class="order-notional"><b>' + usd(o.notional, 0) + "</b><small>合约腿名义</small></div></div></div>" +
        '<div class="legs">' + legHTML(o.legs[0]) + legHTML(o.legs[1]) + "</div>" +
        '<div class="order-foot"><div class="order-kv">' +
          "<div>已成交<b>" + usd(o.legs[0].notional + o.legs[1].notional, 0) + "</b></div>" +
          "<div>计划滑点<b>" + (o.slippageBps || 5).toFixed(1) + " bps</b></div>" +
          "<div>当前滑点<b>" + (o.status === "filled" ? (o.slippageBps + 0.4).toFixed(1) : "—") + " bps</b></div>" +
          (gap > 1 ? '<span class="gap-warn"><svg class="ic"><use href="#i-alert"/></svg>对冲缺口 ' + usd(gap, 0) + "</span>" : "") +
        "</div>" +
        '<div class="order-actions">' +
          (o.status !== "filled" ? '<button class="btn btn-sm btn-ghost" data-order-hedge="' + o.id + '"' + (app.kill ? ' disabled title="熔断中，补对冲已停止"' : "") + ">补对冲</button>" : "") +
          (o.status === "filled"
            ? '<button class="btn btn-sm btn-ghost" data-order-archive="' + o.id + '">归档</button>'
            : '<button class="btn btn-sm btn-danger-ghost" data-order-flat="' + o.id + '">立即平仓</button>') +
        "</div></div></article>";
    }).join("");

    const openOrders = app.orders.filter(o => o.status !== "filled");
    $("#ex-active").textContent = openOrders.length;
    $("#ex-active-notional").textContent = usd(openOrders.reduce((s, o) => s + o.notional, 0), 0);
    $("#ex-review").textContent = app.reviews.length;
    $("#tab-active-count").textContent = openOrders.length;
    $("#tab-review-count").textContent = app.reviews.length;
    $("#nav-exec-count").textContent = app.reviews.length;
    $("#nav-exec-count").style.display = app.reviews.length ? "" : "none";

    const empty = app.orders.length === 0;
    $("#order-list").hidden = empty;
    const orderEmpty = $("#order-empty");
    if (orderEmpty) orderEmpty.hidden = !empty;
  }

  function renderReviews() {
    const host = $("#review-list");
    if (!host) return;
    host.innerHTML = app.reviews.map(r => {
      const ev = D.events.find(e => e.id === r.evId);
      return '<article class="review" data-review="' + r.id + '">' +
        '<div class="review-top"><div>' +
          '<div class="review-reason"><svg class="ic"><use href="#i-alert"/></svg>' + esc(r.kind) + " · " + r.id + "</div>" +
          '<div class="order-title">' + esc(ev.title) + "</div>" +
          '<div class="order-sub"><span>' + esc(r.reason) + "</span></div>" +
        "</div>" +
        '<div style="text-align:right;flex:none"><span class="countdown" data-countdown="' + r.id + '">' + countdown(r.seconds) + "</span><small>自动平仓倒计时</small></div></div>" +
        '<div class="review-advice"><svg class="ic"><use href="#i-bolt"/></svg><span>引擎建议：<b>' + esc(r.advice) + "</b></span></div>" +
        '<div class="order-foot"><div class="order-kv"><div>已执行动作<b style="font-family:var(--font-ui);font-size:11px">' + esc(r.action) + "</b></div></div>" +
          '<div class="order-actions">' +
            '<button class="btn btn-sm btn-ghost" data-review-ignore="' + r.id + '">忽略</button>' +
            '<button class="btn btn-sm btn-danger-ghost" data-review-flat="' + r.id + '">立即平仓</button>' +
            '<button class="btn btn-sm btn-primary" data-review-take="' + r.id + '">接管</button>' +
          "</div></div></article>";
    }).join("");
    if (!app.reviews.length) {
      host.innerHTML = '<div class="empty"><svg class="ic"><use href="#i-check"/></svg><b>没有需要接管的订单</b><p>两条腿对齐、参数在阈值内，系统会自己处理。</p></div>';
    }
    const meta = $("#ex-review-meta");
    if (meta) {
      meta.textContent = app.reviews.length
        ? "最早 " + countdown(app.reviews.reduce((m, r) => Math.min(m, r.seconds), Infinity)) + " 后自动平仓"
        : "没有待接管的订单";
    }
    $("#tab-review-count").textContent = app.reviews.length;
    $("#nav-exec-count").textContent = app.reviews.length;
    $("#nav-exec-count").style.display = app.reviews.length ? "" : "none";
  }

  function autoFlattenReview(id) {
    const r = app.reviews.find(x => x.id === id);
    if (!r) return;
    const ev = D.events.find(e => e.id === r.evId);
    app.reviews = app.reviews.filter(x => x.id !== id);
    renderReviews();
    renderNav();
    logAudit("自动引擎", "自动平仓", ev ? ev.title : r.evId, "PM + HL", "接管倒计时结束，两条腿已按对手价平仓");
    toast("接管到期 · 已自动平仓", (ev ? ev.title : r.evId) + "：倒计时结束，系统已按预案平掉两条腿。", "warn");
  }

  /* 全部平仓：把执行台的未结订单、待接管队列与持仓账本一起清空。 */
  function flattenAll() {
    const b = book();
    const legs = b.rows.length * 2;
    const pnl = b.pnl;
    if (!legs && !app.orders.length && !app.reviews.length) {
      toast("没有可平的头寸", "执行台与持仓账本都已经是空的。");
      return;
    }
    app.orders = [];
    app.reviews = [];
    D.positions.length = 0;
    app.expanded = null;
    closeDrawer();
    renderOrders(); renderReviews(); renderPositions(); renderOverview(); renderTable(); renderRisk(); renderNav();
    logAudit("林 · 自营", "全部平仓", "全组合", "PM + HL",
      legs + " 条腿按对手价平仓，实现盈亏 " + signedUsd(pnl, 0) + "，账本清零");
    toast("全组合已平仓", legs + " 条腿已提交平仓，账本清零。已实现盈亏 " + signedUsd(pnl, 0) + "。", "warn");
  }

  function renderAudit() {
    const rows = app.audit.filter(a => app.auditActor === "all" || a.actor === app.auditActor);
    $("#audit-body").innerHTML = rows.map(a => {
      const dot = a.actor === "风控" ? "warn" : a.actor === "自动引擎" ? "ok" : "";
      return "<tr><td class=\"time\">" + a.t + '</td><td><span class="actor"><span class="dot ' + dot + '"></span>' + esc(a.actor) + "</span></td>" +
        "<td>" + esc(a.action) + "</td><td>" + esc(a.obj) + "</td><td class=\"muted\">" + esc(a.venue) + "</td>" +
        '<td class="detail">' + esc(a.detail) + "</td></tr>";
    }).join("");
    $("#audit-count").textContent = rows.length + " 条";
  }

  /* ---------------- positions ---------------- */
  function renderPositions() {
    const b = book();
    const rows = app.posFilter === "warn" ? b.rows.filter(r => r.ratio < 0.9) : b.rows;

    $("#pos-face").textContent = usd(b.face, 0);
    $("#pos-delta").textContent = usd(b.netDelta, 0);
    $("#pos-delta-pct").textContent = pct(b.netDelta / D.equityNow, 2);
    const deltaLimit = app.limits.find(l => l.id === "delta");
    if (deltaLimit) $("#pos-delta-limit").textContent = usd(deltaLimit.value, 0);
    $("#pos-margin").textContent = usd(b.margin, 0);
    $("#pos-pnl").textContent = signedUsd(b.pnl, 0);
    $("#pos-warn-count").textContent = b.undehedged;
    $("#pos-all-count").textContent = b.rows.length;
    const faceMeta = $("#pos-face-meta");
    if (faceMeta) faceMeta.textContent = b.rows.length + " 个事件 · " + Object.keys(b.byUnd).length + " 个标的";
    const distFace = $("#dist-face");
    if (distFace) distFace.textContent = "名义 " + compactUsd(b.face);
    const coverMeta = $("#pos-cover-meta");
    if (coverMeta) {
      coverMeta.textContent = b.target > 0
        ? "已覆盖 " + Math.round(b.hedge / b.target * 100) + "% 的 Delta 敞口"
        : "没有需要覆盖的 Delta 敞口";
    }
    $("#pos-pnl").className = "kpi-v num " + (b.pnl >= 0 ? "pos" : "neg");
    $("#hero-pnl").textContent = signedUsd(b.pnl, 0);
    $("#hero-unhedged").textContent = usd(b.netDelta, 0);
    $("#hero-util").textContent = pct((b.cost + b.margin) / D.equityNow);

    // distribution by underlying
    const totalFace = b.face || 1;
    const unds = Object.keys(b.byUnd).sort((a, z) => b.byUnd[z].face - b.byUnd[a].face);
    $("#dist-underlying").innerHTML = unds.length
      ? unds.map(u =>
          '<div class="dist-row"><span class="dist-k">' + u + '</span>' +
            '<span class="dist-bar"><i style="width:' + (b.byUnd[u].face / totalFace * 100).toFixed(1) + '%"></i></span>' +
            '<span class="dist-v">' + compactUsd(b.byUnd[u].face) + "<small>" + (b.byUnd[u].face / totalFace * 100).toFixed(1) + "%</small></span></div>"
        ).join("")
      : '<p class="note"><svg class="ic"><use href="#i-wallet"/></svg><span>还没有持仓。建立对冲组合后，这里会按标的拆开名义敞口。</span></p>';

    const buckets = [
      { k: "≤ 14 天", min: 0, max: 14 },
      { k: "15–45 天", min: 14, max: 45 },
      { k: "46–90 天", min: 45, max: 90 },
      { k: "> 90 天", min: 90, max: 9999 }
    ];
    const totalCost = b.cost || 1;
    $("#dist-tenor").innerHTML = b.rows.length
      ? buckets.map(bk => {
          const val = b.rows.filter(r => r.d.days > bk.min && r.d.days <= bk.max).reduce((s, r) => s + r.cost, 0);
          return '<div class="dist-row"><span class="dist-k">' + bk.k + '</span>' +
            '<span class="dist-bar"><i style="width:' + (val / totalCost * 100).toFixed(1) + '%"></i></span>' +
            '<span class="dist-v">' + compactUsd(val) + "<small>" + (val / totalCost * 100).toFixed(1) + "%</small></span></div>";
        }).join("")
      : '<p class="note"><svg class="ic"><use href="#i-clock"/></svg><span>还没有持仓。建仓后这里会按到期日拆分资金占用与保证金。</span></p>';

    $("#pos-body").innerHTML = rows.map(r => {
      const isOpen = app.expanded === r.evId;
      const ratioCls = r.ratio < 0.85 ? "low" : r.ratio < 0.95 ? "mid" : "";
      const main =
        '<tr class="row-main' + (isOpen ? " is-expanded" : "") + '" data-pos="' + r.evId + '" tabindex="0" aria-expanded="' + (isOpen ? "true" : "false") + '">' +
          '<td><div class="pos-title"><span class="ev-title">' + esc(r.ev.title) + "</span></div>" +
            '<div class="pos-sub"><span class="chip">' + esc(r.ev.und) + "</span><span>" + esc(r.ev.cat) + "</span></div></td>" +
          '<td class="num-col"><div class="hedge-cell">' + Math.round(r.qty).toLocaleString("en-US") + " 股<small>" + cents(r.avg) + " → " + cents(r.mark) + "</small></div></td>" +
          '<td class="num-col"><div class="hedge-cell">' + usd(r.hedgeUsd, 0) + "<small>" + esc(r.ev.und) + " @ " + usd(r.hedgeEntry, 1) + "</small></div></td>" +
          '<td class="num-col"><span class="ratio ' + ratioCls + '"><span class="ratio-bar"><i style="width:' + clamp(r.ratio * 100, 0, 100) + '%"></i></span><b>' + (r.ratio * 100).toFixed(0) + "%</b></span></td>" +
          '<td class="num-col"><div class="hedge-cell">' + (r.deltaUsd >= 0 ? "" : "−") + usd(Math.abs(r.deltaUsd), 0) + "<small>" + (r.deltaUsd > 0 ? "多向敞口" : "空向敞口") + "</small></div></td>" +
          '<td class="num-col"><div class="hedge-cell ' + (r.pnl >= 0 ? "pos" : "neg") + '">' + signedUsd(r.pnl, 0) + "<small>合约 " + signedUsd(r.contractPnl, 0) + "</small></div></td>" +
          '<td class="num-col"><div class="due-cell' + (r.d.days <= 7 ? " is-soon" : "") + '">' + dateShort(Date.parse(r.ev.due)) + "<small>" + daysText(r.d.days) + "</small></div></td>" +
          '<td><button class="row-go" data-align="' + r.evId + '" aria-label="对齐对冲腿"><svg class="ic"><use href="#i-refresh"/></svg></button></td>' +
        "</tr>";

      const detail = isOpen
        ? '<tr class="legd-row"><td colspan="8"><div class="legd">' +
            '<div class="legd-box"><div class="legd-h">合约腿 · POLYMARKET <span>' + esc(r.ev.id) + "</span></div><div class=\"legd-rows\">" +
              "<div><span>方向 / 数量</span><b>买入 YES · " + Math.round(r.qty).toLocaleString("en-US") + "</b></div>" +
              "<div><span>均价 / 标记</span><b>" + cents(r.avg) + " / " + cents(r.mark) + "</b></div>" +
              "<div><span>成本</span><b>" + usd(r.cost, 2) + "</b></div>" +
              "<div><span>未实现</span><b class=\"" + (r.contractPnl >= 0 ? "pos" : "neg") + "\">" + signedUsd(r.contractPnl, 2) + "</b></div>" +
            "</div></div>" +
            '<div class="legd-box"><div class="legd-h">对冲腿 · HYPERLIQUID <span>' + esc(r.ev.und) + "-PERP</span></div><div class=\"legd-rows\">" +
              "<div><span>规模 / 目标</span><b>" + usd(r.hedgeUsd, 0) + " / " + usd(r.target, 0) + "</b></div>" +
              "<div><span>入场 / 标记</span><b>" + usd(r.hedgeEntry, 2) + " / " + usd(r.mk.px, 2) + "</b></div>" +
              "<div><span>保证金</span><b>" + usd(r.hedgeUsd / 4.8, 0) + "</b></div>" +
              "<div><span>未实现</span><b class=\"" + (r.hedgePnl >= 0 ? "pos" : "neg") + "\">" + signedUsd(r.hedgePnl, 2) + "</b></div>" +
            "</div></div>" +
          "</div></td></tr>"
        : "";

      return main + detail;
    }).join("");

    // 空态：整体没有持仓，与"筛选后为空"是两种不同情况，文案不能共用。
    const posEmpty = $("#pos-empty");
    const posScroll = $("#view-positions .table-card .tbl-scroll");
    if (!b.rows.length) {
      if (posEmpty) posEmpty.hidden = false;
      if (posScroll) posScroll.style.display = "none";
    } else {
      if (posEmpty) posEmpty.hidden = true;
      if (posScroll) posScroll.style.display = "";
      if (!rows.length) {
        $("#pos-body").innerHTML = '<tr class="legd-row"><td colspan="8"><div class="empty" style="border:0;padding:26px 0"><svg class="ic"><use href="#i-check"/></svg><b>没有对冲不足的头寸</b><p>所有头寸的对冲比例都在 90% 以上，无需补单。</p></div></td></tr>';
      }
    }

    updateRiskLimits();
    updateRiskView();
  }

  function alignHedge(evId) {
    if (app.kill) { toast("已熔断", "熔断期间停止补对冲，请先在风控页解除。", "neg"); return; }
    const p = D.positions.find(x => x.evId === evId);
    if (!p) return;
    const v = D.positionView(p);
    if (v.ratio >= 0.999) { toast("已对齐", "该头寸的对冲比例已经达到目标。"); return; }
    const add = v.target - p.hedgeUsd;
    const mk = D.market[v.ev.und].px;
    p.hedgeEntry = (p.hedgeUsd * p.hedgeEntry + add * mk) / (p.hedgeUsd + add);
    p.hedgeUsd = v.target;
    renderPositions();
    logAudit("林 · 自营", "补对冲", v.ev.title, "HL",
      "追加 " + v.ev.und + "-PERP " + usd(add, 0) + "，对冲比例 " + (v.ratio * 100).toFixed(0) + "% → 100%");
    toast("补对冲已提交", v.ev.title + " · 追加 " + usd(add, 0) + " " + v.ev.und + "-PERP，对冲比例回到 100%。");
  }

  /* ---------------- risk ---------------- */
  function updateRiskLimits() {
    const map = limitMap();
    const host = $("#limit-list");
    if (!host) return;
    host.innerHTML = app.limits.map(l => {
      const v = map[l.id];
      const w = clamp(v.used / v.value * 100, 0, 100);
      const cls = w > 95 ? "is-neg" : w > 80 ? "is-warn" : "";
      const isEdit = app.editingLimit === l.id;
      const usedTxt = l.kind === "pct" ? v.used.toFixed(1) + "%" : compactUsd(v.used);
      const valTxt = l.kind === "pct" ? l.value + "%" : compactUsd(l.value);
      return '<div class="limit-item">' +
        '<div class="limit-name"><b>' + esc(l.name) + "</b><span>" + esc(l.desc) + "</span></div>" +
        '<div class="limit-meter"><i class="' + cls + '" style="width:' + w + '%"></i></div>' +
        '<div class="limit-right">' +
          (isEdit
            ? '<div class="limit-edit"><input type="number" id="limit-input" value="' + l.value + '" step="' + (l.kind === "pct" ? "1" : "10000") + '">' +
              '<div class="limit-actions"><button class="mini-btn ok" data-limit-save="' + l.id + '">存</button><button class="mini-btn" data-limit-cancel>×</button></div></div>'
            : '<div class="limit-val"><b>' + usedTxt + "</b><span>/ " + valTxt + "</span></div>" +
              '<button class="mini-btn" data-limit-edit="' + l.id + '">改</button>') +
        "</div>" +
        "</div>";
    }).join("");

    if (app.editingLimit) {
      const input = $("#limit-input");
      if (input) {
        input.focus();
        input.select();
        input.addEventListener("keydown", e => {
          if (e.key === "Enter") saveLimit(app.editingLimit);
          if (e.key === "Escape") { app.editingLimit = null; updateRiskLimits(); }
        });
      }
    }
  }

  function saveLimit(id) {
    const l = app.limits.find(x => x.id === id);
    const input = $("#limit-input");
    const val = Number(input.value);
    const map = limitMap();
    const min = map[id].used * 1.02;
    if (!val || val <= 0) { toast("数值无效", "限额必须大于 0。", "neg"); return; }
    if (val < min) {
      toast("不能低于当前占用", "当前占用 " + (l.kind === "pct" ? map[id].used.toFixed(1) + "%" : usd(map[id].used, 0)) + "，请留出至少 2% 缓冲。", "neg");
      return;
    }
    l.value = val;
    app.editingLimit = null;
    updateRiskLimits();
    renderOverview();
    logAudit("林 · 自营", "调整限额", l.name, "组合", "新上限 " + (l.kind === "pct" ? val + "%" : usd(val, 0)) + "，已同步至下单前校验");
    toast("限额已更新", l.name + " → " + (l.kind === "pct" ? val + "%" : usd(val, 0)) + "，已同步至下单前校验。");
  }

  function renderRules() {
    $("#rule-list").innerHTML = app.rules.map(r =>
      '<div class="rule"><div class="rule-body"><b>' + esc(r.name) + "</b><span>" + esc(r.desc) + "</span></div>" +
      '<button class="switch switch-sm" role="switch" aria-checked="' + r.on + '" data-rule="' + r.id + '" aria-label="' + esc(r.name) + '"><span class="knob"></span></button></div>'
    ).join("");
    const count = app.rules.filter(r => r.on).length;
    $(".rule-list").parentElement.querySelector(".card-h-sub").textContent = count + " / " + app.rules.length + " 启用";
  }

  function renderRiskCalendar() {
    const now = D.now();
    const rows = D.calendar.map(c => {
      const ev = D.events.find(e => e.id === c.evId);
      const pos = D.positions.find(p => p.evId === c.evId);
      const exposure = pos ? D.positionView(pos).cost : c.exposure;
      const days = (Date.parse(ev.due) - now) / 86400000;
      return { ev, days, exposure, note: c.note };
    }).sort((a, b) => a.days - b.days);

    $("#risk-calendar").innerHTML = rows.map(r =>
      '<div class="cal-row"><span class="cal-date">' + dateShort(Date.parse(r.ev.due)) + "<small>" + (r.days < 1 ? "今日" : Math.round(r.days) + " 天后") + "</small></span>" +
      '<span class="cal-title">' + esc(r.ev.title) + "<small>" + esc(r.note) + "</small></span>" +
      '<span class="cal-exp">' + compactUsd(r.exposure) + "<small>成本暴露</small></span></div>"
    ).join("");
  }

  function renderRiskFeed() {
    $("#risk-feed").innerHTML = D.riskEvents.map(e =>
      '<li><span class="feed-time">' + e.t + "</span>" +
        '<span class="dot ' + e.level + ' feed-dot"></span>' +
        '<div class="feed-body"><p><b>' + esc(e.title) + "</b></p><small>" + esc(e.detail) + "</small></div>" +
        '<span class="feed-val">' + esc(e.val) + "</span></li>"
    ).join("");
    $("#kp-check").textContent = clockStr();
    $("#risk-state").innerHTML = '<span class="dot ' + (app.kill ? "bad" : "ok") + '"></span>' +
      (app.kill ? "已熔断 · 等待人工解除" : "系统正常 · 全档运行");
  }

  function updateRiskView() {
    if ($("#limit-list")) updateRiskLimits();
    renderRiskCalendar();
  }

  function renderRisk() {
    updateRiskLimits();
    renderRules();
    renderRiskCalendar();
    renderRiskFeed();
    updateSystem();
  }

  /* ---------------- kill switch ---------------- */
  function killModal() {
    if (app.kill) {
      openModal({
        title: "解除熔断",
        sub: "解除后自动执行与补对冲会立即恢复。请确认场所连接与盘口正常。",
        body:
          '<div class="field"><label>解除原因</label><select id="kill-reason">' +
            "<option>盘口与连接已人工核验</option><option>误触发，无需停市</option><option>已完成风险排查</option></select></div>" +
          '<div class="warn-box"><svg class="ic"><use href="#i-shield"/></svg><p>解除后第一笔订单仍会走完整的两腿校验，<b>不会绕过</b>限额与延迟规则。</p></div>',
        actions: [
          { label: "保持熔断", kind: "btn-ghost" },
          { label: "确认解除", kind: "btn-primary", onClick: function () {
              const why = ($("#kill-reason") || {}).value || "人工确认";
              app.kill = false; app.auto = true;
              updateSystem(); renderOrders(); renderRisk(); renderTable();
              logAudit("风控", "解除熔断", "全组合", "组合", why + "；自动执行恢复，护栏规则继续生效");
              toast("已解除熔断", "自动执行恢复。限额、延迟与结算规则继续生效。");
            } }
        ]
      });
      return;
    }
    openModal({
      title: "确认熔断？",
      sub: "会立即撤销所有未成交挂单、停止新开仓与补对冲，已成交头寸保留在场。",
      body:
        '<div class="field"><label>触发原因</label><select id="kill-reason">' +
          "<option>场所报价异常 / 断线</option><option>盘口深度骤降</option><option>模型或数据异常</option><option>人工演练</option></select></div>" +
        '<div class="kvbox"><div><span>进行中订单</span><b>' + app.orders.filter(o => o.status !== "filled").length + " 笔</b></div>" +
          "<div><span>未成交挂单</span><b>12 笔</b></div>" +
          "<div><span>待接管</span><b>" + app.reviews.length + " 笔</b></div>" +
          '<div class="total"><span>预计撤单耗时</span><b>~240ms</b></div></div>' +
        '<div class="warn-box"><svg class="ic"><use href="#i-alert"/></svg><p>熔断<b>不会自动平仓</b>。已成交的合约腿与对冲腿会保留，避免在异常行情中制造额外滑点。</p></div>',
      actions: [
        { label: "取消", kind: "btn-ghost" },
        { label: "确认熔断", kind: "btn-danger", onClick: function () {
            const why = ($("#kill-reason") || {}).value || "人工触发";
            app.kill = true; app.auto = false;
            updateSystem(); renderOrders(); renderRisk(); renderTable();
            logAudit("风控", "熔断", "全组合", "PM + HL", why + "；挂单已撤销，新开仓与补对冲停止");
            toast("已触发熔断", "挂单已撤销，新开仓与补对冲停止。已有头寸保留。", "neg");
          } }
      ]
    });
  }

  /* ---------------- routing ---------------- */
  const routes = ["overview", "scanner", "execution", "positions", "risk"];
  const titles = { overview: "总览", scanner: "机会扫描", execution: "执行台", positions: "持仓", risk: "风控" };

  function parseHash() {
    const parts = (location.hash || "#/overview").replace(/^#\//, "").split("/");
    return {
      route: routes.indexOf(parts[0]) > -1 ? parts[0] : "overview",
      id: parts[1] || null
    };
  }

  function go(route, push) {
    if (routes.indexOf(route) < 0) route = "overview";
    app.route = route;
    $$(".view").forEach(v => { v.hidden = v.dataset.view !== route; });
    $$(".nav-item").forEach(n => {
      const on = n.dataset.route === route;
      n.classList.toggle("is-active", on);
      if (on) n.setAttribute("aria-current", "page"); else n.removeAttribute("aria-current");
    });
    $("#viewport").scrollTop = 0;
    document.title = "CONVERGENCE · " + titles[route];
    // 详情抽屉只属于扫描器：切到别的视图还挂着它，会遮住刚切过去的页面。
    if (!$("#drawer-root").hidden && route !== "scanner") closeDrawer();
    if (push !== false) history.replaceState(null, "", "#/" + route);
    if (route === "overview") {
      const v = $('[data-view="overview"]');
      v.classList.remove("is-entering"); void v.offsetWidth; v.classList.add("is-entering");
      renderChart();
    }
    if (route === "positions") renderPositions();
    if (route === "risk") renderRisk();
    if (route === "execution") { renderOrders(); renderReviews(); renderAudit(); }
  }

  window.addEventListener("hashchange", function () {
    const h = parseHash();
    if (h.route !== app.route) go(h.route, false);
    if (h.route === "scanner" && h.id && D.events.some(e => e.id === h.id)) {
      if (app.sel !== h.id) openDrawer(h.id);
    } else if (!$("#drawer-root").hidden) {
      closeDrawer();
    }
  });

  /* ---------------- static bindings ---------------- */
  $$(".nav-item").forEach(n => n.addEventListener("click", e => { e.preventDefault(); go(n.dataset.route); }));
  $$("[data-nav]").forEach(el => el.addEventListener("click", () => go(el.dataset.nav)));

  document.addEventListener("click", e => {
    const t = e.target.closest("[data-toast]");
    if (!t) return;
    toast(t.classList.contains("venue-pill") ? "场所连接" : "账户设置", t.dataset.toast);
  });

  $("#auto-switch").addEventListener("click", () => {
    if (app.kill) { toast("熔断中", "请先解除熔断。", "neg"); return; }
    app.auto = !app.auto;
    updateSystem();
    renderTable();
    toast(app.auto ? "自动执行已开启" : "自动执行已暂停", app.auto ? "满足阈值的信号会直接进入两腿执行。" : "信号只推送，不自动下单。", app.auto ? "ok" : "warn");
  });

  $("#kill-btn").addEventListener("click", killModal);
  $("#kill-page-btn").addEventListener("click", killModal);
  $("#banner-action").addEventListener("click", () => go(app.kill ? "risk" : "execution"));

  $("#rescan-btn").addEventListener("click", () => {
    app.scanSeq += 1;
    app.lastScan = Date.now();
    $("#scan-seq").textContent = "#" + app.scanSeq.toLocaleString("en-US");
    renderTable();
    toast("扫描完成", "412 个事件重算 1.8s，命中 " + computed().filter(r => r.net >= D.MIN_EDGE_CENTS).length + " 个净边信号。");
  });

  $("#q").addEventListener("input", e => { app.opp.q = e.target.value; renderTable(); });
  $("#cat-chips").addEventListener("click", e => {
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    app.opp.cat = b.dataset.cat;
    $$("#cat-chips .chip-btn").forEach(x => x.classList.toggle("is-on", x === b));
    renderTable();
  });
  $("#min-edge").addEventListener("change", e => { app.opp.minEdge = Number(e.target.value); renderTable(); });
  $("#horizon").addEventListener("change", e => { app.opp.horizon = e.target.value; renderTable(); });
  $("#only-ready").addEventListener("click", e => {
    app.opp.onlyReady = !app.opp.onlyReady;
    e.currentTarget.setAttribute("aria-checked", String(app.opp.onlyReady));
    renderTable();
  });
  $("#reset-filters").addEventListener("click", () => {
    app.opp = { q: "", cat: "all", minEdge: 2.5, horizon: "all", onlyReady: false, sortKey: "edge", sortDir: "desc" };
    $("#q").value = "";
    $("#min-edge").value = "2.5";
    $("#horizon").value = "all";
    $("#only-ready").setAttribute("aria-checked", "false");
    $$("#cat-chips .chip-btn").forEach(x => x.classList.toggle("is-on", x.dataset.cat === "all"));
    renderTable();
  });

  $("#opp-table thead").addEventListener("click", e => {
    const th = e.target.closest("th[data-sort]");
    if (!th) return;
    const k = th.dataset.sort;
    if (app.opp.sortKey === k) app.opp.sortDir = app.opp.sortDir === "desc" ? "asc" : "desc";
    else { app.opp.sortKey = k; app.opp.sortDir = k === "due" || k === "title" ? "asc" : "desc"; }
    renderTable();
  });

  $("#opp-body").addEventListener("click", e => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    openDrawer(tr.dataset.id);
  });
  $("#opp-body").addEventListener("keydown", e => {
    if (e.key !== "Enter" || !e.target.matches("tr[data-id]")) return;
    openDrawer(e.target.dataset.id);
  });

  $("#radar-list").addEventListener("click", e => {
    const row = e.target.closest("[data-open]");
    if (row) openDrawer(row.dataset.open);
  });

  $("#opp-cards").addEventListener("click", e => {
    const card = e.target.closest("[data-id]");
    if (card) openDrawer(card.dataset.id);
  });

  $$(".seg-btn").forEach(b => b.addEventListener("click", () => {
    $$(".seg-btn").forEach(x => x.setAttribute("aria-selected", "false"));
    b.setAttribute("aria-selected", "true");
    app.range = Number(b.dataset.range);
    renderChart();
  }));

  $$(".tab").forEach(t => t.addEventListener("click", () => {
    $$(".tab").forEach(x => x.setAttribute("aria-selected", "false"));
    t.setAttribute("aria-selected", "true");
    $$(".tab-panel").forEach(p => { p.hidden = p.dataset.panel !== t.dataset.tab; });
  }));

  $("#order-list").addEventListener("click", e => {
    const archive = e.target.closest("[data-order-archive]");
    if (archive) {
      const o = app.orders.find(x => x.id === archive.dataset.orderArchive);
      if (!o) return;
      app.orders = app.orders.filter(x => x.id !== o.id);
      renderOrders(); renderNav(); renderPositions();
      toast("已归档", o.id + " 已写入审计日志，不再占用执行台。");
      return;
    }
    const hedge = e.target.closest("[data-order-hedge]");
    if (hedge) {
      const o = app.orders.find(x => x.id === hedge.dataset.orderHedge);
      if (!o) return;
      o.legs[1].filled = o.legs[1].qty;
      o.legs[1].notional = o.legs[1].qty;
      o.legs[1].done = true;
      o.legs[1].note = "已按对手价补足 · 滑点 6.8bps";
      o.status = "filled"; o.statusText = "已成交";
      renderOrders();
      logAudit("林 · 自营", "补对冲", (D.events.find(e => e.id === o.evId) || {}).title || o.id, "HL",
        "按对手价补足缺口 " + usd(o.legs[1].qty - o.legs[1].filled, 0) + "，滑点 6.8bps");
      toast("补对冲完成", o.id + " 的对冲缺口已补足，两条腿对齐。");
      return;
    }
    const flat = e.target.closest("[data-order-flat]");
    if (flat) {
      const o = app.orders.find(x => x.id === flat.dataset.orderFlat);
      if (!o) return;
      openModal({
        title: "立即平仓",
        sub: o.id + " · " + (D.events.find(e => e.id === o.evId) || {}).title,
        body: '<div class="kvbox"><div><span>合约腿</span><b>卖出 ' + Math.round(o.legs[0].filled).toLocaleString("en-US") + " YES</b></div>" +
          "<div><span>对冲腿</span><b>平掉 " + Math.round(o.legs[1].filled).toLocaleString("en-US") + " " + (D.events.find(e => e.id === o.evId) || {}).und + "-PERP</b></div>" +
          '<div class="total"><span>预计滑点</span><b>8–14 bps</b></div></div>' +
          '<div class="warn-box"><svg class="ic"><use href="#i-alert"/></svg><p>平仓会同时释放两条腿；若其中一条腿失败，系统会保留另一条并在 30 秒内重试。</p></div>',
        actions: [
          { label: "取消", kind: "btn-ghost" },
          { label: "确认平仓", kind: "btn-danger", onClick: function () {
              app.orders = app.orders.filter(x => x.id !== o.id);
              renderOrders(); renderNav();
              logAudit("林 · 自营", "立即平仓", (D.events.find(e => e.id === o.evId) || {}).title || o.id, "PM + HL",
                o.id + " 两条腿同时提交平仓");
              toast("平仓指令已提交", o.id + " 两条腿同时平仓，预计 12 秒内完成。", "warn");
            } }
        ]
      });
    }
  });

  $("#review-list").addEventListener("click", e => {
    const take = e.target.closest("[data-review-take]");
    const flat = e.target.closest("[data-review-flat]");
    const ignore = e.target.closest("[data-review-ignore]");
    if (!take && !flat && !ignore) return;
    const id = (take || flat || ignore).dataset[take ? "reviewTake" : flat ? "reviewFlat" : "reviewIgnore"];
    const r = app.reviews.find(x => x.id === id);
    if (!r) return;
    const ev = D.events.find(x => x.id === r.evId);
    if (take) {
      openModal({
        title: "接管 " + r.id,
        sub: esc(ev.title),
        body: '<div class="field"><label>处置方式</label><select id="take-action">' +
            "<option value=\"shrink\">缩减规模，继续执行</option>" +
            "<option value=\"abort\">放弃机会，回滚合约腿</option>" +
            "<option value=\"hold\">保留裸敞口 30 分钟</option></select></div>" +
          '<div class="warn-box"><svg class="ic"><use href="#i-alert"/></svg><p>接管后该订单不再受自动规则保护，<b>需要你在 30 分钟内</b>确认最终状态。</p></div>',
        actions: [
          { label: "取消", kind: "btn-ghost" },
          { label: "确认接管", kind: "btn-primary", onClick: function () {
              const mode = ($("#take-action") || {}).value;
              app.reviews = app.reviews.filter(x => x.id !== id);
              renderReviews(); renderNav();
              logAudit("林 · 自营", "接管", ev.title, "PM + HL",
                (mode === "shrink" ? "缩减至盘口规模后重发第二腿" : mode === "abort" ? "放弃机会并回滚合约腿" : "保留裸敞口 30 分钟") + " · " + r.id);
              toast("已接管 " + r.id, mode === "shrink" ? "已按盘口可成交规模重发第二腿。" : mode === "abort" ? "已发出回滚指令，合约腿将在 5 分钟内清仓。" : "保留裸敞口，30 分钟后再次提醒。", "warn");
            } }
        ]
      });
    } else if (flat) {
      app.reviews = app.reviews.filter(x => x.id !== id);
      renderReviews(); renderNav();
      logAudit("林 · 自营", "立即平仓", ev.title, "PM + HL", "待接管订单 " + r.id + " 两条腿已提交平仓");
      toast("已平仓 " + r.id, "两条腿已同时提交平仓，预计 12 秒完成。", "warn");
    } else {
      app.reviews = app.reviews.filter(x => x.id !== id);
      renderReviews(); renderNav();
      logAudit("林 · 自营", "忽略待接管", ev.title, "组合", "标记 " + r.id + " 为已知风险，不再进入待接管队列");
      toast("已忽略 " + r.id, "已标记为已知风险，不再进入待接管队列。", "warn");
    }
  });

  $("#audit-chips").addEventListener("click", e => {
    const b = e.target.closest("[data-actor]");
    if (!b) return;
    app.auditActor = b.dataset.actor;
    $$("#audit-chips .chip-btn").forEach(x => x.classList.toggle("is-on", x === b));
    renderAudit();
  });

  $("#pos-body").addEventListener("click", e => {
    const align = e.target.closest("[data-align]");
    if (align) { e.stopPropagation(); alignHedge(align.dataset.align); return; }
    const row = e.target.closest("tr[data-pos]");
    if (!row) return;
    app.expanded = app.expanded === row.dataset.pos ? null : row.dataset.pos;
    renderPositions();
  });
  $("#pos-body").addEventListener("keydown", e => {
    if (e.key !== "Enter" || !e.target.matches("tr[data-pos]")) return;
    e.preventDefault();
    app.expanded = app.expanded === e.target.dataset.pos ? null : e.target.dataset.pos;
    renderPositions();
  });

  $$("[data-pos-filter]").forEach(b => b.addEventListener("click", () => {
    app.posFilter = b.dataset.posFilter;
    $$("[data-pos-filter]").forEach(x => x.classList.toggle("is-on", x === b));
    renderPositions();
  }));

  $("#hedge-all-btn").addEventListener("click", () => {
    if (!guard()) return;
    const b = book();
    const need = b.rows.filter(r => r.ratio < 0.999);
    if (!need.length) { toast("无需操作", "所有头寸的对冲比例都已在目标附近。"); return; }
    need.forEach(r => {
      const p = D.positions.find(x => x.evId === r.evId);
      const add = r.target - p.hedgeUsd;
      const mk = D.market[r.ev.und].px;
      if (add > 0) {
        p.hedgeEntry = (p.hedgeUsd * p.hedgeEntry + add * mk) / (p.hedgeUsd + add);
        p.hedgeUsd = r.target;
      }
    });
    renderPositions();
    toast("对冲腿已对齐", need.length + " 个头寸补足，净 Delta 敞口回到限额内。");
  });

  $("#flatten-all-btn").addEventListener("click", () => {
    const b = book();
    const legs = b.rows.length * 2;
    const openOrders = app.orders.filter(o => o.status !== "filled").length;
    openModal({
      title: "平掉全部头寸？",
      sub: b.rows.length + " 个事件 · " + legs + " 条腿同时提交，按当前盘口估计滑点 12–18bps。",
      body: '<div class="kvbox">' +
          "<div><span>持仓事件</span><b>" + b.rows.length + " 个 · 名义 " + compactUsd(b.face) + "</b></div>" +
          "<div><span>进行中订单</span><b>" + openOrders + " 笔</b></div>" +
          "<div><span>待接管</span><b>" + app.reviews.length + " 笔</b></div>" +
          '<div class="total"><span>当前未实现</span><b>' + signedUsd(b.pnl, 0) + "</b></div></div>" +
        '<div class="warn-box"><svg class="ic"><use href="#i-alert"/></svg><p>此操作<b>不可撤销</b>，会在 Polymarket 与 Hyperliquid 同时产生市价单，并把持仓账本清零。建议在盘口深度正常时执行。</p></div>',
      actions: [
        { label: "取消", kind: "btn-ghost" },
        { label: "确认全部平仓", kind: "btn-danger", onClick: function () { flattenAll(); } }
      ]
    });
  });

  $("#new-pos-btn").addEventListener("click", () => {
    if (!guard()) return;
    const ready = computed().filter(d => d.status === "ready" || d.status === "active").sort((a, b) => b.net - a.net).slice(0, 8);
    openModal({
      title: "建立对冲组合",
      sub: "手动选择事件与规模，系统会同时提交两条腿。",
      body: '<div class="field"><label>事件</label><select id="np-event">' +
          ready.map(d => '<option value="' + d.id + '">' + esc(d.title) + " · 净边 " + signedCents(d.net) + "</option>").join("") +
          '</select></div>' +
        '<div class="field"><label>合约腿成本（USDC）</label><input type="number" id="np-size" value="25000" min="1000" step="1000">' +
          '<span class="hint">对冲腿按事件 Delta 自动计算</span></div>' +
        '<div class="kvbox" id="np-preview"></div>',
      actions: [
        { label: "取消", kind: "btn-ghost" },
        { label: "建立组合", kind: "btn-primary", onClick: function () {
            const id = $("#np-event").value;
            const size = Number($("#np-size").value);
            const ev = D.events.find(e => e.id === id);
            const d = D.derive(ev);
            if (!size || size < 1000) { toast("规模过小", "最低 1,000 USDC。", "neg"); return false; }
            const qty = Math.floor(size / d.ask / 100) * 100;
            D.positions.push({ evId: id, qty: qty, avg: d.ask, hedgeUsd: qty * Math.abs(d.delta) * 0.96, hedgeEntry: D.market[ev.und].px });
            renderPositions(); renderTable(); renderOverview();
            logAudit("林 · 自营", "建立组合", ev.title, "PM + HL",
              "买入 " + qty.toLocaleString("en-US") + " YES @ " + cents(d.ask) + "；对冲 " + ev.und + "-PERP " + usd(qty * Math.abs(d.delta) * 0.96, 0));
            toast("组合已建立", ev.title + " · " + qty.toLocaleString("en-US") + " 股，两条腿已提交。");
            go("positions");
          } }
      ],
      onMount: function (modal) {
        const update = () => {
          const ev = D.events.find(e => e.id === $("#np-event", modal).value);
          const d = D.derive(ev);
          const size = Number($("#np-size", modal).value) || 0;
          const qty = Math.floor(size / d.ask / 100) * 100;
          $("#np-preview", modal).innerHTML =
            "<div><span>合约腿</span><b>" + qty.toLocaleString("en-US") + " YES @ " + cents(d.ask) + "</b></div>" +
            "<div><span>对冲腿</span><b>" + usd(qty * Math.abs(d.delta) * 0.96, 0) + " " + esc(ev.und) + "-PERP</b></div>" +
            "<div><span>预计净边</span><b>" + bps(d.netBps) + " bps</b></div>" +
            '<div class="total"><span>预期收益</span><b>' + signedUsd(qty * d.net / 100, 0) + "</b></div>";
        };
        $("#np-event", modal).addEventListener("change", update);
        $("#np-size", modal).addEventListener("input", update);
        update();
      }
    });
  });

  $("#limit-list").addEventListener("click", e => {
    const edit = e.target.closest("[data-limit-edit]");
    if (edit) { app.editingLimit = edit.dataset.limitEdit; updateRiskLimits(); return; }
    const save = e.target.closest("[data-limit-save]");
    if (save) { saveLimit(save.dataset.limitSave); return; }
    if (e.target.closest("[data-limit-cancel]")) { app.editingLimit = null; updateRiskLimits(); }
  });

  $("#reset-limits").addEventListener("click", () => {
    app.limits = D.limitDefaults.map(l => ({ ...l }));
    app.editingLimit = null;
    updateRiskLimits(); renderOverview();
    toast("限额已恢复默认", "所有限额回到策略基准值，已同步至下单前校验。");
  });

  $("#rule-list").addEventListener("click", e => {
    const b = e.target.closest("[data-rule]");
    if (!b) return;
    const r = app.rules.find(x => x.id === b.dataset.rule);
    r.on = !r.on;
    b.setAttribute("aria-checked", String(r.on));
    renderRules();
    logAudit("风控", r.on ? "启用规则" : "关闭规则", r.name, "组合", r.on ? "规则重新参与下单前校验" : "关闭期间不再拦截任何订单");
    toast(r.on ? "规则已启用" : "规则已关闭", r.name + (r.on ? " 已重新参与下单校验。" : " 关闭期间不会拦截任何订单，请确认风险可控。"), r.on ? "ok" : "warn");
  });

  $("#export-btn").addEventListener("click", () => {
    const rows = filterRows();
    const header = ["事件", "类别", "标的", "结算日", "剩余天数", "PM买价", "PM卖价", "HL公允", "毛边bps", "成本bps", "净边bps",
      "持有期回报%", "简单年化%", "可成交USDC", "对冲USDC", "置信度", "状态"];
    const csv = [header.join(",")].concat(rows.map(r => [
      '"' + r.title.replace(/"/g, '""') + '"', r.cat, r.und, dateFull(Date.parse(r.due)), r.days.toFixed(1),
      (r.bid * 100).toFixed(1), (r.ask * 100).toFixed(1), (r.fair * 100).toFixed(1),
      Math.round(r.grossBps), Math.round(r.costBps), Math.round(r.netBps),
      (r.holdReturn * 100).toFixed(2), (r.annualized > 999 ? ">999" : r.annualized.toFixed(1)),
      Math.round(r.depth), Math.round(r.hedgeUsd), r.conf, r.statusText
    ].join(","))).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "convergence-opportunities-" + dateStr() + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("日报已导出", rows.length + " 条机会明细，含净边、对冲规模与状态。");
  });

  $("#sync-btn").addEventListener("click", () => {
    toast("场所已同步", "Polymarket 持仓 9 笔、Hyperliquid 9 条腿，账本差异 $0.00。");
  });

  $(".drawer-scrim").addEventListener("click", () => closeDrawer());
  $(".modal-scrim").addEventListener("click", () => closeModal());

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if (!$("#modal-root").hidden) { closeModal(); return; }
      if (!$("#drawer-root").hidden) { closeDrawer(); return; }
    }
    if (!$("#modal-root").hidden || !$("#drawer-root").hidden) return;
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const map = { "1": "overview", "2": "scanner", "3": "execution", "4": "positions", "5": "risk" };
    if (map[e.key]) { e.preventDefault(); go(map[e.key]); }
  });

  /* ---------------- live loop ---------------- */
  function tickClock() {
    $("#clock").textContent = clockStr();
    $("#scan-ago").textContent = ((Date.now() - app.lastScan) / 1000).toFixed(1) + "s 前";
    $("#last-scan").textContent = ((Date.now() - app.lastScan) / 1000).toFixed(1) + "s 前";
    $("#radar-updated").textContent = ((Date.now() - app.lastScan) / 1000).toFixed(1) + "s";

    const expired = [];
    $$("[data-countdown]").forEach(el => {
      const r = app.reviews.find(x => x.id === el.dataset.countdown);
      if (!r) return;
      r.seconds = Math.max(0, r.seconds - 1);
      el.textContent = countdown(r.seconds);
      if (r.seconds === 0) expired.push(r.id);
    });
    // 倒计时归零必须真的执行"自动平仓"，否则界面在许诺一个不会发生的事。
    expired.forEach(id => autoFlattenReview(id));

    const meta = $("#ex-review-meta");
    if (meta && app.reviews.length) {
      meta.textContent = "最早 " + countdown(app.reviews.reduce((m, r) => Math.min(m, r.seconds), Infinity)) + " 后自动平仓";
    }
  }

  function tickQuotes() {
    const pool = D.events;
    const baseQ = D.base.quotes;
    const seen = new Set();
    for (let k = 0; k < 4; k++) {
      // 八成落在展示中的样本上，剩下的分给整个扫描面，表格不会看起来是静止的。
      const span = Math.random() < 0.8 ? D.CURATED_COUNT : pool.length;
      const i = Math.floor(Math.random() * span);
      if (seen.has(i)) continue;
      seen.add(i);
      const ev = pool[i], b = baseQ[i];
      // 8% 回归 + 小额噪声：报价围着基准呼吸，页面开几小时也不会漂到 95¢ 边界。
      ev.ask = clamp(ev.ask + (b.ask - ev.ask) * 0.08 + (Math.random() - 0.5) * 0.0032, 0.02, 0.96);
      ev.fair = clamp(ev.fair + (b.fair - ev.fair) * 0.08 + (Math.random() - 0.5) * 0.0032, 0.02, 0.97);
      ev.bid = clamp(ev.bid + (b.bid - ev.bid) * 0.08 + (Math.random() - 0.5) * 0.0022, 0.01, ev.ask - 0.002);
    }
    const m = D.market, bm = D.base.market;
    const revert = (cur, base, noise, lo, hi) => clamp(cur + (base - cur) * 0.06 + (Math.random() - 0.5) * noise, lo, hi);
    m.BTC.px = revert(m.BTC.px, bm.BTC.px, 16, bm.BTC.px * 0.9, bm.BTC.px * 1.1);
    m.ETH.px = revert(m.ETH.px, bm.ETH.px, 1.6, bm.ETH.px * 0.9, bm.ETH.px * 1.1);
    m.SOL.px = revert(m.SOL.px, bm.SOL.px, 0.14, bm.SOL.px * 0.9, bm.SOL.px * 1.1);
    m.HYPE.px = revert(m.HYPE.px, bm.HYPE.px, 0.09, bm.HYPE.px * 0.82, bm.HYPE.px * 1.18);
    m.BTC.chg = revert(m.BTC.chg, bm.BTC.chg, 0.06, -8, 8);
    m.ETH.chg = revert(m.ETH.chg, bm.ETH.chg, 0.08, -10, 10);
    m.HYPE.chg = revert(m.HYPE.chg, bm.HYPE.chg, 0.10, -12, 12);
    m.SOL.chg = revert(m.SOL.chg, bm.SOL.chg, 0.06, -10, 10);

    renderPulse();
    app.lastScan = Date.now() - Math.floor(Math.random() * 420);
    if (Math.random() < 0.22) {
      app.scanSeq += 1;
      const seq = $("#scan-seq");
      if (seq) seq.textContent = "#" + app.scanSeq.toLocaleString("en-US");
    }
    if (app.route === "scanner") updateLiveCells();
    if (app.route === "overview") updateRadarCells();
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (app.route === "overview") { renderChart(); renderSpark(); }
    }, 160);
  });

  /* ---------------- boot ---------------- */
  function init() {
    renderPulse();
    renderOverview();
    renderNav();
    renderTable();
    renderOrders();
    renderReviews();
    renderAudit();
    renderPositions();
    renderRisk();
    updateSystem();

    const h = parseHash();
    go(h.route, false);
    if (h.route === "scanner" && h.id && D.events.some(e => e.id === h.id)) {
      setTimeout(function () { openDrawer(h.id); }, 40);
    }

    setInterval(tickClock, 1000);
    setInterval(tickQuotes, 2400);
    tickClock();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
