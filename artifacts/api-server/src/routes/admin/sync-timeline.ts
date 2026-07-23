import { Router } from "express";
import { syncLeadMessagesFromTimeline } from "../../lib/amo-timeline-sync";

const router = Router();

/**
 * POST /api/admin/sync-timeline-messages
 * Manually trigger message sync from amoCRM events_timeline.
 * Body: { limit?: number } — optional max leads to process
 */
router.post("/api/admin/sync-timeline-messages", async (req, res) => {
  try {
    const result = await syncLeadMessagesFromTimeline();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("Timeline sync error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
