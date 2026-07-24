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
import { getLastMessengerFieldId, updateLastMessengerField } from "./amo-messenger-field.js";

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
    author?: {
      id: string;
      name: string;
      full_name: string;
      type: string;
      origin?: string;          // "wahelp.whatbot", "ru.wababa.amocrm", etc.
      origin_profile?: string;  // JSON with { id: number } — source_id
      origin_chat_id?: string;
      origin_name?: string;     // channel name e.g. "Wahelp Nick"
    };
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
  // Channel source info from type 89 origin fields
  channelSourceId?: string;
  channelSourceName?: string;
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
    let channelSourceId: string | undefined;
    let channelSourceName: string | undefined;

    if (ev.type === 89) {
      // Incoming from client
      senderName = data.author?.full_name || data.author?.name || "Unknown";
      senderId = data.author?.id || null;
      direction = "inbound";
      senderType = "lead";

      // Extract channel source from origin fields
      if (data.author?.origin_profile) {
        try {
          const profile = typeof data.author.origin_profile === "string"
            ? JSON.parse(data.author.origin_profile)
            : data.author.origin_profile;
          if (profile?.id) channelSourceId = String(profile.id);
        } catch {
          // Not JSON — might be a plain ID
          channelSourceId = data.author.origin_profile;
        }
      }
      if (data.author?.origin_name) {
        channelSourceName = data.author.origin_name;
      }
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
      channelSourceId,
      channelSourceName,
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

// ── Source ID → channel name mapping (from /ajax/v1/chats/origin/sources) ─────
let sourceMap: Record<string, string> = {};

async function loadSourceMap(cookieStr: string): Promise<void> {
  if (Object.keys(sourceMap).length > 0) return; // Already loaded
  try {
    const res = await fetch(`${AMO_BASE}/ajax/v1/chats/origin/sources`, {
      headers: { Cookie: cookieStr },
    });
    if (!res.ok) return;
    const data = await res.json() as { response: { sources: Array<{ id: number; name: string }> } };
    const sources = data?.response?.sources ?? [];
    for (const s of sources) {
      sourceMap[String(s.id)] = s.name;
    }
    logger.info({ count: sources.length }, "loaded amoCRM source map");
  } catch (err) {
    logger.warn({ err }, "failed to load source map");
  }
}

// ── Detect new incoming messages and update lastMessageFrom ─────────────────────
/**
 * For ALL non-excluded leads, check if the client sent a new message that we
 * haven't processed yet. Uses `lastMessageAt` from DB as the deduplication
 * anchor — if the latest type 89 event is newer, it's a new client message.
 *
 * Previously this only checked leads where lastMessageFrom != 'lead', which
 * meant once a client replied, their subsequent messages were never detected
 * (because syncOutgoingEvents is broken and never resets lastMessageFrom to 'us').
 *
 * This catches: manager replies from phone/amoCRM, new client messages, etc.
 */
export async function syncIncomingMessageDetection(): Promise<{ detected: number; liveGenerated: number }> {
  const cookieStr = await getAmoCookies();
  if (!cookieStr) {
    logger.error("incoming detection: no cookies");
    return { detected: 0, liveGenerated: 0 };
  }

  // Get ALL non-excluded leads — we need to check every lead for new messages
  const leads = await db
    .select({
      leadId: leadsSyncTable.leadId,
      lastMessageFrom: leadsSyncTable.lastMessageFrom,
      lastMessageAt: leadsSyncTable.lastMessageAt,
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
      ),
    );

  if (leads.length === 0) {
    logger.info("incoming detection: no leads to check");
    return { detected: 0, liveGenerated: 0 };
  }

  logger.info({ leadCount: leads.length }, "incoming detection started");

  // Load source map for channel name resolution
  await loadSourceMap(cookieStr);
  const fieldId = getLastMessengerFieldId();

  let detected = 0;
  let liveGenerated = 0;
  const BATCH_SIZE = 10;
  const DELAY_MS = 2000;

  // Fetch more events to avoid race conditions with Salesbot replies
  const RECENT_LIMIT = 20;

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (lead) => {
        try {
          const events = await fetchTimeline(cookieStr, lead.leadId, RECENT_LIMIT);
          if (events.length === 0) return { leadId: lead.leadId, detected: false };

          // Find most recent type 89 (incoming)
          let latestIncoming = 0;
          let latestIncomingText = "";
          let latestIncomingEvent: TimelineEvent | null = null;

          for (const ev of events) {
            if (ev.type === 89 && ev.created_at && ev.created_at > latestIncoming) {
              latestIncoming = ev.created_at;
              latestIncomingText = ev.data?.message?.text || "";
              latestIncomingEvent = ev;
            }
          }

          if (latestIncoming === 0) return { leadId: lead.leadId, detected: false };

          // Compare with lastMessageAt from DB — the anchor for deduplication
          // Use whichever timestamp is more recent between lastMessageAt and lastOurMessageAt
          const lastMsgAt = lead.lastMessageAt?.getTime() ?? 0;
          const lastOurAt = lead.lastOurMessageAt?.getTime() ?? 0;
          const knownAt = Math.max(lastMsgAt, lastOurAt);
          const knownTs = Math.floor(knownAt / 1000);

          if (knownTs > 0 && latestIncoming <= knownTs) {
            // We already know about this message (or a newer one)
            return { leadId: lead.leadId, detected: false };
          }

          // New client message detected! Update lastMessageFrom
          const incomingAt = new Date(latestIncoming * 1000);
          await db
            .update(leadsSyncTable)
            .set({
              lastMessageFrom: "lead",
              lastMessageAt: incomingAt,
              updatedAt: new Date(),
            })
            .where(eq(leadsSyncTable.leadId, lead.leadId));

          // Update "last active chat messenger" custom field for Salesbot routing
          if (latestIncomingEvent && fieldId) {
            try {
              const author = latestIncomingEvent.data?.author;
              let sourceId: string | undefined;
              let sourceName: string | undefined;

              if (author?.origin_profile) {
                try {
                  const profile = typeof author.origin_profile === "string"
                    ? JSON.parse(author.origin_profile)
                    : author.origin_profile;
                  if (profile?.id) sourceId = String(profile.id);
                } catch {
                  sourceId = author.origin_profile;
                }
              }

              if (sourceId && sourceMap[sourceId]) {
                sourceName = sourceMap[sourceId];
              } else if (author?.origin_name) {
                sourceName = author.origin_name;
              }

              if (sourceName) {
                await updateLastMessengerField(lead.leadId, sourceName, parseInt(sourceId ?? "0", 10), fieldId);
              }
            } catch (err) {
              logger.warn({ leadId: lead.leadId, err }, "incoming detection: failed to update messenger field");
            }
          }

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
            { leadId: lead.leadId, incomingAt, knownTs, liveCreated },
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

// ── Quick poll: fetch only new incoming messages via v4 events API ─────────────
/**
 * Instead of scanning all 2193 leads, poll the v4 events API for
 * incoming_chat_message events. Returns unique lead IDs that have new messages.
 * Uses cookie-based auth (not Bearer token).
 */
async function pollNewIncomingLeadIds(cookieStr: string, lookbackMs = 5 * 60 * 1000): Promise<string[]> {
  const fromTs = Math.floor((Date.now() - lookbackMs) / 1000);
  const url = `${AMO_BASE}/api/v4/events?filter[type][]=incoming_chat_message&filter[created_at][from]=${fromTs}&limit=250`;

  try {
    const res = await fetch(url, {
      headers: { Cookie: cookieStr, "Content-Type": "application/json" },
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "poll incoming: v4 events failed");
      return [];
    }
    const text = await res.text();
    if (!text || text.length < 3) return []; // 204 No Content or empty body
    const data = JSON.parse(text) as { _embedded?: { events?: Array<{ entity_id: number | string }> } };
    const events = data?._embedded?.events ?? [];
    const leadIds = [...new Set(events.map((e) => String(e.entity_id)))];
    if (leadIds.length > 0) {
      logger.info({ count: leadIds.length, eventCount: events.length }, "poll incoming: found new messages");
    }
    return leadIds;
  } catch (err) {
    logger.warn({ err }, "poll incoming: fetch failed");
    return [];
  }
}

/**
 * Process a single lead: fetch timeline, store new messages, detect incoming,
 * generate LIVE suggestion if needed. Same as the full sync but for ONE lead.
 */
async function processQuickPollLead(
  cookieStr: string,
  leadId: string,
): Promise<{ stored: number; detected: boolean; liveCreated: boolean }> {
  // Fetch full timeline for this lead
  let allEvents: TimelineEvent[] = [];
  let beforeTs: number | undefined;
  for (let pageNum = 0; pageNum < 10; pageNum++) {
    const events = await fetchTimeline(cookieStr, leadId, 200, beforeTs);
    if (events.length === 0) break;
    allEvents.push(...events);
    const oldest = events[events.length - 1];
    if (oldest?.created_at) beforeTs = oldest.created_at;
    else break;
    if (events.length < 200) break;
  }

  if (allEvents.length === 0) return { stored: 0, detected: false, liveCreated: false };

  // Store messages
  const messages = parseTimelineEvents(leadId, allEvents);
  const stored = await storeMessages(messages);

  // Get lead info from DB
  const [leadRow] = await db
    .select({
      lastMessageAt: leadsSyncTable.lastMessageAt,
      lastOurMessageAt: leadsSyncTable.lastOurMessageAt,
      leadStage: leadsSyncTable.leadStage,
      pipeline: leadsSyncTable.pipeline,
      botExcluded: leadsSyncTable.botExcluded,
      responsibleUser: leadsSyncTable.responsibleUser,
    })
    .from(leadsSyncTable)
    .where(eq(leadsSyncTable.leadId, leadId))
    .limit(1);

  if (!leadRow || leadRow.botExcluded) return { stored, detected: false, liveCreated: false };

  // Find latest type 89 (incoming)
  let latestIncoming = 0;
  let latestIncomingText = "";
  let latestIncomingEvent: TimelineEvent | null = null;
  for (const ev of allEvents) {
    if (ev.type === 89 && ev.created_at && ev.created_at > latestIncoming) {
      latestIncoming = ev.created_at;
      latestIncomingText = ev.data?.message?.text || "";
      latestIncomingEvent = ev;
    }
  }
  if (latestIncoming === 0) return { stored, detected: false, liveCreated: false };

  // Compare with known timestamps
  const lastMsgAt = leadRow.lastMessageAt?.getTime() ?? 0;
  const lastOurAt = leadRow.lastOurMessageAt?.getTime() ?? 0;
  const knownAt = Math.max(lastMsgAt, lastOurAt);
  const knownTs = Math.floor(knownAt / 1000);
  if (knownTs > 0 && latestIncoming <= knownTs) return { stored, detected: false, liveCreated: false };

  // New incoming detected! Update DB
  const incomingAt = new Date(latestIncoming * 1000);
  await db
    .update(leadsSyncTable)
    .set({ lastMessageFrom: "lead", lastMessageAt: incomingAt, updatedAt: new Date() })
    .where(eq(leadsSyncTable.leadId, leadId));

  // Update messenger field
  const fieldId = getLastMessengerFieldId();
  if (latestIncomingEvent && fieldId) {
    try {
      const author = latestIncomingEvent.data?.author;
      let sourceName: string | undefined;
      if (author?.origin_profile) {
        try {
          const profile = typeof author.origin_profile === "string" ? JSON.parse(author.origin_profile) : author.origin_profile;
          const sourceId = profile?.id ? String(profile.id) : undefined;
          if (sourceId && sourceMap[sourceId]) sourceName = sourceMap[sourceId];
        } catch { /* ignore */ }
      }
      if (!sourceName && author?.origin_name) sourceName = author.origin_name;
      if (sourceName) {
        await updateLastMessengerField(leadId, sourceName, 0, fieldId);
      }
    } catch { /* non-fatal */ }
  }

  // Delete pending PUSH suggestions
  await db
    .delete(pendingSuggestionsTable)
    .where(and(
      eq(pendingSuggestionsTable.leadId, leadId),
      eq(pendingSuggestionsTable.status, "pending"),
      eq(pendingSuggestionsTable.kind, "push"),
    ));

  // Check for existing LIVE suggestion
  const [existingLive] = await db
    .select({ id: pendingSuggestionsTable.id })
    .from(pendingSuggestionsTable)
    .where(and(
      eq(pendingSuggestionsTable.leadId, leadId),
      eq(pendingSuggestionsTable.status, "pending"),
      eq(pendingSuggestionsTable.kind, "live"),
    ))
    .limit(1);

  let liveCreated = false;
  if (!existingLive && latestIncomingText) {
    try {
      const fullEvents = await fetchTimeline(cookieStr, leadId, 20);
      const allMsgs = parseTimelineEvents(leadId, fullEvents);
      const lastLeadMsg = allMsgs.filter((m) => m.direction === "inbound").pop();
      const contentSnippet = allMsgs.map((m) => `${m.senderName}: ${m.text}`).join("\n");
      if (lastLeadMsg) {
        await generateSuggestion({
          leadId,
          responsibleUser: leadRow.responsibleUser,
          kind: "live",
          lastLeadMessage: lastLeadMsg.text,
          contentSnippet: contentSnippet.slice(0, 3000),
          leadStage: leadRow.leadStage,
          pipeline: leadRow.pipeline,
        });
        liveCreated = true;
      }
    } catch (err) {
      logger.error({ leadId, err }, "quick poll: LIVE generation failed");
    }
  }

  logger.info({ leadId, incomingAt, liveCreated }, "quick poll: new incoming processed");
  return { stored, detected: true, liveCreated };
}

// ── Quick poll scheduler: check for new messages every 2 minutes ───────────────
const QUICK_POLL_INTERVAL_MS = 15 * 1000; // 15 seconds
const QUICK_POLL_LOOKBACK_MS = 60 * 1000; // look back 1 min (overlap for safety)

async function runQuickPoll(): Promise<void> {
  const cookieStr = await getAmoCookies();
  if (!cookieStr) {
    logger.error("quick poll: no cookies");
    return;
  }

  await loadSourceMap(cookieStr);

  const leadIds = await pollNewIncomingLeadIds(cookieStr, QUICK_POLL_LOOKBACK_MS);
  if (leadIds.length === 0) return;

  const BATCH_SIZE = 5;
  let detected = 0;
  let liveCreated = 0;

  for (let i = 0; i < leadIds.length; i += BATCH_SIZE) {
    const batch = leadIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((leadId) => processQuickPollLead(cookieStr, leadId)),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.detected) {
        detected++;
        if (r.value.liveCreated) liveCreated++;
      }
    }
    if (i + BATCH_SIZE < leadIds.length) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (detected > 0) {
    logger.info({ detected, liveCreated, total: leadIds.length }, "quick poll complete");
  }
}

// ── Scheduler ──────────────────────────────────────────────────────────────────
const TIMELINE_SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes (full sync backup)

export function startTimelineSyncScheduler(): void {
  logger.info({ fieldId: getLastMessengerFieldId() }, "last messenger custom field configured");

  // Quick poll every 2 minutes (fast path — catches new messages quickly)
  setTimeout(async () => {
    try { await runQuickPoll(); } catch (err) { logger.error({ err }, "initial quick poll error"); }
  }, 30_000); // first poll after 30 seconds

  setInterval(async () => {
    try { await runQuickPoll(); } catch (err) { logger.error({ err }, "quick poll error"); }
  }, QUICK_POLL_INTERVAL_MS);

  // Full sync every 30 minutes (backup — catches anything the quick poll missed)
  setTimeout(async () => {
    try { await syncLeadMessagesFromTimeline(); } catch (err) { logger.error({ err }, "initial timeline sync error"); }
  }, 60_000);

  setInterval(async () => {
    try { await syncLeadMessagesFromTimeline(); } catch (err) { logger.error({ err }, "periodic timeline sync error"); }
  }, TIMELINE_SYNC_INTERVAL_MS);

  logger.info("scheduler started: quick poll every 2 min, full sync every 30 min");
}
