// cf_ai_werewolf — single-page chat UI driven by WebSocket.
const $ = (id) => document.getElementById(id);

const ROLE_INFO = {
  villager: { emoji: "👤", name: "Villager", desc: "You have no special abilities. Outwit the wolves with logic." },
  seer: { emoji: "🔮", name: "Seer", desc: "Each night, learn one player's true role." },
  doctor: { emoji: "🩺", name: "Doctor", desc: "Each night, protect one player from the wolves." },
  werewolf: { emoji: "🐺", name: "Werewolf", desc: "Each night, choose with your pack who to kill. Lie during the day." },
};

const PHASE_INFO = {
  lobby: { icon: "🏘️", name: "Lobby" },
  night: { icon: "🌙", name: "Night" },
  "day-debate": { icon: "☀️", name: "Day Debate" },
  voting: { icon: "🗳️", name: "Voting" },
  resolution: { icon: "⚖️", name: "Resolving" },
  ended: { icon: "🏁", name: "Game Over" },
};

const state = {
  gameId: null,
  humanPlayerId: null,
  role: null,
  ws: null,
  players: [],
  livingPlayers: [],
  knownWolves: [],
  privateMemory: [],
  phase: "lobby",
  turn: 0,
  pendingActions: { nightAction: false, vote: false, say: false },
};

function avatar(name, idx) {
  const initial = (name || "?").charAt(0).toUpperCase();
  const c = (idx ?? 0) % 7;
  return `<span class="avatar avatar-${c}">${initial}</span>`;
}

function renderPlayers() {
  const ul = $("players-list");
  ul.innerHTML = "";
  state.players.forEach((p, idx) => {
    const li = document.createElement("li");
    li.className = "player-item" + (p.alive ? "" : " dead");
    li.innerHTML = `
      ${avatar(p.name, idx)}
      <span class="player-name">${p.name}</span>
      ${p.role ? `<span class="role-tag">${p.role}</span>` : ""}
    `;
    ul.appendChild(li);
  });
  const livingCount = state.players.filter((p) => p.alive).length;
  $("alive-counter").textContent = `${livingCount}/${state.players.length} alive`;
}

function renderRole() {
  if (!state.role) return;
  const info = ROLE_INFO[state.role];
  $("role-emoji").textContent = info.emoji;
  $("role-name").textContent = info.name;

  const wolvesPanel = $("known-wolves");
  if (state.role === "werewolf" && state.knownWolves.length > 0) {
    wolvesPanel.hidden = false;
    $("known-wolves-list").innerHTML = state.knownWolves
      .map((w, i) => `<li class="player-item">${avatar(w.name, i + 4)} <span class="player-name">${w.name}</span></li>`)
      .join("");
  } else {
    wolvesPanel.hidden = true;
  }

  const seerPanel = $("seer-knowledge");
  const seerEntries = state.privateMemory.filter((m) => m.type === "seer-check-result");
  if (state.role === "seer" && seerEntries.length > 0) {
    seerPanel.hidden = false;
    $("seer-knowledge-list").innerHTML = seerEntries
      .map((m) => `<li class="player-item">🔮 <span class="player-name">${m.content}</span></li>`)
      .join("");
  } else {
    seerPanel.hidden = true;
  }
}

function renderPhaseHeader() {
  const info = PHASE_INFO[state.phase] ?? { icon: "❓", name: state.phase };
  $("phase-icon").textContent = info.icon;
  $("phase-name").textContent = info.name;
  $("turn-indicator").textContent = state.turn > 0 ? `Turn ${state.turn}` : "";
}

function appendLogEntry(entry) {
  const stream = $("log-stream");
  const div = document.createElement("div");
  div.className = `log-entry ${entry.logType ?? entry.type ?? "system"}`;
  div.textContent = entry.content;
  stream.appendChild(div);
  stream.scrollTop = stream.scrollHeight;
}

function renderActionPanel() {
  const panel = $("action-content");
  panel.innerHTML = "";
  const me = state.players.find((p) => p.id === state.humanPlayerId);
  if (!me || !me.alive) {
    panel.innerHTML = `<div class="action-prompt">👻 You're dead. Watch the rest unfold.</div>`;
    return;
  }
  if (state.phase === "night") {
    if (state.role === "werewolf") {
      renderTargetPicker(panel, "🐺 Pick a victim", "kill", state.livingPlayers.filter((p) => p.id !== state.humanPlayerId && !state.knownWolves.some((w) => w.id === p.id)));
    } else if (state.role === "seer") {
      renderTargetPicker(panel, "🔮 Investigate one player", "investigate", state.livingPlayers.filter((p) => p.id !== state.humanPlayerId));
    } else if (state.role === "doctor") {
      renderTargetPicker(panel, "🩺 Choose someone to protect", "save", state.livingPlayers);
    } else {
      panel.innerHTML = `<div class="action-prompt">💤 You sleep. Others act in the dark.</div>`;
    }
  } else if (state.phase === "day-debate") {
    panel.innerHTML = `
      <div class="action-prompt">💬 Day debate. Speak your mind (or wait it out).</div>
      <textarea id="say-input" class="action-input" placeholder="What do you want to say?" maxlength="400"></textarea>
      <button id="say-btn">Speak</button>
      <button id="pass-btn" class="secondary">Pass</button>
    `;
    $("say-btn").onclick = () => {
      const content = $("say-input").value.trim();
      if (content) {
        send({ type: "say", content });
        $("say-input").value = "";
        $("say-btn").disabled = true;
      }
    };
    $("pass-btn").onclick = () => {
      $("say-btn").disabled = true;
      $("say-input").disabled = true;
      $("pass-btn").disabled = true;
    };
  } else if (state.phase === "voting") {
    renderTargetPicker(panel, "🗳️ Vote to eliminate", "vote", state.livingPlayers.filter((p) => p.id !== state.humanPlayerId));
  } else if (state.phase === "resolution") {
    panel.innerHTML = `<div class="action-prompt">⚖️ Resolving…</div>`;
  } else {
    panel.innerHTML = `<div class="action-prompt">…</div>`;
  }
}

function renderTargetPicker(panel, label, kind, targets) {
  panel.innerHTML = `
    <div class="action-prompt">${label}</div>
    <div id="target-buttons" class="target-buttons"></div>
  `;
  const tb = $("target-buttons");
  for (const t of targets) {
    const b = document.createElement("button");
    b.textContent = t.name;
    b.onclick = () => {
      [...tb.querySelectorAll("button")].forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
      [...tb.querySelectorAll("button")].forEach((x) => (x.disabled = true));
      if (kind === "vote") {
        send({ type: "vote", target: t.id });
      } else {
        send({ type: "night-action", action: kind, target: t.id });
      }
    };
    tb.appendChild(b);
  }
}

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

async function fetchPlayerView() {
  const res = await fetch(`/api/games/${state.gameId}/me?playerId=${state.humanPlayerId}`);
  if (!res.ok) return;
  const view = await res.json();
  state.knownWolves = view.knownWolves ?? [];
  state.privateMemory = view.privateMemory ?? [];
  renderRole();
}

async function fetchPublicState() {
  const res = await fetch(`/api/games/${state.gameId}`);
  if (!res.ok) return;
  const s = await res.json();
  state.players = s.players ?? [];
  state.livingPlayers = state.players.filter((p) => p.alive);
  state.phase = s.phase ?? "lobby";
  state.turn = s.turn ?? 0;
  renderPlayers();
  renderPhaseHeader();
  // Replay log entries if log empty
  if ($("log-stream").children.length === 0 && s.log) {
    for (const e of s.log) {
      appendLogEntry({ logType: e.type, content: e.content });
    }
  }
}

function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${location.host}/api/games/${state.gameId}/ws?playerId=${state.humanPlayerId}`);
  state.ws = ws;
  ws.onopen = () => {
    // initial state already loaded
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(msg);
  };
  ws.onclose = () => {
    // attempt one reconnect after 2s
    setTimeout(() => {
      if (state.phase !== "ended") connectWebSocket();
    }, 2000);
  };
}

async function handleServerMessage(msg) {
  switch (msg.type) {
    case "hello":
      state.role = msg.role;
      renderRole();
      break;
    case "phase":
      state.phase = msg.phase;
      state.turn = msg.turn;
      renderPhaseHeader();
      await fetchPublicState();
      await fetchPlayerView();
      renderActionPanel();
      break;
    case "log":
      appendLogEntry(msg);
      break;
    case "death":
      appendLogEntry({ logType: "death", content: `💀 ${msg.victimName} was killed in the night.` });
      await fetchPublicState();
      await fetchPlayerView();
      renderActionPanel();
      break;
    case "vote-result":
      appendLogEntry({
        logType: "vote-result",
        content: msg.executedName ? `🗳️ ${msg.executedName} was eliminated.` : "🗳️ No one was eliminated.",
      });
      await fetchPublicState();
      await fetchPlayerView();
      renderActionPanel();
      break;
    case "game-over":
      state.phase = "ended";
      showGameOver(msg);
      break;
    case "game-error":
      appendLogEntry({ logType: "death", content: `⚠️ Game errored: ${msg.message}` });
      break;
    case "action-too-late":
      appendLogEntry({ logType: "system", content: "⏱️ Too late — the phase has moved on." });
      renderActionPanel();
      break;
  }
}

function showGameOver(msg) {
  $("game").hidden = true;
  $("game-over").hidden = false;
  const banner = $("winner-banner");
  if (msg.winner === "village") banner.textContent = "🏆 Village wins!";
  else if (msg.winner === "wolves") banner.textContent = "🐺 Wolves win!";
  else banner.textContent = "⚠️ Game crashed";
  const ul = $("reveal-list");
  ul.innerHTML = (msg.reveals ?? [])
    .map((r) => `<li><span>${r.name}</span><span class="role-tag">${r.role}</span></li>`)
    .join("");
}

$("play-again-btn").addEventListener("click", () => {
  location.reload();
});

$("lobby-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("name-input").value.trim();
  if (!name) return;
  $("start-btn").disabled = true;
  $("lobby-error").hidden = true;
  try {
    const res = await fetch("/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ humanName: name }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    const { gameId, humanPlayerId, role } = await res.json();
    state.gameId = gameId;
    state.humanPlayerId = humanPlayerId;
    state.role = role;
    $("lobby").hidden = true;
    $("game").hidden = false;
    await fetchPublicState();
    await fetchPlayerView();
    renderRole();
    renderActionPanel();
    connectWebSocket();
  } catch (err) {
    $("lobby-error").hidden = false;
    $("lobby-error").textContent = `Could not start a game: ${err.message ?? err}`;
    $("start-btn").disabled = false;
  }
});
