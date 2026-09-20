/**
 * A card someone else took back out of QUALIFIED stays out until the owner answers (owner, 19.09.2026).
 *
 * Two agents judge a listing card. The stage engine promotes on the facts in the thread; the listing
 * manager (Cowork) returns a card it cannot publish and writes why on the card: "RETURNED TO TAKEN TO
 * WORK <date> - <reason>", usually with "QUESTION FOR THE BOT, to send as is: "…"". Until 19.09 the
 * engine read the same unchanged facts on its next audit and promoted the card again, the manager
 * returned it again, and the bot never asked the question: the nudge pass found nothing missing in the
 * facts and stayed silent. Diraya (23567217) went QUALIFIED → back three times in four days with the
 * owner never asked for a monthly rate; Bersinar (23567313) four times.
 *
 * The owner's rule: "если инфы не хватает чтобы квалифицировать — нужно добрать инфы и
 * квалифицировать; убрать зацикленность". So:
 * - the engine does not promote a returned card again until the owner has written after the return;
 * - the nudge pass sends the manager's question, word for word, once, and then the usual ladder.
 *
 * "Returned" is read from what we can see: the engine's own last move put the card on QUALIFIED and
 * the card is now in TAKEN TO WORK — nobody records the way back in stage_events. The moment and the
 * question come from the manager's note; a return without a note (a person dragging the card) is
 * timed from amoCRM's status events and carries no question.
 */
import { db, stageEventsTable, leadMessagesTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { amoFetch } from "./amo-client";
import { LISTING_STAGE } from "./listing-status-week";
import { logger } from "./logger";

/** pending_suggestions.objection_category of a draft that is the manager's question, sent as is. */
export const MANAGER_QUESTION_CATEGORY = "listing_manager_question";

/** Stages at or past the bar: a card now in TAKEN TO WORK below one of these was moved back. */
const AT_OR_PAST_QUALIFIED = new Set<string>([
  "qualified (pre-listed)",
  "inspection sceduled",
  "live",
  "weekly check sent",
  "update availability received",
]);
const WORK_NAME = "taken to work";
const CACHE_MS = 10 * 60_000;

export type ReturnHold = {
  /** When the card was taken back out of QUALIFIED. */
  at: Date;
  /** The first line of the return note ("still no monthly rate from the owner."), or null. */
  reason: string | null;
  /** The question the manager left for the bot, verbatim, or null. */
  question: string | null;
};

const cache = new Map<string, { until: number; hold: ReturnHold | null; arrivalMs: number }>();

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** "RETURNED TO TAKEN TO WORK 19 Sep 2026 - still no monthly rate…" → the reason and the question. */
export function parseReturnNote(raw: string): { reason: string | null; question: string | null } | null {
  const text = decodeEntities(raw ?? "");
  // The manager writes the note freely: "RETURNED TO TAKEN TO WORK 19 Sep - …" one day, "REVIEWED
  // 20 Sep 2026, second pass of the daily listing run - NOT LISTED. Returned to TAKEN TO WORK." the
  // next. Matching only the first spelling lost Villa Antony's question (20.09). What identifies the
  // note is the question block, or the sentence saying the card went back.
  if (!/QUESTION FOR THE BOT/i.test(text) && !/returned to taken to work/i.test(text)) return null;
  const firstLine = (text.split("\n")[0] ?? "").slice(0, 300);
  const reason =
    firstLine.replace(/^\s*(RETURNED TO TAKEN TO WORK|REVIEWED)\b[^-–—]*[-–—]\s*/i, "").trim() || null;
  const m = text.match(/QUESTION FOR THE BOT[^\n]*\n+\s*["“]([\s\S]+?)["”]\s*(?:\n|$)/i);
  const question = m?.[1]?.trim() || null;
  return { reason, question };
}

type Note = { created_at: number; note_type?: string; params?: { text?: string } };

async function newestReturnNote(leadId: string): Promise<{ at: Date; reason: string | null; question: string | null } | null | undefined> {
  const d = await amoFetch<{ _embedded?: { notes?: Note[] } }>(
    `/api/v4/leads/${leadId}/notes?filter[note_type][]=common&order[id]=desc&limit=25`,
  );
  if (d === null) return undefined; // amoCRM did not answer — unknown, not "no note"
  for (const n of d._embedded?.notes ?? []) {
    const parsed = parseReturnNote(n.params?.text ?? "");
    if (parsed) return { at: new Date(n.created_at * 1000), ...parsed };
  }
  return null;
}

const PAST_BAR = new Set<number>([
  LISTING_STAGE.QUALIFIED,
  LISTING_STAGE.INSPECTION_SCHEDULED,
  LISTING_STAGE.LIVE,
  LISTING_STAGE.WEEKLY_CHECK_SENT,
  LISTING_STAGE.AVAILABILITY_RECEIVED,
]);

async function lastExitFromTheBar(leadId: string): Promise<Date | null | undefined> {
  const d = await amoFetch<{
    _embedded?: { events?: Array<{ created_at: number; value_before?: Array<{ lead_status?: { id?: number } }> }> };
  }>(`/api/v4/events?filter[entity]=lead&filter[entity_id][]=${leadId}&filter[type]=lead_status_changed&limit=50`);
  if (d === null) return undefined;
  const exits = (d._embedded?.events ?? [])
    .filter((e) => PAST_BAR.has(e.value_before?.[0]?.lead_status?.id ?? -1))
    .map((e) => e.created_at * 1000);
  return exits.length ? new Date(Math.max(...exits)) : null;
}

/**
 * The hold on a card that was taken back out of QUALIFIED by someone other than the engine, or null.
 * Fails closed: when amoCRM cannot be read, the card is held from now (not cached), so an outage never
 * lets the engine undo a person's return.
 */
export async function returnHold(leadId: string, currentStage: string | null | undefined): Promise<ReturnHold | null> {
  if (norm(currentStage) !== WORK_NAME) return null;
  const [last] = await db
    .select({ at: stageEventsTable.changedAt, to: stageEventsTable.toStage, by: stageEventsTable.responsibleUser })
    .from(stageEventsTable)
    .where(eq(stageEventsTable.leadId, leadId))
    .orderBy(desc(stageEventsTable.changedAt))
    .limit(1);
  // Returned from ANYWHERE at or past the bar, not only from QUALIFIED itself, and by anyone.
  // Villa Antony (23608407, 20.09) sat in Inspection sceduled (a person's move, so the last event
  // reads "Inspection sceduled"); the manager returned it to TAKEN TO WORK with a question, a
  // signature that knew only QUALIFIED saw nothing, and ten minutes later our own send put the card
  // back in QUALIFIED with the owner never asked.
  if (!last?.at || !AT_OR_PAST_QUALIFIED.has(norm(last.to))) return null;
  const arrivalMs = last.at.getTime();

  const hit = cache.get(leadId);
  if (hit && hit.arrivalMs === arrivalMs && Date.now() < hit.until) return hit.hold;

  const note = await newestReturnNote(leadId);
  let hold: ReturnHold | null;
  if (note && note.at.getTime() >= arrivalMs) {
    hold = { at: note.at, reason: note.reason, question: note.question };
  } else {
    const exit = await lastExitFromTheBar(leadId);
    if (note === undefined || exit === undefined) {
      logger.warn({ leadId }, "listing return hold: amoCRM unreadable — holding the card this round");
      return { at: new Date(), reason: null, question: null };
    }
    // The card was past the bar and is in TAKEN TO WORK now: somebody moved it. No event
    // found (older than the page) still means a return; time it from the engine's own arrival.
    hold = { at: exit && exit.getTime() >= arrivalMs ? exit : new Date(arrivalMs), reason: null, question: null };
  }
  cache.set(leadId, { until: Date.now() + CACHE_MS, hold, arrivalMs });
  return hold;
}

/** Has the owner written since the return? Then the facts may be judged again. */
export async function ownerWroteSince(leadId: string, at: Date): Promise<boolean> {
  const [n] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leadMessagesTable)
    .where(and(eq(leadMessagesTable.leadId, leadId), eq(leadMessagesTable.senderType, "lead"), sql`${leadMessagesTable.sentAt} > ${at}`));
  return (n?.n ?? 0) > 0;
}

/** Have we written to the owner since the return (the question already went, by the bot or by hand)? */
export async function weWroteSince(leadId: string, at: Date): Promise<boolean> {
  const [n] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leadMessagesTable)
    .where(and(eq(leadMessagesTable.leadId, leadId), sql`${leadMessagesTable.senderType} <> 'lead'`, sql`${leadMessagesTable.sentAt} > ${at}`));
  if ((n?.n ?? 0) > 0) return true;
  const r = await db.execute(
    sql`SELECT 1 AS x FROM sent_messages WHERE lead_id = ${leadId} AND created_at > ${at} AND webhook_status BETWEEN 200 AND 299 LIMIT 1`,
  );
  return ((r as unknown as { rows?: unknown[] }).rows ?? []).length > 0;
}
