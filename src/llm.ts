import { z } from "zod";

export const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;

export class LLMValidationError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = "LLMValidationError";
  }
}

export type GenerateTextOpts = {
  maxTokens?: number;
  temperature?: number;
};

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type AiBindingLike = {
  run: (model: string, inputs: unknown) => Promise<unknown>;
};

function asResponseString(result: unknown): string {
  if (
    result &&
    typeof result === "object" &&
    "response" in result &&
    typeof (result as { response: unknown }).response === "string"
  ) {
    return (result as { response: string }).response;
  }
  throw new Error(
    `LLM returned no .response field: ${JSON.stringify(result).slice(0, 200)}`,
  );
}

export async function generateText(
  ai: AiBindingLike,
  system: string,
  user: string,
  opts: GenerateTextOpts = {},
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const result = await ai.run(MODEL_ID, {
    messages,
    max_tokens: opts.maxTokens ?? 512,
    temperature: opts.temperature ?? 0.7,
  });
  return asResponseString(result);
}

/**
 * Streamed text generation. Calls `onToken(chunk)` for each chunk of tokens
 * as they arrive. Returns the accumulated full text.
 *
 * Degrades gracefully: if the AI binding returns a plain `{response: "..."}`
 * object (non-streaming), calls `onToken` once with the full response.
 * On mid-stream failure, returns whatever was accumulated so callers can
 * still persist a partial log entry.
 */
export async function generateStreamedText(
  ai: AiBindingLike,
  system: string,
  user: string,
  onToken: (chunk: string) => void,
  opts: GenerateTextOpts = {},
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  let accumulated = "";
  try {
    const result = await ai.run(MODEL_ID, {
      messages,
      max_tokens: opts.maxTokens ?? 512,
      temperature: opts.temperature ?? 0.7,
      stream: true,
    });

    // Plain object response (not actually streaming) — emit all as one chunk
    if (
      result &&
      typeof result === "object" &&
      "response" in result &&
      typeof (result as { response: unknown }).response === "string"
    ) {
      const text = (result as { response: string }).response;
      onToken(text);
      return text;
    }

    // ReadableStream of SSE-style bytes: `data: {"response":"..."}\n\n`
    if (result && typeof (result as ReadableStream).getReader === "function") {
      const reader = (result as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Split on newline; each SSE event is separated by a blank line
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed === "data: [DONE]") return accumulated;
          if (trimmed.startsWith("data:")) {
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const parsed = JSON.parse(payload) as { response?: string };
              if (typeof parsed.response === "string" && parsed.response.length > 0) {
                accumulated += parsed.response;
                onToken(parsed.response);
              }
            } catch {
              // Malformed chunk — ignore and continue
            }
          }
        }
      }
      // Drain any trailing buffered payload
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data:")) {
        const payload = trimmed.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try {
            const parsed = JSON.parse(payload) as { response?: string };
            if (typeof parsed.response === "string" && parsed.response.length > 0) {
              accumulated += parsed.response;
              onToken(parsed.response);
            }
          } catch {}
        }
      }
      return accumulated;
    }

    return accumulated;
  } catch {
    // Partial stream: return whatever we've accumulated so far.
    return accumulated;
  }
}

export async function generateStructured<T>(
  ai: AiBindingLike,
  system: string,
  user: string,
  zodSchema: z.ZodType<T>,
  jsonSchema: object,
): Promise<T> {
  const baseMessages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const inputs = {
    messages: baseMessages,
    max_tokens: 512,
    temperature: 0.7,
    response_format: {
      type: "json_schema" as const,
      json_schema: jsonSchema,
    },
  };

  let lastRaw = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const messages =
      attempt === 0
        ? baseMessages
        : [
            ...baseMessages,
            {
              role: "system" as const,
              content:
                "IMPORTANT: respond with VALID JSON matching the schema. No prose.",
            },
          ];
    const result = await ai.run(MODEL_ID, { ...inputs, messages });
    lastRaw = asResponseString(result);

    let parsed: unknown;
    try {
      parsed = JSON.parse(lastRaw);
    } catch {
      continue;
    }

    const validation = zodSchema.safeParse(parsed);
    if (validation.success) return validation.data;
  }

  throw new LLMValidationError(
    `LLM produced invalid JSON / failed schema after 2 attempts`,
    lastRaw,
  );
}
