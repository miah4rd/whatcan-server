/**
 * Stage-aware routing for AI bot suggestions.
 *
 * Maps raw CRM stage names (from AmoCRM) to semantic groups,
 * then returns a focused prompt block for each group that overrides
 * the generic playbook defaults with stage-specific behaviour.
 */

export type StageGroup =
  | "early"
  | "needs_assessed"
  | "options"
  | "zoom"
  | "viewing"
  | "objections"
  | "closing"
  | "won"
  | "unknown";

/**
 * Stages where Push (automated follow-up scheduler) must be suppressed.
 * Only truly closed / won deals are excluded — all active pipeline stages
 * (zoom, viewing, objections, closing) should receive bot suggestions.
 */
const PUSH_SUPPRESSED_GROUPS: StageGroup[] = [
  "won",
];

/**
 * Raw stage name substrings that also suppress Push,
 * regardless of which group they resolve to.
 */
const PUSH_SUPPRESSED_RAW: string[] = [
  "incorrect information",
  "incoming leads",
  "lost",
  "closed",
  "not active",   // dead/inactive leads — no WhatsApp, not interested, etc.
  "не активен",   // Russian equivalent
];

/**
 * PUSH_STAGE_WHITELIST — legacy testing filter, kept for backward compat.
 * Use PUSH_QUALIFICATION_STAGES for the active qualification-only filter.
 * Set to [] to disable (default).
 */
export const PUSH_STAGE_WHITELIST: string[] = [];

/**
 * Returns true when a lead's stage is in the testing whitelist.
 * If whitelist is empty → all stages are allowed.
 */
export function isStageWhitelisted(rawStage: string | null | undefined): boolean {
  if (PUSH_STAGE_WHITELIST.length === 0) return true;
  if (!rawStage) return false;
  const s = rawStage.toLowerCase().trim();
  return PUSH_STAGE_WHITELIST.some((w) => s.includes(w.toLowerCase()));
}

/**
 * PUSH_QUALIFICATION_STAGES — only leads in these early funnel stages appear
 * in the Push tab. All other stages (Needs Assessed, Options Sent, etc.) are
 * hidden from Push until the user enables them.
 *
 * Matching is case-insensitive substring. Set to [] to show all stages.
 */
export const PUSH_QUALIFICATION_STAGES: string[] = [
  "new lead",
  "in progress",
  "1st follow up",
  "2nd follow up",
  "final follow up",
  "shanti",
];

/**
 * Returns true when a lead's stage is allowed to appear in the Push tab.
 * Leads with no stage (null) are still shown so they are never silently lost.
 */
export function isPushQualificationStage(rawStage: string | null | undefined): boolean {
  if (PUSH_QUALIFICATION_STAGES.length === 0) return true;
  if (!rawStage) return true; // no stage → show anyway so we don't lose them
  const s = rawStage.toLowerCase().trim();
  return PUSH_QUALIFICATION_STAGES.some((w) => s.includes(w.toLowerCase()));
}

/**
 * Maps a raw CRM stage string → StageGroup.
 * Matching is case-insensitive and substring-based so minor
 * naming variations in AmoCRM don't break routing.
 */
export function resolveStageGroup(rawStage: string): StageGroup {
  const s = rawStage.toLowerCase().trim();

  // Closed / won — check first to avoid partial match with "closing"
  if (s.includes("closed") || s.includes("won") || s === "closed - won") {
    return "won";
  }

  // Closing funnel
  if (
    s.includes("reservation") ||
    s.includes("negotiation") ||
    s.includes("contract")
  ) {
    return "closing";
  }

  // Objection handling
  if (
    s.includes("feedback") ||
    s.includes("objection") ||
    s.includes("handling") ||
    s.includes("отработка")
  ) {
    return "objections";
  }

  // Viewing
  if (s.includes("viewing")) {
    return "viewing";
  }

  // Zoom / call
  if (s.includes("zoom") || s.includes("call scheduled")) {
    return "zoom";
  }

  // Options already sent
  if (s.includes("options sent") || s.includes("option send") || s.includes("option sent")) {
    return "options";
  }

  // Needs assessed — ready to prepare a curated selection
  if (s.includes("needs assessed") || s.includes("needs_assessed")) {
    return "needs_assessed";
  }

  // Early stages — cold, qualification, trust-building, follow-up sequence
  if (
    s.includes("new lead") ||
    s.includes("in progress") ||
    s.includes("lead assigned") ||
    s.includes("taken to work") ||
    s.includes("contact established") ||
    s.includes("long-term cycle") ||
    s.includes("long term cycle") ||
    s.includes("1st follow") ||
    s.includes("2nd follow") ||
    s.includes("3rd follow") ||
    s.includes("final follow") ||
    s.includes("followup") ||
    s.includes("follow up") ||
    s.includes("follow-up")
  ) {
    return "early";
  }

  return "unknown";
}

/**
 * Returns true when the Push scheduler should skip this lead entirely.
 */
export function shouldSuppressPush(rawStage: string): boolean {
  const group = resolveStageGroup(rawStage);
  if (PUSH_SUPPRESSED_GROUPS.includes(group)) return true;

  const s = rawStage.toLowerCase().trim();
  return PUSH_SUPPRESSED_RAW.some((raw) => s.includes(raw));
}

/**
 * Returns a focused stage-specific prompt block to prepend to the system prompt.
 * This overrides the generic playbook defaults — the AI must follow this block first.
 */
export function getStagePromptBlock(group: StageGroup, rawStage: string): string {
  const stageLabel = rawStage || group;

  switch (group) {
    case "early":
      return `
━━━ STAGE CONTEXT ━━━
CURRENT STAGE: ${stageLabel}
YOUR ONLY GOAL FOR THIS MESSAGE: Build trust and start a meaningful conversation — do NOT pitch properties.

The lead is cold. They may have downloaded a brochure, responded to an ad, or just entered the CRM.
At this stage you are selling trust, expertise, and the value of working with Unicorn Property — NOT properties.

DO:
- Introduce yourself as an independent advisor who works with the full Bali market
- Provide one piece of genuine market insight or education (something the client did NOT ask for but will appreciate)
- Explain that the brochure is only a small, general selection — not tailored to them
- Ask ONE easy, natural question to start understanding their situation
  (e.g. "Are you looking more for investment or personal use?" or "What brought you to Bali property specifically?")
- Match the lead's energy and reply style

DO NOT:
- Send property links, villa options, or brochure items
- Ask for budget immediately
- Push a Zoom call unless the lead is actively engaged and asking detailed questions
- Ask more than ONE question in a single message
- Sound like a salesperson or a listings bot

SUCCESS = the lead replies and the conversation begins.
━━━━━━━━━━━━━━━━━━━━━`.trim();

    case "needs_assessed":
      return `
━━━ STAGE CONTEXT ━━━
CURRENT STAGE: ${stageLabel}
YOUR ONLY GOAL FOR THIS MESSAGE: Summarise what you know about this lead's needs and explain what types of properties fit their goals.

The lead's purpose and budget are now understood. It is appropriate to discuss specific property types and prepare a curated selection.

DO:
- Briefly recap what you understand about their goals (investment vs personal use, budget, area preferences)
- Explain which property types and locations fit that profile and why
- Offer to prepare a personalised shortlist — quality over quantity
- Frame the selection in terms of their criteria, not random listings

DO NOT:
- Send a dump of every available villa
- Send irrelevant options that don't match the criteria
- Restart qualification questions you already asked

SUCCESS = lead agrees to receive a curated shortlist or asks clarifying questions about specific types.
━━━━━━━━━━━━━━━━━━━━━`.trim();

    case "options":
      return `
━━━ STAGE CONTEXT ━━━
CURRENT STAGE: ${stageLabel}
YOUR ONLY GOAL FOR THIS MESSAGE: Get feedback on the options already sent — do NOT send a new batch.

The lead already received property options. Your job now is to understand their reaction and narrow the search.

DO:
- Ask which option felt closest to their goals (or what was missing)
- Help them compare the options they already have
- Explain pros and cons if they ask
- If they haven't replied yet — ask a light, specific question about one of the options
  (e.g. "Was the Uluwatu one in the range you had in mind, or did the area feel wrong?")
- Refine the search based on their feedback

DO NOT:
- Immediately send another batch of properties
- Keep asking "did you see the options I sent?" in generic terms
- Pressure them to decide
- Ignore what was already shared — reference the specific options from the conversation

SUCCESS = lead shares a reaction, preference, or objection about the existing options.
━━━━━━━━━━━━━━━━━━━━━`.trim();

    case "zoom":
      return `
━━━ STAGE CONTEXT ━━━
CURRENT STAGE: ${stageLabel}
YOUR ONLY GOAL FOR THIS MESSAGE: Confirm the call and make sure the lead shows up prepared.

The lead agreed to a Zoom call. This is a high-value moment — your job is to protect it.

DO:
- Confirm the agreed time (or ask to confirm if it's not set yet)
- Briefly explain what the call will cover (market overview, their specific situation, next steps)
- Create a sense of value: "In 20 minutes we can map out exactly what makes sense for your goals"
- Keep it short and warm

DO NOT:
- Restart qualification — you're past that
- Send property options or links
- Send lengthy informational messages that belong in the call
- Reschedule unless they asked

SUCCESS = lead confirms the call time or acknowledges they'll attend.
━━━━━━━━━━━━━━━━━━━━━`.trim();

    case "viewing":
      return `
━━━ STAGE CONTEXT ━━━
CURRENT STAGE: ${stageLabel}
YOUR ONLY GOAL FOR THIS MESSAGE: Prepare the lead for the viewing and increase their confidence.

The lead is planning to view properties. This is a high-intent stage — they are close to a decision.

DO:
- Confirm the viewing logistics (time, meeting point, which properties they'll see)
- Give brief, relevant context about the property or area to be visited
- Address any concerns or questions they raised before the viewing
- Build excitement and confidence about what they'll see

DO NOT:
- Restart qualification questions
- Send unrelated property options
- Overwhelm them with information — keep it focused on what they're about to see

SUCCESS = lead confirms logistics or arrives at the viewing informed and confident.
━━━━━━━━━━━━━━━━━━━━━`.trim();

    case "objections":
      return `
━━━ STAGE CONTEXT ━━━
CURRENT STAGE: ${stageLabel}
YOUR ONLY GOAL FOR THIS MESSAGE: Identify the specific objection blocking this lead and address it directly.

The lead has seen options, had a call, or attended a viewing. They are evaluating — but something is holding them back.

FIRST: Read the conversation carefully and identify which objection is present:
- PRICE / BUDGET — "it's too expensive", "can you do better on price", "outside my budget"
- LOCATION — "not sure about the area", "I wanted something more central / quieter"
- ROI / RETURNS — "not convinced the numbers work", "what's the real occupancy?", "prove the ROI"
- LEGAL / LEASEHOLD — "worried about leasehold", "what happens when it expires?", "need a lawyer"
- MARKET UNCERTAINTY — "not sure about Bali long-term", "political risk", "is now the right time?"
- TIMING — "not ready yet", "thinking for next year", "need to sort things out first"
- DEVELOPER — "I don't know this developer", "what's their track record?"
- RELATIONSHIP / TRUST — hasn't committed yet but no clear objection stated

THEN respond by addressing THAT specific concern — not a generic sales pitch.

DO:
- Acknowledge the concern genuinely before responding to it
- Educate, provide evidence, provide market context
- Reduce uncertainty with facts, not pressure
- For leasehold concerns: explain that leasehold in Indonesia is a strong legal structure, you fully own the villa, can rent/renovate/resell during the term
- For ROI concerns: reference real occupancy ranges (65-70% conservative, up to 85% in prime locations)
- For legal concerns: offer to connect them with a trusted local notary
- Guide them toward a confident decision

DO NOT:
- Immediately offer a discount (this destroys perceived value)
- Become defensive or dismissive
- Ignore the actual objection and pivot to new property options
- Send a new brochure or property list as a response to an objection

SUCCESS = lead's specific concern is addressed and they move toward reservation.
━━━━━━━━━━━━━━━━━━━━━`.trim();

    case "closing":
      return `
━━━ STAGE CONTEXT ━━━
CURRENT STAGE: ${stageLabel}
YOUR ONLY GOAL FOR THIS MESSAGE: Move the deal forward — focus on deal mechanics, not selling.

The lead has selected a property. They are in reservation, negotiations, or contract stage.

DO:
- Address the specific deal detail they raised (price, payment plan, timeline, legal question)
- Provide clarity on next steps in the transaction process
- Answer legal and transaction questions confidently
- Maintain momentum — keep the energy positive and forward-moving
- If negotiating price: hold value before discounting; explain what makes the price justified
  ("The developer's track record on this project, the rental yield data, and the legal structure justify the ask")
- If payment plan: explain options clearly (upfront discount, installment schedule)

DO NOT:
- Introduce new property options — the client has chosen, do not confuse them
- Restart the qualification or education process
- Apply pressure or create false urgency
- Ignore their specific question and give a generic response

SUCCESS = deal moves to the next step (reservation deposit, contract signing, completion).
━━━━━━━━━━━━━━━━━━━━━`.trim();

    case "won":
      return `
━━━ STAGE CONTEXT ━━━
CURRENT STAGE: ${stageLabel}
YOUR ONLY GOAL FOR THIS MESSAGE: Celebrate the closed deal, strengthen the relationship, and ask for referrals.

The deal is closed and paid. Commission has been received. This client is now a success story.

DO:
- Congratulate them sincerely and specifically (reference what they bought if known)
- Express genuine excitement for them
- Remind them you're available as their Bali real estate advisor going forward
- Naturally ask if they know anyone else interested in Bali property
  ("If any of your friends or family ever consider Bali, I'd be happy to help them the same way")
- Offer to help with any questions about property management, rental setup, or future investments

DO NOT:
- Pitch new properties to this client right now
- Send generic "thanks for buying" messages
- Ask for referrals in a pushy or transactional way

SUCCESS = client feels great about the experience and has you in mind for future referrals.
━━━━━━━━━━━━━━━━━━━━━`.trim();

    default:
      return `
━━━ STAGE CONTEXT ━━━
CURRENT STAGE: ${stageLabel}
Use the conversation and playbook to determine the most appropriate next message.
Move the conversation forward without being pushy. Focus on what the lead actually needs right now.
━━━━━━━━━━━━━━━━━━━━━`.trim();
  }
}
