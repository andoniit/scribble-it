const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const WORDS = require("./words");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3010;

// ---------- Game constants ----------
const ROUNDS_PER_GAME = 3;
const CHOOSE_TIME = 15; // seconds to pick a word
const DRAW_TIME = 80; // seconds to draw
const WORD_CHOICES = 3;
const MIN_PLAYERS = 2;

// ---------- Room state ----------
/** roomId -> room */
const rooms = new Map();

function createRoom(roomId) {
  const room = {
    id: roomId,
    players: [], // { id, name, score, guessedAt }
    phase: "lobby", // lobby | choosing | drawing | roundEnd | gameEnd
    round: 0,
    drawerIdx: -1,
    drawerId: null,
    word: null,
    wordChoices: [],
    revealed: new Set(), // indices of hinted letters
    timer: null,
    timeLeft: 0,
    drawnThisRound: new Set(), // player ids who already drew this round
    strokes: [], // replay buffer for late joiners
  };
  rooms.set(roomId, room);
  return room;
}

function publicPlayers(room) {
  return room.players.map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    guessed: p.guessedAt !== null,
    drawing: p.id === room.drawerId,
  }));
}

function maskedWord(room) {
  if (!room.word) return "";
  return room.word
    .split("")
    .map((ch, i) => (ch === " " || ch === "-" || room.revealed.has(i) ? ch : "_"))
    .join("");
}

function broadcastState(room) {
  io.to(room.id).emit("roomState", {
    phase: room.phase,
    round: room.round,
    maxRounds: ROUNDS_PER_GAME,
    players: publicPlayers(room),
    drawerId: room.drawerId,
    timeLeft: room.timeLeft,
    masked: room.phase === "drawing" ? maskedWord(room) : "",
  });
}

function clearTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function pickWords(n) {
  const picked = new Set();
  while (picked.size < n) {
    picked.add(WORDS[Math.floor(Math.random() * WORDS.length)]);
  }
  return [...picked];
}

function startGame(room) {
  room.round = 1;
  room.players.forEach((p) => (p.score = 0));
  room.drawnThisRound = new Set();
  nextTurn(room);
}

function nextTurn(room) {
  clearTimer(room);
  room.word = null;
  room.revealed = new Set();
  room.strokes = [];
  room.players.forEach((p) => (p.guessedAt = null));

  // Everyone drew? advance the round
  const remaining = room.players.filter((p) => !room.drawnThisRound.has(p.id));
  if (remaining.length === 0) {
    room.round++;
    room.drawnThisRound = new Set();
    if (room.round > ROUNDS_PER_GAME) {
      endGame(room);
      return;
    }
  }

  const candidates = room.players.filter((p) => !room.drawnThisRound.has(p.id));
  if (candidates.length === 0) return; // shouldn't happen
  const drawer = candidates[0];
  room.drawerId = drawer.id;
  room.drawnThisRound.add(drawer.id);
  room.wordChoices = pickWords(WORD_CHOICES);
  room.phase = "choosing";
  room.timeLeft = CHOOSE_TIME;

  io.to(room.id).emit("clearCanvas");
  io.to(drawer.id).emit("chooseWord", { choices: room.wordChoices, time: CHOOSE_TIME });
  io.to(room.id).emit("systemMessage", `${drawer.name} is choosing a word...`);
  broadcastState(room);

  room.timer = setInterval(() => {
    room.timeLeft--;
    if (room.timeLeft <= 0) {
      // auto-pick first word
      beginDrawing(room, room.wordChoices[0]);
    }
  }, 1000);
}

function beginDrawing(room, word) {
  clearTimer(room);
  room.word = word;
  room.phase = "drawing";
  room.timeLeft = DRAW_TIME;
  room.revealed = new Set();

  const drawer = room.players.find((p) => p.id === room.drawerId);
  io.to(room.drawerId).emit("yourWord", word);
  io.to(room.id).emit("systemMessage", `${drawer ? drawer.name : "Someone"} is drawing now!`);
  broadcastState(room);

  const hintAt = [Math.floor(DRAW_TIME * 0.5), Math.floor(DRAW_TIME * 0.25)];
  room.timer = setInterval(() => {
    room.timeLeft--;

    if (hintAt.includes(room.timeLeft)) revealHint(room);

    io.to(room.id).emit("tick", { timeLeft: room.timeLeft, masked: maskedWord(room) });

    if (room.timeLeft <= 0) endTurn(room, "Time's up!");
  }, 1000);
}

function revealHint(room) {
  const hidden = [];
  room.word.split("").forEach((ch, i) => {
    if (ch !== " " && ch !== "-" && !room.revealed.has(i)) hidden.push(i);
  });
  // keep at least one letter hidden
  if (hidden.length > 1) {
    room.revealed.add(hidden[Math.floor(Math.random() * hidden.length)]);
  }
}

function endTurn(room, reason) {
  clearTimer(room);
  room.phase = "roundEnd";
  io.to(room.id).emit("turnEnd", { word: room.word, reason, players: publicPlayers(room) });
  broadcastState(room);
  setTimeout(() => {
    // room may have emptied or restarted while waiting
    if (!rooms.has(room.id) || room.phase !== "roundEnd") return;
    if (room.players.length < MIN_PLAYERS) {
      room.phase = "lobby";
      room.drawerId = null;
      io.to(room.id).emit("systemMessage", "Not enough players — waiting in lobby.");
      broadcastState(room);
      return;
    }
    nextTurn(room);
  }, 5000);
}

function endGame(room) {
  clearTimer(room);
  room.phase = "gameEnd";
  room.drawerId = null;
  const ranking = [...room.players].sort((a, b) => b.score - a.score);
  io.to(room.id).emit("gameEnd", {
    ranking: ranking.map((p) => ({ name: p.name, score: p.score })),
  });
  broadcastState(room);
  setTimeout(() => {
    if (!rooms.has(room.id)) return;
    room.phase = "lobby";
    room.round = 0;
    broadcastState(room);
  }, 10000);
}

function checkAllGuessed(room) {
  const guessers = room.players.filter((p) => p.id !== room.drawerId);
  if (guessers.length > 0 && guessers.every((p) => p.guessedAt !== null)) {
    endTurn(room, "Everyone guessed it!");
  }
}

// ---------- Socket handling ----------
io.on("connection", (socket) => {
  let joinedRoom = null;

  socket.on("join", ({ name, roomId }, ack) => {
    name = String(name || "").trim().slice(0, 16);
    roomId = String(roomId || "lobby").trim().toLowerCase().slice(0, 20) || "lobby";
    if (!name) {
      if (ack) ack({ error: "Please enter a name." });
      return;
    }

    const room = rooms.get(roomId) || createRoom(roomId);
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      if (ack) ack({ error: "That name is taken in this room." });
      return;
    }

    joinedRoom = room;
    socket.join(room.id);
    room.players.push({ id: socket.id, name, score: 0, guessedAt: null });

    if (ack) ack({ ok: true, roomId: room.id, selfId: socket.id });
    io.to(room.id).emit("systemMessage", `${name} joined the game.`);
    broadcastState(room);

    // replay existing drawing for late joiners
    if (room.strokes.length > 0) {
      socket.emit("strokeBatch", room.strokes);
    }
  });

  socket.on("startGame", () => {
    const room = joinedRoom;
    if (!room || room.phase !== "lobby" && room.phase !== "gameEnd") return;
    if (room.players.length < MIN_PLAYERS) {
      socket.emit("systemMessage", `Need at least ${MIN_PLAYERS} players to start.`);
      return;
    }
    startGame(room);
  });

  socket.on("chooseWord", (word) => {
    const room = joinedRoom;
    if (!room || room.phase !== "choosing" || socket.id !== room.drawerId) return;
    if (!room.wordChoices.includes(word)) return;
    beginDrawing(room, word);
  });

  // in the lobby everyone can doodle to warm up; during a game only the drawer draws
  const mayDraw = (room) =>
    room.phase === "lobby" || (room.phase === "drawing" && socket.id === room.drawerId);

  socket.on("stroke", (seg) => {
    const room = joinedRoom;
    if (!room || !mayDraw(room)) return;
    // seg: {x0,y0,x1,y1,color,size} normalized 0..1
    if (typeof seg !== "object" || seg === null) return;
    room.strokes.push(seg);
    if (room.strokes.length > 20000) room.strokes.splice(0, 5000);
    socket.to(room.id).emit("stroke", seg);
  });

  socket.on("clearCanvas", () => {
    const room = joinedRoom;
    if (!room || !mayDraw(room)) return;
    room.strokes = [];
    io.to(room.id).emit("clearCanvas");
  });

  socket.on("guess", (text) => {
    const room = joinedRoom;
    if (!room) return;
    text = String(text || "").trim().slice(0, 100);
    if (!text) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;

    const isDrawer = socket.id === room.drawerId;
    const alreadyGuessed = player.guessedAt !== null;

    if (
      room.phase === "drawing" &&
      !isDrawer &&
      !alreadyGuessed &&
      text.toLowerCase() === room.word.toLowerCase()
    ) {
      player.guessedAt = Date.now();
      // score: more time left = more points
      const points = 50 + Math.ceil((room.timeLeft / DRAW_TIME) * 200);
      player.score += points;
      const drawer = room.players.find((p) => p.id === room.drawerId);
      if (drawer) drawer.score += 30;

      io.to(room.id).emit("correctGuess", { name: player.name, points });
      broadcastState(room);
      checkAllGuessed(room);
      return;
    }

    // drawer & players who guessed can't leak the word
    if (
      room.phase === "drawing" &&
      (isDrawer || alreadyGuessed) &&
      text.toLowerCase().includes(room.word.toLowerCase())
    ) {
      return;
    }

    io.to(room.id).emit("chat", { name: player.name, text, guessed: alreadyGuessed });

    // "close" hint
    if (room.phase === "drawing" && !isDrawer && !alreadyGuessed && room.word) {
      if (levenshtein(text.toLowerCase(), room.word.toLowerCase()) === 1) {
        socket.emit("systemMessage", `"${text}" is close!`);
      }
    }
  });

  socket.on("disconnect", () => {
    const room = joinedRoom;
    if (!room) return;
    const idx = room.players.findIndex((p) => p.id === socket.id);
    if (idx === -1) return;
    const [player] = room.players.splice(idx, 1);
    io.to(room.id).emit("systemMessage", `${player.name} left the game.`);

    if (room.players.length === 0) {
      clearTimer(room);
      rooms.delete(room.id);
      return;
    }

    if (socket.id === room.drawerId && (room.phase === "drawing" || room.phase === "choosing")) {
      endTurn(room, `${player.name} (the drawer) left.`);
    } else if (room.phase === "drawing") {
      checkAllGuessed(room);
    }
    broadcastState(room);
  });
});

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

server.listen(PORT, () => {
  console.log(`Scribble It running at http://localhost:${PORT}`);
});
