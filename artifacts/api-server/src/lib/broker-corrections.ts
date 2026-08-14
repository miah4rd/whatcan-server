/**
 * Learning from the broker's edits — server-side, so it works from EVERY
 * surface. The correction store existed, but only the Chrome extension ever
 * wrote to it: the owner edits from the phone, so nothing was ever learned, and
 * the next draft repeated exactly what had just been corrected. The revision
 * endpoint itself now saves the lesson.
 */
import { db, brokerCorrectionsTable } from "@workspace/db";
import { eq, desc, and, isNull, inArray, or } from "drizzle-orm";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";
import { brokerKey } from "./broker-identity";
import { logger } from "./logger";

/**
 * The moments a rental conversation actually passes through. A lesson is
 * taught IN one of these moments, and it mostly only makes sense there:
 * "skip qualification questions, go straight to action items" was dictated on
 * an owner conversation and is actively wrong on a first client contact.
 *
 * Before this, every lesson applied to every message — the model was handed
 * one flat list, and the only cure for a lesson misfiring in the wrong moment
 * was the broker teaching its negation, which then ALSO applied everywhere.
 * Situational lessons are the load-bearing half of "the broker eventually
 * stops editing": the end state is per-situation autopilot, and a situation
 * can only graduate when its lessons are its own.
 *
 * `style` is the exception — tone, greeting, signature, language — and applies
 * to every message. Untagged legacy rows are treated as style until the
 * backfill classifier has visited them.
 */
export const SITUATIONS = [
  "first_contact", // first reply to a new lead / ad-lead answer
  "qualifying",    // gathering criteria: dates, budget, area, bedrooms
  "options",       // presenting listings, availability answers, shortlists
  "objection",     // price pushback, doubts, "too expensive", comparisons
  "viewing",       // arranging a viewing / call, time slots
  "followup",      // scheduled chases, re-engaging a silent lead
  "owner_intake",  // Rental Listings: talking to an owner about their villa
  "closing",       // reservation, negotiation, contract, handover
] as const;
export type Situation = (typeof SITUATIONS)[number];
export type LessonTag = Situation | "style";

const OBJECTION_RX =
  /too (expensive|much|high)|over (my|our) budget|cheaper|expensive|can'?t afford|price is|дорого|слишком дор|дешевле|mahal|kemahalan|budget nya|di luar budget/i;

/**
 * Which moment the CURRENT draft is being written in. Deterministic and free —
 * computed from state the generation path already holds, so telling the
 * lessons apart costs zero extra AI calls and zero latency.
 */
export function deriveSituation(opts: {
  pipeline?: string | null;
  kind?: string | null;
  leadStage?: string | null;
  lastLeadText?: string | null;
  /** True when the lead has not written anything yet / this is our opener. */
  isFirstContact?: boolean;
}): Situation {
  const pipe = (opts.pipeline ?? "").toLowerCase();
  if (pipe.includes("listing")) return "owner_intake";

  if ((opts.kind ?? "") === "push") return "followup";

  const stage = (opts.leadStage ?? "").toLowerCase();
  if (/(negotiat|reservation|contract|won)/.test(stage)) return "closing";
  if (/(viewing|zoom)/.test(stage)) return "viewing";
  if (OBJECTION_RX.test(opts.lastLeadText ?? "")) return "objection";
  if (/(feedback|objection)/.test(stage)) return "objection";
  if (opts.isFirstContact || /(new lead|initial|неразобран)/.test(stage)) return "first_contact";
  if (/(need|assess|qualif|contact establi)/.test(stage)) return "qualifying";
  if (/option/.test(stage)) return "options";
  return "options";
}

function wordSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-zа-яё0-9\s]/gi, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/** Rough duplicate check so the store doesn't fill with restatements. */
function similar(a: string, b: string): boolean {
  const A = wordSet(a);
  const B = wordSet(b);
  if (A.size === 0 || B.size === 0) return false;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size) > 0.6;
}

/**
 * Distil a (possibly rambling, voice-dictated) edit into a short reusable
 * preference and store it — unless an equivalent lesson is already stored.
 * Fire-and-forget: learning must never slow the reply down.
 */
export async function learnFromRevision(
  brokerName: string | null | undefined,
  rawFeedback: string,
  /** The moment the edit happened in — lets the lesson apply only where it was taught. */
  ctx?: { pipeline?: string | null; leadStage?: string | null; lastLeadText?: string | null },
): Promise<void> {
  const feedback = (rawFeedback ?? "").trim();
  if (feedback.length < 8) return;
  const brokerId = brokerKey(brokerName);

  try {
    const situationHint = ctx
      ? `\n\nCONTEXT of the edit: pipeline "${ctx.pipeline ?? "?"}", lead stage "${ctx.leadStage ?? "?"}"${ctx.lastLeadText ? `, client's last message: "${String(ctx.lastLeadText).slice(0, 200)}"` : ""}.`
      : "";
    const parsed = await chatCompletionJSON<{ instruction?: string; situation?: string }>({
      model: HELPER_MODEL,
      label: "learn-edit",
      system: `A real-estate broker just corrected an AI-drafted message. Extract the REUSABLE preference behind the correction — something that should apply to future messages too (max 120 chars). Keep names the broker wants used (e.g. "sign as Nick") and copy every name EXACTLY as written — never transliterate or guess a spelling ("Хос" stays "Хос", it is not "Jose"). Drop one-off details about this specific lead or property. If the correction is purely one-off (nothing reusable), return an empty instruction.

Also classify WHEN this preference applies. "style" = tone/greeting/signature/language/length — applies to every message. Otherwise pick the ONE conversation moment it belongs to: ${SITUATIONS.join(", ")}. When unsure, prefer "style".${situationHint}

Respond with JSON only: {"instruction": "...", "situation": "style|${SITUATIONS.join("|")}"}`,
      messages: [{ role: "user", content: feedback.slice(0, 1500) }],
      max_tokens: 120,
    });
    const instruction = parsed.instruction?.trim();
    if (!instruction || instruction.length < 5) return;

    const situation: LessonTag =
      parsed.situation && (SITUATIONS as readonly string[]).includes(parsed.situation)
        ? (parsed.situation as Situation)
        : "style";

    const existing = await activeLessons(brokerId, 60);
    if (existing.some((r) => similar(r.instruction, instruction))) return;

    const situationContext = ctx
      ? [ctx.pipeline, ctx.leadStage].filter(Boolean).join(" / ") || null
      : null;
    await db.insert(brokerCorrectionsTable).values({ brokerId, instruction, situation, situationContext });
    logger.info({ brokerId, instruction, situation }, "learned from the broker's edit");

    // The broker has just told us something newer. Anything they taught
    // earlier that this contradicts is no longer what they want, and leaving
    // both in the prompt is how the model ended up holding "avoid the word
    // proactive" and "use proactive language" at the same time.
    await retireContradicted(brokerId, instruction, existing);
  } catch (err) {
    logger.warn({ err, brokerId }, "could not learn from this edit (non-fatal)");
  }
}

type Lesson = { id: string; instruction: string; situation?: string | null };

/**
 * The lessons still in force. With a `situation`, narrows to the ones that
 * belong to this moment plus the universal `style` set; untagged legacy rows
 * ride along as universal until the backfill classifier has visited them, so
 * nothing the broker taught before tagging existed silently stops applying.
 */
async function activeLessons(brokerId: string, limit: number, situation?: Situation | null): Promise<Lesson[]> {
  const base = and(
    eq(brokerCorrectionsTable.brokerId, brokerId),
    isNull(brokerCorrectionsTable.supersededAt),
  );
  const where = situation
    ? and(
        base,
        or(
          isNull(brokerCorrectionsTable.situation),
          eq(brokerCorrectionsTable.situation, "style"),
          eq(brokerCorrectionsTable.situation, situation),
        ),
      )
    : base;
  const rows = await db
    .select({
      id: brokerCorrectionsTable.id,
      instruction: brokerCorrectionsTable.instruction,
      situation: brokerCorrectionsTable.situation,
    })
    .from(brokerCorrectionsTable)
    .where(where)
    .orderBy(desc(brokerCorrectionsTable.createdAt))
    .limit(limit);
  return rows
    .map((r) => ({ id: r.id, instruction: (r.instruction ?? "").trim(), situation: r.situation }))
    .filter((r) => r.instruction);
}

/**
 * Asks the cheap model which of the broker's earlier lessons the new one
 * overrides, and retires those. Deliberately conservative: it is told to
 * return nothing unless following both at once is impossible, because a
 * false positive silently erases a preference the broker still holds — and
 * two lessons that merely cover different ground ("sign as Nick", "keep it
 * short") must both survive.
 */
async function retireContradicted(brokerId: string, fresh: string, earlier: Lesson[]): Promise<void> {
  if (earlier.length === 0) return;
  try {
    const numbered = earlier.map((l, i) => `${i + 1}. ${l.instruction}`).join("\n");
    const parsed = await chatCompletionJSON<{ supersedes?: number[] }>({
      model: HELPER_MODEL,
      label: "corrections-supersede",
      system: `A real-estate broker has just taught their AI assistant a NEW writing preference. You are given their EARLIER preferences, numbered.

Return the numbers of earlier preferences that the new one CONTRADICTS or REPLACES — cases where a writer could not follow both at once, or where the new one is a stricter/updated version of the same rule.

Be conservative. Preferences about different things both stay. If in doubt, do NOT list it. An empty list is the normal answer.

Respond with JSON only: {"supersedes": [numbers]}`,
      messages: [{ role: "user", content: `NEW PREFERENCE:\n${fresh}\n\nEARLIER PREFERENCES:\n${numbered}` }],
      max_tokens: 100,
      temperature: 0,
    });

    const ids = (parsed.supersedes ?? [])
      .map((n) => earlier[Number(n) - 1]?.id)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;

    await db
      .update(brokerCorrectionsTable)
      .set({ supersededAt: new Date() })
      .where(inArray(brokerCorrectionsTable.id, ids));
    logger.info({ brokerId, retired: ids.length, fresh }, "retired contradicted lessons");
  } catch (err) {
    logger.warn({ err, brokerId }, "supersede check failed (non-fatal)");
  }
}

/**
 * The lessons, ready to inject into a prompt. Shared by BOTH generation paths —
 * the corrections used to reach only the revision endpoint, so the next fresh
 * draft ignored everything the broker had taught.
 *
 * The window was 8. One broker had taught 242 lessons; 234 of them applied to
 * nothing, so a preference held for more than about two days quietly stopped
 * being honoured and the broker had to teach it again. Retiring contradicted
 * lessons on write (see retireContradicted) is what makes a wider window safe:
 * what survives is a set the model can follow all at once.
 *
 * Pass `situation` (deriveSituation at the call site, or a fixed one where the
 * caller IS the situation — the follow-up scheduler, the listing-intake
 * prompt) and the block narrows to this moment's lessons plus `style`.
 * Without it, everything active is included — the pre-situational behaviour.
 */
export async function correctionsPromptBlock(
  brokerName: string | null | undefined,
  situation?: Situation | null,
  limit = 30,
): Promise<string> {
  try {
    const lessons = await activeLessons(brokerKey(brokerName), limit, situation);
    if (lessons.length === 0) return "";
    const scope = situation ? `in this situation (${situation})` : "on every message";
    return `\n\nTHE BROKER HAS TAUGHT YOU THESE PREFERENCES on earlier edits — they apply ${scope}:\n${lessons
      .map((l) => `- ${l.instruction}`)
      .join("\n")}`;
  } catch {
    return "";
  }
}
