/**
 * Every agreed villa inspection is a note in the shared "Brokers" Google Calendar (owner, 14.09.2026:
 * "вилла такая-то, время такое-то, инспекция. Юди может открывать календарь и сразу смотреть, какие у
 * него сегодня встречи"). Written through the Make.com webhook in google-calendar.ts.
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
 *   check, availability received, won) → the event exists and matches (create / update);
 * - card went back (QUALIFIED, TAKEN TO WORK, Initial Contact), lost / parked, left the funnel, or its
 *   slot disappeared → the event is deleted;
 * - visit more than a day past → the row is retired; the event stays as history.
 *
 * Idempotency lives in `inspection_calendar_events` (the webhook cannot list or search events): one row
 * per key with the event id, the body's hash and a status. The row is marked `creating` BEFORE the create
 * call; a create whose outcome is unknown (timeout, lost reply) becomes `uncertain` and is NOT created
 * again automatically — a person checks the calendar and re-runs with ?retry=1. A failed amoCRM or site
 * read aborts the pass: nothing is deleted on a bad read.
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
  isMissingEventError,
  updateEvent,
  type CalendarEventBody,
} from "./google-calendar";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const PASS_EVERY_MS = 5 * 60_000;
const RECENT_MS = DAY;
const DURATION_MS = HOUR;
const SITE = "https://unicorn-properties.com";
const AMO = "https://unicornproperty.amocrm.ru/leads/detail";

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
  action: "create" | "update" | "unchanged" | "delete" | "retire" | "uncertain" | "error" | "skipped";
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
    .then(() => db.execute(sql`ALTER TABLE inspection_calendar_events ADD COLUMN IF NOT EXISTS summary TEXT`))
    .then(() => db.execute(sql`ALTER TABLE inspection_calendar_events ADD COLUMN IF NOT EXISTS start_at TEXT`))
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

/** "[LISTED R-YUD-097] Villa Ma'Wa - Berawa Semat - 2BR - 44M mo" → "Villa Ma'Wa"; "Сделка #123" → null. */
export function villaNameFromCard(name: string | null | undefined): string | null {
  let s = String(name ?? "").replace(/^\s*(\[[^\]]*\]\s*)+/, "").trim();
  s = s.split(/\s+[-–—|]\s+/)[0]!.trim();
  if (!s || /^(сделка|deal|lead)\s*#?\s*\d+$/i.test(s) || /^#?\d+$/.test(s)) return null;
  return s.slice(0, 80);
}

const CODE_RX = /(?<![A-Za-z0-9-])(R-[A-Za-z]+-\d+)(?![0-9])/g;

/** The fields of one planned event, for readers other than the calendar (GET /api/public/inspections/upcoming). No phones. */
export type InspectionInfo = {
  key: string;
  villa: string;
  code: string | null;
  listingTitle: string | null;
  listingUrl: string | null;
  area: string | null;
  ownerName: string | null;
  visitAt: string;
  visitAtBali: string;
  timeKnown: boolean;
  agreedAt: string | null;
  quote: string | null;
  mapUrl: string | null;
  address: string | null;
  cards: string[];
};

type Desired = { key: string; slot: SlotRow; leads: AmoLead[]; body: CalendarEventBody; hash: string; visitAt: Date; info: InspectionInfo };

async function buildPlan(): Promise<{ desired: Map<string, Desired>; stored: StoredRow[]; now: Date }> {
  await ensureTable();
  const now = new Date();
  // A slot replaced by a new agreed time is 'rescheduled' (listing-progress.ts); only the current one counts.
  const slotsRes = await db.execute(sql`SELECT DISTINCT ON (lead_id) id, lead_id, visit_at, time_known, agreed_at, quote, created_at
                                        FROM listing_inspection_slots WHERE status = 'scheduled'
                                        ORDER BY lead_id, created_at DESC, visit_at DESC`);
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
    lines.push("", `Written by whatcan from the card's thread (ref ${key}); edits here are overwritten when the visit changes.`);

    const body: CalendarEventBody = {
      summary: `Inspection — ${villa}${code ? ` (${code})` : ""}${timed ? "" : " — time not fixed"}`,
      location: mapUrl || address || (prop?.area ?? "").trim(),
      description: lines.join("\n"),
      start: baliIso(visitAt),
      end: baliIso(new Date(visitAt.getTime() + DURATION_MS)),
    };
    const hash = crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex");
    const info: InspectionInfo = {
      key,
      villa,
      code,
      listingTitle: prop?.title ?? null,
      listingUrl: code ? `${SITE}/property/${code}` : null,
      area: (prop?.area ?? "").trim() || null,
      ownerName: (priv?.owner_name ?? "").trim() || null,
      visitAt: visitAt.toISOString(),
      visitAtBali: `${baliHuman(visitAt)}${timed ? "" : " (time not fixed)"}`,
      timeKnown: timed,
      agreedAt: agreedAt ? agreedAt.toISOString() : null,
      quote: (slot.quote ?? "").trim() || null,
      mapUrl: mapUrl || null,
      address: address || null,
      cards: cards.map((c) => `${AMO}/${c.id}`),
    };
    desired.set(key, { key, slot, leads: cards, body, hash, visitAt, info });
  }
  return { desired, stored, now };
}

/**
 * Every agreed villa visit still ahead (or started under three hours ago) within `days`, soonest
 * first — from the same plan the calendar pass writes, so the list and the calendar agree. Read-only.
 */
export async function upcomingInspectionEvents(days = 14): Promise<InspectionInfo[]> {
  const { desired, now } = await buildPlan();
  return [...desired.values()]
    .filter((d) => d.visitAt.getTime() >= now.getTime() - 3 * HOUR && d.visitAt.getTime() <= now.getTime() + days * DAY)
    .sort((a, b) => a.visitAt.getTime() - b.visitAt.getTime())
    .map((d) => d.info);
}

async function writeRow(d: Desired, status: string, eventId: string | null, error: string | null): Promise<void> {
  await db.execute(sql`INSERT INTO inspection_calendar_events (sync_key, slot_id, lead_ids, visit_at, event_id, calendar_id, payload_hash, status, last_error, summary, start_at, updated_at)
    VALUES (${d.key}, ${d.slot.id}, ${d.leads.map((l) => l.id).join(",")}, ${d.visitAt.toISOString()}, ${eventId}, ${calendarConfig().calendarId},
            ${eventId ? d.hash : null}, ${status}, ${error ? error.slice(0, 500) : null}, ${d.body.summary}, ${d.body.start}, now())
    ON CONFLICT (sync_key) DO UPDATE SET slot_id = EXCLUDED.slot_id, lead_ids = EXCLUDED.lead_ids, visit_at = EXCLUDED.visit_at,
      event_id = COALESCE(EXCLUDED.event_id, inspection_calendar_events.event_id), calendar_id = EXCLUDED.calendar_id,
      payload_hash = COALESCE(EXCLUDED.payload_hash, inspection_calendar_events.payload_hash), status = EXCLUDED.status,
      last_error = EXCLUDED.last_error, summary = EXCLUDED.summary, start_at = EXCLUDED.start_at, updated_at = now()`);
}
async function markRow(key: string, status: string, error: string | null, clearEvent = false): Promise<void> {
  await db
    .execute(sql`UPDATE inspection_calendar_events SET status = ${status}, last_error = ${error},
                 event_id = CASE WHEN ${clearEvent ? "1" : "0"} = '1' THEN NULL ELSE event_id END, updated_at = now() WHERE sync_key = ${key}`)
    .catch(() => undefined);
}

/** Row first, then the call: a crash or a lost reply leaves `creating` / `uncertain`, never a silent second create. */
async function create(d: Desired, base: CalendarAction, out: CalendarAction[]): Promise<void> {
  await writeRow(d, "creating", null, null);
  const c = await createEvent(d.body);
  if (c.ok) {
    await writeRow(d, "synced", c.data.id, null);
    out.push({ ...base, action: "create", eventId: c.data.id });
  } else if (c.transport) {
    await writeRow(d, "uncertain", null, c.reason);
    logger.warn({ key: d.key, reason: c.reason }, "inspection calendar: create outcome unknown — not retried automatically, check the calendar");
    out.push({ ...base, action: "uncertain", detail: `${c.reason} — check the calendar, then ?apply=1&retry=1` });
  } else {
    await writeRow(d, "error", null, c.reason);
    out.push({ ...base, action: "error", detail: c.reason });
  }
}

let running = false;

export async function syncInspectionCalendar(o: { apply: boolean; reason?: string; retryUncertain?: boolean }): Promise<{ configured: boolean; missing: string[]; actions: CalendarAction[] }> {
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
      const base: CalendarAction = { action: "skipped", key: d.key, summary: d.body.summary, start: d.body.start, location: d.body.location || undefined, leads: d.leads.map((l) => String(l.id)) };
      const live = !!row?.event_id && ["synced", "retired", "error"].includes(row.status);
      // `creating` left by a crash is as unknown as a lost reply.
      const unknown = !row?.event_id && (row?.status === "uncertain" || row?.status === "creating");
      if (unknown && !o.retryUncertain) {
        actions.push({ ...base, action: "uncertain", detail: "an earlier create may have written this event — check the calendar, then ?apply=1&retry=1" });
        continue;
      }
      if (live && row!.payload_hash === d.hash) {
        actions.push({ ...base, action: "unchanged", eventId: row!.event_id });
        if (o.apply && row!.status !== "synced") await markRow(d.key, "synced", null);
        continue;
      }
      if (!o.apply) {
        actions.push({ ...base, action: live ? "update" : "create", eventId: row?.event_id ?? null });
        continue;
      }
      if (live) {
        const u = await updateEvent(row!.event_id!, d.body);
        if (u.ok) {
          await writeRow(d, "synced", u.data.id, null);
          actions.push({ ...base, action: "update", eventId: u.data.id });
          continue;
        }
        if (u.transport || !isMissingEventError(u.reason)) {
          await markRow(d.key, "error", u.reason);
          actions.push({ ...base, action: "error", eventId: row!.event_id, detail: u.reason });
          continue;
        }
        // Removed in the calendar by hand, and the visit changed since: written again.
        await markRow(d.key, "error", u.reason, true);
      }
      await create(d, base, actions);
    }

    for (const row of stored) {
      if (desired.has(row.sync_key) || row.status === "deleted" || row.status === "retired") continue;
      const visitAt = asDate(row.visit_at);
      const aged = !!visitAt && visitAt.getTime() < now.getTime() - RECENT_MS;
      const base: CalendarAction = { action: "skipped", key: row.sync_key, start: visitAt ? baliIso(visitAt) : undefined, leads: (row.lead_ids ?? "").split(",").filter(Boolean), eventId: row.event_id };
      if (!row.event_id) {
        actions.push({ ...base, action: row.status === "uncertain" || row.status === "creating" ? "uncertain" : "skipped", detail: "no longer wanted; no event id on record" });
        if (o.apply) await markRow(row.sync_key, row.status === "uncertain" || row.status === "creating" ? "uncertain" : "deleted", null);
        continue;
      }
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

    if (o.apply) {
      for (const a of actions.filter((x) => x.action !== "unchanged")) {
        logger.info({ key: a.key, eventId: a.eventId, leads: a.leads, start: a.start, reason: o.reason }, `inspection calendar: ${a.action} ${a.summary ?? ""} ${a.detail ?? ""}`.trim());
      }
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
        logger.warn({ missing: cfg.missing }, "inspection calendar: Google Calendar webhook not configured — pass skipped");
      }
      return;
    }
    void syncInspectionCalendar({ apply: true, reason: "schedule" }).catch((err) => logger.warn({ err }, "inspection calendar: pass failed"));
  };
  ensureTable().catch((err) => logger.error({ err }, "inspection calendar: table not created"));
  setTimeout(tick, 90_000);
  setInterval(tick, PASS_EVERY_MS);
}

/** The webhook cannot list events: what this sync wrote, from our table. */
export async function inspectionEventsFromCalendar(): Promise<Record<string, unknown>> {
  await ensureTable();
  const rows = await db.execute(sql`SELECT sync_key, event_id, summary, start_at, status, lead_ids, last_error, updated_at
                                    FROM inspection_calendar_events ORDER BY start_at DESC NULLS LAST`);
  return { configured: calendarConfig().configured, events: rows.rows ?? [] };
}

/** One clearly marked TEST event through the webhook: create → update (the id resolves) → delete. */
export async function calendarSelfTest(): Promise<Record<string, unknown>> {
  const cfg = calendarConfig();
  if (!cfg.configured) return { ok: false, reason: `not configured: ${cfg.missing.join(", ")} missing` };
  const day = new Date(Date.now() + 2 * DAY);
  const date = baliIso(day).slice(0, 10);
  const body: CalendarEventBody = {
    summary: "[TEST] whatcan calendar check — safe to delete",
    description: "Created and deleted automatically by whatcan to verify the calendar connection.",
    location: "",
    start: `${date}T06:00:00+08:00`,
    end: `${date}T06:15:00+08:00`,
  };
  const created = await createEvent(body);
  if (!created.ok) return { ok: false, step: "create", reason: created.reason };
  const updated = await updateEvent(created.data.id, { ...body, summary: `${body.summary} (updated)` });
  const deleted = await deleteEvent(created.data.id);
  return {
    ok: updated.ok && deleted.ok,
    created: { id: created.data.id, start: body.start },
    updated: updated.ok ? { id: updated.data.id } : updated.reason,
    deleted: deleted.ok ? true : deleted.reason,
  };
}
