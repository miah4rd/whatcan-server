/**
 * Unicorn OS — a funnel as the automation sees it (owner, 26.09).
 *
 * For every stage: what moves a card into it and who owns that move (the
 * Copilot reading the conversation, a fixed rule in code, the site, or only a
 * person); where the autopilot line sits (autopilot sends on its own before
 * it, people approve from it on); and how ready each stage is to be handed
 * over — the share of the Copilot's drafts sent exactly as written.
 *
 * The descriptions the Copilot reads are editable here and take effect in the
 * classifier (lib/stage-classifier.ts reads os_stage_rules). The rest is shown
 * as it is: those moves live in code, and saying otherwise would mislead.
 *
 * Also the work share: what the bot did and what people did, per day, with
 * the time it saved.
 */
import { pool } from "@workspace/db";
import { getPipelineStages, clearStageMapCache } from "../stage-classifier";
import { getAutopilotSetting } from "../autopilot";
import { isListingAcquisition } from "../pipelines";
import { audit, type OsUser } from "./auth";

export type FunnelKey = "rental" | "rental-listings" | "unicorn";
const PIPE: Record<FunnelKey, string> = { rental: "rental", "rental-listings": "rental listings", unicorn: "unicorn" };
export const AUTOPILOT_RULE_ID: Record<FunnelKey, string> = { rental: "autopilot-rental", "rental-listings": "autopilot-listings", unicorn: "autopilot-sales" };

let ready: Promise<void> | null = null;
function ensureTable() {
  if (!ready) {
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS os_stage_rules (
           pipeline text NOT NULL,
           stage text NOT NULL,
           meaning text,
           updated_by text,
           updated_at timestamptz NOT NULL DEFAULT now(),
           PRIMARY KEY (pipeline, stage)
         )`,
      )
      .then(() => undefined)
      .catch((err) => {
        ready = null;
        throw err;
      });
  }
  return ready;
}

/** Stages set only by people, in every funnel. */
const PERSON_ONLY = /contract signed|check[-\s]?in|inventory|closed|won|lost|успешно|закрыто|inspection\.?\s*done|rented/i;
/** Stages moved by a fixed rule in code, with what the rule is, per funnel. */
const RULES: Record<FunnelKey, Array<[RegExp, string]>> = {
  rental: [
    [/new lead/i, "A new lead from a Meta form, the website or the catalog lands here. The welcome goes out at once."],
    [/need.?s? assess/i, "Floor rule: anything we send moves a New LEAD here. The Copilot also chooses it from the conversation."],
    [/options sent/i, "Floor rule: a villa link we send moves the card here. The Copilot also chooses it from the conversation."],
    [/viewing\s*scheduled/i, "Needs a viewing slot agreed in the chat and on record; the Copilot cannot choose it on words alone."],
    [/viewing\s*done/i, "The filed viewing report moves the card here (the report opens 30 minutes after the slot)."],
  ],
  "rental-listings": [
    [/qualified/i, "Qualification rule: bedrooms, a price with its commission position and the real owner confirmed. The listing goes on the site as Pre-listed."],
    [/inspection\s*sc?h?ed/i, "A visit agreed in the thread, with its date; it also goes to the Brokers Google Calendar."],
    [/^live$/i, "The site's Listed switch (Pre-listed to Listed) moves the card here."],
    [/weekly check/i, "The weekly availability check sent to the owner."],
    [/availability received|update availability/i, "The owner answered the weekly availability check."],
    [/long term/i, "Regulation of 15.09: five conditions and the owner's free date in words; the card leaves 14 days before that date."],
    [/co-?broke/i, "The other side is an agency with its own commission."],
    [/backlog/i, "A reserve: the autopilot does not take cards from here."],
  ],
  unicorn: [[/new lead/i, "A new sales lead from a form or the website."]],
};

type StageRow = {
  name: string;
  id: number;
  owner: "copilot" | "rule" | "person" | "workflow";
  howItGetsHere: string;
  editable: boolean;
  edited: { by: string | null; at: string | null } | null;
  builtIn: string | null;
  cardsNow: number;
  movesIn7d: { bot: number; people: number };
  drafts30d: { total: number; auto: number; asWritten: number; edited: number; skipped: number; readiness: number | null };
  autopilot: "autopilot" | "dry" | "people";
};

export async function stageMap(f: FunnelKey) {
  if (!PIPE[f]) throw new Error("Unknown funnel.");
  await ensureTable();
  const key = PIPE[f];
  const [stages, ap, rulesDb, now, moves, drafts] = await Promise.all([
    getPipelineStages(key),
    getAutopilotSetting(key),
    pool.query(`SELECT stage, meaning, updated_by, updated_at FROM os_stage_rules WHERE pipeline = $1`, [key]),
    pool.query(`SELECT lead_stage AS stage, count(*)::int AS n FROM leads_sync WHERE lower(coalesce(pipeline,'')) = $1 GROUP BY 1`, [key]),
    pool.query(
      `SELECT to_stage AS stage, count(*) FILTER (WHERE responsible_user LIKE 'engine:%')::int AS bot, count(*) FILTER (WHERE coalesce(responsible_user,'') NOT LIKE 'engine:%')::int AS people
         FROM stage_events WHERE lower(coalesce(pipeline,'')) = $1 AND changed_at > now() - interval '7 days' GROUP BY 1`,
      [key],
    ),
    // Each draft of the last 30 days, at the stage its card was in when it was written.
    pool.query(
      `SELECT coalesce(st.to_stage, l.lead_stage) AS stage,
              count(*)::int AS total,
              count(*) FILTER (WHERE p.auto_sent)::int AS auto,
              count(*) FILTER (WHERE p.status = 'approved' AND NOT coalesce(p.auto_sent,false))::int AS as_written,
              count(*) FILTER (WHERE p.status = 'edited')::int AS edited,
              count(*) FILTER (WHERE p.status = 'skipped')::int AS skipped
         FROM pending_suggestions p
         JOIN leads_sync l ON l.lead_id = p.lead_id
         LEFT JOIN LATERAL (SELECT e.to_stage FROM stage_events e WHERE e.lead_id = p.lead_id AND e.changed_at <= p.created_at ORDER BY e.changed_at DESC LIMIT 1) st ON true
        WHERE lower(coalesce(l.pipeline,'')) = $1 AND p.created_at > now() - interval '30 days'
        GROUP BY 1`,
      [key],
    ),
  ]);
  if (!stages) throw new Error("amoCRM did not return this funnel's stages.");
  const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();
  const byName = <T extends Record<string, unknown>>(rows: T[]) => new Map(rows.map((r) => [lc(r.stage), r]));
  const nowBy = byName(now.rows);
  const movesBy = byName(moves.rows);
  const draftsBy = byName(drafts.rows);
  const dbBy = byName(rulesDb.rows);
  const selectable = new Map(stages.selectable.map((s) => [lc(s.name), s]));
  const limitIdx = ap.upToStageName ? stages.all.findIndex((s) => lc(s.name) === lc(ap.upToStageName)) : -1;

  const rows: StageRow[] = stages.all.map((s, i) => {
    const sel = selectable.get(lc(s.name)) as { meaning?: string } | undefined;
    const db = dbBy.get(lc(s.name)) as { meaning?: string; updated_by?: string; updated_at?: string } | undefined;
    const rule = RULES[f].find(([re]) => re.test(s.name))?.[1] ?? null;
    let owner: StageRow["owner"];
    let how: string;
    if (PERSON_ONLY.test(s.name)) {
      owner = "person";
      how = "Only a person moves a card here; the Copilot never does.";
    } else if (sel) {
      owner = "copilot";
      how = sel.meaning ?? "";
    } else if (rule) {
      owner = "rule";
      how = rule;
    } else {
      owner = "workflow";
      how = isListingAcquisition(key) ? "Set by a person or by another automation; the Copilot does not choose it from the conversation." : "A working stage (follow-up counter, mailing, taken to work): set by hand or by other automations, never read from the conversation.";
    }
    const d = draftsBy.get(lc(s.name)) as { total: number; auto: number; as_written: number; edited: number; skipped: number } | undefined;
    const decided = d ? d.as_written + d.edited + d.skipped : 0;
    const m = movesBy.get(lc(s.name)) as { bot: number; people: number } | undefined;
    return {
      name: s.name,
      id: s.id,
      owner,
      howItGetsHere: how,
      // Rule notes ride along on Copilot stages that also have a floor rule (Rental).
      builtIn: owner === "copilot" && rule ? rule : null,
      editable: owner === "copilot",
      edited: db?.meaning ? { by: db.updated_by ?? null, at: db.updated_at ? new Date(db.updated_at).toISOString() : null } : null,
      cardsNow: Number((nowBy.get(lc(s.name)) as { n?: number } | undefined)?.n ?? 0),
      movesIn7d: { bot: m?.bot ?? 0, people: m?.people ?? 0 },
      drafts30d: { total: d?.total ?? 0, auto: d?.auto ?? 0, asWritten: d?.as_written ?? 0, edited: d?.edited ?? 0, skipped: d?.skipped ?? 0, readiness: decided >= 5 ? Math.round(((d!.as_written) / decided) * 100) : null },
      autopilot: ap.mode === "off" || limitIdx < 0 || i >= limitIdx ? "people" : ap.mode === "dry" ? "dry" : "autopilot",
    };
  });
  return { funnel: f, pipeline: stages.all.length ? key : key, autopilot: { mode: ap.mode, upToStageName: ap.upToStageName, dailyCap: ap.dailyCap, ruleId: AUTOPILOT_RULE_ID[f] }, stages: rows };
}

/** Rewrite (or reset, with an empty text) what the Copilot reads about a stage. */
export async function setStageRule(user: OsUser, f: FunnelKey, stage: string, meaning: string | null) {
  if (!PIPE[f]) throw new Error("Unknown funnel.");
  await ensureTable();
  const key = PIPE[f];
  const stages = await getPipelineStages(key);
  const sel = stages?.selectable.find((s) => s.name.trim().toLowerCase() === stage.trim().toLowerCase());
  if (!sel) throw new Error("The Copilot does not choose this stage from the conversation, so there is no description of it to change.");
  const text = (meaning ?? "").trim();
  if (text && (text.length < 20 || text.length > 1200)) throw new Error("Describe the stage in 20 to 1200 characters.");
  if (text) {
    await pool.query(
      `INSERT INTO os_stage_rules (pipeline, stage, meaning, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (pipeline, stage) DO UPDATE SET meaning = EXCLUDED.meaning, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, sel.name, text, user.login],
    );
  } else {
    await pool.query(`DELETE FROM os_stage_rules WHERE pipeline = $1 AND stage = $2`, [key, sel.name]);
  }
  clearStageMapCache();
  await audit(user, "stage-rule.set", `${key}|${sel.name}`, { meaning: text || null });
  return stageMap(f);
}

// ── Work share: the bot and the people ──────────────────────────────────────

export async function workShare(opts: { days: number; funnel?: FunnelKey | null }) {
  const days = Math.min(365, Math.max(7, opts.days));
  const pipe = opts.funnel && PIPE[opts.funnel] ? PIPE[opts.funnel] : null;
  const day = `to_char((%s AT TIME ZONE 'Asia/Makassar')::date, 'YYYY-MM-DD')`;
  const [drafts, msgs, moves, wa] = await Promise.all([
    pool.query(
      `SELECT ${day.replace("%s", "p.created_at")} AS day,
              count(*)::int AS written,
              count(*) FILTER (WHERE p.auto_sent)::int AS autopilot,
              count(*) FILTER (WHERE p.status = 'approved' AND NOT coalesce(p.auto_sent,false))::int AS as_written,
              count(*) FILTER (WHERE p.status = 'edited')::int AS edited,
              count(*) FILTER (WHERE p.status = 'skipped')::int AS skipped
         FROM pending_suggestions p JOIN leads_sync l ON l.lead_id = p.lead_id
        WHERE p.created_at > now() - ($1 || ' days')::interval AND ($2::text IS NULL OR lower(coalesce(l.pipeline,'')) = $2)
        GROUP BY 1 ORDER BY 1`,
      [String(days), pipe],
    ),
    pool.query(
      `SELECT ${day.replace("%s", "m.sent_at")} AS day,
              count(*) FILTER (WHERE m.sender_type = 'broker')::int AS people_msgs,
              count(*) FILTER (WHERE m.sender_type = 'bot')::int AS bot_msgs
         FROM lead_messages m JOIN leads_sync l ON l.lead_id = m.lead_id
        WHERE m.sent_at > now() - ($1 || ' days')::interval AND ($2::text IS NULL OR lower(coalesce(l.pipeline,'')) = $2)
        GROUP BY 1 ORDER BY 1`,
      [String(days), pipe],
    ),
    pool.query(
      `SELECT ${day.replace("%s", "changed_at")} AS day,
              count(*) FILTER (WHERE responsible_user LIKE 'engine:%')::int AS bot_moves,
              count(*) FILTER (WHERE coalesce(responsible_user,'') NOT LIKE 'engine:%')::int AS people_moves
         FROM stage_events WHERE changed_at > now() - ($1 || ' days')::interval AND ($2::text IS NULL OR lower(coalesce(pipeline,'')) = $2)
        GROUP BY 1 ORDER BY 1`,
      [String(days), pipe],
    ),
    // Since the own WhatsApp channel (18–22.09) the gateway knows who sent what:
    // out_copilot went through the Copilot (drafts, autopilot, templates),
    // out_phone was typed on the phone. History imports are not new messages.
    pool
      .query(
        `SELECT ${day.replace("%s", "w.created_at")} AS day,
                count(*) FILTER (WHERE w.direction = 'out_phone')::int AS wa_phone,
                count(*) FILTER (WHERE w.direction = 'out_copilot' AND coalesce(w.status,'') <> 'error')::int AS wa_copilot
           FROM wa_messages w LEFT JOIN leads_sync l ON l.lead_id = w.card_lead_id::text
          WHERE w.created_at > now() - ($1 || ' days')::interval AND coalesce(w.status,'') NOT IN ('history','history_dup')
            AND ($2::text IS NULL OR lower(coalesce(l.pipeline,'')) = $2)
          GROUP BY 1 ORDER BY 1`,
        [String(days), pipe],
      )
      .catch(() => ({ rows: [] as Record<string, unknown>[] })),
  ]);
  const byDay = new Map<string, Record<string, number | string>>();
  const put = (rows: Array<Record<string, unknown>>) => {
    for (const r of rows) {
      const d = String(r.day);
      const cur = byDay.get(d) ?? { day: d };
      for (const [k, v] of Object.entries(r)) if (k !== "day") cur[k] = Number(v ?? 0);
      byDay.set(d, cur);
    }
  };
  put(drafts.rows);
  put(msgs.rows);
  put(moves.rows);
  put(wa.rows);
  const rows = [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  return { days, funnel: opts.funnel ?? null, rows };
}
