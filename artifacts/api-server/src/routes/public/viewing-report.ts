import { Router } from "express";
import { dueReportForLead, fileReport, NEXT_STEPS, type ViewingOutcome } from "../../lib/viewing-report";
import { signedStorageUpload } from "../../lib/site-storage";

const router = Router();

/** The due report for a lead, if any — the card shows the form when there is one. */
router.get("/public/viewing-report", async (req, res) => {
  const leadId = String(req.query["leadId"] ?? "").trim();
  if (!leadId) { res.status(400).json({ error: "leadId required" }); return; }
  const report = await dueReportForLead(leadId);
  res.json({ report, nextSteps: NEXT_STEPS });
});

const OUTCOMES: ViewingOutcome[] = ["go", "think", "no", "no_show", "cancelled", "rescheduled"];

router.post("/public/viewing-report", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const reportId = String(b["reportId"] ?? "").trim();
  const outcome = String(b["outcome"] ?? "") as ViewingOutcome;
  if (!reportId || !OUTCOMES.includes(outcome)) { res.status(400).json({ error: "reportId and a valid outcome are required" }); return; }
  const r = await fileReport({
    reportId,
    outcome,
    feedback: String(b["feedback"] ?? ""),
    nextSteps: Array.isArray(b["nextSteps"]) ? (b["nextSteps"] as unknown[]).map(String) : [],
    nextBy: b["nextBy"] ? String(b["nextBy"]) : null,
    rescheduledTo: b["rescheduledTo"] ? String(b["rescheduledTo"]) : null,
    brokerId: b["brokerId"] ? String(b["brokerId"]) : null,
    propertyCode: b["propertyCode"] ? String(b["propertyCode"]) : null,
    media: Array.isArray(b["media"]) ? (b["media"] as unknown[]).map(String) : [],
  });
  if (!r.ok) { res.status(404).json(r); return; }
  res.json(r);
});

/** A one-time upload slot for a photo or video from the viewing: viewings/<report id>/… in the site's storage. */
router.post("/public/viewing-report/upload", async (req, res) => {
  const reportId = String(req.body?.reportId ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(reportId)) { res.status(400).json({ error: "reportId required" }); return; }
  const kind = req.body?.kind === "video" ? "video" : "photo";
  try {
    res.json(await signedStorageUpload(`viewings/${reportId}`, kind, String(req.body?.name ?? ""), "view"));
  } catch (err) {
    res.status(503).json({ error: String((err as Error).message).slice(0, 200) });
  }
});

export default router;
