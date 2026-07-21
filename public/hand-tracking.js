// Hand tracking via MediaPipe HandLandmarker (tasks-vision).
//
// callbacks.onUpdate({ x, y, mode, detected }) — x/y normalized 0..1 in
// mirrored (selfie) space. mode is one of:
//   "draw"       — one finger pointing (index up, middle folded)
//   "eraseSmall" — three fingers (index + middle + ring)
//   "eraseBig"   — open palm (all four fingers extended)
//   "pinch"      — thumb + index pinched (shortcut for clicking controls)
//   "hover"      — two fingers, fist, or anything else: move only
//
// Recognition works on 3D *world* landmarks and per-finger joint angles, so
// it holds up when the hand is rotated, tilted, or further from the camera —
// none of which a 2D fingertip-distance test survives.

const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

// Pinch hysteresis (thumb-index distance / hand size): ON below, OFF above,
// so a hand resting near the threshold can't flicker.
const PINCH_ON = 0.38;
const PINCH_OFF = 0.55;

// Per-finger curl hysteresis, in radians summed over the two finger joints.
// A straight finger is ~0; a folded one approaches Pi.
const CURL_EXTENDED = 0.9;
const CURL_FOLDED = 1.35;

// Mode voting: a new mode needs a majority of the recent window before it
// takes over. Kept short so gestures switch fast — the per-finger hysteresis
// already removes most of the noise.
const VOTE_WINDOW = 3;
const VOTE_MAJORITY = 2;

// Safety cap for the rAF fallback only, so we don't run inference at 120Hz on
// a high-refresh display. The requestVideoFrameCallback path needs no cap: it
// already fires exactly once per camera frame.
const MAX_FPS = 60;
const RAF_MIN_FRAME_MS = 1000 / MAX_FPS;

// Keep reporting the hand for a moment through a brief detection dropout,
// so a single missed frame doesn't break the stroke you're drawing.
const DROPOUT_GRACE_MS = 110;

const FINGERS = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

let landmarker = null;
let running = false;
let rafId = null;
let videoCbId = null;
let videoEl = null;
let stream = null;

let pinched = false;
let mode = "hover";
let voteBuf = [];
let extended = { index: false, middle: false, ring: false, pinky: false, thumb: false };
let lastSeenAt = 0;
let lastGood = null;
let fps = 0;

// which physical hand to track — the other one is ignored entirely
let preferredHand = "right";
const LABEL_FOR = { right: "Right", left: "Left" };

export function setPreferredHand(hand) {
  preferredHand = hand === "left" ? "left" : "right";
}

export function getTrackingFps() {
  return Math.round(fps);
}

export function pickHandIndex(result) {
  const wanted = LABEL_FOR[preferredHand];
  const lists = result.handednesses || result.handedness || [];
  const n = result.landmarks ? result.landmarks.length : 0;
  for (let i = 0; i < n; i++) {
    const label = lists[i] && lists[i][0] ? lists[i][0].categoryName : null;
    if (label === wanted) return i;
    if (label === null && lists.length === 0) return i; // no handedness info
  }
  return -1;
}

// ---------- One Euro filter: low jitter when still, low lag when moving ----------
class OneEuro {
  // minCutoff sets how much the cursor is smoothed while nearly still, beta
  // how quickly smoothing gives way as you move. Tuned to stay snappy: at
  // rest this tracks ~35% of each new sample, and approaches 1:1 when moving.
  constructor(minCutoff = 2.6, beta = 0.13, dCutoff = 1.2) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
    this.t = null;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }
  filter(value, t) {
    if (this.x === null) {
      this.x = value;
      this.t = t;
      return value;
    }
    const dt = Math.max(1e-3, (t - this.t) / 1000);
    this.t = t;
    const dxRaw = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dxRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}
const fx = new OneEuro();
const fy = new OneEuro();

// ---------- geometry ----------
function angleBetween(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const na = Math.hypot(a[0], a[1], a[2]);
  const nb = Math.hypot(b[0], b[1], b[2]);
  if (!na || !nb) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot / (na * nb))));
}

const vec = (lm, a, b) => [
  lm[b].x - lm[a].x,
  lm[b].y - lm[a].y,
  (lm[b].z || 0) - (lm[a].z || 0),
];

// total bend across a finger's two joints — rotation and scale invariant
function fingerCurl(lm, [mcp, pip, dip, tip]) {
  return (
    angleBetween(vec(lm, mcp, pip), vec(lm, pip, dip)) +
    angleBetween(vec(lm, pip, dip), vec(lm, dip, tip))
  );
}

// per-finger hysteresis kills borderline flicker at the source
function updateExtension(lm) {
  for (const [name, joints] of Object.entries(FINGERS)) {
    const curl = fingerCurl(lm, joints);
    // the thumb is naturally curved, so it needs a looser bar
    const slack = name === "thumb" ? 0.45 : 0;
    if (extended[name]) {
      if (curl > CURL_FOLDED + slack) extended[name] = false;
    } else if (curl < CURL_EXTENDED + slack) {
      extended[name] = true;
    }
  }
}

function detectMode(world) {
  // pinch first: measured in 3D and scaled by hand size, so it behaves the
  // same near and far from the camera
  const handSize = Math.hypot(...vec(world, 0, 9)) || 1e-6;
  const pinchRatio = Math.hypot(...vec(world, 4, 8)) / handSize;
  if (pinched) {
    if (pinchRatio > PINCH_OFF) pinched = false;
  } else if (pinchRatio < PINCH_ON) {
    pinched = true;
  }
  if (pinched) return "pinch";

  updateExtension(world);
  const { index, middle, ring, pinky } = extended;
  const count = index + middle + ring + pinky;

  // count-based, so a slightly lazy finger doesn't break the gesture
  if (count >= 4) return "eraseBig";
  if (count === 3 && index && middle && ring) return "eraseSmall";
  if (count === 2 && index && middle) return "hover";
  if (count === 1 && index) return "draw";
  return "hover";
}

// majority vote over a short window
function stableMode(raw) {
  voteBuf.push(raw);
  if (voteBuf.length > VOTE_WINDOW) voteBuf.shift();
  if (raw === mode) return mode;
  let votes = 0;
  for (const m of voteBuf) if (m === raw) votes++;
  if (votes >= VOTE_MAJORITY) mode = raw;
  return mode;
}

function resetState() {
  pinched = false;
  mode = "hover";
  voteBuf = [];
  extended = { index: false, middle: false, ring: false, pinky: false, thumb: false };
  lastSeenAt = 0;
  lastGood = null;
  fx.reset();
  fy.reset();
}

async function loadLandmarker() {
  if (landmarker) return landmarker;
  const vision = await import(`${VISION_URL}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${VISION_URL}/wasm`);
  const options = (delegate) => ({
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate,
    },
    runningMode: "VIDEO",
    numHands: 2, // see both hands so we can ignore the non-preferred one
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.55,
    minTrackingConfidence: 0.55,
  });
  try {
    landmarker = await vision.HandLandmarker.createFromOptions(fileset, options("GPU"));
  } catch {
    landmarker = await vision.HandLandmarker.createFromOptions(fileset, options("CPU"));
  }
  return landmarker;
}

export async function startHandTracking(video, { onUpdate, onStatus }) {
  if (running) return;
  onStatus?.("loading hand model...");
  await loadLandmarker();

  onStatus?.("requesting camera...");
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: MAX_FPS },
      facingMode: "user",
    },
    audio: false,
  });
  video.srcObject = stream;
  videoEl = video;
  await video.play();

  running = true;
  resetState();
  onStatus?.("hand tracking on");

  let lastInferAt = 0;
  let lastVideoTime = -1;

  // `capped` is only true on the rAF fallback. Gating the frame-synced path on
  // elapsed time would drop frames that arrive a hair early and halve the
  // effective rate, which feels like lag.
  const process = (now, capped) => {
    if (!running) return;
    if (capped && now - lastInferAt < RAF_MIN_FRAME_MS) return;
    if (video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;

    const dt = now - lastInferAt;
    if (lastInferAt) fps += (1000 / dt - fps) * 0.15;
    lastInferAt = now;

    let result = null;
    try {
      result = landmarker.detectForVideo(video, now);
    } catch {
      return; // transient decode hiccup — skip this frame
    }

    const idx = result ? pickHandIndex(result) : -1;
    if (idx !== -1) {
      const screen = result.landmarks[idx];
      // world landmarks are metric 3D; fall back to screen space if absent
      const world = (result.worldLandmarks && result.worldLandmarks[idx]) || screen;

      // anchor slightly behind the fingertip: steadier, and less affected by
      // the fingertip swinging in as you pinch
      const tip = screen[8];
      const pip = screen[6];
      const rawX = 1 - (tip.x * 0.78 + pip.x * 0.22); // mirror for selfie view
      const rawY = tip.y * 0.78 + pip.y * 0.22;

      const x = fx.filter(rawX, now);
      const y = fy.filter(rawY, now);
      const m = stableMode(detectMode(world));

      lastSeenAt = now;
      lastGood = { x, y, mode: m };
      onUpdate({ x, y, mode: m, detected: true });
      return;
    }

    // brief dropout: hold the last known pose rather than lifting the pen
    if (lastGood && now - lastSeenAt < DROPOUT_GRACE_MS) {
      onUpdate({ ...lastGood, detected: true });
      return;
    }

    if (lastGood) {
      lastGood = null;
      resetState();
    }
    onUpdate({ detected: false });
  };

  // requestVideoFrameCallback fires exactly once per decoded frame — no
  // polling, no wasted wake-ups. rAF is the fallback.
  if (typeof video.requestVideoFrameCallback === "function") {
    const onFrame = () => {
      if (!running) return;
      process(performance.now(), false);
      videoCbId = video.requestVideoFrameCallback(onFrame);
    };
    videoCbId = video.requestVideoFrameCallback(onFrame);
  } else {
    const loop = () => {
      if (!running) return;
      process(performance.now(), true);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }
}

export function stopHandTracking(video) {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (videoCbId && videoEl && typeof videoEl.cancelVideoFrameCallback === "function") {
    videoEl.cancelVideoFrameCallback(videoCbId);
  }
  videoCbId = null;
  videoEl = null;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (video) video.srcObject = null;
  resetState();
  fps = 0;
}

export function isTracking() {
  return running;
}
