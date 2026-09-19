/**
 * Is this Rental card the villa's side (owner, manager, staff) rather than a client?
 *
 * To book a viewing the broker writes to the villa from her phone, and amoCRM opens a Rental card on the
 * reply. On 18.09 one viewing of R-YUD-042 became three: the client's card, the owner Gabriel's card
 * (his number is the listing's owner_phone in Internal data) and his staff member Rani's card (a number
 * Gabriel sent as a contact in his own thread). Each got a viewing slot, a "Fill the viewing report" task
 * and a place in the viewing count. generate-suggestion.ts `isVillaSideContact` already knew Gabriel
 * (it keeps the viewing push off his card); the slot writer never asked.
 *
 * A card is the villa's side when its phone is
 * - an owner_phone in the site's Internal data, or
 * - a number the villa side itself sent in a thread: a Rental Listings card, or a Rental card that is
 *   itself the villa's side by Internal data.
 * An unreadable phone means "not the villa" — a real client never loses a report over a failed read.
 */
import { pool } from "@workspace/db";
import { leadPhone } from "./phone-dedupe";
import { villaContactPhoneKeys, phoneKey } from "./property-flags";
import { logger } from "./logger";

const cache = new Map<string, { at: number; ttl: number; villa: boolean; why: string }>();

async function ownerPhoneMatch(leadId: string, keys: Set<string>): Promise<boolean> {
  const k = phoneKey(await leadPhone(leadId).catch(() => ""));
  return Boolean(k && keys.has(k));
}

export async function villaSideCard(leadId: string | null | undefined): Promise<{ villa: boolean; why: string }> {
  const id = String(leadId ?? "").trim();
  if (!id) return { villa: false, why: "no card" };
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < hit.ttl) return { villa: hit.villa, why: hit.why };
  const remember = (villa: boolean, why: string, ttl = 6 * 3_600_000) => {
    cache.set(id, { at: Date.now(), ttl, villa, why });
    return { villa, why };
  };
  try {
    const [phone, keys] = await Promise.all([leadPhone(id).catch(() => ""), villaContactPhoneKeys()]);
    const k = phoneKey(phone);
    if (!k) return remember(false, "phone unreadable", 10 * 60_000);
    if (keys.has(k)) return remember(true, "owner phone in Internal data");
    const r = await pool.query(
      `SELECT DISTINCT m.lead_id, l.pipeline
         FROM lead_messages m LEFT JOIN leads_sync l ON l.lead_id = m.lead_id
        WHERE m.sender_type = 'lead' AND m.lead_id <> $1
          AND m.sent_at > now() - interval '180 days'
          AND regexp_replace(coalesce(m.text, ''), '[^0-9]', '', 'g') LIKE '%' || $2 || '%'
        LIMIT 20`,
      [id, k],
    );
    for (const row of r.rows as { lead_id: string; pipeline: string | null }[]) {
      if (row.pipeline === "Rental Listings") return remember(true, `number sent by the villa side on listing card ${row.lead_id}`);
      if (await ownerPhoneMatch(String(row.lead_id), keys)) return remember(true, `number sent by the villa owner on card ${row.lead_id}`);
    }
    return remember(false, "not a villa contact");
  } catch (err) {
    logger.warn({ err, leadId: id }, "villa-side check failed — treated as a client");
    return remember(false, "check failed", 10 * 60_000);
  }
}
