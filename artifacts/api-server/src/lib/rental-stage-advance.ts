/**
 * Automatic CRM stage advancement for the Rental pipeline.
 *
 * Brokers were moving leads through the funnel by hand, which is error-prone —
 * a stage gets forgotten and the lead sits stale, or the bot's own qualifying
 * logic (which reads `leadStage`) makes decisions against a stage that no
 * longer reflects reality.
 *
 * Scope is intentionally narrow: this ONLY ever moves a lead forward to
 * "Options sent", and only on a hard, code-verifiable signal (a LIVE reply
 * with real property attachments actually got sent). Every stage past that —
 * Viewing, Negotiation, Closed — carries scheduling or money weight and stays
 * a human call; auto-advancing those on a language guess is exactly the kind
 * of mistake that erodes trust in the automation.
 */

export const RENTAL_PIPELINE_NAME = "rental";

// Real stage IDs for amoCRM pipeline 11119150 ("Rental") — verified live via
// GET /api/admin/pipelines. These are NOT the same ids as the Unicorn pipeline
// (see stage-options.ts) even where names look similar.
export const RENTAL_STAGE_ORDER: Array<{ name: string; id: number }> = [
  { name: "New LEAD", id: 87301078 },
  { name: "1 foolow up", id: 87318450 },
  { name: "2 foolow up", id: 87318706 },
  { name: "3 foolow up", id: 87318710 },
  { name: "Needs Assessed", id: 87318714 },
  { name: "Options sent", id: 87318718 },
  { name: "Viewing", id: 87301082 },
  { name: "Negotiation", id: 87301086 },
  // "Closed - won" / "Closed - lost" intentionally excluded — never auto-set.
];

function rentalStageRank(name: string | null | undefined): number {
  if (!name) return -1;
  return RENTAL_STAGE_ORDER.findIndex((s) => s.name.toLowerCase() === name.trim().toLowerCase());
}

const OPTIONS_SENT_RANK = rentalStageRank("Options sent");

/**
 * Returns the stage to auto-advance to, or null if no auto-advance applies.
 * Call this right after a LIVE reply has actually been sent to the lead.
 */
export function detectRentalAutoStageAdvance(opts: {
  pipeline: string | null;
  currentStage: string | null;
  attachmentsJustSent: boolean;
}): { name: string; id: number } | null {
  if ((opts.pipeline ?? "").trim().toLowerCase() !== RENTAL_PIPELINE_NAME) return null;
  if (!opts.attachmentsJustSent) return null;

  const currentRank = rentalStageRank(opts.currentStage);
  // Already at or past "Options sent" (including Viewing/Negotiation) — nothing to do.
  if (currentRank >= OPTIONS_SENT_RANK) return null;

  return RENTAL_STAGE_ORDER[OPTIONS_SENT_RANK] ?? null;
}
