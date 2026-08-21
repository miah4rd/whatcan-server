/**
 * The opening move on a paid ad lead.
 *
 * A lead who filled in the Meta form is on their phone RIGHT NOW, choosing a
 * villa. Until this existed, the first thing they got from us was a draft
 * waiting in a broker's inbox — good text, often hours late, and the reason a
 * large share of ad leads never replied at all.
 *
 * The AUTO-WELCOME sits outside the count. Immediately, with no broker
 * involved: a short greeting, the listing they actually clicked, and one open
 * question. It is the brochure — the only message in this system that reaches
 * a client without a human tap, which is why every guard below refuses rather
 * than guesses. It is not the broker's first message and must never be counted
 * as one.
 *
 * THE BROKER'S FIRST MESSAGE comes 15 minutes later, if the client stayed
 * silent: an ordinary Copilot draft — the bot writes, the broker approves and
 * sends. NOT a follow-up: it is kind "live", so it is not counted as a chase in
 * the report and does not consume a follow-up level. The 24h chase then counts
 * from whenever THAT is sent, which approve.ts already does on every send.
 *
 * The numbering is deliberate and worth keeping straight. Calling the 15-minute
 * draft "the second message" is what made it behave like one: it inherited the
 * qualifying ladder meant for a client mid-conversation and opened by asking
 * what the Meta form had already answered. It is the FIRST thing a broker says.
 *
 * If the client answers before the 15 minutes are up, nothing extra happens —
 * they simply become a normal LIVE lead answering on their own words, and the
 * broker opening never fires. Reacting to silence is the entire point; talking
 * over a client who just replied would undo it.
 */
import { db, leadsSyncTable, sentMessagesTable, pendingSuggestionsTable, brokerSettingsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "./logger";
import { amoFetch } from "./amo-client";
import { describePropertiesByIds } from "./property-catalog";
import { brokerDisplayName } from "./broker-identity";
import { correctionsPromptBlock, deriveSituation } from "./broker-corrections";
import { generateSuggestion } from "./generate-suggestion";
import { notifyBrokerForLead } from "./push-notifications";
import { resolveSendChannel, deliverText, sendAttachmentLinks } from "./outbound-send";
import { parseDialogContent } from "./dialog-parser";

/**
 * Marks a delivery as the automatic ad-lead welcome. This is the ONLY record
 * that the first touch happened, so the 15-minute pass reads it to know whose
 * clock is running — and the "have we ever sent to this lead" guard reads it to
 * know we already have.
 *
 * Declared in pending-visibility.ts and re-exported here: the visibility rules
 * have to discount this message too, and one constant with two declarations is
 * how the two halves drift apart.
 */
export { AD_AUTO_KIND } from "./pending-visibility";
import { AD_AUTO_KIND } from "./pending-visibility";

/** Silence after the welcome before the broker gets a draft to send. */
const BROKER_OPENING_DELAY_MS = 15 * 60 * 1000;

/**
 * The broker's opening is not a chase, so it must not read like one.
 *
 * Left to the ordinary qualifying ladder this message was worthless: the
 * ladder counts lead messages and a seeded enquiry is exactly one, so every
 * draft opened with "when would you be looking to move in?" — a question the
 * client had often already answered in the Meta form before we ever wrote to
 * them. Fifteen minutes of the owner's chosen silence spent asking something
 * we knew.
 *
 * The form answers are the request; the villa they clicked is only the ad that
 * caught them. Work from the request when we have it, and when we do not, ask
 * for the pieces a shortlist actually needs — and say why we are asking.
 */
const BROKER_OPENING_BRIEF = `SITUATION: This is a paid-ad lead. Fifteen minutes ago they clicked an ad for one villa and received an automatic welcome with that listing. They have not replied. Their only words are the enquiry above — which also carries whatever the Meta lead form asked them (budget, area, bedrooms, move-in timing, free-text notes).

Task: Write the broker's FIRST real message. It has to earn the reply the automatic welcome did not get, so it must add something that message did not contain.

- The form answers are the REQUEST. The villa they clicked is only the ad that caught their eye — they may well want something else. Work from the request whenever you have it.
- If you know what they want (any of: budget, area, bedrooms, dates): say briefly that you have places that fit THAT, and close with ONE question that moves things forward — narrowing the shortlist or proposing a viewing.
- If the request is missing or only partial: ask ONLY for what you still need in order to shortlist properly, and say why you are asking — so you can send the right places instead of a random list. At most two things, in one natural sentence.
- NEVER open with a bare "when are you looking to move in?" or "how long do you need it?". On its own that is a chase: it asks the client to do work and gives them nothing.
- Do not repeat the welcome, and do not re-send the same listing link.

Under 90 words.`

/**
 * Kill switch. The owner can stop every automatic welcome without a deploy by
 * setting broker_settings key `ad_auto_welcome` to "off" — this is the first
 * thing in the system that writes to a client unattended, so turning it off has
 * to be faster than shipping code.
 */
async function autoWelcomeEnabled(): Promise<boolean> {
  try {
    const [row] = await db
      .select({ value: brokerSettingsTable.value })
      .from(brokerSettingsTable)
      .where(eq(brokerSettingsTable.key, "ad_auto_welcome"))
      .limit(1);
    return (row?.value ?? "on").trim().toLowerCase() !== "off";
  } catch {
    return true;
  }
}

/**
 * The welcome text. Deliberately a template and not a model call: it goes out
 * with nobody reading it first, so it may not be capable of inventing a price,
 * a date or an availability. Everything in it is either the client's own name
 * or a fact read straight from the catalog.
 *
 * The URL is NOT in this text — it follows as its own message, both because
 * WhatsApp only unfurls a preview for a link that stands alone and because a
 * bare link as the very first thing from an unknown number is what spam looks
 * like to WhatsApp's own filters.
 */
function welcomeText(opts: { clientName: string; brokerName: string; listingLabel: string }): string {
  const hi = opts.clientName ? `Hi ${opts.clientName}!` : "Hi!";
  const who = opts.brokerName ? `${opts.brokerName} here from Unicorn Property.` : "Unicorn Property here.";
  return (
    `${hi} ${who} Thanks for your enquiry about ${opts.listingLabel}. ` +
    `Sending you the full listing now — photos, price and location.\n\n` +
    `Is this the villa you had in mind, or would you like me to look for something different — another area, size or budget?`
  );
}

/**
 * Render one outgoing line in the shape amoCRM's `content` uses, so the reply
 * generator reads our welcome as part of the conversation immediately instead
 * of waiting for the next amoCRM sync.
 *
 * This is not cosmetic. The "never re-offer a listing the lead has seen" rule
 * derives its exclusion list from /property/<ID> links found IN THE
 * CONVERSATION TEXT — so until our welcome is in `content`, the 15-minute draft
 * would happily attach the very villa we just sent.
 *
 * The stamp is written +3h because the parser treats these as Moscow time.
 */
function formatAsOurMessage(at: Date, text: string): string {
  const shifted = new Date(at.getTime() + 3 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${p(shifted.getUTCDate())}.${p(shifted.getUTCMonth() + 1)}.${shifted.getUTCFullYear()} ` +
    `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}`;
  const oneLine = text.replace(/\s*\n+\s*/g, " ").trim();
  return `${stamp} Manager (менеджер - whatsapp) → ${oneLine}`;
}

/** Digits only — "+62 811 …" and "62811…" are the same person. */
function normalisePhone(raw: string): string {
  return (raw ?? "").replace(/\D+/g, "");
}

/** The lead's contact phone, or "" when it cannot be read. */
async function leadPhone(leadId: string): Promise<string> {
  try {
    const lead = await amoFetch<{ _embedded?: { contacts?: Array<{ id: number }> } }>(
      `/api/v4/leads/${leadId}?with=contacts`,
    );
    const contactId = lead?._embedded?.contacts?.[0]?.id;
    if (!contactId) return "";
    const contact = await amoFetch<{
      custom_fields_values?: Array<{ field_code?: string; values?: Array<{ value?: string }> }>;
    }>(`/api/v4/contacts/${contactId}`);
    const phone = (contact?.custom_fields_values ?? [])
      .find((f) => f.field_code === "PHONE")
      ?.values?.[0]?.value;
    return normalisePhone(String(phone ?? ""));
  } catch {
    return "";
  }
}

/**
 * Has this PHONE already been written to?
 *
 * The scout and the ad forms both create duplicate cards: Larissalara and Anna
 * Shahumyan each existed twice, with different contact ids and the same number,
 * and each received two different opening messages a minute apart. Contact id
 * is not a dedupe key here — the number is. With a human in the loop this was
 * embarrassing; with an automatic welcome it would be systematic.
 */
async function phoneAlreadyMessaged(leadId: string, phone: string): Promise<boolean> {
  if (!phone) return false;
  try {
    const found = await amoFetch<{
      _embedded?: { contacts?: Array<{ _embedded?: { leads?: Array<{ id: number }> } }> };
    }>(`/api/v4/contacts?query=${encodeURIComponent(phone)}&with=leads&limit=10`);
    const siblingLeadIds = (found?._embedded?.contacts ?? [])
      .flatMap((c) => c._embedded?.leads ?? [])
      .map((l) => String(l.id))
      .filter((id) => id !== leadId);
    if (siblingLeadIds.length === 0) return false;

    const [row] = await db
      .select({ id: sentMessagesTable.id })
      .from(sentMessagesTable)
      .where(sql`${sentMessagesTable.leadId} IN (${sql.join(siblingLeadIds.map((i) => sql`${i}`), sql`, `)})`)
      .limit(1);
    if (row) {
      logger.warn({ leadId, phone, siblingLeadIds }, "ad welcome skipped — this phone already received a message on another lead");
      return true;
    }
    return false;
  } catch (err) {
    // A failed lookup must not become a second message to the same person.
    logger.warn({ err, leadId }, "ad welcome: phone dedupe lookup failed — skipping the send to stay safe");
    return true;
  }
}

/**
 * Send the automatic welcome for one freshly seeded ad lead.
 *
 * Returns true only when the client actually received something.
 */
export async function sendAdLeadWelcome(opts: {
  leadId: string;
  responsibleUser: string | null;
  listingId: string;
  clientName: string;
  content: string;
}): Promise<boolean> {
  const { leadId, responsibleUser, listingId } = opts;
  if (!(await autoWelcomeEnabled())) {
    logger.info({ leadId }, "ad welcome skipped — ad_auto_welcome is off");
    return false;
  }

  // Never open a conversation twice. Any prior delivery on this lead — the
  // welcome itself, or a broker's own send — means this is not a first touch.
  const [everSent] = await db
    .select({ id: sentMessagesTable.id })
    .from(sentMessagesTable)
    .where(eq(sentMessagesTable.leadId, leadId))
    .limit(1);
  if (everSent) return false;

  const phone = await leadPhone(leadId);
  if (await phoneAlreadyMessaged(leadId, phone)) return false;

  const known = await describePropertiesByIds([listingId]).catch(() => new Map());
  const listing = known.get(listingId.toUpperCase());
  if (!listing) {
    // The code in the lead name is not in the catalog — we do not know what the
    // client clicked, so there is nothing safe to send unattended. The broker
    // gets the ordinary draft instead.
    logger.warn({ leadId, listingId }, "ad welcome skipped — listing not found in catalog");
    return false;
  }

  const log = { warn: (o: object, m: string) => logger.warn(o, m) };
  const channel = await resolveSendChannel(leadId, responsibleUser, log);
  if (!channel.ok) {
    logger.warn({ leadId, error: channel.error }, "ad welcome not sent — channel refused, broker will send the draft by hand");
    return false;
  }

  const text = welcomeText({
    clientName: opts.clientName,
    brokerName: brokerDisplayName(responsibleUser),
    listingLabel: listing.clientLabel || listing.title,
  });

  const delivery = await deliverText(leadId, text, log);
  if (delivery.leadMissing || !delivery.chatSent) {
    logger.warn({ leadId, hookBody: delivery.hookBody }, "ad welcome delivery failed — leaving the lead to the normal draft path");
    return false;
  }

  // Recorded the INSTANT the text leaves, before the link is paced out: this row
  // is the only proof the client already has it, and a restart in the gap would
  // otherwise replay the whole thing at them.
  const [deliveryRow] = await db
    .insert(sentMessagesTable)
    .values({
      leadId,
      kind: AD_AUTO_KIND,
      messageText: delivery.deliveryText,
      responsibleUser,
      webhookStatus: delivery.hookStatus,
      webhookResponse: `${delivery.hookBody} | links 0/1`,
    })
    .returning({ id: sentMessagesTable.id });

  await sendAttachmentLinks(leadId, [{ url: listing.url }], 0, deliveryRow?.id ?? null, delivery.hookBody, log);

  const now = new Date();
  const ourLine = formatAsOurMessage(now, `${delivery.deliveryText} ${listing.url}`);
  await db
    .update(leadsSyncTable)
    .set({
      content: `${opts.content}\n${ourLine}`.trim(),
      lastMessageFrom: "us",
      lastOurMessageAt: now,
      // The 15-minute pass owns this lead now. A follow-up clock here would
      // schedule a chase for a client who has not been given a chance to speak.
      nextFollowupAt: null,
      followupLevel: 0,
      updatedAt: now,
    })
    .where(eq(leadsSyncTable.leadId, leadId));

  logger.info({ leadId, listingId, broker: responsibleUser }, "ad welcome sent automatically — 15-minute draft armed");
  return true;
}

/**
 * Broker opening: 15 minutes of silence after the automatic welcome means the
 * client did not answer. Write the broker a draft NOW rather than at the usual
 * 24-hour chase — a paid lead who ignored the villa we sent has usually not
 * gone cold, they have simply been sent the wrong villa, and reading that
 * signal a day later is what loses them.
 *
 * The draft is an ordinary LIVE suggestion: bot writes, broker approves. No
 * message goes out of here.
 */
export async function processAdLeadBrokerOpening(): Promise<number> {
  const cutoff = new Date(Date.now() - BROKER_OPENING_DELAY_MS);

  // Leads whose automatic welcome is older than the window, where WE still
  // spoke last (the client has said nothing) and no draft is waiting.
  const rows = await db
    .select({
      leadId: leadsSyncTable.leadId,
      responsibleUser: leadsSyncTable.responsibleUser,
      content: leadsSyncTable.content,
      leadNotes: leadsSyncTable.leadNotes,
      leadStage: leadsSyncTable.leadStage,
      pipeline: leadsSyncTable.pipeline,
      welcomeAt: sentMessagesTable.createdAt,
    })
    .from(sentMessagesTable)
    .innerJoin(leadsSyncTable, eq(leadsSyncTable.leadId, sentMessagesTable.leadId))
    .where(
      and(
        eq(sentMessagesTable.kind, AD_AUTO_KIND),
        sql`${sentMessagesTable.createdAt} < ${cutoff}`,
        eq(leadsSyncTable.lastMessageFrom, "us"),
        sql`lower(coalesce(${leadsSyncTable.pipeline}, '')) = 'rental'`,
        sql`coalesce(${leadsSyncTable.botExcluded}, false) = false`,
      ),
    );

  if (rows.length === 0) return 0;

  let drafted = 0;
  for (const lead of rows) {
    try {
      // Anything already waiting for this broker — a draft from this pass on an
      // earlier run, or one they asked for by hand — is left alone.
      const [pending] = await db
        .select({ id: pendingSuggestionsTable.id })
        .from(pendingSuggestionsTable)
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, lead.leadId),
            eq(pendingSuggestionsTable.status, "pending"),
          ),
        )
        .limit(1);
      if (pending) continue;

      // Anything sent AFTER the welcome means this lead has moved on — the
      // broker already sent the opening, or answered by hand. Without
      // this the pass would draft again on every tick for the rest of the
      // lead's life: approve.ts sets last_message_from back to "us" and clears
      // the pending row, which is exactly the shape this query looks for.
      const [sentCount] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(sentMessagesTable)
        .where(eq(sentMessagesTable.leadId, lead.leadId));
      if ((sentCount?.n ?? 0) > 1) continue;

      // Belt and braces on the race this whole design turns on: if a reply
      // landed between the query above and now, the client is talking and the
      // ordinary LIVE path owns them.
      const [fresh] = await db
        .select({ lastMessageFrom: leadsSyncTable.lastMessageFrom })
        .from(leadsSyncTable)
        .where(eq(leadsSyncTable.leadId, lead.leadId))
        .limit(1);
      if ((fresh?.lastMessageFrom ?? "") !== "us") continue;

      const content = lead.content ?? "";
      const parsed = parseDialogContent(content);
      // The client's own words are still the seeded enquiry — the villa they
      // clicked plus whatever the Meta form asked them. That is exactly what
      // the second message has to widen off.
      const lastLeadMessage = parsed.lastLeadMessage?.text ?? "";
      if (!lastLeadMessage) continue;

      const situation = deriveSituation({
        pipeline: lead.pipeline,
        kind: "live",
        leadStage: lead.leadStage,
        lastLeadText: lastLeadMessage,
        isFirstContact: true,
      });
      const corrections = await correctionsPromptBlock(lead.responsibleUser, situation, 20);

      const { text, attachments } = await generateSuggestion({
        leadId: lead.leadId,
        responsibleUser: lead.responsibleUser,
        kind: "live",
        lastLeadMessage,
        contentSnippet: content,
        leadNotes: lead.leadNotes,
        leadStage: lead.leadStage,
        correctionsBlock: corrections,
        pipeline: lead.pipeline,
        taskBrief: BROKER_OPENING_BRIEF,
      });
      if (!text) continue;

      await db.insert(pendingSuggestionsTable).values({
        leadId: lead.leadId,
        responsibleUser: lead.responsibleUser,
        // "live", never "push": this is still the opening conversation, not a
        // chase. The report counts pushes as follow-ups and the approve path
        // would burn a follow-up level on it.
        kind: "live",
        followupLevel: null,
        suggestionText: text,
        status: "pending",
        attachments,
      });

      notifyBrokerForLead(
        lead.responsibleUser,
        lead.leadId,
        "replied",
        "No answer to the ad welcome — a follow-up message is ready to send",
        { content, leadStage: lead.leadStage },
      ).catch(() => {});

      drafted++;
      logger.info({ leadId: lead.leadId }, "ad lead broker opening drafted after 15 minutes of silence");
    } catch (err) {
      logger.error({ err, leadId: lead.leadId }, "ad lead broker opening failed");
    }
  }

  if (drafted > 0) logger.info({ drafted }, "ad-lead broker-opening pass complete");
  return drafted;
}
