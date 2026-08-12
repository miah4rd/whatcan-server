/**
 * Leads the bot has silently failed to act on.
 *
 * Every outage on this project has looked identical from the outside: an empty
 * inbox. Not an error, not a red mark — just nothing, which is indistinguishable
 * from a quiet day. In one afternoon the same shape appeared five times:
 * push drafts hidden by a stage whitelist written for another funnel; a daily
 * quota consumed by one pipeline so a second could never show; a reCaptcha
 * killing the poll that detects replies; leads_sync.content frozen so drafts
 * were written as cold first contact to owners who had already answered; and a
 * scout note in a new layout, skipped on every pass forever. Each was found by
 * a human noticing something missing, days late in some cases.
 *
 * The durable fix is not another parser or another gate — it is that the system
 * must be able to say "there are leads here I cannot process". This computes
 * exactly that, from the one fact no failure mode can fake: a lead sitting in a
 * pipeline we track, old enough to have been handled, with nothing to show for
 * it — no conversation, no draft, no send.
 */
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { and, eq, isNull, or, sql, inArray } from "drizzle-orm";
import { logger } from "./logger";
import { shouldSuppressPush } from "./stage-routing";

/** Grace period — a fresh lead has not had a chance to be worked yet. */
const STUCK_AFTER_MS = 30 * 60 * 1000;

export type StuckLead = {
  leadId: string;
  pipeline: string | null;
  leadStage: string | null;
  responsibleUser: string | null;
  ageMinutes: number;
};

export async function findStuckLeads(responsibleUser?: string | null): Promise<StuckLead[]> {
  const rows = await db
    .select({
      leadId: leadsSyncTable.leadId,
      pipeline: leadsSyncTable.pipeline,
      leadStage: leadsSyncTable.leadStage,
      responsibleUser: leadsSyncTable.responsibleUser,
      amoCreatedAt: leadsSyncTable.amoCreatedAt,
      content: leadsSyncTable.content,
    })
    .from(leadsSyncTable)
    .where(
      and(
        or(eq(leadsSyncTable.botExcluded, false), isNull(leadsSyncTable.botExcluded)),
        sql`${leadsSyncTable.amoCreatedAt} is not null`,
        sql`${leadsSyncTable.amoCreatedAt} < now() - interval '30 minutes'`,
        // Only recent enough to still matter — an ancient untouched card is
        // history, not a live failure.
        sql`${leadsSyncTable.amoCreatedAt} > now() - interval '14 days'`,
      ),
    );

  if (rows.length === 0) return [];

  // Anything the bot has ever produced for these leads clears them.
  const everTouched = new Set(
    (
      await db
        .select({ leadId: pendingSuggestionsTable.leadId })
        .from(pendingSuggestionsTable)
        .where(inArray(pendingSuggestionsTable.leadId, rows.map((r) => r.leadId)))
    ).map((r) => r.leadId),
  );

  const wanted = (responsibleUser ?? "").trim().toLowerCase();
  const now = Date.now();

  return rows
    .filter((r) => {
      if (everTouched.has(r.leadId)) return false;
      // A seeded/known conversation means the bot is engaged with it.
      if ((r.content ?? "").trim().length > 0) return false;
      // Closed, lost and administrative stages are not work owed.
      if (r.leadStage && shouldSuppressPush(r.leadStage)) return false;
      if (wanted && (r.responsibleUser ?? "").trim().toLowerCase() !== wanted) return false;
      return true;
    })
    .map((r) => ({
      leadId: r.leadId,
      pipeline: r.pipeline,
      leadStage: r.leadStage,
      responsibleUser: r.responsibleUser,
      ageMinutes: Math.floor((now - (r.amoCreatedAt?.getTime() ?? now)) / 60000),
    }))
    .sort((a, b) => b.ageMinutes - a.ageMinutes);
}

/**
 * Periodic shout into the log. The banner in /m is what the broker sees; this is
 * what makes the same fact greppable after the fact, so "since when?" has an
 * answer that is not "since somebody happened to look".
 */
export async function logStuckLeads(): Promise<void> {
  try {
    const stuck = await findStuckLeads();
    if (stuck.length === 0) return;
    const byPipeline: Record<string, number> = {};
    for (const s of stuck) byPipeline[s.pipeline ?? "(none)"] = (byPipeline[s.pipeline ?? "(none)"] ?? 0) + 1;
    logger.warn(
      { count: stuck.length, byPipeline, oldestMinutes: stuck[0]?.ageMinutes, sample: stuck.slice(0, 5).map((s) => s.leadId) },
      "stuck leads: the bot has produced nothing for these — seeding or detection is failing for them",
    );
  } catch (err) {
    logger.error({ err }, "stuck-lead check failed");
  }
}
