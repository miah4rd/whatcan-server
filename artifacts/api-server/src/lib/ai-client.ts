import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!_client) {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

export type ChatMessage = { role: "user" | "assistant"; content: string };

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
export async function chatCompletion(opts: ChatCompletionOpts): Promise<ChatCompletionResult> {
  const client = getAnthropic();

  const response = await client.messages.create({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    max_tokens: opts.max_tokens ?? 400,
    temperature: opts.temperature,
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!text) {
    // eslint-disable-next-line no-console
    console.error("DEBUG_EMPTY_AI_RESPONSE", JSON.stringify({
      model: opts.model,
      stop_reason: response.stop_reason,
      blockTypes: response.content.map((b) => b.type),
      usage: response.usage,
      systemLen: opts.system.length,
      messagesLens: opts.messages.map((m) => m.content.length),
    }));
  }

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
    throw new Error(`Failed to parse JSON from AI response: ${result.content.slice(0, 200)}`);
  }
}
