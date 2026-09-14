/**
 * Every agreed villa inspection is a note in the shared "Brokers" Google Calendar (owner, 14.09.2026:
 * "вилла такая-то, время такое-то, инспекция. Юди может открывать календарь и сразу смотреть, какие у
 * него сегодня встречи").
 *
 * Source: `listing_inspection_slots` (written by listing-progress.ts when a Rental Listings card goes to
 * Inspection sceduled, id 87763170). The current agreement of a card is its latest recorded slot.
 *
 * One event per VILLA visit: the key is the listing code when the card resolves to one (listing_crm_link,
 * else exactly one site code in the card's name or notes) — duplicate cards of one villa (23305115 and
 * 23541159, Umbala, 14.09) share one event — and `lead:<id>` when it does not.
 *
 * The pass (every 5 minutes, and a few seconds after a slot is recorded):
 * - slot visit in the future or at most 1 day past, card in Inspection sceduled or further (live, weekly
 *   check, availability received, won) → the event exists and matches (create / patch);
 * - card went back (QUALIFIED, TAKEN TO WORK, Initial Contact), lost / parked, left the funnel, or its
 *   slot disappeared → the event is deleted;
 * - visit more than a day past → the row is retired; the event stays as history.
 * Idempotent: `inspection_calendar_events` holds the event id per key, and before creating, the calendar
 * is searched for the key in the event's private extended properties (whatcanKey), so a lost row never
 * duplicates an event. A failed amoCRM or site read aborts the pass: nothing is deleted on a bad read.
 */
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { amoFetch } from "./amo-client";
import { LISTINGS_PIPELINE_ID, LISTING_STAGE, siteGet } from "./listing-status-week";
import {
  calendarConfig,
  createEvent,
  deleteEvent,
  getEvent,
  listEvents,
  patchEvent,
  type CalendarEvent,
  type CalendarEventBody,
} from "./google-calendar";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const PASS_EVERY_MS = 5 * 60_000;
const RECENT_MS = DAY;
const DURATION_MS = HOUR;
const SITE = "https://unicorn-properties.com";
const AMO = "https://unicornproperty.amocrm.ru/leads/detail";
const SOURCE_TAG = "inspection";

/** Where a card with an agreed visit may sit and still have the visit on the calendar. */
const KEEP = new Set<number>([
  LISTING_STAGE.INSPECTION_SCHEDULED,
  LISTING_STAGE.LIVE,
  LISTING_STAGE.WEEKLY_CHECK_SENT,
  LISTING_STAGE.AVAILABILITY_RECEIVED,
  LISTING_STAGE.WON,
]);

type SlotRow = { id: string; lead_id: string; visit_at: string | Date; time_known: boolean; agreed_at: string | Date | null; quote: string | null; created_at: string | Date };
type StoredRow = { sync_key: string; slot_id: string | null; lead_ids: string | null; visit_at: string | Date | null; event_id: string | null; payload_hash: string | null; status: string };
type AmoLead = { id: number; name: string | null; status_id: number; pipeline_id: number };

export type CalendarAction = {
  action: "create" | "patch" | "unchanged" | "adopt" | "delete" | "retire" | "error" | "skipped";
  key: string;
  summary?: string;
  start?: string;
  location?: string;
  leads?: string[];
  eventId?: string | null;
  detail?: string;
};

let ensured: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  ensured ??= db
    .execute(sql`CREATE TABLE IF NOT EXISTS inspection_calendar_events (
      sync_key TEXT PRIMARY KEY,
      slot_id UUID,
      lead_ids TEXT,
      visit_at TIMESTAMPTZ,
      event_id TEXT,
      calendar_id TEXT,
      payload_hash TEXT,
      status TEXT NOT NULL DEFAULT 'synced',
      last_error TEXT,
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
const enc = encodeURIComponent;

/** Bali is UTC+8 all year: wall-clock parts without Intl. */
function baliIso(d: Date): { date: string; dateTime: string } {
  const b = new Date(d.getTime() + 8 * HOUR).toISOString();
  return { date: b.slice(0, 10), dateTime: `${b.slice(0, 10)}T${b.slice(11, 16)}:00+08:00` };
}
const baliHuman = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Makassar", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

/** "[LISTED R-YUD-097] Villa Ma'Wa - Berawa Semat - 2BR - 44M mo" → "Villa Ma'Wa"; "Сделка #123" → null. */
export function villaNameFromCard(name: string | null | undefined): string | null {
  let s = String(name ?? "").replace(/^\s*(\[[^\]]*\]\s*)+/, "").trim();
  s = s.split(/\s+[-–—|]\s+/)[0]!.trim();
  if (!s || /^(сделка|deal|lead)\s*#?\s*\d+$/i.test(s) || /^#?\d+$/.test(s)) return null;
  return s.slice(0, 80);
}

const CODE_RX = /(?<![A-Za-z0-9-])(R-[A-Za-z]+-\d+)(?![0-9])/g;

type Desired = { key: string; slot: SlotRow; leads: AmoLead[]; body: CalendarEventBody; hash: string; visitAt: Date };

type Plan = { desired: Map<string, Desired>; stored: StoredRow[]; now: Date };

async function buildPlan(): Promise<Plan> {
  await ensureTable();
  const now = new Date();
  const slotsRes = await db.execute(sql`SELECT DISTINCT ON (lead_id) id, lead_id, visit_at, time_known, agreed_at, quote, created_at
                                        FROM listing_inspection_slots ORDER BY lead_id, created_at DESC, visit_at DESC`);
  const latest = (slotsRes.rows ?? []) as SlotRow[];
  const candidates = latest.filter((s) => asDate(s.visit_at)!.getTime() >= now.getTime() - RECENT_MS);
  const storedRes = await db.execute(sql`SELECT sync_key, slot_id, lead_ids, visit_at, event_id, payload_hash, status FROM inspection_calendar_events`);
  const stored = (storedRes.rows ?? []) as StoredRow[];
  const desired = new Map<string, Desired>();
  if (candidates.length === 0) return { desired, stored, now };

  // amoCRM: the cards' stage and name. A failed read aborts — never delete on a bad read.
  const ids = [...new Set(candidates.map((s) => s.lead_id))];
  const leads = new Map<string, AmoLead>();
  for (let i = 0; i < ids.length; i += 50) {
    const q = ids.slice(i, i + 50).map((id, j) => `filter[id][${j}]=${id}`).join("&");
    const d = await amoFetch<{ _embedded?: { leads?: AmoLead[] } }>(`/api/v4/leads?${q}&limit=250`);
    if (!d) throw new Error("amoCRM leads could not be read");
    for (const l of d._embedded?.leads ?? []) leads.set(String(l.id), l);
  }
  const kept = candidates.filter((s) => {
    const l = leads.get(s.lead_id);
    return !!l && l.pipeline_id === LISTINGS_PIPELINE_ID && KEEP.has(l.status_id);
  });
  if (kept.length === 0) return { desired, stored, now };

  // Which listing each card is: the site link, else exactly one site code in its name or notes.
  const keptIds = kept.map((s) => s.lead_id);
  const links = await siteGet<{ property_id: string; amo_lead_id: number }[]>(
    `listing_crm_link?select=property_id,amo_lead_id&amo_lead_id=in.(${keptIds.join(",")})`,
  );
  const codeByLead = new Map<string, string>();
  for (const l of links) {
    const prev = codeByLead.get(String(l.amo_lead_id));
    // A card linked to two listings is not guessed.
    codeByLead.set(String(l.amo_lead_id), prev && prev !== l.property_id.toUpperCase() ? "" : l.property_id.toUpperCase());
  }
  const unlinked = keptIds.filter((id) => !codeByLead.has(id));
  if (unlinked.length) {
    const text = new Map<string, string>(unlinked.map((id) => [id, leads.get(id)?.name ?? ""]));
    const q = unlinked.map((id) => `filter[entity_id][]=${id}`).join("&");
    const d = await amoFetch<{ _embedded?: { notes?: { entity_id: number; params?: { text?: string } }[] } }>(
      `/api/v4/leads/notes?${q}&filter[note_type][]=common&limit=250`,
    );
    for (const n of d?._embedded?.notes ?? []) text.set(String(n.entity_id), `${text.get(String(n.entity_id)) ?? ""}\n${n.params?.text ?? ""}`);
    const found = new Map<string, Set<string>>();
    for (const [id, t] of text) found.set(id, new Set([...t.matchAll(CODE_RX)].map((m) => m[1]!.toUpperCase())));
    const all = [...new Set([...found.values()].flatMap((s) => [...s]))];
    const existing = all.length
      ? new Set((await siteGet<{ id: string }[]>(`properties?select=id&id=in.(${all.map((c) => `"${c}"`).join(",")})`)).map((r) => r.id.toUpperCase()))
      : new Set<string>();
    for (const [id, codes] of found) {
      const real = [...codes].filter((c) => existing.has(c));
      if (real.length === 1) codeByLead.set(id, real[0]!);
    }
  }

  const codes = [...new Set([...codeByLead.values()].filter(Boolean))];
  const inList = codes.map((c) => `"${c}"`).join(",");
  const props = codes.length ? await siteGet<{ id: string; title: string | null; area: string | null }[]>(`properties?select=id,title,area&id=in.(${inList})`) : [];
  const privs = codes.length
    ? await siteGet<{ property_id: string; owner_name: string | null; exact_address: string | null; google_maps_url: string | null }[]>(
        `property_private?select=property_id,owner_name,exact_address,google_maps_url&property_id=in.(${inList})`,
      )
    : [];
  const propById = new Map(props.map((p) => [p.id.toUpperCase(), p]));
  const privById = new Map(privs.map((p) => [p.property_id.toUpperCase(), p]));

  // Group by villa; the latest recorded slot of the group is the agreement.
  const groups = new Map<string, SlotRow[]>();
  for (const s of kept) {
    const code = codeByLead.get(s.lead_id) || "";
    const key = code && propById.has(code) ? `prop:${code}` : `lead:${s.lead_id}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const [key, slots] of groups) {
    slots.sort((a, b) => asDate(b.created_at)!.getTime() - asDate(a.created_at)!.getTime());
    const slot = slots[0]!;
    const cards = [slot.lead_id, ...slots.slice(1).map((s) => s.lead_id).filter((id) => id !== slot.lead_id)].map((id) => leads.get(id)!);
    const code = key.startsWith("prop:") ? key.slice(5) : null;
    const prop = code ? propById.get(code) : undefined;
    const priv = code ? privById.get(code) : undefined;
    const visitAt = asDate(slot.visit_at)!;
    const agreedAt = asDate(slot.agreed_at);
    const villa = cards.map((c) => villaNameFromCard(c.name)).find(Boolean) ?? prop?.title ?? `card #${slot.lead_id}`;
    const mapUrl = (priv?.google_maps_url ?? "").trim();
    const address = (priv?.exact_address ?? "").trim();
    const b = baliIso(visitAt);
    const timed = slot.time_known === true;

    const lines: string[] = [];
    lines.push(`Villa inspection${timed ? "" : " — the time is NOT fixed in the thread, confirm it with the villa side"}.`);
    if (prop?.title) lines.push(`Listing: ${prop.title}${code ? ` (${code})` : ""}`);
    if (code) lines.push(`Site: ${SITE}/property/${code}`);
    if ((priv?.owner_name ?? "").trim()) lines.push(`Owner / manager: ${priv!.owner_name!.trim()}`);
    if ((prop?.area ?? "").trim()) lines.push(`Area: ${prop!.area!.trim()}`);
    if (address) lines.push(`Address: ${address}`);
    if (mapUrl) lines.push(`Map: ${mapUrl}`);
    lines.push(`amoCRM card: ${AMO}/${cards[0]!.id}`);
    for (const c of cards.slice(1)) lines.push(`Same villa, another card: ${AMO}/${c.id}`);
    if ((slot.quote ?? "").trim()) lines.push(`Agreed${agreedAt ? ` ${baliHuman(agreedAt)}` : ""}: "${slot.quote!.trim().slice(0, 200)}"`);
    lines.push("", "Written by whatcan from the card's thread; edits here are overwritten when the visit changes.");

    const body: CalendarEventBody = {
      summary: `Inspection — ${villa}${code ? ` (${code})` : ""}${timed ? "" : " — time not fixed"}`,
      location: mapUrl || address || (prop?.area ?? "").trim() || undefined,
      description: lines.join("\n"),
      start: timed ? { dateTime: b.dateTime, timeZone: "Asia/Makassar" } : { date: b.date },
      end: timed
        ? { dateTime: baliIso(new Date(visitAt.getTime() + DURATION_MS)).dateTime, timeZone: "Asia/Makassar" }
        : { date: baliIso(new Date(visitAt.getTime() + DAY)).date },
      // An all-day note reminds at 17:00 the day before (minutes before its midnight).
      reminders: { useDefault: false, overrides: timed ? [{ method: "popup", minutes: 60 }, { method: "popup", minutes: 15 }] : [{ method: "popup", minutes: 420 }] },
      extendedProperties: {
        private: { whatcanSource: SOURCE_TAG, whatcanKey: key, whatcanSlotId: slot.id, whatcanLeadIds: cards.map((c) => c.id).join(",") },
      },
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: false,
    };
    const hash = crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex");
    desired.set(key, { key, slot, leads: cards, body, hash, visitAt });
  }
  return { desired, stored, now };
}

const startOf = (b: CalendarEventBody) => b.start.dateTime ?? `${b.start.date} (all day)`;

async function saveRow(d: Desired, eventId: string, status = "synced"): Promise<void> {
  await db.execute(sql`INSERT INTO inspection_calendar_events (sync_key, slot_id, lead_ids, visit_at, event_id, calendar_id, payload_hash, status, last_error, updated_at)
    VALUES (${d.key}, ${d.slot.id}, ${d.leads.map((l) => l.id).join(",")}, ${d.visitAt.toISOString()}, ${eventId}, ${calendarConfig().calendarId}, ${d.hash}, ${status}, NULL, now())
    ON CONFLICT (sync_key) DO UPDATE SET slot_id = EXCLUDED.slot_id, lead_ids = EXCLUDED.lead_ids, visit_at = EXCLUDED.visit_at, event_id = EXCLUDED.event_id,
      calendar_id = EXCLUDED.calendar_id, payload_hash = EXCLUDED.payload_hash, status = EXCLUDED.status, last_error = NULL, updated_at = now()`);
}
async function markRow(key: string, status: string, error: string | null): Promise<void> {
  await db.execute(sql`UPDATE inspection_calendar_events SET status = ${status}, last_error = ${error}, updated_at = now() WHERE sync_key = ${key}`).catch(() => undefined);
}
async function noteError(d: Desired, reason: string): Promise<void> {
  await db
    .execute(sql`INSERT INTO inspection_calendar_events (sync_key, slot_id, lead_ids, visit_at, status, last_error)
      VALUES (${d.key}, ${d.slot.id}, ${d.leads.map((l) => l.id).join(",")}, ${d.visitAt.toISOString()}, 'error', ${reason.slice(0, 500)})
      ON CONFLICT (sync_key) DO UPDATE SET last_error = EXCLUDED.last_error, updated_at = now()`)
    .catch(() => undefined);
}

/** Create, or adopt what the calendar already holds for this key (a lost row never duplicates). */
async function ensureEvent(d: Desired, out: CalendarAction[]): Promise<void> {
  const base = { key: d.key, summary: d.body.summary, start: startOf(d.body), location: d.body.location, leads: d.leads.map((l) => String(l.id)) };
  const found = await listEvents({ privateProperty: `whatcanKey=${d.key}` });
  if (!found.ok) {
    await noteError(d, found.reason);
    out.push({ ...base, action: "error", detail: `lookup: ${found.reason}` });
    return;
  }
  const [first, ...extra] = found.data;
  for (const e of extra) await deleteEvent(e.id);
  if (first) {
    const p = await patchEvent(first.id, d.body);
    if (!p.ok) {
      await noteError(d, p.reason);
      out.push({ ...base, action: "error", eventId: first.id, detail: p.reason });
      return;
    }
    await saveRow(d, first.id);
    out.push({ ...base, action: "adopt", eventId: first.id, detail: extra.length ? `removed ${extra.length} duplicate(s)` : undefined });
    return;
  }
  const c = await createEvent(d.body);
  if (!c.ok) {
    await noteError(d, c.reason);
    out.push({ ...base, action: "error", detail: c.reason });
    return;
  }
  await saveRow(d, c.data.id);
  out.push({ ...base, action: "create", eventId: c.data.id });
}

let running = false;

export async function syncInspectionCalendar(o: { apply: boolean; reason?: string }): Promise<{ configured: boolean; missing: string[]; actions: CalendarAction[] }> {
  const cfg = calendarConfig();
  if (o.apply && !cfg.configured) return { configured: false, missing: cfg.missing, actions: [] };
  if (o.apply && running) return { configured: true, missing: [], actions: [{ action: "skipped", key: "*", detail: "a pass is already running" }] };
  if (o.apply) running = true;
  try {
    const { desired, stored, now } = await buildPlan();
    const actions: CalendarAction[] = [];
    const storedByKey = new Map(stored.map((r) => [r.sync_key, r]));

    for (const d of desired.values()) {
      const row = storedByKey.get(d.key);
      const base = { key: d.key, summary: d.body.summary, start: startOf(d.body), location: d.body.location, leads: d.leads.map((l) => String(l.id)) };
      const live = row && row.event_id && (row.status === "synced" || row.status === "retired");
      if (live && row!.payload_hash === d.hash) {
        actions.push({ ...base, action: "unchanged", eventId: row!.event_id });
        if (o.apply && row!.status !== "synced") await markRow(d.key, "synced", null);
        continue;
      }
      if (!o.apply) {
        actions.push({ ...base, action: live ? "patch" : "create", eventId: row?.event_id ?? null });
        continue;
      }
      if (live) {
        const p = await patchEvent(row!.event_id!, d.body);
        if (p.ok) {
          await saveRow(d, row!.event_id!);
          actions.push({ ...base, action: "patch", eventId: row!.event_id });
          continue;
        }
        if (p.status !== 404 && p.status !== 410) {
          await noteError(d, p.reason);
          actions.push({ ...base, action: "error", eventId: row!.event_id, detail: p.reason });
          continue;
        }
        // Removed in the calendar by hand: the visit still stands, so it is written again.
      }
      await ensureEvent(d, actions);
    }

    for (const row of stored) {
      if (desired.has(row.sync_key) || row.status === "deleted" || row.status === "retired" || !row.event_id) continue;
      const visitAt = asDate(row.visit_at);
      const aged = !!visitAt && visitAt.getTime() < now.getTime() - RECENT_MS;
      const base = { key: row.sync_key, start: visitAt?.toISOString(), leads: (row.lead_ids ?? "").split(",").filter(Boolean), eventId: row.event_id };
      if (aged) {
        actions.push({ ...base, action: "retire", detail: "visit more than a day past — event kept as history" });
        if (o.apply) await markRow(row.sync_key, "retired", null);
        continue;
      }
      actions.push({ ...base, action: "delete", detail: "card left Inspection sceduled (back, lost, parked) or its slot is gone" });
      if (!o.apply) continue;
      const r = await deleteEvent(row.event_id);
      await markRow(row.sync_key, r.ok ? "deleted" : row.status, r.ok ? null : r.reason);
      if (!r.ok) actions[actions.length - 1] = { ...actions[actions.length - 1]!, action: "error", detail: r.reason };
    }

    const changed = actions.filter((a) => a.action !== "unchanged");
    if (o.apply && changed.length) {
      for (const a of changed) logger.info({ key: a.key, eventId: a.eventId, leads: a.leads, start: a.start, reason: o.reason }, `inspection calendar: ${a.action} ${a.summary ?? ""} ${a.detail ?? ""}`.trim());
    }
    return { configured: cfg.configured, missing: cfg.missing, actions };
  } finally {
    if (o.apply) running = false;
  }
}

let queued: ReturnType<typeof setTimeout> | null = null;

/** After a slot is recorded: one pass a few seconds later (several slots in one audit coalesce). Never throws. */
export function queueInspectionCalendarSync(reason: string): void {
  if (!calendarConfig().configured) return;
  if (queued) return;
  queued = setTimeout(() => {
    queued = null;
    void syncInspectionCalendar({ apply: true, reason }).catch((err) => logger.warn({ err, reason }, "inspection calendar: queued pass failed"));
  }, 8000);
}

let warnedAt = 0;
export function startInspectionCalendarSync(): void {
  const tick = () => {
    const cfg = calendarConfig();
    if (!cfg.configured) {
      if (Date.now() - warnedAt > 6 * HOUR) {
        warnedAt = Date.now();
        logger.warn({ missing: cfg.missing }, "inspection calendar: Google Calendar not configured — pass skipped");
      }
      return;
    }
    void syncInspectionCalendar({ apply: true, reason: "schedule" }).catch((err) => logger.warn({ err }, "inspection calendar: pass failed"));
  };
  ensureTable().catch((err) => logger.error({ err }, "inspection calendar: table not created"));
  setTimeout(tick, 90_000);
  setInterval(tick, PASS_EVERY_MS);
}

/** What the calendar holds from this sync (read back from the API). */
export async function inspectionEventsFromCalendar(days = 60): Promise<{ ok: boolean; reason?: string; events: Array<{ id: string; summary: string; start: string; location?: string; key?: string }> }> {
  const r = await listEvents({ privateProperty: `whatcanSource=${SOURCE_TAG}`, timeMin: new Date(Date.now() - 2 * DAY), timeMax: new Date(Date.now() + days * DAY) });
  if (!r.ok) return { ok: false, reason: r.reason, events: [] };
  return {
    ok: true,
    events: r.data.map((e: CalendarEvent) => ({
      id: e.id,
      summary: e.summary,
      start: e.start?.dateTime ?? `${e.start?.date} (all day)`,
      location: e.location,
      key: e.extendedProperties?.private?.["whatcanKey"],
    })),
  };
}

/** One clearly marked TEST event: create → read back → delete → read again. */
export async function calendarSelfTest(): Promise<Record<string, unknown>> {
  const cfg = calendarConfig();
  if (!cfg.configured) return { ok: false, reason: `not configured: ${cfg.missing.join(", ")} missing` };
  const at = new Date(Date.now() + 2 * DAY);
  const b = baliIso(at);
  const start = `${b.date}T06:00:00+08:00`;
  const end = `${b.date}T06:15:00+08:00`;
  const created = await createEvent({
    summary: "[TEST] whatcan calendar check — safe to delete",
    description: "Created and deleted automatically by whatcan to verify the Google Calendar connection.",
    start: { dateTime: start, timeZone: "Asia/Makassar" },
    end: { dateTime: end, timeZone: "Asia/Makassar" },
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { whatcanSource: "selftest", whatcanKey: `selftest:${Date.now()}` } },
  });
  if (!created.ok) return { ok: false, step: "create", reason: created.reason };
  const read = await getEvent(created.data.id);
  const del = await deleteEvent(created.data.id);
  const after = await getEvent(created.data.id);
  return {
    ok: read.ok && del.ok && (!after.ok ? true : after.data.status === "cancelled"),
    created: { id: created.data.id, summary: created.data.summary, start: created.data.start },
    readBack: read.ok ? { summary: read.data.summary, start: read.data.start, status: read.data.status } : { error: read.reason },
    deleted: del.ok ? true : del.reason,
    afterDelete: after.ok ? { status: after.data.status } : { status: after.status, reason: after.reason },
  };
}
