import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("scaffold", () => {
  it("env exposes all required bindings", () => {
    expect(env.AI).toBeTruthy();
    expect(env.GAME_DO).toBeTruthy();
    expect(env.GAME_WORKFLOW).toBeTruthy();
    expect(env.ASSETS).toBeTruthy();
  });
});
