import { Router } from "express";
import { chatCompletionJSON } from "../../lib/ai-client.js";

const router = Router();

router.options("/parse-task", (_req, res) => res.sendStatus(204));

/**
 * POST /api/public/parse-task
 * Parses a free-form voice/text instruction into a structured CRM task.
 *
 * Body: { text: string }
 * Response: { taskDate: string (ISO date YYYY-MM-DD), taskText: string }
 */
router.post("/parse-task", async (req, res) => {
  const { text } = req.body as { text?: string };
  if (!text?.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  try {
    const parsed = await chatCompletionJSON<{ taskDate?: string; taskText?: string }>({
      model: "claude-sonnet-5",
      system: `Today's date is ${today}.
You are a CRM assistant. Parse the broker's voice instruction into a structured follow-up task.

Extract:
- taskDate: the date when the broker wants to follow up (ISO format YYYY-MM-DD). Resolve relative expressions like "in 2 weeks", "next month", "through 3 weeks" relative to today.
- taskText: a short, clear task description in English (max 80 chars) describing what to do on that date.

Respond with JSON only: {"taskDate": "YYYY-MM-DD", "taskText": "..."}
If no date is mentioned, default to 7 days from today.`,
      messages: [
        {
          role: "user",
          content: text.trim(),
        },
      ],
      max_tokens: 80,
      temperature: 0,
    });

    const taskDate = parsed.taskDate ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const taskText = parsed.taskText ?? text.trim().slice(0, 80);

    res.json({ taskDate, taskText });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg.slice(0, 200) });
  }
});

export default router;
