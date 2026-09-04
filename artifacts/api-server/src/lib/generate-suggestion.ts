import { chatCompletion, chatCompletionJSON, WRITER_MODEL } from "./ai-client";
import { brokerDisplayName } from "./broker-identity";
import { cleanLeadName } from "./lead-display-name";
import { getLeadCardCriteria } from "./lead-card-fields";
import { correctionsPromptBlock, deriveSituation } from "./broker-corrections";
import { logger } from "./logger";
import { criteriaFromListing } from "./property-catalog";
import { parseDialogContent, formatDialogForAI, describeConversationTiming, conversationWindow } from "./dialog-parser";
import { getKnowledgeBase, filterKnowledgeBaseForRental } from "./knowledge-base";
import { sanitizeSuggestion, AVOID_PHRASES_REMINDER } from "./sanitize-suggestion";
import { buildRentalPromptParts } from "./rental-prompt";
import { buildSalesPromptParts } from "./sales-prompt";
import { generateListingAcquisitionReply, isListingAcquisitionPipeline } from "./listing-acquisition-prompt";
import { matchProperties, availabilityForCriteria, describePropertiesByIds, type PropertyPick, type BrokerIntent } from "./property-catalog";
import { getMergedDialog } from "./merged-conversation";
import { db, pendingSuggestionsTable } from "@workspace/db";
import { eq, inArray, and } from "drizzle-orm";

/**
 * Every property this lead has ALREADY been shown, so a follow-up shortlist
 * surfaces different listings instead of re-sending ones they've seen (and
 * possibly already rejected).
 *
 * The conversation text is the authoritative source: whatever reached the lead
 * appears there as a /property/<ID> link regardless of which code path sent it
 * (mobile, extension, scheduler, Salesbot). Reading only pending_suggestions
 * attachments missed links sent through the other paths, and those leaked back
 * in via matchProperties' explicit-mention fast path — which sees a property ID
 * in the conversation and treats our own earlier link as the lead asking about
 * that listing, re-offering exactly what was just rejected.
 */
async function alreadySentPropertyIds(
  leadId: string,
  conversationText: string,
  /** The lead's OWN links are not something we sent them. Someone arriving from a
   * listing ad has that listing in their first message, and counting it as
   * "already shown" removed the one villa the whole enquiry was about — the
   * shortlist then came back empty. Pass the lead's text to subtract it. */
  leadOwnText?: string,
  /** But a lead quoting back a link WE sent — "is this one available?", "I like
   * this one" — is the normal, common way a listing comes up a second time over
   * WhatsApp. Subtracting every ID in the lead's text (above) treated that quote
   * exactly like an ad-lead's opening link, un-excluding a villa that genuinely
   * was already shown — it then came back as a "similar alternative" to a new
   * anchor and got re-attached as if fresh. Anything that also appears in what
   * WE sent stays excluded no matter what the lead echoes back. */
  ourSentText?: string,
): Promise<string[]> {
  const ids = new Set<string>();

  for (const m of conversationText.matchAll(/\/property\/([A-Za-z0-9-]+)/gi)) {
    if (m[1]) ids.add(m[1]);
  }

  if (leadOwnText) {
    const oursIds = new Set<string>();
    if (ourSentText) {
      for (const m of ourSentText.matchAll(/\/property\/([A-Za-z0-9-]+)/gi)) {
        if (m[1]) oursIds.add(m[1]);
      }
    }
    for (const m of leadOwnText.matchAll(/\/property\/([A-Za-z0-9-]+)/gi)) {
      if (m[1] && !oursIds.has(m[1])) ids.delete(m[1]);
    }
  }

  try {
    const rows = await db
      .select({ attachments: pendingSuggestionsTable.attachments })
      .from(pendingSuggestionsTable)
      .where(and(eq(pendingSuggestionsTable.leadId, leadId), inArray(pendingSuggestionsTable.status, ["approved", "edited"])));
    for (const r of rows) {
      for (const att of r.attachments ?? []) {
        if (att.type !== "link" || !att.url) continue;
        const m = att.url.match(/\/property\/([A-Za-z0-9-]+)/i);
        if (m?.[1]) ids.add(m[1]);
      }
    }
  } catch {
    // Conversation-derived ids above are enough to keep the shortlist fresh.
  }

  return [...ids];
}

/**
 * Once the lead has picked out a specific villa, attaching a fresh batch talks
 * straight over them at the most important moment in the conversation — so this
 * is enforced in code rather than left to the matching model, which was asked
 * not to and did it anyway.
 *
 * Two signals, both deterministic:
 *  - the lead's own recent message references a listing we already sent them
 *    (quoting the link back is how "I like this one" arrives over WhatsApp)
 *  - the CRM stage already says the conversation is past browsing
 */
/**
 * Quoting a listing back at us is only a "stop sending options" signal when the
 * lead LIKES it. Josua quoted the link we sent with "I really dont like the
 * floor" — a rejection — and the bot read the quote alone, sent no new options,
 * and promised to "come back shortly with the best options" instead. A rejection
 * is precisely when a fresh shortlist is wanted.
 */
const REJECTS_THE_LISTING =
  /(do ?n'?t|does ?n'?t|not) (like|love|work|suit|fit)|dislike|hate|too (expensive|pricey|small|big|far|dark|noisy|much)|not (for me|a fan|keen|what|quite)|something (else|different)|anything else|other options|не нравится|не подходит|не то\b|дорого|другие|другой|похуже|получше/i;

function shouldSkipNewListings(
  messages: ReturnType<typeof parseDialogContent>["messages"],
  alreadySentIds: string[],
  leadStage: string | null | undefined,
): boolean {
  const stage = (leadStage ?? "").toLowerCase();
  if (/viewing|zoom call|negotiat|reservation|contract signed|closed/.test(stage)) return true;

  if (alreadySentIds.length === 0) return false;
  const sent = new Set(alreadySentIds.map((id) => id.toUpperCase()));
  const recentLeadMessages = messages.filter((m) => m.from === "lead").slice(-3);

  for (const m of recentLeadMessages) {
    const text = (m.text ?? "").toUpperCase();
    if (![...sent].some((id) => text.includes(id))) continue;
    // They mentioned one of ours — the sentiment decides what to do next.
    if (REJECTS_THE_LISTING.test(m.text ?? "")) return false;
    return true;
  }
  return false;
}

/**
 * THE single place that decides which property links ride along with a reply.
 *
 * Exists because there are two generateSuggestion implementations (this lib and
 * amocrm-webhook.ts's own copy — the main LIVE path). The webhook copy called
 * matchProperties bare: no already-sent exclusion, no area/bedroom filter, no
 * "lead already picked one" gate. Result: the explicit-mention fast path saw OUR
 * OWN previously sent links quoted in the conversation and returned those exact
 * two listings every time, regardless of what the lead now wanted — which is
 * why every matching fix looked like it changed nothing. Both implementations
 * now call this and cannot drift apart again.
 */
export async function pickPropertyAttachments(opts: {
  leadId: string;
  brokerId: string | null;
  isRental: boolean;
  contentSnippet: string;
  dialogMessages: ReturnType<typeof parseDialogContent>["messages"];
  formattedDialog: string;
  lastLeadText: string;
  leadStage?: string | null;
  /** Card notes — used to spot an "Ad enquiry" lead on first contact. */
  leadNotes?: string | null;
  /** Set when the broker is revising an existing draft — see matchProperties. */
  brokerInstruction?: string | null;
  currentAttachmentIds?: string[];
  brokerIntent?: BrokerIntent | null;
  /**
   * The broker's opening on an ad lead that already got the welcome. The
   * welcome WAS the one-villa answer, so this message exists to widen: it
   * needs a shortlist, not the same listing again. Without this the
   * first-contact rule below capped the matcher at one property and the
   * message had nothing to offer.
   */
  openingAfterWelcome?: boolean;
}): Promise<GeneratedSuggestion["attachments"]> {
  try {
    const excludeIds = await alreadySentPropertyIds(
      opts.leadId,
      `${opts.contentSnippet}\n${opts.formattedDialog}`,
      opts.dialogMessages
        .filter((m) => m.from === "lead")
        .map((m) => m.text)
        .join("\n"),
      opts.dialogMessages
        .filter((m) => m.from === "us")
        .map((m) => m.text)
        .join("\n"),
    );
    // A broker asking for different links has overruled the "don't send more
    // options" gate — they are looking at the draft and telling us what to send.
    //
    // So has the broker's opening on an ad lead, for a subtler reason: the
    // "client message" naming one of our listings is the SEEDED enquiry we
    // wrote ourselves ("Hi! I saw this villa: .../property/R-YUD-046"), and the
    // welcome then sent that very link. The gate reads its own two footprints
    // as a client discussing a villa we sent and returns nothing — which is how
    // the opening on 23302661 ended up with a shortlist promise and no links
    // (2026-08-21). Widening is the entire job of this message.
    if (
      !opts.brokerInstruction &&
      !opts.openingAfterWelcome &&
      shouldSkipNewListings(opts.dialogMessages, excludeIds, opts.leadStage)
    ) {
      logger.info({ leadId: opts.leadId }, "property matcher skipped — lead is discussing listings already sent");
      return [];
    }
    // First reply to an ad lead: the advertised villa on its own. The usual
    // "always two or three" rule is about giving a choice to someone still
    // looking — this person already chose, and burying their villa among
    // alternatives is the opposite of listening.
    // Only the advertised villa on first contact — UNLESS their stated budget
    // says they cannot afford it. Then a single unaffordable link is the worst
    // possible first message, and they get real alternatives instead.
    // Core criteria the client typed into the ad form. Their own words in the
    // conversation still win — this only fills what they never said out loud.
    const card = await getLeadCardCriteria(opts.leadId).catch(() => null);
    const cardBudget = card?.budgetIdrMonthly ?? null;
    const adAffordable =
      !cardBudget ||
      !card ||
      (await (async () => {
        const m = /Ad enquiry:\s*([A-Z0-9-]+)/i.exec(opts.leadNotes ?? "");
        if (!m?.[1]) return true;
        const known = await describePropertiesByIds([m[1]]).catch(() => new Map());
        const hit = known.get(m[1].toUpperCase());
        if (!hit || typeof hit.priceIdr !== "number" || hit.priceIdr <= 0) return true;
        return hit.priceIdr <= Math.round(cardBudget * 1.15);
      })());

    const isFirstContactAdLead =
      !opts.openingAfterWelcome &&
      /Ad enquiry:/i.test(opts.leadNotes ?? "") &&
      opts.dialogMessages.filter((m) => m.from === "lead").length <= 1 &&
      adAffordable;

    // The card's answers first. When the Meta form left them blank, the villa
    // they clicked IS the request — its size, its area, its price are the only
    // thing this person has told us. Without this the matcher searched on
    // nothing and returned nothing, and the opening had no shortlist to offer.
    let matchCriteria = card
      ? { bedrooms: card.bedrooms, areas: card.areas, budgetIdrMonthly: card.budgetIdrMonthly }
      : null;
    // Per FIELD, not all-or-nothing: the form is often answered in part (a
    // budget but no area, an area but no size), and an all-or-nothing guard
    // left those gaps open — the search then had one criterion where it could
    // have had three. The card always wins where it has an answer.
    if (
      opts.openingAfterWelcome &&
      (!matchCriteria?.bedrooms || !matchCriteria?.areas?.length || !matchCriteria?.budgetIdrMonthly)
    ) {
      const adId = /Ad enquiry:\s*([A-Z0-9-]+)/i.exec(opts.leadNotes ?? "")?.[1];
      if (adId) {
        const fromListing = await criteriaFromListing(adId).catch(() => null);
        if (fromListing) {
          matchCriteria = {
            bedrooms: matchCriteria?.bedrooms ?? fromListing.bedrooms,
            areas: matchCriteria?.areas?.length ? matchCriteria.areas : fromListing.areas,
            budgetIdrMonthly: matchCriteria?.budgetIdrMonthly ?? fromListing.budgetIdrMonthly,
          };
          logger.info({ leadId: opts.leadId, adId, ...fromListing }, "opening: criteria taken from the clicked listing");
        }
      }
    }

    const picks = await matchProperties({
      listingType: opts.isRental ? "rent" : "sale",
      ...(isFirstContactAdLead ? { limit: 1 } : {}),
      conversationText: `${opts.formattedDialog}\n${opts.lastLeadText}`,
      brokerId: opts.brokerId,
      excludeIds,
      seenCount: excludeIds.length,
      latestLeadMessage: opts.lastLeadText,
      brokerInstruction: opts.brokerInstruction ?? null,
      currentAttachmentIds: opts.currentAttachmentIds ?? [],
      brokerIntent: opts.brokerIntent ?? null,
      cardCriteria: matchCriteria,
      // newest first — the criteria filter takes the most recent area/bedroom pin
      // The lead's OWN messages, newest first. The window used to be 5, which is
      // where a long conversation lost its own requirements: Josua agreed on
      // 3-4 bedrooms early, then talked style and budget, and by then the size
      // had scrolled out of view — so no bedroom filter applied at all and a 2BR
      // reached his shortlist. Newest-first still means a revision wins.
      recentLeadMessages: [
        opts.lastLeadText,
        ...opts.dialogMessages.filter((m) => m.from === "lead").slice(-25).reverse().map((m) => m.text),
      ].filter(Boolean),
    });
    const out = toAttachments(picks);
    // Silence here cost a client-facing lie: the opening on 23300773 said "here
    // are two more" with nothing attached, because an empty match and a thrown
    // match looked identical from outside (2026-08-21).
    if (out.length === 0) logger.info({ leadId: opts.leadId }, "property matcher returned nothing to attach");
    return out;
  } catch (err) {
    logger.warn({ err, leadId: opts.leadId }, "property matcher threw — sending the draft with no attachments");
    return [];
  }
}

export type GeneratedSuggestion = {
  text: string;
  attachments: Array<{ type: "link"; label: string; url: string }>;
};

function toAttachments(picks: PropertyPick[]): GeneratedSuggestion["attachments"] {
  return picks.map((p) => ({ type: "link" as const, label: p.label, url: p.url }));
}

/**
 * States the client's name as a fact for the prompt.
 *
 * Exported because there are two generateSuggestion implementations (this lib
 * and amocrm-webhook.ts's own copy, which serves regen and several webhook
 * paths). Adding the rule to only one meant replies still opened "Hi there" —
 * exactly how the property-matching fixes silently missed the main path.
 */
export function buildLeadNameRule(
  messages: ReturnType<typeof parseDialogContent>["messages"],
): string {
  const raw = messages.find(
    (m) => m.from === "lead" && m.senderName && m.senderName.trim().length > 1,
  )?.senderName;

  // "Nathan Craig (клиент - Facebook)" → "Nathan". Shared cleaner: the local
  // copy of this regex could not survive a name that itself contains brackets.
  const cleaned = cleanLeadName(raw) ?? "";
  const first = cleaned.split(/\s+/)[0] ?? "";
  const isPlaceholder = /^(lead|client|клиент|guest|user|wahelp|whatsapp|telegram|instagram|fb|ig|new)$/i.test(first);
  // A listing code is not a person. When a lead has no contact yet, the deal
  // name is all there is — and on an ad lead that name IS the listing, so the
  // bot opened with "Hi R-MER-004" (leads 23300773 and 23302889, 2026-08-21).
  // Better to greet nobody than to greet a property.
  const isListingCode = /^[A-Z]{1,4}-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(first);
  const name = !first || isPlaceholder || isListingCode ? "" : first;

  return name
    ? `\n\nTHE CLIENT'S NAME IS ${name}. OPEN THE MESSAGE WITH IT — "Hi ${name}, ..." — every time, whatever else the message has to do. Never open with "Hi there", never open straight into the answer with no greeting at all, and never drop the name because the message is short or urgent.`
    : `\n\nYou do NOT know this client's name. Do not invent one and do not use a placeholder — just open without a name.`;
}

/**
 * Every rule that has to be true of the final message but can't live in the
 * static system prompt: who the client is, what we actually have in stock, and
 * the fact that links ride along with this very message.
 *
 * Shared because there are two generateSuggestion implementations and each new
 * rule kept landing in only one of them — the name rule, then the inventory
 * check. Both call this now, so a rule added here cannot go missing on the
 * other path.
 */
/**
 * Makes the message agree with the links actually attached to it.
 *
 * The reply and the property matching run concurrently (serialising them cost
 * seconds on the broker's push), so the writer never knows what got picked. No
 * amount of prompt wording fixed this reliably: the draft kept ending in "want
 * me to send them over?" with three links already attached, or promised "a
 * solid option" in the singular. So the invariant is checked in code, and only
 * a message that actually contradicts its attachments pays for a rewrite —
 * the normal case costs nothing.
 */
const ASKS_OR_PROMISES_TO_SEND =
  /(want me to|shall i|should i|do you want me to)[^?]*\?|(send|get) (them|it|these|those) over|(i(?:'ll| will| can| could|'d)|let me)\s+(send|pull|line up|put together|share|forward|dig out|get|find|shortlist)|(get|send|have) (these|them|those|a few|a couple)[^.!?]{0,30}(to you|over|your way)|come back to you|отправ(лю|им|ить)|пришл(ю|ем|ать)|скину|подберу|подготовлю|могу подобрать/i;
/** "I have one villa that fits" — said while two or three links are attached. */
const CLAIMS_ONLY_ONE =
  /\b(one|a single|just one|1)\s+(villa|property|option|place|match|listing)\b|\b(a|one) (solid|good|strong)? ?option\b|\bодн[ау] (виллу|опци|вариант)/i;

/**
 * Hard guarantee on the output language.
 *
 * Prompt instructions were not enough, however absolute the wording: dictating an
 * edit in Russian still handed an English-speaking client a Russian message about
 * one run in two. So the invariant is checked in code — cheap, deterministic —
 * and only a message that actually came out in the wrong script pays for a fix.
 */
export async function enforceLanguage(text: string, required: string | null | undefined): Promise<string> {
  const want = (required ?? "").trim().toLowerCase();
  if (!want || !text) return text;

  const letters = (text.match(/[a-zA-Z\u0400-\u04FF]/g) ?? []).length;
  if (letters < 20) return text;
  const cyrillic = (text.match(/[\u0400-\u04FF]/g) ?? []).length;
  const cyrillicShare = cyrillic / letters;

  const wantsCyrillic = want.startsWith("rus") || want.startsWith("рус");
  const wrong = wantsCyrillic ? cyrillicShare < 0.3 : cyrillicShare > 0.15;
  if (!wrong) return text;

  try {
    const fixed = await chatCompletion({
      model: WRITER_MODEL,
      label: "language-fix",
      system: `Rewrite the WhatsApp message below in ${required}. Keep the meaning, the tone, the line breaks, the names, the numbers and the links EXACTLY as they are — only the language changes. Property names stay as written. Output only the rewritten message, nothing else.`,
      messages: [{ role: "user", content: text }],
      max_tokens: 500,
    });
    const out = sanitizeSuggestion(fixed.content);
    if (out.trim().length > 20) {
      logger.warn({ required, cyrillicShare: Number(cyrillicShare.toFixed(2)) }, "reply came out in the wrong language — translated back");
      return out;
    }
  } catch (err) {
    logger.warn({ err }, "language enforcement failed (keeping the draft)");
  }
  return text;
}

/**
 * ONE decision: the words and the links together.
 *
 * The old shape had three minds and none of them saw the whole picture — a
 * writer that read the broker's instruction, a matcher that read the catalog,
 * and code in the middle guessing the broker's intent from keywords. Every
 * guess needed another rule ("the word budget means filter" → "unless they're
 * asking FOR the budget" → "unless they said they'd send options later"), and
 * each rule left a gap at the next phrasing.
 *
 * Here the same mind that writes "tell me your budget and I'll find options"
 * decides that nothing is attached — because it is one thought, not two.
 *
 * What stays in code afterwards is only what is arithmetic or fact, never
 * judgement: the budget ceiling, listings with no price, duplicates, anything
 * the lead has already been shown, and links the broker curated by hand.
 */
export async function composeReplyWithListings(opts: {
  systemPrompt: string;
  conversation: string;
  brokerInstruction: string;
  /** Earlier instructions from THIS editing session. The owner corrected his
   * name in step one and watched step two revert it — each pass saw only the
   * newest feedback, so every earlier decision silently expired. */
  priorInstructions?: string[];
  currentDraft: string;
  currentAttachments: Array<{ id: string; label: string }>;
  /** True when the broker edited the link list themselves — a fact, not a guess. */
  attachmentsCurated: boolean;
  candidates: Array<{ id: string; line: string }>;
  language?: string | null;
}): Promise<{ text: string; listingIds: string[]; decision: "keep_current" | "none_this_message" | "new_selection" } | null> {
  const current = opts.currentAttachments.length
    ? opts.currentAttachments.map((a) => `${a.id} — ${a.label}`).join("\n")
    : "(none)";

  try {
    const result = await chatCompletionJSON<{
      message?: string;
      listing_ids?: string[];
      attachments_decision?: string;
    }>({
      model: WRITER_MODEL,
      label: "compose-edit",
      system: `${opts.systemPrompt}

──────────────────────────────────────────
THE BROKER'S INSTRUCTION IS THE HIGHEST AUTHORITY HERE.

You are revising a draft the broker has read and rejected. Everything above —
tone rules, structure rules, stage rules, CTA rules — is the DEFAULT, for when
nobody is steering. The broker is steering now. Where their instruction
conflicts with any rule above, the instruction wins, completely, not partially.
Half-obeying an instruction is the one unforgivable failure in this task.

You decide BOTH things as one decision: the message text AND which property
links go with it (listing_ids).
${
        (opts.priorInstructions ?? []).length > 0
          ? `\nInstructions the broker ALREADY gave while editing this same message — every one of them still stands; the newest instruction adds to them and never silently undoes them:\n${opts
              .priorInstructions!.map((i) => `- ${i}`)
              .join("\n")}\n`
          : ""
      }

Currently attached to the draft:
${current}
${
        opts.attachmentsCurated
          ? "\nThe broker picked this list BY HAND earlier. Keep it exactly — unless their new instruction below says to change it, in which case the new instruction wins."
          : ""
      }

Properties you may attach (pick by ID; attaching NONE is a normal answer):
${opts.candidates.map((c) => c.line).join("\n")}

First decide attachments_decision — ONE of exactly these three, by MEANING, not keywords:
- "keep_current" — the instruction is about wording only (shorter, warmer, translate, fix tone). listing_ids = exactly what is currently attached.
- "none_this_message" — the point of this message is something other than offering properties: asking the client something first with options to come AFTER they answer, collecting feedback on options already sent, arranging a viewing, nudging a quiet lead. listing_ids = []. This holds even when a villa the CLIENT themselves named is the whole subject of the message ("let me check on that one with the owner") — the client already has that link, they do not need it back, and re-sending it is not what the broker asked for. Attach it ONLY if the BROKER'S INSTRUCTION itself says to send, attach, share, or confirm a link — never because the text happens to talk about a specific villa.
- "new_selection" — the broker wants different/other/cheaper properties, or names listings to add or remove. listing_ids = the new set, picked from the list.

When in doubt between "none_this_message" and "new_selection", choose "none_this_message" — attaching villas to a message whose text is a question about the future is the single most complained-about failure of this system.

If the broker's instruction says to SEND OPTIONS, any stage rule above that says "do not send listings yet" is overridden — the broker outranks the stage script. Do not re-ask the client's requirements when the broker just told you to act on them: their requirements are already in the conversation, read them from there.

Facts you never break (these are facts, not style, and the broker is not asking you to lie):
- Never attribute to the client anything they have not actually said in the conversation. If they never stated a budget, do not write "your budget"; if they never said they liked something, do not write "you liked". Check the conversation before referencing any such fact — invented agreement reads as not listening at all.
- A listing whose line says "price on request" has no published price. Never state or estimate a number for it — say you will confirm the exact rate with the owner.
- Never invent demand ("very popular", "going fast").
- Never write URLs in the message body — every attached link is delivered as its own WhatsApp message. Refer to "the link below".
- Never write internal codes (R-YUD-018, UP-1001) in the text — use the villa's name.
- The message must talk about what is attached and nothing else: no describing a villa you did not attach.

Language: write in ${opts.language ?? "the language the CLIENT writes in"} — unless the broker's instruction explicitly asks for another language, in which case obey the broker.

Respond with JSON only: {"message": "<the WhatsApp message>", "attachments_decision": "keep_current|none_this_message|new_selection", "listing_ids": ["ID", ...]}`,
      messages: [
        {
          role: "user",
          content: `Conversation so far:\n${conversationWindow(opts.conversation)}\n\nCurrent draft:\n${opts.currentDraft}\n\nTHE BROKER'S INSTRUCTION:\n"${opts.brokerInstruction}"`,
        },
      ],
      max_tokens: 900,
    });

    const text = sanitizeSuggestion(result.message ?? "");
    if (text.trim().length < 10) return null;
    const ids = (result.listing_ids ?? []).map((i) => String(i).toUpperCase());
    const d = String(result.attachments_decision ?? "").trim();
    const decision =
      d === "keep_current" || d === "none_this_message" || d === "new_selection"
        ? d
        : ids.length === 0
          ? ("none_this_message" as const)
          : ("new_selection" as const);
    return { text, listingIds: ids, decision };
  } catch (err) {
    logger.warn({ err }, "composeReplyWithListings failed — falling back to the split path");
    return null;
  }
}
/**
 * Does the message actually talk about ANY of the villas attached to it?
 *
 * The writer and the matcher run concurrently, so a first-touch draft could ask
 * a pure qualifying question while three links rode along "прикрученные" — the
 * owner's words. A message referencing none of its own attachments is broken by
 * definition, whatever produced it.
 */
const GENERIC_TITLE_WORDS = new Set([
  "villa", "villas", "bedroom", "bedrooms", "rental", "rent", "yearly", "monthly",
  "long", "term", "long-term", "for", "in", "with", "the", "and", "brand", "new",
  "house", "family", "private", "premium", "spacious", "bali",
]);

/** Strict variant: EVERY attachment must be referenced — a hand-curated panel
 * of four where the text lists three reads as the fourth being ignored, which
 * is exactly the owner's screenshot. */
export function textMentionsEveryAttachment(
  text: string,
  attachments: Array<{ label?: string }>,
): boolean {
  return attachments.every((a) => textMentionsAnyAttachment(text, [a]));
}

export function textMentionsAnyAttachment(
  text: string,
  attachments: Array<{ label?: string }>,
): boolean {
  if (attachments.length === 0) return true;
  const t = (text ?? "").toLowerCase();
  // Any one shared word used to be enough — and "rental" is in nearly every
  // title, so a text describing Pererenan and Tumbak Bayuh "matched" links to
  // Kerobokan and Balangan (Ekaterina, Rori, 2026-08-31). The client reads one
  // place and opens another. The area is the one word that cannot be generic:
  // every attached villa's area must be named in the text, or the text is
  // about villas that are not attached.
  for (const a of attachments) {
    const inParens = /\(([^,)]+)/.exec(a.label ?? "")?.[1]?.trim().toLowerCase() ?? "";
    const area = inParens.split(/\s*,\s*/)[0] ?? "";
    if (area && area.length > 3 && !t.includes(area)) return false;
  }
  for (const a of attachments) {
    const title = (a.label ?? "").split(" (")[0] ?? "";
    const words = title
      .toLowerCase()
      .split(/[^a-zа-яё0-9]+/)
      .filter((w) => w.length > 3 && !GENERIC_TITLE_WORDS.has(w));
    if (words.some((w) => t.includes(w))) return true;
  }
  return false;
}

/**
 * Phrasings that present villas as arriving WITH this message.
 *
 * A pre-filter only — deliberately loose, because it is allowed to be wrong in
 * one direction: everything it catches is judged properly by the model below.
 * What it must never do is miss "would you consider any of these?", which is
 * exactly what reached a client with nothing under it.
 */
const OFFERS_LISTINGS_NOW =
  /here (are|is|'s)\b|\b(link|links|option|options|villa|villas|listing|listings|one)s?\s+(below|attached)\b|\bbelow\b|\battached\b|\b(any|one|either|some) of (these|them)\b|\bthese (options|villas|properties|listings|three|two)\b|\bi (?:have |'ve )?(?:picked|pulled|put together|lined up|got) (?:a few|three|two|some|these)|\bвот\b|\bниже\b|прилага|подобрал|скинул|отправляю|berikut|di bawah|ini beberapa|saya kirim/i;

/**
 * THE invariant, in the one place every path already passes through: a message
 * must never present villas that are not attached to it.
 *
 * The text and the links are ONE message — split into several WhatsApp bubbles
 * only so a preview renders for each. So "the text offers options" and "the
 * options are attached" cannot disagree, and which tab produced the draft (LIVE,
 * PUSH, an ad-lead opening, a broker revision) has nothing to do with it. Every
 * caller of reconcileTextWithAttachments used to get an early `return text` the
 * moment the list was empty — the one case where the message can lie.
 *
 * The regex only decides whether to ask. The model decides whether the message
 * is OFFERING villas now (must be repaired) or merely REFERRING BACK to ones the
 * client already has ("the two I sent last week"), which is normal and correct.
 */
async function stripUnbackedListingOffer(text: string): Promise<string> {
  if (!text || !OFFERS_LISTINGS_NOW.test(text)) return text;
  try {
    const fixed = await chatCompletion({
      model: WRITER_MODEL,
      label: "unbacked-offer",
      system: `You check one WhatsApp message a broker is about to send a client.

NO property links are attached to it. Nothing will arrive after it.

First decide which of these the message is doing:
(A) It presents villas as being HERE — "here are three", "the link below", "any of these?", a numbered list of properties. The client would look for something that never comes.
(B) It only refers BACK to villas already sent earlier, or asks a question, or mentions no properties at all. Nothing is missing.

If (B): return the message EXACTLY as given, character for character.

If (A): rewrite it so it no longer presents or promises any property. Keep the same language, the same voice, the same length and the same closing question if that question is not about sending links. Do not replace the offer with a promise to send options later — say nothing about listings at all. Referring to villas the client already received is fine and should be kept.

Your entire output is the message. No preamble, no explanation.`,
      messages: [{ role: "user", content: text }],
      max_tokens: 400,
    });
    const out = sanitizeSuggestion(fixed.content);
    if (out.trim().length > 15 && out.trim() !== text.trim()) {
      logger.info({}, "message offered villas that were not attached — the offer was removed");
      return out;
    }
  } catch (err) {
    logger.warn({ err }, "unbacked-offer check failed (non-fatal, keeping the draft)");
  }
  return text;
}

export async function reconcileTextWithAttachments(
  text: string,
  attachments: GeneratedSuggestion["attachments"],
  /** Set when the links have just CHANGED under an existing draft (a broker
   * revision). The text was written against the old ones, so it has to be
   * re-checked whether or not it trips a pattern — it claimed three villas
   * "all sit around your 30 million budget" after they had been swapped. */
  force = false,
  /** The client's stated monthly budget in rupiah, when known. */
  budgetIdr?: number | null,
  /** The language the message must be in. "Same language" as an instruction was
   * too weak — this step silently returned a Russian message for an
   * English-speaking client, so the target is now stated outright. */
  language?: string | null,
): Promise<string> {
  // Nothing attached is precisely when the message is free to lie — see above.
  if (attachments.length === 0) return stripUnbackedListingOffer(text);
  // A quoted figure for a listing whose price nobody has filled in is a made-up
  // number going to a client. Checked in code, not hoped for: the prompt already
  // said never to invent a price and it did anyway.
  const unpricedLabels = attachments
    .filter((a) => /price on request/i.test(a.label ?? ""))
    .map((a) => (a.label ?? "").split(" (")[0]);
  const QUOTES_MONEY = /\d[\d.,\s]{2,}\s*(idr|rp\b|million|jt\b|juta)|rp\.?\s*\d/i;
  const invents = unpricedLabels.length > 0 && QUOTES_MONEY.test(text);

  // A villa that is still occupied carries "free from <date>" on its label. The
  // reply is written CONCURRENTLY with the matching, so the writer cannot know
  // it was picked — which is exactly why this step exists. Presenting such a
  // villa as ready now is the same class of error as promising links that are
  // already attached: the client finds out only after choosing it.
  const datedLabels = attachments
    .map((a) => a.label ?? "")
    .filter((l) => /free from /i.test(l));
  const SAYS_A_DATE = /\bfree from\b|\bavailable from\b|\bfrees up\b|\bfrom the \d/i;
  const hidesMoveInDate = datedLabels.length > 0 && !SAYS_A_DATE.test(text);

  const contradicts =
    force ||
    invents ||
    hidesMoveInDate ||
    ASKS_OR_PROMISES_TO_SEND.test(text) ||
    (attachments.length > 1 && CLAIMS_ONLY_ONE.test(text)) ||
    !textMentionsAnyAttachment(text, attachments);
  if (!contradicts) return text;

  const list = attachments.map((a, i) => `${i + 1}. ${a.label ?? a.url}`).join("\n");
  // Deliberately NOT told the budget. Given it, this step kept making arithmetic
  // claims that were wrong ("both sit above the 63 million you mentioned" with one
  // at 55). Its job is making the words match the links; budget honesty belongs to
  // the main prompt, which has the inventory and the numbers.
  const budgetLine = "";
  try {
    const fixed = await chatCompletion({
      model: WRITER_MODEL,
      label: "reconcile",
      system: `You correct one specific inconsistency in a WhatsApp message a broker is about to send.

These ${attachments.length} property links are attached to that exact message and will arrive with it:
${list}${budgetLine}${
    unpricedLabels.length > 0
      ? `\n\nTHESE HAVE NO PUBLISHED PRICE (their label says "price on request"): ${unpricedLabels.join("; ")}. You do NOT know what they cost. Remove any figure, range or estimate for them from the message and say plainly that you will confirm the exact rate with the owner. Inventing a number here would be quoted back at us.`
      : ""
  }${
    datedLabels.length > 0
      ? `\n\nTHESE ARE NOT FREE YET — their label says "free from <date>": ${datedLabels.join("; ")}. Say that date in plain words for each of them ("this one frees up on 29 August"). Presenting them as available now is the one thing this message must not do.`
      : ""
  }

Rewrite the message so it matches that reality:
- Present the listings as being right here. Name each one as it is written above and say which area it is in — the names and areas above are the truth, never a place the client asked for but that isn't on the list. "a villa in Canggu, another villa in Canggu" is not naming them.
- Delete any question asking permission to send them, and any promise to send something later.
- The prices above are the real ones — quote them as given and never invent one. Never invent demand either: no "popular", "in high demand", "going fast", "lots of interest". Do NOT add any claim about whether they fit the client's budget: state the price and let them judge.
- No email-style sign-off. This is WhatsApp: no "Best," and no name at the end.
- Never write an internal listing code (R-YUD-018, UP-1001). If a listing above shows only a code and no name, describe it plainly ("the 3-bedroom villa in Canggu") instead.
- NO URLs inside the text. The property links are attached below and each is delivered as its own WhatsApp message — writing a link (or a catalog/browse link) under every villa duplicates them and looks broken. At most ONE general browse link at the very end, and only if the draft already had it.
- Change NOTHING else: same voice, same length, same closing question if it isn't about sending links.
- WRITE IN ${language ? language.toUpperCase() : "THE SAME LANGUAGE AS THE MESSAGE BELOW"}. This is absolute. The broker's instructions may be in another language; that never changes the language the client is written to.

Your entire output IS the WhatsApp message to the CLIENT. Never address the broker, never ask for more details, never explain what you are missing — if a listing's details look incomplete, write around it and keep the message natural. A question back to the broker would be sent to the client as-is.

Output only the corrected message.`,
      messages: [{ role: "user", content: text }],
      max_tokens: 400,
    });
    const out = sanitizeSuggestion(fixed.content);
    if (out.trim().length > 20) {
      logger.info({ attachments: attachments.length }, "reconciled the reply with its attachments");
      return out;
    }
  } catch (err) {
    logger.warn({ err }, "attachment reconciliation failed (non-fatal, keeping the draft)");
  }
  return text;
}

export async function buildPromptAdditions(opts: {
  isRental: boolean;
  dialogMessages: ReturnType<typeof parseDialogContent>["messages"];
  lastLeadText?: string | null;
  /** Card notes — carries the "Ad enquiry: <ID> — <title>" marker for a lead that
   * arrived by clicking a listing ad. */
  leadNotes?: string | null;
  /** Whose voice this is — resolves the SIGNING name and their learned preferences. */
  responsibleUser?: string | null;
  /** Needed to read the lead card's own fields (the ad form's answers). */
  leadId?: string | null;
  /** For situational lesson injection — which moment this draft is written in. */
  leadStage?: string | null;
  kind?: string | null;
  /**
   * True when this draft is the broker's opening on an ad lead that ALREADY
   * received the automatic welcome. Two rules below were written when this
   * draft was the first thing the client heard — they say to name the villa
   * they clicked, hand over its link, and ask when they are moving in. The
   * welcome now does exactly that, so leaving them on makes the broker's first
   * message a verbatim repeat of a message sent fifteen minutes earlier.
   */
  openingAfterWelcome?: boolean;
}): Promise<string> {
  const recentLeadMessages = [
    opts.lastLeadText ?? "",
    ...opts.dialogMessages.filter((m) => m.from === "lead").slice(-25).reverse().map((m) => m.text),
  ].filter(Boolean);

  // What we can actually offer for what they asked — computed from the cached
  // catalog with no AI call, so the reply is written KNOWING the answer instead
  // of promising a shortlist that doesn't exist. (A lead asking "Seminyak only"
  // got "I've got a few in mind" while the catalog held zero Seminyak listings:
  // the matcher knew, the message didn't, because the two run in parallel.)
  const stock = await availabilityForCriteria({
    listingType: opts.isRental ? "rent" : "sale",
    recentLeadMessages,
  }).catch(() => null);

  // The links are attached to THIS message, so asking "want me to send them?"
  // sends the question and the answer together and makes the bot look broken.
  const attachedRule =
    `\n\nNO SIGN-OFF. This is WhatsApp, not email: never end with your name, "Best", "Regards" or anything like it. The client sees who is writing.` +
    `\n\nNEVER write an internal listing code (R-YUD-018, UP-1001 and the like) in the message — it is our catalog reference, meaningless to the client and it reads like a database record. Use the villa's name.` +
    `\n\nNO URLS IN THE TEXT: every attached property link is delivered as its own separate WhatsApp message right after this one — never write property or catalog URLs inside the message body itself.` +
    `\n\nTHE LINKS GO OUT WITH THIS MESSAGE. When a shortlist is being sent, two or three property links are attached to this exact message automatically — they are already below your text. So present them ("here are three that fit"), never ask permission to send them and never promise them for later. The one exception is when the client has already settled on a specific villa: then no options are sent and you move to the viewing instead.`;

  // A client who arrives naming ONE villa ("I saw your ad for R-YUD-038") is not
  // asking for a shortlist. The matcher now attaches only that villa, but the
  // text is written CONCURRENTLY with the matching, so without this the model
  // still opens with "Here are a few options for you:" and lists three — which
  // is exactly what the client got (lead 23279935, 2026-08-19). Tell the writer
  // what the client actually came in on.
  const anchorIds = Array.from(
    new Set(
      recentLeadMessages
        .flatMap((m) => Array.from(String(m).matchAll(/\/property\/([A-Za-z0-9-]+)|\b(R-[A-Z]+-\d+)\b/gi)))
        .map((x) => (x[1] ?? x[2] ?? "").toUpperCase())
        .filter(Boolean),
    ),
  );
  let anchorLine = "";
  if (anchorIds.length > 0 && !opts.openingAfterWelcome) {
    try {
      const known = await describePropertiesByIds(anchorIds);
      const hit = anchorIds.map((id) => known.get(id)).find(Boolean);
      if (hit) {
        anchorLine =
          `\n\nTHIS CLIENT CAME IN ABOUT ONE SPECIFIC VILLA: "${hit.title}". That is the villa attached to this message — the only one.` +
          ` Answer about IT: confirm it is available and say what it costs. Do NOT present a list, do NOT open with "here are a few options",` +
          ` and do NOT offer alternatives they did not ask for — they already chose what they want to see.` +
          ` Then ask only for what is genuinely missing to move forward (budget if they left it blank, move-in date, how long they need it).` +
          ` This does not change the greeting: still open with their name.`;
      }
    } catch { /* no anchor line is better than a failed draft */ }
  }

  const stockLine = stock
    ? stock.matching > 0
      ? `\n\nINVENTORY CHECK (true right now): ${stock.matching} listing(s) match what they asked for${stock.areas.length ? ` in ${stock.areas.join("/")}` : ""}.`
      : `\n\nINVENTORY CHECK (true right now): NOTHING in the catalog is${stock.areas.length ? ` in ${stock.areas.join("/")}` : " a match for their criteria"}${stock.bedrooms ? ` at ${stock.bedrooms} bedrooms` : ""}. Say that plainly — do not imply we have what they asked for.${stock.nearbyAreas.length ? ` The same size IS available in ${stock.nearbyAreas.join(", ")}, and those are the listings attached here: name the area each one is actually in, and let them decide. Being straight about it is what keeps their trust.` : ""}`
    : "";

  // Bali rents in rupiah — the catalog now carries the rupiah figure itself, so
  // there is nothing to convert and nothing to hedge about. The bot used to
  // quote dollars at a client budgeting in juta purely because the code read
  // only the *_usd columns.
  const currencyRule = opts.isRental
    ? `\n\nPRICES ARE IN RUPIAH. The catalog figures for rentals are already the real rupiah price (shown as "Rp 88 jt/mo" — 88 million per month). Quote them exactly as given, in rupiah. Never convert to dollars, never state a dollar figure, and never invent a price for a listing that has none.`
    : "";

  // A lead who clicked a listing ad has told us exactly one thing: which villa
  // caught their eye. The first reply should answer that and nothing else — thank
  // them, name the villa, hand over the link with the details, ask ONE thing.
  const adMatch = /Ad enquiry:\s*([A-Z0-9-]+)\s*—\s*(.+)/i.exec(opts.leadNotes ?? "");
  const cardForAd = await getLeadCardCriteria(opts.leadId ?? "").catch(() => null);
  const adBudgetNote =
    cardForAd?.budgetIdrMonthly
      ? `\n\nTHEY TOLD THE FORM THEIR BUDGET: ${Math.round(cardForAd.budgetIdrMonthly / 1_000_000)} million rupiah a month. If the villa they clicked costs more than that, say so kindly and early — do not pretend it fits — and point them at what does. Their money is the more reliable signal of the two.`
      : "";
  const adRule =
    adMatch && !opts.openingAfterWelcome && opts.dialogMessages.filter((m) => m.from === "lead").length <= 1
      ? `\n\nTHIS PERSON CAME FROM AN AD FOR ONE SPECIFIC VILLA: "${adMatch[2]!.trim()}". That is their entire enquiry — they have not told you dates, budget or anything else. Write the first message like a person who just got their enquiry:\n- greet them by name and thank them for reaching out;\n- say you can see which villa caught their eye and NAME IT exactly as written above;\n- tell them the link below has the full details — photos, the location on the map, what's included;\n- then ONE question, the one that decides everything: when they are looking to move in and for how long.\nDo NOT offer alternative villas in this first message. They came for this one; suggesting others straight away reads as not having listened.
- Never claim the villa is popular, in demand, "getting a lot of interest" or going fast. You have no such information, and this one had a single view. An invented pressure line is the fastest way to lose a serious client.`
      : "";

  // Who is writing, by their real name — never the login. "HoS" signed messages
  // because the account label leaked into the prompt as if it were a person.
  const displayName = brokerDisplayName(opts.responsibleUser);
  const identityRule = displayName
    ? `\n\nYOU ARE WRITING AS ${displayName}. If you introduce yourself or sign anywhere, that is the only name you use — never an account label like "HoS".`
    : "";

  // What the broker has taught on earlier edits. This is the other half of
  // "the bot never learns": lessons were saved but only the revision endpoint
  // read them, so every fresh draft ignored them. Narrowed to THIS moment's
  // lessons (plus universal style) — a rule dictated on an owner conversation
  // must not steer a first client contact.
  const learned = await correctionsPromptBlock(
    opts.responsibleUser,
    deriveSituation({
      pipeline: opts.isRental ? "rental" : null,
      kind: opts.kind,
      leadStage: opts.leadStage,
      lastLeadText: opts.lastLeadText,
      isFirstContact: opts.dialogMessages.filter((m) => m.from === "lead").length === 0,
    }),
  );

  return buildLeadNameRule(opts.dialogMessages) + attachedRule + anchorLine + stockLine + currencyRule + adRule + identityRule + learned;
}

export async function generateSuggestion(opts: {
  leadId: string;
  responsibleUser: string | null;
  kind: "live" | "push";
  lastLeadMessage: string;
  contentSnippet: string;
  leadNotes?: string | null;
  leadStage?: string | null;
  isFirstContact?: boolean;
  /** Pre-built corrections block to inject into system prompt */
  correctionsBlock?: string;
  /** "rental" swaps in the villa-rental prompt/qualifying logic instead of the Sales one */
  pipeline?: string | null;
  /**
   * Replaces the qualifying-ladder task for a caller whose message is not a
   * reply in an ongoing conversation. The ladder counts lead messages and asks
   * the next question in a fixed order, which is right when a client is
   * actually talking and wrong when we are opening on their behalf: a seeded
   * ad enquiry is exactly one lead message, so the ladder always produced
   * "when are you moving in" no matter what the client had already told the
   * Meta form. Conversation, timing and lead-card context are still supplied —
   * only the task is the caller's.
   */
  taskBrief?: string;
}): Promise<GeneratedSuggestion> {
  // Rental Listings (acquiring rental listings from owners/agents) is a
  // different conversation entirely — no property matching, no client
  // qualifying logic. Own module so it can't fall through to the sales/
  // Unicorn branch below, which would pitch villas to the owner instead of
  // asking to manage theirs. Mirrored in routes/amocrm-webhook.ts's own
  // generateSuggestion — see its top for why there are two.
  if (isListingAcquisitionPipeline(opts.pipeline)) {
    const { text } = await generateListingAcquisitionReply(opts);
    return { text, attachments: [] };
  }

  const isRental = (opts.pipeline ?? "").toLowerCase() === "rental";

  const [kb] = await Promise.all([
    getKnowledgeBase(),
  ]);

  const brokerPicksBlock = "";
  const catalog = "";

  // Rental splits its prompt: the rulebook and the knowledge base are the same
  // ~9,000 tokens for every lead and get cached; only the stage and the lessons
  // the broker taught ride along uncached.
  // Rental gets the knowledge base narrowed to what a renting client can use —
  // the sales half (leasehold, ROI, developers, buyer objections) is not just
  // dead weight in a rental conversation, it pulls the bot toward selling.
  const rentalParts = isRental
    ? buildRentalPromptParts({
        leadStage: opts.leadStage,
        kb: filterKnowledgeBaseForRental(kb),
        correctionsBlock: opts.correctionsBlock,
      })
    : null;
  // Sales splits its prompt the same way — rules + knowledge base cached,
  // stage + lessons per lead. Both funnels now share one copy of their prompt.
  const salesParts = rentalParts
    ? null
    : buildSalesPromptParts({
        leadStage: opts.leadStage,
        kb,
        correctionsBlock: opts.correctionsBlock,
        brokerPicksBlock,
        catalog,
      });
  const cachePrefix = rentalParts ? rentalParts.prefix : salesParts!.prefix;
  const systemPrompt = rentalParts ? rentalParts.tail : salesParts!.tail;
  // leads_sync.content alone is NOT the conversation — it freezes for whole
  // channels, most reliably the broker's own WhatsApp replies typed on their
  // phone. Writing the draft off it produced messages that talked over villas
  // the broker had already sent by hand (lead 23303055, 26.08). Merge in the
  // timeline poll and our own send record before a single word is written.
  const dialog = await getMergedDialog(opts.leadId, opts.contentSnippet);
  const formattedDialog = formatDialogForAI(dialog.messages, 500, true);
  const timingSummary = describeConversationTiming(dialog.messages);
  const lastLeadText = opts.lastLeadMessage.trim() || dialog.lastLeadMessage?.text || "";
  const lastBrokerText = dialog.lastOurMessage?.text ?? "";

  // Shared timing-awareness guidance injected into every non-first-contact task
  // so the AI calibrates to how long it's actually been, not just message order.
  const timingGuidance = `TIMING AWARENESS (read the timestamps — do not treat an old exchange as if it just happened):
- If the last interaction was recent (hours/days): reply naturally in-thread.
- If it has been weeks or months: acknowledge the gap honestly ("it's been a while") instead of pretending no time passed. Do not reference dates, trips, seasons or deadlines from old messages as if still current — they may have passed.
- Judge whether the lead's last message actually needed a reply: a bare closer ("ok thanks", "see you", 👍) did not, so don't over-apologize; but a real unanswered question or expressed interest left hanging for a long time should be addressed gracefully — light acknowledgment of the delay, then real value.`;

  const leadContext = opts.leadNotes?.trim()
    ? `\nLEAD CARD INFO (name, budget, notes from broker):\n${opts.leadNotes.trim()}\n`
    : "";

  const prompt =
    opts.taskBrief
      ? `FULL CONVERSATION (each line timestamped, oldest → newest):
${formattedDialog}

TIMING:
${timingSummary}
${leadContext}
Broker: ${opts.responsibleUser ?? "Broker"}

${opts.taskBrief}${AVOID_PHRASES_REMINDER}`
      : opts.isFirstContact
      ? `${leadContext}
SITUATION: This lead was just assigned to you. You have not spoken with them before. No prior conversation.

Broker: ${opts.responsibleUser ?? "Broker"}

Task: Write the broker's opening WhatsApp message — a warm, direct first introduction.
- Max 3 sentences.
- Introduce yourself briefly as ${isRental ? "a Bali villa rental specialist" : "a Bali real estate advisor"} at Unicorn Property.
- End with ONE simple, open question to understand their interest (${isRental ? "dates? how long? how many guests?" : "investment? personal use? area? budget?"}).
- Do NOT list properties yet.
- Under 60 words.${AVOID_PHRASES_REMINDER}`
      : opts.kind === "live"
      ? `FULL CONVERSATION (each line timestamped, oldest → newest):
${formattedDialog}

TIMING:
${timingSummary}

${timingGuidance}
${leadContext}
SITUATION: The lead just replied. Their latest message:
"${lastLeadText}"

Broker: ${opts.responsibleUser ?? "Broker"}

Task: Write the broker's next WhatsApp reply. React directly to what the lead just said.

STEP 1 — COUNT LEAD MESSAGES in the conversation above (lines starting with [Lead]).
STEP 2 — APPLY THIS RULE, no exceptions:

${isRental ? `  • Lead has sent 1 message → ask ONE question: check-in/check-out dates and number of guests?
  • Lead has sent 2 messages → ask ONE question: budget per month/night, and short-term or long-term stay?
  • Lead has sent 3 or more messages → DO NOT ask any qualifying question.
    The lead has engaged enough. Write a message that: (1) briefly confirms what you understood, (2) offers to prepare a curated shortlist. Example CTA: "I've got a few that could work well for this, want me to send them over?"

This rule is absolute. Even if area or exact size is unknown — at 3+ lead messages, move forward.` : `  • Lead has sent 1 message → ask ONE question: investment or personal use?
  • Lead has sent 2 messages → ask ONE question: villas or other property type?
  • Lead has sent 3 or more messages → DO NOT ask any qualifying question.
    The lead has engaged enough. Write a message that: (1) briefly confirms what you understood, (2) adds one short market insight, (3) offers to prepare a curated shortlist. Example CTA: "I have a few options that match well — want me to send them over?"

This rule is absolute. Even if budget or area is unknown — at 3+ lead messages, move forward. Budget and area are discovered through the options, not through more questions.`}

IMPORTANT: Do NOT include any property links or listings in this reply. The broker will personally choose and share properties when ready.
Only suggest an in-person meeting if the lead explicitly mentioned being in Bali.

Under 90 words.${AVOID_PHRASES_REMINDER}`
      : `FULL CONVERSATION (each line timestamped, oldest → newest):
${formattedDialog}

TIMING:
${timingSummary}

${timingGuidance}
${leadContext}
SITUATION: The broker's last message was:
"${lastBrokerText}"
The lead has NOT replied to this message yet.

Broker: ${opts.responsibleUser ?? "Broker"}

Task: Write a short follow-up. The lead hasn't responded — re-engage without repeating the same message. Use any lead card info above to personalise. Let the timing above guide tone: a long silence after a message that did not need a reply is normal (re-engage fresh); a long silence after the lead's real question went unanswered should be acknowledged gracefully.

IMPORTANT: Do NOT include property links or listings in this follow-up. The broker will personally select and share properties when ready. Your job is to re-engage naturally — add value, reference something they said earlier, or propose a low-effort next step.

Under 100 words.${AVOID_PHRASES_REMINDER}`;

  const promptAdditions = await buildPromptAdditions({
    isRental,
    dialogMessages: dialog.messages,
    lastLeadText,
    leadNotes: opts.leadNotes ?? null,
    responsibleUser: opts.responsibleUser ?? null,
    leadId: opts.leadId,
    leadStage: opts.leadStage ?? null,
    kind: opts.kind,
    openingAfterWelcome: Boolean(opts.taskBrief),
  });

  // Property matching only needs the conversation, not our reply — so it runs
  // CONCURRENTLY with writing the reply instead of after it. Serialising these
  // two AI round-trips was adding seconds of dead time before the broker's
  // push notification could fire.
  // Exclusion reads the RAW content too — formatDialogForAI truncates, and a
  // link sent long ago still counts as "already shown to this lead".
  const [completion, attachments] = await Promise.all([
    chatCompletion({
      model: WRITER_MODEL,
      label: "draft",
      system: systemPrompt,
      ...(cachePrefix ? { cachePrefix } : {}),
      messages: [{ role: "user", content: prompt + promptAdditions }],
      max_tokens: 400,
    }),
    pickPropertyAttachments({
      leadId: opts.leadId,
      brokerId: opts.responsibleUser,
      isRental,
      contentSnippet: opts.contentSnippet,
      dialogMessages: dialog.messages,
      formattedDialog,
      lastLeadText,
      leadStage: opts.leadStage,
      leadNotes: opts.leadNotes ?? null,
      openingAfterWelcome: Boolean(opts.taskBrief),
    }),
  ]);

  const text = await reconcileTextWithAttachments(sanitizeSuggestion(completion.content), attachments);

  return { text, attachments };
}
