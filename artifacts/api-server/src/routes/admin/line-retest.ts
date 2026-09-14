/**
 * Re-send a card's first message from a DIFFERENT WhatsApp line, to find out
 * whether "WhatsApp is not installed on this number" was about the number or
 * about the line that sent it.
 *
 * Owner, 14.09.2026: Yudi 2 (62585) got that notice on 4 of its first 6 sends,
 * all ordinary mobiles — "send those from Yudi's first number; if they fail
 * there too the numbers are bad, if they arrive the problem is line 2".
 *
 * POST /api/admin/line-retest?lead=<id>&line=59537          dry run
 * POST /api/admin/line-retest?lead=<id>&line=59537&apply=1  send
 *
 * Only for a card that already carries the not-installed notice. Goes through
 * deliverText (the one send path) with the messenger field set to the given
 * line; no stage, task or follow-up is touched, and the row is stamped
 * kind "line-retest" so the first-contact budget (which bills a lead's FIRST
 * send) does not count it. Read the result in the lead's timeline: a type-90
 * event, then either a reply or another notice.
 */
import { Router } from "express";
import { db, sentMessagesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { deliverText } from "../../lib/outbound-send";
import { getLastMessengerFieldId, isKnownWhatsappLine, updateLastMessengerField } from "../../lib/amo-messenger-field";
import { UNDELIVERABLE_LEAD_IDS } from "../../lib/undeliverable";

const router = Router();

function rows<T>(res: unknown): T[] {
  const r = res as { rows?: T[] };
  return Array.isArray(r.rows) ? r.rows : Array.isArray(res) ? (res as T[]) : [];
}

router.post("/admin/line-retest", async (req, res) => {
  const leadId = String(req.query["lead"] ?? "").trim();
  const line = Number(req.query["line"]);
  const apply = String(req.query["apply"] ?? "") === "1";
  if (!/^\d+$/.test(leadId) || !isKnownWhatsappLine(line)) {
    res.status(400).json({ error: "lead=<numeric id> and line=<one of our WhatsApp source ids> are required" });
    return;
  }

  const notice = rows<{ x: number }>(
    await db.execute(sql`SELECT 1 AS x WHERE ${leadId} IN ${UNDELIVERABLE_LEAD_IDS}`),
  );
  if (notice.length === 0) {
    res.status(409).json({ error: "this card has no 'WhatsApp not installed' notice — nothing to re-test" });
    return;
  }

  const [first] = rows<{ message_text: string; source_id: string | null; responsible_user: string | null }>(
    await db.execute(sql`
      SELECT message_text, source_id, responsible_user FROM sent_messages
      WHERE lead_id = ${leadId} AND coalesce(kind, '') <> 'line-retest'
      ORDER BY created_at ASC LIMIT 1`),
  );
  if (!first) {
    res.status(409).json({ error: "no earlier send on this card to repeat" });
    return;
  }

  const plan = { leadId, line, originalLine: first.source_id, text: first.message_text };
  if (!apply) {
    res.json({ dryRun: true, ...plan });
    return;
  }

  const log = { warn: (o: object, m: string) => logger.warn(o, m) };
  const fieldOk = await updateLastMessengerField(leadId, String(line), line, getLastMessengerFieldId());
  if (!fieldOk) {
    res.status(502).json({ error: "could not set the messenger field — not sent", ...plan });
    return;
  }
  const delivery = await deliverText(leadId, first.message_text, log);
  await db.insert(sentMessagesTable).values({
    leadId,
    kind: "line-retest",
    messageText: delivery.deliveryText,
    responsibleUser: first.responsible_user,
    sourceId: String(line),
    webhookStatus: delivery.hookStatus,
    webhookResponse: delivery.hookBody,
  });
  logger.warn({ ...plan, hookStatus: delivery.hookStatus }, "line-retest: first message re-sent from another line");
  res.json({ sent: delivery.chatSent, hookStatus: delivery.hookStatus, hookBody: delivery.hookBody, ...plan });
});

export default router;
