// cf_ai_werewolf — single-page chat UI driven by WebSocket.
const $ = (id) => document.getElementById(id);

const STALL_THRESHOLD_MS = 10_000;

const ROLE_INFO = {
  villager: {
    emoji: "🌾",
    name: "Villager",
    flavor: "A plain soul.",
    desc: "You have no abilities. Watch the others closely — the truth is in what they say, and what they fail to say. At the vote, be ready to name a wolf.",
  },
  seer: {
    emoji: "🔮",
    name: "Seer",
    flavor: "One who sees.",
    desc: "Each night you may investigate a single player and learn whether they are a werewolf. Share your findings at your own risk — speak up and the wolves will come for you next.",
  },
  doctor: {
    emoji: "🕯️",
    name: "Doctor",
    flavor: "A quiet healer.",
    desc: "Each night, choose one soul to protect. If the wolves attack them, they live. You may protect yourself — but never two nights in a row. Keep your role hidden.",
  },
  werewolf: {
    emoji: "🐺",
    name: "Werewolf",
    flavor: "Hunger in the dark.",
    desc: "You and your pack stalk the village by night. Each night choose a victim together. By day, lie. Deflect. Accuse the innocent. The village wins at dawn only if every wolf is gone.",
  },
};

const PHASE_INFO = {
  lobby: { icon: "🏘️", name: "Lobby" },
  night: { icon: "🌙", name: "Night" },
  "day-debate": { icon: "☀️", name: "Day Debate" },
  voting: { icon: "🗳️", name: "Voting" },
  resolution: { icon: "⚖️", name: "Resolving" },
  ended: { icon: "🏁", name: "Game Over" },
};

// Small emoji badge per persona id (matches src/personas.ts)
const PERSONA_EMOJI = {
  wren: "🥖",
  morgan: "🎣",
  tobias: "🔨",
  elspeth: "🍺",
  rorik: "🏹",
  isolde: "🌿",
  callum: "🌾",
  branwen: "🧵",
  human: "🧭",
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
  // Activity: playerId -> { playerName, action, startedAt }
  activity: new Map(),
  // In-progress speech entries: seq -> { playerId, playerName, text, el }
  inProgress: new Map(),
  lastEventAt: Date.now(),
};

function avatar(name, idx, personaId) {
  const initial = (name || "?").charAt(0).toUpperCase();
  const c = (idx ?? 0) % 7;
  const emoji = personaId && PERSONA_EMOJI[personaId] ? PERSONA_EMOJI[personaId] : "";
  return `<span class="avatar avatar-${c}">${initial}${emoji ? `<span class="avatar-emoji">${emoji}</span>` : ""}</span>`;
}

function renderPlayers() {
  const ul = $("players-list");
  ul.innerHTML = "";
  state.players.forEach((p, idx) => {
    const li = document.createElement("li");
    const thinking = state.activity.has(p.id);
    li.className = "player-item" + (p.alive ? "" : " dead") + (thinking ? " thinking" : "");
    li.innerHTML = `
      ${avatar(p.name, idx, p.id)}
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
  const flavor = $("role-flavor");
  if (flavor) flavor.textContent = info.flavor;
  const desc = $("role-description");
  if (desc) desc.textContent = info.desc;

  const wolvesPanel = $("known-wolves");
  if (state.role === "werewolf" && state.knownWolves.length > 0) {
    wolvesPanel.hidden = false;
    $("known-wolves-list").innerHTML = state.knownWolves
      .map((w, i) => `<li class="player-item">${avatar(w.name, i + 4, w.id)} <span class="player-name">${w.name}</span></li>`)
      .join("");
  } else {
    wolvesPanel.hidden = true;
  }

  const seerPanel = $("seer-knowledge");
  const allSeerEntries = state.privateMemory.filter((m) => m.type === "seer-check-result");
  // Dedup by targetId — most recent check per target wins.
  const byTarget = new Map();
  for (const entry of allSeerEntries) {
    byTarget.set(entry.targetId, entry);
  }
  const seerEntries = [...byTarget.values()];
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

function renderActivityStrip() {
  const strip = $("activity-strip");
  strip.innerHTML = "";
  strip.classList.remove("stalled");
  if (state.activity.size === 0) return;
  for (const [playerId, info] of state.activity) {
    const line = document.createElement("div");
    line.className = "activity-line";
    const verb =
      info.action === "speak" ? "is thinking" :
      info.action === "vote" ? "is deciding a vote" :
      info.action === "kill" ? "is choosing a victim" :
      info.action === "save" ? "is choosing who to protect" :
      info.action === "investigate" ? "peers into the dark" :
      "is thinking";
    line.innerHTML = `
      <span class="player-name">${info.playerName}</span> <span style="color: var(--ink-dim)">${verb}</span>
      <span class="thinking-dots"><span></span><span></span><span></span></span>
    `;
    strip.appendChild(line);
  }
}

function updateStallState() {
  const strip = $("activity-strip");
  if (!strip) return;
  if (state.activity.size === 0) {
    strip.classList.remove("stalled");
    return;
  }
  const silentFor = Date.now() - state.lastEventAt;
  if (silentFor > STALL_THRESHOLD_MS) {
    strip.classList.add("stalled");
  } else {
    strip.classList.remove("stalled");
  }
}

function appendLogEntry(entry) {
  const stream = $("log-stream");
  const div = document.createElement("div");
  div.className = `log-entry ${entry.logType ?? entry.type ?? "system"}`;
  div.textContent = entry.content;
  stream.appendChild(div);
  stream.scrollTop = stream.scrollHeight;
  return div;
}

function appendInProgressSpeech(seq, playerName) {
  const stream = $("log-stream");
  const div = document.createElement("div");
  div.className = "log-entry speech in-progress";
  div.setAttribute("data-seq", String(seq));
  div.textContent = `${playerName}: `;
  stream.appendChild(div);
  stream.scrollTop = stream.scrollHeight;
  return div;
}

function renderActionPanel() {
  const panel = $("action-content");
  panel.innerHTML = "";
  const me = state.players.find((p) => p.id === state.humanPlayerId);
  if (!me || !me.alive) {
    panel.innerHTML = `<div class="action-prompt">👻 You're gone. Watch the rest unfold.</div>`;
    return;
  }
  if (state.phase === "night") {
    if (state.role === "werewolf") {
      renderTargetPicker(panel, "🐺 Pick a victim", "kill", state.livingPlayers.filter((p) => p.id !== state.humanPlayerId && !state.knownWolves.some((w) => w.id === p.id)));
    } else if (state.role === "seer") {
      renderTargetPicker(panel, "🔮 Look into one soul", "investigate", state.livingPlayers.filter((p) => p.id !== state.humanPlayerId));
    } else if (state.role === "doctor") {
      renderTargetPicker(panel, "🕯️ Guard one soul", "save", state.livingPlayers);
    } else {
      panel.innerHTML = `<div class="action-prompt">💤 You sleep. Others move in the dark.</div>`;
    }
  } else if (state.phase === "day-debate") {
    panel.innerHTML = `
      <div class="action-prompt">💬 Speak your mind.</div>
      <textarea id="say-input" class="action-input" placeholder="What do you want to say?" maxlength="400"></textarea>
      <button id="say-btn">Speak</button>
      <button id="pass-btn" class="secondary">Hold my tongue</button>
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
  applyPhaseBodyClass();
  renderPlayers();
  renderPhaseHeader();
  if ($("log-stream").children.length === 0 && s.log) {
    for (const e of s.log) {
      appendLogEntry({ logType: e.type, content: e.content });
    }
  }
}

function applyPhaseBodyClass() {
  const cls = document.body.className.split(" ").filter((c) => !c.startsWith("phase-"));
  cls.push(`phase-${state.phase}`);
  document.body.className = cls.join(" ");
}

function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${location.host}/api/games/${state.gameId}/ws?playerId=${state.humanPlayerId}`);
  state.ws = ws;
  ws.onopen = () => { state.lastEventAt = Date.now(); };
  ws.onmessage = (ev) => {
    state.lastEventAt = Date.now();
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(msg);
  };
  ws.onclose = () => {
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
      applyPhaseBodyClass();
      renderPhaseHeader();
      // Clear activity at phase boundaries — any in-flight calls are old
      state.activity.clear();
      renderActivityStrip();
      await fetchPublicState();
      await fetchPlayerView();
      renderActionPanel();
      break;
    case "log":
      // If there's a tentative in-progress entry matching this speech, promote it
      if (msg.logType === "speech") {
        for (const [seq, ip] of state.inProgress) {
          if (ip.el && ip.playerName && msg.content.startsWith(`${ip.playerName}:`)) {
            ip.el.className = "log-entry speech";
            ip.el.textContent = msg.content;
            state.inProgress.delete(seq);
            return;
          }
        }
      }
      appendLogEntry(msg);
      break;
    case "activity":
      if (msg.status === "thinking") {
        state.activity.set(msg.playerId, {
          playerName: msg.playerName,
          action: msg.action,
          startedAt: Date.now(),
        });
      } else {
        state.activity.delete(msg.playerId);
      }
      renderActivityStrip();
      renderPlayers();
      break;
    case "log-delta": {
      let ip = state.inProgress.get(msg.seq);
      if (!ip) {
        const el = appendInProgressSpeech(msg.seq, msg.playerName);
        ip = { playerId: msg.playerId, playerName: msg.playerName, text: "", el };
        state.inProgress.set(msg.seq, ip);
      }
      ip.text += msg.delta;
      ip.el.textContent = `${ip.playerName}: ${ip.text}`;
      $("log-stream").scrollTop = $("log-stream").scrollHeight;
      break;
    }
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
      applyPhaseBodyClass();
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
  const sub = $("winner-sub");
  if (msg.winner === "village") {
    banner.textContent = "🏆 The village endures.";
    if (sub) sub.textContent = "Dawn breaks. The wolves are gone.";
  } else if (msg.winner === "wolves") {
    banner.textContent = "🐺 The wolves feast.";
    if (sub) sub.textContent = "The village falls silent.";
  } else {
    banner.textContent = "⚠️ Something went wrong.";
    if (sub) sub.textContent = "The night refuses to end.";
  }
  const ul = $("reveal-list");
  ul.innerHTML = (msg.reveals ?? [])
    .map((r) => `<li><span>${r.name}</span><span class="role-tag">${r.role}</span></li>`)
    .join("");
}

// Mobile tab switching
function setupTabs() {
  const tabs = document.querySelectorAll(".mobile-tabs button[data-tab]");
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      const which = btn.getAttribute("data-tab");
      tabs.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const classes = document.body.className.split(" ").filter((c) => !c.startsWith("tab-"));
      classes.push(`tab-${which}`);
      document.body.className = classes.join(" ");
    });
  });
  // default
  if (!document.body.className.includes("tab-")) {
    document.body.classList.add("tab-log");
  }
}

// Role card flip
function setupRoleCardFlip() {
  const card = $("role-card");
  if (!card) return;
  card.addEventListener("click", () => card.classList.toggle("flipped"));
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      card.classList.toggle("flipped");
    }
  });
}

$("play-again-btn").addEventListener("click", () => {
  location.reload();
});

$("lobby-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("name-input").value.trim();
  if (!name) return;
  $("start-btn").disabled = true;
  const spinner = $("start-btn").querySelector(".spinner");
  if (spinner) spinner.hidden = false;
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
    if (spinner) spinner.hidden = true;
    await fetchPublicState();
    await fetchPlayerView();
    renderRole();
    renderActionPanel();
    connectWebSocket();
    setupTabs();
    setupRoleCardFlip();
  } catch (err) {
    $("lobby-error").hidden = false;
    $("lobby-error").textContent = `Could not begin: ${err.message ?? err}`;
    $("start-btn").disabled = false;
    if (spinner) spinner.hidden = true;
  }
});

// Stall detector — pulses activity strip yellow if 10s of silence
setInterval(updateStallState, 1000);
