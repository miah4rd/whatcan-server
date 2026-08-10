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

// The scout writes notes in TWO layouts and they must both parse. Assuming a
// single format silently dropped 4 of 11 leads on the first run — they logged
// "no ORIGINAL TEXT" and were skipped forever, which looks identical to "no
// leads today":
//   A) "SOURCE - ..." / "ORIGINAL TEXT:" / "IDENTIFIED VILLA (...)" / "GOOGLE MAPS"
//   B) "=== SOURCE / FULL CHAIN ===" / "=== PROPERTY (from post) ===" /
//      "=== ACTION BRIEF FOR LISTING AGENT ==="
/** Exported for the note-parsing test — both layouts must keep parsing. */
export function isActionBrief(text: string): boolean {
  return /^\s*=*\s*ACTION BRIEF/i.test(text);
}

/**
 * The scout's own section headings — an explicit list, matched CASE-SENSITIVELY.
 *
 * A generic "this line looks like a heading" test (all-caps, ends in a colon)
 * cannot work here: rental ads shout. "DIRECT OWNER. NO CONSTRUCTION AROUND.
 * LONG TERM ONLY." and "PRICE (minimum three months upfront):" are ad copy, and
 * the heuristic version of this function treated the first one as a section
 * break — trimming a 900-character listing down to its title line, which the
 * bot would then have answered knowing nothing but "2BR in Pererenan".
 * Case-sensitivity is what keeps the ad's own "WhatsApp ..." and "Contact: ..."
 * lines from being mistaken for the scout's "=== WHATSAPP ===" section.
 */
const SCOUT_HEADING =
  /^\s*(?:={2,}|!{2,})?\s*(SOURCE|ORIGINAL TEXT|IDENTIFIED VILLA|GOOGLE MAPS|WHATSAPP|PROPERTY|ACTION BRIEF|POSSIBLE DUPLICATE)\b/;

function isHeading(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (/^={2,}/.test(t)) return true; // === SECTION === (layout B, unambiguous)
  return SCOUT_HEADING.test(t);
}

/** The body under `headingRe`, up to the next heading. */
function sectionAfter(note: string, headingRe: RegExp): string | null {
  const lines = note.split("\n");
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start === -1) return null;
  const kept: string[] = [];
  const sameLine = lines[start].replace(headingRe, "").replace(/^[\s:=]+/, "").replace(/=+$/, "").trim();
  if (sameLine) kept.push(sameLine);
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeading(lines[i])) break;
    kept.push(lines[i]);
  }
  const text = kept.join("\n").trim();
  return text.length > 20 ? text : null;
}

/**
 * What the poster themselves put out about the villa.
 *
 * Layout A gives the ad verbatim under "ORIGINAL TEXT:". Layout B has no
 * verbatim copy — "PROPERTY (from post)" is the same content restated as
 * bullets. Both are the poster's own facts, which is what the draft needs;
 * everything else in the note (our research, the duplicate warning, the brief)
 * is ours and stays out of the conversation.
 */
export function extractOriginalAd(note: string): string | null {
  return (
    sectionAfter(note, /ORIGINAL TEXT\s*:/i) ??
    sectionAfter(note, /^\s*=*\s*PROPERTY\b[^=]*=*\s*$/i)
  );
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
      // Only a REAL send blocks seeding — a broker approved or edited something,
      // and rewriting the conversation under them would be dishonest.
      //
      // Counting 'pending' here let the bot lock itself out: the follow-up
      // scheduler queued a draft for these leads before this pass reached them,
      // and from then on every pass skipped the lead as "already worked", so it
      // kept the draft written with no listing context forever. A draft nobody
      // has approved is not history worth protecting. (A `skipped` row must not
      // block either — that bug is documented in sourced-lead-outreach.ts.)
      const [alreadySent] = await db
        .select({ id: pendingSuggestionsTable.id })
        .from(pendingSuggestionsTable)
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, lead.leadId),
            sql`${pendingSuggestionsTable.status} IN ('approved','edited')`,
          ),
        )
        .limit(1);
      if (alreadySent) continue;

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

      // Retire any draft written before we had the ad — it was composed blind,
      // and on this pipeline that meant a buyer-funnel template addressed to a
      // villa owner. The LIVE pass writes a fresh one from the seeded ad.
      await db
        .update(pendingSuggestionsTable)
        .set({ status: "skipped" })
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, lead.leadId),
            eq(pendingSuggestionsTable.status, "pending"),
          ),
        );

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
