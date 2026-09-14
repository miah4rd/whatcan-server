import { chatCompletion, chatCompletionJSON, WRITER_MODEL, HELPER_MODEL } from "./ai-client";
import { areaNamesInText, fuzzyAreaNamesInText, landmarkAreasInText } from "./bali-areas";
import { brokerDisplayName } from "./broker-identity";
import { cleanLeadName } from "./lead-display-name";
import { getLeadCardCriteria } from "./lead-card-fields";
import { correctionsPromptBlock, deriveSituation } from "./broker-corrections";
import { logger } from "./logger";
import { parseDialogContent, formatDialogForAI, describeConversationTiming, conversationWindow } from "./dialog-parser";
import { getKnowledgeBase, filterKnowledgeBaseForRental } from "./knowledge-base";
import { sanitizeSuggestion, AVOID_PHRASES_REMINDER } from "./sanitize-suggestion";
import { buildRentalPromptParts } from "./rental-prompt";
import { buildSalesPromptParts } from "./sales-prompt";
import { generateListingAcquisitionReply, isListingAcquisitionPipeline } from "./listing-acquisition-prompt";
import { matchPropertiesDetailed, describePropertiesByIds, describeRequest, requestMisfits, requestHasCore, fetchAllPropertiesForPriceLookup, resolveClientRequest, shortlistOutcomeFor, clientOwnWords, type PropertyPick, type BrokerIntent, type ShortlistOutcome, type RelaxHint, type RelaxExample } from "./property-catalog";
import { getMergedDialog } from "./merged-conversation";
import { db, pendingSuggestionsTable, sentMessagesTable } from "@workspace/db";
import { viewingReportPromptBlock } from "./viewing-report-context";
import { leadPhone } from "./phone-dedupe";
import { villaContactPhoneKeys, phoneKey } from "./property-flags";
import { eq, inArray, and, gte, sql } from "drizzle-orm";

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
export async function alreadySentPropertyIds(
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
      .select({ id: pendingSuggestionsTable.id, attachments: pendingSuggestionsTable.attachments })
      .from(pendingSuggestionsTable)
      .where(and(eq(pendingSuggestionsTable.leadId, leadId), inArray(pendingSuggestionsTable.status, ["approved", "edited"])));
    if (rows.length > 0) {
      // Only links that actually went out. A draft row lists what the bot
      // attached, not what reached the client: Sophie's 12.09 draft was
      // approved with its links dropped, the row still listed R-YUD-074,
      // R-MER-040 and R-YUD-075, and those three stayed "already sent" — out
      // of every later shortlist although she never saw them. The send record
      // says how many links followed the text ("| links n/m"); a send with no
      // marker carried none (a delivered link is in the conversation text
      // above anyway). No send record yet = the send may be under way: count all.
      const sends = await db
        .select({ suggestionId: sentMessagesTable.suggestionId, webhookResponse: sentMessagesTable.webhookResponse })
        .from(sentMessagesTable)
        .where(eq(sentMessagesTable.leadId, leadId));
      const sendOf = new Map(sends.filter((s) => s.suggestionId).map((s) => [String(s.suggestionId), s.webhookResponse ?? ""]));
      for (const r of rows) {
        const links = (r.attachments ?? []).filter((att) => att.type === "link" && att.url);
        if (links.length === 0) continue;
        const response = sendOf.get(String(r.id));
        const marker = response === undefined ? null : /\|\s*links (\d+)\/(\d+)/.exec(response);
        const wentOut = response === undefined ? links.length : marker ? Number(marker[1]) : 0;
        for (const att of links.slice(0, wentOut)) {
          const m = att.url!.match(/\/property\/([A-Za-z0-9-]+)/i);
          if (m?.[1]) ids.add(m[1]);
        }
      }
    }
  } catch {
    // Conversation-derived ids above are enough to keep the shortlist fresh.
  }

  return [...ids];
}

/**
 * Does THIS message carry a new shortlist? (owner, 14.09.2026 — final)
 *
 * People rarely say "I don't like it". "Let's see more", "not quite my style",
 * "I've seen these", "keep sending", "hopefully something comes up",
 * "anything else?", "similar ones?" — and any new criterion (budget, area,
 * pool, garden, pets, dates, parking) — are objections, and the answer is
 * ALWAYS a new shortlist inside the request. New links are skipped only when
 * the client's latest message clearly sits on ONE villa we already sent with a
 * next step: its price, location, availability, a viewing of it, "I like this
 * one". The stage alone decides nothing — after a viewing or a failed
 * negotiation "any similar villas?" gets villas. When unsure, the shortlist
 * goes: deterministic cues first, a small yes/no model check only for what
 * they leave open, and that check fails toward sending.
 *
 * The gate this replaces skipped whenever a sent listing ID appeared in one of
 * the client's last three messages, or the stage said viewing/negotiation. In
 * the week of 11-14.09 the IDs it "saw" were never the client's: the quick
 * poll appends a raw timeline tail to the content, the parser glued that tail
 * — our own link messages — onto the client's last message, and Lance, Luke,
 * Jesica, Chloé and Sophie all got "lead is discussing listings already sent"
 * while asking for something else (dialog-parser.ts now cuts the tail). Every
 * decision is logged with the rule that fired and its evidence.
 */
export type ShortlistGate = { skip: boolean; reason: string; evidence: Record<string, unknown> };

const ASKS_FOR_MORE = new RegExp(
  [
    String.raw`\b(more|other|another|else|different|similar|alternative)\s+(options?|villas?|places?|ones?|properties|houses?|homes?|listings?|choices?)\b`,
    String.raw`\bsimilar\b|\bthe others\b|\bother ones\b`,
    String.raw`\bkeep (sending|them coming|looking|me posted|us posted)\b`,
    String.raw`\bsend (me |us )?(more|others|some more|other)\b`,
    String.raw`\b(anything|something|what) else\b`,
    String.raw`\b(any|some) (others|more)\b`,
    String.raw`\b(did|have|had|already|i've|we've|i have|we have)\s+(already\s+)?(seen|see|saw|checked|looked at)\s+(these|those|them|all)\b`,
    String.raw`\b(i|we) saw (these|those|them)\b`,
    String.raw`\bhopefully (something|one|another|we find|we get)\b`,
    String.raw`\bsomething (great|good|nice|better|suitable|else)?\s?(comes|pops|turns) up\b`,
    String.raw`\blet'?s see (more|others|what else|other)\b`,
    String.raw`\bnot (quite|really|exactly|totally) (my|our|what|it|for|right)\b`,
    String.raw`\bnot (my|our) (style|taste|thing|vibe|type)\b`,
    String.raw`\bnot for (me|us)\b`,
    String.raw`\b(do ?n'?t|does ?n'?t|did ?n'?t|not) (really )?(like|love|fit|suit|work for)\b|\bdislike\b`,
    String.raw`\btoo (expensive|pricey|small|big|far|noisy|dark|much|busy|old)\b`,
    String.raw`\bnone of (these|them|those)\b`,
    String.raw`\byou (have|got|find) (any(thing)?|some(thing)?|other|more|(a|an|one)\s+(\w+\s+){0,3}(villa|house|place|home|bedroom|br|property|option|studio))\b`,
    String.raw`\bany (news|updates?|new ones|new listings|new options|new villas)\b`,
    String.raw`\bnew (ones|options|listings|villas)\b`,
    String.raw`\b(still|keep|continue) (looking|searching|hunting)\b`,
    String.raw`\blooking (for|at) (other|more|something else)\b`,
    String.raw`другие|ещё вариант|еще вариант|похож|не нравится|не подходит|что-то ещё|что-нибудь ещё`,
  ].join("|"),
  "i",
);

const NEW_CRITERIA = new RegExp(
  [
    String.raw`\b\d+([.,]\d+)?\s*(m|mil|mill?ions?|mio|mln|jt|juta|k)\b`,
    String.raw`\b(budget|rupiah|idr|usd|per month|a month|monthly|per year|a year|yearly)\b|\brp\.?\s*\d|\$\s?\d`,
    String.raw`\b(\d|one|two|three|four|five)\s*-?\s*(br|bed(room)?s?|bdr)\b|\bbedrooms?\b|\bstudio\b`,
    String.raw`\b(pool|garden|yard|backyard|pets?|dogs?|cats?|parking|cars?|moto(rbike)?s?|scooters?|office|workspace|furnished|unfurnished|kitchen|enclosed|gym|kids|children|quiet|beach|rice ?fields?|bathtub|storage)\b`,
    String.raw`\b(jan(uary)?|feb(ruary)?|march|april|june|july|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b|\b(in|from|until|early|mid|end of|by) may\b`,
    String.raw`\b(move[- ]?in|moving in|check[- ]?in|arriv(e|al|ing)|until|til|till|asap|as soon as|right away|immediately|next (week|month)|this (week|month)|long[- ]term|short[- ]term|\d+\s*(months?|weeks?|years?))\b`,
  ].join("|"),
  "i",
);

/** The client points at ONE villa: "this one", "that villa", "the first one", "the one in Seseh". */
const ONE_VILLA_REFERENCE =
  /\b(this|that) (one|villa|house|place|property|home)\b|\bthe (first|second|third|fourth|last|other|1st|2nd|3rd|4th) (one|villa|house|place|option|link)\b|\b(the )?one (in|at|near|with) [a-z]/i;
/** "it" used about a villa in a short message: "is it available?", "can we see it?". */
const IT_ABOUT_A_VILLA = /\b(is it|it is|it's|is this|is that|see it|like it|love it|book it|take it|want it|reserve it|visit it|view it|of it|for it)\b/i;
/** A next step on a villa: its price, where, when, a viewing, a yes. */
const NEXT_STEP_ON_A_VILLA =
  /\b(price|how much|cost|rate|discount|negotiat\w*|deposit|contract|lease|sign|book(ing)?|reserve|reservation|lock (it|this|that|the \w+) in|take (it|this|that)|go (for|with) (it|this|that)|avail\w*|free (from|on|in)|still (free|open|there)|when (can|could|is|will)|where|location|address|maps?|pin|how far|distance|viewing|visit|view (it|this|that)|see (it|this|that|the (villa|house|place))|come (and |to )?see|check (it|this|that) out|tour|photos?|pictures?|video|(i|we) (really )?(like|love|want|prefer)|interested in|keen on|go ahead|better)\b/i;
const PAST_BROWSING_STAGE = /viewing\s*(scheduled|done)|zoom|negotiat|reservation|contract|check\s*in|closed|won/i;

async function oneVillaFocusCheck(leadId: string, said: string, stage: string | null): Promise<{ focus: boolean; why: string } | null> {
  try {
    const res = await Promise.race([
      chatCompletionJSON<{ focus?: unknown; why?: unknown }>({
        model: HELPER_MODEL,
        label: "shortlist-gate",
        system: `A client of a Bali villa rental agency wrote the message below. We have already sent them links to some villas. Decide ONE thing: does this message clearly sit on ONE villa we already sent and move it to a next step — asking its price, location or availability, asking to view it, saying they like it, or arranging, confirming or reporting on a viewing or a deal for it?
focus=false when they ask for more, other or similar villas, say what they saw is not right, give a new wish (budget, area, size, dates, pool, garden, pets, parking), or anything else. When unsure, false.
Respond with JSON only: {"focus": true|false, "why": "<at most 12 words>"}`,
        messages: [{ role: "user", content: `CRM stage: ${stage ?? "unknown"}\nClient's latest message(s):\n${said.slice(0, 800)}` }],
        max_tokens: 60,
        temperature: 0,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    if (!res || typeof res.focus !== "boolean") return null;
    return { focus: res.focus, why: String(res.why ?? "").slice(0, 120) };
  } catch (err) {
    logger.warn({ err, leadId }, "shortlist gate: model check failed — options go");
    return null;
  }
}

export async function decideShortlistGate(opts: {
  leadId: string;
  messages: ReturnType<typeof parseDialogContent>["messages"];
  /** Everything already sent to this lead (alreadySentPropertyIds). */
  sentIds: string[];
  leadStage: string | null | undefined;
  lastLeadText: string;
}): Promise<ShortlistGate> {
  const sent = [...new Set(opts.sentIds.map((i) => i.toUpperCase()))];
  if (sent.length === 0) return { skip: false, reason: "nothing sent to this client yet", evidence: {} };

  // The client's latest turn: what they wrote after our last message, or —
  // when we spoke last (a follow-up) — their last message.
  const msgs = opts.messages;
  const lastOurIdx = msgs.map((m) => m.from).lastIndexOf("us");
  let turn = msgs.slice(lastOurIdx + 1).filter((m) => m.from === "lead").map((m) => m.text ?? "");
  if (turn.length === 0) {
    const lastLead = [...msgs].reverse().find((m) => m.from === "lead");
    if (lastLead) turn = [lastLead.text ?? ""];
  }
  const newest = (opts.lastLeadText ?? "").trim();
  if (newest && !turn.some((t) => t.trim() === newest)) turn.push(newest);
  turn = turn.filter((t) => t.trim()).slice(-4);
  if (turn.length === 0) return { skip: false, reason: "no client message to answer — the draft carries options", evidence: {} };

  const apostrophes = (s: string) => s.replace(/[’‘]/g, "'");
  const ours = msgs.filter((m) => m.from === "us").map((m) => m.text ?? "");
  const own = apostrophes(turn.map((t) => clientOwnWords(t, ours)).filter(Boolean).join("\n"));
  const raw = apostrophes(turn.join("\n"));
  const said = own.slice(0, 300);

  const more = ASKS_FOR_MORE.exec(own);
  if (more) return { skip: false, reason: "the client asks for more or turns down what they have", evidence: { phrase: more[0], said } };

  const idsIn = sent.filter((id) => raw.toUpperCase().includes(id));
  const ref = ONE_VILLA_REFERENCE.exec(own);
  const itRef = own.length <= 80 ? IT_ABOUT_A_VILLA.exec(own) : null;
  const step = NEXT_STEP_ON_A_VILLA.exec(own);
  if (step && (idsIn.length === 1 || (idsIn.length === 0 && (ref || itRef)) || (ref && idsIn.length <= 1))) {
    return {
      skip: true,
      reason: "the client is on one villa already sent, with a next step",
      evidence: { villa: idsIn[0] ?? null, reference: ref?.[0] ?? itRef?.[0] ?? null, step: step[0], said },
    };
  }

  const areas = [...areaNamesInText(own), ...fuzzyAreaNamesInText(own), ...landmarkAreasInText(own).map((l) => l.landmark)];
  const criteria = NEW_CRITERIA.exec(own);
  if (criteria || areas.length > 0) {
    return { skip: false, reason: "the client gives new or changed criteria", evidence: { phrase: criteria?.[0] ?? null, areas, said } };
  }

  const late = PAST_BROWSING_STAGE.test(opts.leadStage ?? "");
  const weakRef = idsIn.length > 0 || !!ref || turn.some((t) => t.startsWith(">>"));
  if (late || weakRef) {
    const verdict = await oneVillaFocusCheck(opts.leadId, own || raw, opts.leadStage ?? null);
    if (verdict?.focus) {
      return { skip: true, reason: "model check: the client is on one villa or its viewing", evidence: { why: verdict.why, stage: opts.leadStage ?? null, said } };
    }
    return {
      skip: false,
      reason: verdict ? "model check: not settled on one villa — options go" : "model check unavailable — options go",
      evidence: { why: verdict?.why ?? null, stage: opts.leadStage ?? null, said },
    };
  }
  return { skip: false, reason: "no sign the client is settled on one villa — options go", evidence: { said } };
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
export type PickOptions = {
  leadId: string;
  brokerId: string | null;
  isRental: boolean;
  contentSnippet: string;
  dialogMessages: ReturnType<typeof parseDialogContent>["messages"];
  formattedDialog: string;
  lastLeadText: string;
  leadStage?: string | null;
  /** Card notes — the "Ad enquiry" marker and the scout's summary of the client's post. */
  leadNotes?: string | null;
  /** Set when the broker is revising an existing draft — see matchProperties. */
  brokerInstruction?: string | null;
  currentAttachmentIds?: string[];
  brokerIntent?: BrokerIntent | null;
  /**
   * The broker's opening on an ad lead that already got the welcome. The
   * welcome restated the request, so this message needs a shortlist — the
   * "lead is discussing a villa we sent" gate must not read the seeded
   * enquiry as that.
   */
  openingAfterWelcome?: boolean;
};

/** The links for one draft, and what the decision knew — the writer's prompt and the final check both read it. */
export type PickedAttachments = {
  attachments: GeneratedSuggestion["attachments"];
  outcome: ShortlistOutcome | null;
  /** The lead is discussing villas already sent — no new ones by design. */
  skipped: boolean;
  excludeIds: string[];
  /** Villas offered to this lead in drafts the broker skipped (last 21 days) — ranked lower, not removed. */
  proposedIds?: string[];
  /** The shortlist gate's decision for this message (null when a broker instruction or the ad opening decided). */
  gate?: ShortlistGate | null;
};

export async function pickPropertyAttachments(opts: PickOptions): Promise<GeneratedSuggestion["attachments"]> {
  return (await pickPropertyAttachmentsDetailed(opts)).attachments;
}

/**
 * Villas the bot put in a draft for this lead that the broker SKIPPED in the
 * last 21 days and that never went out. Not excluded — a skip can be about
 * timing — but ranked lower (rankShortlistFits), so the next follow-up does not
 * re-propose the same set while other fits sit unsent (23398487: R-YUD-048 in a
 * push skipped on 01.09, proposed again on 14.09).
 */
async function skippedDraftPropertyIds(leadId: string, sentIds: string[]): Promise<string[]> {
  try {
    const since = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({ attachments: pendingSuggestionsTable.attachments })
      .from(pendingSuggestionsTable)
      .where(
        and(
          eq(pendingSuggestionsTable.leadId, leadId),
          eq(pendingSuggestionsTable.status, "skipped"),
          gte(pendingSuggestionsTable.createdAt, since),
        ),
      );
    const sent = new Set(sentIds.map((i) => i.toUpperCase()));
    const ids = new Set<string>();
    for (const r of rows) {
      for (const att of r.attachments ?? []) {
        const m = att.url?.match(/\/property\/([A-Za-z0-9-]+)/i);
        if (m?.[1] && !sent.has(m[1].toUpperCase())) ids.add(m[1].toUpperCase());
      }
    }
    return [...ids];
  } catch {
    return [];
  }
}

export async function pickPropertyAttachmentsDetailed(opts: PickOptions): Promise<PickedAttachments> {
  let excludeIds: string[] = [];
  let proposedIds: string[] = [];
  try {
    excludeIds = await alreadySentPropertyIds(
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
    proposedIds = await skippedDraftPropertyIds(opts.leadId, excludeIds);
    // A broker asking for different links has overruled the "don't send more
    // options" gate; so has the broker's opening on an ad lead, whose seeded
    // enquiry names a villa the gate would otherwise read as one we sent
    // (23302661, 2026-08-21).
    // The form's answers as parsed AND as typed, the scout's notes, and the
    // villa an ad lead clicked all go into ONE request (resolveClientRequest);
    // the client's own words always outrank them. The clicked villa fills only
    // size and area — its price is not the client's budget (the old
    // criteriaFromListing made it one, times 1.15).
    const card = await getLeadCardCriteria(opts.leadId).catch(() => null);
    const adId = /Ad enquiry:\s*([A-Z0-9-]+)/i.exec(opts.leadNotes ?? "")?.[1]?.toUpperCase() ?? null;
    // The lead's OWN messages, newest first (a long thread keeps its early
    // requirements: Josua's 3-4 bedrooms scrolled out of a window of 5).
    const recentLeadMessages = [
      opts.lastLeadText,
      ...opts.dialogMessages.filter((m) => m.from === "lead").slice(-25).reverse().map((m) => m.text),
    ].filter(Boolean);
    const listingType = opts.isRental ? ("rent" as const) : ("sale" as const);
    const cardCriteria = card ? { bedrooms: card.bedrooms, areas: card.areas, budgetIdrMonthly: card.budgetIdrMonthly } : null;

    const ourTexts = opts.dialogMessages.filter((m) => m.from === "us").map((m) => m.text);
    // A broker asking for different links, and the broker's opening on an ad
    // lead, have already decided; every other draft asks the gate.
    const gate: ShortlistGate | null =
      opts.brokerInstruction || opts.openingAfterWelcome
        ? null
        : await decideShortlistGate({
            leadId: opts.leadId,
            messages: opts.dialogMessages,
            sentIds: excludeIds,
            leadStage: opts.leadStage,
            lastLeadText: opts.lastLeadText,
          });
    if (gate) {
      logger.info(
        { leadId: opts.leadId, rule: gate.reason, stage: opts.leadStage ?? null, alreadySent: excludeIds.length, ...gate.evidence },
        gate.skip ? `property matcher skipped — ${gate.reason}` : "shortlist gate: this message carries new options",
      );
    }

    if (gate?.skip) {
      // No new links by design — but the writer still needs the request: a
      // villa already sent that is outside it must not be called a match.
      let outcome: ShortlistOutcome | null = null;
      try {
        const request = await resolveClientRequest({
          listingType,
          leadMessages: recentLeadMessages,
          ourMessages: ourTexts,
          cardCriteria,
          cardAnswers: card?.answers ?? null,
          cardBudgetTexts: card?.budgetTexts ?? [],
          leadNotes: opts.leadNotes ?? null,
          clickedListingId: adId,
        });
        const named = [...new Set(recentLeadMessages.flatMap((t) => Array.from(String(t).matchAll(/\/property\/([A-Za-z0-9-]+)|\b(R-[A-Z]{2,6}-[A-Z0-9]+)\b/gi)).map((m) => (m[1] ?? m[2] ?? "").toUpperCase())).filter(Boolean))];
        outcome = { ...(await shortlistOutcomeFor(request, { listingType, excludeIds, namedIds: named, rotationKey: opts.leadId })).outcome, declined: true };
      } catch (err) {
        logger.warn({ err, leadId: opts.leadId }, "request read on a skipped shortlist failed (non-fatal)");
      }
      return { attachments: [], outcome, skipped: true, excludeIds, proposedIds, gate };
    }

    const { picks, outcome } = await matchPropertiesDetailed({
      listingType,
      conversationText: `${opts.formattedDialog}\n${opts.lastLeadText}`,
      brokerId: opts.brokerId,
      excludeIds,
      proposedIds,
      leadId: opts.leadId,
      seenCount: excludeIds.length,
      latestLeadMessage: opts.lastLeadText,
      brokerInstruction: opts.brokerInstruction ?? null,
      currentAttachmentIds: opts.currentAttachmentIds ?? [],
      brokerIntent: opts.brokerIntent ?? null,
      cardCriteria,
      cardAnswers: card?.answers ?? null,
      cardBudgetTexts: card?.budgetTexts ?? [],
      leadNotes: opts.leadNotes ?? null,
      clickedListingId: adId,
      recentLeadMessages,
      ourMessages: ourTexts,
      // Past the gate (or the broker's ad opening), a Rental draft carries
      // options: the matching model chooses AMONG the fits and no longer
      // decides whether to send any — fail toward sending (owner, 14.09).
      mustAttach: opts.isRental && !opts.brokerInstruction,
    });
    const out = toAttachments(picks);

    // The villa they clicked rides along on the opening ONLY when it is inside
    // their own request (owner, 14.09.2026, replacing "fit or not" of 04.09):
    // R-YUD-066, let until October 2027, went to a client moving in tomorrow;
    // R-YUD-050, a 3BR at 66M, went to 2BR-under-50M and Ubud-only requests.
    const stillOpening = opts.dialogMessages.filter((m) => m.from === "lead").length <= 1;
    const sent = new Set(excludeIds.map((i) => i.toUpperCase()));
    if (adId && stillOpening && !sent.has(adId) && !out.some((a) => a.url.toUpperCase().includes(`/PROPERTY/${adId}`))) {
      const villa = (await fetchAllPropertiesForPriceLookup().catch(() => [])).find((p) => p.id.toUpperCase() === adId);
      const misfits = villa ? requestMisfits(villa, outcome.request) : ["not in the published catalog"];
      if (villa && misfits.length === 0) {
        const hit = (await describePropertiesByIds([adId]).catch(() => new Map())).get(adId);
        if (hit && typeof hit.url === "string") {
          out.push({ type: "link" as const, label: (hit as { clientLabel?: string; label?: string }).clientLabel ?? hit.label ?? adId, url: hit.url });
          logger.info({ leadId: opts.leadId, adId }, "ad lead: the villa they clicked is inside their request — attached last");
        }
      } else {
        logger.info({ leadId: opts.leadId, adId, misfits, request: describeRequest(outcome.request) }, "ad lead: the villa they clicked is outside their stated request — not attached");
      }
    }
    if (out.length === 0) logger.info({ leadId: opts.leadId, request: describeRequest(outcome.request) }, "property matcher returned nothing to attach");
    return { attachments: out, outcome, skipped: false, excludeIds, proposedIds, gate };
  } catch (err) {
    logger.warn({ err, leadId: opts.leadId }, "property matcher threw — sending the draft with no attachments");
    return { attachments: [], outcome: null, skipped: false, excludeIds, proposedIds };
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
  /** With an empty pool: what to say instead of promising a shortlist (built by the caller from relaxQuestion). */
  emptyPoolGuidance?: string;
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

Properties you may attach (pick by ID; attaching NONE is a normal answer). They are ranked best match first — prefer the top unless the broker's instruction or the client's own words point to a lower one:
${opts.candidates.map((c) => c.line).join("\n")}${opts.candidates.length === 0 && opts.emptyPoolGuidance ? `(none)\n\n${opts.emptyPoolGuidance}` : ""}

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
  // Words that describe half the catalog. "pool" + "Pererenan" was enough to
  // count a villa as named while the text was about its neighbour.
  "pool", "garden", "luxury", "modern", "stylish", "cozy", "beautiful", "stunning",
  "furnished", "fully", "available", "sale", "apartment", "unit", "studio",
  "near", "close", "walk", "minutes", "complex", "residence", "residences",
]);

/** Never identity on their own, never part of an identifying phrase. */
const CONNECTIVE_WORDS = new Set([
  "a", "an", "and", "at", "by", "for", "from", "in", "near", "of", "on", "or", "the", "to", "with",
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

/**
 * Text and links are ONE message. The client receives the words and, seconds
 * later, the links — as a single thought. Every path that produces or changes
 * either half goes through these helpers, so "does the text name this villa"
 * has exactly one definition in the codebase.
 *
 * What counts as naming a villa is DISTINCTIVE evidence, judged against the
 * other villas it could be confused with: the full title, or a two-word title
 * phrase / a title word that those others do not share. "pool" and
 * "Pererenan" are not a name — half the catalog has both — and the first cut
 * of this gate accepted exactly that, so a text about villa A passed as also
 * naming villa B, and an edited text "named" nineteen catalog villas at once.
 */
function normWords(s: string): string[] {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function titleOf(label: string): string {
  return (label ?? "").split(" (")[0] ?? "";
}

/** Padded so that `includes(" word ")` is a whole-word test. */
function normText(text: string): string {
  return ` ${normWords(text).join(" ")} `;
}

function hasWords(t: string, needle: string): boolean {
  return t.includes(` ${needle} `);
}

/** Title words that can carry identity: not connectives, not generic. */
function titleTokens(label: string): string[] {
  return normWords(titleOf(label)).filter(
    (w) => w.length > 3 && !GENERIC_TITLE_WORDS.has(w) && !CONNECTIVE_WORDS.has(w),
  );
}

/** Two-word title phrases that can carry identity: no connective, not both generic. */
function titlePhrases(title: string): string[] {
  const w = normWords(title);
  const out: string[] = [];
  for (let i = 0; i + 1 < w.length; i++) {
    const a = w[i]!;
    const b = w[i + 1]!;
    if (CONNECTIVE_WORDS.has(a) || CONNECTIVE_WORDS.has(b)) continue;
    if (GENERIC_TITLE_WORDS.has(a) && GENERIC_TITLE_WORDS.has(b)) continue;
    out.push(`${a} ${b}`);
  }
  return out;
}

/**
 * Does the text name THIS villa, given the other villas riding in the same
 * message? Distinctiveness is judged against the message, not the world: two
 * Pererenan villas must be told apart by more than "Pererenan".
 */
export function textNamesVilla(text: string, label: string, others: string[] = []): boolean {
  const t = normText(text);
  const title = normWords(titleOf(label)).join(" ");
  if (title.length >= 12 && hasWords(t, title)) return true;
  const phrases = titlePhrases(titleOf(label));
  const tokens = titleTokens(label);
  if (phrases.length === 0 && tokens.length === 0) return true; // nothing to name it by
  const otherPhrases = new Set(others.flatMap((o) => titlePhrases(titleOf(o))));
  const otherTokens = new Set(others.flatMap((o) => titleTokens(o)));
  if (phrases.some((ph) => !otherPhrases.has(ph) && hasWords(t, ph))) return true;
  return tokens.some((w) => !otherTokens.has(w) && hasWords(t, w));
}

/** Every attached villa is named in the text. The deterministic gate — not a heuristic. */
export function allAttachmentsNamed(
  text: string,
  attachments: Array<{ label?: string }>,
): boolean {
  const labels = attachments.map((a) => a.label ?? "");
  return labels.every((label, i) => textNamesVilla(text, label, labels.filter((_, j) => j !== i)));
}

/** The attached villas this text does NOT name (matcher labels, as attached). */
function missingLabels(text: string, attachments: Array<{ label?: string }>): string[] {
  const labels = attachments.map((a) => a.label ?? "");
  return labels.filter((label, i) => !textNamesVilla(text, label, labels.filter((_, j) => j !== i)));
}

/** A villa described for a client from its matcher label: title, area, monthly price. */
function describeForAppendix(label: string): string {
  const title = titleOf(label).trim();
  const area = /\(([^,)]+)/.exec(label)?.[1]?.trim() ?? "";
  const price = /Rp\s?[\d.,]+\s?(?:million|billion)\/mo/i.exec(label)?.[0]?.replace(/\/mo$/i, "/month") ?? "";
  const inArea = area && !title.toLowerCase().includes(area.toLowerCase()) ? ` in ${area}` : "";
  return `${title}${inArea}${price ? ` at ${price}` : ""}`;
}

/**
 * The exit invariant of every path that produces text over links: each attached
 * villa is named. The writer and the reconcile step are models and can drop
 * one (Jared, 2026-09-04: three links, two named — twice in a row). When they
 * do, the missing villas are appended deterministically rather than letting a
 * half-matched message reach the inbox. Loud in the log, because it should be
 * rare.
 */
export function ensureAllNamed(text: string, attachments: Array<{ label?: string }>): string {
  const missing = missingLabels(text, attachments);
  if (missing.length === 0 || attachments.length === 0) return text;
  logger.warn({ missing: missing.map((m) => titleOf(m)) }, "text still leaves attached villas unnamed — appending them deterministically");
  return `${text.trim()}\n\nAlso attached: ${missing.map(describeForAppendix).join("; ")}.`;
}

/** The block the writer is given: the exact villas riding with this message. */
export function attachedVillasBlock(attachments: Array<{ label?: string; url?: string }>): string {
  if (attachments.length === 0) return "";
  const list = attachments.map((a, i) => `${i + 1}. ${a.label ?? a.url}`).join("\n");
  return `\n\nTHE VILLAS ATTACHED TO THIS EXACT MESSAGE — these ${attachments.length}, and no others:\n${list}\nName each of them by its title as written here, mentioning its area naturally in the sentence — never as a bracket after the title, most titles already say where it is. Do not describe, recommend or allude to any villa that is not on this list — the client will open exactly these links under your words.`;
}

/**
 * The reverse direction: which catalog villas does this text name? Used when a
 * broker rewrites the words — the links follow what they wrote. Precision over
 * recall on purpose: a miss keeps the links the broker already saw, a false
 * match attaches a villa nobody chose. So a phrase counts only when exactly
 * ONE villa in the catalog carries it, and a single phrase needs the villa's
 * area beside it.
 */
export function villasNamedInText(
  text: string,
  catalog: Array<{ id: string; title: string; area: string | null }>,
): string[] {
  const t = normText(text);
  const byUrl = Array.from((text ?? "").matchAll(/\/property\/([a-z0-9-]+)/gi)).map((m) => m[1]!.toUpperCase());
  const owners = new Map<string, Set<string>>();
  for (const p of catalog) {
    for (const ph of new Set(titlePhrases(p.title ?? ""))) {
      const s = owners.get(ph) ?? new Set<string>();
      s.add((p.id ?? "").toUpperCase());
      owners.set(ph, s);
    }
  }
  const named: string[] = [];
  for (const p of catalog) {
    const id = (p.id ?? "").toUpperCase();
    if (!id) continue;
    const title = normWords(p.title ?? "").join(" ");
    if (title.length >= 12 && hasWords(t, title)) {
      named.push(id);
      continue;
    }
    const hits = titlePhrases(p.title ?? "").filter((ph) => owners.get(ph)?.size === 1 && hasWords(t, ph));
    if (hits.length === 0) continue;
    const areaOk = normWords(p.area ?? "").some((w) => w.length > 3 && hasWords(t, w));
    if (hits.length >= 2 || areaOk) named.push(id);
  }
  return Array.from(new Set([...byUrl, ...named]));
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
  /** A concrete defect the final check found (wrong count, a stray villa) — told to the rewrite. */
  extraNote?: string,
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
  if (!contradicts) return ensureAllNamed(text, attachments);

  const list = attachments.map((a, i) => `${i + 1}. ${a.label ?? a.url}`).join("\n");
  // Deliberately NOT told the budget. Given it, this step kept making arithmetic
  // claims that were wrong ("both sit above the 63 million you mentioned" with one
  // at 55). Its job is making the words match the links; budget honesty belongs to
  // the main prompt, which has the inventory and the numbers.
  const budgetLine = "";
  const systemFor = (missingNote: string) => `You correct one specific inconsistency in a WhatsApp message a broker is about to send.

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

Output only the corrected message.${missingNote}`;
  const rewrite = async (missingNote: string): Promise<string | null> => {
    const fixed = await chatCompletion({
      model: WRITER_MODEL,
      label: "reconcile",
      system: systemFor(missingNote),
      messages: [{ role: "user", content: text }],
      max_tokens: 400,
    });
    const out = sanitizeSuggestion(fixed.content);
    return out.trim().length > 20 ? out : null;
  };
  try {
    let out = await rewrite(extraNote ? `\n\n${extraNote}` : "");
    if (out && !allAttachmentsNamed(out, attachments)) {
      // The rewrite itself dropped a villa. Once more, with the omission named.
      const missing = missingLabels(out, attachments);
      logger.warn({ missing: missing.map((m) => titleOf(m)) }, "reconcile: rewrite left attached villas unnamed — second attempt");
      const again = await rewrite(
        `\n\nYOUR PREVIOUS ATTEMPT LEFT THESE ATTACHED VILLAS OUT. This time EVERY one of them must be named in the message, by its title, with its area and price:\n${missing.map((m) => `- ${m}`).join("\n")}`,
      );
      if (again) out = again;
    }
    if (out) {
      logger.info({ attachments: attachments.length }, "reconciled the reply with its attachments");
      return ensureAllNamed(out, attachments);
    }
  } catch (err) {
    logger.warn({ err }, "attachment reconciliation failed (non-fatal, keeping the draft)");
  }
  return ensureAllNamed(text, attachments);
}

// ── The request is the filter; the finished draft is checked against it ─────
// (owner, 2026-09-14: «предлагать нужно только в нём»). Every generator of a
// client-facing draft — both generateSuggestion copies, both follow-up
// writers — hands its text and links to enforceRequestOnDraft. The prompt
// asks; this checks, deterministically:
//  · every attached villa is published and inside the request (requestMisfits);
//  · the text names every attached villa (allAttachmentsNamed);
//  · a number of villas in the text equals the number attached ("two more
//    options" over three links, 23548815);
//  · the text names no villa that is neither attached nor already sent (a
//    Tumbak Bayuh villa described with nothing under it, 23552139);
//  · no "link below" with no link.

/**
 * The shortlist decision as the writer must hear it: the request the links
 * passed, or — when nothing is inside it — an honest "nothing exactly within
 * your request right now" and ONE question about which part could flex.
 */
export function shortlistPromptBlock(picked: PickedAttachments | null | undefined): string {
  const o = picked?.outcome;
  if (!picked || !o || !o.hasCore) return "";
  const req = describeRequest(o.request);
  const advisory =
    (o.sentOutside.length > 0
      ? `\n\nALREADY SENT, BUT OUTSIDE THIS CLIENT'S REQUEST (${req}): ${o.sentOutside.map((v) => `"${v.title}" (${v.why.join("; ")})`).join(", ")}. Never call these a match or say they fit their budget, area, size or dates, and do not push a viewing of them unless the client themselves is asking about one.`
      : "") +
    (o.namedOutside.length > 0
      ? `\n\nTHE VILLA THE CLIENT ASKED ABOUT OR CLICKED IS OUTSIDE THEIR OWN REQUEST: ${o.namedOutside.map((v) => `"${v.title}" (${v.why.join("; ")})`).join(", ")}. If you mention it, give that real reason in plain words (e.g. "it is only free from October 2027"); never invent another one.`
      : "");
  if (picked.skipped || o.declined) return advisory;
  if (picked.attachments.length > 0) {
    return `\n\nTHE CLIENT'S REQUEST, AS THE FILTER: ${req}. Every attached villa is inside it. If you give a number of villas, it is exactly ${picked.attachments.length}.${advisory}`;
  }
  const question = relaxQuestion(o.hint);
  const exceptExample = o.hint?.example ? " except the one closest option the question below names" : "";
  if (o.fitCountInclSent > 0) {
    return `\n\nEVERYTHING WE HAVE INSIDE THIS CLIENT'S REQUEST (${req}) HAS ALREADY BEEN SENT TO THEM. Nothing new is attached. Say honestly that what they already have is what we have for that brief right now; never promise to find, check, pull together or send more, never name or describe any other villa${exceptExample}, never write "below" or "attached". Ask exactly ONE question: ${question}.${advisory}`;
  }
  return `\n\nNOTHING IN OUR CATALOG IS EXACTLY WITHIN THIS CLIENT'S REQUEST RIGHT NOW (${req}). No villa is attached to this message. Say that honestly in one short sentence in your own voice — never imply we have a match, never claim we cover or regularly work in that area, never name or describe a specific villa${exceptExample}, never write "below" or "attached", and never promise to check, find or send options later ("let me check and come back with a proper shortlist" is exactly that promise). Then ask exactly ONE question: ${question}. One question only — no second question about arrival or viewings — and do not re-ask what they already told you.${advisory}`;
}

/** The closest real option as a client may hear it: size, area, price, free date — never a code or a title. */
export function describeRelaxExample(e: RelaxExample): string {
  const size = e.bedrooms ? `${e.bedrooms}-bedroom villa` : "villa";
  const price = e.priceIdr > 0 ? ` at Rp ${Math.round(e.priceIdr / 100_000) / 10} million a month` : "";
  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  const free =
    e.freeFrom && e.freeFrom > today
      ? `, free from ${new Date(`${e.freeFrom}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" })}`
      : "";
  return `a ${size} in ${e.area ?? "another area"}${price}${free}`;
}

/**
 * The ONE question when nothing is inside the request (owner, 14.09.2026):
 * which part could flex, naming the closest real option — "there is a
 * 1-bedroom in Pererenan at Rp 30 million, would that work?" — instead of
 * "could the area flex?" or "I'll come back with a proper shortlist".
 */
export function relaxQuestion(h: RelaxHint | null | undefined): string {
  if (!h) return "whether the area, the budget or the number of bedrooms could flex";
  const base = h.dim === "budget" ? `whether they could consider ${h.suggestion}` : `whether ${h.suggestion} would work for them`;
  if (!h.example) return base;
  const option = describeRelaxExample(h.example);
  return `${base}, naming the closest real option in plain words — there is ${option} (e.g. "There is ${option}, would that work for you?")`;
}

/** Nothing inside the request exists at all (not even among villas sent) — no viewing to push, one question only. */
export function nothingInsideRequest(picked: PickedAttachments | null | undefined): boolean {
  const o = picked?.outcome;
  return !!picked && !picked.skipped && !!o && o.hasCore && !o.declined && o.fitCountInclSent === 0 && picked.attachments.length === 0;
}

const INTERNAL_CODE = /\b(R-[A-Z]{2,6}-[A-Z0-9]{2,5}|UP-\d{3,5})\b/g;

/** Our catalog codes never reach a client: replaced by the villa's title (links untouched). */
function replaceInternalCodes(text: string, byId: Map<string, { title: string }>, leadId: string): string {
  let replaced = 0;
  const out = String(text ?? "").replace(INTERNAL_CODE, (code: string, _g: string, offset: number, whole: string) => {
    if (/\/property\/$/i.test(whole.slice(Math.max(0, offset - 10), offset))) return code;
    replaced++;
    return byId.get(code.toUpperCase())?.title ?? "the villa";
  });
  if (replaced > 0) logger.warn({ leadId, replaced }, "draft check: internal listing codes in the text replaced by villa names");
  return out;
}

async function removePromiseOfOptions(text: string, leadId: string): Promise<string> {
  try {
    const out = await chatCompletion({
      model: WRITER_MODEL,
      label: "draft-check:no-promise",
      system: `You edit one WhatsApp message a broker is about to send a client. Nothing inside the client's request exists in our catalog right now, so the message must not promise to find, prepare, pull together, shortlist or send villas or options later. Remove only such promises. Keep everything else exactly as written — the greeting, the honest statement, the question, the language and the voice. Output only the message.`,
      messages: [{ role: "user", content: text }],
      max_tokens: 500,
    });
    const cleaned = sanitizeSuggestion(out.content);
    if (cleaned.trim().length > 15) {
      logger.warn({ leadId }, "draft check: removed a promise of options when nothing is inside the request");
      return cleaned;
    }
  } catch (err) {
    logger.warn({ err, leadId }, "draft check: could not remove the promise of options (non-fatal)");
  }
  return text;
}

const COUNT_WORD: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  "a couple of": 2, "couple of": 2, "a pair of": 2,
};
const COUNTED_VILLAS =
  /\b(one|two|three|four|five|six|a couple of|couple of|a pair of|[1-6])\s+(?:(?:more|other|new|further|additional|fresh|great|good|strong|solid|lovely|nice|beautiful|similar|different)\s+){0,2}(options?|villas?|places?|properties|listings?|homes?|matches|choices)\b/gi;
const REFERS_BACK = /\b(sent|shared|earlier|yesterday|last (week|time)|before|already|previous(ly)?|you (saw|viewed|liked))\b/i;

/** How many villas the text presents with THIS message ("two more options"), or null when it gives no number. Sentences that refer back ("the three I sent") do not count. */
export function presentedVillaCount(text: string): number | null {
  let total = 0;
  let found = false;
  for (const sentence of String(text ?? "").split(/(?<=[.!?\n])\s+/)) {
    if (REFERS_BACK.test(sentence)) continue;
    for (const m of sentence.matchAll(COUNTED_VILLAS)) {
      const w = m[1]!.toLowerCase();
      const n = COUNT_WORD[w] ?? Number(w);
      if (n > 0) {
        total += n;
        found = true;
      }
    }
  }
  return found ? total : null;
}

const DANGLING_LINKS =
  /\b(links?|details|photos|options|villas|listings)\s+(are\s+|is\s+)?(below|attached)\b|\b(see|check|open)\s+(the\s+)?links?\b|\b(link|links) (under|after) (this|my) message\b/i;

/** With nothing attached, a sentence pointing at links is removed outright (the model already had its chance). */
function stripDanglingLinkPromises(text: string, leadId: string): string {
  if (!DANGLING_LINKS.test(text)) return text;
  const lines = text.split("\n").map((line) =>
    line
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => !DANGLING_LINKS.test(sentence))
      .join(" "),
  );
  const out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (out.length < 15) return text;
  logger.warn({ leadId }, "draft check: removed a sentence pointing at links when none are attached");
  return out;
}

async function removeVillaMentions(text: string, titles: string[], leadId: string): Promise<string> {
  try {
    const out = await chatCompletion({
      model: WRITER_MODEL,
      label: "draft-check:strip-unattached",
      system: `You edit one WhatsApp message a broker is about to send a client. It mentions these villas, which are NOT attached to it and were never sent to the client: ${titles.join("; ")}. Remove every mention of them, with any price or detail about them. Keep everything else exactly as written — same language, same voice, same greeting, same closing question. Output only the message.`,
      messages: [{ role: "user", content: text }],
      max_tokens: 500,
    });
    const cleaned = sanitizeSuggestion(out.content);
    if (cleaned.trim().length > 15) {
      logger.warn({ leadId, titles }, "draft check: removed villas the text named with nothing attached");
      return cleaned;
    }
  } catch (err) {
    logger.warn({ err, leadId }, "draft check: could not remove unattached villas (non-fatal)");
  }
  return text;
}

const propertyIdOf = (url: string | null | undefined): string | null =>
  String(url ?? "").match(/\/property\/([A-Za-z0-9-]+)/i)?.[1]?.toUpperCase() ?? null;

/**
 * "Are you looking for this villa for yourself, or helping someone else?" —
 * asked in front of the villa to clients whose request was already known
 * (Lance and Chloé, 13.09 follow-ups). It came from a learned lesson (Amelia,
 * followup, 12-14.09) that broker-corrections.ts now refuses; this is the
 * final-text half, so no lesson or model habit can put it back.
 */
const WHO_IS_IT_FOR =
  /\bfor (your ?self|yourselves|your own (move|stay|use|family))\b|\b(helping|on behalf of|sourcing (it |this )?for|representing) (someone|somebody|a (client|friend|colleague))\b|\b(someone|somebody) else\b|\bdecision[- ]?mak(er|ers|ing)\b/i;

function stripWhoIsItForQuestion(text: string, leadId: string): string {
  if (!WHO_IS_IT_FOR.test(text)) return text;
  const out = text
    .split("\n")
    .map((line) => {
      const kept: string[] = [];
      for (const sentence of line.split(/(?<=[.!?])\s+/)) {
        if (!WHO_IS_IT_FOR.test(sentence)) {
          kept.push(sentence);
          continue;
        }
        // "Hi Lance, quick one before …, are you looking for yourself?" keeps "Hi Lance,".
        const greeting = /^((?:hi|hey|hello|good (?:morning|afternoon|evening)|morning)\b[^,.!?]{0,40}[,!])/i.exec(sentence);
        if (greeting) kept.push(greeting[1]!);
      }
      return kept.join(" ");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (out.length < 15) return text;
  logger.warn({ leadId }, "draft check: removed a who-is-the-villa-for question (the request is already known)");
  return out;
}

/**
 * THE final check every generator runs on a finished draft (see the block
 * comment above). Returns the text and the links that may actually go out.
 */
export async function enforceRequestOnDraft(opts: {
  leadId: string;
  text: string;
  attachments: GeneratedSuggestion["attachments"];
  picked?: PickedAttachments | null;
  language?: string | null;
  /** A Rental client draft — the who-is-the-villa-for question is removed. */
  rental?: boolean;
}): Promise<{ text: string; attachments: GeneratedSuggestion["attachments"]; dropped: string[] }> {
  const request = opts.picked?.outcome?.request ?? null;
  const alreadySent = new Set((opts.picked?.excludeIds ?? []).map((i) => i.toUpperCase()));
  const catalog = await fetchAllPropertiesForPriceLookup().catch(() => [] as Awaited<ReturnType<typeof fetchAllPropertiesForPriceLookup>>);
  const byId = new Map(catalog.map((p) => [p.id.toUpperCase(), p]));
  const sourceText = replaceInternalCodes(opts.text, byId, opts.leadId);
  const dropped: string[] = [];
  let attachments = opts.attachments;
  if (catalog.length > 0) {
    attachments = opts.attachments.filter((a) => {
      const id = propertyIdOf(a.url);
      if (!id) return true;
      const p = byId.get(id);
      if (!p) {
        dropped.push(`${id}: not published`);
        return false;
      }
      if (request && requestHasCore(request)) {
        const why = requestMisfits(p, request);
        if (why.length > 0) {
          dropped.push(`${id}: ${why.join("; ")}`);
          return false;
        }
      }
      return true;
    });
  }
  // A villa the client already received is never attached again, whichever
  // path picked it (owner, 14.09.2026).
  if (alreadySent.size > 0) {
    attachments = attachments.filter((a) => {
      const id = propertyIdOf(a.url);
      if (id && alreadySent.has(id)) {
        dropped.push(`${id}: already sent to this client`);
        return false;
      }
      return true;
    });
  }
  if (dropped.length > 0) {
    logger.warn(
      { leadId: opts.leadId, dropped, request: request ? describeRequest(request) : null },
      "draft check: attachments outside the request, unpublished or already sent — removed",
    );
  }

  const attachedIds = new Set(attachments.map((a) => propertyIdOf(a.url)).filter((x): x is string => !!x));
  const attachedTitles = new Set(attachments.map((a) => titleOf(a.label ?? "").trim().toLowerCase()).filter(Boolean));
  const strays = (t: string): string[] =>
    catalog.length === 0
      ? []
      : villasNamedInText(t, catalog).filter((id) => {
          if (attachedIds.has(id) || alreadySent.has(id)) return false;
          const title = (byId.get(id)?.title ?? "").trim().toLowerCase();
          return !attachedTitles.has(title);
        });

  const count = presentedVillaCount(sourceText);
  const countWrong = count !== null && attachments.length > 0 && count !== attachments.length;
  const strays1 = strays(sourceText);
  const force = dropped.length > 0 || !allAttachmentsNamed(sourceText, attachments) || countWrong || strays1.length > 0 || sourceText !== opts.text;
  const note = [
    countWrong ? `THE MESSAGE MUST PRESENT EXACTLY ${attachments.length} VILLA(S) — it currently speaks of ${count}. Fix the number.` : "",
    strays1.length > 0 ? `IT ALSO NAMES VILLAS THAT ARE NOT ATTACHED AND WERE NEVER SENT: ${strays1.map((id) => byId.get(id)?.title ?? id).join("; ")}. Remove every mention of them.` : "",
  ].filter(Boolean).join("\n");
  let text = await reconcileTextWithAttachments(sourceText, attachments, force && attachments.length > 0 ? true : force, null, opts.language ?? null, note || undefined);

  const strays2 = strays(text);
  if (strays2.length > 0) text = await removeVillaMentions(text, strays2.map((id) => byId.get(id)?.title ?? id), opts.leadId);
  if (attachments.length === 0) text = stripDanglingLinkPromises(text, opts.leadId);
  const o = opts.picked?.outcome;
  if (attachments.length === 0 && o && o.hasCore && o.fitCount === 0 && !o.declined && !opts.picked?.skipped && ASKS_OR_PROMISES_TO_SEND.test(text)) {
    text = await removePromiseOfOptions(text, opts.leadId);
  }
  if (opts.rental) text = stripWhoIsItForQuestion(text, opts.leadId);
  const count2 = presentedVillaCount(text);
  if (count2 !== null && attachments.length > 0 && count2 !== attachments.length) {
    logger.warn({ leadId: opts.leadId, said: count2, attached: attachments.length }, "draft check: the text still gives a different number of villas than attached");
  }
  return { text, attachments, dropped };
}

/**
 * The send-time half, for approve.ts: a link whose listing is no longer
 * published opens nothing or shows no price (R-AME-028 went back to draft on
 * 14.09 while a follow-up carrying it waited in the inbox). An unreadable
 * catalog drops nothing.
 */
export async function dropUnpublishedAttachments<T extends { url?: string | null }>(attachments: T[], leadId?: string | null): Promise<T[]> {
  const withIds = attachments.filter((a) => propertyIdOf(a.url));
  if (withIds.length === 0) return attachments;
  const catalog = await fetchAllPropertiesForPriceLookup().catch(() => []);
  if (catalog.length === 0) return attachments;
  const live = new Set(catalog.map((p) => p.id.toUpperCase()));
  const kept = attachments.filter((a) => {
    const id = propertyIdOf(a.url);
    return !id || live.has(id);
  });
  if (kept.length !== attachments.length) {
    logger.warn(
      { leadId, dropped: attachments.filter((a) => !kept.includes(a)).map((a) => propertyIdOf(a.url)) },
      "approve: links to listings that are not published — removed before sending",
    );
  }
  return kept;
}

// ── Viewing push ────────────────────────────────────────────────────────────
// The owner (10.09.2026): "показ — ключевая метрика, ведущая к сделке;
// предлагать слот всем". Two weeks of data: 41 clients replied after a
// shortlist, 6 were asked about a viewing with anything concrete, 30 never
// heard the word from us. And the same day: "не перегнуть… чтобы триггер
// был, но выглядело как Амелино сообщение" — the trigger is ours, the words
// are the broker's. So the push is a deterministic trigger, a block that
// shows the writer the broker's OWN viewing invitations as the style, and a
// check on the draft that, when it fails, inserts one sentence in that voice
// rather than rewriting the message.
const HARD_NO = /(found (a|another|our|the) (place|villa|one|apartment)|already (booked|rented|signed|found)|no longer (looking|need|interested)|not interested|none of (these|them|those)|unsubscribe|stop (messaging|texting|writing|contacting)|don'?t (contact|message|text) me)/i;
const SLOT_WORDS = /(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this (morning|afternoon|evening|weekend)|next (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\bat \d{1,2}(:\d{2})?\b|\b\d{1,2}(st|nd|rd|th)?\s+(of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(st|nd|rd|th)?\b|\bon the \d{1,2}(st|nd|rd|th)\b)/i;
// The broker's own moves: "are you in Bali?", "which day suits?", "I can check
// the owner's availability", "virtual viewing before your arrival".
const TIME_ASK = /((which|what) (day|date|time)|when (do|will|would|could)? ?you (arrive|be|land|come|get)|(are|will) you (currently |already |still )?(in bali|on the island|here|around)|you'?(re| are) (currently |already |still )?(in bali|on the island|here)|once you('re| are) (here|in bali|on the island)|(today|tomorrow|this week)'?s? availability|check (for )?(the |their |owner'?s? )?availability|earliest|as soon as|asap|before your arrival|on arrival|your arrival|those (days|dates)|your dates|this week)/i;
const DIRECT_ASK = /(would you (like|want|prefer) (that|to|me|us|a|the)|shall (i|we)|do you (want|plan|prefer)|want me to (check|arrange|book|schedule|set)|(can|could) (i|we) (arrange|schedule|book|set up|line up|pencil)|(i|we) (can|could|will|'ll) (arrange|schedule|book|set up|line up|pencil|organi[sz]e)|(set|line|setting|lining) up (the |a |some )?(viewing|visit)|would you still like|could you confirm)/i;
const PASSIVE_ONLY = /(whenever (you|it)('re| are)? (like|free|ready|suits?|want)|any ?time|let me know (when|if) you('re| are|'d| would)? ?(like|want|free|ready|keen))/i;
// "view" as a verb is Amelia's own most common line ("Are you currently in Bali
// to view some properties?") and was missing until 14.09: her examples never
// reached the prompt and a draft that already asked got a second insertion.
// Only the verb — "ocean view" / "rice field view" is not a viewing.
const VIEW_WORDS = /(viewing|visit|\b(to|and|can|could|come|go) view\b|\bview (some|the|it|them|this|that|these|those|both|either|a|any|one|properties|property|villas?|options?)\b|\bsee (it|them|the|this|that|both|either|one|villa|you (there|at|on))|show (you|it|them)|check (it|them) out|come (and|to) see|walk-?through|video (tour|call|walk)|\btour\b|meet (you )?(at|there)|take you (to|around|through))/i;

/**
 * Does this message move the client toward a viewing? A viewing word plus
 * either a time, a time-bound question ("are you in Bali?", "which day?",
 * "I can check today's availability") or a direct ask. "Happy to arrange a
 * viewing whenever you like" is not a move.
 */
export function proposesViewingSlot(text: string): boolean {
  if (!VIEW_WORDS.test(text)) return false;
  if (SLOT_WORDS.test(text) || TIME_ASK.test(text)) return true;
  return DIRECT_ASK.test(text) && !PASSIVE_ONLY.test(text);
}

/**
 * Is THIS the message that must push for a viewing? Rental, options already
 * sent, no viewing on the books, and the client's last word (if any) did not
 * end it. Silence after the links is pushed too — the follow-up carries the
 * question.
 */
export function viewingPushDue(
  messages: ReturnType<typeof parseDialogContent>["messages"],
  leadStage: string | null | undefined,
): boolean {
  const stage = (leadStage ?? "").toLowerCase();
  if (/viewing\s*(scheduled|done)|negotiat|contract|reserv|check\s*in|closed|lost|won/.test(stage)) return false;
  const firstLinkIdx = messages.findIndex((m) => m.from !== "lead" && /\/property\//i.test(m.text ?? ""));
  if (firstLinkIdx === -1) return false;
  const clientAfter = messages.slice(firstLinkIdx + 1).filter((m) => m.from === "lead");
  const last = clientAfter[clientAfter.length - 1]?.text ?? "";
  if (HARD_NO.test(last)) return false;
  return true;
}

/**
 * Is this "lead" actually the villa? Amelia writes to a villa from her phone
 * to book a client's viewing and sends it its own link; amoCRM opens a Rental
 * card on the reply, and the thread then looks exactly like "options sent, no
 * viewing yet" (23528767 Bu Nia, 23543021 Mireia — the bot asked the villa's
 * staff "are you currently in Bali?"). The signal is structured data, not the
 * language or the wording: the card's phone is the owner_phone the brokers
 * entered for a listing in the site's Internal data. Cached per lead; an
 * unreadable phone or phone list counts as "not the villa" (the push stays).
 */
const villaSideCache = new Map<string, { at: number; ttl: number; villa: boolean }>();
export async function isVillaSideContact(leadId: string | null | undefined): Promise<boolean> {
  const id = String(leadId ?? "").trim();
  if (!id) return false;
  const hit = villaSideCache.get(id);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.villa;
  const [phone, keys] = await Promise.all([leadPhone(id).catch(() => ""), villaContactPhoneKeys()]);
  const k = phoneKey(phone);
  const villa = Boolean(k && keys.has(k));
  // A real answer holds for hours; a failed read is retried in ten minutes.
  villaSideCache.set(id, { at: Date.now(), ttl: k && keys.size ? 6 * 3_600_000 : 10 * 60_000, villa });
  return villa;
}

/**
 * Everything the viewing push needs to know about the draft being written.
 * Every generator of a client-facing Rental draft builds one of these and asks
 * the three functions below — the gate, the prompt block and the check on the
 * finished text live HERE and nowhere else (14.09: the follow-up scheduler
 * wrote 35 of 45 post-shortlist drafts and had none of the three).
 */
export type ViewingPushContext = {
  leadId: string;
  pipeline: string | null | undefined;
  leadStage: string | null | undefined;
  messages: ReturnType<typeof parseDialogContent>["messages"];
  responsibleUser: string | null | undefined;
  kind?: string | null;
  lastLeadText?: string | null;
};

/** The ONE gate: Rental, options out, no viewing on the books, not a hard no, not the villa itself. */
export async function viewingPushApplies(ctx: ViewingPushContext): Promise<boolean> {
  if ((ctx.pipeline ?? "").trim().toLowerCase() !== "rental") return false;
  if (!viewingPushDue(ctx.messages, ctx.leadStage)) return false;
  if (await isVillaSideContact(ctx.leadId)) {
    logger.info({ leadId: ctx.leadId }, "viewing push: this number is a villa's own contact (Internal data) — no push");
    return false;
  }
  return true;
}

function baliToday(): string {
  return new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Makassar", weekday: "long", day: "numeric", month: "long" });
}

/**
 * The broker's own viewing invitations, from messages they sent themselves
 * (sender_type 'broker' — the phone, not the bot), newest first. These are
 * the style guide: the writer imitates them, and the insertion below is
 * written "as in these". Cached per broker for 15 minutes.
 */
const viewingExampleCache = new Map<string, { at: number; lines: string[] }>();
export async function brokerViewingExamples(responsibleUser: string | null | undefined): Promise<string[]> {
  const key = (responsibleUser ?? "").trim().toLowerCase();
  if (!key) return [];
  const hit = viewingExampleCache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.lines;
  const lines: string[] = [];
  try {
    const res = await db.execute(sql`
      SELECT m.text, m.lead_id FROM lead_messages m
      JOIN leads_sync l ON l.lead_id = m.lead_id
      WHERE m.sender_type = 'broker'
        AND lower(coalesce(l.pipeline, '')) = 'rental'
        AND lower(coalesce(l.responsible_user, '')) = ${key}
        AND m.sent_at > now() - interval '90 days'
        AND length(m.text) BETWEEN 30 AND 420
      ORDER BY m.sent_at DESC
      LIMIT 300`);
    for (const r of (res.rows ?? []) as Array<{ text: string | null; lead_id: string | null }>) {
      const t = (r.text ?? "").replace(/\s+/g, " ").trim();
      if (!t || /https?:\/\//i.test(t) || t.startsWith(">>")) continue;
      if (!proposesViewingSlot(t)) continue;
      // No video tours for now (owner, 10.09): a "virtual viewing" line would
      // be imitated.
      if (/video|virtual/i.test(t)) continue;
      // An invitation is short and asks something (or names when); a long
      // lead-specific update ("Evelyn the staff is cleaning the carpet today")
      // passes the detector but teaches nothing about the move.
      if (t.length > 220 || (!/\?/.test(t) && !TIME_ASK.test(t))) continue;
      if (lines.some((x) => x.slice(0, 40) === t.slice(0, 40))) continue;
      // A line written to a villa ("is the villa available to visit today?")
      // is not how the broker invites a client.
      if (await isVillaSideContact(r.lead_id)) continue;
      lines.push(t);
      if (lines.length >= 5) break;
    }
  } catch (err) {
    logger.warn({ err, broker: key }, "viewing push: could not read the broker's own examples (non-fatal)");
  }
  viewingExampleCache.set(key, { at: Date.now(), lines });
  return lines;
}

function examplesBlock(broker: string, examples: string[]): string {
  if (!examples.length) return "";
  return `\nThis is how ${broker} does it — their own recent messages, same voice, same moves:\n${examples.map((e) => `  · "${e}"`).join("\n")}`;
}

export function viewingPushBlock(broker: string, examples: string[]): string {
  return `

VIEWING PUSH. Options are out and no viewing is on the books yet; the next step is a viewing, not another link. This message moves them toward one — the way ${broker} does it, never as a template.${examplesBlock(broker, examples)}
Today is ${baliToday()} (Bali). What the message has to do, in ${broker}'s own words:
- name the villa(s) worth seeing — the ones they reacted to, else the best fit already sent;
- if the thread does not say whether they are in Bali or when they arrive, ask — the viewing is planned around it;
- on the island: ask which day suits, or offer to check the owner's availability for a day you name; a time the owner already confirmed in the thread is proposed as it stands;
- not on the island yet: ask when they arrive and offer to line up the viewings for those days; do not offer video tours or virtual viewings (owner, 10.09);
- a time the owner has not confirmed is "I'll check with the owner", never a booking;
- no new links unless they rejected everything sent; end on the viewing question, not on "let me know what you think".`;
}

/**
 * The draft must carry the move toward a viewing when the push is due. When
 * it does not, ONE sentence is inserted in the broker's own voice — with
 * their lessons and their own examples in front of the model — and the rest
 * of the draft stays verbatim. A second miss goes out as written and is
 * logged; a broker sees it, a silent loop does not.
 */
export async function enforceViewingProposal(
  text: string,
  attachments: GeneratedSuggestion["attachments"],
  opts: {
    leadId: string;
    due: boolean;
    lastLeadText: string;
    responsibleUser: string | null | undefined;
    kind: string | null | undefined;
    leadStage: string | null | undefined;
  },
): Promise<string> {
  if (!opts.due || proposesViewingSlot(text)) return text;
  const broker = brokerDisplayName(opts.responsibleUser) || "the broker";
  try {
    const [examples, lessons] = await Promise.all([
      brokerViewingExamples(opts.responsibleUser),
      correctionsPromptBlock(
        opts.responsibleUser,
        deriveSituation({ pipeline: "rental", kind: opts.kind, leadStage: opts.leadStage, lastLeadText: opts.lastLeadText }),
      ),
    ]);
    const out = await chatCompletion({
      model: WRITER_MODEL,
      label: "draft:viewing-push",
      max_tokens: 500,
      temperature: 0.3,
      system: `You are ${broker}, a rental broker in Bali, finishing your own WhatsApp message. The draft below is yours and stays as it is: every sentence, every villa name, the greeting and the sign-off, verbatim. It is missing one thing — a move toward a viewing. Insert ONE sentence (two at most) that makes that move, where it reads naturally (usually right before the sign-off), in your own voice.${examplesBlock(broker, examples)}
The move: if the thread does not say whether the client is in Bali or when they arrive, ask that; on the island — ask which day suits, or offer to check the owner's availability for a day; not on the island yet — ask when they arrive and offer to line up the viewings for those days (no video tours, no virtual viewings); a time the owner has not confirmed is "I'll check with the owner", never a booking. Today is ${baliToday()} (Bali). No links.${lessons}
Return the full message and nothing else.${attachments.length ? ` Villas attached under this message: ${attachments.map((a) => a.label).join("; ")}.` : ""}`,
      messages: [{ role: "user", content: `Client's last message: ${opts.lastLeadText.slice(0, 400)}\n\nYour draft:\n${text}` }],
    });
    const rewritten = sanitizeSuggestion(out.content ?? "").trim();
    const kept = rewritten.length >= Math.floor(text.length * 0.8);
    if (kept && proposesViewingSlot(rewritten) && allAttachmentsNamed(rewritten, attachments)) {
      logger.info({ leadId: opts.leadId, broker }, "viewing push: one sentence added in the broker's voice");
      return rewritten;
    }
    logger.warn({ leadId: opts.leadId, kept, proposes: proposesViewingSlot(rewritten) }, "viewing push: insertion did not pass — sending the draft as written");
    return text;
  } catch (err) {
    logger.warn({ err, leadId: opts.leadId }, "viewing push: insertion failed (non-fatal)");
    return text;
  }
}

/** The prompt half: the block in the broker's voice, or "" when the gate says no. */
export async function viewingPushPromptBlock(ctx: ViewingPushContext): Promise<string> {
  if (!(await viewingPushApplies(ctx))) return "";
  return viewingPushBlock(brokerDisplayName(ctx.responsibleUser) || "the broker", await brokerViewingExamples(ctx.responsibleUser));
}

/**
 * The text half, called on the FINISHED draft (after the attachment
 * reconciliation) by every generator: the move toward a viewing is there, or
 * one sentence in the broker's voice is inserted.
 */
export async function applyViewingPush(
  text: string,
  attachments: GeneratedSuggestion["attachments"],
  ctx: ViewingPushContext,
): Promise<string> {
  if (!text.trim()) return text;
  const lastLeadText = ctx.lastLeadText ?? [...ctx.messages].reverse().find((m) => m.from === "lead")?.text ?? "";
  return enforceViewingProposal(text, attachments, {
    leadId: ctx.leadId,
    due: await viewingPushApplies(ctx),
    lastLeadText,
    responsibleUser: ctx.responsibleUser,
    kind: ctx.kind,
    leadStage: ctx.leadStage,
  });
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
  /** The shortlist decision for THIS draft (pickPropertyAttachmentsDetailed) — the inventory line is written from it. */
  shortlist?: PickedAttachments | null;
}): Promise<string> {
  const recentLeadMessages = [
    opts.lastLeadText ?? "",
    ...opts.dialogMessages.filter((m) => m.from === "lead").slice(-25).reverse().map((m) => m.text),
  ].filter(Boolean);

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

  // What we can offer for what they asked — the SAME decision the attached
  // links came from, not a second count (availabilityForCriteria used to
  // extract the criteria again and could disagree with the shortlist).
  const stockLine = opts.shortlist ? shortlistPromptBlock(opts.shortlist) : "";

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

  // What the broker saw at the viewing — the one thing the thread cannot show.
  const viewingBlock = opts.isRental && opts.leadId ? await viewingReportPromptBlock(opts.leadId) : "";
  // Options out, no viewing yet: this message moves toward one, in the
  // broker's own voice — their real invitations are the style guide.
  // Same gate and block as the follow-up scheduler (viewingPushPromptBlock).
  const pushBlock = nothingInsideRequest(opts.shortlist) ? "" : await viewingPushPromptBlock({
    leadId: opts.leadId ?? "",
    pipeline: opts.isRental ? "rental" : null,
    leadStage: opts.leadStage,
    messages: opts.dialogMessages,
    responsibleUser: opts.responsibleUser,
    kind: opts.kind,
    lastLeadText: opts.lastLeadText,
  });

  return buildLeadNameRule(opts.dialogMessages) + attachedRule + anchorLine + stockLine + currencyRule + adRule + identityRule + viewingBlock + pushBlock + learned;
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

  // Links FIRST, then words — and the client's request decides which links
  // exist at all (strict: bedrooms, area, budget, dates). The writer is told
  // the exact villas, or that nothing is inside the request and which ONE
  // question to ask; the finished text is then checked against both.
  const picked = await pickPropertyAttachmentsDetailed({
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
  });

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
    shortlist: picked,
  });

  const completion = await chatCompletion({
    model: WRITER_MODEL,
    label: "draft",
    system: systemPrompt,
    ...(cachePrefix ? { cachePrefix } : {}),
    messages: [{ role: "user", content: prompt + promptAdditions + attachedVillasBlock(picked.attachments) }],
    max_tokens: 400,
  });

  const written = sanitizeSuggestion(completion.content);
  const checked = await enforceRequestOnDraft({ leadId: opts.leadId, text: written, attachments: picked.attachments, picked, rental: isRental });
  const text = nothingInsideRequest(picked) ? checked.text : await applyViewingPush(checked.text, checked.attachments, {
    leadId: opts.leadId,
    pipeline: opts.pipeline,
    leadStage: opts.leadStage,
    messages: dialog.messages,
    responsibleUser: opts.responsibleUser,
    kind: opts.kind,
    lastLeadText,
  });

  return { text, attachments: checked.attachments };
}
