/**
 * Every agreed client viewing (Rental) is an event in the Unicorn Property Google Calendar, in its own
 * colour next to Yudi's inspections (owner, 15.09.2026: "то же самое для воронки Rental с планированием
 * показов, только цвет другой, чтобы визуально было сразу понятно"). Same Make.com webhook as
 * inspection-calendar.ts (lib/google-calendar.ts); the colour rides in the body.
 *
 * Source: `viewing_slots` — thread-stage-sync.ts records a slot when a viewing time is agreed in the thread,
 * viewing-report.ts marks it reported once the report is owed. One event per slot (card + time).
 *
 * The pass (every 5 minutes, and a few seconds after a slot is recorded) only ADDS: a slot scheduled or
 * reported, viewing ahead or at most 1 day past, gets an event once. Nothing is ever edited or deleted
 * afterwards — not by a report (16.09 Anastasia Bondar was deleted by a "cancelled" report), not by the
 * card's stage. Owner, 17.09.2026: "запланировано — факт… только ставить запланированные визиты, удалять
 * ничего не надо". Rows no longer wanted are retired; their events stay.
 *
 * Idempotency lives in `viewing_calendar_events`, with the same create-once rules as
 * inspection_calendar_events: the row is marked `creating` before the call, an unknown outcome becomes
 * `uncertain` and is only re-created with ?retry=1. A failed amoCRM or site read aborts the pass.
 */
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { amoFetch } from "./amo-client";
import { siteGet } from "./listing-status-week";
import { cleanLeadName } from "./lead-display-name";
import {
  calendarConfig,
  createEvent,
  type CalendarEventBody,
} from "./google-calendar";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const PASS_EVERY_MS = 5 * 60_000;
const RECENT_MS = DAY;
const DURATION_MS = HOUR;
const SITE = "https://unicorn-properties.com";
const AMO = "https://unicornproperty.amocrm.ru/leads/detail";
const RENTAL_PIPELINE_ID = 11119150;
/** Google Calendar event colour 10 "Basil" (green). Inspections keep the calendar's own colour. */
export const VIEWING_COLOR_ID = "10";

type SlotRow = {
  id: string;
  lead_id: string;
  viewing_at: string | Date;
  property_code: string | null;
  status: string;
  agreed_at: string | Date | null;
  content: string | null;
  responsible_user: string | null;
};
type StoredRow = { sync_key: string; slot_id: string | null; lead_id: string | null; viewing_at: string | Date | null; event_id: string | null; payload_hash: string | null; status: string };
type AmoLead = { id: number; name: string | null; status_id: number; pipeline_id: number };

export type ViewingCalendarAction = {
  action: "create" | "update" | "unchanged" | "delete" | "retire" | "uncertain" | "error" | "skipped";
  key: string;
  summary?: string;
  start?: string;
  location?: string;
  lead?: string;
  eventId?: string | null;
  detail?: string;
};

let ensured: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  ensured ??= db
    .execute(sql`CREATE TABLE IF NOT EXISTS viewing_calendar_events (
      sync_key TEXT PRIMARY KEY,
      slot_id UUID,
      lead_id TEXT,
      viewing_at TIMESTAMPTZ,
      event_id TEXT,
      calendar_id TEXT,
      payload_hash TEXT,
      status TEXT NOT NULL DEFAULT 'synced',
      last_error TEXT,
      summary TEXT,
      start_at TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
    .then(() => undefined)
    .catch((err) => {
      ensured = null;
      throw err;
    });
  return ensured;
}

const asDate = (v: string | Date | null | undefined) => (v == null ? null : v instanceof Date ? v : new Date(v));

/** Bali is UTC+8 all year: wall-clock ISO without Intl. */
const baliIso = (d: Date) => {
  const b = new Date(d.getTime() + 8 * HOUR).toISOString();
  return `${b.slice(0, 10)}T${b.slice(11, 16)}:00+08:00`;
};
const baliHuman = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Makassar", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

/** A slot at Bali midnight is a day without an agreed hour (thread-stage-sync never records midnight on purpose). */
const timeKnown = (d: Date) => baliIso(d).slice(11, 16) !== "00:00";

/** The client's name from the conversation copy: the first "(клиент - …)" sender that is a person. */
export function clientNameFromContent(content: string | null | undefined): string | null {
  for (const m of String(content ?? "").matchAll(/(?:^|\n|\s)([^\n→]{1,80}?\((?:клиент|client)\s*[-–][^)]*\))\s*→/gi)) {
    const raw = m[1]!.replace(/^[\d.:\s]+/, "").trim();
    const name = cleanLeadName(raw);
    if (name && !/^(lead|client|клиент|whatsapp|guest|user)$/i.test(name.trim())) return name.trim().slice(0, 60);
  }
  return null;
}

/** A person's name from the card title: "FB Lead: Searra" → Searra; "R-UM-024 - qualification" → none. */
function cardClient(name: string | null): string | null {
  const n = (cleanLeadName(name ?? "") ?? "").replace(/^\s*(fb|ig|meta)\s*lead\s*:\s*/i, "").trim();
  return n && !/\d|qualification|lead\b/i.test(n) ? n.slice(0, 60) : null;
}

type Desired = { key: string; slot: SlotRow; lead: AmoLead; body: CalendarEventBody; hash: string; viewingAt: Date };

async function buildPlan(sinceDays?: number): Promise<{ desired: Map<string, Desired>; stored: StoredRow[]; now: Date }> {
  await ensureTable();
  const now = new Date();
  // Every agreed slot is a planned visit, whatever its report says later. ?since= reaches further back (backfill).
  const since = new Date(now.getTime() - (sinceDays ? sinceDays * DAY : RECENT_MS));
  const slotsRes = await db.execute(sql`SELECT s.id, s.lead_id, s.viewing_at, s.property_code, s.status, s.agreed_at, ls.content, ls.responsible_user
      FROM viewing_slots s
      LEFT JOIN viewing_reports r ON r.id = s.report_id
      LEFT JOIN leads_sync ls ON ls.lead_id = s.lead_id
     WHERE s.status IN ('scheduled', 'reported')
       AND s.viewing_at >= ${since.toISOString()}::timestamptz
       AND coalesce(r.feedback, '') NOT ILIKE 'TEST:%'
     ORDER BY s.viewing_at, s.id`);
  const slots = (slotsRes.rows ?? []) as SlotRow[];
  const storedRes = await db.execute(sql`SELECT sync_key, slot_id, lead_id, viewing_at, event_id, payload_hash, status FROM viewing_calendar_events`);
  const stored = (storedRes.rows ?? []) as StoredRow[];
  const desired = new Map<string, Desired>();
  if (slots.length === 0) return { desired, stored, now };

  // amoCRM: the cards' funnel and stage. A failed read aborts — never delete on a bad read.
  const ids = [...new Set(slots.map((s) => s.lead_id))];
  const leads = new Map<string, AmoLead>();
  for (let i = 0; i < ids.length; i += 50) {
    const q = ids.slice(i, i + 50).map((id, j) => `filter[id][${j}]=${id}`).join("&");
    const d = await amoFetch<{ _embedded?: { leads?: AmoLead[] } }>(`/api/v4/leads?${q}&limit=250`);
    if (!d) throw new Error("amoCRM leads could not be read");
    for (const l of d._embedded?.leads ?? []) leads.set(String(l.id), l);
  }
  // Any stage, Closed Lost included: what happened to the client after the viewing is not the calendar's
  // business. A card amoCRM no longer returns keeps its viewing; only a card in another funnel is left out.
  const kept = slots.filter((s) => {
    const l = leads.get(s.lead_id);
    return !l || l.pipeline_id === RENTAL_PIPELINE_ID;
  });
  if (kept.length === 0) return { desired, stored, now };

  const codes = [...new Set(kept.map((s) => (s.property_code ?? "").trim().toUpperCase()).filter(Boolean))];
  const inList = codes.map((c) => `"${c}"`).join(",");
  const props = codes.length ? await siteGet<{ id: string; title: string | null; area: string | null }[]>(`properties?select=id,title,area&id=in.(${inList})`) : [];
  const privs = codes.length
    ? await siteGet<{ property_id: string; owner_name: string | null; exact_address: string | null; google_maps_url: string | null }[]>(
        `property_private?select=property_id,owner_name,exact_address,google_maps_url&property_id=in.(${inList})`,
      )
    : [];
  const propById = new Map(props.map((p) => [p.id.toUpperCase(), p]));
  const privById = new Map(privs.map((p) => [p.property_id.toUpperCase(), p]));

  // Two cards of one client, one visit (Remi Petit, R-YUD-054 10.09): one event.
  const seenVisit = new Set<string>();
  for (const slot of kept) {
    const visitKey = `${(slot.property_code ?? "").trim().toUpperCase()}|${asDate(slot.viewing_at)!.getTime()}`;
    if ((slot.property_code ?? "").trim() && seenVisit.has(visitKey)) continue;
    seenVisit.add(visitKey);
    const lead = leads.get(slot.lead_id) ?? { id: Number(slot.lead_id), name: null, status_id: 0, pipeline_id: RENTAL_PIPELINE_ID };
    const code = (slot.property_code ?? "").trim().toUpperCase() || null;
    const prop = code ? propById.get(code) : undefined;
    const priv = code ? privById.get(code) : undefined;
    const viewingAt = asDate(slot.viewing_at)!;
    const agreedAt = asDate(slot.agreed_at);
    const timed = timeKnown(viewingAt);
    const parsed = clientNameFromContent(slot.content);
    // The thread parse sometimes grabs a sentence ("like to visit? I can check…"): then the card's name.
    const client = parsed && !/[\d?!:]/.test(parsed) && parsed.split(/\s+/).length <= 4 ? parsed : cardClient(lead.name);
    const area = (prop?.area ?? "").trim();
    const mapUrl = (priv?.google_maps_url ?? "").trim();
    const address = (priv?.exact_address ?? "").trim();
    const broker = (slot.responsible_user ?? "").trim();

    const lines: string[] = [];
    lines.push(`Client viewing${timed ? "" : " — the time is NOT fixed in the thread, confirm it with the client"}.`);
    if (client) lines.push(`Client: ${client}`);
    if (broker) lines.push(`Broker: ${broker}`);
    if (prop?.title) lines.push(`Villa: ${prop.title}${code ? ` (${code})` : ""}`);
    else lines.push(code ? `Villa: ${code}` : "Villa: not named in the thread — check the card");
    if (code) lines.push(`Site: ${SITE}/property/${code}`);
    if (area) lines.push(`Area: ${area}`);
    if (address) lines.push(`Address: ${address}`);
    if (mapUrl) lines.push(`Map: ${mapUrl}`);
    if ((priv?.owner_name ?? "").trim()) lines.push(`Owner / manager (access): ${priv!.owner_name!.trim()}`);
    lines.push(`amoCRM card: ${AMO}/${lead.id}`);
    if (agreedAt) lines.push(`Agreed in the thread: ${baliHuman(agreedAt)}`);
    lines.push("", `Written by whatcan from the card's thread (ref slot:${slot.id}); edits here are overwritten when the viewing changes.`);

    const key = `slot:${slot.id}`;
    const body: CalendarEventBody = {
      summary: `Viewing — ${code ?? "villa not named"}${area ? ` ${area}` : ""}${client ? ` · ${client}` : ""}${timed ? "" : " — time not fixed"}`,
      location: mapUrl || address || area,
      description: lines.join("\n"),
      start: baliIso(viewingAt),
      end: baliIso(new Date(viewingAt.getTime() + DURATION_MS)),
      colorId: VIEWING_COLOR_ID,
    };
    const hash = crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex");
    desired.set(key, { key, slot, lead, body, hash, viewingAt });
  }
  return { desired, stored, now };
}

async function writeRow(d: Desired, status: string, eventId: string | null, error: string | null): Promise<void> {
  await db.execute(sql`INSERT INTO viewing_calendar_events (sync_key, slot_id, lead_id, viewing_at, event_id, calendar_id, payload_hash, status, last_error, summary, start_at, updated_at)
    VALUES (${d.key}, ${d.slot.id}, ${String(d.lead.id)}, ${d.viewingAt.toISOString()}, ${eventId}, ${calendarConfig().calendarId},
            ${eventId ? d.hash : null}, ${status}, ${error ? error.slice(0, 500) : null}, ${d.body.summary}, ${d.body.start}, now())
    ON CONFLICT (sync_key) DO UPDATE SET slot_id = EXCLUDED.slot_id, lead_id = EXCLUDED.lead_id, viewing_at = EXCLUDED.viewing_at,
      event_id = COALESCE(EXCLUDED.event_id, viewing_calendar_events.event_id), calendar_id = EXCLUDED.calendar_id,
      payload_hash = COALESCE(EXCLUDED.payload_hash, viewing_calendar_events.payload_hash), status = EXCLUDED.status,
      last_error = EXCLUDED.last_error, summary = EXCLUDED.summary, start_at = EXCLUDED.start_at, updated_at = now()`);
}
async function markRow(key: string, status: string, error: string | null, clearEvent = false): Promise<void> {
  await db
    .execute(sql`UPDATE viewing_calendar_events SET status = ${status}, last_error = ${error},
                 event_id = CASE WHEN ${clearEvent ? "1" : "0"} = '1' THEN NULL ELSE event_id END, updated_at = now() WHERE sync_key = ${key}`)
    .catch(() => undefined);
}

/** Row first, then the call: a crash or a lost reply leaves `creating` / `uncertain`, never a silent second create. */
async function create(d: Desired, base: ViewingCalendarAction, out: ViewingCalendarAction[]): Promise<void> {
  await writeRow(d, "creating", null, null);
  const c = await createEvent(d.body);
  if (c.ok) {
    await writeRow(d, "synced", c.data.id, null);
    out.push({ ...base, action: "create", eventId: c.data.id });
  } else if (c.transport) {
    await writeRow(d, "uncertain", null, c.reason);
    logger.warn({ key: d.key, reason: c.reason }, "viewing calendar: create outcome unknown — not retried automatically, check the calendar");
    out.push({ ...base, action: "uncertain", detail: `${c.reason} — check the calendar, then ?apply=1&retry=1` });
  } else {
    await writeRow(d, "error", null, c.reason);
    out.push({ ...base, action: "error", detail: c.reason });
  }
}

let running = false;

export async function syncViewingCalendar(o: { apply: boolean; reason?: string; retryUncertain?: boolean; sinceDays?: number }): Promise<{ configured: boolean; missing: string[]; actions: ViewingCalendarAction[] }> {
  const cfg = calendarConfig();
  if (o.apply && !cfg.configured) return { configured: false, missing: cfg.missing, actions: [] };
  if (o.apply && running) return { configured: true, missing: [], actions: [{ action: "skipped", key: "*", detail: "a pass is already running" }] };
  if (o.apply) running = true;
  try {
    const { desired, stored, now } = await buildPlan(o.sinceDays);
    const actions: ViewingCalendarAction[] = [];
    const storedByKey = new Map(stored.map((r) => [r.sync_key, r]));

    for (const d of desired.values()) {
      const row = storedByKey.get(d.key);
      const base: ViewingCalendarAction = { action: "skipped", key: d.key, summary: d.body.summary, start: d.body.start, location: d.body.location || undefined, lead: String(d.lead.id) };
      const live = !!row?.event_id && ["synced", "retired", "error"].includes(row.status);
      const unknown = !row?.event_id && (row?.status === "uncertain" || row?.status === "creating");
      if (unknown && !o.retryUncertain) {
        actions.push({ ...base, action: "uncertain", detail: "an earlier create may have written this event — check the calendar, then ?apply=1&retry=1" });
        continue;
      }
      // Written once, never edited or replaced (owner, 17.09.2026: only put planned visits, delete nothing).
      if (live) {
        actions.push({ ...base, action: "unchanged", eventId: row!.event_id });
        if (o.apply && row!.status !== "synced") await markRow(d.key, "synced", null);
        continue;
      }
      if (!o.apply) {
        actions.push({ ...base, action: "create", eventId: null });
        continue;
      }
      await create(d, base, actions);
    }

    for (const row of stored) {
      if (desired.has(row.sync_key) || row.status === "deleted" || row.status === "retired") continue;
      const viewingAt = asDate(row.viewing_at);
      const base: ViewingCalendarAction = { action: "skipped", key: row.sync_key, start: viewingAt ? baliIso(viewingAt) : undefined, lead: row.lead_id ?? undefined, eventId: row.event_id };
      if (!row.event_id) {
        const unsure = row.status === "uncertain" || row.status === "creating";
        actions.push({ ...base, action: unsure ? "uncertain" : "skipped", detail: "no longer wanted; no event id on record" });
        if (o.apply) await markRow(row.sync_key, unsure ? "uncertain" : "deleted", null);
        continue;
      }
      actions.push({ ...base, action: "retire", detail: "no longer planned or past — the event stays, nothing is deleted" });
      if (o.apply) await markRow(row.sync_key, "retired", null);
    }

    if (o.apply) {
      for (const a of actions.filter((x) => x.action !== "unchanged")) {
        logger.info({ key: a.key, eventId: a.eventId, lead: a.lead, start: a.start, reason: o.reason }, `viewing calendar: ${a.action} ${a.summary ?? ""} ${a.detail ?? ""}`.trim());
      }
    }
    return { configured: cfg.configured, missing: cfg.missing, actions };
  } finally {
    if (o.apply) running = false;
  }
}

let queued: ReturnType<typeof setTimeout> | null = null;

/** After a viewing slot is recorded or changed: one pass a few seconds later. Never throws. */
export function queueViewingCalendarSync(reason: string): void {
  if (!calendarConfig().configured) return;
  if (queued) return;
  queued = setTimeout(() => {
    queued = null;
    void syncViewingCalendar({ apply: true, reason }).catch((err) => logger.warn({ err, reason }, "viewing calendar: queued pass failed"));
  }, 8000);
}

export function startViewingCalendarSync(): void {
  const tick = () => {
    if (!calendarConfig().configured) return;
    void syncViewingCalendar({ apply: true, reason: "schedule" }).catch((err) => logger.warn({ err }, "viewing calendar: pass failed"));
  };
  ensureTable().catch((err) => logger.error({ err }, "viewing calendar: table not created"));
  setTimeout(tick, 120_000);
  setInterval(tick, PASS_EVERY_MS);
}

/** The webhook cannot list events: what this sync wrote, from our table. */
export async function viewingEventsFromCalendar(): Promise<Record<string, unknown>> {
  await ensureTable();
  const rows = await db.execute(sql`SELECT sync_key, lead_id, event_id, summary, start_at, status, last_error, updated_at
                                    FROM viewing_calendar_events ORDER BY start_at DESC NULLS LAST`);
  return { configured: calendarConfig().configured, events: rows.rows ?? [] };
}
