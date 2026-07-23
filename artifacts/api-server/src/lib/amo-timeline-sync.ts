/**
 * Fetches chat messages from amoCRM via internal /ajax/v3/leads/{id}/events_timeline/
 * endpoint. Requires Puppeteer login to get session access_token.
 *
 * Types 89 = incoming message from client
 * Types 90 = outgoing message (bot/broker)
 */
import { db, leadMessagesTable, leadsSyncTable } from "@workspace/db";
import { eq, and, sql, isNotNull, not } from "drizzle-orm";
import { createHash } from "crypto";
import { logger } from "./logger";

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

// ── Session token cache ────────────────────────────────────────────────────────
let cachedSession: { accessToken: string; expiresAt: number } | null = null;

/**
 * Login via Puppeteer and get session access_token from /ajax/v1/chats/session.
 * The session token is used as Bearer for internal /ajax/ endpoints.
 */
async function getSessionToken(): Promise<string | null> {
  // Return cached if still valid (with 5 min buffer)
  if (cachedSession && cachedSession.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedSession.accessToken;
  }

  let puppeteer: any;
  try {
    puppeteer = await import("puppeteer");
  } catch {
    logger.error("puppeteer not installed — run: npm install puppeteer");
    return null;
  }

  const launchArgs: any = {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  };
  if (CHROME_PATH) launchArgs.executablePath = CHROME_PATH;

  const browser = await puppeteer.default.launch(launchArgs);
  try {
    const page = await browser.newPage();

    // Capture session token from network responses
    let sessionToken: string | null = null;
    let sessionExpiresAt = 0;

    page.on("response", async (res: any) => {
      if (res.url().includes("/ajax/v1/chats/session") && res.status() === 200) {
        try {
          const data = await res.json();
          const session = data?.response?.chats?.session;
          if (session?.access_token) {
            sessionToken = session.access_token;
            sessionExpiresAt = (session.expired_at ?? 0) * 1000;
          }
        } catch {}
      }
    });

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

    // Navigate to a lead page to trigger session token loading
    await page.goto(AMO_BASE + "/leads/detail/22609833", { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 5000));

    if (sessionToken) {
      cachedSession = { accessToken: sessionToken, expiresAt: sessionExpiresAt };
      logger.info({ expiresAt: new Date(sessionExpiresAt).toISOString() }, "amoCRM session token obtained");
    } else {
      logger.error("Failed to obtain session token from amoCRM");
    }

    return sessionToken;
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
  accessToken: string,
  leadId: string,
  limit = 200,
  beforeTs?: number,
): Promise<TimelineEvent[]> {
  let url = `${AMO_BASE}/ajax/v3/leads/${leadId}/events_timeline/?limit=${limit}`;
  if (beforeTs) url += `&filter[created_at][lt]=${beforeTs}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
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
    const amoMsgId = ev.id || messageId(leadId, ev.created_at ?? 0, senderId ?? "", text);
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
  // Get session token
  const accessToken = await getSessionToken();
  if (!accessToken) {
    logger.error("Cannot sync messages: no session token");
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
            const events = await fetchTimeline(accessToken, lead.leadId, 200, beforeTs);
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

  return { synced: totalSynced, leads: leadsProcessed, errors };
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
