import { Router } from "express";
import { db, leadCrmTasksTable, leadsSyncTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createAmoTask, getAmoLead } from "../../lib/amo-client.js";

const router = Router();

router.options("/schedule-task", (_req, res) => res.sendStatus(204));

router.post("/schedule-task", async (req, res) => {
  const { leadId, taskDate, taskText } = req.body as {
    leadId?: string;
    taskDate?: string;
    taskText?: string;
  };

  if (!leadId || !taskDate || !taskText) {
    return void res.status(400).json({ error: "leadId, taskDate, taskText are required" });
  }

  const parsedDate = new Date(taskDate);
  if (isNaN(parsedDate.getTime())) {
    return void res.status(400).json({ error: "Invalid taskDate" });
  }

  let amoOk = false;
  let amoError = "";
  try {
    const lead = await getAmoLead(leadId);
    const responsibleUserId = lead?.responsible_user_id ?? undefined;
    amoOk = await createAmoTask(leadId, taskText, parsedDate, responsibleUserId);
  } catch (e) {
    req.log.error({ err: e }, "schedule-task amoCRM API error");
    amoError = String(e).slice(0, 500);
  }

  await db.insert(leadCrmTasksTable).values({
    leadId,
    taskDate: parsedDate,
    taskText,
    webhookStatus: amoOk ? 200 : 500,
    webhookResponse: amoOk ? "created via API" : amoError,
  });

  await db
    .update(leadsSyncTable)
    .set({ nextFollowupAt: parsedDate })
    .where(eq(leadsSyncTable.leadId, leadId));

  req.log.info({ leadId, taskDate, amoOk }, "CRM task scheduled via amoCRM API, push snoozed");

  res.json({ ok: amoOk, amoOk });
});

export default router;
