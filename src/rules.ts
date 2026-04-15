import type {
  DoctorSaveHistory,
  Player,
  ResolveNightInput,
  ResolveNightResult,
  Role,
  TallyResult,
  Winner,
} from "./types";

const ROLE_DISTRIBUTION: Role[] = [
  "werewolf",
  "werewolf",
  "seer",
  "doctor",
  "villager",
  "villager",
  "villager",
];

export const PLAYERS_PER_GAME = ROLE_DISTRIBUTION.length;

function hashStringToInt(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export function makeRng(seed: string): () => number {
  let state = hashStringToInt(seed) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function seededShuffle<T>(arr: T[], seed: string): T[] {
  const out = arr.slice();
  const rng = makeRng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

export function assignRoles(
  seed: string,
  playerIds: string[],
): Map<string, Role> {
  if (playerIds.length !== PLAYERS_PER_GAME) {
    throw new Error(
      `assignRoles: expected ${PLAYERS_PER_GAME} players, got ${playerIds.length}`,
    );
  }
  const shuffledRoles = seededShuffle(ROLE_DISTRIBUTION, seed);
  const out = new Map<string, Role>();
  for (let i = 0; i < playerIds.length; i++) {
    out.set(playerIds[i], shuffledRoles[i]);
  }
  return out;
}

export function winner(players: Player[]): Winner | null {
  const livingWolves = players.filter((p) => p.alive && p.role === "werewolf");
  const livingNonWolves = players.filter(
    (p) => p.alive && p.role !== "werewolf",
  );
  if (livingWolves.length === 0) return "village";
  if (livingWolves.length >= livingNonWolves.length) return "wolves";
  return null;
}

export function tallyVotes(
  votes: Map<string, string>,
  livingIds: string[],
): TallyResult {
  const counts: Record<string, number> = {};
  const livingSet = new Set(livingIds);
  for (const [voterId, targetId] of votes) {
    if (!livingSet.has(voterId)) continue;
    if (!livingSet.has(targetId)) continue;
    if (!targetId) continue;
    counts[targetId] = (counts[targetId] ?? 0) + 1;
  }
  let max = 0;
  for (const count of Object.values(counts)) {
    if (count > max) max = count;
  }
  const winners: string[] = [];
  if (max > 0) {
    for (const [id, count] of Object.entries(counts)) {
      if (count === max) winners.push(id);
    }
  }
  winners.sort();
  return { winners, counts };
}

export function resolveTie(
  tied: string[],
  secondVotes: Map<string, string>,
): TallyResult {
  return tallyVotes(secondVotes, tied);
}

export function finalTieBreak(tied: string[], seed: string): string {
  if (tied.length === 0) {
    throw new Error("finalTieBreak: empty tied list");
  }
  const sorted = [...tied].sort();
  const rng = makeRng(seed);
  return sorted[Math.floor(rng() * sorted.length)];
}

export function resolveNight(input: ResolveNightInput): ResolveNightResult {
  const { killTarget, saveTarget } = input;
  if (!killTarget) return { died: null, saved: false };
  if (saveTarget && saveTarget === killTarget) {
    return { died: null, saved: true };
  }
  return { died: killTarget, saved: false };
}

export function nextDoctorSaveBlocked(
  history: DoctorSaveHistory[],
  day: number,
): string | null {
  const previous = history.find((h) => h.turn === day - 1);
  return previous ? previous.targetId : null;
}

export function pickWolfKill(
  wolfChoices: { wolfId: string; target: string }[],
): string | null {
  if (wolfChoices.length === 0) return null;
  const counts = new Map<string, number>();
  for (const c of wolfChoices) counts.set(c.target, (counts.get(c.target) ?? 0) + 1);
  let max = 0;
  for (const count of counts.values()) if (count > max) max = count;
  const tied: { wolfId: string; target: string }[] = [];
  for (const c of wolfChoices) if (counts.get(c.target) === max) tied.push(c);
  tied.sort((a, b) => a.wolfId.localeCompare(b.wolfId));
  return tied[0].target;
}
