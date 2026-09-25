/**
 * The viewing report: what the system cannot see because the viewing happens
 * in person.
 *
 * Until 08.09.2026 a viewing left no trace beyond "we are here" / "see you at
 * 12": four viewings were held in one week, and for none of them did the card
 * carry the client's verdict, their objections or the agreed next step. The
 * next draft was written blind, and the stage after the viewing was a guess.
 *
 * Half an hour after the slot the broker gets a push and an amoCRM task; the
 * card in PUSH carries a three-part form (outcome · the client's feedback ·
 * next steps). Filing it sets the stage, writes the notes, creates the
 * next-step task and rewrites the draft to the client from what was said.
 * Without a report for 24 hours the generic "how did the viewing go?" goes out
 * and the task turns overdue. Viewings are counted from reports only.
 */
import { db, viewingReportsTable, viewingSlotsTable, leadsSyncTable, leadMessagesTable, pendingSuggestionsTable, stageEventsTable } from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  getAmoLead,
  getOpenAmoTasks,
  createAmoTask,
  amoPatch,
  amoPost,
  amoFetch,
  updateLeadStatus,
  VIEWING_REPORT_TASK_PREFIX,
  NEXT_STEP_TASK_PREFIX,
  LISTING_STEP_TASK_PREFIX,
} from "./amo-client";
import { notifyBroker } from "./push-notifications";
import { brokerKey } from "./broker-identity";
import { chatCompletion, WRITER_MODEL } from "./ai-client";
import { generateSuggestion, applyViewingPush } from "./generate-suggestion";
import { getMergedDialog } from "./merged-conversation";
import { correctionsPromptBlock, deriveSituation } from "./broker-corrections";
import { leadPhone, siblingLeadIds } from "./phone-dedupe";
import { propertyForSlot, recordViewingSlot } from "./thread-stage-sync";
import { amoStageFor } from "./stage-classifier";
import { pipelineKind } from "./pipelines";
import { pool } from "@workspace/db";
import { isOwnStorageUrl } from "./site-storage";

/**
 * Photos and video the broker took at the viewing (owner, 19.09.2026: Amelia sometimes films the
 * villa; it goes into the report straight from her phone instead of being forgotten in the gallery).
 * Files live in the site's storage under viewings/<report id>/; the links go into the notes.
 */
let mediaTable: Promise<void> | null = null;
function ensureMediaTable(): Promise<void> {
  mediaTable ??= pool
    .query(`CREATE TABLE IF NOT EXISTS viewing_report_media (
      id BIGSERIAL PRIMARY KEY,
      report_id UUID NOT NULL,
      url TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (report_id, url)
    )`)
    .then(() => undefined)
    .catch((err) => {
      mediaTable = null;
      throw err;
    });
  return mediaTable;
}
const isVideoUrl = (u: string) => u.includes("/property-videos/");

/** The task texts live in amo-client, where closeAmoTasksForLead protects them. */
export const REPORT_TASK_PREFIX = VIEWING_REPORT_TASK_PREFIX;
export const REPORT_FILED_VERDICT = "viewing report filed";
/** The verdict on the placeholder push draft that carries the form in PUSH. */
export const VIEWING_FOLLOWUP_VERDICT = "viewing follow-up due";

export type ViewingOutcome = "go" | "think" | "no" | "no_show" | "cancelled" | "rescheduled";
export const NEXT_STEPS = [
  "Send price & terms",
  "Deposit to hold it",
  "Second visit",
  "Contract",
  "Counter-offer to owner",
  "New shortlist",
  "Wait for client's decision",
  "Close",
] as const;

const BALI = "Asia/Makassar";
function fmt(d: Date): string {
  return d.toLocaleString("en-GB", { timeZone: BALI, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function firstName(raw: string | null | undefined): string {
  const s = (raw ?? "").replace(/\(.*$/, "").trim().split(/\s+/)[0] ?? "";
  return /^[A-Za-zÀ-ÿ'’-]{2,}$/.test(s) ? s : "";
}

async function clientName(leadId: string): Promise<string> {
  const [row] = await db
    .select({ name: leadMessagesTable.senderName })
    .from(leadMessagesTable)
    .where(and(eq(leadMessagesTable.leadId, leadId), eq(leadMessagesTable.senderType, "lead")))
    .orderBy(desc(leadMessagesTable.sentAt))
    .limit(1);
  return firstName(row?.name);
}

const CLOSED_STATUS_IDS = new Set([142, 143]);

/**
 * Which card carries the report for a slot agreed in this card's thread.
 *
 * Remi's viewing (10.09 14:00) was agreed and held in the thread of 23489993, a
 * card closed automatically on 07.09 while he was still writing; his open card
 * is 23528439. A report on the closed card is a task nobody opens. So: the
 * thread's own card when it is open; otherwise the client's OPEN card in the
 * same funnel (same contact, or the same phone on a duplicate contact); when
 * there is none, the closed card itself with a "reopen?" line — a card is never
 * reopened automatically, closing and reopening are the broker's taps.
 */
export async function reportCardFor(threadLeadId: string): Promise<{ leadId: string; closedCard: boolean }> {
  const lead = await amoFetch<{ id: number; status_id: number; pipeline_id: number; _embedded?: { contacts?: Array<{ id: number }> } }>(
    `/api/v4/leads/${threadLeadId}?with=contacts`,
  ).catch(() => null);
  if (!lead || !CLOSED_STATUS_IDS.has(lead.status_id)) return { leadId: threadLeadId, closedCard: false };
  const ids = new Set<string>();
  for (const c of lead._embedded?.contacts ?? []) {
    const contact = await amoFetch<{ _embedded?: { leads?: Array<{ id: number }> } }>(`/api/v4/contacts/${c.id}?with=leads`).catch(() => null);
    for (const l of contact?._embedded?.leads ?? []) ids.add(String(l.id));
  }
  const phone = await leadPhone(threadLeadId).catch(() => "");
  if (phone) for (const id of await siblingLeadIds(threadLeadId, phone).catch(() => [] as string[])) ids.add(id);
  ids.delete(threadLeadId);
  if (ids.size > 0) {
    const q = [...ids].slice(0, 40).map((id) => `filter[id][]=${id}`).join("&");
    const found = await amoFetch<{ _embedded?: { leads?: Array<{ id: number; status_id: number; pipeline_id: number; updated_at: number }> } }>(
      `/api/v4/leads?${q}&limit=50`,
    ).catch(() => null);
    const open = (found?._embedded?.leads ?? [])
      .filter((l) => l.pipeline_id === lead.pipeline_id && !CLOSED_STATUS_IDS.has(l.status_id))
      .sort((a, b) => b.updated_at - a.updated_at);
    if (open[0]) return { leadId: String(open[0].id), closedCard: false };
  }
  return { leadId: threadLeadId, closedCard: true };
}

/**
 * The report owed for a slot agreed in `threadLeadId`'s thread: created on the
 * card reportCardFor picks, the slot marked reported. Idempotent. `propertyCode`
 * undefined means "not known yet — read it from the thread".
 */
export async function ensureSlotReport(
  threadLeadId: string,
  viewingAt: Date,
  propertyCode: string | null | undefined,
  source: string,
): Promise<{ id: string; created: boolean; leadId: string; closedCard: boolean }> {
  const target = await reportCardFor(threadLeadId);
  const code = propertyCode !== undefined ? propertyCode : await propertyForSlot(threadLeadId, viewingAt).catch(() => null);
  const r = await ensureDueReport(target.leadId, viewingAt, { propertyCode: code, threadLeadId, closedCard: target.closedCard });
  await recordViewingSlot(threadLeadId, { viewingAt, propertyCode: code }, source).catch(() => undefined);
  await db
    .update(viewingSlotsTable)
    .set({ status: "reported", reportId: r.id, reportLeadId: target.leadId, updatedAt: new Date() })
    .where(and(eq(viewingSlotsTable.leadId, threadLeadId), eq(viewingSlotsTable.viewingAt, viewingAt)));
  return { ...r, leadId: target.leadId, closedCard: target.closedCard };
}

/**
 * Re-create the report task for a report still due. Before 14.09 any message
 * closed every open task on the card, the report task included (Lorenzo,
 * viewing 09.09: "Closed automatically" 10.09 12:40, report still due).
 */
export async function retaskDueReport(leadId: string, viewingAt: Date): Promise<{ ok: boolean; reason: string }> {
  const [rep] = await db
    .select({ propertyCode: viewingReportsTable.propertyCode, status: viewingReportsTable.status })
    .from(viewingReportsTable)
    .where(and(eq(viewingReportsTable.leadId, leadId), eq(viewingReportsTable.viewingAt, viewingAt)))
    .limit(1);
  if (!rep) return { ok: false, reason: "no report for this card and slot" };
  if (rep.status !== "due") return { ok: false, reason: `the report is ${rep.status}` };
  const open = await getOpenAmoTasks(leadId);
  if (open.some((t) => (t.text ?? "").startsWith(REPORT_TASK_PREFIX))) return { ok: false, reason: "an open report task already exists" };
  const name = await clientName(leadId);
  const lead = await getAmoLead(leadId);
  const ok = await createAmoTask(
    leadId,
    `${REPORT_TASK_PREFIX}: ${name || "the client"}${rep.propertyCode ? ` · ${rep.propertyCode}` : ""} (viewing ${fmt(viewingAt)}). Open the card in Copilot — outcome, the client's feedback, next steps.`,
    new Date(Date.now() + 3 * 3_600_000),
    lead?.responsible_user_id ?? undefined,
  );
  return { ok, reason: ok ? "report task re-created" : "amoCRM refused the task" };
}

/**
 * One report per viewing slot, on the card given. Safe to call again — an
 * existing row is returned.
 */
export async function ensureDueReport(
  leadId: string,
  viewingAt: Date,
  opts: { propertyCode?: string | null; threadLeadId?: string; closedCard?: boolean } = {},
): Promise<{ id: string; created: boolean }> {
  const [existing] = await db
    .select({ id: viewingReportsTable.id })
    .from(viewingReportsTable)
    .where(and(eq(viewingReportsTable.leadId, leadId), eq(viewingReportsTable.viewingAt, viewingAt)))
    .limit(1);
  if (existing) return { id: existing.id, created: false };

  const [sync] = await db
    .select({ responsibleUser: leadsSyncTable.responsibleUser })
    .from(leadsSyncTable)
    .where(eq(leadsSyncTable.leadId, leadId))
    .limit(1);
  const threadLeadId = opts.threadLeadId ?? leadId;
  // The villa comes from the messages that agreed the slot. "The last code
  // sent before the slot" named the wrong villa in 2 of 3 reports; when the
  // thread does not make it clear, it stays empty and the form asks.
  const property =
    opts.propertyCode !== undefined ? opts.propertyCode : await propertyForSlot(threadLeadId, viewingAt).catch(() => null);
  const name = (await clientName(leadId)) || (await clientName(threadLeadId));
  const [row] = await db
    .insert(viewingReportsTable)
    .values({ leadId, propertyCode: property, viewingAt, status: "due" })
    .returning({ id: viewingReportsTable.id });

  // One open push per card: a follow-up written before the slot ("we still
  // have the 5PM visit set up") is wrong once the slot has passed. A draft the
  // broker asked for herself stays.
  await db
    .update(pendingSuggestionsTable)
    .set({ status: "skipped" })
    .where(
      and(
        eq(pendingSuggestionsTable.leadId, leadId),
        eq(pendingSuggestionsTable.status, "pending"),
        eq(pendingSuggestionsTable.kind, "push"),
        sql`${pendingSuggestionsTable.requestedAt} IS NULL`,
        sql`${pendingSuggestionsTable.createdAt} < ${viewingAt}`,
        sql`${pendingSuggestionsTable.autopilotSkippedReason} IS DISTINCT FROM ${VIEWING_FOLLOWUP_VERDICT}`,
      ),
    );

  // The form lives inside a card, and the inbox lists drafts: without a
  // pending push for this lead there is nothing to open. The placeholder
  // "how did it go?" is that card; it is rewritten once the report is filed.
  const [pendingPush] = await db
    .select({ id: pendingSuggestionsTable.id })
    .from(pendingSuggestionsTable)
    .where(and(eq(pendingSuggestionsTable.leadId, leadId), eq(pendingSuggestionsTable.status, "pending"), eq(pendingSuggestionsTable.kind, "push")))
    .limit(1);
  if (!pendingPush) {
    await db.insert(pendingSuggestionsTable).values({
      leadId,
      responsibleUser: sync?.responsibleUser ?? null,
      kind: "push",
      suggestionText:
        `Hi${name ? ` ${name}` : ""}, how did the viewing go? ` +
        `If it felt right, I can check the next steps with the owner, and if not, tell me what was missing and I'll find closer matches.`,
      status: "pending",
      autopilotSkippedReason: VIEWING_FOLLOWUP_VERDICT,
      autopilotSkippedAt: new Date(),
    });
  }

  const label = `${name || "the client"}${property ? ` · ${property}` : ""}`;
  const elsewhere = threadLeadId !== leadId ? ` The viewing was agreed in the chat of card #${threadLeadId}.` : "";
  const reopen = opts.closedCard ? " This card is closed: if the client is still looking, reopen it." : "";
  // The task is what the broker already works from: it is the "today" /
  // "overdue" badge on the card, the same as every other task.
  try {
    const lead = await getAmoLead(leadId);
    await createAmoTask(
      leadId,
      `${REPORT_TASK_PREFIX}: ${label} (viewing ${fmt(viewingAt)}). Open the card in Copilot — outcome, the client's feedback, next steps, and your photos/video if you filmed the villa.${elsewhere}${reopen}`,
      new Date(Date.now() + 3 * 3_600_000),
      lead?.responsible_user_id ?? undefined,
    );
  } catch (err) {
    logger.warn({ err, leadId }, "viewing report: task not created (non-fatal)");
  }
  await notifyBroker(
    brokerKey(sync?.responsibleUser),
    `Fill the viewing report · ${name || "client"}`,
    `${property ?? "Viewing"} at ${fmt(viewingAt)}. Outcome, feedback, next steps — and the video if you filmed it.${opts.closedCard ? " The card is closed: reopen it?" : ""}`,
    "/m",
  ).catch(() => 0);
  logger.info({ leadId, threadLeadId, closedCard: !!opts.closedCard, reportId: row!.id, property, viewingAt }, "viewing report: due");
  return { id: row!.id, created: true };
}

/**
 * Due reports for a set of leads — for the inbox payload, one query. The card
 * shows the newest; `openCount` says how many are due on it. Lorenzo had two
 * viewings (09.09, 12.09): Amelia filed the 12.09 report, the 09.09 one took
 * its place in the same form, and she read it as her report "still appearing"
 * (15.09.2026).
 */
export async function dueReportsForLeads(
  leadIds: string[],
): Promise<Map<string, { id: string; viewingAt: Date; propertyCode: string | null; createdAt: Date; openCount: number }>> {
  const out = new Map<string, { id: string; viewingAt: Date; propertyCode: string | null; createdAt: Date; openCount: number }>();
  if (leadIds.length === 0) return out;
  const rows = await db
    .select({
      id: viewingReportsTable.id,
      leadId: viewingReportsTable.leadId,
      viewingAt: viewingReportsTable.viewingAt,
      propertyCode: viewingReportsTable.propertyCode,
      createdAt: viewingReportsTable.createdAt,
    })
    .from(viewingReportsTable)
    .where(and(inArray(viewingReportsTable.leadId, leadIds), eq(viewingReportsTable.status, "due")))
    .orderBy(desc(viewingReportsTable.viewingAt));
  for (const r of rows) {
    const seen = out.get(r.leadId);
    if (seen) seen.openCount++;
    else out.set(r.leadId, { ...r, openCount: 1 });
  }
  return out;
}

export async function dueReportForLead(leadId: string) {
  return (await dueReportsForLeads([leadId])).get(leadId) ?? null;
}

// The filed report DOES move the card to "Viewing done" (markViewingDone
// above) — owner, 16.09.2026: "этап завершён только если брокер выполнил
// действие: провёл, получил фидбек, отправил через анкету". This replaces the
// 09.09 canon that the report is information only. Nothing else sets that
// stage: not a timer, not the thread, not the classifier.
export const OUTCOME_LABEL: Record<ViewingOutcome, string> = {
  go: "Going ahead",
  think: "Liked it, needs time",
  no: "Not this one",
  no_show: "Client didn't show",
  cancelled: "Cancelled by the villa",
  rescheduled: "Rescheduled",
};

export type FileReportInput = {
  reportId: string;
  outcome: ViewingOutcome;
  feedback: string;
  nextSteps: string[];
  nextBy: string | null;
  rescheduledTo: string | null;
  brokerId: string | null;
  /** The villa, when the report carried none: the thread did not make it clear, so the broker named it. */
  propertyCode?: string | null;
  /** Photos / video uploaded from the form (public URLs of our own storage). */
  media?: string[];
};

/**
 * A next step's due time, never in the past. "By today" filed at 13:00 used to
 * create a task due 10:00 the same day, overdue the moment it appeared.
 */
function stepDue(nextBy: string | null): Date {
  const soon = Date.now() + 30 * 60_000;
  if (!nextBy) return new Date(Date.now() + 24 * 3_600_000);
  for (const hour of ["10", "18"]) {
    const d = new Date(`${nextBy}T${hour}:00:00+08:00`);
    if (d.getTime() > soon) return d;
  }
  return new Date(Date.now() + 3 * 3_600_000);
}

/** Stages only a person sets and only a person leaves. */
const HANDS_OFF_STAGE = /check[-\s]?in|inventory|contract\s*signed/i;
const VIEWING_DONE_STAGE = /viewing\s*(done|held|completed)/i;

/**
 * The filed report moves the card to "Viewing done".
 *
 * Owner, 16.09.2026: every Rental stage is a completed action of the broker's
 * — "показ проведён" is one of them — and the action is finished when they held
 * the viewing, took the feedback and handed it in through this form. So the
 * form is the trigger, not a timer and not the thread. This reverses the
 * 09.09 canon ("анкета — это просто обратная связь"), which left the card on
 * "Viewing scheduled" whenever the viewing happened and nobody wrote about it.
 *
 * Only forward, only Rental, never onto or off a stage a person owns.
 */
async function markViewingDone(leadId: string): Promise<string | null> {
  const lead = await getAmoLead(leadId).catch(() => null);
  if (!lead?.status_id || !lead.pipeline_id) return null;
  if (CLOSED_STATUS_IDS.has(lead.status_id)) return null;
  const where = await amoStageFor(lead.pipeline_id, lead.status_id).catch(() => null);
  if (!where || pipelineKind(where.pipeline) !== "rental") return null;
  if (HANDS_OFF_STAGE.test(where.stage ?? "")) return null;
  const cur = where.all.findIndex((st) => st.id === lead.status_id);
  const done = where.all.findIndex((st) => VIEWING_DONE_STAGE.test(st.name));
  if (cur < 0 || done < 0 || cur >= done) return null;
  const target = where.all[done]!;
  if (!(await updateLeadStatus(leadId, target.id))) {
    logger.warn({ leadId, to: target.name }, "viewing report: amoCRM refused Viewing done");
    return null;
  }
  const [sync] = await db
    .select({ responsibleUser: leadsSyncTable.responsibleUser })
    .from(leadsSyncTable)
    .where(eq(leadsSyncTable.leadId, leadId))
    .limit(1);
  await db
    .update(leadsSyncTable)
    .set({ leadStage: target.name, leadStageId: String(target.id), updatedAt: new Date() })
    .where(eq(leadsSyncTable.leadId, leadId));
  await db
    .insert(stageEventsTable)
    .values({ leadId, fromStage: where.stage, toStage: target.name, pipeline: where.pipeline, responsibleUser: sync?.responsibleUser ?? null })
    .catch(() => undefined);
  logger.info({ leadId, from: where.stage, to: target.name }, "viewing report: card moved by the filed report");
  return target.name;
}

/**
 * File the report and do everything that follows from it: stage, notes, the
 * next-step task, the draft to the client. Each side effect is best-effort —
 * the report itself is never lost because amoCRM was slow.
 */
export async function fileReport(input: FileReportInput): Promise<{ ok: boolean; stage?: string | null; error?: string }> {
  const [rep] = await db.select().from(viewingReportsTable).where(eq(viewingReportsTable.id, input.reportId)).limit(1);
  if (!rep) return { ok: false, error: "report not found" };
  if (rep.status === "filed") return { ok: true, stage: null };
  const leadId = rep.leadId;
  const nextSteps = input.nextSteps.filter((s) => (NEXT_STEPS as readonly string[]).includes(s));
  const nextBy = input.nextBy && /^\d{4}-\d{2}-\d{2}$/.test(input.nextBy) ? input.nextBy : null;
  // A typo in the year (2926-09-23, filed 23.09.2026) became an amoCRM task due
  // in year -1: amoCRM keeps the due time in 32 bits and wrapped around. A next
  // step is due within a year of the viewing, or the broker is asked again.
  if (nextBy) {
    const t = Date.parse(`${nextBy}T12:00:00+08:00`);
    if (Number.isNaN(t) || t < Date.now() - 7 * 86_400_000 || t > Date.now() + 366 * 86_400_000) {
      return { ok: false, error: `The next-step date ${nextBy} looks wrong. Pick a date within the next year.` };
    }
  }
  const rescheduledTo = input.rescheduledTo && !Number.isNaN(new Date(input.rescheduledTo).getTime()) ? new Date(input.rescheduledTo) : null;
  const typedCode = (input.propertyCode ?? "").trim().toUpperCase();
  if (!rep.propertyCode && /^(R-[A-Z]+-\d+|YUDR-\d+)$/.test(typedCode)) rep.propertyCode = typedCode;

  await db
    .update(viewingReportsTable)
    .set({
      status: "filed",
      outcome: input.outcome,
      feedback: input.feedback.trim() || null,
      nextSteps,
      nextBy,
      rescheduledTo,
      propertyCode: rep.propertyCode,
      filedBy: input.brokerId,
      filedAt: new Date(),
    })
    .where(eq(viewingReportsTable.id, input.reportId));

  const media = [...new Set((input.media ?? []).filter(isOwnStorageUrl))].slice(0, 30);
  if (media.length) {
    try {
      await ensureMediaTable();
      for (const url of media) {
        await pool.query(`INSERT INTO viewing_report_media (report_id, url, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
          input.reportId,
          url,
          isVideoUrl(url) ? "video" : "photo",
        ]);
      }
    } catch (err) {
      logger.warn({ err, reportId: input.reportId }, "viewing report: media not recorded (non-fatal, links still go into the notes)");
    }
  }
  const mediaLines = media.map((u) => `${isVideoUrl(u) ? "Video" : "Photo"}: ${u}`);

  const [sync] = await db
    .select({ responsibleUser: leadsSyncTable.responsibleUser })
    .from(leadsSyncTable)
    .where(eq(leadsSyncTable.leadId, leadId))
    .limit(1);

  // 1a. The stage: the broker held the viewing and handed in the feedback, so
  //     the card moves now. "Did not happen" outcomes move nothing.
  let stage: string | null = null;
  if (input.outcome === "go" || input.outcome === "think" || input.outcome === "no") {
    stage = await markViewingDone(leadId).catch((err) => {
      logger.warn({ err, leadId }, "viewing report: stage not moved (non-fatal)");
      return null;
    });
  }

  // 1. The slot only: a viewing that did not happen frees the slot, a
  //    rescheduled one replaces it, so the next report is asked at the right
  //    time. No stage is touched.
  if (input.outcome === "no_show" || input.outcome === "cancelled" || input.outcome === "rescheduled") {
    await db.update(leadsSyncTable).set({ viewingAt: rescheduledTo, updatedAt: new Date() }).where(eq(leadsSyncTable.leadId, leadId)).catch(() => undefined);
  }
  if (rescheduledTo) {
    await recordViewingSlot(leadId, { viewingAt: rescheduledTo, propertyCode: rep.propertyCode }, "report-rescheduled").catch(() => undefined);
  }

  // 2. The report as a note on the lead, so amoCRM shows it too.
  const noteLines = [
    `VIEWING REPORT — ${rep.propertyCode ?? "villa"}, ${fmt(rep.viewingAt)}`,
    `Outcome: ${OUTCOME_LABEL[input.outcome]}${rescheduledTo ? ` → ${fmt(rescheduledTo)}` : ""}`,
    input.feedback.trim() ? `Client's feedback: ${input.feedback.trim()}` : null,
    nextSteps.length ? `Next steps: ${nextSteps.join(", ")}${nextBy ? ` by ${nextBy}` : ""}` : null,
    ...mediaLines,
    `Filed by ${input.brokerId ?? "broker"} via Copilot`,
  ].filter(Boolean);
  const noteText = noteLines.join("\n");
  await amoPost(`/api/v4/leads/${encodeURIComponent(leadId)}/notes`, [{ note_type: "common", params: { text: noteText } }]).catch(() => null);

  // 3. The report task closes; the next step becomes a task with a date.
  try {
    const open = await getOpenAmoTasks(leadId);
    const mine = open.filter((t) => (t.text ?? "").startsWith(REPORT_TASK_PREFIX));
    if (mine.length) await amoPatch(`/api/v4/tasks`, mine.map((t) => ({ id: t.id, is_completed: true, result: { text: "Report filed in Copilot" } })));
    if (nextSteps.length && !nextSteps.every((s) => s === "Close")) {
      const due = stepDue(nextBy);
      const lead = await getAmoLead(leadId);
      await createAmoTask(leadId, `${NEXT_STEP_TASK_PREFIX}: ${nextSteps.join(", ")}`, due, lead?.responsible_user_id ?? undefined);
    }
  } catch (err) {
    logger.warn({ err, leadId }, "viewing report: tasks not updated (non-fatal)");
  }

  // 4. The listing's own card: what the next client should know, and — when
  //    the next step is on the OWNER's side (a counter-offer, a deposit, the
  //    contract) — a task for whoever holds that owner. Amelia's step used to
  //    stop on her card; Yudi, who talks to the owner, never heard of it.
  if (rep.propertyCode) {
    try {
      const found = await amoFetch<{ _embedded?: { leads?: Array<{ id: number; name: string; responsible_user_id?: number }> } }>(
        `/api/v4/leads?query=${encodeURIComponent(rep.propertyCode)}&limit=5`,
      );
      const listing = (found?._embedded?.leads ?? []).find((l) => (l.name ?? "").toUpperCase().includes(rep.propertyCode!));
      if (listing) {
        if (input.feedback.trim() || mediaLines.length) {
          const text = [
            `Viewing feedback (${fmt(rep.viewingAt)}, lead #${leadId}): ${OUTCOME_LABEL[input.outcome]}. ${input.feedback.trim()}`.trim(),
            ...(mediaLines.length ? [`Filmed / photographed at the viewing:`, ...mediaLines] : []),
          ].join("\n");
          await amoPost(`/api/v4/leads/${listing.id}/notes`, [{ note_type: "common", params: { text } }]);
        }
        const ownerSide = nextSteps.filter((s) => s === "Counter-offer to owner" || s === "Deposit to hold it" || s === "Contract");
        if (ownerSide.length) {
          const due = stepDue(nextBy);
          await createAmoTask(
            String(listing.id),
            `${LISTING_STEP_TASK_PREFIX} ${rep.propertyCode} (lead #${leadId}): ${ownerSide.join(", ")}. ${input.feedback.trim() ? `Their feedback: ${input.feedback.trim().slice(0, 300)}` : ""}`.trim(),
            due,
            listing.responsible_user_id ?? undefined,
          );
          logger.info({ leadId, listingLead: listing.id, ownerSide }, "viewing report: owner-side step handed to the listing card");
        }
      }
    } catch (err) {
      logger.warn({ err, leadId, property: rep.propertyCode }, "viewing report: listing card not updated (non-fatal)");
    }
  }

  // 5. The draft to the client, written from the report. The generic "how did
  //    the viewing go?" is retired — it was the placeholder for this.
  try {
    await db
      .update(pendingSuggestionsTable)
      .set({ status: "skipped", autopilotSkippedReason: REPORT_FILED_VERDICT, autopilotSkippedAt: new Date() })
      .where(and(eq(pendingSuggestionsTable.leadId, leadId), eq(pendingSuggestionsTable.status, "pending"), eq(pendingSuggestionsTable.kind, "push")));
    if (!nextSteps.every((s) => s === "Close" || s === "Wait for client's decision") || input.outcome === "no_show" || input.outcome === "cancelled") {
      const wantsOptions = nextSteps.includes("New shortlist") || nextSteps.includes("Second visit");
      let text: string | null = null;
      let attachments: Array<{ type: "link"; label: string; url: string }> = [];
      if (wantsOptions) {
        // Real options, picked by the same matcher every shortlist uses —
        // a text that promises "links below" with none attached is the bug
        // this project has fixed three times; it does not get a fourth.
        const gen = await shortlistAfterViewing(leadId, rep.propertyCode, input.outcome, input.feedback, nextSteps, nextBy);
        if (gen && gen.attachments.length > 0) { text = gen.text; attachments = gen.attachments; }
      }
      if (!text) text = await composeClientDraft(leadId, rep.propertyCode, input.outcome, input.feedback, nextSteps, nextBy, rescheduledTo);
      if (text) {
        await db.insert(pendingSuggestionsTable).values({
          leadId,
          responsibleUser: sync?.responsibleUser ?? null,
          kind: "push",
          suggestionText: text,
          attachments,
          status: "pending",
          autopilotSkippedReason: REPORT_FILED_VERDICT,
          autopilotSkippedAt: new Date(),
        });
      }
    }
  } catch (err) {
    logger.warn({ err, leadId }, "viewing report: client draft not written (non-fatal)");
  }

  logger.info({ leadId, reportId: input.reportId, outcome: input.outcome, nextSteps, stage }, "viewing report: filed");
  return { ok: true, stage };
}

async function composeClientDraft(
  leadId: string,
  property: string | null,
  outcome: ViewingOutcome,
  feedback: string,
  nextSteps: string[],
  nextBy: string | null,
  rescheduledTo: Date | null,
): Promise<string | null> {
  const rows = await db
    .select({ who: leadMessagesTable.senderType, text: leadMessagesTable.text, at: leadMessagesTable.sentAt })
    .from(leadMessagesTable)
    .where(and(eq(leadMessagesTable.leadId, leadId), sql`${leadMessagesTable.text} IS NOT NULL`))
    .orderBy(desc(leadMessagesTable.sentAt))
    .limit(14);
  const thread = rows
    .reverse()
    .map((r) => `${r.who === "lead" ? "Client" : "Amelia"}: ${(r.text ?? "").replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  const name = await clientName(leadId);
  const [sync] = await db
    .select({ responsibleUser: leadsSyncTable.responsibleUser, content: leadsSyncTable.content, leadStage: leadsSyncTable.leadStage, pipeline: leadsSyncTable.pipeline })
    .from(leadsSyncTable)
    .where(eq(leadsSyncTable.leadId, leadId))
    .limit(1);
  const broker = (sync?.responsibleUser ?? "Amelia").split(/\s+/)[0];

  const report = [
    `Outcome: ${OUTCOME_LABEL[outcome]}${rescheduledTo ? ` (new slot ${fmt(rescheduledTo)})` : ""}`,
    feedback.trim() ? `Client's feedback (broker's words): ${feedback.trim()}` : "No feedback noted.",
    nextSteps.length ? `Broker's next steps: ${nextSteps.join(", ")}${nextBy ? ` by ${nextBy}` : ""}` : "",
  ].join("\n");

  try {
    const out = await chatCompletion({
      model: WRITER_MODEL,
      label: "viewing-report:client-draft",
      max_tokens: 300,
      temperature: 0.4,
      system: `You write ${broker}'s next WhatsApp message to a rental client in Bali, right after a villa viewing. You have the broker's viewing report; the client never sees the report. Write ONLY the message, in English, under 80 words, warm and concrete, no links, no bullet points, no subject line.
Rules: acknowledge what the client said or felt (from the feedback); state the concrete next thing the broker is doing (from the next steps) and, if the report says so, when; if terms or a price are still being confirmed with the owner, say the broker is confirming them today rather than inventing numbers; if the client didn't show or the villa cancelled, propose a new slot politely; if the outcome is "Not this one", ask what would make the next option right and say new options are coming. Never mention "report", "system" or "Copilot". You cannot attach anything: never write "link below", "here are options", "sending you villas" or promise a list — say what the broker will do and by when instead. Sign as ${broker} only if the thread shows the broker signing.`,
      messages: [{ role: "user", content: `Client: ${name || "the client"}${property ? ` · villa ${property}` : ""}\n\nRecent thread:\n${thread}\n\nViewing report:\n${report}` }],
    });
    const text = (out.content ?? "").trim();
    if (text.length <= 10) return null;
    // The same viewing-push gate as every other Rental draft. After a held
    // viewing the card sits on a viewing stage and the gate says no; a card a
    // person moved back before Viewing scheduled is pushed like any other.
    const dialog = await getMergedDialog(leadId, sync?.content ?? "");
    return await applyViewingPush(text, [], {
      leadId,
      pipeline: sync?.pipeline,
      leadStage: sync?.leadStage,
      messages: dialog.messages,
      responsibleUser: sync?.responsibleUser,
      kind: "push",
    });
  } catch (err) {
    logger.warn({ err, leadId }, "viewing report: draft composition failed");
    return null;
  }
}

/**
 * A "New shortlist" / "Second visit" next step needs villas, not words about
 * villas: run the ordinary generator with the report as the brief, so the
 * matcher picks the links and the writer names exactly those.
 */
async function shortlistAfterViewing(
  leadId: string,
  property: string | null,
  outcome: ViewingOutcome,
  feedback: string,
  nextSteps: string[],
  nextBy: string | null,
): Promise<{ text: string; attachments: Array<{ type: "link"; label: string; url: string }> } | null> {
  const [lead] = await db
    .select({
      responsibleUser: leadsSyncTable.responsibleUser,
      content: leadsSyncTable.content,
      leadNotes: leadsSyncTable.leadNotes,
      leadStage: leadsSyncTable.leadStage,
      pipeline: leadsSyncTable.pipeline,
    })
    .from(leadsSyncTable)
    .where(eq(leadsSyncTable.leadId, leadId))
    .limit(1);
  if (!lead) return null;
  const [last] = await db
    .select({ text: leadMessagesTable.text })
    .from(leadMessagesTable)
    .where(and(eq(leadMessagesTable.leadId, leadId), eq(leadMessagesTable.senderType, "lead"), sql`${leadMessagesTable.text} IS NOT NULL`))
    .orderBy(desc(leadMessagesTable.sentAt))
    .limit(1);
  const lastLeadMessage = last?.text ?? "";
  try {
    const corrections = await correctionsPromptBlock(
      lead.responsibleUser,
      deriveSituation({ pipeline: lead.pipeline, kind: "push", leadStage: lead.leadStage, lastLeadText: lastLeadMessage, isFirstContact: false }),
      20,
    );
    const brief =
      `The client viewed ${property ?? "a villa"} in person; outcome: ${OUTCOME_LABEL[outcome]}. ` +
      `The broker's notes from the viewing: ${feedback.trim() || "none"}. ` +
      `Agreed next step: ${nextSteps.join(", ")}${nextBy ? ` by ${nextBy}` : ""}. ` +
      `Write the follow-up that delivers that step: pick 2-3 villas that FIX what they disliked (the notes name it) and fit their bedrooms, area and budget; name each attached villa in the text; do not re-offer the villa they saw; if the step is a second visit, offer to line up the viewing dates for the ones they pick. Under 90 words before the list.`;
    const gen = await generateSuggestion({
      leadId,
      responsibleUser: lead.responsibleUser,
      kind: "push",
      lastLeadMessage,
      contentSnippet: lead.content ?? "",
      leadNotes: lead.leadNotes,
      leadStage: lead.leadStage,
      correctionsBlock: corrections,
      pipeline: lead.pipeline,
      taskBrief: brief,
    });
    if (!gen.text) return null;
    return {
      text: gen.text,
      attachments: (gen.attachments ?? []).filter((a) => a?.type === "link" && a.url).map((a) => ({ type: "link" as const, label: a.label ?? a.url!, url: a.url! })),
    };
  } catch (err) {
    logger.warn({ err, leadId }, "viewing report: shortlist generation failed — falling back to a plain draft");
    return null;
  }
}
