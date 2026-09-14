/**
 * Google Calendar API client for the shared "Brokers" calendar (owner, 14.09.2026: every agreed villa
 * inspection becomes a short note there, so Yudi opens the calendar and sees today's visits).
 *
 * Auth — a Google SERVICE ACCOUNT (the OAuth consent as info@unicorn-property.com failed with
 * invalid_grant on 14.09). The Brokers calendar is shared with the service account's email with
 * "Make changes to events"; no domain-wide delegation, no impersonation. JWT bearer grant: an RS256
 * assertion signed with node:crypto (scope calendar.events) → access token, cached until a minute
 * before it expires. Env: GOOGLE_CALENDAR_SA_KEY_FILE (path of the JSON key, chmod 600, never in git)
 * and GOOGLE_CALENDAR_ID. The refresh-token path (GOOGLE_CALENDAR_CLIENT_ID / _CLIENT_SECRET /
 * _REFRESH_TOKEN) is kept as a fallback, used only when no key file is configured.
 *
 * Fail soft: every call returns { ok: false, reason } instead of throwing, and nothing here ever logs a
 * credential or the key file's content. No attendees are ever sent (a service account cannot invite
 * anyway) and every write carries sendUpdates=none.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { logger } from "./logger";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const REFRESH_NAMES = ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REFRESH_TOKEN"] as const;

export type CalendarEventTime = { dateTime?: string; date?: string; timeZone?: string };
export type CalendarEventBody = {
  summary: string;
  description?: string;
  location?: string;
  start: CalendarEventTime;
  end: CalendarEventTime;
  reminders?: { useDefault: boolean; overrides?: Array<{ method: "popup" | "email"; minutes: number }> };
  extendedProperties?: { private?: Record<string, string> };
  transparency?: "opaque" | "transparent";
  guestsCanInviteOthers?: boolean;
  guestsCanSeeOtherGuests?: boolean;
};
export type CalendarEvent = CalendarEventBody & {
  id: string;
  status?: string;
  htmlLink?: string;
  updated?: string;
};
export type CalResult<T> = { ok: true; data: T } | { ok: false; status: number; reason: string };

const env = (k: string) => (process.env[k] ?? "").trim();

export function calendarConfig(): { configured: boolean; missing: string[]; calendarId: string; auth: "service-account" | "refresh-token" | "none" } {
  const calendarId = env("GOOGLE_CALENDAR_ID");
  const keyFile = env("GOOGLE_CALENDAR_SA_KEY_FILE");
  const missing: string[] = [];
  if (!calendarId) missing.push("GOOGLE_CALENDAR_ID");
  let auth: "service-account" | "refresh-token" | "none" = "none";
  if (keyFile) {
    if (fs.existsSync(keyFile)) auth = "service-account";
    else missing.push(`GOOGLE_CALENDAR_SA_KEY_FILE (file not found)`);
  } else if (REFRESH_NAMES.every((k) => env(k))) {
    auth = "refresh-token";
  } else {
    missing.push("GOOGLE_CALENDAR_SA_KEY_FILE");
  }
  return { configured: !!calendarId && auth !== "none", missing, calendarId, auth };
}

let cached: { token: string; exp: number } | null = null;
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Service-account JWT assertion. Errors name the failing step only — never key content. */
function serviceAccountAssertion(): { ok: true; assertion: string; tokenUri: string } | { ok: false; reason: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(env("GOOGLE_CALENDAR_SA_KEY_FILE"), "utf8");
  } catch (err) {
    return { ok: false, reason: `service account key file unreadable (${(err as NodeJS.ErrnoException)?.code ?? "error"})` };
  }
  let key: { client_email?: string; private_key?: string; token_uri?: string };
  try {
    key = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "service account key file is not valid JSON" };
  }
  if (!key.client_email || !key.private_key) return { ok: false, reason: "service account key file lacks client_email / private_key" };
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = key.token_uri || TOKEN_URL;
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }),
  )}`;
  try {
    const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(key.private_key);
    return { ok: true, assertion: `${unsigned}.${b64url(sig)}`, tokenUri };
  } catch {
    return { ok: false, reason: "service account private key could not sign the assertion" };
  }
}

async function accessToken(): Promise<CalResult<string>> {
  if (cached && Date.now() < cached.exp) return { ok: true, data: cached.token };
  const cfg = calendarConfig();
  if (!cfg.configured) return { ok: false, status: 0, reason: `not configured: ${cfg.missing.join(", ")} missing` };
  let url = TOKEN_URL;
  let form: URLSearchParams;
  if (cfg.auth === "service-account") {
    const a = serviceAccountAssertion();
    if (!a.ok) return { ok: false, status: 0, reason: a.reason };
    url = a.tokenUri;
    form = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: a.assertion });
  } else {
    form = new URLSearchParams({
      client_id: env("GOOGLE_CALENDAR_CLIENT_ID"),
      client_secret: env("GOOGLE_CALENDAR_CLIENT_SECRET"),
      refresh_token: env("GOOGLE_CALENDAR_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    });
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number; error?: string; error_description?: string } | null;
    if (!res.ok || !body?.access_token) {
      const err = body?.error ?? `HTTP ${res.status}`;
      const reason =
        `${cfg.auth} token exchange failed: ${err}` +
        (body?.error_description ? ` (${body.error_description.slice(0, 160)})` : "") +
        (err === "invalid_grant" ? (cfg.auth === "service-account" ? " — key revoked/deleted or server clock off; see CLAUDE.md" : " — refresh token revoked; see CLAUDE.md") : "");
      return { ok: false, status: res.status, reason };
    }
    cached = { token: body.access_token, exp: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000 };
    return { ok: true, data: cached.token };
  } catch (err) {
    return { ok: false, status: 0, reason: `token exchange threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function call<T>(method: string, path: string, o: { query?: Record<string, string>; body?: unknown } = {}): Promise<CalResult<T>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await accessToken();
    if (!tok.ok) return tok;
    const cal = encodeURIComponent(calendarConfig().calendarId);
    const qs = o.query ? `?${new URLSearchParams(o.query).toString()}` : "";
    try {
      const res = await fetch(`${API}/calendars/${cal}${path}${qs}`, {
        method,
        headers: { Authorization: `Bearer ${tok.data}`, ...(o.body ? { "Content-Type": "application/json" } : {}) },
        body: o.body ? JSON.stringify(o.body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 401 && attempt === 0) {
        cached = null;
        continue;
      }
      if (res.status === 204) return { ok: true, data: null as T };
      const data = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
      if (!res.ok) {
        return { ok: false, status: res.status, reason: `${method} ${path.split("?")[0]} → ${res.status} ${(data?.error?.message ?? "").slice(0, 200)}`.trim() };
      }
      return { ok: true, data: data as T };
    } catch (err) {
      return { ok: false, status: 0, reason: `${method} ${path} threw: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: false, status: 401, reason: "unauthorized twice" };
}

const NO_MAIL = { sendUpdates: "none" };

export async function createEvent(event: CalendarEventBody): Promise<CalResult<CalendarEvent>> {
  const r = await call<CalendarEvent>("POST", "/events", { query: NO_MAIL, body: event });
  if (!r.ok) logger.warn({ reason: r.reason }, "google-calendar: create failed");
  return r;
}

export async function patchEvent(id: string, event: Partial<CalendarEventBody>): Promise<CalResult<CalendarEvent>> {
  const r = await call<CalendarEvent>("PATCH", `/events/${encodeURIComponent(id)}`, { query: NO_MAIL, body: event });
  if (!r.ok) logger.warn({ reason: r.reason, eventId: id }, "google-calendar: patch failed");
  return r;
}

/** Already gone (404 / 410) counts as deleted. */
export async function deleteEvent(id: string): Promise<CalResult<null>> {
  const r = await call<null>("DELETE", `/events/${encodeURIComponent(id)}`, { query: NO_MAIL });
  if (!r.ok && (r.status === 404 || r.status === 410)) return { ok: true, data: null };
  if (!r.ok) logger.warn({ reason: r.reason, eventId: id }, "google-calendar: delete failed");
  return r;
}

export async function getEvent(id: string): Promise<CalResult<CalendarEvent>> {
  return call<CalendarEvent>("GET", `/events/${encodeURIComponent(id)}`);
}

/** Live (not cancelled) events carrying a private extended property, optionally within a window. */
export async function listEvents(o: { privateProperty?: string; timeMin?: Date; timeMax?: Date; max?: number }): Promise<CalResult<CalendarEvent[]>> {
  const out: CalendarEvent[] = [];
  let pageToken = "";
  for (let page = 0; page < 10; page++) {
    const query: Record<string, string> = { maxResults: String(Math.min(o.max ?? 250, 250)), singleEvents: "true" };
    if (o.privateProperty) query["privateExtendedProperty"] = o.privateProperty;
    if (o.timeMin) query["timeMin"] = o.timeMin.toISOString();
    if (o.timeMax) query["timeMax"] = o.timeMax.toISOString();
    if (o.timeMin && o.timeMax) query["orderBy"] = "startTime";
    if (pageToken) query["pageToken"] = pageToken;
    const r = await call<{ items?: CalendarEvent[]; nextPageToken?: string }>("GET", "/events", { query });
    if (!r.ok) return r;
    out.push(...(r.data.items ?? []).filter((e) => e.status !== "cancelled"));
    pageToken = r.data.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return { ok: true, data: out };
}
