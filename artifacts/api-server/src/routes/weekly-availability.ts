import { Router } from "express";
import {
  planWeeklyChecks,
  processAnswers,
  processWeeklyAvailabilityCheck,
  weeklyAvailabilityMode,
} from "../lib/weekly-availability-check";

const router = Router();

/**
 * The automatic weekly availability check with listing owners (owner, 14.09.2026) — see
 * lib/weekly-availability-check.ts.
 *
 * POST /api/admin/weekly-availability?dry=1
 *   The plan: every Rental Listings card at or past live, who would get the check now and why the
 *   rest would not, with the exact message. Also reads pending owner answers (answers=1) without
 *   writing anything. Sends nothing.
 * POST /api/admin/weekly-availability?run=1
 *   One scheduled pass now (only when broker_settings.weekly_availability_mode = on).
 */
router.post("/admin/weekly-availability", async (req, res) => {
  const mode = await weeklyAvailabilityMode();
  try {
    if (String(req.query["run"] ?? "") === "1") {
      if (mode !== "on") {
        res.status(409).json({ mode, error: "weekly_availability_mode is not on — nothing sent" });
        return;
      }
      res.json({ mode, sent: await processWeeklyAvailabilityCheck() });
      return;
    }
    const plan = (await planWeeklyChecks()).map(({ ownerTexts: _t, lastContactMs: _l, responsibleUser, ...row }) => ({ ...row, responsibleUser }));
    const answers = String(req.query["answers"] ?? "") === "1" ? await processAnswers({ apply: false }) : undefined;
    res.json({
      mode,
      dry: true,
      counts: {
        cards: plan.length,
        send: plan.filter((r) => r.decision === "send").length,
        skip: plan.filter((r) => r.decision === "skip").length,
      },
      plan,
      answers,
    });
  } catch (err) {
    req.log.error({ err }, "weekly availability plan failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
