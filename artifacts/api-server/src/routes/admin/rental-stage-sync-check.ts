import { Router } from "express";
import { runStageSyncCheck, lastStageSyncCheck } from "../../lib/stage-sync-check";

const router = Router();

/**
 * The Rental stage sync check on demand (lib/stage-sync-check.ts). It also
 * runs by itself daily at 09:00 Bali and pushes the owner when anything fails.
 *   GET /api/admin/rental-stage-sync-check?hours=24          run now, no push
 *   GET /api/admin/rental-stage-sync-check?hours=24&alert=1  run now and push on failure
 *   GET /api/admin/rental-stage-sync-check/last              the last stored run
 */
router.get("/admin/rental-stage-sync-check/last", async (_req, res) => {
  res.json(await lastStageSyncCheck());
});

router.all("/admin/rental-stage-sync-check", async (req, res) => {
  try {
    const hours = Number(req.query["hours"]) || 24;
    const alert = String(req.query["alert"] ?? "") === "1";
    res.json(await runStageSyncCheck({ hours, alert }));
  } catch (err) {
    res.status(500).json({ error: String(err).slice(0, 300) });
  }
});

export default router;
