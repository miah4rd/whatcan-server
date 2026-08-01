/**
 * The broker's budget-gate dial (see lib/budget-filter.ts). GET returns the
 * current setting; POST saves it. Rental-only by the owner's instruction, but
 * keyed by pipeline so another funnel could opt in later without new code.
 */
import { Router } from "express";
import { getBudgetFilter, setBudgetFilter } from "../../lib/budget-filter";

const router = Router();

router.options("/budget-filter", (_req, res) => res.sendStatus(204));

router.get("/budget-filter", async (req, res) => {
  const pipeline = String(req.query["pipeline"] ?? "rental").toLowerCase();
  try {
    res.json({ setting: await getBudgetFilter(pipeline) });
  } catch (err) {
    req.log.error({ err }, "budget-filter get failed");
    res.status(500).json({ error: "settings unavailable" });
  }
});

router.post("/budget-filter", async (req, res) => {
  const body = req.body as { pipeline?: string; enabled?: boolean; minMonthlyIdr?: number };
  const pipeline = (body.pipeline ?? "rental").toLowerCase();
  const enabled = body.enabled === true;
  const minMonthlyIdr = Math.max(0, Math.round(Number(body.minMonthlyIdr) || 0));

  if (enabled && (minMonthlyIdr < 1_000_000 || minMonthlyIdr > 10_000_000_000)) {
    res.status(400).json({ error: "minMonthlyIdr must be a plausible rupiah amount" });
    return;
  }

  try {
    await setBudgetFilter({ pipeline, enabled, minMonthlyIdr });
    res.json({ ok: true, setting: { pipeline, enabled, minMonthlyIdr } });
  } catch (err) {
    req.log.error({ err }, "budget-filter set failed");
    res.status(500).json({ error: "could not save" });
  }
});

export default router;
