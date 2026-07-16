// Tiny WebAudio sound effects — synthesized, no audio files needed.
let ctx = null;
let muted = localStorage.getItem("scribble-muted") === "1";

function ensureCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function tone(freq, { dur = 0.12, type = "sine", vol = 0.12, at = 0, slide } = {}) {
  if (muted) return;
  try {
    const c = ensureCtx();
    const t0 = c.currentTime + at;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch {
    /* audio unavailable — stay silent */
  }
}

export const sfx = {
  // call from a user gesture to satisfy autoplay policies
  unlock() {
    try {
      ensureCtx();
    } catch {}
  },
  click() {
    tone(700, { dur: 0.05, type: "square", vol: 0.045 });
  },
  pop() {
    tone(320, { dur: 0.12, slide: 620, vol: 0.12 });
  },
  leave() {
    tone(520, { dur: 0.15, slide: 240, vol: 0.09 });
  },
  tick() {
    tone(1050, { dur: 0.04, type: "square", vol: 0.055 });
  },
  correct() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.09, dur: 0.18, vol: 0.14, type: "triangle" }));
  },
  yourTurn() {
    [440, 660].forEach((f, i) => tone(f, { at: i * 0.12, dur: 0.16, vol: 0.12, type: "triangle" }));
  },
  roundEnd() {
    [660, 440].forEach((f, i) => tone(f, { at: i * 0.14, dur: 0.2, vol: 0.1, type: "triangle" }));
  },
  fanfare() {
    [523, 659, 784, 1047, 784, 1319].forEach((f, i) => tone(f, { at: i * 0.13, dur: 0.24, vol: 0.13, type: "triangle" }));
  },
  isMuted: () => muted,
  toggleMute() {
    muted = !muted;
    localStorage.setItem("scribble-muted", muted ? "1" : "0");
    return muted;
  },
};
