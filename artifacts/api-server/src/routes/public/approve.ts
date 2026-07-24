import { Router } from "express";
import { db, pendingSuggestionsTable, sentMessagesTable, leadsSyncTable, stageEventsTable, brokerCorrectionsTable, leadCrmTasksTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { nextFollowupDate } from "../../lib/dialog-parser";
import { chatCompletionJSON } from "../../lib/ai-client.js";
import { updateLeadStatus, closeAmoTasksForLead, createAmoTask, getAmoLead, closeLeadAsLost } from "../../lib/amo-client.js";
import { updateLeadCustomField, triggerSalesbot } from "../../lib/amo-chat-client";
import { FOLLOWUP_STAGE_ADVANCE_RENTAL, FOLLOWUP_DELAY_DAYS_RENTAL } from "../../lib/rental-followup.js";
import { incrementBrokerPick } from "../../lib/broker-picks-tracker.js";

// amoCRM status IDs for the Unicorn Property pipeline (PIPELINE 8347534)
// Maps each follow-up stage to the NEXT stage — bot auto-advances on approve.
const FOLLOWUP_STAGE_ADVANCE: Record<number, number> = {
  72376798: 72376802, // 1ST FOLLOW UP → 2ND FOLLOW UP
  72376802: 72376806, // 2ND FOLLOW UP → FINAL FOLLOW UP
  // FINAL FOLLOW UP (72376806) → auto-closes as Lost if client never replied
};

// AmoCRM loss reason ID for "Not Responding" (created via API)
const LOSS_REASON_NOT_RESPONDING = 23931458;

// followupLevel value that corresponds to Final Follow Up (same numbering for every pipeline —
// this is our own DB-tracked touch counter, not an amoCRM-specific value).
const FINAL_FOLLOWUP_LEVEL = 3;

const router = Router();

const COMPANION_FIELD_ID = 965907;
const COMPANION_ROBERT_BOT_ID = 22127;

/**
 * Close any open CRM tasks for this lead (in DB + amoCRM directly via API),
 * then create a new task scheduled for the NEXT follow-up interval.
 * Fire-and-forget — never blocks the approve response.
 */
async function autoCreateCrmTask(
  leadId: string,
  messageText: string,
  kind: string,
  followupLevel: number | null,
  approveNow: Date,
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void },
  /** lastMessageFrom captured BEFORE the approve DB update — "lead" means client had replied at some point */
  prevLastMessageFrom: string | null,
): Promise<void> {
  try {
    // 0. Look up the lead's pipeline — Rental uses its own (shorter) cadence
    //    and its own stage-advance map (see constants above).
    const [pipelineRow] = await db
      .select({ pipeline: leadsSyncTable.pipeline })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, leadId))
      .limit(1);
    const isRentalPipeline = (pipelineRow?.pipeline ?? "").toLowerCase() === "rental";
    const stageAdvanceMap = isRentalPipeline ? FOLLOWUP_STAGE_ADVANCE_RENTAL : FOLLOWUP_STAGE_ADVANCE;
    const delayDays = isRentalPipeline ? FOLLOWUP_DELAY_DAYS_RENTAL : undefined;

    // 1. Close open tasks in our DB
    const closeNow = new Date();
    await db
      .update(leadCrmTasksTable)
      .set({ status: "closed", closedAt: closeNow })
      .where(and(eq(leadCrmTasksTable.leadId, leadId), eq(leadCrmTasksTable.status, "open")));

    // 2. Close open tasks in amoCRM directly (no webhook needed)
    const closedCount = await closeAmoTasksForLead(leadId);
    log.info({ leadId, closedCount }, "amoCRM tasks closed before creating new");

    const snippet = messageText.replace(/\n+/g, " ").slice(0, 80);
    const ellipsis = messageText.length > 80 ? "…" : "";

    let taskDate: Date;
    let nextActionNote: string;

    if (kind === "push") {
      const level = Math.max(0, followupLevel ?? 0);
      const nextLevelDate = delayDays ? nextFollowupDate(approveNow, level, delayDays) : nextFollowupDate(approveNow, level);

      if (nextLevelDate) {
        taskDate = nextLevelDate;
        nextActionNote = `Follow-up #${level + 1} — если нет ответа, отправить следующий touch.`;
      } else {
        taskDate = new Date(approveNow.getTime() + 7 * 24 * 60 * 60 * 1000);
        nextActionNote = `Последний follow-up #${level} отправлен. Если нет ответа — принять решение по лиду.`;
      }
    } else {
      taskDate = new Date(approveNow.getTime() + 24 * 60 * 60 * 1000);
      nextActionNote = "Ожидать ответа клиента. Если нет ответа в течение 24ч — follow-up.";
    }

    const taskText = `Отправлено (${kind}): "${snippet}${ellipsis}". ${nextActionNote}`;

    // 3. Get lead's responsible_user_id from amoCRM for task assignment
    //    Also read current status_id so we can auto-advance the stage.
    let responsibleUserId: number | undefined;
    let currentStatusId: number | undefined;
    try {
      const amoLead = await getAmoLead(leadId);
      responsibleUserId = amoLead?.responsible_user_id;
      currentStatusId = amoLead?.status_id;
    } catch { /* non-fatal */ }

    // 3b. Auto-advance stage OR auto-close as Lost on Final Follow Up
    if (kind === "push" && currentStatusId) {
      const isFinalFollowup = followupLevel === FINAL_FOLLOWUP_LEVEL;

      if (isFinalFollowup) {
        // Final Follow Up approved → check if client never replied
        // prevLastMessageFrom is captured BEFORE the approve handler set it to "us"
        const clientNeverReplied = prevLastMessageFrom !== "lead";

        if (clientNeverReplied) {
          // Close lead as Lost: Closed Lost + Not Responding + exclude from bot
          try {
            await closeLeadAsLost(leadId, LOSS_REASON_NOT_RESPONDING);
            log.info({ leadId }, "auto-closed as Lost: Final Follow Up, client never replied");
          } catch { /* non-fatal */ }

          // Exclude from bot — no more suggestions needed
          await db
            .update(leadsSyncTable)
            .set({ botExcluded: true, nextFollowupAt: null })
            .where(eq(leadsSyncTable.leadId, leadId));

          // No new task needed — lead is closed
          log.info({ leadId }, "auto-close: skipping new task creation (lead archived)");
          return;
        }
      } else {
        const nextStatusId = stageAdvanceMap[currentStatusId];
        if (nextStatusId) {
          try {
            await updateLeadStatus(leadId, nextStatusId);
            log.info({ leadId, currentStatusId, nextStatusId }, "auto-advanced follow-up stage");
          } catch { /* non-fatal */ }
        }
      }
    }

    // 4. Create task directly in amoCRM via API
    const amoTaskOk = await createAmoTask(leadId, taskText, taskDate, responsibleUserId);

    // 5. Record in our DB
    await db.insert(leadCrmTasksTable).values({
      leadId,
      taskDate,
      taskText,
      webhookStatus: amoTaskOk ? 200 : 0,
      webhookResponse: amoTaskOk ? "created via API" : "failed",
    });

    log.info({ leadId, kind, amoTaskOk, responsibleUserId }, "auto-task created after approve");
  } catch (err) {
    log.error({ err }, "autoCreateCrmTask failed (non-fatal)");
  }
}

router.options("/approve", (_req, res) => res.sendStatus(204));

/**
 * Analyze the diff between original AI draft and broker's manual edit,
 * extract a reusable instruction, and save it to broker_corrections so
 * the AI learns from this edit in future suggestions.
 * Fire-and-forget — never blocks the approve response.
 */
async function learnFromManualEdit(
  brokerId: string,
  originalText: string,
  editedText: string,
  stage: string,
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void },
): Promise<void> {
  try {
    const parsed = await chatCompletionJSON<{ instruction?: string }>({
      model: "claude-haiku-4-5-20251001",
      system: `You are a writing coach analyzing how a real estate broker edited an AI-generated message.
Extract a SHORT, REUSABLE instruction (max 120 chars) that describes WHAT the broker changed and WHY, 
so an AI can apply this preference to future messages automatically.

Focus on style/tone/content patterns — not the specific lead or property.
Examples of good instructions:
- "Use a more casual, friendly tone — avoid formal greetings"
- "Always end with a concrete question, not a soft statement"
- "Keep messages under 3 sentences — remove filler phrases"
- "Mention specific ROI numbers when discussing investment properties"

Respond with JSON only: {"instruction": "..."}`,
      messages: [
        {
          role: "user",
          content: `Original AI draft:\n"${originalText.slice(0, 600)}"\n\nBroker edited to:\n"${editedText.slice(0, 600)}"`,
        },
      ],
      max_tokens: 80,
      temperature: 0,
    });
    const instruction = parsed.instruction?.trim();

    if (!instruction || instruction.length < 5) return;

    await db.insert(brokerCorrectionsTable).values({
      brokerId: brokerId.toLowerCase().slice(0, 64),
      instruction,
      situationContext: stage || null,
    });

    log.info({ brokerId, instruction }, "auto-correction saved from manual edit");
  } catch (err) {
    log.error({ err }, "learnFromManualEdit failed (non-fatal)");
  }
}

router.post("/approve", async (req, res) => {
  const body = req.body as {
    suggestionId?: string;
    message?: string;
    edited?: boolean;
    newStage?: string;
    /** Numeric AmoCRM status_id — forwarded to stage webhook */
    stageId?: string;
    /** When true: only move stage, do NOT send the message to the client */
    skipMessage?: boolean;
    /** Original AI-generated text — sent by extension when broker manually edited */
    originalText?: string;
    /** Broker identifier — used to save correction */
    brokerId?: string;
  };

  const newStage = typeof body?.newStage === "string" && body.newStage.trim() ? body.newStage.trim() : null;
  const skipMessage = body?.skipMessage === true;

  if (
    !body?.suggestionId ||
    typeof body.suggestionId !== "string" ||
    !body.message ||
    typeof body.message !== "string" ||
    body.message.length > 8000
  ) {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }

  const [sug] = await db
    .select()
    .from(pendingSuggestionsTable)
    .where(eq(pendingSuggestionsTable.id, body.suggestionId as any))
    .limit(1);

  if (!sug) {
    res.status(404).json({ error: "Suggestion not found" });
    return;
  }
  if (sug.status !== "pending") {
    res.status(409).json({ error: "Already processed" });
    return;
  }

  const approveNow = new Date();
  let hookStatus = 0;
  let hookBody = "";
  let stageOk = false;
  let chatSent = false;

  // ── Atomic idempotency guard ──────────────────────────────────────────────
  const claimedStatus = skipMessage ? "skipped" : (body.edited ? "edited" : "approved");
  const [claimed] = await db
    .update(pendingSuggestionsTable)
    .set({ status: claimedStatus, finalText: body.message })
    .where(and(eq(pendingSuggestionsTable.id, body.suggestionId as any), eq(pendingSuggestionsTable.status, "pending")))
    .returning({ id: pendingSuggestionsTable.id });
  if (!claimed) {
    res.status(409).json({ error: "Already processed" });
    return;
  }

  if (skipMessage) {
    req.log.info({ leadId: sug.leadId, newStage }, "approve skip-message: suggestion skipped, no message sent");
  } else {
    req.log.info({
      leadId: sug.leadId,
      kind: sug.kind,
      edited: body.edited ?? false,
      msgLen: body.message.length,
      msgLines: body.message.split("\n").length,
      msgPreview: body.message.slice(0, 120).replace(/\n/g, "↵"),
    }, "approve: message received");

    // ── Update leads_sync BEFORE sending message ────────────────────────────
    const [prevSyncRow] = await db
      .select({ lastMessageFrom: leadsSyncTable.lastMessageFrom })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, sug.leadId))
      .limit(1);
    const prevLastMessageFrom = prevSyncRow?.lastMessageFrom ?? null;

    if (sug.kind === "push") {
      const sentLevel = sug.followupLevel ?? 1;
      const level = Math.max(0, sentLevel);
      const precomputedNextAt =
        nextFollowupDate(approveNow, level) ??
        new Date(approveNow.getTime() + 7 * 24 * 60 * 60 * 1000);
      await db
        .update(leadsSyncTable)
        .set({
          lastMessageFrom: "us",
          lastOurMessageAt: approveNow,
          followupLevel: sentLevel,
          nextFollowupAt: precomputedNextAt,
          updatedAt: approveNow,
        })
        .where(eq(leadsSyncTable.leadId, sug.leadId));
    } else {
      await db
        .update(leadsSyncTable)
        .set({
          lastMessageFrom: "us",
          lastOurMessageAt: approveNow,
          updatedAt: approveNow,
        })
        .where(eq(leadsSyncTable.leadId, sug.leadId));
    }

    // ── Send via Salesbot (replaces F5 hook) ──────────────────────────────────
    // 1. Write message to custom field "companion massage"
    // 2. Trigger Salesbot "Companion Robert" which reads the field and sends via WhatsApp
    const botId = COMPANION_ROBERT_BOT_ID;
    try {
      const fieldOk = await updateLeadCustomField(sug.leadId, COMPANION_FIELD_ID, body.message);
      if (fieldOk) {
        const botTriggered = await triggerSalesbot(sug.leadId, botId);
        chatSent = botTriggered;
        hookStatus = botTriggered ? 200 : 500;
        hookBody = botTriggered ? `Salesbot ${botId} triggered` : "Salesbot trigger failed";
      } else {
        hookStatus = 500;
        hookBody = "Custom field update failed";
      }
    } catch (e) {
      req.log.error({ err: e }, "Salesbot send error");
      hookStatus = 500;
      hookBody = String(e).slice(0, 1000);
    }
    req.log.info({ leadId: sug.leadId, hookStatus, chatSent, hookBody }, "Salesbot response");

    // Note: suggestion status already set atomically above (claimed update).

    await db.insert(sentMessagesTable).values({
      leadId: sug.leadId,
      suggestionId: sug.id as any,
      kind: sug.kind,
      messageText: body.message,
      responsibleUser: sug.responsibleUser,
      webhookStatus: hookStatus,
      webhookResponse: hookBody,
    });

    // ── Learn from manual edits ─────────────────────────────────────────────
    if (
      body.edited &&
      body.originalText &&
      body.brokerId &&
      body.originalText.trim() !== body.message.trim()
    ) {
      learnFromManualEdit(
        body.brokerId,
        body.originalText,
        body.message,
        newStage ?? sug.responsibleUser ?? "",
        req.log,
      ).catch(() => {});
    }

    // ── Auto-create CRM task (close previous, open new) ──────────────────────
    autoCreateCrmTask(
      sug.leadId,
      body.message,
      sug.kind,
      sug.followupLevel ?? null,
      approveNow,
      req.log,
      prevLastMessageFrom,
    ).catch(() => {});

    // ── Track property picks — personalizes future matching for this broker ──
    if (sug.responsibleUser && sug.attachments && sug.attachments.length > 0) {
      for (const att of sug.attachments) {
        if (att.type !== "link" || !att.url) continue;
        const match = att.url.match(/\/property\/([A-Za-z0-9-]+)/i);
        if (!match) continue;
        const propertyId = match[1];
        const listingType = /^R-/i.test(propertyId) ? "rent" : "sale";
        incrementBrokerPick(sug.responsibleUser, propertyId, listingType).catch(() => {});
      }
    }
  }

  // ── Stage change (applies for both normal approve and skip-message) ─────────
  if (newStage) {
    const prevSync = await db
      .select({ leadStage: leadsSyncTable.leadStage })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, sug.leadId))
      .limit(1);

    const prevStage = prevSync[0]?.leadStage ?? null;

    const stageId = typeof body.stageId === "string" && body.stageId.trim() ? body.stageId.trim() : null;

    await db
      .update(leadsSyncTable)
      .set({ leadStage: newStage, leadStageId: stageId ?? undefined, nextFollowupAt: null, updatedAt: new Date() })
      .where(eq(leadsSyncTable.leadId, sug.leadId));

    if (newStage !== prevStage) {
      await db.insert(stageEventsTable).values({
        leadId: sug.leadId,
        fromStage: prevStage,
        toStage: newStage,
        responsibleUser: sug.responsibleUser,
      }).catch(() => {});
    }

    // Update stage directly in amoCRM via API (stageId is the numeric status_id)
    if (stageId) {
      try {
        stageOk = await updateLeadStatus(sug.leadId, Number(stageId));
        req.log.info({ leadId: sug.leadId, newStage, stageId, stageOk }, "stage updated in amoCRM via API");
      } catch (e) {
        req.log.error({ err: e }, "stage-change API error");
      }
    } else {
      req.log.warn({ leadId: sug.leadId, newStage }, "no stageId provided — skipping amoCRM stage update");
    }
  }

  res.json({ ok: skipMessage ? true : hookStatus >= 200 && hookStatus < 300, hookStatus, stageOk });
});

export default router;
