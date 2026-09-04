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
import { closeLeadAsLost } from "./amo-client";

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

/**
 * How long a card must have been quiet before each round, counted from OUR last
 * real message. The owner's cadence: a day, then three days after that, then
 * five (2026-09-03).
 *
 * Measuring every round from `lastOurMessageAt` rather than from the previous
 * DRAFT is what makes the spacing real: a nudge that actually sends moves that
 * timestamp, so the next round waits its own full interval from the send. A
 * nudge the broker skipped never moves it, so the rounds still space out
 * instead of firing back to back the moment the draft leaves the queue.
 */
const NUDGE_AFTER_HOURS = [24, 72, 120];
/**
 * How long the last nudge is given to land before the card is closed.
 *
 * Five days, the same as the gap the third nudge itself waited: if that much
 * silence was not worth another message, it is not worth an open card either.
 */
const CLOSE_AFTER_LAST_NUDGE_HOURS = 120;
/**
 * Three rounds, then stop.
 *
 * It was ONE for the first run of this funnel — nobody had ever followed up an
 * owner here and we did not know how they would react. That run happened, and
 * the cost of the cap showed up in the data: 74 cards of 101 had already spent
 * their single nudge, meaning an owner who ignored one message was never
 * contacted again and the card sat in the funnel forever with nothing scheduled
 * against it. Three rounds on a widening cadence is the owner's decision
 * (2026-09-03).
 */
const MAX_NUDGES = NUDGE_AFTER_HOURS.length;

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
 *
 * It carries the WHOLE qualification ask in one sentence — bedrooms, price, and
 * the date free — because a card only reaches QUALIFIED once bedrooms and a
 * commission-inclusive price are known, and every extra round trip is a day
 * lost. The price is asked for in the form we need ("including our 10% agency
 * commission") rather than as "does your price include commission?": the
 * meta-question gets skipped or answered ambiguously, and the card then sits in
 * "commission position NOT confirmed" — a number we cannot put on the site.
 * "That's everything we need" is a promise, not filler: it tells the owner this
 * is the last question, not the first of a form.
 */
export function composeNudge(ownerName: string, villa: string): string {
  const who = ownerName ? ` ${ownerName}` : "";
  const what = villa || "your villa";
  return (
    `Hi${who}, just following up on ${what} — are you still looking to rent it out? ` +
    `We have clients searching in the area right now.\n\n` +
    `If so, could you send me the number of bedrooms, the monthly and yearly rate ` +
    `including our 10% agency commission, and the date it's available from — ` +
    `that's everything we need to put it in front of them.`
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
      if (round > MAX_NUDGES) {
        // The ladder is spent and the owner never came back. Leaving the card in
        // TAKEN TO WORK forever is the worst of the options: it is not worked by
        // the bot, which is done with it, and not by the broker, who has no
        // reason to open a card nothing points at. The owner's rule (04.09.2026):
        // after the third nudge with nothing back, close it.
        const silentHours = (Date.now() - lead.lastOurMessageAt!.getTime()) / 3_600_000;
        if (silentHours >= CLOSE_AFTER_LAST_NUDGE_HOURS) {
          const ok = await closeLeadAsLost(lead.leadId);
          logger.info(
            { leadId: lead.leadId, silentHours: Math.round(silentHours), nudges: lead.followupLevel },
            "listing closed: three nudges, no reply",
          );
          if (ok) {
            await db
              .update(leadsSyncTable)
              .set({ nextFollowupAt: null, updatedAt: new Date() })
              .where(eq(leadsSyncTable.leadId, lead.leadId));
          }
        }
        continue;
      }

      const silentHours = (Date.now() - lead.lastOurMessageAt!.getTime()) / 3_600_000;
      if (silentHours < NUDGE_AFTER_HOURS[round - 1]!) continue;

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
