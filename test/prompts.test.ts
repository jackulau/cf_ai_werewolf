import { describe, it, expect } from "vitest";
import {
  buildDayTalkPrompt,
  buildInvestigatePrompt,
  buildKillPrompt,
  buildPersonaSystem,
  buildSavePrompt,
  buildVotePrompt,
  type PromptContext,
} from "../src/prompts";
import type { LogEntry, PrivateMemoryEvent } from "../src/types";

const wren = { id: "p1", name: "Wren", bio: "the baker" };
const morgan = { id: "p2", name: "Morgan", bio: "the fisher" };
const tobias = { id: "p3", name: "Tobias", bio: "the smith" };
const elspeth = { id: "p4", name: "Elspeth", bio: "the innkeeper" };
const rorik = { id: "p5", name: "Rorik", bio: "the hunter" };
const isolde = { id: "p6", name: "Isolde", bio: "the herbalist" };
const callum = { id: "p7", name: "Callum", bio: "the miller" };

const ALL = [wren, morgan, tobias, elspeth, rorik, isolde, callum];

function ctxFor(role: PromptContext["player"]["role"], partial: Partial<PromptContext> = {}): PromptContext {
  return {
    player: { ...wren, role },
    livingPlayers: ALL,
    deadPlayers: [],
    publicLog: [],
    privateMemory: [],
    coWolves: undefined,
    blockedSavePlayer: null,
    turn: 1,
    logSummary: null,
    ...partial,
  };
}

describe("buildPersonaSystem", () => {
  it("includes player name and bio", () => {
    const sys = buildPersonaSystem(ctxFor("villager"));
    expect(sys).toContain("Wren");
    expect(sys).toContain("the baker");
  });

  it("includes role-specific guidance for villager", () => {
    expect(buildPersonaSystem(ctxFor("villager"))).toContain("innocent villager");
  });

  it("includes role-specific guidance for werewolf", () => {
    const sys = buildPersonaSystem(
      ctxFor("werewolf", { coWolves: [tobias] }),
    );
    expect(sys).toContain("Werewolf");
    expect(sys).toContain("Tobias");
  });

  it("does NOT mention co-wolves for villager prompts", () => {
    const sys = buildPersonaSystem(ctxFor("villager"));
    expect(sys.toLowerCase()).not.toContain("fellow werewolves");
  });
});

describe("buildKillPrompt", () => {
  it("wolf kill prompt mentions co-wolves by name", () => {
    const p = buildKillPrompt(
      ctxFor("werewolf", { coWolves: [tobias] }),
    );
    expect(p.system).toContain("Tobias");
  });

  it("JSON schema enum excludes wolves and self", () => {
    const p = buildKillPrompt(
      ctxFor("werewolf", { coWolves: [tobias] }),
    );
    const enumValues = (p.jsonSchema as { properties: { target: { enum: string[] } } })
      .properties.target.enum;
    expect(enumValues).not.toContain("Wren");
    expect(enumValues).not.toContain("Tobias");
    expect(enumValues).toContain("Morgan");
  });

  it("Zod schema accepts valid living non-wolf and rejects wolf", () => {
    const p = buildKillPrompt(
      ctxFor("werewolf", { coWolves: [tobias] }),
    );
    expect(p.zodSchema.safeParse({ target: "Morgan", reasoning: "x" }).success).toBe(true);
    expect(p.zodSchema.safeParse({ target: "Wren", reasoning: "x" }).success).toBe(false);
  });
});

describe("buildSavePrompt", () => {
  it("doctor save enum excludes the blocked player", () => {
    const p = buildSavePrompt(
      ctxFor("doctor", { blockedSavePlayer: "p2" }),
    );
    const enumValues = (p.jsonSchema as { properties: { target: { enum: string[] } } })
      .properties.target.enum;
    expect(enumValues).not.toContain("Morgan");
    expect(enumValues).toContain("Wren");
  });
});

describe("buildInvestigatePrompt", () => {
  it("seer prompt includes prior check results from private memory", () => {
    const memory: PrivateMemoryEvent[] = [
      {
        seq: 1,
        playerId: "p1",
        turn: 1,
        type: "seer-check-result",
        targetId: "p3",
        content: "Tobias is a werewolf",
        ts: 0,
      },
    ];
    const p = buildInvestigatePrompt(
      ctxFor("seer", { privateMemory: memory }),
    );
    expect(p.user).toContain("Tobias is a werewolf");
  });

  it("seer cannot investigate self", () => {
    const p = buildInvestigatePrompt(ctxFor("seer"));
    const enumValues = (p.jsonSchema as { properties: { target: { enum: string[] } } })
      .properties.target.enum;
    expect(enumValues).not.toContain("Wren");
  });
});

describe("buildDayTalkPrompt", () => {
  it("includes recent public log messages (memory)", () => {
    const log: LogEntry[] = [
      {
        seq: 1,
        turn: 1,
        phase: "day-debate",
        type: "speech",
        actorId: "p1",
        targetId: null,
        content: "I think Morgan is a wolf",
        ts: 0,
      },
    ];
    const p = buildDayTalkPrompt(ctxFor("villager", { publicLog: log }), 2);
    expect(p.user).toContain("I think Morgan is a wolf");
  });

  it("wolf is told to deflect", () => {
    const p = buildDayTalkPrompt(
      ctxFor("werewolf", { coWolves: [tobias] }),
      1,
    );
    expect(p.user.toLowerCase()).toContain("deflect");
  });

  it("instructions say no JSON", () => {
    const p = buildDayTalkPrompt(ctxFor("villager"), 1);
    expect(p.user).toMatch(/no json/i);
  });
});

describe("buildVotePrompt", () => {
  it("vote enum is living players minus self", () => {
    const p = buildVotePrompt(ctxFor("villager"));
    const enumValues = (p.jsonSchema as { properties: { target: { enum: string[] } } })
      .properties.target.enum;
    expect(enumValues).not.toContain("Wren");
    expect(enumValues).toContain("Morgan");
  });

  it("vote enum excludes dead players", () => {
    const p = buildVotePrompt(
      ctxFor("villager", { livingPlayers: [wren, morgan, tobias], deadPlayers: [callum] }),
    );
    const enumValues = (p.jsonSchema as { properties: { target: { enum: string[] } } })
      .properties.target.enum;
    expect(enumValues).not.toContain("Callum");
  });
});

describe("AI memory: round-2 talk prompt includes round-1 statement", () => {
  it("villager X's round-2 prompt includes their round-1 accusation verbatim", () => {
    const log: LogEntry[] = [
      {
        seq: 1, turn: 1, phase: "day-debate", type: "speech",
        actorId: "p2", targetId: null,
        content: "Morgan: Tobias was acting strange last night.", ts: 0,
      },
      {
        seq: 2, turn: 1, phase: "day-debate", type: "speech",
        actorId: "p1", targetId: null,
        content: "Wren: I agree, Tobias is suspicious.", ts: 1,
      },
    ];
    const p = buildDayTalkPrompt(
      ctxFor("villager", { publicLog: log, turn: 1 }),
      2,
    );
    expect(p.user).toContain("Tobias was acting strange last night.");
    expect(p.user).toContain("I agree, Tobias is suspicious.");
  });
});

describe("no role leakage", () => {
  it("villager prompt does not mention any other player's role", () => {
    const sys = buildPersonaSystem(ctxFor("villager"));
    expect(sys).not.toContain("werewolf is");
    expect(sys.toLowerCase()).not.toMatch(/morgan is a (werewolf|seer|doctor)/);
  });

  it("seer prompt only contains seer's own check results, not raw role assignments", () => {
    const memory: PrivateMemoryEvent[] = [
      {
        seq: 1, playerId: "p1", turn: 1,
        type: "seer-check-result", targetId: "p3",
        content: "Tobias is a werewolf", ts: 0,
      },
    ];
    const p = buildInvestigatePrompt(
      ctxFor("seer", { privateMemory: memory }),
    );
    // The seer should know about Tobias, but not other unchecked players
    expect(p.user).toContain("Tobias is a werewolf");
    expect(p.user).not.toContain("Morgan is a werewolf");
    expect(p.user).not.toContain("Elspeth is a werewolf");
  });
});

describe("rolling summary integration", () => {
  it("includes log_summary in prompt when present", () => {
    const p = buildDayTalkPrompt(
      ctxFor("villager", { logSummary: "Earlier turns: Morgan was killed; Tobias was lynched but turned out villager." }),
      1,
    );
    expect(p.user).toContain("Earlier turns:");
    expect(p.user).toContain("Tobias was lynched");
  });
});
