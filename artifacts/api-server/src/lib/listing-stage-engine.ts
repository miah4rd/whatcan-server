/**
 * The ONE owner of every stage before the handover on the listing funnel.
 *
 * Until 07.09.2026 five independent movers set these stages, each on its own
 * trigger with its own guards: the qualification rule, the parking router,
 * two release functions, and a conversation classifier that judged prose.
 * They did not know about each other. The result the owner found by opening
 * cards: QUALIFIED cards pulled back to TAKEN TO WORK minutes after promotion
 * (Casa Ola four times), cards in Details on "will be happy to discuss" with
 * no price, owners parked in co-broke, villas free in October parked as
 * "long term" with a free date in 2024.
 *
 * Now the stage is a FUNCTION of the accumulated facts (`desiredStage`, pure,
 * below), and `reconcileListingStage` is the only code that moves a card
 * between these stages. Same facts, same stage, however many times it runs.
 *
 *   Initial Contact     nothing has gone out yet
 *   TAKEN TO WORK       outreach sent; the owner's answers are still short
 *                       of the bar (or the owner has not replied)
 *   long term           qualified, but occupied beyond 90 days until a date the owner named
 *                       himself (regulation 15.09.2026: owner side, bedrooms, price with
 *                       commission, his own date); leaves two weeks before that date
 *   co-broke Agents     the counterpart is a separate business (confirmed)
 *   Closed - lost       below the 33M floor, or not our format (confirmed)
 *   QUALIFIED           every fact on the bar is known — the handover point
 *
 * Beyond QUALIFIED the engine computes where the facts say a card should be,
 * reports the gap, and never moves it: `engineOwnsStage` is false there.
 * "Inspection sceduled" (id 87763170, a visit agreed — "Inspection. done"
 * until 14.09.2026, "agreement" before 09.09; "Details ased" 87763166 was
 * deleted 14.09) is set from the thread by lib/listing-progress.ts, run on every message and
 * once a day after this audit; live only by the site's Listed switch
 * (listing-status-pass.ts). Stage names are matched by exact string here and
 * the owner renames stages: new code uses ids. Two closers stay outside the engine because they
 * are driven by time, not facts: three unanswered nudges
 * (listing-owner-followup) and a number without WhatsApp (undeliverable).
 *
 * Flapping is prevented by two things: facts ACCUMULATE (a fresh extraction is
 * merged with the card's own fields, never downgrading a settled fact — see
 * withCardFacts), and a parked card leaves its parking only on positive
 * evidence: a free date within 90 days, or the owner writing again and no
 * longer being occupied; the owner being the counterpart. An extraction that
 * merely came back thinner moves nothing.
 */
import { db, leadsSyncTable, leadMessagesTable, sentMessagesTable, stageEventsTable, brokerSettingsTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { publishedListingFor } from "./listing-live-link";
import {
  getAmoLead,
  updateLeadStatus,
  closeLeadAsLost,
  createAmoTask,
  getOpenAmoTasks,
  completeAmoTasks,
  amoPost,
  LONG_TERM_TASK_PREFIX,
} from "./amo-client";
import { longTermControl } from "./long-term-control";
import { safeStageIdForLead } from "./stage-classifier";
import { isListingAcquisition } from "./pipelines";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";
import { notifyBroker } from "./push-notifications";
import { auditListingProgress } from "./listing-progress";
import { returnHold, ownerWroteSince } from "./listing-return-hold";
import {
  type ListingFacts,
  extractListingFacts,
  meetsQualified,
  floorQuoteIdr,
  freeSoon,
  plausibleFreeDate,
  confirmsNotOurFormat,
  notOurFormatVetoed,
  syncListingFactsToCard,
  MIN_LISTING_MONTHLY_IDR,
  longTermBar,
  ownerFreeWords,
  availableFromLine,
  dateFromAvailableLine,
  humanDate,
  writeListingAvailableFrom,
  stripQuotedText,
} from "./listing-card-fields";

export const STAGE = {
  INITIAL: "Initial Contact",
  WORK: "TAKEN TO WORK",
  QUALIFIED: "QUALIFIED (Pre-listed)",
  LONG_TERM: "long term",
  CO_BROKE: "co-broke Agents",
  CLOSED_LOST: "Closed - lost",
} as const;
export type EngineStage = (typeof STAGE)[keyof typeof STAGE];

/** Two weeks before a parked villa frees up, the broker is reminded. */
const REMIND_BEFORE_DAYS = 14;

const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

export function isTerminalStage(stage: string | null | undefined): boolean {
  const s = norm(stage);
  return s.includes("closed") || s.includes("lost") || s.includes("won");
}

/** Stages the engine may move a card OUT of. QUALIFIED is arrival-only. */
export function engineOwnsStage(stage: string | null | undefined): boolean {
  const s = norm(stage);
  return (
    s === norm(STAGE.INITIAL) ||
    s === norm(STAGE.WORK) ||
    s === norm(STAGE.LONG_TERM) ||
    s === norm(STAGE.CO_BROKE)
  );
}

export function emptyFacts(): ListingFacts {
  return {
    bedrooms: null,
    monthlyIdr: null,
    maxMonthlyIdr: null,
    priceNote: null,
    yearlyIdr: null,
    commission: "unknown",
    availableFrom: null,
    minStayMonths: null,
    viewableFrom: null,
    area: null,
    mapsLink: null,
    photosLink: null,
    counterpart: "unclear",
    theirCommissionPct: null,
    stopSignal: null,
    stopKind: null,
    freeFromIso: null,
    freeFromQuote: null,
  };
}

export type EngineInput = {
  facts: ListingFacts;
  /** Any message of ours in the thread. */
  outboundSent: boolean;
  /** Any message from the owner's side in the thread. */
  ownerReplied: boolean;
  /** The free date is in the villa side's own words, found in their messages. Absent = no. */
  ownerSaidFreeDate?: boolean;
};

export type Desired = {
  stage: EngineStage;
  reason: string;
  /** A close or a co-broke parking is confirmed by a focused second opinion
   *  before it is applied (destructive-verdict rule). */
  confirm?: "not_our_format" | "third_party";
  /** Closed on the price floor — waits for the negotiation (see reconcile). */
  floor?: true;
};

/**
 * Where the facts say the card belongs. Pure: no I/O, no clock beyond
 * freeSoon's "today". Order matters and encodes the owner's priorities:
 * a deterministic price beats everything, WHO beats occupancy, occupancy
 * beats format, and qualification is judged last.
 */
export function desiredStage(i: EngineInput): Desired {
  const f = i.facts;
  if (!i.outboundSent) return { stage: STAGE.INITIAL, reason: "nothing sent yet" };
  if (!i.ownerReplied) return { stage: STAGE.WORK, reason: "outreach sent, no reply yet" };

  const quoted = floorQuoteIdr(f);
  if (quoted !== null && quoted < MIN_LISTING_MONTHLY_IDR) {
    return {
      stage: STAGE.CLOSED_LOST,
      reason: `below our floor: ${Math.round(quoted / 1_000_000)}M client-facing, minimum ${MIN_LISTING_MONTHLY_IDR / 1_000_000}M`,
      floor: true,
    };
  }
  if (f.counterpart === "manager" || f.counterpart === "agent") {
    return { stage: STAGE.CO_BROKE, reason: `counterpart is ${f.counterpart}`, confirm: "third_party" };
  }
  // long term (regulation 15.09.2026): parked ONLY with the whole card in hand — owner side, bedrooms,
  // price with commission, and a date the owner named himself (longTermBar). An occupied villa short
  // of any of them stays in TAKEN TO WORK, where the bot keeps asking: on 15.09, 23 of the 33 parked
  // cards had no price, because "occupied, date unknown" parked a card for good. A far date with no
  // stop word is the same villa ("next year" on 23537943 would otherwise have qualified).
  const freeAt = plausibleFreeDate(f);
  const occupiedBeyondWindow =
    !freeSoon(f) && (f.stopKind === "occupied" || (f.stopKind === null && !!freeAt && freeAt.getTime() > Date.now()));
  if (occupiedBeyondWindow) {
    const bar = longTermBar(f, i.ownerSaidFreeDate === true);
    if (bar.ok) return { stage: STAGE.LONG_TERM, reason: `occupied, the owner says free from ${f.freeFromIso}` };
    return { stage: STAGE.WORK, reason: `occupied, not long term yet: ${bar.missing.join(", ")}` };
  }
  if (f.stopKind === "not_our_format" && !notOurFormatVetoed(f)) {
    return {
      stage: STAGE.CLOSED_LOST,
      reason: `not our format: ${f.stopSignal ?? "stated by the counterpart"}`,
      confirm: "not_our_format",
    };
  }
  const v = meetsQualified(f);
  if (v.ok) return { stage: STAGE.QUALIFIED, reason: "every fact on the bar is known" };
  return { stage: STAGE.WORK, reason: `not yet: ${v.missing.join(", ")}` };
}

/**
 * Second opinion before a card is parked as co-broke. The counterpart field
 * is one of fourteen in the extraction, and "villa manager" is said both by
 * the owner's employee and by a management company. Owners were parked here
 * (Swoi, Ersanea) on that single word. Fail-closed: unsure means not parked.
 */
async function confirmsThirdParty(leadId: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT string_agg(m.sender_type || ': ' || m.text, E'\n' ORDER BY m.sent_at) AS convo
      FROM lead_messages m
     WHERE m.lead_id = ${leadId} AND m.text IS NOT NULL
  `);
  const convo = (res.rows?.[0] as { convo?: string } | undefined)?.convo ?? "";
  if (!convo.trim()) return false;
  const out = await chatCompletionJSON<{ third_party: boolean; why: string }>({
    model: HELPER_MODEL,
    label: "listing:third-party-check",
    max_tokens: 160,
    temperature: 0,
    system: `We are a rental agency talking to the person who advertised a villa. Answer ONE question: is this person a SEPARATE BUSINESS standing between us and the villa's owner — a management company or another agency with a name of its own, its own contract, its own agent rates or commission?

true ONLY when that separate business is visible: they name their company (not the villa's name), they speak of "our agent rates", "our contract", "our commission", "we work with agents through ...", or say the owner is their client.

false for the owner's own side, each of which was wrongly parked before: the owner; the owner's assistant, staff, family or house manager; the villa's own reception / guest services / front desk answering about its own villa; the developer's own sales staff; an in-house team "working directly with the owner" with no second company named; anyone who merely says "I manage this villa" with no company behind it; and anything you are unsure about.

Reply with JSON only: {"third_party": true|false, "why": "<8 words>"}`,
    messages: [{ role: "user", content: convo.slice(-6000) }],
  }).catch(() => null);
  if (!out || typeof out.third_party !== "boolean") return false;
  logger.info({ leadId, thirdParty: out.third_party, why: out.why }, "co-broke second opinion");
  return out.third_party;
}

export type ReconcileResult = {
  leadId: string;
  /** engine = the engine may move it; human = beyond the handover, report only. */
  owner: "engine" | "human" | "terminal" | "other";
  current: string;
  desired?: EngineStage;
  reason: string;
  applied: boolean;
  /** The second opinion a move would need — carried out to the audit so a
   *  report about a person's card is checked the same way a move would be. */
  confirm?: Desired["confirm"];
};

type ReconcileOpts = {
  /** Facts already extracted by the caller. `null` = judge from signals only
   *  (no model call); `undefined` = extract from the thread here. */
  facts?: ListingFacts | null;
  apply?: boolean;
  source: string;
  /** Re-read the thread even when the cached facts are current (a new extraction field). */
  refresh?: boolean;
};

async function ownerWroteSinceArrival(leadId: string, stage: string): Promise<boolean> {
  const [arrival] = await db
    .select({ at: stageEventsTable.changedAt })
    .from(stageEventsTable)
    .where(and(eq(stageEventsTable.leadId, leadId), sql`lower(${stageEventsTable.toStage}) = ${norm(stage)}`))
    .orderBy(desc(stageEventsTable.changedAt))
    .limit(1);
  if (!arrival?.at) return false;
  const [n] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leadMessagesTable)
    .where(and(eq(leadMessagesTable.leadId, leadId), eq(leadMessagesTable.senderType, "lead"), sql`${leadMessagesTable.sentAt} > ${arrival.at}`));
  return (n?.n ?? 0) > 0;
}

/**
 * Did the ENGINE close this card, and has the owner written since? A card a
 * person closed is theirs; only the engine's own close is reopened by facts.
 */
async function engineClosedAndOwnerWroteSince(leadId: string): Promise<boolean> {
  const [last] = await db
    .select({ at: stageEventsTable.changedAt, by: stageEventsTable.responsibleUser, to: stageEventsTable.toStage })
    .from(stageEventsTable)
    .where(eq(stageEventsTable.leadId, leadId))
    .orderBy(desc(stageEventsTable.changedAt))
    .limit(1);
  if (!last?.at || !/closed|lost/i.test(last.to ?? "") || !String(last.by ?? "").startsWith("engine:")) return false;
  const [n] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leadMessagesTable)
    .where(and(eq(leadMessagesTable.leadId, leadId), eq(leadMessagesTable.senderType, "lead"), sql`${leadMessagesTable.sentAt} > ${last.at}`));
  return (n?.n ?? 0) > 0;
}

/**
 * The fifth condition of long term (regulation 15.09.2026): the villa side named the date itself.
 * The words the extraction copied must be found in one of THEIR messages with quoted text removed.
 * Our own question about availability, pasted back or not, is not a date: Villa Mei (23369825) was
 * parked the minute we asked "start 1 October, minimum 12 months, can you check availability?".
 */
async function ownerSaidFreeDate(leadId: string, f: ListingFacts): Promise<boolean> {
  const squash = (s: string | null | undefined): string =>
    (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const said = [f.freeFromQuote, ownerFreeWords(f)].map(squash).filter((s) => s.length >= 4);
  if (!said.length) return false;
  const rows = await db
    .select({ text: leadMessagesTable.text })
    .from(leadMessagesTable)
    .where(and(eq(leadMessagesTable.leadId, leadId), eq(leadMessagesTable.senderType, "lead"), sql`${leadMessagesTable.text} IS NOT NULL`));
  const theirs = rows.map((r) => ` ${squash(stripQuotedText(`lead: ${r.text ?? ""}`))} `);
  return said.some((s) => theirs.some((t) => t.includes(` ${s} `)));
}

/** The card's last move was the engine taking it out of long term, and the villa side has not written since. */
async function awaitingOwnerAfterLongTerm(leadId: string): Promise<boolean> {
  const [last] = await db
    .select({ at: stageEventsTable.changedAt, from: stageEventsTable.fromStage, by: stageEventsTable.responsibleUser })
    .from(stageEventsTable)
    .where(eq(stageEventsTable.leadId, leadId))
    .orderBy(desc(stageEventsTable.changedAt))
    .limit(1);
  if (!last?.at || norm(last.from) !== norm(STAGE.LONG_TERM) || !String(last.by ?? "").startsWith("engine:")) return false;
  const [n] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leadMessagesTable)
    .where(and(eq(leadMessagesTable.leadId, leadId), eq(leadMessagesTable.senderType, "lead"), sql`${leadMessagesTable.sentAt} > ${last.at}`));
  return (n?.n ?? 0) === 0;
}

/** The long term task is due two weeks before the free date, at 10:00 Bali. */
function longTermTaskDue(freeIso: string): Date {
  const dayIso = new Date(Date.parse(`${freeIso}T00:00:00Z`) - REMIND_BEFORE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const due = new Date(`${dayIso}T10:00:00+08:00`);
  return due.getTime() > Date.now() + 3_600_000 ? due : new Date(Date.now() + 3_600_000);
}

/**
 * The record a parked card cannot be without (regulation 15.09.2026, §5): the date in "Listing:
 * available from" and a task two weeks before it. Idempotent: writes only what is missing or wrong,
 * and completes a long term task left over from an earlier date.
 */
async function ensureLongTermRecord(leadId: string, facts: ListingFacts): Promise<{ ok: boolean; why: string; fixed: string[] }> {
  if (!facts.freeFromIso || !plausibleFreeDate(facts)) return { ok: false, why: "no usable free date", fixed: [] };
  const fixed: string[] = [];
  const field = await writeListingAvailableFrom(leadId, facts);
  if (field === "failed") return { ok: false, why: `could not write "Listing: available from"`, fixed };
  if (field === "written") fixed.push("available-from date");
  const due = longTermTaskDue(facts.freeFromIso);
  const dueSec = Math.floor(due.getTime() / 1000);
  const open = await getOpenAmoTasks(leadId).catch(() => []);
  const ours = open.filter((t) => (t.text ?? "").startsWith(LONG_TERM_TASK_PREFIX));
  const keep = ours.find((t) => Math.abs((t.complete_till ?? 0) - dueSec) < 86_400);
  if (!keep) {
    const text = `${LONG_TERM_TASK_PREFIX} the villa frees up ${humanDate(facts.freeFromIso)}. Ask the owner to confirm the date and the price.`;
    if (!(await createAmoTask(leadId, text, due).catch(() => false))) return { ok: false, why: "amoCRM refused the task", fixed };
    fixed.push(`task due ${due.toISOString().slice(0, 10)}`);
  }
  const stale = ours.filter((t) => t !== keep).map((t) => t.id);
  if (stale.length) await completeAmoTasks(stale, "The free date changed: replaced by a new long term task").catch(() => false);
  return { ok: true, why: "", fixed };
}

/** The note the regulation asks for, in its own template, with the owner's words. */
async function postLongTermNote(leadId: string, facts: ListingFacts, verb: "Moved to" | "Kept in"): Promise<void> {
  const today = humanDate(new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10));
  const quote = (facts.freeFromQuote ?? ownerFreeWords(facts) ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const exact = (availableFromLine(facts) ?? "").includes("APPROX") ? "APPROX" : "exact";
  const rate = facts.monthlyIdr
    ? `IDR ${facts.monthlyIdr.toLocaleString("en-US")}/month`
    : facts.yearlyIdr
      ? `IDR ${facts.yearlyIdr.toLocaleString("en-US")}/year`
      : "not given";
  // A rate of their own is the position to report, not our reading of "net" (Ersanea: "our standard
  // fee is 5%, which is the maximum").
  const commission =
    facts.theirCommissionPct !== null && facts.theirCommissionPct !== 10
      ? `their offer ${facts.theirCommissionPct}%, not yet agreed`
      : facts.commission === "included"
        ? "included"
        : facts.commission === "net"
          ? "on top"
          : "not confirmed";
  const touch = humanDate(longTermTaskDue(facts.freeFromIso!).toISOString().slice(0, 10));
  const text = [
    `${verb} LONG TERM on ${today}. Owner quote: "${quote}".`,
    `Free from ${humanDate(facts.freeFromIso!)} (${exact}). Bedrooms ${facts.bedrooms}, owner rate ${rate},`,
    `commission ${commission}. Owner side verified: ${facts.counterpart === "owner" ? "the owner or the owner's own staff" : facts.counterpart}.`,
    `Next touch scheduled for ${touch}.`,
  ].join("\n");
  const posted = await amoPost(`/api/v4/leads/${encodeURIComponent(leadId)}/notes`, [{ note_type: "common", params: { text } }]).catch(() => null);
  if (!posted) logger.error({ leadId }, "long term: the note did not reach amoCRM");
}

/** A quote under the floor closes the card only once it has stood this long. */
const FLOOR_CLOSE_AFTER_MS = 18 * 3_600_000;

const reconcileInFlight = new Map<string, Promise<ReconcileResult>>();

/**
 * Bring one card to the stage its facts earn. Idempotent; safe to call from
 * every trigger (a reply generated, a message sent, the daily audit).
 *
 * One at a time per card. A reply is generated and the autopilot sends it
 * within the same second, and both triggers used to judge the SAME old stage
 * in parallel: two amoCRM writes and two stage events for one move (every
 * engine move on 10–11.09 was recorded twice), and two paid second opinions
 * for one close. Serialised, the second call reads the stage the first one
 * wrote and returns "in place".
 */
export async function reconcileListingStage(leadId: string, opts: ReconcileOpts): Promise<ReconcileResult> {
  const prev = reconcileInFlight.get(leadId);
  const run = (prev ? prev.catch(() => undefined) : Promise.resolve(undefined)).then(() => reconcileOnce(leadId, opts));
  reconcileInFlight.set(leadId, run);
  try {
    return await run;
  } finally {
    if (reconcileInFlight.get(leadId) === run) reconcileInFlight.delete(leadId);
  }
}

async function reconcileOnce(leadId: string, opts: ReconcileOpts): Promise<ReconcileResult> {
  const apply = opts.apply !== false;
  const [row] = await db
    .select({
      pipeline: leadsSyncTable.pipeline,
      leadStage: leadsSyncTable.leadStage,
      botExcluded: leadsSyncTable.botExcluded,
      listingFreeFrom: leadsSyncTable.listingFreeFrom,
      listingFacts: leadsSyncTable.listingFacts,
      listingFactsAt: leadsSyncTable.listingFactsAt,
    })
    .from(leadsSyncTable)
    .where(eq(leadsSyncTable.leadId, leadId))
    .limit(1);
  const current = row?.leadStage ?? "";
  if (!row || !isListingAcquisition(row.pipeline) || row.botExcluded) {
    return { leadId, owner: "other", current, reason: "not a listing card the bot works", applied: false };
  }
  let owner: ReconcileResult["owner"];
  if (isTerminalStage(current)) {
    // A card the engine closed is reopened the way it was closed — by facts —
    // once the owner has written since. Villa Mimoza (23519133, 10.09) was
    // closed at 14:38 on a 32M quote in the same minute the bot counter-offered
    // 33M; at 15:12 the owner accepted 33M and named a viewing day, and nothing
    // looked, because a closed card was never judged again. A person's close
    // is never reopened, and "won" is never touched.
    const reopenable = norm(current).includes("lost") && (await engineClosedAndOwnerWroteSince(leadId));
    if (!reopenable) return { leadId, owner: "terminal", current, reason: "closed", applied: false };
    owner = "engine";
  } else {
    owner = engineOwnsStage(current) ? "engine" : "human";
  }

  const [sig] = await db
    .select({
      ours: sql<number>`count(*) FILTER (WHERE ${leadMessagesTable.senderType} <> 'lead')::int`,
      theirs: sql<number>`count(*) FILTER (WHERE ${leadMessagesTable.senderType} = 'lead')::int`,
      // Epoch ms, not a timestamp: pg hands `max(timestamptz)` back as
      // "2026-09-07 07:16:45+02", which `new Date()` cannot parse, and an
      // Invalid Date compares false — every card was re-read on every run
      // (88 model calls on the first cached pass instead of 0).
      newestMs: sql<number | null>`(extract(epoch from max(${leadMessagesTable.sentAt})) * 1000)::float8`,
      theirNewestMs: sql<number | null>`(extract(epoch from max(${leadMessagesTable.sentAt}) FILTER (WHERE ${leadMessagesTable.senderType} = 'lead')) * 1000)::float8`,
    })
    .from(leadMessagesTable)
    .where(and(eq(leadMessagesTable.leadId, leadId), sql`${leadMessagesTable.text} IS NOT NULL`));
  // Our send is recorded in sent_messages the instant it leaves; the same
  // message reaches lead_messages only when the sync picks it up — fifteen
  // minutes later on 11.09. The send trigger runs right after the send, so it
  // could not see its own message and left every first contact in Initial
  // Contact until the next morning's audit.
  // Only a RECENT send stands in for the thread. A delivered message lands in
  // the thread within minutes; a send older than an hour that never did is not
  // evidence of contact — Asta Villa (23213343) has four sends since 17.08 on
  // a card with no reachable number and not one message in its thread.
  const [sentRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sentMessagesTable)
    .where(and(eq(sentMessagesTable.leadId, leadId), sql`${sentMessagesTable.createdAt} > now() - interval '60 minutes'`));
  const outboundSent = (sig?.ours ?? 0) > 0 || (sentRow?.n ?? 0) > 0;
  const ownerReplied = (sig?.theirs ?? 0) > 0;

  let facts: ListingFacts;
  let extractedHere = false;
  const newestAt = sig?.newestMs ? new Date(Number(sig.newestMs)) : null;
  const cached =
    row.listingFacts && row.listingFactsAt && newestAt && newestAt.getTime() <= row.listingFactsAt.getTime()
      ? (row.listingFacts as unknown as ListingFacts)
      : null;
  if (opts.facts) facts = opts.facts;
  else if (!ownerReplied) facts = emptyFacts();
  else if (opts.facts === null) {
    // `facts: null` means "signals only, no model call" — the send path. It
    // used to be handed EMPTY facts, which is not the same thing: empty says
    // "nothing about this villa is known", so every send re-judged a complete
    // card as "not yet: bedrooms, price, minimum stay…" and dragged it back
    // to TAKEN TO WORK. On 10.09 two cards flapped four times in ten minutes
    // (23518851, 23519135: Initial Contact → long term → TAKEN TO WORK → long
    // term → TAKEN TO WORK), and a card could never hold QUALIFIED past its
    // next message. What we last read still stands, however old — a message
    // WE send changes none of it; with nothing ever read, there is nothing to
    // judge and the card stays where it is.
    const known = (row.listingFacts as unknown as ListingFacts | null) ?? null;
    if (!known || typeof known.counterpart !== "string") {
      return { leadId, owner, current, reason: "no facts read yet — a send judges nothing", applied: false };
    }
    facts = known;
  } else if (cached && !opts.refresh && typeof cached.counterpart === "string") {
    // Nothing new in the thread since the last read: the facts stand.
    facts = cached;
  } else {
    const res = await db.execute(sql`
      SELECT string_agg(m.sender_type || ': ' || m.text, E'\n' ORDER BY m.sent_at) AS convo
        FROM lead_messages m
       WHERE m.lead_id = ${leadId} AND m.text IS NOT NULL
    `);
    const convo = (res.rows?.[0] as { convo?: string } | undefined)?.convo ?? "";
    const extracted = await extractListingFacts(convo, leadId);
    if (!extracted) {
      // No facts is not "no data": the model call failed (the API ran out of
      // credit during the first audit, 07.09, and 183 cards came back as
      // "missing everything"). Nothing is judged on a failed read.
      return { leadId, owner, current, reason: "facts unavailable (extraction failed) — not judged", applied: false };
    }
    facts = extracted;
    extractedHere = true;
  }
  // The free date we stored when parking is a fact too — unless the owner has since written that it is
  // free: no date in the read, availability in their own words (not our dated line), not occupied.
  const parkedIso = row.listingFreeFrom ? row.listingFreeFrom.toISOString().slice(0, 10) : null;
  const releasedByOwner =
    norm(current) === norm(STAGE.LONG_TERM) &&
    !!parkedIso &&
    !facts.freeFromIso &&
    facts.stopKind !== "occupied" &&
    !!facts.availableFrom &&
    !dateFromAvailableLine(facts.availableFrom) &&
    (await ownerWroteSinceArrival(leadId, current));
  if (!facts.freeFromIso && parkedIso && !releasedByOwner) {
    facts = { ...facts, freeFromIso: parkedIso };
  }
  const ownerSaid = facts.freeFromIso ? await ownerSaidFreeDate(leadId, facts) : false;

  let desired = desiredStage({ facts, outboundSent, ownerReplied, ownerSaidFreeDate: ownerSaid });

  // The floor closes a card only once the quote has stood. The reply prompt
  // counter-offers up to the floor, so a quote under it is usually the START
  // of a negotiation: Mimoza (10.09) was closed on 32M while the bot was
  // proposing 33M, and the owner accepted 33M half an hour later. A live
  // trigger never closes on the floor; the daily audit does, once the owner's
  // last word is a day old and the quote still stands.
  if (desired.stage === STAGE.CLOSED_LOST && desired.floor) {
    const ownerWordAgeMs = sig?.theirNewestMs ? Date.now() - Number(sig.theirNewestMs) : Number.POSITIVE_INFINITY;
    if (opts.source !== "audit" || ownerWordAgeMs < FLOOR_CLOSE_AFTER_MS) {
      desired = {
        stage: (isTerminalStage(current) ? STAGE.CLOSED_LOST : current) as EngineStage,
        reason: "below our floor, still negotiating — closes if the quote stands a day",
      };
    }
  }

  // Parking stickiness: leaving needs positive evidence, not a thinner read.
  // Evidence is a free date inside the window, or availability the owner has
  // stated since the card was parked. "Alright 🙏" plus one extraction that
  // happened to leave out the tenant is not evidence: Villa Solis (23528529,
  // 11.09) went long term → TAKEN TO WORK on exactly that, and straight back.
  //
  // Since the long term regulation (15.09.2026, §6) the parking holds until two weeks before the date
  // the owner named, not until the date merely comes inside the 90-day selling window — leaving at 90
  // days is why the two-week availability check almost never found a card. What still moves a parked
  // card: the owner naming another date or saying it is free, a card short of the bar (parked before
  // the regulation with no price, or on a date nobody on their side said), or the date itself.
  let exitByDate = false;
  if (
    norm(current) === norm(STAGE.LONG_TERM) &&
    desired.stage !== STAGE.LONG_TERM &&
    desired.stage !== STAGE.CLOSED_LOST &&
    desired.stage !== STAGE.CO_BROKE
  ) {
    const at = plausibleFreeDate(facts);
    const sameDate = !!parkedIso && facts.freeFromIso === parkedIso;
    if (at && sameDate && longTermBar(facts, ownerSaid).ok) {
      if (at.getTime() - Date.now() <= REMIND_BEFORE_DAYS * 86_400_000) {
        desired = { stage: STAGE.WORK, reason: `free date ${parkedIso} is two weeks away or less — asking the owner to confirm the date and the price` };
        exitByDate = true;
      } else {
        desired = { stage: STAGE.LONG_TERM, reason: `parked until two weeks before ${parkedIso}` };
      }
    }
  }
  if (norm(current) === norm(STAGE.CO_BROKE) && desired.stage !== STAGE.CO_BROKE && desired.stage !== STAGE.CLOSED_LOST) {
    if (facts.counterpart !== "owner") desired = { stage: STAGE.CO_BROKE, reason: "parked; the counterpart is still not established as the owner" };
  }

  // Back from long term, a card waits in TAKEN TO WORK for the owner's answer on the date and the price
  // (§6). Facts read months ago do not carry it on to QUALIFIED unasked.
  if (norm(current) === norm(STAGE.WORK) && desired.stage === STAGE.QUALIFIED && (await awaitingOwnerAfterLongTerm(leadId))) {
    desired = { stage: STAGE.WORK, reason: "back from long term — waiting for the owner to confirm the date and the price" };
  }
  // Taken back out of QUALIFIED by someone else (the listing manager's "RETURNED TO TAKEN TO WORK"):
  // the same facts do not promote it again — only the owner's next message does (19.09.2026).
  if (norm(current) === norm(STAGE.WORK) && desired.stage === STAGE.QUALIFIED) {
    const hold = await returnHold(leadId, current);
    if (hold && !(await ownerWroteSince(leadId, hold.at))) {
      desired = {
        stage: STAGE.WORK,
        reason: `returned from QUALIFIED ${hold.at.toISOString().slice(0, 16)}${hold.reason ? ` (${hold.reason})` : ""} — waiting for the owner's answer`,
      };
    }
  }

  // Outbound is monotonic: a card past Initial Contact whose thread shows no
  // message of ours (old cards synced before message logging) never goes back.
  if (desired.stage === STAGE.INITIAL && norm(current) !== norm(STAGE.INITIAL)) {
    desired = { stage: current as EngineStage, reason: "outbound not in the log, stage itself is the evidence" };
  }
  if (norm(desired.stage) === norm(current) || (isTerminalStage(current) && desired.stage === STAGE.CLOSED_LOST)) {
    // A card that stays parked keeps its record whole (§5): a date the owner moved rewrites the field
    // and the task; a card parked before the regulation gets the date and the task it never had.
    if (apply && owner === "engine" && desired.stage === STAGE.LONG_TERM && norm(current) === norm(STAGE.LONG_TERM)) {
      const rec = await ensureLongTermRecord(leadId, facts);
      const dateMoved = parkedIso !== facts.freeFromIso;
      if (rec.ok && dateMoved) {
        await db
          .update(leadsSyncTable)
          .set({ listingFreeFrom: plausibleFreeDate(facts), updatedAt: new Date() })
          .where(eq(leadsSyncTable.leadId, leadId))
          .catch(() => undefined);
      }
      if (rec.ok && (dateMoved || rec.fixed.length)) await postLongTermNote(leadId, facts, "Kept in");
      const changes = [dateMoved ? `free date ${parkedIso ?? "none"} → ${facts.freeFromIso}` : "", ...rec.fixed].filter(Boolean);
      const tail = !rec.ok ? `; record NOT complete: ${rec.why}` : changes.length ? `; record updated: ${changes.join(", ")}` : "";
      return { leadId, owner, current, desired: desired.stage, reason: `in place: ${desired.reason}${tail}`, applied: false };
    }
    return { leadId, owner, current, desired: desired.stage, reason: `in place: ${desired.reason}`, applied: false };
  }
  if (owner !== "engine") {
    return { leadId, owner, current, desired: desired.stage, reason: `facts say ${desired.stage} (${desired.reason}) — a person's stage, not moved`, applied: false, confirm: desired.confirm };
  }
  // One stage move per new message from the villa side (§8). SWOI Loft (23298483) went TAKEN TO WORK →
  // long term → co-broke → long term in five minutes on one conversation: the decision followed the
  // noise of re-reads, not a fact. A second move needs a new message from them. The date-driven exit
  // from long term is not a message and is exempt.
  // Nor is taking a card OUT of long term because it falls short of the bar: that corrects a parking,
  // it is not noise. At 13:11 on 15.09 a person moved ten cards from long term to TAKEN TO WORK by the
  // regulation; at 13:17 the old engine re-parked three of them on a send, and without this the guard
  // would have protected that wrong move for a day.
  const correctsParking =
    norm(current) === norm(STAGE.LONG_TERM) && desired.stage === STAGE.WORK && !longTermBar(facts, ownerSaid).ok;
  if (ownerReplied && !exitByDate && !correctsParking && sig?.theirNewestMs) {
    const [lastMove] = await db
      .select({ at: stageEventsTable.changedAt, to: stageEventsTable.toStage })
      .from(stageEventsTable)
      .where(and(eq(stageEventsTable.leadId, leadId), sql`${stageEventsTable.responsibleUser} LIKE 'engine:%'`))
      .orderBy(desc(stageEventsTable.changedAt))
      .limit(1);
    if (lastMove?.at && lastMove.at.getTime() > Number(sig.theirNewestMs) && Date.now() - lastMove.at.getTime() < 24 * 3_600_000) {
      return {
        leadId,
        owner,
        current,
        desired: desired.stage,
        reason: `held: already moved to ${lastMove.to} after their last message; the next move waits for a new one (${desired.reason})`,
        applied: false,
      };
    }
  }
  if (!apply) return { leadId, owner, current, desired: desired.stage, reason: `would move: ${desired.reason}`, applied: false };

  if (desired.confirm === "not_our_format" && !(await confirmsNotOurFormat(leadId))) {
    return { leadId, owner, current, desired: desired.stage, reason: "not our format NOT confirmed by the second opinion — stays", applied: false };
  }
  if (desired.confirm === "third_party" && !(await confirmsThirdParty(leadId))) {
    if (norm(current) !== norm(STAGE.LONG_TERM)) {
      return { leadId, owner, current, desired: desired.stage, reason: "third party NOT confirmed by the second opinion — stays", applied: false };
    }
    // long term needs the owner side established (regulation 15.09.2026, §3). Not a confirmed third
    // party is not a confirmed owner either: the card goes back to asking who they are, instead of
    // staying parked on a question nobody answered (Villa Mei 23369825, Villa Wabu 23434733).
    desired = { stage: STAGE.WORK, reason: "not long term: the owner side is not established, and no third party is confirmed" };
  }

  if (extractedHere) await syncListingFactsToCard(leadId, facts).catch(() => undefined);

  // Nothing is parked without its record (§5): the date on the card and the task two weeks before it
  // are written BEFORE the move, and either failing leaves the card where it is.
  if (desired.stage === STAGE.LONG_TERM) {
    const rec = await ensureLongTermRecord(leadId, facts);
    if (!rec.ok) return { leadId, owner, current, desired: desired.stage, reason: `long term NOT applied: ${rec.why}`, applied: false };
  }

  // A villa published on the site is never closed here (owner, 16.09.2026). Bernice's card
  // (23355219 / R-YUD-049) went to Closed - lost the moment she said a tenant had taken it for a
  // trial month, while the listing stayed on the site as free and no weekly check could ever ask
  // again. The card keeps its stage; the audit reports this line.
  if (desired.stage === STAGE.CLOSED_LOST) {
    const live = await publishedListingFor(leadId);
    if (live) {
      return {
        leadId,
        owner,
        current,
        desired: desired.stage,
        reason: `NOT closed: ${live.id} is published on the site — ${desired.reason}`,
        applied: false,
      };
    }
  }

  let ok = false;
  let stageId: string | null = null;
  if (desired.stage === STAGE.CLOSED_LOST) {
    ok = await closeLeadAsLost(leadId);
    stageId = "143";
  } else {
    const lead = await getAmoLead(leadId);
    if (!lead?.pipeline_id) return { leadId, owner, current, desired: desired.stage, reason: "amoCRM did not return the lead's funnel", applied: false };
    const { id } = await safeStageIdForLead({ pipelineId: lead.pipeline_id, stageId: null, stageName: desired.stage });
    if (!id) return { leadId, owner, current, desired: desired.stage, reason: `no "${desired.stage}" stage in this funnel`, applied: false };
    stageId = id;
    ok = await updateLeadStatus(leadId, Number(id));
  }
  if (!ok) return { leadId, owner, current, desired: desired.stage, reason: "amoCRM refused the stage change", applied: false };

  const freeAt = desired.stage === STAGE.LONG_TERM ? plausibleFreeDate(facts) : null;
  await db
    .update(leadsSyncTable)
    .set({
      leadStage: desired.stage === STAGE.CLOSED_LOST ? "Closed Lost" : desired.stage,
      leadStageId: stageId ?? undefined,
      listingFreeFrom: desired.stage === STAGE.LONG_TERM ? freeAt : exitByDate ? row.listingFreeFrom : null,
      ...(desired.stage === STAGE.CLOSED_LOST || desired.stage === STAGE.LONG_TERM || desired.stage === STAGE.CO_BROKE ? { nextFollowupAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(leadsSyncTable.leadId, leadId))
    .catch(() => undefined);
  await db
    .insert(stageEventsTable)
    .values({ leadId, fromStage: current, toStage: desired.stage, pipeline: row.pipeline, responsibleUser: `engine:${opts.source}` })
    .catch(() => undefined);
  if (freeAt) await postLongTermNote(leadId, facts, "Moved to");
  if (exitByDate && row.listingFreeFrom) {
    // §6: the task has fired. The card is back in TAKEN TO WORK and the bot asks the two questions.
    const open = await getOpenAmoTasks(leadId).catch(() => []);
    await completeAmoTasks(
      open.filter((t) => (t.text ?? "").startsWith(LONG_TERM_TASK_PREFIX)).map((t) => t.id),
      "Back in TAKEN TO WORK: the bot asked the owner to confirm the date and the price",
    ).catch(() => false);
    const { writeAvailabilityCheckDraft } = await import("./long-term-check");
    await writeAvailabilityCheckDraft(leadId, row.listingFreeFrom, facts).catch((err) =>
      logger.error({ err, leadId }, "long term: the re-confirm draft failed"),
    );
  }
  logger.info({ leadId, from: current, to: desired.stage, reason: desired.reason, source: opts.source }, "listing stage engine: card moved");
  return { leadId, owner, current, desired: desired.stage, reason: desired.reason, applied: true };
}

/**
 * Every open card in the funnel, once: engine-owned cards are brought into
 * place, cards beyond the handover are reported with where the facts say they
 * belong. The daily run of this is how the next drift is seen by a report,
 * not by the owner opening cards.
 */
export async function auditListingStages(opts: { apply: boolean; limit?: number; stage?: string; refresh?: boolean }): Promise<{
  scanned: number;
  moved: ReconcileResult[];
  held: ReconcileResult[];
  forBroker: ReconcileResult[];
  /** Cards whose facts could not be read this run (a failed model call).
   *  Listed, never counted as "in place": an outage must not look like order. */
  notJudged: string[];
  inPlace: number;
}> {
  const rows = await db.execute(sql`
    SELECT lead_id FROM leads_sync
     WHERE lower(coalesce(pipeline,'')) = 'rental listings'
       AND bot_excluded IS NOT TRUE
       AND lower(coalesce(lead_stage,'')) NOT LIKE '%closed%'
       AND lower(coalesce(lead_stage,'')) NOT LIKE '%lost%'
       AND lower(coalesce(lead_stage,'')) NOT LIKE '%won%'
       AND (${opts.stage ?? ""} = '' OR lower(coalesce(lead_stage,'')) = lower(${opts.stage ?? ""}))
     ORDER BY updated_at DESC
     LIMIT ${opts.limit ?? 400}
  `);
  const ids = ((rows.rows ?? []) as Array<{ lead_id: string }>).map((r) => r.lead_id);
  const moved: ReconcileResult[] = [];
  const held: ReconcileResult[] = [];
  const forBroker: ReconcileResult[] = [];
  const notJudged: string[] = [];
  let inPlace = 0;
  for (const leadId of ids) {
    try {
      const r = await reconcileListingStage(leadId, { apply: opts.apply, source: "audit", refresh: opts.refresh });
      if (r.reason.startsWith("facts unavailable")) { notJudged.push(leadId); continue; }
      if (r.applied) moved.push(r);
      else if (
        r.owner === "human" &&
        r.desired &&
        norm(r.desired) !== norm(r.current) &&
        // Material only: a manager, a price under the floor, an occupied villa,
        // a format we do not list. "Still missing the viewing day" on a card
        // the broker is filling in is not a disagreement worth a push.
        (r.desired === STAGE.CLOSED_LOST || r.desired === STAGE.CO_BROKE || r.desired === STAGE.LONG_TERM)
      ) {
        // The same second opinion a move would get, so the broker is not sent
        // a "this is a manager" on one word of a fourteen-field extraction.
        if (r.confirm === "not_our_format" && !(await confirmsNotOurFormat(leadId))) { inPlace++; continue; }
        if (r.confirm === "third_party" && !(await confirmsThirdParty(leadId))) { inPlace++; continue; }
        forBroker.push(r);
      }
      else if (r.owner === "engine" && r.desired && norm(r.desired) !== norm(r.current)) held.push(r);
      else inPlace++;
    } catch (err) {
      logger.error({ err, leadId }, "listing stage audit: card failed");
    }
  }
  logger.info({ scanned: ids.length, moved: moved.length, held: held.length, forBroker: forBroker.length, notJudged: notJudged.length, inPlace, apply: opts.apply }, "listing stage audit complete");
  return { scanned: ids.length, moved, held, forBroker, notJudged, inPlace };
}

const AUDIT_DAY_KEY = "listing_audit_last_day";
let lastAuditDay = "";
/**
 * Once a day, after 09:00 Bali and before the outreach window opens: bring
 * the bot's cards into place and tell the broker which of his cards the facts
 * disagree with. Called from the scheduler tick. The day is persisted, so a
 * restart (every deploy) does not run it — and push the broker — again.
 */
export async function maybeRunDailyListingAudit(): Promise<void> {
  const bali = new Date(Date.now() + 8 * 3_600_000);
  const day = bali.toISOString().slice(0, 10);
  if (bali.getUTCHours() < 9 || lastAuditDay === day) return;
  if (!lastAuditDay) {
    const [row] = await db.select({ value: brokerSettingsTable.value }).from(brokerSettingsTable).where(eq(brokerSettingsTable.key, AUDIT_DAY_KEY)).limit(1);
    lastAuditDay = row?.value ?? "";
    if (lastAuditDay === day) return;
  }
  lastAuditDay = day;
  await db
    .insert(brokerSettingsTable)
    .values({ key: AUDIT_DAY_KEY, value: day })
    .onConflictDoUpdate({ target: brokerSettingsTable.key, set: { value: day } })
    .catch(() => undefined);
  const r = await auditListingStages({ apply: true });
  // After the engine's own moves (a card it just qualified is judged the same run):
  // a message a detector missed still moves its card within a day.
  const progressed: Array<{ leadId: string; to: string | null; moved: boolean }> = await auditListingProgress({ apply: true, source: "audit" }).catch((err) => {
    logger.error({ err }, "listing progress audit failed");
    return [];
  });
  logger.info({ scanned: progressed.length, moved: progressed.filter((p) => p.moved).map((p) => `${p.leadId}→${p.to}`) }, "listing progress audit complete");
  const lines = r.forBroker.slice(0, 6).map((x) => `#${x.leadId}: ${x.current} → facts say ${x.desired}`);
  // The long term regulation's standing check (§9), read live after the day's moves. Expected: nothing.
  const control = await longTermControl().catch((err) => {
    logger.error({ err }, "long term control failed");
    return null;
  });
  const defects = control ? control.noPrice.length + control.noDate.length + control.noFutureTask.length + control.stale.length : 0;
  if (control) {
    const ids = (rows: Array<{ leadId: number }>) => rows.map((x) => x.leadId);
    const summary = { total: control.total, noPrice: ids(control.noPrice), noDate: ids(control.noDate), noFutureTask: ids(control.noFutureTask), stale: ids(control.stale) };
    if (defects) logger.warn(summary, "long term control: defects on the stage");
    else logger.info(summary, "long term control: clean");
  }
  const controlLine = !control
    ? "\nLong term check could not be read."
    : defects
      ? `\nLong term check: ${control.noPrice.length} without a price, ${control.noDate.length} without a date, ${control.noFutureTask.length} without a task, ${control.stale.length} untouched 30+ days.`
      : "";
  const body = `Bot moved ${r.moved.length}, held ${r.held.length}${r.notJudged.length ? `, could not read ${r.notJudged.length}` : ""}. ${r.forBroker.length} of your cards disagree with their facts.${lines.length ? "\n" + lines.join("\n") : ""}${controlLine}`;
  await notifyBroker("yudi", "Listing stage audit", body, "/m").catch(() => 0);
}
