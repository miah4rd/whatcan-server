/**
 * "The client is waiting for an answer from the villa owner" — the step after "I'll check with the owner"
 * (owner, 27.09.2026, Copilot OS first). Any question: availability, a lower price, pets, anything.
 *
 * The owner's words: a broker who writes "I'll check with the owner" has closed the conversation in the
 * Copilot; he calls the owner and answers the client straight in WhatsApp, and the Copilot never sees the
 * rest. Every step must have its next step inside the Copilot.
 *
 * So the moment such a promise is SENT, the client's card gets one PUSH item (first in Push, red tag)
 * that is not a message: the question, the villas it is about (picked by the bot: the villa the client
 * swipe-replied to in WhatsApp, else the thread; the broker only corrects), and two ways to answer:
 *   🤖 ASK THE OWNER: the listing side asks, from the villa's own Rental Listings card and its listing
 *     agent's line, in the owner's language, like the weekly check; the owner's reply is read and comes
 *     back as the draft to the client (the listing agent's bot and the broker's bot share this record).
 *   📞 I CALLED: the broker writes what the owner said, the draft to the client is written from it.
 * Either way the reply to the client is a LIVE draft with the next step (a viewing when the answer is
 * good; when not, the question whether to look at the rest of the shortlist or at new options).
 * Unclear which villa: the CLIENT is asked, never the broker.
 *
 * Nothing here sends to a client: the replies are drafts the broker approves; the PUSH item itself can
 * never be sent (approve.ts refuses it). The question to the owner is a draft too, unless the mode is
 * "auto" (after the move, when the listing agent's line runs in the OS).
 */
import { pool } from "@workspace/db";
import { logger } from "../logger";
import { OS_MODE, amoFetch, amoPost } from "../amo-client";
import { chatCompletion, chatCompletionJSON, HELPER_MODEL, WRITER_MODEL } from "../ai-client";
import { correctionsPromptBlock } from "../broker-corrections";
import { sanitizeSuggestion } from "../sanitize-suggestion";
import { notifyBroker } from "../push-notifications";
import { siteGet } from "../listing-status-week";
import { readAnswer, guardAnswer, fetchLeadTitle, threadLanguage, writeAvailability, writeOccupied, type AvailabilityAnswer } from "../weekly-availability-check";

/** autopilot_skipped_reason of the broker's PUSH item: `availability ask:<id>`. Never sent. */
export const AVAILABILITY_ASK_VERDICT = "availability ask";
/** autopilot_skipped_reason of a question to a villa owner: `availability owner ask:<id>`. */
export const AVAILABILITY_OWNER_VERDICT = "availability owner ask";
/** autopilot_skipped_reason of the reply to the client once the answers are in. */
export const AVAILABILITY_REPLY_VERDICT = "availability answer";
/** autopilot_skipped_reason of the question to the client "which one do you mean?". */
export const AVAILABILITY_CLARIFY_VERDICT = "availability clarify";

const LISTINGS_PIPELINE_ID = 11180334;
/** Nobody touched the question, or the owner has not answered: the broker is told at these marks (owner, 27.09). */
const NUDGE_MARKS_MS = [30 * 60_000, 2 * 3_600_000];
/** An automatic question that has not left after this long is sent again. */
const RESEND_AFTER_MS = 3 * 60_000;

type Villa = { id: string; label: string; url: string };
/** An answer: the owner's or the broker's words, and (availability questions) the reading of a date. */
type VillaAnswer = { text: string; by: "broker" | "owner"; availability?: AvailabilityAnswer };
type OwnerAsk = { lead: string; suggestion: string; villas: string[] };
export type Ask = {
  id: string;
  client_lead_id: string;
  broker: string | null;
  candidates: Villa[];
  villa_ids: string[];
  answers: Record<string, VillaAnswer>;
  owners: Record<string, OwnerAsk>;
  move_in: string | null;
  stay: string | null;
  /** What the client wants to know, as asked to the owner (English, one line). */
  question: string | null;
  status: "open" | "clarifying" | "answered" | "cancelled";
  nudges?: number;
  push_suggestion_id: string | null;
  reminded_at: string | null;
  created_at: string;
};

let ready: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  ready ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS os_availability_asks (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         client_lead_id text NOT NULL,
         broker text,
         candidates jsonb NOT NULL DEFAULT '[]',
         move_in text,
         stay text,
         status text NOT NULL DEFAULT 'open',
         push_suggestion_id uuid,
         reply_suggestion_id uuid,
         reminded_at timestamptz,
         created_at timestamptz NOT NULL DEFAULT now(),
         answered_at timestamptz
       );
       ALTER TABLE os_availability_asks ADD COLUMN IF NOT EXISTS villa_ids jsonb NOT NULL DEFAULT '[]';
       ALTER TABLE os_availability_asks ADD COLUMN IF NOT EXISTS answers jsonb NOT NULL DEFAULT '{}';
       ALTER TABLE os_availability_asks ADD COLUMN IF NOT EXISTS owners jsonb NOT NULL DEFAULT '{}';
       ALTER TABLE os_availability_asks ADD COLUMN IF NOT EXISTS question text;
       ALTER TABLE os_availability_asks ADD COLUMN IF NOT EXISTS nudges int NOT NULL DEFAULT 0;
       CREATE INDEX IF NOT EXISTS os_availability_asks_open ON os_availability_asks (status, client_lead_id);`,
    )
    .then(() => undefined)
    .catch((err) => {
      ready = null;
      throw err;
    });
  return ready;
}

const PROMISE_CUE =
  /availab|free (from|on|for)|still free|check (with|on|the|if|whether)|ask (the )?(owner|landlord)|with the (owner|landlord)|confirm|double.?check|get back to you|come back to you|let you know|find out|уточн|провер|свобод|узна|спрош|cek|tanya|tersedia|kosong|konfirmasi/i;
const CODE = /\b(R-[A-Z]+-\d+)\b/gi;
const idsIn = (text: string): string[] => [
  ...new Set([...String(text ?? "").matchAll(/\/property\/([A-Za-z0-9-]+)/gi)].map((m) => m[1]!.toUpperCase()).concat([...String(text ?? "").matchAll(CODE)].map((m) => m[1]!.toUpperCase()))),
];

/** Villas already sent on this card, newest first: the links of the approved drafts. */
async function sentVillas(leadId: string): Promise<Villa[]> {
  const r = await pool.query(
    `SELECT attachments FROM pending_suggestions WHERE lead_id = $1 AND status = 'approved' AND attachments IS NOT NULL ORDER BY created_at DESC LIMIT 20`,
    [leadId],
  );
  const out: Villa[] = [];
  const seen = new Set<string>();
  for (const row of r.rows) {
    for (const a of (row.attachments ?? []) as Array<{ url?: string; label?: string; ladder?: { caption?: string } }>) {
      const id = String(a.url ?? "").match(/\/property\/([A-Za-z0-9-]+)/i)?.[1]?.toUpperCase();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const caption = String(a.ladder?.caption ?? "").split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
      out.push({ id, label: caption.replace(/^\d+\.\s*/, "").slice(0, 80) || id, url: a.url! });
    }
  }
  return out;
}

async function recentThread(leadId: string): Promise<string> {
  const r = await pool.query(
    `SELECT sender_type, text FROM lead_messages WHERE lead_id = $1 AND text IS NOT NULL ORDER BY sent_at DESC LIMIT 14`,
    [leadId],
  );
  return r.rows
    .reverse()
    .map((m) => `${m.sender_type === "lead" ? "Client" : "Us"}: ${String(m.text).replace(/\s+/g, " ").slice(0, 400)}`)
    .join("\n");
}

/** The villas the client swipe-replied to in WhatsApp (the quoted message names the villa). */
async function quotedVillas(leadId: string, known: Set<string>): Promise<string[]> {
  const r = await pool
    .query(
      `SELECT q.text FROM wa_messages m JOIN wa_messages q ON q.session = m.session AND q.wa_id = m.quoted_wa_id
        WHERE m.card_lead_id = $1 AND m.direction = 'in' AND m.quoted_wa_id IS NOT NULL AND m.created_at > now() - interval '3 days'
        ORDER BY m.created_at DESC LIMIT 10`,
      [Number(leadId)],
    )
    .catch(() => ({ rows: [] as Array<{ text: string }> }));
  return [...new Set(r.rows.flatMap((x) => idsIn(x.text)).filter((id) => known.has(id)))];
}

/**
 * Called after a message to a Rental client is SENT (approve.ts). One model call only when the text
 * carries a cue; nothing when an ask is already open on the card.
 */
export async function maybeStartAvailabilityAsk(leadId: string, sentText: string, broker: string | null): Promise<void> {
  if (!PROMISE_CUE.test(sentText ?? "")) return;
  await ensureTable();
  const sync = (await pool.query(`SELECT pipeline, req_move_in::text AS req_move_in, req_stay::text AS req_stay, responsible_user FROM leads_sync WHERE lead_id = $1`, [leadId]).catch(() => null))?.rows?.[0];
  if (!sync || String(sync.pipeline ?? "").trim().toLowerCase() !== "rental") return;
  const open = await pool.query(`SELECT 1 FROM os_availability_asks WHERE client_lead_id = $1 AND status = 'open' LIMIT 1`, [leadId]);
  if (open.rows.length) return;
  const villas = await sentVillas(leadId);
  if (!villas.length) return;
  const known = new Set(villas.map((v) => v.id));

  const thread = await recentThread(leadId);
  const read = await chatCompletionJSON<{ promise?: boolean; villas?: string[]; question?: string }>({
    model: HELPER_MODEL,
    label: "os:availability-promise",
    max_tokens: 200,
    temperature: 0,
    system: `A real-estate broker in Bali just sent the LAST message below to a rental client. Did it promise to find something out from the villa owner and come back to the client (availability on the client's dates, a lower price, pets, anything about the villa)? A question to the client does not count.
If yes: which villas is it about? The villas sent on this card: ${villas.map((v) => `${v.id} (${v.label})`).join("; ")}. List the ids the thread makes clear (named, numbered, quoted); an empty list when it does not.
And the question to put to the owner: one short English line, the way a broker would ask it ("Is it free from 1 November for 6 months?", "Could the price go down to 35 million a month?"). Use the client's dates and numbers from the thread; invent nothing.
JSON only: {"promise": true|false, "villas": ["R-XXX-000"], "question": "…"}`,
    messages: [{ role: "user", content: `${thread}\nUs (LAST, just sent): ${sentText.slice(0, 800)}` }],
  }).catch(() => null);
  if (!read?.promise) return;
  const quoted = await quotedVillas(leadId, known);
  const named = (read.villas ?? []).map((v) => String(v).toUpperCase()).filter((v) => known.has(v));
  const picked = quoted.length ? quoted : named;
  const question = String(read.question ?? "").trim().slice(0, 300) || defaultQuestion(sync.req_move_in ?? null, sync.req_stay ?? null);
  const askId = await openAsk(leadId, broker ?? sync.responsible_user ?? null, villas, picked, sync.req_move_in ?? null, sync.req_stay ?? null, sync.responsible_user ?? broker, question);
  // Not clear which villa: the client is asked, never the broker (owner, 27.09).
  if (!picked.length && askId) await clarifyWithClient(askId).catch((err) => logger.warn({ err, askId }, "availability ask: clarify failed"));
}

function defaultQuestion(moveIn: string | null, stay: string | null): string {
  return `Is it free${moveIn ? ` from ${moveIn}` : ""}${stay ? ` for ${stay}` : ""}?`;
}

function pushText(picked: string[], question: string): string {
  return `Client waiting for an answer${picked.length ? ` on ${picked.join(", ")}` : ""}: ${question}`;
}

async function openAsk(leadId: string, broker: string | null, villas: Villa[], picked: string[], moveIn: string | null, stay: string | null, responsible: string | null, question: string): Promise<string> {
  const ask = (
    await pool.query(
      `INSERT INTO os_availability_asks (client_lead_id, broker, candidates, villa_ids, move_in, stay, question) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [leadId, broker, JSON.stringify(villas.slice(0, 10)), JSON.stringify(picked), moveIn, stay, question],
    )
  ).rows[0];
  const text = pushText(picked, question);
  const push = (
    await pool.query(
      `INSERT INTO pending_suggestions (lead_id, responsible_user, kind, suggestion_text, status, requested_at, autopilot_skipped_reason, autopilot_skipped_at, attachments)
       VALUES ($1,$2,'push',$3,'pending',now(),$4,now(),'[]'::jsonb) RETURNING id`,
      [leadId, responsible, text, `${AVAILABILITY_ASK_VERDICT}:${ask.id}`],
    )
  ).rows[0];
  await pool.query(`UPDATE os_availability_asks SET push_suggestion_id = $2 WHERE id = $1`, [ask.id, push.id]);
  logger.info({ leadId, askId: ask.id, picked, candidates: villas.length }, "availability ask: opened after the broker's promise");
  const title = (await fetchLeadTitle(leadId).catch(() => "")) || "Client";
  if (picked.length) void notifyBroker(String(responsible ?? "").toLowerCase() || null, `⏳ ${title} is waiting`, text, `/m?lead=${encodeURIComponent(leadId)}`).catch(() => 0);
  return String(ask.id);
}

/**
 * The client said "I like this one" without a swipe or a name: the reply asks them which one, and the
 * question to the broker waits until they say (passOnce reads their answer and picks the villas).
 */
export async function clarifyWithClient(askId: string): Promise<{ ok: boolean; error?: string }> {
  const ask = await askById(askId);
  if (!ask || (ask.status !== "open" && ask.status !== "clarifying")) return { ok: false, error: "This question is already closed." };
  if ((ask.villa_ids ?? []).length) return { ok: false, error: "The villa is already known." };
  const sync = (await pool.query(`SELECT responsible_user FROM leads_sync WHERE lead_id = $1`, [ask.client_lead_id]))?.rows?.[0];
  const broker = String(sync?.responsible_user ?? ask.broker ?? "");
  const thread = await recentThread(ask.client_lead_id);
  const lessons = await correctionsPromptBlock(broker, null).catch(() => "");
  const out = await chatCompletion({
    model: WRITER_MODEL,
    label: "os:availability-clarify",
    max_tokens: 300,
    temperature: 0.3,
    system: `You are ${broker || "the broker"} at Unicorn Property, Bali, writing a short WhatsApp message to a rental client. They said they like one of the villas you sent, but not which one, and you want to check its availability for them. Ask which one they mean, naming the options briefly the way your list did (number, area and price), so they can answer with one word or a number. The villas you sent: ${ask.candidates.map((v, i) => `${i + 1}. ${v.label !== v.id ? v.label : v.id}`).join("; ")}. One or two lines, warm, no dashes, no links, no codes like R-XXX.${lessons}
Return the message only.`,
    messages: [{ role: "user", content: `Conversation so far:\n${thread}` }],
  });
  const text = sanitizeSuggestion(out.content ?? "").trim();
  if (!text) return { ok: false, error: "The question could not be written just now. Try again." };
  await pool.query(
    `INSERT INTO pending_suggestions (lead_id, responsible_user, kind, suggestion_text, status, requested_at, autopilot_skipped_reason, autopilot_skipped_at, attachments)
     VALUES ($1,$2,'live',$3,'pending',now(),$4,now(),'[]'::jsonb)`,
    [ask.client_lead_id, sync?.responsible_user ?? ask.broker, text, `${AVAILABILITY_CLARIFY_VERDICT}:${ask.id}`],
  );
  await pool.query(`UPDATE os_availability_asks SET status = 'clarifying' WHERE id = $1`, [ask.id]);
  // The broker's question waits until the client says which villa.
  if (ask.push_suggestion_id) await pool.query(`UPDATE pending_suggestions SET status = 'skipped' WHERE id = $1 AND status = 'pending'`, [ask.push_suggestion_id]);
  logger.info({ askId, lead: ask.client_lead_id }, "availability ask: the client is asked which villa");
  return { ok: true };
}

/** The client answered "which one": pick the villas from their words (or their swipe) and put the question back. */
async function readClarification(ask: Ask): Promise<void> {
  const q = (await pool.query(`SELECT id FROM pending_suggestions WHERE autopilot_skipped_reason = $1 ORDER BY created_at DESC LIMIT 1`, [`${AVAILABILITY_CLARIFY_VERDICT}:${ask.id}`])).rows[0];
  if (!q) return;
  const sent = (await pool.query(`SELECT created_at FROM sent_messages WHERE suggestion_id = $1 ORDER BY created_at LIMIT 1`, [q.id])).rows[0];
  if (!sent) return;
  const replies = (
    await pool.query(`SELECT text FROM lead_messages WHERE lead_id = $1 AND sender_type = 'lead' AND text IS NOT NULL AND sent_at > $2 ORDER BY sent_at`, [ask.client_lead_id, sent.created_at])
  ).rows.map((r) => String(r.text));
  if (!replies.length) return;
  const known = new Set(ask.candidates.map((v) => v.id));
  let picked = await quotedVillas(ask.client_lead_id, known);
  if (!picked.length) {
    const read = await chatCompletionJSON<{ villas?: string[] }>({
      model: HELPER_MODEL,
      label: "os:availability-which",
      max_tokens: 120,
      temperature: 0,
      system: `A rental client was asked which of these villas they mean: ${ask.candidates.map((v, i) => `${i + 1}. ${v.id} (${v.label})`).join("; ")}. From their reply, list the ids they mean (a number, an area, a price or a description counts). Empty when the reply does not say.
JSON only: {"villas": ["R-XXX-000"]}`,
      messages: [{ role: "user", content: replies.join("\n").slice(0, 1000) }],
    }).catch(() => null);
    picked = (read?.villas ?? []).map((v) => String(v).toUpperCase()).filter((v) => known.has(v));
  }
  if (!picked.length) return;
  await pool.query(`UPDATE os_availability_asks SET villa_ids = $2, status = 'open' WHERE id = $1 AND status = 'clarifying'`, [ask.id, JSON.stringify(picked)]);
  if (ask.push_suggestion_id) await pool.query(`UPDATE pending_suggestions SET status = 'pending', requested_at = now(), suggestion_text = $2 WHERE id = $1`, [
    ask.push_suggestion_id,
    pushText(picked, ask.question || defaultQuestion(ask.move_in, ask.stay)),
  ]);
  logger.info({ askId: ask.id, picked }, "availability ask: the client said which villa");
  const title = (await fetchLeadTitle(ask.client_lead_id).catch(() => "")) || "Client";
  void notifyBroker(String(ask.broker ?? "").toLowerCase() || null, `⏳ ${title} is waiting`, pushText(picked, ask.question || defaultQuestion(ask.move_in, ask.stay)), `/m?lead=${encodeURIComponent(ask.client_lead_id)}`).catch(() => 0);
}

export async function askById(id: string): Promise<Ask | null> {
  await ensureTable();
  const r = await pool.query(`SELECT * FROM os_availability_asks WHERE id::text = $1`, [id]).catch(() => null);
  return (r?.rows?.[0] as Ask | undefined) ?? null;
}

/** The asks behind PUSH items, for the inbox (suggestions.ts). */
export async function asksForSuggestions(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!ids.length) return out;
  await ensureTable();
  const r = await pool.query(`SELECT * FROM os_availability_asks WHERE push_suggestion_id::text = ANY($1)`, [ids]).catch(() => null);
  for (const a of (r?.rows ?? []) as Ask[]) {
    const ownerState: Record<string, string> = {};
    for (const [villa, o] of Object.entries(a.owners ?? {})) {
      const s = (await pool.query(`SELECT status FROM pending_suggestions WHERE id = $1`, [o.suggestion]).catch(() => null))?.rows?.[0];
      ownerState[villa] = s?.status === "approved" ? "sent" : s?.status === "pending" ? "draft" : "none";
    }
    // The owner's name and number, so the broker can call straight from the card.
    const contacts: Record<string, { name: string; phone: string }> = {};
    for (const v of a.villa_ids ?? []) {
      const o = await villaOwner(v).catch(() => null);
      if (o) contacts[v] = { name: o.name, phone: o.phone };
    }
    out.set(String(a.push_suggestion_id), {
      id: a.id, candidates: a.candidates, villa_ids: a.villa_ids ?? [], answers: a.answers ?? {}, owner_state: ownerState, owner_contacts: contacts,
      move_in: a.move_in, stay: a.stay, status: a.status, question: a.question || defaultQuestion(a.move_in, a.stay),
    });
  }
  return out;
}

function answerLine(a: VillaAnswer): string {
  return a.text;
}

/** The broker corrects what is asked. */
export async function setQuestion(askId: string, question: string): Promise<{ ok: boolean; error?: string }> {
  const ask = await askById(askId);
  if (!ask || ask.status !== "open") return { ok: false, error: "This question is already closed." };
  const q = String(question ?? "").trim().slice(0, 300);
  if (!q) return { ok: false, error: "Write the question." };
  await pool.query(`UPDATE os_availability_asks SET question = $2 WHERE id = $1`, [askId, q]);
  if (ask.push_suggestion_id) await pool.query(`UPDATE pending_suggestions SET suggestion_text = $2 WHERE id = $1`, [ask.push_suggestion_id, pushText(ask.villa_ids ?? [], q)]);
  return { ok: true };
}

/** The broker corrects which villas the client means. */
export async function setVillas(askId: string, villaIds: string[]): Promise<{ ok: boolean; error?: string }> {
  const ask = await askById(askId);
  if (!ask || ask.status !== "open") return { ok: false, error: "This question is already closed." };
  const known = new Set(ask.candidates.map((v) => v.id));
  const ids = [...new Set(villaIds.map((v) => String(v).toUpperCase()).filter((v) => known.has(v)))];
  await pool.query(`UPDATE os_availability_asks SET villa_ids = $2 WHERE id = $1`, [askId, JSON.stringify(ids)]);
  return { ok: true };
}

async function resolve(ask: Ask): Promise<{ ok: boolean; done?: boolean; text?: string; error?: string }> {
  const claimed = await pool.query(`UPDATE os_availability_asks SET status = 'answered', answered_at = now() WHERE id = $1 AND status = 'open' RETURNING id`, [ask.id]);
  if (!claimed.rows.length) return { ok: false, error: "This question is already answered." };
  const sync = (await pool.query(`SELECT responsible_user FROM leads_sync WHERE lead_id = $1`, [ask.client_lead_id]))?.rows?.[0];
  const clientName = await fetchLeadTitle(ask.client_lead_id).catch(() => "");
  const broker = String(sync?.responsible_user ?? ask.broker ?? "");
  const facts = ask.villa_ids
    .map((id) => {
      const v = ask.candidates.find((c) => c.id === id);
      return `- ${id}${v ? ` (${v.label})` : ""}: ${answerLine(ask.answers[id]!)}`;
    })
    .join("\n");
  const others = ask.candidates.filter((c) => !ask.villa_ids.includes(c.id)).length;
  const thread = await recentThread(ask.client_lead_id);
  const lessons = await correctionsPromptBlock(broker, null).catch(() => "");
  const out = await chatCompletion({
    model: WRITER_MODEL,
    label: "os:availability-reply",
    max_tokens: 450,
    temperature: 0.4,
    system: `You are ${broker || "the broker"} at Unicorn Property, Bali, writing the next WhatsApp message to a rental client. You told them you would find something out from the villa owner; now you know.
THE QUESTION: ${ask.question || defaultQuestion(ask.move_in, ask.stay)}
THE ANSWER (the owner's words, or what the owner told you on the phone):
${facts}
The client wants to move in ${ask.move_in ?? "on their dates"}${ask.stay ? ` for ${ask.stay}` : ""}.
Write it the way you write: short, warm, no dashes, no links, no invented facts. Refer to each villa the way the conversation did (area and price), not by its code.
Always end with the next step, so the conversation goes on:
- a good answer (free on their dates, the price works, pets allowed…): say so and move on to a viewing: ask which day suits them;
- a bad answer (not free, no discount, no pets…): say so plainly, then ASK (do not send anything yet) whether they would like to look again at the other ${others ? `${others} ` : ""}villas from your list or whether you should find new options for their request;
- mixed: lead with the good one and the viewing.
Never promise anything the answer does not say.${lessons}
Return the message only.`,
    messages: [{ role: "user", content: `Conversation so far:\n${thread}` }],
  });
  const text = sanitizeSuggestion(out.content ?? "").trim();
  if (!text) {
    await pool.query(`UPDATE os_availability_asks SET status = 'open', answered_at = NULL WHERE id = $1`, [ask.id]);
    return { ok: false, error: "The reply could not be written just now. Try again." };
  }
  const reply = (
    await pool.query(
      `INSERT INTO pending_suggestions (lead_id, responsible_user, kind, suggestion_text, status, requested_at, autopilot_skipped_reason, autopilot_skipped_at, attachments)
       VALUES ($1,$2,'live',$3,'pending',now(),$4,now(),'[]'::jsonb) RETURNING id`,
      [ask.client_lead_id, sync?.responsible_user ?? ask.broker, text, `${AVAILABILITY_REPLY_VERDICT}:${ask.id}`],
    )
  ).rows[0];
  await pool.query(`UPDATE os_availability_asks SET reply_suggestion_id = $2 WHERE id = $1`, [ask.id, reply.id]);
  // The question item, and owners' questions that never left: the answers are in.
  const retire = [ask.push_suggestion_id, ...Object.values(ask.owners ?? {}).map((o) => o.suggestion)].filter(Boolean);
  await pool.query(`UPDATE pending_suggestions SET status = 'skipped' WHERE status = 'pending' AND id = ANY($1::uuid[])`, [retire]);
  logger.info({ askId: ask.id, lead: ask.client_lead_id, villas: ask.villa_ids }, "availability ask: answered — reply to the client drafted");
  if (Object.values(ask.answers).some((a) => a.by === "owner")) {
    void notifyBroker(broker.toLowerCase() || null, `✅ Owner answered`, `The reply to ${clientName || "the client"} is ready in Live`, `/m?lead=${encodeURIComponent(ask.client_lead_id)}`).catch(() => 0);
  }
  return { ok: true, done: true, text };
}

const today = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);

/** 📞 I CALLED: the broker writes what the owner said; the reply to the client is written from it. */
export async function answerByBroker(askId: string, input: { text?: string }): Promise<{ ok: boolean; done?: boolean; text?: string; error?: string }> {
  const ask = await askById(askId);
  if (!ask || ask.status !== "open") return { ok: false, error: "This question is already closed." };
  const t = String(input.text ?? "").trim().slice(0, 1500);
  if (!t) return { ok: false, error: "Write what the owner said." };
  if (!(ask.villa_ids ?? []).length) return { ok: false, error: "Pick the villa the client liked." };
  const answers: Record<string, VillaAnswer> = {};
  for (const v of ask.villa_ids) if (!ask.answers?.[v]) answers[v] = { text: t, by: "broker" };
  await pool.query(`UPDATE os_availability_asks SET answers = answers || $2::jsonb WHERE id = $1 AND status = 'open'`, [ask.id, JSON.stringify(answers)]);
  const fresh = await askById(askId);
  return resolve(fresh!);
}

/** Owner phone and name from the site's Internal data. */
async function villaOwner(villaId: string): Promise<{ phone: string; name: string; title: string } | null> {
  const [priv] = await siteGet<Array<{ owner_phone: string | null; owner_name: string | null }>>(
    `property_private?select=owner_phone,owner_name&property_id=eq.${encodeURIComponent(villaId)}`,
  ).catch(() => []);
  const [pub] = await siteGet<Array<{ title: string | null }>>(`properties?select=title&id=eq.${encodeURIComponent(villaId)}`).catch(() => []);
  const phone = String(priv?.owner_phone ?? "").replace(/[^\d+]/g, "");
  if (phone.replace(/\D/g, "").length < 8) return null;
  return { phone: phone.startsWith("+") ? phone : `+${phone}`, name: String(priv?.owner_name ?? "").trim(), title: String(pub?.title ?? villaId) };
}

/**
 * Who asks the owner (owner, 27.09.2026): the LISTING side, not the client's broker. The villa's own
 * Rental Listings card, where its listing agent (Yudi) already talks to the owner, from his line, in the
 * same conversation, like the weekly availability check: the owner sees a familiar contact, not a
 * stranger. The card is the one the site links to the villa (listing_crm_link, which keeps its id after
 * the move from amoCRM); else the owner's card found by phone; else a new card in the listing agent's
 * name (the code's middle part: R-YUD-053 → Yudi).
 */
async function villaCard(villaId: string, owner: { phone: string; name: string; title: string }): Promise<{ lead: string; agent: string | null } | null> {
  const users = await amoFetch<{ _embedded?: { users?: Array<{ id: number; name: string }> } }>(`/api/v4/users?limit=250`);
  const nameOf = (id: number | null | undefined) => users?._embedded?.users?.find((u) => u.id === id)?.name.split(/\s+/)[0] ?? null;
  const open = async (id: number | string) => {
    const lead = await amoFetch<{ id: number; pipeline_id: number; status_id: number; responsible_user_id?: number }>(`/api/v4/leads/${id}`).catch(() => null);
    return lead && lead.pipeline_id === LISTINGS_PIPELINE_ID && lead.status_id !== 143 ? { lead: String(lead.id), agent: nameOf(lead.responsible_user_id) } : null;
  };
  const links = await siteGet<Array<{ amo_lead_id: number }>>(`listing_crm_link?select=amo_lead_id&property_id=eq.${encodeURIComponent(villaId)}`).catch(() => []);
  for (const l of links) {
    const hit = await open(l.amo_lead_id);
    if (hit) return hit;
  }
  const digits = owner.phone.replace(/\D/g, "");
  const found = await amoFetch<{ _embedded?: { contacts?: Array<{ _embedded?: { leads?: Array<{ id: number }> } }> } }>(`/api/v4/contacts?query=${digits.slice(-9)}&with=leads&limit=5`);
  for (const c of found?._embedded?.contacts ?? []) {
    for (const l of c._embedded?.leads ?? []) {
      const hit = await open(l.id);
      if (hit) return hit;
    }
  }
  // Copilot Amo: no villa card is made in the live CRM; a villa without one is asked by phone.
  if (!OS_MODE) return null;
  const pipe = await amoFetch<{ _embedded?: { statuses?: Array<{ id: number; name: string }> } }>(`/api/v4/leads/pipelines/${LISTINGS_PIPELINE_ID}`);
  const live = pipe?._embedded?.statuses?.find((st) => /^live$/i.test(st.name.trim()))?.id;
  const code = villaId.split("-")[1]?.toLowerCase() ?? "";
  const agent = users?._embedded?.users?.find((u) => code && u.name.toLowerCase().startsWith(code.slice(0, 3)));
  const created = await amoPost<Array<{ id: number }>>(`/api/v4/leads/complex`, [
    {
      name: `${owner.title} (${villaId})`,
      pipeline_id: LISTINGS_PIPELINE_ID,
      ...(live ? { status_id: live } : {}),
      ...(agent ? { responsible_user_id: agent.id } : {}),
      _embedded: { contacts: [{ first_name: owner.name || villaId, custom_fields_values: [{ field_code: "PHONE", values: [{ value: owner.phone, enum_code: "WORK" }] }] }] },
    },
  ]);
  const id = created?.[0]?.id ? String(created[0].id) : null;
  if (id) await import("../amo-sync").then((m) => m.syncLeadStages()).catch(() => undefined);
  return id ? { lead: id, agent: agent ? agent.name.split(/\s+/)[0]! : null } : null;
}

/**
 * How the question to the owner leaves: "approve" (a draft on the villa card, the pilot's default) or
 * "auto" (sent at once, like the weekly check — once the listing agent's line runs in the OS). The answer
 * reaches the site's availability only in "auto": in the pilot the Copilot Amo's weekly check owns it.
 */
async function ownerAskMode(): Promise<"approve" | "auto"> {
  const r = await pool.query(`SELECT value FROM broker_settings WHERE key = 'availability_owner_ask_mode'`).catch(() => null);
  const v = r?.rows?.[0]?.value;
  // Copilot Amo: the listing agent's line already sends the weekly check by itself; the question goes
  // the same way unless the setting says otherwise (owner, 27.09.2026). Copilot OS pilot: approve.
  if (v === "auto" || v === "approve") return v;
  return OS_MODE ? "approve" : "auto";
}

/** The question to the villa owner, in the owner's language, short, the way the listing agent writes. */
async function ownerQuestion(lang: "en" | "id", first: string, names: string, question: string): Promise<string> {
  if (lang === "en") return `Hi${first ? ` ${first}` : ""}, we have a client who'd like to view ${names}. ${question}`;
  const out = await chatCompletion({
    model: HELPER_MODEL,
    label: "os:owner-question-id",
    max_tokens: 200,
    temperature: 0,
    system: `Translate this short WhatsApp question from a Bali real-estate agent to a villa owner into natural, polite Indonesian (the way agents write: "Halo pak/kak …", short, no dashes). Keep numbers and dates. Return the message only.`,
    messages: [{ role: "user", content: `Hi${first ? ` ${first}` : ""}, we have a client who'd like to view ${names}. ${question}` }],
  }).catch(() => null);
  return sanitizeSuggestion(out?.content ?? "").trim() || `Halo${first ? ` ${first}` : ""}, ada klien yang mau lihat ${names}. ${question}`;
}

/** AUTOMATIC: each picked villa's owner is asked from the villa's own card (one message per owner). */
export async function askOwners(askId: string): Promise<{ ok: boolean; error?: string; asked?: string[]; missing?: string[]; mode?: string }> {
  const ask = await askById(askId);
  if (!ask || ask.status !== "open") return { ok: false, error: "This question is already closed." };
  const todo = (ask.villa_ids ?? []).filter((v) => !ask.answers?.[v] && !ask.owners?.[v]);
  if (!(ask.villa_ids ?? []).length) return { ok: false, error: "Pick the villa the client liked." };
  if (!todo.length) return { ok: false, error: "Every villa is already asked or answered." };
  const byPhone = new Map<string, { owner: { phone: string; name: string; title: string }; villas: string[] }>();
  const missing: string[] = [];
  for (const v of todo) {
    const owner = await villaOwner(v);
    if (!owner) { missing.push(v); continue; }
    const key = owner.phone.replace(/\D/g, "");
    const g = byPhone.get(key) ?? { owner, villas: [] };
    g.villas.push(v);
    byPhone.set(key, g);
  }
  const mode = await ownerAskMode();
  const asked: string[] = [];
  const owners: Record<string, OwnerAsk> = {};
  for (const { owner, villas } of byPhone.values()) {
    const card = await villaCard(villas[0]!, owner);
    if (!card) { missing.push(...villas); continue; }
    const ownerTexts = (await pool.query(`SELECT text FROM lead_messages WHERE lead_id = $1 AND sender_type = 'lead' AND text IS NOT NULL ORDER BY sent_at DESC LIMIT 20`, [card.lead])).rows.map((r) => String(r.text));
    const lang = ownerTexts.length ? threadLanguage(ownerTexts) : "en";
    const first = owner.name.split(/\s+/)[0] ?? "";
    const text = await ownerQuestion(lang, first, villas.length > 1 ? villas.join(" and ") : owner.title, ask.question || defaultQuestion(ask.move_in, ask.stay));
    const agent = card.agent ?? ask.broker;
    const s = (
      await pool.query(
        `INSERT INTO pending_suggestions (lead_id, responsible_user, kind, suggestion_text, status, requested_at, autopilot_skipped_reason, autopilot_skipped_at, attachments)
         VALUES ($1,$2,'push',$3,'pending',now(),$4,now(),'[]'::jsonb) RETURNING id`,
        [card.lead, agent, text, `${AVAILABILITY_OWNER_VERDICT}:${ask.id}`],
      )
    ).rows[0];
    for (const v of villas) owners[v] = { lead: card.lead, suggestion: String(s.id), villas };
    asked.push(...villas);
    if (mode === "auto") {
      // The same door every send goes through (autopilot.ts does the same), from the villa card's own line.
      const port = process.env["PORT"] || "3000";
      await fetch(`http://127.0.0.1:${port}/api/public/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestionId: s.id, message: text, attachments: [], brokerId: agent ?? undefined }),
      }).catch((err) => logger.warn({ err, askId }, "availability ask: the owner question did not leave"));
    }
  }
  if (Object.keys(owners).length) await pool.query(`UPDATE os_availability_asks SET owners = owners || $2::jsonb WHERE id = $1`, [ask.id, JSON.stringify(owners)]);
  logger.info({ askId, asked, missing, mode }, "availability ask: questions to the owners from the villa cards");
  if (!asked.length) return { ok: false, error: `No owner number in the Internal data of ${missing.join(", ")}. Call and answer by hand.` };
  return { ok: true, asked, missing, mode };
}

/** Replies already read per question (suggestion id → number of replies): an unclear one is not re-read. */
const readUpto = new Map<string, number>();

/** Owners' replies to our question, and a reminder when nobody has answered in two hours. */
async function passOnce(): Promise<void> {
  await ensureTable();
  const clarifying = (await pool.query(`SELECT * FROM os_availability_asks WHERE status = 'clarifying' AND created_at > now() - interval '7 days'`)).rows as Ask[];
  for (const ask of clarifying) await readClarification(ask).catch((err) => logger.warn({ err, askId: ask.id }, "availability ask: reading the client's answer failed"));
  const open = (await pool.query(`SELECT * FROM os_availability_asks WHERE status = 'open' AND created_at > now() - interval '7 days'`)).rows as Ask[];
  for (const ask of open) await processOpen(ask);
}

/**
 * The moment a message lands on a card (amo-timeline-sync's fast refresh, seconds after WhatsApp
 * delivers it): the questions it can answer are read at once, so the owner's answer becomes the
 * client's reply within seconds, not on the next minute's pass (owner, 27.09: «мгновенно… цепочка
 * нигде не ломалась»). The minute pass stays as the net.
 */
export async function onLeadMessages(leadId: string): Promise<void> {
  await ensureTable();
  const r = await pool.query(
    `SELECT * FROM os_availability_asks
      WHERE status IN ('open','clarifying') AND created_at > now() - interval '7 days'
        AND (client_lead_id = $1 OR EXISTS (SELECT 1 FROM jsonb_each(owners) o WHERE o.value->>'lead' = $1))`,
    [leadId],
  );
  for (const ask of r.rows as Ask[]) {
    if (ask.status === "clarifying") await readClarification(ask).catch((err) => logger.warn({ err, askId: ask.id }, "availability ask: reading the client's answer failed"));
    else await processOpen(ask).catch((err) => logger.warn({ err, askId: ask.id }, "availability ask: reading the owner's answer failed"));
  }
}

async function processOpen(ask: Ask): Promise<void> {
  // Every answer is in but the reply to the client was not written (the writer failed): write it now.
  // The answers live in the record, so nothing is lost between the tries.
  if ((ask.villa_ids ?? []).length && ask.villa_ids.every((v) => ask.answers?.[v])) {
    await resolve(ask).catch((err) => logger.warn({ err, askId: ask.id }, "availability ask: the reply to the client failed — retried next minute"));
    return;
  }
  {
    const seen = new Set<string>();
    for (const o of Object.values(ask.owners ?? {})) {
      if (seen.has(o.suggestion)) continue;
      seen.add(o.suggestion);
      if (o.villas.every((v) => ask.answers?.[v])) continue;
      const sent = (await pool.query(`SELECT created_at FROM sent_messages WHERE suggestion_id = $1 ORDER BY created_at LIMIT 1`, [o.suggestion])).rows[0];
      if (!sent) continue;
      const replies = (
        await pool.query(`SELECT text FROM lead_messages WHERE lead_id = $1 AND sender_type = 'lead' AND text IS NOT NULL AND sent_at > $2 ORDER BY sent_at`, [o.lead, sent.created_at])
      ).rows.map((r) => String(r.text));
      if (!replies.length || readUpto.get(o.suggestion) === replies.length) continue;
      readUpto.set(o.suggestion, replies.length);
      const reply = replies.join("\n").slice(0, 1500);
      const question = ask.question || defaultQuestion(ask.move_in, ask.stay);
      const read = await chatCompletionJSON<{ answered?: boolean; answers?: Record<string, string> }>({
        model: HELPER_MODEL,
        label: "os:owner-answer",
        max_tokens: 300,
        temperature: 0,
        system: `A villa owner in Bali was asked about ${o.villas.join(", ")}: "${question}". Did their reply answer it? "Let me check", "I'll ask my wife", a question back, or an answer about something else is NOT an answer.
If it answered, give the answer per villa in plain English, in their own terms (a date, a price, a yes/no with its condition), as short as possible. Invent nothing.
JSON only: {"answered": true|false, "answers": {"${o.villas[0]}": "…"}}`,
        messages: [{ role: "user", content: reply }],
      }).catch(() => null);
      const unclear = !read?.answered;
      if (!unclear) {
        // The owner's answer is the listing side's: the villa card needs no LIVE reply from its agent.
        await pool.query(`UPDATE pending_suggestions SET status = 'skipped' WHERE lead_id = $1 AND kind = 'live' AND status = 'pending' AND created_at > $2`, [o.lead, sent.created_at]).catch(() => undefined);
        const got: Record<string, VillaAnswer> = {};
        for (const v of o.villas) {
          if (ask.answers?.[v]) continue;
          const text = String(read?.answers?.[v] ?? Object.values(read?.answers ?? {})[0] ?? reply).slice(0, 500);
          const a: VillaAnswer = { text, by: "owner" };
          // An availability answer reaches the site once the OS owns it (mode auto): the same reader and
          // guards as the weekly check, fail-closed.
          if ((await ownerAskMode()) === "auto" && /free|availab|kosong|tersedia/i.test(question)) {
            const av = guardAnswer(await readAnswer(v, question, reply, today()), reply, today());
            if (av.answer !== "unclear") {
              a.availability = av;
              const note = `Owner via the Copilot question of ${today()}: "${av.quote}"`;
              const w = av.answer === "free_now" || av.answer === "free_from"
                ? await writeAvailability(v, av.answer === "free_from" ? av.date : null, note, today(), true).catch(() => null)
                : av.answer === "occupied_until" && av.date
                  ? await writeAvailability(v, av.date, note, today(), true).catch(() => null)
                  : av.answer === "not_for_rent" ? await writeOccupied(v, note, today(), true).catch(() => null) : null;
              if (w) logger.info({ askId: ask.id, villa: v, detail: w.detail }, "availability ask: site availability");
            }
          }
          got[v] = a;
        }
        if (Object.keys(got).length) {
          await pool.query(`UPDATE os_availability_asks SET answers = answers || $2::jsonb WHERE id = $1 AND status = 'open'`, [ask.id, JSON.stringify(got)]);
          const fresh = await askById(ask.id);
          if (fresh && fresh.status === "open" && (fresh.villa_ids ?? []).every((v) => fresh.answers?.[v])) {
            await resolve(fresh).catch((err) => logger.warn({ err, askId: ask.id }, "availability ask: the reply to the client failed — retried next minute"));
            return;
          }
        }
      }
      if (unclear && !ask.reminded_at) {
        await pool.query(`UPDATE os_availability_asks SET reminded_at = now() WHERE id = $1`, [ask.id]);
        void notifyBroker(String(ask.broker ?? "").toLowerCase() || null, `Owner replied`, `Not a clear answer: "${reply.slice(0, 90)}" — write what they said on the client's card`, `/m?lead=${encodeURIComponent(ask.client_lead_id)}`).catch(() => 0);
      }
    }
    await nudgeLadder(ask);
  }
}

/**
 * The safety net (owner, 27.09.2026: «если какого-то числа времени мы не получили ответа… информировать
 * брокера… можем вообще потерять клиента»). An automatic question that did not leave is sent again; then
 * the broker is told at 30 minutes and at 2 hours: nobody asked the owner yet → "the client is waiting";
 * the owner was asked and is silent → "call them", with their name and number.
 */
async function nudgeLadder(ask: Ask): Promise<void> {
  const fresh = await askById(ask.id);
  if (!fresh || fresh.status !== "open") return;
  const owners = Object.values(fresh.owners ?? {});
  if ((await ownerAskMode()) === "auto") {
    for (const o of owners) {
      const s = (await pool.query(`SELECT status, created_at, suggestion_text, responsible_user FROM pending_suggestions WHERE id = $1`, [o.suggestion])).rows[0];
      if (s?.status === "pending" && Date.now() - new Date(s.created_at).getTime() > RESEND_AFTER_MS) {
        const port = process.env["PORT"] || "3000";
        await fetch(`http://127.0.0.1:${port}/api/public/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ suggestionId: o.suggestion, message: s.suggestion_text, attachments: [], brokerId: s.responsible_user ?? undefined }),
        }).catch(() => undefined);
        logger.warn({ askId: ask.id, suggestion: o.suggestion }, "availability ask: the owner question had not left — sent again");
      }
    }
  }
  const waiting = (fresh.villa_ids ?? []).filter((v) => !fresh.answers?.[v]);
  if (!waiting.length) return;
  // The clock: from the owner question leaving, else from the question being opened.
  let since = new Date(fresh.created_at).getTime();
  let asked = false;
  for (const v of waiting) {
    const o = fresh.owners?.[v];
    if (!o) continue;
    const sent = (await pool.query(`SELECT created_at FROM sent_messages WHERE suggestion_id = $1 ORDER BY created_at LIMIT 1`, [o.suggestion])).rows[0];
    if (sent) { asked = true; since = Math.max(since, new Date(sent.created_at).getTime()); }
  }
  const step = fresh.nudges ?? 0;
  if (step >= NUDGE_MARKS_MS.length || Date.now() - since < NUDGE_MARKS_MS[step]!) return;
  const claimed = await pool.query(`UPDATE os_availability_asks SET nudges = $2 WHERE id = $1 AND nudges = $3 RETURNING id`, [fresh.id, step + 1, step]);
  if (!claimed.rows.length) return;
  const after = step === 0 ? "30 min" : "2 h";
  const title = (await fetchLeadTitle(fresh.client_lead_id).catch(() => "")) || "Client";
  let body: string;
  if (asked) {
    const who = await villaOwner(waiting[0]!).catch(() => null);
    body = `No answer from the owner of ${waiting.join(", ")} in ${after}. Call${who ? ` ${who.name || "them"} ${who.phone}` : " them"} and write what they said on ${title}'s card.`;
  } else {
    body = `${title} has been waiting ${after}: ${fresh.question || "an answer from the owner"} Ask the owner or call.`;
  }
  void notifyBroker(String(fresh.broker ?? "").toLowerCase() || null, `⏳ ${title} is still waiting`, body, `/m?lead=${encodeURIComponent(fresh.client_lead_id)}`).catch(() => 0);
  logger.info({ askId: fresh.id, step: step + 1, asked }, "availability ask: the broker is reminded");
}

export function startAvailabilityAskPass(): void {
  setInterval(() => void passOnce().catch((err) => logger.warn({ err }, "availability ask pass failed")), 60_000);
}
