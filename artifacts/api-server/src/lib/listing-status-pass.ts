/**
 * The website's Pre-listed / Listed switch is the inspection result, and it moves the villa's card
 * in Rental Listings to live (owner, 2026-09-14: "на сайте в internal data этот рубильник — по нему
 * можно считать как итог и двигать карточки в live в CRM").
 *
 * The site database journals every change of `properties.pre_listed` (trigger →
 * `listing_status_log`: old/new value, who, through what). Every few minutes this pass reads the
 * changes it has not decided yet and, for each:
 *
 * - Pre-listed → Listed, card in TAKEN TO WORK / QUALIFIED / Details / Inspection. done:
 *   the card goes to Inspection. done, then to live (two status changes a few seconds apart, so
 *   amoCRM's event log shows the path), plus a note saying who listed it, when, and whether the
 *   inspection record (flags, video, Drive folder) is on the site.
 * - card already in live / Weekly Check Sent / Update Availability Received: nothing.
 * - card in long term / co-broke / lost / won, no card, or two candidate cards: not moved; Yudi gets
 *   a push and the daily report lists it.
 * - Listed → Pre-listed: never moves a card back; Yudi is told.
 *
 * Each decision is written to `listing_status_actions` (one row per log row), which is what makes
 * the pass idempotent and what the report reads. A person switched the listing, so this is the one
 * automatic way into Inspection. done and live — the stage engine does not own either
 * (`engineOwnsStage`), and nothing here ever moves a card out of live.
 *
 * Which card belongs to a listing is kept in `listing_crm_link`. An unlinked listing is resolved the
 * way the 14.09 backfill was: its code in an open card's name or notes, then its owner phone on the
 * card's contact — and when two cards qualify, nothing is guessed.
 */
import { amoFetch, amoPost, getAmoLead, updateLeadStatus } from "./amo-client";
import { notifyBroker } from "./push-notifications";
import { phoneKey } from "./property-flags";
import { logger } from "./logger";
import {
  LISTING_AGENT_BROKER,
  LISTINGS_PIPELINE_ID as PIPELINE_ID,
  LISTING_STAGE,
  LISTING_STAGE_NAME as STAGE_NAME,
  siteGet,
  siteInsert,
  type Decision,
} from "./listing-status-week";

const SITE = "https://unicorn-properties.com";
const MOVABLE = new Set<number>([
  LISTING_STAGE.TAKEN_TO_WORK,
  LISTING_STAGE.QUALIFIED,
  LISTING_STAGE.DETAILS,
  LISTING_STAGE.INSPECTION_DONE,
]);
const ALREADY_LIVE = new Set<number>([
  LISTING_STAGE.LIVE,
  LISTING_STAGE.WEEKLY_CHECK_SENT,
  LISTING_STAGE.AVAILABILITY_RECEIVED,
]);
const PARKED = new Set<number>([LISTING_STAGE.LONG_TERM, LISTING_STAGE.CO_BROKE, LISTING_STAGE.LOST, LISTING_STAGE.WON]);
const CLOSED = new Set<number>([LISTING_STAGE.WON, LISTING_STAGE.LOST]);
/** "[SYSTEM] FB прогон — доска состояния": a status board whose notes name every code. Never a villa. */
const SYSTEM_LEADS = new Set<number>([23211429]);

/** Changes older than this are not picked up (the pass runs every 5 minutes). */
const LOOKBACK_DAYS = 7;
const PASS_EVERY_MS = 5 * 60 * 1000;
/** Between "Inspection. done" and "live", so the two moves are two events in amoCRM. */
const STEP_GAP_MS = 4000;
/** A Listed → Pre-listed write this soon after the row was inserted is the admin form creating or renaming it. */
const CREATION_WINDOW_MS = 10 * 60 * 1000;

type LogRow = {
  id: number;
  property_id: string;
  op: "INSERT" | "UPDATE";
  pre_listed_old: boolean | null;
  pre_listed_new: boolean | null;
  is_draft: boolean | null;
  changed_at: string;
  changed_by_email: string | null;
  source: string;
};
type PropertyRow = { id: string; title: string | null; is_draft: boolean; pre_listed: boolean | null; video_url: string | null };
type AmoLeadRow = {
  id: number;
  name: string | null;
  status_id: number;
  pipeline_id: number;
  _embedded?: { contacts?: { id: number }[] };
};

export type PassDecision = {
  logId: number;
  propertyId: string;
  decision: Decision;
  amoLeadId: number | null;
  stageBefore: string | null;
  detail: string;
  notify?: { title: string; body: string };
};

const enc = encodeURIComponent;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stageName = (id: number | null | undefined) => (id == null ? "unknown" : STAGE_NAME[id] ?? `stage ${id}`);

export function baliTime(iso: string): string {
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Makassar",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso)) + " Bali time"
  );
}

// ── Which card is this listing's ─────────────────────────────────────────────

export type CardResolution =
  | { kind: "one"; leadId: number; source: string; evidence: string }
  | { kind: "none"; detail: string }
  | { kind: "ambiguous"; detail: string };

type ResolverContext = {
  leads: AmoLeadRow[];
  /** Card name plus every common note (open cards); closed cards carry only their name. */
  textByLead: Map<number, string>;
  phonesByLead: Map<number, Set<string>>;
  phonesByListing: Map<string, Set<string>>;
  listingsByPhone: Map<string, Set<string>>;
  siteIds: Set<string>;
};

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const codeRx = (code: string) => new RegExp(`(?<![A-Za-z0-9-])${escapeRx(code)}(?![0-9])`, "i");

function codesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![A-Za-z0-9-])(R-[A-Za-z]+-\d+)(?![0-9])/g)) out.add(m[1]!.toUpperCase());
  return out;
}

function phoneKeys(raw: string | null | undefined): Set<string> {
  const keys = new Set<string>();
  for (const part of String(raw ?? "").split(/[/,;]| or /i)) {
    const k = phoneKey(part);
    if (k) keys.add(k);
  }
  return keys;
}

const overlaps = (a: Set<string> | undefined, b: Set<string> | undefined) =>
  !!a && !!b && [...a].some((k) => b.has(k));

async function buildResolverContext(): Promise<ResolverContext> {
  const leads: AmoLeadRow[] = [];
  for (let page = 1; page <= 20; page++) {
    const d = await amoFetch<{ _embedded?: { leads?: AmoLeadRow[] } }>(
      `/api/v4/leads?filter[pipeline_id][]=${PIPELINE_ID}&with=contacts&limit=250&page=${page}`,
    );
    const batch = d?._embedded?.leads ?? [];
    leads.push(...batch);
    if (batch.length < 250) break;
  }
  if (leads.length === 0) throw new Error("amoCRM returned no Rental Listings cards");

  const open = leads.filter((l) => !CLOSED.has(l.status_id) && !SYSTEM_LEADS.has(l.id));
  const textByLead = new Map<number, string>(leads.map((l) => [l.id, l.name ?? ""]));
  for (let i = 0; i < open.length; i += 40) {
    const ids = open
      .slice(i, i + 40)
      .map((l) => `filter[entity_id][]=${l.id}`)
      .join("&");
    for (let page = 1; page <= 10; page++) {
      const d = await amoFetch<{ _embedded?: { notes?: { entity_id: number; params?: { text?: string } }[] } }>(
        `/api/v4/leads/notes?${ids}&filter[note_type][]=common&limit=250&page=${page}`,
      );
      // Forty open listing cards without a single note do not exist: an empty first page is a failed read,
      // and a resolution without the notes could link by phone a card whose notes name another villa.
      if (page === 1 && !d) throw new Error("amoCRM notes could not be read");
      const notes = d?._embedded?.notes ?? [];
      for (const n of notes) {
        textByLead.set(n.entity_id, `${textByLead.get(n.entity_id) ?? ""}\n${n.params?.text ?? ""}`);
      }
      if (notes.length < 250) break;
    }
  }

  const contactIds = [...new Set(open.flatMap((l) => (l._embedded?.contacts ?? []).map((c) => c.id)))];
  const phonesByContact = new Map<number, Set<string>>();
  for (let i = 0; i < contactIds.length; i += 50) {
    const q = contactIds
      .slice(i, i + 50)
      .map((id) => `filter[id][]=${id}`)
      .join("&");
    const d = await amoFetch<{
      _embedded?: {
        contacts?: {
          id: number;
          custom_fields_values?: { field_code?: string | null; values?: { value?: unknown }[] }[] | null;
        }[];
      };
    }>(`/api/v4/contacts?${q}&limit=250`);
    if (!d) throw new Error("amoCRM contacts could not be read");
    for (const c of d._embedded?.contacts ?? []) {
      const keys = new Set<string>();
      for (const f of c.custom_fields_values ?? []) {
        if (f.field_code !== "PHONE") continue;
        for (const v of f.values ?? []) for (const k of phoneKeys(String(v.value ?? ""))) keys.add(k);
      }
      phonesByContact.set(c.id, keys);
    }
  }
  const phonesByLead = new Map<number, Set<string>>(
    open.map((l) => [
      l.id,
      new Set((l._embedded?.contacts ?? []).flatMap((c) => [...(phonesByContact.get(c.id) ?? [])])),
    ]),
  );

  const [privateRows, idRows] = await Promise.all([
    siteGet<{ property_id: string; owner_phone: string | null }[]>(
      "property_private?select=property_id,owner_phone&owner_phone=not.is.null",
    ),
    siteGet<{ id: string }[]>("properties?select=id"),
  ]);
  const phonesByListing = new Map<string, Set<string>>();
  const listingsByPhone = new Map<string, Set<string>>();
  for (const r of privateRows) {
    const id = r.property_id.toUpperCase();
    const keys = phoneKeys(r.owner_phone);
    phonesByListing.set(id, keys);
    for (const k of keys) {
      if (!listingsByPhone.has(k)) listingsByPhone.set(k, new Set());
      listingsByPhone.get(k)!.add(id);
    }
  }
  return {
    leads,
    textByLead,
    phonesByLead,
    phonesByListing,
    listingsByPhone,
    siteIds: new Set(idRows.map((r) => r.id.toUpperCase())),
  };
}

/** One card, or an honest "none" / "ambiguous". Pure over the context, so it can be replayed. */
export function resolveFrom(ctx: ResolverContext, propertyId: string): CardResolution {
  const code = propertyId.toUpperCase();
  const rx = codeRx(code);
  const label = (l: AmoLeadRow) => `#${l.id} (${stageName(l.status_id)})`;
  const isOpen = (l: AmoLeadRow) => !CLOSED.has(l.status_id) && !SYSTEM_LEADS.has(l.id);
  const otherCodesOn = (l: AmoLeadRow) =>
    [...codesIn(ctx.textByLead.get(l.id) ?? "")].filter((c) => c !== code && ctx.siteIds.has(c));

  const named = ctx.leads.filter((l) => !SYSTEM_LEADS.has(l.id) && rx.test(ctx.textByLead.get(l.id) ?? l.name ?? ""));
  const strong = named.filter(isOpen);
  const myPhones = ctx.phonesByListing.get(code) ?? new Set<string>();
  const phoneCards = myPhones.size
    ? ctx.leads.filter((l) => isOpen(l) && overlaps(ctx.phonesByLead.get(l.id), myPhones))
    : [];

  if (strong.length > 1) {
    return { kind: "ambiguous", detail: `the code is on several open cards: ${strong.map(label).join(", ")}` };
  }
  if (strong.length === 1) {
    const card = strong[0]!;
    const onPhone = phoneCards.some((l) => l.id === card.id);
    if (!onPhone && phoneCards.length > 0) {
      return {
        kind: "ambiguous",
        detail: `the code is on ${label(card)} but the owner phone is on ${phoneCards.map(label).join(", ")}`,
      };
    }
    const others = otherCodesOn(card);
    if (others.length > 0) {
      const othersOnPhone = others.filter((o) => overlaps(ctx.phonesByListing.get(o), ctx.phonesByLead.get(card.id)));
      if (!onPhone || othersOnPhone.length > 0) {
        return { kind: "ambiguous", detail: `${label(card)} also names ${others.join(", ")}` };
      }
    }
    const how = rx.test(card.name ?? "") ? "code-in-name" : "code-in-note";
    return { kind: "one", leadId: card.id, source: onPhone ? `${how}+phone` : how, evidence: `${label(card)} ${card.name ?? ""}`.trim() };
  }
  if (phoneCards.length === 1) {
    const card = phoneCards[0]!;
    const others = otherCodesOn(card);
    const sharedPhone = [...myPhones].some((k) => (ctx.listingsByPhone.get(k)?.size ?? 0) > 1);
    if (others.length === 0 && !sharedPhone) {
      return { kind: "one", leadId: card.id, source: "owner-phone", evidence: `${label(card)} ${card.name ?? ""}`.trim() };
    }
    return {
      kind: "ambiguous",
      detail:
        `the owner phone is on ${label(card)}` +
        (others.length ? `, which names ${others.join(", ")}` : "") +
        (sharedPhone ? ", and the same phone belongs to another listing" : ""),
    };
  }
  if (phoneCards.length > 1) {
    return { kind: "ambiguous", detail: `the owner phone is on several open cards: ${phoneCards.map(label).join(", ")}` };
  }
  const closed = named.filter((l) => CLOSED.has(l.status_id));
  return {
    kind: "none",
    detail: closed.length
      ? `only closed cards carry the code: ${closed.map(label).join(", ")}`
      : "no card in Rental Listings carries the code or the owner phone",
  };
}

// ── Inspection record on the site ─────────────────────────────────────────────

const lineCount = (t: string | null | undefined) => String(t ?? "").split("\n").filter((l) => l.trim() !== "").length;

async function inspectionRecord(p: PropertyRow): Promise<string> {
  const [priv] = await siteGet<
    { red_flags: string | null; green_flags: string | null; construction_nearby: boolean | null; drive_folder_url: string | null }[]
  >(`property_private?select=red_flags,green_flags,construction_nearby,drive_folder_url&property_id=eq.${enc(p.id)}`);
  const red = lineCount(priv?.red_flags);
  const green = lineCount(priv?.green_flags);
  return [
    red + green > 0
      ? `red/green flags present (${red} red, ${green} green${priv?.construction_nearby ? ", construction nearby" : ""})`
      : "red/green flags MISSING",
    p.video_url ? "own video present" : "own video MISSING",
    (priv?.drive_folder_url ?? "").trim() ? "Drive folder (own photos) present" : "Drive folder (own photos) MISSING",
  ].join("; ");
}

// ── The pass ─────────────────────────────────────────────────────────────────

function whoChanged(row: LogRow): string {
  if (row.changed_by_email) return row.changed_by_email;
  if (row.source === "service_role") return "a server with the service key";
  if (row.source === "sql") return "a direct database session";
  return "an unknown session";
}

async function decide(
  row: LogRow,
  allRows: LogRow[],
  context: () => Promise<ResolverContext>,
  dry: boolean,
): Promise<Omit<PassDecision, "logId" | "propertyId">> {
  const [p] = await siteGet<PropertyRow[]>(
    `properties?select=id,title,is_draft,pre_listed,video_url&id=eq.${enc(row.property_id)}`,
  );
  if (!p) return { decision: "skipped", amoLeadId: null, stageBefore: null, detail: "the listing no longer exists (deleted or renamed)" };
  const who = whoChanged(row);
  const when = baliTime(row.changed_at);
  const [link] = await siteGet<{ amo_lead_id: number; source: string }[]>(
    `listing_crm_link?select=amo_lead_id,source&property_id=eq.${enc(p.id)}`,
  );

  // Listed → Pre-listed: never moves a card back.
  if (row.pre_listed_old === false && row.pre_listed_new === true) {
    const at = Date.parse(row.changed_at);
    const beingCreated = allRows.some(
      (r) => r.property_id === row.property_id && r.op === "INSERT" && at >= Date.parse(r.changed_at) && at - Date.parse(r.changed_at) < CREATION_WINDOW_MS,
    );
    if (beingCreated) {
      return { decision: "skipped", amoLeadId: link?.amo_lead_id ?? null, stageBefore: null, detail: "status set while the listing was being created or renamed" };
    }
    return {
      decision: "back_to_prelisted",
      amoLeadId: link?.amo_lead_id ?? null,
      stageBefore: null,
      detail: `switched back to Pre-listed by ${who} at ${when}; the card was not moved back`,
      notify: {
        title: `${p.id} switched back to Pre-listed`,
        body: `${who}, ${when}. Its amoCRM card was NOT moved back — move it yourself if the inspection result changed.`,
      },
    };
  }

  if (!(row.pre_listed_old === true && row.pre_listed_new === false)) {
    return { decision: "skipped", amoLeadId: null, stageBefore: null, detail: `not a status switch (${row.pre_listed_old} → ${row.pre_listed_new})` };
  }
  if (p.pre_listed !== false) {
    return { decision: "skipped", amoLeadId: link?.amo_lead_id ?? null, stageBefore: null, detail: "switched back to Pre-listed before the pass ran" };
  }

  const notMoved = (decision: Decision, detail: string, leadId: number | null, stage: string | null) => ({
    decision,
    amoLeadId: leadId,
    stageBefore: stage,
    detail,
    notify: {
      title: `${p.id} is Listed — card NOT moved`,
      body: `Listed on the site by ${who} (${when}), but ${detail}. Move the right card to live yourself.`,
    },
  });

  let leadId = link?.amo_lead_id ?? null;
  if (!leadId) {
    const found = resolveFrom(await context(), p.id);
    if (found.kind === "none") return notMoved("not_moved_no_card", found.detail, null, null);
    if (found.kind === "ambiguous") return notMoved("not_moved_ambiguous", found.detail, null, null);
    leadId = found.leadId;
    if (!dry) {
      await siteInsert("listing_crm_link", [
        { property_id: p.id, amo_lead_id: leadId, source: found.source, evidence: found.evidence.slice(0, 500) },
      ]);
    }
  }

  const lead = await getAmoLead(String(leadId));
  if (!lead?.status_id) throw new Error(`amoCRM did not return card #${leadId}`);
  const stage = stageName(lead.status_id);
  if (lead.pipeline_id !== PIPELINE_ID) {
    return notMoved("not_moved_other_stage", `its linked card #${leadId} is not in Rental Listings`, leadId, stage);
  }
  if (ALREADY_LIVE.has(lead.status_id)) {
    return { decision: "already_live", amoLeadId: leadId, stageBefore: stage, detail: `card #${leadId} is already in ${stage}` };
  }
  if (PARKED.has(lead.status_id)) {
    return notMoved("not_moved_parked", `its card #${leadId} is in ${stage}`, leadId, stage);
  }
  if (!MOVABLE.has(lead.status_id)) {
    return notMoved("not_moved_other_stage", `its card #${leadId} is still in ${stage}`, leadId, stage);
  }

  const record = await inspectionRecord(p);
  const path = lead.status_id === LISTING_STAGE.INSPECTION_DONE ? "Inspection. done → live" : `${stage} → Inspection. done → live`;
  if (!dry) {
    if (lead.status_id !== LISTING_STAGE.INSPECTION_DONE) {
      if (!(await updateLeadStatus(String(leadId), LISTING_STAGE.INSPECTION_DONE))) {
        throw new Error(`amoCRM refused to move #${leadId} to Inspection. done`);
      }
      await sleep(STEP_GAP_MS);
    }
    if (!(await updateLeadStatus(String(leadId), LISTING_STAGE.LIVE))) {
      throw new Error(`amoCRM refused to move #${leadId} to live`);
    }
    const note =
      `Listed on the website: ${p.id} was switched Pre-listed → Listed by ${who} at ${when}.\n` +
      `Card moved ${path} automatically — the site switch is the inspection result (owner, 14.09.2026).\n` +
      `Inspection record on the site: ${record}.\n` +
      `${SITE}/property/${p.id}`;
    const posted = await amoPost(`/api/v4/leads/${leadId}/notes`, [{ note_type: "common", params: { text: note } }]);
    if (!posted) logger.warn({ leadId, propertyId: p.id }, "listing switch: card moved but the note was not written");
  }
  return { decision: "moved_to_live", amoLeadId: leadId, stageBefore: stage, detail: `card #${leadId} ${path}; ${record}` };
}

let running = false;

/** One pass over the undecided switches. `dry` decides and reports without touching amoCRM or the site. */
export async function runListingStatusPass(opts: { dry?: boolean } = {}): Promise<PassDecision[]> {
  if (running) return [];
  running = true;
  const dry = opts.dry === true;
  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
    const rows = await siteGet<LogRow[]>(
      `listing_status_log?select=*&changed_at=gte.${enc(since)}&order=id.asc&limit=1000`,
    );
    const changes = rows.filter((r) => r.op === "UPDATE");
    if (changes.length === 0) return [];
    const decided = await siteGet<{ log_id: number }[]>(
      `listing_status_actions?select=log_id&log_id=in.(${changes.map((r) => r.id).join(",")})`,
    );
    const done = new Set(decided.map((d) => d.log_id));

    let ctx: Promise<ResolverContext> | null = null;
    const context = () => (ctx ??= buildResolverContext());
    const out: PassDecision[] = [];
    for (const row of changes.filter((r) => !done.has(r.id))) {
      try {
        const d: PassDecision = { logId: row.id, propertyId: row.property_id, ...(await decide(row, rows, context, dry)) };
        out.push(d);
        logger.info(
          { logId: d.logId, propertyId: d.propertyId, decision: d.decision, leadId: d.amoLeadId, stageBefore: d.stageBefore, dry },
          `listing switch: ${d.propertyId} ${d.decision} — ${d.detail}`,
        );
        if (dry) continue;
        await siteInsert("listing_status_actions", [
          {
            log_id: d.logId,
            property_id: d.propertyId,
            decision: d.decision,
            amo_lead_id: d.amoLeadId,
            stage_before: d.stageBefore,
            detail: d.detail.slice(0, 1000),
          },
        ]);
        if (d.notify) await notifyBroker(LISTING_AGENT_BROKER, d.notify.title, d.notify.body, "/m").catch(() => 0);
      } catch (err) {
        // Nothing recorded: the next pass tries this switch again.
        ctx = null;
        logger.warn({ err, logId: row.id, propertyId: row.property_id }, "listing switch: decision failed, retried next pass");
      }
    }
    return out;
  } finally {
    running = false;
  }
}

export function startListingStatusPass(): void {
  if (!process.env["SUPABASE_URL"] || !process.env["SUPABASE_SERVICE_ROLE_KEY"]) {
    logger.warn("listing switch pass not started: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
    return;
  }
  const tick = () =>
    void runListingStatusPass().catch((err) => logger.error({ err }, "listing switch pass failed"));
  setTimeout(tick, 60_000);
  setInterval(tick, PASS_EVERY_MS);
}
