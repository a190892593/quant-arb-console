import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Repository } from "./db/repository.js";
import { config } from "./config.js";
import type { Role, User, UserRow } from "./domain/types.js";

export const COOKIE = "conv_sid";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = parts[1]!;
  const expected = Buffer.from(parts[2]!, "base64url");
  const actual = scryptSync(password, salt, 64);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function tokenId(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function publicUser(row: UserRow | undefined): User | null {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    active: !!row.active,
    createdAt: row.created_at,
    lastLogin: row.last_login
  };
}

export interface SessionInfo {
  token: string;
  csrf: string;
  expiresAt: number;
}

export function createSession(repo: Repository, userId: string): SessionInfo {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const now = Date.now();
  const expiresAt = now + config.sessionTtlMs;
  repo.sessionCreate({ id: tokenId(token), userId, csrf, createdAt: now, expiresAt });
  return { token, csrf, expiresAt };
}

export interface AuthContext {
  user: UserRow;
  csrf: string;
  token: string;
}

export function sessionFromToken(repo: Repository, token: string | undefined): AuthContext | null {
  if (!token) return null;
  const session = repo.sessionGet(tokenId(token));
  if (!session) return null;
  const user = repo.userById(session.user_id);
  if (!user || !user.active) {
    repo.sessionDelete(session.id);
    return null;
  }
  return { user, csrf: session.csrf, token };
}

export function deleteSessionByToken(repo: Repository, token: string): void {
  repo.sessionDelete(tokenId(token));
}

const ranks: Record<Role, number> = { analyst: 1, trader: 2, admin: 3 };

export function roleAtLeast(user: User | UserRow | null | undefined, role: Role): boolean {
  if (!user) return false;
  return ranks[user.role] >= ranks[role];
}

export function isWriteRole(user: User | UserRow | null | undefined): boolean {
  return roleAtLeast(user, "trader");
}

/* ---------------- login throttling ---------------- */
interface Attempt { start: number; count: number }
const attempts = new Map<string, Attempt>();
const WINDOW = 15 * 60 * 1000;
const MAX = 8;

export function loginAllowed(ip: string): boolean {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.start > WINDOW) return true;
  return rec.count < MAX;
}

export function noteLoginFailure(ip: string): void {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.start > WINDOW) attempts.set(ip, { start: Date.now(), count: 1 });
  else rec.count += 1;
}

export function clearLoginFailures(ip: string): void { attempts.delete(ip); }
