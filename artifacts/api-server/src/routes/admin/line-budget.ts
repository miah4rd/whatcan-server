/**
 * Today's first-contact budget per WhatsApp line of a broker, read-only.
 *
 * GET /api/admin/line-budget?broker=Yudi
 * → { broker, lines: [{ line, used, cap }, …] }  (primary line first)
 *
 * Yudi got a second number on 2026-09-13; the second line is warmed up
 * (3, then 6, then 9 a day) — see new-contact-budget.ts.
 */
import { Router } from "express";
import { lineBudgets } from "../../lib/new-contact-budget";
import { buildLearningDigest, sendLearningDigest } from "../../lib/learning-digest";

const router = Router();

router.get("/admin/line-budget", async (req, res) => {
  const broker = String(req.query["broker"] ?? "Yudi").trim();
  res.json({ broker, lines: await lineBudgets(broker) });
});


// Weekly Copilot learning digest (owner, 26.09.2026): preview, or send now with ?send=1.
router.get("/admin/learning-digest", async (req, res) => {
  const text = await buildLearningDigest(Number(req.query.days) || 7);
  if (req.query.send === "1") {
    const ok = await sendLearningDigest(text);
    res.json({ sent: ok, text });
    return;
  }
  res.type("text/plain").send(text);
});

export default router;
