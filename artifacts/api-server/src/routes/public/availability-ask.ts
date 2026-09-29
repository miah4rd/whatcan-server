/** The two ways to answer "are these villas free?" from the client's card (lib/os/availability-ask.ts). */
import { Router } from "express";
import { answerByBroker, askOwners, clarifyWithClient, setQuestion, setVillas, openRemoteAsk, answersFromOs
} from "../../lib/os/availability-ask";

const router = Router();

router.post("/availability-answer", async (req, res) => {
  const b = req.body ?? {};
  try {
    res.json(await answerByBroker(String(b.askId ?? ""), { text: b.text }));
  } catch (err) {
    req.log.error({ err }, "availability answer failed");
    res.status(500).json({ ok: false, error: "Could not save the answer. Try again." });
  }
});

router.post("/availability-ask-owner", async (req, res) => {
  const b = req.body ?? {};
  try {
    res.json(await askOwners(String(b.askId ?? "")));
  } catch (err) {
    req.log.error({ err }, "availability ask-owner failed");
    res.status(500).json({ ok: false, error: "Could not prepare the question to the owner. Try again." });
  }
});

router.post("/availability-villas", async (req, res) => {
  const b = req.body ?? {};
  try {
    res.json(await setVillas(String(b.askId ?? ""), Array.isArray(b.villas) ? b.villas.map(String) : []));
  } catch (err) {
    req.log.error({ err }, "availability villas failed");
    res.status(500).json({ ok: false, error: "Could not save the villas. Try again." });
  }
});

router.post("/availability-clarify", async (req, res) => {
  try {
    res.json(await clarifyWithClient(String(req.body?.askId ?? "")));
  } catch (err) {
    req.log.error({ err }, "availability clarify failed");
    res.status(500).json({ ok: false, error: "Could not write the question to the client. Try again." });
  }
});

router.post("/availability-question", async (req, res) => {
  try {
    res.json(await setQuestion(String(req.body?.askId ?? ""), String(req.body?.question ?? "")));
  } catch (err) {
    req.log.error({ err }, "availability question failed");
    res.status(500).json({ ok: false, error: "Could not save the question. Try again." });
  }
});


// Copilot Amo ⇄ Unicorn OS on the loopback, with the shared gateway secret (lib/os/availability-ask.ts).
function trusted(req: import("express").Request, secret: string | undefined): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return !!secret && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") && req.headers["x-wa-secret"] === secret;
}
router.post("/remote-owner-ask", async (req, res) => {
  if (!trusted(req, process.env["WA_GATEWAY_SECRET"])) return void res.status(401).json({ ok: false, error: "unauthorized" });
  res.json(await openRemoteAsk(req.body ?? {}).catch((err) => ({ ok: false, error: String((err as Error).message ?? err) })));
});
router.post("/remote-owner-answer", async (req, res) => {
  if (!trusted(req, process.env["WA_FORWARD_SECRET"])) return void res.status(401).json({ ok: false, error: "unauthorized" });
  const askId = String(req.body?.askId ?? "");
  if (!/^[0-9a-f-]{36}$/.test(askId)) return void res.status(400).json({ ok: false, error: "askId" });
  res.json(await answersFromOs(askId, req.body?.answers ?? {}).catch((err) => ({ ok: false, error: String((err as Error).message ?? err) })));
});

export default router;
