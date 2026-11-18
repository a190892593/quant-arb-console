/* ============================================================
   CONVERGENCE · 无依赖验收脚本

   用法：node tools/verify.mjs
   需要本机已安装 Chrome 或 Edge（headless 运行，不打开窗口）。
   退出码 0 表示全部通过，1 表示有失败项。

   它做三件事：
   1. 用 DevTools 协议把页面跑在真实 Chromium 里，捕获 JS 异常与 console 报错；
   2. 走一遍关键交互（扫描 → 详情 → 下单 → 对冲成交 → 熔断 → 平仓 → 风控）；
   3. 断言页面不产生横向滚动，并把失败项连同比对值打出来。
   ============================================================ */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "event-arb-console.html");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- 找浏览器 ---------------- */
function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  return candidates.find(p => existsSync(p)) || null;
}

/* ---------------- 极简 CDP 客户端 ---------------- */
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("无法连接到浏览器调试端口")), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
      return;
    }
    for (const l of listeners.slice()) l(msg);
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return {
    send,
    on: (method, cb) => listeners.push(m => { if (m.method === method) cb(m.params); }),
    once: (method, cb) => {
      const h = m => { if (m.method === method) { listeners.splice(listeners.indexOf(h), 1); cb(m.params); } };
      listeners.push(h);
    },
  };
}

async function launch(port) {
  const bin = findBrowser();
  if (!bin) {
    console.error("没有找到 Chrome / Edge。设置 CHROME_PATH 指向可执行文件后重试。");
    process.exit(2);
  }
  const profile = mkdtempSync(join(tmpdir(), "conv-verify-"));
  const proc = spawn(bin, [
    "--headless=new",
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + profile,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--hide-scrollbars", "--allow-file-access-from-files", "--no-sandbox",
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });

  let target = null;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
      if (r.ok) { target = await r.json(); break; }
    } catch { /* 端口还没起来 */ }
    await sleep(120);
  }
  if (!target) { proc.kill(); throw new Error("浏览器调试端口未就绪"); }

  const page = await connect(target.webSocketDebuggerUrl);
  const errors = { exceptions: [], console: [] };
  page.on("Runtime.exceptionThrown", e => errors.exceptions.push(e.exceptionDetails.text + " " + (e.exceptionDetails.exception?.description || "")));
  page.on("Runtime.consoleAPICalled", e => {
    if (e.type === "error") errors.console.push(e.args.map(a => a.value ?? a.description).join(" "));
  });
  page.on("Log.entryAdded", e => { if (e.entry.level === "error") errors.console.push(e.entry.text); });
  page.on("Page.javascriptDialogOpening", () => page.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}));

  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Log.enable");
  await page.send("Network.enable");
  return { proc, page, errors };
}

/* ---------------- 断言 ---------------- */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  if (!ok) console.log(`  ✗ ${name}${detail === undefined ? "" : "  → " + detail}`);
}

const URL = pathToFileURL(APP).href;
const PORT = 9500 + Math.floor(Math.random() * 400);

const browser = await launch(PORT);
const page = browser.page;
const wait = ms => sleep(ms);

const evaluate = async expression => {
  const r = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const viewport = (width, height, mobile = false) =>
  page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
const goto = async (url, waitMs = 700) => {
  const loaded = new Promise(res => page.once("Page.loadEventFired", res));
  await page.send("Page.navigate", { url });
  await Promise.race([loaded, sleep(8000)]);
  await wait(waitMs);
};

try {
  console.log("CONVERGENCE · 验收");
  await viewport(1600, 1000);
  await goto(URL + "?debug=1", 1600);

  /* ---------- 1. 五个视图都能渲染 ---------- */
  for (const route of ["overview", "scanner", "execution", "positions", "risk"]) {
    await evaluate(`location.hash = "#/${route}"`);
    await wait(280);
    const shown = await evaluate(`[...document.querySelectorAll('.view')].filter(v => !v.hidden).map(v => v.dataset.view)`);
    check(`视图 ${route} 单独显示`, shown.length === 1 && shown[0] === route, JSON.stringify(shown));
  }

  const counts = await evaluate(`(() => ({
    radar: document.querySelectorAll('#radar-list .radar-row').length,
    opp: document.querySelectorAll('#opp-body tr').length,
    orders: document.querySelectorAll('#order-list .order').length,
    reviews: document.querySelectorAll('#review-list .review').length,
    positions: document.querySelectorAll('#pos-body tr.row-main').length,
    limits: document.querySelectorAll('#limit-list .limit-item').length,
    rules: document.querySelectorAll('#rule-list .rule').length,
    chart: !!document.querySelector('#equity-chart svg'),
    spark: !!document.querySelector('#hero-spark svg')
  }))()`);
  check("总览：雷达 5 条 + 两张图", counts.radar === 5 && counts.chart && counts.spark, JSON.stringify(counts));
  check("扫描：29 条机会", counts.opp === 29, String(counts.opp));
  check("执行台：订单与待接管都有内容", counts.orders === 4 && counts.reviews === 3, JSON.stringify(counts));
  check("持仓：9 个头寸", counts.positions === 9, String(counts.positions));
  check("风控：5 项限额 + 5 条规则", counts.limits === 5 && counts.rules === 5, JSON.stringify(counts));

  /* ---------- 2. 扫描器筛选与排序 ---------- */
  await evaluate(`location.hash = "#/scanner"`);
  await wait(300);
  await evaluate(`(() => { const el = document.querySelector('#q'); el.value = 'zzzz'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const emptyState = await evaluate(`(() => ({
    empty: !document.querySelector('#opp-empty').hidden,
    rows: document.querySelectorAll('#opp-body tr').length,
    hidden: getComputedStyle(document.querySelector('#view-scanner .tbl-scroll')).display === 'none'
  }))()`);
  check("扫描器：无匹配时显示空态并隐藏表格", emptyState.empty && emptyState.rows === 0 && emptyState.hidden, JSON.stringify(emptyState));
  await evaluate(`document.querySelector('#reset-filters').click()`);
  await wait(200);
  check("扫描器：重置筛选恢复 29 条", (await evaluate(`document.querySelectorAll('#opp-body tr').length`)) === 29);

  await evaluate(`document.querySelectorAll('#opp-table thead th')[2].click()`);
  check("扫描器：点击表头按净边排序",
    (await evaluate(`document.querySelector('#opp-table th.is-sorted')?.dataset.sort`)) === "edge");

  await evaluate(`document.querySelector('#only-ready').click()`);
  const onlyReady = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#opp-body tr')];
    return rows.length > 0 && rows.every(tr => /可执行/.test(tr.querySelector('[data-f=status]').textContent));
  })()`);
  check("扫描器：仅可执行过滤生效", onlyReady);
  await evaluate(`document.querySelector('#only-ready').click()`);

  /* ---------- 3. 详情 → 下单 → 对冲成交 ---------- */
  await evaluate(`document.querySelector('#opp-body tr').click()`);
  await wait(300);
  const drawer = await evaluate(`(() => ({
    open: !document.querySelector('#drawer-root').hidden,
    title: document.querySelector('.drawer-title')?.textContent,
    marks: document.querySelectorAll('.ruler-mark').length,
    legs: document.querySelectorAll('.plan-leg').length,
    cta: document.querySelector('#execute-btn')?.textContent.trim()
  }))()`);
  check("详情抽屉：标尺 + 两腿计划 + 主操作", drawer.open && drawer.marks === 2 && drawer.legs === 2 && drawer.cta === "执行套利", JSON.stringify(drawer));

  await evaluate(`document.querySelector('#execute-btn').click()`);
  await wait(250);
  check("下单确认框：数量与预览齐备", await evaluate(`!document.querySelector('#modal-root').hidden && document.querySelectorAll('#exec-preview > div').length >= 4`));

  await evaluate(`(() => { const el = document.querySelector('#size-qty'); el.value = '99999999'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('#modal .btn-primary').click()`);
  await wait(200);
  check("下单确认框：越界数量被拦下", (await evaluate(`!document.querySelector('#modal-root').hidden`)) === true);

  const before = await evaluate(`document.querySelectorAll('#order-list .order').length`);
  const idBefore = await evaluate(`__convApp.orders.map(o => o.id)`);
  const posBefore = await evaluate(`CONV.positions.length`);
  await evaluate(`(() => { const el = document.querySelector('#size-qty'); el.value = '4000'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('#modal .btn-primary').click()`);
  await wait(400);
  const after = await evaluate(`(() => ({
    n: document.querySelectorAll('#order-list .order').length,
    ids: __convApp.orders.map(o => o.id),
    drawerClosed: document.querySelector('#drawer-root').hidden
  }))()`);
  check("下单后新订单进入执行台", after.n === before + 1 && after.drawerClosed, JSON.stringify(after));
  check("订单号不重复", new Set(after.ids).size === after.ids.length && after.ids.filter(x => !idBefore.includes(x)).length === 1, JSON.stringify(after.ids));

  await wait(4800);
  const filled = await evaluate(`(() => {
    const o = document.querySelector('#order-list .order');
    return { full: o.querySelectorAll('.leg.full').length, positions: CONV.positions.length };
  })()`);
  check("对冲腿自动成交、两腿对齐", filled.full === 2, JSON.stringify(filled));
  check("成交后头寸进入持仓账本", filled.positions === posBefore + 1, JSON.stringify(filled));

  /* ---------- 4. 熔断与恢复 ---------- */
  await evaluate(`document.querySelector('#kill-btn').click()`);
  await wait(250);
  await evaluate(`document.querySelector('#modal .btn-danger').click()`);
  await wait(300);
  const killed = await evaluate(`(() => ({
    banner: !document.querySelector('#global-banner').hidden,
    kind: document.querySelector('#global-banner').classList.contains('is-kill'),
    switchOff: document.querySelector('#auto-switch').disabled,
    mode: document.querySelector('#sys-mode').textContent
  }))()`);
  check("熔断：全站横幅 + 自动执行禁用", killed.banner && killed.kind && killed.switchOff && /熔断/.test(killed.mode), JSON.stringify(killed));

  await evaluate(`location.hash = "#/risk"`);
  await wait(300);
  await evaluate(`document.querySelector('#kill-page-btn').click()`);
  await wait(250);
  await evaluate(`document.querySelector('#modal .btn-primary').click()`);
  await wait(300);
  check("熔断解除后恢复自动执行",
    (await evaluate(`document.querySelector('#global-banner').hidden && /全自动/.test(document.querySelector('#sys-mode').textContent)`)) === true);

  /* ---------- 5. 风控限额校验 ---------- */
  await evaluate(`document.querySelector('[data-limit-edit]').click()`);
  await wait(200);
  check("风控：限额可编辑", (await evaluate(`!!document.querySelector('#limit-input')`)) === true);
  await evaluate(`(() => { document.querySelector('#limit-input').value = '1'; })()`);
  await evaluate(`document.querySelector('[data-limit-save]').click()`);
  await wait(200);
  check("风控：低于当前占用的限额被拒", (await evaluate(`!!document.querySelector('#limit-input')`)) === true);
  await evaluate(`(() => { document.querySelector('#limit-input').value = '2000000'; })()`);
  await evaluate(`document.querySelector('[data-limit-save]').click()`);
  await wait(250);
  check("风控：合法限额保存生效", (await evaluate(`!document.querySelector('#limit-input')`)) === true);

  /* ---------- 6. 倒计时到期自动平仓 ---------- */
  await evaluate(`location.hash = "#/execution"`);
  await wait(300);
  await evaluate(`[...document.querySelectorAll('.tab')].find(t => t.dataset.tab === 'review').click()`);
  const revBefore = await evaluate(`__convApp.reviews.length`);
  await evaluate(`(() => { __convApp.reviews[0].seconds = 1; })()`);
  await wait(2400);
  const revAfter = await evaluate(`(() => ({
    n: __convApp.reviews.length,
    action: __convApp.audit[0].action,
    toast: [...document.querySelectorAll('#toasts .toast-body b')].map(b => b.textContent).join('|')
  }))()`);
  check("待接管倒计时归零 → 自动平仓并记审计", revAfter.n === revBefore - 1 && revAfter.action === "自动平仓", JSON.stringify(revAfter));

  /* ---------- 7. 全部平仓与空态 ---------- */
  await evaluate(`location.hash = "#/execution"`);
  await wait(250);
  await evaluate(`document.querySelector('#flatten-all-btn').click()`);
  await wait(250);
  check("全部平仓：确认框列出实时笔数", await evaluate(`/持仓事件/.test(document.querySelector('#modal .modal-b').textContent)`));
  await evaluate(`[...document.querySelectorAll('#modal .modal-f .btn')].find(b => /确认全部平仓/.test(b.textContent)).click()`);
  await wait(500);
  const flat = await evaluate(`(() => ({
    pos: CONV.positions.length,
    orders: __convApp.orders.length,
    reviews: __convApp.reviews.length,
    orderEmpty: !document.querySelector('#order-empty').hidden,
    face: document.querySelector('#pos-face').textContent
  }))()`);
  check("全部平仓：账本、订单、待接管全部清零", flat.pos === 0 && flat.orders === 0 && flat.reviews === 0 && flat.face === "$0", JSON.stringify(flat));
  check("全部平仓：执行台显示空态", flat.orderEmpty);

  await evaluate(`location.hash = "#/positions"`);
  await wait(400);
  const posEmpty = await evaluate(`(() => ({
    empty: !document.querySelector('#pos-empty').hidden,
    hidden: getComputedStyle(document.querySelector('#view-positions .table-card .tbl-scroll')).display === 'none',
    all: document.querySelector('#pos-all-count').textContent
  }))()`);
  check("持仓：空态文案与计数归零", posEmpty.empty && posEmpty.hidden && posEmpty.all === "0", JSON.stringify(posEmpty));

  await evaluate(`location.hash = "#/overview"`);
  await wait(500);
  const ov = await evaluate(`(() => ({
    util: document.querySelector('#hero-util').textContent,
    pnl: document.querySelector('#hero-pnl').textContent,
    delta: document.querySelector('#kpi-delta').textContent
  }))()`);
  check("空账本下总览仍自洽", ov.util === "0.0%" && ov.pnl === "+$0" && ov.delta === "$0", JSON.stringify(ov));

  /* ---------- 8. 响应式：页面永不横滚 ---------- */
  const offenders = [];
  for (const width of [1600, 1280, 1024, 900, 768, 700, 480, 390]) {
    await viewport(width, 900, width <= 700);
    await goto(URL, 600);
    for (const route of ["overview", "scanner", "execution", "positions", "risk"]) {
      await evaluate(`location.hash = "#/${route}"`);
      await wait(220);
      const m = await evaluate(`({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth })`);
      if (m.scrollW > m.clientW + 1) offenders.push(width + ":" + route);
    }
  }
  check("8 档宽度 × 5 个视图都不产生横向滚动", offenders.length === 0, offenders.join(","));

  await viewport(390, 844, true);
  await goto(URL, 800);
  await evaluate(`location.hash = "#/scanner"`);
  await wait(350);
  const mobile = await evaluate(`(() => ({
    cards: getComputedStyle(document.querySelector('#opp-cards')).display,
    table: getComputedStyle(document.querySelector('#view-scanner .tbl-scroll')).display,
    cardCount: document.querySelectorAll('#opp-cards .opp-card').length
  }))()`);
  check("移动端：机会表切换为卡片列表", mobile.cards === "flex" && mobile.table === "none" && mobile.cardCount > 0, JSON.stringify(mobile));

  /* ---------- 9. 无运行时报错 ---------- */
  check("没有未捕获的 JS 异常", browser.errors.exceptions.length === 0, JSON.stringify(browser.errors.exceptions));
  check("没有 console 报错", browser.errors.console.length === 0, JSON.stringify(browser.errors.console));
} catch (err) {
  console.error("\n验收脚本自身出错：" + err.message);
  results.push({ name: "脚本执行", ok: false });
} finally {
  try { await page.send("Browser.close"); } catch {}
  try { browser.proc.kill(); } catch {}
}

const failed = results.filter(r => !r.ok);
console.log("\n结果：" + (results.length - failed.length) + "/" + results.length + " 通过");
if (failed.length) {
  console.log("失败项：");
  failed.forEach(f => console.log("  - " + f.name));
}
process.exit(failed.length ? 1 : 0);
