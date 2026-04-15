# PROMPTS.md

Two sections:
1. **In-game LLM prompts** — what each AI player sees when Llama 3.3 generates their action.
2. **Developer prompts** — the prompts I used with Claude (Anthropic's CLI agent) to build this project.

---

## 1. In-game LLM prompts

All prompts use Llama 3.3 70B Instruct (FP8 fast) on Cloudflare Workers AI:
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Decisions (kill, save, investigate, vote) use **JSON Schema response format**; dialogue uses plain text. The actual implementations are in `src/prompts.ts` and `src/llm.ts`.

### Persona system prompt (shared base for every action)

```
You are {persona.name}.
{persona.bio}

You are playing a game of Werewolf.
{role-specific guidance — see below}

Stay in character. Keep responses short and natural — one or two sentences.
Do not break the fourth wall. Do not narrate. Do not use markdown.
```

**Role-specific guidance:**

| Role | Guidance |
|---|---|
| Villager | "You are an innocent villager. You have no special abilities. Your only weapon is reasoning out loud about who is suspicious. You do not know any other player's role for certain — only what they say and do." |
| Seer | "You are the Seer. Each night you investigate one player and learn their true role. Use this knowledge carefully — revealing yourself paints a target on your back. You may share, hold back, or lie about what you've seen." |
| Doctor | "You are the Doctor. Each night you choose one player to protect from being killed. You may protect yourself, but not on consecutive nights. You must hide your role — if the wolves discover you, they will kill you." |
| Werewolf | "You are a Werewolf. Each night you and your pack pick a villager to kill. During the day you must lie convincingly to deflect suspicion. You know who the other werewolves are. NEVER reveal your role to non-wolves; agreeing with safe accusations against villagers is a good way to blend in." |

For werewolves, an extra line is appended: `Your fellow werewolves are: {co_wolves}. You will never vote against them or accuse them.`

### Shared context block (prepended to every user prompt)

```
=== Game state ===
Turn: {turn}
Living players ({n}):
- {Name1} — {bio1}
- {Name2} — {bio2}
...
Dead players: {comma-separated names}

(if rolling summary exists)
=== Earlier events (summary) ===
{LLM-generated summary of pre-cutoff log}

=== Recent events (most recent first {N} shown) ===
[turn 1 day-debate] Wren: I think Morgan is a wolf.
[turn 1 day-debate] Morgan: That's a strange accusation.
...

=== Your private notes ===
- (turn 1, seer-check-result) Tobias is a werewolf (investigated turn 1).
- (turn 1, self-vote) I voted for Morgan.
```

### Action-specific user prompts + JSON schemas

#### Kill (werewolf)

```
{shared context}

It is night. Pick one non-wolf player to kill. Consider:
- Who is most dangerous to the pack (likely Seer, Doctor, or sharp accuser)?
- Who can you eliminate without obvious blowback?

Respond with JSON: { "target": "<player name>", "reasoning": "<one sentence>" }
```

JSON Schema:
```json
{
  "type": "object",
  "properties": {
    "target": { "type": "string", "enum": ["Morgan", "Tobias", ...living non-wolf names] },
    "reasoning": { "type": "string" }
  },
  "required": ["target", "reasoning"]
}
```

#### Save (doctor)

```
{shared context}
[if doctor saved someone last night: "Note: you saved one player last night and cannot save them again tonight."]

It is night. Pick one player (including yourself) to protect from the wolves' attack. Choose someone you suspect the wolves will target.

Respond with JSON: { "target": "<player name>", "reasoning": "<one sentence>" }
```

#### Investigate (seer)

```
{shared context}

It is night. Pick one player to investigate. You will learn whether they are a werewolf. Choose carefully — past investigations are in your private notes.

Respond with JSON: { "target": "<player name>", "reasoning": "<one sentence>" }
```

#### Day talk (any role)

```
{shared context}

It is the day debate, round {round}. It is your turn to speak.

{role-specific nudge — see below}

Reply with ONLY your spoken statement — one or two short sentences.
No quotes, no narration, no JSON, no markdown.
```

Role-specific nudges for day talk:

| Role | Nudge |
|---|---|
| Werewolf | "Remember: deflect suspicion from yourself and the pack. Cast doubt on a villager. Agree with safe accusations against villagers when convenient. Never reveal your role." |
| Seer | "Decide whether to share your investigation results — you may persuade more by speaking up, but you'll get killed tomorrow night." |
| Doctor | "Be careful not to reveal your role. The wolves will target you if they find out." |
| Villager | "Look for inconsistencies in what others are saying. Question suspicious behavior." |

#### Vote

```
{shared context}

It is time to vote. Pick one living player (not yourself) to eliminate. Consider every accusation, defense, and behavior so far.

Respond with JSON: { "target": "<player name>", "reasoning": "<one sentence>" }
```

#### Log summary (called when the public log exceeds 40 entries)

System: `You summarize a Werewolf game log into 4-6 short bullet points capturing key accusations, deaths, and revealed roles. No fluff.`

User: `Summarize:\n\n{full transcript of older entries}`

The summary is cached on the DO and prepended to all subsequent prompts so we stay under Llama's 24k context window in long games.

### Validation + fallback

JSON-schema mode "isn't guaranteed" per Cloudflare's docs. So `generateStructured` (`src/llm.ts`) does:

1. Call Llama with `response_format: { type: "json_schema", json_schema }`.
2. `JSON.parse` + Zod `.safeParse` against the same schema.
3. On failure: retry once with an extra system message: `"IMPORTANT: respond with VALID JSON matching the schema. No prose."`
4. On second failure: throw `LLMValidationError`. The DO method catches this and falls back to a deterministic random pick from valid living targets (seeded by `gameId|playerId|turn`), and writes a `private_memory_events` row of type `llm-fallback` so we can observe the fallback rate.

---

## 2. Developer prompts

These are the actual conversational prompts I used with Claude (the CLI agent at https://claude.ai/code) while building this project. The session was iterative — I'd brainstorm an idea, ask Claude to scope it, then ask Claude to plan and execute. Below are the load-bearing turns.

### Initial brainstorming

> "help me think for this Optional Assignment Instructions: We plan to fast track review of candidates who complete an assignment to build a type of AI-powered application on Cloudflare. An AI-powered application should include the following components: LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice; Workflow / coordination (recommend using Workflows, Workers or Durable Objects); User input via chat or voice (recommend using Pages or Realtime); Memory or state. ... your repository name must be prefixed with cf_ai_, must include a README.md file with project documentation and clear running instructions to try out components ..."

Claude proposed three idea categories (D&D, voice journal, research agent) and we converged on a game.

### Narrowing the game

> "lets do this: AI Werewolf / Mafia (single-player vs AI villagers) — Chat UI for day/night discussion, Durable Object holds each AI player's hidden role + personal memory of what's been said, Workflow orchestrates the phase state machine ... create a spec and then execute for us."

### Spec invocation (slash command)

I invoked Claude's `/spec` skill with this prompt — it spawned 5 parallel research agents (Workers AI, Workflows, Durable Objects, Workers Assets, vitest-pool-workers) and then 2 validation agents (approach-critic, edge-case-hunter):

> "Build `cf_ai_werewolf` — a single-player AI Werewolf/Mafia game on Cloudflare. ... Game concept: Human plays one role (villager or werewolf) alongside 6 AI players (7-player game). Classic roles: 2 Werewolves, 1 Seer, 1 Doctor, 3 Villagers ... AI players each have: persona, hidden role, private memory of what's been said/done, and must lie convincingly if they're a wolf. Architecture: Durable Object per game holds full game state; Each AI player's state lives inside the game DO; Cloudflare Workflow orchestrates the phase state machine ..."

The spec went through two rounds of automated critique:
- **approach-critic** flagged that the Workflow/DO boundary was fuzzy and the rolling-summary mechanism was unspecified.
- **edge-case-hunter** flagged late-event handling, AI-exhaustion stuck-game, doctor consecutive-save persistence, three-way ties, hallucinated player names, duplicate WebSocket connections, and 1MiB step return value limits.

Both rounds were applied to the spec at `tasks/cf-ai-werewolf/spec.md` before execution.

### Execute invocation

> "execute pick the best answers" — referring to the three open questions in the spec (defaults: real Workers AI in dev / init git in cf_ai_werewolf as own repo / stop at `wrangler deploy --dry-run`).

This launched Claude's `/execute` skill which created a worktree, then worked through 10 implementation tasks test-first, running the verification gate after each. Total ~95 tests written, all passing.

### Things I corrected mid-build

- npm install was hitting esbuild post-install errors in the deep `.claude-workspace` worktree path. Solved by `--ignore-scripts`.
- vitest 4.x's "basic" reporter no longer exists; switched to default.
- `@cloudflare/vitest-pool-workers` v0.14.x dropped the `/config` subpath export and `defineWorkersConfig` in favor of a `cloudflareTest()` Vite plugin.
- DO RPC errors that throw across the worker isolate boundary surface as "unhandled rejections" in Vitest — must use `runInDurableObject` and call methods on the `instance` argument (same isolate) for `expect(...).rejects.toThrow()` to work cleanly.
- Workflow tests timed out because `disableSleeps()` doesn't disable `step.waitForEvent` timeouts. Solved by making per-phase timeouts env-controlled and overriding to "1 second" in `vitest.config.ts`.

---

That's the full prompt history. The spec at `tasks/cf-ai-werewolf/spec.md` (in the worktree parent of this repo) has the complete design and test plan if you want the detailed reasoning.
