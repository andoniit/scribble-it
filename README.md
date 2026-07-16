# ✋ Scribble It

A skribbl.io-style multiplayer drawing & guessing game — except you draw **in the air with your hand**, tracked live through your webcam.

## How it works

- **Multiplayer rooms** — join the public room, or hit **Create Private Room** to get a shareable invite link (`/?room=abc123`) your friends can open to join you directly. 2+ players to start.
- **Configurable games** — whoever starts the game picks the settings: time per turn (30–150s), rounds (1–5), word difficulty (easy / medium / hard / mixed), and word categories: 🎨 Classic, 🍕 Food, 🐾 Animals, ⚽ Sports, ⚙️ Engineering, and a cheeky 🔞 After Dark pack.
- **Turns** — each turn, the drawer picks one of 3 words and draws it while everyone else guesses in chat. Faster guesses score more; letter hints are revealed over time.
- **Air drawing** — click the 📷 Air-draw button to enable hand tracking (MediaPipe HandLandmarker):
  - ☝️ **One finger** (index up, middle folded) to draw
  - ✌️ **Two fingers** (index + middle) to move the cursor without drawing
  - 🤟 **Three fingers** (index + middle + ring) for a small eraser
  - 🖐 **Full palm** (all fingers open) for a big eraser
  - 🤏 **Pinch** thumb + index over a color, tool, or the brush slider to select it
- **Mouse/touch fallback** — regular drawing always works too.

## Run it

```bash
npm install
npm start
```

Then open http://localhost:3010 in two or more browser tabs (or share on your LAN) and hit **Start Game**.

> Note: camera access requires `localhost` or HTTPS.

## Deploy (Render)

This app needs a long-lived Node server for its Socket.io WebSockets, so serverless
hosts like Vercel/Netlify won't work. [Render](https://render.com)'s free tier does:

1. Sign in to Render with GitHub and click **New → Blueprint**.
2. Pick this repo — Render reads [render.yaml](render.yaml) and sets everything up.
3. Deploy. You'll get an `https://scribble-it-xxxx.onrender.com` URL — HTTPS included,
   so camera hand-tracking works out of the box.

(Free instances sleep after ~15 min idle; the first visit after that takes ~30s to wake.)

## Stack

- Node.js + Express + Socket.io (rooms, turns, scoring, chat, stroke relay)
- Vanilla JS canvas client
- MediaPipe `tasks-vision` HandLandmarker via CDN for hand tracking
