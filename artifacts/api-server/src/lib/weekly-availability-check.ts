/**
 * The weekly availability check with the owners of villas we carry — AUTOMATIC (owner, 14.09.2026).
 *
 * Owner's words: "Когда листинг попал в лайв, то 1 раз в неделю мы по регламенту уточняем про
 * availability. Сейчас это делает Юди через аппрувы, но это долго, иногда он забывает, нужно
 * автоматически. Важно, чтобы он не заёбывал этими сообщениями: одно короткое сообщение 1 раз в
 * неделю достаточно. ТОЛЬКО для листингов, которые прошли до этапа live в CRM, не раньше."
 *
 * Until 14.09 this pass wrote a push DRAFT for Yudi to approve; six sat unapproved from 27.08, and the
 * two he did send on 07.09 both got an owner answer within an hour. Now it sends by itself:
 *
 * WHO (all of them, fail closed):
 * - a Rental Listings card whose amoCRM stage is live / Weekly Check Sent / Update Availability
 *   Received, or that amoCRM's own event log shows went through live and that is not closed, parked
 *   (long term, co-broke) or back in Initial Contact / TAKEN TO WORK now;
 * - linked to exactly one PUBLISHED rent listing on the site (`listing_crm_link`, not a draft);
 * - an existing conversation with the owner (they have written to us at least once). A weekly check
 *   is never a first contact, so it neither spends nor waits for the 9-a-day new-contact budget.
 *
 * WHEN (one message a week, never a nag):
 * - nothing of ours (Copilot or the phone) reached the owner in the last 7 days;
 * - the owner has not written in the last 3 days (a live conversation — the reply path has it);
 * - no reply to the owner is waiting in the inbox;
 * - the last two checks were not both left unanswered (then it stops and tells Yudi once);
 * - Bali 10:00–17:00, one send per pass and at least 12 minutes between two checks.
 *
 * WHAT: one fixed sentence, no model, in English or in Bahasa Indonesia when the owner writes in
 * Indonesian, with the villa's own name. Sent through lib/outbound-send.ts (the one send path: the
 * conversation's own line, the channel guards) and recorded in sent_messages as kind
 * "weekly-availability". A Salesbot 200 is not delivery: the card moves to Weekly Check Sent only
 * once the type-90 outgoing event is in the lead's timeline.
 *
 * THE ANSWER: when the owner replies to the newest check, the card moves to Update Availability
 * Received and one focused extraction reads the reply (free now / free from a day / occupied until a
 * day / no longer for rent / unclear). A clear, dated answer is written to the listing's
 * property_availability in the admin's own format (status available, start = first free day, end
 * 2099-12-31) and read back; anything else — a month without a day, a range the site cannot hold,
 * "sold", a question back — goes to Yudi as a push with the owner's words. Nothing here unpublishes.
 *
 * Switch: broker_settings `weekly_availability_mode` = on | dry | off (missing = dry: the scheduler
 * does nothing). Plan without sending: POST /api/admin/weekly-availability?dry=1.
 */
import { db, leadsSyncTable, leadMessagesTable, sentMessagesTable, brokerSettingsTable, pendingSuggestionsTable } from "@workspace/db";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { logger } from "./logger";
import { amoFetch, amoPost, updateLeadStatus, whatsappTalkLines } from "./amo-client";
import { brokerLines } from "./amo-messenger-field";
import { invalidatePropertyCache } from "./property-catalog";
import { resolveSendChannel, deliverText } from "./outbound-send";
import { isFirstOutbound } from "./new-contact-budget";
import { fetchTimeline, getAmoAuth, refreshLeadMessages } from "./amo-timeline-sync";
import { isUndeliverableNotice } from "./undeliverable";
import { notifyBroker } from "./push-notifications";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";
import { LISTING_AGENT_BROKER, LISTING_STAGE, LISTING_STAGE_NAME, LISTINGS_PIPELINE_ID, siteGet, siteInsert } from "./listing-status-week";

export const WEEKLY_CHECK_KIND = "weekly-availability";
const MODE_KEY = "weekly_availability_mode";
const CHECK_EVERY_DAYS = 7;
const OWNER_ACTIVE_DAYS = 3;
const OPEN_HOUR = 10;
const CLOSE_HOUR = 17;
const MIN_GAP_MS = 12 * 60_000;
const MAX_UNANSWERED_IN_A_ROW = 2;
/** The owner often sends the answer in two or three messages; read them once they are done. */
const ANSWER_QUIET_MS = 10 * 60_000;

const WEEKLY_STAGES = new Set<number>([LISTING_STAGE.LIVE, LISTING_STAGE.WEEKLY_CHECK_SENT, LISTING_STAGE.AVAILABILITY_RECEIVED]);
/** Went through live and moved on by a person: still ours to check unless one of these now. */
const NOT_AFTER_LIVE = new Set<number>([
  LISTING_STAGE.INITIAL_CONTACT,
  LISTING_STAGE.TAKEN_TO_WORK,
  LISTING_STAGE.LONG_TERM,
  LISTING_STAGE.CO_BROKE,
  LISTING_STAGE.WON,
  LISTING_STAGE.LOST,
]);

type Mode = "off" | "dry" | "on";

export async function weeklyAvailabilityMode(): Promise<Mode> {
  try {
    const [row] = await db
      .select({ value: brokerSettingsTable.value })
      .from(brokerSettingsTable)
      .where(eq(brokerSettingsTable.key, MODE_KEY))
      .limit(1);
    const v = (row?.value ?? "").trim().toLowerCase();
    return v === "on" || v === "off" ? v : "dry";
  } catch {
    return "off";
  }
}

async function getKey(key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: brokerSettingsTable.value })
    .from(brokerSettingsTable)
    .where(eq(brokerSettingsTable.key, key))
    .limit(1);
  return row?.value ?? null;
}

async function setKey(key: string, value: string): Promise<void> {
  await db
    .insert(brokerSettingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: brokerSettingsTable.key, set: { value, updatedAt: new Date() } });
}

const baliHour = (d = new Date()) => (d.getUTCHours() + 8) % 24;
const baliToday = (d = new Date()) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);

// ── Names ───────────────────────────────────────────────────────────────────

/** The owner sees this. Keep it short enough to answer from a lock screen. */
export function composeWeeklyCheck(lang: "en" | "id", ownerName: string, villa: string): string {
  const who = ownerName ? ` ${ownerName}` : "";
  const named = villa && villa !== "your villa";
  if (lang === "id") {
    return `Halo${who}, cek mingguan untuk ${named ? villa : "villanya"}: apakah masih tersedia? Kalau sudah terisi, kosong lagi mulai tanggal berapa?`;
  }
  return `Hi${who}, quick weekly check on ${named ? villa : "your villa"}: is it still available? If it's taken, when does it free up?`;
}

/**
 * The card title carries the villa, but in two shapes the scout and the site
 * import each produce:
 *   "R-YUD-002 - 2BR Umalas (owner: Bram)"
 *   "Casa Emilia - 2BR 3-storey Pererenan | 450M/yr (37.5M/mo)"
 * Take the leading name and drop the trailing spec, rather than sending the
 * owner their own price list back.
 */
export function villaFromLeadName(name: string): string {
  const head = (name ?? "").split("|")[0]!.trim();
  const beforeSpec = head.split(/\s[-—]\s/)[0]!.trim();
  const cleaned = beforeSpec
    // Internal bookkeeping the scout writes into the title. The owner must
    // never read it back: "following up on Aquamarine Villas III (BREIG) —
    // Pererenan (FB SESEH PERERENAN VILLAS)" and "[LISTED] Luxfield Villa"
    // both went out looking exactly like the database row they came from.
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Cards titled "R-YUD-002 - 2BR Umalas (owner: Bram)" reduce to our own
  // listing id. "Quick check on R-YUD-002" tells the owner they are a row in
  // someone's database; the neutral fallback reads like ordinary shorthand.
  if (/^(R-[A-Z]+-\d+|YUDR-\d+)$/i.test(cleaned)) return "your villa";
  // amoCRM titles a card with no name of its own "Сделка #23308431" / "Deal
  // #23308431". That is our CRM's row number in Russian, and it went out to an
  // owner as "following up on Сделка #23308431".
  if (/^(сделка|deal|lead)\s*#?\s*\d+$/i.test(cleaned) || /^#?\d+$/.test(cleaned)) return "your villa";
  // A spec is not a name: "2BR Umalas" would read as a listing ad quoted back.
  if (/^\d+\s*(br|bed)/i.test(cleaned)) return "your villa";
  return cleaned || "your villa";
}

/**
 * Is this "name" actually the villa wearing a person's slot?
 *
 * Scout cards are often created with the property as the contact — "Casa
 * Emilia", "Villa Azul Canggu (Google Maps)" — because that is all the advert
 * gave. Greeting that contact by "name" produces "Hi Casa, quick check on Casa
 * Emilia", which tells the owner immediately that a machine wrote it. No
 * greeting at all reads as normal shorthand; a wrong one does not.
 */
function looksLikeTheVilla(name: string, villa: string): boolean {
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const nameWords = norm(name);
  const villaWords = new Set(norm(villa));
  if (nameWords.length === 0) return false;
  if (nameWords.some((w) => villaWords.has(w))) return true;
  return /\b(villa|villas|casa|resort|residence|suites?|property|management|maps|listing|owner|manager)\b/i.test(name);
}

export async function fetchOwnerName(leadId: string, villa: string): Promise<string> {
  try {
    const lead = await amoFetch<{ _embedded?: { contacts?: Array<{ id: number }> } }>(
      `/api/v4/leads/${leadId}?with=contacts`,
    );
    const contactId = lead?._embedded?.contacts?.[0]?.id;
    if (!contactId) return "";
    const contact = await amoFetch<{ name?: string }>(`/api/v4/contacts/${contactId}`);
    const name = (contact?.name ?? "").trim();
    // Scout cards sometimes carry a placeholder or a bare phone number as the
    // contact name. "Hi 62812..." is worse than no name at all.
    if (!name || /^\+?\d[\d\s()-]*$/.test(name) || /^<|dummy|test lead|full_name/i.test(name)) return "";
    if (looksLikeTheVilla(name, villa)) return "";
    return name.split(/\s+/)[0]!;
  } catch {
    return "";
  }
}

export async function fetchLeadTitle(leadId: string): Promise<string> {
  try {
    const lead = await amoFetch<{ name?: string }>(`/api/v4/leads/${leadId}`);
    return (lead?.name ?? "").trim();
  } catch {
    return "";
  }
}

// ── Language ────────────────────────────────────────────────────────────────

const ID_WORDS =
  /\b(yang|dan|ini|itu|bisa|tidak|nggak|gak|ga|sudah|udah|belum|kak|pak|bu|bapak|ibu|terima|kasih|makasih|iya|ada|untuk|masih|kosong|sampai|bulan|tahun|mau|saya|aku|kami|nanti|besok|siap|baik|boleh|harga|sewa|tersedia|villanya|sama|dulu|lagi|tanggal|selamat|pagi|siang|sore|malam)\b/gi;
const EN_WORDS =
  /\b(the|is|and|available|thanks|thank|you|it|yes|will|we|can|please|from|until|month|per|price|free|still|would|have|not|hello|hi|ok|okay|sure|when|what|how)\b/gi;

/** Indonesian when the owner writes Indonesian; English otherwise. Deterministic. */
export function threadLanguage(ownerTexts: string[]): "en" | "id" {
  const text = ownerTexts.join(" ");
  const id = (text.match(ID_WORDS) ?? []).length;
  const en = (text.match(EN_WORDS) ?? []).length;
  return id >= 2 && id > en ? "id" : "en";
}

// ── Candidates ──────────────────────────────────────────────────────────────

type AmoLead = { id: number; name?: string; status_id: number; pipeline_id: number };

async function leadsInWeeklyStages(): Promise<AmoLead[]> {
  const statuses = [...WEEKLY_STAGES]
    .map((s, i) => `filter[statuses][${i}][pipeline_id]=${LISTINGS_PIPELINE_ID}&filter[statuses][${i}][status_id]=${s}`)
    .join("&");
  const out: AmoLead[] = [];
  for (let page = 1; page <= 10; page++) {
    const d = await amoFetch<{ _embedded?: { leads?: AmoLead[] } }>(`/api/v4/leads?${statuses}&limit=250&page=${page}`);
    if (page === 1 && !d) throw new Error("amoCRM: listing cards could not be read");
    const batch = d?._embedded?.leads ?? [];
    out.push(...batch);
    if (batch.length < 250) break;
  }
  return out;
}

let passedLiveCache: { at: number; ids: number[] } | null = null;

/** Cards amoCRM's own event log shows arriving in live, by anyone, ever. */
async function leadsThatPassedLive(): Promise<number[]> {
  if (passedLiveCache && Date.now() - passedLiveCache.at < 3600_000) return passedLiveCache.ids;
  const ids = new Set<number>();
  for (let page = 1; page <= 20; page++) {
    const d = await amoFetch<{ _embedded?: { events?: Array<{ entity_id: number }> } }>(
      `/api/v4/events?filter[type]=lead_status_changed` +
        `&filter[value_after][leads_statuses][0][pipeline_id]=${LISTINGS_PIPELINE_ID}` +
        `&filter[value_after][leads_statuses][0][status_id]=${LISTING_STAGE.LIVE}&limit=100&page=${page}`,
    );
    const batch = d?._embedded?.events ?? [];
    for (const e of batch) ids.add(e.entity_id);
    if (batch.length < 100) break;
  }
  passedLiveCache = { at: Date.now(), ids: [...ids] };
  return passedLiveCache.ids;
}

async function leadsByIds(ids: number[]): Promise<AmoLead[]> {
  const out: AmoLead[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const q = ids.slice(i, i + 50).map((id) => `filter[id][]=${id}`).join("&");
    const d = await amoFetch<{ _embedded?: { leads?: AmoLead[] } }>(`/api/v4/leads?${q}&limit=250`);
    out.push(...(d?._embedded?.leads ?? []));
  }
  return out;
}

export type WeeklyPlanRow = {
  leadId: string;
  stage: string;
  title: string;
  villa: string;
  owner: string;
  listing: string | null;
  line: string | null;
  lastOwnerMessageAt: string | null;
  lastOurMessageAt: string | null;
  lang: "en" | "id" | null;
  decision: "send" | "skip";
  why: string;
  message: string | null;
};

type Candidate = WeeklyPlanRow & { responsibleUser: string | null; ownerTexts: string[]; lastContactMs: number };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function planCard(lead: AmoLead, link: { property_id: string; title: string } | null, why: string): Promise<Candidate> {
  const leadId = String(lead.id);
  const title = (lead.name ?? "").trim();
  const villa = villaFromLeadName(title);
  const base: Candidate = {
    leadId,
    stage: LISTING_STAGE_NAME[lead.status_id] ?? String(lead.status_id),
    title,
    villa,
    owner: "",
    listing: link?.property_id ?? null,
    line: null,
    lastOwnerMessageAt: null,
    lastOurMessageAt: null,
    lang: null,
    decision: "skip",
    why,
    message: null,
    responsibleUser: null,
    ownerTexts: [],
    lastContactMs: 0,
  };
  if (why) return base;

  const [sync] = await db
    .select({ responsibleUser: leadsSyncTable.responsibleUser, botExcluded: leadsSyncTable.botExcluded, pipeline: leadsSyncTable.pipeline })
    .from(leadsSyncTable)
    .where(eq(leadsSyncTable.leadId, leadId))
    .limit(1);
  if (!sync) return { ...base, why: "no Copilot row for this card" };
  base.responsibleUser = sync.responsibleUser;
  if (sync.botExcluded) return { ...base, why: "bot excluded on this card" };

  // What reached the owner from the phone is in amoCRM seconds after it leaves and in lead_messages
  // only on the next sweep — read it now, cadence is judged on it.
  await refreshLeadMessages(leadId, 60).catch(() => 0);
  const msgs = await db
    .select({ direction: leadMessagesTable.direction, text: leadMessagesTable.text, sentAt: leadMessagesTable.sentAt })
    .from(leadMessagesTable)
    .where(eq(leadMessagesTable.leadId, leadId))
    .orderBy(desc(leadMessagesTable.sentAt))
    .limit(200);
  const inbound = msgs.filter((m) => m.direction === "inbound" && (m.text ?? "").trim() && !isUndeliverableNotice(m.text));
  const outboundThread = msgs.filter((m) => m.direction !== "inbound");
  const [lastSent] = await db
    .select({ at: sentMessagesTable.createdAt })
    .from(sentMessagesTable)
    .where(and(eq(sentMessagesTable.leadId, leadId), eq(sentMessagesTable.webhookStatus, 200)))
    .orderBy(desc(sentMessagesTable.createdAt))
    .limit(1);
  const lastIn = inbound[0]?.sentAt ?? null;
  const lastOutMs = Math.max(outboundThread[0]?.sentAt?.getTime() ?? 0, lastSent?.at?.getTime() ?? 0);
  const lastOut = lastOutMs ? new Date(lastOutMs) : null;
  base.lastOwnerMessageAt = iso(lastIn);
  base.lastOurMessageAt = iso(lastOut);
  base.lastContactMs = Math.max(lastOutMs, lastIn?.getTime() ?? 0);
  base.ownerTexts = inbound.slice(0, 15).map((m) => m.text ?? "");
  base.lang = threadLanguage(base.ownerTexts);
  const talks: Array<{ sourceId: number; updatedAt: number }> = await whatsappTalkLines(leadId).catch(() => []);
  base.line = talks[0] ? String(talks[0].sourceId) : null;

  base.owner = await fetchOwnerName(leadId, villa);
  base.message = composeWeeklyCheck(base.lang, base.owner, villa);

  if (inbound.length === 0 || (await isFirstOutbound(leadId))) {
    return { ...base, why: "the owner has never written to us — a weekly check is not a first contact" };
  }
  // The question goes out on the line the owner is talking to. A thread that lives on another
  // broker's number (Bumbak Dream Villa: the owner talks to Amelia's 56811, the card is Yudi's) would
  // make resolveSendChannel reassign the card to Yudi's line and open a second chat with the owner.
  const own = brokerLines(sync.responsibleUser);
  if (talks.length === 0) return { ...base, why: "no WhatsApp conversation visible on this card in amoCRM" };
  // resolveSendChannel keeps a multi-line broker on a talk that exists on one of their own numbers;
  // with none, it would reassign the card to the broker's primary line and open a new chat.
  const ownTalk = talks.find((t) => own.includes(t.sourceId));
  if (!ownTalk) {
    return { ...base, why: `the owner's conversation is only on line ${talks[0]!.sourceId}, not ${sync.responsibleUser}'s — would open a second chat` };
  }
  base.line = String(ownTalk.sourceId);
  if (lastOut && lastOut > daysAgo(CHECK_EVERY_DAYS)) {
    return { ...base, why: `we wrote to the owner ${lastOut.toISOString().slice(0, 16)} — less than ${CHECK_EVERY_DAYS} days ago` };
  }
  if (lastIn && lastIn > daysAgo(OWNER_ACTIVE_DAYS)) {
    return { ...base, why: `the owner wrote ${lastIn.toISOString().slice(0, 16)} — conversation active, the reply path has it` };
  }
  const [attempt] = await db
    .select({ at: sentMessagesTable.createdAt })
    .from(sentMessagesTable)
    .where(and(eq(sentMessagesTable.leadId, leadId), eq(sentMessagesTable.kind, WEEKLY_CHECK_KIND), gt(sentMessagesTable.createdAt, daysAgo(1))))
    .limit(1);
  if (attempt) return { ...base, why: "a check was attempted in the last 24 hours" };
  // A reply written in the last 3 days is a conversation the broker is in; a draft left for a week
  // is not, and must not keep the villa unchecked forever (Villa Lani: a draft from 09.09).
  const [pendingReply] = await db
    .select({ id: pendingSuggestionsTable.id })
    .from(pendingSuggestionsTable)
    .where(
      and(
        eq(pendingSuggestionsTable.leadId, leadId),
        eq(pendingSuggestionsTable.status, "pending"),
        eq(pendingSuggestionsTable.kind, "live"),
        gt(pendingSuggestionsTable.createdAt, daysAgo(OWNER_ACTIVE_DAYS)),
      ),
    )
    .limit(1);
  if (pendingReply) return { ...base, why: "a reply to the owner is waiting in the inbox" };

  const checks = await db
    .select({ at: sentMessagesTable.createdAt })
    .from(sentMessagesTable)
    .where(and(eq(sentMessagesTable.leadId, leadId), eq(sentMessagesTable.kind, WEEKLY_CHECK_KIND), eq(sentMessagesTable.webhookStatus, 200)))
    .orderBy(desc(sentMessagesTable.createdAt))
    .limit(MAX_UNANSWERED_IN_A_ROW);
  if (checks.length >= MAX_UNANSWERED_IN_A_ROW && !(lastIn && lastIn > checks[checks.length - 1]!.at)) {
    return { ...base, why: `the last ${MAX_UNANSWERED_IN_A_ROW} checks went unanswered — stopped, Yudi told` };
  }
  return { ...base, decision: "send", why: base.stage === "live" || WEEKLY_STAGES.has(lead.status_id) ? `stage ${base.stage}, listing ${base.listing} published` : why };
}

/** Every Rental Listings card at or past live, judged. Read-only apart from refreshing lead_messages. */
export async function planWeeklyChecks(): Promise<Candidate[]> {
  const inStages = await leadsInWeeklyStages();
  const passed = await leadsThatPassedLive();
  const extraIds = passed.filter((id) => !inStages.some((l) => l.id === id));
  const extra = (await leadsByIds(extraIds)).filter((l) => l.pipeline_id === LISTINGS_PIPELINE_ID);
  const cards = [...inStages, ...extra];
  if (cards.length === 0) return [];

  const ids = cards.map((l) => l.id);
  const links = await siteGet<{ property_id: string; amo_lead_id: number }[]>(
    `listing_crm_link?select=property_id,amo_lead_id&amo_lead_id=in.(${ids.join(",")})`,
  );
  const propIds = [...new Set(links.map((l) => l.property_id))];
  const props = propIds.length
    ? await siteGet<{ id: string; title: string; is_draft: boolean | null; listing_type: string | null }[]>(
        `properties?select=id,title,is_draft,listing_type&id=in.(${propIds.map((p) => `"${p}"`).join(",")})`,
      )
    : [];

  const out: Candidate[] = [];
  for (const lead of cards) {
    let why = "";
    const passedOnly = !WEEKLY_STAGES.has(lead.status_id);
    const mine = links.filter((l) => l.amo_lead_id === lead.id);
    const prop = mine.length === 1 ? props.find((p) => p.id === mine[0]!.property_id) ?? null : null;
    if (passedOnly && NOT_AFTER_LIVE.has(lead.status_id)) why = `went through live, now ${LISTING_STAGE_NAME[lead.status_id] ?? lead.status_id}`;
    else if (mine.length === 0) why = "no site listing linked to this card (listing_crm_link)";
    else if (mine.length > 1) why = `two site listings linked to this card (${mine.map((m) => m.property_id).join(", ")})`;
    else if (!prop) why = `linked listing ${mine[0]!.property_id} not found on the site`;
    else if (prop.is_draft) why = `linked listing ${prop.id} is a draft, not published`;
    else if ((prop.listing_type ?? "rent") !== "rent") why = `linked listing ${prop.id} is not a rental`;
    try {
      const row = await planCard(lead, prop ? { property_id: prop.id, title: prop.title } : null, why);
      if (!why && passedOnly && row.decision === "send") row.why = `went through live, now ${row.stage}; listing ${row.listing} published`;
      out.push(row);
    } catch (err) {
      logger.warn({ err, leadId: lead.id }, "weekly-availability: could not judge this card");
    }
  }
  return out;
}

// ── Send ────────────────────────────────────────────────────────────────────

const normalise = (s: string) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

type Seen = { eventId: string; deliveryStatus: number | null } | null;

/** The type-90 outgoing event carrying this text, if amoCRM has it. */
async function outgoingEvent(leadId: string, text: string, sinceSec: number): Promise<Seen> {
  const auth = await getAmoAuth();
  if (!auth) return null;
  const events = (await fetchTimeline(auth, leadId, 20)) as unknown as Array<{
    id: string;
    type: number;
    date_create?: number;
    data?: { text?: string; message?: { text?: string }; delivery_status?: number };
  }>;
  const needle = normalise(text).slice(0, 60);
  for (const ev of events) {
    if (ev.type !== 90) continue;
    if ((ev.date_create ?? 0) < sinceSec - 60) continue;
    const t = normalise(ev.data?.text ?? ev.data?.message?.text ?? "");
    if (needle && t.includes(needle)) return { eventId: ev.id, deliveryStatus: ev.data?.delivery_status ?? null };
  }
  return null;
}

async function waitForOutgoing(leadId: string, text: string, sinceSec: number, budgetMs = 45_000): Promise<Seen> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const seen = await outgoingEvent(leadId, text, sinceSec).catch(() => null);
    if (seen) return seen;
  }
  return null;
}

/** Move a listing card only from the stages given; also mirror it into leads_sync. */
async function moveCard(leadId: string, from: number[], to: number): Promise<boolean> {
  const lead = await amoFetch<{ status_id: number; pipeline_id: number }>(`/api/v4/leads/${leadId}`);
  if (!lead || lead.pipeline_id !== LISTINGS_PIPELINE_ID || !from.includes(lead.status_id)) return false;
  if (!(await updateLeadStatus(leadId, to))) return false;
  await db
    .update(leadsSyncTable)
    .set({ leadStage: LISTING_STAGE_NAME[to] ?? null, leadStageId: String(to) })
    .where(eq(leadsSyncTable.leadId, leadId))
    .catch(() => undefined);
  return true;
}

const CONFIRMED = /timeline type-90 /;
const UNCONFIRMED = "type-90 NOT seen";

async function afterDelivered(leadId: string, text: string): Promise<boolean> {
  const moved = await moveCard(leadId, [LISTING_STAGE.LIVE, LISTING_STAGE.AVAILABILITY_RECEIVED], LISTING_STAGE.WEEKLY_CHECK_SENT);
  await amoPost(`/api/v4/leads/${leadId}/notes`, [
    { note_type: "common", params: { text: `Weekly availability check sent automatically (owner's rule, 14.09.2026):\n"${text}"` } },
  ]).catch(() => null);
  return moved;
}

async function sendCheck(c: Candidate): Promise<string> {
  const log = { warn: (obj: object, msg: string) => logger.warn(obj, msg) };
  const channel = await resolveSendChannel(c.leadId, c.responsibleUser, log);
  if (!channel.ok) {
    await db.insert(sentMessagesTable).values({
      leadId: c.leadId,
      kind: WEEKLY_CHECK_KIND,
      messageText: c.message!,
      responsibleUser: c.responsibleUser,
      webhookStatus: 409,
      webhookResponse: `not sent: ${channel.error}`,
    });
    await notifyBroker(LISTING_AGENT_BROKER, `Weekly check not sent: ${c.villa}`, `#${c.leadId}: ${channel.message}`).catch(() => 0);
    return `refused: ${channel.error}`;
  }
  const sinceSec = Math.floor(Date.now() / 1000);
  const delivery = await deliverText(c.leadId, c.message!, log);
  if (delivery.leadMissing) return "lead missing in amoCRM";
  const [row] = await db
    .insert(sentMessagesTable)
    .values({
      leadId: c.leadId,
      kind: WEEKLY_CHECK_KIND,
      messageText: delivery.deliveryText,
      responsibleUser: c.responsibleUser,
      sourceId: channel.source,
      webhookStatus: delivery.hookStatus,
      webhookResponse: delivery.hookBody,
    })
    .returning({ id: sentMessagesTable.id });
  if (!delivery.chatSent) return `Salesbot refused (${delivery.hookStatus})`;
  await db.update(leadsSyncTable).set({ lastOurMessageAt: new Date() }).where(eq(leadsSyncTable.leadId, c.leadId)).catch(() => undefined);

  const seen = await waitForOutgoing(c.leadId, delivery.deliveryText, sinceSec);
  const stamp = seen
    ? `${delivery.hookBody} | timeline type-90 ${seen.eventId} delivery_status ${seen.deliveryStatus ?? "?"}`
    : `${delivery.hookBody} | ${UNCONFIRMED} after 45s`;
  await db.update(sentMessagesTable).set({ webhookResponse: stamp }).where(eq(sentMessagesTable.id, row!.id));
  if (!seen) return "sent, delivery not yet confirmed — re-checked next pass";
  const moved = await afterDelivered(c.leadId, delivery.deliveryText);
  return `delivered (type-90 ${seen.eventId}, delivery_status ${seen.deliveryStatus ?? "?"})${moved ? ", card → Weekly Check Sent" : ""}`;
}

/** A send whose outgoing event was not in the timeline yet: look again, then tell Yudi. */
async function reconfirmRecentSends(): Promise<void> {
  const rows = await db
    .select({ id: sentMessagesTable.id, leadId: sentMessagesTable.leadId, text: sentMessagesTable.messageText, at: sentMessagesTable.createdAt, resp: sentMessagesTable.webhookResponse })
    .from(sentMessagesTable)
    .where(
      and(
        eq(sentMessagesTable.kind, WEEKLY_CHECK_KIND),
        eq(sentMessagesTable.webhookStatus, 200),
        gt(sentMessagesTable.createdAt, daysAgo(1)),
        sql`${sentMessagesTable.webhookResponse} LIKE ${"%" + UNCONFIRMED + "%"}`,
      ),
    );
  for (const r of rows) {
    const seen = await outgoingEvent(r.leadId, r.text, Math.floor(r.at.getTime() / 1000)).catch(() => null);
    if (seen) {
      await db
        .update(sentMessagesTable)
        .set({ webhookResponse: `${(r.resp ?? "").split(" | ")[0]} | timeline type-90 ${seen.eventId} delivery_status ${seen.deliveryStatus ?? "?"} (confirmed late)` })
        .where(eq(sentMessagesTable.id, r.id));
      await afterDelivered(r.leadId, r.text);
      logger.info({ leadId: r.leadId, eventId: seen.eventId }, "weekly-availability: delivery confirmed late");
    } else if (Date.now() - r.at.getTime() > 2 * 3600_000 && !(r.resp ?? "").includes("Yudi told")) {
      await db
        .update(sentMessagesTable)
        .set({ webhookResponse: `${r.resp} | still not in the timeline after 2h, Yudi told` })
        .where(eq(sentMessagesTable.id, r.id));
      await notifyBroker(
        LISTING_AGENT_BROKER,
        "Weekly check may not have arrived",
        `#${r.leadId}: the availability question is not in the WhatsApp timeline 2h after sending. Check the chat.`,
      ).catch(() => 0);
    }
  }
}

// ── Answer ──────────────────────────────────────────────────────────────────

export type AvailabilityAnswer = {
  answer: "free_now" | "free_from" | "occupied_until" | "not_for_rent" | "unclear";
  date: string | null;
  exact_day: boolean;
  quote: string;
};

const AVAILABLE_WORDS = /\b(available|free|still|yes|yep|yeah|ready|vacant|empty|masih|tersedia|kosong|bisa|ada|iya|ya|ready)\b/i;
const BUSY_WORDS = /(not available|unavailable|booked|occupied|rented|taken|sold|full|terisi|penuh|sudah (di)?sewa|tidak tersedia|gak tersedia|belum (bisa|tersedia|kosong)|no longer)/i;
const DATE_WORDS =
  /\d|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|januari|februari|maret|mei|juni|juli|agustus|september|oktober|november|desember|tomorrow|besok|lusa)\w*/i;

const MONTHS: string[][] = [
  ["jan", "januari"], ["feb", "februari"], ["mar", "maret"], ["apr", "april"], ["may", "mei"], ["jun", "juni"],
  ["jul", "juli"], ["aug", "agu", "agustus"], ["sep", "sept"], ["oct", "okt", "oktober"], ["nov"], ["dec", "des", "desember"],
];

/**
 * The owner wrote this very calendar day: "October 16", "16 Okt", "16th of October", "16/10".
 * The model marked "Available from October 16 / Open end" as not an exact day (Villa Lani, 14.09.2026).
 */
export function replyNamesDay(reply: string, isoDate: string): boolean {
  const m = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  if (!m || !day) return false;
  const names = MONTHS[m - 1]!.join("|");
  const d = `0?${day}(?:st|nd|rd|th)?`;
  const text = reply.toLowerCase();
  return (
    new RegExp(`\\b${d}\\s*(?:of\\s+)?(?:${names})[a-z]*\\b`).test(text) ||
    new RegExp(`\\b(?:${names})[a-z]*\\.?\\s*${d}\\b`).test(text) ||
    new RegExp(`\\b0?${day}\\s*[/.-]\\s*0?${m}\\b`).test(text)
  );
}

/** Fail-closed guards around the model's reading. Anything it cannot defend becomes "unclear". */
export function guardAnswer(a: AvailabilityAnswer | null, reply: string, today: string): AvailabilityAnswer & { guard?: string } {
  const unclear = (guard: string) => ({ answer: "unclear" as const, date: a?.date ?? null, exact_day: false, quote: a?.quote ?? "", guard });
  if (!a || typeof a.answer !== "string") return unclear("no reading");
  if (a.answer === "not_for_rent" || a.answer === "unclear") return a;
  if (a.answer === "free_now") {
    if (!AVAILABLE_WORDS.test(reply) || BUSY_WORDS.test(reply)) return unclear("'free now' not backed by the owner's own words");
    return a;
  }
  const d = a.date ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) return unclear("no valid date");
  if (!a.exact_day && !replyNamesDay(reply, d)) return unclear("no exact day (a month or 'soon' is not a date for the site)");
  if (!DATE_WORDS.test(reply)) return unclear("the date is not in the owner's words");
  const max = new Date(Date.parse(`${today}T00:00:00Z`) + 548 * 86400_000).toISOString().slice(0, 10);
  if (d > max) return unclear("date more than 18 months out");
  if (a.answer === "free_from" && d <= today) return { ...a, answer: "free_now", date: null };
  if (a.answer === "occupied_until" && d < today) return { ...a, answer: "free_now", date: null };
  return a;
}

async function readAnswer(villa: string, question: string, reply: string, today: string): Promise<AvailabilityAnswer | null> {
  return chatCompletionJSON<AvailabilityAnswer>({
    model: HELPER_MODEL,
    label: "listing:weekly-availability-answer",
    max_tokens: 200,
    temperature: 0,
    system: `We asked a villa owner in Bali our weekly question: is the villa still available, and if taken, when does it free up. Today is ${today}. Read ONLY the owner's reply and answer ONE question: what did the owner say about the villa's availability for rent?

answer:
- "free_now": the villa is free / still available now (no later start date given).
- "free_from": free from a later day; date = that first free day.
- "occupied_until": occupied / booked / rented until a day; date = the LAST occupied day.
- "not_for_rent": sold, withdrawn, no longer renting it out, only daily/nightly now, rented long term with no end, or they no longer handle it.
- "unclear": anything else — a question back, a partial answer, a price, "I'll check", a range with gaps, several units with different dates, or you are not sure.

date: YYYY-MM-DD or null. Resolve a day without a year to its next occurrence from today.
exact_day: true ONLY when the owner named a calendar day (or said now/today/tomorrow). A month alone ("November", "end of the month", "next month", "early October"), a week, or "soon" is false.
quote: the owner's words that carry the answer, verbatim, max 160 chars.

Reply with JSON only: {"answer": "...", "date": "YYYY-MM-DD" | null, "exact_day": true|false, "quote": "..."}`,
    messages: [{ role: "user", content: `Villa: ${villa}\nOur question: ${question}\n\nOwner's reply:\n${reply.slice(-3000)}` }],
  }).catch(() => null);
}

type AvailRow = { id: string; start_date: string | null; end_date: string | null; status: string | null; note: string | null };

function siteEnv(): { url: string; key: string } {
  const url = process.env["SUPABASE_URL"] ?? "";
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  return { url, key };
}

async function sitePatchAvailability(id: string, patch: Partial<AvailRow>): Promise<AvailRow | null> {
  const { url, key } = siteEnv();
  const res = await fetch(`${url}/rest/v1/property_availability?id=eq.${id}`, {
    method: "PATCH",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`site availability patch → ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const rows = (await res.json()) as AvailRow[];
  return rows[0] ?? null;
}

const human = (isoDay: string) =>
  new Date(`${isoDay}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Write the owner's answer the way the admin does: one `available` row from the first free day to
 * 2099-12-31. Only when the listing's rows leave no room for doubt (none, or a single available row);
 * occupied periods or several rows are Yudi's to reconcile. Read back before claiming success.
 */
async function writeAvailability(
  propertyId: string,
  freeFrom: string | null,
  note: string,
  today: string,
  apply: boolean,
): Promise<{ written: boolean; detail: string }> {
  const rows = await siteGet<AvailRow[]>(
    `property_availability?select=id,start_date,end_date,status,note&property_id=eq.${encodeURIComponent(propertyId)}`,
  );
  const busy = rows.filter((r) => (r.status === "occupied" || r.status === "rented") && (r.end_date ?? "") >= today);
  const avail = rows.filter((r) => r.status === "available");
  if (busy.length > 0 || avail.length > 1 || rows.length > avail.length + busy.length) {
    return { written: false, detail: `${propertyId} has ${rows.length} availability rows the pass will not guess over` };
  }
  const current = avail[0] ?? null;
  const currentFree = current && (current.start_date ?? "") > today ? current.start_date : null;
  if ((freeFrom ?? null) === (currentFree ?? null)) {
    return { written: false, detail: `${propertyId} already shows ${freeFrom ? `free from ${human(freeFrom)}` : "free now"} — nothing to change` };
  }
  const start = freeFrom ?? today;
  const fullNote = current?.note ? `${note} Earlier: ${current.note}`.slice(0, 1500) : note;
  if (!apply) {
    return { written: false, detail: `DRY: would set ${propertyId} ${freeFrom ? `free from ${human(freeFrom)}` : "free now"} (was ${currentFree ? `free from ${human(currentFree)}` : "free now"})` };
  }
  if (current) {
    const back = await sitePatchAvailability(current.id, { start_date: start, end_date: "2099-12-31", status: "available", note: fullNote });
    if (!back || back.start_date !== start) return { written: false, detail: `${propertyId}: the site did not return the new date — NOT saved` };
  } else {
    await siteInsert("property_availability", [{ property_id: propertyId, start_date: start, end_date: "2099-12-31", status: "available", note: fullNote }]);
    const check = await siteGet<AvailRow[]>(
      `property_availability?select=id,start_date&property_id=eq.${encodeURIComponent(propertyId)}&start_date=eq.${start}`,
    );
    if (check.length === 0) return { written: false, detail: `${propertyId}: the new row is not in the site database — NOT saved` };
  }
  invalidatePropertyCache();
  return {
    written: true,
    detail: `${propertyId} set ${freeFrom ? `free from ${human(freeFrom)}` : "free now"} (was ${currentFree ? `free from ${human(currentFree)}` : "free now"})`,
  };
}

export type AnswerOutcome = { leadId: string; checkId: string; reply: string; reading: AvailabilityAnswer & { guard?: string }; result: string };

/** Owners who answered the newest check: stage, extraction, site write or Yudi. */
export async function processAnswers(opts: { apply: boolean }): Promise<AnswerOutcome[]> {
  const checks = await db.execute(sql`
    SELECT DISTINCT ON (lead_id) id, lead_id, message_text, created_at
      FROM sent_messages
     WHERE kind = ${WEEKLY_CHECK_KIND} AND webhook_status = 200 AND created_at > now() - interval '10 days'
     ORDER BY lead_id, created_at DESC
  `);
  const rows = ((checks as unknown as { rows?: Array<{ id: string; lead_id: string; message_text: string; created_at: string }> }).rows ?? []);
  const out: AnswerOutcome[] = [];
  const today = baliToday();
  for (const c of rows) {
    const doneKey = `weekly_check:answer:${c.id}`;
    try {
      if (await getKey(doneKey)) continue;
      const since = new Date(c.created_at);
      const replies = await db
        .select({ text: leadMessagesTable.text, sentAt: leadMessagesTable.sentAt })
        .from(leadMessagesTable)
        .where(and(eq(leadMessagesTable.leadId, c.lead_id), eq(leadMessagesTable.direction, "inbound"), gt(leadMessagesTable.sentAt, since)))
        .orderBy(leadMessagesTable.sentAt);
      const real = replies.filter((m) => (m.text ?? "").trim() && !isUndeliverableNotice(m.text));
      if (real.length === 0) continue;
      if (Date.now() - real[real.length - 1]!.sentAt.getTime() < ANSWER_QUIET_MS) continue;

      const question = c.message_text;
      // A WhatsApp reply quotes our question (">> <question> <answer>"): keep only the answer.
      const reply = real
        .map((m) => (m.text ?? "").replace(/^>>\s*/, "").replace(question, "").trim())
        .filter(Boolean)
        .join("\n");
      const title = await fetchLeadTitle(c.lead_id);
      const villa = villaFromLeadName(title);
      const reading = guardAnswer(await readAnswer(villa, question, reply, today), reply, today);

      let result = "";
      const links = await siteGet<{ property_id: string }[]>(`listing_crm_link?select=property_id&amo_lead_id=eq.${c.lead_id}`);
      const propertyId = links.length === 1 ? links[0]!.property_id : null;
      const stamp = `Owner WhatsApp ${human(today)} (amoCRM lead ${c.lead_id}, weekly check): "${(reading.quote || reply).slice(0, 300)}".`;
      let tellYudi: string | null = null;

      if (reading.answer === "free_now" || reading.answer === "free_from" || reading.answer === "occupied_until") {
        if (!propertyId) {
          tellYudi = "no single site listing linked to the card — availability not written";
        } else {
          let freeFrom: string | null = null;
          if (reading.answer === "free_from") freeFrom = reading.date;
          if (reading.answer === "occupied_until") {
            const d = new Date(`${reading.date}T00:00:00Z`);
            d.setUTCDate(d.getUTCDate() + 1);
            freeFrom = d.toISOString().slice(0, 10);
          }
          const w = await writeAvailability(propertyId, freeFrom, stamp, today, opts.apply);
          result = w.detail;
          if (!w.written && !/nothing to change|^DRY/.test(w.detail)) tellYudi = w.detail;
        }
      } else if (reading.answer === "not_for_rent") {
        tellYudi = "the owner says it is no longer for rent — the listing was NOT unpublished, decide";
      } else {
        tellYudi = `unclear answer (${reading.guard ?? "the reading was not sure"}) — availability not written`;
      }
      if (tellYudi) result = result ? `${result}; ${tellYudi}` : tellYudi;

      if (opts.apply) {
        const moved = await moveCard(c.lead_id, [LISTING_STAGE.WEEKLY_CHECK_SENT], LISTING_STAGE.AVAILABILITY_RECEIVED);
        await amoPost(`/api/v4/leads/${c.lead_id}/notes`, [
          { note_type: "common", params: { text: `Weekly availability check — the owner answered:\n"${reply.slice(0, 500)}"\nRead as: ${reading.answer}${reading.date ? ` ${reading.date}` : ""}.\n${result}` } },
        ]).catch(() => null);
        if (tellYudi) {
          await notifyBroker(LISTING_AGENT_BROKER, `Availability: ${villa}`, `#${c.lead_id} owner: "${reply.slice(0, 80)}" — ${tellYudi}`).catch(() => 0);
        } else {
          // The answer is on the site: the reply draft the owner's message raised is not Yudi's to approve
          // (owner, 14.09.2026: the weekly check runs on autopilot). Unclear answers keep theirs.
          const cleared = await db
            .update(pendingSuggestionsTable)
            .set({ status: "skipped" })
            .where(and(eq(pendingSuggestionsTable.leadId, c.lead_id), eq(pendingSuggestionsTable.status, "pending"), gt(pendingSuggestionsTable.createdAt, since)))
            .returning({ id: pendingSuggestionsTable.id });
          if (cleared.length) result = `${result}; ${cleared.length} reply draft(s) cleared from the inbox`;
        }
        await setKey(doneKey, JSON.stringify({ at: new Date().toISOString(), answer: reading.answer, date: reading.date, result, moved }));
      }
      out.push({ leadId: c.lead_id, checkId: c.id, reply, reading, result });
      logger.info({ leadId: c.lead_id, answer: reading.answer, date: reading.date, result, apply: opts.apply }, "weekly-availability: owner answer handled");
    } catch (err) {
      logger.warn({ err, leadId: c.lead_id }, "weekly-availability: answer handling failed, retried next pass");
    }
  }
  return out;
}

// ── Pass ────────────────────────────────────────────────────────────────────

let running = false;

/**
 * Scheduled every 5 minutes from followup-scheduler.ts. Returns how many checks went out.
 * Does nothing unless broker_settings.weekly_availability_mode = on.
 */
export async function processWeeklyAvailabilityCheck(): Promise<number> {
  if (running) return 0;
  if ((await weeklyAvailabilityMode()) !== "on") return 0;
  running = true;
  try {
    await reconfirmRecentSends().catch((err) => logger.warn({ err }, "weekly-availability: reconfirm failed"));
    await processAnswers({ apply: true }).catch((err) => logger.warn({ err }, "weekly-availability: answers failed"));

    const hour = baliHour();
    if (hour < OPEN_HOUR || hour >= CLOSE_HOUR) return 0;
    const [last] = await db
      .select({ at: sentMessagesTable.createdAt })
      .from(sentMessagesTable)
      .where(eq(sentMessagesTable.kind, WEEKLY_CHECK_KIND))
      .orderBy(desc(sentMessagesTable.createdAt))
      .limit(1);
    if (last && Date.now() - last.at.getTime() < MIN_GAP_MS) return 0;

    const plan = await planWeeklyChecks();
    for (const row of plan.filter((r) => r.why.startsWith(`the last ${MAX_UNANSWERED_IN_A_ROW} checks`))) {
      const key = `weekly_check:paused:${row.leadId}`;
      if (await getKey(key)) continue;
      await setKey(key, new Date().toISOString());
      await notifyBroker(LISTING_AGENT_BROKER, `No answer on availability: ${row.villa}`, `#${row.leadId}: two weekly checks unanswered — the bot stopped asking. Call or decide.`).catch(() => 0);
    }
    const next = plan.filter((r) => r.decision === "send").sort((a, b) => a.lastContactMs - b.lastContactMs)[0];
    if (!next) return 0;
    const result = await sendCheck(next);
    logger.info({ leadId: next.leadId, villa: next.villa, lang: next.lang, result }, "weekly-availability: check sent automatically");
    return 1;
  } catch (err) {
    logger.error({ err }, "weekly-availability pass failed");
    return 0;
  } finally {
    running = false;
  }
}
