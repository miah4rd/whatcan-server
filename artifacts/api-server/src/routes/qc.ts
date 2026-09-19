/**
 * The morning quality-control report (lib/quality-control.ts).
 *
 * GET  /qc/preview?k=KEY&day=YYYY-MM-DD[&json=1][&review=0]  build the report for a day (default:
 *      yesterday) without sending; `kpi_dashboard_key` opens it. review=0 skips the model pass.
 * POST /qc/send (x-admin-token) {day?, to?, force?}  build and send now; `to` sends a test copy to one
 *      number/group and does not mark the day as sent.
 */
import { Router } from "express";
import { pool } from "@workspace/db";
import { baliDate } from "../lib/kpi-dashboard";
import { buildQc, composeMessage, runQc } from "../lib/quality-control";

const router = Router();

const yesterday = () => new Date(Date.parse(`${baliDate()}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
const dayParam = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? String(v) : yesterday());

router.get("/qc/preview", async (req, res) => {
  const r = await pool.query(`SELECT value FROM broker_settings WHERE key = 'kpi_dashboard_key'`);
  const key = (r.rows[0] as { value?: string } | undefined)?.value;
  if (!key || req.query["k"] !== key) {
    res.status(403).type("text/plain").send("Forbidden");
    return;
  }
  try {
    const qc = await buildQc(dayParam(req.query["day"]), { review: req.query["review"] !== "0" });
    if (req.query["json"] === "1") res.set("Cache-Control", "no-store").json(qc);
    else res.set("Cache-Control", "no-store").type("text/plain; charset=utf-8").send(composeMessage(qc));
  } catch (err) {
    req.log.error({ err }, "qc preview failed");
    res.status(500).type("text/plain").send("qc failed");
  }
});

router.post("/qc/send", async (req, res) => {
  const token = process.env["ADMIN_TOKEN"];
  const given = req.get("x-admin-token") ?? (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || given !== token) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const to = typeof req.body?.to === "string" && req.body.to.trim() ? req.body.to.trim() : undefined;
  const r = await runQc(dayParam(req.body?.day), { send: true, to, force: Boolean(req.body?.force) });
  res.json({ day: r.day, sentTo: "sentTo" in r ? r.sentTo : null, error: "error" in r ? r.error : null, skipped: "skipped" in r ? r.skipped : null, message: "message" in r ? r.message : null });
});

export default router;
