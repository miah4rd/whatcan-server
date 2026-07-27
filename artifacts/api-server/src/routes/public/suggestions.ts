import { Router } from "express";
import { db, pendingSuggestionsTable, leadsSyncTable, leadMessagesTable } from "@workspace/db";
import { desc, inArray, eq, and, sql } from "drizzle-orm";
import { parseDialogContent, countTrailingOurMessages } from "../../lib/dialog-parser";
import { getPushStageWhitelist } from "../../lib/push-stage-whitelist";
import { computePushPriority, isAdaptiveBroker } from "../../lib/adaptive-followup";
import { isPendingVisible, dedupePushPerLead } from "../../lib/pending-visibility";

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
              amoCreatedAt: leadsSyncTable.amoCreatedAt,
              profileTemperature: leadsSyncTable.profileTemperature,
              profilePotential: leadsSyncTable.profilePotential,
              profileOpenQuestion: leadsSyncTable.profileOpenQuestion,
              profileAlive: leadsSyncTable.profileAlive,
              profileSummary: leadsSyncTable.profileSummary,
              discardFlaggedAt: leadsSyncTable.discardFlaggedAt,
              discardReason: leadsSyncTable.discardReason,
            })
            .from(leadsSyncTable)
            .where(inArray(leadsSyncTable.leadId, allLeadIds))
        : [];

    const syncByLeadId = new Map(syncRows.map((r) => [r.leadId, r]));

    // Timeline-synced messages (lead_messages) are fresher than leads_sync.content,
    // which only updates when an amoCRM webhook fires. Without merging these in,
    // the conversation view lags behind and the broker thinks the bot "didn't see"
    // the lead's newest reply.
    const timelineMsgRows =
      allLeadIds.length > 0
        ? await db
            .select({
              leadId: leadMessagesTable.leadId,
              senderType: leadMessagesTable.senderType,
              senderName: leadMessagesTable.senderName,
              text: leadMessagesTable.text,
              channel: leadMessagesTable.channel,
              sentAt: leadMessagesTable.sentAt,
            })
            .from(leadMessagesTable)
            .where(inArray(leadMessagesTable.leadId, allLeadIds))
            .orderBy(desc(leadMessagesTable.sentAt))
            .limit(600)
        : [];
    const timelineMsgsByLead = new Map<string, typeof timelineMsgRows>();
    for (const m of timelineMsgRows) {
      const arr = timelineMsgsByLead.get(m.leadId);
      if (arr) { if (arr.length < 15) arr.push(m); }
      else timelineMsgsByLead.set(m.leadId, [m]);
    }

    // Visibility rules are shared with the push-notification badge counter
    // (lib/pending-visibility.ts) so the icon number always matches the inbox.
    let items = allPending.filter((r) => isPendingVisible(r, syncByLeadId.get(r.leadId), pushWhitelist));

    if (kind === "live" || kind === "push") items = items.filter((r) => r.kind === kind);
    if (responsibleUser) {
      const wanted = responsibleUser.trim().toLowerCase();
      items = items.filter((r) => (r.responsibleUser ?? "").trim().toLowerCase() === wanted);
    }

    // Unicorn brokers see ONLY their Unicorn-pipeline leads — even if a lead of
    // theirs sits in another pipeline (e.g. Rental), it must not surface here.
    // Scoped to the adaptive (Unicorn) brokers so Rental brokers are unaffected.
    if (isAdaptiveBroker(responsibleUser)) {
      items = items.filter((r) => (syncByLeadId.get(r.leadId)?.pipeline ?? "").toUpperCase() === "UNICORN");
    }

    items = dedupePushPerLead(items);

    const enrichedRaw = items.map((i) => {
      const sync = syncByLeadId.get(i.leadId);
      const content = sync?.content ?? "";
      let lastLeadText: string | null = null;
      let recentMessages: Array<{ from: string; senderName: string; text: string; at: string; channel: string | null }> = [];
      let brokerRepliedAfterSuggestion = false;
      let lastLeadChannel: string | null = null;
      let trailingUnanswered = 0;

      let leadName: string | null = null;

      if (content) {
        try {
          const dialog = parseDialogContent(content);
          lastLeadText = dialog.lastLeadMessage?.text ?? null;
          lastLeadChannel = dialog.lastLeadChannel;
          trailingUnanswered = countTrailingOurMessages(dialog.messages);
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

      // Merge in timeline-synced messages newer than the webhook content —
      // dedupe by text+minute since both paths write overlapping history.
      {
        const lastContentMs = recentMessages.length > 0 ? new Date(recentMessages[recentMessages.length - 1]!.at).getTime() : 0;
        const seen = new Set(recentMessages.map((m) => `${m.text}|${Math.floor(new Date(m.at).getTime() / 60000)}`));
        const fresh = (timelineMsgsByLead.get(i.leadId) ?? [])
          .filter((m) => m.sentAt.getTime() > lastContentMs)
          .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
        for (const m of fresh) {
          const key = `${m.text ?? ""}|${Math.floor(m.sentAt.getTime() / 60000)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const from = m.senderType === "lead" ? "lead" : "us";
          recentMessages.push({
            from,
            senderName: m.senderName ?? (from === "lead" ? "Lead" : "Us"),
            text: m.text ?? "",
            at: m.sentAt.toISOString(),
            channel: m.channel ?? null,
          });
          if (from === "lead" && m.text) lastLeadText = m.text;
        }
        recentMessages = recentMessages.slice(-8);
        // Re-evaluate staleness against the MERGED view: a lead reply that only
        // exists in the timeline (webhook lagging) must keep the LIVE visible.
        const mergedLast = recentMessages[recentMessages.length - 1];
        if (i.kind === "live" && mergedLast) {
          brokerRepliedAfterSuggestion = mergedLast.from === "us";
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
        trailing_unanswered: trailingUnanswered,
        // Conversation-derived funnel stage. Non-terminal ones apply themselves
        // on approve; terminal ones (Closed won/lost) are surfaced pre-filled
        // for the broker to confirm.
        suggested_stage: i.suggestedStage ?? null,
        suggested_stage_id: i.suggestedStageId ?? null,
        suggested_stage_reason: i.suggestedStageReason ?? null,
        suggested_stage_terminal: i.suggestedStageTerminal ?? false,
        // Distilled profile (for adaptive ranking + surfaced to the client UI)
        profile_temperature: sync?.profileTemperature ?? null,
        profile_potential: sync?.profilePotential ?? null,
        profile_open_question: sync?.profileOpenQuestion ?? null,
        profile_alive: sync?.profileAlive ?? null,
        profile_summary: sync?.profileSummary ?? null,
        discard_flagged: !!sync?.discardFlaggedAt,
        discard_reason: sync?.discardReason ?? null,
        age_days: sync?.amoCreatedAt
          ? Math.floor((Date.now() - sync.amoCreatedAt.getTime()) / 86400000)
          : null,
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

      const taskGroup = (item: (typeof enriched)[0]): 1 | 2 | 3 => {
        const nfa = item.next_followup_at ? new Date(item.next_followup_at) : null;
        if (!nfa) return 3; // no task → last
        if (nfa >= todayStartBali) return 1; // today's task → first
        return 2; // overdue → middle
      };

      // Adaptive priority ranking runs for the enabled adaptive brokers (see
      // ADAPTIVE_BROKERS). Others keep the original stage→task→warmth sort.
      const useAdaptiveRanking = isAdaptiveBroker(responsibleUser);

      if (useAdaptiveRanking) {
        const overdueDays = (item: (typeof enriched)[0]): number => {
          const nfa = item.next_followup_at ? new Date(item.next_followup_at).getTime() : null;
          if (!nfa) return 0;
          return Math.max(0, Math.floor((nowMs - nfa) / 86400000));
        };
        const scoreOf = (item: (typeof enriched)[0]): number => {
          if (item.kind !== "push") return 1e6; // LIVE (if mixed in) always on top
          return computePushPriority({
            leadStage: item.lead_stage,
            temperature: (item.profile_temperature as "cold" | "warm" | "hot" | null) ?? null,
            potential: item.profile_potential ?? null,
            openQuestion: item.profile_open_question ?? null,
            taskGroup: taskGroup(item),
            streak: item.trailing_unanswered ?? 0,
            ageDays: item.age_days ?? null,
            daysWaitingPastEligible: overdueDays(item),
          });
        };
        enriched.sort((a, b) => {
          const sa = scoreOf(a);
          const sb = scoreOf(b);
          if (sa !== sb) return sb - sa; // higher score first
          try { return Number(BigInt(b.lead_id) - BigInt(a.lead_id)); } catch { return 0; }
        });
      } else {
        enriched.sort((a, b) => {
          // 1) funnel stage (unqualified stages first — see STAGE_RANK above)
          const ra = stageRank(a.lead_stage);
          const rb = stageRank(b.lead_stage);
          if (ra !== rb) return ra - rb;

          // 2) task urgency (today → overdue asc → no task)
          const ga = taskGroup(a);
          const gb = taskGroup(b);
          if (ga !== gb) return ga - gb;

          if (a.kind === "push" && b.kind === "push") {
            const nfaA = a.next_followup_at ? new Date(a.next_followup_at).getTime() : null;
            const nfaB = b.next_followup_at ? new Date(b.next_followup_at).getTime() : null;
            if (ga === 2 && nfaA !== null && nfaB !== null && nfaA !== nfaB) {
              // Overdue: ascending (oldest overdue first)
              return nfaA - nfaB;
            }

            // 3) warmth — fewer unanswered touches in a row first
            const wa = a.trailing_unanswered ?? 0;
            const wb = b.trailing_unanswered ?? 0;
            if (wa !== wb) return wa - wb;
          }

          // Default: newest lead first
          try { return Number(BigInt(b.lead_id) - BigInt(a.lead_id)); } catch { return 0; }
        });
      }
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
