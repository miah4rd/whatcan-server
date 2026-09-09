/**
 * The viewing report: what the system cannot see because the viewing happens
 * in person.
 *
 * Until 08.09.2026 a viewing left no trace beyond "we are here" / "see you at
 * 12": four viewings were held in one week, and for none of them did the card
 * carry the client's verdict, their objections or the agreed next step. The
 * next draft was written blind, and the stage after the viewing was a guess.
 *
 * Three hours after the slot the broker gets a push and an amoCRM task; the
 * card in PUSH carries a three-part form (outcome · the client's feedback ·
 * next steps). Filing it sets the stage, writes the notes, creates the
 * next-step task and rewrites the draft to the client from what was said.
 * Without a report for 24 hours the generic "how did the viewing go?" goes out
 * and the task turns overdue. Viewings are counted from reports only.
 */
import { db, viewingReportsTable, leadsSyncTable, leadMessagesTable, pendingSuggestionsTable } from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getAmoLead, getOpenAmoTasks, createAmoTask, amoPatch, amoPost, amoFetch } from "./amo-client";
import { notifyBroker } from "./push-notifications";
import { brokerKey } from "./broker-identity";
import { chatCompletion, WRITER_MODEL } from "./ai-client";

export const REPORT_TASK_PREFIX = "Fill the viewing report";
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

/** The villa shown: the last property code we sent before the slot. */
async function shownProperty(leadId: string, before: Date): Promise<string | null> {
  const rows = await db
    .select({ text: leadMessagesTable.text })
    .from(leadMessagesTable)
    .where(and(eq(leadMessagesTable.leadId, leadId), sql`${leadMessagesTable.sentAt} <= ${before}`, sql`${leadMessagesTable.text} ~* '(R-[A-Z]+-[0-9]+|YUDR-[0-9]+)'`))
    .orderBy(desc(leadMessagesTable.sentAt))
    .limit(1);
  const m = /(R-[A-Z]+-\d+|YUDR-\d+)/i.exec(rows[0]?.text ?? "");
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * One report per viewing slot. Called three hours after the slot by the
 * viewing-outcome pass; safe to call again — an existing row is returned.
 */
export async function ensureDueReport(leadId: string, viewingAt: Date): Promise<{ id: string; created: boolean }> {
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
  const property = await shownProperty(leadId, viewingAt);
  const name = await clientName(leadId);
  const [row] = await db
    .insert(viewingReportsTable)
    .values({ leadId, propertyCode: property, viewingAt, status: "due" })
    .returning({ id: viewingReportsTable.id });

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
  // The task is what the broker already works from: it is the "today" /
  // "overdue" badge on the card, the same as every other task.
  try {
    const lead = await getAmoLead(leadId);
    await createAmoTask(
      leadId,
      `${REPORT_TASK_PREFIX}: ${label} (viewing ${fmt(viewingAt)}). Open the card in Copilot — outcome, the client's feedback, next steps.`,
      new Date(Date.now() + 3 * 3_600_000),
      lead?.responsible_user_id ?? undefined,
    );
  } catch (err) {
    logger.warn({ err, leadId }, "viewing report: task not created (non-fatal)");
  }
  await notifyBroker(
    brokerKey(sync?.responsibleUser),
    `Fill the viewing report · ${name || "client"}`,
    `${property ?? "Viewing"} at ${fmt(viewingAt)}. Outcome, the client's feedback, next steps — one minute.`,
    "/m",
  ).catch(() => 0);
  logger.info({ leadId, reportId: row!.id, property, viewingAt }, "viewing report: due");
  return { id: row!.id, created: true };
}

/** Due reports for a set of leads — for the inbox payload, one query. */
export async function dueReportsForLeads(
  leadIds: string[],
): Promise<Map<string, { id: string; viewingAt: Date; propertyCode: string | null; createdAt: Date }>> {
  const out = new Map<string, { id: string; viewingAt: Date; propertyCode: string | null; createdAt: Date }>();
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
  for (const r of rows) if (!out.has(r.leadId)) out.set(r.leadId, r);
  return out;
}

export async function dueReportForLead(leadId: string) {
  return (await dueReportsForLeads([leadId])).get(leadId) ?? null;
}

// The report never moves the card (owner, 09.09.2026: "анкета — это просто
// обратная связь… зачем-то на основе неё начинаешь какие-то действия делать").
// Stages follow the thread and the broker; the report is information.
const OUTCOME_LABEL: Record<ViewingOutcome, string> = {
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
};

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
  const rescheduledTo = input.rescheduledTo && !Number.isNaN(new Date(input.rescheduledTo).getTime()) ? new Date(input.rescheduledTo) : null;

  await db
    .update(viewingReportsTable)
    .set({
      status: "filed",
      outcome: input.outcome,
      feedback: input.feedback.trim() || null,
      nextSteps,
      nextBy,
      rescheduledTo,
      filedBy: input.brokerId,
      filedAt: new Date(),
    })
    .where(eq(viewingReportsTable.id, input.reportId));

  const [sync] = await db
    .select({ responsibleUser: leadsSyncTable.responsibleUser })
    .from(leadsSyncTable)
    .where(eq(leadsSyncTable.leadId, leadId))
    .limit(1);

  // 1. The slot only: a viewing that did not happen frees the slot, a
  //    rescheduled one replaces it, so the next report is asked at the right
  //    time. No stage is touched.
  if (input.outcome === "no_show" || input.outcome === "cancelled" || input.outcome === "rescheduled") {
    await db.update(leadsSyncTable).set({ viewingAt: rescheduledTo, updatedAt: new Date() }).where(eq(leadsSyncTable.leadId, leadId)).catch(() => undefined);
  }

  // 2. The report as a note on the lead, so amoCRM shows it too.
  const noteLines = [
    `VIEWING REPORT — ${rep.propertyCode ?? "villa"}, ${fmt(rep.viewingAt)}`,
    `Outcome: ${OUTCOME_LABEL[input.outcome]}${rescheduledTo ? ` → ${fmt(rescheduledTo)}` : ""}`,
    input.feedback.trim() ? `Client's feedback: ${input.feedback.trim()}` : null,
    nextSteps.length ? `Next steps: ${nextSteps.join(", ")}${nextBy ? ` by ${nextBy}` : ""}` : null,
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
      const due = nextBy ? new Date(`${nextBy}T10:00:00+08:00`) : new Date(Date.now() + 24 * 3_600_000);
      const lead = await getAmoLead(leadId);
      await createAmoTask(leadId, `Next step after the viewing: ${nextSteps.join(", ")}`, due, lead?.responsible_user_id ?? undefined);
    }
  } catch (err) {
    logger.warn({ err, leadId }, "viewing report: tasks not updated (non-fatal)");
  }

  // 4. What the next client should know goes to the listing's own card.
  if (rep.propertyCode && input.feedback.trim()) {
    try {
      const found = await amoFetch<{ _embedded?: { leads?: Array<{ id: number; name: string }> } }>(
        `/api/v4/leads?query=${encodeURIComponent(rep.propertyCode)}&limit=5`,
      );
      const listing = (found?._embedded?.leads ?? []).find((l) => (l.name ?? "").toUpperCase().includes(rep.propertyCode!));
      if (listing) {
        await amoPost(`/api/v4/leads/${listing.id}/notes`, [
          { note_type: "common", params: { text: `Viewing feedback (${fmt(rep.viewingAt)}, lead #${leadId}): ${OUTCOME_LABEL[input.outcome]}. ${input.feedback.trim()}` } },
        ]);
      }
    } catch (err) {
      logger.warn({ err, leadId, property: rep.propertyCode }, "viewing report: listing note not written (non-fatal)");
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
      const text = await composeClientDraft(leadId, rep.propertyCode, input.outcome, input.feedback, nextSteps, nextBy, rescheduledTo);
      if (text) {
        await db.insert(pendingSuggestionsTable).values({
          leadId,
          responsibleUser: sync?.responsibleUser ?? null,
          kind: "push",
          suggestionText: text,
          status: "pending",
          autopilotSkippedReason: REPORT_FILED_VERDICT,
          autopilotSkippedAt: new Date(),
        });
      }
    }
  } catch (err) {
    logger.warn({ err, leadId }, "viewing report: client draft not written (non-fatal)");
  }

  logger.info({ leadId, reportId: input.reportId, outcome: input.outcome, nextSteps }, "viewing report: filed");
  return { ok: true, stage: null };
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
  const [sync] = await db.select({ responsibleUser: leadsSyncTable.responsibleUser }).from(leadsSyncTable).where(eq(leadsSyncTable.leadId, leadId)).limit(1);
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
Rules: acknowledge what the client said or felt (from the feedback); state the concrete next thing the broker is doing (from the next steps) and, if the report says so, when; if terms or a price are still being confirmed with the owner, say the broker is confirming them today rather than inventing numbers; if the client didn't show or the villa cancelled, propose a new slot politely; if the outcome is "Not this one", ask what would make the next option right and say new options are coming. Never mention "report", "system" or "Copilot". Sign as ${broker} only if the thread shows the broker signing.`,
      messages: [{ role: "user", content: `Client: ${name || "the client"}${property ? ` · villa ${property}` : ""}\n\nRecent thread:\n${thread}\n\nViewing report:\n${report}` }],
    });
    const text = (out.content ?? "").trim();
    return text.length > 10 ? text : null;
  } catch (err) {
    logger.warn({ err, leadId }, "viewing report: draft composition failed");
    return null;
  }
}
