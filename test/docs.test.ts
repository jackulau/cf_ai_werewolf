import { describe, it, expect } from "vitest";
// @ts-expect-error vite ?raw imports return strings
import README from "../README.md?raw";
// @ts-expect-error vite ?raw imports return strings
import PROMPTS from "../PROMPTS.md?raw";

describe("README.md", () => {
  it("mentions all 4 required components (LLM, Workflow, DO, chat)", () => {
    const lower = README.toLowerCase();
    expect(lower).toContain("llama");
    expect(lower).toContain("workflow");
    expect(lower).toContain("durable object");
    expect(lower).toMatch(/websocket|chat/);
  });

  it("has Local development section with npm install", () => {
    expect(README).toMatch(/local development/i);
    expect(README).toContain("npm install");
    expect(README).toContain("npm run dev");
  });

  it("explains why Workers Assets over Pages", () => {
    expect(README.toLowerCase()).toMatch(/workers assets|workers-assets/);
    expect(README.toLowerCase()).toContain("pages functions");
  });

  it("has Deployment section", () => {
    expect(README).toMatch(/deployment/i);
    expect(README).toContain("wrangler deploy");
  });

  it("documents game rules and roles", () => {
    expect(README).toMatch(/werewolf/i);
    expect(README).toMatch(/seer/i);
    expect(README).toMatch(/doctor/i);
    expect(README).toMatch(/villager/i);
  });
});

describe("PROMPTS.md", () => {
  it("exists and is non-trivial", () => {
    expect(PROMPTS.length).toBeGreaterThan(2000);
  });

  it("includes the in-game LLM prompts section", () => {
    expect(PROMPTS).toMatch(/in-game LLM prompts/i);
    expect(PROMPTS).toMatch(/persona system prompt/i);
    expect(PROMPTS).toMatch(/json schema/i);
  });

  it("documents kill, save, investigate, day-talk, vote prompts", () => {
    const lower = PROMPTS.toLowerCase();
    expect(lower).toContain("kill");
    expect(lower).toContain("save");
    expect(lower).toContain("investigate");
    expect(lower).toContain("day talk");
    expect(lower).toContain("vote");
  });

  it("includes the dev-side prompts section with /spec invocation", () => {
    expect(PROMPTS).toMatch(/developer prompts/i);
    expect(PROMPTS).toMatch(/spec/);
    expect(PROMPTS).toMatch(/execute/);
  });
});

describe("repo structure", () => {
  it("README + PROMPTS imported successfully", () => {
    expect(typeof README).toBe("string");
    expect(typeof PROMPTS).toBe("string");
    expect(README.length).toBeGreaterThan(0);
    expect(PROMPTS.length).toBeGreaterThan(0);
  });
});
