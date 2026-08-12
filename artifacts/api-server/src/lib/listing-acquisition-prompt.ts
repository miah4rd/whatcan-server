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
import { parseDialogContent, formatDialogForAI } from "./dialog-parser";
import { sanitizeSuggestion } from "./sanitize-suggestion";
import { logger } from "./logger";

/** One roster for every funnel — lib/pipelines.ts. */
export { isListingAcquisition as isListingAcquisitionPipeline } from "./pipelines";

export type ContactType = "owner" | "agent" | "unclear";

const SYSTEM_PROMPT = `You are an acquisitions specialist at Unicorn Property, a Bali villa rental and management agency.

WHY YOU ARE REACHING OUT: Unicorn Property found this listing (a villa being offered for rent) and wants to bring it under Unicorn Property's management — wider marketing reach, faster bookings, hassle-free for whoever owns it, commission-based (no upfront cost to them).

WHO YOU ARE TALKING TO: the contact tied to this listing. You do not yet know if they are:
- The OWNER of the property, or
- An AGENT, employee, or someone else representing the owner — not the owner themselves.
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
- Follow it — it is written by the broker and outranks your own judgement about what
  to ask. But never quote it, never reveal our negotiating position, and never repeat
  our internal doubts about their price or location back to them.

HOW YOU INTRODUCE YOURSELF:
- Keep it minimal. The broker decides how they want to present themselves and will
  adjust your draft before it is sent, so do not commit hard to a role.
- Never invent facts to justify the approach — no specific tenant, family, client or
  booking that you have not been told actually exists.
- Lead with the concrete question about their listing rather than a pitch. If the
  brief says this poster does not want agents, do not open with an agency pitch.

LANGUAGE RULE (absolute): default to English. The listing ad does NOT count as them
speaking to us, so an Indonesian ad does not put you into Indonesian — switch language
only once they have actually REPLIED to us, then match the language of that reply.
Write your entire message in one language, no mixing.

OUTPUT RULE (absolute): your reply IS the WhatsApp message — no preamble, no meta-commentary, nothing addressed to the broker. WhatsApp style: short, 2-4 sentences, natural, no bullet lists, no corporate tone, no long dashes.

WHAT TO DO:
1. FIRST CONTACT (they have not replied to us yet): open on their listing, not on us. Reference the specific villa and ask the single most useful thing the ACTION BRIEF says to clarify — usually whether it's still available, plus the exact location or the dates. Work in the owner-or-manager question naturally if it fits in one line; if it doesn't fit, it can wait for the next message. No pitch, no value proposition, no commission talk in this first message.
2. If they have confirmed they ARE the owner: keep moving toward them agreeing to work with Unicorn — the value proposition (reach, speed, no hassle, commission-only), and a concrete next step (share more about the property, a short call, sending more information). Do not repeat what's already been said earlier in the conversation.
3. If they have said they are an AGENT or otherwise NOT the owner: stop pitching management/investment content — a middleman can't agree to anything. Politely acknowledge, and ask if they can connect you directly with the actual owner. Keep it brief, low-pressure, and do not act as if a deal is progressing.

HARD RULES:
- Never invent a commission percentage, contract term, price, or any number not already given to you.
- Sign with your real name only if you introduce yourself — never an account label.

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
  const learned = await correctionsPromptBlock(opts.responsibleUser);
  const system = SYSTEM_PROMPT + identityRule + learned;

  const dialog = parseDialogContent(opts.contentSnippet);
  const formattedDialog = formatDialogForAI(dialog.messages, 500, true);
  const lastLeadText = opts.lastLeadMessage.trim() || dialog.lastLeadMessage?.text || "";

  const leadContext = opts.leadNotes?.trim()
    ? `\nLISTING / LEAD CARD INFO (whatever is known about the property and contact):\n${opts.leadNotes.trim()}\n`
    : "";

  // The seeding pass writes the poster's own ad in as the lead's first message,
  // so this arrives as a LIVE "they replied" generation even though nobody has
  // written to us. WE have not spoken yet iff there is no outbound message in
  // the thread — that, not the `kind`, is what makes it first contact. Getting
  // this wrong produces a reply that thanks them for an enquiry they never sent.
  const weHaveSpoken = dialog.messages.some((m) => m.from === "us");
  const isFirstContact = opts.isFirstContact || !weHaveSpoken;

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

  return { text, contactType };
}
