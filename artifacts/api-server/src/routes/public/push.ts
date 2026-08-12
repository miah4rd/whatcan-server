import { Router } from "express";
import { db, pushSubscriptionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getVapidPublicKey, brokersWithPush } from "../../lib/push-notifications";
import { reportableBrokers } from "../../lib/daily-report";

const router = Router();

router.options("/push/vapid-public-key", (_req, res) => res.sendStatus(204));
router.get("/push/vapid-public-key", (_req, res) => {
  res.json({ key: getVapidPublicKey() });
});

/**
 * Who is actually reachable, and who is dark.
 *
 * Enrolment happens on each broker's own device (a browser will not hand out a
 * push subscription any other way), so the one thing that must NOT be optional
 * is knowing who never enrolled. Anyone with live leads and no subscription is
 * working blind: no reply alert, no morning report, nothing.
 */
router.options("/push/coverage", (_req, res) => res.sendStatus(204));
router.get("/push/coverage", async (req, res) => {
  try {
    const [brokers, covered] = await Promise.all([reportableBrokers(null), brokersWithPush()]);
    const rows = brokers.map((b) => ({ broker: b, enabled: covered.has(b.trim().toLowerCase()) }));
    res.json({
      brokers: rows,
      missing: rows.filter((r) => !r.enabled).map((r) => r.broker),
    });
  } catch (err) {
    req.log.error({ err }, "push coverage failed");
    res.status(500).json({ error: "DB error" });
  }
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
