import { db, pool, leadsSyncTable, pendingSuggestionsTable, aiSuggestionsTable, leadMessagesTable } from "@workspace/db";
import { lt, isNotNull, eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { chatCompletion, chatCompletionJSON, WRITER_MODEL, HELPER_MODEL } from "./ai-client";
import { nextFollowupDate, parseDialogContent, formatDialogForAI, countTrailingOurMessages, describeConversationTiming, conversationWindow } from "./dialog-parser";
import { getFollowupSteps, getQualificationSteps } from "./settings";
import { createHash } from "node:crypto";
import { logger } from "./logger";
import { sanitizeSuggestion, AVOID_PHRASES_REMINDER } from "./sanitize-suggestion";
import { OBJECTION_PLAYBOOK, type PlaybookEntry } from "./objection-playbook";
import { shouldSuppressPush, isStageWhitelisted } from "./stage-routing";
import { getPushStageWhitelist, isPushStageAllowed, usesOwnStageVocabulary } from "./push-stage-whitelist";
import { getMergedConversation, getMergedDialog } from "./merged-conversation";
import { buildTemplateMessage, buildFollowupTemplateByLevel, selectVariant } from "./followup-templates";
import { generateSuggestion, pickPropertyAttachments, reconcileTextWithAttachments, type GeneratedSuggestion } from "./generate-suggestion";
import { isAdaptiveBroker, isHosTrackedPipeline } from "./adaptive-followup";
import { notifyBrokerForLead } from "./push-notifications";
import { refreshLeadProfile } from "./lead-profile";
import { isBroker, brokerKey, brokerDisplayName } from "./broker-identity";
import { processSourcedLeadOutreach } from "./sourced-lead-outreach";
import { processAdLeadBrokerOpening } from "./ad-lead-autoreply";
import { processListingAcquisitionOutreach } from "./listing-acquisition-outreach";
import { processWeeklyAvailabilityCheck } from "./weekly-availability-check";
import { processListingOwnerFollowup } from "./listing-owner-followup";
import { processHandoverDrafts } from "./handover-draft";
import { isListingAcquisitionPipeline } from "./listing-acquisition-prompt";
import { logStuckLeads } from "./stuck-leads";
import { logUnknownPipelines, isReachStageName } from "./pipelines";
import { amoFetch } from "./amo-client";
import { correctionsPromptBlock } from "./broker-corrections";
import { maybeAutopilot } from "./autopilot";
import { enforceBudgetFilter } from "./budget-filter";
import { classifyStageInBackground } from "../routes/amocrm-webhook.js";

/**
 * True when the timeline (lead_messages) holds a message FROM THE LEAD that is
 * newer than anything in leads_sync.content.
 *
 * The two stores disagree by design: content is webhook-fed and can silently
 * stop updating for a channel, while the 45s timeline poll keeps writing. When
 * they disagree about who spoke last, the timeline is the one telling the truth.
 * 60s of slack absorbs clock differences between the sources for what is really
 * the same message.
 */
async function hasNewerLeadMessage(leadId: string, contentLastMs: number): Promise<boolean> {
  try {
    const [row] = await db
      .select({ senderType: leadMessagesTable.senderType, sentAt: leadMessagesTable.sentAt })
      .from(leadMessagesTable)
      .where(eq(leadMessagesTable.leadId, leadId))
      .orderBy(desc(leadMessagesTable.sentAt))
      .limit(1);
    if (!row || row.senderType !== "lead") return false;
    return row.sentAt.getTime() > contentLastMs + 60_000;
  } catch (err) {
    // Never let this check be the reason a follow-up stops working — but say so.
    // A bare `catch {}` here hid a missing import for hours: the helper threw on
    // every call and silently reported "no newer message", so the guard it
    // implements was inert while looking deployed.
    logger.error({ err, leadId }, "hasNewerLeadMessage failed — falling back to content-only");
    return false;
  }
}

/**
 * The mirror of hasNewerLeadMessage: does the timeline know about an OUTGOING
 * message newer than what the webhook-fed content shows? content freezes for
 * WhatsApp replies (manual and Salesbot alike), so "content says the lead spoke
 * last" is routinely a lie about an already-answered lead. Trusting it wiped
 * the follow-up clock the send had set — the scheduler's own defensive check
 * was the second eraser behind "answered → nothing scheduled" (Yudi's Rental
 * leads sat from 07.08 because of this exact branch).
 */
async function ourMessageIsNewest(leadId: string, contentLastMs: number): Promise<boolean> {
  try {
    const [row] = await db
      .select({ senderType: leadMessagesTable.senderType, sentAt: leadMessagesTable.sentAt })
      .from(leadMessagesTable)
      .where(eq(leadMessagesTable.leadId, leadId))
      .orderBy(desc(leadMessagesTable.sentAt))
      .limit(1);
    if (!row || row.senderType === "lead") return false;
    return row.sentAt.getTime() > contentLastMs - 60_000;
  } catch (err) {
    logger.error({ err, leadId }, "ourMessageIsNewest failed — falling back to content-only");
    return false;
  }
}

/**
 * What a follow-up notification SAYS on the broker's phone.
 *
 * Never our own draft. A notification whose body is the copilot's suggested
 * text reads exactly like a message FROM the client — Amelia reported it the
 * morning after follow-up notifications shipped: "it's not a message from the
 * client, it's a suggestion for me, looks weird". The long-standing rule for
 * LIVE is that a notification carries the lead's own incoming message; a
 * follow-up has no incoming message by definition, so it states the job.
 */
function followupNoticeBody(lastContactAt: Date | null | undefined): string {
  const base = "Follow-up ready to send";
  if (!lastContactAt) return base;
  const days = Math.floor((Date.now() - lastContactAt.getTime()) / 86_400_000);
  if (days < 1) return base;
  return `${base} — quiet for ${days} day${days === 1 ? "" : "s"}`;
}

async function classifyObjection(
  conversationSnippet: string,
  brokerName: string,
): Promise<PlaybookEntry> {
  const categories = OBJECTION_PLAYBOOK.map(
    (e, i) => `${i + 1}. ${e.id} — ${e.description}`,
  ).join("\n");

  const completion = await chatCompletion({
    // Picks one label off a list — mechanical, never read by a client. Sonnet
    // was three times the price for a twenty-token answer.
    model: HELPER_MODEL,
    label: "objection",
    system: "You are a Bali real estate sales coach. Based on the conversation snippet, identify which hidden objection is most likely blocking the lead. Reply with ONLY the id from the list, nothing else.",
    messages: [
      {
        role: "user",
        content: `Hidden objection categories:\n${categories}\n\nConversation:\n${conversationSnippet.slice(-1000)}\n\nBroker: ${brokerName}\n\nWhich hidden objection id best fits? Reply with one of: ${OBJECTION_PLAYBOOK.map((e) => e.id).join(", ")}`,
      },
    ],
    max_tokens: 20,
  });

  const raw = completion.content.toLowerCase();
  const matched = OBJECTION_PLAYBOOK.find((e) => raw.includes(e.id));
  return matched ?? OBJECTION_PLAYBOOK[0]!;
}

/**
 * The property links that ride WITH a follow-up — and the paragraph that tells
 * the writer, BEFORE it writes, which ones it actually has.
 *
 * Follow-ups were inserted with a hardcoded `attachments: []` on every path
 * while their text was free to say "link below" or "would you consider any of
 * these?". The client got the sentence and nothing under it — lead 23291217 on
 * 25.08, lead 23303055 on 28.08, and the owner's screenshots of both. LIVE
 * drafts never had this problem because they go through pickPropertyAttachments;
 * PUSH simply never called it. Same matcher, same gates (a lead already
 * discussing one of ours, or past the browsing stages, still gets nothing), so
 * the two paths cannot drift apart again.
 *
 * Telling the writer up front beats correcting it afterwards: a message written
 * knowing it has no shortlist never promises one, and there is no regex trying
 * to tell "here are two options" from "the two options I sent last week".
 */
async function followupListings(opts: {
  leadId: string;
  responsibleUser: string | null;
  pipeline: string | null;
  leadStage: string | null;
  leadNotes: string | null;
  messages: Awaited<ReturnType<typeof getMergedDialog>>["messages"];
  formattedDialog: string;
}): Promise<{ attachments: GeneratedSuggestion["attachments"]; brief: string }> {
  // Acquiring listings from owners is not a shortlist conversation at all.
  if (isListingAcquisitionPipeline(opts.pipeline)) {
    return { attachments: [], brief: "" };
  }
  const lastLeadText = [...opts.messages].reverse().find((m) => m.from === "lead")?.text ?? "";
  const attachments = await pickPropertyAttachments({
    leadId: opts.leadId,
    brokerId: opts.responsibleUser,
    isRental: (opts.pipeline ?? "").trim().toLowerCase() === "rental",
    contentSnippet: opts.formattedDialog,
    dialogMessages: opts.messages,
    formattedDialog: opts.formattedDialog,
    lastLeadText,
    leadStage: opts.leadStage,
    leadNotes: opts.leadNotes,
  }).catch((err) => {
    logger.warn({ err, leadId: opts.leadId }, "followup property matcher threw — writing without listings");
    return [] as GeneratedSuggestion["attachments"];
  });

  const brief = attachments.length
    ? `

PROPERTY LINKS ATTACHED TO THIS MESSAGE (${attachments.length}) — they are delivered right after it, automatically:
${attachments.map((a, i) => `${i + 1}. ${a.label}`).join("\n")}
Name each of them and say which area it is in. Quote only the prices above, never invent one. Never write a URL or an internal listing code — the links are attached. Never ask permission to send them or promise them "later": they are already on their way.`
    : `

YOU HAVE NO PROPERTY LINKS TO ATTACH TO THIS MESSAGE. Nothing will arrive after it. So do not write "here are", "below", "attached", "these options", "any of these", and do not promise to send or prepare anything — whatever you offer here would reach the client empty. Referring back to villas you already sent EARLIER in the conversation above is fine, and naming them is better than "the options I sent".`;

  return { attachments, brief };
}

export async function generateFollowup(opts: {
  leadId: string;
  responsibleUser: string | null;
  followupLevel: number;
  lastContent: string;
  leadNotes?: string | null;
  leadStage?: string | null;
  pipeline?: string | null;
  /** Pre-built corrections block to inject into system prompt */
  correctionsBlock?: string;
}): Promise<{
  text: string;
  entry: PlaybookEntry;
  rationale: string;
  formattedDialog: string;
  attachments: GeneratedSuggestion["attachments"];
}> {
  // The SIGNING name, not the login: "HoS" is an account, the person is Nick.
  const brokerName = brokerDisplayName(opts.responsibleUser) || opts.responsibleUser || "Broker";
  // content alone freezes — merge the timeline poll in (merged-conversation.ts).
  const parsedDialog = await getMergedDialog(opts.leadId, opts.lastContent);
  const formattedDialog = formatDialogForAI(parsedDialog.messages);
  const leadName =
    parsedDialog.messages.find((m) => m.from === "lead")?.senderName ?? "there";

  // What this message can honestly offer, decided BEFORE it is written.
  const listings = await followupListings({
    leadId: opts.leadId,
    responsibleUser: opts.responsibleUser,
    pipeline: opts.pipeline ?? null,
    leadStage: opts.leadStage ?? null,
    leadNotes: opts.leadNotes ?? null,
    messages: parsedDialog.messages,
    formattedDialog,
  });

  // Classify objection to decide which attachments to suggest.
  // The classification does NOT dictate the message text — it only selects
  // what supplementary materials (AirDNA screenshots, links, etc.) to attach.
  const entry = await classifyObjection(formattedDialog, brokerName);

  // Build a summary of available tactics so AI can reference them if relevant,
  // without being forced to use them.
  const tacticsHint = OBJECTION_PLAYBOOK.map((e) =>
    `- ${e.label}: ${e.description}`,
  ).join("\n");

  const leadContext = opts.leadNotes?.trim()
    ? `\nLead card notes: ${opts.leadNotes.trim()}`
    : "";

  // Write the follow-up from scratch, fully driven by conversation context.
  const completion = await chatCompletion({
    model: WRITER_MODEL,
    label: "followup",
    system: `You are ${brokerName}, a senior broker at Unicorn Property, Bali real estate. You are writing a WhatsApp follow-up to a lead who has not replied to your last message.

RULES:
- Read the FULL conversation carefully. Understand exactly where things left off.
- Write a message that fits the current situation:
  • If you agreed to call / meet → remind about that specific plan
  • If the lead asked a question that wasn't answered → answer it now or revisit it
  • If the lead went cold with no clear signal → re-engage with a relevant, non-pushy touch
  • If the lead expressed interest in a specific property or area → reference that
- The tone is human, direct, conversational — like a trusted advisor, not a salesperson
- WhatsApp style: short paragraphs, no bullet points, no long dashes, under 80 words
- Do NOT use generic openers like "Just checking in" or "Hope you're doing well"
- Do NOT use formal sign-offs
- Return ONLY the message body — no preamble, no quotes, no subject line

AVAILABLE TACTICS (use only if genuinely relevant to the conversation, not forced):
${tacticsHint}${listings.brief}${opts.correctionsBlock ?? (await correctionsPromptBlock(opts.responsibleUser, "followup"))}${AVOID_PHRASES_REMINDER}`,
    messages: [
      {
        role: "user",
        content: `Lead: ${leadName}${leadContext}
Follow-up #${opts.followupLevel}

Full conversation:
${formattedDialog}

Write the follow-up message.`,
      },
    ],
    max_tokens: 250,
    // NOTE: `temperature` is deprecated/rejected by the API for claude-sonnet-5
    // (returns a 400) — omit it rather than hardcoding a value.
  });

  // Same safety net the LIVE path has: the words must match the links that
  // will actually arrive, not the ones the writer imagined.
  const text = await reconcileTextWithAttachments(
    sanitizeSuggestion(completion.content),
    listings.attachments,
  );

  const rationale = `Follow-up #${opts.followupLevel} — context-aware. Situation tactic: ${entry.label}.`;

  return { text, entry, rationale, formattedDialog, attachments: listings.attachments };
}

/**
 * PUSH follow-ups for the active-funnel stages (Contact established / Needs
 * Assessed / Options Sent). Unlike generateFollowup() above, this always
 * writes a fresh, context-aware message — it does not fall back to a static
 * qual-script/template, since reusing the same canned text on every repeat
 * touch to the same lead defeats the point of personalization.
 *
 * `trailingUnanswered` = how many of our messages in a row the lead has left
 * unanswered (see countTrailingOurMessages). The prompt uses this to shift
 * tone: 0-2 = normal warm follow-up, 3+ = lower-pressure re-engagement — no
 * hardcoded script, the model just writes shorter and gives the lead an easy
 * out, since a broker doesn't have "cold lead scripts" written yet.
 */
export async function generatePushFollowup(opts: {
  responsibleUser: string | null;
  leadId: string;
  leadStage: string;
  lastContent: string;
  leadNotes?: string | null;
  trailingUnanswered: number;
  correctionsBlock?: string;
  pipeline?: string | null;
}): Promise<{ text: string; rationale: string; attachments: GeneratedSuggestion["attachments"] }> {
  const brokerName = opts.responsibleUser ?? "Broker";
  // Merge content + lead_messages so a push is never built from a frozen,
  // truncated thread (see lib/merged-conversation.ts).
  const mergedMessages = await getMergedConversation(opts.leadId, opts.lastContent);
  const now = new Date();
  const formattedDialog = formatDialogForAI(mergedMessages, 500, true);
  const timingSummary = describeConversationTiming(mergedMessages, now);
  const isCold = opts.trailingUnanswered >= 3;

  // What this follow-up can honestly offer — decided before a word is written.
  const listings = await followupListings({
    leadId: opts.leadId,
    responsibleUser: opts.responsibleUser,
    pipeline: opts.pipeline ?? null,
    leadStage: opts.leadStage,
    leadNotes: opts.leadNotes ?? null,
    messages: mergedMessages,
    formattedDialog,
  });

  const leadContext = opts.leadNotes?.trim()
    ? `\nLead card notes: ${opts.leadNotes.trim()}`
    : "";

  const completion = await chatCompletion({
    model: WRITER_MODEL,
    label: "followup",
    system: `You are ${brokerName}, a senior Bali real estate broker at Unicorn Property, writing a WhatsApp follow-up to a lead currently at CRM stage "${opts.leadStage}".

LANGUAGE RULE (absolute): Detect the language the lead writes in. Respond 100% in that language. Never mix languages. Default to English if unclear.

READ THE FULL CONVERSATION FIRST — including WHEN each message was sent (every line is timestamped, and a timing summary is provided). Then decide your approach:

0. TIMING IS CRITICAL — do not treat an old conversation as if it happened yesterday. Look at how long it has actually been since the last interaction:
   - If the last exchange was RECENT (days): follow up naturally, continuing the thread.
   - If it has been WEEKS OR MONTHS: acknowledge the gap honestly and naturally ("it's been a while", "hope things have moved along since we last spoke") rather than replying as if the previous message just arrived. Re-open warmly, don't pretend no time passed.
   - Consider whether the lead's last message actually warranted a reply. A bare closer ("ok thanks", "great, see you", 👍) did NOT need one, so no need to apologize for a gap — just re-engage with something fresh. But if the lead asked a real question or showed real interest and it went unanswered for a long time, address that gracefully (a light acknowledgment of the delay, then real value) instead of ignoring it.
   - Never reference a specific date/season/event from an old message as if it's still current (e.g. don't ask about a trip or deadline that has already passed).

1. GAUGE HOW TALKATIVE THE LEAD HAS BEEN — message count, message length, how much they've volunteered beyond bare answers.
   - TALKATIVE / expressive lead (shared context beyond bare facts — family, work, travel plans, lifestyle, reasons for buying, frustrations, excitement, etc.): write warmer and more personal. Reference a SPECIFIC detail they shared — business-related (budget, area, property type, timeline) AND personal if available. Show you remember them as a person, not just a lead record.
   - QUIET / terse lead (short answers, facts but little else) — especially common at "Contact established": do NOT try to be personal, it reads as fake. Lead with ONE piece of concrete value (a market insight, a relevant fact tied to what they asked about), then end with exactly ONE simple, easy-to-answer opening question that invites them back into conversation. Keep it short.

2. STAGE AWARENESS — but the CRM stage label can be STALE. Brokers sometimes forget to move a lead forward after real progress happens in the conversation (e.g. options were already sent, needs were already discussed, but the card is still sitting on "Contact established"). Treat the stage below as a HINT, not ground truth — if the actual conversation shows the lead is further along than the label says, respond to what's ACTUALLY happening in the conversation, not the label:
   - "Contact established": still early — the goal is to get them talking, not to sell. Value + one opening question. (Unless the conversation shows real needs/options already discussed — then treat it like Needs Assessed/Options Sent instead.)
   - "Needs Assessed" / "Options Sent": lead has already shared real criteria or seen options — be specific and consultative, reference what they actually said they want or what was sent, move them toward a concrete next step (call, viewing, narrowing down options).

3. FOLLOW-UP RECENCY: this lead has left ${opts.trailingUnanswered} of your messages in a row unanswered.${
      isCold
        ? " That's several touches with no reply — this is a re-engagement, not a normal follow-up. Keep it noticeably shorter and lower-pressure than a warm follow-up would be. Give them an easy, guilt-free way to respond (e.g. acknowledge they might be busy or have moved on) rather than piling on more information. Do NOT repeat what previous unanswered messages already said."
        : " Still within a normal follow-up rhythm — write as usual."
    }

4. GROUNDING: every message must reference something concrete from THIS conversation. Never a generic template. If the conversation is thin, say less — don't invent details.

STYLE:
- WhatsApp style: short, natural, conversational. No bullet points, no long dashes, no corporate tone.
- Under 80 words unless the situation genuinely needs more.
- No "Just checking in", "Hope you're doing well", or other filler openers.
- No formal sign-offs. Sign naturally if it fits, don't force it.
- Return ONLY the message body — no preamble, no quotes, no explanation of your reasoning.${listings.brief}${opts.correctionsBlock ?? ""}${AVOID_PHRASES_REMINDER}`,
    messages: [
      {
        role: "user",
        content: `TIMING:\n${timingSummary}\n\nLead card notes:${leadContext || " (none)"}\n\nFull conversation (each line timestamped, oldest → newest):\n${formattedDialog}\n\nWrite the follow-up message.`,
      },
    ],
    max_tokens: 250,
  });

  const text = await reconcileTextWithAttachments(
    sanitizeSuggestion(completion.content),
    listings.attachments,
  );
  const rationale = isCold
    ? `PUSH — re-engagement (${opts.trailingUnanswered} unanswered touches), stage "${opts.leadStage}".`
    : `PUSH — adaptive follow-up, stage "${opts.leadStage}".`;

  return { text, rationale, attachments: listings.attachments };
}

/**
 * Ask the AI to estimate when the NEXT follow-up should be sent,
 * based on signals in the conversation (client's arrival date, scheduled meeting,
 * expressed urgency, stated timeline, etc.).
 *
 * Returns defaultDelayMs unchanged when no clear contextual signal is found.
 */
async function estimateContextualDelay(
  formattedDialog: string,
  defaultDelayMs: number,
): Promise<{ delayMs: number; reason: string; contextual: boolean }> {
  try {
    const parsed = await chatCompletionJSON<{ delayHours?: number | null; reason?: string }>({
      model: HELPER_MODEL,
      label: "followup-timing",
      system: `You analyze a real estate sales conversation and decide the ideal timing for the next follow-up.

Look for concrete signals:
- Lead mentions when they arrive in Bali → follow up 1–2 days after arrival
- A viewing or meeting was scheduled → follow up the next day
- Lead said "I'll decide in X days" → respect that window
- Lead expressed strong interest / urgency → follow up sooner (within 1–2 days)
- Lead went cold, no clear signal → return null (use default timing)

Respond with JSON only: {"delayHours": <integer or null>, "reason": "<one short line>"}
Constraints: minimum 6 hours, maximum 360 hours (15 days). Return null if no clear signal.`,
      messages: [
        {
          role: "user",
          content: conversationWindow(formattedDialog),
        },
      ],
      max_tokens: 80,
      temperature: 0,
    });

    if (
      parsed.delayHours !== null &&
      parsed.delayHours !== undefined &&
      typeof parsed.delayHours === "number" &&
      parsed.delayHours >= 6 &&
      parsed.delayHours <= 360
    ) {
      return {
        delayMs: parsed.delayHours * 60 * 60 * 1000,
        reason: parsed.reason ?? "contextual signal",
        contextual: true,
      };
    }
  } catch {
    // Non-fatal — fall back to default
  }

  return {
    delayMs: defaultDelayMs,
    reason: "no clear contextual signal — using default schedule",
    contextual: false,
  };
}

/**
 * Quick AI relevance check before generating a push suggestion.
 * Returns false if the lead has clearly disqualified themselves from further outreach:
 * wrong number, not interested, already bought, hostile, blocked, etc.
 * Uses GPT-4o-mini for speed — non-fatal, defaults to true on error.
 */
/**
 * Memoised on the exact text it judges.
 *
 * The verdict is a pure function of the conversation and the stage, but the
 * scheduler re-asked it on every pass for every lead still in the queue — 30
 * calls an hour, every hour, for days, almost all of them re-deciding an
 * unchanged conversation (~$0.9/day of the ~$4/day baseline, 2026-08-21).
 * Keyed on a hash of the input, so a lead who says "not interested" is judged
 * afresh the moment their words change; nothing is held stale.
 */
const aliveVerdicts = new Map<string, boolean>();
const ALIVE_CACHE_MAX = 5000;

function aliveKey(content: string, stage: string): string {
  return createHash("sha1").update(`${stage}\u0000${content}`).digest("hex");
}

async function isLeadActiveForFollowup(content: string, stage: string): Promise<boolean> {
  const key = aliveKey(content, stage);
  const cached = aliveVerdicts.get(key);
  if (cached !== undefined) return cached;
  try {
    const snippet = conversationWindow(content, 1000, 3000);
    const parsed = await chatCompletionJSON<{ active?: boolean; reason?: string }>({
      model: HELPER_MODEL,
      label: "lead-alive",
      system: `You are a CRM analyst. Given a sales conversation, decide if the lead is still a viable prospect worth following up with.

Return JSON: {"active": true/false, "reason": "one short line"}

Return active=FALSE only if the lead has CLEARLY and EXPLICITLY:
- Said they are not interested / asked to stop messaging
- Said it's the wrong number / no WhatsApp on this number
- Already purchased from a competitor and closed the topic
- Blocked or become hostile

Return active=TRUE if:
- The lead is just silent (no response yet)
- The conversation is neutral or exploratory
- There is ANY ambiguity about their intent
- The lead asked a question but never got a full answer

When in doubt → return true. False positives (following up on a dead lead) are far better than false negatives (skipping an interested lead).`,
      messages: [
        {
          role: "user",
          content: `Stage: ${stage || "unknown"}\n\nConversation:\n${snippet}`,
        },
      ],
      max_tokens: 60,
    });
    // Bounded: this runs for the life of the process, so it must not grow
    // without limit. Oldest-first eviction is enough — a verdict that falls out
    // is simply recomputed.
    if (aliveVerdicts.size >= ALIVE_CACHE_MAX) {
      const oldest = aliveVerdicts.keys().next().value;
      if (oldest !== undefined) aliveVerdicts.delete(oldest);
    }
    if (parsed.active === false) {
      logger.info({ stage, reason: parsed.reason }, "relevance check: lead marked inactive");
      aliveVerdicts.set(key, false);
      return false;
    }
    aliveVerdicts.set(key, true);
    return true;
  } catch {
    return true; // non-fatal — default to active
  }
}

/**
 * Map an amoCRM stage name → qual script index (0-based).
 * This ensures the correct script is used even when a broker manually moves
 * a lead to a stage without going through previous bot follow-ups.
 *
 * Priority order: "final" > "2nd/second" > default (1st follow-up).
 */
function qualScriptIndexForStage(stage: string | null): number {
  // Index into getFollowupSteps() — 3-entry array (0=1st, 1=2nd, 2=final)
  const s = (stage ?? "").toLowerCase();
  // Rental pipeline's stage names have a "foolow" typo in amoCRM (e.g. "3 foolow up")
  // and don't say "2nd"/"final" — match those forms too.
  if (s.includes("final") || s.includes("3 foolow up") || s.includes("3rd foolow")) return 2;
  if (s.includes("2nd") || s.includes("second") || s.includes("2 foolow up")) return 1;
  return 0; // 1st follow-up (default)
}


/**
 * Fetch the last 20 corrections for a broker and return a formatted block
 * ready to inject into a system prompt. Returns empty string if none found.
 * Results are cached per brokerId per call (pass the cache map in).
 */
/**
 * Delegates to the shared selector — this used to be its own raw query, which
 * kept injecting lessons the broker had since reversed (superseded_at) and
 * applied every lesson to every follow-up alike. Everything queued from this
 * scheduler is, by definition, the "followup" situation.
 */
async function buildBrokerCorrectionsBlock(
  brokerId: string,
  cache: Map<string, string>,
): Promise<string> {
  if (cache.has(brokerId)) return cache.get(brokerId)!;
  const block = await correctionsPromptBlock(brokerId, "followup", 20);
  cache.set(brokerId, block);
  return block;
}

/**
 * True while an ad lead is between its automatic welcome and the broker's first
 * real message: exactly one message sent, and it was the welcome. Inside that
 * window a LIVE draft on a silent lead is the point, not a ghost to sweep up.
 */
async function isAdLeadOpeningWindow(leadId: string): Promise<boolean> {
  try {
    const r = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE kind = 'ad_auto')::int AS welcome
         FROM sent_messages WHERE lead_id = $1`,
      [leadId],
    );
    const row = r.rows?.[0];
    return Number(row?.total ?? 0) === 1 && Number(row?.welcome ?? 0) === 1;
  } catch {
    return false;
  }
}

export async function processFollowups(): Promise<void> {
  const now = new Date();
  const steps = await getFollowupSteps();
  const qualSteps = await getQualificationSteps();
  const correctionsCache = new Map<string, string>();

  // ── Cleanup: delete stale LIVE suggestions for leads where we sent last ──
  // These are "ghost" LIVE items created before a bot/broker message was sent.
  // The unanswered-live stale-check only runs for leads with lastMessageFrom='lead',
  // so these items are never caught by that pass. Delete them here so they don't
  // block push suggestions from appearing.
  // Single bulk DELETE — no per-lead loop.
  //
  // EXCEPT the ad-lead broker opening, which is a LIVE draft raised on SILENCE
  // by design — "we sent last" is its defining condition, not a symptom of a
  // ghost. Without the exemption the two passes fought each other once a
  // minute: the opening pass wrote a draft (a Sonnet draft + a Sonnet listing
  // match), this cleanup deleted it, and a minute later it was written again.
  // From the hour the ad flow shipped (2026-08-20 15:00) that loop ran all
  // evening at ~64 drafts an hour with nobody working — $15 of the balance,
  // and it emptied the account overnight. Scoped to the opening window only:
  // exactly one message sent (the welcome itself), so once the broker actually
  // sends, this cleanup owns the lead again.
  try {
    const staleLiveLeads = await db
      .select({ leadId: leadsSyncTable.leadId })
      .from(leadsSyncTable)
      .where(
        or(
          eq(leadsSyncTable.lastMessageFrom, "us"),
          isNull(leadsSyncTable.lastMessageFrom),
        ),
      );
    if (staleLiveLeads.length > 0) {
      const leadIds = staleLiveLeads.map((r) => r.leadId);
      await db
        .delete(pendingSuggestionsTable)
        .where(
          and(
            inArray(pendingSuggestionsTable.leadId, leadIds),
            eq(pendingSuggestionsTable.kind, "live"),
            eq(pendingSuggestionsTable.status, "pending"),
            sql`${pendingSuggestionsTable.leadId} NOT IN (
              SELECT sm.lead_id FROM sent_messages sm
              WHERE sm.kind = 'ad_auto'
              GROUP BY sm.lead_id
              HAVING (SELECT count(*) FROM sent_messages s2 WHERE s2.lead_id = sm.lead_id) = 1
            )`,
          ),
        );
    }
  } catch (err) {
    logger.error({ err }, "processFollowups: stale-live cleanup error (non-fatal)");
  }

  // Generate suggestions ahead of time so broker sees them before they're due:
  // – Regular follow-ups (23h / 3 days / 5 days): appear 2 hours early
  // – Warmup (15 min, followupLevel=-1): appear 10 minutes early
  // We fetch with the larger 2h window; warmup leads that are >10 min away are skipped inside the loop.
  const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  const due = await db
    .select()
    .from(leadsSyncTable)
    .where(
      and(
        isNotNull(leadsSyncTable.nextFollowupAt),
        lt(leadsSyncTable.nextFollowupAt, twoHoursFromNow),
        // "Did we speak last?" — decided by TIMESTAMPS, not by the flag. The flag
        // goes stale: a reply sent manually from WhatsApp lands in
        // last_our_message_at and lead_messages while last_message_from stays
        // 'lead'. Such a lead was then invisible from both sides at once — the
        // LIVE inbox hid it (by timestamp, we answered) and this query skipped it
        // (by flag, the lead answered). Liza (22932219) sat in that gap for a week.
        or(
          eq(leadsSyncTable.lastMessageFrom, "us"),
          isNull(leadsSyncTable.lastMessageFrom),
          isNull(leadsSyncTable.lastMessageAt),
          sql`${leadsSyncTable.lastOurMessageAt} >= ${leadsSyncTable.lastMessageAt}`,
        ),
      ),
    );

  for (const lead of due) {
    try {
      // ── Stage-based suppression ───────────────────────────────────────────
      // Skip Push generation for leads in late-funnel or managed stages.
      // These leads need broker-driven conversation, not automated follow-ups.
      const leadStage = lead.leadStage ?? "";
      if (leadStage && shouldSuppressPush(leadStage)) {
        await db
          .update(leadsSyncTable)
          .set({ nextFollowupAt: null })
          .where(eq(leadsSyncTable.leadId, lead.leadId));
        logger.info(
          { leadId: lead.leadId, leadStage },
          "scheduler: push suppressed — stage requires broker-driven handling",
        );
        continue;
      }

      // Rental Listings owns its own outbound: the acquisition pass seeds the
      // owner's ad and the LIVE path answers it. Nothing templated may go out
      // here. `qualification_steps` is ONE setting shared by every pipeline and
      // the configured one is a BUYER script — villa owners were queued
      // "Saw you grabbed the guide, ! 👋 Bali's still outperforming most markets
      // on rental returns", empty name and all. That is the exact bug the Rental
      // carve-out further down already exists for. Clear the task so it stops
      // re-queuing; follow-up cadence for this funnel is a later phase.
      if (isListingAcquisitionPipeline(lead.pipeline)) {
        await db
          .update(leadsSyncTable)
          .set({ nextFollowupAt: null })
          .where(eq(leadsSyncTable.leadId, lead.leadId));
        continue;
      }

      // HoS is also responsible for leads outside the Rental pipeline (e.g. a
      // separate hiring/HR track) — this bot only handles Rental (and Rental
      // Listings) for that account.
      if (isBroker(lead.responsibleUser, "HoS") && !isHosTrackedPipeline(lead.pipeline)) {
        await db
          .update(leadsSyncTable)
          .set({ nextFollowupAt: null })
          .where(eq(leadsSyncTable.leadId, lead.leadId));
        continue;
      }

      // ── REACH stages: bypass whitelist guards, fall through to generation ──
      // "1st/2nd/Final Follow Up" stages appear in the REACH tab (extension
      // shows kind=push items whose stage matches follow-up keywords).
      // These leads MUST get a push suggestion generated — only skip the
      // whitelist and bulk-push guards that apply to non-qualification stages.
      const isReachStage = isReachStageName(leadStage);

      // Rental and Rental Listings use their own stage vocabulary, which doesn't
      // overlap with the Unicorn-oriented push whitelist below — bypass that
      // whitelist for them so they aren't silently skipped.
      // shouldSuppressPush() above still filters dead stages.
      const ownVocabulary = usesOwnStageVocabulary(lead.pipeline);

      if (!isReachStage && !ownVocabulary) {
        // ── Push qualification filter ───────────────────────────────────────
        // Only generate push for stages in the dynamic whitelist.
        const pushWhitelist = await getPushStageWhitelist();
        if (!isPushStageAllowed(pushWhitelist, lead.leadStage)) {
          await db
            .update(leadsSyncTable)
            .set({ nextFollowupAt: null })
            .where(eq(leadsSyncTable.leadId, lead.leadId));
          logger.info(
            { leadId: lead.leadId, leadStage: lead.leadStage },
            "scheduler: push skipped — stage not in push qualification list",
          );
          continue;
        }

        // Active-funnel stages (CE / Needs Assessed / Options Sent):
        // amo-sync encodes task urgency in nextFollowupAt:
        //   today's task  → nextFollowupAt = now (immediate scheduler pickup)
        //   overdue task  → nextFollowupAt = actualTaskDate (past date, for sort)
        //   no task / >3mo → nextFollowupAt = null (skipped by scheduler query)
        // No stale guard here — overdue leads must generate so they appear in PUSH.

        // TEMP (rollout gate): the push-stage-whitelist above was just corrected
        // from REACH stage names to the actual CE/Needs Assessed/Options Sent
        // funnel stages. Roll out per broker via ADAPTIVE_BROKERS — only enabled
        // brokers' active-stage leads get adaptive PUSH generation, so other
        // brokers' queues don't fill up with a backlog all at once. Does NOT
        // touch nextFollowupAt, so adding a broker there picks their eligible
        // leads up automatically on the next scheduler run.
        if (!isAdaptiveBroker(lead.responsibleUser)) {
          continue;
        }
      }

      // ── Bot-excluded leads ────────────────────────────────────────────────
      if (lead.botExcluded) {
        await db
          .update(leadsSyncTable)
          .set({ nextFollowupAt: null })
          .where(eq(leadsSyncTable.leadId, lead.leadId));
        logger.info({ leadId: lead.leadId }, "scheduler: push skipped — lead is bot-excluded");
        continue;
      }

      // ── Early exit: pending push already exists ───────────────────────────
      // Check BEFORE expensive content guard / AI generation to avoid redundant
      // work. Also fixes a race condition where concurrent scheduler runs could
      // both pass the check and insert a duplicate push.
      // nextFollowupAt is intentionally NOT cleared here — it holds the amoCRM
      // task date which the extension displays ("Overdue", "Today", "In 3d").
      {
        const existingPush = await db
          .select({ id: pendingSuggestionsTable.id })
          .from(pendingSuggestionsTable)
          .where(
            and(
              eq(pendingSuggestionsTable.leadId, lead.leadId),
              eq(pendingSuggestionsTable.status, "pending"),
              eq(pendingSuggestionsTable.kind, "push"),
            ),
          )
          .limit(1);
        if (existingPush.length > 0) continue;
      }

      // ── No conversation content guard ─────────────────────────────────────
      // Without content we can't do relevance analysis or generate a contextual
      // message — AI hallucinates generic brochure links. Skip until the webhook
      // brings real conversation content.
      // Exception: if a stage template exists for this lead, proceed without
      // content — templates are pre-written and don't require conversation context.
      // Has a qual script configured in Settings, or a non-brochure touch template?
      // Active-funnel PUSH (CE / Needs Assessed / Options Sent) no longer has a
      // template fallback (see generatePushFollowup below) — it always needs
      // real conversation content, so this bypass only applies to Reach/Rental.
      const hasStageTpl =
        (isReachStage || ownVocabulary) &&
        (qualSteps.some((s) => s.message?.trim()) ||
          !!buildFollowupTemplateByLevel(1, lead.leadId, ""));
      if (!hasStageTpl && (!lead.content || lead.content.trim().length < 30)) {
        logger.info(
          { leadId: lead.leadId, leadStage: lead.leadStage },
          "scheduler: push skipped — no conversation content yet",
        );
        continue;
      }

      // Defensive check: confirm the lead hasn't actually replied before nudging
      // them. Guards against a stale lastMessageFrom in the DB.
      {
        const { parseDialogContent } = await import("./dialog-parser");
        const parsed = lead.content ? parseDialogContent(lead.content) : null;
        const contentLastMs = parsed?.lastMessage?.at?.getTime() ?? 0;

        // content only refreshes on an amoCRM webhook, which for some channels
        // (Instagram especially) never arrives — so it can sit hours behind while
        // the timeline poll has already written the reply into lead_messages.
        // Checking content alone sent "you haven't replied" nudges to leads who
        // were sitting there waiting on US, which is the worst possible message.
        const repliedPerTimeline = await hasNewerLeadMessage(lead.leadId, contentLastMs);

        // Content saying "lead spoke last" is only believable when the timeline
        // does NOT know of a newer outgoing reply — content freezes for
        // WhatsApp sends, and trusting it here erased the follow-up clock of
        // every already-answered lead this pass touched.
        const contentSaysLead =
          parsed?.lastMessage?.from === "lead" &&
          !(await ourMessageIsNewest(lead.leadId, contentLastMs));

        if (repliedPerTimeline || contentSaysLead) {
          await db
            .update(leadsSyncTable)
            .set({ lastMessageFrom: "lead", nextFollowupAt: null })
            .where(eq(leadsSyncTable.leadId, lead.leadId));
          logger.info(
            { leadId: lead.leadId, source: repliedPerTimeline ? "timeline" : "content" },
            "scheduler: skipping push — lead replied last",
          );
          continue;
        }
      }

      // ── Conversation relevance check ──────────────────────────────────────
      // Before generating a push suggestion, quickly verify the lead is still
      // a viable prospect. Skips leads who have clearly disqualified themselves
      // (wrong number, not interested, already bought, blocked, etc.).
      // Exception: if a preset message (qual script or touch template) is available,
      // the broker has already set a task → trust the broker, skip AI gating.
      // Bypassing here prevents an infinite block loop where AI rejects a template lead,
      // clears nextFollowupAt, amo-sync re-sets it, and the cycle repeats forever.
      if (lead.content && !hasStageTpl) {
        const relevant = await isLeadActiveForFollowup(lead.content, lead.leadStage ?? "");
        if (!relevant) {
          await db
            .update(leadsSyncTable)
            .set({ nextFollowupAt: null })
            .where(eq(leadsSyncTable.leadId, lead.leadId));
          logger.info(
            { leadId: lead.leadId, stage: lead.leadStage },
            "scheduler: push skipped — conversation analysis says lead is no longer active",
          );
          continue;
        }
      }

      // ── Extract lead first name once (used by templates) ─────────────────
      const leadParsed = parseDialogContent(lead.content ?? "");
      const leadFirstName = (() => {
        const msg = leadParsed.messages.find((m) => m.from === "lead" && m.senderName?.trim());
        if (!msg?.senderName) return "";
        return msg.senderName.replace(/\s*\([^)]*\)\s*$/, "").trim().split(/\s+/)[0] ?? "";
      })();

      // ── Warmup timing guard: only generate 10 min before, not 2h early ─────
      // The outer query fetches leads within a 2h window, but warmup (15 min) uses
      // a tighter 10-min pre-generation window to avoid showing it too far in advance.
      if (lead.followupLevel === -1 && lead.nextFollowupAt) {
        const tenMinFromNow = new Date(now.getTime() + 10 * 60 * 1000);
        if (lead.nextFollowupAt > tenMinFromNow) continue;
      }

      // ── Warmup (followupLevel=-1): brand new lead, 15-min window passed ──────
      // Brochures are sent automatically by ARGO — NEVER suggest the brochure here.
      // Priority: 1) qual script for level 1, 2) Touch 1 template, 3) AI generation.
      if (lead.followupLevel === -1) {
        // qualification_steps is shared across pipelines and was written for a
        // buyer — Rental never uses it (or the static template below) verbatim,
        // same reasoning as the main follow-up path further down.
        const warmupIsRental = (lead.pipeline ?? "").trim().toLowerCase() === "rental";
        // 1. Qual script for level 1 (configured in Settings UI)
        const warmupQualMsg = warmupIsRental ? "" : (qualSteps[0]?.message?.trim() ?? "");
        const warmupQualText = warmupQualMsg
          ? warmupQualMsg.replace(/\[Name\]/g, leadFirstName).replace(/\[name\]/g, leadFirstName)
          : null;
        // 2. Touch 1 template (never Touch 0 / brochure) — skipped for Rental
        const warmupTemplateText =
          warmupQualText ?? (warmupIsRental ? null : buildFollowupTemplateByLevel(1, lead.leadId, leadFirstName, lead.responsibleUser ?? "Robert"));

        // ── Pick message: qual/template → AI fallback ─────────────────────
        let warmupText: string;
        let warmupEntry: PlaybookEntry;
        let warmupRationale: string;
        // Only the AI branch can offer listings; a broker's own script/template
        // is sent as written and never has links bolted onto it.
        let warmupAttachments: GeneratedSuggestion["attachments"] = [];

        if (warmupTemplateText) {
          warmupText = warmupTemplateText;
          warmupEntry = OBJECTION_PLAYBOOK[0]!;
          warmupRationale = warmupQualText
            ? `Warmup — qual script level 1 (Settings).`
            : `Warmup — Touch 1 template, variant ${selectVariant(lead.leadId)}.`;
          logger.info(
            { leadId: lead.leadId, stage: lead.leadStage, source: warmupQualText ? "qual-script" : "touch-1-template" },
            "warmup: using follow-up message (not brochure)",
          );
        } else {
          const warmupBrokerIdKey = brokerKey(lead.responsibleUser);
          const warmupCorrections = await buildBrokerCorrectionsBlock(warmupBrokerIdKey, correctionsCache);
          const warmupAI = await generateFollowup({
            leadId: lead.leadId,
            responsibleUser: lead.responsibleUser,
            followupLevel: 1,
            lastContent: lead.content ?? "",
            leadNotes: lead.leadNotes,
            leadStage: lead.leadStage,
            pipeline: lead.pipeline,
            correctionsBlock: warmupCorrections,
          });
          warmupText = warmupAI.text;
          warmupEntry = warmupAI.entry;
          warmupRationale = warmupAI.rationale;
          warmupAttachments = warmupAI.attachments;
        }

        if (!warmupText) {
          logger.warn({ leadId: lead.leadId }, "empty warmup text, skipping");
          continue;
        }

        const warmupBrokerId = brokerKey(lead.responsibleUser);

        await db.insert(aiSuggestionsTable).values({
          brokerId: warmupBrokerId,
          leadId: lead.leadId,
          leadName: `Lead #${lead.leadId}`,
          promptMessages: [],
          suggestionText: warmupText,
          rationale: warmupRationale,
          model: "claude-sonnet-5",
        });

        const warmupExisting = await db
          .select({ id: pendingSuggestionsTable.id })
          .from(pendingSuggestionsTable)
          .where(and(
            eq(pendingSuggestionsTable.leadId, lead.leadId),
            eq(pendingSuggestionsTable.status, "pending"),
          ))
          .limit(1);

        if (warmupExisting.length === 0) {
          await db.insert(pendingSuggestionsTable).values({
            leadId: lead.leadId,
            responsibleUser: lead.responsibleUser,
            kind: "push",
            // Store as level 1 (first follow-up) so that after approve the
            // next amoCRM-task-triggered run picks qualSteps[1] (2nd follow-up).
            followupLevel: 1,
            suggestionText: warmupText,
            status: "pending",
            objectionCategory: warmupEntry.id,
            attachments: warmupAttachments,
          });
          // Same rule as the main follow-up path below: queued work the broker
          // has to act on always announces itself.
          notifyBrokerForLead(lead.responsibleUser, lead.leadId, "reminder", followupNoticeBody(lead.lastMessageAt ?? lead.lastOurMessageAt), {
            content: lead.content,
            leadStage: lead.leadStage,
          }).catch(() => {});
          void maybeAutopilot(lead.leadId);
        }

        // Mark as level 1 done. nextFollowupAt = null — the amoCRM task
        // created on approve will drive the next scheduling via amo-sync.
        await db
          .update(leadsSyncTable)
          .set({ followupLevel: 1, nextFollowupAt: null })
          .where(eq(leadsSyncTable.leadId, lead.leadId));

        logger.info(
          { leadId: lead.leadId, objection: warmupEntry.id },
          "warmup push queued (task-driven next step)",
        );
        continue;
      }

      // ── Stage-based script selection ─────────────────────────────────────
      // Use the lead's CURRENT STAGE to determine which qual script to show.
      // This handles leads manually moved to a stage (e.g. Final Follow Up)
      // without going through previous bot-driven follow-ups.
      const stageScriptIdx = qualScriptIndexForStage(lead.leadStage);
      // followupLevel to store in DB/suggestion = stageScriptIdx + 1
      const stageLevel = stageScriptIdx + 1;

      // Also keep nextLevel for backward-compat checks (preset messages etc.)
      const currentLevel = lead.followupLevel ?? 0;
      const nextLevel = stageLevel; // always use stage-derived level

      let text: string;
      let entry: PlaybookEntry;
      let rationale: string;
      let formattedDialog: string;
      // Stays empty for a broker's preset/qual-script/template message: that
      // text is sent exactly as written and gets no links bolted onto it.
      let pushAttachments: GeneratedSuggestion["attachments"] = [];

      if (!isReachStage && !ownVocabulary) {
        // ── Active-funnel PUSH (CE / Needs Assessed / Options Sent) ─────────
        // (Reached only for Robert — the whitelist gate above already `continue`d
        // every other broker, so profile/discard work here is Robert-scoped.)
        // Always write a fresh, context-aware message here — no static
        // qual-script/template fallback. qualScriptIndexForStage() always maps
        // "Contact established" to the same script slot regardless of how many
        // touches were already sent to this lead, so the old cascade below was
        // sending the identical canned text on every repeat follow-up.
        const trailingUnanswered = countTrailingOurMessages(leadParsed.messages);

        // Refresh the distilled profile — bounded + cached (only calls AI when
        // the lead's last message changed since last distillation).
        let profile = null as Awaited<ReturnType<typeof refreshLeadProfile>>;
        try {
          profile = await refreshLeadProfile({
            leadId: lead.leadId,
            responsibleUser: lead.responsibleUser,
            content: lead.content,
            leadStage: lead.leadStage,
            leadNotes: lead.leadNotes,
            profileSourceMsgAt: lead.profileSourceMsgAt,
            stored: lead,
          });
        } catch { /* non-fatal */ }

        // ── Discard-candidate detection (FLAG ONLY — broker confirms, never auto) ──
        // Content saying the lead is dead → flag. Otherwise flag only on a long,
        // deep silence with zero real engagement — NEVER on time alone (real
        // estate leads go quiet for months and come back).
        try {
          const ageDays = lead.amoCreatedAt
            ? Math.floor((now.getTime() - lead.amoCreatedAt.getTime()) / 86400000)
            : 0;
          const everEngaged = leadParsed.messages.some(
            (m) => m.from === "lead" && m.text.trim().length > 25,
          );
          const deadByContent = profile?.alive === "dead_candidate";
          const deadBySilence = !everEngaged && trailingUnanswered >= 5 && ageDays > 60;
          if ((deadByContent || deadBySilence) && !lead.discardFlaggedAt) {
            await db
              .update(leadsSyncTable)
              .set({
                discardFlaggedAt: new Date(),
                discardReason: deadByContent
                  ? (profile?.summary || "content indicates the lead is no longer active")
                  : "long silence, never engaged, many unanswered touches",
              })
              .where(eq(leadsSyncTable.leadId, lead.leadId));
            logger.info({ leadId: lead.leadId, deadByContent, deadBySilence }, "discard: lead flagged for broker review");
          }
        } catch { /* non-fatal */ }

        const pushBrokerIdKey = brokerKey(lead.responsibleUser);
        const pushCorrections = await buildBrokerCorrectionsBlock(pushBrokerIdKey, correctionsCache);
        const generated = await generatePushFollowup({
          responsibleUser: lead.responsibleUser,
          leadId: lead.leadId,
          leadStage: lead.leadStage ?? "",
          lastContent: lead.content ?? "",
          leadNotes: lead.leadNotes,
          trailingUnanswered,
          correctionsBlock: pushCorrections,
          pipeline: lead.pipeline,
        });
        text = generated.text;
        pushAttachments = generated.attachments;
        entry = OBJECTION_PLAYBOOK[0]!; // not classified on this path — field kept for schema/analytics compat
        rationale = generated.rationale;
        formattedDialog = formatDialogForAI(leadParsed.messages);
        logger.info(
          { leadId: lead.leadId, stage: lead.leadStage, trailingUnanswered },
          "followup: adaptive PUSH generated",
        );
      } else if (qualSteps.length === 0 && steps.length === 0) {
        logger.info({ leadId: lead.leadId }, "followup: no steps configured, skipping");
        continue;
      } else {
      const currentStep = steps[stageScriptIdx] ?? steps[0];
      const presetMessage = currentStep?.message?.trim() ?? "";

      if (presetMessage) {
        // ── Broker pre-wrote this step's message — use it verbatim ──────────
        text = presetMessage;
        entry = OBJECTION_PLAYBOOK[0]!;
        rationale = `Follow-up #${nextLevel} — preset message (broker-defined).`;
        const parsedDialog = parseDialogContent(lead.content ?? "");
        formattedDialog = formatDialogForAI(parsedDialog.messages);
        logger.info({ leadId: lead.leadId, nextLevel, stage: lead.leadStage }, "followup: using preset message");
      } else {
        // ── Try broker's qualification script (from Settings UI) — by STAGE ─
        // Use qualScriptIndexForStage (3-entry array: 0=1st, 1=2nd, 2=final) — matches Settings structure
        const qualStep = qualSteps[qualScriptIndexForStage(lead.leadStage)];
        const isRentalFollowup = (lead.pipeline ?? "").trim().toLowerCase() === "rental";
        // qualification_steps is ONE setting shared by every pipeline, and the
        // one that exists was written for a buyer ("returns", "the guide") —
        // read verbatim, it went out unchanged to Rental tenants too, and being
        // fixed text meant nothing a broker corrected in a live conversation
        // could ever reach it. "Он точно обучается на моих исправлениях?" — on
        // this path he was right: it never called the model at all. Rental
        // ignores whatever is configured here and always composes the touch
        // fresh, with the conversation and his own learned corrections; Unicorn
        // keeps using its configured script verbatim, unchanged.
        const qualScriptMsg = isRentalFollowup ? "" : (qualStep?.message?.trim() ?? "");

        // The hardcoded TOUCH_TEMPLATES fallback is gone for Rental too, same
        // reasoning — canned text nobody wrote for this lead, signed with a
        // default broker name, identical for every lead.
        const tplText = qualScriptMsg
          ? qualScriptMsg.replace(/\[Name\]/g, leadFirstName).replace(/\[name\]/g, leadFirstName)
          : isRentalFollowup
            ? null
            : buildFollowupTemplateByLevel(nextLevel, lead.leadId, leadFirstName, lead.responsibleUser ?? "Robert");

        if (tplText) {
          text = tplText;
          entry = OBJECTION_PLAYBOOK[0]!;
          rationale = qualScriptMsg
            ? `Follow-up #${nextLevel} — broker qualification script (Settings).`
            : `Template Touch — stage "${lead.leadStage}", variant ${selectVariant(lead.leadId)}.`;
          formattedDialog = formatDialogForAI(leadParsed.messages);
          logger.info(
            { leadId: lead.leadId, nextLevel, source: qualScriptMsg ? "qual-script" : "stage-template" },
            "followup: using template",
          );
        } else {
          // ── No template — generate context-aware follow-up via AI ───────────
          const genBrokerIdKey = brokerKey(lead.responsibleUser);
          const genCorrections = await buildBrokerCorrectionsBlock(genBrokerIdKey, correctionsCache);
          const generated = await generateFollowup({
            leadId: lead.leadId,
            responsibleUser: lead.responsibleUser,
            followupLevel: nextLevel,
            lastContent: lead.content ?? "",
            leadNotes: lead.leadNotes,
            leadStage: lead.leadStage,
            pipeline: lead.pipeline,
            correctionsBlock: genCorrections,
          });
          text = generated.text;
          pushAttachments = generated.attachments;
          entry = generated.entry;
          rationale = generated.rationale;
          formattedDialog = generated.formattedDialog;
        }
      }
      }

      if (!text) {
        logger.warn({ leadId: lead.leadId }, "empty followup text, skipping");
        continue;
      }

      const brokerId = brokerKey(lead.responsibleUser);

      await db.insert(aiSuggestionsTable).values({
        brokerId,
        leadId: lead.leadId,
        leadName: `Lead #${lead.leadId}`,
        promptMessages: [],
        suggestionText: text,
        rationale,
        model: "claude-sonnet-5",
      });

      const existing = await db
        .select({ id: pendingSuggestionsTable.id })
        .from(pendingSuggestionsTable)
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, lead.leadId),
            eq(pendingSuggestionsTable.status, "pending"),
            eq(pendingSuggestionsTable.kind, "push"),
          ),
        )
        .limit(1);

      if (existing.length === 0) {
        await db.insert(pendingSuggestionsTable).values({
          leadId: lead.leadId,
          responsibleUser: lead.responsibleUser,
          kind: "push",
          followupLevel: stageLevel, // stage-derived level
          suggestionText: text,
          status: "pending",
          objectionCategory: entry.id,
          attachments: pushAttachments,
        });
        // A follow-up waiting to be sent is work the broker owes, exactly like a
        // lead's reply — the owner's rule: "any action the broker has to take in
        // the copilot deserves a notification, live or follow-up, no difference".
        // Only LIVE ever notified, so the PUSH tab filled in silence: three of
        // Amelia's follow-ups sat ready from 4-6 August with nothing to signal
        // them. Same notification shape as a reply, so the badge stays in step.
        notifyBrokerForLead(lead.responsibleUser, lead.leadId, "reminder", followupNoticeBody(lead.lastMessageAt ?? lead.lastOurMessageAt), {
          content: lead.content,
          leadStage: lead.leadStage,
        }).catch(() => {});
        void maybeAutopilot(lead.leadId);
      }

      // Update followupLevel to the stage-derived level.
      // nextFollowupAt is intentionally preserved — it holds the amoCRM task due
      // date displayed in the extension. amo-sync Pass 0 will snooze it to the
      // next future task date when the broker reschedules.
      await db
        .update(leadsSyncTable)
        .set({ followupLevel: stageLevel })
        .where(eq(leadsSyncTable.leadId, lead.leadId));

      logger.info(
        { leadId: lead.leadId, stageLevel, stage: lead.leadStage, objection: entry.id },
        "followup queued",
      );
    } catch (err) {
      logger.error({ err, leadId: lead.leadId }, "followup generation error");
    }
  }
}

/**
 * For every lead where the client wrote last (lastMessageFrom='lead') and there
 * is no pending live suggestion, generate a fresh live reply suggestion.
 * This ensures unanswered leads always have a live suggestion regardless of age.
 * Capped at 5 per run to avoid overloading OpenAI.
 */
export async function processUnansweredLive(): Promise<void> {
  const unansweredCorrectionsCache = new Map<string, string>();
  // Find ALL leads where DB says the lead wrote last
  const unanswered = await db
    .select({
      leadId: leadsSyncTable.leadId,
      responsibleUser: leadsSyncTable.responsibleUser,
      content: leadsSyncTable.content,
      leadNotes: leadsSyncTable.leadNotes,
      leadStage: leadsSyncTable.leadStage,
      botExcluded: leadsSyncTable.botExcluded,
      pipeline: leadsSyncTable.pipeline,
      profileSourceMsgAt: leadsSyncTable.profileSourceMsgAt,
      profileTemperature: leadsSyncTable.profileTemperature,
      profilePotential: leadsSyncTable.profilePotential,
      profileIntent: leadsSyncTable.profileIntent,
      profileTimeframe: leadsSyncTable.profileTimeframe,
      profileOpenQuestion: leadsSyncTable.profileOpenQuestion,
      profileAlive: leadsSyncTable.profileAlive,
      profileSummary: leadsSyncTable.profileSummary,
    })
    .from(leadsSyncTable)
    // The flag alone is not proof the lead is unanswered: a reply sent manually
    // from WhatsApp lands in last_our_message_at while last_message_from stays
    // "lead" forever. This pass then treated an answered lead as unanswered on
    // every cycle — regenerating a LIVE draft and deleting whatever was there,
    // which is what kept wiping the draft the broker had just asked for.
    .where(
      and(
        eq(leadsSyncTable.lastMessageFrom, "lead"),
        or(
          isNull(leadsSyncTable.lastOurMessageAt),
          isNull(leadsSyncTable.lastMessageAt),
          sql`${leadsSyncTable.lastOurMessageAt} < ${leadsSyncTable.lastMessageAt}`,
        ),
      ),
    );

  if (unanswered.length === 0) return;

  // A draft the broker asked for by hand is theirs — this pass must not delete it
  // or write over it, whatever it thinks about who spoke last.
  const requestedByBroker = new Set(
    (
      await db
        .select({ leadId: pendingSuggestionsTable.leadId })
        .from(pendingSuggestionsTable)
        .where(
          and(
            eq(pendingSuggestionsTable.status, "pending"),
            isNotNull(pendingSuggestionsTable.requestedAt),
          ),
        )
    ).map((r) => r.leadId),
  );

  // Fetch existing pending LIVE suggestions for filtering in Pass 2
  const existingLive = await db
    .select({ leadId: pendingSuggestionsTable.leadId })
    .from(pendingSuggestionsTable)
    .where(
      and(
        eq(pendingSuggestionsTable.kind, "live"),
        eq(pendingSuggestionsTable.status, "pending"),
      ),
    );
  const alreadyHasLive = new Set(existingLive.map((r) => r.leadId));

  // `content` only refreshes when an amoCRM webhook fires, and for some channels
  // (Instagram especially) it silently doesn't. The timeline poll meanwhile
  // writes every message straight into lead_messages, so that table can be hours
  // ahead. The stale-check below used to trust content alone — which inverted it
  // into a bug: for a lead who really HAD just replied, it flipped
  // lastMessageFrom back to "us" and DELETED the correct pending LIVE, so the
  // broker saw nothing and the push scheduler then nudged the lead to reply to a
  // message they had already answered.
  const newestByLead = new Map<string, { senderType: string; sentAt: Date }>();
  try {
    const rows = await db.execute<{ lead_id: string; sender_type: string; sent_at: Date }>(sql`
      SELECT DISTINCT ON (lead_id) lead_id, sender_type, sent_at
      FROM lead_messages
      WHERE lead_id IN (${sql.join(unanswered.map((l) => sql`${l.leadId}`), sql`, `)})
      ORDER BY lead_id, sent_at DESC
    `);
    for (const r of rows.rows ?? []) {
      newestByLead.set(String(r.lead_id), { senderType: String(r.sender_type), sentAt: new Date(r.sent_at) });
    }
  } catch (err) {
    logger.error({ err }, "unanswered-live: newest-message lookup failed (falling back to content only)");
  }

  // PASS 1: Stale-check ALL leads (including those that already have a LIVE suggestion).
  // If the actual last message in the conversation is from us, the DB's lastMessageFrom
  // field is stale (e.g. SalesBot sent a brochure but the webhook didn't update the DB).
  // Fix the DB field and delete any existing stale LIVE suggestion so the push scheduler
  // can correctly pick this lead up as a PUSH.
  const genuinelyUnanswered: typeof unanswered = [];
  for (const lead of unanswered) {
    try {
      const content = lead.content ?? "";
      if (!content) {
        genuinelyUnanswered.push(lead);
        continue;
      }
      const parsed = parseDialogContent(content);

      // If the timeline knows about a lead message newer than anything in
      // content, content is the stale side — believe the timeline and leave the
      // lead alone. 60s of slack absorbs clock/rounding differences between the
      // two sources for what is really the same message.
      const newest = newestByLead.get(lead.leadId);
      const contentLastMs = parsed.lastMessage?.at?.getTime() ?? 0;
      if (newest && newest.senderType === "lead" && newest.sentAt.getTime() > contentLastMs + 60_000) {
        genuinelyUnanswered.push(lead);
        continue;
      }

      if (parsed.lastMessage?.from === "us") {
        await db
          .update(leadsSyncTable)
          .set({ lastMessageFrom: "us" })
          .where(eq(leadsSyncTable.leadId, lead.leadId));
        // Same exemption as the bulk cleanup above: an ad lead still inside its
        // opening window has a LIVE draft precisely BECAUSE we spoke last.
        if (await isAdLeadOpeningWindow(lead.leadId)) {
          logger.info({ leadId: lead.leadId }, "unanswered-live: ad-lead opening draft left alone");
          continue;
        }
        await db
          .delete(pendingSuggestionsTable)
          .where(
            and(
              eq(pendingSuggestionsTable.leadId, lead.leadId),
              eq(pendingSuggestionsTable.kind, "live"),
              eq(pendingSuggestionsTable.status, "pending"),
            ),
          );
        logger.info({ leadId: lead.leadId }, "unanswered-live: stale lastMessageFrom fixed, LIVE cleared");
        continue;
      }
      genuinelyUnanswered.push(lead);
    } catch (err) {
      logger.error({ err, leadId: lead.leadId }, "unanswered-live stale-check error");
      genuinelyUnanswered.push(lead);
    }
  }

  // PASS 2: For genuinely unanswered leads that don't yet have a LIVE suggestion, generate one.
  const toProcess = genuinelyUnanswered.filter((l) => {
    if (alreadyHasLive.has(l.leadId)) return false;
    // The broker asked for a draft on this lead by hand — leave it alone.
    if (requestedByBroker.has(l.leadId)) return false;
    if (l.botExcluded) return false;
    const stage = (l.leadStage ?? "").toLowerCase();
    if (shouldSuppressPush(stage)) return false;
    // HoS is also responsible for leads outside the Rental pipeline (e.g. a
    // separate hiring/HR track) — this bot only handles Rental (and Rental
    // Listings) for that account, so skip generation entirely rather than
    // burning an AI call just to hide it later.
    if (isBroker(l.responsibleUser, "HoS") && !isHosTrackedPipeline(l.pipeline)) return false;
    return true;
  });
  if (toProcess.length === 0) return;

  // Cap at 10 per scheduler run to avoid OpenAI overload and inbox flooding.
  const batch = toProcess.slice(0, 10);

  for (const lead of batch) {
    try {
      // Below-budget rentals are binned before any generation spends a token.
      if (await enforceBudgetFilter(lead.leadId)) continue;
      const content = lead.content ?? "";
      if (!content) continue;

      const parsed = parseDialogContent(content);
      const lastLeadMessage = parsed.lastLeadMessage?.text ?? "";
      if (!lastLeadMessage) continue;

      // A lead that just replied is the highest-value moment to refresh its
      // distilled profile. Gated to the adaptive brokers (see ADAPTIVE_BROKERS);
      // cached, so it only calls AI when the last lead message actually changed.
      if (isAdaptiveBroker(lead.responsibleUser)) {
        try {
          await refreshLeadProfile({
            leadId: lead.leadId,
            responsibleUser: lead.responsibleUser,
            content,
            leadStage: lead.leadStage,
            leadNotes: lead.leadNotes,
            profileSourceMsgAt: lead.profileSourceMsgAt,
            stored: lead,
          });
        } catch { /* non-fatal */ }
      }

      const liveBrokerIdKey = brokerKey(lead.responsibleUser);
      const liveCorrections = await buildBrokerCorrectionsBlock(liveBrokerIdKey, unansweredCorrectionsCache);
      const { text, attachments } = await generateSuggestion({
        leadId: lead.leadId,
        responsibleUser: lead.responsibleUser,
        kind: "live",
        lastLeadMessage,
        contentSnippet: content,
        leadNotes: lead.leadNotes,
        leadStage: lead.leadStage,
        correctionsBlock: liveCorrections,
        pipeline: lead.pipeline,
      });

      if (!text) continue;

      // Refresh the lead's pending suggestion IN PLACE (keep the same id) rather
      // than delete + insert. A broker who had the card open was hitting "Webhook
      // 404" on approve because this pass churned the id out from under them every
      // scheduler run. Update-in-place is the project rule (see CLAUDE.md); insert
      // only when there's genuinely nothing pending yet.
      const [existingPending] = await db
        .select({ id: pendingSuggestionsTable.id })
        .from(pendingSuggestionsTable)
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, lead.leadId),
            eq(pendingSuggestionsTable.status, "pending"),
            isNull(pendingSuggestionsTable.requestedAt),
          ),
        )
        .limit(1);

      let rowId: string;
      if (existingPending) {
        rowId = existingPending.id;
        await db
          .update(pendingSuggestionsTable)
          .set({ kind: "live", followupLevel: null, suggestionText: text, attachments })
          .where(eq(pendingSuggestionsTable.id, rowId));
      } else {
        const [inserted] = await db
          .insert(pendingSuggestionsTable)
          .values({
            leadId: lead.leadId,
            responsibleUser: lead.responsibleUser,
            kind: "live",
            followupLevel: null,
            suggestionText: text,
            status: "pending",
            attachments,
          })
          .returning({ id: pendingSuggestionsTable.id });
        rowId = inserted!.id;
      }
      notifyBrokerForLead(lead.responsibleUser, lead.leadId, "replied", lastLeadMessage, {
        content: lead.content,
        leadStage: lead.leadStage,
      }).catch(() => {});

      // This path (a separate, independent generator from the webhook's own
      // queueSuggestion) never called the stage classifier at all — every ad
      // lead whose first reply came from here sat in "New LEAD" forever,
      // because nothing ever populated suggestedStage for approve.ts to apply.
      void classifyStageInBackground(rowId, lead.leadId, text, (attachments ?? []).length);

      logger.info({ leadId: lead.leadId }, "live suggestion generated for unanswered lead");
      void maybeAutopilot(lead.leadId);
    } catch (err) {
      logger.error({ err, leadId: lead.leadId }, "unanswered live generation error");
    }
  }
}

let schedulerHandle: ReturnType<typeof setInterval> | null = null;

export function startFollowupScheduler(intervalMs = 5 * 60 * 1000): void {
  if (schedulerHandle) return;
  logger.info({ intervalMs }, "followup scheduler started");
  setTimeout(() => {
    processFollowups().catch((err) => logger.error({ err }, "followup scheduler error"));
    processUnansweredLive().catch((err) => logger.error({ err }, "unanswered live error"));
    processSourcedLeadOutreach().catch((err) => logger.error({ err }, "sourced lead outreach error"));
    processWeeklyAvailabilityCheck().catch((err) => logger.error({ err }, "weekly availability check error"));
    processListingOwnerFollowup().catch((err) => logger.error({ err }, "listing owner followup error"));
  }, 10_000);
  schedulerHandle = setInterval(() => {
    processFollowups().catch((err) => logger.error({ err }, "followup scheduler error"));
    processUnansweredLive().catch((err) => logger.error({ err }, "unanswered live error"));
    // Its own pass, deliberately outside processFollowups: that path is blocked
    // for this whole funnel so the buyer-facing qualification template can never
    // reach a villa owner. The cadence gate lives inside the pass.
    processWeeklyAvailabilityCheck().catch((err) => logger.error({ err }, "weekly availability check error"));
    // Owner nudges for Rental Listings — the "later phase" the block above
    // names. Its own pass with its own words, so the buyer script stays out.
    processListingOwnerFollowup().catch((err) => logger.error({ err }, "listing owner followup error"));
    // The handover itself must produce something the broker can act on, or a
    // card that crossed the autopilot threshold belongs to nobody: the bot has
    // let it go and the inbox, which lists drafts rather than cards, shows
    // nothing until the owner happens to write again.
    // Re-enabled 2026-09-03 after the guard was rebuilt on the verdict stamp
    // (autopilot_skipped_at vs. arrival at the stage) instead of created_at —
    // the first version looped because queueSuggestion rewrites a pending row
    // in place and created_at never moved. Verified idempotent by hand: three
    // consecutive runs gave 2, 0, 0.
    // DISABLED again 2026-09-03: a silent deleter removes the handover row
    // between passes and takes the guard's stamp with it. Find and fix the
    // deleter (or move the stamp off the row) before re-enabling.
    // processHandoverDrafts().catch((err) => logger.error({ err }, "handover draft error"));
  }, intervalMs);

  // A paid ad lead sat unnoticed for up to ten minutes: one 5-min pass to seed
  // it, ANOTHER to write its draft. Seeding is a cheap SELECT, so it runs every
  // minute — and when it actually seeded someone, their draft is generated right
  // away instead of waiting for the next general pass.
  setInterval(() => {
    processSourcedLeadOutreach()
      .then((seeded) => {
        if (seeded > 0) return processUnansweredLive();
        return undefined;
      })
      .catch((err) => logger.error({ err }, "sourced lead outreach error"));
    // An ad lead that got the automatic welcome and stayed silent gets its
    // broker a draft at 15 minutes, not at 24 hours. Runs on the same minute
    // tick so the window is accurate to within a minute.
    processAdLeadBrokerOpening().catch((err) => logger.error({ err }, "ad lead broker opening error"));
  }, 60_000);

  // Say it out loud when leads are stuck. Cheap query, and it is the only
  // record of "since when" once someone finally notices.
  setInterval(() => {
    logStuckLeads().catch((err) => logger.error({ err }, "stuck-lead check error"));
    // A funnel missing from the roster never reaches leads_sync at all, so the
    // stuck-lead check above cannot see it. This is the only thing that can.
    logUnknownPipelines(
      async () => {
        const d = await amoFetch<{ _embedded?: { pipelines?: Array<{ id: number; name: string }> } }>(
          "/api/v4/leads/pipelines?limit=50",
        );
        return d?._embedded?.pipelines ?? [];
      },
      async (pipelineId) => {
        const d = await amoFetch<{ _page?: number; _embedded?: { leads?: unknown[] } }>(
          `/api/v4/leads?filter[pipeline_id]=${pipelineId}&limit=1`,
        );
        return (d?._embedded?.leads ?? []).length;
      },
      (o, m) => logger.warn(o, m),
    ).catch(() => {});
  }, 15 * 60 * 1000);

  // Rental Listings: seed the owner's own ad as the first message, then answer
  // it right away instead of waiting for the next general pass — same
  // seed-then-generate shape (and cadence) as the sourced-lead pass above.
  setInterval(() => {
    processListingAcquisitionOutreach()
      .then((seeded) => (seeded > 0 ? processUnansweredLive() : undefined))
      .catch((err) => logger.error({ err }, "listing acquisition outreach error"));
  }, 60_000);
}

export function stopFollowupScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}
