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
 *   long term           the villa is ours to take but occupied beyond 90 days
 *   co-broke Agents     the counterpart is a separate business (confirmed)
 *   Closed - lost       below the 33M floor, or not our format (confirmed)
 *   QUALIFIED           every fact on the bar is known — the handover point
 *
 * Beyond QUALIFIED (Details, agreement, live, weekly checks) a person works
 * the card; the engine computes where the facts say it should be, reports the
 * gap, and never moves it. Two closers stay outside the engine because they
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
import { db, leadsSyncTable, leadMessagesTable, stageEventsTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getAmoLead, updateLeadStatus, closeLeadAsLost, createAmoTask } from "./amo-client";
import { safeStageIdForLead } from "./stage-classifier";
import { isListingAcquisition } from "./pipelines";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";
import { notifyBroker } from "./push-notifications";
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
  };
}

export type EngineInput = {
  facts: ListingFacts;
  /** Any message of ours in the thread. */
  outboundSent: boolean;
  /** Any message from the owner's side in the thread. */
  ownerReplied: boolean;
};

export type Desired = {
  stage: EngineStage;
  reason: string;
  /** A close or a co-broke parking is confirmed by a focused second opinion
   *  before it is applied (destructive-verdict rule). */
  confirm?: "not_our_format" | "third_party";
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
    };
  }
  if (f.counterpart === "manager" || f.counterpart === "agent") {
    return { stage: STAGE.CO_BROKE, reason: `counterpart is ${f.counterpart}`, confirm: "third_party" };
  }
  if (f.stopKind === "occupied" && !freeSoon(f)) {
    return {
      stage: STAGE.LONG_TERM,
      reason: f.freeFromIso ? `occupied, free from ${f.freeFromIso}` : "occupied, date unknown",
    };
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
};

type ReconcileOpts = {
  /** Facts already extracted by the caller. `null` = judge from signals only
   *  (no model call); `undefined` = extract from the thread here. */
  facts?: ListingFacts | null;
  apply?: boolean;
  source: string;
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
 * Bring one card to the stage its facts earn. Idempotent; safe to call from
 * every trigger (a reply generated, a message sent, the daily audit).
 */
export async function reconcileListingStage(leadId: string, opts: ReconcileOpts): Promise<ReconcileResult> {
  const apply = opts.apply !== false;
  const [row] = await db
    .select({
      pipeline: leadsSyncTable.pipeline,
      leadStage: leadsSyncTable.leadStage,
      botExcluded: leadsSyncTable.botExcluded,
      listingFreeFrom: leadsSyncTable.listingFreeFrom,
    })
    .from(leadsSyncTable)
    .where(eq(leadsSyncTable.leadId, leadId))
    .limit(1);
  const current = row?.leadStage ?? "";
  if (!row || !isListingAcquisition(row.pipeline) || row.botExcluded) {
    return { leadId, owner: "other", current, reason: "not a listing card the bot works", applied: false };
  }
  if (isTerminalStage(current)) return { leadId, owner: "terminal", current, reason: "closed", applied: false };
  const owner: ReconcileResult["owner"] = engineOwnsStage(current) ? "engine" : "human";

  const [sig] = await db
    .select({
      ours: sql<number>`count(*) FILTER (WHERE ${leadMessagesTable.senderType} <> 'lead')::int`,
      theirs: sql<number>`count(*) FILTER (WHERE ${leadMessagesTable.senderType} = 'lead')::int`,
    })
    .from(leadMessagesTable)
    .where(and(eq(leadMessagesTable.leadId, leadId), sql`${leadMessagesTable.text} IS NOT NULL`));
  const outboundSent = (sig?.ours ?? 0) > 0;
  const ownerReplied = (sig?.theirs ?? 0) > 0;

  let facts: ListingFacts;
  let extractedHere = false;
  if (opts.facts) facts = opts.facts;
  else if (opts.facts === null || !ownerReplied) facts = emptyFacts();
  else {
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
  // The free date we stored when parking is a fact too.
  if (!facts.freeFromIso && row.listingFreeFrom) {
    facts = { ...facts, freeFromIso: row.listingFreeFrom.toISOString().slice(0, 10) };
  }

  let desired = desiredStage({ facts, outboundSent, ownerReplied });

  // Parking stickiness: leaving needs positive evidence, not a thinner read.
  if (norm(current) === norm(STAGE.LONG_TERM) && desired.stage !== STAGE.LONG_TERM && desired.stage !== STAGE.CLOSED_LOST) {
    const evidence = freeSoon(facts) || (facts.stopKind !== "occupied" && (await ownerWroteSinceArrival(leadId, current)));
    if (!evidence) desired = { stage: STAGE.LONG_TERM, reason: "parked; no new word from the owner and no near free date" };
  }
  if (norm(current) === norm(STAGE.CO_BROKE) && desired.stage !== STAGE.CO_BROKE && desired.stage !== STAGE.CLOSED_LOST) {
    if (facts.counterpart !== "owner") desired = { stage: STAGE.CO_BROKE, reason: "parked; the counterpart is still not established as the owner" };
  }

  // Outbound is monotonic: a card past Initial Contact whose thread shows no
  // message of ours (old cards synced before message logging) never goes back.
  if (desired.stage === STAGE.INITIAL && norm(current) !== norm(STAGE.INITIAL)) {
    desired = { stage: current as EngineStage, reason: "outbound not in the log, stage itself is the evidence" };
  }
  if (norm(desired.stage) === norm(current)) {
    return { leadId, owner, current, desired: desired.stage, reason: `in place: ${desired.reason}`, applied: false };
  }
  if (owner !== "engine") {
    return { leadId, owner, current, desired: desired.stage, reason: `facts say ${desired.stage} (${desired.reason}) — a person's stage, not moved`, applied: false };
  }
  if (!apply) return { leadId, owner, current, desired: desired.stage, reason: `would move: ${desired.reason}`, applied: false };

  if (desired.confirm === "not_our_format" && !(await confirmsNotOurFormat(leadId))) {
    return { leadId, owner, current, desired: desired.stage, reason: "not our format NOT confirmed by the second opinion — stays", applied: false };
  }
  if (desired.confirm === "third_party" && !(await confirmsThirdParty(leadId))) {
    return { leadId, owner, current, desired: desired.stage, reason: "third party NOT confirmed by the second opinion — stays", applied: false };
  }

  if (extractedHere) await syncListingFactsToCard(leadId, facts).catch(() => undefined);

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
      listingFreeFrom: desired.stage === STAGE.LONG_TERM ? freeAt : null,
      ...(desired.stage === STAGE.CLOSED_LOST || desired.stage === STAGE.LONG_TERM || desired.stage === STAGE.CO_BROKE ? { nextFollowupAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(leadsSyncTable.leadId, leadId))
    .catch(() => undefined);
  await db
    .insert(stageEventsTable)
    .values({ leadId, fromStage: current, toStage: desired.stage, pipeline: row.pipeline, responsibleUser: `engine:${opts.source}` })
    .catch(() => undefined);
  if (freeAt) {
    const due = new Date(freeAt.getTime() - REMIND_BEFORE_DAYS * 86_400_000);
    const soonest = new Date(Date.now() + 7 * 86_400_000);
    await createAmoTask(
      leadId,
      `Villa frees up around ${facts.freeFromIso}. Get back in touch now, before it is re-let.`,
      due > soonest ? due : soonest,
    ).catch(() => undefined);
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
export async function auditListingStages(opts: { apply: boolean; limit?: number }): Promise<{
  scanned: number;
  moved: ReconcileResult[];
  held: ReconcileResult[];
  forBroker: ReconcileResult[];
  inPlace: number;
}> {
  const rows = await db.execute(sql`
    SELECT lead_id FROM leads_sync
     WHERE lower(coalesce(pipeline,'')) = 'rental listings'
       AND bot_excluded IS NOT TRUE
       AND lower(coalesce(lead_stage,'')) NOT LIKE '%closed%'
       AND lower(coalesce(lead_stage,'')) NOT LIKE '%lost%'
       AND lower(coalesce(lead_stage,'')) NOT LIKE '%won%'
     ORDER BY updated_at DESC
     LIMIT ${opts.limit ?? 400}
  `);
  const ids = ((rows.rows ?? []) as Array<{ lead_id: string }>).map((r) => r.lead_id);
  const moved: ReconcileResult[] = [];
  const held: ReconcileResult[] = [];
  const forBroker: ReconcileResult[] = [];
  let inPlace = 0;
  for (const leadId of ids) {
    try {
      const r = await reconcileListingStage(leadId, { apply: opts.apply, source: "audit" });
      if (r.applied) moved.push(r);
      else if (
        r.owner === "human" &&
        r.desired &&
        norm(r.desired) !== norm(r.current) &&
        // Material only: a manager, a price under the floor, an occupied villa,
        // a format we do not list. "Still missing the viewing day" on a card
        // the broker is filling in is not a disagreement worth a push.
        (r.desired === STAGE.CLOSED_LOST || r.desired === STAGE.CO_BROKE || r.desired === STAGE.LONG_TERM)
      ) forBroker.push(r);
      else if (r.owner === "engine" && r.desired && norm(r.desired) !== norm(r.current)) held.push(r);
      else inPlace++;
    } catch (err) {
      logger.error({ err, leadId }, "listing stage audit: card failed");
    }
  }
  logger.info({ scanned: ids.length, moved: moved.length, held: held.length, forBroker: forBroker.length, inPlace, apply: opts.apply }, "listing stage audit complete");
  return { scanned: ids.length, moved, held, forBroker, inPlace };
}

let lastAuditDay = "";
/**
 * Once a day, after 09:00 Bali and before the outreach window opens: bring
 * the bot's cards into place and tell the broker which of his cards the facts
 * disagree with. Called from the scheduler tick.
 */
export async function maybeRunDailyListingAudit(): Promise<void> {
  const bali = new Date(Date.now() + 8 * 3_600_000);
  const day = bali.toISOString().slice(0, 10);
  if (bali.getUTCHours() < 9 || lastAuditDay === day) return;
  lastAuditDay = day;
  const r = await auditListingStages({ apply: true });
  const lines = r.forBroker.slice(0, 6).map((x) => `#${x.leadId}: ${x.current} → facts say ${x.desired}`);
  const body = `Bot moved ${r.moved.length}, held ${r.held.length}. ${r.forBroker.length} of your cards disagree with their facts.${lines.length ? "\n" + lines.join("\n") : ""}`;
  await notifyBroker("yudi", "Listing stage audit", body, "/m").catch(() => 0);
}
