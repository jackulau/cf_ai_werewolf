import { describe, it, expect } from "vitest";
import type { ServerMessage, ClientMessage } from "../src/ws";

/**
 * Type-level tests. These compile iff the discriminated unions include
 * every expected case. If we drop a case, tsc fails.
 */
describe("ServerMessage discriminated union", () => {
  it("includes every expected message type", () => {
    const types: ServerMessage["type"][] = [
      "hello", "phase", "log", "death", "vote-result", "seer-result",
      "game-over", "game-error", "action-too-late", "activity", "log-delta", "ack",
    ];
    // One of each so an exhaustive switch must cover them
    const check = (m: ServerMessage): string => {
      switch (m.type) {
        case "hello": return m.role;
        case "phase": return String(m.turn);
        case "log": return m.content;
        case "death": return m.victimName;
        case "vote-result": return String(m.executedName);
        case "seer-result": return m.targetName;
        case "game-over": return m.winner;
        case "game-error": return m.message;
        case "action-too-late": return m.currentPhase;
        case "activity": return m.playerName;
        case "log-delta": return m.delta;
        case "ack": return m.for;
      }
    };
    expect(types.length).toBe(12);
    expect(typeof check).toBe("function");
  });
});

describe("ClientMessage discriminated union", () => {
  it("includes every expected message type", () => {
    const types: ClientMessage["type"][] = ["start", "night-action", "vote", "say"];
    expect(types.length).toBe(4);
  });
});
