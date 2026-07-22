import { Router } from "express";
import { db, pendingSuggestionsTable, leadsSyncTable } from "@workspace/db";
import { desc, inArray, eq, and, sql } from "drizzle-orm";
import { parseDialogContent } from "../../lib/dialog-parser";
import { shouldSuppressPush } from "../../lib/stage-routing";
import { getPushStageWhitelist, isPushStageAllowed } from "../../lib/push-stage-whitelist";

const router = Router();

router.options("/suggestions", (_req, res) => res.sendStatus(204));

router.get("/suggestions", async (req, res) => {
  const kind = req.query["kind"] as string | undefined;
  const responsibleUser = req.query["responsibleUser"] as string | undefined;

  try {
    const [results, pushWhitelist] = await Promise.all([
      db
        .select()
        .from(pendingSuggestionsTable)
        // Sort newest leads first: AmoCRM lead IDs are auto-incrementing,
        // so higher ID = more recently created lead in CRM.
        .orderBy(sql`CASE WHEN ${pendingSuggestionsTable.leadId} ~ '^[0-9]+$' THEN ${pendingSuggestionsTable.leadId}::bigint ELSE 0 END DESC`),
      getPushStageWhitelist(),
    ]);

    const allPending = results.filter((r) => r.status === "pending");

    // Fetch leads_sync for ALL pending items upfront — needed for LIVE staleness check
    const allLeadIds = [...new Set(allPending.map((i) => i.leadId))];
    const syncRows =
      allLeadIds.length > 0
        ? await db
            .select({
              leadId: leadsSyncTable.leadId,
              content: leadsSyncTable.content,
              leadNotes: leadsSyncTable.leadNotes,
              leadStage: leadsSyncTable.leadStage,
              leadStageId: leadsSyncTable.leadStageId,
              lastMessageAt: leadsSyncTable.lastMessageAt,
              lastMessageFrom: leadsSyncTable.lastMessageFrom,
              lastOurMessageAt: leadsSyncTable.lastOurMessageAt,
              nextFollowupAt: leadsSyncTable.nextFollowupAt,
              updatedAt: leadsSyncTable.updatedAt,
              botExcluded: leadsSyncTable.botExcluded,
              pipeline: leadsSyncTable.pipeline,
            })
            .from(leadsSyncTable)
            .where(inArray(leadsSyncTable.leadId, allLeadIds))
        : [];

    const syncByLeadId = new Map(syncRows.map((r) => [r.leadId, r]));

    let items = allPending.filter((r) => {
      const sync = syncByLeadId.get(r.leadId);

      // Never show bot-excluded leads
      if (sync?.botExcluded) return false;

      // Never show leads on dead stages — closed, lost, incorrect information, incoming leads, etc.
      // Uses the same suppression list as the push scheduler for consistency.
      const stage = sync?.leadStage ?? "";
      if (stage && shouldSuppressPush(stage)) return false;

      // Push tab: only show stages in the dynamic whitelist (configurable via /api/admin/push-stages)
      if (r.kind === "push" && !isPushStageAllowed(pushWhitelist, stage)) return false;

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

      // Rule 1: if DB already knows broker replied last → LIVE is stale.
      if (sync?.lastMessageFrom === "us") return false;

      // Rule 2: real-time content check — catches the race condition where
      // broker replied via SalesBot/external tool but the webhook hasn't arrived yet.
      // Parse the actual dialog content and check who sent the last message.
      if (sync?.content) {
        try {
          const parsed = parseDialogContent(sync.content);
          if (parsed.lastMessage?.from === "us") return false;
        } catch {
          // ignore parse errors
        }
      }

      return true;
    });

    if (kind === "live" || kind === "push") items = items.filter((r) => r.kind === kind);
    if (responsibleUser) items = items.filter((r) => r.responsibleUser === responsibleUser);

    // Deduplicate push suggestions by leadId — keep only the first (oldest) pending push
    // per lead. Duplicates can appear due to scheduler race conditions (concurrent runs
    // both passing the existing-push check before either insert commits).
    {
      const seenLeadIds = new Set<string>();
      items = items.filter((r) => {
        if (r.kind !== "push") return true;
        if (seenLeadIds.has(r.leadId)) return false;
        seenLeadIds.add(r.leadId);
        return true;
      });
    }

    const enrichedRaw = items.map((i) => {
      const sync = syncByLeadId.get(i.leadId);
      const content = sync?.content ?? "";
      let lastLeadText: string | null = null;
      let recentMessages: Array<{ from: string; senderName: string; text: string; at: string; channel: string | null }> = [];
      let brokerRepliedAfterSuggestion = false;
      let lastLeadChannel: string | null = null;

      let leadName: string | null = null;

      if (content) {
        try {
          const dialog = parseDialogContent(content);
          lastLeadText = dialog.lastLeadMessage?.text ?? null;
          lastLeadChannel = dialog.lastLeadChannel;
          // Extract lead's display name from first message that has a real sender name
          const leadMsg = dialog.messages.find(
            (m) => m.from === "lead" && m.senderName && m.senderName.trim().length > 1,
          );
          // Strip AmoCRM sender suffix: "Name (клиент - source)" → "Name"
          leadName = leadMsg?.senderName
            ? (leadMsg.senderName.replace(/\s*\([^)]*\)\s*$/, "").trim() || leadMsg.senderName)
            : null;
          recentMessages = dialog.messages.slice(-8).map((m) => ({
            from: m.from,
            senderName: m.senderName,
            text: m.text,
            at: m.at.toISOString(),
            channel: m.channel ?? null,
          }));

          // Content-based stale check: if last message in dialog is from "us"
          // (broker or automated bot), the lead's question was already answered.
          // No time comparison needed — if "us" is last in content, LIVE is stale.
          if (i.kind === "live" && dialog.lastMessage?.from === "us") {
            brokerRepliedAfterSuggestion = true;
          }
        } catch {
          // ignore parse errors
        }
      }

      return {
        ...i,
        suggestion_text: i.suggestionText,
        lead_id: i.leadId,
        responsible_user: i.responsibleUser,
        followup_level: i.followupLevel,
        triggered_by_message_at: i.triggeredByMessageAt,
        created_at: i.createdAt,
        last_lead_text: lastLeadText,
        recent_messages: recentMessages,
        lead_name: leadName,
        lead_notes: sync?.leadNotes ?? null,
        lead_stage: sync?.leadStage ?? null,
        lead_stage_id: sync?.leadStageId ?? null,
        last_message_at: sync?.lastMessageAt?.toISOString() ?? null,
        next_followup_at: sync?.nextFollowupAt?.toISOString() ?? null,
        last_lead_channel: lastLeadChannel,
        _brokerReplied: brokerRepliedAfterSuggestion,
      };
    });

    const enriched = enrichedRaw.filter((i) => !i._brokerReplied);

    // ── Stage priority map ───────────────────────────────────────────────────
    // Everything BEFORE "Needs Assessed" = unqualified = highest priority (1–20).
    // Lead hasn't told us budget/goals yet — broker must follow up ASAP to qualify.
    //
    // Everything FROM "Needs Assessed" onward = already qualified (50+).
    // These leads know what they want; they're in active sales, not intro follow-up.
    //
    // Within each rank group leads are sorted newest first (highest AmoCRM ID).
    const STAGE_RANK: Record<string, number> = {
      // ── Unqualified track ────────────────────────────────────────────────
      "new lead":                          1,   // just arrived, needs brochure intro
      "in progress":                       2,   // same-day follow-up
      "1st follow up (next day)":          3,
      "2nd follow up (3 days after)":      4,
      "final follow up (5 days after)":    5,  // actual amoCRM stage name
      "final follow up (1 week after)":    5,  // legacy variant
      "shanti 5th msg (after 5 days)":     6,
      "lead assigned":                     7,   // Ф5 new assignment
      "taken to work":                     8,
      "contact established":               9,   // replied but not yet qualified
      "mailing":                           10,
      "long-term cycle":                   11,
      // ── Qualified track (already assessed) ──────────────────────────────
      "needs assessed":                    50,
      "options sent":                      51,
      "option send":                       51,  // alt spelling
      "zoom call scheduled":               52,
      "viewing scheduled":                 53,
      "feedback / handling objections":    54,
      "reservation":                       55,
      "negotiations":                      56,
      "contract signed":                   57,
      "closed - won":                      58,
    };

    function stageRank(stage: string | null): number {
      if (!stage) return 99;
      return STAGE_RANK[stage.toLowerCase()] ?? 99;
    }

    // ── PUSH-specific sort: task urgency (today → overdue asc → no task) ────
    // For PUSH suggestions, nextFollowupAt encodes the amoCRM task date:
    //   today's task  → nextFollowupAt ≈ now (>= today midnight Bali)
    //   overdue task  → nextFollowupAt = actualTaskDate (past date)
    //   no task       → nextFollowupAt = null
    // Within PUSH we sort by urgency; for LIVE we keep the existing stage rank.
    const hasPushItems = enriched.some((i) => i.kind === "push");
    if (hasPushItems && (!kind || kind === "push")) {
      const BALI_OFFSET_MS = 8 * 60 * 60 * 1000;
      const nowMs = Date.now();
      const nowBali = new Date(nowMs + BALI_OFFSET_MS);
      const todayStartBali = new Date(
        Date.UTC(nowBali.getUTCFullYear(), nowBali.getUTCMonth(), nowBali.getUTCDate()) - BALI_OFFSET_MS,
      );

      const taskGroup = (item: (typeof enriched)[0]): number => {
        if (item.kind !== "push") return 0; // LIVE items sort first by stage rank, handled below
        const nfa = item.next_followup_at ? new Date(item.next_followup_at) : null;
        if (!nfa) return 3; // no task → last
        if (nfa >= todayStartBali) return 1; // today's task → first
        return 2; // overdue → middle
      };

      enriched.sort((a, b) => {
        const ga = taskGroup(a);
        const gb = taskGroup(b);
        if (ga !== gb) return ga - gb;

        if (a.kind === "push" && b.kind === "push") {
          const nfaA = a.next_followup_at ? new Date(a.next_followup_at).getTime() : null;
          const nfaB = b.next_followup_at ? new Date(b.next_followup_at).getTime() : null;
          if (ga === 2) {
            // Overdue: ascending (oldest overdue first)
            if (nfaA !== null && nfaB !== null) return nfaA - nfaB;
          }
        }

        // Default: newest lead first
        try { return Number(BigInt(b.lead_id) - BigInt(a.lead_id)); } catch { return 0; }
      });
    } else {
      enriched.sort((a, b) => {
        const rankDiff = stageRank(a.lead_stage) - stageRank(b.lead_stage);
        if (rankDiff !== 0) return rankDiff;
        // Within same stage group: newest lead first (higher AmoCRM ID = newer)
        try { return Number(BigInt(b.lead_id) - BigInt(a.lead_id)); } catch { return 0; }
      });
    }

    res.json({ items: enriched });
  } catch (err) {
    req.log.error({ err }, "suggestions fetch error");
    res.status(500).json({ error: "DB error" });
  }
});

// Called by Chrome extension when broker already replied outside the extension
// (e.g. via WhatsApp directly or WAHelp bot) and the LIVE suggestion is stale.
router.options("/broker-replied", (_req, res) => res.sendStatus(204));
router.post("/broker-replied", async (req, res) => {
  const { leadId } = req.body as { leadId?: string };
  if (!leadId) return void res.status(400).json({ error: "leadId required" });

  try {
    await Promise.all([
      // Mark broker as last sender in leads_sync so future polls skip this LIVE
      db
        .update(leadsSyncTable)
        .set({ lastMessageFrom: "us", nextFollowupAt: null })
        .where(eq(leadsSyncTable.leadId, leadId)),
      // Delete ALL pending suggestions for this lead (both live and push)
      db
        .update(pendingSuggestionsTable)
        .set({ status: "skipped" })
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, leadId),
            eq(pendingSuggestionsTable.status, "pending"),
          ),
        ),
    ]);
    req.log.info({ leadId }, "broker-replied: cleared stale LIVE suggestion");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "broker-replied error");
    res.status(500).json({ error: "DB error" });
  }
});

export default router;
