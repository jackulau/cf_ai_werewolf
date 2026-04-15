import type { Phase, Role, Winner } from "./types";

// Server → Client messages
export type ServerMessage =
  | { type: "hello"; gameId: string; humanPlayerId: string; role: Role }
  | { type: "phase"; phase: Phase; turn: number }
  | {
      type: "log";
      seq: number;
      turn: number;
      phase: Phase;
      logType: string;
      actorName: string | null;
      content: string;
    }
  | { type: "death"; victimName: string; turn: number }
  | { type: "vote-result"; executedName: string | null; counts: Record<string, number> }
  | { type: "seer-result"; targetName: string; isWolf: boolean; turn: number }
  | {
      type: "game-over";
      winner: Winner;
      reveals: { name: string; role: Role }[];
    }
  | { type: "game-error"; message: string }
  | { type: "action-too-late"; currentPhase: Phase }
  | { type: "ack"; ok: true; for: string };

// Client → Server messages
export type ClientMessage =
  | { type: "start" }
  | { type: "night-action"; action: "kill" | "save" | "investigate"; target: string }
  | { type: "vote"; target: string }
  | { type: "say"; content: string };

export const HUMAN_PLAYER_ID_TAG_PREFIX = "player:";
