/**
 * What the bot actually costs, per day and per purpose.
 *
 * Until now nothing recorded it, so "why are the tokens burning so fast" could
 * only be answered with arithmetic on estimates. `ai_usage` gets a row per API
 * call with its own price already worked out (lib/ai-client.ts), and this
 * endpoint adds it up: today, yesterday, and where the money went.
 *
 * Days are counted in Bali time, because that is the day the broker means.
 */
import { Router } from "express";
import { pool } from "@workspace/db";

const router = Router();

const BALI = "Asia/Makassar";

router.options("/ai-spend", (_req, res) => res.sendStatus(204));

router.get("/ai-spend", async (req, res) => {
  const days = Math.min(30, Math.max(1, Number(req.query["days"]) || 7));
  try {
    const byDay = await pool.query(
      `SELECT (created_at AT TIME ZONE 'UTC' AT TIME ZONE $1)::date::text AS day,
              COUNT(*)::int          AS calls,
              SUM(cost_usd)::float8  AS usd,
              SUM(in_tokens)::bigint         AS in_tokens,
              SUM(out_tokens)::bigint        AS out_tokens,
              SUM(cache_read_tokens)::bigint AS cache_read,
              SUM(cache_write_tokens)::bigint AS cache_write
         FROM ai_usage
        WHERE created_at > now() - ($2 || ' days')::interval
        GROUP BY 1 ORDER BY 1 DESC`,
      [BALI, String(days)],
    );

    // Where today's money went. "label" is set at each call site; anything
    // unlabelled lands in "other" rather than silently disappearing.
    const byLabel = await pool.query(
      `SELECT COALESCE(label, 'other') AS label,
              COUNT(*)::int         AS calls,
              SUM(cost_usd)::float8 AS usd
         FROM ai_usage
        WHERE (created_at AT TIME ZONE 'UTC' AT TIME ZONE $1)::date
              = (now() AT TIME ZONE 'UTC' AT TIME ZONE $1)::date
        GROUP BY 1 ORDER BY 3 DESC NULLS LAST`,
      [BALI],
    );

    const rows = byDay.rows as Array<{ day: string; usd: number }>;
    const today = (await pool.query(
      `SELECT (now() AT TIME ZONE 'UTC' AT TIME ZONE $1)::date::text AS d`,
      [BALI],
    )).rows[0]?.d as string | undefined;

    res.json({
      today_usd: rows.find((r) => r.day === today)?.usd ?? 0,
      by_day: byDay.rows,
      by_label_today: byLabel.rows,
    });
  } catch (err) {
    req.log.error({ err }, "ai-spend failed");
    res.status(500).json({ error: "spend unavailable" });
  }
});

export default router;
