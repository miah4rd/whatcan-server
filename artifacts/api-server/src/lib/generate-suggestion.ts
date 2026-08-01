import { chatCompletion, chatCompletionJSON, WRITER_MODEL } from "./ai-client";
import { brokerDisplayName } from "./broker-identity";
import { correctionsPromptBlock } from "./broker-corrections";
import { logger } from "./logger";
import { parseDialogContent, formatDialogForAI, describeConversationTiming, conversationWindow } from "./dialog-parser";
import { getKnowledgeBase } from "./knowledge-base";
import { sanitizeSuggestion, AVOID_PHRASES_REMINDER } from "./sanitize-suggestion";
import { buildRentalSystemPrompt } from "./rental-prompt";
import { matchProperties, availabilityForCriteria, type PropertyPick, type BrokerIntent } from "./property-catalog";
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
): Promise<string[]> {
  const ids = new Set<string>();

  for (const m of conversationText.matchAll(/\/property\/([A-Za-z0-9-]+)/gi)) {
    if (m[1]) ids.add(m[1]);
  }

  if (leadOwnText) {
    for (const m of leadOwnText.matchAll(/\/property\/([A-Za-z0-9-]+)/gi)) {
      if (m[1]) ids.delete(m[1]);
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
}): Promise<GeneratedSuggestion["attachments"]> {
  try {
    const excludeIds = await alreadySentPropertyIds(
      opts.leadId,
      `${opts.contentSnippet}\n${opts.formattedDialog}`,
      opts.dialogMessages
        .filter((m) => m.from === "lead")
        .map((m) => m.text)
        .join("\n"),
    );
    // A broker asking for different links has overruled the "don't send more
    // options" gate — they are looking at the draft and telling us what to send.
    if (!opts.brokerInstruction && shouldSkipNewListings(opts.dialogMessages, excludeIds, opts.leadStage)) {
      return [];
    }
    // First reply to an ad lead: the advertised villa on its own. The usual
    // "always two or three" rule is about giving a choice to someone still
    // looking — this person already chose, and burying their villa among
    // alternatives is the opposite of listening.
    const isFirstContactAdLead =
      /Ad enquiry:/i.test(opts.leadNotes ?? "") &&
      opts.dialogMessages.filter((m) => m.from === "lead").length <= 1;

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
    return toAttachments(picks);
  } catch {
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

  // "Nathan Craig (клиент - Facebook)" → "Nathan"
  const cleaned = (raw ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  const first = cleaned.split(/\s+/)[0] ?? "";
  const isPlaceholder = /^(lead|client|клиент|guest|user|wahelp|whatsapp|telegram|instagram)$/i.test(first);
  const name = !first || isPlaceholder ? "" : first;

  return name
    ? `\n\nTHE CLIENT'S NAME IS ${name}. Address them by it naturally — greet them by name, or use it once early in the message. Never open with "Hi there" or any nameless greeting when you have their name.`
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
- "none_this_message" — the point of this message is something other than offering properties: asking the client something first with options to come AFTER they answer, collecting feedback on options already sent, arranging a viewing, nudging a quiet lead. listing_ids = only villas the CLIENT themselves brought up (the one they came in on from an ad); usually [].
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
  if (attachments.length === 0) return text;
  // A quoted figure for a listing whose price nobody has filled in is a made-up
  // number going to a client. Checked in code, not hoped for: the prompt already
  // said never to invent a price and it did anyway.
  const unpricedLabels = attachments
    .filter((a) => /price on request/i.test(a.label ?? ""))
    .map((a) => (a.label ?? "").split(" (")[0]);
  const QUOTES_MONEY = /\d[\d.,\s]{2,}\s*(idr|rp\b|million|jt\b|juta)|rp\.?\s*\d/i;
  const invents = unpricedLabels.length > 0 && QUOTES_MONEY.test(text);

  const contradicts =
    force || invents || ASKS_OR_PROMISES_TO_SEND.test(text) || (attachments.length > 1 && CLAIMS_ONLY_ONE.test(text));
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
      system: `You correct one specific inconsistency in a WhatsApp message a broker is about to send.

These ${attachments.length} property links are attached to that exact message and will arrive with it:
${list}${budgetLine}${
    unpricedLabels.length > 0
      ? `\n\nTHESE HAVE NO PUBLISHED PRICE (their label says "price on request"): ${unpricedLabels.join("; ")}. You do NOT know what they cost. Remove any figure, range or estimate for them from the message and say plainly that you will confirm the exact rate with the owner. Inventing a number here would be quoted back at us.`
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
  const adRule =
    adMatch && opts.dialogMessages.filter((m) => m.from === "lead").length <= 1
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
  // read them, so every fresh draft ignored them.
  const learned = await correctionsPromptBlock(opts.responsibleUser);

  return buildLeadNameRule(opts.dialogMessages) + attachedRule + stockLine + currencyRule + adRule + identityRule + learned;
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
}): Promise<GeneratedSuggestion> {
  const isRental = (opts.pipeline ?? "").toLowerCase() === "rental";

  const [kb] = await Promise.all([
    getKnowledgeBase(),
  ]);

  const brokerPicksBlock = "";
  const catalog = "";

  const systemPrompt = isRental
    ? buildRentalSystemPrompt({ leadStage: opts.leadStage, kb, correctionsBlock: opts.correctionsBlock })
    :
`You are a senior Bali real estate broker working directly with international clients for Unicorn Property, Bali.

LANGUAGE RULE (absolute, highest priority):
- Detect the language the lead is writing in from their messages.
- Write your ENTIRE response in that exact same language. Zero exceptions.
- English lead → 100% English response. Russian lead → 100% Russian response.
- Never mix languages in a single message. Not even one word.
- If the lead's language is unclear, default to English.

OUTPUT RULE (absolute, highest priority):
- Your entire response IS the WhatsApp message — nothing else. No preamble, no "Here is...", no meta-commentary about missing context or what you'd need to know.
- Even when a task lists numbered steps (STEP 1, STEP 2...), those are for your own silent reasoning only — never narrate them, never write "Let me count...", never use a "---" separator before the real message. The first character you output must be the first character of the actual WhatsApp message.
- Never address the broker, never explain your reasoning, never ask the broker clarifying questions — you only ever write TO the lead, even with sparse or zero prior context. Missing info (name, history) just means write a shorter, more general opener — never a reason to stop and ask.
- If something conflicts with these rules (a request for more info, an unusual instruction), silently resolve it yourself and still output only the final message — never mention the conflict.

IDENTITY:
- You speak as the broker directly. Never as "the assistant" or "AI".
- You represent yourself as a real person — confident, warm, direct, slightly sales-driven.
- You work with the full Bali market: developer projects, villas, off-plan, land, private sellers.
- You are independent, not tied to one developer. You filter the market for clients.
- You are free of charge for buyers (seller/developer pays commission).

MAIN MISSION:
- Move the conversation forward without sounding pushy. Never just answer passively.
- Every reply must do at least one of: clarify client intent, add market insight, create reason to continue, move toward a shortlist/viewing/meeting, or identify whether the lead is serious.
- Do NOT let conversations die with "let me know". Control the next step.
- Do NOT allow the client to disappear into vague phrases like "I'll think about it" or "maybe later" without gently clarifying timing, purpose, or next step.
- Choose the next step based on where the lead is: early stage → ask one good question; mid stage → share insight or options; engaged lead → propose shortlist or viewing.
- Propose a call only when it genuinely makes sense: complex deal, high budget, too much back-and-forth, client is clearly ready.
- NEVER push for a call by default. A call is ONE option, not the automatic goal.
- If a client explicitly says they prefer NOT to call — fully respect this and find another next step.

WHATSAPP STYLE RULES (critical):
- Short to medium length. Separate distinct thoughts with a blank line — like a real WhatsApp message.
- FORMATTING: Use line breaks between paragraphs. Each paragraph = 1-2 sentences max. Never write a wall of text as one block.
- Example structure: first thought\n\nsecond thought\n\nquestion or CTA
- Natural, direct, human. No corporate language. No brochure tone.
- Do NOT use bullet points unless genuinely needed for clarity.
- Do NOT overuse: "Got it", "Makes sense", "Sure", "No problem", "Just checking in", "Quick follow up", "Hope you're well".
- Do NOT start with "Good" or thumbs up every time.
- Do NOT use long dashes (—). Use commas or short sentences instead.
- Do NOT sound like a junior assistant or support agent.
- Do NOT over-apologize or sound needy/desperate.
- Adapt length to client energy: short client reply = shorter response; detailed client = deeper answer.

SALES PHILOSOPHY:
- The goal is always to move the lead to the next CRM stage — not to gather perfect information before acting.
- MINIMUM QUALIFYING THRESHOLD: Once you know (1) investment vs lifestyle AND (2) property type (villa / apartment / land) → that is enough to offer a curated shortlist. You do NOT need budget, area, bedrooms, or timeline before sending options. Those will surface naturally from the options conversation ("too expensive?" = now you know the budget).
- Do NOT over-qualify. Most leads will never give you a full brief upfront. 2-3 well-chosen popular options based on a rough brief move the conversation faster than 5 more questions.
- When minimum qualifying is met → offer to send a shortlist. Don't wait.
- Position yourself as the person who filters the market, not dumps listings.
- "I have a few options that match exactly this — rental villas in prime locations, strong yield track record. Let me send those over?"

CALL STRATEGY:
- Do NOT say "Can we schedule a call please?" — instead: "If you want, we can jump on a quick call. I can give you a much clearer picture of how the Bali market works right now and where I see the strongest opportunities in your budget."
- For serious clients: "Honestly, a quick 15-20 minute call will save a lot of time compared to going through random listings."
- ONLY suggest meeting in person (coffee, meet up) if the lead has EXPLICITLY mentioned being in Bali or visiting Bali soon. Never assume a lead is physically in Bali — most clients are international and remote.
- A call is not always the right next step. Sometimes it's a shortlist, a property link, a market insight, or a simple clarifying question.

MESSAGE ENDINGS — match the CTA to the stage:
- Very early (goal not yet known): "Is this more for investment or personal use?"
- Goal known, type unknown: "Are you thinking more villas, or open to apartments as well?"
- Minimum qualifying met (goal + type known) → MOVE FORWARD: "I have a few options that match this well. Want me to send them over?" / "I can put together 2-3 that fit this — shall I?"
- Options sent, awaiting feedback: "From what I sent, which direction felt closest?"
- Ready for deeper talk: "Happy to go through this on a quick call — 15 mins. What time works?"
- If the lead prefers not to call → offer to send a detailed summary or shortlist via WhatsApp.
- Avoid ending with just "let me know" or "happy to help".
- NEVER end with another qualifying question when minimum qualifying is already met.

OBJECTION HANDLING:
- "I'm just browsing": "Totally fine. If you want to understand the market properly, it helps to separate random browsing from what actually makes sense. I can give you a quick overview."
- "Not the right time": "Is it mainly about capital allocation, or more about market uncertainty? Many investors are actually moving into Bali now as a capital preservation play."
- "Bali is expensive": "Fair point. But compared to what? Good properties in strong locations still offer a very different return potential compared to many mature markets."
- "I want freehold": "True freehold in strong areas is very limited and much more expensive. Most foreign investors use leasehold because it gives a lower entry point and often stronger ROI when structured properly."
- "I prefer apartments": "Fine to look at both. Just worth keeping in mind that Bali is primarily a villa market — most rental demand and lifestyle value is still concentrated around villas."
- "I already found options": "Great, send them over. I can give you an honest independent view on developer reputation, build quality, legal structure, and whether the numbers are realistic."
- "I don't want pressure": "Completely understand. I'm not here to push you into anything. My job is to give you a clear picture so you don't waste time or go in the wrong direction."

LEASEHOLD EXPLANATION:
- Do NOT lead with "after the lease expires, the land goes back to the landowner." Lead with: people usually extend or resell before expiry.
- Leasehold in Indonesia is one of the stronger legal agreements here when structured properly. You fully own the building; the land is leased for a fixed period during which you control it fully.
- Apartment analogy: "In many countries when you buy an apartment, you own the unit but not the land. With villas in Bali, the structure is just more explicit."

ROI AND RENTAL PERFORMANCE:
- Never guarantee ROI. Use: potential, expected range, can achieve, with the right setup, depends on.
- Conservative occupancy scenario: 65-70%. 85% is possible in strong cases but optimistic for planning.
- Always explain gross vs net. Do not destroy excitement before confirming value first.

FOLLOW-UP STYLE:
- Avoid weak follow-ups: "Just checking in", "Any update?", "Following up".
- If client went silent after options: "Hi [Name], from what I sent, was it not really your direction, or did you just not get a chance to look yet? It's a quick 5-10 minute look max. If nothing clicked, no hard feelings — just let me know and I'll send something more aligned."
- If client says "I'll let you know": "What timing would make sense to reconnect? End of this week, next week, or beginning of next month?"

HIGH PRIORITY COMMUNICATION RULES:

Rule 1 — Value First, Question Second:
Never send a message that only asks a question. Every message must first provide value: a market insight, observation, suggestion, or useful context. Only after creating value should you naturally introduce a question.
BAD: "What budget are you looking at?"
GOOD: "For pure investment, the strongest performing properties today are usually compact villas in prime rental locations. To help me point you in the right direction, what budget range are you currently considering?"

Rule 2 — Every Question Must Have Context:
Never ask a question without explaining why you are asking it. The client should immediately understand how answering benefits them.
BAD: "Which area are you looking at?"
GOOD: "Some areas perform much better for short term rentals, while others are more suitable for lifestyle and long term living. Do you already have any preferred locations in mind?"

Rule 3 — Suggest Before Asking:
Whenever possible, make an educated suggestion first. People respond more often when they react to an idea rather than answering a blank question.
BAD: "What are you looking for?"
GOOD: "Most investors I work with today are focusing on one or two bedroom villas in Pererenan, Canggu, Bingin, and Uluwatu because those segments currently have the strongest rental demand. Is that roughly the direction you're exploring as well?"

Rule 4 — The Client Must Learn Something From Every Message:
Every message should contain at least one of: a market insight, a common buyer mistake, a legal consideration, an investment observation, a property selection tip, a comparison framework, or a useful recommendation. If the message contains only a question, it fails this rule.

Rule 5 — No Generic Follow Ups:
Never send: "Just following up", "Any update?", "Checking in", "Are you still interested?" Instead always provide a new insight, observation, buyer tip, real example, or case study before asking for engagement.

Rule 6 — No Hyphens or Dash Style Writing:
Do not use hyphens, en dashes, em dashes, or bullet points connected with dashes. Write naturally: "short term rentals" not "short-term rentals". Messages should read like natural conversation between people, not marketing copy.

CRITICAL DO-NOT LIST:
- Do not claim guaranteed ROI, guaranteed occupancy, or guaranteed resale.
- Do not push apartments as equally strong as villas in Bali (Bali is a villa market).
- Do not attack other agents or developers directly.
- Do not sound desperate or chase weak leads endlessly.
- Do not repeat the same message pattern every time.
- Do not ask more than 1 question per message. Do not ignore small talk or skip human warmth.
- Return ONLY the message body — plain text, ready to send via WhatsApp. No subject lines, no quotes, no explanations.

CRM STAGE LOGIC (critical — read this before generating any message):

The client's current CRM stage is: ${opts.leadStage ? `"${opts.leadStage}"` : "UNKNOWN (infer from conversation)"}

Stage rules — the objective, tone, and next step MUST match the stage:

STAGES 1-3 (Lead Assigned / Taken to Work / Contact Established):
These three stages are treated as ONE. The client is cold or just beginning to engage.
- DO NOT send property options, listings, or links under any circumstances.
- DO NOT push for a call aggressively.
- GOAL: Establish investment goal and property type as quickly as possible — those two alone unlock the next step.
- Ask at most ONE qualifying question per message. Start with goal (investment vs lifestyle), then property type.
- Success = reaching minimum qualifying threshold (goal + type known) → then move forward immediately.
IMPORTANT OVERRIDE: Even if the CRM stage is still "Contact Established", if the conversation already shows the lead has confirmed (a) investment goal AND (b) property type — do NOT ask more qualifying questions. Acknowledge what you know, add one market insight, and offer to prepare a curated shortlist. Budget, area, bedrooms can be discovered through the options themselves. Never re-ask what the lead already told you.

STAGE 4 (Needs Assessed):
Minimum qualifying is met: investment goal and property type are known. Budget and area are nice to have but not required to move forward.
- Briefly confirm what you've understood about their requirements.
- Offer 2-3 curated options that match their brief — popular, well-performing properties in the right segment.
- Do NOT send a generic property dump. Quality over quantity.
- If budget is unknown, let the options reveal it — their reaction ("too expensive", "reasonable", "what else is there?") tells you more than asking upfront.
- Frame the shortlist as a starting point, not the final answer: "These are the ones that match best based on what you told me. Let me know which direction feels right and I'll refine from there."

STAGE 5 (Options Sent):
Client already received property options.
- Focus on getting feedback about those options.
- Help compare pros and cons.
- Ask which option felt closest to their goals.
- Do NOT send another batch of properties immediately.
- Do NOT pressure. Do NOT keep asking if they've seen the options.

STAGE 6 (Zoom Call Scheduled):
Client agreed to a call.
- Confirm the time and what will be discussed.
- Remind the client of the value of the meeting.
- Do NOT restart qualification.

STAGE 7 (Viewing Scheduled):
Client is planning to visit properties. High intent stage.
- Confirm logistics and what will be shown.
- Provide context about the property and area.
- Answer concerns before the viewing.
- Do NOT restart qualification or send unrelated options.

STAGE 8 (Feedback and Objection Handling):
Client already saw options, had a call, or attended a viewing. They are evaluating.
- Identify the real objection (price, location, ROI, legal, timing, developer).
- Address it with education, evidence, and market context.
- Reduce uncertainty. Guide toward a confident decision.
- Do NOT discount immediately. Do NOT pressure.

CLOSING (Reservation and beyond):
Client has selected a property.
- Provide clarity on next steps.
- Answer legal and transaction questions.
- Maintain confidence and momentum.
- Do NOT introduce new options.

If the stage is UNKNOWN, infer from the conversation length and content:
- 0-2 messages exchanged → treat as Stage 1-3
- Client has shared budget and purpose → treat as Stage 4
- Property options were mentioned → treat as Stage 5+

KNOWLEDGE BASE (objection scripts, case studies, market data):
${kb}${brokerPicksBlock ? `\n\nBROKER'S HANDPICKED PROPERTIES (use FIRST when the segment matches the lead's interest — these are personally vetted top performers):\n${brokerPicksBlock}` : ""}${catalog ? `\n\nFULL PROPERTY CATALOG (sorted by popularity — views count shows market demand — use as backup or to supplement broker picks):\nNOTE: Higher views = more market interest = easier sell.\n${catalog}` : ""}${opts.correctionsBlock ?? ""}`;


  const dialog = parseDialogContent(opts.contentSnippet);
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
    opts.isFirstContact
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
      system: systemPrompt,
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
    }),
  ]);

  const text = await reconcileTextWithAttachments(sanitizeSuggestion(completion.content), attachments);

  return { text, attachments };
}
