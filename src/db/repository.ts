import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AccountId, AuditEntry, CalendarItem, Conversion, EquityPoint, EventContract, FeedItem, Limit, MmFill, MmPosition, Order,
  Position, Review, RiskEvent, Rule, User, UserRow
} from "../domain/types.js";

type SqlValue = string | number | null | bigint | Uint8Array;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','trader','analyst')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  account_id TEXT NOT NULL,
  ev_id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, ev_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_account ON orders(account_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL DEFAULT '',
  t TEXT NOT NULL, actor TEXT NOT NULL, actor_id TEXT,
  action TEXT NOT NULL, obj TEXT NOT NULL, venue TEXT, detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(id DESC);
CREATE TABLE IF NOT EXISTS risk_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL DEFAULT '',
  t TEXT NOT NULL, level TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, val TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS limits (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL, descr TEXT NOT NULL,
  value REAL NOT NULL, kind TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);
CREATE TABLE IF NOT EXISTS rules (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL, descr TEXT NOT NULL,
  onoff INTEGER NOT NULL DEFAULT 1, value REAL,
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);
CREATE TABLE IF NOT EXISTS equity (
  account_id TEXT NOT NULL,
  t INTEGER NOT NULL,
  v REAL NOT NULL,
  PRIMARY KEY (account_id, t)
);
CREATE TABLE IF NOT EXISTS feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL DEFAULT '',
  t TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, val TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calendar (
  account_id TEXT NOT NULL,
  ev_id TEXT NOT NULL,
  exposure REAL NOT NULL, note TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, ev_id)
);

CREATE TABLE IF NOT EXISTS conversions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversions_account ON conversions(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mm_positions (
  account_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, market_id)
);

CREATE TABLE IF NOT EXISTS mm_fills (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mm_fills_account ON mm_fills(account_id, created_at DESC);
`;

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

interface AuditRow {
  account_id: string | null; t: string; actor: string; action: string; obj: string; venue: string | null; detail: string | null;
}
interface FeedRow { account_id: string | null; t: string; kind: string; title: string; detail: string | null; val: string | null }
interface RiskRow { account_id: string | null; t: string; level: string; title: string; detail: string | null; val: string | null }
interface LimitRow { id: string; name: string; descr: string; value: number; kind: string; sort: number }
interface RuleRow { id: string; name: string; descr: string; onoff: number; value: number | null; sort: number }
interface CalendarRow { ev_id: string; exposure: number; note: string | null }
interface SessionRow { id: string; user_id: string; csrf: string; created_at: number; expires_at: number }
interface CountRow { n: number }
interface ColRow { name: string }

export interface SessionRecord {
  id: string;
  userId: string;
  csrf: string;
  createdAt: number;
  expiresAt: number;
}

export class Repository {
  private db: DatabaseSync;
  private pendingLegacyCopy = false;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.migrateLegacy();
    this.db.exec(SCHEMA);
    const ruleColumns = this.all<ColRow>("PRAGMA table_info(rules)");
    if (ruleColumns.length && !ruleColumns.some(c => c.name === "value")) {
      this.db.exec("ALTER TABLE rules ADD COLUMN value REAL");
    }
    if (this.pendingLegacyCopy) this.copyLegacy();
  }

  close(): void { this.db.close(); }

  private all<T>(sql: string, ...args: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...args) as unknown as T[];
  }
  private get<T>(sql: string, ...args: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...args) as unknown as T | undefined;
  }
  private run(sql: string, ...args: SqlValue[]): void {
    this.db.prepare(sql).run(...args);
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * v2 kept one shared trading book. v3 gives every strategy its own account.
   * Rename the legacy tables, let SCHEMA create the account-scoped ones, then copy
   * the old book into `prob` so an existing installation keeps its positions.
   */
  private migrateLegacy(): void {
    const cols = this.all<ColRow>("PRAGMA table_info(positions)");
    const legacy = cols.length > 0 && !cols.some(c => c.name === "account_id");
    if (!legacy) return;
    const tables = ["positions", "orders", "reviews", "limits", "rules", "equity", "calendar"];
    for (const table of tables) this.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_legacy`);
    this.db.exec("DROP INDEX IF EXISTS idx_orders_updated");
    for (const table of ["audit", "feed", "risk_events"]) {
      const c = this.all<ColRow>(`PRAGMA table_info(${table})`);
      if (c.length && !c.some(x => x.name === "account_id")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN account_id TEXT NOT NULL DEFAULT 'prob'`);
      }
    }
    this.pendingLegacyCopy = true;
  }

  private copyLegacy(): void {
    this.tx(() => {
      this.db.exec("INSERT INTO positions(account_id,ev_id,data,updated_at) SELECT 'prob',ev_id,data,updated_at FROM positions_legacy");
      this.db.exec("INSERT INTO orders(id,account_id,data,created_at,updated_at) SELECT id,'prob',data,created_at,updated_at FROM orders_legacy");
      this.db.exec("INSERT INTO reviews(id,account_id,data,created_at,updated_at) SELECT id,'prob',data,created_at,updated_at FROM reviews_legacy");
      this.db.exec("INSERT INTO limits(account_id,id,name,descr,value,kind,sort) SELECT 'prob',id,name,descr,value,kind,sort FROM limits_legacy");
      this.db.exec("INSERT INTO rules(account_id,id,name,descr,onoff,sort) SELECT 'prob',id,name,descr,onoff,sort FROM rules_legacy");
      this.db.exec("INSERT INTO equity(account_id,t,v) SELECT 'prob',t,v FROM equity_legacy");
      this.db.exec("INSERT INTO calendar(account_id,ev_id,exposure,note,sort) SELECT 'prob',ev_id,exposure,note,sort FROM calendar_legacy");
    });
    for (const table of ["positions", "orders", "reviews", "limits", "rules", "equity", "calendar"]) {
      this.db.exec(`DROP TABLE ${table}_legacy`);
    }
    this.pendingLegacyCopy = false;
  }

  /* ---------------- meta / settings ---------------- */
  metaGet(key: string, fallback: string | null = null): string | null {
    return this.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? fallback;
  }
  metaSet(key: string, value: string | number): void {
    this.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, String(value));
  }
  nextSeq(key: string, start = 1): number {
    const cur = Number(this.metaGet(key, String(start - 1))) || start - 1;
    const next = cur + 1;
    this.metaSet(key, next);
    return next;
  }
  settingsAll(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of this.all<{ key: string; value: string }>("SELECT key,value FROM settings")) {
      out[row.key] = parseJson<unknown>(row.value, row.value);
    }
    return out;
  }
  settingGet<T>(key: string, fallback: T): T {
    const row = this.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
    return row ? parseJson<T>(row.value, fallback) : fallback;
  }
  settingSet(key: string, value: unknown): void {
    this.run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(value));
  }

  /* ---------------- users / sessions ---------------- */
  userCount(): number { return this.get<CountRow>("SELECT COUNT(*) AS n FROM users")?.n ?? 0; }
  userByEmail(email: string): UserRow | undefined {
    return this.get<UserRow>("SELECT * FROM users WHERE lower(email)=lower(?)", email);
  }
  userById(id: string): UserRow | undefined {
    return this.get<UserRow>("SELECT * FROM users WHERE id=?", id);
  }
  usersAll(): User[] {
    return this.all<Omit<User, "active" | "createdAt" | "lastLogin"> & { active: number; created_at: string; last_login: string | null }>(
      "SELECT id,email,name,role,active,created_at,last_login FROM users ORDER BY created_at"
    ).map(r => ({
      id: r.id, email: r.email, name: r.name, role: r.role,
      active: !!r.active, createdAt: r.created_at, lastLogin: r.last_login
    }));
  }
  userInsert(u: { id: string; email: string; name: string; role: User["role"]; passwordHash: string; active: boolean; createdAt: string }): void {
    this.run("INSERT INTO users(id,email,name,role,password_hash,active,created_at) VALUES(?,?,?,?,?,?,?)",
      u.id, u.email, u.name, u.role, u.passwordHash, u.active ? 1 : 0, u.createdAt);
  }
  userUpdate(id: string, patch: Partial<{ email: string; name: string; role: User["role"]; active: boolean; passwordHash: string }>): UserRow | undefined {
    const cur = this.userById(id);
    if (!cur) return undefined;
    this.run("UPDATE users SET email=?,name=?,role=?,active=?,password_hash=? WHERE id=?",
      patch.email ?? cur.email,
      patch.name ?? cur.name,
      patch.role ?? cur.role,
      patch.active == null ? cur.active : (patch.active ? 1 : 0),
      patch.passwordHash ?? cur.password_hash,
      id);
    return this.userById(id);
  }
  userTouchLogin(id: string): void {
    this.run("UPDATE users SET last_login=? WHERE id=?", new Date().toISOString(), id);
  }
  userDelete(id: string): void { this.run("DELETE FROM users WHERE id=?", id); }
  adminCount(): number {
    return this.get<CountRow>("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1")?.n ?? 0;
  }

  sessionCreate(s: SessionRecord): void {
    this.run("INSERT INTO sessions(id,user_id,csrf,created_at,expires_at) VALUES(?,?,?,?,?)",
      s.id, s.userId, s.csrf, s.createdAt, s.expiresAt);
  }
  sessionGet(id: string): SessionRow | undefined {
    const row = this.get<SessionRow>("SELECT * FROM sessions WHERE id=?", id);
    if (!row) return undefined;
    if (row.expires_at < Date.now()) { this.sessionDelete(id); return undefined; }
    return row;
  }
  sessionDelete(id: string): void { this.run("DELETE FROM sessions WHERE id=?", id); }
  sessionsDeleteForUser(userId: string): void { this.run("DELETE FROM sessions WHERE user_id=?", userId); }
  sessionsCleanup(): void { this.run("DELETE FROM sessions WHERE expires_at < ?", Date.now()); }

  /* ---------------- events ---------------- */
  eventsAll(activeOnly = false): EventContract[] {
    const sql = "SELECT data FROM events" + (activeOnly ? " WHERE active=1" : "") + " ORDER BY rowid";
    return this.all<{ data: string }>(sql).map(r => parseJson<EventContract | null>(r.data, null)).filter((e): e is EventContract => e !== null);
  }
  eventsReplace(events: EventContract[], active = true): void {
    this.tx(() => {
      this.run("DELETE FROM events");
      const stmt = this.db.prepare("INSERT INTO events(id,data,active,updated_at) VALUES(?,?,?,?)");
      const now = Date.now();
      for (const e of events) stmt.run(e.id, JSON.stringify(e), active ? 1 : 0, now);
    });
  }
  eventUpsert(e: EventContract, active = true): void {
    this.run(`INSERT INTO events(id,data,active,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, active=excluded.active, updated_at=excluded.updated_at`,
      e.id, JSON.stringify(e), active ? 1 : 0, Date.now());
  }
  eventSetActive(id: string, active: boolean): void {
    this.run("UPDATE events SET active=? WHERE id=?", active ? 1 : 0, id);
  }
  eventGet(id: string): EventContract | null {
    const row = this.get<{ data: string }>("SELECT data FROM events WHERE id=?", id);
    return row ? parseJson<EventContract | null>(row.data, null) : null;
  }

  /* ---------------- positions / orders / reviews ---------------- */
  positionsAll(accountId?: AccountId): Position[] {
    const rows = accountId
      ? this.all<{ data: string }>("SELECT data FROM positions WHERE account_id=? ORDER BY rowid", accountId)
      : this.all<{ data: string }>("SELECT data FROM positions ORDER BY rowid");
    return rows.map(r => parseJson<Position | null>(r.data, null)).filter((p): p is Position => p !== null);
  }
  positionUpsert(accountId: AccountId, p: Position): void {
    const data = { ...p, accountId, strategyId: accountId };
    this.run(`INSERT INTO positions(account_id,ev_id,data,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(account_id,ev_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
      accountId, p.evId, JSON.stringify(data), Date.now());
  }
  positionDelete(accountId: AccountId, evId: string): void {
    this.run("DELETE FROM positions WHERE account_id=? AND ev_id=?", accountId, evId);
  }
  positionsClear(accountId?: AccountId): void {
    if (accountId) this.run("DELETE FROM positions WHERE account_id=?", accountId);
    else this.run("DELETE FROM positions");
  }

  /* ---------------- NegRisk conversion ledger ---------------- */
  conversionsAll(accountId?: AccountId, limit = 200): Conversion[] {
    const rows = accountId
      ? this.all<{ data: string }>("SELECT data FROM conversions WHERE account_id=? ORDER BY created_at DESC LIMIT ?", accountId, limit)
      : this.all<{ data: string }>("SELECT data FROM conversions ORDER BY created_at DESC LIMIT ?", limit);
    return rows.map(r => parseJson<Conversion | null>(r.data, null)).filter((c): c is Conversion => c !== null);
  }
  conversionAdd(c: Conversion): void {
    const now = Date.now();
    this.run(`INSERT INTO conversions(id,account_id,data,created_at,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
      c.id, c.accountId, JSON.stringify(c), c.createdAt ?? now, now);
  }
  conversionsClear(accountId?: AccountId): void {
    if (accountId) this.run("DELETE FROM conversions WHERE account_id=?", accountId);
    else this.run("DELETE FROM conversions");
  }

  /* ---------------- Market-making inventory / fills ---------------- */
  mmPositionsAll(accountId: AccountId): MmPosition[] {
    return this.all<{ data: string }>("SELECT data FROM mm_positions WHERE account_id=? ORDER BY market_id", accountId)
      .map(r => parseJson<MmPosition | null>(r.data, null))
      .filter((p): p is MmPosition => p !== null);
  }
  mmPositionUpsert(accountId: AccountId, p: MmPosition): void {
    this.run(`INSERT INTO mm_positions(account_id,market_id,data,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(account_id,market_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
      accountId, p.marketId, JSON.stringify(p), Date.now());
  }
  mmFillsAll(accountId?: AccountId, limit = 200): MmFill[] {
    const rows = accountId
      ? this.all<{ data: string }>("SELECT data FROM mm_fills WHERE account_id=? ORDER BY created_at DESC LIMIT ?", accountId, limit)
      : this.all<{ data: string }>("SELECT data FROM mm_fills ORDER BY created_at DESC LIMIT ?", limit);
    return rows.map(r => parseJson<MmFill | null>(r.data, null)).filter((f): f is MmFill => f !== null);
  }
  mmFillAdd(f: MmFill): void {
    this.run(`INSERT INTO mm_fills(id,account_id,data,created_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data`, f.id, f.accountId, JSON.stringify(f), f.createdAt ?? Date.now());
  }
  mmFillsClear(accountId?: AccountId): void {
    if (accountId) this.run("DELETE FROM mm_fills WHERE account_id=?", accountId);
    else this.run("DELETE FROM mm_fills");
  }
  mmPositionsClear(accountId?: AccountId): void {
    if (accountId) this.run("DELETE FROM mm_positions WHERE account_id=?", accountId);
    else this.run("DELETE FROM mm_positions");
  }

  ordersAll(accountId?: AccountId): Order[] {
    const rows = accountId
      ? this.all<{ data: string }>("SELECT data FROM orders WHERE account_id=? ORDER BY created_at DESC", accountId)
      : this.all<{ data: string }>("SELECT data FROM orders ORDER BY created_at DESC");
    return rows.map(r => parseJson<Order | null>(r.data, null)).filter((o): o is Order => o !== null);
  }
  orderUpsert(accountId: AccountId, o: Order): void {
    const data = { ...o, accountId, strategyId: accountId };
    const now = Date.now();
    this.run(`INSERT INTO orders(id,account_id,data,created_at,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
      o.id, accountId, JSON.stringify(data), o.createdAt ?? now, now);
  }
  orderDelete(accountId: AccountId, id: string): void {
    this.run("DELETE FROM orders WHERE account_id=? AND id=?", accountId, id);
  }
  ordersClear(accountId?: AccountId): void {
    if (accountId) this.run("DELETE FROM orders WHERE account_id=?", accountId);
    else this.run("DELETE FROM orders");
  }

  reviewsAll(accountId?: AccountId): Review[] {
    const rows = accountId
      ? this.all<{ data: string }>("SELECT data FROM reviews WHERE account_id=? ORDER BY created_at ASC", accountId)
      : this.all<{ data: string }>("SELECT data FROM reviews ORDER BY created_at ASC");
    return rows.map(r => parseJson<Review | null>(r.data, null)).filter((r): r is Review => r !== null);
  }
  reviewUpsert(accountId: AccountId, r: Review): void {
    const data = { ...r, accountId };
    const now = Date.now();
    this.run(`INSERT INTO reviews(id,account_id,data,created_at,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
      r.id, accountId, JSON.stringify(data), r.createdAt ?? now, now);
  }
  reviewDelete(accountId: AccountId, id: string): void {
    this.run("DELETE FROM reviews WHERE account_id=? AND id=?", accountId, id);
  }
  reviewsClear(accountId?: AccountId): void {
    if (accountId) this.run("DELETE FROM reviews WHERE account_id=?", accountId);
    else this.run("DELETE FROM reviews");
  }

  /* ---------------- audit / feed / risk events ---------------- */
  auditAdd(a: AuditEntry & { actorId?: string }): void {
    this.run("INSERT INTO audit(account_id,t,actor,actor_id,action,obj,venue,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      a.accountId ?? "", a.t, a.actor, a.actorId ?? null, a.action, a.obj, a.venue || "", a.detail || "", new Date().toISOString());
  }
  auditAll(opts: { accountId?: AccountId | null; limit?: number; actor?: string | null; q?: string | null } = {}): AuditEntry[] {
    const { accountId = null, limit = 200, actor = null, q = null } = opts;
    let sql = "SELECT account_id,t,actor,action,obj,venue,detail FROM audit";
    const where: string[] = [];
    const args: SqlValue[] = [];
    if (accountId) { where.push("account_id=?"); args.push(accountId); }
    if (actor) { where.push("actor=?"); args.push(actor); }
    if (q) { where.push("(obj LIKE ? OR detail LIKE ? OR action LIKE ?)"); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY id DESC LIMIT ?";
    args.push(Math.min(1000, Math.max(1, limit)));
    return this.all<AuditRow>(sql, ...args).map(r => ({
      t: r.t, actor: r.actor, action: r.action, obj: r.obj, venue: r.venue ?? "", detail: r.detail ?? "",
      accountId: (r.account_id || undefined) as AccountId | undefined
    }));
  }
  auditClear(): void { this.run("DELETE FROM audit"); }

  riskEventsAll(accountId: AccountId | undefined, limit = 30): RiskEvent[] {
    const rows = accountId
      ? this.all<RiskRow>("SELECT account_id,t,level,title,detail,val FROM risk_events WHERE account_id=? ORDER BY id DESC LIMIT ?", accountId, limit)
      : this.all<RiskRow>("SELECT account_id,t,level,title,detail,val FROM risk_events ORDER BY id DESC LIMIT ?", limit);
    return rows.map(r => ({
      t: r.t, level: r.level as RiskEvent["level"], title: r.title, detail: r.detail ?? "", val: r.val ?? "",
      accountId: (r.account_id || undefined) as AccountId | undefined
    }));
  }
  riskEventAdd(e: RiskEvent): void {
    this.run("INSERT INTO risk_events(account_id,t,level,title,detail,val,created_at) VALUES(?,?,?,?,?,?,?)",
      e.accountId ?? "", e.t, e.level, e.title, e.detail, e.val, new Date().toISOString());
  }
  riskEventsClear(accountId?: AccountId): void {
    if (accountId) this.run("DELETE FROM risk_events WHERE account_id=?", accountId);
    else this.run("DELETE FROM risk_events");
  }

  feedAll(accountId: AccountId | undefined, limit = 20): FeedItem[] {
    const rows = accountId
      ? this.all<FeedRow>("SELECT account_id,t,kind,title,detail,val FROM feed WHERE account_id=? ORDER BY id DESC LIMIT ?", accountId, limit)
      : this.all<FeedRow>("SELECT account_id,t,kind,title,detail,val FROM feed ORDER BY id DESC LIMIT ?", limit);
    return rows.map(r => ({
      t: r.t, kind: r.kind as FeedItem["kind"], title: r.title, detail: r.detail ?? "", val: r.val ?? "",
      accountId: (r.account_id || undefined) as AccountId | undefined
    }));
  }
  feedAdd(f: FeedItem): void {
    this.run("INSERT INTO feed(account_id,t,kind,title,detail,val,created_at) VALUES(?,?,?,?,?,?,?)",
      f.accountId ?? "", f.t, f.kind, f.title, f.detail, f.val, new Date().toISOString());
  }
  feedClear(accountId?: AccountId): void {
    if (accountId) this.run("DELETE FROM feed WHERE account_id=?", accountId);
    else this.run("DELETE FROM feed");
  }

  /* ---------------- limits / rules ---------------- */
  limitsAll(accountId: AccountId): Limit[] {
    return this.all<LimitRow>("SELECT id,name,descr,value,kind,sort FROM limits WHERE account_id=? ORDER BY sort", accountId)
      .map(r => ({ id: r.id, name: r.name, desc: r.descr, value: r.value, used: 0, kind: r.kind as Limit["kind"] }));
  }
  limitsReplace(accountId: AccountId, limits: Limit[]): void {
    this.tx(() => {
      this.run("DELETE FROM limits WHERE account_id=?", accountId);
      const stmt = this.db.prepare("INSERT INTO limits(account_id,id,name,descr,value,kind,sort) VALUES(?,?,?,?,?,?,?)");
      limits.forEach((l, i) => stmt.run(accountId, l.id, l.name, l.desc, l.value, l.kind, i));
    });
  }
  limitUpdate(accountId: AccountId, id: string, value: number): void {
    this.run("UPDATE limits SET value=? WHERE account_id=? AND id=?", value, accountId, id);
  }
  rulesAll(accountId: AccountId): Rule[] {
    return this.rulesStored(accountId);
  }
  rulesStored(accountId: AccountId): Rule[] {
    return this.all<RuleRow>("SELECT id,name,descr,onoff,value,sort FROM rules WHERE account_id=? ORDER BY sort", accountId)
      .map(r => ({ id: r.id, name: r.name, desc: r.descr, on: !!r.onoff, value: r.value ?? undefined }));
  }
  rulesReplace(accountId: AccountId, rules: Rule[]): void {
    this.tx(() => {
      this.run("DELETE FROM rules WHERE account_id=?", accountId);
      const stmt = this.db.prepare("INSERT INTO rules(account_id,id,name,descr,onoff,value,sort) VALUES(?,?,?,?,?,?,?)");
      rules.forEach((r, i) => stmt.run(accountId, r.id, r.name, r.desc, r.on ? 1 : 0, r.value ?? null, i));
    });
  }
  ruleUpsert(accountId: AccountId, rule: Rule): void {
    const sort = 0;
    this.run(
      `INSERT INTO rules(account_id,id,name,descr,onoff,value,sort) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(account_id,id) DO UPDATE SET onoff=excluded.onoff, value=excluded.value`,
      accountId, rule.id, rule.name, rule.desc, rule.on ? 1 : 0, rule.value ?? null, sort
    );
  }
  ruleSet(accountId: AccountId, id: string, on: boolean): void {
    const rule = this.rulesAll(accountId).find(r => r.id === id);
    if (rule) this.ruleUpsert(accountId, { ...rule, on });
  }

  /* ---------------- equity / calendar ---------------- */
  equityAll(accountId: AccountId): EquityPoint[] {
    return this.all<EquityPoint>("SELECT t,v FROM equity WHERE account_id=? ORDER BY t", accountId);
  }
  equityAllAccounts(): Array<EquityPoint & { accountId: AccountId }> {
    return this.all<EquityPoint & { account_id: AccountId }>("SELECT account_id,t,v FROM equity ORDER BY t")
      .map(r => ({ accountId: r.account_id, t: r.t, v: r.v }));
  }
  equityReplace(accountId: AccountId, rows: EquityPoint[]): void {
    this.tx(() => {
      this.run("DELETE FROM equity WHERE account_id=?", accountId);
      const stmt = this.db.prepare("INSERT INTO equity(account_id,t,v) VALUES(?,?,?)");
      for (const r of rows) stmt.run(accountId, r.t, r.v);
    });
  }
  equityAppend(accountId: AccountId, point: EquityPoint): void {
    this.run("INSERT OR REPLACE INTO equity(account_id,t,v) VALUES(?,?,?)", accountId, point.t, point.v);
  }
  equityTrim(accountId: AccountId, keep = 5000): void {
    this.run(
      "DELETE FROM equity WHERE account_id=? AND t NOT IN (SELECT t FROM equity WHERE account_id=? ORDER BY t DESC LIMIT ?)",
      accountId, accountId, keep
    );
  }
  calendarAll(accountId: AccountId): CalendarItem[] {
    return this.all<CalendarRow>("SELECT ev_id,exposure,note FROM calendar WHERE account_id=? ORDER BY sort", accountId)
      .map(r => ({ evId: r.ev_id, exposure: r.exposure, note: r.note ?? "" }));
  }
  calendarReplace(accountId: AccountId, rows: CalendarItem[]): void {
    this.tx(() => {
      this.run("DELETE FROM calendar WHERE account_id=?", accountId);
      const stmt = this.db.prepare("INSERT INTO calendar(account_id,ev_id,exposure,note,sort) VALUES(?,?,?,?,?)");
      rows.forEach((r, i) => stmt.run(accountId, r.evId, r.exposure, r.note, i));
    });
  }

  clearTradingState(accountId?: AccountId): void {
    this.tx(() => {
      const tables = ["positions", "orders", "reviews", "conversions", "mm_positions", "mm_fills"];
      if (accountId) {
        for (const table of tables) this.run(`DELETE FROM ${table} WHERE account_id=?`, accountId);
      } else {
        for (const table of tables) this.run(`DELETE FROM ${table}`);
      }
    });
  }

  resetBusinessData(): void {
    this.tx(() => {
      for (const table of ["positions", "orders", "reviews", "conversions", "mm_positions", "mm_fills", "audit", "risk_events", "feed", "equity", "calendar"]) {
        this.run(`DELETE FROM ${table}`);
      }
      this.run("DELETE FROM meta WHERE key IN ('seededTrading','orderSeq','reviewSeq','conversionSeq','mmFillSeq')");
    });
  }

  resetAll(): void {
    this.tx(() => {
      for (const table of ["positions", "orders", "reviews", "conversions", "mm_positions", "mm_fills", "audit", "risk_events", "feed", "equity", "calendar", "limits", "rules", "settings", "events", "sessions", "users", "meta"]) {
        this.run(`DELETE FROM ${table}`);
      }
    });
  }
}
