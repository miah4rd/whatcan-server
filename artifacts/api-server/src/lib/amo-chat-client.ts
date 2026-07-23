/**
 * amoCRM Chat API client with HMAC-SHA1 signing.
 * Used for direct chat integration (receiving messages, sending via Salesbot).
 */
import * as crypto from "crypto";
import { logger } from "./logger";

const AMOJO_BASE = "https://amojo.amocrm.ru";

const CHANNEL_ID = process.env.AMO_CHAT_CHANNEL_ID ?? "";
const CHANNEL_SECRET = process.env.AMO_CHAT_CHANNEL_SECRET ?? "";
const CHANNEL_BOT_ID = process.env.AMO_CHAT_BOT_ID ?? "";
const AMOJO_ACCOUNT_ID = process.env.AMO_CHAT_AMOJO_ID ?? "";

// ── HMAC-SHA1 signing ────────────────────────────────────────────────────────

function signRequest(
  method: string,
  body: string,
  contentType: string,
  date: string,
  path: string,
): { "Content-MD5": string; "X-Signature": string } {
  const md5 = crypto.createHash("md5").update(body).digest("hex").toLowerCase();
  const str = [method.toUpperCase(), md5, contentType, date, path].join("\n");
  const signature = crypto.createHmac("sha1", CHANNEL_SECRET).update(str).digest("hex").toLowerCase();
  return { "Content-MD5": md5, "X-Signature": signature };
}

function chatHeaders(method: string, body: string, path: string) {
  const date = new Date().toUTCString();
  const contentType = "application/json";
  const { "Content-MD5": md5, "X-Signature": sig } = signRequest(method, body, contentType, date, path);
  return {
    "Date": date,
    "Content-Type": contentType,
    "Content-MD5": md5,
    "X-Signature": sig,
  };
}

// ── Connect channel to account ────────────────────────────────────────────────

export async function connectChannel(): Promise<string | null> {
  if (!CHANNEL_ID || !CHANNEL_SECRET || !AMOJO_ACCOUNT_ID) {
    logger.error("amoChat: missing CHANNEL_ID, CHANNEL_SECRET, or AMOJO_ACCOUNT_ID");
    return null;
  }

  const path = `/v2/origin/custom/${CHANNEL_ID}/connect`;
  const body = JSON.stringify({
    account_id: AMOJO_ACCOUNT_ID,
    title: "whatcan-copilot",
    hook_api_version: "v2",
  });

  const headers = chatHeaders("POST", body, path);

  try {
    const res = await fetch(`${AMOJO_BASE}${path}`, {
      method: "POST",
      headers,
      body,
    });
    const data = await res.json() as { scope_id?: string; error?: string };
    if (data.scope_id) {
      logger.info({ scope_id: data.scope_id }, "amoChat: channel connected");
      return data.scope_id;
    }
    logger.error({ status: res.status, data }, "amoChat: connect failed");
    return null;
  } catch (err) {
    logger.error({ err }, "amoChat: connect error");
    return null;
  }
}

// ── Send message via Chat API ─────────────────────────────────────────────────

export async function sendChatMessage(
  scopeId: string,
  conversationId: string,
  text: string,
  messageId?: string,
): Promise<boolean> {
  const path = `/v2/origin/custom/${scopeId}`;
  const body = JSON.stringify({
    event_type: "new_message",
    payload: {
      timestamp: Math.floor(Date.now() / 1000),
      conversation_id: conversationId,
      sender: {
        id: CHANNEL_BOT_ID,
        name: "whatcan-copilot",
      },
      message: {
        type: "text",
        text,
      },
      ...(messageId ? { msgid: messageId } : {}),
    },
  });

  const headers = chatHeaders("POST", body, path);

  try {
    const res = await fetch(`${AMOJO_BASE}${path}`, {
      method: "POST",
      headers,
      body,
    });
    if (res.ok) {
      logger.info({ conversationId, text: text.slice(0, 80) }, "amoChat: message sent");
      return true;
    }
    const err = await res.text();
    logger.error({ status: res.status, err }, "amoChat: send failed");
    return false;
  } catch (err) {
    logger.error({ err }, "amoChat: send error");
    return false;
  }
}

// ── Get chat history ──────────────────────────────────────────────────────────

export async function getChatMessages(
  scopeId: string,
  chatId: string,
): Promise<Array<{ id: string; text: string; sender: { id: string; name: string }; created_at: number }> | null> {
  const path = `/v2/origin/custom/${scopeId}/chats/${chatId}/messages`;
  const body = "";
  const headers = chatHeaders("GET", body, path);

  try {
    const res = await fetch(`${AMOJO_BASE}${path}`, {
      method: "GET",
      headers,
    });
    if (!res.ok) {
      logger.error({ status: res.status }, "amoChat: getMessages failed");
      return null;
    }
    const data = await res.json() as { _embedded?: { messages: Array<{ id: string; text: string; sender: { id: string; name: string }; created_at: number }> } };
    return data._embedded?.messages ?? [];
  } catch (err) {
    logger.error({ err }, "amoChat: getMessages error");
    return null;
  }
}

// ── Trigger Salesbot on lead ──────────────────────────────────────────────────

export async function triggerSalesbot(leadId: string, botId: number): Promise<boolean> {
  const AMO_BASE = `https://${process.env.AMO_SUBDOMAIN ?? "unicornproperty"}.amocrm.ru`;
  const token = process.env.AMOCRM_LONG_LIVED_TOKEN ?? "";

  try {
    const res = await fetch(`${AMO_BASE}/api/v4/bots/${botId}/run`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entity_id: Number(leadId),
        entity_type: "leads",
      }),
    });
    if (res.ok || res.status === 202) {
      logger.info({ leadId, botId }, "amoChat: Salesbot triggered");
      return true;
    }
    const err = await res.text();
    logger.error({ status: res.status, err }, "amoChat: Salesbot trigger failed");
    return false;
  } catch (err) {
    logger.error({ err }, "amoChat: Salesbot trigger error");
    return false;
  }
}

// ── Update lead custom field ──────────────────────────────────────────────────

export async function updateLeadCustomField(
  leadId: string,
  fieldId: number,
  value: string,
): Promise<boolean> {
  const AMO_BASE = `https://${process.env.AMO_SUBDOMAIN ?? "unicornproperty"}.amocrm.ru`;
  const token = process.env.AMOCRM_LONG_LIVED_TOKEN ?? "";

  try {
    const res = await fetch(`${AMO_BASE}/api/v4/leads/${leadId}`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        custom_fields_values: [
          {
            field_id: fieldId,
            values: [{ value }],
          },
        ],
      }),
    });
    if (res.ok) {
      logger.info({ leadId, fieldId }, "amoChat: custom field updated");
      return true;
    }
    const err = await res.text();
    logger.error({ status: res.status, err }, "amoChat: custom field update failed");
    return false;
  } catch (err) {
    logger.error({ err }, "amoChat: custom field update error");
    return false;
  }
}

// ── Get lead custom fields ────────────────────────────────────────────────────

export async function getLeadCustomFields(
  leadId: string,
): Promise<Array<{ field_id: number; field_name: string; values: Array<{ value: string }> }> | null> {
  const AMO_BASE = `https://${process.env.AMO_SUBDOMAIN ?? "unicornproperty"}.amocrm.ru`;
  const token = process.env.AMOCRM_LONG_LIVED_TOKEN ?? "";

  try {
    const res = await fetch(`${AMO_BASE}/api/v4/leads/${leadId}?with=custom_fields`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) return null;
    const data = await res.json() as { custom_fields_values?: Array<{ field_id: number; field_name: string; values: Array<{ value: string }> }> };
    return data.custom_fields_values ?? null;
  } catch (err) {
    logger.error({ err }, "amoChat: getLeadCustomFields error");
    return null;
  }
}

// ── Constants export ──────────────────────────────────────────────────────────

export const CHAT_CONSTANTS = {
  CHANNEL_ID,
  CHANNEL_SECRET,
  CHANNEL_BOT_ID,
  AMOJO_ACCOUNT_ID,
  AMOJO_BASE,
};
