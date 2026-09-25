/**
 * Unicorn OS — sign-in, sessions and roles.
 *
 * The OS is a second host of the same data the Copilot already works on
 * (leads_sync, lead_messages, pending_suggestions, amoCRM tasks, the site's
 * catalog). It adds nothing to the business rules; it adds people: every user
 * signs in with their own password and gets a role.
 *
 *  - admin    the owner. Everything, including the team and the switches.
 *  - manager  everything except managing the team.
 *  - broker   their own cards, tasks and calendar; villas read and edit; no
 *             switches, no money (ad spend, AI bill), no one else's cards.
 *
 * Passwords are scrypt hashes (node:crypto, no native module). Sessions are
 * random tokens kept only as a sha256 on our side, in an HttpOnly cookie
 * scoped to /os. The existing /api/public endpoints stay as open as they are
 * today; everything under /os/api requires a session.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { pool } from "@workspace/db";
import { logger } from "../logger";

export type OsRole = "admin" | "manager" | "broker";
export type OsUser = {
  id: number;
  login: string;
  name: string;
  role: OsRole;
  brokerKey: string | null;
  mustChangePassword: boolean;
};

const COOKIE = "uos";
const SESSION_DAYS = 30;

// Starter accounts. Only salted scrypt hashes live here; the passwords were
// handed to the owner once and must be changed on first sign-in.
const SEED_USERS: Array<{ login: string; name: string; role: OsRole; brokerKey: string; hash: string }> = [
  { login: 'nikita', name: 'Nikita', role: 'admin', brokerKey: 'hos', hash: 'scrypt$16384$8$1$O2CLr7XUBwHx_Vxk1F3FzA$hXxmBckT3Qxc-OmKC2yi282pOy33lexyt0FFsr0ZQl5A3t8hv0CWAANd9LVX2aXcVdVcaGPuggPCmIXMJP6VHQ' },
  { login: 'amelia', name: 'Amelia', role: 'broker', brokerKey: 'Amelia', hash: 'scrypt$16384$8$1$EGip_mpnXFi-0p88IFn-PQ$gbYb10FJ1tYqBNTBrAYC1inZACUd8V4THS5TWUgwVtyusBOLAb5QjbuRC9Xnc6ODGwnw7F8puIceb_uY0XS2Mw' },
  { login: 'yudi', name: 'Yudi', role: 'broker', brokerKey: 'Yudi', hash: 'scrypt$16384$8$1$gt9MFikDgkEzKKOfav97ew$Opk9IEXSNIRqW26edVxCBkkZ9_R_SXUBycsxX_eEO0jOLdYJJY1DtlBFBB8H_DQ1M_gpQs1LE22y71_Otx5rbg' },
];

let ready: Promise<void> | null = null;
export function ensureOsTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS os_users (
          id                    serial PRIMARY KEY,
          login                 text NOT NULL UNIQUE,
          name                  text NOT NULL,
          role                  text NOT NULL CHECK (role IN ('admin','manager','broker')),
          broker_key            text,
          password_hash         text NOT NULL,
          must_change_password  boolean NOT NULL DEFAULT true,
          disabled              boolean NOT NULL DEFAULT false,
          notif_seen_at         timestamptz,
          created_at            timestamptz NOT NULL DEFAULT now(),
          last_login_at         timestamptz
        );
        CREATE TABLE IF NOT EXISTS os_sessions (
          token_hash  text PRIMARY KEY,
          user_id     integer NOT NULL REFERENCES os_users(id) ON DELETE CASCADE,
          created_at  timestamptz NOT NULL DEFAULT now(),
          expires_at  timestamptz NOT NULL,
          user_agent  text
        );
        CREATE TABLE IF NOT EXISTS os_audit (
          id          bigserial PRIMARY KEY,
          user_id     integer,
          login       text,
          action      text NOT NULL,
          target      text,
          detail      jsonb,
          created_at  timestamptz NOT NULL DEFAULT now()
        );
      `);
      for (const u of SEED_USERS) {
        await pool.query(
          `INSERT INTO os_users (login, name, role, broker_key, password_hash, must_change_password)
           VALUES ($1, $2, $3, $4, $5, true) ON CONFLICT (login) DO NOTHING`,
          [u.login, u.name, u.role, u.brokerKey, u.hash],
        );
      }
    })().catch((err) => {
      ready = null;
      logger.error({ err }, "os: could not create its tables");
      throw err;
    });
  }
  return ready;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${h.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64url");
  const got = scryptSync(password, Buffer.from(salt, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function rowToUser(r: Record<string, unknown>): OsUser {
  return {
    id: Number(r["id"]),
    login: String(r["login"]),
    name: String(r["name"]),
    role: r["role"] as OsRole,
    brokerKey: (r["broker_key"] as string | null) ?? null,
    mustChangePassword: Boolean(r["must_change_password"]),
  };
}

// Five wrong passwords per login or per address in 15 minutes, then a pause.
const failures = new Map<string, number[]>();
function tooManyFailures(key: string): boolean {
  const now = Date.now();
  const list = (failures.get(key) ?? []).filter((t) => now - t < 15 * 60_000);
  failures.set(key, list);
  return list.length >= 5;
}
function noteFailure(key: string) {
  failures.set(key, [...(failures.get(key) ?? []), Date.now()]);
}

export async function login(req: Request, res: Response): Promise<void> {
  await ensureOsTables();
  const loginName = String(req.body?.login ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  // Through the site's /os proxy every request comes from Cloudflare; the worker
  // passes the visitor's address in x-os-client-ip. A forged header only dodges
  // the per-address limit — the per-login limit still holds.
  const ip = String(req.headers["x-os-client-ip"] ?? req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"] ?? req.ip ?? "").split(",")[0].trim();
  if (!loginName || !password) {
    res.status(400).json({ error: "Enter your login and password." });
    return;
  }
  if (tooManyFailures("l:" + loginName) || tooManyFailures("i:" + ip)) {
    res.status(429).json({ error: "Too many attempts. Wait 15 minutes and try again." });
    return;
  }
  const { rows } = await pool.query(`SELECT * FROM os_users WHERE login = $1 AND NOT disabled`, [loginName]);
  const row = rows[0];
  if (!row || !verifyPassword(password, String(row.password_hash))) {
    noteFailure("l:" + loginName);
    noteFailure("i:" + ip);
    res.status(401).json({ error: "Wrong login or password." });
    return;
  }
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await pool.query(
    `INSERT INTO os_sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, $3, $4)`,
    [sha(token), row.id, expires, String(req.headers["user-agent"] ?? "").slice(0, 200)],
  );
  await pool.query(`UPDATE os_users SET last_login_at = now() WHERE id = $1`, [row.id]);
  await audit(rowToUser(row), "login", null, { ip });
  setSessionCookie(req, res, token, expires);
  res.json({ user: rowToUser(row) });
}

function setSessionCookie(req: Request, res: Response, token: string, expires: Date) {
  const secure = req.secure || String(req.headers["x-forwarded-proto"] ?? "").includes("https") || Boolean(req.headers["cf-ray"]);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${token}; Path=/os; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure ? "; Secure" : ""}`,
  );
}

function readCookie(req: Request): string | null {
  const raw = String(req.headers.cookie ?? "");
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=") || null;
  }
  return null;
}

export async function logout(req: Request, res: Response): Promise<void> {
  const token = readCookie(req);
  if (token) await pool.query(`DELETE FROM os_sessions WHERE token_hash = $1`, [sha(token)]).catch(() => undefined);
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/os; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}

export async function currentUser(req: Request): Promise<OsUser | null> {
  const token = readCookie(req);
  if (!token) return null;
  await ensureOsTables();
  const { rows } = await pool.query(
    `SELECT u.* FROM os_sessions s JOIN os_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`,
    [sha(token)],
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { osUser?: OsUser }
  }
}

/** Every /os/api route except sign-in goes through this. */
export function requireOsUser(roles?: OsRole[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await currentUser(req);
      if (!user) {
        res.status(401).json({ error: "Sign in first." });
        return;
      }
      if (roles && !roles.includes(user.role)) {
        res.status(403).json({ error: "Your role cannot do this." });
        return;
      }
      req.osUser = user;
      next();
    } catch (err) {
      logger.error({ err }, "os: session check failed");
      res.status(500).json({ error: "Session check failed." });
    }
  };
}

export const isStaff = (u: OsUser | undefined | null) => !!u && (u.role === "admin" || u.role === "manager");

/** Whose cards this user may see: null = everyone's. */
export function brokerScope(u: OsUser): string | null {
  return isStaff(u) ? null : (u.brokerKey ?? "__none__");
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const user = req.osUser!;
  const current = String(req.body?.current ?? "");
  const next = String(req.body?.next ?? "");
  if (next.length < 10) {
    res.status(400).json({ error: "Use at least 10 characters." });
    return;
  }
  const { rows } = await pool.query(`SELECT password_hash FROM os_users WHERE id = $1`, [user.id]);
  if (!rows[0] || !verifyPassword(current, String(rows[0].password_hash))) {
    res.status(401).json({ error: "The current password is wrong." });
    return;
  }
  await pool.query(`UPDATE os_users SET password_hash = $1, must_change_password = false WHERE id = $2`, [hashPassword(next), user.id]);
  await audit(user, "password.change", String(user.id), null);
  res.json({ ok: true });
}

export async function listUsers(): Promise<Array<OsUser & { disabled: boolean; lastLoginAt: string | null }>> {
  await ensureOsTables();
  const { rows } = await pool.query(`SELECT * FROM os_users ORDER BY role, name`);
  return rows.map((r) => ({ ...rowToUser(r), disabled: Boolean(r.disabled), lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null }));
}

function tempPassword(): string {
  return randomBytes(9).toString("base64url");
}

export async function createUser(by: OsUser, input: { login: string; name: string; role: OsRole; brokerKey?: string | null }): Promise<{ user: OsUser; password: string }> {
  const login = input.login.trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}$/.test(login)) throw new Error("Login: 2–32 letters, digits, dot, dash or underscore.");
  if (!["admin", "manager", "broker"].includes(input.role)) throw new Error("Unknown role.");
  const password = tempPassword();
  const { rows } = await pool.query(
    `INSERT INTO os_users (login, name, role, broker_key, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5,true) RETURNING *`,
    [login, input.name.trim() || login, input.role, input.brokerKey?.trim() || null, hashPassword(password)],
  );
  await audit(by, "user.create", login, { role: input.role, brokerKey: input.brokerKey ?? null });
  return { user: rowToUser(rows[0]), password };
}

export async function resetPassword(by: OsUser, id: number): Promise<string> {
  const password = tempPassword();
  const { rowCount } = await pool.query(`UPDATE os_users SET password_hash = $1, must_change_password = true WHERE id = $2`, [hashPassword(password), id]);
  if (!rowCount) throw new Error("No such user.");
  await pool.query(`DELETE FROM os_sessions WHERE user_id = $1`, [id]);
  await audit(by, "user.reset-password", String(id), null);
  return password;
}

export async function updateUser(by: OsUser, id: number, patch: { role?: OsRole; brokerKey?: string | null; disabled?: boolean; name?: string }): Promise<void> {
  if (id === by.id && (patch.disabled || (patch.role && patch.role !== "admin"))) throw new Error("You cannot lock yourself out.");
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.role) { vals.push(patch.role); sets.push(`role = $${vals.length}`); }
  if (patch.brokerKey !== undefined) { vals.push(patch.brokerKey || null); sets.push(`broker_key = $${vals.length}`); }
  if (patch.disabled !== undefined) { vals.push(patch.disabled); sets.push(`disabled = $${vals.length}`); }
  if (patch.name) { vals.push(patch.name); sets.push(`name = $${vals.length}`); }
  if (!sets.length) return;
  vals.push(id);
  await pool.query(`UPDATE os_users SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  if (patch.disabled) await pool.query(`DELETE FROM os_sessions WHERE user_id = $1`, [id]);
  await audit(by, "user.update", String(id), patch);
}

export async function audit(user: OsUser | null, action: string, target: string | null, detail: unknown): Promise<void> {
  await pool
    .query(`INSERT INTO os_audit (user_id, login, action, target, detail) VALUES ($1,$2,$3,$4,$5)`, [
      user?.id ?? null, user?.login ?? null, action, target, detail == null ? null : JSON.stringify(detail),
    ])
    .catch((err) => logger.warn({ err, action }, "os: audit write failed"));
}
