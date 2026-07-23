/**
 * Webhook handler for amoCRM Chat API incoming messages.
 * Receives messages from the registered channel (whatcan-copilot).
 * 
 * Webhook URL: https://copilot.globalapplab.ru/api/amocrm/chats/:scope_id
 * 
 * Flow:
 * 1. Receive incoming message from Chat API
 * 2. Parse sender/conversation info
 * 3. Store in lead_messages table
 * 4. Trigger AI suggestion generation (optional)
 */
import { Router } from "express";
import * as crypto from "crypto";
import { db, leadMessagesTable, leadsSyncTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { CHAT_CONSTANTS } from "../lib/amo-chat-client";

const router = Router();

// ── Verify HMAC-SHA1 signature ───────────────────────────────────────────────

function verifySignature(req: any): boolean {
  const date = req.headers["date"] ?? "";
  const contentType = req.headers["content-type"] ?? "application/json";
  const md5Header = req.headers["content-md5"] ?? "";
  const signature = req.headers["x-signature"] ?? "";

  if (!date || !signature) return false;

  const body = JSON.stringify(req.body);
  const md5 = crypto.createHash("md5").update(body).digest("hex").toLowerCase();

  const path = req.path;
  const str = ["POST", md5, contentType, date, path].join("\n");
  const expected = crypto.createHmac("sha1", CHAT_CONSTANTS.CHANNEL_SECRET).update(str).digest("hex").toLowerCase();

  return signature === expected;
}

// ── Chat webhook endpoint ─────────────────────────────────────────────────────

router.post("/amocrm/chats/:scopeId", async (req, res) => {
  try {
    if (!verifySignature(req)) {
      logger.warn("amoChat webhook: invalid signature");
      res.status(403).json({ error: "Invalid signature" });
      return;
    }

    const { scopeId } = req.params;
    const payload = req.body?.payload;

    if (!payload) {
      res.status(200).json({ ok: true });
      return;
    }

    const eventType = req.body?.event_type ?? "unknown";

    logger.info({
      scopeId,
      eventType,
      conversationId: payload?.conversation_id,
      senderId: payload?.sender?.id,
    }, "amoChat webhook received");

    if (eventType === "new_message" && payload?.message) {
      const msg = payload.message;
      const sender = payload.sender ?? {};
      const conversationId = payload.conversation_id ?? "";

      const messageData = {
        leadId: 0,
        amoMessageId: `chat_${conversationId}_${payload.timestamp}_${Date.now()}`,
        senderType: sender.is_bot ? "bot" : "client",
        senderName: sender.name ?? "Unknown",
        senderId: sender.id ?? "",
        text: msg.text ?? "",
        channel: "amo-chat",
        direction: sender.is_bot ? "outgoing" as const : "incoming" as const,
        sentAt: new Date((payload.timestamp ?? Math.floor(Date.now() / 1000)) * 1000),
      };

      try {
        await db.insert(leadMessagesTable).values(messageData).onConflictDoNothing();
        logger.info({
          conversationId,
          senderName: messageData.senderName,
          text: messageData.text.slice(0, 100),
        }, "amoChat: message stored");
      } catch (err) {
        logger.error({ err }, "amoChat: failed to store message");
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err }, "amoChat webhook error");
    res.status(200).json({ ok: true });
  }
});

router.get("/debug/chat-webhook", (_req, res) => {
  res.json({
    status: "ok",
    channelId: CHAT_CONSTANTS.CHANNEL_ID,
    botId: CHAT_CONSTANTS.CHANNEL_BOT_ID,
    amojoId: CHAT_CONSTANTS.AMOJO_ACCOUNT_ID,
    message: "Chat webhook endpoint is active",
  });
});

export default router;
