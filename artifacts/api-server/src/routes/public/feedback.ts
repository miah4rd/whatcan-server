import { Router } from "express";
import { db, suggestionFeedbackTable } from "@workspace/db";

const router = Router();

const VERDICTS = new Set(["good", "bad", "approved", "skipped", "edited"]);

router.options("/feedback", (_req, res) => res.sendStatus(204));

router.post("/feedback", async (req, res) => {
  const body = req.body as {
    suggestionId?: string;
    brokerId?: string;
    brokerName?: string;
    verdict?: string;
    finalText?: string;
    comment?: string;
  };

  if (
    !body?.suggestionId ||
    typeof body.suggestionId !== "string" ||
    !body.verdict ||
    !VERDICTS.has(body.verdict) ||
    (body.finalText && body.finalText.length > 8000) ||
    (body.comment && body.comment.length > 1000)
  ) {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }

  const brokerId = (body.brokerId || body.brokerName || "anon").toLowerCase().slice(0, 64);

  try {
    await db.insert(suggestionFeedbackTable).values({
      suggestionId: body.suggestionId as any,
      brokerId,
      verdict: body.verdict,
      finalText: body.finalText ?? null,
      comment: body.comment ?? null,
    });
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "feedback insert error");
    res.status(500).json({ error: "DB error" });
  }
});

export default router;
