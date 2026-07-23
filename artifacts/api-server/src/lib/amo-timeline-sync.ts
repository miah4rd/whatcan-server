/**
 * Fetches chat messages from amoCRM via internal /ajax/v3/leads/{id}/events_timeline/
 * endpoint. Uses Puppeteer to login and extract access_token cookie, then makes
 * direct HTTP requests with that cookie.
 *
 * Types 89 = incoming message from client
 * Types 90 = outgoing message (bot/broker)
 */
import { db, leadMessagesTable, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, and, sql, isNotNull, not } from "drizzle-orm";
import { createHash } from "crypto";
import { logger } from "./logger";
import { generateSuggestion } from "./generate-suggestion.js";

const AMO_SUBDOMAIN = process.env.AMO_SUBDOMAIN ?? "unicornproperty";
const AMO_BASE = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
const LOGIN = process.env.AMO_LOGIN ?? "unicorn.properties.office@gmail.com";
const PASSWORD = process.env.AMO_PASSWORD ?? "UnicornProperty00!";
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH ?? undefined;

// ── Deterministic message ID ───────────────────────────────────────────────────
function messageId(leadId: string, eventTs: number, authorId: string, text: string): string {
  const payload = `${leadId}|${eventTs}|${authorId}|${text.slice(0, 200)}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

// ── Cookie cache ───────────────────────────────────────────────────────────────
let cachedCookies: { cookieStr: string; expiresAt: number } | null = null;

/**
 * Login via Puppeteer and extract access_token + other cookies.
 * The access_token cookie is used for direct HTTP requests to /ajax/ endpoints.
 */
async function getAmoCookies(): Promise<string | null> {
  // Return cached if still valid (with 5 min buffer)
  if (cachedCookies && cachedCookies.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedCookies.cookieStr;
  }

  let puppeteerCore: any;
  try {
    puppeteerCore = await import("puppeteer-core");
  } catch {
    logger.error("puppeteer-core not installed — run: pnpm add -w puppeteer-core");
    return null;
  }

  const chromePath = CHROME_PATH || "/root/.cache/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome";
  const browser = await puppeteerCore.default.launch({
    headless: true,
    executablePath: chromePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();

    // Login
    await page.goto(AMO_BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
    const loginInput = await page.$('input[name="login"], input[type="email"], input[type="text"]');
    const passInput = await page.$('input[name="password"], input[type="password"]');
    if (loginInput && passInput) {
      await loginInput.click({ clickCount: 3 });
      await loginInput.type(LOGIN, { delay: 15 });
      await passInput.click({ clickCount: 3 });
      await passInput.type(PASSWORD, { delay: 15 });
      const btn = await page.$('button[type="submit"], input[type="submit"]');
      if (btn) await btn.click();
      else await page.keyboard.press("Enter");
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    }

    // Navigate to a lead page to ensure session is fully established
    await page.goto(AMO_BASE + "/leads/detail/22609833", { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 5000));

    // Extract cookies
    const cookies = await page.cookies();
    const cookieStr = cookies.map((c) => c.name + "=" + c.value).join("; ");

    // Find access_token expiry from cookie
    const accessTokenCookie = cookies.find((c) => c.name === "access_token");
    const expiresAtCookie = cookies.find((c) => c.name === "access_token_expires_at");
    const expiresAt = expiresAtCookie ? parseInt(expiresAtCookie.value, 10) * 1000 : Date.now() + 3600 * 1000;

    if (accessTokenCookie) {
      cachedCookies = { cookieStr, expiresAt };
      logger.info({ expiresAt: new Date(expiresAt).toISOString(), cookieCount: cookies.length }, "amoCRM cookies obtained");
    } else {
      logger.error("Failed to obtain access_token cookie from amoCRM");
    }

    return cookieStr;
  } catch (err) {
    logger.error({ err }, "Puppeteer login failed");
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── Fetch events_timeline for a lead ───────────────────────────────────────────
interface TimelineEvent {
  id: string;
  type: number;
  created_at?: number;
  data?: {
    text?: string;
    message?: { type: string; text: string; media?: string };
    author?: { id: string; name: string; full_name: string; type: string };
    recipient?: { id: string; name: string; full_name: string };
    dialog?: { id: number; category: string };
    params?: any;
  };
}

interface TimelineResponse {
  _embedded?: { items: TimelineEvent[] };
  _links?: { prev?: { href: string } };
}

async function fetchTimeline(
  cookieStr: string,
  leadId: string,
  limit = 200,
  beforeTs?: number,
): Promise<TimelineEvent[]> {
  let url = `${AMO_BASE}/ajax/v3/leads/${leadId}/events_timeline/?limit=${limit}`;
  if (beforeTs) url += `&filter[created_at][lt]=${beforeTs}`;

  const res = await fetch(url, {
    headers: {
      Cookie: cookieStr,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    logger.warn({ leadId, status: res.status }, "events_timeline fetch failed");
    return [];
  }

  const data = (await res.json()) as TimelineResponse;
  return data?._embedded?.items ?? [];
}

// ── Parse timeline events into messages ────────────────────────────────────────
interface RawMessage {
  amoMessageId: string;
  leadId: string;
  senderType: "lead" | "broker" | "bot";
  senderName: string;
  senderId: string | null;
  text: string;
  channel: string | null;
  direction: "inbound" | "outbound";
  sentAt: Date;
}

function parseTimelineEvents(leadId: string, events: TimelineEvent[]): RawMessage[] {
  const messages: RawMessage[] = [];

  for (const ev of events) {
    if (ev.type !== 89 && ev.type !== 90) continue;

    const data = ev.data;
    if (!data) continue;

    const text = data.message?.text || "";
    if (!text) continue;

    let senderName: string;
    let senderId: string | null;
    let direction: "inbound" | "outbound";
    let senderType: "lead" | "broker" | "bot";
    let channel: string | null = null;

    if (ev.type === 89) {
      // Incoming from client
      senderName = data.author?.full_name || data.author?.name || "Unknown";
      senderId = data.author?.id || null;
      direction = "inbound";
      senderType = "lead";
    } else {
      // Outgoing (type 90)
      senderName = data.author?.full_name || data.author?.name || "Bot";
      senderId = data.author?.id || null;
      direction = "outbound";

      // Determine if it's bot or human broker
      const authorType = data.author?.type || "";
      if (authorType === "bot" || senderName.toLowerCase().includes("bot") || senderName === "Amojo Bot") {
        senderType = "bot";
        channel = "amocrm";
      } else {
        senderType = "broker";
      }

      // Try to detect channel from dialog or recipient info
      if (data.dialog?.category) {
        const cat = data.dialog.category.toLowerCase();
        if (cat.includes("whatsapp") || cat === "main") channel = channel ?? "whatsapp";
      }
    }

    // Use event id as unique identifier
    const amoMessageId = ev.id || messageId(leadId, ev.created_at ?? 0, senderId ?? "", text);
    const sentAt = ev.created_at ? new Date(ev.created_at * 1000) : new Date();

    messages.push({
      amoMessageId,
      leadId,
      senderType,
      senderName,
      senderId,
      text,
      channel,
      direction,
      sentAt,
    });
  }

  return messages;
}

// ── Store messages in DB ───────────────────────────────────────────────────────
async function storeMessages(messages: RawMessage[]): Promise<number> {
  let inserted = 0;
  for (const msg of messages) {
    try {
      await db
        .insert(leadMessagesTable)
        .values({
          leadId: msg.leadId,
          amoMessageId: msg.amoMessageId,
          senderType: msg.senderType,
          senderName: msg.senderName,
          senderId: msg.senderId,
          text: msg.text,
          channel: msg.channel,
          direction: msg.direction,
          sentAt: msg.sentAt,
        })
        .onConflictDoNothing({ target: leadMessagesTable.amoMessageId });
      inserted++;
    } catch {
      // Duplicate — non-fatal
    }
  }
  return inserted;
}

// ── Main sync function ─────────────────────────────────────────────────────────
export async function syncLeadMessagesFromTimeline(): Promise<{
  synced: number;
  leads: number;
  errors: number;
}> {
  // Get cookies
  const cookieStr = await getAmoCookies();
  if (!cookieStr) {
    logger.error("Cannot sync messages: no cookies");
    return { synced: 0, leads: 0, errors: 0 };
  }

  // Get all leads that need message sync
  const leads = await db
    .select({
      leadId: leadsSyncTable.leadId,
    })
    .from(leadsSyncTable)
    .where(
      and(
        isNotNull(leadsSyncTable.leadId),
        not(eq(leadsSyncTable.botExcluded, true)),
      ),
    );

  if (leads.length === 0) {
    logger.info("timeline message sync: no leads to process");
    return { synced: 0, leads: 0, errors: 0 };
  }

  logger.info({ leadCount: leads.length }, "timeline message sync started");

  let totalSynced = 0;
  let leadsProcessed = 0;
  let errors = 0;

  // Process in batches to avoid rate limits
  const BATCH_SIZE = 10;
  const DELAY_BETWEEN_BATCHES_MS = 2000;

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (lead) => {
        try {
          // Fetch all timeline events with pagination
          let allEvents: TimelineEvent[] = [];
          let beforeTs: number | undefined;
          let pageNum = 0;
          const MAX_PAGES = 10;

          while (pageNum < MAX_PAGES) {
            const events = await fetchTimeline(cookieStr, lead.leadId, 200, beforeTs);
            if (events.length === 0) break;
            allEvents.push(...events);

            // Get oldest event timestamp for pagination
            const oldest = events[events.length - 1];
            if (oldest?.created_at) {
              beforeTs = oldest.created_at;
            } else break;

            // If we got a full page, there might be more
            if (events.length < 200) break;
            pageNum++;
          }

          if (allEvents.length === 0) return { leadId: lead.leadId, count: 0 };

          // Parse and store
          const messages = parseTimelineEvents(lead.leadId, allEvents);
          const count = await storeMessages(messages);
          return { leadId: lead.leadId, count };
        } catch (err) {
          logger.error({ leadId: lead.leadId, err }, "timeline sync error for lead");
          throw err;
        }
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value.count > 0) {
        totalSynced += r.value.count;
        leadsProcessed++;
      } else if (r.status === "rejected") {
        errors++;
      }
    }

    // Delay between batches
    if (i + BATCH_SIZE < leads.length) {
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_BATCHES_MS));
    }
  }

  logger.info(
    { totalSynced, leadsProcessed, errors, totalLeads: leads.length },
    "timeline message sync complete",
  );

  // ── Also detect new incoming messages while we have cookies ────────────────
  try {
    const incoming = await syncIncomingMessageDetection();
    logger.info({ ...incoming }, "incoming message detection complete (part of timeline sync)");
  } catch (err) {
    logger.error({ err }, "incoming message detection failed (non-fatal)");
  }

  return { synced: totalSynced, leads: leadsProcessed, errors };
}

// ── Detect new incoming messages and update lastMessageFrom ─────────────────────
/**
 * For leads where we sent the last message (lastMessageFrom = "us" or null),
 * check if the client replied since our last outgoing message.
 * If so, update lastMessageFrom = "lead" and generate a LIVE suggestion.
 *
 * This catches manager replies from phone/amoCRM that bypass the extension.
 */
export async function syncIncomingMessageDetection(): Promise<{ detected: number; liveGenerated: number }> {
  const cookieStr = await getAmoCookies();
  if (!cookieStr) {
    logger.error("incoming detection: no cookies");
    return { detected: 0, liveGenerated: 0 };
  }

  // Get leads where we potentially sent the last message
  const leads = await db
    .select({
      leadId: leadsSyncTable.leadId,
      lastMessageFrom: leadsSyncTable.lastMessageFrom,
      lastOurMessageAt: leadsSyncTable.lastOurMessageAt,
      leadStage: leadsSyncTable.leadStage,
      pipeline: leadsSyncTable.pipeline,
      botExcluded: leadsSyncTable.botExcluded,
      responsibleUser: leadsSyncTable.responsibleUser,
    })
    .from(leadsSyncTable)
    .where(
      and(
        isNotNull(leadsSyncTable.leadId),
        not(eq(leadsSyncTable.botExcluded, true)),
        sql`${leadsSyncTable.lastMessageFrom} != 'lead' OR ${leadsSyncTable.lastMessageFrom} IS NULL`,
      ),
    );

  if (leads.length === 0) {
    logger.info("incoming detection: no leads to check");
    return { detected: 0, liveGenerated: 0 };
  }

  logger.info({ leadCount: leads.length }, "incoming detection started");

  let detected = 0;
  let liveGenerated = 0;
  const BATCH_SIZE = 10;
  const DELAY_MS = 2000;

  // Only fetch the most recent 5 events per lead (enough to find latest incoming/outgoing)
  const RECENT_LIMIT = 5;

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (lead) => {
        try {
          const events = await fetchTimeline(cookieStr, lead.leadId, RECENT_LIMIT);
          if (events.length === 0) return { leadId: lead.leadId, detected: false };

          // Find most recent type 89 (incoming) and type 90 (outgoing)
          let latestIncoming = 0;
          let latestOutgoing = 0;
          let latestIncomingText = "";

          for (const ev of events) {
            if (ev.type === 89 && ev.created_at && ev.created_at > latestIncoming) {
              latestIncoming = ev.created_at;
              latestIncomingText = ev.data?.message?.text || "";
            }
            if (ev.type === 90 && ev.created_at && ev.created_at > latestOutgoing) {
              latestOutgoing = ev.created_at;
            }
          }

          if (latestIncoming === 0) return { leadId: lead.leadId, detected: false };

          // Client replied after our last outgoing message?
          const lastOurAt = lead.lastOurMessageAt?.getTime() ?? 0;
          const lastOurTs = Math.floor(lastOurAt / 1000);

          if (latestIncoming <= latestOutgoing && latestOutgoing > 0) {
            // Incoming is older than outgoing — no new client reply
            return { leadId: lead.leadId, detected: false };
          }

          if (lastOurTs > 0 && latestIncoming <= lastOurTs) {
            // We already know about a more recent outgoing
            return { leadId: lead.leadId, detected: false };
          }

          // Client replied! Update lastMessageFrom
          const incomingAt = new Date(latestIncoming * 1000);
          await db
            .update(leadsSyncTable)
            .set({
              lastMessageFrom: "lead",
              lastMessageAt: incomingAt,
              updatedAt: new Date(),
            })
            .where(eq(leadsSyncTable.leadId, lead.leadId));

          // Delete any pending PUSH suggestions (client just replied — no follow-up needed)
          await db
            .delete(pendingSuggestionsTable)
            .where(
              and(
                eq(pendingSuggestionsTable.leadId, lead.leadId),
                eq(pendingSuggestionsTable.status, "pending"),
                eq(pendingSuggestionsTable.kind, "push"),
              ),
            );

          // Check if there's already a pending LIVE suggestion
          const [existingLive] = await db
            .select({ id: pendingSuggestionsTable.id })
            .from(pendingSuggestionsTable)
            .where(
              and(
                eq(pendingSuggestionsTable.leadId, lead.leadId),
                eq(pendingSuggestionsTable.status, "pending"),
                eq(pendingSuggestionsTable.kind, "live"),
              ),
            )
            .limit(1);

          let liveCreated = false;
          if (!existingLive && latestIncomingText) {
            // Generate LIVE suggestion — fetch more context for the AI
            try {
              const fullEvents = await fetchTimeline(cookieStr, lead.leadId, 20);
              const allMsgs = parseTimelineEvents(lead.leadId, fullEvents);
              const lastLeadMsg = allMsgs.filter((m) => m.direction === "inbound").pop();
              const contentSnippet = allMsgs.map((m) => `${m.senderName}: ${m.text}`).join("\n");

              if (lastLeadMsg) {
                await generateSuggestion({
                  leadId: lead.leadId,
                  responsibleUser: lead.responsibleUser,
                  kind: "live",
                  lastLeadMessage: lastLeadMsg.text,
                  contentSnippet: contentSnippet.slice(0, 3000),
                  leadStage: lead.leadStage,
                  pipeline: lead.pipeline,
                });
                liveCreated = true;
              }
            } catch (err) {
              logger.error({ leadId: lead.leadId, err }, "incoming detection: LIVE generation failed");
            }
          }

          logger.info(
            { leadId: lead.leadId, incomingAt, latestOutgoing, liveCreated },
            "incoming detection: client replied detected",
          );

          return { leadId: lead.leadId, detected: true, liveCreated };
        } catch (err) {
          logger.error({ leadId: lead.leadId, err }, "incoming detection error");
          return { leadId: lead.leadId, detected: false };
        }
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value.detected) {
        detected++;
        if (r.value.liveCreated) liveGenerated++;
      }
    }

    if (i + BATCH_SIZE < leads.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  logger.info({ detected, liveGenerated, totalChecked: leads.length }, "incoming detection complete");
  return { detected, liveGenerated };
}

// ── Standalone runner ──────────────────────────────────────────────────────────
// When run directly: `node dist/lib/amo-timeline-sync.js`
if (process.argv[1]?.includes("amo-timeline-sync")) {
  syncLeadMessagesFromTimeline()
    .then((result) => {
      console.log("Result:", result);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
}

// ── Scheduler ──────────────────────────────────────────────────────────────────
const TIMELINE_SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export function startTimelineSyncScheduler(): void {
  // First sync after 60 seconds (let other schedulers finish first)
  setTimeout(async () => {
    try { await syncLeadMessagesFromTimeline(); } catch (err) { logger.error({ err }, "initial timeline sync error"); }
  }, 60_000);

  setInterval(async () => {
    try { await syncLeadMessagesFromTimeline(); } catch (err) { logger.error({ err }, "periodic timeline sync error"); }
  }, TIMELINE_SYNC_INTERVAL_MS);

  logger.info("timeline sync scheduler started (every 30 min)");
}
