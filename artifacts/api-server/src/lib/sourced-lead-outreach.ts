/**
 * Seeds the conversation for leads that arrive with their request already known.
 *
 * A separate scouting bot works Facebook groups: it finds people looking for a
 * villa, gets their WhatsApp in DM, and creates the amoCRM card with a note
 * describing exactly what they asked for. The conversation genuinely started —
 * just on another channel — but these leads fell into a gap: no LIVE (nothing
 * "incoming" to answer) and no PUSH (a new lead waits 24h for an amoCRM welcome
 * automation that never fires for cards created this way). The card sat in
 * "New LEAD" with a detailed request nobody acted on.
 *
 * Rather than bolt on a parallel outreach path, this writes the request into the
 * conversation AS the lead's first message — which is what it actually is. From
 * there every existing mechanism works untouched: LIVE detection, reply
 * generation, property matching against their stated criteria, stage
 * classification. One entry point instead of two.
 *
 * RENTAL ONLY. The Unicorn/sales pipeline already has a working welcome and
 * qualification flow; a second way in would fight it.
 */
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, and, isNull, isNotNull, or, sql } from "drizzle-orm";
import { logger } from "./logger";
import { amoFetch } from "./amo-client";
import { describePropertiesByIds } from "./property-catalog";

type AmoNote = { note_type?: string; params?: { text?: string } };

/** Pull the lead's amoCRM notes — that's where the scout bot writes the request. */
async function fetchLeadNote(leadId: string): Promise<string | null> {
  try {
    const data = await amoFetch<{ _embedded?: { notes?: AmoNote[] } }>(
      `/api/v4/leads/${leadId}/notes?limit=25`,
    );
    const texts = (data?._embedded?.notes ?? [])
      .map((n) => (n.params?.text ?? "").trim())
      .filter((t) => t.length > 20);
    return texts.length > 0 ? texts.join("\n").slice(0, 2000) : null;
  } catch (err) {
    logger.warn({ err, leadId }, "sourced-lead: notes fetch failed");
    return null;
  }
}

/**
 * The PERSON's name, from the lead's contact. For an ad lead the lead name is the
 * listing code ("R-YUD-018 - 3BR Villa…"), so using it as the sender would have
 * the bot greeting the client as "Hi R-YUD-018".
 */
async function fetchContactName(leadId: string): Promise<string> {
  try {
    const lead = await amoFetch<{ _embedded?: { contacts?: Array<{ id: number }> } }>(
      `/api/v4/leads/${leadId}?with=contacts`,
    );
    const contactId = lead?._embedded?.contacts?.[0]?.id;
    if (!contactId) return "";
    const contact = await amoFetch<{ name?: string }>(`/api/v4/contacts/${contactId}`);
    const name = (contact?.name ?? "").trim();
    // amoCRM placeholders are worse than no name at all.
    if (!name || /^<|dummy|test lead|full_name/i.test(name)) return "";
    return name;
  } catch {
    return "";
  }
}

/** The lead's amoCRM name exactly as it is — ad leads carry the listing code in it. */
async function fetchRawLeadName(leadId: string): Promise<string> {
  try {
    const lead = await amoFetch<{ name?: string }>(`/api/v4/leads/${leadId}`);
    return (lead?.name ?? "").trim();
  } catch {
    return "";
  }
}

async function fetchLeadName(leadId: string): Promise<string> {
  try {
    const lead = await amoFetch<{ name?: string }>(`/api/v4/leads/${leadId}`);
    // Scout cards are named "FB Lead: Nathan Craig" — keep just the person.
    const raw = (lead?.name ?? "").replace(/^\s*(fb\s*lead|lead)\s*:\s*/i, "").trim();
    return raw || "Lead";
  } catch {
    return "Lead";
  }
}

/**
 * A note is only actionable if it actually describes what the client wants.
 * The scout bot writes "Request: ..."; anything shorter is CRM housekeeping.
 */
function looksLikeClientRequest(note: string): boolean {
  const t = note.toLowerCase();
  // A lead who answered a listing ad brings a link instead of a description —
  // that link IS the request, and the matcher builds the shortlist around it.
  if (/\/property\/|unicorn-property/.test(t)) return true;
  if (t.length < 40) return false;
  return /request:|looking for|ищет|запрос|villa|bedroom|budget|move-in/.test(t);
}

/**
 * Render one line in the exact shape amoCRM's `content` uses, so the existing
 * parser reads it as a normal inbound message.
 *
 * The timestamp is written +3h because parseDialogContent treats these stamps as
 * Moscow time (that's how amoCRM renders them) and subtracts the offset — so
 * this round-trips back to the real time instead of landing 3 hours early.
 */
function formatAsLeadMessage(at: Date, leadName: string, text: string): string {
  const shifted = new Date(at.getTime() + 3 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${p(shifted.getUTCDate())}.${p(shifted.getUTCMonth() + 1)}.${shifted.getUTCFullYear()} ` +
    `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}`;
  const oneLine = text.replace(/\s*\n+\s*/g, " ").trim();
  return `${stamp} ${leadName} (клиент - Facebook) → ${oneLine}`;
}

export async function processSourcedLeadOutreach(): Promise<number> {
  const candidates = await db
    .select({
      leadId: leadsSyncTable.leadId,
      responsibleUser: leadsSyncTable.responsibleUser,
      leadStage: leadsSyncTable.leadStage,
      leadNotes: leadsSyncTable.leadNotes,
      amoCreatedAt: leadsSyncTable.amoCreatedAt,
    })
    .from(leadsSyncTable)
    .where(
      and(
        sql`lower(coalesce(${leadsSyncTable.pipeline}, '')) = 'rental'`,
        or(isNull(leadsSyncTable.content), eq(leadsSyncTable.content, "")),
        or(eq(leadsSyncTable.botExcluded, false), isNull(leadsSyncTable.botExcluded)),
        // Recent cards only. Without this the pass reached back through every
        // conversation-less lead in the CRM and touched 2024 cards parked in
        // Long-Term Cycle. A lead sourced elsewhere is acted on within days.
        isNotNull(leadsSyncTable.amoCreatedAt),
        sql`${leadsSyncTable.amoCreatedAt} > now() - interval '7 days'`,
        sql`lower(coalesce(${leadsSyncTable.leadStage}, '')) LIKE '%new lead%'`,
      ),
    );

  if (candidates.length === 0) return 0;

  let seeded = 0;
  for (const lead of candidates) {
    try {
      // Someone already worked this lead — don't rewrite history under them.
      // Only a live card (pending) or a real send (approved/edited) counts.
      // Matching ANY row also caught `skipped` ones, which is how leads that had
      // a suggestion cancelled — including by an earlier version of this very
      // pass — became permanently unseedable.
      const [everQueued] = await db
        .select({ id: pendingSuggestionsTable.id })
        .from(pendingSuggestionsTable)
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, lead.leadId),
            sql`${pendingSuggestionsTable.status} IN ('pending','approved','edited')`,
          ),
        )
        .limit(1);
      if (everQueued) continue;

      let note = lead.leadNotes?.trim() || "";
      if (!note) note = (await fetchLeadNote(lead.leadId)) ?? "";

      // Meta Ads leads (via Albato) arrive with the LISTING CODE in the lead's
      // NAME — "R-YUD-018 - 3BR Villa for Long-Term Rental in Umalas" — and
      // nothing else: no conversation, no note. So the bot saw nothing to answer
      // and the +24h push delay meant silence for a day on a paid lead. The code
      // in the name IS the enquiry: seed it as the listing they asked about, and
      // the existing anchor logic offers that villa plus comparable ones.
      let adListing: { id: string; title: string; url: string } | null = null;
      const rawName = await fetchRawLeadName(lead.leadId);
      const codeMatch = rawName.match(/\b([A-Z]{1,4}-[A-Z0-9]+(?:-[A-Z0-9]+)*)\b/);
      if (codeMatch?.[1]) {
        const known = await describePropertiesByIds([codeMatch[1]]).catch(() => new Map());
        const hit = known.get(codeMatch[1].toUpperCase());
        if (hit) adListing = { id: codeMatch[1].toUpperCase(), title: hit.title, url: hit.url };
      }

      if (!adListing && (!note || !looksLikeClientRequest(note))) continue;

      // The person, not the lead title — for ad leads those are different things.
      const leadName = (await fetchContactName(lead.leadId)) || (await fetchLeadName(lead.leadId));
      const at = lead.amoCreatedAt ?? new Date();
      // Only ever state what is actually known: which listing the ad was for.
      // Never invent requirements the person has not given.
      const enquiry = adListing
        ? `Hi! I saw this villa and I'm interested: ${adListing.url}`
        : note;
      const content = formatAsLeadMessage(at, leadName, enquiry);

      await db
        .update(leadsSyncTable)
        .set({
          content,
          leadNotes: note || (adListing ? `Ad enquiry: ${adListing.id} — ${adListing.title}` : null),
          // It IS an inbound message — say so, and the normal LIVE pass takes over.
          lastMessageFrom: "lead",
          lastMessageAt: at,
          nextFollowupAt: null,
          updatedAt: new Date(),
        })
        .where(eq(leadsSyncTable.leadId, lead.leadId));

      seeded++;
      logger.info(
        { leadId: lead.leadId, leadName, stage: lead.leadStage, adListing: adListing?.id ?? null },
        adListing
          ? "ad lead: listing code read from the lead name and seeded as the enquiry — LIVE will pick it up"
          : "sourced-lead: request note seeded as the lead's first message — LIVE will pick it up",
      );
    } catch (err) {
      logger.error({ err, leadId: lead.leadId }, "sourced-lead seeding failed");
    }
  }

  if (seeded > 0) logger.info({ seeded }, "sourced-lead seeding pass complete");
  return seeded;
}
