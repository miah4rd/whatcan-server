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

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: opts.model,
    system: opts.system,
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
