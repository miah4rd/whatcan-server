import { Router } from "express";
import { auditListingStages, reconcileListingStage } from "../../lib/listing-stage-engine";

const router = Router();

/**
 * Where does every open listing card belong, by its facts?
 *
 * Dry by default: lists the bot's cards it would move, the ones it holds back
 * (a second opinion said no), and the broker's cards whose facts disagree with
 * their stage. `?apply=1` moves the bot's cards; the broker's are never moved.
 * `?lead=<id>` judges one card.
 */
router.post("/admin/listing-audit", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const only = String(req.query["lead"] ?? "").trim();
  if (only) {
    res.json(await reconcileListingStage(only, { apply, source: "audit" }));
    return;
  }
  const limit = Math.min(Number(req.query["limit"] ?? 400) || 400, 400);
  res.json({ apply, ...(await auditListingStages({ apply, limit })) });
});

export default router;
