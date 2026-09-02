/**
 * Lists the custom fields amoCRM has on LEAD cards, with their ids.
 *
 * Why this is a route and not a one-off script: every field we write back to a
 * card is addressed by a hardcoded numeric id (see amo-request-fields.ts), and
 * those ids are invisible from anywhere else in this system — `amo_deals`
 * stores a `custom_fields` column that has never been populated, so the only
 * source of truth is amoCRM itself. Without this, adding a field means reading
 * ids out of the amoCRM UI by hand and hoping they were typed correctly.
 *
 * Read-only on purpose. Creating a field changes the owner's live CRM for every
 * user of it; that stays a deliberate, separate act.
 */
import { Router } from "express";
import { amoFetch } from "../../lib/amo-client";

const router = Router();

type AmoField = {
  id: number;
  name: string;
  type: string;
  enums?: Array<{ id: number; value: string }> | null;
};

router.get("/admin/lead-fields", async (req, res) => {
  const filter = String(req.query["q"] ?? "").toLowerCase();
  const data = await amoFetch<{ _embedded?: { custom_fields?: AmoField[] } }>(
    "/api/v4/leads/custom_fields?limit=250",
  );
  if (!data) {
    res.status(502).json({ error: "amoCRM unreachable or not authorised" });
    return;
  }
  const all = data._embedded?.custom_fields ?? [];
  const fields = all
    .filter((f) => !filter || f.name.toLowerCase().includes(filter))
    .map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      ...(f.enums?.length ? { options: f.enums.map((e) => e.value) } : {}),
    }));
  res.json({ total: all.length, shown: fields.length, fields });
});

export default router;
