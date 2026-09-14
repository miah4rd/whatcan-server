/**
 * Viewing canons on the paths a PERSON drives, and a wrapper for old callers.
 *
 * The stage that follows the thread — every message, whoever wrote it — lives
 * in lib/thread-stage-sync.ts (onThreadChanged → syncStageFromThread). Until
 * 14.09 this file held a second copy of that decision, called by the webhook
 * and the timeline sweep only; a reply amo-sync noticed first never reached
 * it. What stays here:
 *   - viewingCanons(): the send path's check when the BROKER picks a stage in
 *     /m — the slot is still read and stored, a backward move still clears it;
 *   - classifyAndApplyStage(): a thin wrapper so existing callers go through
 *     the one decision.
 */
import { db, leadsSyncTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { getPipelineStages } from "./stage-classifier";
import { backwardEvidence, extractViewingAt, syncStageFromThread, threadTranscript, type ThreadSource } from "./thread-stage-sync";

export { extractViewingAt } from "./thread-stage-sync";

const BALI = "Asia/Makassar";

function fmt(d: Date): string {
  return d.toLocaleString("en-GB", { timeZone: BALI, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export type ViewingCanonVerdict =
  | { ok: true; viewingAt?: Date; clearViewingAt: boolean }
  | { ok: false; reason: string };

/**
 * The viewing canons for a stage write on the send path:
 *   1. "Viewing done" needs the booked slot to have passed.
 *   2. Leaving a viewing stage BACKWARD needs a stated cancellation / no-show /
 *      rejection (one focused yes/no, fail-closed) and clears the slot.
 *   3. "Viewing scheduled" needs a concrete slot readable in the thread, and
 *      that slot is returned so the caller stores it.
 * A person's explicit pick is never refused (`explicit`), but the slot is
 * still read and a backward move still clears it.
 */
export async function viewingCanons(
  leadId: string,
  o: {
    fromStage: string | null | undefined;
    toStage: string;
    pipeline: string | null | undefined;
    explicit: boolean;
    /** A transcript the caller already built; read from lead_messages otherwise. */
    threadText?: string;
    /** Text leaving right now (approve), not yet in lead_messages. */
    extraText?: string;
    storedViewingAt?: Date | null;
  },
): Promise<ViewingCanonVerdict> {
  const from = (o.fromStage ?? "").toLowerCase();
  const to = o.toStage.trim().toLowerCase();
  const isViewingStage = (s: string) => /viewing/.test(s);
  const isViewingScheduled = /viewing\s*(scheduled|booked|arranged)/.test(to);
  if (!isViewingStage(from) && !isViewingStage(to)) return { ok: true, clearViewingAt: false };

  let stored = o.storedViewingAt;
  if (stored === undefined) {
    const [row] = await db.select({ viewingAt: leadsSyncTable.viewingAt }).from(leadsSyncTable).where(eq(leadsSyncTable.leadId, leadId)).limit(1);
    stored = row?.viewingAt ?? null;
  }
  let text = o.threadText ?? (await threadTranscript(leadId));
  if (o.extraText?.trim()) text = `${text}\n${fmt(new Date())} Broker: ${o.extraText.replace(/\s+/g, " ").trim()}`;

  if (/viewing\s*done/.test(to) && stored && stored.getTime() > Date.now() && !o.explicit) {
    return { ok: false, reason: `canon: booked slot ${fmt(stored)} has not come yet — cannot be "Viewing done"` };
  }

  let clearViewingAt = false;
  if (isViewingStage(from) && from !== to) {
    const order = await getPipelineStages(o.pipeline ?? "");
    const idx = (name: string) => order?.all.findIndex((s) => s.name.trim().toLowerCase() === name) ?? -1;
    const backward = idx(to) >= 0 && idx(from) >= 0 && idx(to) < idx(from);
    if (backward) {
      if (!o.explicit) {
        const ev = await backwardEvidence(o.fromStage ?? "", o.toStage, text);
        if (!ev.confirmed) {
          return { ok: false, reason: `canon: leaving ${o.fromStage} backward needs a stated cancellation/no-show/rejection — none found (${ev.why})` };
        }
        logger.info({ leadId, from: o.fromStage, to: o.toStage, why: ev.why }, "viewing regression confirmed by evidence");
      }
      clearViewingAt = true;
    }
  }

  if (isViewingScheduled) {
    const viewingAt = await extractViewingAt(text);
    if (!viewingAt && !o.explicit) {
      return { ok: false, reason: "canon: Viewing scheduled needs a concrete slot in the thread (ahead or ≤2 days past) — none found" };
    }
    return viewingAt ? { ok: true, viewingAt, clearViewingAt: false } : { ok: true, clearViewingAt: false };
  }
  return { ok: true, clearViewingAt };
}

export type StageApplyResult = { moved: boolean; from?: string | null; to?: string; reason: string; viewingAt?: Date | null };

const SOURCE: Record<"manual-reply" | "backfill" | "viewing-outcome" | "inbound", ThreadSource> = {
  "manual-reply": "phone",
  backfill: "backfill",
  "viewing-outcome": "viewing-outcome",
  inbound: "inbound",
};

/** Kept for existing callers: the thread decides, through the one decision in thread-stage-sync.ts. */
export async function classifyAndApplyStage(
  leadId: string,
  opts: { source: "manual-reply" | "backfill" | "viewing-outcome" | "inbound"; apply?: boolean; replyText?: string },
): Promise<StageApplyResult> {
  const r = await syncStageFromThread(leadId, { sources: [SOURCE[opts.source]], apply: opts.apply });
  return { moved: r.moved, from: r.from, to: r.to ?? undefined, reason: r.reason, viewingAt: r.viewingAt ?? null };
}
