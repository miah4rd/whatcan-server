import { Router } from "express";
import { runInspectionBookingPass } from "../../lib/inspection-booking";

const router = Router();

/**
 * POST /api/admin/inspection-booking                  dry: every QUALIFIED listing card — mode, PUSH due or why not,
 *                                                     the villa side's stance, our asks, Yudi's proposed times
 *   ?lead=<id>[,<id>…]                                 only these cards
 *   ?generate=1                                        also write the drafts that are due (paid call), queue nothing
 *   ?apply=1                                           write and queue them for Yudi (PUSH), as the scheduled pass does
 * Never sends anything to an owner (lib/inspection-booking.ts).
 */
router.post("/admin/inspection-booking", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const generate = String(req.query["generate"] ?? "") === "1";
  const leads = String(req.query["lead"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const decisions = await runInspectionBookingPass({ apply, generate, leads: leads.length ? leads : undefined });
  res.json({
    apply,
    generate,
    scanned: decisions.length,
    due: decisions.filter((d) => d.pushDue).length,
    queued: decisions.filter((d) => d.queued).length,
    decisions,
  });
});

export default router;
