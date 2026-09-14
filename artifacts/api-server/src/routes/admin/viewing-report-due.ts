import { Router } from "express";
import { ensureSlotReport, retaskDueReport } from "../../lib/viewing-report";

const router = Router();

/**
 * Ask the broker for a viewing report by hand: `?lead=<id>&at=<ISO>`.
 * The scheduler does this itself three hours after every agreed slot; this is
 * for viewings it could not see. `lead` is the card whose thread agreed the
 * slot — when that card is closed the report goes to the client's open card,
 * the same rule as the scheduled pass.
 *
 * `&retask=1` re-creates the "Fill the viewing report" task for a report that
 * is still due: before 14.09 any message closed every open task on the card,
 * the report task included.
 */
router.post("/admin/viewing-report-due", async (req, res) => {
  const leadId = String(req.query["lead"] ?? "").trim();
  const at = new Date(String(req.query["at"] ?? ""));
  if (!leadId || Number.isNaN(at.getTime())) { res.status(400).json({ error: "lead and at (ISO) required" }); return; }
  if (String(req.query["retask"] ?? "") === "1") {
    res.json(await retaskDueReport(leadId, at));
    return;
  }
  res.json(await ensureSlotReport(leadId, at, undefined, "admin"));
});

export default router;
