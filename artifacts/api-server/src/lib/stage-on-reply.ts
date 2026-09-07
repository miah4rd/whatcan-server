/**
 * Stage classification for replies the broker sent OUTSIDE Copilot.
 *
 * The classifier ran only on the approve path, so a viewing Amelia confirmed
 * from her phone moved nothing: three viewings were agreed in one week (Liu
 * 05.09, Alena 07.09, Lorenzo 09.09) and the CRM showed one. Any report built
 * on stages was wrong, and "Viewing done" was never set by anyone.
 *
 * Both manual-reply detectors (the webhook and the timeline sweep) call this
 * ONE function, with the same guards approve.ts applies: closing stages are
 * never auto-applied, a lead on the REACH ladder is never pulled off it, and
 * the id is resolved against the funnel amoCRM says the lead is in.
 *
 * When the stage lands on "Viewing scheduled", the viewing's date and time are
 * read from the thread and stored, so the outcome pass knows when to ask what
 * happened.
 */
import { db, leadsSyncTable, leadMessagesTable, stageEventsTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { classifyStage, safeStageIdForLead } from "./stage-classifier";
import { getAmoLead, updateLeadStatus } from "./amo-client";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";

const BALI = "Asia/Makassar";

function fmt(d: Date): string {
  return d.toLocaleString("en-GB", { timeZone: BALI, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** The last N messages as one readable transcript, oldest first. */
async function transcript(leadId: string, n = 30): Promise<{ text: string; lastOurs: string | null }> {
  const rows = await db
    .select({ who: leadMessagesTable.senderType, at: leadMessagesTable.sentAt, text: leadMessagesTable.text })
    .from(leadMessagesTable)
    .where(and(eq(leadMessagesTable.leadId, leadId), sql`${leadMessagesTable.text} IS NOT NULL`))
    .orderBy(desc(leadMessagesTable.sentAt))
    .limit(n);
  const ordered = rows.reverse();
  const lastOurs = [...ordered].reverse().find((r) => r.who !== "lead")?.text ?? null;
  const text = ordered
    .map((r) => `${fmt(r.at)} ${r.who === "lead" ? "Client" : "Broker"}: ${(r.text ?? "").replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return { text, lastOurs };
}

/**
 * When is the viewing? Read from the thread, as an absolute Bali time.
 * "Tomorrow at 3" only means something next to the date it was written on, so
 * every line carries its timestamp and the model is told what "now" is.
 */
export async function extractViewingAt(threadText: string): Promise<Date | null> {
  const now = new Date();
  const out = await chatCompletionJSON<{ viewing_at: string | null }>({
    model: HELPER_MODEL,
    label: "viewing:extract-datetime",
    max_tokens: 120,
    temperature: 0,
    system: `Now is ${fmt(now)} (day/month, Bali time, year ${now.getFullYear()}). Every line in the thread starts with the date and time it was written.
Answer ONE question: has a property viewing been AGREED with a concrete date and time (a slot the client accepted, or one both sides confirmed)? If yes, return it as an ISO datetime in the Asia/Makassar zone (+08:00). If a viewing is only offered, requested, or being checked, return null.
Relative words ("tomorrow", "Wednesday") are relative to the line they appear in, not to now.
JSON only: {"viewing_at": "2026-09-07T15:00:00+08:00" | null}`,
    messages: [{ role: "user", content: threadText.slice(-6000) }],
  }).catch(() => null);
  const iso = out?.viewing_at;
  if (!iso || typeof iso !== "string") return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // A viewing more than 60 days out or more than 2 days in the past is a misread.
  const delta = d.getTime() - now.getTime();
  if (delta > 60 * 86_400_000 || delta < -2 * 86_400_000) return null;
  return d;
}

export type StageApplyResult = { moved: boolean; from?: string | null; to?: string; reason: string; viewingAt?: Date | null };

/**
 * Classify the conversation as it stands after the broker's newest message and
 * apply the stage. Safe to call repeatedly: an unchanged verdict is a no-op.
 */
export async function classifyAndApplyStage(
  leadId: string,
  opts: { source: "manual-reply" | "backfill" | "viewing-outcome"; apply?: boolean; replyText?: string },
): Promise<StageApplyResult> {
  const apply = opts.apply !== false;
  const [row] = await db
    .select({
      pipeline: leadsSyncTable.pipeline,
      leadStage: leadsSyncTable.leadStage,
      responsibleUser: leadsSyncTable.responsibleUser,
      botExcluded: leadsSyncTable.botExcluded,
    })
    .from(leadsSyncTable)
    .where(eq(leadsSyncTable.leadId, leadId))
    .limit(1);
  if (!row || row.botExcluded) return { moved: false, reason: "no row or bot excluded" };

  const stageLower = (row.leadStage ?? "").toLowerCase();
  if (/1st follow up|2nd follow up|final follow up/.test(stageLower)) {
    return { moved: false, reason: "on the REACH ladder — never pulled off it by a classification" };
  }

  const { text, lastOurs } = await transcript(leadId);
  if (!text.trim()) return { moved: false, reason: "no thread" };

  const cls = await classifyStage({
    pipeline: row.pipeline,
    currentStage: row.leadStage,
    conversationText: text,
    replyText: opts.replyText ?? lastOurs ?? "",
    attachmentsCount: 0,
  });
  if (!cls) return { moved: false, reason: "classifier: nothing to change" };
  if (cls.terminal) return { moved: false, reason: `terminal stage "${cls.stage.name}" is the broker's tap`, to: cls.stage.name };
  const toLower = (cls.stage.name ?? "").toLowerCase();
  if (toLower === stageLower) return { moved: false, reason: "already there" };
  // A viewing is a fact, not a mood. This path never pulls a card back out of
  // a viewing stage: "Viewing done" is history, and "Viewing scheduled" only
  // moves forward (to done) — a client reviewing other options after booking
  // a slot has not un-booked it. The dry run proposed exactly that regression
  // on three cards; approve.ts keeps its own judgement for the broker's sends.
  const isViewingStage = (s: string) => /viewing/.test(s);
  if (isViewingStage(stageLower) && !isViewingStage(toLower)) {
    return { moved: false, reason: `would leave a viewing stage (${row.leadStage} -> ${cls.stage.name}) — not by this path`, to: cls.stage.name };
  }
  if (/viewing\s*done/.test(stageLower)) {
    return { moved: false, reason: "Viewing done is history — never moved from here automatically", to: cls.stage.name };
  }

  const isViewingScheduled = /viewing\s*(scheduled|booked|arranged)/i.test(cls.stage.name);
  const viewingAt = isViewingScheduled ? await extractViewingAt(text) : null;

  if (!apply) return { moved: false, from: row.leadStage, to: cls.stage.name, reason: `would move: ${cls.reason}`, viewingAt };

  const lead = await getAmoLead(leadId);
  if (!lead?.pipeline_id) return { moved: false, reason: "amoCRM did not return the lead's funnel" };
  const { id } = await safeStageIdForLead({ pipelineId: lead.pipeline_id, stageId: String(cls.stage.id), stageName: cls.stage.name });
  if (!id) return { moved: false, reason: `stage "${cls.stage.name}" not in the lead's funnel` };

  const ok = await updateLeadStatus(leadId, Number(id));
  if (!ok) return { moved: false, reason: "amoCRM refused the stage change" };

  await db
    .update(leadsSyncTable)
    .set({
      leadStage: cls.stage.name,
      leadStageId: id,
      ...(isViewingScheduled ? { viewingAt } : {}),
      updatedAt: new Date(),
    })
    .where(eq(leadsSyncTable.leadId, leadId));
  await db
    .insert(stageEventsTable)
    .values({ leadId, fromStage: row.leadStage, toStage: cls.stage.name, pipeline: row.pipeline, responsibleUser: row.responsibleUser })
    .catch(() => undefined);
  logger.info(
    { leadId, from: row.leadStage, to: cls.stage.name, viewingAt, source: opts.source, reason: cls.reason },
    "stage applied from the conversation (outside the approve path)",
  );
  return { moved: true, from: row.leadStage, to: cls.stage.name, reason: cls.reason, viewingAt };
}
