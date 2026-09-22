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
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { updateLeadCustomField, triggerSalesbot } from "./amo-chat-client";
import {
  resolveOutboundSource,
  fillMessengerFromResponsibleIfNoMessages,
  brokerLines,
  getLastMessengerFieldId,
  updateLastMessengerField,
  isKnownWhatsappLine,
} from "./amo-messenger-field";
import { countActiveWhatsappChats, closeStaleDuplicateWhatsappTalks, whatsappTalkLines } from "./amo-client.js";
import { isFirstOutbound, pickLineForNewConversation } from "./new-contact-budget";
import { stripEmojiForDelivery } from "./message-delivery.js";
import { isOwnLine } from "./wa-own-line-ids";
import { humanizeLayout } from "./humanize-layout";
import { deliverViaOwnLine } from "./wa-own-send";
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
 * Which of a multi-line broker's numbers this send goes out on.
 *
 * 1. The lead already has a conversation on one of the broker's numbers (amoCRM
 *    talks, or our own stamped send when the talk is not visible yet): that
 *    number. A chat belongs to the number it was opened from; answering from
 *    the other one opens a second chat with the same person.
 * 2. Nobody has talked to this lead yet: the first number with budget left
 *    today (primary first). All spent — only a broker's own Approve gets this
 *    far — the primary.
 * 3. A conversation exists but on nobody's line of this broker (a handover):
 *    `source: null`, and the ordinary single-line rules decide.
 *
 * The chosen number is written into the field Salesbot reads. If that write
 * fails the send is refused: Salesbot would otherwise go out on whatever
 * number the field still holds.
 */
async function resolveMultiLineSource(
  leadId: string,
  responsibleUser: string | null,
  lines: number[],
  log: Log,
): Promise<{ source: string | null } | { refuse: true }> {
  let line: number | null = null;
  let why = "";

  const onOwnLine = (await whatsappTalkLines(leadId)).find((t) => lines.includes(t.sourceId));
  if (onOwnLine) {
    line = onOwnLine.sourceId;
    why = "existing conversation (talk)";
  } else {
    const [stamped] = await db
      .select({ sourceId: sentMessagesTable.sourceId })
      .from(sentMessagesTable)
      .where(and(eq(sentMessagesTable.leadId, leadId), isNotNull(sentMessagesTable.sourceId)))
      .orderBy(desc(sentMessagesTable.createdAt))
      .limit(1);
    const n = Number(stamped?.sourceId);
    if (lines.includes(n)) {
      line = n;
      why = "our earlier send";
    } else if (await isFirstOutbound(leadId)) {
      line = (await pickLineForNewConversation(responsibleUser)) ?? lines[0]!;
      why = "first contact — line with budget left today";
    }
  }
  // The broker's own number runs on our bridge: a conversation that lived on its
  // old Wahelp line (or on a bridge line that is gone) continues from it.
  if (line === null && isOwnLine(lines[0])) {
    line = lines[0]!;
    why = "conversation continues on the broker's own number (bridge)";
  }
  if (line === null) return { source: null };

  // Our own-bridge lines are not amoCRM sources: nothing is written into the
  // messenger field (Salesbot would read it and send on its fallback exit), the
  // send goes through wa-gateway (deliverText / sendAttachmentLinks below).
  if (isOwnLine(line)) {
    log.warn({ leadId, responsibleUser, line, why }, "multi-line send: own-bridge line chosen");
    return { source: String(line) };
  }

  const ok = await updateLastMessengerField(leadId, String(line), line, getLastMessengerFieldId());
  if (!ok) {
    log.warn({ leadId, line }, "multi-line send: could not write the chosen number into the messenger field — refusing");
    return { refuse: true };
  }
  log.warn({ leadId, responsibleUser, line, why }, "multi-line send: number chosen");
  return { source: String(line) };
}

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
  // A broker with more than one WhatsApp number (Yudi, 2026-09-13) needs the
  // line decided here, per send: a conversation stays on the number it lives
  // on, and a first contact takes the number with budget left today.
  const lines = brokerLines(responsibleUser);
  let source: string | null = null;
  if (lines.length > 1 || lines.some((l) => isOwnLine(l))) {
    const multi = await resolveMultiLineSource(leadId, responsibleUser, lines, log).catch((e) => {
      log.warn({ leadId, err: e }, "resolveMultiLineSource threw");
      return { refuse: true as const };
    });
    if ("refuse" in multi) {
      return {
        ok: false,
        error: "channel_unresolved",
        message:
          "Could not set which of the broker's WhatsApp numbers to send from — the message was NOT sent. Send it manually from amoCRM (the draft stays in your inbox).",
      };
    }
    source = multi.source;
    if (source && isOwnLine(source)) return { ok: true, source };
  }

  if (!source) {
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
    source = await resolveOutboundSource(leadId, responsibleUser).catch((e) => {
      log.warn({ leadId, err: e }, "resolveOutboundSource threw");
      return null;
    });
  }
  if (!source) {
    return {
      ok: false,
      error: "channel_unresolved",
      message:
        "Could not resolve the sending channel for this lead — the message was NOT sent. Send it manually from amoCRM (the draft stays in your inbox).",
    };
  }

  // Salesbot 22127 has one branch per WhatsApp line we know (SOURCE_MAP). Since
  // 13.09 its "None of the conditions" exit sends through Yudi 2 (62585), so a
  // line it has no branch for — an old Instagram/Facebook source id left in the
  // field — would leave from Yudi 2's WhatsApp instead of its own channel.
  if (!isKnownWhatsappLine(source)) {
    log.warn({ leadId, source }, "send refused — Salesbot has no branch for this source; it would go out on Yudi 2");
    return {
      ok: false,
      error: "channel_unresolved",
      message:
        "This lead's chat channel is not one of our WhatsApp lines — the message was NOT sent. Send it manually from amoCRM (the draft stays in your inbox).",
    };
  }

  // If a lead has two active WhatsApp chat threads (WAhelp registered the same
  // number twice — "+61…" and "61…"), a single Salesbot send fans out to BOTH
  // and the client gets the message twice. Addressing is line-level, not
  // chat-level, so we cannot pick one from here.
  let activeChats = await countActiveWhatsappChats(leadId);
  if (activeChats >= 2) {
    // Try to fix the cause rather than report it: close the stale duplicate and
    // ask again. Only if that fails does anyone need to hear about it.
    const closed = await closeStaleDuplicateWhatsappTalks(leadId);
    if (closed > 0) activeChats = await countActiveWhatsappChats(leadId);
  }
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
export async function deliverText(leadId: string, rawText: string, log: Log, source?: string | null): Promise<DeliverResult> {
  // One wall of text reads as a bot (owner, 19.09.2026): long messages go out
  // in short paragraphs with an empty line between them. See humanize-layout.ts.
  const text = humanizeLayout(rawText);
  if (source && isOwnLine(source)) {
    // WhatsApp through our gateway keeps emoji; nothing truncates them there.
    const own = await deliverViaOwnLine(leadId, source, text);
    return { leadMissing: false, chatSent: own.chatSent, hookStatus: own.hookStatus, hookBody: own.hookBody, deliveryText: text };
  }
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
/**
 * The price-ladder layout of a Rental shortlist (generate-suggestion.ts,
 * LadderInfo): before the first villa of each price group its title goes out
 * as its own message, each villa goes as "caption + link" in ONE message (the
 * preview still unfurls — the link is the only URL in it), and after the last
 * villa the closing line. A link without a ladder goes out bare, as always.
 */
type LadderedLink = {
  url?: string | null;
  ladder?: { band: string; caption: string; headers: Record<string, string>; closing: string };
};

function ladderMessagesAt(attachments: LadderedLink[], i: number): { before: string | null; body: string | null; after: string | null } {
  const a = attachments[i];
  if (!a?.url) return { before: null, body: null, after: null };
  const lad = a.ladder;
  if (!lad) return { before: null, body: a.url, after: null };
  const prevBand = i > 0 ? attachments[i - 1]?.ladder?.band ?? null : null;
  const before = prevBand !== lad.band ? (lad.headers[lad.band] ?? "").trim() || null : null;
  const lastLinked = attachments.map((x, j) => (x?.url ? j : -1)).filter((j) => j >= 0).pop();
  const after = i === lastLinked ? (lad.closing ?? "").trim() || null : null;
  return { before, body: lad.caption ? `${lad.caption}\n${a.url}` : a.url, after };
}

export async function sendAttachmentLinks(
  leadId: string,
  attachments: LadderedLink[],
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
  source?: string | null,
): Promise<number> {
  const total = attachments.length;
  let delivered = startIndex;
  if (source && isOwnLine(source)) {
    // Own line: each link is its own WhatsApp message straight through the
    // gateway — no shared field to protect, so no waiting on the timeline.
    for (let i = startIndex; i < total; i++) {
      const url = attachments[i]?.url;
      if (url) {
        const m = ladderMessagesAt(attachments, i);
        let ok = true;
        for (const value of [m.before, m.body]) {
          if (!value) continue;
          await new Promise((r) => setTimeout(r, 2000));
          const r = await deliverViaOwnLine(leadId, source, value);
          if (!r.chatSent) {
            log.warn({ leadId, url, body: r.hookBody }, "own line: link not sent — stopping");
            ok = false;
            break;
          }
        }
        if (!ok) break;
        if (m.after) {
          await new Promise((r) => setTimeout(r, 2000));
          await deliverViaOwnLine(leadId, source, m.after);
        }
      }
      delivered = i + 1;
      if (sentMessageId) {
        await db
          .update(sentMessagesTable)
          .set({ webhookResponse: `${hookBody} | links ${delivered}/${total}` })
          .where(eq(sentMessagesTable.id, sentMessageId as any))
          .catch(() => {});
      }
    }
    return delivered;
  }
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

    const m = ladderMessagesAt(attachments, i);
    // A group title goes out on its own before the group's first villa, under
    // the same guard as every other overwrite of the shared field.
    if (m.before) {
      await new Promise((r) => setTimeout(r, 1200));
      const headField = await updateLeadCustomField(leadId, COMPANION_FIELD_ID, m.before).catch(() => ({ ok: false, leadMissing: false }));
      if (headField.leadMissing) break;
      if (headField.ok) {
        await triggerSalesbot(leadId, COMPANION_ROBERT_BOT_ID);
        const confirmed = await waitForOutbound(leadId, m.before, 20_000);
        if (!confirmed) {
          log.warn({ leadId, delivered, total }, "ladder: group title not confirmed in the timeline — stopping before it is overwritten");
          break;
        }
      }
    }

    await new Promise((r) => setTimeout(r, 1200));
    try {
      const linkField = await updateLeadCustomField(leadId, COMPANION_FIELD_ID, m.body ?? url);
      // The lead vanished between the text and this link (deleted or merged in
      // amoCRM mid-send) — the remaining links can only fail the same way.
      if (linkField.leadMissing) break;
      if (linkField.ok) {
        await triggerSalesbot(leadId, COMPANION_ROBERT_BOT_ID);
        delivered = i + 1;
        // Guard the NEXT overwrite on this one actually landing.
        pending = m.body ?? url;
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
  // The ladder's closing line, once every villa is out.
  const lastIdx = attachments.map((x, j) => (x?.url ? j : -1)).filter((j) => j >= 0).pop();
  const closing = lastIdx !== undefined && delivered >= total ? ladderMessagesAt(attachments, lastIdx).after : null;
  if (closing) {
    const ready = pending ? await waitForOutbound(leadId, pending, 20_000) : true;
    if (!ready) {
      log.warn({ leadId }, "ladder: last villa not confirmed in the timeline — closing line not sent");
    } else {
      await new Promise((r) => setTimeout(r, 1200));
      const f = await updateLeadCustomField(leadId, COMPANION_FIELD_ID, closing).catch(() => ({ ok: false, leadMissing: false }));
      if (f.ok) await triggerSalesbot(leadId, COMPANION_ROBERT_BOT_ID);
    }
  }
  return delivered;
}
