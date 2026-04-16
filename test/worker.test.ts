import { SELF, env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

// All worker.test cases avoid actually starting workflows (they mock AI for safety).
function silenceAi() {
  vi.spyOn(env.AI, "run").mockImplementation(async (_m, inputs: any) => {
    if (inputs?.response_format?.json_schema) {
      const enumValues = inputs.response_format.json_schema.properties?.target?.enum ?? [];
      return { response: JSON.stringify({ target: enumValues[0] ?? "x", reasoning: "ok" }) } as never;
    }
    return { response: "..." } as never;
  });
}

describe("/api/health", () => {
  it("returns 200", async () => {
    const res = await SELF.fetch("https://app/api/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("POST /api/games", () => {
  it("creates a game and returns role", async () => {
    silenceAi();
    const res = await SELF.fetch("https://app/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ humanName: "Alice" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { gameId: string; humanPlayerId: string; role: string };
    expect(body.gameId).toMatch(/^g_/);
    expect(body.humanPlayerId).toBe("human");
    expect(["villager", "seer", "doctor", "werewolf"]).toContain(body.role);
  });

  it("rejects empty humanName with 400", async () => {
    const res = await SELF.fetch("https://app/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ humanName: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON body with 400", async () => {
    const res = await SELF.fetch("https://app/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects GET with 405", async () => {
    const res = await SELF.fetch("https://app/api/games", { method: "GET" });
    expect(res.status).toBe(405);
  });
});

describe("GET /api/games/:gameId", () => {
  it("returns state for a created game", async () => {
    silenceAi();
    const create = await SELF.fetch("https://app/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ humanName: "Bob" }),
    });
    const { gameId } = (await create.json()) as { gameId: string };
    const res = await SELF.fetch(`https://app/api/games/${gameId}`);
    expect(res.status).toBe(200);
    const state = (await res.json()) as { players: { id: string }[] };
    expect(state.players.length).toBe(7);
  });

  it("returns 404 for unknown gameId", async () => {
    const res = await SELF.fetch("https://app/api/games/unknown-game-id-xxx");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/games/:gameId/me", () => {
  it("returns player view for the human", async () => {
    silenceAi();
    const create = await SELF.fetch("https://app/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ humanName: "Carol" }),
    });
    const { gameId, role } = (await create.json()) as { gameId: string; role: string };
    const res = await SELF.fetch(`https://app/api/games/${gameId}/me?playerId=human`);
    expect(res.status).toBe(200);
    const view = (await res.json()) as { role: string };
    expect(view.role).toBe(role);
  });

  it("requires playerId query param", async () => {
    silenceAi();
    const create = await SELF.fetch("https://app/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ humanName: "D" }),
    });
    const { gameId } = (await create.json()) as { gameId: string };
    const res = await SELF.fetch(`https://app/api/games/${gameId}/me`);
    expect(res.status).toBe(400);
  });
});

describe("static asset fallback", () => {
  it("GET / returns the index page", async () => {
    const res = await SELF.fetch("https://app/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<title>");
    expect(body).toContain("Moonlit Village");
  });

  it("GET /unknown-path falls back to index.html (SPA)", async () => {
    const res = await SELF.fetch("https://app/some-spa-route/abc");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<title>");
  });
});
