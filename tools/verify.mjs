/* ============================================================
   CONVERGENCE · end-to-end verification
   Starts a real server with an isolated SQLite database, drives a
   headless Chromium through the terminal and admin console, and
   asserts the same behaviours the product promises.
   ============================================================ */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok || detail === undefined ? "" : "  → " + detail));
}

function findBrowser() {
  return [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean).find(p => existsSync(p));
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("CDP connect failed")), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
      return;
    }
    for (const l of listeners.slice()) l(msg);
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { send, on: fn => listeners.push(fn), close: () => ws.close() };
}

async function launchBrowser(port) {
  const bin = findBrowser();
  if (!bin) throw new Error("Chrome/Edge not found; set CHROME_PATH");
  const profile = mkdtempSync(join(tmpdir(), "conv-e2e-"));
  const proc = spawn(bin, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
    "--no-sandbox", "about:blank"
  ], { stdio: "ignore", windowsHide: true });
  let target = null;
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
      if (r.ok) { target = await r.json(); break; }
    } catch { /* not ready */ }
    await sleep(120);
  }
  if (!target) { proc.kill(); throw new Error("browser debug port not ready"); }
  const page = await connect(target.webSocketDebuggerUrl);
  const errors = { exceptions: [], console: [] };
  page.on(m => {
    if (m.method === "Runtime.exceptionThrown") errors.exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.console.push(m.params.args.map(a => a.value ?? a.description).join(" "));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") errors.console.push(m.params.entry.text);
  });
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Log.enable");
  return { proc, page, errors };
}

async function waitForServer(base) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(base + "/api/health");
      if (r.ok) return await r.json();
    } catch { /* not ready */ }
    await sleep(200);
  }
  throw new Error("server did not become ready");
}

const browserPort = 9400 + Math.floor(Math.random() * 300);
const appPort = 8800 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${appPort}`;
const dbDir = mkdtempSync(join(tmpdir(), "conv-e2e-db-"));
const dbPath = join(dbDir, "app.db");

const server = spawn(process.execPath, [join(ROOT, "dist", "index.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(appPort),
    HOST: "127.0.0.1",
    DB_PATH: dbPath,
    MARKET_DATA_MODE: "demo",
    SEED_TEST_FIXTURE: "1",
    PM_ENABLED: "false",
    HL_ENABLED: "false",
    LOG_LEVEL: "silent",
    NODE_ENV: "test"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverLog = "";
server.stdout.on("data", d => { serverLog += d.toString(); });
server.stderr.on("data", d => { serverLog += d.toString(); });

let browser;
try {
  console.log("CONVERGENCE · 全栈验收");
  const health = await waitForServer(base);
  check("服务端健康检查", health.ok === true, JSON.stringify(health));

  browser = await launchBrowser(browserPort);
  const { page, errors } = browser;
  const evaluate = async expression => {
    const r = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const goto = async (url, wait = 900) => {
    await page.send("Page.navigate", { url });
    await sleep(wait);
  };
  const shot = async name => {
    const s = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(ROOT, "preview", name), Buffer.from(s.data, "base64"));
  };

  await page.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await goto(base + "/login", 700);
  await shot("live-login.png");
  await evaluate(`document.querySelector('[data-demo="admin@convergence.local"]').click()`);
  await evaluate(`document.querySelector('#login-form').requestSubmit()`);
  await sleep(1800);
  console.log("LOGIN_DEBUG", JSON.stringify({ path: await evaluate("location.pathname"), title: await evaluate("document.title") }));
  check("登录后进入总览", (await evaluate("location.pathname")) === "/" && (await evaluate("document.title")).includes("总览"));

  const counts = await evaluate(`({
    radar: document.querySelectorAll('#radar-list .radar-row').length,
    opp: document.querySelectorAll('#opp-body tr').length,
    orders: document.querySelectorAll('#order-list .order').length,
    reviews: document.querySelectorAll('#review-list .review').length,
    positions: document.querySelectorAll('#pos-body tr.row-main').length,
    limits: document.querySelectorAll('#limit-list .limit-item').length,
    rules: document.querySelectorAll('#rule-list .rule').length,
    chart: !!document.querySelector('#equity-chart svg'),
    spark: !!document.querySelector('#hero-spark svg')
  })`);
  check("总览渲染：雷达、净值曲线、迷你曲线", counts.radar === 5 && counts.chart && counts.spark, JSON.stringify(counts));
  check("工作区数据齐全", counts.orders >= 1 && counts.positions >= 1 && counts.limits === 5 && counts.rules >= 16, JSON.stringify(counts));

  for (const route of ["scanner", "execution", "positions", "risk", "overview"]) {
    await evaluate(`location.hash = "#/${route}"`);
    await sleep(300);
    const shown = await evaluate(`[...document.querySelectorAll('.view')].filter(v => !v.hidden).map(v => v.dataset.view)`);
    check(`视图 ${route} 单独显示`, shown.length === 1 && shown[0] === route, JSON.stringify(shown));
  }

  await evaluate(`location.hash = "#/accounts"`);
  await sleep(400);
  const accountView = await evaluate(`({
    cards: document.querySelectorAll('#acct-grid .acct-card').length,
    rows: document.querySelectorAll('#acct-table tr').length,
    code: document.querySelector('#acct-code').textContent
  })`);
  check("账户矩阵：五个独立账户", accountView.cards === 5 && accountView.rows === 5, JSON.stringify(accountView));  await evaluate(`document.querySelector('[data-acct-enter="converge"]').click()`);
  await sleep(1400);
  const switched = await evaluate(`({ code: document.querySelector('#acct-code').textContent, name: document.querySelector('#acct-name').textContent, route: location.hash })`);
  check("切换账户后整个操作台切换账本", switched.code === "S2" && switched.route === "#/overview", JSON.stringify(switched));
  await evaluate(`document.querySelector('#acct-btn').click()`);
  await sleep(150);
  await evaluate(`document.querySelector('[data-acct-switch="prob"]').click()`);
  await sleep(1400);
  check("切回原账户", (await evaluate(`document.querySelector('#acct-code').textContent`)) === "S1");
  await evaluate(`location.hash = "#/accounts"`);
  await sleep(400);
  await shot("live-accounts.png");

  await evaluate(`location.hash = "#/scanner"`);
  await sleep(400);
  const hedgeLabel = await evaluate(`document.querySelector('#opp-body tr .hedge-cell small')?.textContent || ""`);
  check("扫描器显示真实 Delta 倍数与对冲方向", /x/.test(hedgeLabel) && /做空|做多/.test(hedgeLabel), hedgeLabel);
  const neutral = await evaluate(`(async () => {
    const r = await fetch('/api/state?account=prob'); const s = (await r.json()).state;
    return { net: s.book.netDelta, cost: s.book.cost, ratios: s.book.rows.map(x => x.ratio), sides: s.book.rows.map(x => x.hedgeSide) };
  })()`);
  check("账户初始账本为真实 Delta 中性", Math.abs(neutral.net) < Math.max(100, neutral.cost * 0.03) && neutral.ratios.every(r => Math.abs(r - 1) < 0.05), JSON.stringify(neutral));
  await evaluate(`(() => { const el = document.querySelector('#q'); el.value = 'zzzz-no-match'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check("扫描器空态", await evaluate(`!document.querySelector('#opp-empty').hidden && document.querySelectorAll('#opp-body tr').length === 0`));
  await evaluate(`document.querySelector('#reset-filters').click()`);
  await sleep(300);
  const oppCount = await evaluate(`document.querySelectorAll('#opp-body tr').length`);
  check("扫描器重置后恢复结果", oppCount > 5, String(oppCount));

  await evaluate(`document.querySelectorAll('#opp-table thead th')[2].click()`);
  check("扫描器表头排序", (await evaluate(`document.querySelector('#opp-table th.is-sorted')?.dataset.sort`)) === "edge");
  const tradeTargetId = await evaluate(`(async () => {
    const r = await fetch('/api/state?account=prob'); const s = await r.json();
    const t = s.state.events.find(e => e.status === "ready" && e.days > 2 && e.net >= s.state.settings.minEdge && e.depth > 20000);
    return t ? t.id : null;
  })()`);
  check("扫描器存在可执行标的", !!tradeTargetId, String(tradeTargetId));
  const targetSelector = `#opp-body tr[data-id="${tradeTargetId}"]`;
  await evaluate(`document.querySelector(${JSON.stringify(targetSelector)}).click()`);
  await sleep(400);
  const drawer = await evaluate(`({
    open: !document.querySelector('#drawer-root').hidden,
    marks: document.querySelectorAll('.ruler-mark').length,
    legs: document.querySelectorAll('.plan-leg').length,
    cta: document.querySelector('#execute-btn')?.textContent.trim()
  })`);
  check("机会详情：概率标尺 + 两腿计划", drawer.open && drawer.marks === 2 && drawer.legs === 2, JSON.stringify(drawer));

  const positionsBefore = await evaluate(`document.querySelectorAll('#pos-body tr.row-main').length`);
  const ordersBefore = await evaluate(`document.querySelectorAll('#order-list .order').length`);
  await evaluate(`document.querySelector('#execute-btn').click()`);
  await sleep(250);
  check("下单确认框", await evaluate(`!document.querySelector('#modal-root').hidden && document.querySelectorAll('#exec-preview > div').length >= 4`));
  await evaluate(`(() => { const el = document.querySelector('#size-qty'); el.value = '1000'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('#modal .btn-primary').click()`);
  await sleep(800);
  const afterOrder = await evaluate(`({
    orders: document.querySelectorAll('#order-list .order').length,
    drawer: document.querySelector('#drawer-root').hidden,
    modal: document.querySelector('#modal-root').hidden,
    toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')
  })`);
  check("下单后订单进入执行台", afterOrder.orders === ordersBefore + 1 && afterOrder.drawer, JSON.stringify(afterOrder));

  await sleep(5200);
  const afterFill = await evaluate(`({
    full: document.querySelectorAll('#order-list .order:first-child .leg.full').length,
    positions: document.querySelectorAll('#pos-body tr.row-main').length
  })`);
  check("对冲腿自动成交并进入持仓", afterFill.full === 2 && afterFill.positions >= positionsBefore, JSON.stringify(afterFill));
  await evaluate(`location.hash = "#/execution"`);
  await sleep(500);
  await shot("live-execution.png");

  await evaluate(`location.hash = "#/positions"`);
  await sleep(350);
  await evaluate(`document.querySelector('#pos-body tr.row-main')?.click()`);
  await sleep(250);
  check("持仓展开两腿账本", (await evaluate(`document.querySelectorAll('.legd-box').length`)) === 2);
  await shot("live-positions.png");

  await evaluate(`location.hash = "#/risk"`);
  await sleep(350);
  await evaluate(`document.querySelector('#kill-page-btn').click()`);
  await sleep(250);
  await evaluate(`document.querySelector('#modal .btn-danger').click()`);
  await sleep(700);
  const killed = await evaluate(`({
    banner: !document.querySelector('#global-banner').hidden,
    kill: !document.querySelector('#global-banner').classList.contains('is-kill') ? false : true,
    disabled: document.querySelector('#auto-switch').disabled,
    mode: document.querySelector('#sys-mode').textContent
  })`);
  check("熔断：横幅 + 自动执行停止", killed.banner && killed.kill && killed.disabled && /熔断/.test(killed.mode), JSON.stringify(killed));
  await evaluate(`document.querySelector('#kill-page-btn').click()`);
  await sleep(250);
  await evaluate(`document.querySelector('#modal .btn-primary').click()`);
  await sleep(600);
  check("解除熔断后恢复", (await evaluate(`document.querySelector('#global-banner').hidden`)) === true);

  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(`location.hash = "#/scanner"`);
  await sleep(400);
  const mobile = await evaluate(`({
    scroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
    cards: document.querySelectorAll('#opp-cards .opp-card').length,
    tableHidden: getComputedStyle(document.querySelector('#opp-table')).display === 'none'
  })`);
  check("移动端卡片列表且页面不横滚", mobile.scroll && mobile.cards > 0, JSON.stringify(mobile));
  await shot("live-mobile.png");

  await page.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(`location.hash = "#/overview"`);
  await sleep(500);
  await shot("live-overview.png");
  check("浏览器控制台无异常", errors.exceptions.length === 0 && errors.console.length === 0, JSON.stringify(errors));

  // Admin workspace, embedded in the terminal shell
  await goto(base + "/admin", 2600);
  check("管理后台加载", (await evaluate("document.title")).includes("管理") && (await evaluate(`document.querySelectorAll('#admin-tabs [data-admin-tab]').length`)) === 9);
  const adminData = await evaluate(`({
    kpis: document.querySelectorAll('#overview-kpis .admin-kpi').length,
    venues: document.querySelectorAll('#overview-venues .admin-venue').length,
    audit: document.querySelectorAll('#overview-audit tr').length,
    users: document.querySelectorAll('#users-table tbody tr').length,
    inShell: !!document.querySelector('#view-admin') && !document.querySelector('#view-admin').hidden
  })`);
  check("后台概览与账号列表", adminData.kpis === 4 && adminData.venues === 2 && adminData.users >= 3 && adminData.inShell, JSON.stringify(adminData));
  await evaluate(`document.querySelector('#admin-tabs [data-admin-tab="accounts"]').click()`);
  await sleep(300);
  const adminAccounts = await evaluate(`({
    cards: document.querySelectorAll('#accounts-grid .admin-account-card').length,
    rows: document.querySelectorAll('#accounts-table tbody tr').length,
    kpis: document.querySelectorAll('#accounts-kpis .admin-kpi').length
  })`);
  check("后台策略账户矩阵", adminAccounts.cards === 5 && adminAccounts.rows === 5 && adminAccounts.kpis === 4, JSON.stringify(adminAccounts));
  await shot("live-admin-accounts.png");
  await evaluate(`document.querySelector('#admin-tabs [data-admin-tab="users"]').click()`);
  await sleep(250);
  check("后台用户页", (await evaluate(`document.querySelectorAll('#users-table tbody tr').length`)) >= 3);
  await evaluate(`document.querySelector('#admin-tabs [data-admin-tab="strategy"]').click()`);
  await sleep(250);
  check("后台策略表单", (await evaluate(`document.querySelectorAll('#settings-fields input').length`)) >= 6);
  await evaluate(`document.querySelector('#admin-tabs [data-admin-tab="risk"]').click()`);
  await sleep(250);
  await evaluate(`(() => { const el = document.querySelector('#risk-account'); el.value = 'converge'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(600);
  const riskAccount = await evaluate(`({
    selector: document.querySelector('#risk-account').value,
    synced: document.querySelector('#strategy-account').value,
    limits: document.querySelectorAll('#risk-limits tbody tr').length,
    rules: document.querySelectorAll('#rules-list .admin-rule').length
  })`);
  check("后台风控按账户切换", riskAccount.selector === "converge" && riskAccount.synced === "converge" && riskAccount.limits === 5 && riskAccount.rules >= 16, JSON.stringify(riskAccount));
  await evaluate(`document.querySelector('#admin-tabs [data-admin-tab="venues"]').click()`);
  await sleep(250);
  check("后台场所页", (await evaluate(`document.querySelectorAll('#venue-cards .admin-card').length`)) === 2);
  await shot("live-admin.png");
  check("后台控制台无异常", errors.exceptions.length === 0, JSON.stringify(errors.exceptions));

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log("失败项：");
    failed.forEach(f => console.log(" - " + f.name));
    process.exitCode = 1;
  }
} catch (err) {
  console.error("\nE2E 运行失败：", err);
  console.error(serverLog.slice(-4000));
  process.exitCode = 1;
} finally {
  if (browser) {
    try {
      const s = await browser.page.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(ROOT, "preview", "live-failure.png"), Buffer.from(s.data, "base64"));
    } catch { /* ignore */ }
    browser.page.close();
    browser.proc.kill();
  }
  server.kill();
}
