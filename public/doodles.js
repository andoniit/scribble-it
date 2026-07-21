// Scatters rough, hand-drawn doodles behind the lobby card — the same
// wobbly marker look you get drawing in the game itself.

const NS = "http://www.w3.org/2000/svg";
const PALETTE = ["#ff6b9d", "#4ecdc4", "#ff7a5c", "#b79cff", "#6ba6ff", "#7be495", "#ffd84d", "#14110f"];

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------- geometry helpers (all shapes live in a 0..100 box) ----------
function circle(cx, cy, r, seg = 22) {
  const pts = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

function arc(cx, cy, r, a0, a1, seg = 14) {
  const pts = [];
  for (let i = 0; i <= seg; i++) {
    const a = a0 + ((a1 - a0) * i) / seg;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

// ---------- the doodles ----------
const SHAPES = [
  function star() {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 20 : 46;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      pts.push([50 + Math.cos(a) * r, 50 + Math.sin(a) * r]);
    }
    pts.push(pts[0]);
    return [{ pts }];
  },

  function heart() {
    const pts = [];
    for (let t = 0; t <= Math.PI * 2 + 0.01; t += Math.PI / 22) {
      const x = 16 * Math.sin(t) ** 3;
      const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
      pts.push([50 + x * 2.5, 50 + y * 2.5]);
    }
    return [{ pts, smooth: true }];
  },

  function smiley() {
    return [
      { pts: circle(50, 50, 42), smooth: true },
      { pts: circle(37, 40, 4, 8), smooth: true },
      { pts: circle(63, 40, 4, 8), smooth: true },
      { pts: arc(50, 52, 24, 0.35, Math.PI - 0.35), smooth: true },
    ];
  },

  function cat() {
    return [
      { pts: circle(50, 54, 34), smooth: true },
      { pts: [[26, 32], [22, 8], [45, 24]] },
      { pts: [[74, 32], [78, 8], [55, 24]] },
      { pts: circle(39, 50, 3.5, 8), smooth: true },
      { pts: circle(61, 50, 3.5, 8), smooth: true },
      { pts: [[30, 66], [10, 62]] },
      { pts: [[30, 71], [11, 74]] },
      { pts: [[70, 66], [90, 62]] },
      { pts: [[70, 71], [89, 74]] },
    ];
  },

  function house() {
    return [
      { pts: [[22, 92], [22, 46], [78, 46], [78, 92], [22, 92]] },
      { pts: [[14, 48], [50, 14], [86, 48]] },
      { pts: [[42, 92], [42, 66], [60, 66], [60, 92]] },
    ];
  },

  function cloud() {
    return [
      { pts: [...arc(34, 58, 17, Math.PI, Math.PI * 2), ...arc(56, 52, 22, Math.PI * 1.1, Math.PI * 2.05), [78, 62], [26, 62]], smooth: true },
    ];
  },

  function sun() {
    const strokes = [{ pts: circle(50, 50, 24), smooth: true }];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      strokes.push({ pts: [[50 + Math.cos(a) * 32, 50 + Math.sin(a) * 32], [50 + Math.cos(a) * 46, 50 + Math.sin(a) * 46]] });
    }
    return strokes;
  },

  function flower() {
    const strokes = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      strokes.push({ pts: circle(50 + Math.cos(a) * 22, 44 + Math.sin(a) * 22, 14), smooth: true });
    }
    strokes.push({ pts: circle(50, 44, 8), smooth: true });
    strokes.push({ pts: [[50, 60], [50, 96]] });
    return strokes;
  },

  function fish() {
    return [
      { pts: [...arc(46, 50, 26, -Math.PI * 0.85, Math.PI * 0.85)], smooth: true },
      { pts: [[70, 34], [92, 50], [70, 66]] },
      { pts: circle(36, 43, 3.5, 8), smooth: true },
    ];
  },

  function tree() {
    return [
      { pts: circle(50, 40, 30), smooth: true },
      { pts: [[50, 68], [50, 94]] },
      { pts: [[50, 78], [34, 68]] },
      { pts: [[50, 84], [66, 74]] },
    ];
  },

  function bolt() {
    return [{ pts: [[58, 8], [30, 54], [48, 54], [38, 94], [72, 42], [52, 42], [58, 8]] }];
  },

  function spiral() {
    const pts = [];
    for (let t = 0; t < Math.PI * 5; t += 0.28) {
      const r = 3 + t * 3.1;
      pts.push([50 + Math.cos(t) * r, 50 + Math.sin(t) * r]);
    }
    return [{ pts, smooth: true }];
  },

  function balloon() {
    const pts = [];
    for (let t = 0; t <= Math.PI * 2 + 0.01; t += Math.PI / 18) {
      pts.push([50 + Math.cos(t) * 26, 40 + Math.sin(t) * 30]);
    }
    return [
      { pts, smooth: true },
      { pts: [[50, 70], [55, 78], [45, 86], [52, 96]], smooth: true },
    ];
  },

  function mountain() {
    return [
      { pts: [[8, 82], [32, 34], [50, 60], [68, 22], [92, 82], [8, 82]] },
      { pts: [[24, 56], [32, 46], [40, 56]] },
    ];
  },

  function note() {
    return [
      { pts: circle(36, 74, 13), smooth: true },
      { pts: [[49, 74], [49, 18]] },
      { pts: [[49, 18], [80, 28], [80, 40], [49, 30]], smooth: true },
    ];
  },

  function arrow() {
    return [
      { pts: [[12, 74], [40, 40], [62, 58], [88, 22]], smooth: true },
      { pts: [[70, 22], [88, 22], [88, 40]] },
    ];
  },
];

// ---------- rough rendering ----------
// jitter every point and stroke each path twice, so lines look drawn by hand
function jitter(pts, amt) {
  return pts.map(([x, y]) => [x + rnd(-amt, amt), y + rnd(-amt, amt)]);
}

function toPath(pts, smooth) {
  if (!smooth || pts.length < 3) {
    return pts.map(([x, y], i) => `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  }
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const xc = ((pts[i][0] + pts[i + 1][0]) / 2).toFixed(1);
    const yc = ((pts[i][1] + pts[i + 1][1]) / 2).toFixed(1);
    d += ` Q ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${xc} ${yc}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
}

function drawDoodle(svg, { x, y, size, rot, color }) {
  const g = document.createElementNS(NS, "g");
  g.setAttribute("transform", `translate(${x} ${y}) rotate(${rot}) scale(${size / 100}) translate(-50 -50)`);
  g.setAttribute("fill", "none");
  g.setAttribute("stroke", color);
  g.setAttribute("stroke-linecap", "round");
  g.setAttribute("stroke-linejoin", "round");

  // counteract the group scale so every doodle is drawn with the same
  // apparent pen width, whatever its size
  const penWidth = rnd(2.8, 3.8) * (100 / size);

  for (const { pts, smooth } of pick(SHAPES)()) {
    // two passes with different jitter = sketchy double-stroke
    for (let pass = 0; pass < 2; pass++) {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", toPath(jitter(pts, 1.6), smooth));
      p.setAttribute("stroke-width", penWidth.toFixed(2));
      p.setAttribute("opacity", pass ? 0.5 : 1);
      g.appendChild(p);
    }
  }
  svg.appendChild(g);
}

// ---------- placement ----------
export function renderDoodles(host, avoidEl) {
  const old = host.querySelector(".doodle-layer");
  if (old) old.remove();

  const w = host.clientWidth;
  const h = host.clientHeight;
  if (!w || !h) return;

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "doodle-layer");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("aria-hidden", "true");

  // narrow screens leave only thin bands above/below the card, so shrink the
  // doodles and the clearance to let a few still fit
  const compact = w < 640;
  const pad = compact ? 10 : 40;

  // keep clear of the card in the middle
  const hostBox = host.getBoundingClientRect();
  const card = avoidEl ? avoidEl.getBoundingClientRect() : null;
  const keepOut = card && {
    x0: card.left - hostBox.left - pad,
    x1: card.right - hostBox.left + pad,
    y0: card.top - hostBox.top - pad,
    y1: card.bottom - hostBox.top + pad,
  };

  const count = Math.round(Math.min(26, Math.max(8, (w * h) / 62000)));
  for (let i = 0; i < count; i++) {
    const size = compact ? rnd(44, 78) : rnd(64, 132);
    let x, y, tries = 0;
    do {
      x = rnd(size * 0.5, w - size * 0.5);
      y = rnd(size * 0.5, h - size * 0.5);
      tries++;
    } while (
      tries < 60 &&
      keepOut &&
      x > keepOut.x0 - size / 2 && x < keepOut.x1 + size / 2 &&
      y > keepOut.y0 - size / 2 && y < keepOut.y1 + size / 2
    );
    if (tries >= 60) continue; // genuinely no room — skip it
    drawDoodle(svg, { x, y, size, rot: rnd(-28, 28), color: pick(PALETTE) });
  }

  host.prepend(svg);
}
