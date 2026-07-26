/**
 * Derives a lead's CRM stage from the conversation itself.
 *
 * The funnel stage is just a reflection of where the conversation actually is,
 * and the bot is the one holding that conversation — so making the broker
 * remember to drag cards between stages by hand is both redundant and a
 * reliable source of drift (a forgotten stage makes the bot's own
 * stage-dependent qualifying logic reason about a state that isn't real).
 *
 * Safety model:
 *  - Only stages that genuinely describe a CONVERSATION state are selectable.
 *    Administrative//workflow stages (Mailing, TAKEN TO WORK, Неразобранное,
 *    incorrect information, …) are never auto-assigned — they mean things that
 *    happen outside the chat.
 *  - Closed - won / Closed - lost are classified but flagged `terminal`, and a
 *    terminal stage is NEVER applied automatically: it carries money and
 *    reporting weight, so it's surfaced pre-filled for the broker to confirm.
 *  - A broker's own explicit stage pick always wins over the classification.
 */
import { chatCompletionJSON } from "./ai-client";
import { logger } from "./logger";

export type StageDef = { name: string; id: number };

/** amoCRM status ids that close a lead — classified, but never auto-applied. */
const TERMINAL_STAGE_IDS = new Set([142, 143]);

type PipelineStages = {
  /** Every stage, in funnel order — used to resolve the lead's CURRENT stage. */
  all: StageDef[];
  /** Stages the classifier may choose, with what each one means in a chat. */
  selectable: Array<StageDef & { meaning: string }>;
};

// Stage ids verified live against GET /api/admin/pipelines — they differ per
// pipeline even where stage NAMES look identical, so never reuse across them.
const RENTAL: PipelineStages = {
  all: [
    { name: "New LEAD", id: 87301078 },
    { name: "1 foolow up", id: 87318450 },
    { name: "2 foolow up", id: 87318706 },
    { name: "3 foolow up", id: 87318710 },
    { name: "Needs Assessed", id: 87318714 },
    { name: "Options sent", id: 87318718 },
    { name: "Viewing", id: 87301082 },
    { name: "Negotiation", id: 87301086 },
    { name: "Closed - won", id: 142 },
    { name: "Closed - lost", id: 143 },
  ],
  selectable: [
    { name: "New LEAD", id: 87301078, meaning: "Just arrived or only greetings exchanged. The lead has not shared any real requirement yet." },
    { name: "Needs Assessed", id: 87318714, meaning: "The lead has shared real requirements — any combination of dates, stay length, budget, area, guest count or must-haves — but no property options have been sent yet." },
    { name: "Options sent", id: 87318718, meaning: "Specific property options/links have actually been sent to the lead, and the conversation is about reacting to them (including asking for different ones)." },
    { name: "Viewing", id: 87301082, meaning: "A viewing or in-person/video visit is being actively arranged or has been agreed — a date, time or meeting point is on the table." },
    { name: "Negotiation", id: 87301086, meaning: "The lead has settled on a specific villa and the conversation is about terms: price, deposit, contract length, move-in date, what's included." },
    { name: "Closed - won", id: 142, meaning: "The booking is confirmed — the lead has explicitly agreed to take a specific villa, paid, or signed. Only pick this on an unambiguous confirmation." },
    { name: "Closed - lost", id: 143, meaning: "The lead has explicitly withdrawn — said they are no longer looking, booked elsewhere, or clearly refused to continue. Only pick this on an unambiguous statement, never on mere silence." },
  ],
};

const UNICORN: PipelineStages = {
  all: [
    { name: "NEW LEAD", id: 68024550 },
    { name: "1ST FOLLOW UP (NEXT DAY)", id: 72376798 },
    { name: "2ND FOLLOW UP (3 DAYS AFTER)", id: 72376802 },
    { name: "FINAL FOLLOW UP (5 DAYS AFTER)", id: 72376806 },
    { name: "LEAD ASSIGNED", id: 72376818 },
    { name: "TAKEN TO WORK", id: 72376822 },
    { name: "Contact established", id: 68024554 },
    { name: "Mailing", id: 84883814 },
    { name: "Long-Term Cycle", id: 68035578 },
    { name: "Needs Assessed", id: 68024558 },
    { name: "Options Sent", id: 68035586 },
    { name: "Zoom Call scheduled", id: 70723858 },
    { name: "Viewing Scheduled", id: 68035590 },
    { name: "Feedback / Handling Objections", id: 68035594 },
    { name: "Reservation", id: 68035598 },
    { name: "Negotiations", id: 68035602 },
    { name: "Contract signed", id: 68035614 },
    { name: "Closed - won", id: 142 },
    { name: "Closed - lost", id: 143 },
  ],
  selectable: [
    { name: "Contact established", id: 68024554, meaning: "The lead has replied substantively but has not yet shared concrete requirements (budget, purpose, area)." },
    { name: "Needs Assessed", id: 68024558, meaning: "The lead has shared real requirements — budget, purpose (investment vs living), area, property type — but no specific listings have been sent yet." },
    { name: "Options Sent", id: 68035586, meaning: "Specific listings/links have actually been sent, and the conversation is about reacting to them." },
    { name: "Zoom Call scheduled", id: 70723858, meaning: "A video/Zoom call is being actively arranged or has been agreed, with a time discussed." },
    { name: "Viewing Scheduled", id: 68035590, meaning: "An in-person property viewing is being arranged or has been agreed, with a date or meeting point discussed." },
    { name: "Feedback / Handling Objections", id: 68035594, meaning: "The lead has seen options or visited, and the conversation is now about their concerns, doubts or objections." },
    { name: "Negotiations", id: 68035602, meaning: "A specific property is settled on and the conversation is about price, payment structure or contract terms." },
    { name: "Reservation", id: 68035598, meaning: "The lead is reserving a specific property — a reservation/deposit is being arranged." },
    { name: "Closed - won", id: 142, meaning: "The deal is confirmed — contract signed or purchase agreed unambiguously. Only pick this on an explicit confirmation." },
    { name: "Closed - lost", id: 143, meaning: "The lead has explicitly withdrawn — bought elsewhere, dropped the search, or clearly refused. Only on an unambiguous statement, never on mere silence." },
  ],
};

function pipelineStages(pipeline: string | null | undefined): PipelineStages | null {
  const p = (pipeline ?? "").trim().toLowerCase();
  if (p === "rental") return RENTAL;
  if (p === "unicorn") return UNICORN;
  // Every other pipeline (HOS hiring, Listing manager, Shanti, …) is not a
  // client sales conversation — leave its stages entirely alone.
  return null;
}

function findStage(stages: StageDef[], name: string | null | undefined): { def: StageDef; index: number } | null {
  if (!name) return null;
  const wanted = name.trim().toLowerCase();
  const index = stages.findIndex((s) => s.name.toLowerCase() === wanted);
  return index === -1 ? null : { def: stages[index]!, index };
}

export type StageClassification = {
  stage: StageDef;
  reason: string;
  /** Closing stages: surfaced for the broker to confirm, never auto-applied. */
  terminal: boolean;
};

/**
 * Classifies where the conversation will stand once `replyText` has been sent.
 * Returns null when nothing should change (unknown pipeline, unchanged stage,
 * AI unsure, or the lead sits in an administrative stage we must not touch).
 */
export async function classifyStage(opts: {
  pipeline: string | null;
  currentStage: string | null;
  conversationText: string;
  /** The reply about to be sent — the stage should reflect the state AFTER it. */
  replyText: string;
  /** Property links attached to that reply, if any. */
  attachmentsCount: number;
}): Promise<StageClassification | null> {
  const stages = pipelineStages(opts.pipeline);
  if (!stages) return null;

  // A lead already closed (or parked in an admin stage that isn't in `all`)
  // should not be dragged back into the funnel by a stray message.
  const current = findStage(stages.all, opts.currentStage);
  if (current && TERMINAL_STAGE_IDS.has(current.def.id)) return null;

  const optionsSent = stages.selectable.find((s) => /^options sent$/i.test(s.name));

  try {
    const catalog = stages.selectable.map((s) => `- ${s.name}: ${s.meaning}`).join("\n");
    const result = await chatCompletionJSON<{ stage?: string; reason?: string }>({
      model: "claude-sonnet-5",
      system: `You classify which CRM funnel stage a sales conversation is currently in.

Available stages:
${catalog}

Rules:
- Judge the state the conversation will be in AFTER the broker's pending reply is sent.
- Pick the single stage that best describes the conversation's real state right now.
- Moving BACKWARD is allowed, but only when the conversation genuinely regressed — the lead restarted their search, withdrew a decision, or went back to basic requirements. A passing clarifying question inside a later-stage conversation is NOT a regression.
- Never pick a closing stage (Closed - won / Closed - lost) unless the lead stated it unambiguously. Silence, vagueness or mild hesitation are never closing signals.
- If you cannot tell, return an empty stage rather than guessing.

Respond with JSON only: {"stage": "<exact stage name or empty string>", "reason": "<max 12 words>"}`,
      messages: [
        {
          role: "user",
          content: `Lead's CRM stage right now: ${opts.currentStage || "unknown"}
Property links attached to the pending reply: ${opts.attachmentsCount}

Conversation (oldest → newest):
${opts.conversationText.slice(-4000)}

Broker's pending reply (not sent yet):
${opts.replyText.slice(0, 1200)}`,
        },
      ],
      max_tokens: 120,
      temperature: 0,
    });

    const picked = findStage(
      stages.selectable.map((s) => ({ name: s.name, id: s.id })),
      result.stage ?? null,
    );

    // Hard floor: if real property links are going out, the conversation is at
    // minimum "Options sent" regardless of what the model said. This is the one
    // signal that's verifiable in code rather than inferred from language.
    let chosen = picked?.def ?? null;
    let reason = (result.reason ?? "").slice(0, 120);
    if (opts.attachmentsCount > 0 && optionsSent) {
      const chosenIdx = chosen ? findStage(stages.all, chosen.name)?.index ?? -1 : -1;
      const optionsIdx = findStage(stages.all, optionsSent.name)?.index ?? -1;
      if (chosenIdx < optionsIdx) {
        chosen = { name: optionsSent.name, id: optionsSent.id };
        reason = "property options delivered";
      }
    }

    if (!chosen) return null;
    // Nothing to do when it already matches the card.
    if (current && current.def.id === chosen.id) return null;

    return { stage: chosen, reason, terminal: TERMINAL_STAGE_IDS.has(chosen.id) };
  } catch (err) {
    logger.error({ err, pipeline: opts.pipeline }, "classifyStage failed (non-fatal)");
    return null;
  }
}
