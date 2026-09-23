/**
 * The inspection report: Yudi closes a villa inspection from Copilot alone (owner, 19.09.2026).
 *
 * "Наш человек, листинг-менеджер, работает только с копайлотом … все изменения на Google диске, на
 * сайте и репорт в чат идут автоматически … меньше зависимость от человека, больше контроля со
 * стороны системы."
 *
 * Half an hour after an agreed inspection (`listing_inspection_slots`, the same rows the calendar reads)
 * the villa's card in Rental Listings gets a due report: an amoCRM task, a push to Yudi, and — so the
 * card is in his inbox at all — a placeholder draft to the owner ("thanks for having us") that only a
 * person sends. The form is the site's Internal data (the same `property_private` row, no copy of it):
 * Listed, red flags, green flags and Yudi's notes are required; photos and a video are optional.
 *
 * "Report done" applies everything and then READS EVERY CHANGE BACK from the system it went to — site
 * row, photos, video, publish blockers, the card's stage in amoCRM, the message in Unicorn Rental. A
 * write that answered "ok" is not a check. Any red line keeps the report open (status `failed`), tells
 * Yudi what did not go through and pushes the owner; a second press re-runs only what is not green.
 *
 * The card's move to live is NOT done here: the site switch Pre-listed → Listed is the one way into
 * live (listing-status-pass.ts, owner 14.09). This module flips the switch, links the card to the
 * listing so the pass cannot miss it, runs the pass and reads the stage back.
 *
 * "Not listing" (the villa does not fit at all): reason + notes → the card closes as lost, the listing
 * is hidden (draft), one line goes to the group.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { amoFetch, amoPatch, amoPost, closeLeadAsLost, createAmoTask, getAmoLead, getOpenAmoTasks, INSPECTION_REPORT_TASK_PREFIX } from "./amo-client";
import { notifyBroker } from "./push-notifications";
import { chatCompletion, HELPER_MODEL } from "./ai-client";
import { LISTING_AGENT_BROKER, LISTINGS_PIPELINE_ID, LISTING_STAGE, siteGet, siteInsert } from "./listing-status-week";
import { runListingStatusPass } from "./listing-status-pass";
import { gateway, OWNER_SESSION } from "./wa-bridge";
import { signedStorageUpload } from "./site-storage";

export const INSPECTION_REPORT_VERDICT = "inspection report due";
export { INSPECTION_REPORT_TASK_PREFIX };

const SITE = "https://unicorn-properties.com";
const AMO = "https://unicornproperty.amocrm.ru/leads/detail";
/** Unicorn Rental — the team group the owner pointed at (screenshot, 19.09.2026). */
const GROUP_JID = process.env["INSPECTION_REPORT_GROUP"] ?? "120363411017702009@g.us";
/** Yudi's own WhatsApp, linked to wa-gateway as an extra device (shadow: nothing reaches amoCRM). */
const YUDI_SESSION = process.env["WA_YUDI_SESSION"] ?? "yudi";
const OWNER_BROKER = "hos";
const HOUR = 3600_000;
const DUE_AFTER_MS = 30 * 60_000;
/** A visit older than this is not turned into a report. */
const LOOKBACK_MS = 7 * 24 * HOUR;
const PASS_EVERY_MS = 5 * 60_000;
/** With fewer own photos than this, the photos found online stay after Yudi's instead of being hidden. */
const REPLACE_AT = 6;
const LIVE_STAGES = new Set<number>([LISTING_STAGE.LIVE, LISTING_STAGE.WEEKLY_CHECK_SENT, LISTING_STAGE.AVAILABILITY_RECEIVED]);
const CLOSED = new Set<number>([142, 143]);
const CODE_RX = /(?<![A-Za-z0-9-])(R-[A-Za-z]+-\d+)(?![0-9])/g;

export type CheckState = "ok" | "bad" | "warn" | "run" | "todo";
export type Check = { key: string; label: string; state: CheckState; detail: string };
export type ReportRow = {
  id: string;
  lead_id: string;
  slot_id: string | null;
  property_code: string | null;
  visit_at: Date;
  status: "due" | "checking" | "done" | "failed" | "not_listing" | "cancelled";
  red_flags: string | null;
  green_flags: string | null;
  construction_nearby: boolean | null;
  notes: string | null;
  notes_raw: string | null;
  photos: string[];
  cover: string | null;
  video_url: string | null;
  private_edits: Record<string, string> | null;
  previous_images: string[] | null;
  checks: Check[] | null;
  not_listing_reason: string | null;
  wa_message_id: string | null;
  filed_by: string | null;
  filed_at: Date | null;
  done_at: Date | null;
  created_at: Date;
};

// ── Storage ───────────────────────────────────────────────────────────────────

let ensured: Promise<void> | null = null;
export function ensureTable(): Promise<void> {
  ensured ??= pool
    .query(`CREATE TABLE IF NOT EXISTS inspection_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id TEXT NOT NULL,
      slot_id UUID UNIQUE,
      property_code TEXT,
      visit_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'due',
      red_flags TEXT,
      green_flags TEXT,
      construction_nearby BOOLEAN,
      notes TEXT,
      notes_raw TEXT,
      photos JSONB NOT NULL DEFAULT '[]',
      cover TEXT,
      video_url TEXT,
      private_edits JSONB,
      previous_images JSONB,
      checks JSONB,
      not_listing_reason TEXT,
      wa_message_id TEXT,
      filed_by TEXT,
      filed_at TIMESTAMPTZ,
      done_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS inspection_reports_lead ON inspection_reports (lead_id, status)`))
    .then(() => undefined)
    .catch((err) => {
      ensured = null;
      throw err;
    });
  return ensured;
}

export async function getReport(id: string): Promise<ReportRow | null> {
  await ensureTable();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await pool.query(`SELECT * FROM inspection_reports WHERE id = $1`, [id]);
  return (r.rows[0] as ReportRow) ?? null;
}

/** Open (due or failed) reports per card, newest visit first — for the inbox payload. */
export async function openReportsForLeads(leadIds: string[]): Promise<Map<string, { id: string; property_code: string | null; visit_at: string; status: string }>> {
  const out = new Map<string, { id: string; property_code: string | null; visit_at: string; status: string }>();
  if (!leadIds.length) return out;
  await ensureTable();
  const r = await pool.query(
    `SELECT id, lead_id, property_code, visit_at, status FROM inspection_reports
      WHERE lead_id = ANY($1) AND status IN ('due', 'checking', 'failed') ORDER BY visit_at DESC`,
    [leadIds],
  );
  for (const row of r.rows) {
    if (!out.has(row.lead_id)) out.set(row.lead_id, { id: row.id, property_code: row.property_code, visit_at: new Date(row.visit_at).toISOString(), status: row.status });
  }
  return out;
}

// ── Site database (service key) ───────────────────────────────────────────────

function siteDb(): { url: string; key: string } {
  const url = process.env["SUPABASE_URL"] ?? "";
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  return { url, key };
}
const enc = encodeURIComponent;

async function siteWrite(method: "PATCH" | "POST", path: string, body: unknown, prefer = "return=representation"): Promise<unknown> {
  const { url, key } = siteDb();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: prefer },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`site ${method} ${path.split("?")[0]} → ${res.status} ${text.slice(0, 300)}`);
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function publishBlockers(code: string): Promise<string[]> {
  const { url, key } = siteDb();
  const res = await fetch(`${url}/rest/v1/rpc/listing_publish_blockers`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ _property_id: code }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`listing_publish_blockers → ${res.status} ${text.slice(0, 200)}`);
  const v = JSON.parse(text || "[]");
  return Array.isArray(v) ? v.map(String).filter(Boolean) : v ? [String(v)] : [];
}

/** Uploads go straight from the phone into the site's storage (lib/site-storage.ts). */
export function signedUpload(code: string, kind: "photo" | "video", fileName: string): Promise<{ uploadUrl: string; publicUrl: string }> {
  return signedStorageUpload(code, kind, fileName, "insp");
}

type Property = { id: string; title: string | null; area: string | null; bedrooms: number | null; images: string[] | null; video_url: string | null; pre_listed: boolean | null; is_draft: boolean | null };
type Private = {
  property_id: string;
  owner_name: string | null;
  owner_phone: string | null;
  google_maps_url: string | null;
  exact_address: string | null;
  drive_folder_url: string | null;
  notes: string | null;
  red_flags: string | null;
  green_flags: string | null;
  construction_nearby: boolean | null;
};

export async function siteListing(code: string): Promise<{ property: Property | null; priv: Private | null }> {
  const [property] = await siteGet<Property[]>(`properties?select=id,title,area,bedrooms,images,video_url,pre_listed,is_draft&id=eq.${enc(code)}`);
  const [priv] = await siteGet<Private[]>(
    `property_private?select=property_id,owner_name,owner_phone,google_maps_url,exact_address,drive_folder_url,notes,red_flags,green_flags,construction_nearby&property_id=eq.${enc(code)}`,
  );
  return { property: property ?? null, priv: priv ?? null };
}

// ── Which listing a card is ───────────────────────────────────────────────────

async function codeForLead(leadId: string, cardName: string | null): Promise<string | null> {
  const links = await siteGet<{ property_id: string }[]>(`listing_crm_link?select=property_id&amo_lead_id=eq.${enc(leadId)}`).catch(() => []);
  const linked = [...new Set(links.map((l) => l.property_id.toUpperCase()))];
  if (linked.length === 1) return linked[0]!;
  if (linked.length > 1) return null; // two listings on one card: the form asks
  const cal = await pool
    .query(`SELECT sync_key FROM inspection_calendar_events WHERE sync_key LIKE 'prop:%' AND (',' || lead_ids || ',') LIKE $1`, [`%,${leadId},%`])
    .catch(() => ({ rows: [] as { sync_key: string }[] }));
  const fromCal = [...new Set(cal.rows.map((r) => String(r.sync_key).slice(5).toUpperCase()))];
  if (fromCal.length === 1) return fromCal[0]!;
  const inName = [...new Set([...(cardName ?? "").matchAll(CODE_RX)].map((m) => m[1]!.toUpperCase()))];
  return inName.length === 1 ? inName[0]! : null;
}

// ── Due pass ──────────────────────────────────────────────────────────────────

function dueAt(visitAt: Date, timeKnown: boolean): Date {
  if (timeKnown) return new Date(visitAt.getTime() + DUE_AFTER_MS);
  // A day without a time: ask at 18:00 Bali that day.
  const baliDay = new Date(visitAt.getTime() + 8 * HOUR).toISOString().slice(0, 10);
  return new Date(`${baliDay}T18:00:00+08:00`);
}

const fmt = (d: Date) =>
  d.toLocaleString("en-GB", { timeZone: "Asia/Makassar", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export async function runDuePass(opts: { dry?: boolean } = {}): Promise<Array<{ leadId: string; code: string | null; visitAt: string; action: string }>> {
  await ensureTable();
  const now = Date.now();
  const slots = await pool.query(
    `SELECT DISTINCT ON (lead_id) id, lead_id, visit_at, time_known FROM listing_inspection_slots
      WHERE status = 'scheduled' ORDER BY lead_id, created_at DESC, visit_at DESC`,
  );
  const out: Array<{ leadId: string; code: string | null; visitAt: string; action: string }> = [];
  for (const s of slots.rows as Array<{ id: string; lead_id: string; visit_at: Date; time_known: boolean }>) {
    const visitAt = new Date(s.visit_at);
    if (dueAt(visitAt, s.time_known).getTime() > now || visitAt.getTime() < now - LOOKBACK_MS) continue;
    const exists = await pool.query(
      `SELECT 1 FROM inspection_reports WHERE slot_id = $1 OR (lead_id = $2 AND visit_at > $3::timestamptz - interval '12 hours')`,
      [s.id, s.lead_id, visitAt],
    );
    if (exists.rows.length) continue;
    const lead = await amoFetch<{ id: number; name: string | null; status_id: number; pipeline_id: number; responsible_user_id?: number }>(`/api/v4/leads/${s.lead_id}`);
    if (!lead) { out.push({ leadId: s.lead_id, code: null, visitAt: visitAt.toISOString(), action: "skipped: amoCRM did not return the card" }); continue; }
    if (lead.pipeline_id !== LISTINGS_PIPELINE_ID) { out.push({ leadId: s.lead_id, code: null, visitAt: visitAt.toISOString(), action: "skipped: card left Rental Listings" }); continue; }
    if (CLOSED.has(lead.status_id) || LIVE_STAGES.has(lead.status_id) || lead.status_id === LISTING_STAGE.LONG_TERM || lead.status_id === LISTING_STAGE.CO_BROKE) {
      out.push({ leadId: s.lead_id, code: null, visitAt: visitAt.toISOString(), action: `skipped: card is already past inspection (status ${lead.status_id})` });
      continue;
    }
    const code = await codeForLead(s.lead_id, lead.name);
    if (opts.dry) { out.push({ leadId: s.lead_id, code, visitAt: visitAt.toISOString(), action: "would create" }); continue; }
    const ins = await pool.query(
      `INSERT INTO inspection_reports (lead_id, slot_id, property_code, visit_at) VALUES ($1, $2, $3, $4) ON CONFLICT (slot_id) DO NOTHING RETURNING id`,
      [s.lead_id, s.id, code, visitAt],
    );
    if (!ins.rows.length) continue;
    await announceDue(s.lead_id, code, visitAt, lead.name, lead.responsible_user_id).catch((err) => logger.warn({ err, leadId: s.lead_id }, "inspection report: announce failed (non-fatal)"));
    out.push({ leadId: s.lead_id, code, visitAt: visitAt.toISOString(), action: "created" });
    logger.info({ leadId: s.lead_id, code, visitAt, reportId: ins.rows[0].id }, "inspection report: due");
  }
  // Second source: the STAGE. A visit agreed by phone, in person or in a thread the reader could not
  // parse leaves no slot, so the card reached "Inspection sceduled" with nothing owing a report — the
  // hole Yudi hit on 23.09 ("listings with no inspection report button"). The stage is the broker's own
  // act, so it is evidence enough; the form asks for the rest.
  for (const lead of await cardsOnInspectionStage()) {
    const has = await pool.query(
      `SELECT 1 FROM inspection_reports WHERE lead_id = $1 AND (status IN ('due', 'checking', 'failed') OR COALESCE(done_at, filed_at) > now() - interval '7 days')`,
      [String(lead.id)],
    );
    if (has.rows.length) continue;
    const future = await pool.query(
      `SELECT 1 FROM listing_inspection_slots WHERE lead_id = $1 AND status = 'scheduled' AND visit_at > now() - interval '30 minutes'`,
      [String(lead.id)],
    );
    if (future.rows.length) continue; // the visit is still ahead — the slot pass will ask afterwards
    const enteredAt = await stageEnteredAt(String(lead.id));
    if (Date.now() - enteredAt.getTime() < DUE_AFTER_MS) continue;
    const code = await codeForLead(String(lead.id), lead.name).catch(() => null);
    if (opts.dry) { out.push({ leadId: String(lead.id), code, visitAt: enteredAt.toISOString(), action: "would create (from the stage, no slot)" }); continue; }
    const ins = await pool.query(`INSERT INTO inspection_reports (lead_id, property_code, visit_at) VALUES ($1, $2, $3) RETURNING id`, [String(lead.id), code, enteredAt]);
    await announceDue(String(lead.id), code, enteredAt, lead.name, lead.responsible_user_id).catch(() => undefined);
    out.push({ leadId: String(lead.id), code, visitAt: enteredAt.toISOString(), action: "created (from the stage, no slot)" });
    logger.info({ leadId: lead.id, code, reportId: ins.rows[0].id }, "inspection report: due from the stage (no slot recorded)");
  }

  if (!opts.dry) {
    const open = await pool.query(`SELECT DISTINCT lead_id FROM inspection_reports WHERE status IN ('due', 'failed')`);
    for (const r of open.rows) {
      const leadId = String(r.lead_id);
      // A card a person closed after the visit owes no report (23590381, 21.09).
      const lead = await getAmoLead(leadId).catch(() => null);
      if (lead?.status_id && CLOSED.has(lead.status_id)) {
        await pool.query(`UPDATE inspection_reports SET status = 'cancelled', updated_at = now() WHERE lead_id = $1 AND status IN ('due', 'failed')`, [leadId]);
        await closeTaskAndPlaceholder(leadId, "Card closed — no inspection report needed").catch(() => undefined);
        logger.info({ leadId }, "inspection report: card closed, report cancelled");
        continue;
      }
      await ensurePlaceholder(leadId).catch(() => undefined);
    }
  }
  return out;
}

/** Cards sitting on "Inspection sceduled" right now. */
async function cardsOnInspectionStage(): Promise<Array<{ id: number; name: string | null; responsible_user_id?: number }>> {
  const q =
    `/api/v4/leads?filter[statuses][0][pipeline_id]=${LISTINGS_PIPELINE_ID}` +
    `&filter[statuses][0][status_id]=${LISTING_STAGE.INSPECTION_SCHEDULED}&limit=250`;
  const d = await amoFetch<{ _embedded?: { leads?: Array<{ id: number; name: string | null; responsible_user_id?: number }> } }>(q).catch(() => null);
  return d?._embedded?.leads ?? [];
}

/** When the card entered the inspection stage — our own journal, else now. */
async function stageEnteredAt(leadId: string): Promise<Date> {
  const r = await pool
    .query(
      `SELECT changed_at FROM stage_events WHERE lead_id = $1 AND to_stage ILIKE '%inspection%' ORDER BY changed_at DESC LIMIT 1`,
      [leadId],
    )
    .catch(() => ({ rows: [] as Array<{ changed_at: Date }> }));
  return r.rows[0]?.changed_at ? new Date(r.rows[0].changed_at) : new Date();
}

/** The task, the push, and the placeholder draft that puts the card in Yudi's inbox. */
export async function announceDue(leadId: string, code: string | null, visitAt: Date, cardName: string | null, responsible?: number): Promise<void> {
  const villa = code ?? (cardName ?? `card #${leadId}`).slice(0, 60);
  await createAmoTask(
    leadId,
    `${INSPECTION_REPORT_TASK_PREFIX}: ${villa} (inspection ${fmt(visitAt)}). Open the card in Copilot — Listed, red & green flags, your notes, photos/video.`,
    new Date(Date.now() + 3 * HOUR),
    responsible,
  ).catch(() => false);
  await notifyBroker(LISTING_AGENT_BROKER, `Inspection report · ${villa}`, `Inspection ${fmt(visitAt)}. Listed, flags, notes, photos — in Copilot, two minutes.`, "/m").catch(() => 0);
  await ensurePlaceholder(leadId);
}

/**
 * The inbox lists drafts, not cards: an open report needs a pending draft on its card to be seen. Other
 * passes retire drafts (a booking ask, an answered LIVE), so the due pass re-checks every open report.
 */
async function ensurePlaceholder(leadId: string): Promise<void> {
  // Our placeholder, or any pending PUSH, carries the report; a stale hidden LIVE draft does not
  // (Villa Markisa 23299143, 21.09: an old LIVE kept the card out of the inbox).
  const pending = await pool.query(
    `SELECT 1 FROM pending_suggestions WHERE lead_id = $1 AND status = 'pending' AND (kind = 'push' OR autopilot_skipped_reason = $2) LIMIT 1`,
    [leadId, INSPECTION_REPORT_VERDICT],
  );
  if (!pending.rows.length) {
    const sync = await pool.query(`SELECT responsible_user FROM leads_sync WHERE lead_id = $1`, [leadId]).catch(() => ({ rows: [] as any[] }));
    await pool.query(
      `INSERT INTO pending_suggestions (lead_id, responsible_user, kind, suggestion_text, status, autopilot_skipped_reason, autopilot_skipped_at)
       VALUES ($1, $2, 'push', $3, 'pending', $4, now())`,
      [
        leadId,
        sync.rows[0]?.responsible_user ?? "Yudi",
        "Thank you again for having us at the villa, it was great to see it in person. I'll let you know as soon as it's live on our website.",
        INSPECTION_REPORT_VERDICT,
      ],
    );
  }
}

/**
 * A report the broker starts himself: a villa he inspected whose visit was never agreed in the thread,
 * so no slot and no card in the inbox (Yudi, 23.09: "how can i edit the villa as inspected … with no
 * inspection report button?"). Same row, task, push and inbox card as the scheduled pass creates.
 */
export async function startReport(leadId: string, broker: string | null): Promise<{ ok: boolean; id?: string; error?: string }> {
  await ensureTable();
  if (!/^\d+$/.test(leadId)) return { ok: false, error: "bad card id" };
  const open = await pool.query(`SELECT id FROM inspection_reports WHERE lead_id = $1 AND status IN ('due', 'checking', 'failed')`, [leadId]);
  if (open.rows.length) return { ok: true, id: String(open.rows[0].id) };
  // A report filed days ago is this villa's report: the button must not open a second one (23.09).
  const recent = await pool.query(
    `SELECT done_at FROM inspection_reports WHERE lead_id = $1 AND status IN ('done', 'not_listing') AND COALESCE(done_at, filed_at) > now() - interval '7 days' ORDER BY COALESCE(done_at, filed_at) DESC LIMIT 1`,
    [leadId],
  );
  if (recent.rows.length) {
    const when = new Date(recent.rows[0].done_at ?? Date.now()).toLocaleDateString("en-GB", { timeZone: "Asia/Makassar", day: "2-digit", month: "short" });
    return { ok: false, error: `the report for this villa was already filed on ${when}` };
  }
  const lead = await amoFetch<{ id: number; name: string | null; status_id: number; pipeline_id: number; responsible_user_id?: number }>(`/api/v4/leads/${leadId}`);
  if (!lead) return { ok: false, error: "amoCRM did not return this card" };
  if (lead.pipeline_id !== LISTINGS_PIPELINE_ID) return { ok: false, error: "this card is not in Rental Listings" };
  if (CLOSED.has(lead.status_id)) return { ok: false, error: "this card is closed" };
  const code = await codeForLead(leadId, lead.name).catch(() => null);
  const visitAt = new Date();
  const ins = await pool.query(`INSERT INTO inspection_reports (lead_id, property_code, visit_at) VALUES ($1, $2, $3) RETURNING id`, [leadId, code, visitAt]);
  await announceDue(leadId, code, visitAt, lead.name, lead.responsible_user_id).catch(() => undefined);
  logger.info({ leadId, code, broker }, "inspection report: started by the broker");
  return { ok: true, id: String(ins.rows[0].id) };
}

export function startInspectionReportPass(): void {
  const tick = () => runDuePass().catch((err) => logger.warn({ err }, "inspection report: due pass failed"));
  setTimeout(tick, 45_000);
  setInterval(tick, PASS_EVERY_MS);
}

// ── Draft save and notes tidy-up ──────────────────────────────────────────────

export type DraftInput = {
  propertyCode?: string | null;
  red?: string[];
  green?: string[];
  construction?: boolean;
  notes?: string;
  notesRaw?: string;
  photos?: string[];
  cover?: string | null;
  video?: string | null;
  privateEdits?: Record<string, string>;
};

const lines = (a: string[] | undefined) => (a ?? []).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 12);
const storageUrl = (u: string) => {
  const base = process.env["SUPABASE_URL"] ?? "";
  return !!base && u.startsWith(`${base}/storage/v1/object/public/property-`);
};
const PRIVATE_KEYS = ["owner_name", "owner_phone", "google_maps_url", "drive_folder_url"] as const;

export async function saveDraft(id: string, input: DraftInput): Promise<ReportRow | null> {
  const rep = await getReport(id);
  if (!rep || rep.status === "done" || rep.status === "not_listing") return rep;
  const code = (input.propertyCode ?? "").trim().toUpperCase();
  const edits: Record<string, string> = {};
  for (const k of PRIVATE_KEYS) {
    const v = input.privateEdits?.[k];
    if (typeof v === "string") edits[k] = v.trim().slice(0, 500);
  }
  const photos = (input.photos ?? rep.photos ?? []).filter(storageUrl).slice(0, 40);
  const r = await pool.query(
    `UPDATE inspection_reports SET
        property_code = COALESCE($2, property_code),
        red_flags = $3, green_flags = $4, construction_nearby = $5, notes = $6, notes_raw = COALESCE($7, notes_raw),
        photos = $8::jsonb, cover = $9, video_url = $10, private_edits = $11::jsonb, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [
      id,
      !rep.property_code && /^R-[A-Z]+-\d+$/.test(code) ? code : null,
      input.red ? lines(input.red).join("\n") : rep.red_flags,
      input.green ? lines(input.green).join("\n") : rep.green_flags,
      input.construction ?? rep.construction_nearby,
      input.notes !== undefined ? input.notes.trim().slice(0, 3000) : rep.notes,
      input.notesRaw ? input.notesRaw.slice(0, 5000) : null,
      JSON.stringify(photos),
      input.cover !== undefined ? (input.cover && photos.includes(input.cover) ? input.cover : photos[0] ?? null) : rep.cover,
      input.video !== undefined ? (input.video && storageUrl(input.video) ? input.video : null) : rep.video_url,
      JSON.stringify(Object.keys(edits).length ? { ...(rep.private_edits ?? {}), ...edits } : rep.private_edits ?? {}),
    ],
  );
  return (r.rows[0] as ReportRow) ?? null;
}

/** Dictated notes → 2–4 short lines in English. The raw text is kept on the report. */
export async function tidyNotes(raw: string, code: string | null): Promise<string> {
  const text = raw.trim().slice(0, 4000);
  if (!text) return "";
  const out = await chatCompletion({
    model: HELPER_MODEL,
    label: "inspection-report:tidy-notes",
    max_tokens: 300,
    temperature: 0.2,
    system:
      "A listing manager dictated notes right after inspecting a rental villa in Bali (speech-to-text, may mix English and Indonesian, no punctuation). " +
      "Rewrite them for the team as 2–4 short plain lines in English, one fact per line: condition, owner's terms (price, minimum stay), issues, anything the team must know. " +
      "Keep every number, price and name exactly as said, written as digits (40M, 12 months); keep the owner's terms together as said (e.g. 12 months at 40M, minimum 6 months); add nothing that was not said; no bullets, no headings, no emoji. Output only the lines.",
    messages: [{ role: "user", content: `${code ? `Villa ${code}. ` : ""}Dictated notes:\n${text}` }],
  });
  return (out.content ?? "").trim().split("\n").map((l) => l.replace(/^[-•*\s]+/, "").trim()).filter(Boolean).slice(0, 5).join("\n");
}

// ── Report done: apply, then read everything back ─────────────────────────────

export function missingFields(rep: ReportRow, listed: boolean): string[] {
  const m: string[] = [];
  if (!rep.property_code) m.push("which villa (code)");
  if (!listed) m.push("switch to Listed");
  if (!(rep.red_flags ?? "").trim()) m.push("a red flag");
  if (!(rep.green_flags ?? "").trim()) m.push("a green flag");
  if (!(rep.notes ?? "").trim()) m.push("your notes");
  return m;
}

const CHECK_LABELS: Array<[string, string]> = [
  ["internal", "Red & green flags, notes saved"],
  ["photos", "Photos on the site, yours first"],
  ["video", "Video tour on the site"],
  ["listed", "Listing switched to Listed"],
  ["blockers", "Nothing blocks publishing"],
  ["card", "Card moved to live in amoCRM"],
  ["drive", "Copies on Google Drive"],
  ["group", "Report posted to Unicorn Rental"],
];

async function setChecks(id: string, checks: Check[], status?: string): Promise<void> {
  await pool.query(
    `UPDATE inspection_reports SET checks = $2::jsonb, status = COALESCE($3, status), updated_at = now(),
        done_at = CASE WHEN $3 = 'done' THEN now() ELSE done_at END WHERE id = $1`,
    [id, JSON.stringify(checks), status ?? null],
  );
}

const running = new Set<string>();
/** "checking" with no run in this process = the run died with a restart: the form offers "Check again". */
export function isRunning(id: string): boolean {
  return running.has(id);
}

/** Starts the apply-and-check run; the form polls GET /status for the lines. */
export async function fileReport(id: string, broker: string | null): Promise<{ ok: boolean; error?: string; missing?: string[] }> {
  const rep = await getReport(id);
  if (!rep) return { ok: false, error: "report not found" };
  if (rep.status === "done") return { ok: true };
  if (rep.status === "not_listing") return { ok: false, error: "this report was closed as not listing" };
  const missing = missingFields(rep, true);
  if (missing.length) return { ok: false, error: "required fields are missing", missing };
  if (running.has(id)) return { ok: true };
  await pool.query(`UPDATE inspection_reports SET status = 'checking', filed_by = COALESCE($2, filed_by), filed_at = COALESCE(filed_at, now()) WHERE id = $1`, [id, broker]);
  running.add(id);
  void applyAndCheck(id).finally(() => running.delete(id));
  return { ok: true };
}

async function applyAndCheck(id: string): Promise<void> {
  const rep = (await getReport(id))!;
  const code = rep.property_code!;
  const prev = new Map((rep.checks ?? []).map((c) => [c.key, c]));
  const checks: Check[] = CHECK_LABELS.map(([key, label]) => {
    const p = prev.get(key);
    return p && (p.state === "ok" || p.state === "warn") ? p : { key, label, state: "todo", detail: "" };
  });
  const set = async (key: string, state: CheckState, detail: string) => {
    const c = checks.find((x) => x.key === key)!;
    c.state = state;
    c.detail = detail;
    await setChecks(id, checks);
  };
  const need = (key: string) => {
    const c = checks.find((x) => x.key === key)!;
    return c.state !== "ok" && c.state !== "warn";
  };
  const step = async (key: string, fn: () => Promise<[CheckState, string]>) => {
    if (!need(key)) return;
    await set(key, "run", "");
    const t0 = Date.now();
    try {
      // A step that hangs is a red line, not an endless "checking" (the first live run sat on one for minutes).
      const limit = key === "card" ? 120_000 : key === "drive" ? 150_000 : 60_000;
      let timer: NodeJS.Timeout | undefined;
      const [state, detail] = await Promise.race([
        fn(),
        new Promise<[CheckState, string]>((resolve) => {
          timer = setTimeout(() => resolve(["bad", `no answer in ${Math.round(limit / 1000)} s — check again`]), limit);
        }),
      ]).finally(() => clearTimeout(timer));
      logger.info({ id, key, state, ms: Date.now() - t0, detail }, "inspection report: check");
      await set(key, state, detail);
    } catch (err) {
      logger.warn({ err, id, key }, "inspection report: check failed");
      await set(key, "bad", String((err as Error)?.message ?? err).slice(0, 300));
    }
  };

  const { property } = await siteListing(code).catch(() => ({ property: null, priv: null }));
  if (!property) {
    await set("internal", "bad", `listing ${code} is not on the site`);
    await finish(id, rep, checks);
    return;
  }

  await step("internal", () => applyInternal(rep));
  await step("photos", () => applyPhotos(id, rep, property));
  await step("video", () => applyVideo(rep, property));
  await step("listed", () => applyListed(code, property));
  await step("blockers", async () => {
    const b = await publishBlockers(code);
    return b.length ? ["bad", `still missing on the site: ${b.join(", ")}`] : ["ok", "listing_publish_blockers is empty"];
  });
  await step("card", () => moveCard(rep));
  await step("drive", () => copyToDrive(rep));
  await step("group", () => postToGroup(id, rep));
  await finish(id, rep, checks);
}

async function finish(id: string, rep: ReportRow, checks: Check[]): Promise<void> {
  const bad = checks.filter((c) => c.state === "bad" || c.state === "todo" || c.state === "run");
  if (bad.length) {
    await setChecks(id, checks, "failed");
    await notifyBroker(
      OWNER_BROKER,
      `Inspection report NOT closed · ${rep.property_code ?? rep.lead_id}`,
      bad.map((c) => `${c.label}: ${c.detail || "not done"}`).join(" · "),
      "/m",
    ).catch(() => 0);
    logger.warn({ id, lead: rep.lead_id, bad: bad.map((c) => c.key) }, "inspection report: checks failed, report stays open");
    return;
  }
  await setChecks(id, checks, "done");
  await closeTaskAndPlaceholder(rep.lead_id, "Inspection report filed in Copilot");
  logger.info({ id, lead: rep.lead_id, code: rep.property_code }, "inspection report: done, every check green");
}

async function applyInternal(rep: ReportRow): Promise<[CheckState, string]> {
  const code = rep.property_code!;
  const { priv } = await siteListing(code);
  const stamp = new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Makassar", day: "2-digit", month: "2-digit", year: "numeric" });
  const block = `Inspection ${stamp} (${rep.filed_by ?? "Yudi"}): ${(rep.notes ?? "").trim()}`;
  const oldNotes = (priv?.notes ?? "").trim();
  const notes = oldNotes.includes(block) ? oldNotes : [block, oldNotes].filter(Boolean).join("\n\n");
  const row: Record<string, unknown> = {
    property_id: code,
    red_flags: (rep.red_flags ?? "").trim(),
    green_flags: (rep.green_flags ?? "").trim(),
    construction_nearby: !!rep.construction_nearby,
    notes,
  };
  for (const [k, v] of Object.entries(rep.private_edits ?? {})) if ((PRIVATE_KEYS as readonly string[]).includes(k) && v) row[k] = v;
  await siteWrite("POST", "property_private?on_conflict=property_id", [row], "resolution=merge-duplicates,return=representation");
  const { priv: after } = await siteListing(code);
  const same =
    after &&
    (after.red_flags ?? "").trim() === row["red_flags"] &&
    (after.green_flags ?? "").trim() === row["green_flags"] &&
    (after.notes ?? "").includes(block);
  if (!same) return ["bad", "the site did not keep what was sent (read back differs)"];
  const r = String(row["red_flags"]).split("\n").length;
  const g = String(row["green_flags"]).split("\n").length;
  return ["ok", `${r} red · ${g} green · notes${rep.construction_nearby ? " · construction nearby" : ""} — read back from the site`];
}

async function headOk(u: string): Promise<boolean> {
  const res = await fetch(u, { method: "HEAD", signal: AbortSignal.timeout(15000) }).catch(() => null);
  return !!res && res.ok;
}

async function applyPhotos(id: string, rep: ReportRow, property: Property): Promise<[CheckState, string]> {
  const own = (rep.photos ?? []).filter(storageUrl);
  if (!own.length) return ["warn", "no new photos added — the gallery stays as it was"];
  const cover = rep.cover && own.includes(rep.cover) ? rep.cover : own[0]!;
  const ordered = [cover, ...own.filter((u) => u !== cover)];
  const before = rep.previous_images ?? (property.images ?? []);
  if (!rep.previous_images) {
    await pool.query(`UPDATE inspection_reports SET previous_images = $2::jsonb WHERE id = $1`, [id, JSON.stringify(before)]);
  }
  const older = before.filter((u) => !own.includes(u));
  const replace = own.length >= REPLACE_AT;
  const images = replace ? ordered : [...ordered, ...older];
  for (const u of ordered) if (!(await headOk(u))) return ["bad", `an uploaded photo does not open: ${u.split("/").pop()}`];
  await siteWrite("PATCH", `properties?id=eq.${enc(rep.property_code!)}`, { images });
  const [p] = await siteGet<{ images: string[] | null }[]>(`properties?select=images&id=eq.${enc(rep.property_code!)}`);
  if (!p || (p.images ?? [])[0] !== cover || (p.images ?? []).length !== images.length) return ["bad", "the site did not keep the new gallery order"];
  return [
    "ok",
    replace
      ? `${own.length} of yours, cover set · ${older.length} online photos hidden (kept on the report, can be restored)`
      : `${own.length} of yours first, cover set · ${older.length} older photos kept after them (fewer than ${REPLACE_AT} of yours)`,
  ];
}

async function applyVideo(rep: ReportRow, property: Property): Promise<[CheckState, string]> {
  if (!rep.video_url) return ["warn", property.video_url ? "no new video — the old one stays" : "no video added"];
  if (!(await headOk(rep.video_url))) return ["bad", "the uploaded video does not open"];
  // The compressor swaps video_url for its -web.mp4 later; either is ours.
  const [cur] = await siteGet<{ video_url: string | null }[]>(`properties?select=video_url&id=eq.${enc(rep.property_code!)}`);
  const stem = rep.video_url.replace(/\.[a-z0-9]+$/i, "");
  if (!(cur?.video_url ?? "").startsWith(stem)) await siteWrite("PATCH", `properties?id=eq.${enc(rep.property_code!)}`, { video_url: rep.video_url });
  const [p] = await siteGet<{ video_url: string | null }[]>(`properties?select=video_url&id=eq.${enc(rep.property_code!)}`);
  if (!(p?.video_url ?? "").startsWith(stem)) return ["bad", "the site did not keep the video"];
  return ["ok", "set as the video tour; the server compresses it within minutes"];
}

async function applyListed(code: string, property: Property): Promise<[CheckState, string]> {
  const patch: Record<string, unknown> = {};
  if (property.pre_listed !== false) patch["pre_listed"] = false;
  if (property.is_draft) patch["is_draft"] = false;
  if (Object.keys(patch).length) await siteWrite("PATCH", `properties?id=eq.${enc(code)}`, patch);
  const [p] = await siteGet<{ pre_listed: boolean | null; is_draft: boolean | null }[]>(`properties?select=pre_listed,is_draft&id=eq.${enc(code)}`);
  if (p?.pre_listed !== false) return ["bad", "pre_listed is still true on the site"];
  if (p?.is_draft) return ["bad", "the listing is still a draft (not published)"];
  return ["ok", `pre_listed = false${property.is_draft ? " · published (was a draft)" : ""} — read back`];
}

async function moveCard(rep: ReportRow): Promise<[CheckState, string]> {
  const code = rep.property_code!;
  const links = await siteGet<{ amo_lead_id: number }[]>(`listing_crm_link?select=amo_lead_id&property_id=eq.${enc(code)}`);
  if (!links.some((l) => String(l.amo_lead_id) === rep.lead_id)) {
    if (links.length) return ["bad", `${code} is linked to another card (#${links.map((l) => l.amo_lead_id).join(", #")}), not #${rep.lead_id}`];
    await siteInsert("listing_crm_link", [{ property_id: code, amo_lead_id: Number(rep.lead_id), source: "inspection_report", evidence: `inspection report ${rep.id}` }]);
  }
  for (let i = 0; i < 8; i++) {
    const lead = await getAmoLead(rep.lead_id);
    if (lead?.status_id && LIVE_STAGES.has(lead.status_id)) {
      await amoPost(`/api/v4/leads/${rep.lead_id}/notes`, [{ note_type: "common", params: { text: reportNote(rep) } }]).catch(() => null);
      return ["ok", `card #${rep.lead_id} is in live — read from amoCRM`];
    }
    await runListingStatusPass().catch(() => []);
    await new Promise((r) => setTimeout(r, 5000));
  }
  const lead = await getAmoLead(rep.lead_id);
  return ["bad", `card #${rep.lead_id} is still in status ${lead?.status_id ?? "?"} — Yudi and the owner got the pass's push`];
}

function reportNote(rep: ReportRow): string {
  return [
    `INSPECTION REPORT — ${rep.property_code}, ${fmt(new Date(rep.visit_at))}`,
    `Red flags: ${(rep.red_flags ?? "").split("\n").join("; ")}`,
    `Green flags: ${(rep.green_flags ?? "").split("\n").join("; ")}`,
    `Notes: ${(rep.notes ?? "").replace(/\n/g, " ")}`,
    rep.photos?.length ? `New photos: ${rep.photos.length}` : null,
    rep.video_url ? "New video tour" : null,
    `Filed by ${rep.filed_by ?? "Yudi"} via Copilot · ${SITE}/property/${rep.property_code}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function copyToDrive(rep: ReportRow): Promise<[CheckState, string]> {
  const files = [...(rep.photos ?? []), ...(rep.video_url ? [rep.video_url] : [])];
  if (!files.length) return ["warn", "nothing new to copy"];
  const hook = (process.env["DRIVE_COPY_WEBHOOK_URL"] ?? "").trim();
  if (!hook) return ["warn", "Drive is not connected yet — files are on the site, copy them by hand for now"];
  const { priv } = await siteListing(rep.property_code!);
  const folder = (priv?.drive_folder_url ?? "").match(/folders\/([A-Za-z0-9_-]{10,})/)?.[1];
  if (!folder) return ["bad", "the listing has no Drive folder link in Internal data"];
  const res = await fetch(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: process.env["DRIVE_COPY_WEBHOOK_SECRET"] ?? "", folderId: folder, files: files.map((url) => ({ url, name: url.split("/").pop() })) }),
    signal: AbortSignal.timeout(120000),
  }).catch(() => null);
  const body = (res ? await res.json().catch(() => null) : null) as { ok?: boolean; copied?: number } | null;
  if (!res?.ok || !body?.ok) return ["bad", `Drive copy did not confirm (${res?.status ?? "no answer"})`];
  const copied = Number(body.copied ?? 0);
  return copied >= files.length ? ["ok", `${copied} files in the listing's Drive folder`] : ["bad", `${copied} of ${files.length} files reached Drive`];
}

async function sessionOpen(name: string): Promise<boolean> {
  const r = await gateway("GET", "/sessions").catch(() => null);
  return Array.isArray(r?.data) && r!.data.some((s: any) => s.name === name && s.status === "open");
}

export function groupMessage(rep: ReportRow, property: Property | null): string {
  const red = (rep.red_flags ?? "").split("\n").filter(Boolean).join("; ");
  const green = (rep.green_flags ?? "").split("\n").filter(Boolean).join("; ");
  const note = (rep.notes ?? "").split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "";
  const media: string[] = [];
  if (rep.photos?.length) media.push(`${rep.photos.length} new photo${rep.photos.length === 1 ? "" : "s"}`);
  if (rep.video_url) media.push("video tour");
  const facts = [property?.bedrooms ? `${property.bedrooms}BR` : null, property?.area ?? null, "✅ Listed"].filter(Boolean).join(" · ");
  const title = (property?.title ?? "").replace(/\s+[-–—|]\s+.*$/, "").trim();
  return [
    `🔍 *Inspection done — ${title ? `${title} (${rep.property_code})` : rep.property_code}*`,
    facts,
    `🔴 ${red}`,
    `🟢 ${green}`,
    note ? `📝 ${note}` : null,
    media.length ? `📸 ${media.join(" + ")} on the site` : null,
    `${SITE}/property/${rep.property_code}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** A throwaway test listing (R-TEST-…) never posts to the team: its message goes to the company number's own chat. */
const TEST_CODE = /^R-TEST-/i;
const SELF_CHAT = process.env["INSPECTION_REPORT_TEST_CHAT"] ?? "6285337836490";

async function sendToGroup(text: string, code: string | null = null): Promise<{ ok: boolean; id?: string; session: string; error?: string }> {
  const to = code && TEST_CODE.test(code) ? SELF_CHAT : GROUP_JID;
  const yudi = await sessionOpen(YUDI_SESSION);
  // Until Yudi's number is linked, the owner's number posts it, signed, so no report waits on a QR code.
  const session = yudi ? YUDI_SESSION : OWNER_SESSION;
  const body = yudi ? text : `Yudi's inspection report:\n${text}`;
  const r = await gateway("POST", "/send", { session, to, text: body }).catch((err) => ({ status: 503, data: { ok: false, error: String(err) } }));
  await pool
    .query(
      `INSERT INTO wa_messages (session, wa_id, direction, phone, type, text, status, error) VALUES ($1, $2, 'out_api', $3, 'text', $4, $5, $6)
       ON CONFLICT (session, wa_id) WHERE wa_id IS NOT NULL DO NOTHING`,
      [session, r.data?.id ?? null, to, body, r.data?.ok ? "sent" : "error", r.data?.ok ? null : String(r.data?.error ?? r.status)],
    )
    .catch(() => null);
  return { ok: !!r.data?.ok, id: r.data?.id, session, error: r.data?.error };
}

async function postToGroup(id: string, rep: ReportRow): Promise<[CheckState, string]> {
  if (rep.wa_message_id) return ["ok", "already posted"];
  const { property } = await siteListing(rep.property_code!);
  const sent = await sendToGroup(groupMessage(rep, property), rep.property_code);
  if (!sent.ok) return ["bad", `WhatsApp did not accept the message (${sent.error ?? "no answer"})`];
  await pool.query(`UPDATE inspection_reports SET wa_message_id = $2 WHERE id = $1`, [id, sent.id ?? "sent"]);
  return sent.session === YUDI_SESSION ? ["ok", "sent from Yudi's number"] : ["warn", "sent from the company number, signed as Yudi's report — Yudi's WhatsApp is not linked yet"];
}

async function closeTaskAndPlaceholder(leadId: string, result: string): Promise<void> {
  const open = await getOpenAmoTasks(leadId).catch(() => []);
  const mine = open.filter((t) => (t.text ?? "").startsWith(INSPECTION_REPORT_TASK_PREFIX));
  if (mine.length) await amoPatch(`/api/v4/tasks`, mine.map((t) => ({ id: t.id, is_completed: true, result: { text: result } }))).catch(() => null);
  await pool
    .query(
      `UPDATE pending_suggestions SET status = 'skipped', autopilot_skipped_reason = 'inspection report closed', autopilot_skipped_at = now()
        WHERE lead_id = $1 AND status = 'pending' AND autopilot_skipped_reason = $2`,
      [leadId, INSPECTION_REPORT_VERDICT],
    )
    .catch(() => null);
}

// ── Not listing ───────────────────────────────────────────────────────────────

export const NOT_LISTING_REASONS = ["Owner changed mind", "Condition too poor", "Price too high", "Not as described", "Already rented", "Other"] as const;

export async function closeNotListing(id: string, reason: string, notes: string, broker: string | null): Promise<{ ok: boolean; error?: string; checks?: Check[] }> {
  const rep = await getReport(id);
  if (!rep) return { ok: false, error: "report not found" };
  if (rep.status === "done") return { ok: false, error: "this report is already closed as Listed" };
  if (!(NOT_LISTING_REASONS as readonly string[]).includes(reason)) return { ok: false, error: "pick a reason" };
  if (!notes.trim()) return { ok: false, error: "your notes are required" };
  const checks: Check[] = [];
  const add = (key: string, label: string, state: CheckState, detail: string) => checks.push({ key, label, state, detail });
  await pool.query(`UPDATE inspection_reports SET not_listing_reason = $2, notes = $3, filed_by = $4, filed_at = now() WHERE id = $1`, [id, reason, notes.trim(), broker]);

  const code = rep.property_code;
  if (code) {
    try {
      const { property, priv } = await siteListing(code);
      if (property) {
        const block = `Inspection ${new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Makassar" })} (${broker ?? "Yudi"}): NOT LISTING — ${reason}. ${notes.trim()}`;
        if (priv) await siteWrite("PATCH", `property_private?property_id=eq.${enc(code)}`, { notes: [block, (priv.notes ?? "").trim()].filter(Boolean).join("\n\n") });
        if (!property.is_draft) await siteWrite("PATCH", `properties?id=eq.${enc(code)}`, { is_draft: true });
        const [p] = await siteGet<{ is_draft: boolean | null }[]>(`properties?select=is_draft&id=eq.${enc(code)}`);
        add("site", "Listing hidden from the site", p?.is_draft ? "ok" : "bad", p?.is_draft ? "is_draft = true — read back" : "still published");
      } else add("site", "Listing hidden from the site", "warn", `${code} is not on the site`);
    } catch (err) {
      add("site", "Listing hidden from the site", "bad", String((err as Error).message).slice(0, 200));
    }
  } else add("site", "Listing hidden from the site", "warn", "no listing code on this card");

  await amoPost(`/api/v4/leads/${rep.lead_id}/notes`, [
    { note_type: "common", params: { text: `INSPECTION — NOT LISTING (${fmt(new Date(rep.visit_at))})\nReason: ${reason}\n${notes.trim()}\nFiled by ${broker ?? "Yudi"} via Copilot` } },
  ]).catch(() => null);
  await closeLeadAsLost(rep.lead_id);
  const lead = await getAmoLead(rep.lead_id);
  add("card", "Card closed as lost", lead?.status_id === 143 ? "ok" : "bad", lead?.status_id === 143 ? `card #${rep.lead_id} is lost — read from amoCRM` : `card is in status ${lead?.status_id ?? "?"}`);

  if (!rep.wa_message_id) {
    const { property } = code ? await siteListing(code).catch(() => ({ property: null, priv: null })) : { property: null };
    const title = (property?.title ?? "").replace(/\s+[-–—|]\s+.*$/, "").trim();
    const sent = await sendToGroup(`🔍 *Inspected, not listing — ${title || code || `card #${rep.lead_id}`}*\n${reason}: ${notes.trim().split("\n")[0]}`, code);
    if (sent.ok) await pool.query(`UPDATE inspection_reports SET wa_message_id = $2 WHERE id = $1`, [id, sent.id ?? "sent"]);
    add("group", "Posted to Unicorn Rental", sent.ok ? (sent.session === YUDI_SESSION ? "ok" : "warn") : "bad", sent.ok ? (sent.session === YUDI_SESSION ? "sent from Yudi's number" : "sent from the company number") : `not sent (${sent.error ?? "no answer"})`);
  }
  const bad = checks.some((c) => c.state === "bad");
  await setChecks(id, checks, bad ? "failed" : "not_listing");
  if (!bad) await closeTaskAndPlaceholder(rep.lead_id, `Inspected — not listing: ${reason}`);
  else await notifyBroker(OWNER_BROKER, `Not-listing report NOT closed · ${code ?? rep.lead_id}`, checks.filter((c) => c.state === "bad").map((c) => `${c.label}: ${c.detail}`).join(" · "), "/m").catch(() => 0);
  return { ok: !bad, checks };
}

export const AMO_CARD_URL = (leadId: string) => `${AMO}/${leadId}`;
