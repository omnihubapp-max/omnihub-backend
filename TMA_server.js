// ================================================================
//  OmniHub TMA — Express + WebSocket Backend
//  File: backend/src/server.js
//
//  Covers:
//    1. Telegram initData verification (HMAC-SHA256)
//    2. Auth middleware — every request validated against Telegram
//    3. REST routes  — /auth/telegram, /wallet, /coins, /loans
//    4. WebSocket Bingo Engine — real-time ball drops + win validation
//    5. PostgreSQL integration (uses schema from Step 1)
// ================================================================

import express        from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import pg             from "pg";
import crypto         from "crypto";
import cors           from "cors";
import helmet         from "helmet";
import rateLimit      from "express-rate-limit";

// ── Config ────────────────────────────────────────────────────────
const PORT     = process.env.PORT ?? 4000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "YOUR_BOT_TOKEN";
const pool     = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ================================================================
//  1.  TELEGRAM initData VERIFICATION
//     Spec: https://core.telegram.org/bots/webapps#validating-data
// ================================================================
function verifyTelegramInitData(initData) {
  if (!initData || initData === "dev") {
    // Allow dev/test mode when BOT_TOKEN is placeholder
    return BOT_TOKEN === "YOUR_BOT_TOKEN"
      ? { id: 0, first_name: "Dev", username: "dev_user" }
      : null;
  }

  try {
    const params  = new URLSearchParams(initData);
    const hash    = params.get("hash");
    params.delete("hash");

    // Sort params and build data-check-string
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    // HMAC-SHA256: key = HMAC-SHA256("WebAppData", bot_token)
    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    const expectedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (expectedHash !== hash) return null;

    // Parse and return user object
    const user = JSON.parse(params.get("user") ?? "{}");
    return user;
  } catch {
    return null;
  }
}

// ================================================================
//  2.  AUTH MIDDLEWARE
// ================================================================
function telegramAuth(req, res, next) {
  const initData = req.headers["x-telegram-init-data"];

  if (!initData) {
    return res.status(401).json({ error: "Missing Telegram init data" });
  }

  const user = verifyTelegramInitData(initData);
  if (!user || !user.id) {
    return res.status(401).json({ error: "Invalid Telegram signature" });
  }

  req.tgUser = user;   // { id, first_name, last_name, username, language_code }
  next();
}

// ================================================================
//  3.  USER / WALLET SERVICE  (DB helpers)
// ================================================================
const UserService = {
  // Find existing user or auto-create from Telegram identity
  async upsert(tgUser) {
    const { rows: [user] } = await pool.query(
      `INSERT INTO users
         (username, email, password_hash, full_name, language,
          kyc_status, is_active)
       VALUES ($1, $2, $3, $4, $5, 'pending', true)
       ON CONFLICT (username) DO UPDATE
         SET full_name    = EXCLUDED.full_name,
             last_login_at = NOW()
       RETURNING *`,
      [
        tgUser.username ?? `tg_${tgUser.id}`,
        `tg_${tgUser.id}@telegram.local`,  // placeholder — no real email needed
        crypto.randomBytes(32).toString("hex"),  // no password for TMA users
        `${tgUser.first_name ?? ""} ${tgUser.last_name ?? ""}`.trim(),
        tgUser.language_code ?? "am",
      ]
    );
    return user;
  },

  async getDashboard(userId) {
    const { rows: [data] } = await pool.query(
      `SELECT * FROM v_user_dashboard WHERE id = $1`, [userId]
    );
    return data;
  },
};

const WalletService = {
  async getBalance(userId) {
    const { rows: [w] } = await pool.query(
      `SELECT balance_etb, balance_usd, coin_balance
       FROM wallets WHERE user_id = $1`, [userId]
    );
    return w ?? { balance_etb: 0, balance_usd: 0, coin_balance: 0 };
  },

  async getRecentTxns(userId, limit = 10) {
    const { rows } = await pool.query(
      `SELECT le.* FROM ledger_entries le
       JOIN wallets w ON w.id = le.wallet_id
       WHERE w.user_id = $1
       ORDER BY le.created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return rows;
  },
};

// ================================================================
//  4.  EXPRESS APP
// ================================================================
const app    = express();
const server = createServer(app);

app.use(cors({ origin: process.env.FRONTEND_URL ?? "*" }));
app.use(helmet());
app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, max: 120 })); // 120 req/min

// ── Health check (no auth) ────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

// ────────────────────────────────────────────────────────────────
//  POST /api/auth/telegram
//  Exchange Telegram initData for a session profile.
//  The TMA doesn't need a traditional JWT — initData IS the token.
// ────────────────────────────────────────────────────────────────
app.post("/api/auth/telegram", telegramAuth, async (req, res) => {
  try {
    const dbUser = await UserService.upsert(req.tgUser);

    // Award daily login coins (non-blocking)
    awardDailyLogin(dbUser.id).catch(console.error);

    const dashboard = await UserService.getDashboard(dbUser.id);
    res.json({ user: dashboard, tgUser: req.tgUser });
  } catch (err) {
    console.error("[auth/telegram]", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ────────────────────────────────────────────────────────────────
//  GET /api/wallet
// ────────────────────────────────────────────────────────────────
app.get("/api/wallet", telegramAuth, async (req, res) => {
  try {
    const dbUser  = await UserService.upsert(req.tgUser);
    const balance = await WalletService.getBalance(dbUser.id);
    const txns    = await WalletService.getRecentTxns(dbUser.id);
    res.json({ balance, transactions: txns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────
//  GET /api/trust
// ────────────────────────────────────────────────────────────────
app.get("/api/trust", telegramAuth, async (req, res) => {
  try {
    const dbUser = await UserService.upsert(req.tgUser);
    await pool.query(`SELECT fn_calculate_trust_score($1)`, [dbUser.id]);
    const { rows: [ts] } = await pool.query(
      `SELECT * FROM trust_scores WHERE user_id = $1`, [dbUser.id]
    );
    res.json(ts ?? { score: 0, max_loan_etb: 0, interest_rate_pct: 20 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────
//  POST /api/loans/apply
// ────────────────────────────────────────────────────────────────
app.post("/api/loans/apply", telegramAuth, async (req, res) => {
  try {
    const dbUser   = await UserService.upsert(req.tgUser);
    const { amount, currency = "ETB", term_days = 30 } = req.body;

    if (!amount || amount <= 0)
      return res.status(400).json({ error: "Invalid amount" });

    // Get trust score
    const { rows: [ts] } = await pool.query(
      `SELECT * FROM trust_scores WHERE user_id = $1`, [dbUser.id]
    );
    if (!ts || ts.score < 50)
      return res.status(400).json({ error: "Trust score too low (min 50)" });
    if (amount > ts.max_loan_etb)
      return res.status(400).json({ error: `Max eligible: ETB ${ts.max_loan_etb}` });

    const autoApprove = ts.score >= 60;
    const dueAt = new Date();
    dueAt.setDate(dueAt.getDate() + term_days);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [loan] } = await client.query(
        `INSERT INTO loans
           (user_id, amount, currency, interest_rate_pct, term_days,
            status, trust_score_snap, disbursed_at, due_at, auto_approved)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [dbUser.id, amount, currency, ts.interest_rate_pct, term_days,
         autoApprove ? "active" : "pending", ts.score,
         autoApprove ? new Date() : null,
         autoApprove ? dueAt : null, autoApprove]
      );

      if (autoApprove) {
        const col = currency === "ETB" ? "balance_etb" : "balance_usd";
        await client.query(
          `UPDATE wallets SET ${col} = ${col} + $1 WHERE user_id = $2`,
          [amount, dbUser.id]
        );
      }
      await client.query("COMMIT");
      res.json({ loan, autoApproved: autoApprove, trustScore: ts.score });
    } catch (e) {
      await client.query("ROLLBACK"); throw e;
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────
//  Coin award helper
// ────────────────────────────────────────────────────────────────
async function awardDailyLogin(userId) {
  const today   = new Date().toISOString().slice(0, 10);
  const { rows: [user] } = await pool.query(
    `UPDATE users
        SET login_streak = CASE
              WHEN last_login_at > NOW() - INTERVAL '48 hours' THEN login_streak + 1
              ELSE 1
            END,
            last_login_at = NOW()
      WHERE id = $1
      RETURNING login_streak`,
    [userId]
  );

  const streakBonus = Math.floor((user?.login_streak ?? 0) / 7) * 5;
  const coins       = 10 + streakBonus;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [w] } = await client.query(
      `UPDATE wallets SET coin_balance = coin_balance + $1
       WHERE user_id = $2 RETURNING coin_balance`, [coins, userId]
    );
    await client.query(
      `INSERT INTO coin_transactions (user_id,rule_key,coins,balance_after,description)
       VALUES ($1,'daily_login',$2,$3,$4)`,
      [userId, coins, w.coin_balance, `Daily login +${coins} (streak ${user?.login_streak})`]
    );
    await client.query("COMMIT");
  } catch { await client.query("ROLLBACK"); }
  finally  { client.release(); }
}

// ================================================================
//  5.  WEBSOCKET BINGO ENGINE
//     Path: ws://host:4000/bingo/:roomId
// ================================================================
const wss = new WebSocketServer({ server, path: "/" });

// In-memory room state (upgrade to Redis for multi-server)
const rooms = new Map();
// rooms.get(roomId) = {
//   clients:  Set<WebSocket>,
//   called:   number[],
//   status:   "waiting"|"active"|"completed",
//   interval: NodeJS.Timer | null,
//   prizePool: number,
// }

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients:   new Set(),
      called:    [],
      status:    "waiting",
      interval:  null,
      prizePool: 0,
    });
  }
  return rooms.get(roomId);
}

function broadcast(room, message) {
  const data = JSON.stringify(message);
  for (const client of room.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(data);
  }
}

// Draw one ball — server-authoritative, cryptographically random
function drawBall(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const maxBall  = 75;
  const remaining = [];
  const calledSet = new Set(room.called);
  for (let i = 1; i <= maxBall; i++) if (!calledSet.has(i)) remaining.push(i);

  if (!remaining.length) {
    // All balls drawn — game over
    clearInterval(room.interval);
    room.status   = "completed";
    room.interval = null;
    broadcast(room, { type: "game_over", called: room.called });
    return;
  }

  // Cryptographically fair selection
  const buf = crypto.randomBytes(4);
  const idx = buf.readUInt32BE(0) % remaining.length;
  const num = remaining[idx];

  room.called.push(num);

  // Persist to DB (non-blocking)
  pool.query(
    `UPDATE bingo_rooms
       SET called_numbers = array_append(called_numbers, $1)
     WHERE room_code = $2`,
    [num, roomId]
  ).catch(console.error);

  broadcast(room, {
    type:   "ball_drawn",
    number: num,
    total:  room.called.length,
    called: room.called,
  });
}

// Validate a win claim from a client
function validateWinClaim(card, called, pattern = "any_line") {
  const s = new Set(called);
  const m = (col, row) => (col === 2 && row === 2) || s.has(card[col][row]);

  if (pattern === "full_house")
    return [0,1,2,3,4].every(c => [0,1,2,3,4].every(r => m(c,r)));

  // Check rows
  for (let r = 0; r < 5; r++)
    if ([0,1,2,3,4].every(c => m(c,r))) return true;
  // Check cols
  for (let c = 0; c < 5; c++)
    if ([0,1,2,3,4].every(r => m(c,r))) return true;
  // Check diagonals
  if ([0,1,2,3,4].every(i => m(i,i))) return true;
  if ([0,1,2,3,4].every(i => m(i,4-i))) return true;

  return false;
}

wss.on("connection", (ws, req) => {
  // Extract roomId from URL: /bingo/room_001
  const roomId = req.url.replace(/^\/bingo\//, "") || "room_001";
  const room   = getOrCreateRoom(roomId);

  room.clients.add(ws);
  let userId = null;
  let userCard = null;

  // Send current state to new joiner
  ws.send(JSON.stringify({
    type:    "welcome",
    roomId,
    status:  room.status,
    called:  room.called,
    players: room.clients.size,
  }));

  broadcast(room, { type: "room_update", players: room.clients.size, prize_pool: room.prizePool });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Client authenticates via Telegram initData ────────────
      case "auth": {
        const tgUser = verifyTelegramInitData(msg.initData);
        if (!tgUser) { ws.send(JSON.stringify({ type: "error", message: "Auth failed" })); return; }
        userId = tgUser.id;
        ws.send(JSON.stringify({ type: "auth_ok", userId }));
        break;
      }

      // ── Client buys in and joins the game ─────────────────────
      case "join_game": {
        if (!userId) return;
        room.prizePool += msg.buy_in ?? 50;

        // Start draw loop when ≥2 players (or after 10s for demo)
        if (room.status === "waiting") {
          room.status = "active";
          broadcast(room, { type: "game_started", players: room.clients.size });

          // Draw a ball every 4 seconds
          room.interval = setInterval(() => drawBall(roomId), 4000);

          // Also draw immediately
          setTimeout(() => drawBall(roomId), 500);
        }

        ws.send(JSON.stringify({ type: "joined", roomId, prizePool: room.prizePool }));
        broadcast(room, { type: "room_update", players: room.clients.size, prize_pool: room.prizePool });
        break;
      }

      // ── Client sends their card (for server-side win checking) ─
      case "register_card": {
        userCard = msg.card;  // 5×5 array[col][row]
        break;
      }

      // ── Client claims BINGO ────────────────────────────────────
      case "claim_win": {
        if (!userCard || !userId) return;

        const valid = validateWinClaim(userCard, room.called, msg.pattern);
        if (valid) {
          clearInterval(room.interval);
          room.status = "completed";

          // Credit winnings in DB
          pool.query(
            `UPDATE wallets
               SET balance_etb = balance_etb + $1
             WHERE user_id = (SELECT id FROM users WHERE username = $2 OR email LIKE $3)`,
            [room.prizePool * 0.9, `tg_${userId}`, `tg_${userId}@%`]
          ).catch(console.error);

          // Award bingo win coins
          pool.query(
            `UPDATE wallets SET coin_balance = coin_balance + 100 WHERE user_id =
             (SELECT id FROM users WHERE email LIKE $1)`,
            [`tg_${userId}@%`]
          ).catch(console.error);

          ws.send(JSON.stringify({ type: "win_confirmed", prize: room.prizePool * 0.9 }));
          broadcast(room, { type: "game_over", winner: userId, called: room.called });
        } else {
          ws.send(JSON.stringify({ type: "win_rejected", reason: "Invalid claim" }));
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    room.clients.delete(ws);
    broadcast(room, { type: "room_update", players: room.clients.size, prize_pool: room.prizePool });
    // Clean up empty room
    if (room.clients.size === 0 && room.interval) {
      clearInterval(room.interval);
      rooms.delete(roomId);
    }
  });

  ws.on("error", (err) => console.error(`[WS] Error (room ${roomId}):`, err.message));
});

// ================================================================
//  START
// ================================================================
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   OmniHub TMA Backend — Running      ║
  ║   HTTP:  http://localhost:${PORT}       ║
  ║   WS:    ws://localhost:${PORT}/bingo/* ║
  ╚══════════════════════════════════════╝
  `);
});

export default app;
