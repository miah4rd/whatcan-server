import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import { pool } from "@workspace/db";
import { recordAiFailure, recordAiSuccess } from "./ai-health";

let _client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!_client) {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

/**
 * One place to change the models, instead of the twenty hardcoded literals this
 * used to be. WRITER is text a real client will read (Sonnet — Opus was
 * considered and deliberately not taken, the owner's call). HELPER is the
 * mechanical background work.
 */
export const WRITER_MODEL = "claude-sonnet-5";
// The mechanical background calls (classify a stage, distil a lesson, parse an
// instruction, spot a task) run on Haiku — several times cheaper per call, and
// these fire far more often than a client ever gets written to. The owner asked
// for the API bill to come down; the client-facing text stays on Sonnet.
export const HELPER_MODEL = "claude-haiku-4-5-20251001";

export type ChatTextBlock = { type: "text"; text: string };
export type ChatImageBlock = { type: "image"; source: { type: "base64"; media_type: string; data: string } };
// content is a plain string OR a mix of text/image blocks (multimodal — lets the
// broker paste a screenshot of the amoCRM chat as ground-truth context).
export type ChatMessage = { role: "user" | "assistant"; content: string | Array<ChatTextBlock | ChatImageBlock> };

interface ChatCompletionOpts {
  model: string;
  system: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  /**
   * The part of the system prompt that is IDENTICAL on every call — the rental
   * rulebook and the knowledge base, ~8,900 tokens of it. Sent as its own
   * cached block so we pay full price for it once and a tenth of that on every
   * later call, instead of buying the same 9,000 tokens again for every single
   * draft. Anything that varies per lead (stage, the broker's own lessons)
   * belongs in `system`, AFTER this — caching is a prefix match, so one
   * changing character early throws away everything behind it.
   */
  cachePrefix?: string;
  /** What this call was for — so the daily bill can be read by purpose, not
   * just as one number. Free text; unlabelled calls show up as "other". */
  label?: string;
}

interface ChatCompletionResult {
  content: string;
}

/**
 * Wrapper around Anthropic Messages API with an OpenAI-like interface.
 * Handles system prompt extraction, response parsing, and model selection.
 */
// Newer models (claude-sonnet-5 and up) reject the `temperature` param with a
// 400 "temperature is deprecated for this model". Callers still pass
// temperature: 0 for deterministic tasks, so strip it centrally for these
// models rather than having every call site 400. Match by family prefix so
// future sonnet/opus 5+ ids are covered without another code change.
function modelRejectsTemperature(model: string): boolean {
  return /claude-(sonnet|opus|fable)-[5-9]/.test(model);
}


/**
 * Price per million tokens, from Anthropic's published rates. Kept here so the
 * daily bill is computed once, at the point we already know the model, rather
 * than reconstructed later from guesses about which call used what.
 * The cache-write rate is the 1-hour one (2x base) — that is the TTL we send.
 */
const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

function callCostUsd(
  model: string,
  u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
): number {
  const p = PRICE_PER_MTOK[model] ?? PRICE_PER_MTOK["claude-sonnet-5"]!;
  const m = 1_000_000;
  return (
    ((u.input_tokens ?? 0) * p.in +
      (u.cache_read_input_tokens ?? 0) * p.in * 0.1 +
      (u.cache_creation_input_tokens ?? 0) * p.in * 2 +
      (u.output_tokens ?? 0) * p.out) /
    m
  );
}

/**
 * A LONE surrogate — half of an emoji, which is how some WhatsApp text reaches
 * us through amoCRM — cannot be encoded as JSON. The SDK then sends an invalid
 * body and the entire call fails with 400 "invalid high surrogate in string",
 * so the lead gets NO draft at all while the log shows only an API error
 * (lead 23258097, 2026-08-18). A complete surrogate PAIR is an ordinary emoji
 * and must survive untouched — only the orphaned halves go.
 */
export function stripLoneSurrogates(s: string): string {
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, "$1");
}

/** Same cleanup, applied through the shapes a request body can take. */
function sanitize<T>(value: T): T {
  if (typeof value === "string") return stripLoneSurrogates(value) as unknown as T;
  if (Array.isArray(value)) return value.map(sanitize) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitize(v);
    return out as unknown as T;
  }
  return value;
}

/**
 * The stop tap on every paid call, flippable without a deploy.
 *
 * There is exactly ONE credential here — ANTHROPIC_API_KEY — so nothing ever
 * "switches" to another wallet; this server has always spent the org's API
 * credits and only those. What was missing was a way to make it STOP on
 * purpose: when the balance is gone the API refuses and no tokens are spent,
 * but the owner had no switch for the case of wanting it to stop BEFORE that.
 * Set broker_settings key `ai_enabled` to "off" and every model call refuses
 * immediately; set it back to "on" (or delete the row) to resume.
 */
let aiEnabledCache: { at: number; on: boolean } | null = null;
const AI_ENABLED_TTL_MS = 30_000;

export async function aiEnabled(): Promise<boolean> {
  if (aiEnabledCache && Date.now() - aiEnabledCache.at < AI_ENABLED_TTL_MS) return aiEnabledCache.on;
  let on = true;
  try {
    const r = await pool.query("SELECT value FROM broker_settings WHERE key = 'ai_enabled' LIMIT 1");
    const v = String(r.rows?.[0]?.value ?? "").trim().toLowerCase();
    if (v === "off" || v === "false" || v === "0") on = false;
  } catch {
    // Unreadable setting must not silently disable the product.
  }
  aiEnabledCache = { at: Date.now(), on };
  return on;
}

/**
 * The ceiling. Nothing here is allowed to spend without a limit.
 *
 * The account emptied overnight because two passes rewrote the same drafts once
 * a minute and nothing was watching the total — the first anyone knew was a
 * dead product in the morning (2026-08-21). A specific loop is now fixed, but
 * the class of failure is "some pass calls in a circle", and the only defence
 * that survives the NEXT one is a number the code refuses to cross.
 *
 * Rolling 24 hours, not a calendar day: the timezone in this database is not
 * what it claims, and a cap that can be reset by a boundary nobody agrees on is
 * not a cap. Default 25 USD, overridable with broker_settings key
 * `ai_daily_cap_usd`. Normal days run 2–5 USD, so 25 is far above real work and
 * far below a runaway.
 */
const DEFAULT_DAILY_CAP_USD = 25;
const CAP_TTL_MS = 60_000;
let capCache: { at: number; spent: number; cap: number } | null = null;

export class AiSpendCapError extends Error {
  constructor(spent: number, cap: number) {
    super(`AI daily spend cap reached: $${spent.toFixed(2)} of $${cap.toFixed(2)} in the last 24h`);
    this.name = "AiSpendCapError";
  }
}

async function readDailyCapUsd(): Promise<number> {
  try {
    const r = await pool.query("SELECT value FROM broker_settings WHERE key = 'ai_daily_cap_usd' LIMIT 1");
    const v = Number(String(r.rows?.[0]?.value ?? "").trim());
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* fall through to the default */ }
  return DEFAULT_DAILY_CAP_USD;
}

async function assertUnderSpendCap(): Promise<void> {
  if (capCache && Date.now() - capCache.at < CAP_TTL_MS) {
    if (capCache.spent >= capCache.cap) throw new AiSpendCapError(capCache.spent, capCache.cap);
    return;
  }
  let spent = 0;
  let cap = DEFAULT_DAILY_CAP_USD;
  try {
    cap = await readDailyCapUsd();
    const r = await pool.query(
      "SELECT coalesce(sum(cost_usd), 0)::float8 AS spent FROM ai_usage WHERE created_at > now() - interval '24 hours'",
    );
    spent = Number(r.rows?.[0]?.spent ?? 0);
  } catch {
    // An unreadable ledger must not take the product down; a real runaway will
    // still be caught on the next tick when the query works.
    capCache = { at: Date.now(), spent: 0, cap };
    return;
  }
  capCache = { at: Date.now(), spent, cap };
  if (spent >= cap) {
    logger.error({ spent: Number(spent.toFixed(2)), cap }, "AI SPEND CAP REACHED — refusing every model call until spend falls below the cap");
    throw new AiSpendCapError(spent, cap);
  }
}

export class AiDisabledError extends Error {
  constructor() {
    super("AI calls are switched off (broker_settings.ai_enabled = off)");
    this.name = "AiDisabledError";
  }
}

export async function chatCompletion(opts: ChatCompletionOpts): Promise<ChatCompletionResult> {
  if (!(await aiEnabled())) {
    logger.warn({ model: opts.model, label: opts.label }, "model call refused — ai_enabled is off");
    throw new AiDisabledError();
  }
  await assertUnderSpendCap();
  const client = getAnthropic();

  // A prefix shorter than ~1000 tokens is silently NOT cached (Anthropic's
  // minimum) while still costing the write premium, so only split the system
  // prompt when the stable half is genuinely large.
  const usePrefix = (opts.cachePrefix ?? "").length > 4000;
  // A one-hour cache, not the default five minutes: leads arrive minutes to
  // hours apart, and at five minutes almost every draft would rewrite the cache
  // instead of reading it. Verified against the live API — the response comes
  // back with ephemeral_1h_input_tokens filled in, so the hour is real.
  // The cast is only because the pinned SDK's types predate the ttl field; the
  // wire format is correct and the API confirms it.
  const systemParam = (usePrefix
    ? [
        { type: "text", text: opts.cachePrefix!, cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: opts.system },
      ]
    : opts.system) as Anthropic.MessageCreateParams["system"];

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: opts.model,
    system: sanitize(systemParam),
    messages: sanitize(opts.messages as Anthropic.MessageParam[]),
    max_tokens: opts.max_tokens ?? 400,
    // Some models (e.g. claude-sonnet-5) use extended thinking by default. For
    // these short, latency-sensitive chat-suggestion calls we want the direct
    // answer, not a reasoning trace — without this, thinking can consume the
    // entire max_tokens budget on complex prompts and leave zero tokens for
    // the actual text, producing a response with no text block at all.
    thinking: { type: "disabled" },
  };
  if (opts.temperature !== undefined && !modelRejectsTemperature(opts.model)) {
    params.temperature = opts.temperature;
  }

  // Every model call in this server goes through this one line, which makes it
  // the only place that can answer "is the model answering at all". An outage
  // used to be invisible: calls threw, callers logged their own error, and
  // nothing anywhere added them up (2026-08-20 — two hours dark, 38 leads with
  // no draft, nobody told).
  let response: Anthropic.Message;
  try {
    response = await client.messages.create(params);
  } catch (err) {
    recordAiFailure(err);
    throw err;
  }
  recordAiSuccess();

  // Nothing recorded what any of this cost, so "the tokens are burning fast"
  // could only ever be answered by guesswork. Every call now says what it spent
  // and how much of it came from cache.
  try {
    const u = response.usage as unknown as {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    const cost = callCostUsd(opts.model, u);
    logger.info(
      {
        model: opts.model,
        label: opts.label ?? "other",
        inTok: u.input_tokens ?? 0,
        outTok: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        costUsd: Number(cost.toFixed(6)),
      },
      "ai usage",
    );
    // Fire and forget: the bill must never be the reason a lead waits.
    void pool
      .query(
        `INSERT INTO ai_usage (model, label, in_tokens, out_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          opts.model,
          opts.label ?? "other",
          u.input_tokens ?? 0,
          u.output_tokens ?? 0,
          u.cache_read_input_tokens ?? 0,
          u.cache_creation_input_tokens ?? 0,
          cost.toFixed(6),
        ],
      )
      .catch(() => {});
  } catch { /* accounting must never break a reply */ }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  return { content: text };
}

/**
 * Call AI and parse JSON response.
 * Anthropic doesn't have response_format: json_object,
 * so we add JSON instructions to the prompt and parse with fallback.
 */
export async function chatCompletionJSON<T = Record<string, unknown>>(
  opts: ChatCompletionOpts,
): Promise<T> {
  const jsonPrompt = `${opts.system}

IMPORTANT: Respond with valid JSON only. No markdown, no code fences, no extra text. Just the raw JSON object.`;
  // Appending to `system` and not to `cachePrefix` is deliberate: the prefix has
  // to stay byte-identical between the JSON and non-JSON callers or neither of
  // them ever gets a cache hit.

  const result = await chatCompletion({
    ...opts,
    system: jsonPrompt,
  });

  try {
    return JSON.parse(result.content) as T;
  } catch {
    // Try to extract JSON from the response if it contains extra text
    const match = result.content.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]) as T;
    }
    // No closing brace at all — the reply ran into max_tokens mid-object. This
    // is not a broken model, it's a truncated one, and throwing here threw away
    // a perfectly good answer: the property matcher explained its reasoning
    // before the JSON, ran out of tokens, and the caller's catch turned three
    // chosen villas into an empty shortlist. Salvage what did arrive.
    const repaired = repairTruncatedJson(result.content);
    if (repaired) {
      logger.warn(
        { preview: result.content.slice(0, 120) },
        "chatCompletionJSON: response was truncated, parsed the salvaged object",
      );
      return repaired as T;
    }
    throw new Error(`Failed to parse JSON from AI response: ${result.content.slice(0, 200)}`);
  }
}

/**
 * Closes a JSON object that was cut off mid-flight: drops an unterminated
 * trailing string or dangling comma, then closes every bracket still open.
 * Returns null if there is nothing recoverable.
 */
function repairTruncatedJson(raw: string): unknown | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastSafe = -1; // end of the last complete value, for trimming a partial one

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        lastSafe = i;
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      stack.pop();
      lastSafe = i;
    } else if (ch === "," || /\d/.test(ch) || ch === "e" || ch === "l") lastSafe = i;
  }

  // Cut off any half-written value, then close what is still open.
  let body = raw.slice(start, lastSafe + 1).replace(/,\s*$/, "");
  if (body.length === 0) return null;
  body += stack.reverse().join("");

  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
