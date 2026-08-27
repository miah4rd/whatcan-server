/**
 * The one way a message leaves this system and reaches a client's WhatsApp.
 *
 * Everything here used to live inline in routes/public/approve.ts, because for a
 * long time there was exactly one way to send: a broker taps Approve. Ad-lead
 * auto-reply added a second caller, and this project's whole history says what
 * happens next when the same behaviour exists twice (see the TWO
 * generateSuggestion implementations in CLAUDE.md — every rule added to one of
 * them silently did nothing on the other path). So the guards and the delivery
 * live in one place and both callers go through them.
 *
 * The send is three separable steps because the caller has to be able to react
 * between them:
 *   1. resolveSendChannel — may we send at all, and on whose line?
 *   2. deliverText        — the message itself.
 *   3. sendAttachmentLinks — each property link as its own message.
 */
import { db, sentMessagesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { updateLeadCustomField, triggerSalesbot } from "./amo-chat-client";
import { resolveOutboundSource, fillMessengerFromResponsibleIfNoMessages } from "./amo-messenger-field";
import { countActiveWhatsappChats } from "./amo-client.js";
import { stripEmojiForDelivery } from "./message-delivery.js";
import { fetchTimeline, parseTimelineEvents, getAmoAuth } from "./amo-timeline-sync.js";

/** amoCRM custom field the Salesbot reads the outgoing text from. */
export const COMPANION_FIELD_ID = 965907;
/** amoCRM Salesbot that picks the field up and delivers it over WhatsApp. */
export const COMPANION_ROBERT_BOT_ID = 22127;

/**
 * How far a send got, stamped into the delivery record's webhookResponse.
 * "…| links 2/3" means the text and two of three links reached the client.
 */
export const LINK_PROGRESS = /\|\s*links (\d+)\/(\d+)/;

type Log = { warn: (obj: object, msg: string) => void };

export type ChannelResult =
  | { ok: true; source: string }
  | { ok: false; error: "channel_unresolved" | "multiple_chat_threads"; message: string };

/**
 * Decide whether this lead can be safely sent to, and on which line.
 *
 * Both refusals here are deliberate: a send that goes out blind is worse than
 * one that does not go out at all, because the broker is told "Sent" either way.
 */
export async function resolveSendChannel(
  leadId: string,
  responsibleUser: string | null,
  log: Log,
): Promise<ChannelResult> {
  // No-dialog guard: a fresh ad lead has no messages, so the timeline sync has
  // nothing to derive the channel from — point the field at the responsible
  // user's own line first. A no-op when the lead does have a dialog.
  await fillMessengerFromResponsibleIfNoMessages(leadId, responsibleUser).catch((e) => {
    log.warn({ leadId, err: e }, "fillMessengerFromResponsible threw");
  });

  // Salesbot reads the "last messenger" field to decide which line/thread to
  // send through. With that field empty it still accepts the trigger and
  // returns 200, then delivers into the wrong conversation (or not at all) —
  // amoCRM shows a red "Error" while the broker's inbox says "Sent". That
  // silent false success is worse than any delivery failure.
  const source = await resolveOutboundSource(leadId, responsibleUser).catch((e) => {
    log.warn({ leadId, err: e }, "resolveOutboundSource threw");
    return null;
  });
  if (!source) {
    return {
      ok: false,
      error: "channel_unresolved",
      message:
        "Could not resolve the sending channel for this lead — the message was NOT sent. Send it manually from amoCRM (the draft stays in your inbox).",
    };
  }

  // If a lead has two active WhatsApp chat threads (WAhelp registered the same
  // number twice — "+61…" and "61…"), a single Salesbot send fans out to BOTH
  // and the client gets the message twice. Addressing is line-level, not
  // chat-level, so we cannot pick one from here.
  const activeChats = await countActiveWhatsappChats(leadId);
  if (activeChats >= 2) {
    return {
      ok: false,
      error: "multiple_chat_threads",
      message:
        "This lead has 2 active WhatsApp threads on the same number — auto-sending would deliver the message twice. It was NOT sent. Send it manually from amoCRM into the main thread (the draft stays in your inbox). Cause: a duplicate thread in WAhelp, fixed on the integration side.",
    };
  }

  return { ok: true, source: String(source) };
}

export type DeliverResult = {
  /** The lead is gone from amoCRM (deleted or merged) — nothing to send to. */
  leadMissing: boolean;
  /** The Salesbot accepted the trigger. */
  chatSent: boolean;
  hookStatus: number;
  hookBody: string;
  /** What actually went out, after emoji stripping — this is what we record. */
  deliveryText: string;
};

/**
 * Write the text into the Salesbot's field and trigger it.
 *
 * Emoji are stripped first: the Salesbot/WAhelp pipeline truncates the message
 * at the first astral-plane character, so clients were receiving only the
 * greeting and nothing after it.
 */
export async function deliverText(leadId: string, text: string, log: Log): Promise<DeliverResult> {
  const deliveryText = stripEmojiForDelivery(text);
  let hookStatus = 0;
  let hookBody = "";
  let chatSent = false;

  const fieldWrite = await updateLeadCustomField(leadId, COMPANION_FIELD_ID, deliveryText);
  if (fieldWrite.leadMissing) {
    return { leadMissing: true, chatSent: false, hookStatus: 410, hookBody: "lead missing", deliveryText };
  }

  try {
    if (fieldWrite.ok) {
      chatSent = await triggerSalesbot(leadId, COMPANION_ROBERT_BOT_ID);
      hookStatus = chatSent ? 200 : 500;
      hookBody = chatSent ? `Salesbot ${COMPANION_ROBERT_BOT_ID} triggered` : "Salesbot trigger failed";
    } else {
      hookStatus = 500;
      hookBody = "Custom field update failed";
    }
  } catch (e) {
    log.warn({ leadId, err: e }, "Salesbot send error");
    hookStatus = 500;
    hookBody = String(e).slice(0, 1000);
  }

  return { leadMissing: false, chatSent, hookStatus, hookBody, deliveryText };
}

/**
 * What has ACTUALLY reached the client, read back from the amoCRM timeline.
 *
 * Every guard below used to reason from our own bookkeeping — "we wrote the
 * field, so the message went out", "this suggestion id was sent before". Both
 * assumptions broke in production: the Salesbot reads the shared field late and
 * sends whatever it finds there, and a broker editing a draft produces a NEW
 * suggestion id that our dedupe could not recognise. The timeline is the only
 * source that cannot disagree with what the client sees.
 */
async function outboundTexts(leadId: string): Promise<string[] | null> {
  const auth = await getAmoAuth();
  if (!auth) return null;
  const events = await fetchTimeline(auth, leadId, 30);
  if (!events.length) return null;
  return parseTimelineEvents(leadId, events)
    .filter((m) => m.direction === "outbound")
    .map((m) => m.text ?? "");
}

/** Loose match: WhatsApp and the Salesbot both reflow whitespace. */
function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function alreadyOut(sent: string[], value: string): boolean {
  const needle = normalise(value);
  if (!needle) return false;
  return sent.some((t) => normalise(t).includes(needle.slice(0, 120)));
}

/**
 * Block until `value` shows up as an outbound message, or the budget runs out.
 *
 * This replaces a flat sleep. The old code waited 3000ms and then overwrote the
 * shared field regardless — if the Salesbot had not read it yet, the text was
 * destroyed before it was ever sent and the client received only the link.
 * Returns false when nothing could be confirmed, and the caller must then NOT
 * overwrite: a missing link is a nuisance, a swallowed message is a lost lead.
 */
async function waitForOutbound(leadId: string, value: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const sent = await outboundTexts(leadId).catch(() => null);
    // Timeline unreadable — fall back to the old timing behaviour rather than
    // blocking the send entirely.
    if (sent === null) return true;
    if (alreadyOut(sent, value)) return true;
  }
  return false;
}

/**
 * Deliver the property links, each as its OWN WhatsApp message — glued into one
 * message, WhatsApp only unfurls a rich preview banner for the first link.
 *
 * The text and every link share ONE amoCRM custom field: write, trigger, then
 * overwrite with the next value and trigger again. The gap before the FIRST
 * link is the riskiest one — Salesbot has to actually read and dispatch the text
 * message before this loop overwrites the field with a URL, and a lead amoCRM
 * hasn't processed before (a fresh contact especially) appears to take longer
 * than a routine reply. A flat 1200ms was cutting that close enough that the
 * text sometimes never went out — only the link did, because by the time
 * Salesbot got around to reading the field, it already held the URL.
 *
 * Every link that lands is stamped into the delivery record as "links k/n".
 * That marker is the ONLY thing that lets an interrupted send resume from where
 * it stopped instead of replaying the whole message at the client.
 *
 * @param startIndex first link to send — > 0 when resuming an interrupted send.
 * @returns how many links have now been delivered in total.
 */
export async function sendAttachmentLinks(
  leadId: string,
  attachments: Array<{ url?: string | null }>,
  startIndex: number,
  sentMessageId: string | null,
  hookBody: string,
  log: Log,
  /**
   * The message written into the shared field immediately before this call.
   * We refuse to overwrite the field until this text is confirmed delivered —
   * pass null only when it is already known to have reached the client (resume).
   */
  precedingText: string | null = null,
): Promise<number> {
  const total = attachments.length;
  let delivered = startIndex;
  // One read of the conversation up front tells us what the client already has,
  // so a re-approved or edited draft cannot repeat a link they can see.
  let sent = (await outboundTexts(leadId).catch(() => null)) ?? [];
  let pending = precedingText;

  for (let i = startIndex; i < total; i++) {
    const url = attachments[i]?.url;
    // Still counts as "done" — the progress marker is an index into this list,
    // so a skipped entry must advance it or a resume would replay the wrong link.
    if (!url) {
      delivered = i + 1;
      continue;
    }

    // The shared field still holds the previous message. Overwriting it before
    // the Salesbot has read it is exactly how the text got swallowed; wait for
    // proof, and if it never comes, stop rather than destroy the message.
    if (pending) {
      const confirmed = await waitForOutbound(leadId, pending, 20_000);
      if (!confirmed) {
        log.warn(
          { leadId, delivered, total },
          "previous message not confirmed in the timeline — stopping before it is overwritten",
        );
        break;
      }
      pending = null;
      sent = (await outboundTexts(leadId).catch(() => null)) ?? sent;
    }

    // The client already has this exact link — a broker editing a draft creates
    // a new suggestion id, so id-based dedupe cannot see it. The conversation can.
    if (alreadyOut(sent, url)) {
      log.warn({ leadId, url }, "link already present in the conversation — skipped");
      delivered = i + 1;
      continue;
    }

    await new Promise((r) => setTimeout(r, 1200));
    try {
      const linkField = await updateLeadCustomField(leadId, COMPANION_FIELD_ID, url);
      // The lead vanished between the text and this link (deleted or merged in
      // amoCRM mid-send) — the remaining links can only fail the same way.
      if (linkField.leadMissing) break;
      if (linkField.ok) {
        await triggerSalesbot(leadId, COMPANION_ROBERT_BOT_ID);
        delivered = i + 1;
        // Guard the NEXT overwrite on this one actually landing.
        pending = url;
        if (sentMessageId) {
          await db
            .update(sentMessagesTable)
            .set({ webhookResponse: `${hookBody} | links ${delivered}/${total}` })
            .where(eq(sentMessagesTable.id, sentMessageId as any))
            .catch(() => {});
        }
      }
    } catch (e) {
      log.warn({ leadId, url, err: e }, "attachment send failed (non-fatal)");
    }
  }
  return delivered;
}
