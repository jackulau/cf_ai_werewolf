import { describe, it, expect } from "vitest";
import {
  assignRoles,
  finalTieBreak,
  nextDoctorSaveBlocked,
  pickWolfKill,
  PLAYERS_PER_GAME,
  resolveNight,
  resolveTie,
  seededShuffle,
  tallyVotes,
  winner,
} from "../src/rules";
import { PERSONAS, pickPersonas } from "../src/personas";
import type { Player, Role } from "../src/types";

const SEVEN_IDS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];

function makePlayer(id: string, role: Role, alive = true): Player {
  return { id, name: id, bio: "", role, isHuman: false, alive };
}

describe("assignRoles", () => {
  it("produces 2/1/1/3 distribution for 7 players", () => {
    const roles = assignRoles("seed-1", SEVEN_IDS);
    expect(roles.size).toBe(PLAYERS_PER_GAME);
    const counts = { werewolf: 0, seer: 0, doctor: 0, villager: 0 } as Record<Role, number>;
    for (const role of roles.values()) counts[role]++;
    expect(counts.werewolf).toBe(2);
    expect(counts.seer).toBe(1);
    expect(counts.doctor).toBe(1);
    expect(counts.villager).toBe(3);
  });

  it("is deterministic for same seed", () => {
    const a = assignRoles("seed-X", SEVEN_IDS);
    const b = assignRoles("seed-X", SEVEN_IDS);
    expect(Array.from(a.entries())).toEqual(Array.from(b.entries()));
  });

  it("produces different distributions across seeds (probabilistic)", () => {
    const sigs = new Set<string>();
    for (const seed of ["a", "b", "c", "d", "e"]) {
      const m = assignRoles(seed, SEVEN_IDS);
      sigs.add(SEVEN_IDS.map((id) => m.get(id)).join("|"));
    }
    expect(sigs.size).toBeGreaterThanOrEqual(2);
  });

  it("throws if player count is wrong", () => {
    expect(() => assignRoles("s", ["a", "b"])).toThrow();
  });
});

describe("winner", () => {
  it("village wins when all wolves dead", () => {
    const players: Player[] = [
      makePlayer("a", "werewolf", false),
      makePlayer("b", "werewolf", false),
      makePlayer("c", "villager"),
      makePlayer("d", "seer"),
    ];
    expect(winner(players)).toBe("village");
  });

  it("wolves win at parity (1 wolf vs 1 villager)", () => {
    const players: Player[] = [
      makePlayer("a", "werewolf"),
      makePlayer("b", "villager"),
    ];
    expect(winner(players)).toBe("wolves");
  });

  it("wolves win when wolves outnumber villagers", () => {
    const players: Player[] = [
      makePlayer("a", "werewolf"),
      makePlayer("b", "werewolf"),
      makePlayer("c", "villager"),
    ];
    expect(winner(players)).toBe("wolves");
  });

  it("returns null when wolves < villagers and >0", () => {
    const players: Player[] = [
      makePlayer("a", "werewolf"),
      makePlayer("b", "villager"),
      makePlayer("c", "villager"),
      makePlayer("d", "seer"),
    ];
    expect(winner(players)).toBeNull();
  });
});

describe("tallyVotes", () => {
  it("identifies single plurality winner", () => {
    const votes = new Map([
      ["a", "b"],
      ["b", "c"],
      ["c", "b"],
      ["d", "b"],
    ]);
    const r = tallyVotes(votes, ["a", "b", "c", "d"]);
    expect(r.winners).toEqual(["b"]);
    expect(r.counts.b).toBe(3);
    expect(r.counts.c).toBe(1);
  });

  it("two-way tie returns both", () => {
    const votes = new Map([
      ["a", "b"],
      ["b", "a"],
    ]);
    const r = tallyVotes(votes, ["a", "b", "c"]);
    expect(r.winners.sort()).toEqual(["a", "b"]);
  });

  it("ignores votes for dead players", () => {
    const votes = new Map([
      ["a", "z-dead"],
      ["b", "a"],
    ]);
    const r = tallyVotes(votes, ["a", "b"]);
    expect(r.winners).toEqual(["a"]);
    expect(r.counts["z-dead"]).toBeUndefined();
  });

  it("ignores empty/skip votes (empty target)", () => {
    const votes = new Map([
      ["a", ""],
      ["b", "a"],
    ]);
    const r = tallyVotes(votes, ["a", "b"]);
    expect(r.winners).toEqual(["a"]);
  });
});

describe("resolveTie + finalTieBreak", () => {
  it("revote settles to single winner", () => {
    const r = resolveTie(["a", "b"], new Map([["a", "b"], ["b", "b"]]));
    expect(r.winners).toEqual(["b"]);
  });

  it("finalTieBreak is deterministic by seed", () => {
    const a = finalTieBreak(["x", "y", "z"], "seed-1");
    const b = finalTieBreak(["x", "y", "z"], "seed-1");
    expect(a).toBe(b);
    expect(["x", "y", "z"]).toContain(a);
  });
});

describe("resolveNight", () => {
  it("kill succeeds when no save", () => {
    expect(resolveNight({ killTarget: "a", saveTarget: null })).toEqual({
      died: "a",
      saved: false,
    });
  });

  it("kill blocked when save matches", () => {
    expect(resolveNight({ killTarget: "a", saveTarget: "a" })).toEqual({
      died: null,
      saved: true,
    });
  });

  it("kill succeeds when save targets different player", () => {
    expect(resolveNight({ killTarget: "a", saveTarget: "b" })).toEqual({
      died: "a",
      saved: false,
    });
  });

  it("no kill when killTarget null", () => {
    expect(resolveNight({ killTarget: null, saveTarget: "a" })).toEqual({
      died: null,
      saved: false,
    });
  });
});

describe("nextDoctorSaveBlocked", () => {
  it("returns the player saved on previous night", () => {
    const history = [{ turn: 1, targetId: "alice" }];
    expect(nextDoctorSaveBlocked(history, 2)).toBe("alice");
  });

  it("returns null on first night", () => {
    expect(nextDoctorSaveBlocked([], 1)).toBeNull();
  });
});

describe("pickWolfKill", () => {
  it("returns agreed target when wolves agree", () => {
    expect(
      pickWolfKill([
        { wolfId: "w1", target: "v1" },
        { wolfId: "w2", target: "v1" },
      ]),
    ).toBe("v1");
  });

  it("breaks tie by first wolfId in sort order", () => {
    expect(
      pickWolfKill([
        { wolfId: "w2", target: "v2" },
        { wolfId: "w1", target: "v1" },
      ]),
    ).toBe("v1");
  });
});

describe("pickPersonas", () => {
  it("is deterministic for same seed and returns distinct ids", () => {
    const a = pickPersonas("seed-1", 6);
    const b = pickPersonas("seed-1", 6);
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
    expect(new Set(a.map((p) => p.id)).size).toBe(6);
  });

  it("throws when count exceeds available personas", () => {
    expect(() => pickPersonas("s", PERSONAS.length + 1)).toThrow();
  });
});

describe("seededShuffle", () => {
  it("preserves elements", () => {
    const shuffled = seededShuffle([1, 2, 3, 4, 5], "seed");
    expect([...shuffled].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
