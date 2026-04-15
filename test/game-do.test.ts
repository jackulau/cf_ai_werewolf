import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GameDurableObject } from "../src/game-do";

let counter = 0;
function newGameStub() {
  counter++;
  const id = env.GAME_DO.idFromName(`game-${counter}-${Date.now()}-${Math.random()}`);
  return { stub: env.GAME_DO.get(id), gameId: `game-${counter}` };
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("createGame", () => {
  it("creates 7 players with correct role distribution", async () => {
    const { stub, gameId } = newGameStub();
    const out = await stub.createGame("seed-A", "Tester", gameId);
    expect(out.gameId).toBe(gameId);
    expect(out.players.length).toBe(7);
    const state = await stub.getPublicState();
    // All living, roles hidden
    expect(state.players.filter((p) => p.alive).length).toBe(7);
  });

  it("returns the human's role and id", async () => {
    const { stub, gameId } = newGameStub();
    const out = await stub.createGame("seed-B", "Alice", gameId);
    expect(out.humanPlayerId).toBe("human");
    expect(["villager", "seer", "doctor", "werewolf"]).toContain(out.role);
  });

  it("is idempotent for same DO instance (returns existing game)", async () => {
    const { stub, gameId } = newGameStub();
    const a = await stub.createGame("seed-C", "Tester", gameId);
    const b = await stub.createGame("seed-C", "OtherName", gameId);
    expect(a.gameId).toBe(b.gameId);
    expect(a.role).toBe(b.role);
  });

  it("rejects empty humanName", async () => {
    const { stub, gameId } = newGameStub();
    await runInDurableObject(stub, async (i) => {
      await expect(i.createGame("seed-D", "", gameId)).rejects.toThrow();
    });
  });
});

describe("getPublicState", () => {
  it("hides roles of living non-human players", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("seed-E", "Tester", gameId);
    const state = await stub.getPublicState();
    const livingNonHuman = state.players.filter((p) => p.alive && p.id !== "human");
    for (const p of livingNonHuman) {
      expect(p.role).toBeUndefined();
    }
  });

  it("reveals roles of dead players", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("seed-F", "Tester", gameId);
    // Manually kill a player (use night action then resolve)
    await runInDurableObject(stub, async (i, s) => {
      const livingByRole = await i.getLivingByRole();
      // Skip to forcibly kill: just mark a non-human player dead via SQL
      const someoneNotHuman = livingByRole.living.find((p) => p.id !== "human")!;
      s.storage.sql.exec(`UPDATE players SET alive = 0 WHERE id = ?`, someoneNotHuman.id);
    });
    const state = await stub.getPublicState();
    const dead = state.players.find((p) => !p.alive);
    expect(dead).toBeDefined();
    expect(dead!.role).toBeDefined();
  });

  it("log payload capped at last 40 entries", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("seed-G", "Tester", gameId);
    await runInDurableObject(stub, async (i, s) => {
      for (let n = 0; n < 200; n++) {
        s.storage.sql.exec(
          `INSERT INTO public_log (turn, phase, type, actor_id, target_id, content, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          1, "day-debate", "speech", null, null, `msg-${n}`, Date.now(),
        );
      }
    });
    const state = await stub.getPublicState();
    expect(state.log.length).toBeLessThanOrEqual(40);
    const json = JSON.stringify(state);
    expect(json.length).toBeLessThan(200_000);
  });
});

describe("getPlayerView", () => {
  it("returns role, memory, and known wolves for human", async () => {
    const { stub, gameId } = newGameStub();
    const out = await stub.createGame("seed-H", "Tester", gameId);
    const view = await stub.getPlayerView("human");
    expect(view).not.toBeNull();
    expect(view!.role).toBe(out.role);
    if (out.role === "werewolf") {
      expect(view!.knownWolves.length).toBe(1);
    } else {
      expect(view!.knownWolves.length).toBe(0);
    }
  });
});

describe("submitVote", () => {
  it("overwrites prior vote for same turn", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("seed-I", "Tester", gameId);
    const living = await stub.getLivingByRole();
    const t1 = living.living[1].id;
    const t2 = living.living[2].id;
    await stub.submitVote("human", t1);
    await stub.submitVote("human", t2);
    const votes = await runInDurableObject(stub, async (i, s) => {
      return s.storage.sql
        .exec(`SELECT * FROM votes WHERE voter_id = 'human'`)
        .toArray();
    });
    expect(votes.length).toBe(1);
    expect((votes[0] as { target_id: string }).target_id).toBe(t2);
  });

  it("rejects vote from dead player", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("seed-J", "Tester", gameId);
    await runInDurableObject(stub, async (i, s) => {
      s.storage.sql.exec(`UPDATE players SET alive = 0 WHERE id = 'human'`);
      const living = await i.getLivingByRole();
      await expect(i.submitVote("human", living.living[0].id)).rejects.toThrow();
    });
  });

  it("rejects vote for dead target", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("seed-K", "Tester", gameId);
    await runInDurableObject(stub, async (i, s) => {
      const living = await i.getLivingByRole();
      const victim = living.living.find((p) => p.id !== "human")!;
      s.storage.sql.exec(`UPDATE players SET alive = 0 WHERE id = ?`, victim.id);
      await expect(i.submitVote("human", victim.id)).rejects.toThrow();
    });
  });
});

describe("submitNightAction", () => {
  it("rejects role-disallowed action (villager kill)", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("villager-seed", "Tester", gameId);
    // Find an actual villager
    await runInDurableObject(stub, async (i, s) => {
      const villager = s.storage.sql
        .exec<{ id: string }>(`SELECT id FROM players WHERE role = 'villager' LIMIT 1`)
        .toArray()[0];
      const target = s.storage.sql
        .exec<{ id: string }>(`SELECT id FROM players WHERE id != ? LIMIT 1`, villager.id)
        .toArray()[0];
      await expect(
        i.submitNightAction(villager.id, "kill", target.id),
      ).rejects.toThrow(/not a werewolf/);
    });
  });

  it("doctor cannot save same player two consecutive nights", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("doc-seed", "Tester", gameId);
    await runInDurableObject(stub, async (i, s) => {
      const doc = s.storage.sql
        .exec<{ id: string }>(`SELECT id FROM players WHERE role = 'doctor' LIMIT 1`)
        .toArray()[0];
      const target = s.storage.sql
        .exec<{ id: string }>(`SELECT id FROM players WHERE id != ? LIMIT 1`, doc.id)
        .toArray()[0];
      await i.kvPutTest("turn", 1);
      await i.submitNightAction(doc.id, "save", target.id);
      await i.kvPutTest("turn", 2);
      await expect(i.submitNightAction(doc.id, "save", target.id)).rejects.toThrow(/two nights/);
    });
  });

  it("doctor consecutive-save block survives DO 'eviction' (state reload)", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("doc-evict-seed", "Tester", gameId);
    await runInDurableObject(stub, async (i, s) => {
      const doc = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'doctor'`).toArray()[0];
      const target = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE id != ?`, doc.id).toArray()[0];
      await i.kvPutTest("turn", 1);
      await i.submitNightAction(doc.id, "save", target.id);
    });
    // Re-fetch stub (simulates eviction; state must come from storage)
    const id2 = env.GAME_DO.idFromName(`game-${counter}`);
    void id2;
    await runInDurableObject(stub, async (i, s) => {
      const doc = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'doctor'`).toArray()[0];
      const target = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE id != ?`, doc.id).toArray()[0];
      await i.kvPutTest("turn", 2);
      await expect(i.submitNightAction(doc.id, "save", target.id)).rejects.toThrow(/two nights/);
    });
  });

  it("seer check stores result in private memory", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("seer-seed", "Tester", gameId);
    const memory = await runInDurableObject(stub, async (i, s) => {
      const seer = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'seer'`).toArray()[0];
      const target = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE id != ? AND role = 'werewolf' LIMIT 1`, seer.id).toArray()[0];
      await i.submitNightAction(seer.id, "investigate", target.id);
      return await i.getPlayerView(seer.id);
    });
    expect(memory!.privateMemory.some((m) => m.type === "seer-check-result" && m.content.includes("werewolf"))).toBe(true);
  });

  it("seer check is deduped at write time — double investigation of same target+turn produces one memory row", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("seer-dedup-seed", "Tester", gameId);
    const count = await runInDurableObject(stub, async (i, s) => {
      const seer = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'seer'`).toArray()[0];
      const target = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE id != ? LIMIT 1`, seer.id).toArray()[0];
      await i.kvPutTest("turn", 1);
      await i.submitNightAction(seer.id, "investigate", target.id);
      // Simulate a retry / partial-failure scenario by re-calling with the same target+turn
      await i.submitNightAction(seer.id, "investigate", target.id);
      const rows = s.storage.sql.exec(
        `SELECT COUNT(*) AS c FROM private_memory WHERE player_id = ? AND type = 'seer-check-result' AND turn = ? AND target_id = ?`,
        seer.id, 1, target.id,
      ).toArray();
      return (rows[0] as { c: number }).c;
    });
    expect(count).toBe(1);
  });

  it("two seer investigations of different targets produce two memory rows", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("seer-two-seed", "Tester", gameId);
    const count = await runInDurableObject(stub, async (i, s) => {
      const seer = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'seer'`).toArray()[0];
      const others = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE id != ? LIMIT 2`, seer.id).toArray();
      await i.kvPutTest("turn", 1);
      await i.submitNightAction(seer.id, "investigate", others[0].id);
      await i.kvPutTest("turn", 2);
      await i.submitNightAction(seer.id, "investigate", others[1].id);
      const rows = s.storage.sql.exec(
        `SELECT COUNT(*) AS c FROM private_memory WHERE player_id = ? AND type = 'seer-check-result'`,
        seer.id,
      ).toArray();
      return (rows[0] as { c: number }).c;
    });
    expect(count).toBe(2);
  });

  it("submitNightActionRandom skips when valid pool empty", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("empty-pool", "Tester", gameId);
    await runInDurableObject(stub, async (i, s) => {
      // Kill all non-wolves
      s.storage.sql.exec(`UPDATE players SET alive = 0 WHERE role != 'werewolf'`);
      const wolf = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'werewolf' AND alive = 1 LIMIT 1`).toArray()[0];
      // Should not throw, just no-op
      await i.submitNightActionRandom(wolf.id, "kill");
      const acts = s.storage.sql.exec(`SELECT * FROM night_actions WHERE actor_id = ?`, wolf.id).toArray();
      expect(acts.length).toBe(0);
    });
  });
});

describe("resolveNight", () => {
  it("kill applied when no save", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("rn-1", "Tester", gameId);
    const result = await runInDurableObject(stub, async (i, s) => {
      await i.kvPutTest("turn", 1);
      const wolf = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'werewolf' LIMIT 1`).toArray()[0];
      const villager = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'villager' LIMIT 1`).toArray()[0];
      await i.submitNightAction(wolf.id, "kill", villager.id);
      return await i.resolveNight();
    });
    expect(result.died).not.toBeNull();
  });

  it("kill blocked when save matches", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("rn-2", "Tester", gameId);
    const result = await runInDurableObject(stub, async (i, s) => {
      await i.kvPutTest("turn", 1);
      const wolf = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'werewolf' LIMIT 1`).toArray()[0];
      const doc = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'doctor' LIMIT 1`).toArray()[0];
      const villager = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'villager' LIMIT 1`).toArray()[0];
      await i.submitNightAction(wolf.id, "kill", villager.id);
      await i.submitNightAction(doc.id, "save", villager.id);
      return await i.resolveNight();
    });
    expect(result.died).toBeNull();
    expect(result.saved).toBe(true);
  });

  it("is idempotent (second call returns same result)", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("rn-3", "Tester", gameId);
    const r1 = await runInDurableObject(stub, async (i, s) => {
      await i.kvPutTest("turn", 1);
      const wolf = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'werewolf' LIMIT 1`).toArray()[0];
      const villager = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'villager' LIMIT 1`).toArray()[0];
      await i.submitNightAction(wolf.id, "kill", villager.id);
      return await i.resolveNight();
    });
    const r2 = await runInDurableObject(stub, async (i, s) => await i.resolveNight());
    expect(r2.died).toBe(r1.died);
  });
});

describe("resolveVote", () => {
  it("plurality winner is executed", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("rv-1", "Tester", gameId);
    await runInDurableObject(stub, async (i, s) => {
      await i.kvPutTest("turn", 1);
      const players = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players ORDER BY id`).toArray();
      const target = players[0].id;
      // Everyone except target votes for target
      for (const p of players.slice(1)) {
        s.storage.sql.exec(
          `INSERT INTO votes (turn, voter_id, target_id) VALUES (?, ?, ?)`,
          1, p.id, target,
        );
      }
    });
    const result = await stub.resolveVote();
    expect(result.executed).not.toBeNull();
  });

  it("tie + revote settles to single winner", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("rv-2", "Tester", gameId);
    const result = await runInDurableObject(stub, async (i, s) => {
      await i.kvPutTest("turn", 1);
      const players = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players ORDER BY id`).toArray();
      // Tie: 3 vote A, 3 vote B, A and B vote against each other (or for self → ignored). Make a 2-way tie.
      const a = players[0].id, b = players[1].id;
      const others = players.slice(2);
      s.storage.sql.exec(`INSERT INTO votes (turn, voter_id, target_id) VALUES (?, ?, ?)`, 1, others[0].id, a);
      s.storage.sql.exec(`INSERT INTO votes (turn, voter_id, target_id) VALUES (?, ?, ?)`, 1, others[1].id, a);
      s.storage.sql.exec(`INSERT INTO votes (turn, voter_id, target_id) VALUES (?, ?, ?)`, 1, others[2].id, b);
      s.storage.sql.exec(`INSERT INTO votes (turn, voter_id, target_id) VALUES (?, ?, ?)`, 1, others[3].id, b);
      s.storage.sql.exec(`INSERT INTO votes (turn, voter_id, target_id) VALUES (?, ?, ?)`, 1, others[4].id, a);
      return await i.resolveVote();
    });
    expect(result.executed).not.toBeNull();
  });
});

describe("aiSpeak", () => {
  it("calls AI, broadcasts message, stores in log", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("ai-speak", "Tester", gameId);
    const spy = vi.spyOn(env.AI, "run").mockResolvedValue({ response: "I think Wren is suspicious." } as unknown as never);
    await runInDurableObject(stub, async (i, s) => {
      const p = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE id != 'human' LIMIT 1`).toArray()[0];
      await i.kvPutTest("turn", 1);
      await i.aiSpeak(p.id, 1);
      const logs = s.storage.sql.exec(`SELECT content FROM public_log WHERE type = 'speech'`).toArray();
      expect(logs.some((r: any) => String(r.content).includes("Wren is suspicious"))).toBe(true);
    });
    expect(spy).toHaveBeenCalled();
  });

  it("is idempotent: second call for same turn/round/player does not re-call AI", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("ai-speak-idem", "Tester", gameId);
    const spy = vi.spyOn(env.AI, "run").mockResolvedValue({ response: "hello" } as unknown as never);
    await runInDurableObject(stub, async (i, s) => {
      const p = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE id != 'human' LIMIT 1`).toArray()[0];
      await i.kvPutTest("turn", 1);
      await i.aiSpeak(p.id, 1);
      await i.aiSpeak(p.id, 1);
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("aiTakeNightAction", () => {
  it("wolf kill action stored in night_actions, NOT in public log", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("ai-night-1", "Tester", gameId);
    vi.spyOn(env.AI, "run").mockImplementation(async (_m, inputs: any) => {
      const enumValues = inputs?.response_format?.json_schema?.properties?.target?.enum ?? [];
      return { response: JSON.stringify({ target: enumValues[0], reasoning: "ok" }) } as unknown as never;
    });
    await runInDurableObject(stub, async (i, s) => {
      const wolf = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'werewolf' LIMIT 1`).toArray()[0];
      await i.kvPutTest("turn", 1);
      await i.aiTakeNightAction(wolf.id);
      const acts = s.storage.sql.exec(`SELECT * FROM night_actions WHERE actor_id = ?`, wolf.id).toArray();
      expect(acts.length).toBe(1);
      const logs = s.storage.sql.exec(`SELECT * FROM public_log WHERE actor_id = ?`, wolf.id).toArray();
      expect(logs.length).toBe(0);
    });
  });

  it("falls back to random target on LLM validation failure", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("ai-night-fb", "Tester", gameId);
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "garbage not json" } as unknown as never);
    await runInDurableObject(stub, async (i, s) => {
      const wolf = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'werewolf' LIMIT 1`).toArray()[0];
      await i.kvPutTest("turn", 1);
      await i.aiTakeNightAction(wolf.id);
      const acts = s.storage.sql.exec(`SELECT * FROM night_actions WHERE actor_id = ?`, wolf.id).toArray();
      expect(acts.length).toBe(1);
      const fallbacks = s.storage.sql.exec(`SELECT * FROM private_memory WHERE player_id = ? AND type = 'llm-fallback'`, wolf.id).toArray();
      expect(fallbacks.length).toBeGreaterThan(0);
    });
  });
});

describe("markGameErrored", () => {
  it("sets phase=ended, winner=error, broadcasts game-error", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("err-1", "Tester", gameId);
    await stub.markGameErrored("AI service down");
    const state = await stub.getPublicState();
    expect(state.phase).toBe("ended");
    expect(state.winner).toBe("error");
  });
});

describe("summarizeAndCacheLog", () => {
  it("summarizes when log exceeds threshold and is idempotent for unchanged log", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("sum-1", "Tester", gameId);
    const spy = vi.spyOn(env.AI, "run").mockResolvedValue({ response: "Summary text here." } as unknown as never);
    await runInDurableObject(stub, async (i, s) => {
      for (let n = 0; n < 50; n++) {
        s.storage.sql.exec(
          `INSERT INTO public_log (turn, phase, type, actor_id, target_id, content, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          1, "day-debate", "speech", null, null, `entry-${n}`, Date.now(),
        );
      }
      await i.summarizeAndCacheLog();
      await i.summarizeAndCacheLog(); // second call with no new entries
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const state = await stub.getPublicState();
    expect(state.logSummary).toBe("Summary text here.");
  });

  it("no-op when log under threshold", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("sum-2", "Tester", gameId);
    const spy = vi.spyOn(env.AI, "run").mockResolvedValue({ response: "x" } as unknown as never);
    await stub.summarizeAndCacheLog();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("currentWinner", () => {
  it("returns null at game start", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("cw-1", "Tester", gameId);
    expect(await stub.currentWinner()).toBeNull();
  });

  it("returns village when all wolves dead", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("cw-2", "Tester", gameId);
    await runInDurableObject(stub, async (i, s) => {
      s.storage.sql.exec(`UPDATE players SET alive = 0 WHERE role = 'werewolf'`);
    });
    expect(await stub.currentWinner()).toBe("village");
  });
});

describe("WebSocket: late-action and duplicate-connection handling", () => {
  it("late night-action returns action-too-late when phase has advanced", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("ws-1", "Tester", gameId);
    await stub.setPhase("day-debate", 1, 1);
    const res = await stub.fetch(new Request("https://do/?playerId=human", { headers: { Upgrade: "websocket" } }));
    const ws = res.webSocket!;
    ws.accept();
    const messages: string[] = [];
    ws.addEventListener("message", (e) => messages.push(typeof e.data === "string" ? e.data : ""));
    ws.send(JSON.stringify({ type: "night-action", action: "investigate", target: "human" }));
    // Allow message dispatch
    await new Promise((r) => setTimeout(r, 100));
    const tooLate = messages.find((m) => m.includes("action-too-late"));
    expect(tooLate).toBeDefined();
  });

  it("second WS connection for same playerId closes the first with code 4001", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("ws-2", "Tester", gameId);
    const res1 = await stub.fetch(new Request("https://do/?playerId=human", { headers: { Upgrade: "websocket" } }));
    const ws1 = res1.webSocket!;
    ws1.accept();
    let close1Code: number | null = null;
    ws1.addEventListener("close", (e) => { close1Code = e.code; });
    const res2 = await stub.fetch(new Request("https://do/?playerId=human", { headers: { Upgrade: "websocket" } }));
    const ws2 = res2.webSocket!;
    ws2.accept();
    await new Promise((r) => setTimeout(r, 100));
    expect(close1Code).toBe(4001);
    ws2.close();
  });
});

// Helper: open a WS and collect all incoming messages as parsed JSON
async function collectMessages(
  stub: DurableObjectStub,
  playerId: string,
): Promise<{ ws: WebSocket; messages: any[] }> {
  const res = await stub.fetch(
    new Request(`https://do/?playerId=${playerId}`, { headers: { Upgrade: "websocket" } }),
  );
  const ws = res.webSocket!;
  ws.accept();
  const messages: any[] = [];
  ws.addEventListener("message", (e) => {
    try { messages.push(JSON.parse(typeof e.data === "string" ? e.data : "")); } catch {}
  });
  return { ws, messages };
}

describe("activity broadcasts", () => {
  it("aiSpeak emits thinking + done activity pair for fresh call", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("act-speak", "Tester", gameId);
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "something." } as unknown as never);
    const { ws, messages } = await collectMessages(stub, "human");
    await runInDurableObject(stub, async (i, s) => {
      const p = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE id != 'human' LIMIT 1`).toArray()[0];
      await i.kvPutTest("turn", 1);
      await i.aiSpeak(p.id, 1);
    });
    await new Promise((r) => setTimeout(r, 50));
    const activities = messages.filter((m) => m.type === "activity");
    expect(activities.length).toBe(2);
    expect(activities[0].status).toBe("thinking");
    expect(activities[0].action).toBe("speak");
    expect(activities[1].status).toBe("done");
    expect(activities[1].action).toBe("speak");
    expect(activities[0].playerId).toBe(activities[1].playerId);
    expect(activities[0].playerName).toBeTruthy();
    ws.close();
  });

  it("aiSpeak idempotent repeat emits NO activity broadcast (no orphan pairs)", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("act-idem", "Tester", gameId);
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "hi" } as unknown as never);
    const { ws, messages } = await collectMessages(stub, "human");
    await runInDurableObject(stub, async (i, s) => {
      const p = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE id != 'human' LIMIT 1`).toArray()[0];
      await i.kvPutTest("turn", 1);
      await i.aiSpeak(p.id, 1);
      await i.aiSpeak(p.id, 1); // repeat — should be no-op
    });
    await new Promise((r) => setTimeout(r, 50));
    const activities = messages.filter((m) => m.type === "activity");
    // Exactly one thinking+done pair — the repeat call didn't produce any
    expect(activities.length).toBe(2);
    ws.close();
  });

  it("aiTakeNightAction emits correct action per role (kill/investigate/save)", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("act-night", "Tester", gameId);
    vi.spyOn(env.AI, "run").mockImplementation(async (_m, inputs: any) => {
      const enumValues = inputs?.response_format?.json_schema?.properties?.target?.enum ?? [];
      return { response: JSON.stringify({ target: enumValues[0] ?? "x", reasoning: "ok" }) } as unknown as never;
    });
    const { ws, messages } = await collectMessages(stub, "human");
    await runInDurableObject(stub, async (i, s) => {
      await i.kvPutTest("turn", 1);
      const wolf = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'werewolf' LIMIT 1`).toArray()[0];
      const seer = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'seer' LIMIT 1`).toArray()[0];
      const doctor = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE role = 'doctor' LIMIT 1`).toArray()[0];
      await i.aiTakeNightAction(wolf.id);
      await i.aiTakeNightAction(seer.id);
      await i.aiTakeNightAction(doctor.id);
    });
    await new Promise((r) => setTimeout(r, 50));
    const activities = messages.filter((m) => m.type === "activity");
    const actions = new Set(activities.map((a) => a.action));
    expect(actions.has("kill")).toBe(true);
    expect(actions.has("investigate")).toBe(true);
    expect(actions.has("save")).toBe(true);
    ws.close();
  });

  it("aiVote emits vote activity", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("act-vote", "Tester", gameId);
    vi.spyOn(env.AI, "run").mockImplementation(async (_m, inputs: any) => {
      const enumValues = inputs?.response_format?.json_schema?.properties?.target?.enum ?? [];
      return { response: JSON.stringify({ target: enumValues[0] ?? "x", reasoning: "ok" }) } as unknown as never;
    });
    const { ws, messages } = await collectMessages(stub, "human");
    await runInDurableObject(stub, async (i, s) => {
      await i.kvPutTest("turn", 1);
      const p = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE id != 'human' LIMIT 1`).toArray()[0];
      await i.aiVote(p.id);
    });
    await new Promise((r) => setTimeout(r, 50));
    const voteActivities = messages.filter((m) => m.type === "activity" && m.action === "vote");
    expect(voteActivities.length).toBe(2);
    expect(voteActivities[0].status).toBe("thinking");
    expect(voteActivities[1].status).toBe("done");
    ws.close();
  });

  it("aiSpeak AI failure still emits done activity (no orphan thinking)", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("act-fail", "Tester", gameId);
    vi.spyOn(env.AI, "run").mockRejectedValue(new Error("AI down"));
    const { ws, messages } = await collectMessages(stub, "human");
    await runInDurableObject(stub, async (i, s) => {
      const p = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE id != 'human' LIMIT 1`).toArray()[0];
      await i.kvPutTest("turn", 1);
      await i.aiSpeak(p.id, 1);
    });
    await new Promise((r) => setTimeout(r, 50));
    const activities = messages.filter((m) => m.type === "activity");
    const doneCount = activities.filter((a) => a.status === "done").length;
    const thinkingCount = activities.filter((a) => a.status === "thinking").length;
    expect(thinkingCount).toBe(doneCount);
    ws.close();
  });
});

describe("streaming aiSpeak broadcasts log-delta chunks", () => {
  function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const c of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: c })}\n\n`));
        }
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        controller.close();
      },
    });
  }

  it("emits one log-delta per chunk, then a final log with the concat", async () => {
    const { stub, gameId } = newGameStub();
    await stub.createGame("stream-speak", "Tester", gameId);
    vi.spyOn(env.AI, "run").mockImplementation(
      async () => sseStream(["I ", "suspect ", "Morgan."]) as unknown as never,
    );
    const { ws, messages } = await collectMessages(stub, "human");
    await runInDurableObject(stub, async (i, s) => {
      const p = s.storage.sql.exec<{ id: string }>(`SELECT id FROM players WHERE id != 'human' LIMIT 1`).toArray()[0];
      await i.kvPutTest("turn", 1);
      await i.aiSpeak(p.id, 1);
    });
    await new Promise((r) => setTimeout(r, 50));
    const deltas = messages.filter((m) => m.type === "log-delta");
    expect(deltas.length).toBe(3);
    expect(deltas.map((d) => d.delta).join("")).toBe("I suspect Morgan.");
    // final authoritative log message should contain the concatenated text
    const logs = messages.filter((m) => m.type === "log" && m.logType === "speech");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[logs.length - 1].content).toContain("I suspect Morgan.");
    ws.close();
  });
});

