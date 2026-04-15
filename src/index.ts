import { GameDurableObject } from "./game-do";
import { GameWorkflow } from "./workflow";
import type { Role } from "./types";

export { GameDurableObject, GameWorkflow };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function generateGameId(): string {
  // crypto.randomUUID is available in Workers
  return `g_${crypto.randomUUID()}`;
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health") {
    return new Response("ok", { status: 200 });
  }

  // POST /api/games
  if (path === "/api/games") {
    if (method !== "POST") return new Response("method not allowed", { status: 405 });
    let body: { humanName?: string };
    try {
      body = (await request.json()) as { humanName?: string };
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const humanName = (body.humanName ?? "").toString().trim();
    if (!humanName) return json({ error: "humanName required" }, 400);

    const gameId = generateGameId();
    const stub = env.GAME_DO.get(env.GAME_DO.idFromName(gameId));
    let created: { gameId: string; humanPlayerId: string; role: Role };
    try {
      created = await stub.createGame(gameId, humanName, gameId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json({ error: msg }, 400);
    }

    // Create workflow instance (fire-and-forget create; status is queued/running)
    try {
      await env.GAME_WORKFLOW.create({ id: gameId, params: { gameId } });
    } catch (e) {
      // If create throws (e.g. id collision or workflow infra issue), surface but
      // the game is still in DO — caller can still inspect state.
    }

    return json(created, 200);
  }

  // /api/games/:gameId/...
  const match = path.match(/^\/api\/games\/([^\/]+)(\/[^?]*)?$/);
  if (!match) return new Response("not found", { status: 404 });
  const gameId = match[1];
  const sub = match[2] ?? "";

  const stub = env.GAME_DO.get(env.GAME_DO.idFromName(gameId));

  // GET /api/games/:gameId/ws (WebSocket)
  if (sub === "/ws") {
    return stub.fetch(request);
  }

  // GET /api/games/:gameId/me
  if (sub === "/me") {
    if (method !== "GET") return new Response("method not allowed", { status: 405 });
    const playerId = url.searchParams.get("playerId");
    if (!playerId) return json({ error: "playerId required" }, 400);
    const view = await stub.getPlayerView(playerId);
    if (!view) return json({ error: "not found" }, 404);
    return json(view);
  }

  // GET /api/games/:gameId
  if (sub === "" || sub === "/") {
    if (method !== "GET") return new Response("method not allowed", { status: 405 });
    const state = await stub.getPublicState();
    if (!state.gameId) return json({ error: "not found" }, 404);
    return json(state);
  }

  return new Response("not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
