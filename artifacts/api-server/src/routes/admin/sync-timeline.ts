import { Router } from "express";
import { syncLeadMessagesFromTimeline } from "../../lib/amo-timeline-sync";
import { logger } from "../../lib/logger";

const router = Router();

/**
 * POST /api/admin/sync-timeline-messages
 * Manually trigger message sync from amoCRM events_timeline.
 * Runs in background — returns immediately with "started" status.
 * Check PM2 logs for completion.
 */
router.post("/admin/sync-timeline-messages", async (req, res) => {
  logger.info("admin: timeline sync requested — starting in background");
  res.json({ ok: true, status: "started", message: "Timeline sync running in background. Check PM2 logs." });

  // Run in background so request doesn't timeout
  syncLeadMessagesFromTimeline()
    .then((result) => {
      logger.info({ ...result }, "admin: timeline sync completed");
    })
    .catch((err: any) => {
      logger.error({ err }, "admin: timeline sync failed");
    });
});

export default router;
