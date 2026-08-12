/**
 * Every amoCRM funnel this bot works, in ONE place.
 *
 * Why this file exists: adding "Rental Listings" took a full day, and almost
 * none of it was new behaviour. The funnel's name was hardcoded in a dozen
 * separate gates written months apart — which pipelines get synced at all,
 * which bypass the Unicorn stage whitelist, which HoS is allowed to see, which
 * the stage classifier may move — and every gate the new name was missing from
 * failed the same silent way: an empty inbox, indistinguishable from a quiet
 * day. They were found one at a time, by a person noticing something absent.
 *
 * So: a funnel is now a row in this table, not a string to chase through the
 * codebase. Add the row, and sync, visibility, stage movement and broker
 * scoping all follow. Anything still comparing pipeline names by hand is a bug
 * waiting for the next funnel.
 */

export type PipelineKind =
  /** Selling property to a buyer. */
  | "sales"
  /** Renting a villa TO a client. */
  | "rental"
  /** Winning a listing FROM its owner — the other side of the table. */
  | "listing-acquisition";

export type PipelineDef = {
  /** Name exactly as amoCRM shows it (compared case-insensitively). */
  name: string;
  kind: PipelineKind;
  /**
   * Stages are this funnel's own vocabulary, not Unicorn's
   * (Contact Established / Needs Assessed / Options Sent). When false, the push
   * stage whitelist applies — and a funnel that names its stages differently
   * matches none of it, so every push is hidden.
   */
  ownStageVocabulary: boolean;
  /** The stage classifier is allowed to move this funnel's cards. */
  conversational: boolean;
  /** Rental-scoped brokers (HoS) may see this funnel's leads. */
  hosTracked: boolean;
};

export const PIPELINES: PipelineDef[] = [
  { name: "Unicorn", kind: "sales", ownStageVocabulary: false, conversational: true, hosTracked: false },
  { name: "Rental", kind: "rental", ownStageVocabulary: true, conversational: true, hosTracked: true },
  { name: "Rental Listings", kind: "listing-acquisition", ownStageVocabulary: true, conversational: true, hosTracked: true },
];

const byName = new Map(PIPELINES.map((p) => [p.name.trim().toLowerCase(), p]));

export function pipelineDef(pipeline: string | null | undefined): PipelineDef | null {
  return byName.get((pipeline ?? "").trim().toLowerCase()) ?? null;
}

/** Funnels we sync and work at all. Everything else is a different business. */
export function isTrackedPipeline(pipeline: string | null | undefined): boolean {
  return pipelineDef(pipeline) !== null;
}

export function pipelineKind(pipeline: string | null | undefined): PipelineKind | null {
  return pipelineDef(pipeline)?.kind ?? null;
}

export function isListingAcquisition(pipeline: string | null | undefined): boolean {
  return pipelineKind(pipeline) === "listing-acquisition";
}

export function usesOwnStageVocabulary(pipeline: string | null | undefined): boolean {
  return pipelineDef(pipeline)?.ownStageVocabulary === true;
}

export function isConversationalPipeline(pipeline: string | null | undefined): boolean {
  return pipelineDef(pipeline)?.conversational === true;
}

export function isHosTrackedPipeline(pipeline: string | null | undefined): boolean {
  return pipelineDef(pipeline)?.hosTracked === true;
}

/** Lowercased names, for the SQL/e-tag style checks that want a plain list. */
export const TRACKED_PIPELINE_NAMES = PIPELINES.map((p) => p.name.toLowerCase());

/**
 * Shout about funnels that exist in amoCRM but not in the table above.
 *
 * The table is still something a person has to edit, and the whole reason this
 * file exists is that a missing entry fails silently — leads never even reach
 * leads_sync, so nothing downstream (not even the stuck-lead check, which reads
 * that table) can notice them. This closes the last gap: create a funnel, put a
 * lead in it, and within minutes the log says the bot does not know about it.
 */
export async function logUnknownPipelines(
  fetchPipelines: () => Promise<Array<{ id: number; name: string }>>,
  countLeads: (pipelineId: number) => Promise<number>,
  log: (o: object, m: string) => void,
): Promise<void> {
  try {
    const all = await fetchPipelines();
    const unknown = all.filter((p) => !isTrackedPipeline(p.name));
    for (const p of unknown) {
      const n = await countLeads(p.id).catch(() => 0);
      if (n > 0) {
        log(
          { pipeline: p.name, pipelineId: p.id, leads: n },
          "unknown pipeline has leads — the bot does not work this funnel. Add it to PIPELINES in lib/pipelines.ts (name, kind, stage vocabulary, who may see it).",
        );
      }
    }
  } catch {
    /* never let a diagnostic break the scheduler */
  }
}
