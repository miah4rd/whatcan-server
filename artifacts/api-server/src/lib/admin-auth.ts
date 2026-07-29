import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger";

/**
 * Guards the internal /admin/* and /debug/* endpoints (bulk imports, scheduler
 * runs, whitelist edits, destructive cleanups, raw data dumps) which were
 * previously wide open on the public domain.
 *
 * Design (deliberately fail-OPEN when unconfigured): if ADMIN_TOKEN is not set
 * we log a loud warning and allow — so a missing/late-loading env var can never
 * hard-lock every operational tool at once. Set ADMIN_TOKEN in the VPS .env (and
 * restart with env reload) to ENFORCE. Callers then pass it as either
 * `x-admin-token: <token>` or `Authorization: Bearer <token>`.
 *
 * Exemptions: the amoCRM OAuth subtree (/admin/amo-oauth/*) is called by amoCRM
 * itself (browser redirect / callback) and must stay reachable without our token.
 */
const ADMIN_TOKEN = process.env["ADMIN_TOKEN"];

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const p = req.path; // relative to the router mount (/api) → e.g. "/admin/run-scheduler"
  const isGuarded =
    (p === "/admin" || p.startsWith("/admin/") || p.startsWith("/debug")) &&
    !p.startsWith("/admin/amo-oauth");

  if (!isGuarded) return next();

  if (!ADMIN_TOKEN) {
    logger.warn({ path: p }, "adminAuth: ADMIN_TOKEN not set — admin route is UNPROTECTED (set it in .env to enforce)");
    return next();
  }

  const provided =
    (req.headers["x-admin-token"] as string | undefined) ??
    (req.headers["authorization"] as string | undefined)?.replace(/^Bearer\s+/i, "");

  if (provided !== ADMIN_TOKEN) {
    res.status(401).json({ error: "admin token required (send x-admin-token header)" });
    return;
  }
  next();
}
