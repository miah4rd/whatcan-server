import { Router } from "express";
import { shouldSuppressPush } from "../../lib/stage-routing";
import { db, pendingSuggestionsTable, sentMessagesTable, leadsSyncTable, stageEventsTable, brokerCorrectionsTable, leadCrmTasksTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { nextFollowupDate, parseDialogContent, countTrailingOurMessages } from "../../lib/dialog-parser";
import { computeNextFollowupDays, isAdaptiveBroker } from "../../lib/adaptive-followup";
import { HELPER_MODEL, chatCompletionJSON } from "../../lib/ai-client.js";
import { updateLeadStatus, closeAmoTasksForLead, createAmoTask, getAmoLead, closeLeadAsLost, countActiveWhatsappChats } from "../../lib/amo-client.js";
import { stripEmojiForDelivery } from "../../lib/message-delivery.js";
import { classifyStage } from "../../lib/stage-classifier";
import { updateLeadCustomField, triggerSalesbot } from "../../lib/amo-chat-client";
import { resolveOutboundSource } from "../../lib/amo-messenger-field";
import { FOLLOWUP_STAGE_ADVANCE_RENTAL, FOLLOWUP_DELAY_DAYS_RENTAL, followupClockAfterReply } from "../../lib/rental-followup.js";
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
      nextActionNote = `Adaptive follow-up (серия ${streak}, +${days}д) — если нет ответа, следующий touch.`;
      log.info({ leadId, streak, days, stage: pipelineRow?.leadStage, temp: pipelineRow?.profileTemperature }, "adaptive cadence: next task scheduled");
    } else if (kind === "push") {
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
     * while editing, so this overrides the originally generated attachments. */
    attachments?: Array<{ type?: string; label?: string; url?: string }>;
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
  if (sug.status !== "pending") {
    // The status is claimed BEFORE the send, so a crash between the two leaves a
    // suggestion permanently marked "sent" that never actually went out — the
    // broker then gets a bare 409 on a message the client never received.
    // sent_messages is the record of an actual delivery attempt: no row means
    // nothing left the building, so let the broker retry instead of blocking.
    const [alreadySent] = await db
      .select({ id: sentMessagesTable.id })
      .from(sentMessagesTable)
      .where(eq(sentMessagesTable.suggestionId, sug.id as any))
      .limit(1);

    if (alreadySent) {
      res.status(409).json({ error: "Already processed" });
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

  // The broker's edited list wins when the client sent one; older clients that
  // don't send the field fall back to what was generated.
  const effectiveAttachments = Array.isArray(body.attachments)
    ? body.attachments
        .filter((a) => a?.type === "link" && typeof a.url === "string" && a.url)
        .map((a) => ({ type: "link" as const, label: a.label ?? a.url!, url: a.url! }))
    : (sug.attachments ?? []).filter((a) => a.type === "link" && a.url);

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
    const messengerSource = await resolveOutboundSource(sug.leadId, sug.responsibleUser).catch((e) => {
      req.log.warn({ leadId: sug.leadId, err: e }, "resolveOutboundSource threw");
      return null;
    });

    const botId = COMPANION_ROBERT_BOT_ID;

    if (!messengerSource) {
      // Hand the suggestion back to the broker — it was claimed above, so
      // release it or it would sit "approved" while nothing was delivered.
      await db
        .update(pendingSuggestionsTable)
        .set({ status: "pending", finalText: null })
        .where(eq(pendingSuggestionsTable.id, sug.id));

      req.log.error(
        { leadId: sug.leadId },
        "approve aborted — outbound channel unresolved, refusing to send blind",
      );
      res.status(409).json({
        ok: false,
        error: "channel_unresolved",
        message:
          "Could not resolve the sending channel for this lead — the message was NOT sent. Send it manually from amoCRM (the draft stays in your inbox).",
      });
      return;
    }

    // ── Duplicate-thread guard ────────────────────────────────────────────────
    // If a lead has two active WhatsApp chat threads (WAhelp registered the same
    // number twice — e.g. "+61…" and "61…"), a single Salesbot send fans out to
    // BOTH and the client gets the message twice. We can't pick one thread from
    // here (addressing is line-level, not chat-level), so the safe move is to
    // NOT send blind: release the suggestion and tell the broker to send this
    // one manually into the main thread. Normal single-thread leads (the vast
    // majority) are unaffected. Skip the check when the broker is only moving the
    // stage (skipMessage) — nothing is being sent.
    if (!skipMessage) {
      const activeChats = await countActiveWhatsappChats(sug.leadId);
      if (activeChats >= 2) {
        await db
          .update(pendingSuggestionsTable)
          .set({ status: "pending", finalText: null })
          .where(eq(pendingSuggestionsTable.id, sug.id));
        req.log.warn(
          { leadId: sug.leadId, activeChats },
          "approve aborted — lead has multiple active WhatsApp threads, refusing to avoid duplicate delivery",
        );
        res.status(409).json({
          ok: false,
          error: "multiple_chat_threads",
          message:
            "This lead has 2 active WhatsApp threads on the same number — auto-sending would deliver the message twice. It was NOT sent. Send it manually from amoCRM into the main thread (the draft stays in your inbox). Cause: a duplicate thread in WAhelp, fixed on the integration side.",
        });
        return;
      }
    }

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

    // ── Send via Salesbot (replaces F5 hook) ──────────────────────────────────
    // 1. Write message to custom field "companion massage"
    // 2. Trigger Salesbot "Companion Robert" which reads the field and sends via WhatsApp
    // Strip emoji first: the Salesbot/WAhelp delivery truncates the message at the
    // first emoji (astral-plane char), so the client was getting only the greeting.
    const deliveryText = stripEmojiForDelivery(body.message);
    try {
      const fieldOk = await updateLeadCustomField(sug.leadId, COMPANION_FIELD_ID, deliveryText);
      if (fieldOk) {
        const botTriggered = await triggerSalesbot(sug.leadId, botId);
        chatSent = botTriggered;
        hookStatus = botTriggered ? 200 : 500;
        hookBody = botTriggered ? `Salesbot ${botId} triggered` : "Salesbot trigger failed";

        // The broker promised the CLIENT something ("I'll check with the owner
        // and get back to you"). The lead may stay silent — correctly — while
        // the ball is with US, so the follow-up-on-silence clock never covers
        // this case and the promise lived only in the broker's head. A CRM task
        // in a few hours makes the promise impossible to forget.
        if (botTriggered) {
          const OWNER_PROMISE =
            /(check|confirm|double.?check|ask|уточн|провер|спрошу|узнаю|запрошу)[^.!?\n]{0,50}(owner|собственник|владел)|(owner|собственник|владел)[^.!?\n]{0,40}(get back|come back|confirm|вернусь|отвечу)|вернусь (к вам|к тебе|с ответом)|get back to you (with|once|after)/i;
          if (OWNER_PROMISE.test(body.message)) {
            const due = new Date(Date.now() + 4 * 60 * 60 * 1000);
            void createAmoTask(
              sug.leadId,
              "Обещали клиенту вернуться с ответом собственника — узнать и написать (клиент может молчать, мяч у нас)",
              due,
            ).catch((err) => req.log.warn({ err }, "owner-promise task failed (non-fatal)"));
            req.log.info({ leadId: sug.leadId }, "owner promise detected — broker task set for +4h");
          }
        }
      } else {
        hookStatus = 500;
        hookBody = "Custom field update failed";
      }
    } catch (e) {
      req.log.error({ err: e }, "Salesbot send error");
      hookStatus = 500;
      hookBody = String(e).slice(0, 1000);
    }
    req.log.info({ leadId: sug.leadId, messengerSource, hookStatus, chatSent, hookBody }, "Salesbot response");

    // Send each property link as its OWN follow-up WhatsApp message — glued
    // into one message, WhatsApp only unfurls a rich preview banner for the
    // first link, so listings need their own message each to all get one.
    if (chatSent && effectiveAttachments.length > 0) {
      for (const att of effectiveAttachments) {
        await new Promise((r) => setTimeout(r, 1200));
        try {
          const linkFieldOk = await updateLeadCustomField(sug.leadId, COMPANION_FIELD_ID, att.url as string);
          if (linkFieldOk) await triggerSalesbot(sug.leadId, botId);
        } catch (e) {
          req.log.warn({ leadId: sug.leadId, url: att.url, err: e }, "attachment send failed (non-fatal)");
        }
      }
    }

    // Note: suggestion status already set atomically above (claimed update).

    await db.insert(sentMessagesTable).values({
      leadId: sug.leadId,
      suggestionId: sug.id as any,
      kind: sug.kind,
      messageText: deliveryText,
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
        explicitNewStage ?? sug.responsibleUser ?? "",
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
    if (sug.responsibleUser && effectiveAttachments.length > 0) {
      for (const att of effectiveAttachments) {
        const match = att.url.match(/\/property\/([A-Za-z0-9-]+)/i);
        if (!match) continue;
        const propertyId = match[1];
        const listingType = /^R-/i.test(propertyId) ? "rent" : "sale";
        incrementBrokerPick(sug.responsibleUser, propertyId, listingType).catch(() => {});
      }
    }

    // ── Auto-apply the stage derived from the conversation ────────────────────
    // The stage is just a reflection of where the conversation stands, and the
    // bot holds that conversation — so it classifies the stage when generating
    // the reply (see lib/stage-classifier.ts) and it gets applied here on send.
    // Two guards: a stage the broker picked themselves always wins, and a
    // terminal stage (Closed won/lost) is never applied automatically — those
    // carry money and reporting weight, so the broker confirms them explicitly.
    if (!explicitNewStage && sug.suggestedStage && sug.suggestedStageId) {
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
          if (cls && !cls.terminal) {
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
  const effectiveNewStage = explicitNewStage ?? autoStage?.name ?? null;
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

    await db
      .update(leadsSyncTable)
      .set({ leadStage: effectiveNewStage, leadStageId: stageId ?? undefined, nextFollowupAt: null, updatedAt: new Date() })
      .where(eq(leadsSyncTable.leadId, sug.leadId));

    if (effectiveNewStage !== prevStage) {
      await db.insert(stageEventsTable).values({
        leadId: sug.leadId,
        fromStage: prevStage,
        toStage: effectiveNewStage,
        responsibleUser: sug.responsibleUser,
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
