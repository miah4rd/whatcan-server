import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable, aiSuggestionsTable, contactEventsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { chatCompletion, WRITER_MODEL } from "../lib/ai-client";
import { parseDialogContent, nextFollowupDate, formatDialogForAI } from "../lib/dialog-parser";
import { getKnowledgeBase, filterKnowledgeBaseForRental } from "../lib/knowledge-base";
import { sanitizeSuggestion, AVOID_PHRASES_REMINDER } from "../lib/sanitize-suggestion";
import { getPropertyCatalogSummary, fetchAllPropertiesForPriceLookup, matchProperties, type PropertyPick } from "../lib/property-catalog";
import { getBrokerPicks } from "../lib/settings";
import { isStageWhitelisted, shouldSuppressPush } from "../lib/stage-routing";

import { getAmoLead } from "../lib/amo-client";
import { advanceRentalFollowup, rentalStageToFollowupLevel } from "../lib/rental-followup";
import { buildRentalPromptParts } from "../lib/rental-prompt";
import { buildSalesPromptParts } from "../lib/sales-prompt";
import { notifyBrokerForLead } from "../lib/push-notifications";
import { isBroker, brokerKey } from "../lib/broker-identity";
import { pickPropertyAttachments, buildPromptAdditions, reconcileTextWithAttachments } from "../lib/generate-suggestion";
import { maybeAutopilot } from "../lib/autopilot";
import { enforceBudgetFilter } from "../lib/budget-filter";
import { recordCommitment } from "../lib/commitment-scheduler";
import { scheduleLiveReply } from "../lib/live-reply-debounce";
import { classifyStage } from "../lib/stage-classifier";
import { logger } from "../lib/logger";

const router = Router();

export type GeneratedSuggestion = {
  text: string;
  attachments: Array<{ type: "link"; label: string; url: string }>;
};

function toAttachments(picks: PropertyPick[]): GeneratedSuggestion["attachments"] {
  return picks.map((p) => ({ type: "link" as const, label: p.label, url: p.url }));
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
  /** "rental" swaps in the villa-rental prompt/qualifying logic instead of the Sales one */
  pipeline?: string | null;
}): Promise<GeneratedSuggestion> {
  const isRental = (opts.pipeline ?? "").toLowerCase() === "rental";

  // Property catalog is not included in AI suggestions (broker selects properties manually)
  const [kb] = await Promise.all([
    getKnowledgeBase(),
  ]);

  // Property catalog and broker picks are disabled — broker selects properties manually
  const brokerPicksBlock = "";
  const catalog = "";

  // Same split as the library path — see generate-suggestion.ts. Both write
  // client-facing drafts with the identical rulebook, so both cache it.
  const rentalParts = isRental
    ? buildRentalPromptParts({ leadStage: opts.leadStage, kb: filterKnowledgeBaseForRental(kb) })
    : null;
  // Sales uses the shared prompt module — this file used to hold its own copy
  // of the same 16,000 characters, and the two had already drifted apart.
  // Corrections are not passed here: on this path they reach the model through
  // buildPromptAdditions instead, exactly as before.
  const salesParts = rentalParts
    ? null
    : buildSalesPromptParts({ leadStage: opts.leadStage, kb, brokerPicksBlock, catalog });
  const cachePrefix = rentalParts ? rentalParts.prefix : salesParts!.prefix;
  const systemPrompt = rentalParts ? rentalParts.tail : salesParts!.tail;



  const dialog = parseDialogContent(opts.contentSnippet);
  const formattedDialog = formatDialogForAI(dialog.messages);
  const lastLeadText = opts.lastLeadMessage.trim() || dialog.lastLeadMessage?.text || "";
  const lastBrokerText = dialog.lastOurMessage?.text ?? "";

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
      ? `FULL CONVERSATION (oldest → newest):
${formattedDialog}
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
      : `FULL CONVERSATION (oldest → newest):
${formattedDialog}
${leadContext}
SITUATION: The broker's last message was:
"${lastBrokerText}"
The lead has NOT replied to this message yet.

Broker: ${opts.responsibleUser ?? "Broker"}

Task: Write a short follow-up. The lead hasn't responded — re-engage without repeating the same message. Use any lead card info above to personalise.

IMPORTANT: Do NOT include property links or listings in this follow-up. The broker will personally select and share properties when ready. Your job is to re-engage naturally — add value, reference something they said earlier, or propose a low-effort next step.

Under 100 words.${AVOID_PHRASES_REMINDER}`;

  // Name, inventory truth and the "links ride along with this message" rule —
  // shared with lib/generate-suggestion so this copy can't drift again.
  const promptAdditions = await buildPromptAdditions({
    isRental,
    dialogMessages: dialog.messages,
    lastLeadText,
    leadNotes: opts.leadNotes ?? null,
    responsibleUser: opts.responsibleUser ?? null,
    leadId: opts.leadId,
  });

  const completion = await chatCompletion({
    model: WRITER_MODEL,
    label: "draft",
    system: systemPrompt,
    ...(cachePrefix ? { cachePrefix } : {}),
    messages: [{ role: "user", content: prompt + promptAdditions }],
    max_tokens: 400,
  });

  const draft = sanitizeSuggestion(completion.content);

  // Shared picker — already-sent exclusion, current area/bedroom criteria, and
  // the "lead already chose a villa" gate all live in ONE place. The bare
  // matchProperties call that used to sit here is why this path kept
  // re-attaching the same two already-sent listings whatever the lead asked.
  const attachments = await pickPropertyAttachments({
    leadId: opts.leadId,
    brokerId: opts.responsibleUser,
    isRental,
    contentSnippet: opts.contentSnippet,
    dialogMessages: dialog.messages,
    formattedDialog,
    lastLeadText,
    leadStage: opts.leadStage,
    leadNotes: opts.leadNotes ?? null,
  });

  // The draft was written without knowing which listings the matcher would
  // choose — make the two agree before this reaches the broker.
  const text = await reconcileTextWithAttachments(draft, attachments);

  return { text, attachments };
}

export async function queueSuggestion(opts: {
  leadId: string;
  responsibleUser: string | null;
  kind: "live" | "push";
  text: string;
  followupLevel?: number;
  attachments?: GeneratedSuggestion["attachments"];
  /** The lead's own incoming message (kind "live" only) — shown in the push notification instead of our draft reply. */
  leadMessageText?: string;
  /** True when a broker asked for this draft by hand — see requestedAt on the table. */
  requestedByBroker?: boolean;
}): Promise<void> {
  const brokerId = brokerKey(opts.responsibleUser);

  await db.insert(aiSuggestionsTable).values({
    brokerId,
    leadId: opts.leadId,
    leadName: `Lead #${opts.leadId}`,
    promptMessages: [],
    suggestionText: opts.text,
    rationale:
      opts.kind === "live"
        ? `Lead replied. Respond now to keep the thread warm.`
        : `Follow-up #${opts.followupLevel ?? 1} — no reply yet.`,
    model: "claude-sonnet-5",
  });

  if (opts.kind === "live") {
    // Lead replied — LIVE always wins over any pending PUSH.
    await db
      .delete(pendingSuggestionsTable)
      .where(
        and(
          eq(pendingSuggestionsTable.leadId, opts.leadId),
          eq(pendingSuggestionsTable.status, "pending"),
          eq(pendingSuggestionsTable.kind, "push"),
        ),
      );

    // Update the EXISTING pending LIVE row in place rather than delete+insert.
    // A broker can have this suggestion open on their phone when the lead sends
    // a follow-up message that triggers a regeneration; delete+insert changed
    // the row's id out from under them, so tapping "Approve" 404'd against an
    // id that no longer existed. Same id survives a refresh → approve always
    // resolves, worst case against text one message older than the newest.
    const [existingLive] = await db
      .select({ id: pendingSuggestionsTable.id })
      .from(pendingSuggestionsTable)
      .where(
        and(
          eq(pendingSuggestionsTable.leadId, opts.leadId),
          eq(pendingSuggestionsTable.status, "pending"),
          eq(pendingSuggestionsTable.kind, "live"),
        ),
      )
      .limit(1);

    let rowId = existingLive?.id ?? null;
    if (existingLive) {
      await db
        .update(pendingSuggestionsTable)
        .set({
          suggestionText: opts.text,
          attachments: opts.attachments,
          createdAt: new Date(),
          // Clear the previous classification — it described an older reply.
          suggestedStage: null,
          suggestedStageId: null,
          suggestedStageReason: null,
          suggestedStageTerminal: null,
        })
        .where(eq(pendingSuggestionsTable.id, existingLive.id));
    } else {
      const [inserted] = await db
        .insert(pendingSuggestionsTable)
        .values({
          leadId: opts.leadId,
          responsibleUser: opts.responsibleUser,
          kind: "live",
          followupLevel: null,
          suggestionText: opts.text,
          status: "pending",
          attachments: opts.attachments,
        })
        .returning({ id: pendingSuggestionsTable.id });
      rowId = inserted?.id ?? null;
    }
    // Notify BEFORE classifying the stage — the broker should hear about the
    // lead's reply the moment it's ready, not after another AI round-trip.
    notifyBrokerForLead(opts.responsibleUser, opts.leadId, "replied", opts.leadMessageText || opts.text).catch(() => {});
    if (rowId) void classifyStageInBackground(rowId, opts.leadId, opts.text, opts.attachments?.length ?? 0);
  } else {
    // PUSH — only queue if no pending suggestion already exists
    const existing = await db
      .select({ id: pendingSuggestionsTable.id })
      .from(pendingSuggestionsTable)
      .where(
        and(
          eq(pendingSuggestionsTable.leadId, opts.leadId),
          eq(pendingSuggestionsTable.status, "pending"),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      await db.insert(pendingSuggestionsTable).values({
        leadId: opts.leadId,
        responsibleUser: opts.responsibleUser,
        kind: "push",
        followupLevel: opts.followupLevel ?? null,
        requestedAt: opts.requestedByBroker ? new Date() : null,
        suggestionText: opts.text,
        status: "pending",
        attachments: opts.attachments,
      });
    } else if (opts.requestedByBroker) {
      // The lead already had a pending row, so the insert above was skipped and
      // the broker's request quietly did nothing: the row stayed kind="live" and
      // the inbox kept hiding it behind "we already answered". Upgrade it in
      // place instead — same id, so a card open on the broker's screen keeps
      // working (a delete+reinsert is what once made approve 404).
      await db
        .update(pendingSuggestionsTable)
        .set({
          kind: "push",
          followupLevel: opts.followupLevel ?? null,
          requestedAt: new Date(),
          suggestionText: opts.text,
          attachments: opts.attachments,
          createdAt: new Date(),
          suggestedStage: null,
          suggestedStageId: null,
          suggestedStageReason: null,
          suggestedStageTerminal: null,
        })
        .where(eq(pendingSuggestionsTable.id, existing[0]!.id));
    }
  }

  // Staged delegation: if the broker has handed this lead's stage to the bot,
  // the freshly queued suggestion is sent without waiting for approval — or
  // logged as "would send" in dry mode. Covers LIVE and push alike.
  void maybeAutopilot(opts.leadId);
}

/**
 * Works out which funnel stage the conversation reaches once this reply is sent
 * and stores it on the suggestion, so approving applies it without the broker
 * dragging the card by hand. Runs AFTER the push notification deliberately —
 * it's an extra AI round-trip and the stage isn't needed until the broker
 * actually approves, which is seconds away at the earliest.
 */
export async function classifyStageInBackground(
  rowId: string,
  leadId: string,
  replyText: string,
  attachmentsCount: number,
): Promise<void> {
  try {
    const [lead] = await db
      .select({
        content: leadsSyncTable.content,
        leadStage: leadsSyncTable.leadStage,
        pipeline: leadsSyncTable.pipeline,
      })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, leadId))
      .limit(1);
    if (!lead) return;

    const dialog = parseDialogContent(lead.content ?? "");
    const classification = await classifyStage({
      pipeline: lead.pipeline,
      currentStage: lead.leadStage,
      conversationText: formatDialogForAI(dialog.messages),
      replyText,
      attachmentsCount,
    });
    if (!classification) return;

    await db
      .update(pendingSuggestionsTable)
      .set({
        suggestedStage: classification.stage.name,
        suggestedStageId: String(classification.stage.id),
        suggestedStageReason: classification.reason,
        suggestedStageTerminal: classification.terminal,
      })
      .where(eq(pendingSuggestionsTable.id, rowId));
    logger.info(
      { leadId, from: lead.leadStage, to: classification.stage.name, terminal: classification.terminal },
      "stage classified for pending suggestion",
    );
  } catch (err) {
    logger.error({ err, leadId }, "background stage classification failed (non-fatal)");
  }
}

/**
 * Split an AI response into individual property messages.
 * Each URL+description block becomes a separate WhatsApp message so
 * WhatsApp renders a unique banner/preview for each property link.
 * Returns the original text as a single-element array if no URLs are found.
 */
function splitPropertyMessages(text: string): string[] {
  const urlCount = (text.match(/^https?:\/\//gm) ?? []).length;
  if (urlCount < 2) return [text.trim()];
  // Split at every newline that immediately precedes a URL
  const parts = text.split(/\n(?=https?:\/\/)/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

router.post("/amocrm/webhook", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  req.log.info({ keys: Object.keys(body) }, "amocrm webhook received");

  // ── New primary format: { leadId, responsibleUser, content } ──────────────
  if (typeof body["leadId"] === "string" && typeof body["content"] === "string") {
    const leadId = body["leadId"] as string;
    const responsibleUser = (body["responsibleUser"] as string | undefined) ?? null;
    const content = body["content"] as string;
    const leadNotes = (body["leadNotes"] as string | undefined) ?? null;
    // Accept both "leadStage" (old format) and "stage" (new format)
    const leadStage = ((body["stage"] ?? body["leadStage"]) as string | undefined) ?? null;
    const leadStageId = (body["stageId"] as string | undefined) ?? null;
    const pipeline = (body["pipeline"] as string | undefined) ?? null;

    // Respond immediately — processing is async
    res.json({ ok: true, leadId });

    // HoS is also responsible for leads outside the Rental pipeline (e.g. a
    // separate hiring/HR track) — this bot only handles Rental for that account,
    // so skip generation entirely rather than burning an AI call just to hide it later.
    if (isBroker(responsibleUser, "HoS") && (pipeline ?? "").toLowerCase() !== "rental") {
      return;
    }

    try {
      const eventType = (body["event"] as string | undefined) ?? "";
      req.log.info(
        { contentTail: content.slice(-150), contentLen: content.length },
        "webhook content tail",
      );

      // ── lead_assigned: first-contact push suggestion ──────────────────────
      if (eventType === "lead_assigned") {
        await db.insert(leadsSyncTable).values({
          leadId,
          responsibleUser,
          content,
          leadNotes,
          leadStage: leadStage ?? undefined,
          leadStageId: leadStageId ?? undefined,
          pipeline: pipeline ?? undefined,
          lastMessageAt: null,
          lastMessageFrom: null,
          lastOurMessageAt: null,
          followupLevel: 0,
          nextFollowupAt: null,
        }).onConflictDoUpdate({
          target: leadsSyncTable.leadId,
          set: { responsibleUser, leadNotes: leadNotes ?? undefined, leadStage: leadStage ?? undefined, leadStageId: leadStageId ?? undefined, pipeline: pipeline ?? undefined, content },
        });

        // Rental has its own amoCRM automation ("Команда F5") that sends the
        // very first message, same role ARGO plays for Unicorn — the bot must
        // not also suggest a first-contact message on top of that. In practice
        // this handler has never fired for Unicorn leads either (no historical
        // records), so skipping it for Rental brings the two pipelines to parity.
        if ((pipeline ?? "").toLowerCase() === "rental") {
          return;
        }

        // "lead_assigned" fires on every (re)assignment, not just genuinely new
        // leads — e.g. amoCRM can re-fire it after a lead is already engaged.
        // Only treat this as a true cold-open if there's no real conversation yet.
        const hasExistingDialog = parseDialogContent(content).messages.length > 0;

        const { text, attachments } = await generateSuggestion({
          leadId,
          responsibleUser,
          kind: "push",
          lastLeadMessage: "",
          contentSnippet: content,
          leadNotes,
          leadStage,
          isFirstContact: !hasExistingDialog,
          pipeline,
        });
        if (text) {
          await queueSuggestion({ leadId, responsibleUser, kind: "push", text, attachments });
          req.log.info({ leadId }, "lead_assigned first-contact suggestion queued");
        }
        return;
      }

      const dialog = parseDialogContent(content);
      const now = new Date();

      // LIVE if: dialog parser says lead replied, OR the event explicitly says so
      const isLiveEvent =
        eventType === "lead_replied" || eventType === "incoming_message";
      let isLive = dialog.leadRepliedAfterUs || isLiveEvent;

      // Fetch existing record
      const [existing] = await db
        .select()
        .from(leadsSyncTable)
        .where(eq(leadsSyncTable.leadId, leadId))
        .limit(1);

      // Use the MOST RECENT known "our message" timestamp.
      // dialog.lastOurMessage?.at comes from stale webhook content and can be older
      // than existing.lastOurMessageAt (updated by approve.ts before the hook fires).
      // Always take the max so follow-up scheduling is based on the real last reply.
      const dialogOurAt = dialog.lastOurMessage?.at ?? null;
      const existingOurAt = existing?.lastOurMessageAt ?? null;
      const lastOurAt =
        dialogOurAt && existingOurAt
          ? new Date(Math.max(dialogOurAt.getTime(), existingOurAt.getTime()))
          : dialogOurAt ?? existingOurAt ?? null;
      const lastMsgAt = dialog.lastMessage?.at ?? null;
      let lastMsgFrom = dialog.lastMessage?.from ?? null;

      // ── Stale-content guard ──────────────────────────────────────────────────
      // Webhook content can arrive delayed (e.g. AmoCRM fires before WAHelp syncs
      // Robert's reply). If our DB already knows Robert replied AFTER the lead's
      // last message in this content, don't let the stale content downgrade
      // lastMessageFrom back to 'lead'.
      if (
        lastMsgFrom === "lead" &&
        existing?.lastMessageFrom === "us" &&
        existing.lastOurMessageAt &&
        dialog.lastLeadMessage?.at &&
        existing.lastOurMessageAt.getTime() > dialog.lastLeadMessage.at.getTime()
      ) {
        req.log.info({ leadId }, "stale-content guard: keeping lastMessageFrom=us, suppressing LIVE");
        lastMsgFrom = "us";
        isLive = false; // prevent generating a new LIVE suggestion for stale content
      }

      let nextFollowupAt: Date | null = existing?.nextFollowupAt ?? null;
      let followupLevel = existing?.followupLevel ?? 0;

      // Detect: broker just sent a NEW human message (not a re-delivery of old content)
      const brokerRepliedFresh =
        !isLive &&
        !!lastOurAt &&
        !!existing?.lastOurMessageAt &&
        lastOurAt.getTime() > existing.lastOurMessageAt.getTime();

      if (isLive) {
        // Lead replied → LIVE → reset follow-up schedule + clear any pending PUSH items
        nextFollowupAt = null;
        followupLevel = 0;
        await db
          .update(pendingSuggestionsTable)
          .set({ status: "skipped" })
          .where(
            and(
              eq(pendingSuggestionsTable.leadId, leadId),
              eq(pendingSuggestionsTable.status, "pending"),
              eq(pendingSuggestionsTable.kind, "push"),
            ),
          );
      } else if (brokerRepliedFresh) {
        // Broker manually replied → clear stale LIVE suggestion.
        // Do NOT set nextFollowupAt — task-driven scheduling via amo-sync
        // will pick up the amoCRM task due date when it's time.
        await db
          .delete(pendingSuggestionsTable)
          .where(
            and(
              eq(pendingSuggestionsTable.leadId, leadId),
              eq(pendingSuggestionsTable.status, "pending"),
              eq(pendingSuggestionsTable.kind, "live"),
            ),
          );
        // Keep followupLevel as-is (stage-based selection handles it at generation time)
        nextFollowupAt = null;

        // Track outbound touch — direct (sent outside plugin)
        await db.insert(contactEventsTable).values({
          leadId,
          responsibleUser: responsibleUser ?? existing?.responsibleUser ?? undefined,
          source: "direct",
        }).catch(() => {});

        // "I'll check with the owner and get back to you" said straight in
        // WhatsApp is just as real a promise as one sent through the bot — the
        // detector only ever saw text that went through /approve, so a broker
        // typing this directly into the app never got a reminder at all.
        if (dialog.lastOurMessage?.text) {
          recordCommitment(
            leadId,
            responsibleUser ?? existing?.responsibleUser ?? null,
            dialog.lastOurMessage.text,
          ).catch(() => {});
        }

        // Rental pipeline: a broker replying directly via WhatsApp (bypassing
        // the extension) still counts as "this touch is done" — advance the
        // stage and create the next task, same as if the bot had sent it.
        if ((pipeline ?? "").toLowerCase() === "rental") {
          try {
            const amoLead = await getAmoLead(leadId);
            if (amoLead?.status_id) {
              const level = rentalStageToFollowupLevel(existing?.leadStage ?? leadStage);
              await advanceRentalFollowup(leadId, amoLead.status_id, level);
              req.log.info({ leadId, level }, "rental: manual WhatsApp reply advanced follow-up");
            }
          } catch (err) {
            req.log.error({ err, leadId }, "rental: advanceRentalFollowup on manual reply failed");
          }
        }
      } else if (lastMsgFrom === "us") {
        // Broker wrote last, lead hasn't replied.
        // Do NOT auto-schedule — the broker creates an amoCRM task with the
        // desired follow-up date and amo-sync detects it when due.
        nextFollowupAt = null;
      } else if (lastMsgFrom === "lead") {
        // Lead wrote last — they already replied, no follow-up needed.
        // Just wait for broker to respond (LIVE suggestion handles this).
        nextFollowupAt = null;
      }

      // Upsert leads_sync
      if (existing) {
        await db
          .update(leadsSyncTable)
          .set({
            responsibleUser,
            content,
            leadNotes: leadNotes ?? existing?.leadNotes ?? null,
            leadStage: leadStage ?? existing?.leadStage ?? null,
            leadStageId: leadStageId ?? existing?.leadStageId ?? null,
            pipeline: pipeline ?? existing?.pipeline ?? null,
            lastMessageAt: lastMsgAt,
            lastMessageFrom: lastMsgFrom,
            lastOurMessageAt: lastOurAt,
            followupLevel,
            nextFollowupAt,
            updatedAt: now,
          })
          .where(eq(leadsSyncTable.leadId, leadId));
      } else {
        await db.insert(leadsSyncTable).values({
          leadId,
          responsibleUser,
          content,
          leadNotes,
          leadStage: leadStage ?? undefined,
          leadStageId: leadStageId ?? undefined,
          pipeline: pipeline ?? undefined,
          lastMessageAt: lastMsgAt,
          lastMessageFrom: lastMsgFrom,
          lastOurMessageAt: lastOurAt,
          followupLevel,
          nextFollowupAt,
        });
      }

      req.log.info(
        { leadId, leadRepliedAfterUs: dialog.leadRepliedAfterUs, brokerRepliedFresh, followupLevel, nextFollowupAt },
        "dialog analyzed",
      );

      // ── Dead-stage cleanup ────────────────────────────────────────────────────
      // If the lead just moved to a closed/lost/incorrect-information stage,
      // immediately cancel ALL pending suggestions so they stop showing in the bot.
      const effectiveStageForCleanup = leadStage ?? existing?.leadStage ?? null;
      if (effectiveStageForCleanup && shouldSuppressPush(effectiveStageForCleanup)) {
        const cancelled = await db
          .update(pendingSuggestionsTable)
          .set({ status: "skipped" })
          .where(
            and(
              eq(pendingSuggestionsTable.leadId, leadId),
              eq(pendingSuggestionsTable.status, "pending"),
            ),
          );
        req.log.info(
          { leadId, stage: effectiveStageForCleanup },
          "dead-stage: all pending suggestions cancelled",
        );
        return;
      }

      if (isLive) {
        const effectiveStage = leadStage ?? existing?.leadStage ?? null;

        // ── Stage whitelist (testing filter) ─────────────────────────────────
        if (!isStageWhitelisted(effectiveStage)) {
          req.log.info(
            { leadId, leadStage: effectiveStage },
            "live suggestion skipped — stage not in testing whitelist",
          );
        } else {
          // Debounced: the timeline quick-poll can independently detect the
          // same burst of WhatsApp messages a few seconds later. Without this,
          // a lead sending 2-3 messages in a row triggered a separate
          // generation per message, producing near-duplicate replies that
          // looked like the bot answering something already two messages old.
          // Re-reads the lead fresh at fire time so whichever trigger's timer
          // actually runs still reflects the latest content, not a stale snapshot.
          scheduleLiveReply(leadId, async () => {
            // The budget gate runs BEFORE any generation — a below-threshold
            // rental lead is closed without spending a token on it.
            if (await enforceBudgetFilter(leadId)) return;
            const [freshLead] = await db
              .select({
                content: leadsSyncTable.content,
                leadNotes: leadsSyncTable.leadNotes,
                leadStage: leadsSyncTable.leadStage,
                pipeline: leadsSyncTable.pipeline,
                responsibleUser: leadsSyncTable.responsibleUser,
              })
              .from(leadsSyncTable)
              .where(eq(leadsSyncTable.leadId, leadId))
              .limit(1);
            if (!freshLead) return;

            const freshContent = freshLead.content ?? content;
            const freshDialog = parseDialogContent(freshContent);
            const lastLeadMsg = freshDialog.lastLeadMessage?.text ?? freshContent.slice(-400);

            const { text, attachments } = await generateSuggestion({
              leadId,
              responsibleUser: freshLead.responsibleUser ?? responsibleUser,
              kind: "live",
              lastLeadMessage: lastLeadMsg,
              contentSnippet: freshContent,
              leadNotes: freshLead.leadNotes ?? leadNotes,
              leadStage: freshLead.leadStage ?? effectiveStage,
              pipeline: freshLead.pipeline ?? pipeline,
            });

            if (text) {
              await queueSuggestion({
                leadId,
                responsibleUser: freshLead.responsibleUser ?? responsibleUser,
                kind: "live",
                text,
                attachments,
                leadMessageText: lastLeadMsg,
              });
              req.log.info({ leadId }, "live suggestion queued (debounced)");
            }
          });
        }
      }
      // PUSH / follow-ups are handled by the scheduler (not inline)
    } catch (err) {
      req.log.error({ err, leadId }, "webhook processing error");
    }

    return;
  }

  // ── Legacy Ф5 flat format: { leadId, responsibleUser, event, content? } ───
  if (typeof body["leadId"] === "string") {
    const leadId = body["leadId"] as string;
    const responsibleUser = (body["responsibleUser"] as string) ?? null;
    const content = (body["content"] as string) ?? "";
    const eventType = (body["event"] as string) ?? "unknown";

    const kind: "live" | "push" =
      eventType === "lead_replied" || eventType === "incoming_message" ? "live" : "push";

    res.json({ ok: true, queued: 1, leadId, kind });

    const [legacySyncRow] = await db
      .select({ pipeline: leadsSyncTable.pipeline })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, leadId))
      .limit(1);

    // HoS is also responsible for leads outside the Rental pipeline (e.g. a
    // separate hiring/HR track) — this bot only handles Rental for that account.
    if (isBroker(responsibleUser, "HoS") && (legacySyncRow?.pipeline ?? "").toLowerCase() !== "rental") {
      return;
    }

    const { text, attachments } = await generateSuggestion({
      leadId,
      responsibleUser,
      kind,
      lastLeadMessage: content,
      contentSnippet: content,
      pipeline: legacySyncRow?.pipeline,
    }).catch((err) => {
      req.log.error({ err, leadId }, "generate error");
      return { text: "", attachments: [] };
    });

    if (text) {
      await queueSuggestion({ leadId, responsibleUser, kind, text, attachments, leadMessageText: content }).catch((err) =>
        req.log.error({ err }, "queue error"),
      );
    }

    return;
  }

  // ── Native AmoCRM webhook: { leads: { add, update } } ─────────────────────
  const amoBody = body as {
    leads?: {
      add?: Array<{ id?: string; name?: string; responsible_user_name?: string }>;
      update?: Array<{ id?: string; name?: string; responsible_user_name?: string }>;
    };
  };

  const tasks: string[] = [];

  for (const lead of amoBody.leads?.add ?? []) {
    if (!lead.id) continue;
    tasks.push(lead.id);
    const [syncRow] = await db
      .select({ pipeline: leadsSyncTable.pipeline })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, String(lead.id)))
      .limit(1);
    if (isBroker(lead.responsible_user_name, "HoS") && (syncRow?.pipeline ?? "").toLowerCase() !== "rental") continue;
    const { text, attachments } = await generateSuggestion({
      leadId: String(lead.id),
      responsibleUser: lead.responsible_user_name ?? null,
      kind: "push",
      lastLeadMessage: "",
      contentSnippet: lead.name ?? "",
      pipeline: syncRow?.pipeline,
    }).catch(() => ({ text: "", attachments: [] }));
    if (text) {
      await queueSuggestion({
        leadId: String(lead.id),
        responsibleUser: lead.responsible_user_name ?? null,
        kind: "push",
        text,
        attachments,
      }).catch(() => null);
    }
  }

  for (const lead of amoBody.leads?.update ?? []) {
    if (!lead.id) continue;
    tasks.push(lead.id);
    const [syncRow] = await db
      .select({ pipeline: leadsSyncTable.pipeline })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, String(lead.id)))
      .limit(1);
    if (isBroker(lead.responsible_user_name, "HoS") && (syncRow?.pipeline ?? "").toLowerCase() !== "rental") continue;
    const { text, attachments } = await generateSuggestion({
      leadId: String(lead.id),
      responsibleUser: lead.responsible_user_name ?? null,
      kind: "live",
      lastLeadMessage: "",
      contentSnippet: lead.name ?? "",
      pipeline: syncRow?.pipeline,
    }).catch(() => ({ text: "", attachments: [] }));
    if (text) {
      await queueSuggestion({
        leadId: String(lead.id),
        responsibleUser: lead.responsible_user_name ?? null,
        kind: "live",
        text,
        attachments,
      }).catch(() => null);
    }
  }

  res.json({ ok: true, queued: tasks.length });
});

router.get("/amocrm/webhook", (_req, res) => {
  res.json({ ok: true, message: "AmoCRM webhook endpoint is live" });
});

// Internal: regenerate a live suggestion for a lead using current lead data from DB
router.post("/amocrm/regen-live", async (req, res) => {
  const { leadId, responsibleUser } = req.body as { leadId: string; responsibleUser?: string };
  if (!leadId) { res.status(400).json({ error: "leadId required" }); return; }

  try {
    const rows = await db.select().from(leadsSyncTable).where(eq(leadsSyncTable.leadId, String(leadId))).limit(1);
    if (!rows[0]) { res.status(404).json({ error: "lead not found" }); return; }

    const lead = rows[0];

    // The budget gate applies here too — this path generated a draft for a lead
    // the gate had already condemned (the villa she clicked costs 28M against a
    // 40M bar), because regen skipped every entry-point check.
    if (await enforceBudgetFilter(String(leadId))) {
      res.json({ ok: true, closed: true, reason: "budget below the broker's threshold" });
      return;
    }

    // ── Stage whitelist (testing filter) ───────────────────────────────────
    if (!isStageWhitelisted(lead.leadStage)) {
      res.json({ ok: true, skipped: true, reason: "stage not in testing whitelist", stage: lead.leadStage });
      return;
    }

    const dialog = parseDialogContent(lead.content ?? "");
    const lastLeadMsg = dialog.lastLeadMessage?.text ?? "";

    if (!lastLeadMsg) { res.json({ ok: true, skipped: true, reason: "no lead message" }); return; }

    const { text, attachments } = await generateSuggestion({
      leadId: String(leadId),
      responsibleUser: responsibleUser ?? lead.responsibleUser ?? null,
      kind: "live",
      lastLeadMessage: lastLeadMsg,
      contentSnippet: lead.content ?? "",
      leadNotes: lead.leadNotes ?? null,
      leadStage: lead.leadStage ?? null,
      pipeline: lead.pipeline,
    });

    // A draft asked for by hand on a lead we have ALREADY answered is a proactive
    // message, not a reply — and the inbox hides LIVE drafts once we spoke last
    // ("did the broker already answer?"). Queued as live it existed in the table
    // and was invisible in the app, which is exactly what the owner kept seeing:
    // "the draft is there, I don't see the lead". Queue it as push so it surfaces.
    const weSpokeLast =
      !!lead.lastOurMessageAt &&
      (!dialog.lastLeadMessage?.at ||
        lead.lastOurMessageAt.getTime() >= dialog.lastLeadMessage.at.getTime());

    await queueSuggestion({
      leadId: String(leadId),
      responsibleUser: responsibleUser ?? lead.responsibleUser ?? null,
      kind: weSpokeLast ? "push" : "live",
      text,
      attachments,
      leadMessageText: lastLeadMsg,
      followupLevel: weSpokeLast ? 1 : undefined,
      requestedByBroker: true,
    });

    if (weSpokeLast) {
      // The push tab also hides a lead whose follow-up task sits beyond today —
      // bring it forward so the draft the broker just asked for is actually there.
      await db
        .update(leadsSyncTable)
        .set({ nextFollowupAt: new Date(), updatedAt: new Date() })
        .where(eq(leadsSyncTable.leadId, String(leadId)));
    }

    res.json({ ok: true, leadId, kind: weSpokeLast ? "push" : "live", preview: text.slice(0, 100) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "regen-live failed");
    res.status(500).json({ error: msg.slice(0, 200) });
  }
});

// One-shot: delete all pending suggestions containing property links
router.post("/amocrm/purge-property-links", async (_req, res) => {
  try {
    const { sql } = await import("drizzle-orm");
    const result = await db.execute(
      sql`DELETE FROM pending_suggestions WHERE status = 'pending' AND suggestion_text LIKE '%unicorn-property%'`
    );
    res.json({ ok: true, deleted: (result as any).rowCount ?? "?" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg.slice(0, 200) });
  }
});

export default router;
