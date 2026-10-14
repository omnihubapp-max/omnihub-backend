// ================================================================
//  OmniHub — 75-Ball Bingo Engine (Server-Authoritative)
//  File: engine/BingoEngine.js
//
//  Architecture:
//    • Cryptographically fair RNG (no Math.random)
//    • Bitmask win detection — checks 1000 cards in microseconds
//    • Socket.io rooms — every player in a room gets same balls
//    • OmniCoin betting → ETB prize payout
//    • Anti-cheat: all state lives on server, clients are dumb terminals
// ================================================================

import { Server }        from "socket.io";
import { createServer }  from "http";
import express           from "express";
import pg                from "pg";
import jwt               from "jsonwebtoken";
import crypto            from "crypto";

const app    = express();
const http   = createServer(app);
const pool   = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET ?? "dev_secret";

// ── Socket.io with CORS for TMA + Web ───────────────────────────
export const io = new Server(http, {
  cors: { origin: "*", methods: ["GET","POST"] },
  transports: ["websocket","polling"],
});

// ================================================================
//  CONSTANTS
// ================================================================

// Win pattern bitmasks for a 5×5 grid (25 bits, LSB = cell[0][0])
// Layout: columns B=0..4, I=5..9, N=10..14, G=15..19, O=20..24
// FREE cell is bit 12 (center, always marked)
const FREE_BIT = 12;

const WIN_PATTERNS = {
  // ── 5 Rows ──
  row0: 0b00000_00000_00000_00000_11111,
  row1: 0b00000_00000_00000_11111_00000,
  row2: 0b00000_00000_11111_00000_00000,  // contains FREE
  row3: 0b00000_11111_00000_00000_00000,
  row4: 0b11111_00000_00000_00000_00000,

  // ── 5 Columns ──
  colB: 0b00001_00001_00001_00001_00001,
  colI: 0b00010_00010_00010_00010_00010,
  colN: 0b00100_00100_00100_00100_00100,  // contains FREE
  colG: 0b01000_01000_01000_01000_01000,
  colO: 0b10000_10000_10000_10000_10000,

  // ── 2 Diagonals ──
  diagMain:  0b10000_01000_00100_00010_00001,  // top-left → bottom-right
  diagAnti:  0b00001_00010_00100_01000_10000,  // top-right → bottom-left

  // ── Four Corners ──
  corners: 0b10000_00000_00000_00000_00001 |
           0b00001_00000_00000_00000_10000,

  // ── Full House (all 25 cells) ──
  fullHouse: 0b11111_11111_11111_11111_11111,
};

// Column ranges for 75-ball bingo
const COL_RANGES = {
  B: [1,  15],
  I: [16, 30],
  N: [31, 45],
  G: [46, 60],
  O: [61, 75],
};

// ================================================================
//  CARD GENERATION (server-side, cryptographically seeded)
// ================================================================
export function generateCard(seed = null) {
  // Use provided seed or generate fresh one for reproducibility / audit
  const rngSeed = seed ?? crypto.randomBytes(32).toString("hex");

  // Seeded shuffle using seed as HMAC key
  function seededRandom(input, index) {
    const hmac = crypto.createHmac("sha256", rngSeed);
    hmac.update(`${input}:${index}`);
    return parseInt(hmac.digest("hex").slice(0, 8), 16) / 0xFFFFFFFF;
  }

  function seededSample(min, max, count, colKey) {
    const pool = Array.from({ length: max - min + 1 }, (_, i) => i + min);
    // Fisher-Yates with seeded random
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(seededRandom(`${colKey}:${i}`, i) * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count);
  }

  const columns = {};
  Object.entries(COL_RANGES).forEach(([col, [min, max]], ci) => {
    columns[col] = seededSample(min, max, 5, `${col}:${ci}`);
  });

  // FREE space at N[2] (row index 2 of N column)
  columns.N[2] = "FREE";

  return { columns, seed: rngSeed };
}

// ================================================================
//  BITMASK UTILITIES
// ================================================================

/**
 * Build a 25-bit bitmask from a card given the called numbers.
 * Bit layout: B col = bits 0-4, I = 5-9, N = 10-14, G = 15-19, O = 20-24
 * FREE (center) is always set.
 */
function buildMask(card, calledSet) {
  let mask = 0;

  // FREE is always marked
  mask |= (1 << FREE_BIT);

  const cols = ["B","I","N","G","O"];
  cols.forEach((col, ci) => {
    card.columns[col].forEach((val, row) => {
      if (val === "FREE") return;
      if (calledSet.has(val)) {
        const bitPos = ci * 5 + row;
        mask |= (1 << bitPos);
      }
    });
  });

  return mask;
}

/**
 * Check if a bitmask satisfies any win pattern.
 * O(1) — single bitwise AND per pattern check.
 * Can check 1000 cards in <1ms.
 */
function checkWin(mask, pattern = "any_line") {
  if (pattern === "any_line") {
    return Object.entries(WIN_PATTERNS)
      .filter(([k]) => k !== "fullHouse")
      .some(([, pm]) => (mask & pm) === pm);
  }
  if (WIN_PATTERNS[pattern]) {
    return (mask & WIN_PATTERNS[pattern]) === WIN_PATTERNS[pattern];
  }
  return false;
}

/**
 * Validate a claim server-side.
 * Returns { valid, pattern } or { valid: false }
 */
export function validateClaim(card, calledNumbers) {
  const calledSet = new Set(calledNumbers);
  const mask      = buildMask(card, calledSet);

  for (const [pattern, pm] of Object.entries(WIN_PATTERNS)) {
    if (pattern === "fullHouse") continue; // separate prize tier
    if ((mask & pm) === pm) return { valid: true, pattern, mask };
  }
  return { valid: false };
}

// ================================================================
//  ROOM STATE MANAGER
// ================================================================

class GameRoom {
  constructor(roomId, config) {
    this.roomId      = roomId;
    this.config      = config;    // { gameType, buyInCoins, etbPrizePool }
    this.status      = "waiting"; // waiting | countdown | active | finished
    this.calledBalls = [];
    this.allBalls    = [];        // shuffled ball sequence (server-seeded)
    this.cards       = new Map(); // socketId → { card, userId, mask, claimed }
    this.players     = new Map(); // userId → { socketId, username }
    this.prizePool   = 0;
    this.winner      = null;
    this.intervalId  = null;
    this.countdownId = null;
    this.ballSeed    = crypto.randomBytes(32).toString("hex");
  }

  // Cryptographically fair ball sequence
  _generateBallSequence() {
    const balls = Array.from({ length: 75 }, (_, i) => i + 1);
    // Seeded Fisher-Yates
    for (let i = balls.length - 1; i > 0; i--) {
      const hmac = crypto.createHmac("sha256", this.ballSeed);
      hmac.update(`ball:${i}`);
      const j = parseInt(hmac.digest("hex").slice(0,8), 16) % (i + 1);
      [balls[i], balls[j]] = [balls[j], balls[i]];
    }
    return balls;
  }

  addPlayer(socketId, userId, username, card) {
    this.players.set(userId, { socketId, username });
    this.cards.set(socketId, {
      card,
      userId,
      mask: (1 << FREE_BIT), // FREE always set
      claimed: false,
    });
    this.prizePool += this.config.buyInCoins;
  }

  removePlayer(socketId) {
    const entry = this.cards.get(socketId);
    if (entry) this.players.delete(entry.userId);
    this.cards.delete(socketId);
  }

  get playerCount() { return this.players.size; }

  startCountdown(onStart) {
    let count = 5;
    this.countdownId = setInterval(() => {
      io.to(this.roomId).emit("countdown", { seconds: count });
      if (count-- <= 0) {
        clearInterval(this.countdownId);
        onStart();
      }
    }, 1000);
  }

  start() {
    this.status   = "active";
    this.allBalls = this._generateBallSequence();

    // Emit ball every 3 seconds
    this.intervalId = setInterval(() => this._drawNext(), 3_000);
  }

  _drawNext() {
    if (this.calledBalls.length >= this.allBalls.length) {
      this._endGame("no_winner");
      return;
    }

    const ball = this.allBalls[this.calledBalls.length];
    this.calledBalls.push(ball);

    // Update ALL card bitmasks server-side
    this.cards.forEach((entry) => {
      const cols = ["B","I","N","G","O"];
      cols.forEach((col, ci) => {
        entry.card.columns[col].forEach((val, row) => {
          if (val === ball) {
            const bit = ci * 5 + row;
            entry.mask |= (1 << bit);
          }
        });
      });
    });

    io.to(this.roomId).emit("ball_drawn", {
      ball,
      called:      this.calledBalls,
      totalCalled: this.calledBalls.length,
      ballLetter:  this._ballLetter(ball),
    });
  }

  _ballLetter(n) {
    if (n <= 15) return "B";
    if (n <= 30) return "I";
    if (n <= 45) return "N";
    if (n <= 60) return "G";
    return "O";
  }

  // Process a win claim — validates against server bitmask
  processClaim(socketId, claimedPattern = "any_line") {
    const entry = this.cards.get(socketId);
    if (!entry || entry.claimed || this.status !== "active") {
      return { valid: false, reason: "invalid_state" };
    }

    const pm = WIN_PATTERNS[claimedPattern] ?? Object.values(WIN_PATTERNS)[0];

    // Double-validate: server mask AND re-compute from card
    const serverValid  = (entry.mask & pm) === pm;
    const doubleCheck  = validateClaim(entry.card, this.calledBalls);

    if (serverValid && doubleCheck.valid) {
      entry.claimed = true;
      this.winner   = { userId: entry.userId, socketId, pattern: doubleCheck.pattern };
      return { valid: true, pattern: doubleCheck.pattern, mask: entry.mask };
    }

    return { valid: false, reason: "no_winning_pattern" };
  }

  _endGame(reason) {
    clearInterval(this.intervalId);
    this.status = "finished";
    io.to(this.roomId).emit("game_over", { reason, winner: this.winner, prizePool: this.prizePool });
  }

  endWithWinner(winner) {
    clearInterval(this.intervalId);
    this.status = "finished";
    this.winner = winner;
    io.to(this.roomId).emit("game_over", { reason:"winner", winner, prizePool: this.prizePool });
  }
}

// ── Active rooms registry ─────────────────────────────────────────
const activeRooms = new Map(); // roomId → GameRoom

// ================================================================
//  SOCKET.IO CONNECTION HANDLER
// ================================================================
io.use((socket, next) => {
  // JWT auth middleware — runs before any event
  const token = socket.handshake.auth?.token
             ?? socket.handshake.headers?.authorization?.replace("Bearer ", "");
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});

io.on("connection", (socket) => {
  const { id: userId, username } = socket.user;
  console.log(`[Socket] Connected: ${username} (${userId})`);

  // ── JOIN ROOM ──────────────────────────────────────────────────
  // Client sends: { roomId, cardSeed? }
  socket.on("join_room", async ({ roomId, cardSeed }) => {
    try {
      // Validate room exists in DB
      const { rows:[room] } = await pool.query(
        `SELECT * FROM bingo_rooms WHERE id=$1 AND status='waiting'`, [roomId]
      );
      if (!room) return socket.emit("error", { message:"room_not_found_or_started" });

      // Deduct OmniCoins buy-in
      const { rows:[wallet] } = await pool.query(
        `UPDATE wallets SET coin_balance = coin_balance - $1
          WHERE user_id = $2 AND coin_balance >= $1
          RETURNING coin_balance`,
        [room.buy_in_coins ?? 100, userId]  // default 100 coins per card
      );
      if (!wallet) return socket.emit("error", { message:"insufficient_coins" });

      // Log coin spend
      await pool.query(
        `INSERT INTO coin_transactions
           (user_id, rule_key, coins, balance_after, description)
         VALUES ($1,'bingo_buy',$2,$3,'Bingo card purchase')`,
        [userId, -(room.buy_in_coins ?? 100), wallet.coin_balance]
      );

      // Generate or restore card
      const { columns, seed } = generateCard(cardSeed);

      // Save card to DB for audit
      const { rows:[card] } = await pool.query(
        `INSERT INTO bingo_cards (room_id, user_id, card_data)
         VALUES ($1,$2,$3) RETURNING id`,
        [roomId, userId, JSON.stringify({ columns })]
      );

      // Join socket room
      socket.join(roomId);
      socket.roomId  = roomId;
      socket.cardId  = card.id;

      // Register in GameRoom
      let gr = activeRooms.get(roomId);
      if (!gr) {
        gr = new GameRoom(roomId, {
          buyInCoins:   room.buy_in_coins ?? 100,
          etbPrizePool: 0,
        });
        activeRooms.set(roomId, gr);
      }
      gr.addPlayer(socket.id, userId, username, { columns });

      // Emit card back to player
      socket.emit("card_assigned", {
        cardId:  card.id,
        columns,
        seed,
        roomId,
        message: "እንኳን ደህና መጡ! ጨዋታ ይጀምር",
      });

      // Broadcast updated player count
      io.to(roomId).emit("room_update", {
        playerCount: gr.playerCount,
        prizePool:   gr.prizePool,
        status:      gr.status,
      });

      // Start countdown when 2+ players join
      if (gr.playerCount >= 2 && gr.status === "waiting") {
        gr.status = "countdown";
        gr.startCountdown(() => {
          gr.start();
          io.to(roomId).emit("game_started", {
            roomId,
            ballSeed:    gr.ballSeed,
            playerCount: gr.playerCount,
            prizePool:   gr.prizePool,
            message:     "ቢንጎ ጀምሯል! 🎯",
          });
        });
      }

      console.log(`[Room ${roomId}] ${username} joined. Players: ${gr.playerCount}`);
    } catch (err) {
      console.error("[join_room]", err.message);
      socket.emit("error", { message: err.message });
    }
  });

  // ── CLAIM BINGO ────────────────────────────────────────────────
  // Client sends: { pattern } — server re-validates everything
  socket.on("claim_bingo", async ({ pattern = "any_line" }) => {
    const roomId = socket.roomId;
    if (!roomId) return socket.emit("error", { message:"not_in_room" });

    const gr = activeRooms.get(roomId);
    if (!gr) return socket.emit("error", { message:"room_not_active" });

    const result = gr.processClaim(socket.id, pattern);

    if (result.valid) {
      const prizePct  = 0.90; // 90% to winner, 10% platform fee
      const coinPrize = Math.floor(gr.prizePool * prizePct);
      const etbPrize  = coinPrize * 0.05; // 1 coin = 0.05 ETB (configurable)

      try {
        // Credit coins + ETB to winner
        await pool.query(
          `UPDATE wallets
             SET coin_balance = coin_balance + $1,
                 balance_etb  = balance_etb  + $2
           WHERE user_id = $3`,
          [coinPrize, etbPrize, userId]
        );

        // Log prize coin transaction
        const { rows:[w] } = await pool.query(
          `SELECT coin_balance FROM wallets WHERE user_id=$1`, [userId]
        );
        await pool.query(
          `INSERT INTO coin_transactions
             (user_id, rule_key, coins, balance_after, description, metadata)
           VALUES ($1,'bingo_win',$2,$3,$4,$5)`,
          [
            userId, coinPrize, w.coin_balance,
            `Bingo win — ${result.pattern}`,
            JSON.stringify({ roomId, pattern: result.pattern, etbPrize }),
          ]
        );

        // Mark card as winner in DB
        await pool.query(
          `UPDATE bingo_cards SET has_won=true, win_pattern=$1, win_claimed_at=NOW()
           WHERE id=$2`,
          [result.pattern, socket.cardId]
        );
        await pool.query(
          `UPDATE bingo_rooms SET winner_id=$1, status='completed', completed_at=NOW() WHERE id=$2`,
          [userId, roomId]
        );

      } catch (dbErr) {
        console.error("[claim_bingo payout]", dbErr.message);
      }

      // Announce winner to entire room
      gr.endWithWinner({
        userId, username,
        pattern:   result.pattern,
        coinPrize, etbPrize,
        message:   `🏆 ${username} ቢንጎ አሸነፈ! +${coinPrize} coins / +${etbPrize.toFixed(2)} ETB`,
      });

    } else {
      socket.emit("claim_rejected", {
        reason:  result.reason,
        message: "❌ ትክክለኛ ቢንጎ አይደለም — ቀጥሉ!",
      });
    }
  });

  // ── CHAT (room chat during game) ───────────────────────────────
  socket.on("chat_msg", ({ text }) => {
    const roomId = socket.roomId;
    if (!roomId || !text) return;
    if (text.length > 200) return; // limit
    io.to(roomId).emit("chat_msg", {
      username, userId,
      text: text.slice(0, 200),
      ts: Date.now(),
    });
  });

  // ── DISCONNECT ─────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const gr = activeRooms.get(roomId);
    if (!gr) return;
    gr.removePlayer(socket.id);
    io.to(roomId).emit("player_left", { userId, username, playerCount: gr.playerCount });
    if (gr.playerCount === 0) activeRooms.delete(roomId);
    console.log(`[Socket] Disconnected: ${username}`);
  });
});

// ================================================================
//  REST ROUTE — Create room
// ================================================================
app.use(express.json());
app.post("/api/bingo/rooms", async (req, res) => {
  try {
    const { gameType="75ball", buyInCoins=100, maxPlayers=50 } = req.body;
    const seed = crypto.randomBytes(32).toString("hex");
    const code = Math.random().toString(36).slice(2,8).toUpperCase();
    const { rows:[room] } = await pool.query(
      `INSERT INTO bingo_rooms
         (room_code, game_type, buy_in_coins, max_players, server_seed, currency)
       VALUES ($1,$2,$3,$4,$5,'COIN') RETURNING *`,
      [code, gameType, buyInCoins, maxPlayers, seed]
    );
    res.json({ room });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT ?? 4000;
http.listen(PORT, () => console.log(`🎯 Bingo Engine on :${PORT}`));
export default http;
