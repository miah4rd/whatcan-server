import { Router } from "express";
import { db, pushSubscriptionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getVapidPublicKey } from "../../lib/push-notifications";

const router = Router();

router.options("/push/vapid-public-key", (_req, res) => res.sendStatus(204));
router.get("/push/vapid-public-key", (_req, res) => {
  res.json({ key: getVapidPublicKey() });
});

router.options("/push/subscribe", (_req, res) => res.sendStatus(204));
router.post("/push/subscribe", async (req, res) => {
  const body = req.body as {
    brokerId?: string;
    subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  };
  const brokerId = body.brokerId?.trim().toLowerCase();
  const endpoint = body.subscription?.endpoint;
  const p256dh = body.subscription?.keys?.p256dh;
  const auth = body.subscription?.keys?.auth;

  if (!brokerId || !endpoint || !p256dh || !auth) {
    res.status(400).json({ error: "brokerId and subscription.{endpoint,keys.p256dh,keys.auth} are required" });
    return;
  }

  try {
    await db
      .insert(pushSubscriptionsTable)
      .values({ brokerId, endpoint, p256dh, auth })
      .onConflictDoUpdate({
        target: pushSubscriptionsTable.endpoint,
        set: { brokerId, p256dh, auth },
      });
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "push subscribe failed");
    res.status(500).json({ error: "DB error" });
  }
});

router.options("/push/unsubscribe", (_req, res) => res.sendStatus(204));
router.post("/push/unsubscribe", async (req, res) => {
  const { endpoint } = req.body as { endpoint?: string };
  if (!endpoint) {
    res.status(400).json({ error: "endpoint required" });
    return;
  }
  try {
    await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.endpoint, endpoint));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "push unsubscribe failed");
    res.status(500).json({ error: "DB error" });
  }
});

export default router;
