import { db, leadsSyncTable, pendingSuggestionsTable, aiSuggestionsTable, brokerCorrectionsTable } from "@workspace/db";
import { lt, isNotNull, eq, and, or, isNull, inArray, desc } from "drizzle-orm";
import { chatCompletion, chatCompletionJSON } from "./ai-client";
import { nextFollowupDate, parseDialogContent, formatDialogForAI, countTrailingOurMessages, describeConversationTiming } from "./dialog-parser";
import { getFollowupSteps, getQualificationSteps } from "./settings";
import { logger } from "./logger";
import { sanitizeSuggestion, AVOID_PHRASES_REMINDER } from "./sanitize-suggestion";
import { OBJECTION_PLAYBOOK, type PlaybookEntry } from "./objection-playbook";
import { shouldSuppressPush, isStageWhitelisted } from "./stage-routing";
import { getPushStageWhitelist, isPushStageAllowed } from "./push-stage-whitelist";
import { buildTemplateMessage, buildFollowupTemplateByLevel, selectVariant } from "./followup-templates";
import { generateSuggestion } from "./generate-suggestion";
import { notifyBroker } from "./push-notifications";

async function classifyObjection(
  conversationSnippet: string,
  brokerName: string,
): Promise<PlaybookEntry> {
  const categories = OBJECTION_PLAYBOOK.map(
    (e, i) => `${i + 1}. ${e.id} — ${e.description}`,
  ).join("\n");

  const completion = await chatCompletion({
    model: "claude-sonnet-5",
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

export async function generateFollowup(opts: {
  leadId: string;
  responsibleUser: string | null;
  followupLevel: number;
  lastContent: string;
  leadNotes?: string | null;
  /** Pre-built corrections block to inject into system prompt */
  correctionsBlock?: string;
}): Promise<{ text: string; entry: PlaybookEntry; rationale: string; formattedDialog: string }> {
  const brokerName = opts.responsibleUser ?? "Broker";
  const parsedDialog = parseDialogContent(opts.lastContent);
  const formattedDialog = formatDialogForAI(parsedDialog.messages);
  const leadName =
    parsedDialog.messages.find((m) => m.from === "lead")?.senderName ?? "there";

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
    model: "claude-sonnet-5",
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
${tacticsHint}${opts.correctionsBlock ?? ""}${AVOID_PHRASES_REMINDER}`,
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

  const text = sanitizeSuggestion(
    completion.content,
  );

  const rationale = `Follow-up #${opts.followupLevel} — context-aware. Situation tactic: ${entry.label}.`;

  return { text, entry, rationale, formattedDialog };
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
  leadStage: string;
  lastContent: string;
  leadNotes?: string | null;
  trailingUnanswered: number;
  correctionsBlock?: string;
}): Promise<{ text: string; rationale: string }> {
  const brokerName = opts.responsibleUser ?? "Broker";
  const parsedDialog = parseDialogContent(opts.lastContent);
  const now = new Date();
  const formattedDialog = formatDialogForAI(parsedDialog.messages, 500, true);
  const timingSummary = describeConversationTiming(parsedDialog.messages, now);
  const isCold = opts.trailingUnanswered >= 3;

  const leadContext = opts.leadNotes?.trim()
    ? `\nLead card notes: ${opts.leadNotes.trim()}`
    : "";

  const completion = await chatCompletion({
    model: "claude-sonnet-5",
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
- Return ONLY the message body — no preamble, no quotes, no explanation of your reasoning.${opts.correctionsBlock ?? ""}${AVOID_PHRASES_REMINDER}`,
    messages: [
      {
        role: "user",
        content: `TIMING:\n${timingSummary}\n\nLead card notes:${leadContext || " (none)"}\n\nFull conversation (each line timestamped, oldest → newest):\n${formattedDialog}\n\nWrite the follow-up message.`,
      },
    ],
    max_tokens: 250,
  });

  const text = sanitizeSuggestion(completion.content);
  const rationale = isCold
    ? `PUSH — re-engagement (${opts.trailingUnanswered} unanswered touches), stage "${opts.leadStage}".`
    : `PUSH — adaptive follow-up, stage "${opts.leadStage}".`;

  return { text, rationale };
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
      model: "claude-sonnet-5",
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
          content: formattedDialog.slice(-3000),
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
async function isLeadActiveForFollowup(content: string, stage: string): Promise<boolean> {
  try {
    const snippet = content.slice(-3000);
    const parsed = await chatCompletionJSON<{ active?: boolean; reason?: string }>({
      model: "claude-sonnet-5",
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
    if (parsed.active === false) {
      logger.info({ stage, reason: parsed.reason }, "relevance check: lead marked inactive");
      return false;
    }
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
async function buildBrokerCorrectionsBlock(
  brokerId: string,
  cache: Map<string, string>,
): Promise<string> {
  if (cache.has(brokerId)) return cache.get(brokerId)!;
  try {
    const corrections = await db
      .select({ instruction: brokerCorrectionsTable.instruction, ctx: brokerCorrectionsTable.situationContext })
      .from(brokerCorrectionsTable)
      .where(eq(brokerCorrectionsTable.brokerId, brokerId))
      .orderBy(desc(brokerCorrectionsTable.createdAt))
      .limit(20);
    const block = corrections.length > 0
      ? `\n\nLEARNED BROKER PREFERENCES (always apply — learned from ${corrections.length} past edit${corrections.length > 1 ? "s" : ""}):\n` +
        corrections.map((c, i) => `${i + 1}. ${c.instruction}${c.ctx ? ` [when: ${c.ctx}]` : ""}`).join("\n")
      : "";
    cache.set(brokerId, block);
    return block;
  } catch {
    cache.set(brokerId, "");
    return "";
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
        or(
          eq(leadsSyncTable.lastMessageFrom, "us"),
          isNull(leadsSyncTable.lastMessageFrom),
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

      // HoS is also responsible for leads outside the Rental pipeline (e.g. a
      // separate hiring/HR track) — this bot only handles Rental for that account.
      if (lead.responsibleUser === "HoS" && (lead.pipeline ?? "").toLowerCase() !== "rental") {
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
      const REACH_KEYWORDS = ["1st follow up", "2nd follow up", "final follow up"];
      const isReachStage = REACH_KEYWORDS.some(kw => leadStage.toLowerCase().includes(kw));

      // Rental pipeline uses its own stage vocabulary (Qualified, New LEAD,
      // Options sent, N foolow up) that doesn't overlap with the Unicorn-oriented
      // push whitelist below — bypass that whitelist for Rental leads so they
      // aren't silently skipped. shouldSuppressPush() above still filters dead stages.
      const isRentalPipeline = (lead.pipeline ?? "").toLowerCase() === "rental";

      if (!isReachStage && !isRentalPipeline) {
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
        // funnel stages. Restrict the newly-unlocked generation to Robert while
        // he validates PUSH end-to-end, so other brokers' queues don't fill up
        // with a backlog all at once. Does NOT touch nextFollowupAt, so once this
        // gate is removed, all brokers' eligible leads pick up automatically on
        // the next scheduler run. Remove this block to roll out to everyone.
        if (lead.responsibleUser !== "Robert") {
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
        (isReachStage || isRentalPipeline) &&
        (qualSteps.some((s) => s.message?.trim()) ||
          !!buildFollowupTemplateByLevel(1, lead.leadId, ""));
      if (!hasStageTpl && (!lead.content || lead.content.trim().length < 30)) {
        logger.info(
          { leadId: lead.leadId, leadStage: lead.leadStage },
          "scheduler: push skipped — no conversation content yet",
        );
        continue;
      }

      // Defensive check: re-parse content to confirm lead hasn't actually replied.
      // Guards against stale lastMessageFrom in DB.
      if (lead.content) {
        const { parseDialogContent } = await import("./dialog-parser");
        const parsed = parseDialogContent(lead.content);
        if (parsed.lastMessage?.from === "lead") {
          await db
            .update(leadsSyncTable)
            .set({ lastMessageFrom: "lead", nextFollowupAt: null })
            .where(eq(leadsSyncTable.leadId, lead.leadId));
          logger.info({ leadId: lead.leadId }, "scheduler: skipping push — content shows lead replied last");
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
        // 1. Qual script for level 1 (configured in Settings UI)
        const warmupQualMsg = qualSteps[0]?.message?.trim() ?? "";
        const warmupQualText = warmupQualMsg
          ? warmupQualMsg.replace(/\[Name\]/g, leadFirstName).replace(/\[name\]/g, leadFirstName)
          : null;
        // 2. Touch 1 template (never Touch 0 / brochure)
        const warmupTemplateText = warmupQualText ?? buildFollowupTemplateByLevel(1, lead.leadId, leadFirstName, lead.responsibleUser ?? "Robert");

        // ── Pick message: qual/template → AI fallback ─────────────────────
        let warmupText: string;
        let warmupEntry: PlaybookEntry;
        let warmupRationale: string;

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
          const warmupBrokerIdKey = (lead.responsibleUser ?? "unknown").toLowerCase().slice(0, 64);
          const warmupCorrections = await buildBrokerCorrectionsBlock(warmupBrokerIdKey, correctionsCache);
          const warmupAI = await generateFollowup({
            leadId: lead.leadId,
            responsibleUser: lead.responsibleUser,
            followupLevel: 1,
            lastContent: lead.content ?? "",
            leadNotes: lead.leadNotes,
            correctionsBlock: warmupCorrections,
          });
          warmupText = warmupAI.text;
          warmupEntry = warmupAI.entry;
          warmupRationale = warmupAI.rationale;
        }

        if (!warmupText) {
          logger.warn({ leadId: lead.leadId }, "empty warmup text, skipping");
          continue;
        }

        const warmupBrokerId = (lead.responsibleUser ?? "unknown").toLowerCase().slice(0, 64);

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
            attachments: [],
          });
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

      if (!isReachStage && !isRentalPipeline) {
        // ── Active-funnel PUSH (CE / Needs Assessed / Options Sent) ─────────
        // Always write a fresh, context-aware message here — no static
        // qual-script/template fallback. qualScriptIndexForStage() always maps
        // "Contact established" to the same script slot regardless of how many
        // touches were already sent to this lead, so the old cascade below was
        // sending the identical canned text on every repeat follow-up.
        const trailingUnanswered = countTrailingOurMessages(leadParsed.messages);
        const pushBrokerIdKey = (lead.responsibleUser ?? "unknown").toLowerCase().slice(0, 64);
        const pushCorrections = await buildBrokerCorrectionsBlock(pushBrokerIdKey, correctionsCache);
        const generated = await generatePushFollowup({
          responsibleUser: lead.responsibleUser,
          leadStage: lead.leadStage ?? "",
          lastContent: lead.content ?? "",
          leadNotes: lead.leadNotes,
          trailingUnanswered,
          correctionsBlock: pushCorrections,
        });
        text = generated.text;
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
        const qualScriptMsg = qualStep?.message?.trim() ?? "";

        // ── Then try hardcoded stage template ────────────────────────────────
        const tplText = qualScriptMsg
          ? qualScriptMsg.replace(/\[Name\]/g, leadFirstName).replace(/\[name\]/g, leadFirstName)
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
          const genBrokerIdKey = (lead.responsibleUser ?? "unknown").toLowerCase().slice(0, 64);
          const genCorrections = await buildBrokerCorrectionsBlock(genBrokerIdKey, correctionsCache);
          const generated = await generateFollowup({
            leadId: lead.leadId,
            responsibleUser: lead.responsibleUser,
            followupLevel: nextLevel,
            lastContent: lead.content ?? "",
            leadNotes: lead.leadNotes,
            correctionsBlock: genCorrections,
          });
          text = generated.text;
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

      const brokerId = (lead.responsibleUser ?? "unknown").toLowerCase().slice(0, 64);

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
          attachments: [],
        });
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
    })
    .from(leadsSyncTable)
    .where(eq(leadsSyncTable.lastMessageFrom, "lead"));

  if (unanswered.length === 0) return;

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
      if (parsed.lastMessage?.from === "us") {
        await db
          .update(leadsSyncTable)
          .set({ lastMessageFrom: "us" })
          .where(eq(leadsSyncTable.leadId, lead.leadId));
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
    if (l.botExcluded) return false;
    const stage = (l.leadStage ?? "").toLowerCase();
    if (shouldSuppressPush(stage)) return false;
    // HoS is also responsible for leads outside the Rental pipeline (e.g. a
    // separate hiring/HR track) — this bot only handles Rental for that account,
    // so skip generation entirely rather than burning an AI call just to hide it later.
    if (l.responsibleUser === "HoS" && (l.pipeline ?? "").toLowerCase() !== "rental") return false;
    return true;
  });
  if (toProcess.length === 0) return;

  // Cap at 10 per scheduler run to avoid OpenAI overload and inbox flooding.
  const batch = toProcess.slice(0, 10);

  for (const lead of batch) {
    try {
      const content = lead.content ?? "";
      if (!content) continue;

      const parsed = parseDialogContent(content);
      const lastLeadMessage = parsed.lastLeadMessage?.text ?? "";
      if (!lastLeadMessage) continue;

      const liveBrokerIdKey = (lead.responsibleUser ?? "unknown").toLowerCase().slice(0, 64);
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

      // Remove any stale pending push for this lead — live takes priority
      await db
        .delete(pendingSuggestionsTable)
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, lead.leadId),
            eq(pendingSuggestionsTable.status, "pending"),
          ),
        );

      await db.insert(pendingSuggestionsTable).values({
        leadId: lead.leadId,
        responsibleUser: lead.responsibleUser,
        kind: "live",
        followupLevel: null,
        suggestionText: text,
        status: "pending",
        attachments,
      });
      notifyBroker(lead.responsibleUser, "Lead replied", text).catch(() => {});

      logger.info({ leadId: lead.leadId }, "live suggestion generated for unanswered lead");
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
  }, 10_000);
  schedulerHandle = setInterval(() => {
    processFollowups().catch((err) => logger.error({ err }, "followup scheduler error"));
    processUnansweredLive().catch((err) => logger.error({ err }, "unanswered live error"));
  }, intervalMs);
}

export function stopFollowupScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}
