/**
 * Writes the handover drafts on demand.
 *
 * The scheduled version of this looped: queueSuggestion rewrites an existing
 * pending row in place, so the pass's "nothing written since our last message"
 * guard never became true and it re-notified the broker every five minutes.
 * Run by hand there is no loop to have — one call, one draft per card — so the
 * broker gets what the handover owes him while the automatic guard is redesigned.
 */
import { Router } from "express";
import { processHandoverDrafts } from "../../lib/handover-draft";

const router = Router();

router.post("/admin/handover-drafts", async (_req, res) => {
  const queued = await processHandoverDrafts();
  res.json({ queued });
});

export default router;
