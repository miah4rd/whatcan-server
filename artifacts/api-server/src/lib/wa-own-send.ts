/**
 * Copilot's send on one of our own lines (wa-own-line-ids.ts) — Yudi 2 since
 * 19.09.2026. The Wahelp lines go through the amoCRM field + Salesbot 22127;
 * these go straight out through wa-gateway, and the message is then written
 * into the card's chat (mirrorOwnSend) so amoCRM, the broker and every
 * timeline reader see it exactly like a Salesbot send.
 *
 * The result has the same shape as deliverText's, so approve, autopilot and the
 * delivery record need no second code path above this one.
 */
import { pool } from "@workspace/db";
import { amoFetch } from "./amo-client";
import { logger } from "./logger";
import { gateway, mirrorOwnSend } from "./wa-bridge";
import { ownLineSession } from "./wa-own-line-ids";

type Contact = { contactId: number; phone: string; name: string };

async function leadContactFull(leadId: string): Promise<Contact | null> {
  const lead = await amoFetch<{ _embedded?: { contacts?: Array<{ id: number; is_main?: boolean }> } }>(
    `/api/v4/leads/${leadId}?with=contacts`,
  );
  const contacts = lead?._embedded?.contacts ?? [];
  const main = contacts.find((c) => c.is_main) ?? contacts[0];
  if (!main) return null;
  const c = await amoFetch<{ name?: string; custom_fields_values?: Array<{ field_code?: string; values?: Array<{ value?: string }> }> }>(
    `/api/v4/contacts/${main.id}`,
  );
  const raw = (c?.custom_fields_values ?? []).find((f) => f.field_code === "PHONE")?.values?.[0]?.value ?? "";
  const phone = raw.replace(/\D+/g, "");
  if (phone.length < 8) return null;
  return { contactId: main.id, phone, name: String(c?.name ?? "").trim() };
}

export type OwnSendResult = { chatSent: boolean; hookStatus: number; hookBody: string; notOnWhatsapp: boolean };

/**
 * Send one message (text, or a single link) to the lead's contact from the
 * line `source`. A send is `chatSent` only when WhatsApp took it; the mirror
 * into amoCRM failing afterwards is logged, not turned into a failure — the
 * client already has the message and a retry would send it twice.
 */
export async function deliverViaOwnLine(leadId: string, source: string, text: string): Promise<OwnSendResult> {
  const session = ownLineSession(source);
  if (!session) return { chatSent: false, hookStatus: 500, hookBody: `unknown own line ${source}`, notOnWhatsapp: false };
  const contact = await leadContactFull(leadId);
  if (!contact) return { chatSent: false, hookStatus: 422, hookBody: "own line: no phone on the lead's contact", notOnWhatsapp: false };

  let r: { status: number; data: any };
  try {
    r = await gateway("POST", "/send", { session, to: contact.phone, text });
  } catch (err) {
    r = { status: 503, data: { ok: false, error: String(err) } };
  }
  const waId: string | null = r.data?.ok ? r.data.id : null;
  await pool.query(
    `INSERT INTO wa_messages (session, wa_id, direction, phone, type, text, status, error, card_lead_id)
     VALUES ($1, $2, 'out_copilot', $3, 'text', $4, $5, $6, $7)
     ON CONFLICT (session, wa_id) WHERE wa_id IS NOT NULL DO NOTHING`,
    [session, waId, contact.phone, text, waId ? "sent" : "error", waId ? null : String(r.data?.error ?? r.status), Number(leadId)],
  ).catch(() => null);

  if (!waId) {
    const notOn = r.data?.error === "not_on_whatsapp";
    return {
      chatSent: false,
      hookStatus: notOn ? 404 : r.status >= 400 ? r.status : 500,
      hookBody: notOn ? `${session}: WhatsApp is not installed on this number` : `${session}: not sent (${r.data?.error ?? r.status})`,
      notOnWhatsapp: notOn,
    };
  }

  const mirror = await mirrorOwnSend(session, contact.phone, contact.contactId, contact.name, waId, { type: "text", text }).catch(
    (err) => ({ ok: false, amoMsgId: null, error: String(err) }),
  );
  if (mirror.ok) {
    await pool.query(`UPDATE wa_messages SET mirrored = true, amo_msg_id = $3 WHERE session = $1 AND wa_id = $2`, [session, waId, mirror.amoMsgId]).catch(() => null);
  } else {
    logger.error({ leadId, session, error: mirror.error }, "own line: sent to WhatsApp but not written into the amoCRM chat");
  }
  logger.info({ leadId, session, mirrored: mirror.ok }, "own line: message sent");
  return { chatSent: true, hookStatus: 200, hookBody: `${session} (own line) sent ${waId}${mirror.ok ? "" : " — NOT in amoCRM chat"}`, notOnWhatsapp: false };
}
