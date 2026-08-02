import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";

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

export async function chatCompletion(opts: ChatCompletionOpts): Promise<ChatCompletionResult> {
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
    system: systemParam,
    messages: opts.messages as Anthropic.MessageParam[],
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

  const response = await client.messages.create(params);

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
    logger.info(
      {
        model: opts.model,
        inTok: u.input_tokens ?? 0,
        outTok: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
      "ai usage",
    );
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
