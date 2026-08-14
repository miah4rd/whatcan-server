/**
 * Learning from the broker's edits — server-side, so it works from EVERY
 * surface. The correction store existed, but only the Chrome extension ever
 * wrote to it: the owner edits from the phone, so nothing was ever learned, and
 * the next draft repeated exactly what had just been corrected. The revision
 * endpoint itself now saves the lesson.
 */
import { db, brokerCorrectionsTable } from "@workspace/db";
import { eq, desc, and, isNull, inArray } from "drizzle-orm";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";
import { brokerKey } from "./broker-identity";
import { logger } from "./logger";

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
export async function learnFromRevision(brokerName: string | null | undefined, rawFeedback: string): Promise<void> {
  const feedback = (rawFeedback ?? "").trim();
  if (feedback.length < 8) return;
  const brokerId = brokerKey(brokerName);

  try {
    const parsed = await chatCompletionJSON<{ instruction?: string }>({
      model: HELPER_MODEL,
      label: "learn-edit",
      system: `A real-estate broker just corrected an AI-drafted message. Extract the REUSABLE preference behind the correction — something that should apply to future messages too (max 120 chars). Keep names the broker wants used (e.g. "sign as Nick") and copy every name EXACTLY as written — never transliterate or guess a spelling ("Хос" stays "Хос", it is not "Jose"). Drop one-off details about this specific lead or property. If the correction is purely one-off (nothing reusable), return an empty instruction.

Respond with JSON only: {"instruction": "..."}`,
      messages: [{ role: "user", content: feedback.slice(0, 1500) }],
      max_tokens: 80,
    });
    const instruction = parsed.instruction?.trim();
    if (!instruction || instruction.length < 5) return;

    const existing = await activeLessons(brokerId, 60);
    if (existing.some((r) => similar(r.instruction, instruction))) return;

    await db.insert(brokerCorrectionsTable).values({ brokerId, instruction });
    logger.info({ brokerId, instruction }, "learned from the broker's edit");

    // The broker has just told us something newer. Anything they taught
    // earlier that this contradicts is no longer what they want, and leaving
    // both in the prompt is how the model ended up holding "avoid the word
    // proactive" and "use proactive language" at the same time.
    await retireContradicted(brokerId, instruction, existing);
  } catch (err) {
    logger.warn({ err, brokerId }, "could not learn from this edit (non-fatal)");
  }
}

type Lesson = { id: string; instruction: string };

async function activeLessons(brokerId: string, limit: number): Promise<Lesson[]> {
  const rows = await db
    .select({ id: brokerCorrectionsTable.id, instruction: brokerCorrectionsTable.instruction })
    .from(brokerCorrectionsTable)
    .where(
      and(eq(brokerCorrectionsTable.brokerId, brokerId), isNull(brokerCorrectionsTable.supersededAt)),
    )
    .orderBy(desc(brokerCorrectionsTable.createdAt))
    .limit(limit);
  return rows
    .map((r) => ({ id: r.id, instruction: (r.instruction ?? "").trim() }))
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
 */
export async function correctionsPromptBlock(brokerName: string | null | undefined, limit = 30): Promise<string> {
  try {
    const items = (await activeLessons(brokerKey(brokerName), limit)).map((l) => l.instruction);
    if (items.length === 0) return "";
    return `\n\nTHE BROKER HAS TAUGHT YOU THESE PREFERENCES on earlier edits — they apply to every message:\n${items
      .map((i) => `- ${i}`)
      .join("\n")}`;
  } catch {
    return "";
  }
}
