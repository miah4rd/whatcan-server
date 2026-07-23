/**
 * Send message through amoCRM Chat API + Salesbot.
 * 
 * Flow:
 * 1. Save message text to custom field "companion_message" on the lead
 * 2. Trigger Salesbot (e.g. "Companion Robert") which reads the field and sends via WhatsApp
 * 
 * POST /api/public/send-chat-message
 * Body: { leadId: string, message: string, salesbotId?: number }
 */
import { Router } from "express";
import { updateLeadCustomField, triggerSalesbot } from "../../lib/amo-chat-client";
import { logger } from "../../lib/logger";

const router = Router();

const SALESBOT_MAP: Record<string, number> = {
  robert: 22127,
  hos: 22247,
  amelia: 22249,
  companion: 22129,
};

const COMPANION_FIELD_ID = 965907;

router.post("/public/send-chat-message", async (req, res) => {
  try {
    const { leadId, message, salesbotId, broker } = req.body;

    if (!leadId || !message) {
      res.status(400).json({ error: "leadId and message are required" });
      return;
    }

    const botId = salesbotId ?? SALESBOT_MAP[broker?.toLowerCase()] ?? SALESBOT_MAP.companion;

    const fieldUpdated = await updateLeadCustomField(leadId, COMPANION_FIELD_ID, message);
    if (!fieldUpdated) {
      res.status(500).json({ error: "Failed to update custom field" });
      return;
    }

    const botTriggered = await triggerSalesbot(leadId, botId);
    if (!botTriggered) {
      res.status(500).json({ error: "Failed to trigger Salesbot" });
      return;
    }

    logger.info({ leadId, botId, message: message.slice(0, 100) }, "amoChat: message sent via Salesbot");
    res.json({ ok: true, leadId, botId });
  } catch (err) {
    logger.error({ err }, "amoChat: send-chat-message error");
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/public/chat-salesbots", (_req, res) => {
  res.json({
    salesbots: Object.entries(SALESBOT_MAP).map(([name, id]) => ({ name, id })),
    fieldId: COMPANION_FIELD_ID,
  });
});

export default router;
