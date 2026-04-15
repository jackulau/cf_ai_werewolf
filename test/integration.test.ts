/**
 * End-to-end integration: full game played from POST /api/games to game-over,
 * with a deterministic AI mock. Verifies all 4 required components work together.
 */
import { SELF, env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let counter = 0;
function newName() {
  counter++;
  return `Tester${counter}-${Date.now()}`;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

function mockAi(byPattern: (system: string, user: string, jsonSchema: unknown) => unknown) {
  return vi.spyOn(env.AI, "run").mockImplementation(async (_m: string, inputs: unknown) => {
    const i = inputs as {
      messages: { content: string }[];
      response_format?: { json_schema?: unknown };
    };
    const sys = i.messages[0]?.content ?? "";
    const usr = i.messages[i.messages.length - 1]?.content ?? "";
    const out = byPattern(sys, usr, i.response_format?.json_schema);
    const response = typeof out === "string" ? out : JSON.stringify(out);
    return { response } as unknown as never;
  });
}

async function startGame(humanName: string) {
  const res = await SELF.fetch("https://app/api/games", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ humanName }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { gameId: string; humanPlayerId: string; role: string };
}

async function getState(gameId: string) {
  const res = await SELF.fetch(`https://app/api/games/${gameId}`);
  return (await res.json()) as {
    phase: string;
    turn: number;
    winner: string | null;
    players: { id: string; name: string; alive: boolean; role?: string }[];
    log: { content: string; type: string }[];
  };
}

describe("Integration: full game end-to-end", () => {
  it(
    "completes a game from POST to game-over with all 4 components engaged",
    async () => {
      // Mock AI: always pick first enum target; speak with traceable string
      let speakCount = 0;
      mockAi((_s, _u, jsonSchema) => {
        if (jsonSchema && typeof jsonSchema === "object") {
          const enumValues = (jsonSchema as { properties: { target: { enum: string[] } } })
            .properties?.target?.enum ?? [];
          return { target: enumValues[0] ?? "x", reasoning: "scripted" };
        }
        speakCount++;
        return `IT_TAG_${speakCount}: I have my suspicions about someone here.`;
      });

      const created = await startGame(newName());
      const intro = await introspectWorkflowInstance(env.GAME_WORKFLOW, created.gameId);
      await intro.modify(async (m) => {
        await m.disableSleeps();
      });
      // Wait for workflow completion
      await intro.waitForStatus("complete");

      const final = await getState(created.gameId);
      expect(final.phase).toBe("ended");
      expect(["village", "wolves", "error"]).toContain(final.winner);

      // (1) LLM was actually used
      expect(speakCount).toBeGreaterThan(0);

      // (2) Workflow advanced through phases — log has phase-changes
      const phaseChanges = final.log.filter((e) => e.type === "phase-change");
      expect(phaseChanges.length).toBeGreaterThan(2);

      // (3) DO state survives — final state contains all 7 players, all roles revealed at end
      expect(final.players.length).toBe(7);
      for (const p of final.players) {
        expect(p.role).toBeDefined();
      }

      // (4) Chat input plumbing reachable: POST /api/games returned valid data
      expect(created.gameId).toMatch(/^g_/);
      expect(created.humanPlayerId).toBe("human");
    },
    90_000,
  );

  it(
    "memory: round-2 day prompts contain round-1 statements (proves AI players actually use prior context)",
    async () => {
      const seenUserPrompts: string[] = [];
      let speakCount = 0;
      mockAi((_s, user, jsonSchema) => {
        seenUserPrompts.push(user);
        if (jsonSchema && typeof jsonSchema === "object") {
          const enumValues = (jsonSchema as { properties: { target: { enum: string[] } } })
            .properties?.target?.enum ?? [];
          return { target: enumValues[0] ?? "x", reasoning: "ok" };
        }
        speakCount++;
        return `MEMORY_PROOF_${speakCount}: this is statement ${speakCount}.`;
      });

      const created = await startGame(newName());
      const intro = await introspectWorkflowInstance(env.GAME_WORKFLOW, created.gameId);
      await intro.modify(async (m) => {
        await m.disableSleeps();
      });
      await intro.waitForStatus("complete");

      const round2DayPrompts = seenUserPrompts.filter(
        (u) => u.includes("day debate, round") && u.includes("round 2"),
      );
      expect(round2DayPrompts.length, "expected at least one round-2 day prompt").toBeGreaterThan(0);
      const containsEarlier = round2DayPrompts.some((u) => /MEMORY_PROOF_\d+/.test(u));
      expect(containsEarlier, "round-2 prompt should contain a MEMORY_PROOF_ string from round 1").toBe(true);
    },
    90_000,
  );

  it(
    "no role leakage: getPublicState never reveals living non-human roles mid-game",
    async () => {
      const seenStates: { phase: string; players: { id: string; alive: boolean; role?: string }[] }[] = [];
      mockAi((_s, _u, jsonSchema) => {
        if (jsonSchema && typeof jsonSchema === "object") {
          const enumValues = (jsonSchema as { properties: { target: { enum: string[] } } })
            .properties?.target?.enum ?? [];
          return { target: enumValues[0] ?? "x", reasoning: "ok" };
        }
        return "ok";
      });

      const created = await startGame(newName());
      const intro = await introspectWorkflowInstance(env.GAME_WORKFLOW, created.gameId);
      await intro.modify(async (m) => {
        await m.disableSleeps();
      });

      // Poll state a few times during the game
      for (let n = 0; n < 5; n++) {
        await new Promise((r) => setTimeout(r, 200));
        seenStates.push(await getState(created.gameId));
      }
      await intro.waitForStatus("complete");
      seenStates.push(await getState(created.gameId));

      // For every snapshot BEFORE game-over: living non-human players have NO role field
      for (const s of seenStates) {
        if (s.phase === "ended") continue;
        const livingNonHuman = s.players.filter((p) => p.alive && p.id !== "human");
        for (const p of livingNonHuman) {
          expect(p.role, `phase=${s.phase} leaked role for ${p.id}`).toBeUndefined();
        }
      }
    },
    90_000,
  );
});

describe("Integration: activity broadcasts during full game", () => {
  async function connectWs(gameId: string, playerId: string) {
    const res = await SELF.fetch(
      `https://app/api/games/${gameId}/ws?playerId=${playerId}`,
      { headers: { Upgrade: "websocket" } },
    );
    const ws = res.webSocket!;
    ws.accept();
    const messages: any[] = [];
    ws.addEventListener("message", (e) => {
      try { messages.push(JSON.parse(typeof e.data === "string" ? e.data : "")); } catch {}
    });
    return { ws, messages };
  }

  it(
    "thinking activity pairs with a done activity for every AI call",
    async () => {
      mockAi((_s, _u, jsonSchema) => {
        if (jsonSchema && typeof jsonSchema === "object") {
          const enumValues = (jsonSchema as { properties: { target: { enum: string[] } } })
            .properties?.target?.enum ?? [];
          return { target: enumValues[0] ?? "x", reasoning: "ok" };
        }
        return "A careful word.";
      });
      const created = await startGame(newName());
      const { ws, messages } = await connectWs(created.gameId, created.humanPlayerId);

      const intro = await introspectWorkflowInstance(env.GAME_WORKFLOW, created.gameId);
      await intro.modify(async (m) => { await m.disableSleeps(); });
      await intro.waitForStatus("complete");
      // give WS a moment to drain
      await new Promise((r) => setTimeout(r, 200));

      const activities = messages.filter((m) => m.type === "activity");
      expect(activities.length).toBeGreaterThan(0);

      // Every thinking has a matching done for the same (playerId, action)
      const thinking = activities.filter((a) => a.status === "thinking");
      const done = activities.filter((a) => a.status === "done");
      expect(thinking.length).toBe(done.length);

      const key = (a: any) => `${a.playerId}|${a.action}`;
      const thinkingCounts = new Map<string, number>();
      const doneCounts = new Map<string, number>();
      for (const t of thinking) thinkingCounts.set(key(t), (thinkingCounts.get(key(t)) ?? 0) + 1);
      for (const d of done) doneCounts.set(key(d), (doneCounts.get(key(d)) ?? 0) + 1);
      for (const [k, c] of thinkingCounts) {
        expect(doneCounts.get(k) ?? 0, `done count for ${k}`).toBe(c);
      }
      ws.close();
    },
    120_000,
  );

  it(
    "LLM hard failure still emits a matching done activity (no orphan thinking)",
    async () => {
      vi.spyOn(env.AI, "run").mockRejectedValue(new Error("AI 500"));
      const created = await startGame(newName());
      const { ws, messages } = await connectWs(created.gameId, created.humanPlayerId);
      const intro = await introspectWorkflowInstance(env.GAME_WORKFLOW, created.gameId);
      await intro.modify(async (m) => { await m.disableSleeps(); });
      try {
        await intro.waitForStatus("complete");
      } catch {
        try { await intro.waitForStatus("errored"); } catch {}
      }
      await new Promise((r) => setTimeout(r, 200));
      const activities = messages.filter((m) => m.type === "activity");
      const thinking = activities.filter((a) => a.status === "thinking").length;
      const done = activities.filter((a) => a.status === "done").length;
      expect(thinking).toBe(done);
      ws.close();
    },
    120_000,
  );
});
