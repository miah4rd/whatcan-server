import { Router } from "express";
import { auditListingStages, reconcileListingStage } from "../../lib/listing-stage-engine";
import { longTermControl } from "../../lib/long-term-control";

const router = Router();

/**
 * Where does every open listing card belong, by its facts?
 *
 * Dry by default: lists the bot's cards it would move, the ones it holds back
 * (a second opinion said no), and the broker's cards whose facts disagree with
 * their stage. `?apply=1` moves the bot's cards; the broker's are never moved.
 * `?lead=<id>` judges one card. `?stage=long%20term` limits the run to one
 * stage. `?refresh=1` re-reads the threads instead of trusting cached facts —
 * needed once after a new extraction field (the owner's own words for the free
 * date, 15.09.2026).
 */
router.post("/admin/listing-audit", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const refresh = String(req.query["refresh"] ?? "") === "1";
  const stage = String(req.query["stage"] ?? "").trim();
  const only = String(req.query["lead"] ?? "").trim();
  if (only) {
    res.json(await reconcileListingStage(only, { apply, source: "audit", refresh }));
    return;
  }
  const limit = Math.min(Number(req.query["limit"] ?? 400) || 400, 400);
  res.json({ apply, refresh, stage: stage || null, ...(await auditListingStages({ apply, limit, refresh, stage: stage || undefined })) });
});

/** The long term regulation's standing check (§9), live from amoCRM. Expected: four empty lists. */
router.get("/admin/long-term-control", async (_req, res) => {
  try {
    res.json(await longTermControl());
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
