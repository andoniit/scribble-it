import { startHandTracking, stopHandTracking, isTracking } from "./hand-tracking.js";
import { sfx } from "./sounds.js";

const socket = io();

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const lobby = $("lobby");
const game = $("game");
const canvas = $("drawCanvas");
const ctx = canvas.getContext("2d");
const handCursor = $("handCursor");
const camVideo = $("camVideo");
const camStatus = $("camStatus");
const toolbar = $("toolbar");
const chatList = $("chatList");

// ---------- state ----------
let selfId = null;
let isDrawer = false;
let phase = "lobby";
let color = "#1a1c2c";
let brushSize = 6;
let erasing = false;
let last = null; // last draw point {x, y} normalized

const COLORS = [
  "#1a1c2c", "#ef4444", "#f97316", "#facc15", "#4ade80",
  "#22d3ee", "#5d5fef", "#ef5da8", "#a16207", "#ffffff",
];

// ---------- join flow ----------
function showJoinFields(show) {
  $("modeButtons").classList.toggle("hidden", show);
  $("joinFields").classList.toggle("hidden", !show);
}

// invite links look like https://host/?room=abc123 — jump straight to join
const urlRoom = new URLSearchParams(location.search).get("room");
if (urlRoom) {
  $("roomInput").value = urlRoom;
  const notice = $("roomNotice");
  notice.textContent = `You've been invited to room "${urlRoom}" — enter your name to join!`;
  notice.classList.remove("hidden");
  showJoinFields(true);
}

$("joinModeBtn").addEventListener("click", () => {
  showJoinFields(true);
  $("roomInput").focus();
});
$("backBtn").addEventListener("click", () => showJoinFields(false));
$("joinBtn").addEventListener("click", () => join());
$("roomInput").addEventListener("keydown", (e) => e.key === "Enter" && join());
$("nameInput").addEventListener("keydown", (e) => {
  // Enter on the name field joins if a room code is already visible/prefilled
  if (e.key === "Enter" && !$("joinFields").classList.contains("hidden")) join();
});
$("createBtn").addEventListener("click", () => {
  const code = Math.random().toString(36).slice(2, 8);
  $("roomInput").value = code;
  join(code);
});
$("quickPlay").addEventListener("click", (e) => {
  e.preventDefault();
  join("lobby");
});

function join(roomOverride) {
  const name = $("nameInput").value.trim();
  const typed = $("roomInput").value.trim();
  if (!roomOverride && !typed) {
    $("lobbyError").textContent = "Please enter a room code.";
    return;
  }
  const roomId = (roomOverride || typed).toLowerCase();
  socket.emit("join", { name, roomId }, (res) => {
    if (res.error) {
      $("lobbyError").textContent = res.error;
      return;
    }
    selfId = res.selfId;
    sfx.unlock();
    sfx.pop();
    lobby.classList.add("hidden");
    game.classList.remove("hidden");
    setupInvite(res.roomId);
    $("chatInput").focus();
  });
}

function setupInvite(roomId) {
  const isPublic = roomId === "lobby";
  const link = isPublic ? location.origin : `${location.origin}/?room=${roomId}`;
  history.replaceState(null, "", isPublic ? "/" : `/?room=${roomId}`);

  $("roomCodeLabel").innerHTML = isPublic
    ? "Public room"
    : `Room code: <strong>${roomId}</strong>`;
  $("inviteLink").value = link;
  $("inviteBox").classList.remove("hidden");

  const btn = $("copyLinkBtn");
  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      btn.textContent = "✅ Copied!";
    } catch {
      // clipboard blocked (e.g. non-HTTPS) — select the visible link instead
      $("inviteLink").select();
      document.execCommand("copy");
      btn.textContent = "✅ Copied!";
    }
    setTimeout(() => (btn.textContent = "🔗 Copy invite link"), 2000);
  };
}

// ---------- toolbar ----------
const colorsDiv = $("colors");
COLORS.forEach((c, i) => {
  const b = document.createElement("button");
  b.className = "color-swatch" + (i === 0 ? " active" : "");
  b.style.background = c;
  b.addEventListener("click", () => {
    color = c;
    erasing = false;
    $("eraserBtn").classList.remove("active");
    colorsDiv.querySelectorAll(".color-swatch").forEach((s) => s.classList.remove("active"));
    b.classList.add("active");
  });
  colorsDiv.appendChild(b);
});

$("brushSize").addEventListener("input", (e) => (brushSize = +e.target.value));
$("eraserBtn").addEventListener("click", () => {
  erasing = !erasing;
  $("eraserBtn").classList.toggle("active", erasing);
});
$("clearBtn").addEventListener("click", () => socket.emit("clearCanvas"));

const camBtn = $("camToggleBtn");
camBtn.addEventListener("click", async () => {
  if (isTracking()) {
    stopHandTracking(camVideo);
    camVideo.classList.remove("on");
    camBtn.classList.remove("on");
    camBtn.textContent = "📷 Air-draw";
    handCursor.classList.add("hidden");
    setHandHover(null);
    camStatus.textContent = "camera off";
    return;
  }
  try {
    camVideo.classList.add("on");
    camBtn.textContent = "⏳ starting...";
    await startHandTracking(camVideo, {
      onStatus: (s) => (camStatus.textContent = s),
      onUpdate: handleHand,
    });
    camBtn.classList.add("on");
    camBtn.textContent = "🛑 Stop air-draw";
  } catch (err) {
    camVideo.classList.remove("on");
    camBtn.textContent = "📷 Air-draw";
    camStatus.textContent = "camera unavailable — use mouse";
    console.warn("hand tracking failed:", err);
  }
});

// ---------- drawing helpers ----------
function drawSegment(seg, emit) {
  const w = canvas.width, h = canvas.height;
  ctx.strokeStyle = seg.color;
  ctx.lineWidth = seg.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(seg.x0 * w, seg.y0 * h);
  ctx.lineTo(seg.x1 * w, seg.y1 * h);
  ctx.stroke();
  if (emit) socket.emit("stroke", seg);
}

function clearLocal() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function penColor() {
  return erasing ? "#ffffff" : color;
}

function penSize() {
  return erasing ? brushSize * 3 : brushSize;
}

// normalized point from mouse/touch event
function evtPoint(e) {
  const r = canvas.getBoundingClientRect();
  const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
  const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
  return { x: cx / r.width, y: cy / r.height };
}

// ---------- mouse / touch drawing ----------
let mouseDown = false;
canvas.addEventListener("pointerdown", (e) => {
  if (!isDrawer || phase !== "drawing") return;
  mouseDown = true;
  last = evtPoint(e);
});
window.addEventListener("pointerup", () => {
  mouseDown = false;
  last = null;
});
canvas.addEventListener("pointermove", (e) => {
  if (!mouseDown || !isDrawer || phase !== "drawing") return;
  const p = evtPoint(e);
  if (last) {
    drawSegment(
      { x0: last.x, y0: last.y, x1: p.x, y1: p.y, color: penColor(), size: penSize() },
      true
    );
  }
  last = p;
});

// ---------- hand drawing & hand-controlled UI ----------
// The hand cursor roams the whole canvas area (canvas + toolbar). Pinching
// over the canvas draws; pinching over a button/color/slider activates it.
let handLast = null; // last canvas-space point while drawing
let pinchWas = false;
let pinchTarget = null; // "canvas" | "ui" — what the current pinch grabbed
let lastPinchClick = 0;
let hoverEl = null;

function setHandHover(el) {
  if (hoverEl === el) return;
  hoverEl?.classList.remove("hand-hover");
  hoverEl = el;
  hoverEl?.classList.add("hand-hover");
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function handleHand({ x, y, pinching, detected }) {
  if (!detected) {
    handCursor.classList.add("hidden");
    handLast = null;
    pinchWas = false;
    pinchTarget = null;
    setHandHover(null);
    return;
  }

  const wrap = $("canvasWrap").getBoundingClientRect();
  const px = wrap.left + clamp01(x) * wrap.width;
  const py = wrap.top + clamp01(y) * wrap.height;

  handCursor.classList.remove("hidden");
  handCursor.classList.toggle("pinching", pinching);
  handCursor.style.left = `${px - wrap.left}px`;
  handCursor.style.top = `${py - wrap.top}px`;

  // canvas-space normalized coordinates
  const r = canvas.getBoundingClientRect();
  const cx = (px - r.left) / r.width;
  const cy = (py - r.top) / r.height;
  const overCanvas = cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1;

  // hover feedback + pinch-to-click for anything under the cursor
  const under = document.elementFromPoint(px, py);
  const clickable = under ? under.closest("button, a, .color-swatch") : null;
  setHandHover(overCanvas ? null : clickable);

  if (pinching && !pinchWas) {
    // pinch just started — decide what it grabbed
    if (overCanvas) {
      pinchTarget = "canvas";
    } else {
      pinchTarget = "ui";
      const now = Date.now();
      if (now - lastPinchClick > 450) {
        if (clickable) {
          lastPinchClick = now;
          clickable.click();
        } else if (under && under.id === "brushSize") {
          // pinch on the slider sets brush size from horizontal position
          lastPinchClick = now;
          const sr = under.getBoundingClientRect();
          const frac = clamp01((px - sr.left) / sr.width);
          under.value = Math.round(2 + frac * 28);
          under.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    }
  }

  if (pinching && pinchTarget === "canvas" && isDrawer && phase === "drawing" && overCanvas) {
    const p = { x: clamp01(cx), y: clamp01(cy) };
    if (handLast) {
      drawSegment(
        { x0: handLast.x, y0: handLast.y, x1: p.x, y1: p.y, color: penColor(), size: penSize() },
        true
      );
    }
    handLast = p;
  } else {
    handLast = null;
  }

  if (!pinching) pinchTarget = null;
  pinchWas = pinching;
}

// ---------- chat ----------
function sendGuess() {
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("guess", text);
  input.value = "";
}

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  sendGuess();
});
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendGuess();
  }
});

function addChat(html, cls = "") {
  const li = document.createElement("li");
  if (cls) li.className = cls;
  li.innerHTML = html;
  chatList.appendChild(li);
  chatList.scrollTop = chatList.scrollHeight;
  while (chatList.children.length > 150) chatList.removeChild(chatList.firstChild);
}

const esc = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// consistent emoji avatar per player, derived from the name so every client agrees
const AVATARS = ["🦊", "🐼", "🐸", "🦄", "🐙", "🐯", "🐝", "🐧", "🦁", "🐢", "🐰", "🦖", "🐨", "🐹", "🦉", "🐳"];
function nameHash(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
const avatarFor = (name) => AVATARS[nameHash(name) % AVATARS.length];
const hueFor = (name) => nameHash(name) % 360;

// word shown as letter tiles (blanks for hidden letters)
function setWordTiles(str, label = "") {
  $("wordDisplay").innerHTML =
    (label ? `<span class="draw-label">${label}</span>` : "") +
    str
      .split("")
      .map((ch) => {
        if (ch === " " || ch === "-") return '<span class="tile gap"></span>';
        if (ch === "_") return '<span class="tile blank"></span>';
        return `<span class="tile">${esc(ch)}</span>`;
      })
      .join("");
}

// ---------- sounds ----------
const muteBtn = $("muteBtn");
muteBtn.textContent = sfx.isMuted() ? "🔇" : "🔊";
muteBtn.addEventListener("click", () => {
  muteBtn.textContent = sfx.toggleMute() ? "🔇" : "🔊";
});
// every button press (mouse OR hand-pinch) gives a soft click
document.addEventListener("click", (e) => {
  if (e.target.closest("button, a, .color-swatch")) sfx.click();
});

function confetti(count = 130) {
  const colors = ["#7c5cff", "#ff5da2", "#ffc83d", "#4ade80", "#22d3ee", "#fb7185"];
  for (let i = 0; i < count; i++) {
    const c = document.createElement("div");
    c.className = "confetti";
    c.style.left = `${Math.random() * 100}vw`;
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = `${2.5 + Math.random() * 2.5}s`;
    c.style.animationDelay = `${Math.random() * 0.8}s`;
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 6500);
  }
}

// ---------- socket events ----------
$("startBtn").addEventListener("click", () => socket.emit("startGame"));

socket.on("roomState", (s) => {
  phase = s.phase;
  isDrawer = s.drawerId === selfId;

  $("roundInfo").textContent =
    s.phase === "lobby" ? "Lobby" : `Round ${Math.min(s.round, s.maxRounds)} / ${s.maxRounds}`;

  // word display
  if (s.phase === "lobby") {
    $("wordDisplay").textContent = s.players.length < 2 ? "Waiting for players..." : "Ready to start!";
  } else if (s.phase === "choosing") {
    $("wordDisplay").textContent = "Choosing a word...";
  } else if (s.phase === "drawing" && !isDrawer) {
    setWordTiles(s.masked);
  }

  updateTimer(s.timeLeft);

  // players list
  const ul = $("playersList");
  ul.innerHTML = "";
  const sorted = s.players.slice().sort((a, b) => b.score - a.score);
  const topScore = sorted.length ? sorted[0].score : 0;
  sorted.forEach((p) => {
    const li = document.createElement("li");
    li.className = (p.guessed ? "guessed " : "") + (p.drawing ? "drawing" : "");
    const crown = p.score === topScore && topScore > 0 ? "👑 " : "";
    const h = hueFor(p.name);
    li.innerHTML =
      `<span class="avatar" style="background: linear-gradient(145deg, hsl(${h} 80% 62% / 0.55), hsl(${(h + 60) % 360} 80% 62% / 0.4))">${avatarFor(p.name)}</span>` +
      `<span class="player-name">${crown}${p.drawing ? "✏️ " : ""}${esc(p.name)}${p.id === selfId ? " <small>(you)</small>" : ""}</span>` +
      `<span class="score">${p.score}</span>`;
    ul.appendChild(li);
  });

  $("startBtn").classList.toggle(
    "hidden",
    !(s.phase === "lobby" || s.phase === "gameEnd") || s.players.length < 2
  );
  toolbar.classList.toggle("hidden", !(isDrawer && s.phase === "drawing"));

  if (s.phase !== "choosing") $("chooseModal").classList.add("hidden");
  if (s.phase === "drawing") $("resultModal").classList.add("hidden");
});

socket.on("tick", ({ timeLeft, masked }) => {
  updateTimer(timeLeft);
  if (!isDrawer && phase === "drawing") setWordTiles(masked);
  if (phase === "drawing" && timeLeft > 0 && timeLeft <= 10) sfx.tick();
});

function updateTimer(t) {
  $("timerDisplay").textContent = `⏱ ${t ?? "–"}`;
  $("timerDisplay").classList.toggle("low", t !== null && t <= 10);
}

socket.on("chooseWord", ({ choices }) => {
  sfx.yourTurn();
  const div = $("wordChoices");
  div.innerHTML = "";
  choices.forEach((w) => {
    const b = document.createElement("button");
    b.textContent = w;
    b.addEventListener("click", () => {
      socket.emit("chooseWord", w);
      $("chooseModal").classList.add("hidden");
    });
    div.appendChild(b);
  });
  $("chooseModal").classList.remove("hidden");
});

socket.on("yourWord", (word) => {
  setWordTiles(word, "Draw:");
});

socket.on("stroke", (seg) => drawSegment(seg, false));
socket.on("strokeBatch", (segs) => segs.forEach((seg) => drawSegment(seg, false)));
socket.on("clearCanvas", clearLocal);

socket.on("chat", ({ name, text, guessed }) =>
  addChat(`<span class="who">${esc(name)}:</span> ${esc(text)}`, guessed ? "system" : "")
);
socket.on("systemMessage", (text) => addChat(esc(text), "system"));
socket.on("correctGuess", ({ name, points }) => {
  sfx.correct();
  confetti(45);
  addChat(`🎉 ${esc(name)} guessed the word! (+${points})`, "correct");
});

socket.on("turnEnd", ({ word, reason }) => {
  sfx.roundEnd();
  $("resultTitle").textContent = `The word was: ${word}`;
  $("resultBody").textContent = reason;
  $("resultModal").classList.remove("hidden");
  setTimeout(() => $("resultModal").classList.add("hidden"), 4500);
});

socket.on("gameEnd", ({ ranking }) => {
  sfx.fanfare();
  confetti();
  $("resultTitle").textContent = "🏆 Game Over!";
  const medals = ["🥇", "🥈", "🥉"];
  $("resultBody").innerHTML = ranking
    .map(
      (p, i) =>
        `<div class="rank-row"><span>${medals[i] || `${i + 1}.`} ${esc(p.name)}</span><span>${p.score}</span></div>`
    )
    .join("");
  $("resultModal").classList.remove("hidden");
  setTimeout(() => $("resultModal").classList.add("hidden"), 9000);
});

socket.on("disconnect", () => addChat("Disconnected from server — refresh to rejoin.", "system"));
