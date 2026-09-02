import { Router } from "express";
import { db, pendingSuggestionsTable, leadsSyncTable, leadMessagesTable, brokerSettingsTable } from "@workspace/db";
import { desc, inArray, eq, and, sql } from "drizzle-orm";
import { cleanLeadName } from "../../lib/lead-display-name";
import { parseDialogContent, countTrailingOurMessages } from "../../lib/dialog-parser";
import { getPushStageWhitelist } from "../../lib/push-stage-whitelist";
import { computePushPriority, computeNextFollowupDays, isAdaptiveBroker, PUSH_DAILY_CAP } from "../../lib/adaptive-followup";
import { isPendingVisible, dedupePushPerLead, repliedSignalFromTimeline, loadReplySignals } from "../../lib/pending-visibility";
import { findStuckLeads } from "../../lib/stuck-leads";

const router = Router();

router.options("/suggestions", (_req, res) => res.sendStatus(204));

router.get("/suggestions", async (req, res) => {
  const kind = req.query["kind"] as string | undefined;
  const responsibleUser = req.query["responsibleUser"] as string | undefined;
  const pipelineParam = (req.query["pipeline"] as string | undefined)?.trim().toLowerCase();

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
              responsibleUser: leadsSyncTable.responsibleUser,
              content: leadsSyncTable.content,
              leadNotes: leadsSyncTable.leadNotes,
              leadStage: leadsSyncTable.leadStage,
              leadStageId: leadsSyncTable.leadStageId,
              lastMessageAt: leadsSyncTable.lastMessageAt,
              lastMessageFrom: leadsSyncTable.lastMessageFrom,
              lastOurMessageAt: leadsSyncTable.lastOurMessageAt,
              nextFollowupAt: leadsSyncTable.nextFollowupAt,
              liveDismissedAt: leadsSyncTable.liveDismissedAt,
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
              priorityAt: leadsSyncTable.priorityAt,
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
    // timelineMsgsByLead is newest-first, so [0] is the newest message we know
    // of from the timeline — the tie-breaker when webhook-fed content is stale.
    // Reply signal per lead computed in SQL (max inbound vs max outbound). MUST be
    // a per-lead aggregate, not the capped row fetch above — that global LIMIT can
    // miss an older lead's messages entirely, which is exactly why answered leads
    // stayed stuck in LIVE (and why their conversation looked truncated).
    const signalByLead = await loadReplySignals(allLeadIds);

    let items = allPending.filter((r) =>
      isPendingVisible(r, syncByLeadId.get(r.leadId), pushWhitelist, signalByLead.get(r.leadId)),
    );

    if (kind === "live" || kind === "push") items = items.filter((r) => r.kind === kind);
    if (responsibleUser) {
      const wanted = responsibleUser.trim().toLowerCase();
      // pending_suggestions.responsible_user is stamped at CREATION time and
      // never touched again — if the lead is reassigned in amoCRM afterward
      // (e.g. a broker handover), the suggestion silently falls into a gap:
      // invisible to the new owner (row still says the old name) AND the old
      // owner has moved on. leads_sync.responsible_user is kept current by
      // every sync/webhook pass, so prefer it; fall back to the row's own
      // stamp only if the lead hasn't been synced at all yet.
      items = items.filter((r) => {
        const current = (syncByLeadId.get(r.leadId)?.responsibleUser ?? r.responsibleUser ?? "").trim().toLowerCase();
        return current === wanted;
      });
    }

    if (pipelineParam) {
      // Broker explicitly picked a pipeline via the switcher — narrow to it.
      // With no param the view is genuinely ALL pipelines (see below).
      items = items.filter((r) => (syncByLeadId.get(r.leadId)?.pipeline ?? "").toLowerCase() === pipelineParam);
    }
    // No pipeline param = every pipeline this broker works, and that is the
    // default. It used to mean "Unicorn only", which quietly broke the promise
    // the switcher's own "All pipelines" option makes — and worse, it disagreed
    // with the two things a broker actually reacts to: the push notification and
    // the badge count, neither of which has ever filtered by pipeline. Amelia
    // had three untouched Rental leads with drafts ready while her inbox said
    // "All caught up" (2026-08-10). Brokers here run several funnels at once for
    // different clients; the inbox has to show all of them, and each card
    // carries its pipeline so a mixed list still reads clearly.
    // The one real scoping rule that remains is isPendingVisible's Rental-scoped
    // roster (HoS), which is a deliberate exclusion, not a view preference.

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
          leadName = cleanLeadName(leadMsg?.senderName);
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
        // Current synced owner, not the row's creation-time stamp — see the
        // reassignment note above the responsibleUser filter.
        responsible_user: sync?.responsibleUser ?? i.responsibleUser,
        followup_level: i.followupLevel,
        triggered_by_message_at: i.triggeredByMessageAt,
        created_at: i.createdAt,
        last_lead_text: lastLeadText,
        recent_messages: recentMessages,
        lead_name: leadName,
        lead_notes: sync?.leadNotes ?? null,
        lead_stage: sync?.leadStage ?? null,
        lead_stage_id: sync?.leadStageId ?? null,
        pipeline: sync?.pipeline ?? null,
        last_message_at: sync?.lastMessageAt?.toISOString() ?? null,
        next_followup_at: sync?.nextFollowupAt?.toISOString() ?? null,
        priority_at: sync?.priorityAt?.toISOString() ?? null,
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
        // Whether the temperature was set by the broker (sticky) or the AI — the
        // extension shows a ✎ marker so the broker knows it's their call.
        profile_temperature_source: sync?.profileTemperatureSource ?? null,
        // Adaptive suggested date for the NEXT follow-up (cost-of-delay cadence:
        // fresh/hot → tight, cold+old → stretched). The bot proposes this as the
        // default when the broker reschedules the task from the chip.
        suggested_followup_at: new Date(
          Date.now() +
            computeNextFollowupDays({
              streak: trailingUnanswered,
              leadStage: sync?.leadStage,
              temperature: (sync?.profileTemperature as "cold" | "warm" | "hot" | null) ?? undefined,
              ageDays: sync?.amoCreatedAt
                ? Math.floor((Date.now() - sync.amoCreatedAt.getTime()) / 86400000)
                : null,
            }) *
              86400000,
        ).toISOString(),
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

    // LIVE staleness is now decided authoritatively upstream by isPendingVisible
    // (max inbound vs max outbound across content + lead_messages), so no second,
    // weaker filter here — that older last-element check could re-hide a genuine
    // LIVE that the robust rule correctly kept.
    let enriched = enrichedRaw;

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

        // LIVE (client replies) and REACH (qualification follow-ups) are NEVER
        // capped — a client who just wrote, or a lead moved into a follow-up stage,
        // must always show. Active-push gets a DAILY QUOTA of PUSH_DAILY_CAP
        // distinct leads per Bali day: new leads fill the list up to the quota, but
        // once that many distinct leads have entered today the list only DRAINS as
        // the broker works them — no same-day backfill. (Owner: "I follow up 5 and
        // it still shows 30 — they don't go down, new ones come in.") Resets daily.
        if (PUSH_DAILY_CAP > 0) {
          const isReachStage = (s: string | null) =>
            ["1st follow up", "2nd follow up", "final follow up"].some((k) => (s ?? "").toLowerCase().includes(k));
          // LIVE + REACH are ALWAYS shown (never hidden). REACH is time-sensitive
          // and few, so it must never be dropped — but it IS a proactive touch, so
          // it counts toward the daily proactive budget: PUSH flexes DOWN to keep
          // total proactive (push + reach) ≈ PUSH_DAILY_CAP, for WhatsApp-ban safety.
          const liveOrReach = enriched.filter((i) => i.kind !== "push" || isReachStage(i.lead_stage));
          const activePush = enriched.filter((i) => i.kind === "push" && !isReachStage(i.lead_stage));
          // PUSH gets its OWN full daily quota of 30; REACH and LIVE are separate
          // and uncapped (never hidden, and they do NOT eat into the push quota).
          const pushTarget = PUSH_DAILY_CAP;
          const brokerKey = (responsibleUser ?? "").trim().toLowerCase();
          if (brokerKey) {
            const baliDay = new Date(nowMs + BALI_OFFSET_MS).toISOString().slice(0, 10);
            // The quota is per broker AND PER PIPELINE. A single shared bucket
            // meant a second pipeline could never appear at all: Yudi's 25
            // Unicorn leads filled the day before Rental Listings existed, and
            // because the quota is applied AFTER the pipeline filter, switching
            // the picker to Rental Listings showed an empty inbox with 11 ready
            // drafts sitting behind it — "no same-day backfill" is deliberate,
            // so it would have stayed empty until the Unicorn queue drained.
            // Each pipeline now gets its own daily budget (owner's call, weighed
            // against the WhatsApp-ban reason the cap exists for).
            const defaultScope = isAdaptiveBroker(responsibleUser) ? "unicorn" : "all";
            const quotaScope = pipelineParam || defaultScope;
            const focusKey = `daily_focus:${brokerKey}:${quotaScope}`;
            let served: string[] = [];
            let loadedToday = false;
            try {
              const [row] = await db.select().from(brokerSettingsTable).where(eq(brokerSettingsTable.key, focusKey));
              if (row?.value) {
                const parsed = JSON.parse(row.value) as { day?: string; leadIds?: string[] };
                if (parsed.day === baliDay && Array.isArray(parsed.leadIds)) {
                  served = parsed.leadIds.slice();
                  loadedToday = true;
                }
              }
            } catch { /* fail open → fresh quota */ }
            // Carry today's already-served leads over from the pre-split single
            // bucket — but ONLY into the scope that bucket actually held. Without
            // this the split would hand every broker a fresh quota mid-day on
            // deploy, letting them send a second full batch on the same line.
            if (!loadedToday && quotaScope === defaultScope) {
              try {
                const [legacy] = await db
                  .select()
                  .from(brokerSettingsTable)
                  .where(eq(brokerSettingsTable.key, `daily_focus:${brokerKey}`));
                if (legacy?.value) {
                  const parsed = JSON.parse(legacy.value) as { day?: string; leadIds?: string[] };
                  if (parsed.day === baliDay && Array.isArray(parsed.leadIds)) served = parsed.leadIds.slice();
                }
              } catch { /* no legacy bucket → fresh quota */ }
            }
            // Top up today's PUSH quota (budget minus reach) with the highest-ranked
            // active-push not yet served. Drains as worked; no same-day backfill.
            const servedSet = new Set(served);
            for (const item of activePush) {
              if (served.length >= pushTarget) break;
              if (!servedSet.has(item.lead_id)) { served.push(item.lead_id); servedSet.add(item.lead_id); }
            }
            const payload = JSON.stringify({ day: baliDay, leadIds: served });
            try {
              await db.insert(brokerSettingsTable)
                .values({ key: focusKey, value: payload })
                .onConflictDoUpdate({ target: brokerSettingsTable.key, set: { value: payload } });
            } catch { /* non-fatal — degrades to no-quota, never blocks the inbox */ }
            const shownActivePush = activePush.filter((i) => servedSet.has(i.lead_id));
            enriched = [...liveOrReach, ...shownActivePush];
          } else {
            enriched = [...liveOrReach, ...activePush.slice(0, pushTarget)];
          }
        }
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

    // ── Hand-picked priority wins over every ranking above ──────────────────
    //
    // Last on purpose: there are three sort paths here (adaptive score, the
    // stage→task→warmth sort, and the LIVE-only stage rank), and a lift added
    // inside one of them silently would not apply in the other two — a list of
    // cards spanning both tabs is exactly what this is for. Lifting after all of
    // them is one rule that cannot be half-applied, and it is stable, so the
    // ordering a broker already knows survives underneath.
    //
    // The window exists so nobody has to remember to unpin: a priority list is
    // about this week's work, and one that never expires quietly becomes the
    // permanent top of the inbox, which is the same as having no priority.
    const PRIORITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
    const pinnedNow = (i: (typeof enriched)[0]): boolean => {
      const p = i.priority_at ? new Date(i.priority_at).getTime() : null;
      return p !== null && Number.isFinite(p) && Date.now() - p < PRIORITY_WINDOW_MS;
    };
    if (enriched.some(pinnedNow)) {
      enriched = [...enriched.filter(pinnedNow), ...enriched.filter((i) => !pinnedNow(i))];
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
        .set({ lastMessageFrom: "us", nextFollowupAt: null, liveDismissedAt: new Date() })
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

/**
 * GET /api/public/stuck-leads?responsibleUser=X
 * Leads sitting in a tracked pipeline that the bot has produced nothing for.
 * Exists so a silent failure stops looking like a quiet day — see lib/stuck-leads.ts.
 */
router.options("/stuck-leads", (_req, res) => res.sendStatus(204));
router.get("/stuck-leads", async (req, res) => {
  try {
    const stuck = await findStuckLeads(req.query["responsibleUser"] as string | undefined);
    res.json({ count: stuck.length, leads: stuck.slice(0, 50) });
  } catch {
    res.status(500).json({ error: "DB error" });
  }
});

export default router;
