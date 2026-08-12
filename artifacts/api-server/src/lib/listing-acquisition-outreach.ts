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

// The scout does NOT use a fixed note format. Four layouts have turned up so
// far and the headings are free-form each time — "ORIGINAL TEXT:",
// "=== PROPERTY (from post) ===", "ОРИГИНАЛЬНЫЙ ТЕКСТ ОБЪЯВЛЕНИЯ",
// "LISTING (original post, verbatim summary)", "ORIGINAL POST TEXT". Every time
// a new one appeared it silently dropped those leads: they logged "no ORIGINAL
// TEXT", were skipped on every later pass too, and from the outside looked
// exactly like "no new leads today". So this parses STRUCTURALLY — find the
// sections, then recognise them by what the heading is about — instead of
// matching a list of names that the next run will not use.

/** The brief is the note telling OUR broker what to do — never the poster's words. */
export function isActionBrief(text: string): boolean {
  return /ACTION BRIEF|WHO TO CONTACT|FIRST MESSAGE|WHAT TO CLARIFY|POSITIONING/i.test(text);
}

/** Headings whose section holds what the poster themselves published. */
const AD_HEADING = /ORIGINAL|ОРИГИНАЛ|LISTING|POST TEXT|PROPERTY|ОБЪЯВЛЕНИ/i;

/**
 * Words that appear in the scout's SECTION headings — never in advert copy.
 *
 * "All caps and short" is not enough on its own. Rental ads shout: "PRICE
 * (minimum three months upfront):" passes every structural test and cut one
 * listing from 1009 characters to 144, and "DIRECT OWNER. NO CONSTRUCTION
 * AROUND." cut another to its title. Requiring a section word means an
 * unfamiliar heading simply gets absorbed into the previous section — the ad
 * comes through with some extra context, which is the harmless failure.
 */
const HEADING_WORDS =
  /ORIGINAL|ОРИГИНАЛ|LISTING|POST TEXT|PROPERTY|ОБЪЯВЛЕНИ|SOURCE|CONTACT|GROUP|MAPS|IDENTIFIED|HOW THE NAME|ACTION BRIEF|WHO TO|FIRST MESSAGE|WHAT TO|POSITIONING|DUPLICATE|WHATSAPP|VERIFIED|HONEST NOTE|THE OBJECT|FACEBOOK|BRIEF/i;

function isHeading(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (/^={2,}/.test(t)) return true; // === SECTION ===
  if (t.length > 60) return false;
  if (/\.\s/.test(t)) return false; // sentence breaks -> prose, not a heading
  // Judge the part before any parenthetical: "LISTING (original post, verbatim
  // summary)" is a heading even though the bracket is lowercase.
  const core = t.replace(/\([^)]*\)/g, "").replace(/[:=]+$/, "").trim();
  if (core.length < 4) return false;
  if (core !== core.toUpperCase() || !/[A-ZА-ЯЁ]{3,}/.test(core)) return false;
  return HEADING_WORDS.test(core);
}

/** Split a note into [heading, body] sections. */
function sections(note: string): Array<{ heading: string; body: string }> {
  const out: Array<{ heading: string; body: string }> = [];
  let cur: { heading: string; body: string[] } | null = null;
  for (const line of note.split("\n")) {
    if (isHeading(line)) {
      if (cur) out.push({ heading: cur.heading, body: cur.body.join("\n").trim() });
      const h = line.trim().replace(/^[=!\s]+/, "").replace(/[=\s]+$/, "");
      const inline = h.includes(":") ? h.slice(h.indexOf(":") + 1).trim() : "";
      cur = { heading: h, body: inline ? [inline] : [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) out.push({ heading: cur.heading, body: cur.body.join("\n").trim() });
  return out;
}

/**
 * What the poster themselves published about the villa — never our research or
 * our negotiating notes, which sit in other sections of the same note.
 */
export function extractOriginalAd(note: string): string | null {
  const hit = sections(note).find((s) => AD_HEADING.test(s.heading) && s.body.length > 20);
  return hit ? hit.body : null;
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

/** The lead's own title — the scout writes the listing summary into it, e.g.
 *  "The Loft@Tabanan - 4BR Tanah Lot/Beraban | 110M/mo". Public listing facts,
 *  which makes it a safe last resort when the note layout changes again. */
async function fetchLeadTitle(leadId: string): Promise<string> {
  try {
    const lead = await amoFetch<{ name?: string }>(`/api/v4/leads/${leadId}`);
    return (lead?.name ?? "").trim();
  } catch {
    return "";
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
      // A note layout we do not recognise must never make a lead disappear.
      // Skipping used to be permanent — the lead logged "no ORIGINAL TEXT" on
      // every pass forever, which from the broker's side is indistinguishable
      // from having no new leads. Fall back to the lead's own title (public
      // listing facts, never our research) and say so loudly.
      let adText = ad;
      if (!adText) {
        adText = await fetchLeadTitle(lead.leadId);
        logger.warn(
          { leadId: lead.leadId, fallbackTitle: adText, noteChars: research.length },
          "listing-acquisition: no recognisable advert section in the notes — seeding from the lead title instead. The scout's note format has changed again; check the headings.",
        );
      }
      if (!adText || adText.length < 10) {
        logger.warn({ leadId: lead.leadId }, "listing-acquisition: nothing usable to seed, leaving for the broker");
        continue;
      }

      const posterName = (await fetchContactName(lead.leadId)) || "Lister";
      const at = lead.amoCreatedAt ?? new Date();
      const content = formatAsLeadMessage(at, posterName, adText.slice(0, 2000));

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
        { leadId: lead.leadId, adChars: adText.length, briefChars: brief.length },
        "listing-acquisition: owner's listing ad seeded as the first message — LIVE will answer it",
      );
    } catch (err) {
      logger.error({ err, leadId: lead.leadId }, "listing-acquisition seeding failed");
    }
  }

  if (seeded > 0) logger.info({ seeded }, "listing-acquisition seeding pass complete");
  return seeded;
}
