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
 */
import { db, leadsSyncTable } from "@workspace/db";
import { eq, isNull, and } from "drizzle-orm";
import { chatCompletionJSON, WRITER_MODEL } from "./ai-client";
import { brokerDisplayName } from "./broker-identity";
import { correctionsPromptBlock } from "./broker-corrections";
import {
  extractListingFacts,
  syncListingFactsToCard,
  promoteIfQualified,
  routeUnqualified,
  meetsQualified,
  type ListingFacts,
} from "./listing-card-fields";
import { formatDialogForAI } from "./dialog-parser";
import { getMergedConversation } from "./merged-conversation";
import { sanitizeSuggestion } from "./sanitize-suggestion";
import { logger } from "./logger";

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

OUTPUT RULE (absolute): your reply IS the WhatsApp message. No preamble, no meta-commentary, nothing addressed to the broker. WhatsApp style: short, 2-4 sentences, natural, no bullet lists, no corporate tone.

NO DASHES. Not the long one, not the short one, not a hyphen standing in for one. Everything else about your punctuation is fine as it is, and this rule is deliberately about the dash alone: it is the single habit that gives a machine away. People typing on a phone put a comma there, or start a new sentence. A villa owner who notices the dash stops reading a person and starts reading a bot. (Hyphens inside words are not dashes: "long-term" and "3-4BR" stay.)

WHAT TO DO:
1. FIRST CONTACT (they have not replied to us yet): open on their listing, not on us. Reference the specific villa and ask the single most useful thing the ACTION BRIEF says to clarify, usually whether it's still available, plus the exact location or the dates. Work in the owner-or-manager question naturally if it fits in one line; if it doesn't fit, it can wait for the next message. No pitch, no value proposition, no commission talk in this first message.
2. If they have confirmed they ARE the owner (or the villa's own manager, developer or reception, anyone entitled to let it): move to QUALIFY. A card can be listed once we know the bedrooms and a price we may put on the site, so ask for both plus the date it frees up, IN ONE SENTENCE, and only for what this conversation has not already given you:

   "Could you send me the number of bedrooms, the monthly and yearly rate including our 10% agency commission, and the date it's available from? That's everything we need to put it in front of our clients."

   Ask for the price in THAT shape, "including our 10% agency commission". Never ask "does your price include commission?": the meta-question gets skipped or answered ambiguously, and a price we cannot quote to a client is not a price. If the villa is a complex of several units, add whether the rate is for one villa or the whole complex. Close on "that's everything we need", it tells the owner this is the last question, not the first of a form. Everything else (land and build size, what's included, minimum term, agreement, inspection) comes AFTER the villa is on the site; do not spend a round trip on it now.
2a. FOLLOW-UP (you will be told when this is one): a day or more has passed since
   anyone wrote. That is not the same conversation continued, it is a new one
   opened on an old thread, and the person has slept, worked and forgotten us
   since. So it OPENS like a new message: greet them BY NAME, name the villa,
   and in half a sentence say what you are coming back about. Only then the ask.
   The name is the one THEY have given you, how they signed a message, or how
   they introduced themselves earlier in this thread. Use it. If this
   conversation has never carried a personal name, open with a plain "Hi" and
   the villa: a made-up name is far worse than none, and the villa's name is not
   a person's.
   Never open a follow-up with "Good to know, thanks!", "Got it", "Understood" or
   anything that answers a line written days ago, that reads as someone who
   lost track of time. Ask for what is still missing, once, and leave it there:
   a chase that repeats the whole checklist is a chase nobody answers.

2b. WHEN YOU STILL DO NOT KNOW WHO THEY ARE, ask, but ask the question that
   actually matters, which is not their job title. What we need to know is
   whether the villa is run by a company that takes a commission of its own, or
   whether they are the owner's side: "just so I know who I'm coordinating with,
   is the villa handled by you and the owner directly, or is there a management
   company looking after it?" An assistant, a family member or the owner's staff
   answering that is the owner's side, do not push them to call themselves an
   agent. Never ask "are you the owner or are you managing it for someone else":
   it forces the owner's own assistant into the wrong answer.

3. If they have said they are an AGENT or otherwise NOT the owner: stop pitching management/investment content, a middleman can't agree to anything. Politely acknowledge, and ask if they can connect you directly with the actual owner. Keep it brief, low-pressure, and do not act as if a deal is progressing.

HARD RULES:
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
};

export async function generateListingAcquisitionReply(
  opts: ListingAcquisitionOpts,
): Promise<{ text: string; contactType: ContactType }> {
  const displayName = brokerDisplayName(opts.responsibleUser);
  const identityRule = displayName
    ? `\n\nYOU ARE WRITING AS ${displayName} if you sign or introduce yourself by name — never an account label.`
    : "";
  // This whole prompt IS one situation: talking an owner into listing with us.
  const learned = await correctionsPromptBlock(opts.responsibleUser, "owner_intake");
  const system = SYSTEM_PROMPT + identityRule + learned;

  // MERGED, not `contentSnippet` alone. `leads_sync.content` is webhook-fed and
  // freezes for anything sent through Salesbot, so a reply written from it
  // answers a message we already answered: on Villa Rasa Rasa the thread ended
  // on the owner's "yes, we manage the villa" for twelve days while our answer
  // sat in lead_messages the whole time. Fixed here, in the one function both
  // live paths call, rather than at either call site.
  const messages = await getMergedConversation(opts.leadId, opts.contentSnippet);
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

  const leadContextBase = opts.leadNotes?.trim()
    ? `\nLISTING / LEAD CARD INFO (whatever is known about the property and contact):\n${opts.leadNotes.trim()}\n`
    : "";

  // ── What this thread has ALREADY answered ────────────────────────────────
  //
  // Telling the model "ask only for what is missing" is not enough on a long
  // thread: it re-asked a bedroom count the owner had given, under a message
  // that literally read "it's going to be available again around next week".
  // So the facts are extracted BEFORE the reply is written and handed over as
  // settled — an instruction the model cannot lose track of halfway down a
  // conversation. Re-asking a fact someone already gave you is what makes a
  // message read as a robot, and it costs the reply.
  //
  // The same extraction then feeds the card fill and the stage check below, so
  // this is one model call, not two.
  const facts: ListingFacts | null = isFirstContact
    ? null
    : await extractListingFacts(formattedDialog || lastLeadText).catch(() => null);

  let knownBlock = "";
  if (facts) {
    const settled: string[] = [];
    if (facts.bedrooms) settled.push(`bedrooms: ${facts.bedrooms}`);
    if (facts.monthlyIdr) settled.push(`monthly rate: ${Math.round(facts.monthlyIdr / 1_000_000)} juta`);
    if (facts.yearlyIdr) settled.push(`yearly rate: ${Math.round(facts.yearlyIdr / 1_000_000)} juta`);
    if (facts.commission !== "unknown") settled.push(`commission position: ${facts.commission}`);
    if (facts.availableFrom) settled.push(`available from: ${facts.availableFrom}`);
    if (facts.area) settled.push(`area: ${facts.area}`);
    if (facts.counterpart !== "unclear") settled.push(`who we are speaking to: ${facts.counterpart}`);
    const missing = meetsQualified(facts).missing;
    if (settled.length) {
      knownBlock =
        `\nALREADY ANSWERED IN THIS THREAD — treat as settled, do NOT ask for any of it again:\n- ${settled.join("\n- ")}\n`;
    }
    if (missing.length) {
      knownBlock += `\nSTILL MISSING before this villa can be listed: ${missing.join(", ")}. Ask ONLY for these, and only for the ones it makes sense to ask THIS person.\n`;
    } else {
      knownBlock += `\nNothing is missing — this villa can be listed. Do not re-ask anything; move the conversation to the next real step instead.\n`;
    }
  }

  // How long the thread has been quiet. A model cannot feel elapsed time from
  // timestamps in a transcript — it answered a four-day-old line with "Good to
  // know, thanks!" — so the gap is stated in words, and a day or more makes this
  // a follow-up that has to open like a new message.
  const lastAt = messages.length ? messages[messages.length - 1]!.at : null;
  const quietDays = lastAt ? Math.floor((Date.now() - new Date(lastAt).getTime()) / 86_400_000) : 0;
  const isFollowUp = !isFirstContact && (opts.kind === "push" || quietDays >= 1);
  const followUpBlock = isFollowUp
    ? `\nTHIS IS A FOLLOW-UP: nobody has written for ${quietDays === 0 ? "most of a day" : `${quietDays} day(s)`}. Follow rule 2a — open it like a new message, by name, and do not answer their last line as if it had just arrived.\n`
    : "";

  const leadContext = leadContextBase + knownBlock + followUpBlock;

  const prompt = isFirstContact
    ? `${leadContext}
THEIR PUBLIC LISTING AD (they posted this in a Facebook group — it is NOT a message to us):
"${(lastLeadText || "").slice(0, 1500)}"

SITUATION: We have never spoken to this person. They have not contacted us. This is our
cold first approach, off the back of the ad above.

Task: write the opening WhatsApp message, following rule 1 in WHAT TO DO. Under 60 words.`
    : `FULL CONVERSATION (each line timestamped, oldest → newest).
NOTE: the first line is their PUBLIC LISTING AD, not a message they sent us — everything
after it is the real conversation.
${formattedDialog}
${leadContext}
SITUATION: The contact just replied. Their latest message:
"${lastLeadText}"

Task: write the next WhatsApp reply, following the WHAT TO DO rules based on what this conversation has established so far. Under 90 words.`;

  const result = await chatCompletionJSON<{ reply?: string; contact_type?: string }>({
    model: WRITER_MODEL,
    label: "listing-acquisition",
    system,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 400,
  });

  const text = sanitizeSuggestion((result.reply ?? "").trim());
  const contactType: ContactType =
    result.contact_type === "owner" || result.contact_type === "agent" ? result.contact_type : "unclear";

  // Per the owner: never auto-close or auto-move stage here (the funnel's
  // stages aren't configured yet) — only flag, using the same "⊘ Review" chip
  // /m already renders for a dead-lead flag. Idempotent so re-classifying the
  // same lead as "agent" on a later reply doesn't keep resetting the flag.
  if (contactType === "agent") {
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
  if (!isFirstContact && facts) {
    // Reuses the facts already extracted above — one model call feeds the
    // message, the card and the stage.
    void (async () => {
      // Fields first, stage second. A card promoted to QUALIFIED with its
      // columns still empty is an agent opening a "ready" listing that tells
      // them nothing — the exact state this whole change exists to end.
      await syncListingFactsToCard(opts.leadId, facts);
      const outcome = await promoteIfQualified(opts.leadId, facts);
      logger.info({ leadId: opts.leadId, ...outcome }, "listing-acquisition: qualification checked");
      // Only when it did NOT qualify: a management company we have agreed terms
      // with is a listing, not something to file away.
      if (!outcome.moved && outcome.reason.startsWith("not yet")) {
        const routed = await routeUnqualified(opts.leadId, facts);
        if (routed.moved) logger.info({ leadId: opts.leadId, ...routed }, "listing card parked");
      }
    })().catch((err) =>
      logger.warn({ err, leadId: opts.leadId }, "listing-acquisition: card fill failed (non-fatal)"),
    );
  }

  return { text, contactType };
}
