import { Router } from "express";
import { ensureDueReport } from "../../lib/viewing-report";

const router = Router();

/**
 * Ask the broker for a viewing report by hand: `?lead=<id>&at=<ISO>`.
 * The scheduler does this itself three hours after every slot; this exists
 * for viewings that happened before the feature shipped.
 */
router.post("/admin/viewing-report-due", async (req, res) => {
  const leadId = String(req.query["lead"] ?? "").trim();
  const at = new Date(String(req.query["at"] ?? ""));
  if (!leadId || Number.isNaN(at.getTime())) { res.status(400).json({ error: "lead and at (ISO) required" }); return; }
  res.json(await ensureDueReport(leadId, at));
});

export default router;
