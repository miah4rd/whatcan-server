/**
 * The dated availability check on a "long term" card.
 *
 * A villa let for six or twelve months is parked, not lost — and the whole
 * value of parking it is being FIRST when it frees up. The parking used to
 * leave only an amoCRM task fourteen days before the date; the broker saw a
 * task and an empty Copilot, and wrote the message himself or not at all. The
 * owner's rule (2026-09-05): about two weeks before the date, an update on
 * availability, as a ready draft.
 *
 * No AI: the question is the same every time. It carries whatever the card is
 * still missing (price with our commission, bedrooms) and the thread has not
 * already answered (owner-thread-known.ts, 14.09.2026), in the owner's language
 * and in Yudi's words (listing-owner-followup.ts `ownerAskLines`), so a "yes,
 * still free" can arrive with the facts that let it go straight to Details.
 *
 * One draft per free date. The stamp on the draft is both what makes the inbox
 * show it on a suppressed stage and this pass's memory that it was written.
 */
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { and, sql } from "drizzle-orm";
import { logger } from "./logger";
import { villaFromLeadName, fetchLeadTitle, fetchOwnerName } from "./weekly-availability-check";
import { meetsQualified } from "./listing-card-fields";
import { ownerThreadKnown } from "./owner-thread-known";
import { ownerThreadLanguage, type OwnerLang } from "./yudi-voice";
import { nudgeAsks, ownerAskLines, ownerGreeting, spokenVilla, type NudgeAsk } from "./listing-owner-followup";

export const AVAILABILITY_CHECK_VERDICT = "availability check due";
const LEAD_DAYS = 14;
const BATCH_LIMIT = 10;

export function composeAvailabilityCheck(o: {
  owner: string;
  villa: string;
  freeFrom: Date;
  lang: OwnerLang;
  /** Open qualification points only — bedrooms, price, commission. */
  asks: NudgeAsk[];
  needPhotos: boolean;
  needPin: boolean;
  at?: Date;
}): string {
  const g = ownerGreeting(o.owner, o.lang, o.at);
  const asks = o.asks.filter((a) => a === "bedrooms" || a === "price" || a === "price_plain" || a === "commission");
  const lines = [g.line];
  if (o.lang === "id") {
    const when = o.freeFrom.toLocaleDateString("id-ID", { day: "numeric", month: "long", timeZone: "Asia/Makassar" });
    lines.push(`Sebelumnya info dari ${g.call} ${spokenVilla(o.villa) || "villanya"} kosong mulai sekitar ${when}, apakah masih sesuai rencana ya ${g.call}?`);
    lines.push(...ownerAskLines(asks, { lang: "id", villa: o.villa, call: g.call }));
    const media = [o.needPhotos && "photo", o.needPin && "titik lokasi"].filter(Boolean).join(" dan ");
    if (media) lines.push(`Boleh di bantu share ${media} villanya ya ${g.call}, supaya bisa kami siapkan listingnya pas kosong?`);
    lines.push("Terimakasih");
  } else {
    const when = o.freeFrom.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Asia/Makassar" });
    lines.push(`When we spoke you mentioned ${spokenVilla(o.villa) || "the villa"} would be free from around ${when}, is that still the plan?`);
    lines.push(...ownerAskLines(asks, { lang: "en", villa: o.villa }));
    const media = [o.needPhotos && "some pictures", o.needPin && "the exact pin location"].filter(Boolean).join(" and ");
    if (media) lines.push(`Would you please share ${media}, so we can have it listed the day it frees up?`);
    lines.push("Thank you");
  }
  return lines.join("\n");
}

export async function processLongTermAvailabilityChecks(): Promise<number> {
  let queued = 0;
  try {
    const due = await db
      .select({
        leadId: leadsSyncTable.leadId,
        responsibleUser: leadsSyncTable.responsibleUser,
        freeFrom: leadsSyncTable.listingFreeFrom,
      })
      .from(leadsSyncTable)
      .where(
        and(
          sql`lower(${leadsSyncTable.pipeline}) = 'rental listings'`,
          sql`lower(coalesce(${leadsSyncTable.leadStage},'')) LIKE '%long term%'`,
          sql`${leadsSyncTable.botExcluded} IS NOT TRUE`,
          sql`${leadsSyncTable.listingFreeFrom} IS NOT NULL`,
          // Belt and braces with the store-side guard: never draft about a date
          // that has already passed.
          sql`${leadsSyncTable.listingFreeFrom} > now()`,
          sql`${leadsSyncTable.listingFreeFrom} - make_interval(days => ${LEAD_DAYS}) <= now()`,
          // Not already written for this date, and nothing else pending.
          sql`NOT EXISTS (SELECT 1 FROM pending_suggestions p WHERE p.lead_id = ${leadsSyncTable.leadId}
                 AND (p.status = 'pending'
                      OR (p.autopilot_skipped_reason = ${AVAILABILITY_CHECK_VERDICT}
                          AND p.autopilot_skipped_at >= ${leadsSyncTable.listingFreeFrom} - make_interval(days => ${LEAD_DAYS + 1}))))`,
        ),
      )
      .limit(BATCH_LIMIT);

    for (const lead of due) {
      try {
        const title = await fetchLeadTitle(lead.leadId);
        const villa = villaFromLeadName(title);
        const owner = await fetchOwnerName(lead.leadId, villa);
        const known = await ownerThreadKnown(lead.leadId);
        const asks = nudgeAsks(known, known.facts ? meetsQualified(known.facts).missing : null);
        const text = composeAvailabilityCheck({
          owner,
          villa,
          freeFrom: lead.freeFrom!,
          lang: ownerThreadLanguage(known.lines),
          asks,
          needPhotos: !known.known.photos,
          needPin: !known.known.pin,
        });
        await db.insert(pendingSuggestionsTable).values({
          leadId: lead.leadId,
          responsibleUser: lead.responsibleUser,
          kind: "push",
          suggestionText: text,
          status: "pending",
          autopilotSkippedReason: AVAILABILITY_CHECK_VERDICT,
          autopilotSkippedAt: new Date(),
        });
        queued++;
        logger.info({ leadId: lead.leadId, villa, freeFrom: lead.freeFrom }, "long-term check: availability draft written for the broker");
      } catch (err) {
        logger.error({ err, leadId: lead.leadId }, "long-term check: failed for this card");
      }
    }
  } catch (err) {
    logger.error({ err }, "long-term check pass failed");
  }
  if (queued > 0) logger.info({ queued }, "long-term check pass complete");
  return queued;
}
