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

const router = Router();

router.get("/admin/line-budget", async (req, res) => {
  const broker = String(req.query["broker"] ?? "Yudi").trim();
  res.json({ broker, lines: await lineBudgets(broker) });
});

export default router;
