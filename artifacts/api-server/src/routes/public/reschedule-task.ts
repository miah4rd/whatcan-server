import { Router } from "express";
import { db, leadCrmTasksTable, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { closeAmoTasksForLead, createAmoTask, getAmoLead } from "../../lib/amo-client.js";

const router = Router();

router.options("/reschedule-task", (_req, res) => res.sendStatus(204));

/**
 * POST /reschedule-task  { leadId, taskDate, taskText? }
 *
 * The broker reschedules the follow-up task straight from the bot — independent
 * of skip/approve. Closes whatever open task the lead has in amoCRM and creates
 * the next one on the chosen date (the bot "closes this task and sets the next").
 *
 * When the new date is in the future the lead's pending PUSH is retired (status
 * "skipped") so it leaves today's list; the scheduler will generate a fresh,
 * timing-aware draft when the new date comes due — better than surfacing today's
 * stale draft weeks later.
 */
router.post("/reschedule-task", async (req, res) => {
  const { leadId, taskDate, taskText } = req.body as {
    leadId?: string;
    taskDate?: string;
    taskText?: string;
  };

  if (!leadId || !taskDate) {
    return void res.status(400).json({ error: "leadId and taskDate are required" });
  }
  const parsedDate = new Date(taskDate);
  if (isNaN(parsedDate.getTime())) {
    return void res.status(400).json({ error: "Invalid taskDate" });
  }

  const text = (taskText && taskText.trim()) || "Follow up with lead";

  let closedCount = 0;
  let amoOk = false;
  let amoError = "";
  try {
    // 1. Close any open task(s) currently on the lead.
    closedCount = await closeAmoTasksForLead(leadId);
    // 2. Create the next task on the chosen date, assigned to the lead's owner.
    const lead = await getAmoLead(leadId);
    const responsibleUserId = lead?.responsible_user_id ?? undefined;
    amoOk = await createAmoTask(leadId, text, parsedDate, responsibleUserId);
  } catch (e) {
    req.log.error({ err: e, leadId }, "reschedule-task amoCRM API error");
    amoError = String(e).slice(0, 500);
  }

  // 3. Mirror in our DB: log the task and snooze the push to the new date.
  await db.insert(leadCrmTasksTable).values({
    leadId,
    taskDate: parsedDate,
    taskText: text,
    webhookStatus: amoOk ? 200 : 500,
    webhookResponse: amoOk ? "rescheduled via API" : amoError,
  });
  await db
    .update(leadsSyncTable)
    .set({ nextFollowupAt: parsedDate })
    .where(eq(leadsSyncTable.leadId, leadId));

  // 4. If deferred to the future, retire today's pending draft — push OR live —
  //    so it leaves the list now and regenerates fresh when the new date is due.
  //    A live-kind draft was left out of this once: a broker rescheduling a LIVE
  //    lead's follow-up saw it stay pinned in LIVE for good, since only "push"
  //    was ever cleared here.
  const BALI_OFFSET_MS = 8 * 60 * 60 * 1000;
  const nowBali = new Date(Date.now() + BALI_OFFSET_MS);
  const endOfTodayBali = new Date(
    Date.UTC(nowBali.getUTCFullYear(), nowBali.getUTCMonth(), nowBali.getUTCDate() + 1) - BALI_OFFSET_MS,
  );
  let retiredPush = 0;
  if (parsedDate > endOfTodayBali) {
    const result = await db
      .update(pendingSuggestionsTable)
      .set({ status: "skipped" })
      .where(
        and(
          eq(pendingSuggestionsTable.leadId, leadId),
          eq(pendingSuggestionsTable.status, "pending"),
          inArray(pendingSuggestionsTable.kind, ["push", "live"]),
        ),
      );
    retiredPush = (result as unknown as { rowCount?: number }).rowCount ?? 0;
  }

  req.log.info({ leadId, taskDate, amoOk, closedCount, retiredPush }, "task rescheduled via bot");
  res.json({ ok: amoOk, amoOk, closedCount, retiredPush });
});

export default router;
