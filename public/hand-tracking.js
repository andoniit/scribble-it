// Hand tracking via MediaPipe HandLandmarker (tasks-vision).
// Exposes startHandTracking(video, callbacks) / stopHandTracking().
//
// callbacks.onUpdate({ x, y, mode, detected }) — x/y normalized 0..1 in
// mirrored (selfie) space. mode is one of:
//   "draw"       — one finger pointing (index up, middle folded)
//   "eraseSmall" — three fingers (index + middle + ring)
//   "eraseBig"   — full palm (all four fingers extended)
//   "pinch"      — thumb + index pinched, used to click UI elements
//   "hover"      — two fingers, fist, or anything else: move only

const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

// Pinch hysteresis (ratio of thumb-index distance to hand size): the pinch
// turns ON only below PINCH_ON and OFF only above PINCH_OFF, so a hand
// hovering right at one threshold can't flicker.
const PINCH_ON = 0.38;
const PINCH_OFF = 0.55;

// a gesture must hold for this many consecutive frames before the mode
// switches — kills flicker at gesture boundaries (~2 frames ≈ 70ms)
const MODE_STABLE_FRAMES = 2;

let landmarker = null;
let running = false;
let rafId = null;
let stream = null;
let pinched = false;
let mode = "hover";
let pendingMode = null;
let pendingCount = 0;

// which physical hand to track — the other one is ignored entirely.
// NOTE: we feed raw (unmirrored) webcam frames, which flips MediaPipe's
// handedness labels: the physical RIGHT hand is reported as "Left".
let preferredHand = "right";
const LABEL_FOR = { right: "Left", left: "Right" };

export function setPreferredHand(hand) {
  preferredHand = hand === "left" ? "left" : "right";
}

export function pickHandIndex(result) {
  const wanted = LABEL_FOR[preferredHand];
  const lists = result.handednesses || result.handedness || [];
  for (let i = 0; i < (result.landmarks ? result.landmarks.length : 0); i++) {
    const label = lists[i] && lists[i][0] ? lists[i][0].categoryName : null;
    if (label === wanted) return i;
    if (label === null && lists.length === 0) return i; // no handedness info — take what we have
  }
  return -1;
}

// adaptive exponential smoothing: heavy smoothing for slow/precise moves,
// light smoothing for fast strokes so the line doesn't lag behind the hand
const smooth = { x: null, y: null };

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
    minHandDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });
  try {
    landmarker = await vision.HandLandmarker.createFromOptions(fileset, options("GPU"));
  } catch {
    landmarker = await vision.HandLandmarker.createFromOptions(fileset, options("CPU"));
  }
  return landmarker;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// a finger counts as extended when its tip is clearly further from the
// wrist than its middle (PIP) joint — orientation independent
function fingerExtended(lm, tipIdx, pipIdx) {
  const wrist = lm[0];
  return dist(lm[tipIdx], wrist) > dist(lm[pipIdx], wrist) * 1.15;
}

function detectMode(lm) {
  const handSize = dist(lm[0], lm[9]) || 1e-6;
  const pinchRatio = dist(lm[8], lm[4]) / handSize;
  if (pinched) {
    if (pinchRatio > PINCH_OFF) pinched = false;
  } else if (pinchRatio < PINCH_ON) {
    pinched = true;
  }
  if (pinched) return "pinch";

  const index = fingerExtended(lm, 8, 6);
  const middle = fingerExtended(lm, 12, 10);
  const ring = fingerExtended(lm, 16, 14);
  const pinky = fingerExtended(lm, 20, 18);

  if (index && middle && ring && pinky) return "eraseBig"; // full palm
  if (index && middle && ring && !pinky) return "eraseSmall"; // three fingers
  if (index && middle && !ring) return "hover"; // two fingers — move only
  if (index && !middle) return "draw"; // one finger — pointing
  return "hover";
}

// debounce mode switches so a single noisy frame can't lift or drop the pen
function stableMode(raw) {
  if (raw === mode) {
    pendingMode = null;
    pendingCount = 0;
    return mode;
  }
  if (raw === pendingMode) {
    if (++pendingCount >= MODE_STABLE_FRAMES) {
      mode = raw;
      pendingMode = null;
      pendingCount = 0;
    }
  } else {
    pendingMode = raw;
    pendingCount = 1;
  }
  return mode;
}

export async function startHandTracking(video, { onUpdate, onStatus }) {
  if (running) return;
  onStatus?.("loading hand model...");
  await loadLandmarker();

  onStatus?.("requesting camera...");
  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();

  running = true;
  pinched = false;
  mode = "hover";
  onStatus?.("hand tracking on 🤚");

  let lastVideoTime = -1;
  const loop = () => {
    if (!running) return;
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      let result = null;
      try {
        result = landmarker.detectForVideo(video, performance.now());
      } catch {
        /* transient decode hiccup — skip this frame */
      }
      const handIdx = result ? pickHandIndex(result) : -1;
      if (handIdx !== -1) {
        const lm = result.landmarks[handIdx];
        const indexTip = lm[8];

        const rawX = 1 - indexTip.x; // mirror for selfie view
        const rawY = indexTip.y;

        if (smooth.x === null) {
          smooth.x = rawX;
          smooth.y = rawY;
        } else {
          const speed = Math.hypot(rawX - smooth.x, rawY - smooth.y);
          // alpha 0.25 (steady) .. 0.85 (fast flick)
          const alpha = Math.min(0.85, 0.25 + speed * 12);
          smooth.x += alpha * (rawX - smooth.x);
          smooth.y += alpha * (rawY - smooth.y);
        }

        onUpdate({ x: smooth.x, y: smooth.y, mode: stableMode(detectMode(lm)), detected: true });
      } else {
        smooth.x = smooth.y = null;
        pinched = false;
        mode = "hover";
        pendingMode = null;
        pendingCount = 0;
        onUpdate({ detected: false });
      }
    }
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

export function stopHandTracking(video) {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (video) video.srcObject = null;
  smooth.x = smooth.y = null;
  pinched = false;
  mode = "hover";
}

export function isTracking() {
  return running;
}
