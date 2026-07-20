// ================================================================
//  OmniHub — Production Bingo WebSocket Server
//  File: server/BingoServer.js
//
//  NEW in this version:
//    ✅ Disconnect handling  — 45s grace period, seat hold, coin refund
//    ✅ Reconnect recovery   — player rejoins mid-game, gets full state
//    ✅ Admin REST API       — create rooms, force start/end, kick, stats
//    ✅ Admin Socket channel — live event stream to admin dashboard
//    ✅ Heartbeat / zombie cleanup every 30s
//    ✅ Anti-cheat           — server bitmask + double-check on claim
// ================================================================
import { Server }       from "socket.io";
import { createServer } from "http";
import express          from "express";
import pg               from "pg";
import jwt              from "jsonwebtoken";
import crypto           from "crypto";

const app  = express();
const http = createServer(app);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const JWT_SECRET       = process.env.JWT_SECRET    ?? "dev_secret";
const ADMIN_SECRET     = process.env.ADMIN_SECRET  ?? "admin_dev_secret";
const DISCONNECT_GRACE = 45_000;  // ms — how long to hold a seat after DC
const BALL_INTERVAL_MS = 4_000;   // ms between ball draws
const MIN_PLAYERS      = 2;       // auto-start threshold
const AUTO_START_WAIT  = 30_000;  // ms — solo player grace before solo start

app.use(express.json());

// ─────────────────────────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== ADMIN_SECRET)
    return res.status(403).json({ error: "forbidden" });
  next();
}

// ─────────────────────────────────────────────────────────────────
//  BINGO CONSTANTS
// ─────────────────────────────────────────────────────────────────
const BINGO_COLS = ["B","I","N","G","O"];
const FREE_BIT   = 12; // center cell bit position

const WIN_MASKS = [
  // 5 rows
  0b00000_00000_00000_00000_11111,
  0b00000_00000_00000_11111_00000,
  0b00000_00000_11111_00000_00000,
  0b00000_11111_00000_00000_00000,
  0b11111_00000_00000_00000_00000,
  // 5 columns
  0b00001_00001_00001_00001_00001,
  0b00010_00010_00010_00010_00010,
  0b00100_00100_00100_00100_00100,
  0b01000_01000_01000_01000_01000,
  0b10000_10000_10000_10000_10000,
  // 2 diagonals
  0b10000_01000_00100_00010_00001,
  0b00001_00010_00100_01000_10000,
];

// ─────────────────────────────────────────────────────────────────
//  ROOM REGISTRY
// ─────────────────────────────────────────────────────────────────
const rooms = new Map(); // roomId → GameRoom

// ─────────────────────────────────────────────────────────────────
//  GAME ROOM
// ─────────────────────────────────────────────────────────────────
class GameRoom {
  constructor(roomId, config) {
    this.roomId    = roomId;
    this.config    = config;      // { buyInCoins, maxPlayers, gameType }
    this.phase     = "waiting";   // waiting|countdown|active|finished

    this.ballSeed  = crypto.randomBytes(32).toString("hex");
    this.ballSeq   = [];
    this.drawIdx   = 0;
    this.called    = [];

    this.players   = new Map();   // userId → PlayerEntry
    this.prizePool = 0;
    this.winner    = null;

    this.ballInterval   = null;
    this.cdInterval     = null;
    this.autoStartTimer = null;
    this.createdAt      = Date.now();
    this.startedAt      = null;
  }

  get playerCount() { return this.players.size; }
  get activeCount()  { return [...this.players.values()].filter(p => p.connected).length; }

  // ─── Player management ────────────────────────────────────────
  addPlayer(userId, socketId, username, cardColumns, cardId) {
    if (this.players.has(userId)) {
      // RECONNECT — update socket, cancel expiry timer
      const p = this.players.get(userId);
      p.socketId  = socketId;
      p.connected = true;
      if (p.dcTimer) { clearTimeout(p.dcTimer); p.dcTimer = null; }
      return { isReconnect: true, player: p };
    }
    const entry = {
      userId, socketId, username,
      cardColumns, cardId,
      mask:      1 << FREE_BIT,
      connected: true,
      dcTimer:   null,
      joinedAt:  Date.now(),
      refunded:  false,
    };
    this.players.set(userId, entry);
    this.prizePool += Math.floor(this.config.buyInCoins * 0.9);
    return { isReconnect: false, player: entry };
  }

  // ─── Disconnect: start grace timer ──────────────────────────
  onDisconnect(userId) {
    const p = this.players.get(userId);
    if (!p) return;
    p.connected = false;

    gameNS.to(this.roomId).emit("player_disconnected", {
      userId, username: p.username,
      graceSeconds: DISCONNECT_GRACE / 1000,
      message: `⚠️ ${p.username} ተቋርጧል — ${DISCONNECT_GRACE/1000}s ለ reconnect`,
    });

    // Grace period countdown
    p.dcTimer = setTimeout(() => this._expirePlayer(userId), DISCONNECT_GRACE);
  }

  _expirePlayer(userId) {
    const p = this.players.get(userId);
    if (!p || p.connected) return; // player reconnected in time

    const wasActive = this.phase === "active";

    // Refund coins if game hadn't started yet
    if (this.phase === "waiting" || this.phase === "countdown") {
      refundCoins(userId, this.config.buyInCoins,
        "Bingo room timed out before game started").catch(() => {});
      p.refunded = true;
    }

    this.players.delete(userId);

    gameNS.to(this.roomId).emit("player_removed", {
      userId, username: p.username,
      playerCount: this.playerCount,
      message: `${p.username} ሰዓቱ አልፏል — ወጥቷል`,
    });

    // If game was live and nobody is left, end it
    if (wasActive && this.activeCount === 0) {
      this._endGame("all_players_disconnected");
    }

    emitAdmin("player_expired", {
      roomId: this.roomId, userId,
      username: p.username, refunded: p.refunded,
    });
  }

  // ─── Ball machinery ──────────────────────────────────────────
  _updateAllMasks(ball) {
    this.players.forEach(p => {
      BINGO_COLS.forEach((col, ci) => {
        p.cardColumns[col]?.forEach((val, row) => {
          if (val === ball) p.mask |= (1 << (ci * 5 + row));
        });
      });
    });
  }

  _drawBall() {
    if (this.drawIdx >= this.ballSeq.length) {
      this._endGame("all_balls_drawn"); return;
    }
    const ball = this.ballSeq[this.drawIdx++];
    this.called.push(ball);
    this._updateAllMasks(ball);

    gameNS.to(this.roomId).emit("ball_drawn", {
      ball,
      called:      this.called,
      totalCalled: this.called.length,
      letter:      ballLetter(ball),
    });

    pool.query(
      `UPDATE bingo_rooms
         SET called_numbers = array_append(called_numbers, $1)
       WHERE id = $2`,
      [ball, this.roomId]
    ).catch(() => {});

    emitAdmin("ball_drawn", { roomId: this.roomId, ball, total: this.called.length });
  }

  startCountdown(secs = 5) {
    let n = secs;
    this.cdInterval = setInterval(() => {
      gameNS.to(this.roomId).emit("countdown", { seconds: n });
      if (n-- <= 0) { clearInterval(this.cdInterval); this._launch(); }
    }, 1000);
  }

  _launch() {
    this.phase     = "active";
    this.startedAt = Date.now();
    this.ballSeq   = genBallSeq(this.ballSeed);

    gameNS.to(this.roomId).emit("game_started", {
      playerCount: this.playerCount,
      prizePool:   this.prizePool,
      ballSeed:    this.ballSeed,
      message:     "🎯 ቢንጎ ጀምሯል!",
    });

    pool.query(
      `UPDATE bingo_rooms SET status='active', started_at=NOW() WHERE id=$1`,
      [this.roomId]
    ).catch(() => {});

    emitAdmin("game_started", {
      roomId:      this.roomId,
      playerCount: this.playerCount,
      prizePool:   this.prizePool,
    });

    this.ballInterval = setInterval(() => this._drawBall(), BALL_INTERVAL_MS);
  }

  _endGame(reason) {
    clearInterval(this.ballInterval);
    clearInterval(this.cdInterval);
    clearTimeout(this.autoStartTimer);
    this.phase = "finished";

    gameNS.to(this.roomId).emit("game_over", {
      reason, winner: this.winner,
      prizePool:  this.prizePool,
      totalBalls: this.called.length,
    });

    pool.query(
      `UPDATE bingo_rooms
         SET status='completed', completed_at=NOW(), winner_id=$1
       WHERE id=$2`,
      [this.winner?.userId ?? null, this.roomId]
    ).catch(() => {});

    emitAdmin("game_over", { roomId: this.roomId, reason, winner: this.winner });

    // Remove from registry after 60 s
    setTimeout(() => rooms.delete(this.roomId), 60_000);
  }

  // ─── Win validation ──────────────────────────────────────────
  validateClaim(userId) {
    const p = this.players.get(userId);
    if (!p || this.phase !== "active")
      return { valid: false, reason: "invalid_state" };

    // Primary check: server-maintained bitmask
    if (!WIN_MASKS.some(pm => (p.mask & pm) === pm))
      return { valid: false, reason: "no_winning_pattern" };

    // Secondary check: recompute mask from scratch (anti-cheat)
    const recomputed = recomputeMask(p.cardColumns, new Set(this.called));
    if (!WIN_MASKS.some(pm => (recomputed & pm) === pm))
      return { valid: false, reason: "mask_mismatch_anticheat" };

    return { valid: true };
  }

  // ─── Admin controls ──────────────────────────────────────────
  adminForceStart() {
    if (this.phase !== "waiting") return false;
    clearTimeout(this.autoStartTimer);
    this.phase = "countdown";
    gameNS.to(this.roomId).emit("admin_action", {
      action: "force_start", message: "🔧 Admin ጨዋታ ጀምሯል!",
    });
    this.startCountdown(3);
    return true;
  }

  adminForceEnd() {
    this._endGame("admin_terminated");
    return true;
  }

  toJSON() {
    return {
      roomId:      this.roomId,
      phase:       this.phase,
      playerCount: this.playerCount,
      activeCount: this.activeCount,
      prizePool:   this.prizePool,
      ballsCalled: this.called.length,
      startedAt:   this.startedAt,
      config:      this.config,
      players: [...this.players.values()].map(p => ({
        userId:    p.userId,
        username:  p.username,
        connected: p.connected,
        joinedAt:  p.joinedAt,
        refunded:  p.refunded,
      })),
    };
  }
}

// ─────────────────────────────────────────────────────────────────
//  SOCKET.IO — two namespaces: /game (players) and /admin
// ─────────────────────────────────────────────────────────────────
export const io = new Server(http, {
  cors: { origin: "*" },
  pingInterval: 10_000,
  pingTimeout:  25_000,
});

// ── Player namespace ──────────────────────────────────────────────
const gameNS = io.of("/game");

gameNS.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth?.token, JWT_SECRET);
    next();
  } catch { next(new Error("unauthorized")); }
});

gameNS.on("connection", socket => {
  const { id: userId, username } = socket.user;
  socket.isAlive = true;

  // JOIN / RECONNECT
  socket.on("join_room", async ({ roomId, cardId }) => {
    try {
      const { rows: [cardRow] } = await pool.query(
        `SELECT card_data FROM bingo_cards WHERE id=$1 AND user_id=$2`,
        [cardId, userId]
      );
      if (!cardRow) return socket.emit("error", { message: "card_not_found" });

      let room = rooms.get(roomId);
      if (!room) {
        const { rows: [dbRoom] } = await pool.query(
          `SELECT * FROM bingo_rooms WHERE id=$1`, [roomId]
        );
        if (!dbRoom) return socket.emit("error", { message: "room_not_found" });
        room = new GameRoom(roomId, {
          buyInCoins: dbRoom.buy_in_coins ?? 100,
          maxPlayers: dbRoom.max_players  ?? 50,
          gameType:   dbRoom.game_type    ?? "75ball",
        });
        rooms.set(roomId, room);
      }

      socket.join(roomId);
      socket.roomId = roomId;
      socket.userId = userId;
      socket.cardId = cardId;

      const { isReconnect, player } = room.addPlayer(
        userId, socket.id, username, cardRow.card_data, cardId
      );

      if (isReconnect) {
        socket.emit("reconnected", {
          phase:       room.phase,
          called:      room.called,
          prizePool:   room.prizePool,
          playerCount: room.playerCount,
          myMask:      player.mask,
          message:     "🔄 ተመልሰዋል! ጨዋታ ቀጥሏል",
        });
        gameNS.to(roomId).emit("player_reconnected", {
          userId, username, playerCount: room.playerCount,
          message: `✅ ${username} ተመልሷል!`,
        });
      } else {
        socket.emit("room_joined", {
          roomId, cardId,
          playerCount: room.playerCount,
          prizePool:   room.prizePool,
          phase:       room.phase,
        });
        gameNS.to(roomId).emit("player_joined", {
          userId, username,
          playerCount: room.playerCount,
          prizePool:   room.prizePool,
        });

        // Auto-start logic
        if (room.phase === "waiting") {
          if (room.playerCount >= MIN_PLAYERS) {
            clearTimeout(room.autoStartTimer);
            room.phase = "countdown";
            room.startCountdown(5);
          } else if (!room.autoStartTimer) {
            room.autoStartTimer = setTimeout(() => {
              if (room.phase === "waiting" && room.playerCount >= 1) {
                room.phase = "countdown";
                room.startCountdown(5);
              }
            }, AUTO_START_WAIT);
          }
        }
      }
    } catch (err) {
      socket.emit("error", { message: err.message });
    }
  });

  // CLAIM
  socket.on("claim_bingo", async () => {
    const room = rooms.get(socket.roomId);
    if (!room) return socket.emit("error", { message: "no_active_room" });

    const result = room.validateClaim(userId);
    if (!result.valid) {
      return socket.emit("claim_rejected", { reason: result.reason });
    }

    clearInterval(room.ballInterval);
    const coinPrize = room.prizePool;
    const etbPrize  = +(coinPrize * 0.05).toFixed(2);

    // Credit DB
    try {
      await pool.query(
        `UPDATE wallets
           SET coin_balance = coin_balance + $1,
               balance_etb  = balance_etb  + $2
         WHERE user_id = $3`,
        [coinPrize, etbPrize, userId]
      );
      await pool.query(
        `INSERT INTO coin_transactions
           (user_id, rule_key, coins, balance_after, description)
         SELECT $1, 'bingo_win', $2, coin_balance, 'Bingo Win'
         FROM wallets WHERE user_id = $1`,
        [userId, coinPrize]
      );
      await pool.query(
        `UPDATE bingo_cards
           SET has_won=true, win_pattern='any_line', win_claimed_at=NOW()
         WHERE id=$1`,
        [socket.cardId]
      );
    } catch (e) {
      console.error("[payout]", e.message);
    }

    room.winner = { userId, username, coinPrize, etbPrize };
    room._endGame("winner");
  });

  // CHAT
  socket.on("chat", ({ text }) => {
    if (!text?.trim() || text.length > 200) return;
    gameNS.to(socket.roomId).emit("chat", {
      userId, username,
      text: text.trim().slice(0, 200),
      ts:   Date.now(),
    });
  });

  // CLIENT KEEP-ALIVE
  socket.on("ping_game",   () => { socket.isAlive = true; socket.emit("pong_game"); });
  socket.on("pong_server", () => { socket.isAlive = true; });

  // DISCONNECT
  socket.on("disconnect", reason => {
    const room = rooms.get(socket.roomId);
    if (room) room.onDisconnect(userId);
    emitAdmin("disconnect", {
      roomId:  socket.roomId, userId, username,
      reason,  graceSeconds: DISCONNECT_GRACE / 1000,
    });
  });
});

// ── Admin namespace ───────────────────────────────────────────────
const adminNS = io.of("/admin");

adminNS.use((socket, next) => {
  socket.handshake.auth?.adminKey === ADMIN_SECRET
    ? next()
    : next(new Error("forbidden"));
});

adminNS.on("connection", socket => {
  socket.emit("welcome", { rooms: rooms.size, message: "Admin connected ✅" });

  socket.on("list_rooms",   ()         => socket.emit("rooms_list",  getRoomList()));
  socket.on("room_detail",  ({ roomId})=> socket.emit("room_detail", rooms.get(roomId)?.toJSON() ?? null));
  socket.on("force_start",  ({ roomId})=> {
    const ok = rooms.get(roomId)?.adminForceStart();
    socket.emit("ack", { action:"force_start", roomId, ok });
  });
  socket.on("force_end", ({ roomId }) => {
    const ok = rooms.get(roomId)?.adminForceEnd();
    socket.emit("ack", { action:"force_end", roomId, ok });
  });
});

function emitAdmin(event, data) {
  adminNS.emit("event", { event, data, ts: Date.now() });
}

// ─────────────────────────────────────────────────────────────────
//  ADMIN REST API
// ─────────────────────────────────────────────────────────────────
app.get("/admin/rooms", requireAdmin, (_req, res) => {
  res.json({ rooms: getRoomList(), total: rooms.size });
});

app.get("/admin/rooms/:id", requireAdmin, (req, res) => {
  const r = rooms.get(req.params.id);
  r ? res.json(r.toJSON()) : res.status(404).json({ error: "not_found" });
});

app.post("/admin/rooms", requireAdmin, async (req, res) => {
  try {
    const { buyInCoins=100, maxPlayers=50, gameType="75ball" } = req.body;
    const seed = crypto.randomBytes(32).toString("hex");
    const code = Math.random().toString(36).slice(2,8).toUpperCase();
    const { rows:[dbRoom] } = await pool.query(
      `INSERT INTO bingo_rooms
         (room_code, game_type, buy_in_coins, max_players, server_seed, status)
       VALUES ($1,$2,$3,$4,$5,'waiting') RETURNING *`,
      [code, gameType, buyInCoins, maxPlayers, seed]
    );
    const gr = new GameRoom(dbRoom.id, { buyInCoins, maxPlayers, gameType });
    rooms.set(dbRoom.id, gr);
    emitAdmin("room_created", { roomId: dbRoom.id, code, buyInCoins });
    res.json({ room: dbRoom, state: gr.toJSON() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/admin/rooms/:id/start", requireAdmin, (req, res) => {
  const r = rooms.get(req.params.id);
  if (!r) return res.status(404).json({ error: "not_found" });
  res.json({ ok: r.adminForceStart(), phase: r.phase });
});

app.post("/admin/rooms/:id/end", requireAdmin, (req, res) => {
  const r = rooms.get(req.params.id);
  if (!r) return res.status(404).json({ error: "not_found" });
  res.json({ ok: r.adminForceEnd() });
});

app.post("/admin/rooms/:id/kick/:userId", requireAdmin, (req, res) => {
  const r = rooms.get(req.params.id);
  if (!r) return res.status(404).json({ error: "not_found" });
  const p = r.players.get(req.params.userId);
  if (!p) return res.status(404).json({ error: "player_not_found" });
  if (p.connected) {
    gameNS.sockets.get(p.socketId)
      ?.emit("kicked", { message: "Admin has removed you from this room." })
      ?.disconnect();
  }
  r._expirePlayer(req.params.userId);
  res.json({ ok: true });
});

app.get("/admin/stats", requireAdmin, async (_req, res) => {
  try {
    const { rows:[s] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE is_active=true)                       AS total_users,
        (SELECT COUNT(*) FROM users WHERE DATE(created_at)=CURRENT_DATE)        AS new_today,
        (SELECT COUNT(*) FROM bingo_rooms WHERE status='active')                AS db_active_rooms,
        (SELECT COUNT(*) FROM bingo_rooms WHERE DATE(created_at)=CURRENT_DATE)  AS games_today,
        (SELECT COALESCE(SUM(coins),0) FROM coin_transactions
          WHERE coins>0 AND DATE(created_at)=CURRENT_DATE)                      AS coins_today
    `);
    res.json({
      ...s,
      live_rooms:   rooms.size,
      live_players: [...rooms.values()].reduce((n,r)=>n+r.activeCount, 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  HEARTBEAT — zombie socket cleanup
// ─────────────────────────────────────────────────────────────────
setInterval(() => {
  gameNS.sockets.forEach(s => {
    if (!s.isAlive) { s.disconnect(true); return; }
    s.isAlive = false;
    s.emit("server_ping");
  });
}, 30_000);

// ─────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────
function ballLetter(n) {
  if (n<=15) return "B"; if (n<=30) return "I";
  if (n<=45) return "N"; if (n<=60) return "G"; return "O";
}

function genBallSeq(seed) {
  const b = Array.from({length:75}, (_,i)=>i+1);
  for (let i=74;i>0;i--) {
    const j = crypto.createHmac("sha256", seed).update(`b${i}`).digest()
                .readUInt32BE(0) % (i+1);
    [b[i],b[j]] = [b[j],b[i]];
  }
  return b;
}

function recomputeMask(columns, calledSet) {
  let mask = 1 << FREE_BIT;
  BINGO_COLS.forEach((col, ci) => {
    columns[col]?.forEach((val, row) => {
      if (val !== "FREE" && calledSet.has(val)) mask |= (1 << (ci*5+row));
    });
  });
  return mask;
}

async function refundCoins(userId, amount, desc) {
  await pool.query(
    `UPDATE wallets SET coin_balance=coin_balance+$1 WHERE user_id=$2`,
    [amount, userId]
  );
  await pool.query(
    `INSERT INTO coin_transactions (user_id,rule_key,coins,balance_after,description)
     SELECT $1,'refund',$2,coin_balance,$3 FROM wallets WHERE user_id=$1`,
    [userId, amount, desc]
  );
}

function getRoomList() {
  return [...rooms.values()].map(r => ({
    roomId:      r.roomId,
    phase:       r.phase,
    playerCount: r.playerCount,
    activeCount: r.activeCount,
    prizePool:   r.prizePool,
    ballsCalled: r.called.length,
    startedAt:   r.startedAt,
    buyInCoins:  r.config.buyInCoins,
  }));
}

const PORT = process.env.PORT ?? 4000;
http.listen(PORT, () => {
  console.log(`✅  OmniHub Bingo Server :${PORT}`);
  console.log(`📡  Players  → ws://localhost:${PORT}/game`);
  console.log(`🔒  Admin WS → ws://localhost:${PORT}/admin`);
  console.log(`🔗  Admin API→ http://localhost:${PORT}/admin/*`);
});

export default http;
