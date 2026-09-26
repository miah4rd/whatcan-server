/**
 * Rental Listings pipeline — acquiring rental listings FROM owners, not
 * renting a villa TO a client. A separate scouting process creates the
 * amoCRM card (WhatsApp contact + whatever it knows about the listing) with
 * no conversation yet, so unlike every other pipeline here, THIS bot has to
 * write first.
 *
 * The contact is either the property's OWNER or an AGENT/employee handling
 * it for someone else — that has to be established before any real pitch,
 * since only the owner can actually agree to anything. Kept as its own
 * module (not a third branch inside generate-suggestion.ts's isRental
 * logic) because nothing else in that function applies: no property
 * matching, no shortlist, no attachments — Phase 1 is qualify + pitch only.
 *
 * Phase 1 scope (explicit, per owner): qualify owner vs agent, send the
 * first message, pitch management. Collecting listing details and writing
 * them into the public site's database is a later phase — not built here.
 * CRM stage semantics for this pipeline are not fixed yet either (the owner
 * is configuring the funnel himself), so this module never touches stage —
 * that stays entirely manual for now.
 *
 * 14.09.2026, owners via Yudi: the autopilot sounds like a robot and asks what
 * they already answered. Every AI draft to an owner is written here (both
 * generateSuggestion copies, the handover, retouch and requalify all call this
 * function), so the two fixes live here once: the words come from Yudi's own
 * messages (owner-voice.ts), and nothing the thread already answers is asked
 * again (owner-thread-known.ts — in the prompt, and cut from the finished draft).
 */
import { regulationBlock } from "./regulation";
import { db, leadsSyncTable, brokerSettingsTable } from "@workspace/db";
import { eq, isNull, and } from "drizzle-orm";
import { chatCompletionJSON, WRITER_MODEL } from "./ai-client";
import { brokerDisplayName } from "./broker-identity";
import { correctionsPromptBlock } from "./broker-corrections";
import {
  extractListingFacts,
  syncListingFactsToCard,
  meetsQualified,
  confirmsNotOurFormat,
  type ListingFacts,
} from "./listing-card-fields";
import { reconcileListingStage } from "./listing-stage-engine";
import { getAmoLead, amoPost } from "./amo-client";
import { isMediaOnly } from "./media-message";
import { LISTING_STAGE } from "./listing-status-week";
import { latestInspectionSlot } from "./listing-progress";
import { applyInspectionAsk, bookingPlan, inspectionBookingPromptBlock, type BookingPlan } from "./inspection-booking";
import { formatDialogForAI } from "./dialog-parser";
import { getMergedConversation } from "./merged-conversation";
import { sanitizeSuggestion } from "./sanitize-suggestion";
import { logger } from "./logger";
import { handleReferral, mayHoldReferral, REFERRAL_MARK } from "./listing-referral";
import {
  ownerThreadKnown,
  knownPromptBlock,
  removeRepeatedAsks,
  POINT_LABEL,
  type OwnerPoint,
  type OwnerThreadKnown,
} from "./owner-thread-known";
import { ownerVoiceBlock, tightenInYudiVoice } from "./owner-voice";
import { ownerThreadLanguage, type OwnerLang } from "./yudi-voice";

/** One roster for every funnel — lib/pipelines.ts. */
export { isListingAcquisition as isListingAcquisitionPipeline } from "./pipelines";

export type ContactType = "owner" | "agent" | "unclear";

const SYSTEM_PROMPT = `You are an acquisitions specialist at Unicorn Property, a Bali villa rental and management agency.

WHY YOU ARE REACHING OUT: Unicorn Property found this listing (a villa being offered for rent) and wants to bring it under Unicorn Property's management, wider marketing reach, faster bookings, hassle-free for whoever owns it, commission-based (no upfront cost to them).

WHO YOU ARE TALKING TO: the contact tied to this listing. You do not yet know if they are:
- The OWNER of the property, or
- An AGENT, employee, or someone else representing the owner, not the owner themselves.
Only what the conversation itself has established so far tells you which. Never assume.

READ THE FIRST MESSAGE CORRECTLY (this trips people up):
- The first "message" in the conversation is the PUBLIC RENTAL AD this person posted
  in a Facebook group. They wrote it, but they did NOT write it to us and they have
  not contacted us. We are the ones reaching out, cold, about their ad.
- So never thank them for getting in touch, never imply they enquired, and never
  answer it as if it were a question addressed to you. Use it for what it is: the
  facts about the villa (area, price, size, what's included, availability).
- Refer to their listing naturally, the way a real person who just read the ad would.

LEAD CARD INFO IS FOR YOU, NOT FOR THEM:
- It holds our own research and our internal ACTION BRIEF: which number to use, what
  to clarify, where the price or the location looks wrong, how to approach this person.
- Follow it, it is written by the broker and outranks your own judgement about what
  to ask. But never quote it, never reveal our negotiating position, and never repeat
  our internal doubts about their price or location back to them.

HOW YOU INTRODUCE YOURSELF:
- Keep it minimal. The broker decides how they want to present themselves and will
  adjust your draft before it is sent, so do not commit hard to a role.
- Never invent facts to justify the approach, no specific tenant, family, client or
  booking that you have not been told actually exists.
- Lead with the concrete question about their listing rather than a pitch. If the
  brief says this poster does not want agents, do not open with an agency pitch.

LANGUAGE RULE (absolute): default to English. The listing ad does NOT count as them
speaking to us, so an Indonesian ad does not put you into Indonesian, switch language
only once they have actually REPLIED to us, then match the language of that reply.
Write your entire message in one language, no mixing.

OUTPUT RULE (absolute): your reply IS the WhatsApp message. No preamble, no meta-commentary, nothing addressed to the broker. WhatsApp style, the way Yudi types to owners (his own messages follow below): short, one to three short lines with a line break where he would put one, natural, no bullet lists, no corporate tone, no pitch the conversation did not ask for.

NO DASHES. Not the long one, not the short one, not a hyphen standing in for one. Everything else about your punctuation is fine as it is, and this rule is deliberately about the dash alone: it is the single habit that gives a machine away. People typing on a phone put a comma there, or start a new sentence. A villa owner who notices the dash stops reading a person and starts reading a bot. (Hyphens inside words are not dashes: "long-term" and "3-4BR" stay.)

WHAT TO DO:
1. FIRST CONTACT (they have not replied to us yet): open on their listing, not on us. Reference the specific villa and ask the single most useful thing the ACTION BRIEF says to clarify, usually whether it's still available, plus the exact location or the dates. If the owner-or-manager question fits naturally in one line, ask it the way rule 2b describes, with THREE options, never two: the owner, the owner's own team, or a management company looking after it. Two options force the owner's own assistant to answer "managing on behalf", which files a salaried employee as a middleman. If it does not fit, it waits for the next message. No pitch, no value proposition, no commission talk in this first message.
1R. REFERRED NUMBER (the ACTION BRIEF says REFERRED BY): this person never saw a message from us, someone on the villa side gave us their number. Open with that: greet them by the name the brief gives (never invent one), say who passed the number on and for which villa, then ask, in one short message, for the monthly and yearly rate including our 10% agency commission. Here the price question belongs in the first message, because it is exactly why we were sent to them. Never write that you came across their listing.
2. If they have confirmed they ARE the owner (or the villa's own manager, developer or reception, anyone entitled to let it): move to QUALIFY. A card is qualified once we know two things: that we are talking to the owner or the owner's own staff (not another agency), and the monthly and/or yearly price with our 10% commission position. Everything else (bedrooms, photos, description) we take from the internet, and the visit is arranged after qualification — do not ask for the minimum stay or a viewing day to qualify. Ask for what is still missing in ONE message, and ONLY for what this conversation has not already given you: the ALREADY GIVEN list is binding, and a point they answered in any language, after a quote, or to Yudi's own messages is answered. Ask it the way Yudi asks in his own messages below, short, never as a form read out.

   PRICE AND COMMISSION ARE ONE QUESTION, ALWAYS. If your message asks about money at all, our 10% agency commission goes with it, in that same sentence: the price including our 10%. Never a bare price question ("what's the monthly rate?", "could you share pricing details", "berapa harganya" on its own): a bare price question gets a bare number, and then we need a second message days later to learn whether our fee sits inside it or on top. When they already gave a price without saying where our fee sits, ask only that: whether that price already includes our 10%.

   If the villa is a complex of several units, add whether the rate is for one villa or the whole complex. Do not close on a formula ("that's everything we need", "itu saja yang kami perlukan"): Yudi never does. Everything else (land and build size, what's included, agreement, inspection) comes AFTER the villa is on the site; do not spend a round trip on it now.
2a. FOLLOW-UP (you will be told when this is one): a day or more has passed since
   anyone wrote. That is not the same conversation continued, it is a new one
   opened on an old thread, and the person has slept, worked and forgotten us
   since. So it OPENS like a new message: greet them BY NAME, name the villa,
   and in half a sentence say what you are coming back about. Only then the ask.
   The name is the one THEY have given you, how they signed a message, or how
   they introduced themselves earlier in this thread. Use it. If this
   conversation has never carried a personal name, open with a plain greeting and
   the villa: a made-up name is far worse than none, and the villa's name is not
   a person's.
   Never open a follow-up with "Good to know, thanks!", "Got it", "Understood" or
   anything that answers a line written days ago, that reads as someone who
   lost track of time. Ask for what is still missing, once, and leave it there:
   a chase that repeats the whole checklist is a chase nobody answers.

2b. WHEN YOU STILL DO NOT KNOW WHO THEY ARE, ask, but ask the question that
   actually matters, which is not their job title. What we need to know is
   whether the villa is run by a company that takes a commission of its own, or
   whether they are the owner's side: ask whether the villa is handled by them
   and the owner directly, or whether a management company looks after it. An
   assistant, a family member or the owner's staff answering that is the owner's
   side, do not push them to call themselves an agent. Never ask "are you the
   owner or are you managing it for someone else": it forces the owner's own
   assistant into the wrong answer. Once they have said who they are, never ask again.

3. If they have said they are an AGENT or otherwise NOT the owner: stop pitching management/investment content, a middleman can't agree to anything. Politely acknowledge, and ask if they can connect you directly with the actual owner. Keep it brief, low-pressure, and do not act as if a deal is progressing.

4. NOT OUR FORMAT — short stays only. Unicorn lists villas for MONTHLY and YEARLY rental ONLY. If they say the villa is only for short-term, nightly, daily or holiday stays, or they quote a per-night rate as the only option: do NOT qualify it. No questions about rates, commission, minimum stay, availability, photos or viewings. Write ONE short, warm message: thank them, say plainly that we work with monthly and yearly rentals only, so this villa is not a fit for us right now, and leave the door open if they ever consider renting it monthly. Then stop. Never say or imply that we place short-stay clients — we do not, and a message that says "short term works too" is a false promise sent in the company's name.

HARD RULES:
- NEVER ASK AGAIN what the villa side has already told us: anything under ALREADY GIVEN, or anything they plainly answered in the thread, in any wording, any language, as "just to confirm" or as one item of a list. Owners have complained about exactly this. When you are not sure whether they answered, do not ask: mention it as known instead. A draft that re-asks is cut before it is sent.
- WE DO NOT DO SHORT-TERM, NIGHTLY OR DAILY RENTAL. Never claim we do, never ask for a nightly rate, never "work with" a per-night price. Monthly and yearly only.
- COMMISSION: 10% is the ONLY percentage you may ever write. State it, ask for prices that include it, nothing else. You may not name a different rate, accept one, counter one, or say a rate "works for us", even if the other side proposes it and even if agreeing sounds helpful. Commission terms are the owner's decision to make with a human, and a draft that concedes one is a deal term given away by a bot. If they push on the rate, say the broker will confirm it, and stop there.
- Never invent any other number either: no contract term, no price, no size, nothing this conversation has not given you.
- Sign with your real name only if you introduce yourself, never an account label.

Respond with JSON only, no markdown, no code fences: {"reply": "<the WhatsApp message text>", "contact_type": "owner" | "agent" | "unclear"}
contact_type reflects only what THIS conversation has established so far.`;

type ListingAcquisitionOpts = {
  leadId: string;
  responsibleUser: string | null;
  kind: "live" | "push";
  lastLeadMessage: string;
  contentSnippet: string;
  leadNotes?: string | null;
  isFirstContact?: boolean;
  /**
   * Write the draft as it would have been written at this moment: the thread is
   * cut there and NOTHING is written anywhere (no facts, card fill, stage, flag,
   * referral). Today's stage is not the stage the card had then, so the stage
   * and the inspection booking plan are skipped. For replaying a change on real
   * past conversations before it ships (scripts/replay-owner-drafts.ts).
   */
  replayAsOf?: Date;
};

/** The qualification gaps `meetsQualified` names, as owner points. */
const MISSING_POINT: Array<[RegExp, OwnerPoint]> = [
  [/^bedrooms$/, "bedrooms"],
  [/^price$/, "price"],
  [/^commission position$/, "commission"],
  [/^minimum stay$/, "min_stay"],
  [/^earliest viewing$/, "viewing"],
  [/^not the owner/, "owner"],
  [/^free date$/, "availability"],
];

/** A gap the extraction left `null` but the villa side's own words answer is not a gap. */
function answeredInThread(missing: string, k: OwnerThreadKnown): boolean {
  const hit = MISSING_POINT.find(([rx]) => rx.test(missing));
  return Boolean(hit && k.known[hit[1]]);
}

function hasWords(text: string, n: number): boolean {
  return text.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean).length >= n;
}

/**
 * One note per burst of media on the card: "the owner sent 3 photos/screenshots in reply to: …".
 * Keyed by lead + the count so a regenerated draft does not write it twice.
 */
async function noteMediaForBroker(leadId: string, markers: string[], ourQuestion: string | null): Promise<void> {
  const key = `media_note:${leadId}:${markers.length}:${(ourQuestion ?? "").slice(0, 40)}`;
  const [seen] = await db
    .select({ key: brokerSettingsTable.key })
    .from(brokerSettingsTable)
    .where(eq(brokerSettingsTable.key, key))
    .limit(1);
  if (seen) return;
  const what = markers.map((m) => m.replace(/^\[media:\s*/, "").replace(/\]$/, "")).join(", ");
  const text =
    `The owner replied with ${markers.length === 1 ? "a " : markers.length + " x "}${what} — the bot cannot read images, please check it in the chat.` +
    (ourQuestion ? `\nOur last message was: "${ourQuestion.replace(/\s+/g, " ").slice(0, 300)}"` : "") +
    `\nThe bot thanked the owner and will not ask the same question again.`;
  await amoPost(`/api/v4/leads/${leadId}/notes`, [{ note_type: "common", params: { text } }]);
  await db.insert(brokerSettingsTable).values({ key, value: new Date().toISOString() }).onConflictDoNothing();
}

export async function generateListingAcquisitionReply(
  opts: ListingAcquisitionOpts,
): Promise<{ text: string; contactType: ContactType }> {
  const replay = opts.replayAsOf ?? null;
  const displayName = brokerDisplayName(opts.responsibleUser);
  const identityRule = displayName
    ? `\n\nYOU ARE WRITING AS ${displayName} if you sign or introduce yourself by name — never an account label.`
    : "";
  // This whole prompt IS one situation: talking an owner into listing with us.
  const learned = await correctionsPromptBlock(opts.responsibleUser, "owner_intake");

  // MERGED, not `contentSnippet` alone. `leads_sync.content` is webhook-fed and
  // freezes for anything sent through Salesbot, so a reply written from it
  // answers a message we already answered: on Villa Rasa Rasa the thread ended
  // on the owner's "yes, we manage the villa" for twelve days while our answer
  // sat in lead_messages the whole time. Fixed here, in the one function both
  // live paths call, rather than at either call site.
  const merged = await getMergedConversation(opts.leadId, opts.contentSnippet);
  const messages = replay ? merged.filter((m) => m.at.getTime() < replay.getTime()) : merged;
  const formattedDialog = formatDialogForAI(messages, 500, true);
  const lastLeadText =
    opts.lastLeadMessage.trim() ||
    [...messages].reverse().find((m) => m.from === "lead")?.text ||
    "";

  // The seeding pass writes the poster's own ad in as the lead's first message,
  // so this arrives as a LIVE "they replied" generation even though nobody has
  // written to us. WE have not spoken yet iff there is no outbound message in
  // the thread — that, not the `kind`, is what makes it first contact. Getting
  // this wrong produces a reply that thanks them for an enquiry they never sent.
  // Decided BEFORE the fact extraction below, which is skipped on a first
  // contact: the only text in the thread there is their own public ad.
  const weHaveSpoken = messages.some((m) => m.from === "us");
  const isFirstContact = opts.isFirstContact || !weHaveSpoken;

  // The villa side answered with nothing but a photo, a screenshot or a file (Yudi, 21.09: owners
  // send a screenshot of their price list and then get the same question again). The bot cannot
  // read the picture (media-message.ts), so it does not pretend to: a short thanks in Yudi's words,
  // and a note on the card telling him there is something to look at. No model, no question.
  if (!isFirstContact) {
    let lastUs = -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.from === "us") { lastUs = i; break; }
    const theirs = messages.slice(lastUs + 1).filter((m) => m.from === "lead");
    if (theirs.length && theirs.every((m) => isMediaOnly(m.text))) {
      const lang = ownerThreadLanguage(messages.map((m) => ({ senderType: m.from === "lead" ? "lead" : "broker", text: m.text })));
      const text = lang === "id" ? "Terima kasih kak, sudah kami terima 🙏" : "Thank you, received 🙏";
      if (!replay) await noteMediaForBroker(opts.leadId, theirs.map((m) => m.text), messages[lastUs]?.text ?? null).catch(() => undefined);
      logger.info({ leadId: opts.leadId, media: theirs.length }, "listing reply: the owner sent only media — thanks, and a note for the broker");
      return { text, contactType: "unclear" };
    }
  }

  const leadContextBase = opts.leadNotes?.trim()
    ? `\nLISTING / LEAD CARD INFO (whatever is known about the property and contact):\n${opts.leadNotes.trim()}\n`
    : "";

  // ── What this thread has ALREADY answered ────────────────────────────────
  //
  // Telling the model "ask only for what is missing" is not enough on a long
  // thread: it re-asked a bedroom count the owner had given, under a message
  // that literally read "it's going to be available again around next week".
  // So the facts are extracted BEFORE the reply is written and handed over as
  // settled. Since 14.09 the settled list is the shared check
  // (owner-thread-known.ts): the extracted facts AND the villa side's own words,
  // because a fact the extraction left null ("tidak ada minimum", a price in
  // USD, "before 13tg") was listed as missing and asked again.
  //
  // The same extraction then feeds the card fill and the stage check below, so
  // this is one model call, not two.
  const facts: ListingFacts | null = isFirstContact
    ? null
    : await extractListingFacts(formattedDialog || lastLeadText, replay ? undefined : opts.leadId).catch(() => null);
  const known: OwnerThreadKnown | null = isFirstContact
    ? null
    : await ownerThreadKnown(opts.leadId, { facts, ...(replay ? { asOf: replay } : {}) }).catch(() => null);

  // The card's stage is a fact the thread cannot show. Read ONCE, by amoCRM id: the owner renames
  // these stages (87763170 was "agreement", then "Inspection. done", since 14.09 "Inspection
  // sceduled"), and leads_sync.lead_stage_id is not reliable. A replay reads no stage.
  let statusId: number | null = null;
  if (!replay) {
    try {
      statusId = (await getAmoLead(opts.leadId).catch(() => null))?.status_id ?? null;
      if (statusId == null) {
        const [row] = await db
          .select({ leadStage: leadsSyncTable.leadStage })
          .from(leadsSyncTable)
          .where(eq(leadsSyncTable.leadId, opts.leadId))
          .limit(1);
        const name = row?.leadStage ?? "";
        statusId = /inspection|sceduled|scheduled/i.test(name) ? LISTING_STAGE.INSPECTION_SCHEDULED : /qualified/i.test(name) ? LISTING_STAGE.QUALIFIED : null;
      }
    } catch {
      // The stage is a refinement; a failed read must not cost the reply.
    }
  }
  const qualified = statusId === LISTING_STAGE.QUALIFIED;

  // ── Not our format: the one case where the next question is no question ──
  //
  // The owner of Velin Villa wrote "only available for short-term stay" and got
  // back "no worries, short term works too!" plus a request for the nightly
  // rate (autopilot, 2026-09-14) — seven owners in a month. The stage engine
  // knew (stopKind "not_our_format" closes the card) but ran after the send;
  // the writer had no rule and bridged the contradiction with an invented
  // policy. Decided here, in code, from the extracted facts AND a plain-text
  // check on the owner's own recent words, so a missed extraction cannot let
  // it through. A monthly/yearly figure alongside the nightly one is not
  // "only short stays" — the model then follows rule 4 on its own judgement.
  const recentLeadText = messages
    .filter((m) => m.from === "lead")
    .slice(-3)
    .map((m) => m.text)
    .join("\n");
  const SHORT_STAYS_ONLY =
    /\b(only|just|hanya|cuma|khusus)\s+(for\s+|untuk\s+)?(short[- ]?term|short[- ]?stays?|daily|nightly|harian|per\s?night|per\s?malam)|short[- ]?term\s+(stay|only|rental only)|\b(not|no)\s+(available\s+)?(for\s+)?(long[- ]?term|monthly)|\b(per|\/)\s?(night|malam)\b|harian\s+(saja|aja|only)/i;
  const MENTIONS_MONTHLY = /\b(monthly|per month|a month|yearly|per year|annual|bulanan|per bulan|tahunan|per tahun)\b/i;
  // The extraction's `not_our_format` alone is not enough to decline: on the 14.09 replay it read
  // BK Villa's "Maximal 3 bulan saja" (37 juta a month — monthly rental) as short stays only, and
  // the draft told the owner we cannot help. A decline sent to an owner gets the same fail-closed
  // yes/no second opinion the engine asks before closing a card on it.
  const notOurFormat =
    !isFirstContact &&
    ((facts?.stopKind === "not_our_format" && (await confirmsNotOurFormat(opts.leadId).catch(() => false))) ||
      (SHORT_STAYS_ONLY.test(recentLeadText) && !MENTIONS_MONTHLY.test(recentLeadText)));
  let knownBlock = "";
  if (notOurFormat) {
    logger.info(
      { leadId: opts.leadId, viaFacts: facts?.stopKind === "not_our_format", signal: facts?.stopSignal ?? null },
      "listing reply: short stays only — writing the polite decline, no qualification",
    );
    knownBlock =
      `\nNOT OUR FORMAT: this person has said the villa is for short stays / nightly only${facts?.stopSignal ? ` ("${facts.stopSignal}")` : ""}. Follow rule 4 exactly: one short, warm decline — monthly and yearly only, not a fit right now, door open if they ever rent monthly. No questions of any kind. Do not thank them for information you will not use, do not ask for the nightly rate.\n`;
  } else if (known) {
    knownBlock = knownPromptBlock(known);
    if (qualified) {
      // QUALIFIED: the qualification is done by the stage engine; an extraction that lost a fact on a
      // long thread must not turn into a question the owner already answered (owner via Yudi, 14.09:
      // owner messages "repeat questions owners already answered"). The stage block says what's next.
    } else if (facts) {
      const missing = meetsQualified(facts).missing.filter((m) => !answeredInThread(m, known));
      // A price the extraction could not read is still a price; what is open is our 10%.
      if (!facts.monthlyIdr && !facts.yearlyIdr && known.known.price && !known.known.commission && !missing.includes("commission position")) {
        missing.push("commission position");
      }
      if (missing.length) {
        knownBlock += `\nSTILL MISSING before this villa can be listed: ${missing.join(", ")}. Ask ONLY for these, and only for the ones it makes sense to ask THIS person.\n`;
      } else {
        knownBlock += `\nNothing is missing — this villa can be listed. Do not re-ask anything; move the conversation to the next real step instead.\n`;
      }
    }
  }

  // How long the thread has been quiet. A model cannot feel elapsed time from
  // timestamps in a transcript — it answered a four-day-old line with "Good to
  // know, thanks!" — so the gap is stated in words, and a day or more makes this
  // a follow-up that has to open like a new message.
  const nowMs = (replay ?? new Date()).getTime();
  const lastAt = messages.length ? messages[messages.length - 1]!.at : null;
  const quietDays = lastAt ? Math.floor((nowMs - new Date(lastAt).getTime()) / 86_400_000) : 0;
  const isFollowUp = !isFirstContact && (opts.kind === "push" || quietDays >= 1);
  const followUpBlock = isFollowUp
    ? `\nTHIS IS A FOLLOW-UP: nobody has written for ${quietDays === 0 ? "most of a day" : `${quietDays} day(s)`}. Follow rule 2a — open it like a new message, by name, and do not answer their last line as if it had just arrived.\n`
    : "";

  // Until 14.09 this block told the model "OUR AGENT HAS ALREADY INSPECTED THIS
  // VILLA" on 87763170 — since the rename that stage only means a visit is
  // AGREED, so the conversation is about that visit, not after it. On QUALIFIED
  // the next step is Yudi's inspection visit (lib/inspection-booking.ts): the
  // plan decides ask / settle / hold, the words come from Yudi's own messages.
  // "Details ased" (87763166) was deleted by the owner on 14.09.2026.
  let stageBlock = "";
  let booking: BookingPlan | null = null;
  try {
    if (statusId === LISTING_STAGE.INSPECTION_SCHEDULED) {
      const slot = await latestInspectionSlot(opts.leadId).catch(() => null);
      const when = slot
        ? `on ${slot.visitAt.toLocaleString("en-GB", { timeZone: "Asia/Makassar", weekday: "long", day: "numeric", month: "long", ...(slot.timeKnown ? { hour: "2-digit", minute: "2-digit" } : {}) })} Bali time`
        : "as agreed in the thread";
      stageBlock =
        `
A VISIT TO THIS VILLA BY OUR AGENT IS SCHEDULED (card stage: Inspection scheduled) ${when}. It has not necessarily happened yet — never say or imply that we have already been there. What this conversation is about now: that visit — confirm the day and time, who meets our agent at the villa, access (pin, gate, parking, a tenant or guest in the villa), and reschedule politely if the villa side asks. Everything the villa side has already given in the thread (photos, video, pin, price, availability, size, documents) stays given: NEVER ask for any of it again; whatever is still missing is completed at the visit. Do not re-qualify, do not sell the agency again, do not propose another visit on top of the agreed one.
`;
    } else if (qualified && !isFirstContact && !notOurFormat) {
      booking = await bookingPlan(opts.leadId, { statusId });
      stageBlock = await inspectionBookingPromptBlock(booking);
    }
  } catch {
    // The stage is a refinement; a failed read must not cost the reply.
  }

  const leadContext = leadContextBase + knownBlock + stageBlock + followUpBlock;

  // The voice: Yudi's own messages in the language this owner writes (English
  // until they have replied — the language rule), and his hand rewrites. His
  // lessons come after it and win.
  const lang: OwnerLang = known?.ownerReplied ? ownerThreadLanguage(known.lines) : "en";
  const voice = await ownerVoiceBlock({ lang }).catch(() => "");
  // SYSTEM_PROMPT is the same bytes on every call (~2.5k tokens): sent as the cached prefix it is
  // read at a tenth of the price inside the hour instead of paid in full on every reply (25.09.2026).
  // The voice and the lessons change with Yudi's messages and stay outside the cache.
  const system = identityRule + voice + learned;

  // A number the villa side handed us (listing-referral.ts): the opener names
  // who passed it on instead of pretending we read an ad.
  const referred = (opts.leadNotes ?? "").includes(REFERRAL_MARK);
  const prompt = isFirstContact
    ? referred
      ? `${leadContext}
WHAT WE KNOW ABOUT THE VILLA (from the person who referred them, NOT a message from this contact):
"${(lastLeadText || "").slice(0, 1500)}"

SITUATION: We have never spoken to this person. Their number was passed to us by someone on the villa side, as the ACTION BRIEF says.

Task: write the opening WhatsApp message, following rule 1R in WHAT TO DO. Short, the way Yudi opens, under 70 words.`
      : `${leadContext}
THEIR PUBLIC LISTING AD (they posted this in a Facebook group — it is NOT a message to us):
"${(lastLeadText || "").slice(0, 1500)}"

SITUATION: We have never spoken to this person. They have not contacted us. This is our
cold first approach, off the back of the ad above.

Task: write the opening WhatsApp message, following rule 1 in WHAT TO DO. Short, the way Yudi opens, under 60 words.`
    : `FULL CONVERSATION (each line timestamped, oldest → newest).
NOTE: the first line is their PUBLIC LISTING AD, not a message they sent us — everything
after it is the real conversation.
${formattedDialog}
${leadContext}
SITUATION: The contact just replied. Their latest message:
"${lastLeadText}"

Task: write the next WhatsApp reply, following the WHAT TO DO rules based on what this conversation has established so far. As short as Yudi's own replies, usually under 40 words.`;

  const write = (extra = "") =>
    chatCompletionJSON<{ reply?: string; contact_type?: string }>({
      model: WRITER_MODEL,
      label: "listing-acquisition",
      // The owner's regulation (skills/rental-listings.md) joins the cached prefix; a save in Playbooks applies at once.
      cachePrefix: SYSTEM_PROMPT + regulationBlock("rental listings"),
      system,
      messages: [{ role: "user", content: prompt + extra }],
      max_tokens: 400,
    });
  const result = await write();

  // QUALIFIED with an ask due: the reply carries the move toward Yudi's visit (one sentence in his
  // voice is inserted when the model left it out). The plan is null on every other stage.
  let text = await applyInspectionAsk(sanitizeSuggestion((result.reply ?? "").trim()), booking);
  const contactType: ContactType =
    result.contact_type === "owner" || result.contact_type === "agent" ? result.contact_type : "unclear";

  // The finished draft is checked, not trusted: a question about a point the
  // thread already answers is cut (owner-thread-known.ts). A draft that was
  // nothing but repeated questions is written once more, told so; if that too is
  // empty there is no draft — callers skip an empty text.
  if (known && text) {
    const cleaned = await removeRepeatedAsks(text, known, opts.leadId);
    if (cleaned.changed) {
      const asked = [...new Set(cleaned.removed.flatMap((f) => f.repeated))];
      logger.info(
        { leadId: opts.leadId, asked, removed: cleaned.removed.map((f) => f.sentence.slice(0, 140)), replay: Boolean(replay) },
        "listing reply: a question the thread already answers was cut from the draft",
      );
      text = cleaned.text;
      if (!hasWords(text, 4)) {
        const again = await write(
          `\n\nYOUR FIRST DRAFT ONLY RE-ASKED WHAT THEY ALREADY ANSWERED (${asked.map((p) => POINT_LABEL[p]).join("; ")}). Write the reply again without asking for any of it: answer what they said, or confirm what is known and move to the next real step.`,
        ).catch(() => null);
        const second = again
          ? await removeRepeatedAsks(await applyInspectionAsk(sanitizeSuggestion((again.reply ?? "").trim()), booking), known, opts.leadId)
          : null;
        text = second && hasWords(second.text, 4) ? second.text : "";
        if (!text) logger.warn({ leadId: opts.leadId, asked }, "listing reply: nothing left to say that is not a repeated question — no draft");
      }
    }
  }

  // Shorter, in Yudi's own length and register (owner, 19.09.2026). See tightenInYudiVoice.
  if (text) text = await tightenInYudiVoice(text, { lang, leadId: opts.leadId });

  // Per the owner: never auto-close or auto-move stage here (the funnel's
  // stages aren't configured yet) — only flag, using the same "⊘ Review" chip
  // /m already renders for a dead-lead flag. Idempotent so re-classifying the
  // same lead as "agent" on a later reply doesn't keep resetting the flag.
  if (contactType === "agent" && !replay) {
    try {
      await db
        .update(leadsSyncTable)
        .set({
          discardFlaggedAt: new Date(),
          discardReason: "Contact identified themselves as an agent/representative, not the property owner — confirm and close if so.",
        })
        .where(and(eq(leadsSyncTable.leadId, opts.leadId), isNull(leadsSyncTable.discardFlaggedAt)));
    } catch (err) {
      logger.warn({ err, leadId: opts.leadId }, "listing-acquisition: failed to flag agent contact");
    }
  }

  // Fill the card from the SAME thread this reply was written from.
  //
  // It lives here, not at the call sites, because generate-suggestion.ts and
  // amocrm-webhook.ts BOTH call this function — a hook added to one of them is
  // this project's oldest bug shape, and it fails silently.
  //
  // Only once the owner has actually replied: on first contact the only text in
  // the thread is their public ad, and the regulation is explicit that a price
  // taken from a listing ad is not a price the owner gave us.
  //
  // Deliberately not awaited — a Haiku call plus two amoCRM round trips, and
  // nothing about the draft depends on it. If it fails the card stays as it was.
  if (!isFirstContact && facts && !replay) {
    // Reuses the facts already extracted above — one model call feeds the
    // message, the card and the stage.
    void (async () => {
      // Fields first, stage second. A card promoted to QUALIFIED with its
      // columns still empty is an agent opening a "ready" listing that tells
      // them nothing — the exact state this whole change exists to end.
      await syncListingFactsToCard(opts.leadId, facts);
      // One owner for the stage: the engine computes it from the accumulated
      // facts and moves the card if, and only if, the facts earn it.
      const r = await reconcileListingStage(opts.leadId, { facts, apply: true, source: "reply" });
      logger.info({ ...r, source: "reply" }, "listing-acquisition: stage reconciled");
    })().catch((err) =>
      logger.warn({ err, leadId: opts.leadId }, "listing-acquisition: card fill failed (non-fatal)"),
    );
  }

  // The villa side sent us to someone else with a number: open that
  // conversation instead of promising "I'll reach out to them" and doing
  // nothing (12.09: fourteen cards sat on exactly that). A regex gate first;
  // the model is asked only when the message can hold a hand-off.
  if (!isFirstContact && !replay && mayHoldReferral(lastLeadText)) {
    void handleReferral(opts.leadId, { apply: true, source: "reply" }).catch((err) =>
      logger.warn({ err, leadId: opts.leadId }, "listing referral: hand-off failed (non-fatal)"),
    );
  }

  return { text, contactType };
}
