import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable, leadCrmTasksTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { computeNextFollowupDays } from "../../lib/adaptive-followup";
import { parseDialogContent, countTrailingOurMessages } from "../../lib/dialog-parser";
import { createAmoTask, getAmoLead } from "../../lib/amo-client.js";

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
 */
router.post("/no-reply-needed", async (req, res) => {
  const { leadId } = req.body as { leadId?: string; brokerId?: string };
  if (!leadId) return void res.status(400).json({ error: "leadId required" });

  try {
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
    const taskDate = new Date(Date.now() + days * 86400000);

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
        .set({ lastMessageFrom: "us", nextFollowupAt: taskDate })
        .where(eq(leadsSyncTable.leadId, leadId)),
    ]);

    // 3. Create a real amoCRM follow-up task on that date so it persists and the
    //    scheduler surfaces it in PUSH when due (the whole system is task-driven).
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
    res.json({ ok: true, nextFollowupAt: taskDate, days });
  } catch (err) {
    req.log.error({ err, leadId }, "no-reply-needed error");
    res.status(500).json({ error: "internal error" });
  }
});

export default router;
