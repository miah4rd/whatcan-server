/**
 * POST /api/admin/corrections/dedupe[?broker=amelia][&dry=1]
 *
 * A one-off pass over the lessons already in the store.
 *
 * Going forward, a new lesson retires the earlier ones it contradicts (see
 * lib/broker-corrections.ts). But the store was built while nothing did that
 * and while only the newest 8 lessons were ever injected, so contradictions
 * could pile up unnoticed: one broker taught "avoid the word proactive" and
 * "use proactive language" on the same day and both are still marked active.
 * Widening the prompt window to 30 without this would put both in front of the
 * model at once — the fix would have made the symptom worse.
 *
 * Newest wins, always: the broker's most recent instruction is the one they
 * meant. Nothing is deleted, only marked superseded.
 */
import { Router } from "express";
import { db, brokerCorrectionsTable } from "@workspace/db";
import { and, desc, eq, isNull, inArray } from "drizzle-orm";
import { chatCompletionJSON, HELPER_MODEL } from "../../lib/ai-client";

const router = Router();

/** How far back to look. Beyond this the lessons are too old to be worth the tokens. */
const WINDOW = 40;

type Lesson = { id: string; instruction: string };

async function dedupeBroker(brokerId: string, dry: boolean) {
  const rows = await db
    .select({ id: brokerCorrectionsTable.id, instruction: brokerCorrectionsTable.instruction })
    .from(brokerCorrectionsTable)
    .where(and(eq(brokerCorrectionsTable.brokerId, brokerId), isNull(brokerCorrectionsTable.supersededAt)))
    .orderBy(desc(brokerCorrectionsTable.createdAt))
    .limit(WINDOW);

  const lessons: Lesson[] = rows
    .map((r) => ({ id: r.id, instruction: (r.instruction ?? "").trim() }))
    .filter((r) => r.instruction);
  if (lessons.length < 2) return { broker: brokerId, considered: lessons.length, retired: 0, retiredText: [] as string[] };

  // Numbered NEWEST first, and the model is told so — the tie-break is recency.
  const numbered = lessons.map((l, i) => `${i + 1}. ${l.instruction}`).join("\n");
  const parsed = await chatCompletionJSON<{ retire?: number[] }>({
    model: HELPER_MODEL,
    label: "corrections-dedupe",
    system: `These are writing preferences a real-estate broker taught their AI assistant, numbered NEWEST FIRST (1 is the most recent).

Return the numbers that should be RETIRED because a NEWER one (a lower number) contradicts them or is an updated version of the same rule. A writer must be able to follow everything that remains, all at once.

Rules:
- Never retire something because of an OLDER entry. Recency wins.
- Preferences about different things all stay.
- Be conservative: if following both is possible, keep both. An empty list is a fine answer.

Respond with JSON only: {"retire": [numbers]}`,
    messages: [{ role: "user", content: numbered }],
    max_tokens: 300,
    temperature: 0,
  });

  const picked = (parsed.retire ?? [])
    .map((n) => lessons[Number(n) - 1])
    .filter((l): l is Lesson => Boolean(l));

  if (picked.length > 0 && !dry) {
    await db
      .update(brokerCorrectionsTable)
      .set({ supersededAt: new Date() })
      .where(inArray(brokerCorrectionsTable.id, picked.map((l) => l.id)));
  }

  return {
    broker: brokerId,
    considered: lessons.length,
    retired: picked.length,
    retiredText: picked.map((l) => l.instruction),
  };
}

router.post("/admin/corrections/dedupe", async (req, res) => {
  const only = String(req.query["broker"] ?? "").trim().toLowerCase();
  const dry = String(req.query["dry"] ?? "") === "1";

  try {
    const brokers = only
      ? [only]
      : (
          await db
            .selectDistinct({ brokerId: brokerCorrectionsTable.brokerId })
            .from(brokerCorrectionsTable)
        ).map((r) => r.brokerId);

    const results = [];
    for (const b of brokers) results.push(await dedupeBroker(b, dry));
    res.json({ dry, results });
  } catch (err) {
    req.log.error({ err }, "corrections dedupe failed");
    res.status(500).json({ error: "dedupe failed" });
  }
});

export default router;
