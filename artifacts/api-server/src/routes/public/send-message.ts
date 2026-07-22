import { Router } from "express";

const router = Router();

const HOOK_URL = "https://hooks.tglk.ru/in/p5dmPxJ7zyLkZ1HLlPSmaJ24ZQXz9a";

router.options("/send-message", (_req, res) => res.sendStatus(204));

router.post("/send-message", async (req, res) => {
  const body = req.body as { leadId?: string; message?: string };

  if (
    !body?.leadId ||
    typeof body.leadId !== "string" ||
    !body.message ||
    typeof body.message !== "string" ||
    body.message.length > 8000
  ) {
    res.status(400).json({ error: "leadId and message required" });
    return;
  }

  let hookStatus = 0;
  let hookBody = "";
  try {
    const r = await fetch(HOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId: body.leadId, message: body.message }),
    });
    hookStatus = r.status;
    hookBody = (await r.text()).slice(0, 1000);
  } catch (e) {
    req.log.error({ err: e }, "send-message webhook error");
    hookBody = String(e).slice(0, 1000);
  }

  res.json({ ok: hookStatus >= 200 && hookStatus < 300, hookStatus, hookBody });
});

export default router;
