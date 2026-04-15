import { z } from "zod";
import type {
  LogEntry,
  Persona,
  PrivateMemoryEvent,
  Role,
} from "./types";

export type PublicPlayerInfo = { id: string; name: string; bio: string };

export type PromptContext = {
  player: { id: string; name: string; bio: string; role: Role };
  livingPlayers: PublicPlayerInfo[];
  deadPlayers: PublicPlayerInfo[];
  publicLog: LogEntry[];
  privateMemory: PrivateMemoryEvent[];
  coWolves?: PublicPlayerInfo[];
  blockedSavePlayer?: string | null;
  turn: number;
  logSummary?: string | null;
};

export type TextPrompt = { system: string; user: string };

export type StructuredPrompt<T> = {
  system: string;
  user: string;
  jsonSchema: object;
  zodSchema: z.ZodType<T>;
};

const ROLE_GUIDANCE: Record<Role, string> = {
  villager:
    "You are an innocent villager. You have no special abilities. Your only weapon is reasoning out loud about who is suspicious. You do not know any other player's role for certain — only what they say and do.",
  seer:
    "You are the Seer. Each night you investigate one player and learn their true role. Use this knowledge carefully — revealing yourself paints a target on your back. You may share, hold back, or lie about what you've seen.",
  doctor:
    "You are the Doctor. Each night you choose one player to protect from being killed. You may protect yourself, but not on consecutive nights. You must hide your role — if the wolves discover you, they will kill you.",
  werewolf:
    "You are a Werewolf. Each night you and your pack pick a villager to kill. During the day you must lie convincingly to deflect suspicion. You know who the other werewolves are. NEVER reveal your role to non-wolves; agreeing with safe accusations against villagers is a good way to blend in.",
};

function fmtPersonaList(players: PublicPlayerInfo[]): string {
  if (players.length === 0) return "(none)";
  return players.map((p) => `- ${p.name} — ${p.bio}`).join("\n");
}

function fmtLog(log: LogEntry[]): string {
  if (log.length === 0) return "(no events yet)";
  return log
    .map((e) => {
      const who = e.actorId ?? "system";
      return `[turn ${e.turn} ${e.phase}] ${who}: ${e.content}`;
    })
    .join("\n");
}

function fmtPrivateMemory(events: PrivateMemoryEvent[]): string {
  if (events.length === 0) return "(no private notes yet)";
  return events
    .map((e) => `- (turn ${e.turn}, ${e.type}) ${e.content}`)
    .join("\n");
}

function fmtCoWolves(coWolves: PublicPlayerInfo[] | undefined): string {
  if (!coWolves || coWolves.length === 0) return "";
  return `\n\nYour fellow werewolves are: ${coWolves.map((p) => p.name).join(", ")}. You will never vote against them or accuse them.`;
}

export function buildPersonaSystem(ctx: PromptContext): string {
  const lines: string[] = [];
  lines.push(`You are ${ctx.player.name}.`);
  lines.push(ctx.player.bio);
  lines.push("");
  lines.push("You are playing a game of Werewolf.");
  lines.push(ROLE_GUIDANCE[ctx.player.role]);

  if (ctx.player.role === "werewolf" && ctx.coWolves) {
    lines.push(fmtCoWolves(ctx.coWolves).trimStart());
  }

  lines.push("");
  lines.push("Stay in character. Keep responses short and natural — one or two sentences. Do not break the fourth wall. Do not narrate. Do not use markdown.");

  return lines.join("\n");
}

function buildSharedContext(ctx: PromptContext, includeRecentSpeech = true): string {
  const lines: string[] = [];
  lines.push(`=== Game state ===`);
  lines.push(`Turn: ${ctx.turn}`);
  lines.push(`Living players (${ctx.livingPlayers.length}):`);
  lines.push(fmtPersonaList(ctx.livingPlayers));
  if (ctx.deadPlayers.length > 0) {
    lines.push(`Dead players: ${ctx.deadPlayers.map((p) => p.name).join(", ")}`);
  }
  if (ctx.logSummary) {
    lines.push("");
    lines.push(`=== Earlier events (summary) ===`);
    lines.push(ctx.logSummary);
  }
  if (includeRecentSpeech) {
    lines.push("");
    lines.push(`=== Recent events (most recent first ${ctx.publicLog.length} shown) ===`);
    lines.push(fmtLog(ctx.publicLog));
  }
  lines.push("");
  lines.push(`=== Your private notes ===`);
  lines.push(fmtPrivateMemory(ctx.privateMemory));
  return lines.join("\n");
}

function targetEnum(targetIds: string[]): { type: "string"; enum: string[] } {
  return { type: "string", enum: targetIds };
}

export function buildKillPrompt(ctx: PromptContext): StructuredPrompt<{
  target: string;
  reasoning: string;
}> {
  if (ctx.player.role !== "werewolf") {
    throw new Error("buildKillPrompt called for non-wolf player");
  }
  const wolfIds = new Set([
    ctx.player.id,
    ...(ctx.coWolves ?? []).map((p) => p.id),
  ]);
  const validTargets = ctx.livingPlayers
    .filter((p) => !wolfIds.has(p.id))
    .map((p) => p.name);

  const system = buildPersonaSystem(ctx);
  const user = `${buildSharedContext(ctx)}

It is night. Pick one non-wolf player to kill. Consider:
- Who is most dangerous to the pack (likely Seer, Doctor, or sharp accuser)?
- Who can you eliminate without obvious blowback?

Respond with JSON: { "target": "<player name>", "reasoning": "<one sentence>" }`;

  const zodSchema = z.object({
    target: z.enum(validTargets as [string, ...string[]]),
    reasoning: z.string(),
  });
  const jsonSchema = {
    type: "object",
    properties: { target: targetEnum(validTargets), reasoning: { type: "string" } },
    required: ["target", "reasoning"],
  };
  return { system, user, jsonSchema, zodSchema };
}

export function buildSavePrompt(
  ctx: PromptContext,
): StructuredPrompt<{ target: string; reasoning: string }> {
  if (ctx.player.role !== "doctor") {
    throw new Error("buildSavePrompt called for non-doctor player");
  }
  const blocked = ctx.blockedSavePlayer;
  const validTargets = ctx.livingPlayers
    .filter((p) => p.id !== blocked)
    .map((p) => p.name);

  const system = buildPersonaSystem(ctx);
  const blockedHint = blocked
    ? `\n\nNote: you saved one player last night and cannot save them again tonight.`
    : "";
  const user = `${buildSharedContext(ctx)}${blockedHint}

It is night. Pick one player (including yourself) to protect from the wolves' attack. Choose someone you suspect the wolves will target.

Respond with JSON: { "target": "<player name>", "reasoning": "<one sentence>" }`;

  const zodSchema = z.object({
    target: z.enum(validTargets as [string, ...string[]]),
    reasoning: z.string(),
  });
  const jsonSchema = {
    type: "object",
    properties: { target: targetEnum(validTargets), reasoning: { type: "string" } },
    required: ["target", "reasoning"],
  };
  return { system, user, jsonSchema, zodSchema };
}

export function buildInvestigatePrompt(
  ctx: PromptContext,
): StructuredPrompt<{ target: string; reasoning: string }> {
  if (ctx.player.role !== "seer") {
    throw new Error("buildInvestigatePrompt called for non-seer player");
  }
  const validTargets = ctx.livingPlayers
    .filter((p) => p.id !== ctx.player.id)
    .map((p) => p.name);

  const system = buildPersonaSystem(ctx);
  const user = `${buildSharedContext(ctx)}

It is night. Pick one player to investigate. You will learn whether they are a werewolf. Choose carefully — past investigations are in your private notes.

Respond with JSON: { "target": "<player name>", "reasoning": "<one sentence>" }`;

  const zodSchema = z.object({
    target: z.enum(validTargets as [string, ...string[]]),
    reasoning: z.string(),
  });
  const jsonSchema = {
    type: "object",
    properties: { target: targetEnum(validTargets), reasoning: { type: "string" } },
    required: ["target", "reasoning"],
  };
  return { system, user, jsonSchema, zodSchema };
}

export function buildDayTalkPrompt(ctx: PromptContext, round: number): TextPrompt {
  const system = buildPersonaSystem(ctx);
  const roleNudge =
    ctx.player.role === "werewolf"
      ? "Remember: deflect suspicion from yourself and the pack. Cast doubt on a villager. Agree with safe accusations against villagers when convenient. Never reveal your role."
      : ctx.player.role === "seer"
        ? "Decide whether to share your investigation results — you may persuade more by speaking up, but you'll get killed tomorrow night."
        : ctx.player.role === "doctor"
          ? "Be careful not to reveal your role. The wolves will target you if they find out."
          : "Look for inconsistencies in what others are saying. Question suspicious behavior.";
  const user = `${buildSharedContext(ctx)}

It is the day debate, round ${round}. It is your turn to speak.

${roleNudge}

Reply with ONLY your spoken statement — one or two short sentences. No quotes, no narration, no JSON, no markdown.`;
  return { system, user };
}

export function buildVotePrompt(
  ctx: PromptContext,
): StructuredPrompt<{ target: string; reasoning: string }> {
  const validTargets = ctx.livingPlayers
    .filter((p) => p.id !== ctx.player.id)
    .map((p) => p.name);

  const system = buildPersonaSystem(ctx);
  const user = `${buildSharedContext(ctx)}

It is time to vote. Pick one living player (not yourself) to eliminate. Consider every accusation, defense, and behavior so far.

Respond with JSON: { "target": "<player name>", "reasoning": "<one sentence>" }`;

  const zodSchema = z.object({
    target: z.enum(validTargets as [string, ...string[]]),
    reasoning: z.string(),
  });
  const jsonSchema = {
    type: "object",
    properties: { target: targetEnum(validTargets), reasoning: { type: "string" } },
    required: ["target", "reasoning"],
  };
  return { system, user, jsonSchema, zodSchema };
}

export function nameToId(
  name: string,
  livingPlayers: PublicPlayerInfo[],
): string | null {
  const match = livingPlayers.find((p) => p.name === name);
  return match ? match.id : null;
}

// Re-export the PromptContext type alias used by callers
export type { Persona };
