/** The two ways to answer "are these villas free?" from the client's card (lib/os/availability-ask.ts). */
import { Router } from "express";
import { answerByBroker, askOwners, clarifyWithClient, setQuestion, setVillas } from "../../lib/os/availability-ask";

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

export default router;
