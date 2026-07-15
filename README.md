# ✋ Scribble It

A skribbl.io-style multiplayer drawing & guessing game — except you draw **in the air with your hand**, tracked live through your webcam.

## How it works

- **Multiplayer rooms** — join with a name (and optional room code), 2+ players to start.
- **3 rounds** — each turn, the drawer picks one of 3 words and has 80 seconds to draw it while everyone else guesses in chat. Faster guesses score more; letter hints are revealed over time.
- **Air drawing** — click the 📷 button to enable hand tracking (MediaPipe HandLandmarker):
  - 🤏 **Pinch** thumb + index finger together to draw
  - ✋ **Open** your fingers to move the cursor without drawing
- **Mouse/touch fallback** — regular drawing always works too.

## Run it

```bash
npm install
npm start
```

Then open http://localhost:3010 in two or more browser tabs (or share on your LAN) and hit **Start Game**.

> Note: camera access requires `localhost` or HTTPS.

## Stack

- Node.js + Express + Socket.io (rooms, turns, scoring, chat, stroke relay)
- Vanilla JS canvas client
- MediaPipe `tasks-vision` HandLandmarker via CDN for hand tracking
