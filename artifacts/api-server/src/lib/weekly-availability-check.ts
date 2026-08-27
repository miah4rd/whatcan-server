/**
 * Asks the owners of listings we already carry whether the villa is still free.
 *
 * The gap this closes: a listing looks available on the site right up until a
 * client asks for a viewing and the owner says it was taken weeks ago — by
 * another agent, without telling us. We only ever learned after the client was
 * already disappointed. So once a week we ask, and the answer goes back to the
 * site.
 *
 * Why this is its own pass, and NOT the follow-up scheduler:
 *
 * The scheduler's templated outbound is driven by `qualification_steps`, which
 * is ONE setting shared by every pipeline and is written for a BUYER. Sending
 * it on this funnel is not a hypothetical — villa owners were once queued
 * "Saw you grabbed the guide, ! 👋 Bali's still outperforming most markets on
 * rental returns", empty name and all, which is why followup-scheduler.ts hard-
 * blocks the whole Rental Listings pipeline. That block stays. This pass writes
 * its own message instead, so nothing owner-facing can ever inherit the buyer
 * script by accident.
 *
 * No AI, on purpose. The question is fixed, the answer is a date, and a model
 * that rephrases "is it still available?" every week gives the owner a reason
 * to wonder what changed. A broker still approves before it sends.
 */
import { db, leadsSyncTable, pendingSuggestionsTable, sentMessagesTable } from "@workspace/db";
import { and, eq, sql, desc } from "drizzle-orm";
import { logger } from "./logger";
import { amoFetch } from "./amo-client";
import { isListingAcquisition } from "./pipelines";

/** The stage that means "we asked this week". Matches amoCRM case-insensitively. */
const WEEKLY_CHECK_STAGE = "weekly check sent";

/**
 * How long a check stays good. A villa that entered the funnel two days ago was
 * confirmed two days ago — asking again is noise to the owner and teaches them
 * to ignore us.
 */
const CHECK_INTERVAL_DAYS = 7;

/** The owner sees this. Keep it short enough to answer from a lock screen. */
function composeMessage(ownerName: string, villa: string): string {
  const who = ownerName ? ` ${ownerName}` : "";
  return (
    `Hi${who}, quick check on ${villa} — is it still available? ` +
    `We have a client looking.\n\n` +
    `If it's taken, when does it free up? Thanks!`
  );
}

/**
 * The card title carries the villa, but in two shapes the scout and the site
 * import each produce:
 *   "R-YUD-002 - 2BR Umalas (owner: Bram)"
 *   "Casa Emilia - 2BR 3-storey Pererenan | 450M/yr (37.5M/mo)"
 * Take the leading name and drop the trailing spec, rather than sending the
 * owner their own price list back.
 */
export function villaFromLeadName(name: string): string {
  const head = (name ?? "").split("|")[0]!.trim();
  const beforeSpec = head.split(/\s-\s/)[0]!.trim();
  const cleaned = beforeSpec.replace(/\s*\(owner[^)]*\)\s*$/i, "").trim();
  return cleaned || head || "your villa";
}

/**
 * Is this "name" actually the villa wearing a person's slot?
 *
 * Scout cards are often created with the property as the contact — "Casa
 * Emilia", "Villa Azul Canggu (Google Maps)" — because that is all the advert
 * gave. Greeting that contact by "name" produces "Hi Casa, quick check on Casa
 * Emilia", which tells the owner immediately that a machine wrote it. No
 * greeting at all reads as normal shorthand; a wrong one does not.
 */
function looksLikeTheVilla(name: string, villa: string): boolean {
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const nameWords = norm(name);
  const villaWords = new Set(norm(villa));
  if (nameWords.length === 0) return false;
  if (nameWords.some((w) => villaWords.has(w))) return true;
  return /\b(villa|casa|resort|residence|suites?|property|management|maps)\b/i.test(name);
}

async function fetchOwnerName(leadId: string, villa: string): Promise<string> {
  try {
    const lead = await amoFetch<{ _embedded?: { contacts?: Array<{ id: number }> } }>(
      `/api/v4/leads/${leadId}?with=contacts`,
    );
    const contactId = lead?._embedded?.contacts?.[0]?.id;
    if (!contactId) return "";
    const contact = await amoFetch<{ name?: string }>(`/api/v4/contacts/${contactId}`);
    const name = (contact?.name ?? "").trim();
    // Scout cards sometimes carry a placeholder or a bare phone number as the
    // contact name. "Hi 62812..." is worse than no name at all.
    if (!name || /^\+?\d[\d\s()-]*$/.test(name) || /^<|dummy|test lead|full_name/i.test(name)) return "";
    if (looksLikeTheVilla(name, villa)) return "";
    return name.split(/\s+/)[0]!;
  } catch {
    return "";
  }
}

async function fetchLeadTitle(leadId: string): Promise<string> {
  try {
    const lead = await amoFetch<{ name?: string }>(`/api/v4/leads/${leadId}`);
    return (lead?.name ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * Queue one availability check per due listing. Returns how many were written.
 */
export async function processWeeklyAvailabilityCheck(): Promise<number> {
  const candidates = await db
    .select({
      leadId: leadsSyncTable.leadId,
      responsibleUser: leadsSyncTable.responsibleUser,
      pipeline: leadsSyncTable.pipeline,
      leadStage: leadsSyncTable.leadStage,
      botExcluded: leadsSyncTable.botExcluded,
    })
    .from(leadsSyncTable)
    .where(sql`lower(${leadsSyncTable.leadStage}) LIKE ${"%" + WEEKLY_CHECK_STAGE + "%"}`);

  if (candidates.length === 0) return 0;

  let queued = 0;
  for (const lead of candidates) {
    try {
      if (lead.botExcluded) continue;
      // Belt and braces: the stage name is the trigger, but only this funnel
      // has owners to ask. A same-named stage on a client funnel would be a
      // client receiving "is your villa available".
      if (!isListingAcquisition(lead.pipeline)) continue;

      // Already waiting for a broker — don't stack a second identical draft on
      // the same card every five minutes.
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

      // The cadence gate. Measured from what we actually SENT, not from the
      // card's updated_at: amoCRM stamps that on any edit at all, so a card
      // touched for an unrelated reason would look freshly checked. A listing
      // that has never been asked has no row here and goes out on this pass.
      const [lastSent] = await db
        .select({ sentAt: sentMessagesTable.createdAt })
        .from(sentMessagesTable)
        .where(eq(sentMessagesTable.leadId, lead.leadId))
        .orderBy(desc(sentMessagesTable.createdAt))
        .limit(1);

      if (lastSent?.sentAt) {
        const ageDays = (Date.now() - lastSent.sentAt.getTime()) / 86_400_000;
        if (ageDays < CHECK_INTERVAL_DAYS) continue;
      }

      const title = await fetchLeadTitle(lead.leadId);
      const villa = villaFromLeadName(title);
      const owner = await fetchOwnerName(lead.leadId, villa);

      await db.insert(pendingSuggestionsTable).values({
        leadId: lead.leadId,
        responsibleUser: lead.responsibleUser,
        // REACH is kind=push filtered by stage name — see REACH_STAGE_KEYWORDS
        // in lib/pipelines.ts. This row reaches the broker's REACH tab because
        // its stage is "Weekly Check Sent", not because of anything set here.
        kind: "push",
        suggestionText: composeMessage(owner, villa),
        status: "pending",
      });

      queued++;
      logger.info(
        { leadId: lead.leadId, villa, owner: owner || "(no name)" },
        "weekly-availability: queued an availability check for the listing owner",
      );
    } catch (err) {
      logger.error({ err, leadId: lead.leadId }, "weekly-availability: check failed for this listing");
    }
  }

  if (queued > 0) logger.info({ queued }, "weekly-availability pass complete");
  return queued;
}
