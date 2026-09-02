/**
 * Rewrites pending listing-acquisition drafts so each asks only what ITS OWN
 * conversation has not already answered.
 *
 * Why this exists: a qualification checklist is not a message. Pasting the same
 * three questions onto every card asked a villa owner for a bedroom count they
 * had given us the week before, and re-asked availability under a thread that
 * literally said "it's going to be available again around next week". To the
 * person reading it that is a robot, and it costs the reply we were trying to
 * win. The regulation's own words are "ask only for what is missing" — this
 * puts every draft back through the generator that knows that rule.
 *
 * Deliberately routed through `generateListingAcquisitionReply`, the one
 * function both live paths call, rather than composing text here: a second
 * writer would drift from the first the day either changed, which is this
 * project's oldest bug shape.
 *
 * Dry by default (`?apply=1` to write) — these drafts are what a broker taps
 * send on.
 */
import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { generateListingAcquisitionReply } from "../../lib/listing-acquisition-prompt";
import { extractListingFacts, meetsQualified } from "../../lib/listing-card-fields";
import { getMergedConversation } from "../../lib/merged-conversation";

const router = Router();

router.post("/admin/requalify-drafts", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const bodyIds: string[] | undefined = Array.isArray(req.body?.leadIds)
    ? (req.body.leadIds as string[]).map(String)
    : undefined;

  // Default target: whatever a human has pinned. That IS the list someone
  // decided to work now, so it is the list worth spending generations on.
  const pending = await db
    .select()
    .from(pendingSuggestionsTable)
    .where(eq(pendingSuggestionsTable.status, "pending"));

  const leads = await db
    .select()
    .from(leadsSyncTable)
    .where(
      bodyIds?.length
        ? inArray(leadsSyncTable.leadId, bodyIds)
        : and(isNotNull(leadsSyncTable.priorityAt), sql`lower(${leadsSyncTable.pipeline}) = 'rental listings'`),
    );

  const out: Array<Record<string, unknown>> = [];
  let rewritten = 0;

  for (const lead of leads) {
    const draft = pending.find((p) => p.leadId === lead.leadId);
    if (!draft) {
      out.push({ lead: lead.leadId, skipped: "no pending draft" });
      continue;
    }

    // The MERGED thread, never `content` alone: content freezes for anything
    // sent through Salesbot, so a draft written from it answers a message we
    // already answered — which is exactly what it did on Villa Rasa Rasa.
    const merged = await getMergedConversation(lead.leadId, lead.content);
    const conversation = merged
      .map((m) => `${m.from === "lead" ? "lead" : "broker"}: ${m.text}`)
      .join("\n");

    // What the thread already gave us — reported so the caller can see WHY a
    // message came out short, without reading the conversation.
    const facts = await extractListingFacts(conversation);
    const known = facts
      ? {
          bedrooms: facts.bedrooms,
          price: facts.monthlyIdr || facts.yearlyIdr ? "yes" : null,
          commission: facts.commission,
          available_from: facts.availableFrom,
          counterpart: facts.counterpart,
        }
      : null;
    const missing = facts ? meetsQualified(facts).missing : ["everything (no extraction)"];

    let text = "";
    try {
      const gen = await generateListingAcquisitionReply({
        leadId: lead.leadId,
        responsibleUser: lead.responsibleUser ?? null,
        kind: (draft.kind === "push" ? "push" : "live") as "push" | "live",
        contentSnippet: lead.content ?? "",
        // and the freshest turn we know of, so the reply answers the real last message
        lastLeadMessage: [...merged].reverse().find((m) => m.from === "lead")?.text ?? "",
        leadNotes: lead.leadNotes ?? null,
      });
      text = gen.text.trim();
    } catch (err) {
      logger.warn({ err, leadId: lead.leadId }, "requalify-drafts: generation failed");
      out.push({ lead: lead.leadId, skipped: "generation failed", missing });
      continue;
    }

    if (!text) {
      out.push({ lead: lead.leadId, skipped: "empty generation", missing });
      continue;
    }

    if (apply) {
      await db
        .update(pendingSuggestionsTable)
        .set({ suggestionText: text })
        .where(eq(pendingSuggestionsTable.id, draft.id));
      rewritten++;
    }

    out.push({ lead: lead.leadId, known, missing, draft: text });
  }

  logger.info({ apply, considered: leads.length, rewritten }, "requalify-drafts finished");
  res.json({ apply, considered: leads.length, rewritten, leads: out });
});

export default router;
