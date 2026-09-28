/**
 * Rewrites a broker's pending Rental drafts IN PLACE after a rule change.
 *
 * Owner, 28.09.2026, on the new shortlist order (deep request vs basic request,
 * red flags always last) and the old shortlist format coming back: "please ask
 * Copilot to change all of those preparing messages which Amelia hasn't
 * approved yet, to send them messages with these new rules".
 *
 * Every draft goes back through the generator that wrote it — generateSuggestion
 * for a LIVE reply, generateFollowup for a PUSH — never text composed here: a
 * second writer drifts from the first the day either changes. The row keeps its
 * id, kind and follow-up level (a broker with the card open must not get a 404
 * on approve); only the text and the attached villas change. A draft a broker
 * has asked to edit (requested_at set) is left alone.
 *
 * Dry by default (`?apply=1` to write). Body: { broker?: "Amelia",
 * leadIds?: string[], limit?: number }.
 */
import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { generateSuggestion } from "../../lib/generate-suggestion";
import { generateFollowup } from "../../lib/followup-scheduler";
import { getMergedDialog } from "../../lib/merged-conversation";
import { correctionsPromptBlock } from "../../lib/broker-corrections";
import { brokerKey } from "../../lib/broker-identity";

const router = Router();

const linkIds = (a: unknown): string[] =>
  (Array.isArray(a) ? a : [])
    .map((x) => String((x as { url?: string })?.url ?? "").match(/\/property\/([A-Za-z0-9-]+)/i)?.[1]?.toUpperCase() ?? "")
    .filter(Boolean);

router.post("/admin/redraft-rental", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const broker = String(req.body?.broker ?? "Amelia");
  const bodyIds: string[] | undefined = Array.isArray(req.body?.leadIds) ? (req.body.leadIds as unknown[]).map(String) : undefined;
  const limit = Math.min(200, Math.max(1, Number(req.body?.limit) || 200));

  const rows = await db
    .select({ s: pendingSuggestionsTable, l: leadsSyncTable })
    .from(pendingSuggestionsTable)
    .innerJoin(leadsSyncTable, eq(leadsSyncTable.leadId, pendingSuggestionsTable.leadId))
    .where(
      and(
        eq(pendingSuggestionsTable.status, "pending"),
        isNull(pendingSuggestionsTable.requestedAt),
        inArray(pendingSuggestionsTable.kind, ["live", "push"]),
        sql`lower(${leadsSyncTable.pipeline}) = 'rental'`,
        eq(leadsSyncTable.responsibleUser, broker),
        bodyIds?.length ? inArray(pendingSuggestionsTable.leadId, bodyIds) : sql`true`,
      ),
    )
    .orderBy(sql`${pendingSuggestionsTable.createdAt} DESC`)
    .limit(limit);

  const corrections = await correctionsPromptBlock(brokerKey(broker), "followup", 20).catch(() => "");
  const out: Array<Record<string, unknown>> = [];
  let rewritten = 0;

  for (const { s, l } of rows) {
    const before = linkIds(s.attachments);
    try {
      let text = "";
      let attachments: unknown = null;
      if (s.kind === "live") {
        const dialog = await getMergedDialog(l.leadId, l.content);
        const lastLeadMessage = dialog.lastLeadMessage?.text ?? "";
        if (!lastLeadMessage) {
          out.push({ lead: l.leadId, id: s.id, kind: s.kind, skipped: "no client message to answer" });
          continue;
        }
        const g = await generateSuggestion({
          leadId: l.leadId,
          responsibleUser: l.responsibleUser,
          kind: "live",
          lastLeadMessage,
          contentSnippet: l.content ?? "",
          leadNotes: l.leadNotes,
          leadStage: l.leadStage,
          pipeline: l.pipeline,
        });
        text = g.text;
        attachments = g.attachments;
      } else {
        const g = await generateFollowup({
          leadId: l.leadId,
          responsibleUser: l.responsibleUser,
          followupLevel: Math.max(1, s.followupLevel ?? 1),
          lastContent: l.content ?? "",
          leadNotes: l.leadNotes,
          leadStage: l.leadStage,
          pipeline: l.pipeline,
          correctionsBlock: corrections,
        });
        text = g.text;
        attachments = g.attachments;
      }
      if (!text) {
        out.push({ lead: l.leadId, id: s.id, kind: s.kind, skipped: "generator returned no text" });
        continue;
      }
      const after = linkIds(attachments);
      if (apply) {
        // Still pending and untouched by a broker since we read it — never overwrite a send.
        const upd = await db
          .update(pendingSuggestionsTable)
          .set({ suggestionText: text, attachments: attachments as typeof s.attachments })
          .where(and(eq(pendingSuggestionsTable.id, s.id), eq(pendingSuggestionsTable.status, "pending"), isNull(pendingSuggestionsTable.requestedAt)))
          .returning({ id: pendingSuggestionsTable.id });
        if (upd.length) rewritten++;
      }
      out.push({ lead: l.leadId, id: s.id, kind: s.kind, before, after, text: text.slice(0, 280) });
    } catch (err) {
      logger.warn({ err, leadId: l.leadId }, "redraft-rental: generation failed");
      out.push({ lead: l.leadId, id: s.id, kind: s.kind, error: String(err).slice(0, 200) });
    }
  }

  logger.info({ broker, apply, drafts: rows.length, rewritten }, "redraft-rental: pass complete");
  res.json({ apply, broker, drafts: rows.length, rewritten, results: out });
});

export default router;
