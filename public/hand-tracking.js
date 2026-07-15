// Hand tracking via MediaPipe HandLandmarker (tasks-vision).
// Exposes startHandTracking(video, callbacks) / stopHandTracking().
// callbacks.onUpdate({ x, y, pinching, detected }) — x/y normalized 0..1 in
// mirrored (selfie) space, so moving your hand right moves the cursor right.

const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

let landmarker = null;
let running = false;
let rafId = null;
let stream = null;

// exponential smoothing to reduce jitter
const smooth = { x: null, y: null, alpha: 0.45 };

async function loadLandmarker() {
  if (landmarker) return landmarker;
  const vision = await import(`${VISION_URL}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${VISION_URL}/wasm`);
  landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 1,
  });
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
  onStatus?.("hand tracking on 🤚");

  let lastVideoTime = -1;
  const loop = () => {
    if (!running) return;
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const result = landmarker.detectForVideo(video, performance.now());
      if (result.landmarks && result.landmarks.length > 0) {
        const lm = result.landmarks[0];
        const indexTip = lm[8];
        const thumbTip = lm[4];
        // hand size reference: wrist -> middle finger MCP, makes the pinch
        // threshold distance-from-camera invariant
        const handSize = dist(lm[0], lm[9]) || 1e-6;
        const pinching = dist(indexTip, thumbTip) / handSize < 0.55;

        // midpoint of pinch is steadier than the fingertip alone
        const rawX = 1 - (indexTip.x + thumbTip.x) / 2; // mirror for selfie view
        const rawY = (indexTip.y + thumbTip.y) / 2;

        if (smooth.x === null) {
          smooth.x = rawX;
          smooth.y = rawY;
        } else {
          smooth.x += smooth.alpha * (rawX - smooth.x);
          smooth.y += smooth.alpha * (rawY - smooth.y);
        }

        onUpdate({ x: smooth.x, y: smooth.y, pinching, detected: true });
      } else {
        smooth.x = smooth.y = null;
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
}

export function isTracking() {
  return running;
}
