import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable, leadCrmTasksTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { computeNextFollowupDays } from "../../lib/adaptive-followup";
import { parseDialogContent, countTrailingOurMessages } from "../../lib/dialog-parser";
import { createAmoTask, getAmoLead, closeAmoTasksForLead } from "../../lib/amo-client.js";

const router = Router();

router.options("/no-reply-needed", (_req, res) => res.sendStatus(204));

/**
 * POST /no-reply-needed  { leadId, brokerId? }
 *
 * The lead spoke last but their message was a closer ("bye", "thanks", 👍) that
 * needs no reply. The broker dismisses it from LIVE — but NOT from the bot: the
 * conversation has lulled, so we schedule an adaptive follow-up and the lead
 * re-surfaces in PUSH when it's due.
 *
 * Difference from /broker-replied (which is "I already answered → drop it, no
 * follow-up"): this one keeps the lead alive with a next touch scheduled.
 *
 * EXCEPT when the conversation is already over. "Thanks, we found our place"
 * is also a closer needing no reply, and scheduling a chase for it is not a
 * lulled conversation being kept warm — it is us pestering someone who has
 * told us they are done. The stage classifier had already read Kimberly
 * Muylaert's "Thank you but we found our place!" and marked the draft
 * `Closed - lost` / terminal, twice; this endpoint ignored that and booked a
 * follow-up for two days later, so Amelia's trash tap produced a fresh amoCRM
 * task on a dead lead (23291381, 2026-08-26) and read as the button not
 * working. The verdict was sitting on the very suggestion being dismissed.
 *
 * A terminal lead is dismissed and left alone: tasks closed, no clock, no new
 * task. It is NOT closed automatically — that stays the broker's tap, the same
 * rule the classifier follows everywhere else.
 */
router.post("/no-reply-needed", async (req, res) => {
  const { leadId } = req.body as { leadId?: string; brokerId?: string };
  if (!leadId) return void res.status(400).json({ error: "leadId required" });

  try {
    // Read the verdict BEFORE the pending row is marked skipped below.
    const [pending] = await db
      .select({
        suggestedStage: pendingSuggestionsTable.suggestedStage,
        terminal: pendingSuggestionsTable.suggestedStageTerminal,
      })
      .from(pendingSuggestionsTable)
      .where(and(eq(pendingSuggestionsTable.leadId, leadId), eq(pendingSuggestionsTable.status, "pending")))
      .orderBy(desc(pendingSuggestionsTable.createdAt))
      .limit(1);
    const conversationIsOver = pending?.terminal === true;

    const [lead] = await db
      .select({
        leadStage: leadsSyncTable.leadStage,
        content: leadsSyncTable.content,
        profileTemperature: leadsSyncTable.profileTemperature,
        amoCreatedAt: leadsSyncTable.amoCreatedAt,
      })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, leadId))
      .limit(1);

    // Adaptive next-touch date (cost-of-delay cadence). Fresh/hot → sooner,
    // cold+old → later — same logic the ranking and reschedule chip use.
    const parsed = lead?.content ? parseDialogContent(lead.content) : null;
    const streak = parsed ? countTrailingOurMessages(parsed.messages) : 0;
    const ageDays = lead?.amoCreatedAt
      ? Math.floor((Date.now() - lead.amoCreatedAt.getTime()) / 86400000)
      : null;
    const days = computeNextFollowupDays({
      streak,
      leadStage: lead?.leadStage,
      temperature: (lead?.profileTemperature as "cold" | "warm" | "hot" | null) ?? undefined,
      ageDays,
    });
    const taskDate = conversationIsOver ? null : new Date(Date.now() + days * 86400000);

    // 1. Drop the pending LIVE (and any pending push) so it leaves the inbox now.
    // 2. Mark us as last sender so the poll / unanswered-live pass don't re-raise
    //    it, and point nextFollowupAt at the scheduled touch.
    await Promise.all([
      db
        .update(pendingSuggestionsTable)
        .set({ status: "skipped" })
        .where(and(eq(pendingSuggestionsTable.leadId, leadId), eq(pendingSuggestionsTable.status, "pending"))),
      db
        .update(leadsSyncTable)
        .set({ lastMessageFrom: "us", nextFollowupAt: taskDate, liveDismissedAt: new Date() })
        .where(eq(leadsSyncTable.leadId, leadId)),
    ]);

    // 3. Close any open tasks FIRST (DB + amoCRM), then create exactly ONE
    //    follow-up. Without this, each call added another task — the broker saw
    //    several "no reply needed" tasks pile up, and they clobbered the task they
    //    had rescheduled by hand. Close-then-create makes it idempotent: one call =
    //    one task, and a later manual reschedule cleanly replaces this one.
    await db
      .update(leadCrmTasksTable)
      .set({ status: "closed", closedAt: new Date() })
      .where(and(eq(leadCrmTasksTable.leadId, leadId), eq(leadCrmTasksTable.status, "open")));
    await closeAmoTasksForLead(leadId).catch((e) => {
      req.log.warn({ err: e, leadId }, "no-reply-needed: closing existing amo tasks failed (non-fatal)");
    });

    if (!taskDate) {
      req.log.info(
        { leadId, suggestedStage: pending?.suggestedStage },
        "no-reply-needed: conversation is over — dismissed with no follow-up, lead left for the broker to close",
      );
      res.json({ ok: true, nextFollowupAt: null, terminal: true, suggestedStage: pending?.suggestedStage ?? null });
      return;
    }

    let amoOk = false;
    try {
      const amoLead = await getAmoLead(leadId);
      amoOk = await createAmoTask(leadId, "Follow up — lead's last message needed no reply", taskDate, amoLead?.responsible_user_id ?? undefined);
    } catch (e) {
      req.log.error({ err: e, leadId }, "no-reply-needed: amoCRM task create failed (non-fatal)");
    }
    await db.insert(leadCrmTasksTable).values({
      leadId,
      taskDate,
      taskText: "Follow up — lead's last message needed no reply",
      webhookStatus: amoOk ? 200 : 500,
      webhookResponse: amoOk ? "created via API (no-reply-needed)" : "amo task create failed",
    });

    req.log.info({ leadId, days, taskDate, amoOk }, "no-reply-needed: dismissed from LIVE, follow-up scheduled");
    res.json({ ok: true, nextFollowupAt: taskDate, days, terminal: false });
  } catch (err) {
    req.log.error({ err, leadId }, "no-reply-needed error");
    res.status(500).json({ error: "internal error" });
  }
});

export default router;
