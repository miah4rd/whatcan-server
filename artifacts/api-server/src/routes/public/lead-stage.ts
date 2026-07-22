import { Router } from "express";
import { db, leadsSyncTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

router.options("/lead-stage", (_req, res) => res.sendStatus(204));

router.post("/lead-stage", async (req, res) => {
  const { leadId, leadStage } = req.body as { leadId?: string; leadStage?: string | null };
  if (!leadId) return void res.status(400).json({ error: "leadId required" });

  try {
    await db
      .update(leadsSyncTable)
      .set({ leadStage: leadStage?.trim() || null })
      .where(eq(leadsSyncTable.leadId, leadId));
    req.log.info({ leadId, leadStage }, "lead stage updated");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "lead-stage update error");
    res.status(500).json({ error: "DB error" });
  }
});

export default router;
