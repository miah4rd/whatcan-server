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
import { describePropertiesByIds } from "./property-catalog";
import { brokerDisplayName } from "./broker-identity";
import { correctionsPromptBlock, deriveSituation } from "./broker-corrections";
import { generateSuggestion } from "./generate-suggestion";
import { notifyBrokerForLead } from "./push-notifications";
import { resolveSendChannel, deliverText, sendAttachmentLinks } from "./outbound-send";
import { parseDialogContent } from "./dialog-parser";
import { getLeadCardCriteria, type LeadCardAnswers } from "./lead-card-fields";
import { leadPhone, phoneAlreadyMessaged } from "./phone-dedupe";

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
function brokerOpeningBrief(welcomeSent: string, hasOptions = true): string {
  return `SITUATION: This is a paid-ad lead. Fifteen minutes ago they clicked an ad for one villa and received the message below. They have not replied.

ALREADY SENT TO THEM, VERBATIM — everything here has been said once:
"""
${welcomeSent.trim()}
"""

Task: Write the broker's FIRST real message. It always has the same four parts, in this order. Parts 1 and 2 are NOT optional — a message that opens straight into a list reads as a mailshot, and being heard is the whole reason this message exists:

1. Greet them by name. (If no name is known, open with a greeting and no name — never invent one.)
2. SAY THEIR REQUEST BACK TO THEM in one short line, so they can see they were heard. The request is what the Meta form asked them — budget, area, bedrooms, timing — and it is in the enquiry and the lead card above.
   If the form answers are missing, THE VILLA THEY CLICKED IS THE REQUEST: take its bedrooms, its area and its monthly price and state those as what you understand they are looking for. ("Looks like you're after a 2-bedroom in Pererenan around Rp 50 million a month.")
3. ${hasOptions
    ? `OFFER OPTIONS THAT FIT THAT REQUEST. Other places — the one they clicked is already theirs. The links are attached to this very message, so present them ("here are two more that fit"); never ask permission to send them and never promise them for later.
   NAME THE AREA OF EACH OPTION, and if an option is NOT in the area they asked for, say so in the same breath — "this one's in Kerobokan rather than Pererenan". Bali areas are half an hour apart and a client who opens a link expecting their neighbourhood and finds another one stops trusting the next message. Never imply an option is in their area when it is not, and never quietly drop the area to avoid the point.`
    : `NOTHING IS ATTACHED TO THIS MESSAGE. Do not say "here are", do not describe other villas, do not promise to send anything. Instead ask the ONE thing that would let you put a shortlist together — which area, what budget, or what matters most to them — and say why you are asking.`}
4. End with ONE open question.

Absolutes:
- Do not re-sell the villa they clicked: not its features, not its price, not its link. Naming it as the reference point for their request is exactly right; describing it again is not.
- Do not ask when they are moving in or for how long, anywhere in this message. The message above already asked an open question and got silence.

Under 80 words.`;
}

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
 * The client's form answers as one line they can recognise as their own.
 *
 * Every value is repeated VERBATIM from the card — "3BR", "Rp 30–50
 * million/month", "3–6 months". Nothing is parsed on the way here, because the
 * point of the line is that the client reads back the answer they gave: a
 * budget range re-quoted as its ceiling ("Rp 50 million") is not their answer,
 * it is ours, and it lands as us having misread the form.
 *
 * A missing field is simply absent. There is no placeholder, no "not
 * specified", and no field re-asked in passing — a gap the form left is the
 * broker's to close 15 minutes later, in a message a human approves.
 */
function requestLine(answers: LeadCardAnswers): string {
  const parts = [
    answers.bedrooms,
    answers.areas,
    answers.budget,
    answers.moveIn ? `move-in ${answers.moveIn}` : null,
    // Free text: the client's own extra wish ("Big garden"). Repeated only when
    // it is short enough to be a phrase — this field also collects the odd
    // pasted paragraph, and a wall of text quoted back reads as a machine.
    answers.notes && answers.notes.length <= 60 ? answers.notes.replace(/\s+/g, " ") : null,
  ].filter((p): p is string => Boolean(p && p.trim()));
  return parts.join(", ");
}

/**
 * The welcome text. Deliberately a template and not a model call: it goes out
 * with nobody reading it first, so it may not be capable of inventing a price,
 * a date or an availability. Everything in it is either the client's own name,
 * their own form answers, or a fact read straight from the catalog.
 *
 * It does NOT re-ask what the form already asked. Every ad lead now answers the
 * qualifying questions before they ever reach us, so the old closing line —
 * "is this the villa you had in mind, or would you like something different?" —
 * asked a client to type out a request they had just finished typing. From
 * their side that is not a welcome, it is proof nobody read it.
 *
 * The closing question stays, though, and is deliberately still a question: an
 * opening that ends in a full stop gives a stranger no reason to reply at all.
 * What changed is what it asks FOR. It no longer asks them to re-state the
 * request; it offers the next thing they actually need — more villas to compare
 * against the one they clicked, since nobody rents the first place they see.
 *
 * With no form answers on the card we genuinely do not know the request, and
 * the original open question is the honest thing to send.
 *
 * The URL is NOT in this text — it follows as its own message, both because
 * WhatsApp only unfurls a preview for a link that stands alone and because a
 * bare link as the very first thing from an unknown number is what spam looks
 * like to WhatsApp's own filters.
 */
function welcomeText(opts: {
  clientName: string;
  brokerName: string;
  listingLabel: string;
  answers: LeadCardAnswers;
}): string {
  const hi = opts.clientName ? `Hi ${opts.clientName}!` : "Hi!";
  const who = opts.brokerName ? `${opts.brokerName} here from Unicorn Property.` : "Unicorn Property here.";
  const opening =
    `${hi} ${who} Thanks for your enquiry about ${opts.listingLabel}. ` +
    `Sending you the full listing now — photos, price and location.`;

  const request = requestLine(opts.answers);
  const closing = request
    ? `I can also see your request: ${request}. Want me to send over a few more matching options too?`
    : `Is this the villa you had in mind, or would you like me to look for something different — another area, size or budget?`;

  return `${opening}\n\n${closing}`;
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

  // The client's own form answers, read from the card they arrived on. A card
  // we cannot read costs us the recap line, not the welcome: the template falls
  // back to the open question rather than sending a half-written request back
  // at them.
  const card = await getLeadCardCriteria(leadId).catch(() => null);
  const answers: LeadCardAnswers = card?.answers ?? {
    bedrooms: null,
    areas: null,
    budget: null,
    moveIn: null,
    notes: null,
  };

  const text = welcomeText({
    clientName: opts.clientName,
    brokerName: brokerDisplayName(responsibleUser),
    listingLabel: listing.clientLabel || listing.title,
    answers,
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
/**
 * One pass at a time. Each lead now costs up to two AI round-trips, so the pass
 * stopped fitting inside its own minute tick and a second run began while the
 * first was still working — both saw "no pending draft" for the same lead and
 * both inserted one. Leads 23302661 and 23302889 each got two identical drafts
 * a second apart (2026-08-21).
 */
let openingPassRunning = false;

export async function processAdLeadBrokerOpening(): Promise<number> {
  if (openingPassRunning) {
    logger.info("ad-lead broker-opening pass still running — skipping this tick");
    return 0;
  }
  openingPassRunning = true;
  try {
    return await runBrokerOpeningPass();
  } finally {
    openingPassRunning = false;
  }
}

async function runBrokerOpeningPass(): Promise<number> {
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
      welcomeText: sentMessagesTable.messageText,
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

      let { text, attachments } = await generateSuggestion({
        leadId: lead.leadId,
        responsibleUser: lead.responsibleUser,
        kind: "live",
        lastLeadMessage,
        contentSnippet: content,
        leadNotes: lead.leadNotes,
        leadStage: lead.leadStage,
        correctionsBlock: corrections,
        pipeline: lead.pipeline,
        taskBrief: brokerOpeningBrief(lead.welcomeText ?? ""),
      });
      if (!text) continue;

      // The text is written CONCURRENTLY with the property match, so it can
      // promise a shortlist the matcher then fails to produce — which is
      // exactly what reached lead 23300773: "here are two more in that same
      // range" with no links under it. A message that offers nothing is worse
      // than one that asks a question, so write it again knowing the truth.
      if (attachments.length === 0 && /here are|attached|below|send (them|these|you)/i.test(text)) {
        logger.info({ leadId: lead.leadId }, "broker opening promised options with none attached — rewriting without them");
        const retry = await generateSuggestion({
          leadId: lead.leadId,
          responsibleUser: lead.responsibleUser,
          kind: "live",
          lastLeadMessage,
          contentSnippet: content,
          leadNotes: lead.leadNotes,
          leadStage: lead.leadStage,
          correctionsBlock: corrections,
          pipeline: lead.pipeline,
          taskBrief: brokerOpeningBrief(lead.welcomeText ?? "", false),
        });
        if (retry.text) {
          text = retry.text;
          attachments = retry.attachments;
        }
      }

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
