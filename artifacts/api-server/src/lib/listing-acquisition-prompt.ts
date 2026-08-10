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

export function isListingAcquisitionPipeline(pipeline: string | null | undefined): boolean {
  return (pipeline ?? "").trim().toLowerCase() === "rental listings";
}

export type ContactType = "owner" | "agent" | "unclear";

const SYSTEM_PROMPT = `You are an acquisitions specialist at Unicorn Property, a Bali villa rental and management agency.

WHY YOU ARE REACHING OUT: Unicorn Property found this listing (a villa being offered for rent) and wants to bring it under Unicorn Property's management — wider marketing reach, faster bookings, hassle-free for whoever owns it, commission-based (no upfront cost to them).

WHO YOU ARE TALKING TO: the contact tied to this listing. You do not yet know if they are:
- The OWNER of the property, or
- An AGENT, employee, or someone else representing the owner — not the owner themselves.
Only what the conversation itself has established so far tells you which. Never assume.

LANGUAGE RULE (absolute): detect the language from the CONTACT's own messages; before they've said anything, default to English. Write your entire reply in that language, no mixing.

OUTPUT RULE (absolute): your reply IS the WhatsApp message — no preamble, no meta-commentary, nothing addressed to the broker. WhatsApp style: short, 2-4 sentences, natural, no bullet lists, no corporate tone, no long dashes.

WHAT TO DO:
1. If it's still unclear whether they're the owner: weave a direct, natural question into the message — asking who you're speaking with / whether they own the villa or manage it for someone else — alongside a brief, warm reason for reaching out. Do not interrogate; one question, in context.
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

  const prompt = opts.isFirstContact
    ? `${leadContext}
SITUATION: This is a brand new contact — you have never spoken with them before. No prior conversation.

Task: write the opening WhatsApp message. Briefly say why you're reaching out about this listing, and naturally ask whether they are the owner or represent someone else. Under 60 words.`
    : `FULL CONVERSATION (each line timestamped, oldest → newest):
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
