/**
 * GET /api/public/report?broker=X&period=day|week|month&pipeline=Rental
 *   One broker's own card.
 *
 * GET /api/public/report/team?period=day&pipeline=Rental
 *   Every broker with live leads, side by side — what the owner opens.
 *   Carries `notifications: on|off` per broker, because a broker who cannot be
 *   notified is the first thing that explains a bad column and the owner should
 *   never have to hold that in his head (see /push/coverage).
 */
import { Router } from "express";
import { buildReport, reportableBrokers, type ReportPeriod } from "../../lib/daily-report";
import { brokersWithPush } from "../../lib/push-notifications";

const router = Router();

function parsePeriod(v: unknown): ReportPeriod {
  return v === "week" || v === "month" ? v : "day";
}

router.options("/report", (_req, res) => res.sendStatus(204));
router.get("/report", async (req, res) => {
  const broker = String(req.query["broker"] ?? "").trim();
  if (!broker) {
    res.status(400).json({ error: "broker required" });
    return;
  }
  const pipeline = (req.query["pipeline"] as string) || null;
  try {
    res.json(await buildReport(broker, parsePeriod(req.query["period"]), pipeline));
  } catch (err) {
    req.log.error({ err }, "report failed");
    res.status(500).json({ error: "DB error" });
  }
});

router.options("/report/team", (_req, res) => res.sendStatus(204));
router.get("/report/team", async (req, res) => {
  const pipeline = (req.query["pipeline"] as string) || null;
  const period = parsePeriod(req.query["period"]);
  try {
    const [brokers, covered] = await Promise.all([
      reportableBrokers(pipeline),
      brokersWithPush(),
    ]);
    const cards = await Promise.all(brokers.map((b) => buildReport(b, period, pipeline)));
    res.json({
      period,
      cards: cards.map((c) => ({
        ...c,
        notifications: covered.has(c.broker.trim().toLowerCase()) ? "on" : "off",
      })),
    });
  } catch (err) {
    req.log.error({ err }, "team report failed");
    res.status(500).json({ error: "DB error" });
  }
});

export default router;
