/**
 * Hand a specific lead a specific shortlist, as a draft for the broker.
 *
 * Exists for the week of 2026-09-02: eleven villas went live that matched the
 * brief thirteen leads had already given, and the matcher (ranking by views)
 * never surfaced one of them. Those people are still waiting on options they
 * asked for a week ago. Nothing here sends — every message lands in the
 * broker's LIVE inbox for one tap, exactly like any other draft.
 *
 *   POST /api/admin/retouch-listings
 *   body: { "leads": { "<leadId>": ["R-YUD-071", "R-YUD-070"], ... } }
 */
import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { describePropertiesByIds } from "../../lib/property-catalog";
import { generateSuggestion, reconcileTextWithAttachments } from "../../lib/generate-suggestion";
import { parseDialogContent } from "../../lib/dialog-parser";
import { logger } from "../../lib/logger";

const router = Router();

function brief(listings: Array<{ clientLabel: string; priceIdr: number }>): string {
  const lines = listings
    .map((l, i) => `${i + 1}. ${l.clientLabel}${l.priceIdr ? ` — Rp ${Math.round(l.priceIdr / 1_000_000)} million/month` : ""}`)
    .join("\n");
  return `SITUATION: This client asked us for a villa days ago and got options that did not match what they asked for. New villas that DO match their request went live this week — they are attached to this message. This is us coming back with what they actually wanted.

THE VILLAS ATTACHED (present these, and only these):
${lines}

Task: Write the broker's message. Three parts, nothing else:
1. Greet by name. One line acknowledging what they asked for (bedrooms, area, budget — take it from the conversation and the lead card above).
2. Say a couple of new villas that fit that exact brief just came in, and name them briefly — area and price, in the client's currency.
3. Close by proposing a viewing with TWO concrete slots this weekend or early next week ("Saturday morning or Sunday afternoon — which suits?"). Not "let me know what you think". Not "which feels closest". A time.

Under 80 words. Do not apologise for the earlier options. Do not re-describe villas they already have.`;
}

router.post("/admin/retouch-listings", async (req, res) => {
  const leads = (req.body?.leads ?? {}) as Record<string, string[]>;
  const leadIds = Object.keys(leads);
  if (leadIds.length === 0) {
    res.status(400).json({ error: "body.leads must map leadId → [listingId]" });
    return;
  }
  const rows = await db
    .select({
      leadId: leadsSyncTable.leadId,
      responsibleUser: leadsSyncTable.responsibleUser,
      content: leadsSyncTable.content,
      leadNotes: leadsSyncTable.leadNotes,
      leadStage: leadsSyncTable.leadStage,
      pipeline: leadsSyncTable.pipeline,
      lastMessageFrom: leadsSyncTable.lastMessageFrom,
    })
    .from(leadsSyncTable)
    .where(inArray(leadsSyncTable.leadId, leadIds));
  const byId = new Map(rows.map((r) => [r.leadId, r]));

  const out: Array<{ leadId: string; ok: boolean; why?: string; text?: string }> = [];
  for (const leadId of leadIds) {
    const lead = byId.get(leadId);
    if (!lead) { out.push({ leadId, ok: false, why: "not in leads_sync" }); continue; }
    const wanted = (leads[leadId] ?? []).map((x) => x.toUpperCase());
    const known = await describePropertiesByIds(wanted).catch(() => new Map());
    const listings = wanted.map((id) => known.get(id)).filter(Boolean) as Array<{ clientLabel: string; label: string; url: string; priceIdr: number }>;
    if (listings.length === 0) { out.push({ leadId, ok: false, why: "no listing resolved" }); continue; }

    const dialog = parseDialogContent(lead.content ?? "");
    const lastLead = dialog.lastLeadMessage?.text ?? "";
    try {
      const { text } = await generateSuggestion({
        leadId,
        responsibleUser: lead.responsibleUser,
        kind: "live",
        lastLeadMessage: lastLead || "(no reply yet)",
        contentSnippet: lead.content ?? "",
        leadNotes: lead.leadNotes,
        leadStage: lead.leadStage,
        pipeline: lead.pipeline,
        taskBrief: brief(listings),
      });
      if (!text) { out.push({ leadId, ok: false, why: "empty text" }); continue; }
      // Replace whatever the matcher attached with the listings we chose — the
      // whole point of this endpoint is that the matcher's pick was wrong.
      const attachments = listings.map((l) => ({ type: "link" as const, label: l.label, url: l.url }));
      // The writer runs concurrently with the internal matcher and describes
      // THAT shortlist; on the first run 5 of 10 texts named villas that were
      // not attached (a 4BR in Tabanan for a client who asked for 2BR). Force
      // the text back onto the villas that are actually going out.
      const reconciled = await reconcileTextWithAttachments(text, attachments, true);
      // One draft per lead: clear any pending live draft first so the broker
      // sees this one, not a stale one about the wrong villas.
      await db
        .delete(pendingSuggestionsTable)
        .where(eq(pendingSuggestionsTable.leadId, leadId));
      // ALWAYS push. A retouch is us going back to someone, by definition a
      // chase — and LIVE is not merely hidden for such a lead, it is DELETED:
      // the stale-LIVE sweep in processFollowups took 8 of the first 10 within
      // a minute of the restart. requestedAt marks this as asked-for by hand,
      // which lifts the "future task scheduled, don't prompt" snooze that would
      // otherwise hide a push on a lead with a follow-up already on the clock.
      await db.insert(pendingSuggestionsTable).values({
        leadId,
        responsibleUser: lead.responsibleUser,
        kind: "push",
        requestedAt: new Date(),
        followupLevel: null,
        suggestionText: reconciled,
        status: "pending",
        attachments,
      });
      logger.info({ leadId, listings: wanted }, "retouch: draft with the villas they actually asked for");
      out.push({ leadId, ok: true, text: reconciled });
    } catch (err) {
      logger.error({ err, leadId }, "retouch: failed");
      out.push({ leadId, ok: false, why: String((err as Error)?.message ?? err) });
    }
  }
  res.json({ drafted: out.filter((o) => o.ok).length, results: out });
});

export default router;
