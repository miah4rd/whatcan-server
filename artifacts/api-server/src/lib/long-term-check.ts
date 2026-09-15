/**
 * Leaving long term, two weeks before the date the owner named.
 *
 * A villa let for six or twelve months is parked, not lost — and the whole value of parking it is
 * being FIRST when it frees up. The owner's rule (2026-09-05): about two weeks before the date, an
 * update on availability. The long term regulation (2026-09-15, §6) makes it a move as well as a
 * message: the card goes back to TAKEN TO WORK and the bot asks two things — is the villa free from
 * the date they gave, and is the price the same. Confirmed → QUALIFIED; a new far date → parked again
 * with a new field and task; silence → the ordinary nudges and their close.
 *
 * Until 15.09 this pass almost never found a card: the stage engine released a parked card as soon
 * as its date came inside 90 days, long before the two-week mark. Now the engine holds the card until
 * the mark, this pass asks the engine to judge the cards that reached it, and the ENGINE moves the
 * card and calls `writeAvailabilityCheckDraft` — so a move made by the daily audit asks the same
 * question.
 *
 * No AI in the message: the question is the same every time. It carries whatever the card is still
 * missing and the thread has not already answered (owner-thread-known.ts, 14.09.2026), in the owner's
 * language and in Yudi's words (listing-owner-followup.ts `ownerAskLines`).
 */
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { villaFromLeadName, fetchLeadTitle, fetchOwnerName } from "./weekly-availability-check";
import { meetsQualified, type ListingFacts } from "./listing-card-fields";
import { ownerThreadKnown } from "./owner-thread-known";
import { ownerThreadLanguage, type OwnerLang } from "./yudi-voice";
import { nudgeAsks, ownerAskLines, ownerGreeting, spokenVilla, type NudgeAsk } from "./listing-owner-followup";
import { maybeAutopilot } from "./autopilot";
import { reconcileListingStage } from "./listing-stage-engine";

/** The stamp drafts written before 15.09.2026 carry. New drafts go through autopilot like a nudge. */
export const AVAILABILITY_CHECK_VERDICT = "availability check due";
const LEAD_DAYS = 14;
const BATCH_LIMIT = 10;
/** A card that was due and did not move is tried again after this long, not on every tick. */
const RETRY_AFTER_MS = 60 * 60 * 1000;
const lastTried = new Map<string, number>();

export type RateToConfirm = { idr: number; per: "month" | "year"; commission: ListingFacts["commission"] };

export function composeAvailabilityCheck(o: {
  owner: string;
  villa: string;
  freeFrom: Date;
  lang: OwnerLang;
  /** Open qualification points only — bedrooms, price, commission. */
  asks: NudgeAsk[];
  needPhotos: boolean;
  needPin: boolean;
  /** The rate the owner gave, to confirm it still stands (§6). Replaces the price asks. */
  rate?: RateToConfirm | null;
  at?: Date;
}): string {
  const g = ownerGreeting(o.owner, o.lang, o.at);
  const asks = o.asks.filter((a) => a === "bedrooms" || (!o.rate && (a === "price" || a === "price_plain" || a === "commission")));
  const millions = o.rate ? Math.round(o.rate.idr / 1_000_000) : 0;
  const lines = [g.line];
  if (o.lang === "id") {
    const when = o.freeFrom.toLocaleDateString("id-ID", { day: "numeric", month: "long", timeZone: "Asia/Makassar" });
    lines.push(`Sebelumnya info dari ${g.call} ${spokenVilla(o.villa) || "villanya"} kosong mulai sekitar ${when}, apakah masih sesuai rencana ya ${g.call}?`);
    if (o.rate) {
      const incl = o.rate.commission === "included" ? " sudah termasuk 10% komisi agensi" : o.rate.commission === "net" ? " belum termasuk 10% komisi agensi" : "";
      lines.push(`Untuk harganya masih ${millions} juta per ${o.rate.per === "month" ? "bulan" : "tahun"}${incl} ya ${g.call}?`);
    }
    lines.push(...ownerAskLines(asks, { lang: "id", villa: o.villa, call: g.call }));
    const media = [o.needPhotos && "photo", o.needPin && "titik lokasi"].filter(Boolean).join(" dan ");
    if (media) lines.push(`Boleh di bantu share ${media} villanya ya ${g.call}, supaya bisa kami siapkan listingnya pas kosong?`);
    lines.push("Terimakasih");
  } else {
    const when = o.freeFrom.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Asia/Makassar" });
    lines.push(`When we spoke you mentioned ${spokenVilla(o.villa) || "the villa"} would be free from around ${when}, is that still the plan?`);
    if (o.rate) {
      const incl = o.rate.commission === "included" ? ", including our 10% agency commission" : o.rate.commission === "net" ? ", before our 10% agency commission" : "";
      lines.push(`And is the price still IDR ${millions} million per ${o.rate.per}${incl}?`);
    }
    lines.push(...ownerAskLines(asks, { lang: "en", villa: o.villa }));
    const media = [o.needPhotos && "some pictures", o.needPin && "the exact pin location"].filter(Boolean).join(" and ");
    if (media) lines.push(`Would you please share ${media}, so we can have it listed the day it frees up?`);
    lines.push("Thank you");
  }
  return lines.join("\n");
}

/**
 * The two questions of §6, as a draft on a card the engine has just moved back to TAKEN TO WORK.
 * Handed to autopilot the moment it is written, like an owner nudge: it sends in outreach hours or
 * stamps the draft as the bot's. One pending draft per card: if one is already waiting, it stands.
 */
export async function writeAvailabilityCheckDraft(leadId: string, freeFrom: Date, facts: ListingFacts | null): Promise<boolean> {
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pendingSuggestionsTable)
    .where(and(eq(pendingSuggestionsTable.leadId, leadId), eq(pendingSuggestionsTable.status, "pending")));
  if ((pending?.n ?? 0) > 0) {
    logger.info({ leadId }, "long-term check: a draft is already pending on this card — no second one");
    return false;
  }
  const [lead] = await db
    .select({ responsibleUser: leadsSyncTable.responsibleUser })
    .from(leadsSyncTable)
    .where(eq(leadsSyncTable.leadId, leadId))
    .limit(1);
  const title = await fetchLeadTitle(leadId);
  const villa = villaFromLeadName(title);
  const owner = await fetchOwnerName(leadId, villa);
  const known = await ownerThreadKnown(leadId);
  const f = facts ?? known.facts;
  const asks = nudgeAsks(known, f ? meetsQualified(f).missing : null);
  const rate: RateToConfirm | null = f?.monthlyIdr
    ? { idr: f.monthlyIdr, per: "month", commission: f.commission }
    : f?.yearlyIdr
      ? { idr: f.yearlyIdr, per: "year", commission: f.commission }
      : null;
  const text = composeAvailabilityCheck({
    owner,
    villa,
    freeFrom,
    lang: ownerThreadLanguage(known.lines),
    asks,
    needPhotos: !known.known.photos,
    needPin: !known.known.pin,
    rate,
  });
  await db.insert(pendingSuggestionsTable).values({
    leadId,
    responsibleUser: lead?.responsibleUser ?? null,
    kind: "push",
    suggestionText: text,
    status: "pending",
  });
  logger.info({ leadId, villa, freeFrom }, "long-term check: re-confirm draft written, card back in TAKEN TO WORK");
  void maybeAutopilot(leadId);
  return true;
}

/** Parked cards whose free date is two weeks away or closer: the engine judges each (and moves it). */
export async function processLongTermAvailabilityChecks(): Promise<number> {
  let moved = 0;
  try {
    const due = await db
      .select({ leadId: leadsSyncTable.leadId })
      .from(leadsSyncTable)
      .where(
        and(
          sql`lower(${leadsSyncTable.pipeline}) = 'rental listings'`,
          sql`lower(coalesce(${leadsSyncTable.leadStage},'')) LIKE '%long term%'`,
          sql`${leadsSyncTable.botExcluded} IS NOT TRUE`,
          sql`${leadsSyncTable.listingFreeFrom} IS NOT NULL`,
          sql`${leadsSyncTable.listingFreeFrom} - make_interval(days => ${LEAD_DAYS}) <= now()`,
        ),
      )
      .limit(BATCH_LIMIT * 5);

    const now = Date.now();
    for (const lead of due.filter((l) => now - (lastTried.get(l.leadId) ?? 0) >= RETRY_AFTER_MS).slice(0, BATCH_LIMIT)) {
      lastTried.set(lead.leadId, now);
      try {
        const r = await reconcileListingStage(lead.leadId, { source: "long-term-check" });
        if (r.applied) moved++;
        else logger.warn({ leadId: lead.leadId, reason: r.reason }, "long-term check: free date two weeks away, card not moved");
      } catch (err) {
        logger.error({ err, leadId: lead.leadId }, "long-term check: failed for this card");
      }
    }
  } catch (err) {
    logger.error({ err }, "long-term check pass failed");
  }
  if (moved > 0) logger.info({ moved }, "long-term check pass complete");
  return moved;
}
