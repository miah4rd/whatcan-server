import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, userSettingsTable } from "@workspace/db";

const router = Router();

// GET /api/user-settings/:userId — get settings for a user
router.get("/user-settings/:userId", async (req, res) => {
  const userId = req.params.userId;
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }

  try {
    const [row] = await db
      .select()
      .from(userSettingsTable)
      .where(eq(userSettingsTable.userId, userId))
      .limit(1);

    res.json(row ?? {
      userId,
      outputLanguage: "auto",
      tone: "friendly",
      style: "concise",
      autoApprove: false,
      notifyOnLive: true,
      customInstructions: null,
    });
  } catch (err) {
    req.log.error({ err }, "get user-settings failed");
    res.status(500).json({ error: "internal" });
  }
});

// PUT /api/user-settings/:userId — update settings for a user
router.put("/user-settings/:userId", async (req, res) => {
  const userId = req.params.userId;
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }

  const body = req.body as Partial<{
    outputLanguage: string;
    tone: string;
    style: string;
    autoApprove: boolean;
    notifyOnLive: boolean;
    customInstructions: string;
  }>;

  try {
    const now = new Date();
    await db
      .insert(userSettingsTable)
      .values({ userId, ...body, updatedAt: now })
      .onConflictDoUpdate({
        target: userSettingsTable.userId,
        set: { ...body, updatedAt: now },
      });

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "update user-settings failed");
    res.status(500).json({ error: "internal" });
  }
});

export default router;
