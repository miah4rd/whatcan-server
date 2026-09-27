/**
 * Drafts no cleaner may delete (owner, 27.09.2026): the "client waiting for the owner's answer" chain
 * (lib/os/availability-ask.ts) — the question item, the question to the client "which one?", the question
 * to the villa owner and the reply written from the answer. Each exists BECAUSE the conversation looks
 * finished (we spoke last, or the client wrote again), which is exactly what every cleaner reads as
 * "stale": the first "which one?" draft for a test client was written and silently deleted within
 * minutes. Every delete of pending drafts adds this condition.
 */
import { pendingSuggestionsTable } from "@workspace/db";
import { sql } from "drizzle-orm";

export const PROTECTED_VERDICT_PREFIX = "availability ";

/** Also the draft written from a viewing report and the viewing-day confirmation (27.09.2026): the
 * report's own next-step task is in the future, and a PUSH on a card with a future task was deleted —
 * 5 of 7 "new options" reports of September ended with no draft at all. */
export const PROTECTED_VERDICTS = ["viewing report filed", "viewing day confirmation"];

export const notProtectedDraft = () =>
  sql`(coalesce(${pendingSuggestionsTable.autopilotSkippedReason}, '') NOT LIKE ${PROTECTED_VERDICT_PREFIX + "%"} AND coalesce(${pendingSuggestionsTable.autopilotSkippedReason}, '') NOT IN (${sql.join(PROTECTED_VERDICTS.map((v) => sql`${v}`), sql`, `)}))`;
