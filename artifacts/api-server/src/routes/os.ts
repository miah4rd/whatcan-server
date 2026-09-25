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
import express, { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import publicRouter from "./public";
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
import { logger } from "../lib/logger";
import { REACH_STAGE_KEYWORDS } from "../lib/pipelines";

const router = Router();
const COPILOT_ORIGIN = process.env["PUBLIC_BASE_URL"] || "https://copilot.globalapplab.ru";
const webDir = path.resolve(__dirname, "../../os-web");

ensureOsTables().catch(() => undefined);

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
    const [pl, brokers] = await Promise.all([
      pipelines(),
      pool.query(
        `SELECT DISTINCT responsible_user AS b FROM leads_sync WHERE responsible_user IS NOT NULL AND coalesce(lead_stage,'') NOT ILIKE '%closed%' ORDER BY 1`,
      ),
    ]);
    return {
      user: u,
      staff: isStaff(u),
      copilotOrigin: COPILOT_ORIGIN,
      pipelines: pl,
      brokers: brokers.rows.map((r) => String(r.b)),
      objectionCategories: OBJECTION_CATEGORIES,
      closeReasons: CLOSE_REASONS,
      reachStages: REACH_STAGE_KEYWORDS,
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
      gateOptionsToViewing(ws).catch((e) => ({ error: String(e) })),
      gateViewingToDeal(ws).catch((e) => ({ error: String(e) })),
      isStaff(req.osUser) || /yudi/i.test(req.osUser!.brokerKey ?? "") ? gateYudi(ws).catch((e) => ({ error: String(e) })) : Promise.resolve(null),
      isStaff(req.osUser) ? draftsDecided(ws) : Promise.resolve([]),
    ]);
    return { weekStart: ws, targets, gateOptionsToViewing: g1, gateViewingToDeal: g2, gateYudi: y, drafts };
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

// ── Automations, team, integrations ─────────────────────────────────────────
api.get("/automations", signedIn, h(async (req) => automations(isStaff(req.osUser))));
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
router.use("/os", express.static(webDir, { index: false, maxAge: "5m", fallthrough: true }));
// Express 5 (path-to-regexp 8) rejects "/os/*" at startup; a regex is the SPA fallback.
router.get(/^\/os(\/.*)?$/, (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(webDir, "index.html"));
});

export default router;
