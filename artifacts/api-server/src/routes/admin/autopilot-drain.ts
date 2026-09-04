/**
 * Releases a BACKLOG of pending drafts through autopilot, a batch at a time.
 *
 * Autopilot fires when a draft is born, so a funnel that was delegated after the
 * drafts already existed keeps them waiting forever: 108 of them had piled up
 * while the threshold was silently unresolved. This drains that backlog without
 * turning it into 108 WhatsApp messages in one minute, which is what a bulk
 * "approve all" would be — to the recipients and to WhatsApp both.
 *
 * The pacing is the owner's: 15 per run, no more than hourly, 60 a day per
 * funnel, and nothing outside 08:00–20:00 Bali. A message from an unknown
 * agency at three in the morning reads as spam however good the text is.
 *
 * New conversations are NOT part of this. Opening a thread has its own budget
 * (new-contact-budget.ts) and this endpoint never sends a first contact.
 */
import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { delegatedStageNames, getAutopilotSetting, maybeAutopilot } from "../../lib/autopilot";

const router = Router();

const BATCH = 15;
/**
 * A ceiling for the drain's own pace, not a rule about messaging.
 *
 * The real limit lives elsewhere and is about STRANGERS: opening a thread with
 * someone who has never written to us is what Meta blocks a number for, and
 * new-contact-budget.ts caps that at nine a day on its own. Replying to a person
 * who is already talking to us is not policed, so this number exists only to
 * stop a backlog leaving as one burst.
 */
const DAILY_CAP = 200;
const OPEN_HOUR = 8;
const CLOSE_HOUR = 20;

function baliHour(): number {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCHours();
}

router.post("/admin/autopilot-drain", async (req, res) => {
  const pipeline = String(req.query["pipeline"] ?? "rental listings").trim().toLowerCase();
  const limit = Math.min(Number(req.query["limit"]) || BATCH, BATCH);
  const force = String(req.query["force"] ?? "") === "1";

  const setting = await getAutopilotSetting(pipeline);
  if (setting.mode !== "on") {
    res.json({ sent: 0, skipped: `autopilot is "${setting.mode}" for ${pipeline}` });
    return;
  }

  const hour = baliHour();
  if (!force && (hour < OPEN_HOUR || hour >= CLOSE_HOUR)) {
    res.json({ sent: 0, skipped: `outside 08:00–20:00 Bali (now ${hour}:00)` });
    return;
  }

  // The day's spend, counted the way the owner reads a day.
  const sentToday = await db.execute(sql`
    SELECT count(*)::int AS n
      FROM pending_suggestions p
      JOIN leads_sync l ON l.lead_id = p.lead_id
     WHERE p.auto_sent
       AND lower(l.pipeline) = ${pipeline}
       AND (p.created_at AT TIME ZONE 'Asia/Makassar')::date
           = (now() AT TIME ZONE 'Asia/Makassar')::date
  `);
  const already = Number((sentToday.rows?.[0] as { n?: number } | undefined)?.n ?? 0);
  if (!force && already >= DAILY_CAP) {
    res.json({ sent: 0, skipped: `drain pace cap reached (${already}/${DAILY_CAP})` });
    return;
  }
  const room = force ? limit : Math.min(limit, DAILY_CAP - already);

  // Only the stages the broker delegated. Without this the drain picked the
  // oldest drafts in the whole funnel — which live in `live` and `Weekly Check
  // Sent`, past the threshold — and every one of them was declined in silence.
  const eligibleStages = await delegatedStageNames(pipeline);
  if (!eligibleStages || eligibleStages.length === 0) {
    res.json({ sent: 0, skipped: `no delegated stages resolved for ${pipeline}` });
    return;
  }

  // Oldest first: a draft that has waited longest is the one whose conversation
  // is closest to going cold.
  const backlog = await db
    .select({ leadId: pendingSuggestionsTable.leadId })
    .from(pendingSuggestionsTable)
    .innerJoin(leadsSyncTable, eq(leadsSyncTable.leadId, pendingSuggestionsTable.leadId))
    .where(
      and(
        eq(pendingSuggestionsTable.status, "pending"),
        sql`lower(${leadsSyncTable.pipeline}) = ${pipeline}`,
        inArray(leadsSyncTable.leadStage, eligibleStages),
      ),
    )
    // Unjudged drafts first. A draft already stamped "waiting" is still
    // pending, so oldest-first kept re-evaluating the same fifteen every run and
    // never reached the newer ones behind them: two force runs, thirty verdicts,
    // eight nudges still without one.
    .orderBy(
      sql`(${pendingSuggestionsTable.autopilotSkippedReason} IS NOT NULL)`,
      asc(pendingSuggestionsTable.createdAt),
    )
    .limit(room * 3);

  const seen = new Set<string>();
  const picked: string[] = [];
  for (const b of backlog) {
    if (seen.has(b.leadId)) continue;
    seen.add(b.leadId);
    picked.push(b.leadId);
    if (picked.length >= room) break;
  }

  // maybeAutopilot re-checks the stage threshold and every send guard itself —
  // this endpoint decides only WHEN, never WHETHER.
  // Count what LEFT, not what was tried: reporting attempts as sends is how a
  // batch of fifteen silent declines got announced as fifteen delivered
  // messages, and the owner would have believed it.
  let sent = 0;
  const declined: Record<string, number> = {};
  for (const leadId of picked) {
    try {
      const outcome = await maybeAutopilot(leadId);
      if (outcome.sent) sent++;
      else declined[outcome.reason] = (declined[outcome.reason] ?? 0) + 1;
    } catch (err) {
      logger.warn({ err, leadId }, "autopilot-drain: lead failed (non-fatal)");
      declined["threw"] = (declined["threw"] ?? 0) + 1;
    }
  }

  logger.info(
    { pipeline, picked: picked.length, sent, declined, alreadyToday: already },
    "autopilot-drain finished",
  );
  res.json({
    pipeline,
    attempted: picked.length,
    sent,
    declined,
    alreadyToday: already,
    dailyCap: DAILY_CAP,
    eligibleStages,
  });
});

export default router;
