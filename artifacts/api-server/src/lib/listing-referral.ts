/**
 * The villa side sends us to someone else: open that conversation.
 *
 * Owner, 12.09.2026: "так переделывай номер в карточке и пиши владельцу, в чём
 * проблема? бот может?" Fourteen open listing cards ended the same way: the
 * person on the villa's number (reception, a manager, a wife) answered "prices
 * are with the owner, here is his number", the bot replied "I'll reach out to
 * him directly", and nobody ever did, because nothing here could start a
 * conversation with a number that was not on a card.
 *
 * The number is NOT swapped on the existing card. The WhatsApp chat belongs to
 * the number it was opened with: a Salesbot send on that card goes on into the
 * staff member's chat, and a contact with two numbers can fan one send out to
 * both (see countActiveWhatsappChats). So the referred person gets their own
 * card in Rental Listings, Initial Contact, with two notes the seeding pass
 * already reads (the villa as PROPERTY, and an ACTION BRIEF saying who passed
 * the number on), and the ordinary path does the rest: seeding, the opener,
 * the nine-a-day budget (referrals go first in the drain), nudges, the stage
 * engine. The source card gets a note and leaves the bot's hands, so the staff
 * member is not chased for a price they already said they do not have.
 *
 * Who we open: the owner, the owner's family, a partner, the villa's own
 * manager. A reception desk, a sales or booking team, an agency: no card, the
 * outcome is only reported.
 * Guards, all in code: the phone must appear in the villa side's own messages
 * (a model-invented number is never dialled), must differ from the card's own
 * number, and must not already sit on a Rental Listings card (then the cards
 * are linked by notes instead of duplicated). One hand-off per source card.
 */
import { db, leadsSyncTable, leadMessagesTable, brokerSettingsTable } from "@workspace/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { amoFetch, amoPost } from "./amo-client";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";
import { leadContact } from "./phone-dedupe";
import { stripQuotedText } from "./listing-card-fields";

const LISTINGS_PIPELINE_ID = 11180334;
const STATUS_INITIAL_CONTACT = 87738346;
const STATUS_TAKEN_TO_WORK = 87795530;
const STATUS_LONG_TERM = 88322310;
/** The stages the bot works; anything else is a person's card. Read live from amoCRM. */
const BOT_STATUS_IDS = new Set([STATUS_INITIAL_CONTACT, STATUS_TAKEN_TO_WORK, STATUS_LONG_TERM]);
const YUDI_USER_ID = 13301186;
const MIN_PHONE_DIGITS = 9;
const OPEN_ROLES = new Set<Role>(["owner", "family", "partner", "manager"]);

/** Written into the ACTION BRIEF; the reply prompt and the drain recognise a referral by it. */
export const REFERRAL_MARK = "REFERRED BY";

type Role = "owner" | "family" | "partner" | "manager" | "staff" | "sales" | "agency" | "other";
const ROLES: Role[] = ["owner", "family", "partner", "manager", "staff", "sales", "agency", "other"];

export type ReferralOutcome = {
  sourceLeadId: string;
  action: "none" | "skipped" | "would_create" | "created" | "would_link" | "linked";
  reason: string;
  newLeadId?: string;
  name?: string | null;
  phone?: string;
  role?: Role;
  referrer?: string | null;
  evidence?: string | null;
};

const HAND_OFF_WORDS = /(contact|hubungi|call|owner|pemilik|partner|husband|wife|suami|istri|directly|langsung|manager)/i;

/** A cheap gate before any model call: a shared contact card, or a phone number next to a hand-off word. */
export function mayHoldReferral(text: string | null | undefined): boolean {
  const raw = text ?? "";
  if (/_Отправлен контакт_|TEL:\s*\+?\d/i.test(raw)) return true;
  const own = stripQuotedText(raw);
  return /\+?\d[\d\s().-]{7,}\d/.test(own) && HAND_OFF_WORDS.test(own);
}

/** Digits in international form: a local Indonesian "0812..." or "812..." becomes "62812...". */
export function toIntlDigits(raw: string): string {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0") && d.length >= 10) d = `62${d.slice(1)}`;
  else if (d.startsWith("8") && d.length >= 9 && d.length <= 12) d = `62${d}`;
  return d;
}

/** The scout's card name: "Villa - Area - 2BR - note". */
export function nameParts(name: string): { villa: string; area: string; bedrooms: string } {
  const parts = (name ?? "").split(" - ").map((p) => p.trim()).filter(Boolean);
  return {
    villa: parts[0] ?? "",
    area: parts.find((p, i) => i > 0 && !/\d\s*BR\b/i.test(p) && !/target|OTA|referral|\/mo|\bjt\b|\d+M\b/i.test(p)) ?? "",
    bedrooms: (parts.find((p) => /^\d+\s*BR$/i.test(p)) ?? "").replace(/\s+/g, ""),
  };
}

const settingKey = (leadId: string) => `listing_referral:${leadId}`;

async function readThread(leadId: string): Promise<{ text: string; ownerText: string; brokerFollowedUp: boolean }> {
  const rows = await db
    .select({ who: leadMessagesTable.senderType, at: leadMessagesTable.sentAt, text: leadMessagesTable.text })
    .from(leadMessagesTable)
    .where(and(eq(leadMessagesTable.leadId, leadId), sql`${leadMessagesTable.text} IS NOT NULL`))
    .orderBy(asc(leadMessagesTable.sentAt));
  const owner: string[] = [];
  let handoffAt: number | null = null;
  let brokerFollowedUp = false;
  for (const r of rows) {
    const body = r.text ?? "";
    if (r.who === "lead") {
      owner.push(body);
      if (handoffAt === null && mayHoldReferral(body)) handoffAt = r.at.getTime();
    } else if (r.who === "broker" && handoffAt !== null && r.at.getTime() > handoffAt) {
      // A person, not the bot, wrote after the villa side handed us a number.
      brokerFollowedUp = true;
    }
  }
  const lines: string[] = [];
  for (const r of rows.slice(-40)) {
    const day = r.at.toISOString().slice(0, 10);
    const body = r.text ?? "";
    lines.push(r.who === "lead" ? `${day} villa: ${stripQuotedText(body).replace(/\s*\n\s*/g, " | ")}` : `${day} us: ${body.replace(/\s*\n\s*/g, " ")}`);
  }
  return { text: lines.join("\n").slice(-9000), ownerText: owner.join("\n"), brokerFollowedUp };
}

const DETECT_SYSTEM = `You read a WhatsApp thread between our listing agent (lines "us:") and the side of a villa we asked about (lines "villa:"). A shared contact card shows up as "_Отправлен контакт_ | <name> | TEL: <number>".

Decide ONE thing: did the villa side tell us to talk to ANOTHER person about renting or listing THIS villa, and give that person's phone number (in the text or as a shared contact card)?

Return JSON only:
{"referred": true|false, "name": string|null, "phone": string|null, "role": "owner"|"family"|"partner"|"manager"|"staff"|"sales"|"agency"|"other", "referrer": string|null, "evidence": string|null}

- role is about the person we are sent TO: "owner" (they say this is the owner), "family" (the owner's husband, wife, son and so on), "partner" (business partner or co-owner), "manager" (the villa's own manager or GM), "staff" (reception, housekeeping, someone for viewings), "sales" (a sales, reservations or booking team), "agency" (a management company, an agent, any third party), "other".
- referrer: the first name of the person on the villa side who sent us there, when the thread shows it.
- evidence: quote the villa side's words that send us to that person, at most 200 characters.
- Not a referral: the villa side giving their OWN new number, a guest booking hotline, or a contact card with nothing saying we should discuss the villa with that person.
- Several people referred: return the most recent one.`;

type Detection = { referred: boolean; name: string | null; phone: string | null; role: Role; referrer: string | null; evidence: string | null };

async function detect(threadText: string): Promise<Detection | null> {
  const out = await chatCompletionJSON<Record<string, unknown>>({
    model: HELPER_MODEL,
    label: "listing:referral",
    max_tokens: 300,
    temperature: 0,
    system: DETECT_SYSTEM,
    messages: [{ role: "user", content: threadText }],
  }).catch(() => null);
  if (!out || typeof out["referred"] !== "boolean") return null;
  const str = (v: unknown): string | null => {
    const s = typeof v === "string" ? v.trim() : "";
    return s && s.toLowerCase() !== "null" ? s : null;
  };
  const role = ROLES.includes(String(out["role"]) as Role) ? (String(out["role"]) as Role) : "other";
  return { referred: out["referred"] === true, name: str(out["name"]), phone: str(out["phone"]), role, referrer: str(out["referrer"]), evidence: str(out["evidence"]) };
}

/** Rental Listings cards amoCRM already holds for this number. */
async function listingLeadsForPhone(digits: string): Promise<string[]> {
  const found = await amoFetch<{ _embedded?: { contacts?: Array<{ _embedded?: { leads?: Array<{ id: number }> } }> } }>(
    `/api/v4/contacts?query=${encodeURIComponent(digits.slice(-10))}&with=leads&limit=10`,
  );
  const ids = [...new Set((found?._embedded?.contacts ?? []).flatMap((c) => c._embedded?.leads ?? []).map((l) => String(l.id)))];
  const out: string[] = [];
  for (const id of ids) {
    const lead = await amoFetch<{ pipeline_id?: number }>(`/api/v4/leads/${id}`);
    if (lead?.pipeline_id === LISTINGS_PIPELINE_ID) out.push(id);
  }
  return out;
}

async function remember(sourceLeadId: string, value: string): Promise<void> {
  await db
    .insert(brokerSettingsTable)
    .values({ key: settingKey(sourceLeadId), value })
    .onConflictDoUpdate({ target: brokerSettingsTable.key, set: { value } });
  await db.update(leadsSyncTable).set({ botExcluded: true, nextFollowupAt: null }).where(eq(leadsSyncTable.leadId, sourceLeadId));
}

/**
 * Look at one card's thread and, when the villa side handed us someone else's
 * number, open (or link) that person's card. Dry unless `apply`.
 */
export async function handleReferral(sourceLeadId: string, opts: { apply: boolean; source: "reply" | "audit" }): Promise<ReferralOutcome> {
  const base: ReferralOutcome = { sourceLeadId, action: "none", reason: "" };
  try {
    const [done] = await db
      .select({ value: brokerSettingsTable.value })
      .from(brokerSettingsTable)
      .where(eq(brokerSettingsTable.key, settingKey(sourceLeadId)))
      .limit(1);
    if (done) return { ...base, action: "skipped", reason: `already handled: ${done.value}` };

    const [row] = await db
      .select({ pipeline: leadsSyncTable.pipeline, stage: leadsSyncTable.leadStage, botExcluded: leadsSyncTable.botExcluded, facts: leadsSyncTable.listingFacts })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, sourceLeadId))
      .limit(1);
    if (!row || (row.pipeline ?? "").trim().toLowerCase() !== "rental listings") return { ...base, reason: "not a Rental Listings card" };
    if (row.botExcluded) return { ...base, reason: "bot excluded" };
    if (!/^(initial contact|taken to work|long term)$/i.test((row.stage ?? "").trim())) {
      return { ...base, reason: `stage ${row.stage}: the broker's card` };
    }

    // The live stage, not our copy of it: a card a person has taken further is theirs.
    const src = await amoFetch<{ name?: string; responsible_user_id?: number; status_id?: number; pipeline_id?: number }>(
      `/api/v4/leads/${sourceLeadId}`,
    );
    if (!src || src.pipeline_id !== LISTINGS_PIPELINE_ID || !BOT_STATUS_IDS.has(Number(src.status_id))) {
      return { ...base, reason: "amoCRM does not show this card on a bot stage" };
    }

    const { text, ownerText, brokerFollowedUp } = await readThread(sourceLeadId);
    if (!mayHoldReferral(ownerText)) return { ...base, reason: "no hand-off in the thread" };

    const d = await detect(text);
    if (!d) return { ...base, action: "skipped", reason: "detection failed, not judged" };
    if (!d.referred || !d.phone) return { ...base, reason: "the villa side did not send us to another person", evidence: d.evidence };

    const phone = toIntlDigits(d.phone);
    const found = { name: d.name, phone, role: d.role, referrer: d.referrer, evidence: d.evidence };
    if (phone.length < MIN_PHONE_DIGITS) return { ...base, ...found, action: "skipped", reason: "phone too short" };
    if (!toIntlDigits(ownerText).includes(phone.slice(-9)) && !ownerText.replace(/\D/g, "").includes(phone.slice(-9))) {
      return { ...base, ...found, action: "skipped", reason: "that number is not in the villa side's messages" };
    }
    if (!OPEN_ROLES.has(d.role)) return { ...base, ...found, action: "skipped", reason: `role ${d.role}: not someone a listing is agreed with` };

    const own = await leadContact(sourceLeadId);
    if (own.phone && own.phone.replace(/\D/g, "").slice(-9) === phone.slice(-9)) {
      return { ...base, ...found, action: "skipped", reason: "same number as the card" };
    }

    const parts = nameParts(src?.name ?? "");
    const villa = parts.villa || "the villa";
    const referrer = d.referrer || "the villa's contact";
    const quote = (d.evidence ?? "").replace(/\s+/g, " ").slice(0, 200);

    const existing = await listingLeadsForPhone(phone);
    if (existing.length > 0) {
      if (!opts.apply) return { ...base, ...found, action: "would_link", newLeadId: existing[0], reason: "this number is already on a Rental Listings card" };
      const other = existing[0]!;
      await amoPost(`/api/v4/leads/${sourceLeadId}/notes`, [
        { note_type: "common", params: { text: `Note: REFERRAL. ${referrer} sent us to ${d.name ?? "another contact"} (${d.role}), +${phone}: "${quote}". That number is already on card #${other}; the conversation continues there and the bot stopped chasing this number.` } },
      ]);
      await amoPost(`/api/v4/leads/${other}/notes`, [
        { note_type: "common", params: { text: `Note: card #${sourceLeadId} (${villa}) was referred to this contact by ${referrer}: "${quote}".` } },
      ]);
      await remember(sourceLeadId, `linked:${other}`);
      logger.info({ sourceLeadId, other, phone, role: d.role }, "listing referral: number already on a card, linked");
      return { ...base, ...found, action: "linked", newLeadId: other, reason: "linked to the existing card" };
    }

    // A person already acted on the hand-off (Villa Soluna: Yudi wrote to the
    // manager himself on 20.08 and the listing went online). Linking above is
    // harmless; opening a second conversation with that person is not.
    if (brokerFollowedUp) return { ...base, ...found, action: "skipped", reason: "the broker already followed up after the hand-off" };

    if (!opts.apply) return { ...base, ...found, action: "would_create", reason: `new card for ${d.name ?? "the referred contact"} (${d.role})` };

    const facts = (row.facts ?? {}) as Record<string, unknown>;
    const bedrooms = facts["bedrooms"] ? String(facts["bedrooms"]) : parts.bedrooms.replace(/BR$/i, "");
    const known = [parts.area && `the area (${parts.area})`, bedrooms && `the bedroom count (${bedrooms})`].filter(Boolean).join(" and ");
    const person = d.name ?? "";
    const responsible = src?.responsible_user_id ?? YUDI_USER_ID;

    const payload = [
      {
        name: [villa, parts.area, bedrooms ? `${bedrooms}BR` : "", "referral"].filter(Boolean).join(" - "),
        pipeline_id: LISTINGS_PIPELINE_ID,
        status_id: STATUS_INITIAL_CONTACT,
        responsible_user_id: responsible,
        _embedded: {
          tags: [{ name: "Yudi" }, { name: "SRC:AI" }, { name: "Referral" }],
          contacts: [
            {
              name: person || `${villa} (${d.role})`,
              responsible_user_id: responsible,
              custom_fields_values: [{ field_code: "PHONE", values: [{ value: `+${phone}`, enum_code: "WORK" }] }],
            },
          ],
        },
      },
    ];
    const created = await amoPost<Array<{ id: number }>>("/api/v4/leads/complex", payload);
    const newLeadId = created?.[0]?.id ? String(created[0].id) : null;
    if (!newLeadId) return { ...base, ...found, action: "skipped", reason: "amoCRM did not create the card" };

    const propertyNote = `PROPERTY:\n${villa}${parts.area ? `, ${parts.area}` : ""}${bedrooms ? `, ${bedrooms} bedrooms` : ""}. Long-term rental enquiry. The contact on the villa's number, ${referrer}, told us to speak to ${person || "this person"} (${d.role}) about renting it.`;
    const briefNote = [
      "ACTION BRIEF",
      `WHO TO CONTACT: ${person || "this contact"}, the ${d.role} for ${villa}. ${REFERRAL_MARK} ${referrer} on card #${sourceLeadId}: "${quote}".`,
      `FIRST MESSAGE: ${person ? `greet ${person.split(/\s+/)[0]} by name, ` : "open with a plain Hi, "}say that ${referrer} from ${villa} passed on this number, and ask in one sentence for the monthly and yearly rate including our 10% agency commission, the minimum stay they accept and the earliest day we could bring a client to view it.${known ? ` Already known, do not ask again: ${known}.` : ""}`,
    ].join("\n");
    await amoPost(`/api/v4/leads/${newLeadId}/notes`, [
      { note_type: "common", params: { text: propertyNote } },
      { note_type: "common", params: { text: briefNote } },
    ]);
    await amoPost(`/api/v4/leads/${sourceLeadId}/notes`, [
      { note_type: "common", params: { text: `Note: REFERRAL. ${referrer} sent us to ${person || "another contact"} (${d.role}), +${phone}: "${quote}". The conversation continues on card #${newLeadId}; the bot stopped chasing this number.` } },
    ]);
    await remember(sourceLeadId, newLeadId);
    logger.info({ sourceLeadId, newLeadId, phone, role: d.role, source: opts.source }, "listing referral: card opened for the referred contact");
    return { ...base, ...found, action: "created", newLeadId, reason: `card #${newLeadId} opened` };
  } catch (err) {
    logger.warn({ err, sourceLeadId }, "listing referral: failed (non-fatal)");
    return { ...base, action: "skipped", reason: "error" };
  }
}
