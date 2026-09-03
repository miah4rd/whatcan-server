import { db, leadMessagesTable, sentMessagesTable } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { parseDialogContent } from "./dialog-parser";
import { shouldSuppressPush, isClosedWonStage, isPostSigningStage } from "./stage-routing";
import { isPushStageAllowed, usesOwnStageVocabulary } from "./push-stage-whitelist";
import { isReachStageName } from "./pipelines";
import { isRentalScopedBroker, isHosTrackedPipeline } from "./adaptive-followup";

// Shared visibility rules for pending suggestions. This is the single source of
// truth used both by the /suggestions inbox route AND the push-notification
// badge counter — if these two ever apply different rules, the number on the
// app icon diverges from what the broker actually sees in the inbox.

export interface PendingRowLike {
  leadId: string;
  kind: string;
  responsibleUser: string | null;
  /** Set when a broker asked for this draft by hand — it bypasses the
   * "a future task is already scheduled, don't prompt" snooze, which otherwise
   * hid the draft they had just requested. */
  requestedAt?: Date | null;
  /** Why autopilot did not send it (null = it sent it, or was never asked). */
  autopilotSkippedReason?: string | null;
  /** When the draft was written — used only as a safety net below. */
  createdAt?: Date | null;
}

/**
 * Stage names each funnel has delegated to autopilot, lowercased.
 * Built once per request by the caller; empty map = nothing delegated.
 */
export type DelegatedStages = Map<string, Set<string>>;

/**
 * A draft on a delegated stage is the BOT's job, not the broker's.
 *
 * Showing it for approval invites someone to send by hand a message the bot is
 * about to send itself, which is the owner's objection: "брокер по ошибке может
 * запушить какое-то сообщение на этапе, которая уже стоит в автопилоте".
 *
 * The exception is the whole point of the rule: a draft autopilot COULD NOT
 * deliver — a duplicate WhatsApp thread, a deleted card — is precisely the case
 * that needs a person, so it stays visible. Reasons that begin with "waiting"
 * are temporary by construction (tomorrow's budget, outreach hours) and the bot
 * will send those itself.
 */
function autopilotOwnsThisDraft(r: PendingRowLike, stage: string, pipeline: string | null | undefined, delegated?: DelegatedStages): boolean {
  if (!delegated || delegated.size === 0) return false;
  const stages = delegated.get((pipeline ?? "").trim().toLowerCase());
  if (!stages?.has(stage.trim().toLowerCase())) return false;

  const reason = (r.autopilotSkippedReason ?? "").trim();
  if (reason && !reason.startsWith("waiting")) return false; // stuck — a person is needed

  // Safety net: autopilot fires the moment a draft is written, so one still
  // carrying no verdict half an hour later was never processed. Better a draft
  // the broker did not need to see than one nobody ever sees.
  if (!reason && r.createdAt && Date.now() - r.createdAt.getTime() > 30 * 60 * 1000) return false;

  return true;
}

export interface SyncRowLike {
  botExcluded: boolean | null;
  leadStage: string | null;
  pipeline: string | null;
  nextFollowupAt: Date | null;
  lastMessageFrom: string | null;
  content: string | null;
  liveDismissedAt?: Date | null;
}

/** Max timestamps per side, derived from lead_messages (the timeline poll, which
 * — unlike webhook-fed content — DOES capture our outgoing WhatsApp replies,
 * including ones a broker sent manually from the phone). */
export interface RepliedSignal {
  lastLeadAt: number; // ms; newest inbound (lead) message
  lastOursAt: number; // ms; newest outbound (broker/bot/us) message
  /** When the automatic ad-lead welcome went out, if it did. Outbound at or
   * before this instant is NOT us speaking — see AD_AUTO_KIND. */
  adWelcomeAtMs?: number;
}

/**
 * Marks the automatic ad-lead welcome in `sent_messages`. Defined here because
 * the visibility rules are the thing that has to know about it; the sender
 * (`ad-lead-autoreply.ts`) re-exports this constant rather than declaring a
 * second one.
 */
export const AD_AUTO_KIND = "ad_auto";

/**
 * The automatic welcome is a machine courtesy, not a broker speaking.
 *
 * A LIVE draft is shown only when the client spoke last. The ad-lead second
 * touch is raised on the exact opposite condition — 15 minutes of SILENCE — so
 * if the welcome counted as our reply, every broker-opening draft would be
 * created and then hidden by this very file. It would never reach the inbox.
 *
 * Rather than exempt the draft (which would carve a hole in the rule that keeps
 * answered leads out of LIVE), we discount the messages that are not a
 * conversation turn. The welcome is always the FIRST outbound on an ad lead —
 * `sendAdLeadWelcome` refuses to open a conversation twice — so everything up
 * to it is the welcome and nothing else. The moment a broker actually sends the
 * opening, that outbound lands after the window, counts normally, and the
 * lead leaves LIVE the way any answered lead does.
 *
 * The window, not the instant: the welcome is deliberately TWO messages — text
 * first, then the link on its own, because a bare link from an unknown number
 * is what spam looks like to WhatsApp. `sent_messages` records the delivery
 * once, at the text, so a cutoff at that instant leaves the link counting as a
 * reply and hides the draft anyway. Links are paced 3s then 1.2s apart
 * (`outbound-send.ts`), so the burst is over in seconds; WELCOME_BURST_MS is
 * set far above that and far below any human reply time.
 */
const WELCOME_BURST_MS = 60_000;
export async function loadReplySignals(leadIds: string[]): Promise<Map<string, RepliedSignal>> {
  const out = new Map<string, RepliedSignal>();
  if (leadIds.length === 0) return out;

  const welcomeRows = await db
    .select({
      leadId: sentMessagesTable.leadId,
      atMs: sql<string>`coalesce(extract(epoch from max(${sentMessagesTable.createdAt})) * 1000, 0)`,
    })
    .from(sentMessagesTable)
    .where(and(inArray(sentMessagesTable.leadId, leadIds), eq(sentMessagesTable.kind, AD_AUTO_KIND)))
    .groupBy(sentMessagesTable.leadId);
  const welcomeByLead = new Map(welcomeRows.map((r) => [r.leadId, Number(r.atMs) || 0]));

  // Per-lead aggregate, not a capped row fetch: a global LIMIT can miss an
  // older lead's messages entirely, which is what used to strand answered
  // leads in LIVE.
  const rows = await db
    .select({
      leadId: leadMessagesTable.leadId,
      lastLeadMs: sql<string>`coalesce(extract(epoch from max(${leadMessagesTable.sentAt}) filter (where ${leadMessagesTable.senderType} = 'lead')) * 1000, 0)`,
      // A PLAIN aggregate. The welcome discount used to live inside this FILTER
      // as a correlated subquery, and it returned 0 for every lead — our own
      // outgoing messages were plainly in the table, the same aggregate typed by
      // hand gave the right timestamp, and the endpoint still saw zero. Zero is
      // always smaller than the lead's last message, so every answered lead
      // stayed in LIVE forever however many times we replied. The discount does
      // not need to be in SQL at all: `welcomeByLead` is already loaded above.
      lastOursMs: sql<string>`coalesce(extract(epoch from max(${leadMessagesTable.sentAt}) filter (
        where ${leadMessagesTable.senderType} <> 'lead'
      )) * 1000, 0)`,
    })
    .from(leadMessagesTable)
    .where(inArray(leadMessagesTable.leadId, leadIds))
    .groupBy(leadMessagesTable.leadId);

  for (const r of rows) {
    const welcomeAt = welcomeByLead.get(r.leadId) ?? 0;
    const lastOurs = Number(r.lastOursMs) || 0;
    // Same rule the subquery meant to express: the automatic welcome is not a
    // turn in the conversation. Since `lastOurs` is the MAXIMUM, it falling
    // inside the welcome burst means every message we sent is the welcome —
    // exactly the case the discount is for.
    const oursDiscounted = welcomeAt && lastOurs && lastOurs <= welcomeAt + WELCOME_BURST_MS ? 0 : lastOurs;
    out.set(r.leadId, {
      lastLeadAt: Number(r.lastLeadMs) || 0,
      lastOursAt: oursDiscounted,
      adWelcomeAtMs: welcomeAt,
    });
  }
  // A lead with a welcome but no timeline rows yet still needs the discount.
  for (const [leadId, atMs] of welcomeByLead) {
    if (!out.has(leadId)) out.set(leadId, { lastLeadAt: 0, lastOursAt: 0, adWelcomeAtMs: atMs });
  }
  return out;
}

/** Fold a lead's timeline rows into the max inbound/outbound timestamps. */
export function repliedSignalFromTimeline(
  msgs: Array<{ senderType: string; sentAt: Date }>,
): RepliedSignal {
  let lastLeadAt = 0;
  let lastOursAt = 0;
  for (const m of msgs) {
    const t = m.sentAt?.getTime?.() ?? 0;
    if (m.senderType === "lead") lastLeadAt = Math.max(lastLeadAt, t);
    else lastOursAt = Math.max(lastOursAt, t);
  }
  return { lastLeadAt, lastOursAt };
}

export function isPendingVisible(
  r: PendingRowLike,
  sync: SyncRowLike | undefined,
  pushWhitelist: string[],
  /** Newest inbound/outbound timestamps from lead_messages. Pass it whenever
   * available — it's the only source that sees our outgoing WhatsApp replies
   * when the webhook-fed `content` has frozen. */
  timeline?: RepliedSignal,
  /** Stage names each funnel has handed to autopilot. */
  delegatedStages?: DelegatedStages,
): boolean {
  // Never show bot-excluded leads
  if (sync?.botExcluded) return false;

  // Never show leads on dead stages — closed, lost, incorrect information, incoming leads, etc.
  // Uses the same suppression list as the push scheduler for consistency.
  // EXCEPTION: a Closed-WON lead (deal done) is finished for proactive PUSH, but
  // if that past client writes again it should still surface in LIVE — a warm
  // client reaching out. Everything else dead (lost / not active / incorrect /
  // incoming) stays hidden in every tab.
  const stage = sync?.leadStage ?? "";
  if (stage && shouldSuppressPush(stage)) {
    // Same exception for a client mid-handover (CHECK IN / inventory): no
    // proactive chasing, but they are actively moving in and their questions
    // must not vanish from the inbox.
    const liveExempt = isClosedWonStage(stage) || isPostSigningStage(stage);
    if (!(r.kind === "live" && liveExempt)) return false;
  }

  if (autopilotOwnsThisDraft(r, stage, sync?.pipeline, delegatedStages)) return false;

  // Push tab: only show stages in the dynamic whitelist (configurable via /api/admin/push-stages).
  // Pipelines with their own stage vocabulary (Rental, Rental Listings) match none of this
  // Unicorn-oriented whitelist, so they're exempted here the same way they're exempted during
  // generation in followup-scheduler.ts — see usesOwnStageVocabulary for what a missed
  // exemption costs.
  // REACH-stage leads (1st/2nd/final follow up = qualification) are ALSO push-kind but
  // live in the extension's REACH tab — they're never in the CE/NA/OS whitelist, so
  // exempt them too (same bypass the scheduler uses), otherwise the REACH tab is empty.
  const ownVocabulary = usesOwnStageVocabulary(sync?.pipeline);
  const isReachStage = isReachStageName(stage);
  if (r.kind === "push" && !ownVocabulary && !isReachStage && !isPushStageAllowed(pushWhitelist, stage)) return false;

  // Push tab: exclude Shanti Agencies pipeline — different business, not part of this copilot
  if (r.kind === "push" && sync?.pipeline === "Shanti Agencies") return false;

  // Rental-scoped brokers (HoS, Yudi, ...): scoped to Rental pipeline only —
  // leads from other pipelines (e.g. Unicorn) are excluded entirely, live and
  // push alike. Roster shared with isAdaptiveBroker (adaptive-followup.ts).
  if (isRentalScopedBroker(r.responsibleUser) && !isHosTrackedPipeline(sync?.pipeline)) return false;

  // Push tab: hide if lead has a FUTURE task — broker has already scheduled it.
  // amo-sync Pass 0 deletes these, but there's a 0–5 min window. This real-time
  // guard ensures the push never surfaces while nextFollowupAt is in the future.
  if (r.kind === "push") {
    const BALI_OFFSET_MS = 8 * 60 * 60 * 1000;
    const nowBali = new Date(Date.now() + BALI_OFFSET_MS);
    const endOfTodayBali = new Date(
      Date.UTC(nowBali.getUTCFullYear(), nowBali.getUTCMonth(), nowBali.getUTCDate() + 1) - BALI_OFFSET_MS,
    );
    if (!r.requestedAt && sync?.nextFollowupAt && sync.nextFollowupAt > endOfTodayBali) return false;
  }

  if (r.kind !== "live") return true;

  // ── Has the broker already answered this LIVE? ────────────────────────────
  // Decide from WHO SPOKE LAST, using the most complete view we have:
  //   • leads_sync.content — webhook-fed, but for WhatsApp/manual-from-phone
  //     replies it FREEZES and never records our outgoing message;
  //   • lead_messages (timeline poll) — DOES capture our outgoing WhatsApp reply.
  // Take the newest inbound vs newest outbound across BOTH sources. Using max()
  // per side is robust to the bulk-import timestamp collapse (equal ties → treat
  // as answered), which is exactly the owner's complaint: answered leads that
  // were stuck in LIVE forever because the bot never saw our reply.
  let cLeadMs = 0;
  let cOursMs = 0;
  // Same discount as loadReplySignals: the automatic welcome is not a turn in
  // the conversation, wherever we read it from.
  const welcomeMs = timeline?.adWelcomeAtMs ? timeline.adWelcomeAtMs + WELCOME_BURST_MS : 0;
  if (sync?.content) {
    try {
      const parsed = parseDialogContent(sync.content);
      for (const m of parsed.messages) {
        const t = m.at?.getTime?.() ?? 0;
        if (m.from === "us") {
          if (welcomeMs && t <= welcomeMs) continue;
          cOursMs = Math.max(cOursMs, t);
        } else cLeadMs = Math.max(cLeadMs, t);
      }
    } catch {
      // ignore parse errors
    }
  }

  const lastLeadMs = Math.max(cLeadMs, timeline?.lastLeadAt ?? 0);
  const lastOursMs = Math.max(cOursMs, timeline?.lastOursAt ?? 0);

  if (lastLeadMs === 0) return true;    // never saw a lead message → don't hide

  // Broker explicitly dismissed this LIVE ("No reply needed" / "Already replied").
  // Honour it until a NEWER lead message arrives — otherwise the max-timestamp
  // rule below would keep re-raising a lead that genuinely spoke last but that
  // the broker already decided needs no answer.
  const dismissedMs = sync?.liveDismissedAt ? sync.liveDismissedAt.getTime() : 0;
  if (dismissedMs >= lastLeadMs) return false;

  return lastLeadMs > lastOursMs;        // show only if the lead genuinely spoke last
}

// Deduplicate push suggestions by leadId — keep only the first pending push per
// lead. Duplicates can appear due to scheduler race conditions (concurrent runs
// both passing the existing-push check before either insert commits).
export function dedupePushPerLead<T extends PendingRowLike>(rows: T[]): T[] {
  const seenLeadIds = new Set<string>();
  return rows.filter((r) => {
    if (r.kind !== "push") return true;
    if (seenLeadIds.has(r.leadId)) return false;
    seenLeadIds.add(r.leadId);
    return true;
  });
}
