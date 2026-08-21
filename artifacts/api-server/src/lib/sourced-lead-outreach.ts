/**
 * Seeds the conversation for leads that arrive with their request already known.
 *
 * A separate scouting bot works Facebook groups: it finds people looking for a
 * villa, gets their WhatsApp in DM, and creates the amoCRM card with a note
 * describing exactly what they asked for. The conversation genuinely started —
 * just on another channel — but these leads fell into a gap: no LIVE (nothing
 * "incoming" to answer) and no PUSH (a new lead waits 24h for an amoCRM welcome
 * automation that never fires for cards created this way). The card sat in
 * "New LEAD" with a detailed request nobody acted on.
 *
 * Rather than bolt on a parallel outreach path, this writes the request into the
 * conversation AS the lead's first message — which is what it actually is. From
 * there every existing mechanism works untouched: LIVE detection, reply
 * generation, property matching against their stated criteria, stage
 * classification. One entry point instead of two.
 *
 * RENTAL ONLY. The Unicorn/sales pipeline already has a working welcome and
 * qualification flow; a second way in would fight it.
 */
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, and, isNull, isNotNull, or, sql } from "drizzle-orm";
import { logger } from "./logger";
import { amoFetch } from "./amo-client";
import { decodeAmoEntities } from "./amo-text";
import { describePropertiesByIds } from "./property-catalog";
import { enforceBudgetFilter } from "./budget-filter";
import { sendAdLeadWelcome } from "./ad-lead-autoreply";

type AmoNote = { note_type?: string; params?: { text?: string } };

/** Pull the lead's amoCRM notes — that's where the scout bot writes the request. */
async function fetchLeadNote(leadId: string): Promise<string | null> {
  try {
    const data = await amoFetch<{ _embedded?: { notes?: AmoNote[] } }>(
      `/api/v4/leads/${leadId}/notes?limit=25`,
    );
    const texts = (data?._embedded?.notes ?? [])
      .map((n) => (n.params?.text ?? "").trim())
      .filter((t) => t.length > 20);
    return texts.length > 0 ? texts.join("\n").slice(0, 2000) : null;
  } catch (err) {
    logger.warn({ err, leadId }, "sourced-lead: notes fetch failed");
    return null;
  }
}

/**
 * The PERSON's name, from the lead's contact. For an ad lead the lead name is the
 * listing code ("R-YUD-018 - 3BR Villa…"), so using it as the sender would have
 * the bot greeting the client as "Hi R-YUD-018".
 */
async function fetchContactName(leadId: string): Promise<string> {
  try {
    const lead = await amoFetch<{ _embedded?: { contacts?: Array<{ id: number }> } }>(
      `/api/v4/leads/${leadId}?with=contacts`,
    );
    const contactId = lead?._embedded?.contacts?.[0]?.id;
    if (!contactId) return "";
    const contact = await amoFetch<{ name?: string }>(`/api/v4/contacts/${contactId}`);
    const name = (contact?.name ?? "").trim();
    // amoCRM placeholders are worse than no name at all.
    if (!name || /^<|dummy|test lead|full_name/i.test(name)) return "";
    return name;
  } catch {
    return "";
  }
}

/** The lead's amoCRM name exactly as it is — ad leads carry the listing code in it. */
async function fetchRawLeadName(leadId: string): Promise<string> {
  try {
    const lead = await amoFetch<{ name?: string }>(`/api/v4/leads/${leadId}`);
    return (lead?.name ?? "").trim();
  } catch {
    return "";
  }
}

async function fetchLeadName(leadId: string): Promise<string> {
  try {
    const lead = await amoFetch<{ name?: string }>(`/api/v4/leads/${leadId}`);
    // Scout cards are named "FB Lead: Nathan Craig" — keep just the person.
    const raw = (lead?.name ?? "").replace(/^\s*(fb\s*lead|lead)\s*:\s*/i, "").trim();
    return raw || "Lead";
  } catch {
    return "Lead";
  }
}

/**
 * A note is only actionable if it actually describes what the client wants.
 * The scout bot writes "Request: ..."; anything shorter is CRM housekeeping.
 */
function looksLikeClientRequest(note: string): boolean {
  const t = note.toLowerCase();
  // A lead who answered a listing ad brings a link instead of a description —
  // that link IS the request, and the matcher builds the shortlist around it.
  if (/\/property\/|unicorn-property/.test(t)) return true;
  if (t.length < 40) return false;
  return /request:|looking for|ищет|запрос|villa|bedroom|budget|move-in/.test(t);
}

/**
 * CRM housekeeping — true of the CARD, not said by the CLIENT.
 *
 * A lead note is written by whoever created the card, and on a manually entered
 * ad lead that means integration bookkeeping: which Albato form fired, the
 * form_id, the campaign name, the submission time, the contact's own phone.
 * None of it is the client speaking, and all of it was landing in the seeded
 * message — so the broker opened the card and read a paragraph of Russian
 * plumbing where the client's request should be (Amelia, 2026-08-20: "Can we
 * have it fully in English please?"), and the model read the same paragraph as
 * the client's own words.
 */
const NOTE_HOUSEKEEPING =
  /^(форма|form|lead id|подан|submitted|кампания|campaign|имя|name|телефон|phone|whatsapp|важно|important|примечание|note)\s*[:\/]|заведён вручную|заведен вручную|albato|form_id|instant form|ads manager/i;

/** Where the client's actual answers start, in either language. */
const FORM_ANSWERS_MARKER = /(ответы\s+формы|form\s+answers)\s*:?/i;

/**
 * The client's OWN words from an ad lead's card — nothing else.
 *
 * On an ad lead the note belongs to us, not to the client: it is written by
 * whoever created or synced the card and holds Albato bookkeeping, campaign
 * names, and free-form Russian commentary between colleagues ("Повторный
 * контакт — ранее от…"). The one part the CLIENT authored is the answers they
 * typed into the Meta form. So this returns those answers or nothing at all —
 * a filter that tries to subtract known noise instead will always be one
 * unexpected sentence behind, and that sentence lands in the broker's card as
 * if the client had said it.
 */
export function formAnswersFromNote(note: string): string {
  const text = (note ?? "").trim();
  if (!text) return "";
  const marker = FORM_ANSWERS_MARKER.exec(text);
  if (!marker) return "";
  // The answers block can be followed by a note-to-self from whoever entered
  // the card ("ВАЖНО: Meta отдаёт ответы кодами…").
  const answers = stripHousekeeping(text.slice(marker.index + marker[0].length));
  return answers ? `Here is what I filled in on your form: ${answers}` : "";
}

function stripHousekeeping(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((line) => line.trim() && !NOTE_HOUSEKEEPING.test(line.trim()))
    .join("\n")
    .trim();
}

/**
 * A person's name from a deal name, or "" when the deal name is not one.
 *
 * Accepts "FB Lead: Wyatt Bao" → "Wyatt Bao" (the label is a prefix, the name
 * follows). Rejects anything carrying a listing code, a field separator, or a
 * digit, and anything too long to be a name — those are titles, not people.
 */
function personNameFromLeadName(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  // Strip a leading source label ("FB Lead:", "Lead:") — the name is after it.
  const afterLabel = s.replace(/^[^:|]{0,20}:\s*/, "").trim();
  if (!afterLabel) return "";
  if (/\||\d/.test(afterLabel)) return "";
  if (/\b[A-Z]{1,4}-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/.test(afterLabel)) return "";
  if (afterLabel.split(/\s+/).length > 4) return "";
  return afterLabel;
}

/**
 * Render one line in the exact shape amoCRM's `content` uses, so the existing
 * parser reads it as a normal inbound message.
 *
 * The timestamp is written +3h because parseDialogContent treats these stamps as
 * Moscow time (that's how amoCRM renders them) and subtracts the offset — so
 * this round-trips back to the real time instead of landing 3 hours early.
 */
function formatAsLeadMessage(at: Date, leadName: string, text: string): string {
  const shifted = new Date(at.getTime() + 3 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${p(shifted.getUTCDate())}.${p(shifted.getUTCMonth() + 1)}.${shifted.getUTCFullYear()} ` +
    `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}`;
  const oneLine = text.replace(/\s*\n+\s*/g, " ").trim();
  // "client", not "клиент": the parser accepts either, and everything a
  // broker can end up reading has to be English.
  return `${stamp} ${leadName} (client - Facebook) → ${oneLine}`;
}

export async function processSourcedLeadOutreach(): Promise<number> {
  const candidates = await db
    .select({
      leadId: leadsSyncTable.leadId,
      responsibleUser: leadsSyncTable.responsibleUser,
      leadStage: leadsSyncTable.leadStage,
      leadNotes: leadsSyncTable.leadNotes,
      amoCreatedAt: leadsSyncTable.amoCreatedAt,
    })
    .from(leadsSyncTable)
    .where(
      and(
        sql`lower(coalesce(${leadsSyncTable.pipeline}, '')) = 'rental'`,
        or(isNull(leadsSyncTable.content), eq(leadsSyncTable.content, "")),
        or(eq(leadsSyncTable.botExcluded, false), isNull(leadsSyncTable.botExcluded)),
        // Recent cards only. Without this the pass reached back through every
        // conversation-less lead in the CRM and touched 2024 cards parked in
        // Long-Term Cycle. A lead sourced elsewhere is acted on within days.
        isNotNull(leadsSyncTable.amoCreatedAt),
        sql`${leadsSyncTable.amoCreatedAt} > now() - interval '7 days'`,
        sql`lower(coalesce(${leadsSyncTable.leadStage}, '')) LIKE '%new lead%'`,
      ),
    );

  if (candidates.length === 0) return 0;

  let seeded = 0;
  for (const lead of candidates) {
    try {
      // Albato creates the card under its OWN amoCRM user (Admin), and amoCRM's
      // automation moves it to the real broker a few minutes later — 2 minutes
      // on one lead today, 10 minutes and 15 seconds on the next. Our seeding
      // runs within 60 seconds, so it regularly sees a lead that belongs to
      // nobody yet. That is not cosmetic: the automatic welcome is sent on the
      // RESPONSIBLE USER's own WhatsApp line and signed with their name, so on
      // lead 23293265 it was refused outright (channel_unresolved) and the
      // client got nothing — and seeding only ever runs once per lead, so there
      // was no second chance.
      //
      // So: leave the lead alone and let the next minute's pass pick it up.
      // After 20 minutes seed it anyway — a lead nobody was assigned is still
      // better worked by a broker than dropped, it just does not get the
      // automatic first touch.
      const ownerUnassigned = !lead.responsibleUser || /^admin$/i.test(lead.responsibleUser.trim());
      const ageMs = Date.now() - (lead.amoCreatedAt?.getTime() ?? Date.now());
      if (ownerUnassigned && ageMs < 20 * 60 * 1000) {
        logger.info(
          { leadId: lead.leadId, ageSec: Math.round(ageMs / 1000) },
          "sourced-lead: still on Admin, waiting for amoCRM to assign the broker before seeding",
        );
        continue;
      }

      // Someone already worked this lead — don't rewrite history under them.
      // Only a live card (pending) or a real send (approved/edited) counts.
      // Matching ANY row also caught `skipped` ones, which is how leads that had
      // a suggestion cancelled — including by an earlier version of this very
      // pass — became permanently unseedable.
      const [everQueued] = await db
        .select({ id: pendingSuggestionsTable.id })
        .from(pendingSuggestionsTable)
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, lead.leadId),
            sql`${pendingSuggestionsTable.status} IN ('pending','approved','edited')`,
          ),
        )
        .limit(1);
      if (everQueued) continue;

      // Decoded before anything reads it: the note is both what the broker sees
      // on the card and what the model reads as the client's own request, and
      // amoCRM hands it over HTML-escaped (`FB group &quot;…&quot;`).
      let note = decodeAmoEntities(lead.leadNotes?.trim() || "");
      if (!note) note = decodeAmoEntities((await fetchLeadNote(lead.leadId)) ?? "");

      // Meta Ads leads (via Albato) arrive with the LISTING CODE in the lead's
      // NAME — "R-YUD-018 - 3BR Villa for Long-Term Rental in Umalas" — and
      // nothing else: no conversation, no note. So the bot saw nothing to answer
      // and the +24h push delay meant silence for a day on a paid lead. The code
      // in the name IS the enquiry: seed it as the listing they asked about, and
      // the existing anchor logic offers that villa plus comparable ones.
      let adListing: { id: string; title: string; url: string } | null = null;
      const rawName = await fetchRawLeadName(lead.leadId);
      const codeMatch = rawName.match(/\b([A-Z]{1,4}-[A-Z0-9]+(?:-[A-Z0-9]+)*)\b/);
      if (codeMatch?.[1]) {
        const known = await describePropertiesByIds([codeMatch[1]]).catch(() => new Map());
        const hit = known.get(codeMatch[1].toUpperCase());
        if (hit) adListing = { id: codeMatch[1].toUpperCase(), title: hit.title, url: hit.url };
      }

      if (!adListing && (!note || !looksLikeClientRequest(note))) continue;

      // The ad/scout form may carry the budget — a below-threshold lead goes to
      // the bin instead of being seeded and worked.
      if (await enforceBudgetFilter(lead.leadId, [note])) continue;

      // The person, not the lead title — for ad leads those are different things.
      // The deal name is only a person's name when nothing else named them.
      // On an ad lead it is the LISTING — "R-MER-004 - 2BR Villa ... | Budget:
      // b1 | ..." — and on a scout lead it is a label, "FB Lead: Wyatt Bao".
      // Falling back to it blindly is why clients were greeted as
      // "Hi R-MER-004" and "Hi FB" (2026-08-21). Greeting nobody is fine:
      // buildLeadNameRule and welcomeText both open without a name.
      const leadName =
        (await fetchContactName(lead.leadId)) || personNameFromLeadName(await fetchLeadName(lead.leadId));
      const at = lead.amoCreatedAt ?? new Date();
      // Only ever state what is actually known: which listing the ad was for,
      // plus whatever the person themselves answered in the Meta lead form.
      // Never invent requirements the person has not given.
      //
      // The form answers used to be dropped on the floor here: this was a
      // ternary, so the moment a listing code was found in the lead name the
      // enquiry became the bare link and nothing else. The answers were still
      // written to the card, but nothing in the generation path reads
      // leadNotes — so the bot answered a qualified lead as if they had said
      // only "I like this villa". That is the whole point of the qualification
      // campaign, and it reached nothing. Both halves go in: the villa they
      // clicked is a signal, their own words are the request, and the existing
      // rule that the client's own words override an inherited anchor then
      // does the rest.
      const formAnswers = formAnswersFromNote(note);
      const enquiry = adListing
        ? (formAnswers
            ? `Hi! I saw this villa and I'm interested: ${adListing.url}. ${formAnswers}`
            : `Hi! I saw this villa and I'm interested: ${adListing.url}`)
        : note;
      const content = formatAsLeadMessage(at, leadName, enquiry);

      await db
        .update(leadsSyncTable)
        .set({
          content,
          leadNotes: note || (adListing ? `Ad enquiry: ${adListing.id} — ${adListing.title}` : null),
          // It IS an inbound message — say so, and the normal LIVE pass takes over.
          lastMessageFrom: "lead",
          lastMessageAt: at,
          nextFollowupAt: null,
          updatedAt: new Date(),
        })
        .where(eq(leadsSyncTable.leadId, lead.leadId));

      seeded++;

      // The paid lead is on their phone right now. Answer immediately, with no
      // broker in the loop — see lib/ad-lead-autoreply.ts for why this one
      // message is allowed to send itself and what refuses it.
      if (adListing) {
        await sendAdLeadWelcome({
          leadId: lead.leadId,
          responsibleUser: lead.responsibleUser,
          listingId: adListing.id,
          clientName: leadName,
          content,
        }).catch((err) => logger.error({ err, leadId: lead.leadId }, "ad welcome threw"));
      }

      logger.info(
        { leadId: lead.leadId, leadName, stage: lead.leadStage, adListing: adListing?.id ?? null },
        adListing
          ? "ad lead: listing code read from the lead name and seeded as the enquiry — LIVE will pick it up"
          : "sourced-lead: request note seeded as the lead's first message — LIVE will pick it up",
      );
    } catch (err) {
      logger.error({ err, leadId: lead.leadId }, "sourced-lead seeding failed");
    }
  }

  if (seeded > 0) logger.info({ seeded }, "sourced-lead seeding pass complete");
  return seeded;
}
