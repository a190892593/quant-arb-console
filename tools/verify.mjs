/* ============================================================
   CONVERGENCE v3 · end-to-end verification
   Starts an isolated demo-fixture server, drives a headless
   Chromium through both desks, and asserts the product promises.
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
  stdio: "ignore"
});
let serverLog = "";

let browser;
try {
  console.log("CONVERGENCE · 双策略全栈验收");
  const health = await waitForServer(base);
  check("服务端健康检查", health.ok === true && health.version === "3.0.0", JSON.stringify(health));

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
  await evaluate(`document.querySelector('[data-demo="admin@convergence.local"]').click()`);
  await evaluate(`document.querySelector('#login-form').requestSubmit()`);
  await sleep(2200);
  console.log("LOGIN_ROUTE", JSON.stringify({ hash: await evaluate("location.hash"), h1: await evaluate("document.querySelector('.view:not([hidden]) h1')?.textContent") }));
  check("登录后进入策略台", (await evaluate("document.querySelector('.view:not([hidden]) h1')?.textContent")) === "总览");

  const overview = await evaluate(`({
    hero: !!document.querySelector('#view-overview .hero-value'),
    desks: document.querySelectorAll('#view-overview .desk-card').length,
    negRows: document.querySelectorAll('#view-overview tbody tr').length,
    nav: document.querySelectorAll('.nav-item').length,
    admin: !document.querySelector('#nav-admin').hidden
  })`);
  check("总览：双策略卡片 + 净值 + 篮子", overview.hero && overview.desks >= 2 && overview.negRows >= 2, JSON.stringify(overview));
  check("管理员导航可见", overview.admin === true, JSON.stringify(overview));

  await evaluate(`location.hash = "#/accounts"`);
  await sleep(500);
  const accounts = await evaluate(`({
    cards: document.querySelectorAll('#view-accounts .desk-card').length,
    rows: document.querySelectorAll('#view-accounts tbody tr').length,
    codes: [...document.querySelectorAll('#view-accounts .acct-code')].map(x => x.textContent)
  })`);
  check("账户：两个独立策略账户", accounts.cards === 2 && accounts.rows === 2 && accounts.codes.includes("S1") && accounts.codes.includes("S2"), JSON.stringify(accounts));
  await shot("live-accounts.png");

  await evaluate(`location.hash = "#/negrisk"`);
  await sleep(600);
  const negView = await evaluate(`({
    rows: document.querySelectorAll('#view-negrisk tbody tr').length,
    ready: [...document.querySelectorAll('#view-negrisk .chip-ok')].length,
    convert: document.querySelectorAll('#view-negrisk [data-act="convert"]:not([disabled])').length,
    title: document.querySelector('#view-negrisk h1').textContent
  })`);
  check("NegRisk：扫描到可转换篮子", negView.rows >= 3 && negView.ready >= 2 && negView.convert >= 1, JSON.stringify(negView));
  await evaluate(`document.querySelector('#view-negrisk [data-act="convert"]:not([disabled])').click()`);
  await sleep(400);
  const modal = await evaluate(`({
    open: !document.querySelector('#modal-root').hidden,
    legs: document.querySelectorAll('#modal-body tbody tr').length,
    sets: !!document.querySelector('#cv-sets')
  })`);
  check("转换确认框：逐结果腿 + 组数输入", modal.open && modal.legs >= 3 && modal.sets, JSON.stringify(modal));
  await evaluate(`(() => { const el = document.querySelector('#cv-sets'); el.value = '20'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('#modal-actions .btn-primary').click()`);
  await sleep(1200);
  const afterConvert = await evaluate(`({
    ledger: document.querySelectorAll('#view-negrisk tbody tr').length,
    equity: document.querySelector('#acct-equity').textContent,
    toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')
  })`);
  check("转换成交写入台账并抬高净值", afterConvert.ledger >= 4 && afterConvert.equity !== "$10,000", JSON.stringify(afterConvert));
  await shot("live-negrisk.png");

  await evaluate(`document.querySelector('#acct-btn').click()`);
  await sleep(150);
  await evaluate(`document.querySelector('[data-act="switch-account"][data-id="marketmaking"]').click()`);
  await sleep(1200);
  await evaluate(`location.hash = "#/mm"`);
  await sleep(700);
  const mmView = await evaluate(`({
    rows: document.querySelectorAll('#view-mm tbody tr').length,
    quotes: [...document.querySelectorAll('#view-mm tbody tr')].filter(tr => /¢/.test(tr.textContent)).length,
    fills: document.querySelectorAll('#view-mm [data-act="mm-pause"]').length,
    halted: !!document.querySelector('#view-mm .warn-box')
  })`);
  check("做市台：报价与库存表", mmView.rows >= 8 && mmView.fills >= 8, JSON.stringify(mmView));
  await evaluate(`document.querySelector('#view-mm [data-act="mm-pause"]').click()`);
  await sleep(900);
  check("做市：单市场可暂停", (await evaluate(`!!document.querySelector('#view-mm [data-act="mm-pause"][data-paused="true"]')`)) === true);
  await evaluate(`document.querySelector('#view-mm [data-act="refresh-mm"]').click()`);
  await sleep(900);
  await shot("live-mm.png");

  await evaluate(`location.hash = "#/risk"`);
  await sleep(500);
  const risk = await evaluate(`({
    limits: document.querySelectorAll('#view-risk .limit-row').length,
    rules: document.querySelectorAll('#view-risk .rule-row').length,
    cells: document.querySelectorAll('#view-risk .risk-cell').length
  })`);
  check("风控：5 项限额 + 当前账户规则", risk.limits === 5 && risk.rules >= 9 && risk.cells === 6, JSON.stringify(risk));
  await shot("live-risk.png");

  await evaluate(`location.hash = "#/admin"`);
  await sleep(500);
  const admin = await evaluate(`({
    title: document.querySelector('#view-admin h1')?.textContent,
    accounts: document.querySelectorAll('#view-admin tbody tr').length,
    venues: document.querySelectorAll('#view-admin .kv').length
  })`);
  check("管理：账户与场所可见", admin.title === "管理" && admin.accounts === 2 && admin.venues >= 2, JSON.stringify(admin));

  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(`location.hash = "#/overview"`);
  await sleep(600);
  const mobile = await evaluate(`({
    scroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
    nav: document.querySelectorAll('.nav-item').length,
    hero: !!document.querySelector('#view-overview .hero-value')
  })`);
  check("移动端不横滚且导航可用", mobile.scroll && mobile.nav >= 5 && mobile.hero, JSON.stringify(mobile));
  await shot("live-mobile.png");

  await page.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(`location.hash = "#/overview"`);
  await sleep(600);
  await shot("live-overview.png");
  check("浏览器控制台无异常", errors.exceptions.length === 0 && errors.console.length === 0, JSON.stringify(errors));

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
