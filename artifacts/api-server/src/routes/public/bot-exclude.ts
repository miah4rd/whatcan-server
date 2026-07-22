import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../../lib/logger";

const router = Router();

router.options("/bot-exclude", (_req, res) => res.sendStatus(204));

/**
 * POST /api/public/bot-exclude
 * Permanently remove a lead from the bot — the lead stays in CRM but will
 * never appear in Push or Live again.
 * Body: { leadId: string }
 */
router.post("/bot-exclude", async (req, res) => {
  const { leadId } = req.body as { leadId?: string };
  if (!leadId) {
    res.status(400).json({ error: "leadId required" });
    return;
  }

  try {
    await db
      .update(leadsSyncTable)
      .set({ botExcluded: true, nextFollowupAt: null })
      .where(eq(leadsSyncTable.leadId, String(leadId)));

    const cancelled = await db
      .update(pendingSuggestionsTable)
      .set({ status: "skipped" })
      .where(
        and(
          eq(pendingSuggestionsTable.leadId, String(leadId)),
          eq(pendingSuggestionsTable.status, "pending"),
        ),
      )
      .returning({ id: pendingSuggestionsTable.id });

    logger.info(
      { leadId, cancelledCount: cancelled.length },
      "bot-exclude: lead removed from bot",
    );

    res.json({ ok: true, cancelledSuggestions: cancelled.length });
  } catch (err) {
    logger.error({ err, leadId }, "bot-exclude: failed");
    res.status(500).json({ error: "internal error" });
  }
});

export default router;
