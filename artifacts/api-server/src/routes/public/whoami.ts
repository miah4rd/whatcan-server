import { Router } from "express";
import { resolveAmoUserFirstName } from "../../lib/amo-client";

const router = Router();

router.options("/whoami", (_req, res) => res.sendStatus(204));

/**
 * GET /api/public/whoami?userId=<amoCRM user id>
 * Resolves an amoCRM user id → broker first-name using the server's admin token.
 * The extension can read its own current_user_id from /api/v4/account (allowed
 * for any broker) but NOT list /api/v4/users (admin-only → 403), so it asks us
 * to map the id to a name. Returns { name: "Amelia" } or { name: null }.
 */
router.get("/whoami", async (req, res) => {
  const userId = Number(req.query["userId"]);
  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ error: "userId required" });
    return;
  }
  try {
    const name = await resolveAmoUserFirstName(userId);
    res.json({ name: name ?? null });
  } catch (err) {
    req.log.error({ err, userId }, "whoami resolve failed");
    res.status(500).json({ error: "internal", name: null });
  }
});

export default router;
