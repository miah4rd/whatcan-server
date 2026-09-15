/**
 * Writes to the shared "Brokers" Google Calendar (owner, 14.09.2026: every agreed villa inspection
 * becomes a short note there, so Yudi opens the calendar and sees today's visits).
 *
 * Transport — a Make.com scenario: custom webhook → Google Calendar modules on info@unicorn-property.com's
 * connection → Webhook response. Direct Google access is closed (14.09.2026): the OAuth consent failed
 * (invalid_grant), the organisation forbids service account keys (iam.disableServiceAccountKeyCreation).
 *
 * Protocol: POST JSON { secret, action: "create" | "update" | "delete", calendarId, eventId?, summary,
 * description, location, start, end } (ISO with +08:00) → direct JSON { ok: true, id } | { ok: false, error }.
 * A Make webhook can take a few seconds, and answers plain "Accepted" when the scenario is inactive (the
 * request is queued, not run): any non-JSON body is a failure, retried on the next pass. No health check.
 * The scenario sets the reminders and adds no guests.
 *
 * Env: GOOGLE_CALENDAR_WEBHOOK_URL (https://hook.us2.make.com/…), GOOGLE_CALENDAR_WEBHOOK_SECRET,
 * GOOGLE_CALENDAR_ID. Fail soft: every call returns { ok: false, reason }; neither the secret nor the URL
 * is ever logged.
 */
import { logger } from "./logger";

const ENV_NAMES = ["GOOGLE_CALENDAR_WEBHOOK_URL", "GOOGLE_CALENDAR_WEBHOOK_SECRET", "GOOGLE_CALENDAR_ID"] as const;
const TIMEOUT_MS = 60_000;

export type CalendarEventBody = {
  summary: string;
  description: string;
  location: string;
  /** ISO datetime with +08:00 */
  start: string;
  end: string;
  /** Google event colour id ("1".."11"); empty keeps the calendar's colour. Viewings are green, inspections default. */
  colorId?: string;
};
/** `transport`: the request may have reached the scenario but its answer was lost (timeout, network) — outcome unknown. */
export type CalResult<T> = { ok: true; data: T } | { ok: false; reason: string; transport: boolean };

const env = (k: (typeof ENV_NAMES)[number]) => (process.env[k] ?? "").trim();

export function calendarConfig(): { configured: boolean; missing: string[]; calendarId: string } {
  const missing = ENV_NAMES.filter((k) => !env(k));
  return { configured: missing.length === 0, missing, calendarId: env("GOOGLE_CALENDAR_ID") };
}

type Reply = { ok?: boolean; id?: string; error?: string };

async function send(action: string, ev: Partial<CalendarEventBody>, eventId?: string): Promise<CalResult<Reply>> {
  const cfg = calendarConfig();
  if (!cfg.configured) return { ok: false, reason: `not configured: ${cfg.missing.join(", ")} missing`, transport: false };
  let res: Response;
  try {
    res = await fetch(env("GOOGLE_CALENDAR_WEBHOOK_URL"), {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env("GOOGLE_CALENDAR_WEBHOOK_SECRET"),
        action,
        calendarId: cfg.calendarId,
        ...(eventId ? { eventId } : {}),
        summary: ev.summary ?? "",
        description: ev.description ?? "",
        location: ev.location ?? "",
        start: ev.start ?? "",
        end: ev.end ?? "",
        colorId: ev.colorId ?? "",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "error";
    // A timeout may have run the scenario; a refused connection or DNS failure did not.
    const unknown = name === "TimeoutError" || name === "AbortError";
    return { ok: false, reason: `webhook ${action} failed: ${name}`, transport: unknown };
  }
  const text = await res.text().catch(() => "");
  let body: Reply | null = null;
  try {
    body = JSON.parse(text) as Reply;
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object") {
    const hint = /^\s*accepted\s*$/i.test(text) ? "scenario inactive (Make answered Accepted)" : "reply is not JSON";
    return { ok: false, reason: `webhook ${action}: HTTP ${res.status}, ${hint}`, transport: false };
  }
  if (body.ok !== true) return { ok: false, reason: `scenario error: ${String(body.error ?? `HTTP ${res.status}`).slice(0, 200)}`, transport: false };
  return { ok: true, data: body };
}

/** An update / delete on an event that no longer exists — Google's wording varies, so it is matched loosely. */
export const isMissingEventError = (reason: string) => /not\s*found|404|410|no (such )?event|does not exist|deleted|invalid (event|id)/i.test(reason);

export async function createEvent(ev: CalendarEventBody): Promise<CalResult<{ id: string }>> {
  const r = await send("create", ev);
  if (!r.ok) {
    logger.warn({ reason: r.reason }, "google-calendar: create failed");
    return r;
  }
  if (!r.data.id) return { ok: false, reason: "scenario said ok but returned no event id", transport: true };
  return { ok: true, data: { id: String(r.data.id) } };
}

export async function updateEvent(id: string, ev: CalendarEventBody): Promise<CalResult<{ id: string }>> {
  const r = await send("update", ev, id);
  if (!r.ok) {
    logger.warn({ reason: r.reason, eventId: id }, "google-calendar: update failed");
    return r;
  }
  return { ok: true, data: { id: r.data.id ? String(r.data.id) : id } };
}

/** Already gone counts as deleted. */
export async function deleteEvent(id: string): Promise<CalResult<null>> {
  const r = await send("delete", {}, id);
  if (!r.ok && !r.transport && isMissingEventError(r.reason)) return { ok: true, data: null };
  if (!r.ok) {
    logger.warn({ reason: r.reason, eventId: id }, "google-calendar: delete failed");
    return r;
  }
  return { ok: true, data: null };
}
