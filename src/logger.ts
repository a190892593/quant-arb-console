import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: { service: "convergence", env: process.env.NODE_ENV ?? "development" }
});

export function redactSecrets<T>(value: T): T {
  const text = JSON.stringify(value);
  return JSON.parse(text.replace(/(?:0x[a-fA-F0-9]{64}|(?:api[_-]?key|secret|passphrase|private[_-]?key)["']?\s*[:=]\s*["'][^"']+)/gi,
    "[redacted]")) as T;
}
