import { Router } from "express";
import { runListingStatusPass } from "../lib/listing-status-pass";
import { baliWeekStart, listingWeek } from "../lib/listing-status-week";

const router = Router();

/**
 * The website's Pre-listed / Listed switch as a weekly number (owner, 2026-09-14).
 *
 * GET /api/public/listing-status/week?week=YYYY-MM-DD
 *   One Monday–Sunday Bali week (any date inside it; default this week): listings switched
 *   Pre-listed → Listed on the site, the target, Rental Listings cards that reached live in amoCRM,
 *   and the switches that did not move a card.
 * GET /api/public/listing-status/weeks?n=4
 *   The same for the last n weeks, newest first.
 * POST /api/admin/listing-status-pass?dry=1
 *   Run the pass now. dry=1 decides and reports without moving cards, writing notes or links.
 *
 * The same numbers in SQL on the site database:
 *   select * from listing_status_weekly order by week_start_bali desc;
 */
const weekOf = (raw: unknown): string => {
  const q = String(raw ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(q) ? baliWeekStart(new Date(`${q}T12:00:00+08:00`)) : baliWeekStart();
};

router.get("/public/listing-status/week", async (req, res) => {
  try {
    res.json(await listingWeek(weekOf(req.query["week"])));
  } catch (err) {
    req.log.error({ err }, "listing status week failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/public/listing-status/weeks", async (req, res) => {
  const n = Math.min(Math.max(Number(req.query["n"] ?? 4) || 4, 1), 12);
  const first = Date.parse(`${baliWeekStart()}T12:00:00+08:00`);
  const starts = Array.from({ length: n }, (_, i) => baliWeekStart(new Date(first - i * 7 * 86400000)));
  try {
    res.json(await Promise.all(starts.map((s) => listingWeek(s))));
  } catch (err) {
    req.log.error({ err }, "listing status weeks failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/admin/listing-status-pass", async (req, res) => {
  const dry = String(req.query["dry"] ?? "") === "1";
  try {
    res.json({ dry, decisions: await runListingStatusPass({ dry }) });
  } catch (err) {
    req.log.error({ err }, "listing status pass failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
