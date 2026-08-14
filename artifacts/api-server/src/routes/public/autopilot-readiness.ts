/**
 * GET /api/public/autopilot-readiness?broker=X[&pipeline=Rental]
 *
 * The owner's end state is a bot the broker no longer edits — per SITUATION,
 * not as one switch. This is the score that says which situations have
 * earned it: for every conversation moment, how many drafts the broker
 * decided on, and what share went out untouched.
 *
 * Derived entirely in SQL from decisions already recorded in
 * pending_suggestions (approved = sent as drafted, edited = the bot was
 * wrong about something), so it covers all history and costs no AI calls.
 * The situation is reconstructed from kind + stage the same way
 * deriveSituation does it at generation time — keep the two in step.
 *
 * "ready" here is a report, not a trigger: nothing flips to auto-send by
 * itself. The dial stays with the owner; this page is what he reads before
 * turning it.
 */
import { Router } from "express";
import { pool } from "@workspace/db";

const router = Router();

/** SQL mirror of deriveSituation (broker-corrections.ts). */
const SITUATION_CASE = `
  CASE
    WHEN lower(coalesce(l.pipeline,'')) LIKE '%listing%' THEN 'owner_intake'
    WHEN p.kind = 'push' THEN 'followup'
    WHEN lower(coalesce(p.suggested_stage, l.lead_stage, '')) ~ '(negotiat|reservation|contract|won)' THEN 'closing'
    WHEN lower(coalesce(p.suggested_stage, l.lead_stage, '')) ~ '(viewing|zoom)' THEN 'viewing'
    WHEN lower(coalesce(p.suggested_stage, l.lead_stage, '')) ~ '(feedback|objection)' THEN 'objection'
    WHEN lower(coalesce(p.suggested_stage, l.lead_stage, '')) ~ '(new lead|initial|неразобран)' THEN 'first_contact'
    WHEN lower(coalesce(p.suggested_stage, l.lead_stage, '')) ~ '(need|assess|qualif|contact establi)' THEN 'qualifying'
    ELSE 'options'
  END`;

type Row = {
  situation: string;
  decided: number;
  sent_as_is: number;
  edited: number;
  prev_decided: number;
  prev_sent_as_is: number;
};

function readiness(decided: number, sentAsIs: number): "ready" | "close" | "learning" | "no_data" {
  if (decided < 10) return "no_data";
  const rate = sentAsIs / decided;
  if (rate >= 0.9) return "ready";
  if (rate >= 0.75) return "close";
  return "learning";
}

router.options("/autopilot-readiness", (_req, res) => res.sendStatus(204));
router.get("/autopilot-readiness", async (req, res) => {
  const broker = String(req.query["broker"] ?? "").trim();
  if (!broker) {
    res.status(400).json({ error: "broker required" });
    return;
  }
  const pipeline = String(req.query["pipeline"] ?? "").trim() || null;

  const params: unknown[] = [broker];
  if (pipeline) params.push(pipeline);

  try {
    const r = await pool.query(
      `SELECT ${SITUATION_CASE} AS situation,
              count(*) FILTER (WHERE p.status IN ('approved','edited')
                                 AND p.created_at >= now() - interval '14 days')::int AS decided,
              count(*) FILTER (WHERE p.status = 'approved'
                                 AND p.created_at >= now() - interval '14 days')::int AS sent_as_is,
              count(*) FILTER (WHERE p.status = 'edited'
                                 AND p.created_at >= now() - interval '14 days')::int AS edited,
              count(*) FILTER (WHERE p.status IN ('approved','edited')
                                 AND p.created_at >= now() - interval '28 days'
                                 AND p.created_at <  now() - interval '14 days')::int AS prev_decided,
              count(*) FILTER (WHERE p.status = 'approved'
                                 AND p.created_at >= now() - interval '28 days'
                                 AND p.created_at <  now() - interval '14 days')::int AS prev_sent_as_is
         FROM pending_suggestions p
         LEFT JOIN leads_sync l ON l.lead_id = p.lead_id
        WHERE p.responsible_user = $1
          ${pipeline ? "AND lower(coalesce(l.pipeline,'')) = lower($2)" : ""}
        GROUP BY 1
        ORDER BY 2 DESC`,
      params,
    );

    const situations = (r.rows as Row[]).map((row) => {
      const rate = row.decided > 0 ? Math.round((100 * row.sent_as_is) / row.decided) : null;
      const prevRate =
        row.prev_decided > 0 ? Math.round((100 * row.prev_sent_as_is) / row.prev_decided) : null;
      return {
        situation: row.situation,
        decided: row.decided,
        sentAsIs: row.sent_as_is,
        edited: row.edited,
        cleanRatePct: rate,
        prevCleanRatePct: prevRate,
        readiness: readiness(row.decided, row.sent_as_is),
      };
    });

    res.json({ broker, pipeline, windowDays: 14, situations });
  } catch (err) {
    req.log.error({ err }, "autopilot-readiness failed");
    res.status(500).json({ error: "DB error" });
  }
});

export default router;
