/**
 * The Attach menu of the message editor (owner, 27.09.2026: like WhatsApp — a villa from the site,
 * its Google Maps, its Drive folder, its video tour). Same as Copilot OS.
 */
import { Router } from "express";
import { pool } from "@workspace/db";
import { villaIdsIn, villaLinks } from "../../lib/villa-maps";

const router = Router();

/** The villas in play on a card: named in its thread, its pending drafts, or a client-waiting question. */
router.get("/villa-links", async (req, res) => {
  const leadId = String(req.query["leadId"] ?? "").trim();
  if (!/^\d+$/.test(leadId)) { res.status(400).json({ error: "leadId required" }); return; }
  const texts = await pool.query(`SELECT text FROM lead_messages WHERE lead_id = $1 AND text IS NOT NULL ORDER BY sent_at DESC LIMIT 60`, [leadId]).catch(() => ({ rows: [] as Array<{ text: string }> }));
  const drafts = await pool.query(`SELECT suggestion_text, attachments FROM pending_suggestions WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 10`, [leadId]).catch(() => ({ rows: [] as Array<{ suggestion_text: string; attachments: unknown }> }));
  const asks = await pool.query(`SELECT villa_ids FROM os_availability_asks WHERE client_lead_id = $1 ORDER BY created_at DESC LIMIT 3`, [leadId]).catch(() => ({ rows: [] as Array<{ villa_ids: string[] }> }));
  const ids: string[] = [];
  for (const r of asks.rows) for (const v of r.villa_ids ?? []) ids.push(String(v).toUpperCase());
  ids.push(...villaIdsIn(texts.rows.map((r) => r.text).join("\n")));
  ids.push(...villaIdsIn(drafts.rows.map((r) => `${r.suggestion_text}\n${JSON.stringify(r.attachments ?? [])}`).join("\n")));
  res.json({ villas: await villaLinks(ids) });
});

export default router;
