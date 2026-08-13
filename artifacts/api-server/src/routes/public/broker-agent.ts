import { Router } from "express";
import { logger } from "../../lib/logger";
import { runListingIntakeTurn, suggestPropertyCode, type IntakeTurn } from "../../lib/listing-intake";
import { publishListingDraft } from "../../lib/listing-publish";
import {
  loadSession,
  saveSession,
  clearSession,
  saveAttachments,
  classifyPublishIntent,
  type Attachment,
} from "../../lib/broker-agent";

/**
 * The webhook the website's `broker-assistant` edge function calls.
 *
 * Contract, fixed by that function and not by us:
 *   POST { sessionId, user: { id, email }, messages: [{ role, content }], attachments: [] }
 *   200  { reply: string }
 * Everything the broker is told therefore has to fit in `reply` — there is no
 * card, no publish button and no second channel on that surface.
 *
 * Authentication is the shared secret the edge function sends. It is required:
 * with no secret configured the endpoint answers 503 rather than serving
 * anybody who finds the URL, because a request that reaches here can publish to
 * the live catalog.
 */

const router = Router();

function bearer(req: { headers: Record<string, unknown> }): string {
  const raw = String(req.headers["authorization"] ?? "");
  return raw.replace(/^Bearer\s+/i, "").trim();
}

/** Timing-safe enough for a fixed-length shared secret compared per request. */
function secretMatches(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function toTurns(raw: unknown): IntakeTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-24)
    .map((m) => {
      const o = (m ?? {}) as Record<string, unknown>;
      return {
        role: o["role"] === "assistant" ? "assistant" : "user",
        text: String(o["content"] ?? o["text"] ?? "").slice(0, 8000),
        images: [],
      } as IntakeTurn;
    })
    .filter((t) => t.text.trim().length > 0);
}

function brokerLabel(user: unknown): string | null {
  const u = (user ?? {}) as Record<string, unknown>;
  const email = String(u["email"] ?? "").trim();
  if (email) return email.split("@")[0] || email;
  const id = String(u["id"] ?? "").trim();
  return id || null;
}

router.post("/broker-agent", async (req, res) => {
  const expected = (process.env["BROKER_AGENT_WEBHOOK_SECRET"] ?? "").trim();
  if (!expected) {
    logger.error("broker agent: BROKER_AGENT_WEBHOOK_SECRET is not set — refusing to answer");
    res.status(503).json({ error: "Listing agent is not configured on the server." });
    return;
  }
  if (!secretMatches(bearer(req as never), expected)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const body = (req.body ?? {}) as {
      sessionId?: unknown;
      user?: unknown;
      messages?: unknown;
      attachments?: unknown;
    };

    const broker = brokerLabel(body.user);
    const sessionId = String(body.sessionId ?? "").trim() || "broker-" + (broker ?? "web");
    const turns = toTurns(body.messages);
    const attachments = Array.isArray(body.attachments) ? (body.attachments as Attachment[]) : [];

    if (!turns.length && !attachments.length) {
      res.json({ reply: "Пришлите текст от собственника или фото — и я соберу листинг." });
      return;
    }

    const session = await loadSession(sessionId, broker);

    // Photos first: they belong to this turn, and the model reads them only on
    // the turn they arrive (see MAX_IMAGES_PER_TURN in listing-intake.ts).
    const { images: fresh, skipped } = await saveAttachments(sessionId, attachments);
    if (fresh.length) session.images = [...session.images, ...fresh].slice(0, 20);

    const lastUser = [...turns].reverse().find((t) => t.role === "user");

    // ── The broker was asked to confirm publishing and just answered ────────
    if (session.pendingCode && lastUser) {
      const intent = await classifyPublishIntent(lastUser.text, session.pendingCode);
      if (intent.confirm) {
        const result = await publishListingDraft({
          draft: session.draft,
          images: session.images,
          // Without an explicit code from the broker, the code is resolved at
          // publish time rather than reused from the proposal: minutes may have
          // passed, and another broker may have taken it in the meantime.
          propertyId: intent.code ?? "auto",
          broker: session.broker,
        });

        if (result.ok) {
          await clearSession(sessionId);
          logger.info({ sessionId, propertyId: result.propertyId, broker }, "listing published from website assistant");
          const photos = session.images.length;
          res.json({
            reply:
              intent.lang === "en"
                ? `Published. The listing is live: ${result.url}\nCode ${result.propertyId}, ${photos} photo(s). Send the next property whenever you like.`
                : `Опубликовал. Листинг на сайте: ${result.url}\nКод ${result.propertyId}, фото: ${photos}. Следующий объект можно скинуть сюда же.`,
          });
          return;
        }

        // The draft stays in the session on purpose — the work is not lost, and
        // the submission row is already sitting in the review queue at /listings.
        logger.error({ sessionId, error: result.error }, "website assistant publish failed");
        res.json({
          reply:
            intent.lang === "en"
              ? `I could not publish it: ${result.error}\nThe listing is saved in the review queue, nothing is lost. Try again or tell the owner.`
              : `Опубликовать не получилось: ${result.error}\nЛистинг сохранён в очереди на проверку, ничего не потеряно. Попробуйте ещё раз или скажите владельцу.`,
        });
        return;
      }
      // Not a yes — it is a correction or a question. Fall through to the normal
      // turn, which is what actually applies it.
      session.pendingCode = null;
    }

    // ── An ordinary intake turn ─────────────────────────────────────────────
    if (lastUser) {
      if (fresh.length) lastUser.images = fresh;
      const notes: string[] = [];
      if (session.images.length) notes.push(`${session.images.length} photo(s) attached to this listing in total`);
      if (skipped.length) {
        notes.push(
          `these files could NOT be read and were ignored: ${skipped.join(", ")} — only JPG, PNG or WebP photos can be read, tell the broker`,
        );
      }
      if (notes.length) lastUser.text = `${lastUser.text}\n\n[System: ${notes.join(". ")}.]`;
    }

    const result = await runListingIntakeTurn(turns, session.draft, { noCard: true });
    session.draft = result.draft;

    let reply = result.reply;
    if (result.ready) {
      const code = (await suggestPropertyCode(result.draft.listingType)).suggestion;
      session.pendingCode = code;
      // Appended as data, not prose: the sentence around it is the model's, in
      // the broker's own language, and this line is the same in every language.
      if (code) reply = `${reply}\n\n[${code} · 📷 ${session.images.length}]`;
    } else {
      session.pendingCode = null;
    }

    await saveSession(session);
    logger.info(
      { sessionId, broker, ready: result.ready, missing: result.missing, photos: session.images.length },
      "website assistant turn",
    );
    res.json({ reply });
  } catch (err) {
    logger.error({ err }, "broker agent turn failed");
    res.status(500).json({ error: "The assistant could not answer. Try again." });
  }
});

export default router;
