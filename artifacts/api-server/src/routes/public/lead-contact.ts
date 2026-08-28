/**
 * Who the client is and how to reach them, for the card header.
 *
 * The broker had to open amoCRM in another tab for one thing: the phone number.
 * It is not in our database and cannot easily be — amoCRM keeps it on the
 * CONTACT, and amo_contacts has never had a row written to it — so this reads
 * it live.
 *
 * Cached per lead, because it costs TWO amoCRM calls and the inbox reopens the
 * same cards all day. A phone number does not change while a broker is looking
 * at it; ten minutes is far shorter than the gap that would matter.
 */
import { Router } from "express";
import { leadContact } from "../../lib/phone-dedupe";

const router = Router();

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: Awaited<ReturnType<typeof leadContact>> }>();

router.get("/lead-contact", async (req, res) => {
  const leadId = String(req.query["leadId"] ?? "").trim();
  if (!/^\d+$/.test(leadId)) {
    res.status(400).json({ error: "leadId required" });
    return;
  }

  const hit = cache.get(leadId);
  if (hit && Date.now() - hit.at < TTL_MS) {
    res.json(hit.value);
    return;
  }

  const value = await leadContact(leadId);
  // A failed lookup is NOT cached: amoCRM hiccuping once must not blank the
  // number in the header for the next ten minutes.
  if (value.phone || value.name) {
    cache.set(leadId, { at: Date.now(), value });
    // The map is process-lifetime; a few thousand leads is nothing, but an
    // unbounded map on a long-running process is how slow leaks start.
    if (cache.size > 5000) {
      for (const [k, v] of cache) if (Date.now() - v.at > TTL_MS) cache.delete(k);
    }
  }
  res.json(value);
});

export default router;
