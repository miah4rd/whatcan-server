/**
 * Nudges a villa owner who stopped replying while we were still acquiring the
 * listing.
 *
 * Why this exists as its own pass, and why the PUSH tab was empty until now:
 *
 * followup-scheduler.ts hard-blocks the entire Rental Listings funnel and
 * clears `nextFollowupAt` for it. That block is correct and stays. Its outbound
 * is driven by `qualification_steps` — ONE setting shared by every pipeline,
 * configured with a BUYER script. Villa owners were once queued "Saw you
 * grabbed the guide, ! 👋 Bali's still outperforming most markets on rental
 * returns", empty name and all. The comment there calls owner follow-up "a
 * later phase". This is that phase.
 *
 * So the funnel gets its own pass with its own words, exactly as the weekly
 * availability check does. Nothing here can inherit the buyer script, because
 * nothing here reads it.
 *
 * No AI, on purpose. The question is the same every time — are you still
 * renting it out — and a model that rewords it each round gives the owner a
 * reason to wonder what changed. A broker still approves every draft before it
 * sends; this pass only fills the PUSH tab.
 */
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { isListingAcquisition } from "./pipelines";
import { villaFromLeadName, fetchLeadTitle, fetchOwnerName } from "./weekly-availability-check";

/**
 * Stages where the owner conversation is still open.
 *
 * Deliberately a whitelist, not "everything except closed". `live` and
 * `Weekly Check Sent` are the listings we already carry — those owners have
 * their own weekly pass, and a second thread asking a different question would
 * read as two people from the same agency who do not talk to each other.
 */
const OPEN_STAGES = [
  "initial contact",
  "taken to work",
  "qualified",
  "details",
  "agreement",
];

/** Silence that counts as "went quiet". */
const FIRST_NUDGE_HOURS = 24;
/**
 * One nudge per card, then stop.
 *
 * Deliberately conservative for the first run of this funnel: we have never
 * followed up an owner here, so nobody knows yet how they react. A second round
 * is a one-line change once the first has been watched.
 */
const MAX_NUDGES = 1;

/**
 * How many drafts one pass may write.
 *
 * Without this the first run would have dropped ~96 drafts into one broker's
 * PUSH tab at once, which is not a working queue — it is a wall he scrolls past.
 * The pass runs every five minutes, so the backlog drains steadily instead.
 */
const BATCH_LIMIT = 12;

function isOpenStage(stage: string | null): boolean {
  const s = (stage ?? "").toLowerCase();
  return OPEN_STAGES.some((k) => s.includes(k));
}

/**
 * The owner reads this. Short enough to answer from a lock screen, and it says
 * what we want rather than asking how they are.
 */
export function composeNudge(ownerName: string, villa: string): string {
  const who = ownerName ? ` ${ownerName}` : "";
  const what = villa || "your villa";
  return (
    `Hi${who}, just following up on ${what} — are you still looking to rent it out?\n\n` +
    `We have clients searching in the area and I'd like to bring you a tenant.`
  );
}

/**
 * Queue one owner nudge per silent listing card. Returns how many were written.
 */
export async function processListingOwnerFollowup(): Promise<number> {
  // "Went quiet" is measured from OUR last message, not from the card's
  // updated_at: amoCRM stamps that on any edit, so a card touched for an
  // unrelated reason would look like a live conversation.
  const candidates = await db
    .select({
      leadId: leadsSyncTable.leadId,
      responsibleUser: leadsSyncTable.responsibleUser,
      pipeline: leadsSyncTable.pipeline,
      leadStage: leadsSyncTable.leadStage,
      botExcluded: leadsSyncTable.botExcluded,
      followupLevel: leadsSyncTable.followupLevel,
      lastOurMessageAt: leadsSyncTable.lastOurMessageAt,
      lastMessageFrom: leadsSyncTable.lastMessageFrom,
    })
    .from(leadsSyncTable)
    .where(
      and(
        sql`lower(${leadsSyncTable.pipeline}) = 'rental listings'`,
        sql`${leadsSyncTable.lastOurMessageAt} is not null`,
      ),
    );

  if (candidates.length === 0) return 0;

  let queued = 0;
  for (const lead of candidates) {
    if (queued >= BATCH_LIMIT) break;
    try {
      if (lead.botExcluded) continue;
      // Belt and braces, same as the weekly pass: the pipeline name is the
      // trigger, but only this funnel has owners to nudge.
      if (!isListingAcquisition(lead.pipeline)) continue;
      if (!isOpenStage(lead.leadStage)) continue;

      // The owner answered — that is not silence, and the LIVE path handles it.
      if ((lead.lastMessageFrom ?? "").toLowerCase() === "lead") continue;

      // followupLevel is free to use here: the buyer scheduler clears
      // nextFollowupAt for this funnel and never advances the level on it.
      const round = (lead.followupLevel ?? 0) + 1;
      if (round > MAX_NUDGES) continue;

      const silentHours = (Date.now() - lead.lastOurMessageAt!.getTime()) / 3_600_000;
      if (silentHours < FIRST_NUDGE_HOURS) continue;

      // Already waiting for the broker — a second identical card every five
      // minutes is how a queue becomes something people stop opening.
      const [pending] = await db
        .select({ id: pendingSuggestionsTable.id })
        .from(pendingSuggestionsTable)
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, lead.leadId),
            eq(pendingSuggestionsTable.status, "pending"),
          ),
        )
        .limit(1);
      if (pending) continue;

      const title = await fetchLeadTitle(lead.leadId);
      const villa = villaFromLeadName(title);
      const owner = await fetchOwnerName(lead.leadId, villa);

      await db.insert(pendingSuggestionsTable).values({
        leadId: lead.leadId,
        responsibleUser: lead.responsibleUser,
        // kind "push" lands in the PUSH tab. It stays out of REACH because that
        // tab is selected by stage name (REACH_STAGE_KEYWORDS) and none of the
        // open acquisition stages are in it.
        kind: "push",
        suggestionText: composeNudge(owner, villa),
        status: "pending",
      });

      await db
        .update(leadsSyncTable)
        .set({ followupLevel: round })
        .where(eq(leadsSyncTable.leadId, lead.leadId));

      queued++;
      logger.info(
        { leadId: lead.leadId, villa, round, silentHours: Math.round(silentHours) },
        "listing-owner-followup: queued an owner nudge",
      );
    } catch (err) {
      logger.error({ err, leadId: lead.leadId }, "listing-owner-followup: failed for this card");
    }
  }

  if (queued > 0) logger.info({ queued }, "listing-owner-followup pass complete");
  return queued;
}
