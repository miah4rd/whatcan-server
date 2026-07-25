/**
 * Conversation-driven stage advancement.
 *
 * The CRM stage in amoCRM is frequently stale — brokers don't always drag the
 * card forward as a chat progresses. This module infers the *real* funnel stage
 * from the live dialog and, when the conversation has clearly moved ahead of the
 * CRM, advances the lead's stage in amoCRM automatically.
 *
 * Safety rails:
 *  - Only runs when triggered by a fresh incoming lead message (allowAdvance).
 *  - Only moves FORWARD (a higher funnel rank than the current CRM stage), never back.
 *  - Only auto-WRITES up to the "viewing" stage. Commitment stages
 *    (objections / reservation / negotiation / closing / won) stay broker-confirmed —
 *    a wrong auto-move there is expensive. The generated message still reflects the
 *    inferred stage so the reply is appropriate even when the card isn't moved.
 *  - Only acts on HIGH-confidence inference.
 */
import { db, leadsSyncTable, stageEventsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { amoFetch, updateLeadStatus } from "./amo-client";
import { chatCompletionJSON } from "./ai-client";
import { logger } from "./logger";
import { resolveStageGroup, stageGroupRank, type StageGroup } from "./stage-routing";

// Highest funnel group the bot will auto-write to amoCRM by itself.
const AUTO_ADVANCE_MAX_RANK = stageGroupRank("viewing");

// ── Pipeline stage cache (pipeline name → ordered statuses) ───────────────────
type PipelineStage = { id: number; name: string };
type AmoPipelinesResponse = {
  _embedded?: {
    pipelines?: Array<{
      name: string;
      _embedded?: { statuses?: Array<{ id: number; name: string; sort: number }> };
    }>;
  };
};

let pipelineCache: { at: number; byPipeline: Map<string, PipelineStage[]> } | null = null;
const PIPELINE_TTL_MS = 10 * 60 * 1000;

async function getPipelineStages(): Promise<Map<string, PipelineStage[]>> {
  if (pipelineCache && Date.now() - pipelineCache.at < PIPELINE_TTL_MS) {
    return pipelineCache.byPipeline;
  }
  const byPipeline = new Map<string, PipelineStage[]>();
  try {
    const data = await amoFetch<AmoPipelinesResponse>("/api/v4/leads/pipelines?limit=50");
    for (const p of data?._embedded?.pipelines ?? []) {
      const stages = [...(p._embedded?.statuses ?? [])]
        .sort((a, b) => a.sort - b.sort)
        .map((s) => ({ id: s.id, name: s.name }));
      byPipeline.set(p.name.toLowerCase(), stages);
    }
    if (byPipeline.size > 0) pipelineCache = { at: Date.now(), byPipeline };
  } catch (err) {
    logger.error({ err }, "stage-advance: pipeline fetch failed");
  }
  return byPipeline;
}

/**
 * A canonical stage name for a funnel group, so the message prompt keys off the
 * INFERRED stage even when we don't (or can't) move the amoCRM card — e.g. a
 * commitment stage the broker must confirm, or a pipeline that lacks that exact
 * stage. Each name is chosen so resolveStageGroup() maps it back to the group.
 */
function canonicalStageName(group: StageGroup): string | null {
  switch (group) {
    case "early": return "New LEAD";
    case "needs_assessed": return "Needs Assessed";
    case "options": return "Options Sent";
    case "zoom": return "Zoom Call scheduled";
    case "viewing": return "Viewing Scheduled";
    case "objections": return "Feedback / Handling Objections";
    case "closing": return "Reservation";
    case "won": return "Closed - won";
    default: return null;
  }
}

/** Find the amoCRM status the target funnel group maps to within the lead's own pipeline. */
async function resolveStageForGroup(
  pipelineName: string | null,
  group: StageGroup,
): Promise<PipelineStage | null> {
  if (!pipelineName) return null;
  const stages = (await getPipelineStages()).get(pipelineName.toLowerCase());
  if (!stages) return null;
  return stages.find((s) => resolveStageGroup(s.name) === group) ?? null;
}

// ── Conversation → funnel stage inference ─────────────────────────────────────
type Inferred = { group: StageGroup; confidence: "high" | "medium" | "low" };

const GROUP_TOKENS: StageGroup[] = [
  "early",
  "needs_assessed",
  "options",
  "zoom",
  "viewing",
  "objections",
  "closing",
  "won",
];

async function inferStageGroupFromDialog(
  transcript: string,
  pipeline: string | null,
): Promise<Inferred | null> {
  const convo = transcript.trim();
  if (convo.length < 40) return null;
  const isRental = (pipeline ?? "").toLowerCase() === "rental";
  try {
    const parsed = await chatCompletionJSON<{ stage?: string; confidence?: string }>({
      model: "claude-haiku-4-5-20251001",
      system: `You classify where a ${isRental ? "villa rental" : "real estate"} conversation currently stands in the sales funnel. Read the dialog and pick the SINGLE stage that best matches the LATEST state.

Stages (in funnel order):
- early: cold or still qualifying. ${isRental ? "Dates, budget, area" : "Goal, budget, property type"} not all known yet.
- needs_assessed: qualified — enough is known to prepare a curated shortlist, but no specific listings have been sent yet.
- options: specific property options/listings have already been shared; the lead is reacting to or comparing them.
- zoom: a phone/video call has been proposed or agreed.
- viewing: an in-person property viewing is being arranged, agreed, or discussed (the lead asked to see/visit a property, or a viewing is being scheduled).
- objections: after seeing options / a viewing / a call, the lead is raising a concern (price, area, ROI, legal, timing) that blocks the decision.
- closing: the lead has chosen a specific property and is discussing reservation, deposit, contract, or booking terms.
- won: the deal is done / paid / booked.

Rules:
- Judge by the LATEST messages, not the whole history.
- Use "high" confidence ONLY when the signal is explicit. Otherwise "medium" or "low".
- If a viewing is clearly being arranged, or the lead explicitly asked about a viewing, return "viewing".
- Do NOT jump to "closing" or "won" unless the lead explicitly committed to a specific property.

Respond with JSON only: {"stage": "<one token>", "confidence": "high|medium|low"}`,
      messages: [{ role: "user", content: convo.slice(-3000) }],
      max_tokens: 30,
      temperature: 0,
    });
    const tok = String(parsed.stage ?? "").toLowerCase().trim() as StageGroup;
    if (!GROUP_TOKENS.includes(tok)) return null;
    const conf = ["high", "medium", "low"].includes(String(parsed.confidence))
      ? (parsed.confidence as Inferred["confidence"])
      : "low";
    return { group: tok, confidence: conf };
  } catch (err) {
    logger.error({ err }, "stage-advance: inference failed");
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
export type EffectiveStage = {
  /** Funnel group the generated message + attachment gating should use. */
  group: StageGroup;
  /** Stage name to feed the prompt (advanced name if we moved it, else the CRM name). */
  stageName: string | null;
  /** Numeric amoCRM status_id as a string, when known. */
  stageId: string | null;
  /** True when the lead's stage was actually written forward in amoCRM. */
  advanced: boolean;
};

/**
 * Determine the stage the next message should be written for, advancing the
 * lead in amoCRM when the conversation has clearly moved ahead of the CRM.
 * The amoCRM write is fire-and-forget so callers on the request hot path are
 * not blocked by it.
 */
export async function computeEffectiveStage(opts: {
  leadId: string;
  pipeline: string | null;
  crmStage: string | null;
  crmStageId: string | null;
  transcript: string;
  responsibleUser?: string | null;
  /** Only true when a fresh lead message triggered this (never for push follow-ups). */
  allowAdvance: boolean;
}): Promise<EffectiveStage> {
  const crmGroup = resolveStageGroup(opts.crmStage ?? "");
  const base: EffectiveStage = {
    group: crmGroup,
    stageName: opts.crmStage ?? null,
    stageId: opts.crmStageId ?? null,
    advanced: false,
  };

  if (!opts.allowAdvance) return base;

  const inferred = await inferStageGroupFromDialog(opts.transcript, opts.pipeline);
  if (!inferred || inferred.confidence !== "high") return base;

  const inferredRank = stageGroupRank(inferred.group);
  if (inferredRank <= stageGroupRank(crmGroup)) return base; // never move backward

  // The message should already reflect the real (inferred) stage, even when we
  // deliberately leave the CRM card for the broker to move. Synthesize a
  // canonical name for the inferred group so the prompt keys off it correctly.
  const effective: EffectiveStage = {
    ...base,
    group: inferred.group,
    stageName: canonicalStageName(inferred.group) ?? base.stageName,
  };

  if (inferredRank > AUTO_ADVANCE_MAX_RANK) {
    logger.info(
      { leadId: opts.leadId, from: crmGroup, to: inferred.group },
      "stage-advance: inferred beyond viewing — prompt updated, CRM left to broker",
    );
    return effective;
  }

  const target = await resolveStageForGroup(opts.pipeline, inferred.group);
  if (!target) {
    logger.info(
      { leadId: opts.leadId, pipeline: opts.pipeline, group: inferred.group },
      "stage-advance: no matching amoCRM stage in pipeline — prompt updated, CRM unchanged",
    );
    return effective;
  }

  void writeStageAdvance({
    leadId: opts.leadId,
    pipeline: opts.pipeline,
    fromStage: opts.crmStage ?? null,
    toStage: target.name,
    toStageId: target.id,
    responsibleUser: opts.responsibleUser ?? null,
  });

  return { group: inferred.group, stageName: target.name, stageId: String(target.id), advanced: true };
}

async function writeStageAdvance(opts: {
  leadId: string;
  pipeline: string | null;
  fromStage: string | null;
  toStage: string;
  toStageId: number;
  responsibleUser: string | null;
}): Promise<void> {
  try {
    const ok = await updateLeadStatus(opts.leadId, opts.toStageId);
    if (!ok) {
      logger.error(
        { leadId: opts.leadId, toStage: opts.toStage },
        "stage-advance: amoCRM updateLeadStatus returned false",
      );
      return;
    }
    await db
      .update(leadsSyncTable)
      .set({ leadStage: opts.toStage, leadStageId: String(opts.toStageId), updatedAt: new Date() })
      .where(eq(leadsSyncTable.leadId, opts.leadId));
    await db
      .insert(stageEventsTable)
      .values({
        leadId: opts.leadId,
        fromStage: opts.fromStage,
        toStage: opts.toStage,
        pipeline: opts.pipeline,
        responsibleUser: opts.responsibleUser,
      })
      .catch(() => {});
    logger.info(
      { leadId: opts.leadId, from: opts.fromStage, to: opts.toStage },
      "stage-advance: lead auto-advanced in amoCRM",
    );
  } catch (err) {
    logger.error({ err, leadId: opts.leadId }, "stage-advance: write failed");
  }
}
