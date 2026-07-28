import { parseDialogContent } from "./dialog-parser";
import { shouldSuppressPush, isClosedWonStage } from "./stage-routing";
import { isPushStageAllowed } from "./push-stage-whitelist";

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
}

/** Newest row from lead_messages for a lead — see lib/conversation-state.ts. */
export interface NewestTimelineMessage {
  senderType: string;
  sentAt: Date;
}

export function isPendingVisible(
  r: PendingRowLike,
  sync: SyncRowLike | undefined,
  pushWhitelist: string[],
  /** Pass it whenever available: without it, a lead whose webhook stopped
   * delivering has their LIVE hidden by the stale-content rule below. */
  newestTimeline?: NewestTimelineMessage,
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
  if (r.responsibleUser === "HoS" && (sync?.pipeline ?? "").toLowerCase() !== "rental") return false;

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

  // ── Is this LIVE stale (i.e. have we already answered the lead)? ───────────
  // Both signals below read leads_sync, which is webhook-fed and for some
  // channels (Instagram) silently stops updating. The timeline poll keeps
  // writing to lead_messages regardless, so when the two disagree the timeline
  // is the one telling the truth. Without this, a genuine reply produced a
  // correct LIVE suggestion that these rules then hid from the broker — the
  // inbox said "All caught up" while the client sat waiting.
  let contentLastMs = 0;
  let contentSaysWeReplied = false;
  if (sync?.content) {
    try {
      const parsed = parseDialogContent(sync.content);
      contentLastMs = parsed.lastMessage?.at?.getTime() ?? 0;
      contentSaysWeReplied = parsed.lastMessage?.from === "us";
    } catch {
      // ignore parse errors
    }
  }

  const timelineSaysLeadReplied =
    !!newestTimeline &&
    newestTimeline.senderType === "lead" &&
    newestTimeline.sentAt.getTime() > contentLastMs + 60_000;
  if (timelineSaysLeadReplied) return true;

  // Rule 1: DB says the broker spoke last → LIVE is stale.
  if (sync?.lastMessageFrom === "us") return false;

  // Rule 2: content says the broker spoke last — catches a reply sent via
  // SalesBot or an external tool before its webhook lands.
  if (contentSaysWeReplied) return false;

  return true;
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
