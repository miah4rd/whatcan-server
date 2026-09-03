/**
 * Fetches chat messages from amoCRM via internal /ajax/v3/leads/{id}/events_timeline/
 * endpoint, authenticated with the ordinary API Bearer token (see getAmoAuth —
 * this used to drive a headless Chrome through the login form, which a reCaptcha
 * later broke; the browser was never necessary).
 *
 * Types 89 = incoming message from client
 * Types 90 = outgoing message (bot/broker)
 */
import { db, leadMessagesTable, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, and, sql, isNotNull, not } from "drizzle-orm";
import { createHash } from "crypto";
import { logger } from "./logger";
import { generateSuggestion } from "./generate-suggestion.js";
// queueSuggestion persists the generated text into pending_suggestions (the
// inbox) and fires the broker push notification. generateSuggestion alone only
// RETURNS the text — without queueing, the suggestion silently evaporates.
import { queueSuggestion } from "../routes/amocrm-webhook.js";
import { getLastMessengerFieldId, updateLastMessengerField } from "./amo-messenger-field.js";
// Coalesces this detection with the real-time webhook's — both can fire for
// the same burst of WhatsApp messages, so both route through the same debounce.
import { scheduleLiveReply } from "./live-reply-debounce.js";
import { shouldSuppressPush } from "./stage-routing";
import { followupClockAfterReply } from "./rental-followup";
import { reconcileTasksAfterManualReply } from "./manual-reply-followup";
import { enforceBudgetFilter } from "./budget-filter";
import { recordCommitment } from "./commitment-scheduler";
import { getAccessToken } from "./amo-client";
import { getMergedConversation } from "./merged-conversation";
import { renderDialogContent } from "./dialog-parser";

const AMO_SUBDOMAIN = process.env.AMO_SUBDOMAIN ?? "unicornproperty";
const AMO_BASE = `https://${AMO_SUBDOMAIN}.amocrm.ru`;

// ── Deterministic message ID ───────────────────────────────────────────────────
function messageId(leadId: string, eventTs: number, authorId: string, text: string): string {
  const payload = `${leadId}|${eventTs}|${authorId}|${text.slice(0, 200)}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

// ── Auth for the internal /ajax/ endpoints ────────────────────────────────────
/**
 * The ajax timeline accepts the ordinary API Bearer token.
 *
 * This used to drive a headless Chrome through the amoCRM login form purely to
 * scrape an access_token cookie. amoCRM then put a reCaptcha on that form, so
 * the login could never complete: ~42 seconds of pegged event loop every ~45
 * seconds, "Failed to obtain access_token cookie" 4,600+ times, and — the part
 * that actually hurt — no incoming messages detected at all. Leads replied and
 * the bot stayed blind.
 *
 * The Puppeteer round trip was never needed. /ajax/v3/leads/{id}/events_timeline/
 * answers 200 to the same Bearer token every other call in this codebase uses,
 * message text included. No browser, no captcha, nothing to configure.
 */
export async function getAmoAuth(): Promise<string | null> {
  const token = await getAccessToken();
  if (!token) {
    logger.error("timeline sync: no amoCRM access token available");
    return null;
  }
  return `Bearer ${token}`;
}

// ── Fetch events_timeline for a lead ───────────────────────────────────────────
interface TimelineEvent {
  id: string;
  type: number;
  created_at?: number;
  date_create?: number;      // unix seconds — the field the ajax v3 endpoint ACTUALLY returns
  msec_created_at?: number;  // unix seconds with fractional ms (despite the name)
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

// The ajax v3 events_timeline items do NOT carry `created_at` — the real event
// time lives in `date_create` (unix seconds) / `msec_created_at` (unix seconds
// with fractional ms, despite the name). Reading only `created_at` meant every
// message was stored with "now" as its timestamp and incoming-reply detection
// never fired (latestIncoming stayed 0), so LIVE suggestions were never
// created from the timeline path. Returns unix SECONDS, 0 if undeterminable.
function eventTs(ev: TimelineEvent): number {
  if (typeof ev.created_at === "number" && ev.created_at > 0) return ev.created_at;
  if (typeof ev.date_create === "number" && ev.date_create > 0) return ev.date_create;
  if (typeof ev.msec_created_at === "number" && ev.msec_created_at > 0) return Math.floor(ev.msec_created_at);
  return 0;
}

export async function fetchTimeline(
  authHeader: string,
  leadId: string,
  limit = 200,
  beforeTs?: number,
): Promise<TimelineEvent[]> {
  let url = `${AMO_BASE}/ajax/v3/leads/${leadId}/events_timeline/?limit=${limit}`;
  if (beforeTs) url += `&filter[created_at][lt]=${beforeTs}`;

  const res = await fetch(url, {
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
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

export function parseTimelineEvents(leadId: string, events: TimelineEvent[]): RawMessage[] {
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
    const ts = eventTs(ev);
    const amoMessageId = ev.id || messageId(leadId, ts, senderId ?? "", text);
    const sentAt = ts ? new Date(ts * 1000) : new Date();

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

  // The events_timeline endpoint returns events NEWEST-FIRST. Callers assume
  // chronological order — `.pop()` for "the lead's latest message", joining
  // into an oldest→newest conversation snippet for the AI. Consuming the raw
  // order silently inverted both: the "latest" message was actually the OLDEST
  // in the window (stale text in push notifications, replies addressed to old
  // messages) and the AI read the dialog backwards. Sort ascending here so
  // every consumer gets chronological order.
  messages.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());

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
        // Update the timestamp (and text/channel) on re-read: a past bulk import
        // stamped a batch of messages with one wrong time, and DoNothing kept it
        // frozen. Re-syncing a lead now corrects the real time from amoCRM.
        .onConflictDoUpdate({
          target: leadMessagesTable.amoMessageId,
          set: { sentAt: msg.sentAt, text: msg.text, channel: msg.channel, senderType: msg.senderType },
        });
      inserted++;
    } catch {
      // Duplicate — non-fatal
    }
  }
  await startFollowupClockForOutgoing(messages);
  return inserted;
}

/**
 * Second, independent guarantee that answering a lead starts the follow-up clock.
 *
 * The primary detector is syncOutgoingEvents (amo-sync), but it polls amoCRM's
 * event feed every 5 minutes with a 30-minute lookback — a restart or a longer
 * outage silently drops whatever was sent in that window, and then nothing ever
 * chases the lead again. This poll reads the timeline every 45s and already sees
 * our outgoing messages, so it closes the clock here too. Both compute the same
 * value from the same message time, so whichever runs first wins and the other
 * is a no-op.
 */
async function startFollowupClockForOutgoing(messages: RawMessage[]): Promise<void> {
  // Newest message per lead — only act when OURS is the newest one.
  const newestByLead = new Map<string, RawMessage>();
  for (const m of messages) {
    const cur = newestByLead.get(m.leadId);
    if (!cur || m.sentAt.getTime() > cur.sentAt.getTime()) newestByLead.set(m.leadId, m);
  }

  for (const [leadId, newest] of newestByLead) {
    if (newest.senderType === "lead") continue;
    try {
      const [row] = await db
        .select({
          lastOurMessageAt: leadsSyncTable.lastOurMessageAt,
          lastMessageFrom: leadsSyncTable.lastMessageFrom,
          leadStage: leadsSyncTable.leadStage,
          pipeline: leadsSyncTable.pipeline,
          botExcluded: leadsSyncTable.botExcluded,
          responsibleUser: leadsSyncTable.responsibleUser,
        })
        .from(leadsSyncTable)
        .where(eq(leadsSyncTable.leadId, leadId))
        .limit(1);
      if (!row || row.botExcluded) continue;
      if (row.lastOurMessageAt && row.lastOurMessageAt.getTime() >= newest.sentAt.getTime()) continue;
      if (shouldSuppressPush(row.leadStage ?? "")) continue;

      /**
       * "Newest" above means newest IN THIS BATCH, not newest in the thread.
       *
       * A sweep that ingests one of our older outgoing messages — a webhook the
       * feed delivered late, a backfill — used to stamp lastMessageFrom='us'
       * even when the lead had already answered AFTER it. The card then read as
       * "we spoke last and they went quiet" and went to PUSH with a follow-up
       * draft, while the conversation on screen plainly ended with the lead's
       * own words. Villa Chempaka 23270729: the owner wrote "You are welcome"
       * at 19:20, our 18:46 message landed in a later sweep, and the card was
       * chased as unanswered for eleven days.
       */
      const [incoming] = await db
        .select({ newest: sql<Date | null>`max(${leadMessagesTable.sentAt})` })
        .from(leadMessagesTable)
        .where(and(eq(leadMessagesTable.leadId, leadId), eq(leadMessagesTable.senderType, "lead")));
      const leadNewest = incoming?.newest ? new Date(incoming.newest) : null;
      const leadSpokeLater = !!leadNewest && leadNewest.getTime() > newest.sentAt.getTime();

      await db
        .update(leadsSyncTable)
        .set({
          // Our outgoing time is a fact either way; who spoke LAST is not.
          lastOurMessageAt: newest.sentAt,
          ...(leadSpokeLater
            ? { lastMessageFrom: "lead", lastMessageAt: leadNewest }
            : {
                lastMessageFrom: "us",
                nextFollowupAt: followupClockAfterReply(newest.sentAt, row.pipeline),
                ...(row.lastMessageFrom === "lead" ? { followupLevel: 0 } : {}),
              }),
          updatedAt: new Date(),
        })
        .where(eq(leadsSyncTable.leadId, leadId));
      if (leadSpokeLater) continue;

      // Same "I'll check with the owner" detector approve.ts and the real-time
      // webhook use — this is the backup path for a message either one missed,
      // so it needs the same hook or a commitment made in exactly that gap
      // never gets a reminder.
      if (newest.text) {
        recordCommitment(leadId, row.responsibleUser, newest.text).catch(() => {});
      }

      // A MANUAL reply (the broker's own hand — phone WhatsApp or amoCRM chat,
      // never our Salesbot) must also move the amoCRM TASK, because
      // syncTaskSchedule reads open tasks back into nextFollowupAt every 5
      // minutes: resetting only the clock above while an overdue task stayed
      // open re-pinned the lead "Overdue Nd" within minutes, forever (Amelia,
      // 2026-08-18). Bot sends stay out: approve.ts already closed and
      // re-created the task, sometimes on an adaptive cadence this would break.
      if (newest.senderType === "broker") {
        try {
          const r = await reconcileTasksAfterManualReply({
            leadId,
            sentAt: newest.sentAt,
            pipeline: row.pipeline,
            leadStage: row.leadStage,
            responsibleUser: row.responsibleUser,
            mode: "live",
          });
          logger.info({ leadId, action: r.action }, "timeline: manual broker reply — amoCRM task reconciled");
        } catch (err) {
          logger.warn({ err, leadId }, "timeline: manual-reply task reconcile failed");
        }
      }

      logger.info(
        { leadId, sentAt: newest.sentAt, by: newest.senderType },
        "timeline: our outgoing message seen — follow-up clock started (backup path)",
      );
    } catch (err) {
      logger.warn({ err, leadId }, "timeline: could not start the follow-up clock");
    }
  }
}

// ── Main sync function ─────────────────────────────────────────────────────────
export async function syncLeadMessagesFromTimeline(): Promise<{
  synced: number;
  leads: number;
  errors: number;
}> {
  // Get cookies
  const authHeader = await getAmoAuth();
  if (!authHeader) {
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
            const events = await fetchTimeline(authHeader, lead.leadId, 200, beforeTs);
            if (events.length === 0) break;
            allEvents.push(...events);

            // Get oldest event timestamp for pagination
            const oldest = events[events.length - 1];
            const oldestTs = oldest ? eventTs(oldest) : 0;
            if (oldestTs) {
              beforeTs = oldestTs;
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

async function loadSourceMap(authHeader: string): Promise<void> {
  if (Object.keys(sourceMap).length > 0) return; // Already loaded
  try {
    const res = await fetch(`${AMO_BASE}/ajax/v1/chats/origin/sources`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(15_000),
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
  const authHeader = await getAmoAuth();
  if (!authHeader) {
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
      content: leadsSyncTable.content,
      leadNotes: leadsSyncTable.leadNotes,
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
  await loadSourceMap(authHeader);
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
          const events = await fetchTimeline(authHeader, lead.leadId, RECENT_LIMIT);
          if (events.length === 0) return { leadId: lead.leadId, detected: false };

          // Find most recent type 89 (incoming)
          let latestIncoming = 0;
          let latestIncomingText = "";
          let latestIncomingEvent: TimelineEvent | null = null;

          for (const ev of events) {
            const ts = eventTs(ev);
            if (ev.type === 89 && ts && ts > latestIncoming) {
              latestIncoming = ts;
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

          // NOTE: no "existing pending LIVE → skip" check. A NEW incoming message
          // must always refresh the suggestion (queueSuggestion replaces pending
          // rows atomically) — otherwise a stale answer written for an older
          // message sits in the inbox and the bot looks blind to newer replies.
          // The knownTs comparison above runs this at most once per message.
          let liveCreated = false;
          if (latestIncomingText) {
            liveCreated = true;
            // Debounced + re-fetched fresh at fire time — this detection and the
            // real-time webhook's can both fire for the same message burst; without
            // coalescing, each fires its own generation and the lead sees near-
            // duplicate replies a couple minutes apart.
            scheduleLiveReply(lead.leadId, async () => {
              try {
                if (await enforceBudgetFilter(lead.leadId)) return;
                const [freshLead] = await db
                  .select({
                    content: leadsSyncTable.content,
                    leadNotes: leadsSyncTable.leadNotes,
                    leadStage: leadsSyncTable.leadStage,
                    pipeline: leadsSyncTable.pipeline,
                    responsibleUser: leadsSyncTable.responsibleUser,
                  })
                  .from(leadsSyncTable)
                  .where(eq(leadsSyncTable.leadId, lead.leadId))
                  .limit(1);
                if (!freshLead) return;

                const fullEvents = await fetchTimeline(authHeader, lead.leadId, 20);
                const allMsgs = parseTimelineEvents(lead.leadId, fullEvents);
                const lastLeadMsg = allMsgs.filter((m) => m.direction === "inbound").pop();
                const timelineTail = allMsgs.map((m) => `${m.senderName}: ${m.text}`).join("\n");
                const contentSnippet = freshLead.content
                  ? `${freshLead.content}\n\n[LATEST MESSAGES — may not be in the log above yet]\n${timelineTail.slice(-1500)}`
                  : timelineTail;

                if (!lastLeadMsg) return;
                const { text, attachments } = await generateSuggestion({
                  leadId: lead.leadId,
                  responsibleUser: freshLead.responsibleUser,
                  kind: "live",
                  lastLeadMessage: lastLeadMsg.text,
                  contentSnippet,
                  leadNotes: freshLead.leadNotes,
                  leadStage: freshLead.leadStage,
                  pipeline: freshLead.pipeline,
                });
                if (text) {
                  await queueSuggestion({
                    leadId: lead.leadId,
                    responsibleUser: freshLead.responsibleUser,
                    kind: "live",
                    text,
                    attachments,
                    leadMessageText: lastLeadMsg.text,
                  });
                }
              } catch (err) {
                logger.error({ leadId: lead.leadId, err }, "incoming detection: LIVE generation failed");
              }
            });
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
async function pollNewIncomingLeadIds(authHeader: string, lookbackMs = 5 * 60 * 1000): Promise<string[]> {
  const fromTs = Math.floor((Date.now() - lookbackMs) / 1000);
  const url = `${AMO_BASE}/api/v4/events?filter[type][]=incoming_chat_message&filter[created_at][from]=${fromTs}&limit=250`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
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
/**
 * Run the quick-poll pipeline for ONE lead, on demand.
 *
 * The scheduled paths are all-or-nothing: the quick poll only looks at leads
 * with amoCRM activity in the last minute, and the full sweep walks every lead
 * (~12 min) so a single restart aborts it. When one specific lead is known to be
 * out of sync — a lead just restored from bot-exclusion, or a reply the webhook
 * never delivered — there was no way to just fix that one. Now there is.
 */
export async function refreshLeadFromTimeline(
  leadId: string,
): Promise<{ ok: boolean; stored?: number; detected?: boolean; liveCreated?: boolean; error?: string }> {
  const authHeader = await getAmoAuth();
  if (!authHeader) return { ok: false, error: "no amoCRM cookies" };
  try {
    const r = await processQuickPollLead(authHeader, leadId);
    logger.info({ leadId, ...r }, "refreshLeadFromTimeline: done");
    return { ok: true, ...r };
  } catch (err) {
    logger.error({ err, leadId }, "refreshLeadFromTimeline failed");
    return { ok: false, error: String(err).slice(0, 200) };
  }
}

async function processQuickPollLead(
  authHeader: string,
  leadId: string,
): Promise<{ stored: number; detected: boolean; liveCreated: boolean }> {
  // Fetch full timeline for this lead
  let allEvents: TimelineEvent[] = [];
  let beforeTs: number | undefined;
  for (let pageNum = 0; pageNum < 10; pageNum++) {
    const events = await fetchTimeline(authHeader, leadId, 200, beforeTs);
    if (events.length === 0) break;
    allEvents.push(...events);
    const oldest = events[events.length - 1];
    const oldestTs = oldest ? eventTs(oldest) : 0;
    if (oldestTs) beforeTs = oldestTs;
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
      content: leadsSyncTable.content,
      leadNotes: leadsSyncTable.leadNotes,
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
    const ts = eventTs(ev);
    if (ev.type === 89 && ts && ts > latestIncoming) {
      latestIncoming = ts;
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
  // Refresh the conversation itself, not just the flags. content is normally
  // maintained by the Chrome extension when a broker opens the lead — on a
  // funnel nobody opens by hand it stayed frozen at the seeded advert, so every
  // draft was written as a cold first contact even though the owner had already
  // answered, and the classifier tried to drag QUALIFIED leads back down.
  let refreshedContent: string | null = null;
  try {
    const merged = await getMergedConversation(leadId, leadRow.content);
    if (merged.length > 0) refreshedContent = renderDialogContent(merged);
  } catch (err) {
    logger.warn({ err, leadId }, "timeline: could not rebuild content, keeping the old one");
  }

  await db
    .update(leadsSyncTable)
    .set({
      lastMessageFrom: "lead",
      lastMessageAt: incomingAt,
      ...(refreshedContent ? { content: refreshedContent } : {}),
      updatedAt: new Date(),
    })
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

  // NOTE: no "existing pending LIVE → skip" check here. Each NEW incoming
  // message must refresh the suggestion — the previous behavior left a stale
  // pending answer (written for an older message) sitting in the inbox, so
  // from the broker's perspective the bot stopped seeing replies after the
  // first exchange. queueSuggestion replaces any pending rows atomically.
  // The knownTs comparison above guarantees this runs at most once per message.
  let liveCreated = false;
  if (latestIncomingText) {
    liveCreated = true;
    // Debounced + re-fetched fresh at fire time — see live-reply-debounce.ts.
    // The real-time webhook can detect the same message burst independently;
    // without coalescing, each fires its own generation.
    scheduleLiveReply(leadId, async () => {
      try {
        if (await enforceBudgetFilter(leadId)) return;
        const [freshLead] = await db
          .select({
            content: leadsSyncTable.content,
            leadNotes: leadsSyncTable.leadNotes,
            leadStage: leadsSyncTable.leadStage,
            pipeline: leadsSyncTable.pipeline,
            responsibleUser: leadsSyncTable.responsibleUser,
          })
          .from(leadsSyncTable)
          .where(eq(leadsSyncTable.leadId, leadId))
          .limit(1);
        if (!freshLead) return;

        const fullEvents = await fetchTimeline(authHeader, leadId, 20);
        const allMsgs = parseTimelineEvents(leadId, fullEvents);
        const lastLeadMsg = allMsgs.filter((m) => m.direction === "inbound").pop();
        const timelineTail = allMsgs.map((m) => `${m.senderName}: ${m.text}`).join("\n");
        // The webhook-fed content has the full formatted history; the timeline
        // tail covers the newest messages the webhook may not have delivered yet.
        const contentSnippet = freshLead.content
          ? `${freshLead.content}\n\n[LATEST MESSAGES — may not be in the log above yet]\n${timelineTail.slice(-1500)}`
          : timelineTail;
        if (!lastLeadMsg) return;
        const { text, attachments } = await generateSuggestion({
          leadId,
          responsibleUser: freshLead.responsibleUser,
          kind: "live",
          lastLeadMessage: lastLeadMsg.text,
          contentSnippet,
          leadNotes: freshLead.leadNotes,
          leadStage: freshLead.leadStage,
          pipeline: freshLead.pipeline,
        });
        if (text) {
          await queueSuggestion({
            leadId,
            responsibleUser: freshLead.responsibleUser,
            kind: "live",
            text,
            attachments,
            leadMessageText: lastLeadMsg.text,
          });
        }
      } catch (err) {
        logger.error({ leadId, err }, "quick poll: LIVE generation failed");
      }
    });
  }

  logger.info({ leadId, incomingAt, liveScheduled: liveCreated }, "quick poll: new incoming processed");
  return { stored, detected: true, liveCreated };
}

// ── Quick poll scheduler: check for new messages every 2 minutes ───────────────
const QUICK_POLL_INTERVAL_MS = 45 * 1000; // 45 seconds
const QUICK_POLL_LOOKBACK_MS = 60 * 1000; // look back 1 min (overlap for safety)

let quickPollInFlight = false;

async function runQuickPoll(): Promise<void> {
  if (quickPollInFlight) {
    logger.warn("quick poll: previous run still in flight, skipping this tick");
    return;
  }
  quickPollInFlight = true;
  const QUICK_POLL_TIMEOUT_MS = 60_000; // hard limit: 60 seconds max
  const startMs = Date.now();
  try {
    await Promise.race([
      runQuickPollInner(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("quick poll timed out after 60s")), QUICK_POLL_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    if ((err as Error).message?.includes("timed out")) {
      logger.error("quick poll: timed out after 60s — forcing reset");
    } else {
      logger.error({ err }, "quick poll error");
    }
  } finally {
    quickPollInFlight = false;
    logger.info({ durationMs: Date.now() - startMs }, "quick poll: finished (flag cleared)");
  }
}

async function runQuickPollInner(): Promise<void> {
  const authHeader = await getAmoAuth();
  if (!authHeader) {
    logger.error("quick poll: no cookies");
    return;
  }

  await loadSourceMap(authHeader);

  const leadIds = await pollNewIncomingLeadIds(authHeader, QUICK_POLL_LOOKBACK_MS);
  if (leadIds.length === 0) return;

  const BATCH_SIZE = 5;
  let detected = 0;
  let liveCreated = 0;

  for (let i = 0; i < leadIds.length; i += BATCH_SIZE) {
    const batch = leadIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((leadId) =>
        Promise.race([
          processQuickPollLead(authHeader, leadId),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`lead ${leadId} timed out`)), 20_000)
          ),
        ]).catch((err) => {
          logger.warn({ leadId, err: (err as Error).message }, "quick poll: lead timed out or failed");
          return { stored: 0, detected: false, liveCreated: false };
        })
      ),
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
