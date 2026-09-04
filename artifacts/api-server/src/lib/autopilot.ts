/**
 * Staged delegation: the broker hands the funnel to the bot stage by stage.
 *
 * The owner's ask, verbatim: "настройка по этапам — бот действует без аппрува до
 * этапа X, и так потихоньку передавать дела после обучения и контроля". So the
 * unit of trust here is a STAGE, not a message type, and there is a supervised
 * middle mode: `dry` logs exactly what WOULD have been sent without sending, so
 * the broker can watch the bot run a stage for a day before flipping it live.
 *
 * Modes: 'off' (default — nothing changes), 'dry' (log only), 'on' (auto-send).
 * Scope: leads whose CURRENT stage sits STRICTLY BEFORE `up_to_stage_name` in
 * the funnel's own live order, in that pipeline only. The named stage is where
 * the bot hands the card to the broker, not the last stage it works — every
 * card is owned by exactly one of them and none can fall between. Auto-send goes through the
 * real /approve endpoint on localhost, so every existing guard — duplicate
 * threads, channel resolution, stage advance, the owner-promise task, the
 * follow-up clock — applies to an autopilot send exactly as to a human one.
 *
 * There is deliberately NO rate cap: a 30/day limit existed and the owner had
 * it removed — "я сам буду контролить". His control instrument is the audit
 * trail: every auto-send flips auto_sent=TRUE on the suggestion row, so "what
 * did the bot send by itself" is always one query. The dailyCap field stays in
 * the table/API but is not enforced.
 */
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getPipelineStages } from "./stage-classifier";
import {
  mayOpenNewConversation,
  isFirstOutbound,
  withinOutreachHours,
  NEW_CONTACT_DAILY_CAP,
  OUTREACH_OPEN_HOUR,
  OUTREACH_CLOSE_HOUR,
} from "./new-contact-budget";

export type AutopilotMode = "off" | "dry" | "on";
/**
 * Why a lead did or did not auto-send.
 *
 * This used to be `void`, and the backlog drain counted its own CALLS as sends:
 * it reported "sent: 15" for a batch where every single lead had silently
 * returned at the stage check and not one message left the building. A caller
 * that cannot tell "sent" from "declined" will eventually report the wrong one.
 */
export type AutopilotOutcome = { sent: boolean; reason: string };
export type AutopilotSetting = {
  pipeline: string;
  mode: AutopilotMode;
  upToStageName: string | null;
  dailyCap: number;
};

function firstRow<T>(res: unknown): T | undefined {
  const withRows = res as { rows?: T[] };
  if (Array.isArray(withRows.rows)) return withRows.rows[0];
  if (Array.isArray(res)) return (res as T[])[0];
  return undefined;
}

export async function getAutopilotSetting(pipeline: string): Promise<AutopilotSetting> {
  const key = pipeline.trim().toLowerCase();
  try {
    const res = await db.execute(
      sql`SELECT pipeline, mode, up_to_stage_name, daily_cap FROM autopilot_settings WHERE pipeline = ${key}`,
    );
    const r = firstRow<Record<string, unknown>>(res);
    if (!r) return { pipeline: key, mode: "off", upToStageName: null, dailyCap: 30 };
    const mode = ["off", "dry", "on"].includes(String(r["mode"]))
      ? (String(r["mode"]) as AutopilotMode)
      : "off";
    return {
      pipeline: key,
      mode,
      upToStageName: (r["up_to_stage_name"] as string | null) ?? null,
      dailyCap: Number(r["daily_cap"]) || 30,
    };
  } catch (err) {
    logger.warn({ err, pipeline: key }, "autopilot: could not read setting — treating as off");
    return { pipeline: key, mode: "off", upToStageName: null, dailyCap: 30 };
  }
}

export async function setAutopilotSetting(s: AutopilotSetting): Promise<void> {
  const key = s.pipeline.trim().toLowerCase();
  await db.execute(sql`
    INSERT INTO autopilot_settings (pipeline, mode, up_to_stage_name, daily_cap, updated_at)
    VALUES (${key}, ${s.mode}, ${s.upToStageName}, ${s.dailyCap}, now())
    ON CONFLICT (pipeline) DO UPDATE
      SET mode = ${s.mode}, up_to_stage_name = ${s.upToStageName}, daily_cap = ${s.dailyCap}, updated_at = now()
  `);
  logger.info({ setting: { ...s, pipeline: key } }, "autopilot: setting saved");
}

const normStage = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * The stages the broker has actually delegated, in the funnel's own live order.
 *
 * Exists so a caller can ASK which leads autopilot would take, instead of
 * handing it leads and reading a silent no. The backlog drain used to pick the
 * oldest drafts in the whole funnel: the oldest ones sit in `live` and
 * `Weekly Check Sent`, far past the threshold, so a batch of fifteen produced
 * fifteen silent declines and looked like a broken sender.
 */
export async function delegatedStageNames(pipeline: string): Promise<string[] | null> {
  const setting = await getAutopilotSetting(pipeline);
  if (setting.mode !== "on" || !setting.upToStageName) return null;
  const stages = await getPipelineStages(pipeline);
  if (!stages) return null;
  const want = normStage(setting.upToStageName);
  let capIdx = stages.all.findIndex((st) => normStage(st.name) === want);
  if (capIdx === -1) {
    capIdx = stages.all.findIndex(
      (st) => normStage(st.name).startsWith(want) || want.startsWith(normStage(st.name)),
    );
  }
  if (capIdx === -1) return null;
  // EXCLUSIVE: the threshold is the handover point, not the bot's last desk.
  // See maybeAutopilot for why.
  return stages.all.slice(0, capIdx).map((st) => st.name);
}

/**
 * The stage where this funnel hands its cards from the bot to the broker.
 *
 * Exactly the stage named in the setting — the bot works everything before it.
 * Resolved through the funnel's live stage list so a rename still lands.
 */
export async function getHandoverStageName(pipeline: string): Promise<string | null> {
  const setting = await getAutopilotSetting(pipeline);
  if (setting.mode !== "on" || !setting.upToStageName) return null;
  const stages = await getPipelineStages(pipeline);
  if (!stages) return null;
  const want = normStage(setting.upToStageName);
  const hit =
    stages.all.find((st) => normStage(st.name) === want) ??
    stages.all.find((st) => normStage(st.name).startsWith(want) || want.startsWith(normStage(st.name)));
  return hit?.name ?? null;
}

/**
 * Every funnel's delegated stage names, for the funnels autopilot is ON for.
 *
 * The inbox needs this to decide whether a draft is the bot's job or the
 * broker's, and it needs it for ALL funnels in one call rather than per row.
 */
export async function delegatedStagesByPipeline(): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  try {
    const res = await db.execute(sql`SELECT pipeline FROM autopilot_settings WHERE mode = 'on'`);
    const rows = (res as { rows?: Array<{ pipeline: string }> }).rows ?? [];
    for (const r of rows) {
      const names = await delegatedStageNames(r.pipeline);
      if (names) out.set(r.pipeline.trim().toLowerCase(), new Set(names.map((n) => n.trim().toLowerCase())));
    }
  } catch (err) {
    // Fail OPEN: an empty map shows every draft, which is the old behaviour.
    logger.warn({ err }, "autopilot: could not read delegated stages — the inbox will show everything");
  }
  return out;
}

/**
 * Called after a suggestion lands in the inbox. Decides — by the broker's own
 * per-stage setting — whether the bot sends it itself.
 */
export async function maybeAutopilot(leadId: string): Promise<AutopilotOutcome> {
  try {
    const [lead] = await db
      .select({
        pipeline: leadsSyncTable.pipeline,
        leadStage: leadsSyncTable.leadStage,
        botExcluded: leadsSyncTable.botExcluded,
      })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, leadId))
      .limit(1);
    if (!lead) return { sent: false, reason: "no lead row" };
    if (lead.botExcluded) return { sent: false, reason: "bot excluded" };

    const pipeline = (lead.pipeline ?? "").trim().toLowerCase();
    if (!pipeline) return { sent: false, reason: "lead has no pipeline" };
    const setting = await getAutopilotSetting(pipeline);
    if (setting.mode === "off") return { sent: false, reason: "autopilot off" };
    if (!setting.upToStageName) return { sent: false, reason: "no delegated stage set" };

    // The lead's stage must sit AT OR BEFORE the delegated threshold, in the
    // funnel's own live order (renames and re-orders keep working).
    const stages = await getPipelineStages(pipeline);
    if (!stages) return { sent: false, reason: "funnel stages unavailable" };
    // Exact name first, then a prefix match, because a stage rename must not
    // silently switch the whole funnel back to manual. "QUALIFIED" was renamed
    // to "QUALIFIED (Pre-listed)" in amoCRM and this threshold stopped
    // resolving; autopilot then returned on every single lead for a day and
    // nobody could see why — the setting still said "on".
    const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
    const idxOf = (name: string | null | undefined) => {
      const want = norm(name);
      if (!want) return -1;
      const exact = stages.all.findIndex((st) => norm(st.name) === want);
      if (exact !== -1) return exact;
      const prefixed = stages.all.findIndex(
        (st) => norm(st.name).startsWith(want) || want.startsWith(norm(st.name)),
      );
      if (prefixed !== -1) {
        logger.warn(
          { pipeline, wanted: name, resolvedTo: stages.all[prefixed]!.name },
          "autopilot: stage name no longer matches exactly — resolved by prefix. Re-save the setting with the current name.",
        );
      }
      return prefixed;
    };
    const leadIdx = idxOf(lead.leadStage);
    const capIdx = idxOf(setting.upToStageName);
    if (capIdx === -1) {
      // Loud, not silent: "on" plus nothing happening is the worst state to debug.
      logger.error(
        { pipeline, upToStageName: setting.upToStageName, stages: stages.all.map((s) => s.name) },
        "autopilot: threshold stage does not exist in this funnel — nothing will ever auto-send",
      );
      return { sent: false, reason: "threshold stage does not exist in this funnel" };
    }
    if (leadIdx === -1) return { sent: false, reason: `stage not in this funnel: ${lead.leadStage}` };
    /**
     * The threshold is EXCLUSIVE: the bot works every stage BEFORE it and hands
     * the card over on arrival.
     *
     * It used to be inclusive, and that made the last delegated stage a trap.
     * A card reaching QUALIFIED had nothing left for the bot to ask, so no draft
     * was written and nothing moved it on; and because the inbox hides whatever
     * the bot owns, the broker never saw it either. Neither side owned it and it
     * sat there. The owner's rule, and the reason this is exclusive: there must
     * always be a handover point from autopilot to the human, wherever the dial
     * is set, "иначе он просто теряется в системе".
     */
    if (leadIdx >= capIdx) {
      return { sent: false, reason: `handed over to the broker at ${lead.leadStage}` };
    }

    const [sug] = await db
      .select({
        id: pendingSuggestionsTable.id,
        kind: pendingSuggestionsTable.kind,
        text: pendingSuggestionsTable.suggestionText,
        attachments: pendingSuggestionsTable.attachments,
        responsibleUser: pendingSuggestionsTable.responsibleUser,
      })
      .from(pendingSuggestionsTable)
      .where(
        and(eq(pendingSuggestionsTable.leadId, leadId), eq(pendingSuggestionsTable.status, "pending")),
      )
      .limit(1);
    if (!sug || !sug.text?.trim()) return { sent: false, reason: "no pending draft" };

    /**
     * Record on the draft itself why it was not sent.
     *
     * The inbox uses this to stop showing the broker work that is not his: a
     * draft on a delegated stage that autopilot will handle is hidden, and one
     * autopilot could NOT deliver is shown. Without a stored reason those two
     * look identical from the outside.
     */
    const decline = async (reason: string): Promise<AutopilotOutcome> => {
      await db
        .update(pendingSuggestionsTable)
        .set({ autopilotSkippedReason: reason, autopilotSkippedAt: new Date() })
        .where(eq(pendingSuggestionsTable.id, sug.id))
        .catch(() => undefined);
      return { sent: false, reason };
    };

    if (setting.mode === "dry") {
      logger.info(
        {
          leadId,
          stage: lead.leadStage,
          wouldSend: sug.text.slice(0, 160),
          links: (sug.attachments ?? []).length,
        },
        "autopilot DRY RUN: would have auto-sent this (switch to 'on' to actually send)",
      );
      return decline("dry run");
    }

    // Opening a conversation is the one autopilot send Meta cares about — a
    // reply to someone already talking to us is ordinary traffic. Out of
    // budget, the draft simply waits in the inbox for the broker.
    // A PROACTIVE message — a first contact or a follow-up nudge — waits for
    // Bali's working hours. A reply to someone who just wrote to us does not:
    // that is reactive, and answering at 23:00 a person who wrote at 22:55 is
    // ordinary. The nudge pass used to write its drafts straight into the
    // table, so autopilot never judged them; they sat verdict-less in the PUSH
    // tab all evening and the broker was invited to send at 21:00 by hand what
    // the bot would have sent itself at 10:00.
    const proactive = sug.kind === "push" || (await isFirstOutbound(leadId));
    if (proactive && !withinOutreachHours()) {
      return decline(
        `waiting for outreach hours (${OUTREACH_OPEN_HOUR}:00-${OUTREACH_CLOSE_HOUR}:00 Bali)`,
      );
    }
    if (await isFirstOutbound(leadId)) {
      const budget = await mayOpenNewConversation(sug.responsibleUser);
      if (!budget.ok) {
        logger.warn(
          { leadId, used: budget.used, cap: NEW_CONTACT_DAILY_CAP },
          "autopilot held back — this line has already opened its day's worth of new conversations",
        );
        return decline(`waiting for tomorrow's new-contact budget (${budget.used}/${NEW_CONTACT_DAILY_CAP})`);
      }
    }

    // Real send — through the same door a human uses, so every guard applies.
    const port = process.env["PORT"] || "3000";
    const res = await fetch(`http://127.0.0.1:${port}/api/public/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        suggestionId: sug.id,
        message: sug.text,
        attachments: sug.attachments ?? [],
        brokerId: sug.responsibleUser ?? undefined,
      }),
    });
    if (res.ok) {
      await db
        .update(pendingSuggestionsTable)
        .set({ autoSent: true })
        .where(eq(pendingSuggestionsTable.id, sug.id));
      logger.info({ leadId, stage: lead.leadStage }, "autopilot: sent without approval (stage is delegated)");
      return { sent: true, reason: "sent" };
    } else {
      const body = await res.text().catch(() => "");
      logger.warn(
        { leadId, status: res.status, body: body.slice(0, 160) },
        "autopilot: approve refused — left in inbox for the broker",
      );
      // NOT a "waiting" reason: a refusal here is a card the bot cannot deliver
      // to at all (a duplicate WhatsApp thread, a deleted lead), and it is
      // exactly the case that needs a person.
      return decline(`approve refused (${res.status}): ${body.slice(0, 80)}`);
    }
  } catch (err) {
    logger.error({ err, leadId }, "autopilot failed (non-fatal, suggestion stays in inbox)");
    return { sent: false, reason: "error" };
  }
}
