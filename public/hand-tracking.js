// Hand tracking via MediaPipe HandLandmarker (tasks-vision).
// Exposes startHandTracking(video, callbacks) / stopHandTracking().
// callbacks.onUpdate({ x, y, pinching, detected }) — x/y normalized 0..1 in
// mirrored (selfie) space, so moving your hand right moves the cursor right.

const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

// Pinch hysteresis (ratio of thumb-index distance to hand size): the pinch
// turns ON only below PINCH_ON and OFF only above PINCH_OFF, so a hand
// hovering right at one threshold can't flicker the pen up and down.
const PINCH_ON = 0.38;
const PINCH_OFF = 0.55;

let landmarker = null;
let running = false;
let rafId = null;
let stream = null;
let pinched = false;

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
    numHands: 1,
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
      if (result && result.landmarks && result.landmarks.length > 0) {
        const lm = result.landmarks[0];
        const indexTip = lm[8];
        const thumbTip = lm[4];
        // hand size reference: wrist -> middle finger MCP, makes the pinch
        // threshold distance-from-camera invariant
        const handSize = dist(lm[0], lm[9]) || 1e-6;
        const pinchRatio = dist(indexTip, thumbTip) / handSize;
        if (pinched) {
          if (pinchRatio > PINCH_OFF) pinched = false;
        } else if (pinchRatio < PINCH_ON) {
          pinched = true;
        }

        // midpoint of pinch is steadier than the fingertip alone
        const rawX = 1 - (indexTip.x + thumbTip.x) / 2; // mirror for selfie view
        const rawY = (indexTip.y + thumbTip.y) / 2;

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

        onUpdate({ x: smooth.x, y: smooth.y, pinching: pinched, detected: true });
      } else {
        smooth.x = smooth.y = null;
        pinched = false;
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
}

export function isTracking() {
  return running;
}
