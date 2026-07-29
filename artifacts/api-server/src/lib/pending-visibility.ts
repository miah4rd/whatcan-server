import { parseDialogContent } from "./dialog-parser";
import { shouldSuppressPush, isClosedWonStage } from "./stage-routing";
import { isPushStageAllowed } from "./push-stage-whitelist";
import { isBroker, brokerKey } from "./broker-identity";

// Shared visibility rules for pending suggestions. This is the single source of
// truth used both by the /suggestions inbox route AND the push-notification
// badge counter — if these two ever apply different rules, the number on the
// app icon diverges from what the broker actually sees in the inbox.

export interface PendingRowLike {
  leadId: string;
  kind: string;
  responsibleUser: string | null;
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
    if (!(r.kind === "live" && isClosedWonStage(stage))) return false;
  }

  // Push tab: only show stages in the dynamic whitelist (configurable via /api/admin/push-stages).
  // Rental pipeline uses its own stage vocabulary (Qualified, New LEAD, Options sent,
  // N foolow up) that doesn't overlap with this Unicorn-oriented whitelist, so it's
  // exempted here the same way it's exempted during generation in followup-scheduler.ts.
  // REACH-stage leads (1st/2nd/final follow up = qualification) are ALSO push-kind but
  // live in the extension's REACH tab — they're never in the CE/NA/OS whitelist, so
  // exempt them too (same bypass the scheduler uses), otherwise the REACH tab is empty.
  const isRentalLead = (sync?.pipeline ?? "").toLowerCase() === "rental";
  const isReachStage = ["1st follow up", "2nd follow up", "final follow up"].some((k) =>
    stage.toLowerCase().includes(k),
  );
  if (r.kind === "push" && !isRentalLead && !isReachStage && !isPushStageAllowed(pushWhitelist, stage)) return false;

  // Push tab: exclude Shanti Agencies pipeline — different business, not part of this copilot
  if (r.kind === "push" && sync?.pipeline === "Shanti Agencies") return false;

  // HoS account: scoped to Rental pipeline only — leads from other pipelines
  // (e.g. Unicorn) are excluded entirely for this broker, live and push alike.
  if (isBroker(r.responsibleUser, "HoS") && (sync?.pipeline ?? "").toLowerCase() !== "rental") return false;

  // Push tab: hide if lead has a FUTURE task — broker has already scheduled it.
  // amo-sync Pass 0 deletes these, but there's a 0–5 min window. This real-time
  // guard ensures the push never surfaces while nextFollowupAt is in the future.
  if (r.kind === "push") {
    const BALI_OFFSET_MS = 8 * 60 * 60 * 1000;
    const nowBali = new Date(Date.now() + BALI_OFFSET_MS);
    const endOfTodayBali = new Date(
      Date.UTC(nowBali.getUTCFullYear(), nowBali.getUTCMonth(), nowBali.getUTCDate() + 1) - BALI_OFFSET_MS,
    );
    if (sync?.nextFollowupAt && sync.nextFollowupAt > endOfTodayBali) return false;
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
  if (sync?.content) {
    try {
      const parsed = parseDialogContent(sync.content);
      for (const m of parsed.messages) {
        const t = m.at?.getTime?.() ?? 0;
        if (m.from === "us") cOursMs = Math.max(cOursMs, t);
        else cLeadMs = Math.max(cLeadMs, t);
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
