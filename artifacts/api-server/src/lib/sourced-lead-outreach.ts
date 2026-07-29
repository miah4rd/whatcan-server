/**
 * First outreach for leads that arrive with their request already known.
 *
 * A separate scouting bot works Facebook groups: it finds people looking for a
 * villa, gets their WhatsApp in DM, and creates the amoCRM card with a note
 * describing exactly what they asked for. So the conversation genuinely started
 * — just somewhere else — and these leads were falling into a gap:
 *
 *   - no LIVE, because LIVE answers an incoming message and there is none here;
 *   - no PUSH, because a brand-new lead deliberately waits 24h for amoCRM's own
 *     welcome automation, which never fires for cards created this way.
 *
 * So the card sat in "New LEAD" with a detailed request nobody acted on.
 *
 * The note itself lives only in amoCRM, so it's pulled in here — leads_sync
 * never carried notes for these leads, which is why the request was invisible
 * to every prompt even once a suggestion was generated.
 */
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, and, isNull, or, sql } from "drizzle-orm";
import { logger } from "./logger";
import { amoFetch } from "./amo-client";
import { generateSuggestion } from "./generate-suggestion";
import { queueSuggestion } from "../routes/amocrm-webhook.js";
import { shouldSuppressPush } from "./stage-routing";

type AmoNote = { note_type?: string; params?: { text?: string } };

/** Pull the lead's amoCRM notes — that's where the scout bot writes the request. */
async function fetchLeadNote(leadId: string): Promise<string | null> {
  try {
    const data = await amoFetch<{ _embedded?: { notes?: AmoNote[] } }>(
      `/api/v4/leads/${leadId}/notes?limit=25`,
    );
    const notes = data?._embedded?.notes ?? [];
    const texts = notes
      .map((n) => (n.params?.text ?? "").trim())
      .filter((t) => t.length > 20);
    if (texts.length === 0) return null;
    // Newest note last in amoCRM's ordering; keep them all, the request may be
    // split across a couple of lines.
    return texts.join("\n").slice(0, 2000);
  } catch (err) {
    logger.warn({ err, leadId }, "sourced-lead: notes fetch failed");
    return null;
  }
}

/**
 * A note is only actionable if it actually describes what the client wants.
 * The scout bot writes "Request: ..."; anything shorter is CRM housekeeping.
 */
function looksLikeClientRequest(note: string): boolean {
  const t = note.toLowerCase();
  if (t.length < 40) return false;
  return /request:|looking for|ищет|запрос|villa|bedroom|budget|move-in/.test(t);
}

export async function processSourcedLeadOutreach(): Promise<void> {
  // Candidates: no conversation has happened yet, and nothing is queued for the
  // broker. Anything with content is a normal lead handled by the other passes.
  const candidates = await db
    .select({
      leadId: leadsSyncTable.leadId,
      responsibleUser: leadsSyncTable.responsibleUser,
      leadStage: leadsSyncTable.leadStage,
      pipeline: leadsSyncTable.pipeline,
      leadNotes: leadsSyncTable.leadNotes,
      botExcluded: leadsSyncTable.botExcluded,
    })
    .from(leadsSyncTable)
    .where(
      and(
        or(isNull(leadsSyncTable.content), eq(leadsSyncTable.content, "")),
        or(eq(leadsSyncTable.botExcluded, false), isNull(leadsSyncTable.botExcluded)),
        sql`${leadsSyncTable.leadId} IN (
          SELECT lead_id FROM leads_sync
          WHERE (content IS NULL OR content = '')
          ORDER BY amo_created_at DESC NULLS LAST
          LIMIT 40
        )`,
      ),
    );

  if (candidates.length === 0) return;

  let queued = 0;
  for (const lead of candidates) {
    try {
      if (lead.leadStage && shouldSuppressPush(lead.leadStage)) continue;

      // Already waiting on the broker — don't stack another card.
      const [existing] = await db
        .select({ id: pendingSuggestionsTable.id })
        .from(pendingSuggestionsTable)
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, lead.leadId),
            eq(pendingSuggestionsTable.status, "pending"),
          ),
        )
        .limit(1);
      if (existing) continue;

      // Nothing was ever sent for this lead either — a sent message means the
      // outreach already happened and the lead is simply quiet.
      const [everSent] = await db
        .select({ id: pendingSuggestionsTable.id })
        .from(pendingSuggestionsTable)
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, lead.leadId),
            sql`${pendingSuggestionsTable.status} IN ('approved','edited')`,
          ),
        )
        .limit(1);
      if (everSent) continue;

      let note = lead.leadNotes?.trim() || "";
      if (!note) {
        note = (await fetchLeadNote(lead.leadId)) ?? "";
        if (note) {
          await db
            .update(leadsSyncTable)
            .set({ leadNotes: note })
            .where(eq(leadsSyncTable.leadId, lead.leadId));
        }
      }
      if (!note || !looksLikeClientRequest(note)) continue;

      const { text, attachments } = await generateSuggestion({
        leadId: lead.leadId,
        responsibleUser: lead.responsibleUser,
        kind: "push",
        lastLeadMessage: "",
        contentSnippet: "",
        leadNotes: note,
        leadStage: lead.leadStage,
        pipeline: lead.pipeline,
        isFirstContact: true,
        // The request came from a real exchange on another channel — the opener
        // must build on it, not interrogate the client from zero.
        requestAlreadyKnown: true,
      });

      if (!text) continue;

      await queueSuggestion({
        leadId: lead.leadId,
        responsibleUser: lead.responsibleUser,
        kind: "push",
        text,
        attachments,
      });
      queued++;
      logger.info(
        { leadId: lead.leadId, stage: lead.leadStage, pipeline: lead.pipeline },
        "sourced-lead: first outreach queued from the card's request note",
      );
    } catch (err) {
      logger.error({ err, leadId: lead.leadId }, "sourced-lead outreach failed");
    }
  }

  if (queued > 0) logger.info({ queued }, "sourced-lead outreach pass complete");
}
