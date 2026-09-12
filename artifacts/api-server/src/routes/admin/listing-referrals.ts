import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { handleReferral, type ReferralOutcome } from "../../lib/listing-referral";

const router = Router();

/**
 * Cards where the villa side handed us someone else's number.
 *
 * Dry by default: lists what would be opened or linked. `?apply=1` opens the
 * referred contact's card and takes the source card out of the bot's hands.
 * `?lead=<id>` judges one card.
 */
router.post("/admin/listing-referrals", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const only = String(req.query["lead"] ?? "").trim();
  if (only) {
    res.json(await handleReferral(only, { apply, source: "audit" }));
    return;
  }
  const rows = await db.execute(sql`
    SELECT DISTINCT l.lead_id
      FROM leads_sync l
      JOIN lead_messages m ON m.lead_id = l.lead_id
     WHERE lower(coalesce(l.pipeline, '')) = 'rental listings'
       AND l.bot_excluded IS NOT TRUE
       AND lower(coalesce(l.lead_stage, '')) IN ('initial contact', 'taken to work', 'long term')
       AND m.sender_type = 'lead'
       AND m.sent_at > now() - interval '45 days'
       AND (m.text ~ '_Отправлен контакт_' OR m.text ~* 'TEL:\\s*\\+?\\d' OR m.text ~ '\\d[\\d\\s().-]{7,}\\d')
     LIMIT 80
  `);
  const ids = ((rows.rows ?? []) as Array<{ lead_id: string }>).map((r) => String(r.lead_id));
  const results: ReferralOutcome[] = [];
  for (const id of ids) results.push(await handleReferral(id, { apply, source: "audit" }));
  res.json({ apply, scanned: ids.length, results });
});

export default router;
