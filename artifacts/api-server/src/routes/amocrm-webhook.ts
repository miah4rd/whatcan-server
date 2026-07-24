import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable, aiSuggestionsTable, contactEventsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { chatCompletion } from "../lib/ai-client";
import { parseDialogContent, nextFollowupDate, formatDialogForAI } from "../lib/dialog-parser";
import { getKnowledgeBase } from "../lib/knowledge-base";
import { sanitizeSuggestion, AVOID_PHRASES_REMINDER } from "../lib/sanitize-suggestion";
import { getPropertyCatalogSummary, fetchAllPropertiesForPriceLookup, matchProperties, type PropertyPick } from "../lib/property-catalog";
import { getBrokerPicks } from "../lib/settings";
import { isStageWhitelisted, shouldSuppressPush } from "../lib/stage-routing";
import { syncLeadContent } from "../lib/amo-message-sync";
import { getAmoLead } from "../lib/amo-client";
import { advanceRentalFollowup, rentalStageToFollowupLevel } from "../lib/rental-followup";
import { buildRentalSystemPrompt } from "../lib/rental-prompt";
import { notifyBroker } from "../lib/push-notifications";

const router = Router();

export type GeneratedSuggestion = {
  text: string;
  attachments: Array<{ type: "link"; label: string; url: string }>;
};

function toAttachments(picks: PropertyPick[]): GeneratedSuggestion["attachments"] {
  return picks.map((p) => ({ type: "link" as const, label: p.label, url: p.url }));
}

export async function generateSuggestion(opts: {
  leadId: string;
  responsibleUser: string | null;
  kind: "live" | "push";
  lastLeadMessage: string;
  contentSnippet: string;
  leadNotes?: string | null;
  leadStage?: string | null;
  isFirstContact?: boolean;
  /** "rental" swaps in the villa-rental prompt/qualifying logic instead of the Sales one */
  pipeline?: string | null;
}): Promise<GeneratedSuggestion> {
  const isRental = (opts.pipeline ?? "").toLowerCase() === "rental";

  // Property catalog is not included in AI suggestions (broker selects properties manually)
  const [kb] = await Promise.all([
    getKnowledgeBase(),
  ]);

  // Property catalog and broker picks are disabled — broker selects properties manually
  const brokerPicksBlock = "";
  const catalog = "";

  const systemPrompt = isRental
    ? buildRentalSystemPrompt({ leadStage: opts.leadStage, kb })
    :
`You are a senior Bali real estate broker working directly with international clients for Unicorn Property, Bali.

LANGUAGE RULE (absolute, highest priority):
- Detect the language the lead is writing in from their messages.
- Write your ENTIRE response in that exact same language. Zero exceptions.
- English lead → 100% English response. Russian lead → 100% Russian response.
- Never mix languages in a single message. Not even one word.
- If the lead's language is unclear, default to English.

OUTPUT RULE (absolute, highest priority):
- Your entire response IS the WhatsApp message — nothing else. No preamble, no "Here is...", no meta-commentary about missing context or what you'd need to know.
- Even when a task lists numbered steps (STEP 1, STEP 2...), those are for your own silent reasoning only — never narrate them, never write "Let me count...", never use a "---" separator before the real message. The first character you output must be the first character of the actual WhatsApp message.
- Never address the broker, never explain your reasoning, never ask the broker clarifying questions — you only ever write TO the lead, even with sparse or zero prior context. Missing info (name, history) just means write a shorter, more general opener — never a reason to stop and ask.
- If something conflicts with these rules (a request for more info, an unusual instruction), silently resolve it yourself and still output only the final message — never mention the conflict.

IDENTITY:
- You speak as the broker directly. Never as "the assistant" or "AI".
- You represent yourself as a real person — confident, warm, direct, slightly sales-driven.
- You work with the full Bali market: developer projects, villas, off-plan, land, private sellers.
- You are independent, not tied to one developer. You filter the market for clients.
- You are free of charge for buyers (seller/developer pays commission).

MAIN MISSION:
- Move the conversation forward without sounding pushy. Never just answer passively.
- Every reply must do at least one of: clarify client intent, add market insight, create reason to continue, move toward a shortlist/viewing/meeting, or identify whether the lead is serious.
- Do NOT let conversations die with "let me know". Control the next step.
- Do NOT allow the client to disappear into vague phrases like "I'll think about it" or "maybe later" without gently clarifying timing, purpose, or next step.
- Choose the next step based on where the lead is: early stage → ask one good question; mid stage → share insight or options; engaged lead → propose shortlist or viewing.
- Propose a call only when it genuinely makes sense: complex deal, high budget, too much back-and-forth, client is clearly ready.
- NEVER push for a call by default. A call is ONE option, not the automatic goal.
- If a client explicitly says they prefer NOT to call — fully respect this and find another next step.

WHATSAPP STYLE RULES (critical):
- Short to medium length. Separate distinct thoughts with a blank line — like a real WhatsApp message.
- FORMATTING: Use line breaks between paragraphs. Each paragraph = 1-2 sentences max. Never write a wall of text as one block.
- Example structure: first thought\n\nsecond thought\n\nquestion or CTA
- Natural, direct, human. No corporate language. No brochure tone.
- Do NOT use bullet points unless genuinely needed for clarity.
- Do NOT overuse: "Got it", "Makes sense", "Sure", "No problem", "Just checking in", "Quick follow up", "Hope you're well".
- Do NOT start with "Good" or thumbs up every time.
- Do NOT use long dashes (—). Use commas or short sentences instead.
- Do NOT sound like a junior assistant or support agent.
- Do NOT over-apologize or sound needy/desperate.
- Adapt length to client energy: short client reply = shorter response; detailed client = deeper answer.

SALES PHILOSOPHY:
- The goal is always to move the lead to the next CRM stage — not to gather perfect information before acting.
- MINIMUM QUALIFYING THRESHOLD: Once you know (1) investment vs lifestyle AND (2) property type (villa / apartment / land) → that is enough to offer a curated shortlist. You do NOT need budget, area, bedrooms, or timeline before sending options. Those will surface naturally from the options conversation ("too expensive?" = now you know the budget).
- Do NOT over-qualify. Most leads will never give you a full brief upfront. 2-3 well-chosen popular options based on a rough brief move the conversation faster than 5 more questions.
- When minimum qualifying is met → offer to send a shortlist. Don't wait.
- Position yourself as the person who filters the market, not dumps listings.
- "I have a few options that match exactly this — rental villas in prime locations, strong yield track record. Let me send those over?"

CALL STRATEGY:
- Do NOT say "Can we schedule a call please?" — instead: "If you want, we can jump on a quick call. I can give you a much clearer picture of how the Bali market works right now and where I see the strongest opportunities in your budget."
- For serious clients: "Honestly, a quick 15-20 minute call will save a lot of time compared to going through random listings."
- ONLY suggest meeting in person (coffee, meet up) if the lead has EXPLICITLY mentioned being in Bali or visiting Bali soon. Never assume a lead is physically in Bali — most clients are international and remote.
- A call is not always the right next step. Sometimes it's a shortlist, a property link, a market insight, or a simple clarifying question.

MESSAGE ENDINGS — match the CTA to the stage:
- Very early (goal not yet known): "Is this more for investment or personal use?"
- Goal known, type unknown: "Are you thinking more villas, or open to apartments as well?"
- Minimum qualifying met (goal + type known) → MOVE FORWARD: "I have a few options that match this well. Want me to send them over?" / "I can put together 2-3 that fit this — shall I?"
- Options sent, awaiting feedback: "From what I sent, which direction felt closest?"
- Ready for deeper talk: "Happy to go through this on a quick call — 15 mins. What time works?"
- If the lead prefers not to call → offer to send a detailed summary or shortlist via WhatsApp.
- Avoid ending with just "let me know" or "happy to help".
- NEVER end with another qualifying question when minimum qualifying is already met.

OBJECTION HANDLING:
- "I'm just browsing": "Totally fine. If you want to understand the market properly, it helps to separate random browsing from what actually makes sense. I can give you a quick overview."
- "Not the right time": "Is it mainly about capital allocation, or more about market uncertainty? Many investors are actually moving into Bali now as a capital preservation play."
- "Bali is expensive": "Fair point. But compared to what? Good properties in strong locations still offer a very different return potential compared to many mature markets."
- "I want freehold": "True freehold in strong areas is very limited and much more expensive. Most foreign investors use leasehold because it gives a lower entry point and often stronger ROI when structured properly."
- "I prefer apartments": "Fine to look at both. Just worth keeping in mind that Bali is primarily a villa market — most rental demand and lifestyle value is still concentrated around villas."
- "I already found options": "Great, send them over. I can give you an honest independent view on developer reputation, build quality, legal structure, and whether the numbers are realistic."
- "I don't want pressure": "Completely understand. I'm not here to push you into anything. My job is to give you a clear picture so you don't waste time or go in the wrong direction."

LEASEHOLD EXPLANATION:
- Do NOT lead with "after the lease expires, the land goes back to the landowner." Lead with: people usually extend or resell before expiry.
- Leasehold in Indonesia is one of the stronger legal agreements here when structured properly. You fully own the building; the land is leased for a fixed period during which you control it fully.
- Apartment analogy: "In many countries when you buy an apartment, you own the unit but not the land. With villas in Bali, the structure is just more explicit."

ROI AND RENTAL PERFORMANCE:
- Never guarantee ROI. Use: potential, expected range, can achieve, with the right setup, depends on.
- Conservative occupancy scenario: 65-70%. 85% is possible in strong cases but optimistic for planning.
- Always explain gross vs net. Do not destroy excitement before confirming value first.

FOLLOW-UP STYLE:
- Avoid weak follow-ups: "Just checking in", "Any update?", "Following up".
- If client went silent after options: "Hi [Name], from what I sent, was it not really your direction, or did you just not get a chance to look yet? It's a quick 5-10 minute look max. If nothing clicked, no hard feelings — just let me know and I'll send something more aligned."
- If client says "I'll let you know": "What timing would make sense to reconnect? End of this week, next week, or beginning of next month?"

HIGH PRIORITY COMMUNICATION RULES:

Rule 1 — Value First, Question Second:
Never send a message that only asks a question. Every message must first provide value: a market insight, observation, suggestion, or useful context. Only after creating value should you naturally introduce a question.
BAD: "What budget are you looking at?"
GOOD: "For pure investment, the strongest performing properties today are usually compact villas in prime rental locations. To help me point you in the right direction, what budget range are you currently considering?"

Rule 2 — Every Question Must Have Context:
Never ask a question without explaining why you are asking it. The client should immediately understand how answering benefits them.
BAD: "Which area are you looking at?"
GOOD: "Some areas perform much better for short term rentals, while others are more suitable for lifestyle and long term living. Do you already have any preferred locations in mind?"

Rule 3 — Suggest Before Asking:
Whenever possible, make an educated suggestion first. People respond more often when they react to an idea rather than answering a blank question.
BAD: "What are you looking for?"
GOOD: "Most investors I work with today are focusing on one or two bedroom villas in Pererenan, Canggu, Bingin, and Uluwatu because those segments currently have the strongest rental demand. Is that roughly the direction you're exploring as well?"

Rule 4 — The Client Must Learn Something From Every Message:
Every message should contain at least one of: a market insight, a common buyer mistake, a legal consideration, an investment observation, a property selection tip, a comparison framework, or a useful recommendation. If the message contains only a question, it fails this rule.

Rule 5 — No Generic Follow Ups:
Never send: "Just following up", "Any update?", "Checking in", "Are you still interested?" Instead always provide a new insight, observation, buyer tip, real example, or case study before asking for engagement.

Rule 6 — No Hyphens or Dash Style Writing:
Do not use hyphens, en dashes, em dashes, or bullet points connected with dashes. Write naturally: "short term rentals" not "short-term rentals". Messages should read like natural conversation between people, not marketing copy.

CRITICAL DO-NOT LIST:
- Do not claim guaranteed ROI, guaranteed occupancy, or guaranteed resale.
- Do not push apartments as equally strong as villas in Bali (Bali is a villa market).
- Do not attack other agents or developers directly.
- Do not sound desperate or chase weak leads endlessly.
- Do not repeat the same message pattern every time.
- Do not ask more than 1 question per message. Do not ignore small talk or skip human warmth.
- Return ONLY the message body — plain text, ready to send via WhatsApp. No subject lines, no quotes, no explanations.

CRM STAGE LOGIC (critical — read this before generating any message):

The client's current CRM stage is: ${opts.leadStage ? `"${opts.leadStage}"` : "UNKNOWN (infer from conversation)"}

Stage rules — the objective, tone, and next step MUST match the stage:

STAGES 1-3 (Lead Assigned / Taken to Work / Contact Established):
These three stages are treated as ONE. The client is cold or just beginning to engage.
- DO NOT send property options, listings, or links under any circumstances.
- DO NOT push for a call aggressively.
- GOAL: Establish investment goal and property type as quickly as possible — those two alone unlock the next step.
- Ask at most ONE qualifying question per message. Start with goal (investment vs lifestyle), then property type.
- Success = reaching minimum qualifying threshold (goal + type known) → then move forward immediately.
IMPORTANT OVERRIDE: Even if the CRM stage is still "Contact Established", if the conversation already shows the lead has confirmed (a) investment goal AND (b) property type — do NOT ask more qualifying questions. Acknowledge what you know, add one market insight, and offer to prepare a curated shortlist. Budget, area, bedrooms can be discovered through the options themselves. Never re-ask what the lead already told you.

STAGE 4 (Needs Assessed):
Minimum qualifying is met: investment goal and property type are known. Budget and area are nice to have but not required to move forward.
- Briefly confirm what you've understood about their requirements.
- Offer 2-3 curated options that match their brief — popular, well-performing properties in the right segment.
- Do NOT send a generic property dump. Quality over quantity.
- If budget is unknown, let the options reveal it — their reaction ("too expensive", "reasonable", "what else is there?") tells you more than asking upfront.
- Frame the shortlist as a starting point, not the final answer: "These are the ones that match best based on what you told me. Let me know which direction feels right and I'll refine from there."

STAGE 5 (Options Sent):
Client already received property options.
- Focus on getting feedback about those options.
- Help compare pros and cons.
- Ask which option felt closest to their goals.
- Do NOT send another batch of properties immediately.
- Do NOT pressure. Do NOT keep asking if they've seen the options.

STAGE 6 (Zoom Call Scheduled):
Client agreed to a call.
- Confirm the time and what will be discussed.
- Remind the client of the value of the meeting.
- Do NOT restart qualification.

STAGE 7 (Viewing Scheduled):
Client is planning to visit properties. High intent stage.
- Confirm logistics and what will be shown.
- Provide context about the property and area.
- Answer concerns before the viewing.
- Do NOT restart qualification or send unrelated options.

STAGE 8 (Feedback and Objection Handling):
Client already saw options, had a call, or attended a viewing. They are evaluating.
- Identify the real objection (price, location, ROI, legal, timing, developer).
- Address it with education, evidence, and market context.
- Reduce uncertainty. Guide toward a confident decision.
- Do NOT discount immediately. Do NOT pressure.

CLOSING (Reservation and beyond):
Client has selected a property.
- Provide clarity on next steps.
- Answer legal and transaction questions.
- Maintain confidence and momentum.
- Do NOT introduce new options.

If the stage is UNKNOWN, infer from the conversation length and content:
- 0-2 messages exchanged → treat as Stage 1-3
- Client has shared budget and purpose → treat as Stage 4
- Property options were mentioned → treat as Stage 5+

KNOWLEDGE BASE (objection scripts, case studies, market data):
${kb}${brokerPicksBlock ? `\n\nBROKER'S HANDPICKED PROPERTIES (use FIRST when the segment matches the lead's interest — these are personally vetted top performers):\n${brokerPicksBlock}` : ""}${catalog ? `\n\nFULL PROPERTY CATALOG (sorted by popularity — views count shows market demand — use as backup or to supplement broker picks):\nNOTE: Higher views = more market interest = easier sell.\n${catalog}` : ""}`;


  const dialog = parseDialogContent(opts.contentSnippet);
  const formattedDialog = formatDialogForAI(dialog.messages);
  const lastLeadText = opts.lastLeadMessage.trim() || dialog.lastLeadMessage?.text || "";
  const lastBrokerText = dialog.lastOurMessage?.text ?? "";

  const leadContext = opts.leadNotes?.trim()
    ? `\nLEAD CARD INFO (name, budget, notes from broker):\n${opts.leadNotes.trim()}\n`
    : "";

  const prompt =
    opts.isFirstContact
      ? `${leadContext}
SITUATION: This lead was just assigned to you. You have not spoken with them before. No prior conversation.

Broker: ${opts.responsibleUser ?? "Broker"}

Task: Write the broker's opening WhatsApp message — a warm, direct first introduction.
- Max 3 sentences.
- Introduce yourself briefly as ${isRental ? "a Bali villa rental specialist" : "a Bali real estate advisor"} at Unicorn Property.
- End with ONE simple, open question to understand their interest (${isRental ? "dates? how long? how many guests?" : "investment? personal use? area? budget?"}).
- Do NOT list properties yet.
- Under 60 words.${AVOID_PHRASES_REMINDER}`
      : opts.kind === "live"
      ? `FULL CONVERSATION (oldest → newest):
${formattedDialog}
${leadContext}
SITUATION: The lead just replied. Their latest message:
"${lastLeadText}"

Broker: ${opts.responsibleUser ?? "Broker"}

Task: Write the broker's next WhatsApp reply. React directly to what the lead just said.

STEP 1 — COUNT LEAD MESSAGES in the conversation above (lines starting with [Lead]).
STEP 2 — APPLY THIS RULE, no exceptions:

${isRental ? `  • Lead has sent 1 message → ask ONE question: check-in/check-out dates and number of guests?
  • Lead has sent 2 messages → ask ONE question: budget per month/night, and short-term or long-term stay?
  • Lead has sent 3 or more messages → DO NOT ask any qualifying question.
    The lead has engaged enough. Write a message that: (1) briefly confirms what you understood, (2) offers to prepare a curated shortlist. Example CTA: "I've got a few that could work well for this, want me to send them over?"

This rule is absolute. Even if area or exact size is unknown — at 3+ lead messages, move forward.` : `  • Lead has sent 1 message → ask ONE question: investment or personal use?
  • Lead has sent 2 messages → ask ONE question: villas or other property type?
  • Lead has sent 3 or more messages → DO NOT ask any qualifying question.
    The lead has engaged enough. Write a message that: (1) briefly confirms what you understood, (2) adds one short market insight, (3) offers to prepare a curated shortlist. Example CTA: "I have a few options that match well — want me to send them over?"

This rule is absolute. Even if budget or area is unknown — at 3+ lead messages, move forward. Budget and area are discovered through the options, not through more questions.`}

IMPORTANT: Do NOT include any property links or listings in this reply. The broker will personally choose and share properties when ready.
Only suggest an in-person meeting if the lead explicitly mentioned being in Bali.

Under 90 words.${AVOID_PHRASES_REMINDER}`
      : `FULL CONVERSATION (oldest → newest):
${formattedDialog}
${leadContext}
SITUATION: The broker's last message was:
"${lastBrokerText}"
The lead has NOT replied to this message yet.

Broker: ${opts.responsibleUser ?? "Broker"}

Task: Write a short follow-up. The lead hasn't responded — re-engage without repeating the same message. Use any lead card info above to personalise.

IMPORTANT: Do NOT include property links or listings in this follow-up. The broker will personally select and share properties when ready. Your job is to re-engage naturally — add value, reference something they said earlier, or propose a low-effort next step.

Under 100 words.${AVOID_PHRASES_REMINDER}`;

  const completion = await chatCompletion({
    model: "claude-sonnet-5",
    system: systemPrompt,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 400,
  });

  const text = sanitizeSuggestion(completion.content);

  const picks = await matchProperties({
    listingType: isRental ? "rent" : "sale",
    conversationText: `${formattedDialog}\n${lastLeadText}`,
    brokerId: opts.responsibleUser,
  }).catch(() => []);

  return { text, attachments: toAttachments(picks) };
}

export async function queueSuggestion(opts: {
  leadId: string;
  responsibleUser: string | null;
  kind: "live" | "push";
  text: string;
  followupLevel?: number;
  attachments?: GeneratedSuggestion["attachments"];
}): Promise<void> {
  const brokerId = (opts.responsibleUser ?? "unknown").toLowerCase().slice(0, 64);

  await db.insert(aiSuggestionsTable).values({
    brokerId,
    leadId: opts.leadId,
    leadName: `Lead #${opts.leadId}`,
    promptMessages: [],
    suggestionText: opts.text,
    rationale:
      opts.kind === "live"
        ? `Lead replied. Respond now to keep the thread warm.`
        : `Follow-up #${opts.followupLevel ?? 1} — no reply yet.`,
    model: "claude-sonnet-5",
  });

  if (opts.kind === "live") {
    // Lead replied — LIVE always wins. Replace any stale PUSH or LIVE suggestions.
    await db
      .delete(pendingSuggestionsTable)
      .where(
        and(
          eq(pendingSuggestionsTable.leadId, opts.leadId),
          eq(pendingSuggestionsTable.status, "pending"),
        ),
      );

    await db.insert(pendingSuggestionsTable).values({
      leadId: opts.leadId,
      responsibleUser: opts.responsibleUser,
      kind: "live",
      followupLevel: null,
      suggestionText: opts.text,
      status: "pending",
      attachments: opts.attachments,
    });
    notifyBroker(opts.responsibleUser, "Lead replied", opts.text).catch(() => {});
  } else {
    // PUSH — only queue if no pending suggestion already exists
    const existing = await db
      .select({ id: pendingSuggestionsTable.id })
      .from(pendingSuggestionsTable)
      .where(
        and(
          eq(pendingSuggestionsTable.leadId, opts.leadId),
          eq(pendingSuggestionsTable.status, "pending"),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      await db.insert(pendingSuggestionsTable).values({
        leadId: opts.leadId,
        responsibleUser: opts.responsibleUser,
        kind: "push",
        followupLevel: opts.followupLevel ?? null,
        suggestionText: opts.text,
        status: "pending",
        attachments: opts.attachments,
      });
    }
  }
}

/**
 * Split an AI response into individual property messages.
 * Each URL+description block becomes a separate WhatsApp message so
 * WhatsApp renders a unique banner/preview for each property link.
 * Returns the original text as a single-element array if no URLs are found.
 */
function splitPropertyMessages(text: string): string[] {
  const urlCount = (text.match(/^https?:\/\//gm) ?? []).length;
  if (urlCount < 2) return [text.trim()];
  // Split at every newline that immediately precedes a URL
  const parts = text.split(/\n(?=https?:\/\/)/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

router.post("/amocrm/webhook", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  req.log.info({ keys: Object.keys(body) }, "amocrm webhook received");

  // ── New primary format: { leadId, responsibleUser, content } ──────────────
  if (typeof body["leadId"] === "string" && typeof body["content"] === "string") {
    const leadId = body["leadId"] as string;
    const responsibleUser = (body["responsibleUser"] as string | undefined) ?? null;
    const content = body["content"] as string;
    const leadNotes = (body["leadNotes"] as string | undefined) ?? null;
    // Accept both "leadStage" (old format) and "stage" (new format)
    const leadStage = ((body["stage"] ?? body["leadStage"]) as string | undefined) ?? null;
    const leadStageId = (body["stageId"] as string | undefined) ?? null;
    const pipeline = (body["pipeline"] as string | undefined) ?? null;

    // Respond immediately — processing is async
    res.json({ ok: true, leadId });

    // HoS is also responsible for leads outside the Rental pipeline (e.g. a
    // separate hiring/HR track) — this bot only handles Rental for that account,
    // so skip generation entirely rather than burning an AI call just to hide it later.
    if (responsibleUser === "HoS" && (pipeline ?? "").toLowerCase() !== "rental") {
      return;
    }

    try {
      const eventType = (body["event"] as string | undefined) ?? "";
      req.log.info(
        { contentTail: content.slice(-150), contentLen: content.length },
        "webhook content tail",
      );

      // ── lead_assigned: first-contact push suggestion ──────────────────────
      if (eventType === "lead_assigned") {
        await db.insert(leadsSyncTable).values({
          leadId,
          responsibleUser,
          content,
          leadNotes,
          leadStage: leadStage ?? undefined,
          leadStageId: leadStageId ?? undefined,
          pipeline: pipeline ?? undefined,
          lastMessageAt: null,
          lastMessageFrom: null,
          lastOurMessageAt: null,
          followupLevel: 0,
          nextFollowupAt: null,
        }).onConflictDoUpdate({
          target: leadsSyncTable.leadId,
          set: { responsibleUser, leadNotes: leadNotes ?? undefined, leadStage: leadStage ?? undefined, leadStageId: leadStageId ?? undefined, pipeline: pipeline ?? undefined, content },
        });

        // Rental has its own amoCRM automation ("Команда F5") that sends the
        // very first message, same role ARGO plays for Unicorn — the bot must
        // not also suggest a first-contact message on top of that. In practice
        // this handler has never fired for Unicorn leads either (no historical
        // records), so skipping it for Rental brings the two pipelines to parity.
        if ((pipeline ?? "").toLowerCase() === "rental") {
          return;
        }

        // "lead_assigned" fires on every (re)assignment, not just genuinely new
        // leads — e.g. amoCRM can re-fire it after a lead is already engaged.
        // Only treat this as a true cold-open if there's no real conversation yet.
        const hasExistingDialog = parseDialogContent(content).messages.length > 0;

        const { text, attachments } = await generateSuggestion({
          leadId,
          responsibleUser,
          kind: "push",
          lastLeadMessage: "",
          contentSnippet: content,
          leadNotes,
          leadStage,
          isFirstContact: !hasExistingDialog,
          pipeline,
        });
        if (text) {
          await queueSuggestion({ leadId, responsibleUser, kind: "push", text, attachments });
          req.log.info({ leadId }, "lead_assigned first-contact suggestion queued");
        }
        return;
      }

      const dialog = parseDialogContent(content);
      const now = new Date();

      // LIVE if: dialog parser says lead replied, OR the event explicitly says so
      const isLiveEvent =
        eventType === "lead_replied" || eventType === "incoming_message";
      let isLive = dialog.leadRepliedAfterUs || isLiveEvent;

      // Fetch existing record
      const [existing] = await db
        .select()
        .from(leadsSyncTable)
        .where(eq(leadsSyncTable.leadId, leadId))
        .limit(1);

      // Use the MOST RECENT known "our message" timestamp.
      // dialog.lastOurMessage?.at comes from stale webhook content and can be older
      // than existing.lastOurMessageAt (updated by approve.ts before the hook fires).
      // Always take the max so follow-up scheduling is based on the real last reply.
      const dialogOurAt = dialog.lastOurMessage?.at ?? null;
      const existingOurAt = existing?.lastOurMessageAt ?? null;
      const lastOurAt =
        dialogOurAt && existingOurAt
          ? new Date(Math.max(dialogOurAt.getTime(), existingOurAt.getTime()))
          : dialogOurAt ?? existingOurAt ?? null;
      const lastMsgAt = dialog.lastMessage?.at ?? null;
      let lastMsgFrom = dialog.lastMessage?.from ?? null;

      // ── Stale-content guard ──────────────────────────────────────────────────
      // Webhook content can arrive delayed (e.g. AmoCRM fires before WAHelp syncs
      // Robert's reply). If our DB already knows Robert replied AFTER the lead's
      // last message in this content, don't let the stale content downgrade
      // lastMessageFrom back to 'lead'.
      if (
        lastMsgFrom === "lead" &&
        existing?.lastMessageFrom === "us" &&
        existing.lastOurMessageAt &&
        dialog.lastLeadMessage?.at &&
        existing.lastOurMessageAt.getTime() > dialog.lastLeadMessage.at.getTime()
      ) {
        req.log.info({ leadId }, "stale-content guard: keeping lastMessageFrom=us, suppressing LIVE");
        lastMsgFrom = "us";
        isLive = false; // prevent generating a new LIVE suggestion for stale content
      }

      let nextFollowupAt: Date | null = existing?.nextFollowupAt ?? null;
      let followupLevel = existing?.followupLevel ?? 0;

      // Detect: broker just sent a NEW human message (not a re-delivery of old content)
      const brokerRepliedFresh =
        !isLive &&
        !!lastOurAt &&
        !!existing?.lastOurMessageAt &&
        lastOurAt.getTime() > existing.lastOurMessageAt.getTime();

      if (isLive) {
        // Lead replied → LIVE → reset follow-up schedule + clear any pending PUSH items
        nextFollowupAt = null;
        followupLevel = 0;
        await db
          .update(pendingSuggestionsTable)
          .set({ status: "skipped" })
          .where(
            and(
              eq(pendingSuggestionsTable.leadId, leadId),
              eq(pendingSuggestionsTable.status, "pending"),
              eq(pendingSuggestionsTable.kind, "push"),
            ),
          );
      } else if (brokerRepliedFresh) {
        // Broker manually replied → clear stale LIVE suggestion.
        // Do NOT set nextFollowupAt — task-driven scheduling via amo-sync
        // will pick up the amoCRM task due date when it's time.
        await db
          .delete(pendingSuggestionsTable)
          .where(
            and(
              eq(pendingSuggestionsTable.leadId, leadId),
              eq(pendingSuggestionsTable.status, "pending"),
              eq(pendingSuggestionsTable.kind, "live"),
            ),
          );
        // Keep followupLevel as-is (stage-based selection handles it at generation time)
        nextFollowupAt = null;

        // Track outbound touch — direct (sent outside plugin)
        await db.insert(contactEventsTable).values({
          leadId,
          responsibleUser: responsibleUser ?? existing?.responsibleUser ?? undefined,
          source: "direct",
        }).catch(() => {});

        // Rental pipeline: a broker replying directly via WhatsApp (bypassing
        // the extension) still counts as "this touch is done" — advance the
        // stage and create the next task, same as if the bot had sent it.
        if ((pipeline ?? "").toLowerCase() === "rental") {
          try {
            const amoLead = await getAmoLead(leadId);
            if (amoLead?.status_id) {
              const level = rentalStageToFollowupLevel(existing?.leadStage ?? leadStage);
              await advanceRentalFollowup(leadId, amoLead.status_id, level);
              req.log.info({ leadId, level }, "rental: manual WhatsApp reply advanced follow-up");
            }
          } catch (err) {
            req.log.error({ err, leadId }, "rental: advanceRentalFollowup on manual reply failed");
          }
        }
      } else if (lastMsgFrom === "us") {
        // Broker wrote last, lead hasn't replied.
        // Do NOT auto-schedule — the broker creates an amoCRM task with the
        // desired follow-up date and amo-sync detects it when due.
        nextFollowupAt = null;
      } else if (lastMsgFrom === "lead") {
        // Lead wrote last — they already replied, no follow-up needed.
        // Just wait for broker to respond (LIVE suggestion handles this).
        nextFollowupAt = null;
      }

      // Upsert leads_sync
      if (existing) {
        await db
          .update(leadsSyncTable)
          .set({
            responsibleUser,
            content,
            leadNotes: leadNotes ?? existing?.leadNotes ?? null,
            leadStage: leadStage ?? existing?.leadStage ?? null,
            leadStageId: leadStageId ?? existing?.leadStageId ?? null,
            pipeline: pipeline ?? existing?.pipeline ?? null,
            lastMessageAt: lastMsgAt,
            lastMessageFrom: lastMsgFrom,
            lastOurMessageAt: lastOurAt,
            followupLevel,
            nextFollowupAt,
            updatedAt: now,
          })
          .where(eq(leadsSyncTable.leadId, leadId));
      } else {
        await db.insert(leadsSyncTable).values({
          leadId,
          responsibleUser,
          content,
          leadNotes,
          leadStage: leadStage ?? undefined,
          leadStageId: leadStageId ?? undefined,
          pipeline: pipeline ?? undefined,
          lastMessageAt: lastMsgAt,
          lastMessageFrom: lastMsgFrom,
          lastOurMessageAt: lastOurAt,
          followupLevel,
          nextFollowupAt,
        });
      }

      req.log.info(
        { leadId, leadRepliedAfterUs: dialog.leadRepliedAfterUs, brokerRepliedFresh, followupLevel, nextFollowupAt },
        "dialog analyzed",
      );

      // ── Parse content into lead_messages immediately ────────────────────────
      syncLeadContent(leadId, content, responsibleUser)
        .then((count) => { if (count > 0) req.log.info({ leadId, count }, "webhook: messages parsed into lead_messages"); })
        .catch((err) => req.log.error({ err, leadId }, "webhook: message parse failed"));

      // ── Dead-stage cleanup ────────────────────────────────────────────────────
      // If the lead just moved to a closed/lost/incorrect-information stage,
      // immediately cancel ALL pending suggestions so they stop showing in the bot.
      const effectiveStageForCleanup = leadStage ?? existing?.leadStage ?? null;
      if (effectiveStageForCleanup && shouldSuppressPush(effectiveStageForCleanup)) {
        const cancelled = await db
          .update(pendingSuggestionsTable)
          .set({ status: "skipped" })
          .where(
            and(
              eq(pendingSuggestionsTable.leadId, leadId),
              eq(pendingSuggestionsTable.status, "pending"),
            ),
          );
        req.log.info(
          { leadId, stage: effectiveStageForCleanup },
          "dead-stage: all pending suggestions cancelled",
        );
        return;
      }

      if (isLive) {
        // LIVE — generate AI suggestion right now
        const effectiveStage = leadStage ?? existing?.leadStage ?? null;

        // ── Stage whitelist (testing filter) ─────────────────────────────────
        if (!isStageWhitelisted(effectiveStage)) {
          req.log.info(
            { leadId, leadStage: effectiveStage },
            "live suggestion skipped — stage not in testing whitelist",
          );
        } else {
          const lastLeadMsg = dialog.lastLeadMessage?.text ?? (content.slice(-400));
          const { text, attachments } = await generateSuggestion({
            leadId,
            responsibleUser,
            kind: "live",
            lastLeadMessage: lastLeadMsg,
            contentSnippet: content,
            leadNotes,
            leadStage: effectiveStage,
            pipeline,
          });

          if (text) {
            await queueSuggestion({ leadId, responsibleUser, kind: "live", text, attachments });
            req.log.info({ leadId }, "live suggestion queued");
          }
        }
      }
      // PUSH / follow-ups are handled by the scheduler (not inline)
    } catch (err) {
      req.log.error({ err, leadId }, "webhook processing error");
    }

    return;
  }

  // ── Legacy Ф5 flat format: { leadId, responsibleUser, event, content? } ───
  if (typeof body["leadId"] === "string") {
    const leadId = body["leadId"] as string;
    const responsibleUser = (body["responsibleUser"] as string) ?? null;
    const content = (body["content"] as string) ?? "";
    const eventType = (body["event"] as string) ?? "unknown";

    const kind: "live" | "push" =
      eventType === "lead_replied" || eventType === "incoming_message" ? "live" : "push";

    res.json({ ok: true, queued: 1, leadId, kind });

    const [legacySyncRow] = await db
      .select({ pipeline: leadsSyncTable.pipeline })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, leadId))
      .limit(1);

    // HoS is also responsible for leads outside the Rental pipeline (e.g. a
    // separate hiring/HR track) — this bot only handles Rental for that account.
    if (responsibleUser === "HoS" && (legacySyncRow?.pipeline ?? "").toLowerCase() !== "rental") {
      return;
    }

    const { text, attachments } = await generateSuggestion({
      leadId,
      responsibleUser,
      kind,
      lastLeadMessage: content,
      contentSnippet: content,
      pipeline: legacySyncRow?.pipeline,
    }).catch((err) => {
      req.log.error({ err, leadId }, "generate error");
      return { text: "", attachments: [] };
    });

    if (text) {
      await queueSuggestion({ leadId, responsibleUser, kind, text, attachments }).catch((err) =>
        req.log.error({ err }, "queue error"),
      );
    }

    return;
  }

  // ── Native AmoCRM webhook: { leads: { add, update } } ─────────────────────
  const amoBody = body as {
    leads?: {
      add?: Array<{ id?: string; name?: string; responsible_user_name?: string }>;
      update?: Array<{ id?: string; name?: string; responsible_user_name?: string }>;
    };
  };

  const tasks: string[] = [];

  for (const lead of amoBody.leads?.add ?? []) {
    if (!lead.id) continue;
    tasks.push(lead.id);
    const [syncRow] = await db
      .select({ pipeline: leadsSyncTable.pipeline })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, String(lead.id)))
      .limit(1);
    if (lead.responsible_user_name === "HoS" && (syncRow?.pipeline ?? "").toLowerCase() !== "rental") continue;
    const { text, attachments } = await generateSuggestion({
      leadId: String(lead.id),
      responsibleUser: lead.responsible_user_name ?? null,
      kind: "push",
      lastLeadMessage: "",
      contentSnippet: lead.name ?? "",
      pipeline: syncRow?.pipeline,
    }).catch(() => ({ text: "", attachments: [] }));
    if (text) {
      await queueSuggestion({
        leadId: String(lead.id),
        responsibleUser: lead.responsible_user_name ?? null,
        kind: "push",
        text,
        attachments,
      }).catch(() => null);
    }
  }

  for (const lead of amoBody.leads?.update ?? []) {
    if (!lead.id) continue;
    tasks.push(lead.id);
    const [syncRow] = await db
      .select({ pipeline: leadsSyncTable.pipeline })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, String(lead.id)))
      .limit(1);
    if (lead.responsible_user_name === "HoS" && (syncRow?.pipeline ?? "").toLowerCase() !== "rental") continue;
    const { text, attachments } = await generateSuggestion({
      leadId: String(lead.id),
      responsibleUser: lead.responsible_user_name ?? null,
      kind: "live",
      lastLeadMessage: "",
      contentSnippet: lead.name ?? "",
      pipeline: syncRow?.pipeline,
    }).catch(() => ({ text: "", attachments: [] }));
    if (text) {
      await queueSuggestion({
        leadId: String(lead.id),
        responsibleUser: lead.responsible_user_name ?? null,
        kind: "live",
        text,
        attachments,
      }).catch(() => null);
    }
  }

  res.json({ ok: true, queued: tasks.length });
});

router.get("/amocrm/webhook", (_req, res) => {
  res.json({ ok: true, message: "AmoCRM webhook endpoint is live" });
});

// Internal: regenerate a live suggestion for a lead using current lead data from DB
router.post("/amocrm/regen-live", async (req, res) => {
  const { leadId, responsibleUser } = req.body as { leadId: string; responsibleUser?: string };
  if (!leadId) { res.status(400).json({ error: "leadId required" }); return; }

  try {
    const rows = await db.select().from(leadsSyncTable).where(eq(leadsSyncTable.leadId, String(leadId))).limit(1);
    if (!rows[0]) { res.status(404).json({ error: "lead not found" }); return; }

    const lead = rows[0];

    // ── Stage whitelist (testing filter) ───────────────────────────────────
    if (!isStageWhitelisted(lead.leadStage)) {
      res.json({ ok: true, skipped: true, reason: "stage not in testing whitelist", stage: lead.leadStage });
      return;
    }

    const dialog = parseDialogContent(lead.content ?? "");
    const lastLeadMsg = dialog.lastLeadMessage?.text ?? "";

    if (!lastLeadMsg) { res.json({ ok: true, skipped: true, reason: "no lead message" }); return; }

    const { text, attachments } = await generateSuggestion({
      leadId: String(leadId),
      responsibleUser: responsibleUser ?? lead.responsibleUser ?? null,
      kind: "live",
      lastLeadMessage: lastLeadMsg,
      contentSnippet: lead.content ?? "",
      leadNotes: lead.leadNotes ?? null,
      leadStage: lead.leadStage ?? null,
      pipeline: lead.pipeline,
    });

    await queueSuggestion({
      leadId: String(leadId),
      responsibleUser: responsibleUser ?? lead.responsibleUser ?? null,
      kind: "live",
      text,
      attachments,
    });

    res.json({ ok: true, leadId, preview: text.slice(0, 100) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "regen-live failed");
    res.status(500).json({ error: msg.slice(0, 200) });
  }
});

// One-shot: delete all pending suggestions containing property links
router.post("/amocrm/purge-property-links", async (_req, res) => {
  try {
    const { sql } = await import("drizzle-orm");
    const result = await db.execute(
      sql`DELETE FROM pending_suggestions WHERE status = 'pending' AND suggestion_text LIKE '%unicorn-property%'`
    );
    res.json({ ok: true, deleted: (result as any).rowCount ?? "?" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg.slice(0, 200) });
  }
});

export default router;
