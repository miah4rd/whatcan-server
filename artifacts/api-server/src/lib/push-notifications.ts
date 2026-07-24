import webpush from "web-push";
import { db, pushSubscriptionsTable, pendingSuggestionsTable, leadsSyncTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "./logger";
import { parseDialogContent } from "./dialog-parser";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:info@unicorn-property.com";

let configured = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    logger.warn("push-notifications: VAPID keys not set — push disabled");
    return false;
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}

/**
 * Sends a push notification to every device this broker has subscribed on.
 * Fire-and-forget — never throws, never blocks the caller. Prunes
 * subscriptions the browser/OS has permanently invalidated (410/404).
 */
export async function sendPushToBroker(
  brokerId: string,
  payload: { title: string; body: string; url?: string; badge?: number },
): Promise<void> {
  if (!ensureConfigured()) return;
  const normalizedId = brokerId.trim().toLowerCase();
  if (!normalizedId) return;

  try {
    const subs = await db
      .select()
      .from(pushSubscriptionsTable)
      .where(eq(pushSubscriptionsTable.brokerId, normalizedId));

    if (subs.length === 0) return;

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url ?? "/m",
      badge: payload.badge,
    });

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
          );
        } catch (err) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.id, sub.id)).catch(() => {});
          } else {
            logger.error({ err, brokerId: normalizedId }, "push-notifications: send failed");
          }
        }
      }),
    );
  } catch (err) {
    logger.error({ err, brokerId }, "sendPushToBroker failed (non-fatal)");
  }
}

/** Counts this broker's current pending suggestions, for the app-icon badge number. */
async function countPendingForBroker(brokerId: string): Promise<number> {
  try {
    const rows = await db
      .select({ id: pendingSuggestionsTable.id })
      .from(pendingSuggestionsTable)
      .where(and(eq(pendingSuggestionsTable.responsibleUser, brokerId), eq(pendingSuggestionsTable.status, "pending")));
    return rows.length;
  } catch {
    return 0;
  }
}

/** Notify a broker that a lead just replied (LIVE) or a new lead was assigned. */
export async function notifyBroker(brokerId: string | null, title: string, body: string): Promise<void> {
  if (!brokerId) return;
  const badge = await countPendingForBroker(brokerId);
  await sendPushToBroker(brokerId, { title, body: body.slice(0, 150), url: "/m", badge });
}

// Same "Name (client - source)" → "Name" cleanup used for the inbox list's card title.
function extractLeadName(content: string | null | undefined): string | null {
  if (!content) return null;
  try {
    const dialog = parseDialogContent(content);
    const leadMsg = dialog.messages.find((m) => m.from === "lead" && m.senderName && m.senderName.trim().length > 1);
    if (!leadMsg?.senderName) return null;
    return leadMsg.senderName.replace(/\s*\([^)]*\)\s*$/, "").trim() || leadMsg.senderName;
  } catch {
    return null;
  }
}

/**
 * Notify a broker about a specific lead, mirroring the inbox card's title:
 * "<lead name> #<leadId> · <stage>". Pass `hint` with fields already in hand
 * (from a leadsSyncTable row you already fetched) to skip the extra DB read.
 */
export async function notifyBrokerForLead(
  brokerId: string | null,
  leadId: string,
  action: "replied" | "assigned",
  body: string,
  hint?: { content?: string | null; leadStage?: string | null; leadName?: string | null },
): Promise<void> {
  if (!brokerId) return;

  let content = hint?.content;
  let stage = hint?.leadStage ?? null;
  if (content === undefined) {
    try {
      const [sync] = await db.select().from(leadsSyncTable).where(eq(leadsSyncTable.leadId, leadId)).limit(1);
      content = sync?.content ?? null;
      stage = stage ?? sync?.leadStage ?? null;
    } catch {
      content = null;
    }
  }

  const name = hint?.leadName ?? extractLeadName(content);
  const label = name ? `${name} #${leadId}` : `Lead #${leadId}`;
  const icon = action === "replied" ? "\u{1F4AC}" : "\u{1F195}";
  const title = stage ? `${icon} ${label} · ${stage}` : `${icon} ${label}`;

  await notifyBroker(brokerId, title, body);
}
