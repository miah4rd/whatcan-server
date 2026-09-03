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
 * Scope: leads whose CURRENT stage sits at or before `up_to_stage_name` in the
 * funnel's own live order, in that pipeline only. Auto-send goes through the
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
import { mayOpenNewConversation, isFirstOutbound, NEW_CONTACT_DAILY_CAP } from "./new-contact-budget";

export type AutopilotMode = "off" | "dry" | "on";
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

/**
 * Called after a suggestion lands in the inbox. Decides — by the broker's own
 * per-stage setting — whether the bot sends it itself.
 */
export async function maybeAutopilot(leadId: string): Promise<void> {
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
    if (!lead || lead.botExcluded) return;

    const pipeline = (lead.pipeline ?? "").trim().toLowerCase();
    if (!pipeline) return;
    const setting = await getAutopilotSetting(pipeline);
    if (setting.mode === "off" || !setting.upToStageName) return;

    // The lead's stage must sit AT OR BEFORE the delegated threshold, in the
    // funnel's own live order (renames and re-orders keep working).
    const stages = await getPipelineStages(pipeline);
    if (!stages) return;
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
      return;
    }
    if (leadIdx === -1 || leadIdx > capIdx) return;

    const [sug] = await db
      .select({
        id: pendingSuggestionsTable.id,
        text: pendingSuggestionsTable.suggestionText,
        attachments: pendingSuggestionsTable.attachments,
        responsibleUser: pendingSuggestionsTable.responsibleUser,
      })
      .from(pendingSuggestionsTable)
      .where(
        and(eq(pendingSuggestionsTable.leadId, leadId), eq(pendingSuggestionsTable.status, "pending")),
      )
      .limit(1);
    if (!sug || !sug.text?.trim()) return;

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
      return;
    }

    // Opening a conversation is the one autopilot send Meta cares about — a
    // reply to someone already talking to us is ordinary traffic. Out of
    // budget, the draft simply waits in the inbox for the broker.
    if (await isFirstOutbound(leadId)) {
      const budget = await mayOpenNewConversation(sug.responsibleUser);
      if (!budget.ok) {
        logger.warn(
          { leadId, used: budget.used, cap: NEW_CONTACT_DAILY_CAP },
          "autopilot held back — this line has already opened its day's worth of new conversations",
        );
        return;
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
    } else {
      const body = await res.text().catch(() => "");
      logger.warn(
        { leadId, status: res.status, body: body.slice(0, 160) },
        "autopilot: approve refused — left in inbox for the broker",
      );
    }
  } catch (err) {
    logger.error({ err, leadId }, "autopilot failed (non-fatal, suggestion stays in inbox)");
  }
}
