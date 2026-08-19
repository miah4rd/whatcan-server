import { Router } from "express";
import { shouldSuppressPush } from "../../lib/stage-routing";
import { db, pendingSuggestionsTable, sentMessagesTable, leadsSyncTable, stageEventsTable, brokerCorrectionsTable, leadCrmTasksTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { nextFollowupDate, parseDialogContent, countTrailingOurMessages } from "../../lib/dialog-parser";
import { computeNextFollowupDays, isAdaptiveBroker } from "../../lib/adaptive-followup";
import { HELPER_MODEL, chatCompletionJSON } from "../../lib/ai-client.js";
import { updateLeadStatus, closeAmoTasksForLead, createAmoTask, getAmoLead, closeLeadAsLost } from "../../lib/amo-client.js";
import { classifyStage } from "../../lib/stage-classifier";
import {
  resolveSendChannel,
  deliverText,
  sendAttachmentLinks,
  LINK_PROGRESS,
} from "../../lib/outbound-send.js";
import { FOLLOWUP_STAGE_ADVANCE_RENTAL, FOLLOWUP_DELAY_DAYS_RENTAL, followupClockAfterReply } from "../../lib/rental-followup.js";
import { incrementBrokerPick } from "../../lib/broker-picks-tracker.js";
import { recordCommitment } from "../../lib/commitment-scheduler.js";

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
      .select({
        pipeline: leadsSyncTable.pipeline,
        responsibleUser: leadsSyncTable.responsibleUser,
        leadStage: leadsSyncTable.leadStage,
        content: leadsSyncTable.content,
        amoCreatedAt: leadsSyncTable.amoCreatedAt,
        profileTemperature: leadsSyncTable.profileTemperature,
      })
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

    // Adaptive cadence now applies to EVERY approval (LIVE replies included) for
    // adaptive brokers — the follow-up date must reflect the lead's temperature /
    // stage / freshness, not a flat "tomorrow". A hot lead → soon; a cold, old
    // lead → stretched to a week/two/month. Only Rental keeps its own fixed flow.
    // Reach / qualification follow-up stages (1st / 2nd / final follow up) keep
    // their OWN fixed cadence baked into the stage name (next day / +3d / +5d) —
    // the owner sets those timings deliberately. Adaptive cadence is for LIVE and
    // the active-funnel PUSH stages only. Applying it to the reach stages set a
    // fresh lead's Final Follow Up to +3d (freshness cap) instead of the fixed +5d.
    const stageLower = (pipelineRow?.leadStage ?? "").toLowerCase();
    const isReachStage =
      stageLower.includes("1st follow up") ||
      stageLower.includes("2nd follow up") ||
      stageLower.includes("final follow up");
    const useAdaptiveCadence =
      !isRentalPipeline &&
      !isReachStage &&
      isAdaptiveBroker(pipelineRow?.responsibleUser);

    if (useAdaptiveCadence) {
      // Silence streak = consecutive unanswered touches, +1 for the one we're
      // sending now (the lead hasn't replied, so this send extends the streak).
      let streak = 1;
      try {
        const parsed = parseDialogContent(pipelineRow?.content ?? "");
        streak = countTrailingOurMessages(parsed.messages) + 1;
      } catch { /* default streak 1 */ }
      const ageDays = pipelineRow?.amoCreatedAt
        ? Math.floor((approveNow.getTime() - pipelineRow.amoCreatedAt.getTime()) / 86400000)
        : null;
      const days = computeNextFollowupDays({
        streak,
        leadStage: pipelineRow?.leadStage ?? null,
        temperature: pipelineRow?.profileTemperature as "cold" | "warm" | "hot" | null,
        ageDays,
      });
      taskDate = new Date(approveNow.getTime() + days * 86400000);
      nextActionNote = `Adaptive follow-up (streak ${streak}, +${days}d) — if there is no reply, send the next touch.`;
      log.info({ leadId, streak, days, stage: pipelineRow?.leadStage, temp: pipelineRow?.profileTemperature }, "adaptive cadence: next task scheduled");
    } else if (kind === "push") {
      const level = Math.max(0, followupLevel ?? 0);
      // exact: Rental chases exactly 24h from this send, never day-snapped to
      // Bali midnight — this is the amoCRM TASK date, and amo-sync's
      // task-driven scheduler reads it back into nextFollowupAt verbatim, so a
      // day-snapped task here silently reintroduces the midnight clustering
      // even after nextFollowupAt's own computation is fixed elsewhere.
      const nextLevelDate = delayDays
        ? nextFollowupDate(approveNow, level, delayDays, isRentalPipeline)
        : nextFollowupDate(approveNow, level);

      if (nextLevelDate) {
        taskDate = nextLevelDate;
        nextActionNote = `Follow-up #${level + 1} — if there is no reply, send the next touch.`;
      } else {
        taskDate = new Date(approveNow.getTime() + 7 * 24 * 60 * 60 * 1000);
        nextActionNote = `Final follow-up #${level} sent. If there is no reply, decide what to do with this lead.`;
      }
    } else {
      taskDate = new Date(approveNow.getTime() + 24 * 60 * 60 * 1000);
      nextActionNote = "Waiting for the client to reply. If nothing comes within 24h, follow up.";
    }

    const taskText = `Sent (${kind}): "${snippet}${ellipsis}". ${nextActionNote}`;

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
          // Close lead as Lost. This account has no loss reasons configured, so
          // close on status alone (passing a phantom loss_reason_id made amoCRM
          // 500 and silently failed every final-follow-up close).
          const closed = await closeLeadAsLost(leadId);
          if (closed) {
            // Exclude from bot ONLY after the stage actually changed — otherwise
            // the lead drops out of the bot while still sitting in Final Follow Up
            // (the inconsistency that made a "closed" lead look untouched).
            await db
              .update(leadsSyncTable)
              .set({ botExcluded: true, nextFollowupAt: null })
              .where(eq(leadsSyncTable.leadId, leadId));
            log.info({ leadId }, "auto-closed as Lost: Final Follow Up, client never replied — archived");
            return;
          }
          // Close FAILED (amoCRM rejected the change). Do NOT archive — keep the
          // lead active and fall through to create a follow-up task so it comes
          // back for a retry instead of vanishing in a half-closed state.
          log.error({ leadId }, "auto-close FAILED: amoCRM did not accept Closed Lost — lead kept active for retry");
        }
      }
      // The non-final follow-up advance (1st→2nd→final) moved to the MAIN approve
      // handler so it runs SYNCHRONOUSLY in-request and reliably — from this
      // fire-and-forget path it wasn't landing (a sent 1st follow-up left the lead
      // stuck at 1st). Only the Final-Follow-Up auto-close stays here.
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

    // Keep the bot's re-surface date in step with the ADAPTIVE task. A LIVE reply
    // sets leads_sync.nextFollowupAt to a flat +24h upstream (so an answered lead is
    // never forgotten); when this send used the adaptive cadence, align that date to
    // the same taskDate so the bot doesn't pull a hot lead back into PUSH tomorrow
    // while its CRM task sits days out. Runs after the upstream write, so it wins.
    // Reach/qualification + non-adaptive keep their upstream date untouched.
    if (useAdaptiveCadence) {
      try {
        await db.update(leadsSyncTable).set({ nextFollowupAt: taskDate }).where(eq(leadsSyncTable.leadId, leadId));
      } catch { /* non-fatal */ }
    }

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
      model: HELPER_MODEL,
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
    /** Property links as the broker left them — they can remove or add listings
     * while editing, so this overrides the originally generated attachments.
     * Only trusted when attachmentsCurated is also true (see effectiveAttachments
     * below) — a client that sends [] without ever having touched links is not
     * "the broker's choice", it's an empty snapshot. */
    attachments?: Array<{ type?: string; label?: string; url?: string }>;
    /** True only once the broker has actually added/removed a link by hand. */
    attachmentsCurated?: boolean;
  };

  const explicitNewStage = typeof body?.newStage === "string" && body.newStage.trim() ? body.newStage.trim() : null;
  const skipMessage = body?.skipMessage === true;
  // Set below (only for a sent LIVE reply with real property attachments) when
  // the broker didn't already pick a stage themselves via the checkbox.
  let autoStage: { name: string; id: number } | null = null;

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

  // The broker's edited list wins ONLY when they actually curated it
  // (attachmentsCurated === true) — every current client always sends SOME
  // attachments array on every approve, curated or not, so checking
  // Array.isArray alone (the old check) took the "client wins" branch on
  // literally every send and could never fall back. A lead got a reply
  // promising "the link below" with no link because of exactly this: a stale
  // client's never-populated attachments: [] silently overrode the
  // suggestion's own correctly-generated links. Uncurated → trust what was
  // generated; curated → trust the broker's edits, empty list included.
  const clientCurated = body.attachmentsCurated === true;
  const effectiveAttachments = clientCurated && Array.isArray(body.attachments)
    ? body.attachments
        .filter((a) => a?.type === "link" && typeof a.url === "string" && a.url)
        .map((a) => ({ type: "link" as const, label: a.label ?? a.url!, url: a.url! }))
    : (sug.attachments ?? []).filter((a) => a.type === "link" && a.url);

  if (sug.status !== "pending") {
    // The status is claimed BEFORE the send, so an interruption between the two
    // leaves a suggestion marked "sent" that never actually went out — the
    // broker then gets a bare 409 on a message the client never received.
    // sent_messages is the record of a real delivery: it is written the INSTANT
    // the text leaves (see the send path below), and it carries how many links
    // followed it.
    const [alreadySent] = await db
      .select({
        id: sentMessagesTable.id,
        webhookStatus: sentMessagesTable.webhookStatus,
        webhookResponse: sentMessagesTable.webhookResponse,
      })
      .from(sentMessagesTable)
      .where(eq(sentMessagesTable.suggestionId, sug.id as any))
      .limit(1);

    // A row recording a FAILED attempt is not a delivery — it used to block the
    // retry all the same, so a Salesbot error left the broker unable to resend
    // a message the client never got.
    const status = alreadySent?.webhookStatus ?? 0;
    const delivered = !!alreadySent && status >= 200 && status < 300;

    if (delivered) {
      // The client ALREADY has this text — re-sending it is the one outcome we
      // must never produce. It happened to lead 23166131 on 2026-08-10: the
      // delivery was recorded only at the very END of the request, a restart cut
      // the request between the text and its links, so the retry saw "nothing
      // sent" and the client received the whole message a second time.
      // Resume instead: deliver only the links that never made it.
      const base = (alreadySent!.webhookResponse ?? "").replace(LINK_PROGRESS, "").trim();
      const progress = LINK_PROGRESS.exec(alreadySent!.webhookResponse ?? "");
      // No marker = a record written before this resume logic existed. Assume
      // everything went out: a missing link is a nuisance, a duplicate is not.
      const linksSent = progress ? Number(progress[1]) : effectiveAttachments.length;
      const missing = Math.max(0, effectiveAttachments.length - linksSent);

      if (missing > 0) {
        req.log.warn(
          { leadId: sug.leadId, suggestionId: sug.id, linksSent, total: effectiveAttachments.length },
          "interrupted send resumed — text already delivered, sending only the missing links",
        );
        await sendAttachmentLinks(sug.leadId, effectiveAttachments, linksSent, alreadySent!.id, base, req.log);
      }

      res.json({
        ok: true,
        resumed: true,
        hookStatus: status,
        stageOk: false,
        message: missing > 0
          ? `This message had already reached the client — only the ${missing} missing link${missing > 1 ? "s" : ""} were sent just now. Nothing was sent twice.`
          : "Already sent — the client has this message. Nothing was sent again.",
      });
      return;
    }

    req.log.warn(
      { leadId: sug.leadId, suggestionId: sug.id, status: sug.status },
      "suggestion was claimed but never sent (interrupted send) — reopening for retry",
    );
    await db
      .update(pendingSuggestionsTable)
      .set({ status: "pending", finalText: null })
      .where(eq(pendingSuggestionsTable.id, sug.id));
    sug.status = "pending";
  }

  const approveNow = new Date();
  let hookStatus = 0;
  let hookBody = "";
  let stageOk = false;
  let chatSent = false;
  // Reassigned below (send path only) to the freshly-read owner from leads_sync;
  // falls back to the suggestion's stamped owner for skip-message (stage-only)
  // requests, which never run the send path's lookup. Declared here, not with
  // `const` inside the send branch, because the stage-change block below runs
  // for BOTH paths and needs it in scope — a `const` scoped to the send branch
  // threw ReferenceError on every stage-only move and crashed the process.
  let currentResponsibleUser: string | null = sug.responsibleUser ?? null;

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
    req.log.info({ leadId: sug.leadId, newStage: explicitNewStage }, "approve skip-message: suggestion skipped, no message sent");
  } else {
    req.log.info({
      leadId: sug.leadId,
      kind: sug.kind,
      edited: body.edited ?? false,
      msgLen: body.message.length,
      msgLines: body.message.split("\n").length,
      msgPreview: body.message.slice(0, 120).replace(/\n/g, "↵"),
    }, "approve: message received");

    // ── Resolve the outbound channel BEFORE sending ───────────────────────────
    // Salesbot reads the "last messenger" field to decide which line/thread to
    // send through. With that field empty it still accepts the trigger and
    // returns 200, then delivers into the wrong conversation (or not at all) —
    // amoCRM shows the message with a red "Error" while the broker's inbox says
    // "Sent". That silent false success is worse than any delivery failure: the
    // broker moves on believing the client was answered.
    // So: no resolved channel, no send. Refuse loudly and keep the suggestion.
    // Resolved from data only — no Puppeteer. The old path scanned the lead page
    // with a headless Chrome, whose memory spike tripped PM2's 512MB ceiling and
    // restarted the process mid-request, so the broker got a bare "Webhook 502"
    // and no message went out.
    // sug.responsibleUser is stamped at suggestion-creation time and goes stale
    // the moment the lead is reassigned in amoCRM afterward (a broker handover)
    // — sending on the STALE owner's line here would defeat the very purpose of
    // resolveOutboundSource's own reassignment-guard, which trusts whatever
    // responsibleUser it's given. leads_sync is kept current by every sync pass.
    const [currentOwnerRow] = await db
      .select({ responsibleUser: leadsSyncTable.responsibleUser })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, sug.leadId))
      .limit(1);
    currentResponsibleUser = currentOwnerRow?.responsibleUser ?? sug.responsibleUser;

    // ── May we send at all, and on whose line? ───────────────────────────────
    // Both refusals hand the suggestion back to the broker: it was claimed
    // above, so it must be released or it would sit "approved" while nothing
    // was delivered. See lib/outbound-send.ts for why each guard exists.
    const channel = await resolveSendChannel(sug.leadId, currentResponsibleUser, req.log);
    if (!channel.ok) {
      await db
        .update(pendingSuggestionsTable)
        .set({ status: "pending", finalText: null })
        .where(eq(pendingSuggestionsTable.id, sug.id));
      req.log.error({ leadId: sug.leadId, error: channel.error }, "approve aborted — refusing to send blind");
      res.status(409).json({ ok: false, error: channel.error, message: channel.message });
      return;
    }
    const messengerSource = channel.source;

    // ── Update leads_sync BEFORE sending message ────────────────────────────
    const [prevSyncRow] = await db
      .select({
        lastMessageFrom: leadsSyncTable.lastMessageFrom,
        leadStage: leadsSyncTable.leadStage,
        pipeline: leadsSyncTable.pipeline,
      })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, sug.leadId))
      .limit(1);
    const prevLastMessageFrom = prevSyncRow?.lastMessageFrom ?? null;

    if (sug.kind === "push") {
      const sentLevel = sug.followupLevel ?? 1;
      const level = Math.max(0, sentLevel);
      // Rental: its own 1-day spacing, counted exactly from this send, so a
      // day's follow-ups no longer all land on the same minute.
      const isRentalSend = (prevSyncRow?.pipeline ?? "").trim().toLowerCase() === "rental";
      const precomputedNextAt =
        nextFollowupDate(
          approveNow,
          level,
          isRentalSend ? FOLLOWUP_DELAY_DAYS_RENTAL : undefined,
          isRentalSend,
        ) ?? new Date(approveNow.getTime() + 7 * 24 * 60 * 60 * 1000);
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
      // A LIVE reply also starts the clock. This branch used to set only
      // "we answered" and leave nextFollowupAt untouched — so answering a lead
      // through the bot scheduled NOTHING. The 24h promise existed only in the
      // amoCRM task text, and once that task was auto-closed the lead could go
      // quiet forever: Josua (22938199) sat three days after our reply with no
      // reminder, and every LIVE-answered lead had the same hole.
      // followupLevel resets to 0 because the lead engaged — the next chase is #1.
      const stageBlocksFollowup = shouldSuppressPush(prevSyncRow?.leadStage ?? "");
      const liveClock = followupClockAfterReply(approveNow, prevSyncRow?.pipeline ?? null);
      await db
        .update(leadsSyncTable)
        .set({
          lastMessageFrom: "us",
          lastOurMessageAt: approveNow,
          followupLevel: 0,
          nextFollowupAt: stageBlocksFollowup ? null : liveClock,
          updatedAt: approveNow,
        })
        .where(eq(leadsSyncTable.leadId, sug.leadId));
    }

    // ── Send via Salesbot ─────────────────────────────────────────────────────
    const delivery = await deliverText(sug.leadId, body.message, req.log);
    const deliveryText = delivery.deliveryText;
    hookStatus = delivery.hookStatus;
    hookBody = delivery.hookBody;
    chatSent = delivery.chatSent;

    // ── The lead no longer exists in amoCRM ───────────────────────────────────
    // Deleted, or merged into another lead (a merge deletes the source). There
    // is nothing to send to and nothing for the broker to open by hand either,
    // so retrying can only fail again — Amelia hit exactly this on lead
    // 23195549 (2026-08-12) and got "amoCRM refused the send" plus advice to
    // send it manually from a card that does not exist. Drop the ghost the same
    // way amo-sync's own cleanup drops an untracked lead, and say what happened.
    if (delivery.leadMissing) {
      req.log.warn({ leadId: sug.leadId }, "approve aborted — lead no longer exists in amoCRM, removing it and its drafts");
      await db.delete(pendingSuggestionsTable).where(eq(pendingSuggestionsTable.leadId, sug.leadId)).catch(() => {});
      await db.delete(leadsSyncTable).where(eq(leadsSyncTable.leadId, sug.leadId)).catch(() => {});
      res.status(409).json({
        ok: false,
        error: "lead_deleted",
        message:
          "This lead no longer exists in amoCRM — it was deleted or merged into another lead. Nothing was sent, and the card has been removed from your inbox. If the client is real, find the lead they were merged into and reply there.",
      });
      return;
    }

    // The broker promised the CLIENT something ("I'll check with the owner and
    // get back to you"). The lead may stay silent — correctly — while the ball
    // is with US, so the follow-up-on-silence clock never covers this case and
    // the promise lived only in the broker's head. A CRM task in a few hours
    // makes the promise impossible to forget.
    if (chatSent) {
      const OWNER_PROMISE =
        /(check|confirm|double.?check|ask|уточн|провер|спрошу|узнаю|запрошу)[^.!?\n]{0,50}(owner|собственник|владел)|(owner|собственник|владел)[^.!?\n]{0,40}(get back|come back|confirm|вернусь|отвечу)|вернусь (к вам|к тебе|с ответом)|get back to you (with|once|after)/i;
      if (OWNER_PROMISE.test(body.message)) {
        const due = new Date(Date.now() + 4 * 60 * 60 * 1000);
        void createAmoTask(
          sug.leadId,
          "Promised the client an answer from the owner — find out and write back (the client may stay quiet, the ball is with us)",
          due,
        ).catch((err) => req.log.warn({ err }, "owner-promise task failed (non-fatal)"));
        req.log.info({ leadId: sug.leadId }, "owner promise detected — broker task set for +4h");
      }
    }

    req.log.info({ leadId: sug.leadId, messengerSource, hookStatus, chatSent, hookBody }, "Salesbot response");

    // ── Record the delivery BEFORE the links go out ───────────────────────────
    // This row is the only proof the client already has the text, and the retry
    // guard at the top of this handler reads it. It used to be written at the
    // very END of the request — after ~5s of deliberate pacing plus several
    // amoCRM round-trips — so a restart in that window left no trace of a
    // message the client had already received, and the broker's retry delivered
    // the whole thing a second time (lead 23166131, 2026-08-10).
    // Note: suggestion status was already set atomically above (claimed update).
    const [deliveryRow] = await db
      .insert(sentMessagesTable)
      .values({
        leadId: sug.leadId,
        suggestionId: sug.id as any,
        kind: sug.kind,
        messageText: deliveryText,
        responsibleUser: currentResponsibleUser,
        webhookStatus: hookStatus,
        webhookResponse: chatSent && effectiveAttachments.length > 0
          ? `${hookBody} | links 0/${effectiveAttachments.length}`
          : hookBody,
      })
      .returning({ id: sentMessagesTable.id });

    if (chatSent && effectiveAttachments.length > 0) {
      await sendAttachmentLinks(
        sug.leadId,
        effectiveAttachments,
        0,
        deliveryRow?.id ?? null,
        hookBody,
        req.log,
      );
    }

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
        explicitNewStage ?? currentResponsibleUser ?? "",
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

    // ── Detect "I'll check and get back to you" promises — the client is
    // waiting on US here, so the normal wait-for-reply clock never fires.
    recordCommitment(sug.leadId, currentResponsibleUser, body.message).catch(() => {});

    // ── Track property picks — personalizes future matching for this broker ──
    if (currentResponsibleUser && effectiveAttachments.length > 0) {
      for (const att of effectiveAttachments) {
        const match = att.url?.match(/\/property\/([A-Za-z0-9-]+)/i);
        if (!match) continue;
        const propertyId = match[1];
        const listingType = /^R-/i.test(propertyId) ? "rent" : "sale";
        incrementBrokerPick(currentResponsibleUser, propertyId, listingType).catch(() => {});
      }
    }

    // ── Auto-apply the stage derived from the conversation ────────────────────
    // The stage is just a reflection of where the conversation stands, and the
    // bot holds that conversation — so it classifies the stage when generating
    // the reply (see lib/stage-classifier.ts) and it gets applied here on send.
    // Two guards: a stage the broker picked themselves always wins, and a
    // terminal stage (Closed won/lost) is never applied automatically — those
    // carry money and reporting weight, so the broker confirms them explicitly.
    // Third guard: a lead in a REACH / qualification follow-up stage (1st / 2nd /
    // final follow up) that never got a reply must ONLY move along the
    // qualification ladder (1st→2nd→final, advanced below) — the conversation
    // classifier must NOT pull it into a funnel stage like "Contact established"
    // off our own outbound follow-up. If the client actually replies, that's a
    // LIVE turn and the broker moves the stage themselves.
    const curStageLower = (prevSyncRow?.leadStage ?? "").toLowerCase();
    const inReachStage =
      curStageLower.includes("1st follow up") ||
      curStageLower.includes("2nd follow up") ||
      curStageLower.includes("final follow up");
    if (!explicitNewStage && !inReachStage && sug.suggestedStage && sug.suggestedStageId) {
      if (sug.suggestedStageTerminal) {
        req.log.info(
          { leadId: sug.leadId, stage: sug.suggestedStage },
          "stage suggestion is terminal — left for broker confirmation",
        );
      } else {
        autoStage = { name: sug.suggestedStage, id: Number(sug.suggestedStageId) };
        req.log.info(
          { leadId: sug.leadId, toStage: sug.suggestedStage, reason: sug.suggestedStageReason },
          "auto stage: applied from conversation classification",
        );
      }
    } else if (!explicitNewStage && !sug.suggestedStage) {
      // Not every draft arrives pre-classified: the unanswered-lead pass and the
      // autopilot insert rows directly, so their sends carried no stage and the
      // card silently stayed put ("я лиду ответил, но этап не поменялся" —
      // options delivered, lead still in New LEAD). The send moment is the one
      // place every path goes through, so the missing classification happens
      // HERE, whatever produced the draft.
      try {
        const [ctx] = await db
          .select({
            pipeline: leadsSyncTable.pipeline,
            leadStage: leadsSyncTable.leadStage,
            content: leadsSyncTable.content,
          })
          .from(leadsSyncTable)
          .where(eq(leadsSyncTable.leadId, sug.leadId))
          .limit(1);
        if (ctx) {
          const cls = await classifyStage({
            pipeline: ctx.pipeline,
            currentStage: ctx.leadStage,
            conversationText: ctx.content ?? "",
            replyText: body.message ?? sug.suggestionText ?? "",
            attachmentsCount: (body.attachments ?? sug.attachments ?? []).length,
          });
          // Same reach/qualification guard as the draft-classifier path above: a
          // lead on the 1st/2nd/final-follow-up ladder must NOT be pulled into a
          // funnel stage off our own outbound. Only the follow-up advance moves it.
          const ctxStageLower = (ctx.leadStage ?? "").toLowerCase();
          const ctxInReach =
            ctxStageLower.includes("1st follow up") ||
            ctxStageLower.includes("2nd follow up") ||
            ctxStageLower.includes("final follow up");
          if (cls && !cls.terminal && !ctxInReach) {
            autoStage = { name: cls.stage.name, id: cls.stage.id };
            req.log.info(
              { leadId: sug.leadId, toStage: cls.stage.name, reason: cls.reason },
              "auto stage: classified at send time (draft carried none)",
            );
          }
        }
      } catch (err) {
        req.log.warn({ err, leadId: sug.leadId }, "send-time stage classification failed (non-fatal)");
      }
    }
  }

  // ── Stage change (applies for both normal approve and skip-message) ─────────
  // The classifier's stage is applied automatically on send — a stage the broker
  // picked themselves (explicitNewStage) always wins over it. This was disabled
  // for a few days (fcb6816, 2026-08-02) after the classifier moved leads on
  // outbound promises rather than real progress (e.g. → "Options Sent" before
  // options actually went out). Re-enabled 2026-08-06 per the owner — the guards
  // that were meant to prevent exactly that stayed in place the whole time:
  // suggestedStageTerminal is never auto-applied (line ~699), and a lead on the
  // 1st/2nd/final follow-up ladder is never pulled into a funnel stage off our
  // own outbound (inReachStage, both the draft-time and send-time classifier
  // paths above). If a false "Options sent" jump shows up again, the fix is in
  // the classifier's judgement (lib/stage-classifier.ts) or its guards here —
  // not disabling auto-apply again, which just leaves leads stuck in New LEAD.
  const effectiveNewStage = explicitNewStage ?? (autoStage ? autoStage.name : null);
  if (effectiveNewStage) {
    const prevSync = await db
      .select({ leadStage: leadsSyncTable.leadStage })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, sug.leadId))
      .limit(1);

    const prevStage = prevSync[0]?.leadStage ?? null;

    const stageId =
      (typeof body.stageId === "string" && body.stageId.trim() ? body.stageId.trim() : null) ??
      (autoStage ? String(autoStage.id) : null);

    // On a SEND this block runs seconds after the send path set nextFollowupAt —
    // and it used to null it unconditionally, erasing the clock the same request
    // had just started. While auto-stage was off that was rare; once the
    // classifier began applying "Options sent" on nearly every send (re-enabled
    // 2026-08-06), nearly every answered lead lost its follow-up and went silent
    // forever (13 found on 2026-08-13, some hanging since the 7th). Keep the
    // clock on sends; clear it only when the message path never set one — a
    // stage-only move (skipMessage) — or when the new stage is a dead one where
    // chasing must stop.
    const clearClock = skipMessage || shouldSuppressPush(effectiveNewStage);
    await db
      .update(leadsSyncTable)
      .set({
        leadStage: effectiveNewStage,
        leadStageId: stageId ?? undefined,
        ...(clearClock ? { nextFollowupAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(leadsSyncTable.leadId, sug.leadId));

    if (effectiveNewStage !== prevStage) {
      await db.insert(stageEventsTable).values({
        leadId: sug.leadId,
        fromStage: prevStage,
        toStage: effectiveNewStage,
        responsibleUser: currentResponsibleUser,
      }).catch(() => {});
    }

    // Update stage directly in amoCRM via API (stageId is the numeric status_id).
    // Closed - lost needs the dedicated close path: a plain status set is rejected
    // on this account (no loss reasons configured) and the broker's "Send + Move"
    // then left the lead un-moved. closeLeadAsLost uses system status 143 and is
    // the same proven path the auto-close uses — so it works regardless of the
    // stageId the extension sent (or if it sent none).
    const stageNameLower = effectiveNewStage.toLowerCase();
    const isClosedLost = stageNameLower.includes("closed") && stageNameLower.includes("lost");
    try {
      if (isClosedLost) {
        stageOk = await closeLeadAsLost(sug.leadId);
        req.log.info({ leadId: sug.leadId, newStage: effectiveNewStage, stageOk }, "closed-lost applied via closeLeadAsLost");
      } else if (stageId) {
        stageOk = await updateLeadStatus(sug.leadId, Number(stageId));
        req.log.info({ leadId: sug.leadId, newStage: effectiveNewStage, stageId, stageOk }, "stage updated in amoCRM via API");
      } else {
        req.log.warn({ leadId: sug.leadId, newStage: effectiveNewStage }, "no stageId provided — skipping amoCRM stage update");
      }
    } catch (e) {
      req.log.error({ err: e }, "stage-change API error");
    }
  } else if (!skipMessage && sug.kind === "push" && (sug.followupLevel ?? 0) !== FINAL_FOLLOWUP_LEVEL) {
    // Reach/qualification follow-up advance (1st → 2nd → final), SYNCHRONOUS and
    // reliable — the old fire-and-forget path left a sent 1st follow-up stuck at
    // 1st. Runs only when no explicit or classifier stage was applied above.
    // Status IDs are unique per pipeline, so both maps can be checked without a
    // pipeline lookup.
    try {
      const amoLead = await getAmoLead(sug.leadId);
      const curStatus = amoLead?.status_id;
      const nextStatus = curStatus ? (FOLLOWUP_STAGE_ADVANCE[curStatus] ?? FOLLOWUP_STAGE_ADVANCE_RENTAL[curStatus]) : undefined;
      if (nextStatus) {
        stageOk = await updateLeadStatus(sug.leadId, Number(nextStatus));
        req.log.info({ leadId: sug.leadId, from: curStatus, to: nextStatus, stageOk }, "follow-up stage advanced (sync)");
      }
    } catch (e) {
      req.log.error({ err: e, leadId: sug.leadId }, "sync follow-up advance error");
    }
  }

  res.json({ ok: skipMessage ? true : hookStatus >= 200 && hookStatus < 300, hookStatus, stageOk });
});

export default router;
