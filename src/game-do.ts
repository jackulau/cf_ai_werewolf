import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { generateStreamedText, generateStructured, generateText, LLMValidationError } from "./llm";
import { pickPersonas } from "./personas";
import {
  assignRoles,
  finalTieBreak,
  makeRng,
  nextDoctorSaveBlocked,
  pickWolfKill,
  PLAYERS_PER_GAME,
  resolveNight,
  resolveTie,
  seededShuffle,
  tallyVotes,
  winner as computeWinner,
} from "./rules";
import {
  buildDayTalkPrompt,
  buildInvestigatePrompt,
  buildKillPrompt,
  buildSavePrompt,
  buildVotePrompt,
  type PromptContext,
  type PublicPlayerInfo,
} from "./prompts";
import type {
  LogEntry,
  LogEntryType,
  NightAction,
  NightActionType,
  Persona,
  Phase,
  Player,
  PrivateMemoryEvent,
  PrivateMemoryEventType,
  Role,
  Winner,
} from "./types";
import type { ClientMessage, ServerMessage } from "./ws";

const KV_KEYS = {
  phase: "phase",
  turn: "turn",
  round: "round",
  gameId: "gameId",
  humanPlayerId: "humanPlayerId",
  seed: "seed",
  winner: "winner",
  logSummary: "log_summary",
  lastSummarizedSeq: "last_summarized_seq",
  errorMessage: "error_message",
} as const;

type RawPlayerRow = {
  id: string;
  name: string;
  bio: string;
  role: Role;
  is_human: number;
  alive: number;
  joined_turn: number;
};

type RawLogRow = {
  seq: number;
  turn: number;
  phase: Phase;
  type: LogEntryType;
  actor_id: string | null;
  target_id: string | null;
  content: string;
  ts: number;
};

type RawMemoryRow = {
  seq: number;
  player_id: string;
  turn: number;
  type: PrivateMemoryEventType;
  target_id: string | null;
  content: string;
  ts: number;
};

const RECENT_LOG_LIMIT = 40;
const SUMMARIZE_TRIGGER_AFTER = 40;
const SUMMARIZE_RETRIGGER_DELTA = 20;

export class GameDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.initSchema();
    });
  }

  private initSchema(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      bio TEXT NOT NULL,
      role TEXT NOT NULL,
      is_human INTEGER NOT NULL,
      alive INTEGER NOT NULL DEFAULT 1,
      joined_turn INTEGER NOT NULL DEFAULT 0
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS public_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      turn INTEGER NOT NULL,
      phase TEXT NOT NULL,
      type TEXT NOT NULL,
      actor_id TEXT,
      target_id TEXT,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS private_memory (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL,
      turn INTEGER NOT NULL,
      type TEXT NOT NULL,
      target_id TEXT,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS votes (
      turn INTEGER NOT NULL,
      voter_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      PRIMARY KEY (turn, voter_id)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS night_actions (
      turn INTEGER NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id TEXT NOT NULL,
      PRIMARY KEY (turn, actor_id)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS doctor_save_history (
      turn INTEGER PRIMARY KEY,
      target_id TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS aiSpeakRecord (
      turn INTEGER NOT NULL,
      round INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (turn, round, player_id)
    )`);
  }

  // ─── KV-style state helpers ──────────────────────────────────────────────
  private async kvGet<T>(key: string): Promise<T | undefined> {
    return await this.ctx.storage.get<T>(key);
  }
  private async kvPut<T>(key: string, value: T): Promise<void> {
    await this.ctx.storage.put(key, value);
  }

  /** Test-only helper: set a KV state key directly. */
  async kvPutTest(key: string, value: unknown): Promise<void> {
    await this.ctx.storage.put(key, value);
  }

  // ─── Player helpers ──────────────────────────────────────────────────────
  private allPlayers(): Player[] {
    const rows = this.ctx.storage.sql
      .exec<RawPlayerRow>(`SELECT * FROM players ORDER BY joined_turn ASC, id ASC`)
      .toArray();
    return rows.map(rowToPlayer);
  }
  private livingPlayers(): Player[] {
    return this.allPlayers().filter((p) => p.alive);
  }
  private playerById(id: string): Player | null {
    const row = this.ctx.storage.sql
      .exec<RawPlayerRow>(`SELECT * FROM players WHERE id = ? LIMIT 1`, id)
      .toArray()[0];
    return row ? rowToPlayer(row) : null;
  }
  private toPublicInfo(p: Player): PublicPlayerInfo {
    return { id: p.id, name: p.name, bio: p.bio };
  }

  // ─── Log helpers ─────────────────────────────────────────────────────────
  private appendPublicLog(
    type: LogEntryType,
    content: string,
    turn: number,
    phase: Phase,
    actorId: string | null = null,
    targetId: string | null = null,
  ): LogEntry {
    const ts = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO public_log (turn, phase, type, actor_id, target_id, content, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      turn, phase, type, actorId, targetId, content, ts,
    );
    const row = this.ctx.storage.sql
      .exec<RawLogRow>(`SELECT * FROM public_log ORDER BY seq DESC LIMIT 1`)
      .toArray()[0];
    return rowToLog(row);
  }
  private appendMemory(
    playerId: string,
    type: PrivateMemoryEventType,
    content: string,
    turn: number,
    targetId: string | null = null,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO private_memory (player_id, turn, type, target_id, content, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
      playerId, turn, type, targetId, content, Date.now(),
    );
  }
  private recentPublicLog(limit = RECENT_LOG_LIMIT): LogEntry[] {
    const rows = this.ctx.storage.sql
      .exec<RawLogRow>(
        `SELECT * FROM public_log ORDER BY seq DESC LIMIT ?`,
        limit,
      )
      .toArray();
    return rows.reverse().map(rowToLog);
  }
  private memoryFor(playerId: string): PrivateMemoryEvent[] {
    const rows = this.ctx.storage.sql
      .exec<RawMemoryRow>(
        `SELECT * FROM private_memory WHERE player_id = ? ORDER BY seq ASC`,
        playerId,
      )
      .toArray();
    return rows.map(rowToMemory);
  }

  // ─── Public RPC: createGame ──────────────────────────────────────────────
  async createGame(
    seed: string,
    humanName: string,
    gameId: string,
  ): Promise<{ gameId: string; humanPlayerId: string; role: Role; players: PublicPlayerInfo[] }> {
    const existing = await this.kvGet<string>(KV_KEYS.gameId);
    if (existing) {
      const role = (await this.playerByHuman())?.role ?? "villager";
      return {
        gameId: existing,
        humanPlayerId: (await this.kvGet<string>(KV_KEYS.humanPlayerId)) ?? "",
        role,
        players: this.allPlayers().map((p) => this.toPublicInfo(p)),
      };
    }

    if (!humanName || humanName.trim().length === 0) {
      throw new Error("humanName required");
    }

    const personas = pickPersonas(seed, PLAYERS_PER_GAME - 1);
    const humanPlayerId = "human";
    const ids = [humanPlayerId, ...personas.map((p) => p.id)];
    const roleMap = assignRoles(seed, ids);

    // Insert players
    this.ctx.storage.sql.exec(
      `INSERT INTO players (id, name, bio, role, is_human, joined_turn) VALUES (?, ?, ?, ?, 1, 0)`,
      humanPlayerId,
      humanName.trim(),
      "A traveler newly arrived in the village.",
      roleMap.get(humanPlayerId)!,
    );
    for (const p of personas) {
      this.ctx.storage.sql.exec(
        `INSERT INTO players (id, name, bio, role, is_human, joined_turn) VALUES (?, ?, ?, ?, 0, 0)`,
        p.id,
        p.name,
        p.bio,
        roleMap.get(p.id)!,
      );
    }

    await this.kvPut(KV_KEYS.gameId, gameId);
    await this.kvPut(KV_KEYS.humanPlayerId, humanPlayerId);
    await this.kvPut(KV_KEYS.seed, seed);
    await this.kvPut(KV_KEYS.phase, "lobby" as Phase);
    await this.kvPut(KV_KEYS.turn, 0);
    await this.kvPut(KV_KEYS.round, 0);
    await this.kvPut(KV_KEYS.lastSummarizedSeq, 0);

    this.appendPublicLog(
      "system",
      `A new game begins. Seven villagers gather in the square. Among them, two are werewolves.`,
      0,
      "lobby",
    );

    return {
      gameId,
      humanPlayerId,
      role: roleMap.get(humanPlayerId)!,
      players: this.allPlayers().map((p) => this.toPublicInfo(p)),
    };
  }

  private async playerByHuman(): Promise<Player | null> {
    const id = await this.kvGet<string>(KV_KEYS.humanPlayerId);
    return id ? this.playerById(id) : null;
  }

  // ─── Public RPC: getPublicState ──────────────────────────────────────────
  async getPublicState(): Promise<{
    gameId: string | null;
    phase: Phase;
    turn: number;
    round: number;
    winner: Winner | null;
    players: { id: string; name: string; bio: string; alive: boolean; role?: Role }[];
    log: LogEntry[];
    logSummary: string | null;
  }> {
    const phase = (await this.kvGet<Phase>(KV_KEYS.phase)) ?? "lobby";
    const turn = (await this.kvGet<number>(KV_KEYS.turn)) ?? 0;
    const round = (await this.kvGet<number>(KV_KEYS.round)) ?? 0;
    const winner = (await this.kvGet<Winner>(KV_KEYS.winner)) ?? null;
    const gameId = (await this.kvGet<string>(KV_KEYS.gameId)) ?? null;
    const logSummary = (await this.kvGet<string>(KV_KEYS.logSummary)) ?? null;
    const players = this.allPlayers().map((p) => {
      const base = { id: p.id, name: p.name, bio: p.bio, alive: p.alive };
      if (!p.alive || phase === "ended") {
        return { ...base, role: p.role };
      }
      return base;
    });
    return {
      gameId,
      phase,
      turn,
      round,
      winner,
      players,
      log: this.recentPublicLog(),
      logSummary,
    };
  }

  // ─── Public RPC: getPlayerView ───────────────────────────────────────────
  async getPlayerView(playerId: string): Promise<{
    role: Role;
    privateMemory: PrivateMemoryEvent[];
    knownWolves: PublicPlayerInfo[];
  } | null> {
    const player = this.playerById(playerId);
    if (!player) return null;
    let knownWolves: PublicPlayerInfo[] = [];
    if (player.role === "werewolf") {
      knownWolves = this.allPlayers()
        .filter((p) => p.role === "werewolf" && p.id !== playerId)
        .map((p) => this.toPublicInfo(p));
    }
    return {
      role: player.role,
      privateMemory: this.memoryFor(playerId),
      knownWolves,
    };
  }

  // ─── Public RPC: setPhase ────────────────────────────────────────────────
  async setPhase(phase: Phase, turn?: number, round?: number): Promise<void> {
    await this.kvPut(KV_KEYS.phase, phase);
    if (typeof turn === "number") await this.kvPut(KV_KEYS.turn, turn);
    if (typeof round === "number") await this.kvPut(KV_KEYS.round, round);
    const t = (await this.kvGet<number>(KV_KEYS.turn)) ?? 0;
    const r = (await this.kvGet<number>(KV_KEYS.round)) ?? 0;
    this.appendPublicLog(
      "phase-change",
      `Phase: ${phase}${phase === "day-debate" ? ` (round ${r})` : ""}`,
      t,
      phase,
    );
    this.broadcast({ type: "phase", phase, turn: t });
  }

  // ─── Public RPC: submitVote (idempotent upsert) ──────────────────────────
  async submitVote(playerId: string, target: string): Promise<void> {
    const turn = (await this.kvGet<number>(KV_KEYS.turn)) ?? 0;
    const player = this.playerById(playerId);
    const targetPlayer = this.playerById(target);
    if (!player || !player.alive) throw new Error(`Player ${playerId} not alive`);
    if (!targetPlayer || !targetPlayer.alive) throw new Error(`Target ${target} not a living player`);
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO votes (turn, voter_id, target_id) VALUES (?, ?, ?)`,
      turn, playerId, target,
    );
    this.appendMemory(playerId, "self-vote", `I voted for ${targetPlayer.name}.`, turn, target);
  }

  // ─── Public RPC: submitNightAction (idempotent upsert) ───────────────────
  async submitNightAction(
    playerId: string,
    action: NightActionType,
    target: string,
  ): Promise<void> {
    const turn = (await this.kvGet<number>(KV_KEYS.turn)) ?? 0;
    const player = this.playerById(playerId);
    if (!player || !player.alive) throw new Error(`Player ${playerId} not alive`);
    // Role-allowed action check
    if (action === "kill" && player.role !== "werewolf") {
      throw new Error(`Player ${playerId} is not a werewolf, cannot kill`);
    }
    if (action === "save" && player.role !== "doctor") {
      throw new Error(`Player ${playerId} is not the doctor, cannot save`);
    }
    if (action === "investigate" && player.role !== "seer") {
      throw new Error(`Player ${playerId} is not the seer, cannot investigate`);
    }
    const targetPlayer = this.playerById(target);
    if (!targetPlayer || !targetPlayer.alive) {
      throw new Error(`Target ${target} not a living player`);
    }
    if (action === "save") {
      const blocked = await this.blockedSavePlayer(turn);
      if (blocked === target) {
        throw new Error(`Doctor cannot save the same player two nights in a row`);
      }
    }
    if (action === "investigate" && playerId === target) {
      throw new Error(`Seer cannot investigate self`);
    }
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO night_actions (turn, actor_id, action, target_id) VALUES (?, ?, ?, ?)`,
      turn, playerId, action, target,
    );
    if (action === "save") {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO doctor_save_history (turn, target_id) VALUES (?, ?)`,
        turn, target,
      );
      this.appendMemory(playerId, "doctor-save-decision", `I chose to protect ${targetPlayer.name}.`, turn, target);
    }
    if (action === "kill") {
      this.appendMemory(playerId, "wolf-kill-decision", `I voted to kill ${targetPlayer.name}.`, turn, target);
    }
    if (action === "investigate") {
      // Server-side dedup: skip if we've already recorded this exact
      // investigation. Prevents duplicate rows if a workflow step
      // partially completed and got retried.
      const existing = this.ctx.storage.sql
        .exec(
          `SELECT 1 FROM private_memory WHERE player_id = ? AND type = 'seer-check-result' AND turn = ? AND target_id = ? LIMIT 1`,
          playerId, turn, target,
        )
        .toArray();
      if (existing.length === 0) {
        const result = targetPlayer.role === "werewolf" ? "is a werewolf" : "is NOT a werewolf";
        this.appendMemory(
          playerId,
          "seer-check-result",
          `${targetPlayer.name} ${result} (investigated turn ${turn}).`,
          turn,
          target,
        );
      }
    }
  }

  async submitNightActionRandom(
    playerId: string,
    action: NightActionType,
  ): Promise<void> {
    const turn = (await this.kvGet<number>(KV_KEYS.turn)) ?? 0;
    const seed = (await this.kvGet<string>(KV_KEYS.seed)) ?? "";
    const player = this.playerById(playerId);
    if (!player) return;
    let pool = this.livingPlayers();
    if (action === "kill") pool = pool.filter((p) => p.role !== "werewolf");
    if (action === "investigate") pool = pool.filter((p) => p.id !== playerId);
    if (action === "save") {
      const blocked = await this.blockedSavePlayer(turn);
      if (blocked) pool = pool.filter((p) => p.id !== blocked);
    }
    if (pool.length === 0) return;
    const rng = makeRng(`${seed}|${playerId}|${turn}|${action}`);
    const pick = pool[Math.floor(rng() * pool.length)];
    await this.submitNightAction(playerId, action, pick.id);
    this.appendMemory(playerId, "llm-fallback", `Used random fallback for ${action}: ${pick.name}.`, turn, pick.id);
  }

  private async blockedSavePlayer(currentTurn: number): Promise<string | null> {
    const rows = this.ctx.storage.sql
      .exec<{ turn: number; target_id: string }>(`SELECT * FROM doctor_save_history`)
      .toArray();
    return nextDoctorSaveBlocked(
      rows.map((r) => ({ turn: r.turn, targetId: r.target_id })),
      currentTurn,
    );
  }

  // ─── Public RPC: submitDayMessage (human chat) ───────────────────────────
  async submitDayMessage(playerId: string, content: string): Promise<void> {
    const turn = (await this.kvGet<number>(KV_KEYS.turn)) ?? 0;
    const phase = (await this.kvGet<Phase>(KV_KEYS.phase)) ?? "lobby";
    const player = this.playerById(playerId);
    if (!player || !player.alive) throw new Error(`Player ${playerId} not alive`);
    const trimmed = content.trim().slice(0, 500);
    if (!trimmed) return;
    const stamped = `${player.name}: ${trimmed}`;
    const entry = this.appendPublicLog("speech", stamped, turn, phase, playerId);
    this.appendMemory(playerId, "self-statement", stamped, turn);
    this.broadcastLog(entry, player.name);
  }

  // ─── Public RPC: AI take night action ────────────────────────────────────
  async aiTakeNightAction(playerId: string): Promise<void> {
    const turn = (await this.kvGet<number>(KV_KEYS.turn)) ?? 0;
    // Idempotency: if already recorded, skip (no activity broadcast for no-op)
    const existing = this.ctx.storage.sql
      .exec(`SELECT 1 FROM night_actions WHERE turn = ? AND actor_id = ? LIMIT 1`, turn, playerId)
      .toArray();
    if (existing.length > 0) return;

    const player = this.playerById(playerId);
    if (!player || !player.alive) return;
    if (player.role === "villager") return;

    const activityAction: "kill" | "save" | "investigate" =
      player.role === "werewolf" ? "kill" :
      player.role === "seer" ? "investigate" : "save";
    this.broadcast({
      type: "activity",
      playerId: player.id,
      playerName: player.name,
      status: "thinking",
      action: activityAction,
      turn,
    });

    try {
      await this.aiTakeNightActionInner(player, turn);
    } finally {
      this.broadcast({
        type: "activity",
        playerId: player.id,
        playerName: player.name,
        status: "done",
        action: activityAction,
        turn,
      });
    }
  }

  private async aiTakeNightActionInner(player: Player, turn: number): Promise<void> {
    const playerId = player.id;
    const ctx = await this.buildPromptContext(playerId);
    let target: string | null = null;
    let action: NightActionType;

    try {
      if (player.role === "werewolf") {
        const prompt = buildKillPrompt(ctx);
        const out = await generateStructured(
          this.env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> },
          prompt.system,
          prompt.user,
          prompt.zodSchema,
          prompt.jsonSchema,
        );
        target = this.nameToId(out.target);
        action = "kill";
      } else if (player.role === "seer") {
        const prompt = buildInvestigatePrompt(ctx);
        const out = await generateStructured(
          this.env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> },
          prompt.system, prompt.user, prompt.zodSchema, prompt.jsonSchema,
        );
        target = this.nameToId(out.target);
        action = "investigate";
      } else {
        const prompt = buildSavePrompt(ctx);
        const out = await generateStructured(
          this.env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> },
          prompt.system, prompt.user, prompt.zodSchema, prompt.jsonSchema,
        );
        target = this.nameToId(out.target);
        action = "save";
      }
    } catch (e) {
      const fallbackAction: NightActionType =
        player.role === "werewolf" ? "kill" :
        player.role === "seer" ? "investigate" : "save";
      await this.submitNightActionRandom(playerId, fallbackAction);
      return;
    }

    if (!target) {
      const fallbackAction: NightActionType =
        player.role === "werewolf" ? "kill" :
        player.role === "seer" ? "investigate" : "save";
      await this.submitNightActionRandom(playerId, fallbackAction);
      return;
    }
    try {
      await this.submitNightAction(playerId, action, target);
    } catch {
      const fallbackAction: NightActionType =
        player.role === "werewolf" ? "kill" :
        player.role === "seer" ? "investigate" : "save";
      await this.submitNightActionRandom(playerId, fallbackAction);
    }
  }

  // ─── Public RPC: AI speak (day debate) ───────────────────────────────────
  async aiSpeak(playerId: string, round: number): Promise<void> {
    const turn = (await this.kvGet<number>(KV_KEYS.turn)) ?? 0;
    // Idempotency check — no activity for a no-op repeat
    const existing = this.ctx.storage.sql
      .exec(`SELECT 1 FROM aiSpeakRecord WHERE turn = ? AND round = ? AND player_id = ? LIMIT 1`,
            turn, round, playerId)
      .toArray();
    if (existing.length > 0) return;

    const player = this.playerById(playerId);
    if (!player || !player.alive) return;

    this.broadcast({
      type: "activity",
      playerId: player.id,
      playerName: player.name,
      status: "thinking",
      action: "speak",
      turn,
    });

    try {
      await this.aiSpeakInner(player, turn, round);
    } finally {
      this.broadcast({
        type: "activity",
        playerId: player.id,
        playerName: player.name,
        status: "done",
        action: "speak",
        turn,
      });
    }
  }

  private async aiSpeakInner(player: Player, turn: number, round: number): Promise<void> {
    const playerId = player.id;
    const ctx = await this.buildPromptContext(playerId);
    let say: string;
    try {
      const prompt = buildDayTalkPrompt(ctx, round);
      // Streaming speech: broadcast log-delta chunks as they arrive so UI
      // shows tokens appearing in real-time. The accumulated text is still
      // written as a single authoritative public_log entry at the end.
      let accumulated = "";
      let seq = -1;
      await generateStreamedText(
        this.env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> },
        prompt.system,
        prompt.user,
        (chunk) => {
          if (!chunk) return;
          accumulated += chunk;
          if (seq < 0) {
            // First chunk — allocate a sequence number by reading current max+1
            const row = this.ctx.storage.sql
              .exec<{ m: number | null }>(`SELECT MAX(seq) AS m FROM public_log`)
              .toArray()[0];
            seq = ((row?.m ?? 0) as number) + 1;
          }
          this.broadcast({
            type: "log-delta",
            seq,
            playerId: player.id,
            playerName: player.name,
            delta: chunk,
          });
        },
        { maxTokens: 200 },
      );
      say = accumulated;
    } catch (e) {
      say = "I'm not sure what to make of all this.";
    }

    say = (say ?? "").trim().slice(0, 400) || "(remains silent)";
    const stamped = `${player.name}: ${say}`;
    const entry = this.appendPublicLog("speech", stamped, turn, "day-debate", playerId);
    this.appendMemory(playerId, "self-statement", stamped, turn);
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO aiSpeakRecord (turn, round, player_id, content) VALUES (?, ?, ?, ?)`,
      turn, round, playerId, stamped,
    );
    this.broadcastLog(entry, player.name);
  }

  // ─── Public RPC: AI vote ─────────────────────────────────────────────────
  async aiVote(playerId: string): Promise<void> {
    const turn = (await this.kvGet<number>(KV_KEYS.turn)) ?? 0;
    // Idempotency — no activity broadcast for no-op repeat
    const existing = this.ctx.storage.sql
      .exec(`SELECT 1 FROM votes WHERE turn = ? AND voter_id = ? LIMIT 1`, turn, playerId)
      .toArray();
    if (existing.length > 0) return;

    const player = this.playerById(playerId);
    if (!player || !player.alive) return;

    this.broadcast({
      type: "activity",
      playerId: player.id,
      playerName: player.name,
      status: "thinking",
      action: "vote",
      turn,
    });
    try {
      await this.aiVoteInner(player, turn);
    } finally {
      this.broadcast({
        type: "activity",
        playerId: player.id,
        playerName: player.name,
        status: "done",
        action: "vote",
        turn,
      });
    }
  }

  private async aiVoteInner(player: Player, turn: number): Promise<void> {
    const playerId = player.id;
    const ctx = await this.buildPromptContext(playerId);
    let targetId: string | null = null;
    try {
      const prompt = buildVotePrompt(ctx);
      const out = await generateStructured(
        this.env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> },
        prompt.system, prompt.user, prompt.zodSchema, prompt.jsonSchema,
      );
      targetId = this.nameToId(out.target);
    } catch {}

    if (!targetId) {
      // Random fallback excluding self
      const seed = (await this.kvGet<string>(KV_KEYS.seed)) ?? "";
      const pool = this.livingPlayers().filter((p) => p.id !== playerId);
      if (pool.length === 0) return;
      const rng = makeRng(`${seed}|${playerId}|vote|${turn}`);
      targetId = pool[Math.floor(rng() * pool.length)].id;
      this.appendMemory(playerId, "llm-fallback", `Used random vote fallback.`, turn, targetId);
    }
    try {
      await this.submitVote(playerId, targetId);
    } catch {}
  }

  // ─── Public RPC: resolveNight ────────────────────────────────────────────
  async resolveNight(): Promise<{ died: string | null; saved: boolean }> {
    const turn = (await this.kvGet<number>(KV_KEYS.turn)) ?? 0;
    // Idempotency: if a death/no-death log entry already exists for this turn-night, skip
    const already = this.ctx.storage.sql
      .exec<{ seq: number }>(
        `SELECT seq FROM public_log WHERE turn = ? AND type = 'death' LIMIT 1`,
        turn,
      )
      .toArray();
    if (already.length > 0) {
      const row = this.ctx.storage.sql
        .exec<{ target_id: string | null }>(
          `SELECT target_id FROM public_log WHERE turn = ? AND type = 'death' LIMIT 1`,
          turn,
        )
        .toArray()[0];
      return { died: row?.target_id ?? null, saved: row?.target_id === null };
    }

    const wolfActions = this.ctx.storage.sql
      .exec<{ actor_id: string; target_id: string }>(
        `SELECT actor_id, target_id FROM night_actions WHERE turn = ? AND action = 'kill'`,
        turn,
      )
      .toArray();
    const wolfChoices = wolfActions.map((r) => ({ wolfId: r.actor_id, target: r.target_id }));
    const killTarget = pickWolfKill(wolfChoices);

    const saveAction = this.ctx.storage.sql
      .exec<{ target_id: string }>(
        `SELECT target_id FROM night_actions WHERE turn = ? AND action = 'save' LIMIT 1`,
        turn,
      )
      .toArray()[0];
    const saveTarget = saveAction?.target_id ?? null;

    const result = resolveNight({ killTarget, saveTarget });

    if (result.died) {
      this.ctx.storage.sql.exec(`UPDATE players SET alive = 0 WHERE id = ?`, result.died);
      const victim = this.playerById(result.died)!;
      this.appendPublicLog(
        "death",
        `${victim.name} was found dead in the morning.`,
        turn,
        "resolution",
        null,
        result.died,
      );
      this.broadcast({ type: "death", victimName: victim.name, turn });
    } else {
      this.appendPublicLog(
        "system",
        `The village wakes to find no one dead.`,
        turn,
        "resolution",
      );
    }

    // Notify seer (privately, if human) — done via getPlayerView in the UI
    return result;
  }

  // ─── Public RPC: resolveVote (handles tie + revote + final tiebreak) ─────
  async resolveVote(): Promise<{ executed: string | null; counts: Record<string, number> }> {
    const turn = (await this.kvGet<number>(KV_KEYS.turn)) ?? 0;
    const seed = (await this.kvGet<string>(KV_KEYS.seed)) ?? "";

    // Idempotency: if vote-result already logged this turn, return it
    const already = this.ctx.storage.sql
      .exec<{ target_id: string | null; content: string }>(
        `SELECT target_id, content FROM public_log WHERE turn = ? AND type = 'vote-result' LIMIT 1`,
        turn,
      )
      .toArray();
    if (already.length > 0) {
      return { executed: already[0].target_id, counts: {} };
    }

    const livingIds = this.livingPlayers().map((p) => p.id);
    const voteRows = this.ctx.storage.sql
      .exec<{ voter_id: string; target_id: string }>(
        `SELECT voter_id, target_id FROM votes WHERE turn = ?`,
        turn,
      )
      .toArray();
    const votes = new Map(voteRows.map((r) => [r.voter_id, r.target_id]));
    const tally = tallyVotes(votes, livingIds);

    let executedId: string | null = null;
    let finalCounts = tally.counts;

    if (tally.winners.length === 1) {
      executedId = tally.winners[0];
    } else if (tally.winners.length > 1) {
      // Revote among tied
      const tied = tally.winners;
      const revote = new Map<string, string>();
      for (const voterId of livingIds) {
        if (tied.includes(voterId)) continue; // tied players don't vote in revote
        // Each non-tied living player picks one tied player at random (deterministic)
        const rng = makeRng(`${seed}|revote|${turn}|${voterId}`);
        revote.set(voterId, tied[Math.floor(rng() * tied.length)]);
      }
      const second = resolveTie(tied, revote);
      finalCounts = second.counts;
      if (second.winners.length === 1) {
        executedId = second.winners[0];
      } else {
        executedId = finalTieBreak(second.winners.length > 0 ? second.winners : tied, `${seed}|tiebreak|${turn}`);
      }
    }

    if (executedId) {
      this.ctx.storage.sql.exec(`UPDATE players SET alive = 0 WHERE id = ?`, executedId);
      const victim = this.playerById(executedId)!;
      this.appendPublicLog(
        "vote-result",
        `${victim.name} was eliminated by the village. They were a ${victim.role}.`,
        turn,
        "resolution",
        null,
        executedId,
      );
      this.broadcast({ type: "vote-result", executedName: victim.name, counts: finalCounts });
    } else {
      this.appendPublicLog(
        "vote-result",
        `No one was eliminated.`,
        turn,
        "resolution",
      );
      this.broadcast({ type: "vote-result", executedName: null, counts: finalCounts });
    }

    return { executed: executedId, counts: finalCounts };
  }

  // ─── Public RPC: currentWinner ───────────────────────────────────────────
  async currentWinner(): Promise<Winner | null> {
    const stored = await this.kvGet<Winner>(KV_KEYS.winner);
    if (stored) return stored;
    return computeWinner(this.allPlayers());
  }

  // ─── Public RPC: endGame ─────────────────────────────────────────────────
  async endGame(winner: Winner): Promise<void> {
    await this.kvPut(KV_KEYS.winner, winner);
    await this.kvPut(KV_KEYS.phase, "ended" as Phase);
    const reveals = this.allPlayers().map((p) => ({ name: p.name, role: p.role }));
    const turn = (await this.kvGet<number>(KV_KEYS.turn)) ?? 0;
    const banner =
      winner === "village"
        ? "The village has prevailed. The wolves are dead."
        : winner === "wolves"
          ? "The wolves win. The village is consumed."
          : "The game has ended in error.";
    this.appendPublicLog("game-over", banner, turn, "ended");
    this.broadcast({ type: "game-over", winner, reveals });
  }

  // ─── Public RPC: markGameErrored ─────────────────────────────────────────
  async markGameErrored(message: string): Promise<void> {
    await this.kvPut(KV_KEYS.errorMessage, message);
    await this.kvPut(KV_KEYS.winner, "error" as Winner);
    await this.kvPut(KV_KEYS.phase, "ended" as Phase);
    this.appendPublicLog(
      "game-over",
      `Game errored: ${message}`,
      (await this.kvGet<number>(KV_KEYS.turn)) ?? 0,
      "ended",
    );
    this.broadcast({ type: "game-error", message });
  }

  // ─── Public RPC: publicLogCount ──────────────────────────────────────────
  async publicLogCount(): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<{ c: number }>(`SELECT COUNT(*) AS c FROM public_log`)
      .toArray()[0];
    return row.c;
  }

  // ─── Public RPC: summarizeAndCacheLog (idempotent) ───────────────────────
  async summarizeAndCacheLog(): Promise<void> {
    const lastSummarizedSeq = (await this.kvGet<number>(KV_KEYS.lastSummarizedSeq)) ?? 0;
    const totalCount = await this.publicLogCount();
    if (totalCount <= SUMMARIZE_TRIGGER_AFTER) return;

    const recentRows = this.ctx.storage.sql
      .exec<RawLogRow>(`SELECT * FROM public_log ORDER BY seq DESC LIMIT ?`, RECENT_LOG_LIMIT)
      .toArray();
    const cutoffSeq = recentRows.length > 0 ? recentRows[recentRows.length - 1].seq : 0;
    if (cutoffSeq <= lastSummarizedSeq + SUMMARIZE_RETRIGGER_DELTA && lastSummarizedSeq > 0) return;

    const olderRows = this.ctx.storage.sql
      .exec<RawLogRow>(`SELECT * FROM public_log WHERE seq < ? ORDER BY seq ASC`, cutoffSeq)
      .toArray();
    if (olderRows.length === 0) return;
    const transcript = olderRows
      .map((r) => `[turn ${r.turn} ${r.phase}] ${r.actor_id ?? "system"}: ${r.content}`)
      .join("\n");

    let summary: string;
    try {
      summary = await generateText(
        this.env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> },
        "You summarize a Werewolf game log into 4-6 short bullet points capturing key accusations, deaths, and revealed roles. No fluff.",
        `Summarize:\n\n${transcript}`,
        { maxTokens: 400 },
      );
    } catch {
      summary = `(${olderRows.length} earlier events; summary unavailable)`;
    }
    await this.kvPut(KV_KEYS.logSummary, summary.trim());
    await this.kvPut(KV_KEYS.lastSummarizedSeq, cutoffSeq);
  }

  // ─── Public RPC: getLivingByRole ─────────────────────────────────────────
  async getLivingByRole(): Promise<{
    humanId: string;
    werewolves: Player[];
    seer: Player | null;
    doctor: Player | null;
    villagers: Player[];
    living: Player[];
    allPlayers: Player[];
  }> {
    const all = this.allPlayers();
    const living = all.filter((p) => p.alive);
    const werewolves = living.filter((p) => p.role === "werewolf");
    const seer = living.find((p) => p.role === "seer") ?? null;
    const doctor = living.find((p) => p.role === "doctor") ?? null;
    const villagers = living.filter((p) => p.role === "villager");
    const humanId = (await this.kvGet<string>(KV_KEYS.humanPlayerId)) ?? "";
    return { humanId, werewolves, seer, doctor, villagers, living, allPlayers: all };
  }

  // ─── Public RPC: shuffleSpeakers ─────────────────────────────────────────
  async shuffleSpeakers(seedSuffix: string): Promise<string[]> {
    const seed = (await this.kvGet<string>(KV_KEYS.seed)) ?? "";
    const livingIds = this.livingPlayers().map((p) => p.id);
    return seededShuffle(livingIds, `${seed}|${seedSuffix}`);
  }

  // ─── Internal: build prompt context for an AI player ─────────────────────
  private async buildPromptContext(playerId: string): Promise<PromptContext> {
    const player = this.playerById(playerId);
    if (!player) throw new Error(`Player ${playerId} not found`);
    const turn = (await this.kvGet<number>(KV_KEYS.turn)) ?? 0;
    const logSummary = (await this.kvGet<string>(KV_KEYS.logSummary)) ?? null;
    const all = this.allPlayers();
    const living = all.filter((p) => p.alive);
    const dead = all.filter((p) => !p.alive);
    const blocked = await this.blockedSavePlayer(turn);
    const coWolves =
      player.role === "werewolf"
        ? all.filter((p) => p.role === "werewolf" && p.id !== playerId).map((p) => this.toPublicInfo(p))
        : undefined;
    return {
      player: { id: player.id, name: player.name, bio: player.bio, role: player.role },
      livingPlayers: living.map((p) => this.toPublicInfo(p)),
      deadPlayers: dead.map((p) => this.toPublicInfo(p)),
      publicLog: this.recentPublicLog(),
      privateMemory: this.memoryFor(playerId),
      coWolves,
      blockedSavePlayer: blocked,
      turn,
      logSummary,
    };
  }

  private nameToId(name: string): string | null {
    const row = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM players WHERE name = ? LIMIT 1`, name)
      .toArray()[0];
    return row?.id ?? null;
  }

  // ─── WebSocket handling (hibernation API) ────────────────────────────────
  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const playerId = url.searchParams.get("playerId");
    if (!playerId) {
      return new Response("playerId required", { status: 400 });
    }

    // Replace existing connection for same playerId
    for (const existing of this.ctx.getWebSockets(playerId)) {
      try {
        existing.close(4001, "replaced by new connection");
      } catch {
        /* ignore */
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [playerId]);

    // Send hello
    const player = this.playerById(playerId);
    const gameId = (await this.kvGet<string>(KV_KEYS.gameId)) ?? "";
    if (player) {
      const hello: ServerMessage = {
        type: "hello",
        gameId,
        humanPlayerId: playerId,
        role: player.role,
      };
      try { server.send(JSON.stringify(hello)); } catch {}
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(text);
    } catch {
      try { ws.send(JSON.stringify({ type: "ack", ok: false, error: "invalid_json" })); } catch {}
      return;
    }

    const tags = this.ctx.getTags(ws);
    const playerId = tags[0];
    if (!playerId) return;

    const phase = (await this.kvGet<Phase>(KV_KEYS.phase)) ?? "lobby";
    const gameId = (await this.kvGet<string>(KV_KEYS.gameId)) ?? "";
    const turn = (await this.kvGet<number>(KV_KEYS.turn)) ?? 0;

    // Phase guard
    const phaseAllows = (
      msgType: ClientMessage["type"],
      currentPhase: Phase,
    ): boolean => {
      if (msgType === "start") return currentPhase === "lobby";
      if (msgType === "night-action") return currentPhase === "night";
      if (msgType === "say") return currentPhase === "day-debate";
      if (msgType === "vote") return currentPhase === "voting";
      return false;
    };

    if (!phaseAllows(parsed.type, phase)) {
      const m: ServerMessage = { type: "action-too-late", currentPhase: phase };
      try { ws.send(JSON.stringify(m)); } catch {}
      return;
    }

    try {
      switch (parsed.type) {
        case "start": {
          // The Worker entry creates the workflow; this is just an ack
          try { ws.send(JSON.stringify({ type: "ack", ok: true, for: "start" })); } catch {}
          break;
        }
        case "night-action": {
          const targetPlayer = this.playerById(parsed.target);
          if (!targetPlayer) throw new Error("invalid target");
          await this.submitNightAction(playerId, parsed.action, parsed.target);
          await this.notifyWorkflow(gameId, `human-night-${turn}-${playerId}`, {
            target: parsed.target,
          });
          try { ws.send(JSON.stringify({ type: "ack", ok: true, for: "night-action" })); } catch {}
          break;
        }
        case "say": {
          await this.submitDayMessage(playerId, parsed.content);
          const round = (await this.kvGet<number>(KV_KEYS.round)) ?? 1;
          await this.notifyWorkflow(gameId, `human-day-${turn}-${round}`, {
            content: parsed.content,
          });
          try { ws.send(JSON.stringify({ type: "ack", ok: true, for: "say" })); } catch {}
          break;
        }
        case "vote": {
          await this.submitVote(playerId, parsed.target);
          await this.notifyWorkflow(gameId, `human-vote-${turn}`, {
            target: parsed.target,
          });
          try { ws.send(JSON.stringify({ type: "ack", ok: true, for: "vote" })); } catch {}
          break;
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      try { ws.send(JSON.stringify({ type: "ack", ok: false, error: message })); } catch {}
    }
  }

  webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): void {
    try { ws.close(code, reason); } catch {}
  }

  private broadcast(message: ServerMessage): void {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(text); } catch {}
    }
  }

  private broadcastLog(entry: LogEntry, actorName: string | null): void {
    this.broadcast({
      type: "log",
      seq: entry.seq,
      turn: entry.turn,
      phase: entry.phase,
      logType: entry.type,
      actorName,
      content: entry.content,
    });
  }

  private async notifyWorkflow(
    gameId: string,
    eventType: string,
    payload: unknown,
  ): Promise<void> {
    if (!gameId) return;
    try {
      const instance = await this.env.GAME_WORKFLOW.get(gameId);
      await instance.sendEvent({ type: eventType, payload });
    } catch {
      // Workflow may not be running yet (e.g., lobby start) — fine
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function rowToPlayer(row: RawPlayerRow): Player {
  return {
    id: row.id,
    name: row.name,
    bio: row.bio,
    role: row.role,
    isHuman: row.is_human === 1,
    alive: row.alive === 1,
  };
}
function rowToLog(row: RawLogRow): LogEntry {
  return {
    seq: row.seq,
    turn: row.turn,
    phase: row.phase,
    type: row.type,
    actorId: row.actor_id,
    targetId: row.target_id,
    content: row.content,
    ts: row.ts,
  };
}
function rowToMemory(row: RawMemoryRow): PrivateMemoryEvent {
  return {
    seq: row.seq,
    playerId: row.player_id,
    turn: row.turn,
    type: row.type,
    targetId: row.target_id,
    content: row.content,
    ts: row.ts,
  };
}
