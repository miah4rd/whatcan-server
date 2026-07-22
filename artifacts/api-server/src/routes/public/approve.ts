import { Router } from "express";
import { db, pendingSuggestionsTable, sentMessagesTable, leadsSyncTable, stageEventsTable, brokerCorrectionsTable, leadCrmTasksTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { nextFollowupDate } from "../../lib/dialog-parser";
import { chatCompletionJSON } from "../../lib/ai-client.js";
import { updateLeadStatus, closeAmoTasksForLead, createAmoTask, getAmoLead, closeLeadAsLost } from "../../lib/amo-client.js";

// amoCRM status IDs for the Unicorn Property pipeline (PIPELINE 8347534)
// Maps each follow-up stage to the NEXT stage — bot auto-advances on approve.
const FOLLOWUP_STAGE_ADVANCE: Record<number, number> = {
  72376798: 72376802, // 1ST FOLLOW UP → 2ND FOLLOW UP
  72376802: 72376806, // 2ND FOLLOW UP → FINAL FOLLOW UP
  // FINAL FOLLOW UP (72376806) → auto-closes as Lost if client never replied
};

// amoCRM status IDs for the Rental pipeline (PIPELINE 11119150) — same mechanism
// as Unicorn above, but Rental's qualification track is daily (1 day apart)
// instead of Unicorn's 1/3/5-day spread. See FOLLOWUP_DELAY_DAYS_RENTAL below.
const FOLLOWUP_STAGE_ADVANCE_RENTAL: Record<number, number> = {
  87318450: 87318706, // 1 foolow up → 2 foolow up
  87318706: 87318710, // 2 foolow up → 3 foolow up
  // 3 foolow up (87318710) → auto-closes as Lost if client never replied
};

// Rental qualification touches are spaced 1 calendar day apart (vs Unicorn's 1/3/5).
const FOLLOWUP_DELAY_DAYS_RENTAL = [1, 1, 1];

// AmoCRM loss reason ID for "Not Responding" (created via API)
const LOSS_REASON_NOT_RESPONDING = 23931458;

// followupLevel value that corresponds to Final Follow Up (same numbering for every pipeline —
// this is our own DB-tracked touch counter, not an amoCRM-specific value).
const FINAL_FOLLOWUP_LEVEL = 3;

const router = Router();

const HOOK_URL = "https://hooks.tglk.ru/in/p5dmPxJ7zyLkZ1HLlPSmaJ24ZQXz9a";

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

  // ── Atomic idempotency guard ──────────────────────────────────────────────
  // Claim the suggestion by flipping status+finalText in a single UPDATE that
  // only matches rows where status is still 'pending'. If two requests arrive
  // simultaneously both pass the sug.status check above, but only ONE will
  // receive a returned row here — the other gets a 409.
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
    // ── Skip message mode: only move stage, do NOT send WhatsApp message ─────
    // Suggestion already marked 'skipped' by the atomic update above.

    req.log.info({ leadId: sug.leadId, newStage }, "approve skip-message: suggestion skipped, no message sent");
  } else {
    // ── Diagnostic log: capture message shape on every approve ───────────────
    req.log.info({
      leadId: sug.leadId,
      kind: sug.kind,
      edited: body.edited ?? false,
      msgLen: body.message.length,
      msgLines: body.message.split("\n").length,
      msgPreview: body.message.slice(0, 120).replace(/\n/g, "↵"),
    }, "approve: message received");

  // ── Normal approve: update leads_sync BEFORE calling Ф5 hook ─────────────
    // Critical ordering: Ф5 fires a webhook back to us immediately after receiving
    // the message. If we update lastMessageFrom AFTER the hook call, the webhook
    // handler sees stale 'lead' state and re-creates a LIVE suggestion.
    // Updating first ensures the stale-content guard sees lastMessageFrom='us'.

    // Capture lastMessageFrom BEFORE the update so autoCreateCrmTask can determine
    // whether the client had ever replied (after the update it will always be "us").
    const [prevSyncRow] = await db
      .select({ lastMessageFrom: leadsSyncTable.lastMessageFrom })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, sug.leadId))
      .limit(1);
    const prevLastMessageFrom = prevSyncRow?.lastMessageFrom ?? null;

    if (sug.kind === "push") {
      // followupLevel in the suggestion is the level just sent (e.g. 1 = first follow-up).
      // Persist it so the next scheduler run knows which script to use.
      const sentLevel = sug.followupLevel ?? 1;
      // Pre-set nextFollowupAt to the future task date so amo-sync orphan sweep
      // does NOT immediately re-queue this lead while autoCreateCrmTask is still
      // running (fire-and-forget). Mirrors the same date logic used by autoCreateCrmTask.
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
          // Set to the next task date so amo-sync does not treat this lead as an
          // orphan until that date becomes due. amo-sync will overwrite this with
          // now() when the AmoCRM task's complete_till is reached.
          nextFollowupAt: precomputedNextAt,
          updatedAt: approveNow,
        })
        .where(eq(leadsSyncTable.leadId, sug.leadId));
    } else {
      // LIVE approved: broker replied — clear unanswered state immediately.
      await db
        .update(leadsSyncTable)
        .set({
          lastMessageFrom: "us",
          lastOurMessageAt: approveNow,
          updatedAt: approveNow,
        })
        .where(eq(leadsSyncTable.leadId, sug.leadId));
    }

    // ── Send to Ф5 hook ───────────────────────────────────────────────────────
    try {
      const r = await fetch(HOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: sug.leadId, message: body.message }),
      });
      hookStatus = r.status;
      hookBody = (await r.text()).slice(0, 1000);
    } catch (e) {
      req.log.error({ err: e }, "webhook error");
      hookBody = String(e).slice(0, 1000);
    }
    req.log.info({ leadId: sug.leadId, hookStatus, hookBodySnippet: hookBody.slice(0, 200) }, "hook response");

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
