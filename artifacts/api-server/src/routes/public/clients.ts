/**
 * GET /api/public/clients
 *
 * The brokers' request table: one row per client, carrying the five things they
 * asked to be able to read at a glance — name, how many people, how many
 * bedrooms, when, where — plus the budget, which is what actually decides
 * whether a request is workable at all.
 *
 * It exists because the answer to "who was the one who wanted 3 bedrooms in
 * Umalas from November?" lived only in a WhatsApp scroll. amoCRM holds the
 * leads, but a broker has to open each card to see what the person wanted, so
 * a list of forty cards cannot be scanned. This is that list flattened.
 *
 * Nothing here is computed on request: every field was distilled once, when the
 * lead last wrote, by the profile pass in lib/lead-profile.ts. The endpoint is
 * a read, so opening the tab costs no AI and no amoCRM call.
 *
 * Query:
 *   responsibleUser  only this broker's clients (omit for everyone)
 *   pipeline         "Rental" | "Unicorn" — matched loosely, omit for both
 *   closed=1         include Closed - won/lost, which are hidden by default
 *   limit            default 200, max 500
 */
import { Router } from "express";
import { db, leadsSyncTable } from "@workspace/db";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { parseDialogContent } from "../../lib/dialog-parser";
import { cleanLeadName } from "../../lib/lead-display-name";

const router = Router();

export type ClientRow = {
  lead_id: string;
  name: string | null;
  pax: number | null;
  bedrooms: number | null;
  areas: string | null;
  move_in: string | null;
  stay: string | null;
  budget_idr_monthly: number | null;
  stage: string | null;
  pipeline: string | null;
  responsible_user: string | null;
  temperature: string | null;
  intent: string | null;
  last_message_at: string | null;
  /** null means this lead has not been through the profile pass yet — the row
   * is honestly empty rather than wrongly blank, and the UI says so. */
  req_updated_at: string | null;
};

router.options("/clients", (_req, res) => res.sendStatus(204));
router.get("/clients", async (req, res) => {
  const responsibleUser = String(req.query["responsibleUser"] ?? "").trim();
  const pipeline = String(req.query["pipeline"] ?? "").trim();
  const includeClosed = String(req.query["closed"] ?? "") === "1";
  const limit = Math.min(Math.max(parseInt(String(req.query["limit"] ?? "200"), 10) || 200, 1), 500);

  const where: SQL[] = [];
  if (responsibleUser) where.push(eq(leadsSyncTable.responsibleUser, responsibleUser));
  if (pipeline) where.push(sql`coalesce(${leadsSyncTable.pipeline}, '') ILIKE ${"%" + pipeline + "%"}`);
  // A closed deal is not a request anyone is working, so it is out of the way by
  // default — but never deleted from the view, because "who did we lose and what
  // did they want?" is a real question with its own toggle.
  if (!includeClosed) where.push(sql`coalesce(${leadsSyncTable.leadStage}, '') NOT ILIKE '%closed%'`);

  try {
    const rows = await db
      .select({
        leadId: leadsSyncTable.leadId,
        // Only the head of the transcript: the name is taken from the FIRST
        // message the lead sent, and pulling 400 full conversations out of the
        // database to read their opening line would move megabytes per refresh.
        content: sql<string>`left(${leadsSyncTable.content}, 6000)`,
        responsibleUser: leadsSyncTable.responsibleUser,
        leadStage: leadsSyncTable.leadStage,
        pipeline: leadsSyncTable.pipeline,
        lastMessageAt: leadsSyncTable.lastMessageAt,
        temperature: leadsSyncTable.profileTemperature,
        intent: leadsSyncTable.profileIntent,
        pax: leadsSyncTable.reqPax,
        bedrooms: leadsSyncTable.reqBedrooms,
        areas: leadsSyncTable.reqAreas,
        moveIn: leadsSyncTable.reqMoveIn,
        stay: leadsSyncTable.reqStay,
        budget: leadsSyncTable.reqBudgetIdrMonthly,
        reqUpdatedAt: leadsSyncTable.reqUpdatedAt,
      })
      .from(leadsSyncTable)
      .where(where.length > 0 ? and(...where) : undefined)
      // NULLS LAST, not plain DESC: Postgres sorts nulls first on a descending
      // order, which floated every lead that has never written a word to the top
      // of the table — the emptiest rows in the most valuable position.
      .orderBy(sql`${leadsSyncTable.lastMessageAt} DESC NULLS LAST`)
      .limit(limit);

    const items: ClientRow[] = rows.map((r) => {
      // The name lives in the transcript, not in a column — same derivation as
      // the inbox card and the daily report, through the shared helper, because
      // three private copies of this regex is how they drifted apart before.
      let name: string | null = null;
      if (r.content) {
        try {
          const dialog = parseDialogContent(r.content);
          const leadMsg = dialog.messages.find(
            (m) => m.from === "lead" && m.senderName && m.senderName.trim().length > 1,
          );
          name = cleanLeadName(leadMsg?.senderName);
        } catch {
          // a transcript we cannot parse still deserves its row
        }
      }
      return {
        lead_id: r.leadId,
        name,
        pax: r.pax ?? null,
        bedrooms: r.bedrooms ?? null,
        areas: r.areas ?? null,
        move_in: r.moveIn ?? null,
        stay: r.stay ?? null,
        budget_idr_monthly: r.budget ?? null,
        stage: r.leadStage ?? null,
        pipeline: r.pipeline ?? null,
        responsible_user: r.responsibleUser ?? null,
        temperature: r.temperature ?? null,
        intent: r.intent ?? null,
        last_message_at: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
        req_updated_at: r.reqUpdatedAt ? r.reqUpdatedAt.toISOString() : null,
      };
    });

    res.json({ items, count: items.length });
  } catch (err) {
    req.log.error({ err }, "clients table failed");
    res.status(500).json({ error: "DB error" });
  }
});

export default router;
