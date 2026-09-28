/**
 * POST /api/admin/listing-features-fill — fills empty listing features from our own text and the
 * listing's Airbnb / Booking page (lib/listing-features-fill.ts). Dry by default (?apply=1 writes).
 * Body: { ids?: string[], limit?: number }.
 */
import { Router } from "express";
import { runFeatureFill } from "../../lib/listing-features-fill";

const router = Router();

router.post("/admin/listing-features-fill", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String) : undefined;
  const limit = Number(req.body?.limit) || undefined;
  const results = await runFeatureFill({ apply, ids, limit });
  res.json({ apply, looked: results.filter((r) => !r.skipped).length, filled: results.filter((r) => Object.keys(r.filled).length).length, results });
});

export default router;
