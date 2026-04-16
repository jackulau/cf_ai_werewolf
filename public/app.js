// cf_ai_werewolf — pixel-art chat UI driven by WebSocket.
import {
  renderSprite,
  starfield,
  ROLE_SPRITES,
  PERSONA_SPRITES,
  PHASE_SPRITES,
  TRAVELER,
  MOON,
  WEREWOLF,
  SEER,
  DOCTOR,
  SKULL_TINY,
  BALLOT_TINY,
  CHEVRON_TINY,
  BUBBLE_TINY,
  ZZZ_TINY,
  STAR_TINY,
} from "./sprites.js";

const $ = (id) => document.getElementById(id);

const STALL_THRESHOLD_MS = 10_000;

const ROLE_INFO = {
  villager: {
    spriteId: "villager",
    name: "Villager",
    flavor: "A plain soul",
    desc: "You have no abilities. Watch the others closely — the truth is in what they say, and what they fail to say. At the vote, be ready to name a wolf.",
  },
  seer: {
    spriteId: "seer",
    name: "Seer",
    flavor: "One who sees",
    desc: "Each night you may investigate a single player and learn whether they are a werewolf. Share your findings at your own risk — speak up and the wolves will come for you next.",
  },
  doctor: {
    spriteId: "doctor",
    name: "Doctor",
    flavor: "A quiet healer",
    desc: "Each night, choose one soul to protect. If the wolves attack them, they live. You may protect yourself — but never two nights in a row. Keep your role hidden.",
  },
  werewolf: {
    spriteId: "werewolf",
    name: "Werewolf",
    flavor: "Hunger in the dark",
    desc: "You and your pack stalk the village by night. Each night choose a victim together. By day, lie. Deflect. Accuse the innocent. The village wins at dawn only if every wolf is gone.",
  },
};

const PHASE_INFO = {
  lobby: { spriteId: "lobby", name: "Lobby" },
  night: { spriteId: "night", name: "Night" },
  "day-debate": { spriteId: "day-debate", name: "Day Debate" },
  voting: { spriteId: "voting", name: "Voting" },
  resolution: { spriteId: "resolution", name: "Resolving" },
  ended: { spriteId: "ended", name: "Game Over" },
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
  activity: new Map(),
  inProgress: new Map(),
  lastEventAt: Date.now(),
  deathShown: false,
};

function spriteFor(personaId) {
  return PERSONA_SPRITES[personaId] ?? TRAVELER;
}

function avatar(personaId, idx, opts = {}) {
  const c = (idx ?? 0) % 7;
  const size = opts.size ?? 32;
  const html = renderSprite(spriteFor(personaId), { size, className: "avatar-svg" });
  return `<span class="tint-${c}"><span class="avatar-sprite">${html}</span></span>`;
}

function smallSprite(spec, size = 18) {
  return renderSprite(spec, { size, className: "log-marker" });
}

function renderPlayers() {
  const ul = $("players-list");
  ul.innerHTML = "";
  state.players.forEach((p, idx) => {
    const li = document.createElement("li");
    const thinking = state.activity.has(p.id);
    li.className = "player-item" + (p.alive ? "" : " dead") + (thinking ? " thinking" : "");
    li.innerHTML = `
      ${avatar(p.id, idx)}
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
  const sprite = ROLE_SPRITES[info.spriteId];
  $("role-emoji").innerHTML = renderSprite(sprite, { size: 96 });
  $("role-name").textContent = info.name;
  const flavor = $("role-flavor");
  if (flavor) flavor.textContent = info.flavor;
  const desc = $("role-description");
  if (desc) desc.textContent = info.desc;

  const wolvesPanel = $("known-wolves");
  if (state.role === "werewolf" && state.knownWolves.length > 0) {
    wolvesPanel.hidden = false;
    $("known-wolves-list").innerHTML = state.knownWolves
      .map((w, i) =>
        `<li class="player-item">${avatar(w.id, i + 4)} <span class="player-name">${w.name}</span></li>`,
      )
      .join("");
  } else {
    wolvesPanel.hidden = true;
  }

  const seerPanel = $("seer-knowledge");
  const allSeerEntries = state.privateMemory.filter((m) => m.type === "seer-check-result");
  const byTarget = new Map();
  for (const entry of allSeerEntries) byTarget.set(entry.targetId, entry);
  const seerEntries = [...byTarget.values()];
  if (state.role === "seer" && seerEntries.length > 0) {
    seerPanel.hidden = false;
    $("seer-knowledge-list").innerHTML = seerEntries
      .map((m) =>
        `<li class="player-item">${smallSprite(SEER, 16)}<span class="player-name">${m.content}</span></li>`,
      )
      .join("");
  } else {
    seerPanel.hidden = true;
  }
}

function renderPhaseHeader() {
  const info = PHASE_INFO[state.phase] ?? { spriteId: "lobby", name: state.phase };
  const sprite = PHASE_SPRITES[info.spriteId];
  $("phase-icon").innerHTML = renderSprite(sprite, { size: 28 });
  $("phase-name").textContent = info.name;
  $("turn-indicator").textContent = state.turn > 0 ? `Turn ${state.turn}` : "";
}

function renderActivityStrip() {
  const strip = $("activity-strip");
  strip.innerHTML = "";
  strip.classList.remove("stalled");
  if (state.activity.size === 0) return;
  for (const [, info] of state.activity) {
    const line = document.createElement("div");
    line.className = "activity-line";
    const verb =
      info.action === "speak" ? "is thinking" :
      info.action === "vote" ? "is choosing a vote" :
      info.action === "kill" ? "is hunting" :
      info.action === "save" ? "is healing" :
      info.action === "investigate" ? "peers into the dark" :
      "is thinking";
    line.innerHTML = `
      <span class="player-name">${info.playerName}</span>
      <span style="color: var(--ink-dim)">${verb}</span>
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

function logMarkerFor(logType) {
  if (logType === "death") return SKULL_TINY;
  if (logType === "vote-result") return BALLOT_TINY;
  if (logType === "phase-change") return CHEVRON_TINY;
  if (logType === "speech") return BUBBLE_TINY;
  return null;
}

function appendLogEntry(entry) {
  const stream = $("log-stream");
  const div = document.createElement("div");
  div.className = `log-entry ${entry.logType ?? entry.type ?? "system"}`;
  const marker = logMarkerFor(entry.logType ?? entry.type);
  if (marker) {
    div.innerHTML = `<span class="log-marker">${smallSprite(marker, 14)}</span><span class="log-text"></span>`;
    div.querySelector(".log-text").textContent = entry.content;
  } else {
    div.textContent = entry.content;
  }
  stream.appendChild(div);
  stream.scrollTop = stream.scrollHeight;
  return div;
}

function appendInProgressSpeech(seq, playerName) {
  const stream = $("log-stream");
  const div = document.createElement("div");
  div.className = "log-entry speech in-progress";
  div.setAttribute("data-seq", String(seq));
  div.innerHTML = `<span class="log-marker">${smallSprite(BUBBLE_TINY, 14)}</span><span class="log-text">${playerName}: </span>`;
  stream.appendChild(div);
  stream.scrollTop = stream.scrollHeight;
  return div;
}

function isHumanTurn(me) {
  if (!me || !me.alive) return false;
  if (state.phase === "night") {
    return state.role === "werewolf" || state.role === "seer" || state.role === "doctor";
  }
  if (state.phase === "day-debate" || state.phase === "voting") return true;
  return false;
}

function setActionBanner(text) {
  const banner = $("action-banner");
  const panel = $("action-panel");
  if (!banner || !panel) return;
  if (text) {
    banner.textContent = text;
    banner.hidden = false;
    panel.classList.add("your-turn");
  } else {
    banner.hidden = true;
    banner.textContent = "";
    panel.classList.remove("your-turn");
  }
}

function renderActionPanel() {
  const panel = $("action-content");
  panel.innerHTML = "";
  const me = state.players.find((p) => p.id === state.humanPlayerId);
  if (isHumanTurn(me)) {
    const banner =
      state.phase === "night"
        ? "Your turn — act in secret"
        : state.phase === "day-debate"
        ? "Your turn to speak"
        : "Your turn to vote";
    setActionBanner(banner);
  } else {
    setActionBanner(null);
  }
  if (!me || !me.alive) {
    panel.innerHTML = `<div class="action-prompt">${smallSprite(SKULL_TINY, 14)}You're gone. Watch the rest unfold.</div>`;
    return;
  }
  if (state.phase === "night") {
    if (state.role === "werewolf") {
      renderTargetPicker(panel, smallSprite(WEREWOLF, 16) + "Pick a victim", "kill", state.livingPlayers.filter((p) => p.id !== state.humanPlayerId && !state.knownWolves.some((w) => w.id === p.id)));
    } else if (state.role === "seer") {
      renderTargetPicker(panel, smallSprite(SEER, 16) + "Look into one soul", "investigate", state.livingPlayers.filter((p) => p.id !== state.humanPlayerId));
    } else if (state.role === "doctor") {
      renderTargetPicker(panel, smallSprite(DOCTOR, 16) + "Guard one soul", "save", state.livingPlayers);
    } else {
      panel.innerHTML = `<div class="action-prompt">${smallSprite(ZZZ_TINY, 14)}You sleep. Others move in the dark.</div>`;
    }
  } else if (state.phase === "day-debate") {
    panel.innerHTML = `
      <div class="action-prompt">${smallSprite(BUBBLE_TINY, 14)}Speak your mind</div>
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
    renderTargetPicker(panel, smallSprite(BALLOT_TINY, 16) + "Vote to eliminate", "vote", state.livingPlayers.filter((p) => p.id !== state.humanPlayerId));
  } else if (state.phase === "resolution") {
    panel.innerHTML = `<div class="action-prompt">${smallSprite(STAR_TINY, 14)}Resolving</div>`;
  } else {
    panel.innerHTML = `<div class="action-prompt">…</div>`;
  }
}

function renderTargetPicker(panel, labelHtml, kind, targets) {
  panel.innerHTML = `
    <div class="action-prompt">${labelHtml}</div>
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
  checkHumanDeath();
}

function checkHumanDeath() {
  if (state.deathShown) return;
  if (!state.humanPlayerId) return;
  const me = state.players.find((p) => p.id === state.humanPlayerId);
  if (me && !me.alive) {
    state.deathShown = true;
    showDeathOverlay();
  }
}

function showDeathOverlay() {
  const overlay = $("death-overlay");
  if (!overlay) return;
  const info = state.role ? ROLE_INFO[state.role] : null;
  const roleLabel = info ? info.name : "Unknown";
  const flavor = info ? info.flavor : "";
  const title = $("death-title");
  const sub = $("death-sub");
  const roleEl = $("death-role");
  if (title) title.textContent = "You have died";
  if (sub) sub.textContent = "The village story goes on without you. Watch and see how it ends.";
  if (roleEl) roleEl.innerHTML = `You were the <strong>${roleLabel}</strong>${flavor ? ` — ${flavor.toLowerCase()}.` : "."}`;
  overlay.hidden = false;
  const btn = $("death-continue-btn");
  if (btn) btn.focus();
}

function dismissDeathOverlay() {
  const overlay = $("death-overlay");
  if (overlay) overlay.hidden = true;
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
      state.activity.clear();
      renderActivityStrip();
      await fetchPublicState();
      await fetchPlayerView();
      renderActionPanel();
      break;
    case "log":
      if (msg.logType === "speech") {
        for (const [seq, ip] of state.inProgress) {
          if (ip.el && ip.playerName && msg.content.startsWith(`${ip.playerName}:`)) {
            ip.el.classList.remove("in-progress");
            const txt = ip.el.querySelector(".log-text") ?? ip.el;
            txt.textContent = msg.content;
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
      const txt = ip.el.querySelector(".log-text") ?? ip.el;
      txt.textContent = `${ip.playerName}: ${ip.text}`;
      $("log-stream").scrollTop = $("log-stream").scrollHeight;
      break;
    }
    case "death": {
      const mePlayer = state.players.find((p) => p.id === state.humanPlayerId);
      const isMe = mePlayer && msg.victimName === mePlayer.name;
      appendLogEntry({
        logType: "death",
        content: isMe
          ? `You (${msg.victimName}) were killed in the night.`
          : `${msg.victimName} was killed in the night.`,
      });
      await fetchPublicState();
      await fetchPlayerView();
      renderActionPanel();
      break;
    }
    case "vote-result": {
      const mePlayer = state.players.find((p) => p.id === state.humanPlayerId);
      const isMe = mePlayer && msg.executedName === mePlayer.name;
      appendLogEntry({
        logType: "vote-result",
        content: isMe
          ? `You (${msg.executedName}) were eliminated by the village.`
          : msg.executedName
          ? `${msg.executedName} was eliminated.`
          : "No one was eliminated.",
      });
      await fetchPublicState();
      await fetchPlayerView();
      renderActionPanel();
      break;
    }
    case "game-over":
      state.phase = "ended";
      applyPhaseBodyClass();
      showGameOver(msg);
      break;
    case "game-error":
      appendLogEntry({ logType: "death", content: `Game errored: ${msg.message}` });
      break;
    case "action-too-late":
      appendLogEntry({ logType: "system", content: "Too late — the phase has moved on." });
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
    banner.textContent = "The village endures";
    if (sub) sub.textContent = "Dawn breaks. The wolves are gone.";
  } else if (msg.winner === "wolves") {
    banner.textContent = "The wolves feast";
    if (sub) sub.textContent = "The village falls silent.";
  } else {
    banner.textContent = "Something went wrong";
    if (sub) sub.textContent = "The night refuses to end.";
  }
  const ul = $("reveal-list");
  ul.innerHTML = (msg.reveals ?? [])
    .map((r, i) =>
      `<li>${avatar(r.id ?? "human", i, { size: 24 })}<span style="flex:1">${r.name}</span><span class="role-tag">${r.role}</span></li>`,
    )
    .join("");
}

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
  if (!document.body.className.includes("tab-")) {
    document.body.classList.add("tab-log");
  }
}

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

function paintLobby() {
  const sf = $("starfield");
  if (sf) sf.innerHTML = starfield(60, "cf-ai-werewolf-stars");
  const moonHost = $("lobby-moon");
  if (moonHost) moonHost.innerHTML = renderSprite(MOON, { size: 96 });
}

paintLobby();

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

setInterval(updateStallState, 1000);

// ── help modal ─────────────────────────────────────────────
function setupHelpModal() {
  const btn = $("help-btn");
  const modal = $("help-modal");
  if (!btn || !modal) return;
  let lastFocus = null;

  const open = () => {
    lastFocus = document.activeElement;
    modal.hidden = false;
    const close = modal.querySelector("#help-close-btn");
    if (close) close.focus();
  };
  const close = () => {
    modal.hidden = true;
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  };

  btn.addEventListener("click", open);
  modal.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.id === "help-close-btn" || t.getAttribute("data-close") === "backdrop") {
      close();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (!modal.hidden && (e.key === "Escape" || e.key === "Esc")) {
      e.preventDefault();
      close();
    }
  });
}

setupHelpModal();

function setupDeathOverlay() {
  const btn = $("death-continue-btn");
  if (btn) btn.addEventListener("click", dismissDeathOverlay);
}
setupDeathOverlay();
