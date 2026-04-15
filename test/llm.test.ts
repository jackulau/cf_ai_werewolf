import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  generateStructured,
  generateText,
  LLMValidationError,
  MODEL_ID,
} from "../src/llm";

function makeAi(impl: (model: string, inputs: unknown) => Promise<unknown>) {
  return { run: vi.fn(impl) };
}

describe("generateText", () => {
  it("calls AI.run with model id and messages", async () => {
    const ai = makeAi(async () => ({ response: "hi" }));
    await generateText(ai, "you are X", "say hi");
    expect(ai.run).toHaveBeenCalledOnce();
    const [model, inputs] = ai.run.mock.calls[0];
    expect(model).toBe(MODEL_ID);
    expect((inputs as { messages: { role: string; content: string }[] }).messages).toEqual([
      { role: "system", content: "you are X" },
      { role: "user", content: "say hi" },
    ]);
  });

  it("returns the response field", async () => {
    const ai = makeAi(async () => ({ response: "hello world" }));
    expect(await generateText(ai, "s", "u")).toBe("hello world");
  });

  it("throws when response field is missing", async () => {
    const ai = makeAi(async () => ({ wrong: 1 }));
    await expect(generateText(ai, "s", "u")).rejects.toThrow(/no .response field/);
  });
});

describe("generateStructured", () => {
  const schema = z.object({ target: z.string().min(1), reasoning: z.string() });
  const jsonSchema = {
    type: "object",
    properties: {
      target: { type: "string" },
      reasoning: { type: "string" },
    },
    required: ["target", "reasoning"],
  };

  it("parses valid JSON returned from LLM", async () => {
    const ai = makeAi(async () => ({
      response: JSON.stringify({ target: "alice", reasoning: "she lied" }),
    }));
    const out = await generateStructured(ai, "s", "u", schema, jsonSchema);
    expect(out).toEqual({ target: "alice", reasoning: "she lied" });
  });

  it("uses response_format.json_schema in the call", async () => {
    const ai = makeAi(async () => ({
      response: JSON.stringify({ target: "bob", reasoning: "x" }),
    }));
    await generateStructured(ai, "s", "u", schema, jsonSchema);
    const inputs = ai.run.mock.calls[0][1] as {
      response_format: { type: string; json_schema: unknown };
    };
    expect(inputs.response_format.type).toBe("json_schema");
    expect(inputs.response_format.json_schema).toEqual(jsonSchema);
  });

  it("retries once on invalid JSON, succeeds on second try", async () => {
    let call = 0;
    const ai = makeAi(async () => {
      call++;
      if (call === 1) return { response: "not json at all" };
      return { response: JSON.stringify({ target: "x", reasoning: "y" }) };
    });
    const out = await generateStructured(ai, "s", "u", schema, jsonSchema);
    expect(out.target).toBe("x");
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("throws LLMValidationError after second invalid response", async () => {
    const ai = makeAi(async () => ({ response: "still not json" }));
    await expect(
      generateStructured(ai, "s", "u", schema, jsonSchema),
    ).rejects.toBeInstanceOf(LLMValidationError);
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("throws when JSON parses but Zod rejects (target missing)", async () => {
    const ai = makeAi(async () => ({ response: JSON.stringify({ reasoning: "no target" }) }));
    await expect(
      generateStructured(ai, "s", "u", schema, jsonSchema),
    ).rejects.toBeInstanceOf(LLMValidationError);
  });

  it("throws on AI binding error", async () => {
    const ai = makeAi(async () => {
      throw new Error("AI down");
    });
    await expect(
      generateStructured(ai, "s", "u", schema, jsonSchema),
    ).rejects.toThrow("AI down");
  });

  it("Zod rejects target not in enum (hallucinated player name)", async () => {
    const enumSchema = z.object({
      target: z.enum(["alice", "bob"]),
      reasoning: z.string(),
    });
    const ai = makeAi(async () => ({
      response: JSON.stringify({ target: "charlie", reasoning: "made up" }),
    }));
    await expect(
      generateStructured(ai, "s", "u", enumSchema, jsonSchema),
    ).rejects.toBeInstanceOf(LLMValidationError);
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("LLMValidationError captures raw response text", async () => {
    const ai = makeAi(async () => ({ response: "raw garbage 123" }));
    try {
      await generateStructured(ai, "s", "u", schema, jsonSchema);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LLMValidationError);
      expect((e as LLMValidationError).raw).toBe("raw garbage 123");
    }
  });
});
