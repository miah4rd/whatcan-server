import { Router } from "express";

// Groq provides free Whisper API — no OpenAI dependency needed
let _groqClient: any = null;
async function getGroqClient() {
  if (!_groqClient) {
    const apiKey = process.env["GROQ_API_KEY"];
    if (!apiKey) throw new Error("GROQ_API_KEY is required for transcription (free at console.groq.com)");
    const { default: OpenAI } = await import("openai");
    _groqClient = new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" });
  }
  return _groqClient;
}

const router = Router();

router.options("/transcribe", (_req, res) => {
  res.sendStatus(204);
});

router.post(
  "/transcribe",
  (req, res, next) => {
    import("express").then(({ default: express }) => {
      express.raw({ type: "*/*", limit: "10mb" })(req, res, next);
    });
  },
  async (req, res) => {
    try {
      const buf = req.body as Buffer;
      if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
        res.status(400).json({ error: "No audio data" });
        return;
      }
      const contentType = (req.headers["content-type"] || "audio/webm").split(";")[0].trim();
      const ext = contentType.includes("mp4") || contentType.includes("m4a") ? "m4a"
        : contentType.includes("ogg") ? "ogg"
        : contentType.includes("wav") ? "wav"
        : "webm";
      const groq = await getGroqClient();
      const { toFile } = await import("openai");
      const file = await toFile(buf, `audio.${ext}`, { type: contentType });
      const result = await groq.audio.transcriptions.create({
        model: "whisper-large-v3-turbo",
        file,
        response_format: "json",
      });
      res.json({ text: result.text ?? "" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, "transcribe error");
      res.status(502).json({ error: `Transcription failed: ${msg.slice(0, 200)}` });
    }
  }
);

export default router;
