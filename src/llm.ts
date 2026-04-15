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
