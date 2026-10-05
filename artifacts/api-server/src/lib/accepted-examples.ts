/**
 * An approve without an edit is a lesson too (owner, 26.09.2026).
 *
 * The owner's model of Copilot: every approve is a micro-agreement with the team. Until now only an
 * EDIT taught the bot (learnFromRevision → broker_corrections); a draft the broker sent untouched
 * taught nothing, so the bot kept no memory of "this is what a person accepted". Now the newest
 * drafts a broker approved unchanged, in the same conversation moment, go into the prompt as
 * accepted examples: the shape, length and tone to repeat. Nothing here changes a rule — rules live
 * in skills/ and are the owner's; this is only how the bot writes.
 *
 * Read from pending_suggestions: status 'approved', not auto-sent, and the text that went out is the
 * text the bot proposed (final_text empty or equal to suggestion_text). Autopilot's own sends are
 * never examples — they were never approved by anyone.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { SITUATION_CASE } from "./situation-sql";
import { logger } from "./logger";

const WINDOW_DAYS = 30;
const MAX_CHARS = 420;

export async function acceptedExamples(
  brokerName: string | null | undefined,
  situation: string | null | undefined,
  limit = 4,
): Promise<string[]> {
  const who = (brokerName ?? "").trim().toLowerCase();
  if (!who) return [];
  try {
    const res = await db.execute(sql`
      SELECT coalesce(nullif(p.final_text, ''), p.suggestion_text) AS text
        FROM pending_suggestions p
        JOIN leads_sync l ON l.lead_id = p.lead_id
       WHERE p.status IN ('approved', 'edited')
         AND coalesce(p.auto_sent, false) = false
         AND lower(coalesce(p.responsible_user, '')) = ${who}
         AND p.created_at > now() - make_interval(days => ${WINDOW_DAYS})
         AND length(coalesce(nullif(p.final_text, ''), p.suggestion_text)) BETWEEN 20 AND 1200
         AND (${sql.raw(SITUATION_CASE)}) = ${situation ?? "options"}
       ORDER BY p.created_at DESC
       LIMIT ${limit}
    `);
    const rows = ((res as unknown as { rows?: Array<{ text: string }> }).rows ?? []) as Array<{ text: string }>;
    return rows.map((r) => r.text.trim()).filter(Boolean);
  } catch (err) {
    logger.warn({ err, brokerName, situation }, "accepted examples: query failed — none used");
    return [];
  }
}

/** The prompt block, or "" when the broker has approved nothing unchanged in this situation lately. */
export async function acceptedExamplesBlock(brokerName: string | null | undefined, situation: string | null | undefined): Promise<string> {
  const ex = await acceptedExamples(brokerName, situation);
  if (!ex.length) return "";
  const clip = (t: string) => (t.length > MAX_CHARS ? t.slice(0, MAX_CHARS).trimEnd() + "…" : t);
  // The structure travels, the facts do not (owner, 05.10.2026): a sent message carried its client's
  // name, dates, budget and wishes ("no pets or kids, workspace not needed") into eight other clients'
  // drafts. Names after a greeting, figures, dates, villa list lines and links are blanked here.
  const blank = (t: string) =>
    t
      .replace(/^((?:hi|hello|hey|halo|hai|dear|selamat \w+)[ ,]+)([^\s!,.]+(?: [A-Z][^\s!,.]*)?)/gim, "$1{name}")
      .replace(/https?:\/\/\S+/g, "{link}")
      .replace(/^\s*\d+\.\s.*$/gm, "{villa line}")
      .replace(/\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi, "{date}")
      .replace(/\b(rp\.?\s*)?\d[\d.,]*\s*(million|mil|jt|juta|m)?\b/gi, "{number}");
  return (
    // Owner, 27.09: what the broker last SENT in this moment is the structure of this stage's message —
    // an edit included. It outranks the lessons above where they differ.
    `\n\nTHE BROKER'S OWN MESSAGES IN THIS SAME SITUATION, newest first — what they actually sent (edited or as drafted). ` +
    `The FIRST one is the current structure of this message: write yours with the same questions, in the same order, the same greeting, self-introduction and sign-off, the same length and tone; only the facts about this villa or client change (the facts, names and villas below are NOT for reuse). Where a preference above disagrees with it, the broker's latest message wins:\n` +
    ex.map((t) => `«${clip(blank(t)).replace(/\n{2,}/g, "\n").replace(/\n/g, " ⏎ ")}»`).join("\n")
  );
}
