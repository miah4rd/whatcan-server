/**
 * Unicorn OS — the web app at /os and its API at /os/api.
 *
 * A second home for the work the Copilot already does, with sign-in and
 * roles. The Copilot itself is not re-implemented: the card panel embeds /m
 * (the one implementation of drafting, approving, editing by voice, villa
 * picking, stage moves and reports), and the list of drafts reads the same
 * /api/public endpoints, mounted again under /os/api/p behind a session.
 *
 * The frontend is plain files in artifacts/os-web (no build step), served
 * with an SPA fallback. The site's worker proxies unicorn-properties.com/os
 * here, so the app and its cookie live on the agency's own domain.
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import publicRouter from "./public";
import { copilotDefaultGuide } from "./mobile";
import {
  ensureOsTables,
  login,
  logout,
  changePassword,
  requireOsUser,
  isStaff,
  listUsers,
  createUser,
  resetPassword,
  updateUser,
  type OsRole,
} from "../lib/os/auth";
import {
  pipelines,
  boardCards,
  leadDetail,
  movePersonStage,
  setTemperature,
  tasksFor,
  completeTask,
  rescheduleTask,
  createTask,
  calendar,
  notifications,
  markNotificationsSeen,
  integrations,
  matchingClients,
  cleanupCount,
  activeBrokers,
  viewingReportDetail,
} from "../lib/os/data";
import {
  listListings,
  getListing,
  updateListing,
  updatePrivate,
  setAvailability,
  photoUploadUrl,
  proposeEdit,
  describeFields,
} from "../lib/os/listings";
import {
  objectionsSummary,
  scanObjections,
  funnelWeeks,
  stageWaits,
  weeklyReview,
  latestBrief,
  generateBrief,
  OBJECTION_CATEGORIES,
  CLOSE_REASONS,
  listTargets,
  setTarget,
  targetsAt,
  gateOptionsToViewing,
  gateViewingToDeal,
  gateYudi,
  supplyGaps,
  draftsDecided,
  aiCost,
  lastFullWeek,
  mondayOf,
} from "../lib/os/analytics";
import { baliDate } from "../lib/kpi-dashboard";
import { automations, setAutomation } from "../lib/os/automations";
import { teamScorecard, setFunnelTarget, type FunnelKey } from "../lib/os/team";
import { stageMap, setStageRule, workShare, AUTOPILOT_RULE_ID, type FunnelKey as MapFunnel } from "../lib/os/automation-map";
import {
  ensureProjectTables,
  seedFromNotion,
  people,
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  listTasks as listProjectTasks,
  taskDetail as projectTaskDetail,
  createTask as createProjectTask,
  updateTask as updateProjectTask,
  deleteTask as deleteProjectTask,
  restoreTask as restoreProjectTask,
  addComment as addProjectComment,
  TASK_STATUSES,
  PROJECT_STATUSES,
  PRIORITIES,
  ESTIMATES,
} from "../lib/os/projects";
import { logger } from "../lib/logger";
import { REACH_STAGE_KEYWORDS } from "../lib/pipelines";

const router = Router();
const COPILOT_ORIGIN = process.env["PUBLIC_BASE_URL"] || "https://copilot.globalapplab.ru";
const webDir = path.resolve(__dirname, "../../os-web");

ensureOsTables()
  .then(() => ensureProjectTables())
  .then(() => seedFromNotion())
  .catch((err) => logger.warn({ err }, "os tables"));

// Every handler answers JSON errors in words a person can act on.
const h =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err, path: req.path, user: req.osUser?.login }, "os api error");
      if (!res.headersSent) res.status(400).json({ error: msg.slice(0, 400) });
    }
  };

const api = Router();
api.use(express.json({ limit: "2mb" }));

// ── Sign-in ──────────────────────────────────────────────────────────────────
api.post("/login", (req, res) => void login(req, res).catch((err) => res.status(500).json({ error: String(err) })));
api.post("/logout", (req, res) => void logout(req, res));

// Everything below needs a session.
const signedIn = requireOsUser();
const staffOnly = requireOsUser(["admin", "manager"]);
const adminOnly = requireOsUser(["admin"]);

api.get("/me", signedIn, h(async (req) => ({ user: req.osUser })));
api.post("/password", signedIn, (req, res) => void changePassword(req, res));

api.get(
  "/meta",
  signedIn,
  h(async (req) => {
    const u = req.osUser!;
    const [pl, brokers] = await Promise.all([pipelines(), activeBrokers()]);
    return {
      user: u,
      staff: isStaff(u),
      copilotOrigin: COPILOT_ORIGIN,
      pipelines: pl,
      brokers,
      objectionCategories: OBJECTION_CATEGORIES,
      closeReasons: CLOSE_REASONS,
      reachStages: REACH_STAGE_KEYWORDS,
      people: await people(),
      projectFormat: { taskStatuses: TASK_STATUSES, projectStatuses: PROJECT_STATUSES, priorities: PRIORITIES, estimates: ESTIMATES },
      listingFields: describeFields(),
    };
  }),
);

// ── Cards ────────────────────────────────────────────────────────────────────
api.get(
  "/leads",
  signedIn,
  h(async (req) => ({
    items: await boardCards(req.osUser!, {
      pipeline: String(req.query["pipeline"] ?? "rental"),
      broker: (req.query["broker"] as string) || null,
      closed: req.query["closed"] === "1",
      activeDays: req.query["active"] === "all" ? null : Math.min(3650, Number(req.query["active"] ?? 90) || 90),
    }),
  })),
);
api.get(
  "/leads/:id",
  signedIn,
  h(async (req, res) => {
    const d = await leadDetail(req.osUser!, String(req.params["id"]));
    if (!d) return void res.status(404).json({ error: "No such card." });
    if ("forbidden" in d) return void res.status(403).json({ error: "This card is not yours." });
    return d;
  }),
);
api.post(
  "/leads/:id/stage",
  signedIn,
  h(async (req) => {
    const r = await movePersonStage(req.osUser!, String(req.params["id"]), String(req.body?.stage ?? ""), {
      reason: (req.body?.reason as string) ?? null,
      detail: (req.body?.detail as string) ?? null,
    });
    if (!r.ok) throw new Error(r.error ?? "Not moved.");
    return r;
  }),
);
api.post(
  "/leads/:id/temperature",
  signedIn,
  h(async (req) => {
    await setTemperature(req.osUser!, String(req.params["id"]), String(req.body?.temperature ?? ""));
    return { ok: true };
  }),
);

// ── Tasks (amoCRM's own) ─────────────────────────────────────────────────────
api.get("/tasks", signedIn, h(async (req) => ({ items: await tasksFor(req.osUser!, { all: req.query["all"] === "1" }) })));
api.get("/tasks/cleanup", signedIn, h(async (req) => ({ count: await cleanupCount(req.osUser!) })));
api.post(
  "/tasks",
  signedIn,
  h(async (req) => {
    const due = new Date(String(req.body?.due ?? ""));
    if (Number.isNaN(due.getTime())) throw new Error("Pick a due date.");
    const text = String(req.body?.text ?? "").trim();
    if (!text) throw new Error("Write what needs doing.");
    await createTask(req.osUser!, String(req.body?.leadId ?? ""), text, due);
    return { ok: true };
  }),
);
api.post(
  "/tasks/:id/complete",
  signedIn,
  h(async (req) => {
    await completeTask(req.osUser!, Number(req.params["id"]), String(req.body?.result ?? ""));
    return { ok: true };
  }),
);
api.post(
  "/tasks/:id/reschedule",
  signedIn,
  h(async (req) => {
    const due = new Date(String(req.body?.due ?? ""));
    if (Number.isNaN(due.getTime())) throw new Error("Pick a new date.");
    await rescheduleTask(req.osUser!, Number(req.params["id"]), due);
    return { ok: true };
  }),
);

// ── Calendar, notifications ─────────────────────────────────────────────────
api.get(
  "/calendar",
  signedIn,
  h(async (req) => {
    const from = new Date(String(req.query["from"] ?? new Date(Date.now() - 7 * 86400_000).toISOString()));
    const to = new Date(String(req.query["to"] ?? new Date(Date.now() + 21 * 86400_000).toISOString()));
    return { events: await calendar(req.osUser!, from, to) };
  }),
);
api.get("/notifications", signedIn, h(async (req) => notifications(req.osUser!)));
api.post(
  "/notifications/seen",
  signedIn,
  h(async (req) => {
    await markNotificationsSeen(req.osUser!);
    return { ok: true };
  }),
);

// ── Villas (the website catalog) ─────────────────────────────────────────────
api.get(
  "/listings",
  signedIn,
  h(async (req) => ({
    items: await listListings({ type: (String(req.query["type"] ?? "rent") as "rent" | "sale" | "all"), drafts: req.query["drafts"] === "1" }),
  })),
);
api.get(
  "/listings/:id",
  signedIn,
  h(async (req, res) => {
    const l = await getListing(String(req.params["id"]));
    if (!l) return void res.status(404).json({ error: "No such listing." });
    return l;
  }),
);
api.patch("/listings/:id", signedIn, h(async (req) => updateListing(req.osUser!, String(req.params["id"]), req.body ?? {})));
api.patch("/listings/:id/private", signedIn, h(async (req) => updatePrivate(req.osUser!, String(req.params["id"]), req.body ?? {})));
api.post(
  "/listings/:id/availability",
  signedIn,
  h(async (req) => setAvailability(req.osUser!, String(req.params["id"]), { freeFrom: req.body?.freeFrom ?? null, occupiedNoDate: Boolean(req.body?.occupiedNoDate) })),
);
api.get(
  "/listings/:id/matches",
  signedIn,
  h(async (req, res) => {
    const l = await getListing(String(req.params["id"]));
    if (!l) return void res.status(404).json({ error: "No such listing." });
    return { items: await matchingClients(req.osUser!, l as never) };
  }),
);
api.post("/listings/:id/photo-url", signedIn, h(async (req) => photoUploadUrl(String(req.params["id"]), String(req.body?.fileName ?? "photo.jpg"))));
api.post(
  "/listings/:id/ai-edit",
  signedIn,
  h(async (req) => {
    const instruction = String(req.body?.instruction ?? "").trim();
    if (instruction.length < 3) throw new Error("Say or type what to change.");
    return proposeEdit(req.osUser!, String(req.params["id"]), instruction);
  }),
);

// The guide the Copilot sends with a rewrite, the same text as the /m page's.
api.get("/copilot/guide", signedIn, h(async () => ({ guide: copilotDefaultGuide() })));

// One viewing report, whole: feedback, what did not work, next step.
api.get("/viewing-reports/:id", signedIn, h(async (req) => viewingReportDetail(req.osUser!, String(req.params["id"]))));

// ── Analytics ────────────────────────────────────────────────────────────────
const scopeBroker = (req: Request) => (isStaff(req.osUser) ? ((req.query["broker"] as string) || null) : req.osUser!.brokerKey);
api.get("/analytics/objections", signedIn, h(async (req) => objectionsSummary({ days: Math.min(180, Number(req.query["days"] ?? 30) || 30), broker: scopeBroker(req) })));
api.post("/analytics/objections/scan", staffOnly, h(async () => scanObjections({ days: 30 })));
api.get(
  "/analytics/funnel",
  signedIn,
  h(async (req) => funnelWeeks({ pipeline: String(req.query["pipeline"] ?? "Rental"), weeks: Math.min(26, Number(req.query["weeks"] ?? 6) || 6), broker: scopeBroker(req) })),
);
api.get("/analytics/waits", signedIn, h(async (req) => ({ stages: await stageWaits({ pipeline: String(req.query["pipeline"] ?? "Rental"), broker: scopeBroker(req) }) })));
api.get("/analytics/review", staffOnly, h(async (req) => weeklyReview((req.query["week"] as string) || undefined)));
api.get("/analytics/briefs", staffOnly, h(async () => ({ items: await latestBrief() })));
api.post("/analytics/briefs", staffOnly, h(async (req) => generateBrief(req.osUser!.login, (req.body?.week as string) || undefined)));
const weekParam = (req: Request) => {
  const w = String(req.query["week"] ?? "");
  if (w === "current") return mondayOf(baliDate());
  return /^\d{4}-\d{2}-\d{2}$/.test(w) ? mondayOf(w) : lastFullWeek();
};
api.get(
  "/analytics/gates",
  signedIn,
  h(async (req) => {
    const ws = weekParam(req);
    const [targets, g1, g2, y, drafts] = await Promise.all([
      targetsAt(ws),
      gateOptionsToViewing(ws, scopeBroker(req)).catch((e) => ({ error: String(e) })),
      gateViewingToDeal(ws, scopeBroker(req)).catch((e) => ({ error: String(e) })),
      isStaff(req.osUser) || /yudi/i.test(req.osUser!.brokerKey ?? "") ? gateYudi(ws).catch((e) => ({ error: String(e) })) : Promise.resolve(null),
      isStaff(req.osUser) ? draftsDecided(ws) : Promise.resolve([]),
    ]);
    return { weekStart: ws, targets, gateOptionsToViewing: g1, gateViewingToDeal: g2, gateYudi: y, drafts };
  }),
);
// Each funnel on its own: the people in it, their week against targets and the team, and why.
api.get(
  "/analytics/team",
  signedIn,
  h(async (req) => {
    const w = String(req.query["date"] ?? req.query["week"] ?? "");
    const card = await teamScorecard(String(req.query["funnel"] ?? "rental") as FunnelKey, { period: String(req.query["period"] ?? "week"), date: /^\d{4}-\d{2}-\d{2}$/.test(w) ? w : undefined });
    // A broker sees their own row and the team's totals, not the others one by one.
    if (!isStaff(req.osUser)) {
      const me = String(req.osUser!.brokerKey ?? "").toLowerCase();
      card.people = card.people.filter((p) => p.name.toLowerCase() === me);
    }
    return card;
  }),
);
api.post(
  "/analytics/team-targets",
  staffOnly,
  h(async (req) => {
    const b = req.body ?? {};
    await setFunnelTarget(req.osUser!.login, {
      funnel: String(b.funnel ?? ""),
      metric: String(b.metric ?? ""),
      who: String(b.who ?? ""),
      value: b.value === null || b.value === "" || b.value === undefined ? null : Number(b.value),
      floor: b.floor === null || b.floor === "" || b.floor === undefined ? null : Number(b.floor),
      from: String(b.from ?? ""),
      period: String(b.period ?? "week"),
      note: b.note ? String(b.note) : undefined,
    });
    return { ok: true };
  }),
);
api.get("/analytics/supply", signedIn, h(async (req) => supplyGaps(Math.min(60, Number(req.query["days"] ?? 14) || 14))));
api.get("/analytics/ai-cost", staffOnly, h(async (req) => ({ rows: await aiCost(Math.min(31, Number(req.query["days"] ?? 7) || 7)) })));
api.get("/analytics/targets", signedIn, h(async () => ({ items: await listTargets() })));
api.post(
  "/analytics/targets",
  adminOnly,
  h(async (req) => {
    await setTarget(req.osUser!.login, {
      key: String(req.body?.key ?? ""),
      value: Number(req.body?.value),
      floor: req.body?.floor == null || req.body?.floor === "" ? null : Number(req.body.floor),
      from: String(req.body?.from ?? ""),
      note: (req.body?.note as string) ?? undefined,
    });
    return { items: await listTargets() };
  }),
);
api.get(
  "/analytics/kpi-url",
  staffOnly,
  h(async () => {
    const { rows } = await pool.query(`SELECT value FROM broker_settings WHERE key = 'kpi_dashboard_key'`);
    const key = rows[0]?.value as string | undefined;
    return { url: key ? `${COPILOT_ORIGIN}/kpi?k=${encodeURIComponent(key)}` : null };
  }),
);

// ── Projects: goals and tasks (the owner's Notion boards, moved in) ─────────
const idp = (req: Request) => {
  const n = Number(req.params["id"]);
  if (!Number.isInteger(n) || n <= 0) throw new Error("Unknown id.");
  return n;
};
api.get("/projects", signedIn, h(async (req) => ({ items: await listProjects(req.osUser!, { includeDone: req.query["done"] !== "0" }) })));
api.post("/projects", staffOnly, h(async (req) => createProject(req.osUser!, req.body ?? {})));
api.patch("/projects/:id", staffOnly, h(async (req) => updateProject(req.osUser!, idp(req), req.body ?? {})));
api.delete("/projects/:id", staffOnly, h(async (req) => deleteProject(req.osUser!, idp(req))));
api.get(
  "/ptasks",
  signedIn,
  h(async (req) => ({
    items: await listProjectTasks(req.osUser!, {
      projectId: req.query["project"] ? String(req.query["project"]) : undefined,
      assignee: req.query["assignee"] ? String(req.query["assignee"]) : undefined,
      archived: req.query["archived"] === "1",
    }),
  })),
);
api.get("/ptasks/:id", signedIn, h(async (req) => projectTaskDetail(req.osUser!, idp(req))));
api.post("/ptasks", staffOnly, h(async (req) => createProjectTask(req.osUser!, req.body ?? {})));
api.patch("/ptasks/:id", signedIn, h(async (req) => updateProjectTask(req.osUser!, idp(req), req.body ?? {})));
api.delete("/ptasks/:id", staffOnly, h(async (req) => deleteProjectTask(req.osUser!, idp(req))));
api.post("/ptasks/:id/restore", staffOnly, h(async (req) => restoreProjectTask(req.osUser!, idp(req))));
api.post("/ptasks/:id/comments", signedIn, h(async (req) => addProjectComment(req.osUser!, idp(req), req.body ?? {})));

// ── Automations, team, integrations ─────────────────────────────────────────
api.get("/automations", signedIn, h(async (req) => automations(isStaff(req.osUser))));
// A funnel as the automation sees it: who moves cards into each stage, the autopilot line, readiness.
api.get("/automations/map", signedIn, h(async (req) => stageMap(String(req.query["funnel"] ?? "rental") as MapFunnel)));
api.post(
  "/automations/stage-rule",
  staffOnly,
  h(async (req) => setStageRule(req.osUser!, String(req.body?.funnel ?? "") as MapFunnel, String(req.body?.stage ?? ""), req.body?.meaning == null ? null : String(req.body.meaning))),
);
api.post(
  "/automations/autopilot",
  staffOnly,
  h(async (req) => {
    const f = String(req.body?.funnel ?? "") as MapFunnel;
    if (!AUTOPILOT_RULE_ID[f]) throw new Error("Unknown funnel.");
    await setAutomation(req.osUser!, AUTOPILOT_RULE_ID[f], req.body ?? {});
    return stageMap(f);
  }),
);
api.get(
  "/analytics/workshare",
  staffOnly,
  h(async (req) => workShare({ days: Number(req.query["days"] ?? 30) || 30, funnel: (req.query["funnel"] as MapFunnel) || null })),
);
api.post("/automations/:id", staffOnly, h(async (req) => setAutomation(req.osUser!, String(req.params["id"]), req.body ?? {})));
api.get("/integrations", staffOnly, h(async () => integrations()));
api.get("/team", staffOnly, h(async () => ({ items: await listUsers() })));
api.post(
  "/team",
  adminOnly,
  h(async (req) =>
    createUser(req.osUser!, {
      login: String(req.body?.login ?? ""),
      name: String(req.body?.name ?? ""),
      role: String(req.body?.role ?? "broker") as OsRole,
      brokerKey: (req.body?.brokerKey as string) ?? null,
    }),
  ),
);
api.post("/team/:id/reset", adminOnly, h(async (req) => ({ password: await resetPassword(req.osUser!, Number(req.params["id"])) })));
api.patch(
  "/team/:id",
  adminOnly,
  h(async (req) => {
    await updateUser(req.osUser!, Number(req.params["id"]), req.body ?? {});
    return { ok: true };
  }),
);

router.use("/os/api", api);
// The OS lists drafts, it does not read them: with lite=1 the drafts list
// comes without each card's conversation and notes (290 of 530 KB for one
// broker). Same handler, same drafts; only the answer is trimmed.
const LITE_DROP = ["recent_messages", "attachments", "profile_summary", "lead_notes", "form_answers", "suggestionText"];
router.use("/os/api/p/suggestions", (req, res, next) => {
  const lite = req.query["lite"] === "1";
  // The OS's own Copilot asks for one card: the same list, only that lead's draft.
  const onlyLead = typeof req.query["leadId"] === "string" ? String(req.query["leadId"]) : null;
  if (!lite && !onlyLead) return next();
  const send = res.json.bind(res);
  res.json = ((body: { items?: Array<Record<string, unknown>> } | null) => {
    if (body && Array.isArray(body.items) && onlyLead) body = { ...body, items: body.items.filter((it) => String(it["lead_id"]) === onlyLead) };
    if (body && Array.isArray(body.items) && lite) {
      body = {
        ...body,
        items: body.items.map((it) => {
          const o: Record<string, unknown> = { ...it };
          for (const k of LITE_DROP) delete o[k];
          for (const k of ["suggestion_text", "last_lead_text"]) if (typeof o[k] === "string") o[k] = (o[k] as string).slice(0, 280);
          return o;
        }),
      };
    }
    return send(body);
  }) as typeof res.json;
  next();
});
// The Copilot's own endpoints (drafts list, dictation, push subscription,
// reports, autopilot readiness), unchanged, behind the OS session.
router.use("/os/api/p", signedIn, publicRouter);
router.use("/os/api", (_req, res) => void res.status(404).json({ error: "Unknown endpoint." }));

// ── The app itself ───────────────────────────────────────────────────────────
router.get("/os/sw.js", (_req, res) => {
  res.setHeader("Service-Worker-Allowed", "/os/");
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(webDir, "sw.js"));
});
// Every script and stylesheet carries the build in its address, imports between
// scripts included. Cloudflare gives browsers a 4-hour cache on the site's
// domain: on 26.09 a fresh app.js met a cached core.js without the functions it
// imports, and the OS stopped at "Loading" until a hard reload. With the build
// in every address a deploy means new addresses, so old and new never mix.
let buildId = "";
function currentBuild(): string {
  if (!buildId) {
    const h = crypto.createHash("sha1");
    for (const f of fs.readdirSync(webDir).sort()) {
      const p = path.join(webDir, f);
      if (fs.statSync(p).isFile()) h.update(f).update(fs.readFileSync(p));
    }
    buildId = h.digest("hex").slice(0, 10);
  }
  return buildId;
}
const versioned = new Map<string, Buffer>();
const IMPORT_SPEC = /((?:from|import)\s*\(?\s*")(\.\/[a-z0-9-]+\.js)(")/g;
router.get(/^\/os\/([a-z0-9-]+\.(?:js|css))$/, (req, res, next) => {
  const name = String((req.params as Record<string, string>)[0] ?? "");
  if (name === "sw.js") return next();
  const file = path.join(webDir, name);
  if (!fs.existsSync(file)) return next();
  let body = versioned.get(name);
  if (!body) {
    const raw = fs.readFileSync(file, "utf8");
    body = Buffer.from(name.endsWith(".js") ? raw.replace(IMPORT_SPEC, (_m, a: string, spec: string, b: string) => `${a}${spec}?v=${currentBuild()}${b}`) : raw);
    versioned.set(name, body);
  }
  res.type(name.endsWith(".css") ? "text/css" : "application/javascript");
  // A versioned address never changes: cache it for good. Any other is checked every time.
  res.setHeader("Cache-Control", req.query["v"] === currentBuild() ? "public, max-age=31536000, immutable" : "no-cache");
  res.send(body);
});
router.use("/os", express.static(webDir, { index: false, maxAge: "5m", fallthrough: true }));
// Express 5 (path-to-regexp 8) rejects "/os/*" at startup; a regex is the SPA fallback.
let indexHtml = "";
router.get(/^\/os(\/.*)?$/, (_req, res) => {
  if (!indexHtml) indexHtml = fs.readFileSync(path.join(webDir, "index.html"), "utf8").replace(/\?v=[0-9a-z]+/g, `?v=${currentBuild()}`);
  res.setHeader("Cache-Control", "no-cache");
  res.type("html").send(indexHtml);
});

export default router;
