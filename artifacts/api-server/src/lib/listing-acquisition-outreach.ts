/**
 * Seeds the conversation for Rental Listings leads.
 *
 * A scouting bot works Facebook rental groups, finds a villa being advertised,
 * and creates the amoCRM card with TWO notes:
 *   1. the source + the owner's ORIGINAL public post + the villa it identified
 *      (real name, Google Maps pin);
 *   2. an ACTION BRIEF written for our own broker — which number to use, what
 *      to clarify, where the price looks wrong, how to approach the poster.
 *
 * Those notes live in amoCRM, not in leads_sync, so the first version of this
 * pass generated openers with NOTHING but the broker's name: no villa, no
 * price, no area — and, worse, it pitched listing management at a poster whose
 * ad said "No agents please", which is exactly what the brief warned against.
 *
 * Same shape as sourced-lead-outreach.ts: write the owner's OWN ad into the
 * conversation as their first message and let the normal LIVE pass answer it,
 * rather than bolting a second generation path on the side.
 *
 * The two notes are NOT equivalent and must not be merged:
 *   • the ad is the poster's own words — safe to treat as what they said;
 *   • the ACTION BRIEF is our internal strategy ("push back on price", "the pin
 *     is 4 km off"). It goes to lead_notes, where the prompt reads it as
 *     guidance. Feeding it in as the lead's words would have the bot reciting
 *     our own negotiating position back to the person we're negotiating with.
 */
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, and, or, isNull, isNotNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { amoFetch } from "./amo-client";

type AmoNote = { note_type?: string; params?: { text?: string } };

/** amoCRM returns note text HTML-escaped — &quot; all over a Facebook ad. */
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function isActionBrief(text: string): boolean {
  return /^\s*ACTION BRIEF/i.test(text);
}

/**
 * The poster's own words, from the "ORIGINAL TEXT:" block. Everything after it
 * (IDENTIFIED VILLA, GOOGLE MAPS) is the scout's research, not theirs — it stops
 * at the next all-caps section heading. Falls back to the whole note when the
 * scout used a different layout, so a format change degrades to "too much
 * context" rather than to none at all.
 */
function extractOriginalAd(note: string): string | null {
  const start = note.search(/ORIGINAL TEXT\s*:/i);
  if (start === -1) return null;
  const after = note.slice(start).replace(/^ORIGINAL TEXT\s*:/i, "");
  const lines = after.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    // A heading line: all-caps words, no lowercase letters, e.g.
    // "IDENTIFIED VILLA (Google Lens on exterior photo):" or "GOOGLE MAPS ...".
    if (kept.length > 0 && /^[A-Z][A-Z0-9 ()/,'-]{6,}/.test(line.trim()) && !/[a-z]/.test(line.trim().split("(")[0] ?? "")) break;
    kept.push(line);
  }
  const text = kept.join("\n").trim();
  return text.length > 20 ? text : null;
}

async function fetchLeadNotes(leadId: string): Promise<{ ad: string | null; brief: string; research: string }> {
  try {
    const data = await amoFetch<{ _embedded?: { notes?: AmoNote[] } }>(
      `/api/v4/leads/${leadId}/notes?limit=25`,
    );
    const texts = (data?._embedded?.notes ?? [])
      .map((n) => decodeEntities((n.params?.text ?? "").trim()))
      .filter((t) => t.length > 20);

    const briefs = texts.filter(isActionBrief);
    const others = texts.filter((t) => !isActionBrief(t));

    let ad: string | null = null;
    for (const t of others) {
      ad = extractOriginalAd(t);
      if (ad) break;
    }
    return {
      ad,
      brief: briefs.join("\n\n").slice(0, 4000),
      research: others.join("\n\n").slice(0, 4000),
    };
  } catch (err) {
    logger.warn({ err, leadId }, "listing-acquisition: notes fetch failed");
    return { ad: null, brief: "", research: "" };
  }
}

/** The person who posted, for the conversation line. Never a placeholder. */
async function fetchContactName(leadId: string): Promise<string> {
  try {
    const lead = await amoFetch<{ _embedded?: { contacts?: Array<{ id: number }> } }>(
      `/api/v4/leads/${leadId}?with=contacts`,
    );
    const contactId = lead?._embedded?.contacts?.[0]?.id;
    if (!contactId) return "";
    const contact = await amoFetch<{ name?: string }>(`/api/v4/contacts/${contactId}`);
    const name = (contact?.name ?? "").trim();
    if (!name || /^<|dummy|test lead|full_name/i.test(name)) return "";
    return name;
  } catch {
    return "";
  }
}

/**
 * amoCRM's `content` shape, so the existing parser reads this as inbound.
 * Timestamp written +3h because parseDialogContent treats these as Moscow time
 * and subtracts the offset — see sourced-lead-outreach.ts for the same trick.
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

export async function processListingAcquisitionOutreach(): Promise<number> {
  const candidates = await db
    .select({
      leadId: leadsSyncTable.leadId,
      responsibleUser: leadsSyncTable.responsibleUser,
      amoCreatedAt: leadsSyncTable.amoCreatedAt,
    })
    .from(leadsSyncTable)
    .where(
      and(
        sql`lower(coalesce(${leadsSyncTable.pipeline}, '')) = 'rental listings'`,
        isNull(leadsSyncTable.lastMessageFrom),
        or(isNull(leadsSyncTable.content), eq(leadsSyncTable.content, "")),
        or(eq(leadsSyncTable.botExcluded, false), isNull(leadsSyncTable.botExcluded)),
        // Recent cards only — same reasoning as sourced-lead-outreach: without
        // this the first pass after a deploy reaches back through every old
        // card ever parked in this pipeline.
        isNotNull(leadsSyncTable.amoCreatedAt),
        sql`${leadsSyncTable.amoCreatedAt} > now() - interval '30 days'`,
      ),
    );

  if (candidates.length === 0) return 0;

  let seeded = 0;
  for (const lead of candidates) {
    try {
      // Someone already worked this lead — don't rewrite history under them.
      // Only a live card or a real send counts; a `skipped` row must not make
      // the lead permanently unseedable (that bug is documented in
      // sourced-lead-outreach.ts).
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

      const { ad, brief, research } = await fetchLeadNotes(lead.leadId);
      // No ad text means no idea what this listing even is. Seeding a blank
      // conversation would just reproduce the context-free opener this pass
      // exists to fix, so leave it for the broker.
      if (!ad) {
        logger.info({ leadId: lead.leadId }, "listing-acquisition: no ORIGINAL TEXT in notes, skipping");
        continue;
      }

      const posterName = (await fetchContactName(lead.leadId)) || "Lister";
      const at = lead.amoCreatedAt ?? new Date();
      const content = formatAsLeadMessage(at, posterName, ad.slice(0, 2000));

      // The scout's research and brief reach the prompt as LEAD CARD INFO —
      // guidance for the bot, never quoted to the poster.
      const notesForPrompt = [research, brief].filter(Boolean).join("\n\n").slice(0, 6000);

      await db
        .update(leadsSyncTable)
        .set({
          content,
          leadNotes: notesForPrompt || null,
          lastMessageFrom: "lead",
          lastMessageAt: at,
          nextFollowupAt: null,
          updatedAt: new Date(),
        })
        .where(eq(leadsSyncTable.leadId, lead.leadId));

      seeded++;
      logger.info(
        { leadId: lead.leadId, adChars: ad.length, briefChars: brief.length },
        "listing-acquisition: owner's listing ad seeded as the first message — LIVE will answer it",
      );
    } catch (err) {
      logger.error({ err, leadId: lead.leadId }, "listing-acquisition seeding failed");
    }
  }

  if (seeded > 0) logger.info({ seeded }, "listing-acquisition seeding pass complete");
  return seeded;
}
