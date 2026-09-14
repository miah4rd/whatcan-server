import { Router } from "express";
import { calendarSelfTest, inspectionEventsFromCalendar, syncInspectionCalendar } from "../../lib/inspection-calendar";

const router = Router();

/**
 * Agreed villa inspections → the shared "Brokers" Google Calendar through the Make.com webhook
 * (lib/inspection-calendar.ts, lib/google-calendar.ts).
 *
 * POST /api/admin/inspection-calendar            dry: the events the pass would create / update / delete
 *   ?apply=1                                     run the pass now (it also runs every 5 minutes)
 *   &retry=1                                     also re-create rows whose earlier create outcome is unknown
 * GET  /api/admin/inspection-calendar/events     what this sync wrote (our table: key, event id, summary, start, status)
 * POST /api/admin/inspection-calendar/test       one [TEST] event: create → update → delete
 */
router.post("/admin/inspection-calendar", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const retryUncertain = String(req.query["retry"] ?? "") === "1";
  try {
    res.json({ apply, retryUncertain, ...(await syncInspectionCalendar({ apply, retryUncertain, reason: "admin" })) });
  } catch (err) {
    req.log.error({ err }, "inspection calendar: admin pass failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/admin/inspection-calendar/events", async (req, res) => {
  try {
    res.json(await inspectionEventsFromCalendar());
  } catch (err) {
    req.log.error({ err }, "inspection calendar: events read failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/admin/inspection-calendar/test", async (_req, res) => {
  res.json(await calendarSelfTest());
});

export default router;
