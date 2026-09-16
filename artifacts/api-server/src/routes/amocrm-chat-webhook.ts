/**
 * amoCRM Chats API hook: a broker (or Salesbot) sent a message in a chat of our
 * own WhatsApp channel. Registered URL: /api/amocrm/chats/:scope_id
 *
 * amoCRM sends this hook once, never retries, and gives up quickly — so the
 * signature is checked, 200 goes back at once, and the WhatsApp send plus the
 * delivery status run in the background (lib/wa-bridge.ts).
 */
import { Router } from "express";
import { logger } from "../lib/logger";
import { handleAmoOutgoing, verifyAmojoHook } from "../lib/wa-bridge";

const router = Router();

router.post("/amocrm/chats/:scopeId", (req, res) => {
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!verifyAmojoHook(raw, req.headers["x-signature"] as string | undefined, req.headers, req.originalUrl.split("?")[0].replace(/^\/api/, ""))) {
    logger.warn({ scopeId: req.params.scopeId }, "amoChat hook: invalid signature");
    res.status(403).json({ error: "invalid signature" });
    return;
  }
  res.status(200).json({ ok: true });
  handleAmoOutgoing(req.body).catch((err) =>
    logger.error({ err, msgId: req.body?.message?.message?.id }, "amoChat hook: send to WhatsApp failed"),
  );
});

export default router;
