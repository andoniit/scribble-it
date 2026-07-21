import { startHandTracking, stopHandTracking, isTracking, setPreferredHand } from "./hand-tracking.js";
import { sfx } from "./sounds.js";
import { renderDoodles } from "./doodles.js";
import { createDwell } from "./dwell.js";

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
let isHost = false;
let phase = "lobby";
let color = "#1a1c2c";
let brushSize = 8; // must match one of BRUSH_SIZES so a button starts active
let erasing = false;
let last = null; // last draw point {x, y} normalized

const COLORS = [
  "#1a1c2c", "#ef4444", "#f97316", "#facc15", "#4ade80",
  "#22d3ee", "#5d5fef", "#ef5da8", "#a16207", "#ffffff",
];

// ---------- lobby background doodles ----------
const drawLobbyDoodles = () => {
  if (!lobby.classList.contains("hidden")) renderDoodles(lobby, lobby.querySelector(".lobby-card"));
};
drawLobbyDoodles();
let doodleTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(doodleTimer);
  doodleTimer = setTimeout(drawLobbyDoodles, 250);
});

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
      btn.textContent = "Copied";
    } catch {
      // clipboard blocked (e.g. non-HTTPS) — select the visible link instead
      $("inviteLink").select();
      document.execCommand("copy");
      btn.textContent = "Copied";
    }
    setTimeout(() => (btn.textContent = "Copy invite link"), 2000);
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
    sfx.click();
  });
  colorsDiv.appendChild(b);
});

// four discrete brush sizes — far easier to pinch-select in mid-air than a slider
const BRUSH_SIZES = [4, 8, 16, 26];
const brushSizesDiv = $("brushSizes");
BRUSH_SIZES.forEach((size) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "brush-btn" + (size === brushSize ? " active" : "");
  b.title = `Brush size ${size}`;
  // preview dot is capped so the largest brush still fits inside the button
  const dot = Math.min(size, 18);
  b.innerHTML = `<span class="brush-dot" style="width:${dot}px;height:${dot}px"></span>`;
  b.addEventListener("click", () => {
    brushSize = size;
    brushSizesDiv.querySelectorAll(".brush-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    sfx.click();
  });
  brushSizesDiv.appendChild(b);
});
$("eraserBtn").addEventListener("click", () => {
  erasing = !erasing;
  $("eraserBtn").classList.toggle("active", erasing);
});
$("clearBtn").addEventListener("click", () => {
  // warm-up doodles are local, so clear locally; live turns clear for everyone
  if (canBroadcast()) socket.emit("clearCanvas");
  else clearLocal();
});

// gesture guide shown whenever air-draw turns on
const gestureGuide = $("gestureGuide");
let guideTimer = null;
function showGestureGuide() {
  clearTimeout(guideTimer);
  gestureGuide.classList.remove("hidden", "fading");
  // auto-fade after 10s so it never blocks the canvas for long
  guideTimer = setTimeout(() => {
    gestureGuide.classList.add("fading");
    guideTimer = setTimeout(() => hideGestureGuide(), 700);
  }, 10000);
}
function hideGestureGuide() {
  clearTimeout(guideTimer);
  guideTimer = null;
  gestureGuide.classList.add("hidden");
  gestureGuide.classList.remove("fading");
}
$("guideCloseBtn").addEventListener("click", hideGestureGuide);

// ---------- hand preference (right/left — the other hand is ignored) ----------
const handPrefBtn = $("handPrefBtn");
let handPref = localStorage.getItem("scribble-hand") === "left" ? "left" : "right";

function renderHandPref() {
  handPrefBtn.textContent = handPref === "right" ? "Right hand" : "Left hand";
  $("guideHandName").textContent = handPref;
}
setPreferredHand(handPref);
renderHandPref();

handPrefBtn.addEventListener("click", () => {
  handPref = handPref === "right" ? "left" : "right";
  localStorage.setItem("scribble-hand", handPref);
  setPreferredHand(handPref);
  renderHandPref();
  if (isTracking()) camStatus.textContent = `tracking ${handPref} hand only`;
});

const camBtn = $("camToggleBtn");
let camWantedOn = false; // the player's preference, remembered across auto-pauses

function stopCam() {
  stopHandTracking(camVideo);
  camVideo.classList.remove("on");
  $("camOverlay").classList.add("hidden");
  camBtn.classList.remove("on");
  camBtn.textContent = "Air-draw";
  handCursor.classList.add("hidden");
  setHandHover(null);
  cancelDwell();
  hideGestureGuide();
}

async function startCam(withGuide) {
  try {
    camVideo.classList.add("on");
    camBtn.textContent = "starting...";
    await startHandTracking(camVideo, {
      onStatus: (s) => (camStatus.textContent = s),
      onUpdate: handleHand,
    });
    camBtn.classList.add("on");
    camBtn.textContent = "Stop air-draw";
    $("camOverlay").classList.remove("hidden");
    if (withGuide) showGestureGuide();
    return true;
  } catch (err) {
    camVideo.classList.remove("on");
    camBtn.textContent = "Air-draw";
    camStatus.textContent = "camera unavailable — use mouse";
    console.warn("hand tracking failed:", err);
    return false;
  }
}

camBtn.addEventListener("click", async () => {
  if (isTracking()) {
    camWantedOn = false;
    stopCam();
    camStatus.textContent = "camera off";
  } else {
    camWantedOn = await startCam(true);
  }
});

// hand detection is only for whoever is drawing: guessers get it paused
// automatically while someone else draws, and back when it's their turn
const camAllowed = () => isDrawer || phase === "lobby" || phase === "gameEnd";

function syncCamWithTurn() {
  const allowed = camAllowed();
  camBtn.disabled = !allowed;
  camBtn.classList.toggle("disabled", !allowed);
  if (!allowed && isTracking()) {
    stopCam();
    camStatus.textContent = "air-draw paused while others draw";
  } else if (allowed && camWantedOn && !isTracking()) {
    camStatus.textContent = "resuming air-draw...";
    startCam(false);
  }
}

// ---------- drawing helpers ----------
function drawSegment(seg, emit) {
  const w = canvas.width, h = canvas.height;
  ctx.save();
  if (seg.erase) {
    // real erasing: remove pixels instead of painting background color,
    // so the camera mini-map (which overlays the bitmap) stays clean
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0, 0, 0, 1)";
  } else {
    ctx.strokeStyle = seg.color;
  }
  ctx.lineWidth = seg.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(seg.x0 * w, seg.y0 * h);
  ctx.lineTo(seg.x1 * w, seg.y1 * h);
  ctx.stroke();
  ctx.restore();
  if (emit) socket.emit("stroke", seg);
}

function clearLocal() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function penColor() {
  return color;
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

// lobby = free warm-up doodling for everyone; in-game only the drawer draws
const canDrawNow = () => phase === "lobby" || (isDrawer && phase === "drawing");
// warm-up doodles stay on your own screen — only real turns are broadcast
const canBroadcast = () => isDrawer && phase === "drawing";

// ---------- mouse / touch drawing ----------
let mouseDown = false;
canvas.addEventListener("pointerdown", (e) => {
  if (!canDrawNow()) return;
  mouseDown = true;
  last = evtPoint(e);
});
window.addEventListener("pointerup", () => {
  mouseDown = false;
  last = null;
});
canvas.addEventListener("pointermove", (e) => {
  if (!mouseDown || !canDrawNow()) return;
  const p = evtPoint(e);
  if (last) {
    drawSegment(
      { x0: last.x, y0: last.y, x1: p.x, y1: p.y, color: penColor(), size: penSize(), erase: erasing },
      canBroadcast()
    );
  }
  last = p;
});

// ---------- hand drawing & hand-controlled UI ----------
// Gestures: ☝️ point (one finger) draws, 🖐 three fingers erases,
// 🤏 pinch clicks buttons/colors/slider under the cursor.
let handLast = null; // last canvas-space point while drawing/erasing
let handLastMode = null;
let modeWas = "hover";
let lastPinchClick = 0;
let hoverEl = null;

function setHandHover(el) {
  if (hoverEl === el) return;
  hoverEl?.classList.remove("hand-hover");
  hoverEl = el;
  hoverEl?.classList.add("hand-hover");
}

// ---------- dwell-to-select ----------
const dwell = createDwell({
  // camera controls are excluded: dwelling there could switch tracking off
  // mid-draw, stranding the player
  isEligible: (el) => !el.closest("#camControls"),
  onProgress: (p) => {
    handCursor.style.setProperty("--dwell", p.toFixed(3));
    handCursor.classList.toggle("dwelling", p > 0);
  },
});
const updateDwell = dwell.update;
const cancelDwell = dwell.cancel;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ---------- camera mini-map ----------
// Painted over the camera preview: the canvas region (with a live miniature
// of the drawing) plus your fingertip, so you can see where you're aiming.
const camOverlay = $("camOverlay");
const octx = camOverlay.getContext("2d");
const MODE_DOT = { draw: "#ff5da2", pinch: "#7c5cff", eraseSmall: "#a78bfa", eraseBig: "#a78bfa" };

function renderCamOverlay(hand) {
  if (camOverlay.classList.contains("hidden")) return;
  // match the video's rendered size (minus its 2px border)
  const vw = camVideo.clientWidth - 4;
  const vh = camVideo.clientHeight - 4;
  if (vw <= 0 || vh <= 0) return;
  if (camOverlay.width !== vw || camOverlay.height !== vh) {
    camOverlay.width = vw;
    camOverlay.height = vh;
    camOverlay.style.height = `${vh}px`;
  }
  octx.clearRect(0, 0, vw, vh);

  // the draw canvas occupies a sub-rectangle of the hand's roaming area
  const w = $("canvasWrap").getBoundingClientRect();
  const r = canvas.getBoundingClientRect();
  const mx = ((r.left - w.left) / w.width) * vw;
  const my = ((r.top - w.top) / w.height) * vh;
  const mw = (r.width / w.width) * vw;
  const mh = (r.height / w.height) * vh;

  octx.fillStyle = "rgba(255, 253, 248, 0.55)";
  octx.fillRect(mx, my, mw, mh);
  octx.drawImage(canvas, mx, my, mw, mh); // live miniature of the drawing
  octx.setLineDash([5, 4]);
  octx.lineWidth = 2;
  octx.strokeStyle = "#7c5cff";
  octx.strokeRect(mx, my, mw, mh);
  octx.setLineDash([]);

  if (hand && hand.detected) {
    const px = hand.x * vw;
    const py = hand.y * vh;
    const erasing = hand.mode === "eraseSmall" || hand.mode === "eraseBig";
    octx.beginPath();
    octx.arc(px, py, erasing ? (hand.mode === "eraseBig" ? 9 : 6) : 4.5, 0, Math.PI * 2);
    if (hand.mode === "hover" || erasing) {
      octx.strokeStyle = MODE_DOT[hand.mode] || "rgba(255,255,255,0.95)";
      octx.lineWidth = 2.5;
      octx.stroke();
    } else {
      octx.fillStyle = MODE_DOT[hand.mode];
      octx.fill();
    }
  }
}

function handleHand({ x, y, mode, detected }) {
  renderCamOverlay({ x, y, mode, detected });
  if (!detected) {
    handCursor.classList.add("hidden");
    handLast = null;
    handLastMode = null;
    modeWas = "hover";
    setHandHover(null);
    cancelDwell();
    return;
  }

  const wrap = $("canvasWrap").getBoundingClientRect();
  const px = wrap.left + clamp01(x) * wrap.width;
  const py = wrap.top + clamp01(y) * wrap.height;

  handCursor.classList.remove("hidden");
  handCursor.classList.toggle("drawing", mode === "draw");
  handCursor.classList.toggle("erasing", mode === "eraseSmall" || mode === "eraseBig");
  handCursor.classList.toggle("erasing-big", mode === "eraseBig");
  handCursor.classList.toggle("pinching", mode === "pinch");
  handCursor.style.left = `${px - wrap.left}px`;
  handCursor.style.top = `${py - wrap.top}px`;

  // canvas-space normalized coordinates
  const r = canvas.getBoundingClientRect();
  const cx = (px - r.left) / r.width;
  const cy = (py - r.top) / r.height;
  const overCanvas = cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1;

  // hover feedback for anything under the cursor.
  // The toolbar floats ON the canvas, so UI under the cursor always wins
  // over drawing — hovering a tool never paints behind it.
  const under = document.elementFromPoint(px, py);
  const clickable = under ? under.closest("button, a, .color-swatch") : null;
  const overUI = !!(clickable || (under && under.closest("#toolbar")));
  setHandHover(clickable);

  // primary selection: dwell. Hold the cursor on a control and it activates,
  // so nothing about your hand shape has to change at the moment you commit.
  updateDwell(clickable, px, py);

  // pinch still works as an instant shortcut for anyone who prefers it
  if (mode === "pinch" && modeWas !== "pinch" && overUI) {
    const now = Date.now();
    if (now - lastPinchClick > 450) {
      if (clickable) {
        lastPinchClick = now;
        cancelDwell();
        clickable.click();
      }
    }
  }

  const erasing = mode === "eraseSmall" || mode === "eraseBig";
  const acting = mode === "draw" || erasing;
  if (acting && canDrawNow() && overCanvas && !overUI) {
    const p = { x: clamp01(cx), y: clamp01(cy) };
    // don't connect a draw stroke to an erase stroke (or a small to a big one)
    if (handLast && handLastMode === mode) {
      let seg;
      if (erasing) {
        const eraseSize = mode === "eraseBig" ? Math.max(brushSize * 7, 64) : Math.max(brushSize * 2.5, 24);
        seg = { x0: handLast.x, y0: handLast.y, x1: p.x, y1: p.y, size: eraseSize, erase: true };
      } else {
        seg = { x0: handLast.x, y0: handLast.y, x1: p.x, y1: p.y, color: penColor(), size: penSize() };
      }
      drawSegment(seg, canBroadcast());
    }
    handLast = p;
    handLastMode = mode;
  } else {
    handLast = null;
    handLastMode = null;
  }

  modeWas = mode;
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

function nameHash(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
const avatarFor = (name) => esc(name.trim().charAt(0).toUpperCase() || "?");
// flat neo-brutalist avatar colours, picked deterministically from the name
const AVATAR_COLORS = ["#ffd84d", "#ff6b9d", "#4ecdc4", "#ff7a5c", "#b79cff", "#6ba6ff", "#7be495"];
const avatarColor = (name) => AVATAR_COLORS[nameHash(name) % AVATAR_COLORS.length];

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
muteBtn.textContent = sfx.isMuted() ? "Sound off" : "Sound on";
muteBtn.addEventListener("click", () => {
  muteBtn.textContent = sfx.toggleMute() ? "Sound off" : "Sound on";
});
// every button press (mouse OR hand-pinch) gives a soft click
document.addEventListener("click", (e) => {
  if (e.target.closest("button, a, .color-swatch")) sfx.click();
});

function confetti(count = 130) {
  const colors = ["#ffd84d", "#ff6b9d", "#4ecdc4", "#ff7a5c", "#b79cff", "#7be495"];
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
// ---------- game settings ----------
const CATEGORIES = [
  { id: "classic", label: "Classic" },
  { id: "food", label: "Food" },
  { id: "animals", label: "Animals" },
  { id: "sports", label: "Sports" },
  { id: "engineering", label: "Engineering" },
  { id: "adult", label: "After Dark (18+)" },
];
const gameSettings = {
  drawTime: 80,
  rounds: 3,
  difficulty: "all",
  categories: ["classic"],
};

// single-select segmented control
function buildSeg(id, options, key) {
  const seg = $(id);
  options.forEach(({ value, label }) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.classList.toggle("active", gameSettings[key] === value);
    b.addEventListener("click", () => {
      gameSettings[key] = value;
      seg.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
    });
    seg.appendChild(b);
  });
}

buildSeg("setTime", [30, 60, 80, 120, 150].map((v) => ({ value: v, label: `${v}s` })), "drawTime");
buildSeg("setRounds", [1, 2, 3, 5].map((v) => ({ value: v, label: `${v}` })), "rounds");
buildSeg(
  "setDiff",
  [
    { value: "easy", label: "Easy" },
    { value: "medium", label: "Medium" },
    { value: "hard", label: "Hard" },
    { value: "all", label: "Mixed" },
  ],
  "difficulty"
);

// multi-select category chips (at least one must stay on)
CATEGORIES.forEach(({ id, label }) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cat-chip" + (id === "adult" ? " adult" : "");
  b.textContent = label;
  b.classList.toggle("active", gameSettings.categories.includes(id));
  b.addEventListener("click", () => {
    const on = gameSettings.categories.includes(id);
    if (on && gameSettings.categories.length === 1) return; // keep at least one
    gameSettings.categories = on
      ? gameSettings.categories.filter((c) => c !== id)
      : [...gameSettings.categories, id];
    b.classList.toggle("active", !on);
  });
  $("setCats").appendChild(b);
});

$("startBtn").addEventListener("click", () => $("settingsModal").classList.remove("hidden"));
$("settingsCancelBtn").addEventListener("click", () => $("settingsModal").classList.add("hidden"));
$("settingsStartBtn").addEventListener("click", () => {
  $("settingsModal").classList.add("hidden");
  socket.emit("startGame", gameSettings);
});

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

  // only show the countdown in timed phases
  updateTimer(s.phase === "drawing" || s.phase === "choosing" ? s.timeLeft : null);

  // players list
  const ul = $("playersList");
  ul.innerHTML = "";
  const sorted = s.players.slice().sort((a, b) => b.score - a.score);
  const topScore = sorted.length ? sorted[0].score : 0;
  sorted.forEach((p) => {
    const li = document.createElement("li");
    li.className = (p.guessed ? "guessed " : "") + (p.drawing ? "drawing" : "");
    const leader = p.score === topScore && topScore > 0 ? '<span class="leader-mark">&#10022;</span> ' : "";
    const av = avatarColor(p.name);
    li.innerHTML =
      `<span class="avatar" style="background: ${av}">${avatarFor(p.name)}</span>` +
      `<span class="player-name">${leader}${esc(p.name)}${p.id === selfId ? " <small>(you)</small>" : ""}` +
      `${p.host ? ' <small class="host-tag">host</small>' : ""}` +
      `${p.drawing ? ' <small class="drawing-tag">drawing</small>' : ""}</span>` +
      `<span class="score">${p.score}</span>`;
    ul.appendChild(li);
  });

  // only the host starts games; everyone else is told who to wait for
  isHost = s.hostId === selfId;
  const canStartPhase = s.phase === "lobby" || s.phase === "gameEnd";
  $("startBtn").classList.toggle("hidden", !canStartPhase || !isHost || s.players.length < 2);

  const waitMsg = $("waitingForHost");
  const host = s.players.find((p) => p.id === s.hostId);
  if (canStartPhase && !isHost && s.players.length >= 2 && host) {
    waitMsg.textContent = `Waiting for ${host.name} to start the game`;
    waitMsg.classList.remove("hidden");
  } else {
    waitMsg.classList.add("hidden");
  }
  toolbar.classList.toggle("hidden", !canDrawNow());
  syncCamWithTurn();

  // contextual hint about the tools
  const hint = $("canvasHint");
  if (s.phase === "lobby") {
    hint.textContent = "Warm-up — doodle freely; only you can see your canvas.";
    hint.classList.remove("hidden");
  } else if (s.phase === "drawing" && !isDrawer) {
    hint.textContent = "Guess the word — drawing tools unlock on your turn.";
    hint.classList.remove("hidden");
  } else {
    hint.classList.add("hidden");
  }

  if (s.phase !== "choosing") $("chooseModal").classList.add("hidden");
  if (s.phase === "drawing") $("resultModal").classList.add("hidden");
  // someone else may have started the game while this player had settings open
  if (s.phase !== "lobby" && s.phase !== "gameEnd") $("settingsModal").classList.add("hidden");
});

socket.on("tick", ({ timeLeft, masked }) => {
  updateTimer(timeLeft);
  if (!isDrawer && phase === "drawing") setWordTiles(masked);
  if (phase === "drawing" && timeLeft > 0 && timeLeft <= 10) sfx.tick();
});

function updateTimer(t) {
  $("timerDisplay").textContent = t ? `${t}s` : "—";
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
  addChat(`${esc(name)} guessed the word (+${points})`, "correct");
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
  $("resultTitle").textContent = "Game over";
  
  $("resultBody").innerHTML = ranking
    .map(
      (p, i) =>
        `<div class="rank-row"><span><span class="rank-num">${i + 1}</span> ${esc(p.name)}</span><span>${p.score}</span></div>`
    )
    .join("");
  $("resultModal").classList.remove("hidden");
  setTimeout(() => $("resultModal").classList.add("hidden"), 9000);
});

socket.on("disconnect", () => addChat("Disconnected from server — refresh to rejoin.", "system"));
