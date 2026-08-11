/**
 * Derives a lead's CRM stage from the conversation itself.
 *
 * The funnel stage is just a reflection of where the conversation actually is,
 * and the bot is the one holding that conversation — so making the broker drag
 * cards between stages by hand is both redundant and a reliable source of drift
 * (a forgotten stage makes the bot's own stage-dependent logic reason about a
 * state that isn't real).
 *
 * Stages are read LIVE from amoCRM rather than hardcoded. The funnel is the
 * owner's to redesign — renaming stages, dropping the unused follow-up columns,
 * switching to Russian labels — and none of that should require a code change
 * or silently break the auto-stage the day it happens.
 *
 * Safety model:
 *  - Only stages that describe a CONVERSATION state are selectable. Workflow
 *    stages (Неразобранное, Mailing, Long-Term Cycle, TAKEN TO WORK, the
 *    follow-up counters) are never auto-assigned: they describe work outside
 *    the chat, or how many times we nudged, which is not where the deal is.
 *  - The closing stages are classified but flagged `terminal`, and a terminal
 *    stage is NEVER applied automatically: it carries money and reporting
 *    weight, so it's surfaced pre-filled for the broker to confirm.
 *  - A broker's own explicit stage pick always wins over the classification.
 */
import { HELPER_MODEL, chatCompletionJSON } from "./ai-client";
import { amoFetch } from "./amo-client";
import { logger } from "./logger";
import { conversationWindow } from "./dialog-parser";

export type StageDef = { name: string; id: number };

/** amoCRM's universal closing statuses — the same ids in every pipeline. */
const TERMINAL_STAGE_IDS = new Set([142, 143]);

/** Pipelines whose stages the classifier may move. Others (hiring, Shanti) are
 * different businesses — leave their stages alone. */
const CONVERSATIONAL_PIPELINES = new Set(["rental", "unicorn", "rental listings"]);

/** The acquisition funnel talks to a SUPPLIER, not a client — see below. */
const LISTING_ACQUISITION = "rental listings";

/** Stages that describe internal workflow, not where the conversation is. */
const WORKFLOW_STAGE_PATTERNS: RegExp[] = [
  // "Неразобранное" is renamed to "Incoming leads" in these pipelines — it's the
  // unsorted inbox, never a state the conversation moves INTO.
  /неразобранн|incoming leads?|unsorted/i,
  /mailing|рассылк/i,
  /long[-\s]?term\s*cycle|долгосроч/i,
  /taken to work|взят.? в работу/i,
  /incorrect|неверн|некорректн/i,
  /lead assigned|назначен/i,
  // "1 foolow up" / "2nd follow up" — a touch counter, not a funnel state.
  /f[oa]{1,2}l+ow\s*up|follow[-\s]?up/i,
];

/**
 * What a stage means in a conversation, matched on its NAME so a renamed or
 * translated funnel still classifies correctly. First match wins, so the more
 * specific patterns come first.
 */
const STAGE_MEANINGS: Array<{ match: RegExp; meaning: string }> = [
  { match: /closed[-\s]*won|сделка|выигран|успешно реализовано/i,
    meaning: "The deal is confirmed — the client explicitly agreed to take a specific property, paid, or signed. Only on an unambiguous confirmation." },
  { match: /closed[-\s]*lost|лост|проигран|отказ/i,
    meaning: "The client has explicitly withdrawn — no longer looking, went elsewhere, or clearly refused. Only on an unambiguous statement, NEVER on mere silence." },
  { match: /contract signed|контракт|договор подписан/i,
    meaning: "The contract has been signed." },
  { match: /reservation|бронь|резерв/i,
    meaning: "The client is reserving a specific property — a deposit or reservation is being arranged." },
  { match: /negotiat|переговор/i,
    meaning: "The client has settled on a specific property and the conversation is about terms: price, deposit, contract length, move-in date, what's included." },
  { match: /feedback|objection|возражен|обратная связь/i,
    meaning: "The client has seen options or visited, and the conversation is now about their concerns or objections." },
  { match: /viewing|показ|просмотр/i,
    meaning: "A viewing is being arranged, is agreed, or has just happened — a date, time or meeting point is on the table, or they are discussing what they saw." },
  { match: /zoom|call|звонок|созвон/i,
    meaning: "A call or video meeting is being arranged or has been agreed, with a time discussed." },
  { match: /option|опци|вариант|подборк/i,
    meaning: "Specific property options/links have actually been sent, and the conversation is about reacting to them (including asking for different ones)." },
  { match: /needs assessed|qualified|квалифиц|запрос выяснен|потребност/i,
    meaning: "The client has shared real requirements — dates, budget, area, size, purpose — but no options have been sent yet." },
  { match: /contact established|контакт установлен/i,
    meaning: "The client has replied substantively but has not shared concrete requirements yet." },
  { match: /new lead|новый лид|новая заявк/i,
    meaning: "Just arrived, or only greetings exchanged. The client has not shared any real requirement yet." },
];

/**
 * Rental Listings runs the opposite way round: we are chasing a villa OWNER to
 * win their listing, not selling to a client. Reusing the meanings above would
 * be actively wrong, not merely vague — "QUALIFIED" matches the client pattern
 * and would be read as "the client shared their requirements (dates, budget,
 * area)", when in this funnel it means "we have confirmed we are talking to the
 * real owner and they are open to working with us".
 *
 * Deliberately absent: "live" and "RENTED". Those describe OUR work and the
 * world — the listing is published on the site, a tenant has moved in — and
 * neither is knowable from a WhatsApp thread with the owner. Leaving them out
 * keeps them broker-set, the same principle that keeps Mailing and Long-Term
 * Cycle out of the classifier's hands.
 */
const LISTING_ACQUISITION_MEANINGS: Array<{ match: RegExp; meaning: string }> = [
  { match: /closed[-\s]*won|выигран/i,
    meaning: "The owner has agreed to work with us and the listing is secured. Only on an unambiguous confirmation." },
  { match: /closed[-\s]*lost|проигран|отказ/i,
    meaning: "Dead: the contact turned out to be an agent or middleman we cannot work through, the owner refused, or the villa is already committed elsewhere. Only on an unambiguous statement, NEVER on mere silence." },
  { match: /agreement|договор|соглашен/i,
    meaning: "The owner is willing in principle and the conversation is now about TERMS: commission, exclusivity, contract length, who handles what, signing." },
  { match: /details|детал|информац/i,
    meaning: "The owner is on board enough to be handing over what we need to publish the villa: photos, exact address or pin, available dates, prices, size, documents." },
  { match: /qualified|квалифиц/i,
    meaning: "The contact has CONFIRMED they are the owner (or can genuinely decide for the property). Choose this the moment that is confirmed, even if NOTHING else has been collected yet — do not wait for photos, prices, dates or documents, that is the next stage. Merely replying is not enough; the owner question must actually be answered." },
  { match: /taken to work|взят.? в работу/i,
    meaning: "Outreach HAS been sent and we are in conversation, but it is still NOT established whether they are the owner or an agent acting for someone else. This is right as soon as the first message goes out. The moment they say who they are — owner or not — this stage stops being correct." },
  { match: /initial contact|первичн|контакт/i,
    meaning: "A brand new listing card that we have NOT contacted yet — no message has gone out to this person at all. Only for leads where the conversation has not started." },
];

function meaningFor(stageName: string, pipelineKey?: string): string | null {
  const table = pipelineKey === LISTING_ACQUISITION ? LISTING_ACQUISITION_MEANINGS : STAGE_MEANINGS;
  for (const { match, meaning } of table) {
    if (match.test(stageName)) return meaning;
  }
  return null;
}

function isWorkflowStage(stageName: string, pipelineKey?: string): boolean {
  // "TAKEN TO WORK" is administrative in Unicorn and Rental — it records that
  // someone picked the card up, not where the conversation stands, which is why
  // it is on the never-auto-set list. On the acquisition funnel the owner has
  // given it a genuine conversational meaning: outreach sent, still finding out
  // whether this is the real owner. Honour that here only.
  if (pipelineKey === LISTING_ACQUISITION && /taken to work/i.test(stageName)) return false;
  return WORKFLOW_STAGE_PATTERNS.some((re) => re.test(stageName));
}

// ── Live pipeline map, refreshed periodically ─────────────────────────────────
type AmoStatus = { id: number; name: string; sort: number };
type AmoPipeline = { id: number; name: string; _embedded: { statuses: AmoStatus[] } };

export type PipelineStages = {
  /** Every stage in funnel order — used to resolve the lead's CURRENT stage. */
  all: StageDef[];
  /** Stages the classifier may choose, with what each means in a chat. */
  selectable: Array<StageDef & { meaning: string }>;
};

let cache: { at: number; byPipeline: Map<string, PipelineStages> } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

async function loadPipelines(): Promise<Map<string, PipelineStages>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.byPipeline;

  const data = await amoFetch<{ _embedded: { pipelines: AmoPipeline[] } }>(
    "/api/v4/leads/pipelines?limit=50",
  );
  const byPipeline = new Map<string, PipelineStages>();

  for (const p of data?._embedded?.pipelines ?? []) {
    const key = p.name.trim().toLowerCase();
    if (!CONVERSATIONAL_PIPELINES.has(key)) continue;

    const ordered = [...(p._embedded?.statuses ?? [])].sort((a, b) => a.sort - b.sort);
    const all: StageDef[] = ordered.map((s) => ({ name: s.name, id: s.id }));

    const selectable = ordered
      .filter((s) => !isWorkflowStage(s.name, key))
      // On the acquisition funnel an unnamed-in-our-table stage is not merely
      // unlabelled, it is one we deliberately do not auto-set ("live",
      // "RENTED" — see LISTING_ACQUISITION_MEANINGS). The generic
      // "Funnel step N of M" fallback below would hand them to the model.
      .filter((s) => key !== LISTING_ACQUISITION || meaningFor(s.name, key) !== null)
      .map((s) => {
        // The owner's Rental funnel uses "Need Assessed" as "the first outreach
        // was made" — not the generic "requirements are known". Wrong meaning
        // here made the classifier hold cards in New LEAD after the welcome.
        if (key === "rental" && /need.?s? assess/i.test(s.name)) {
          return {
            name: s.name,
            id: s.id,
            meaning:
              "The FIRST outreach message has been sent to this client (the first touch is done) and the conversation is in early qualifying — the client has not necessarily shared requirements yet.",
          };
        }
        const meaning =
          meaningFor(s.name, key) ??
          // Unrecognised name: still selectable, positioned by funnel order so
          // the model can reason about it, rather than silently dropped.
          `Funnel step ${ordered.indexOf(s) + 1} of ${ordered.length}, named "${s.name}".`;
        return { name: s.name, id: s.id, meaning };
      });

    byPipeline.set(key, { all, selectable });
  }

  if (byPipeline.size > 0) {
    cache = { at: Date.now(), byPipeline };
    logger.info(
      { pipelines: [...byPipeline.keys()], stages: [...byPipeline.values()].map((v) => v.selectable.length) },
      "stage-classifier: pipeline map refreshed from amoCRM",
    );
    return byPipeline;
  }

  // amoCRM unreachable — keep serving the previous map rather than silently
  // classifying against nothing.
  logger.warn("stage-classifier: could not load pipelines, reusing last known map");
  return cache?.byPipeline ?? new Map();
}

function findStage(stages: StageDef[], name: string | null | undefined): { def: StageDef; index: number } | null {
  if (!name) return null;
  const wanted = name.trim().toLowerCase();
  const index = stages.findIndex((s) => s.name.trim().toLowerCase() === wanted);
  return index === -1 ? null : { def: stages[index]!, index };
}

/** The live stage map for one pipeline — autopilot needs the funnel's own order. */
export async function getPipelineStages(pipeline: string): Promise<PipelineStages | null> {
  return (await loadPipelines()).get(pipeline.trim().toLowerCase()) ?? null;
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
 * AI unsure, or the lead sits in a stage we must not touch).
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
  const pipelineKey = (opts.pipeline ?? "").trim().toLowerCase();
  if (!CONVERSATIONAL_PIPELINES.has(pipelineKey)) return null;

  const stages = (await loadPipelines()).get(pipelineKey);
  if (!stages || stages.selectable.length === 0) return null;

  // A lead already closed should not be dragged back into the funnel by a
  // stray message.
  const current = findStage(stages.all, opts.currentStage);
  if (current && TERMINAL_STAGE_IDS.has(current.def.id)) return null;

  const optionsSent = stages.selectable.find((s) => /option|опци|вариант|подборк/i.test(s.name));

  try {
    const catalog = stages.selectable.map((s) => `- ${s.name}: ${s.meaning}`).join("\n");
    // Who the other party is decides how every signal reads. On the acquisition
    // funnel "I'm not the owner, I just manage it" is the single most important
    // thing in the thread; on a client funnel it would be noise.
    const domain =
      pipelineKey === LISTING_ACQUISITION
        ? `This is a LISTING ACQUISITION conversation. We contacted the person who advertised a villa for rent, to win the right to market and manage it. The other party is a SUPPLIER (the owner, or an agent acting for them) — they are NOT a client renting from us. Establishing whether they are the actual owner is the first job of this funnel.`
        : `This is a sales conversation with a client.`;
    const result = await chatCompletionJSON<{ stage?: string; reason?: string }>({
      model: HELPER_MODEL,
      label: "stage",
      system: `You classify which CRM funnel stage a conversation is currently in.

${domain}

Available stages, in funnel order:
${catalog}

Rules:
- Judge the state the conversation will be in AFTER the broker's pending reply is sent.
- Pick the single stage that best describes the conversation's real state right now.
- Moving BACKWARD is allowed, but only when the conversation genuinely regressed — the client restarted their search, withdrew a decision, or went back to basic requirements. A passing clarifying question inside a later-stage conversation is NOT a regression.
- Never pick a closing stage unless the client stated it unambiguously. Silence, vagueness or mild hesitation are never closing signals.
- If you cannot tell, return an empty stage rather than guessing.

Respond with JSON only, using a stage name EXACTLY as written above: {"stage": "<stage name or empty string>", "reason": "<max 12 words>"}`,
      messages: [
        {
          role: "user",
          content: `Lead's CRM stage right now: ${opts.currentStage || "unknown"}
Property links attached to the pending reply: ${opts.attachmentsCount}

Conversation (oldest → newest):
${conversationWindow(opts.conversationText, 1500, 4000)}

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
    // minimum "options sent" regardless of what the model said. This is the one
    // signal verifiable in code rather than inferred from language.
    let chosen = picked?.def ?? null;
    let reason = (result.reason ?? "").slice(0, 120);
    if (opts.attachmentsCount > 0 && optionsSent) {
      const chosenIdx = chosen ? findStage(stages.all, chosen.name)?.index ?? -1 : -1;
      const optionsIdx = findStage(stages.all, optionsSent.name)?.index ?? -1;
      if (optionsIdx >= 0 && chosenIdx < optionsIdx) {
        chosen = { name: optionsSent.name, id: optionsSent.id };
        reason = "property options delivered";
      }
    }

    if (!chosen) return null;
    if (current && current.def.id === chosen.id) return null;

    return { stage: chosen, reason, terminal: TERMINAL_STAGE_IDS.has(chosen.id) };
  } catch (err) {
    logger.error({ err, pipeline: opts.pipeline }, "classifyStage failed (non-fatal)");
    return null;
  }
}
