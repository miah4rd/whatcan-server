/**
 * Nudges a villa owner who stopped replying while we were still acquiring the
 * listing.
 *
 * Why this exists as its own pass, and why the PUSH tab was empty until now:
 *
 * followup-scheduler.ts hard-blocks the entire Rental Listings funnel and
 * clears `nextFollowupAt` for it. That block is correct and stays. Its outbound
 * is driven by `qualification_steps` — ONE setting shared by every pipeline,
 * configured with a BUYER script. Villa owners were once queued "Saw you
 * grabbed the guide, ! 👋 Bali's still outperforming most markets on rental
 * returns", empty name and all. The comment there calls owner follow-up "a
 * later phase". This is that phase.
 *
 * So the funnel gets its own pass with its own words, exactly as the weekly
 * availability check does. Nothing here can inherit the buyer script, because
 * nothing here reads it.
 *
 * No AI, on purpose. The question is the same every time — are you still
 * renting it out — and a model that rewords it each round gives the owner a
 * reason to wonder what changed. A broker still approves every draft before it
 * sends; this pass only fills the PUSH tab.
 */
import { db, leadsSyncTable, pendingSuggestionsTable, leadMessagesTable } from "@workspace/db";
import { and, eq, sql, desc } from "drizzle-orm";
import { logger } from "./logger";
import { isListingAcquisition } from "./pipelines";
import { villaFromLeadName, fetchLeadTitle, fetchOwnerName } from "./weekly-availability-check";
import { closeLeadAsLost } from "./amo-client";
import { maybeAutopilot } from "./autopilot";
import { meetsQualified } from "./listing-card-fields";
import { ownerThreadKnown, type OwnerThreadKnown } from "./owner-thread-known";
import { ownerThreadLanguage, type OwnerLang } from "./yudi-voice";

/**
 * Stages where the owner conversation is still open.
 *
 * Deliberately a whitelist, not "everything except closed". `live` and
 * `Weekly Check Sent` are the listings we already carry — those owners have
 * their own weekly pass, and a second thread asking a different question would
 * read as two people from the same agency who do not talk to each other.
 */
const OPEN_STAGES = [
  "initial contact",
  "taken to work",
];
// NOT here since 14.09.2026: "QUALIFIED (Pre-listed)". The villa is qualified
// and its next step is Yudi's inspection visit; the owner's silence there is
// worked by the inspection booking ladder (lib/inspection-booking.ts: one ask,
// at most two follow-ups two days apart, then Yudi's call). This nudge asks for
// bedrooms, price, dates and the viewing day — on a qualified card that is
// asking again what the owner already gave, and three silent nudges closed a
// card that only needed a visit. "Details ased" was deleted the same day.
// NOT here either: "Inspection sceduled" (id 87763170): a visit is agreed.
// A new stage name must not contain "taken to work" or "initial contact" by
// accident — `isOpenStage` matches by substring.

/**
 * How long a card must have been quiet before each round, counted from OUR last
 * real message. The owner's cadence: a day, then three days after that, then
 * five (2026-09-03).
 *
 * Measuring every round from `lastOurMessageAt` rather than from the previous
 * DRAFT is what makes the spacing real: a nudge that actually sends moves that
 * timestamp, so the next round waits its own full interval from the send. A
 * nudge the broker skipped never moves it, so the rounds still space out
 * instead of firing back to back the moment the draft leaves the queue.
 */
const NUDGE_AFTER_HOURS = [24, 72, 120];
/**
 * How long the last nudge is given to land before the card is closed.
 *
 * Five days, the same as the gap the third nudge itself waited: if that much
 * silence was not worth another message, it is not worth an open card either.
 */
const CLOSE_AFTER_LAST_NUDGE_HOURS = 120;
/**
 * Three rounds, then stop.
 *
 * It was ONE for the first run of this funnel — nobody had ever followed up an
 * owner here and we did not know how they would react. That run happened, and
 * the cost of the cap showed up in the data: 74 cards of 101 had already spent
 * their single nudge, meaning an owner who ignored one message was never
 * contacted again and the card sat in the funnel forever with nothing scheduled
 * against it. Three rounds on a widening cadence is the owner's decision
 * (2026-09-03).
 */
const MAX_NUDGES = NUDGE_AFTER_HOURS.length;

/**
 * How many drafts one pass may write.
 *
 * Without this the first run would have dropped ~96 drafts into one broker's
 * PUSH tab at once, which is not a working queue — it is a wall he scrolls past.
 * The pass runs every five minutes, so the backlog drains steadily instead.
 */
const BATCH_LIMIT = 12;

function isOpenStage(stage: string | null): boolean {
  const s = (stage ?? "").toLowerCase();
  return OPEN_STAGES.some((k) => s.includes(k));
}

/**
 * The points a nudge can ask, in the order they are asked. `price_plain` is the price when the
 * commission position is already known (they said net, included, or named a rate): asking it
 * "including our 10%" again would re-ask the half they answered.
 */
export type NudgeAsk = "still_renting" | "availability" | "owner" | "bedrooms" | "price" | "price_plain" | "commission" | "min_stay" | "viewing";

/** The asks that are owner points of their own (`price_plain` is a phrasing of `price`). */
type AskPoint = Exclude<NudgeAsk, "price_plain">;

const MISSING_TO_ASK: Array<[(m: string) => boolean, AskPoint]> = [
  [(m) => m.startsWith("not the owner"), "owner"],
  [(m) => m === "bedrooms", "bedrooms"],
  [(m) => m === "price", "price"],
  [(m) => m === "commission position", "commission"],
  [(m) => m === "minimum stay", "min_stay"],
  [(m) => m === "earliest viewing", "viewing"],
  // Occupied with no date (long term regulation, 15.09.2026): the card is not parked, the date is asked.
  [(m) => m === "free date", "availability"],
];

/**
 * What a nudge may ask this owner: what the card is still missing, minus every point the thread
 * already answers (owner-thread-known.ts).
 *
 * Until 14.09.2026 a nudge whose missing list held nothing it knew how to phrase (a card with all
 * data, a floor or commission-terms note, a failed extraction) asked the WHOLE checklist, opened by
 * "are you still looking to rent it out?". Villa Yoshi had given price with our 10%, the free date,
 * the minimum stay and a viewing time five days earlier and got exactly that on 12.09; Ersanea,
 * Umbala, Gelareh and Villa Amor the same week. And a fact the extraction read as `null` (a price in
 * USD, "tidak ada minimum") was asked again as missing.
 *
 * - An owner who never replied: whether it is still for rent, and who they are (three options).
 * - An owner who replied: only the open qualification points. Unsure (no facts could be read):
 *   nothing — a nudge that might repeat a question is worse than no nudge.
 * - Nothing open: no nudge at all. The card's next step is not a question.
 */
export function nudgeAsks(k: OwnerThreadKnown, missing: string[] | null): NudgeAsk[] {
  if (!k.ownerReplied) {
    return (["still_renting", "owner"] as AskPoint[]).filter((a) => !k.known[a]);
  }
  if (missing === null) return [];
  // They named a commission rate that is not ours: the terms are the broker's call, not a question
  // a bot repeats (Ersanea "our commission is 5%" got "including our 10%" again on 08.09).
  if (missing.some((m) => m.startsWith("commission terms to agree"))) return [];
  const asks: NudgeAsk[] = [];
  for (const [is, a] of MISSING_TO_ASK) {
    if (missing.some(is) && !k.known[a] && !asks.includes(a)) asks.push(a);
  }
  // A price the extraction could not read (USD, a pasted brochure) is still a price: the only open
  // question is whether our 10% is inside it.
  if (missing.includes("price") && k.known.price && !k.known.commission && !asks.includes("commission")) {
    asks.push("commission");
  }
  const priceAt = asks.indexOf("price");
  if (priceAt !== -1 && k.known.commission) asks[priceAt] = "price_plain";
  return asks;
}

const HONORIFIC = /^(pak|bapak|bu|ibu|bli|mbak|mas|kak|ka)$/i;

/** "Pak Damien" → pak Damien / pak; "Diana" → kak Diana / kak; no name → kak / kak. */
export function indonesianAddress(name: string): { greet: string; call: string } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { greet: "kak", call: "kak" };
  const first = parts[0]!.toLowerCase();
  if (HONORIFIC.test(first) && parts.length > 1) {
    const call = first === "bapak" ? "pak" : first === "ibu" ? "bu" : first === "ka" ? "kak" : first;
    return { greet: `${call} ${parts.slice(1).join(" ")}`, call };
  }
  return { greet: `kak ${parts.join(" ")}`, call: "kak" };
}

function baliDayPart(at: Date): string {
  const h = Number(at.toLocaleString("en-GB", { timeZone: "Asia/Makassar", hour: "2-digit", hourCycle: "h23" }));
  return h < 11 ? "pagi" : h < 15 ? "siang" : h < 18 ? "sore" : "malam";
}

function joinList(items: string[], and: string): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`;
}

/** The villa name as the scout's title gives it, or "" when there is none worth saying. */
export function spokenVilla(villa: string): string {
  return villa && villa.toLowerCase() !== "your villa" ? villa : "";
}

/** How Yudi opens: "Selamat siang kak Diana" / "Hello Marc". */
export function ownerGreeting(owner: string, lang: OwnerLang, at: Date = new Date()): { line: string; call: string } {
  if (lang === "id") {
    const a = indonesianAddress(owner);
    return { line: `Selamat ${baliDayPart(at)} ${a.greet}`, call: a.call };
  }
  return { line: owner ? `Hello ${owner}` : "Hello", call: "" };
}

/**
 * The ask lines, in Yudi's words: the phrasings are his own from his phone messages to owners ("may
 * i know if those pricing already included with 10% agency commission?", "may i double check if
 * this price is already included with 10% agency commission?", "Untuk harga nya apakah sudah
 * include 10% komisi agensi ya kak?", "Boleh di bantu untuk details harga nya ya kak?"). Shared by
 * the nudge and the long-term availability check. Still no AI (see the header): the same question
 * every round, but a short one, in the owner's language, with the price asked in the shape we need.
 */
export function ownerAskLines(asks: NudgeAsk[], o: { lang: OwnerLang; villa: string; call?: string }): string[] {
  const lines: string[] = [];
  const has = (a: NudgeAsk) => asks.includes(a);
  if (o.lang === "id") {
    const call = o.call || "kak";
    const villa = spokenVilla(o.villa) || "villanya";
    if (has("still_renting")) lines.push(`Untuk ${villa} apakah masih tersedia untuk sewa bulanan atau tahunan ya ${call}?`);
    if (has("availability")) lines.push(`Kira-kira ${villa} kosong lagi mulai kapan ya ${call}?`);
    const nouns = [
      has("bedrooms") && "jumlah kamar tidurnya",
      has("price") && "harga sewa bulanan dan tahunan yang sudah termasuk 10% komisi agensi",
      has("price_plain") && "harga sewa bulanan dan tahunannya",
      has("min_stay") && "minimal sewanya",
      has("viewing") && "kapan kami bisa bawa client untuk lihat villanya",
    ].filter((x): x is string => Boolean(x));
    if (nouns.length) {
      lines.push(`${has("still_renting") ? "Boleh" : `Untuk ${villa}, boleh`} di bantu info ${joinList(nouns, "dan")} ya ${call}?`);
    }
    if (has("commission") && !has("price") && !has("price_plain")) lines.push(`Untuk harganya apakah sudah termasuk 10% komisi agensi ya ${call}?`);
    if (has("owner")) {
      lines.push(`${lines.length ? "Dan apakah" : "Apakah"} ${call} owner villanya, tim dari owner, atau ada management company yang kelola?`);
    }
    return lines;
  }
  const villa = spokenVilla(o.villa) || "your villa";
  if (has("still_renting")) lines.push(`Is ${villa} still available for monthly or yearly rent?`);
  if (has("availability")) lines.push(`Roughly from when will ${villa} be free again?`);
  const nouns = [
    has("bedrooms") && "the number of bedrooms",
    has("price") && "the monthly and yearly price, already included with our 10% agency commission",
    has("price_plain") && "the monthly and yearly price",
    has("min_stay") && "the minimum rental period",
    has("viewing") && "when we could bring a client to view the villa",
  ].filter((x): x is string => Boolean(x));
  if (nouns.length) lines.push(`${has("still_renting") ? "May I also know" : `For ${villa}, may I know`} ${joinList(nouns, "and")}?`);
  if (has("commission") && !has("price") && !has("price_plain")) {
    lines.push("May I double check if the price is already included with our 10% agency commission?");
  }
  if (has("owner")) {
    lines.push(`${lines.length ? "Also, may" : "May"} I know if you are the owner, part of the owner's team, or is there a management company looking after it?`);
  }
  return lines;
}

/**
 * The owner reads this: a greeting line, only the questions still open, a short thanks — the shape
 * of Yudi's own follow-ups ("Hallo bu Ana / apakah sudah ada details nya ya?"). No "we have clients
 * searching in the area right now" (41% of auto-sent owner messages said "clients"; Yudi 11%), no
 * "that's everything we need". Empty when there is nothing to ask.
 */
export function composeNudge(o: { owner: string; villa: string; lang: OwnerLang; asks: NudgeAsk[]; at?: Date }): string {
  if (!o.asks.length) return "";
  const g = ownerGreeting(o.owner, o.lang, o.at);
  const asks = ownerAskLines(o.asks, { lang: o.lang, villa: o.villa, call: g.call });
  return [g.line, ...asks, o.lang === "id" ? "Terimakasih" : "Thank you"].join("\n");
}

/**
 * Cards where the last look found nothing left to ask, keyed by the newest message then: the pass
 * runs every five minutes and must not pay for an extraction on the same unchanged thread each time.
 * A failed extraction is retried after an hour.
 */
const nothingToAsk = new Map<string, { newestMs: number; until: number }>();

/**
 * Queue one owner nudge per silent listing card. Returns how many were written.
 */
export async function processListingOwnerFollowup(): Promise<number> {
  // "Went quiet" is measured from OUR last message, not from the card's
  // updated_at: amoCRM stamps that on any edit, so a card touched for an
  // unrelated reason would look like a live conversation.
  const candidates = await db
    .select({
      leadId: leadsSyncTable.leadId,
      responsibleUser: leadsSyncTable.responsibleUser,
      pipeline: leadsSyncTable.pipeline,
      leadStage: leadsSyncTable.leadStage,
      botExcluded: leadsSyncTable.botExcluded,
      followupLevel: leadsSyncTable.followupLevel,
      lastOurMessageAt: leadsSyncTable.lastOurMessageAt,
      lastMessageFrom: leadsSyncTable.lastMessageFrom,
    })
    .from(leadsSyncTable)
    .where(
      and(
        sql`lower(${leadsSyncTable.pipeline}) = 'rental listings'`,
        sql`${leadsSyncTable.lastOurMessageAt} is not null`,
      ),
    );

  if (candidates.length === 0) return 0;

  let queued = 0;
  for (const lead of candidates) {
    if (queued >= BATCH_LIMIT) break;
    try {
      if (lead.botExcluded) continue;
      // Belt and braces, same as the weekly pass: the pipeline name is the
      // trigger, but only this funnel has owners to nudge.
      if (!isListingAcquisition(lead.pipeline)) continue;
      if (!isOpenStage(lead.leadStage)) continue;

      // The owner answered — that is not silence, and the LIVE path handles it.
      // Who spoke last is read from the THREAD, not from
      // leads_sync.last_message_from: that column keeps "lead" after the bot
      // answers (the send path stamps last_our_message_at only), so owners the
      // bot had already answered looked like owners waiting on us and were
      // never nudged again. On 12.09 eleven cards sat like that since 05–06.09
      // with the owner talking and us silent for a week. The column is only a
      // fallback for a card whose thread was never logged.
      const [newest] = await db
        .select({ who: leadMessagesTable.senderType, at: leadMessagesTable.sentAt })
        .from(leadMessagesTable)
        .where(and(eq(leadMessagesTable.leadId, lead.leadId), sql`${leadMessagesTable.text} IS NOT NULL`))
        .orderBy(desc(leadMessagesTable.sentAt))
        .limit(1);
      const ownerSpokeLast = newest ? newest.who === "lead" : (lead.lastMessageFrom ?? "").toLowerCase() === "lead";
      if (ownerSpokeLast) continue;
      // Silence runs from OUR latest word, whichever record has it: a reply
      // Yudi typed on his phone is in the thread but not in last_our_message_at.
      const lastOursAtMs = Math.max(lead.lastOurMessageAt!.getTime(), newest ? newest.at.getTime() : 0);

      // followupLevel is free to use here: the buyer scheduler clears
      // nextFollowupAt for this funnel and never advances the level on it.
      const round = (lead.followupLevel ?? 0) + 1;
      if (round > MAX_NUDGES) {
        // The ladder is spent and the owner never came back. Leaving the card in
        // TAKEN TO WORK forever is the worst of the options: it is not worked by
        // the bot, which is done with it, and not by the broker, who has no
        // reason to open a card nothing points at. The owner's rule (04.09.2026):
        // after the third nudge with nothing back, close it.
        const silentHours = (Date.now() - lastOursAtMs) / 3_600_000;
        if (silentHours >= CLOSE_AFTER_LAST_NUDGE_HOURS) {
          const ok = await closeLeadAsLost(lead.leadId);
          logger.info(
            { leadId: lead.leadId, silentHours: Math.round(silentHours), nudges: lead.followupLevel },
            "listing closed: three nudges, no reply",
          );
          if (ok) {
            await db
              .update(leadsSyncTable)
              .set({ nextFollowupAt: null, updatedAt: new Date() })
              .where(eq(leadsSyncTable.leadId, lead.leadId));
          }
        }
        continue;
      }

      const silentHours = (Date.now() - lastOursAtMs) / 3_600_000;
      if (silentHours < NUDGE_AFTER_HOURS[round - 1]!) continue;

      // Already waiting for the broker — a second identical card every five
      // minutes is how a queue becomes something people stop opening.
      const [pending] = await db
        .select({ id: pendingSuggestionsTable.id })
        .from(pendingSuggestionsTable)
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, lead.leadId),
            eq(pendingSuggestionsTable.status, "pending"),
          ),
        )
        .limit(1);
      if (pending) continue;

      // Only what the thread has not answered (owner-thread-known.ts). Nothing left: no nudge,
      // and the ladder does not advance — a card with nothing to ask is not a silent owner.
      const newestMs = newest ? newest.at.getTime() : 0;
      const memo = nothingToAsk.get(lead.leadId);
      if (memo && memo.newestMs === newestMs && Date.now() < memo.until) continue;
      const known = await ownerThreadKnown(lead.leadId);
      const asks = nudgeAsks(known, known.facts ? meetsQualified(known.facts).missing : null);
      if (!asks.length) {
        nothingToAsk.set(lead.leadId, {
          newestMs,
          until: known.facts ? Number.POSITIVE_INFINITY : Date.now() + 3_600_000,
        });
        logger.info(
          { leadId: lead.leadId, round, factsRead: Boolean(known.facts), known: Object.keys(known.known) },
          "listing-owner-followup: nothing left to ask that the thread has not answered — no nudge",
        );
        continue;
      }

      const title = await fetchLeadTitle(lead.leadId);
      const villa = villaFromLeadName(title);
      const owner = await fetchOwnerName(lead.leadId, villa);
      const lang = ownerThreadLanguage(known.lines);

      await db.insert(pendingSuggestionsTable).values({
        leadId: lead.leadId,
        responsibleUser: lead.responsibleUser,
        // kind "push" lands in the PUSH tab. It stays out of REACH because that
        // tab is selected by stage name (REACH_STAGE_KEYWORDS) and none of the
        // open acquisition stages are in it.
        kind: "push",
        suggestionText: composeNudge({ owner, villa, lang, asks }),
        status: "pending",
      });

      await db
        .update(leadsSyncTable)
        .set({ followupLevel: round })
        .where(eq(leadsSyncTable.leadId, lead.leadId));

      queued++;
      logger.info(
        { leadId: lead.leadId, villa, round, silentHours: Math.round(silentHours), asks, lang },
        "listing-owner-followup: queued an owner nudge",
      );
      // Autopilot judges the nudge NOW — sends it if the stage is delegated and
      // it is daytime, or stamps "waiting" so the inbox knows the bot owns it.
      // Inserted straight into the table, it had no verdict, and the inbox's
      // 30-minute safety net then surfaced it to the broker as his to send.
      void maybeAutopilot(lead.leadId);
    } catch (err) {
      logger.error({ err, leadId: lead.leadId }, "listing-owner-followup: failed for this card");
    }
  }

  if (queued > 0) logger.info({ queued }, "listing-owner-followup pass complete");
  return queued;
}
