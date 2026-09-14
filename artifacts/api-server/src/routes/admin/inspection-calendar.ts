import { Router } from "express";
import { calendarSelfTest, inspectionEventsFromCalendar, syncInspectionCalendar } from "../../lib/inspection-calendar";

const router = Router();

/**
 * Agreed villa inspections → the shared "Brokers" Google Calendar (lib/inspection-calendar.ts).
 *
 * POST /api/admin/inspection-calendar            dry: the events the pass would create / patch / delete
 *   ?apply=1                                     run the pass now (it also runs every 5 minutes)
 * GET  /api/admin/inspection-calendar/events     what the calendar holds from this sync, read from the API
 * POST /api/admin/inspection-calendar/test       one [TEST] event: create → read back → delete
 */
router.post("/admin/inspection-calendar", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  try {
    res.json({ apply, ...(await syncInspectionCalendar({ apply, reason: "admin" })) });
  } catch (err) {
    req.log.error({ err }, "inspection calendar: admin pass failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/admin/inspection-calendar/events", async (req, res) => {
  const days = Math.min(Math.max(Number(req.query["days"] ?? 60) || 60, 1), 180);
  res.json(await inspectionEventsFromCalendar(days));
});

router.post("/admin/inspection-calendar/test", async (_req, res) => {
  res.json(await calendarSelfTest());
});

export default router;
