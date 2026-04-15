# cf_ai_werewolf

A single-player Werewolf / Mafia game where you play alongside six AI villagers — two of them want you dead. Built end-to-end on Cloudflare:

- **LLM**: Llama 3.3 (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) on **Workers AI**
- **Coordination**: a **Cloudflare Workflow** drives the durable phase state machine (night → day → vote → resolve → loop) and uses `step.waitForEvent` to pause for human input
- **Memory / state**: a **Durable Object** holds full game state and per-AI-player private memory (every accusation, kill, investigation, vote) in SQLite
- **Chat input**: vanilla HTML/JS frontend served via **Workers Assets**, talking to the DO over WebSocket (with hibernation)

Each component is load-bearing — the game doesn't work without all four.

## Why Workers Assets, not Pages?

The assignment mentions "Pages", but **Pages Functions cannot bind to Cloudflare Workflows** (verified at `developers.cloudflare.com/pages/functions/bindings`). Workers Assets is the 2026 successor to Pages for static hosting and lets DOs + Workflows + frontend live in one project, one deploy. Same outcome — a deployed page with a chat UI — different path.

## Game rules

- **7 players total**: 1 human + 6 AI personas
- **Roles**: 2 Werewolves, 1 Seer, 1 Doctor, 3 Villagers — randomly assigned (you can be any of them)
- **Phases per turn**: Night → Day Debate (2 rounds of statements) → Voting → Resolution
- **Win conditions**:
  - **Village wins** when all wolves are dead.
  - **Wolves win** when wolves outnumber or equal non-wolves (parity).
- **Night actions**: Wolves (each independently) pick a kill; Seer investigates one player and learns their role; Doctor protects one player from death.
- **Day debate**: Each living AI speaks once per round, in randomized order. You can speak at any time.
- **Voting**: Every living player votes for one other to eliminate. Tied votes trigger one revote among the tied players; if still tied, a deterministic random pick from the tied set is executed.

### Known simplifications (called out so a reviewer doesn't have to dig)

- **Wolf coordination**: each wolf makes an independent kill choice. If wolves disagree, the first wolf in player-id sort order wins. (A real consensus loop would mean another LLM round-trip per night — not worth it.)
- **Doctor consecutive save**: classic rule — the doctor cannot protect the same player two nights in a row (including themselves).
- **AFK timeouts**: the workflow never errors on human inactivity. Instead, it falls back to a deterministic random choice (kill/save/investigate) or skips speech/vote.

## Architecture

```
                       ┌──────────────────────┐
   browser ──HTTPS───▶ │  Worker (src/index)  │
       │              └──────┬───────┬───────┘
       │                     │       │
       │ WebSocket           │ RPC   │ create()
       ▼                     ▼       ▼
   ┌───────────┐    ┌─────────────────┐    ┌──────────────────┐
   │ DO (game) │ ◀─ │  Game state    │    │ GameWorkflow     │
   │ SQLite +  │    │  (single        │ ─▶ │ phase machine     │
   │ WS hib.   │ ◀──│   source)      │ ◀─ │ step.waitForEvent │
   └─────┬─────┘    └─────────────────┘    └────────┬─────────┘
         │                                           │
         │                                           │
         └──────── env.AI.run (Llama 3.3) ──────────┘
```

- The Worker is thin — it serves static assets, handles `POST /api/games`, and forwards WS upgrade to the DO.
- The DO is the **single source of truth**. All state lives in SQLite; KV-style keys hold singletons (phase, turn, winner).
- The Workflow only orchestrates — it calls DO RPC methods (which are idempotent, so workflow restarts can't double-kill a player) and pauses on `step.waitForEvent` for human input.
- The DO sends `instance.sendEvent()` to the workflow when a human submits a vote or night action.
- Llama 3.3 is called from inside DO methods (`aiSpeak`, `aiTakeNightAction`, `aiVote`) using JSON Schema mode for structured decisions and plain text for dialogue. Each AI player's prompt includes their persona, role guidance, the full public log, and their private memory.

See `tasks/cf-ai-werewolf/spec.md` (in this repo's parent worktree) for the full design + 110+ test list.

## Local development

```bash
git clone <this repo>
cd cf_ai_werewolf
npm install
npm run cf-typegen   # generate worker-configuration.d.ts from wrangler.jsonc
npm run dev          # opens http://localhost:8787
```

Open the URL in a browser and click **Start Game**. The dev server connects to **real** Workers AI in the cloud — there's no local mock for AI bindings — so you'll burn a small amount of free-tier neurons (about 0.02 USD per full game; the 10k neurons/day free tier covers ~25 games/day).

`npm run dev` runs Workflows locally too — they're emulated in workerd.

## Testing

```bash
npm test         # vitest with @cloudflare/vitest-pool-workers (real DO, mocked AI)
npm run typecheck
```

Tests run inside `workerd` via Miniflare and include:
- Pure unit tests for game rules, prompts, and the LLM wrapper.
- Real DO tests via `runInDurableObject` — including memory persistence across "evictions", WebSocket broadcast, late-action handling, and duplicate-connection replacement.
- Workflow tests via `introspectWorkflowInstance` — including a full village-win scenario, AI-memory verification (round-2 prompts include round-1 statements), wolf-vs-villager prompt content separation, AFK fallback, and AI-exhaustion error recovery.

## Deployment

```bash
wrangler login
npm run deploy     # wrangler deploy
```

After deploy, the game is live at `https://cf-ai-werewolf.<your-account>.workers.dev`. Workflows + DOs + AI + Assets all deploy as one unit.

## Cost

Per game: ~$0.02 in Workers AI inference (8 AI players × ~5 turns × 5 LLM calls/turn × ~500 input + 150 output tokens). 10k free neurons/day covers ~25 games/day during dev iteration. DOs and Workflows are negligible at this scale.

## Files

- `src/index.ts` — Worker entry, HTTP routes
- `src/game-do.ts` — `GameDurableObject` (SQLite + WebSocket hibernation + RPC methods)
- `src/workflow.ts` — `GameWorkflow` (phase state machine)
- `src/llm.ts` — Workers AI wrapper (text + JSON-schema, with Zod validation + retry)
- `src/prompts.ts` — All in-game LLM prompt templates (also documented in `PROMPTS.md`)
- `src/rules.ts` — Pure game logic (role assignment, win check, vote tally)
- `src/personas.ts` — Static list of 8 villager personas
- `src/types.ts` — Shared TypeScript types
- `src/ws.ts` — WebSocket message protocol
- `public/` — Frontend (HTML + vanilla JS + CSS)
- `test/` — Vitest test files
- `wrangler.jsonc` — Cloudflare bindings (AI, GAME_DO, GAME_WORKFLOW, ASSETS)
- `PROMPTS.md` — Both the in-game LLM prompts AND the dev prompts used with Claude during construction

## License

MIT — original work for a Cloudflare job application assignment.
