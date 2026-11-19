export const DAY_MS = 86_400_000;

export function pad(n: number): string { return String(n).padStart(2, "0"); }

export interface SimParts { y: number; m: number; d: number; hh: number; mm: number; ss: number; dow: number }

export function simParts(ms = Date.now()): SimParts {
  const d = new Date(ms + 8 * 3_600_000);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds(), dow: d.getUTCDay()
  };
}

export function clock(ms = Date.now()): string {
  const p = simParts(ms);
  return `${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}`;
}

export function hhmm(ms = Date.now()): string {
  const p = simParts(ms);
  return `${pad(p.hh)}:${pad(p.mm)}`;
}

export function dateStr(ms = Date.now()): string {
  const p = simParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function dateShort(ms = Date.now()): string {
  const p = simParts(ms);
  return `${pad(p.m)}-${pad(p.d)}`;
}

export function weekday(ms = Date.now()): string {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][simParts(ms).dow] ?? "";
}

export function usd(n: number, dp = 0): string {
  return "$" + Math.abs(Number(n) || 0).toLocaleString("en-US", {
    minimumFractionDigits: dp, maximumFractionDigits: dp
  });
}

export function signedUsd(n: number, dp = 0): string {
  return (n >= 0 ? "+" : "−") + usd(n, dp);
}

export function compactUsd(n: number): string {
  const v = Math.abs(Number(n) || 0);
  if (v < 1) return "$0";
  if (v >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (v >= 1000) return "$" + Math.round(n / 1e3) + "k";
  return "$" + Math.round(n).toLocaleString("en-US");
}

export function cents(p: number): string { return (p * 100).toFixed(1) + "¢"; }

export function signedCents(v: number): string {
  if (Math.abs(v) < 0.005) return "0.00¢";
  return (v > 0 ? "+" : "−") + Math.abs(v).toFixed(2) + "¢";
}

export function pct(n: number, dp = 1): string { return (n * 100).toFixed(dp) + "%"; }

export function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v));
}

export function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function pick<T>(arr: readonly T[], rand: () => number = Math.random): T {
  return arr[Math.floor(rand() * arr.length)] as T;
}

export function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}
