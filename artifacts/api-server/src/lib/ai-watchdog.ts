import { logger } from "./logger";
import { aiHealth, logAiHealth, outageHeadline, type AiHealth } from "./ai-health";
import { brokersWithPush, sendPushToBroker } from "./push-notifications";

/**
 * Tells someone when the model stops answering.
 *
 * The rule this exists under is already written down for notifications: a
 * notification that reached nobody is not a notification. So this has both
 * halves — a delivery that knows whether it landed, and a surface that works
 * when it did not. The surface is GET /api/public/ai-health plus a log line
 * loud enough to grep for; `announced` below records whether any device
 * actually took the push, so "we alerted" can never be assumed.
 */

/** How often to look. Cheap: it reads counters held in memory. */
const CHECK_MS = 2 * 60 * 1000;
/** While an outage continues, remind at most this often. */
const RENOTIFY_MS = 60 * 60 * 1000;

type Incident = {
  since: number;
  lastNotifiedAt: number | null;
  /** Devices that took the most recent alert. 0 means nobody heard it. */
  lastDelivered: number;
  announced: boolean;
};

let incident: Incident | null = null;
let handle: ReturnType<typeof setInterval> | null = null;

export function currentIncident(): (Incident & { minutes: number }) | null {
  if (!incident) return null;
  return { ...incident, minutes: Math.round((Date.now() - incident.since) / 60000) };
}

/**
 * Who to wake. An empty API balance is the owner's job, not the brokers' — a
 * rental agent told to "add funds in the Anthropic Console" gets an alarm she
 * cannot act on, and an alarm you cannot act on is the fastest way to teach
 * people to ignore alarms. Overridable so it survives a rename.
 */
const ALERT_BROKERS = (process.env["AI_ALERT_BROKERS"] ?? "HoS,Admin")
  .split(",")
  .map((b) => b.trim().toLowerCase())
  .filter(Boolean);

async function alertRecipients(): Promise<Set<string>> {
  const subscribed = await brokersWithPush();
  const targeted = new Set([...subscribed].filter((b) => ALERT_BROKERS.includes(b)));
  // If none of the named people are reachable, tell everyone rather than
  // nobody. A noisy alert beats an outage that stays invisible — which is the
  // whole failure this module exists for.
  if (targeted.size === 0 && subscribed.size > 0) {
    logger.warn(
      { alertBrokers: ALERT_BROKERS, subscribed: [...subscribed] },
      "AI watchdog: no configured alert recipient has push — falling back to every subscribed broker",
    );
    return subscribed;
  }
  return targeted;
}

async function alertEveryone(title: string, body: string): Promise<number> {
  const brokers = await alertRecipients();
  if (brokers.size === 0) {
    logger.error({ title, body }, "AI watchdog: nobody has a push subscription — alert reached NO ONE");
    return 0;
  }
  let delivered = 0;
  for (const brokerId of brokers) {
    try {
      delivered += await sendPushToBroker(brokerId, { title, body: body.slice(0, 150), url: "/m" });
    } catch (err) {
      logger.error({ err, brokerId }, "AI watchdog: push failed for one broker");
    }
  }
  if (delivered === 0) {
    logger.error({ title, body, brokers: brokers.size }, "AI watchdog: alert was delivered to ZERO devices");
  }
  return delivered;
}

export async function checkAiHealth(now = Date.now()): Promise<AiHealth> {
  const health = aiHealth();

  if (health.outage) {
    if (!incident) {
      incident = { since: now, lastNotifiedAt: null, lastDelivered: 0, announced: false };
      logAiHealth(health);
    }
    const due = incident.lastNotifiedAt === null || now - incident.lastNotifiedAt >= RENOTIFY_MS;
    if (due) {
      const { title, body } = outageHeadline(health);
      const delivered = await alertEveryone(title, body);
      incident.lastNotifiedAt = now;
      incident.lastDelivered = delivered;
      incident.announced = incident.announced || delivered > 0;
    }
    return health;
  }

  // Recovered. Say so — an alert with no all-clear leaves the owner checking by
  // hand, and only tell the people who were told it broke.
  if (incident) {
    const downMinutes = Math.max(1, Math.round((now - incident.since) / 60000));
    const wasAnnounced = incident.announced;
    incident = null;
    logger.info({ downMinutes }, "AI recovered — model calls are succeeding again");
    if (wasAnnounced) {
      await alertEveryone(
        "Copilot is back",
        `The model is answering again after ${downMinutes} min. Drafts are being generated as normal.`,
      );
    }
  }
  return health;
}

/**
 * Fire the real alert on demand, so the delivery path is proven before an
 * outage needs it. Deliberately uses the same alertEveryone() the watchdog
 * uses — a test that takes a different route proves nothing.
 */
export async function testAiOutageAlert(): Promise<{ recipients: string[]; delivered: number }> {
  const recipients = [...(await alertRecipients())];
  const delivered = await alertEveryone(
    "Copilot alert test",
    "This is a test of the outage alarm. If you can read this, you will be told when the bot stops answering.",
  );
  logger.info({ recipients, delivered }, "AI watchdog: test alert sent");
  return { recipients, delivered };
}

export function startAiWatchdog(intervalMs = CHECK_MS): void {
  if (handle) return;
  handle = setInterval(() => {
    checkAiHealth().catch((err) => logger.error({ err }, "checkAiHealth crashed"));
  }, intervalMs);
}

export function stopAiWatchdog(): void {
  if (handle) clearInterval(handle);
  handle = null;
}
