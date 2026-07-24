import { Router } from "express";
import { db, brokerCorrectionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { chatCompletionJSON } from "../../lib/ai-client.js";

const router = Router();

router.options("/correction", (_req, res) => res.sendStatus(204));

/**
 * Distill raw broker feedback (which can be a rambling voice-dictation
 * transcript) into a short, reusable style instruction — never store raw
 * text verbatim, since it gets injected into every future system prompt
 * for this broker and a long/rambling instruction confuses the model
 * (e.g. it starts asking clarifying questions instead of just writing).
 */
async function distillInstruction(raw: string): Promise<string | null> {
  try {
    const parsed = await chatCompletionJSON<{ instruction?: string }>({
      model: "claude-sonnet-5",
      system: `You are a writing coach analyzing feedback a real estate broker gave about AI-generated messages.
Extract a SHORT, REUSABLE instruction (max 120 chars) that describes the broker's general preference,
so it can be applied to future messages automatically. Ignore any specific lead name, property, or one-off detail.

Respond with JSON only: {"instruction": "..."}`,
      messages: [{ role: "user", content: raw.slice(0, 2000) }],
      max_tokens: 80,
    });
    const instruction = parsed.instruction?.trim();
    return instruction && instruction.length >= 5 ? instruction : null;
  } catch {
    return null;
  }
}

router.post("/correction", async (req, res) => {
  const body = req.body as {
    brokerId?: string;
    instruction?: string;
    situationContext?: string;
  };

  if (
    !body?.brokerId ||
    !body?.instruction ||
    typeof body.instruction !== "string" ||
    body.instruction.trim().length < 3 ||
    body.instruction.length > 2000
  ) {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }

  const brokerId = body.brokerId.toLowerCase().slice(0, 64);
  const situationContext = body.situationContext?.trim() ?? null;

  const instruction = await distillInstruction(body.instruction.trim());
  if (!instruction) {
    // Distillation failed or produced nothing usable — skip rather than
    // ever fall back to storing the raw (potentially long/rambling) text.
    res.json({ ok: true, skipped: true });
    return;
  }

  try {
    await db.insert(brokerCorrectionsTable).values({ brokerId, instruction, situationContext });
    req.log.info({ brokerId, instruction }, "broker correction saved");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "correction insert error");
    res.status(500).json({ error: "DB error" });
  }
});

// GET /correction — return recent corrections for a broker (used by admin/debug)
router.get("/correction", async (req, res) => {
  const brokerId = (req.query["brokerId"] as string | undefined)?.toLowerCase().slice(0, 64);
  if (!brokerId) {
    res.status(400).json({ error: "brokerId required" });
    return;
  }
  try {
    const rows = await db
      .select()
      .from(brokerCorrectionsTable)
      .where(eq(brokerCorrectionsTable.brokerId, brokerId))
      .orderBy(desc(brokerCorrectionsTable.createdAt))
      .limit(50);
    res.json({ corrections: rows });
  } catch (err) {
    req.log.error({ err }, "correction fetch error");
    res.status(500).json({ error: "DB error" });
  }
});

export default router;
