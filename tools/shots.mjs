/* Capture current-server screenshots: node tools/shots.mjs */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BASE = process.env.SHOT_URL || "http://127.0.0.1:8787";
const browser = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].find(existsSync);
if (!browser) { console.error("browser not found"); process.exit(2); }
const port = 9700 + Math.floor(Math.random() * 200);
const proc = spawn(browser, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "conv-shot-"))}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--no-sandbox", "about:blank"], { stdio: "ignore", windowsHide: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 120; i++) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }); if (r.ok) { target = await r.json(); break; } } catch {}
  await sleep(120);
}
if (!target) { proc.kill(); throw new Error("browser not ready"); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
let id = 0; const pending = new Map();
ws.addEventListener("message", ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
const evaluate = async expression => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const viewport = (w, h, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
const goto = async (url, wait = 1000) => { await send("Page.navigate", { url }); await sleep(wait); };
const shot = async name => { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(ROOT, "preview", name), Buffer.from(s.data, "base64")); };
await send("Runtime.enable"); await send("Page.enable");
await viewport(1600, 1000);
await goto(BASE + "/login");
await evaluate(`document.querySelector('[data-demo="admin@convergence.local"]').click()`);
await evaluate(`document.querySelector('#login-form').requestSubmit()`);
await sleep(2500);
for (const [hash, name] of [["#/overview", "live-overview.png"], ["#/accounts", "live-accounts.png"], ["#/scanner", "live-scanner.png"]]) {
  await evaluate(`location.hash = ${JSON.stringify(hash)}`); await sleep(700); await shot(name);
}
await evaluate(`location.hash = "#/execution"`); await sleep(700); await shot("live-execution.png");
await evaluate(`location.hash = "#/positions"`); await sleep(700); await evaluate(`document.querySelector('#pos-body tr.row-main')?.click()`); await sleep(300); await shot("live-positions.png");
await evaluate(`location.hash = "#/risk"`); await sleep(700); await shot("live-risk.png");
await viewport(390, 844, true);
await evaluate(`location.hash = "#/accounts"`); await sleep(700); await shot("live-mobile.png");
await viewport(1600, 1000);
await goto(BASE + "/admin", 1800);
await evaluate(`document.querySelector('[data-view="accounts"]').click()`); await sleep(500); await shot("live-admin-accounts.png");
await evaluate(`document.querySelector('[data-view="overview"]').click()`); await sleep(400); await shot("live-admin.png");
console.log("screenshots written");
ws.close(); proc.kill();
