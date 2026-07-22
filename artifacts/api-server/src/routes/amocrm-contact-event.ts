import { Router } from "express";
import { db, contactEventsTable, leadsSyncTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

/**
 * POST /amocrm/contact-event
 *
 * Called by hooks.tglk.ru automation whenever a broker sends ANY outgoing
 * message — via plugin, amoCRM native, or WhatsApp (synced to amoCRM).
 *
 * Expected body (sent by hooks.tglk.ru):
 *   { leadId: string, responsibleUser?: string, source?: "plugin"|"direct" }
 *
 * source defaults to "direct" here — "plugin" writes come from approve.ts directly.
 */
router.post("/amocrm/contact-event", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const leadId = body["leadId"] as string | undefined;
  const responsibleUser = (body["responsibleUser"] as string | undefined) ?? undefined;
  const source = (body["source"] as string | undefined) === "plugin" ? "plugin" : "direct";

  if (!leadId || typeof leadId !== "string") {
    res.status(400).json({ error: "leadId required" });
    return;
  }

  req.log.info({ leadId, responsibleUser, source }, "contact-event received");
  res.json({ ok: true, leadId });

  try {
    // Resolve responsibleUser from DB if not provided
    let resolvedUser = responsibleUser;
    if (!resolvedUser) {
      const row = await db
        .select({ responsibleUser: leadsSyncTable.responsibleUser })
        .from(leadsSyncTable)
        .where(eq(leadsSyncTable.leadId, leadId))
        .limit(1);
      resolvedUser = row[0]?.responsibleUser ?? undefined;
    }

    await db.insert(contactEventsTable).values({
      leadId,
      responsibleUser: resolvedUser,
      source,
    });

    req.log.info({ leadId, resolvedUser, source }, "contact-event saved");
  } catch (err) {
    req.log.error({ err, leadId }, "contact-event: DB error");
  }
});

export default router;
