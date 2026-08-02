/**
 * Learning from the broker's edits — server-side, so it works from EVERY
 * surface. The correction store existed, but only the Chrome extension ever
 * wrote to it: the owner edits from the phone, so nothing was ever learned, and
 * the next draft repeated exactly what had just been corrected. The revision
 * endpoint itself now saves the lesson.
 */
import { db, brokerCorrectionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
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

    const existing = await db
      .select({ instruction: brokerCorrectionsTable.instruction })
      .from(brokerCorrectionsTable)
      .where(eq(brokerCorrectionsTable.brokerId, brokerId))
      .orderBy(desc(brokerCorrectionsTable.createdAt))
      .limit(50);
    if (existing.some((r) => similar(r.instruction ?? "", instruction))) return;

    await db.insert(brokerCorrectionsTable).values({ brokerId, instruction });
    logger.info({ brokerId, instruction }, "learned from the broker's edit");
  } catch (err) {
    logger.warn({ err, brokerId }, "could not learn from this edit (non-fatal)");
  }
}

/**
 * The lessons, ready to inject into a prompt. Shared by BOTH generation paths —
 * the corrections used to reach only the revision endpoint, so the next fresh
 * draft ignored everything the broker had taught.
 */
export async function correctionsPromptBlock(brokerName: string | null | undefined, limit = 8): Promise<string> {
  try {
    const rows = await db
      .select({ instruction: brokerCorrectionsTable.instruction })
      .from(brokerCorrectionsTable)
      .where(eq(brokerCorrectionsTable.brokerId, brokerKey(brokerName)))
      .orderBy(desc(brokerCorrectionsTable.createdAt))
      .limit(limit);
    const items = rows.map((r) => (r.instruction ?? "").trim()).filter(Boolean);
    if (items.length === 0) return "";
    return `\n\nTHE BROKER HAS TAUGHT YOU THESE PREFERENCES on earlier edits — they apply to every message:\n${items
      .map((i) => `- ${i}`)
      .join("\n")}`;
  } catch {
    return "";
  }
}
