export type Role = "villager" | "seer" | "doctor" | "werewolf";

export type Phase =
  | "lobby"
  | "night"
  | "day-debate"
  | "voting"
  | "resolution"
  | "ended";

export type Winner = "village" | "wolves" | "error";

export type Player = {
  id: string;
  name: string;
  bio: string;
  role: Role;
  isHuman: boolean;
  alive: boolean;
};

export type Persona = {
  id: string;
  name: string;
  bio: string;
};

export type LogEntryType =
  | "system"
  | "phase-change"
  | "death"
  | "speech"
  | "vote-result"
  | "game-over"
  | "summary";

export type LogEntry = {
  seq: number;
  turn: number;
  phase: Phase;
  type: LogEntryType;
  actorId: string | null;
  targetId: string | null;
  content: string;
  ts: number;
};

export type PrivateMemoryEventType =
  | "self-statement"
  | "self-vote"
  | "seer-check-result"
  | "wolf-coordination"
  | "wolf-kill-decision"
  | "doctor-save-decision"
  | "llm-fallback";

export type PrivateMemoryEvent = {
  seq: number;
  playerId: string;
  turn: number;
  type: PrivateMemoryEventType;
  targetId: string | null;
  content: string;
  ts: number;
};

export type NightActionType = "kill" | "save" | "investigate";

export type NightAction = {
  turn: number;
  actorId: string;
  action: NightActionType;
  targetId: string;
};

export type VoteRecord = {
  turn: number;
  voterId: string;
  targetId: string;
};

export type DoctorSaveHistory = {
  turn: number;
  targetId: string;
};

export type ResolveNightInput = {
  killTarget: string | null;
  saveTarget: string | null;
};

export type ResolveNightResult = {
  died: string | null;
  saved: boolean;
};

export type TallyResult = {
  winners: string[];
  counts: Record<string, number>;
};
