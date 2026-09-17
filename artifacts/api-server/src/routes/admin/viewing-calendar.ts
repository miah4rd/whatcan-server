import { Router } from "express";
import { syncViewingCalendar, viewingEventsFromCalendar } from "../../lib/viewing-calendar";

const router = Router();

/**
 * Agreed client viewings (Rental) → the Unicorn Property Google Calendar in their own colour, through the
 * same Make.com webhook as inspections (lib/viewing-calendar.ts, lib/google-calendar.ts).
 *
 * POST /api/admin/viewing-calendar            dry: the events the pass would create / update / delete
 *   ?apply=1                                  run the pass now (it also runs every 5 minutes)
 *   &retry=1                                  also re-create rows whose earlier create outcome is unknown
 *   &since=28                                 backfill: viewings up to N days past (max 90), not just the last day
 * GET  /api/admin/viewing-calendar/events     what this sync wrote (our table: key, event id, summary, start, status)
 */
router.post("/admin/viewing-calendar", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const retryUncertain = String(req.query["retry"] ?? "") === "1";
  const sinceRaw = Number(req.query["since"] ?? 0);
  const sinceDays = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.min(sinceRaw, 90) : undefined;
  try {
    res.json({ apply, retryUncertain, ...(await syncViewingCalendar({ apply, retryUncertain, sinceDays, reason: "admin" })) });
  } catch (err) {
    req.log.error({ err }, "viewing calendar: admin pass failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/admin/viewing-calendar/events", async (req, res) => {
  try {
    res.json(await viewingEventsFromCalendar());
  } catch (err) {
    req.log.error({ err }, "viewing calendar: events read failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
