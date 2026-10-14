// ================================================================
//  OmniHub — server.js
//  Complete Production Backend
//  Version: 2.0 — CORS fix + race condition fix included
// ================================================================

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { Pool }   = require('pg');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const cors       = require('cors');

// ── Route imports ────────────────────────────────────────────────
const { registerAICronJobs } = require('./ai/AIAssistant');

const app    = express();
const server = http.createServer(app);

// ================================================================
//  CORS — explicit origins (fix for browser security errors)
// ================================================================
const ALLOWED_ORIGINS = [
  'https://omnihub.vercel.app',
  'https://omnihub-frontend.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials:  true,
  methods:      ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders:['Content-Type','Authorization','x-admin-key'],
}));

app.use(express.json({ limit: '1mb' }));

// ── Socket.io with matching CORS ──────────────────────────────────
const io = new Server(server, {
  cors: {
    origin:      ALLOWED_ORIGINS,
    methods:     ['GET','POST'],
    credentials: true,
  },
  pingInterval: 10000,
  pingTimeout:  25000,
});

// ── Config ────────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const ADMIN_PASS = process.env.ADMIN_PASS || 'OMNI_ADMIN_2026';

// ── Database ──────────────────────────────────────────────────────
const db = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
      max: 20,
      idleTimeoutMillis: 30000,
    })
  : null;

async function dbQuery(sql, params = []) {
  if (!db) return { rows: [] };
  return db.query(sql, params);
}

// ================================================================
//  BINGO CONSTANTS
// ================================================================
const GRACE_PERIOD_MS  = 30000;
const BALL_INTERVAL_MS = 4000;
const BUY_IN_COINS     = 100;
const BINGO_COLS       = ['B','I','N','G','O'];
const FREE_BIT         = 12;

const WIN_MASKS = [
  0b00000_00000_00000_00000_11111,
  0b00000_00000_00000_11111_00000,
  0b00000_00000_11111_00000_00000,
  0b00000_11111_00000_00000_00000,
  0b11111_00000_00000_00000_00000,
  0b00001_00001_00001_00001_00001,
  0b00010_00010_00010_00010_00010,
  0b00100_00100_00100_00100_00100,
  0b01000_01000_01000_01000_01000,
  0b10000_10000_10000_10000_10000,
  0b10000_01000_00100_00010_00001,
  0b00001_00010_00100_01000_10000,
];

// ================================================================
//  GAME STATE
// ================================================================
const gameState = {
  isActive:     false,
  drawnNumbers: [],
  ballSequence: [],
  drawIndex:    0,
  ballSeed:     '',
  prizePool:    0,
  winner:       null,
  ballInterval: null,
  cdInterval:   null,
  players:      new Map(),
  // players Map: socketId → {
  //   userId, username, socketId,
  //   card,        ← { B:[],I:[],N:[],G:[],O:[] }
  //   mask,        ← 25-bit server bitmask
  //   status,      ← 'active' | 'disconnected'
  //   dcTimer,
  //   joinedAt,
  //   refunded
  // }
};

// ================================================================
//  HELPERS
// ================================================================

function ballLetter(n) {
  if (n <= 15) return 'B';
  if (n <= 30) return 'I';
  if (n <= 45) return 'N';
  if (n <= 60) return 'G';
  return 'O';
}

function generateBallSequence(seed) {
  const balls = Array.from({ length: 75 }, (_, i) => i + 1);
  for (let i = 74; i > 0; i--) {
    const j = crypto
      .createHmac('sha256', seed)
      .update(`ball_${i}`)
      .digest()
      .readUInt32BE(0) % (i + 1);
    [balls[i], balls[j]] = [balls[j], balls[i]];
  }
  return balls;
}

function generateCard(seed) {
  const ranges = {
    B:[1,15], I:[16,30], N:[31,45], G:[46,60], O:[61,75],
  };
  const columns = {};
  BINGO_COLS.forEach((col, ci) => {
    const [min, max] = ranges[col];
    const pool = Array.from({ length: max - min + 1 }, (_, i) => i + min);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = crypto
        .createHmac('sha256', seed)
        .update(`${col}_${i}`)
        .digest()
        .readUInt32BE(0) % (i + 1);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    columns[col] = pool.slice(0, 5);
  });
  columns.N[2] = 'FREE';
  return columns;
}

function buildMask(cardColumns, calledSet) {
  let mask = 1 << FREE_BIT;
  BINGO_COLS.forEach((col, ci) => {
    cardColumns[col]?.forEach((val, row) => {
      if (val !== 'FREE' && calledSet.has(val)) {
        mask |= (1 << (ci * 5 + row));
      }
    });
  });
  return mask;
}

function checkWin(mask) {
  return WIN_MASKS.some(pm => (mask & pm) === pm);
}

// ── Update one player's bitmask when a ball is drawn ─────────────
function updatePlayerMask(player, ball) {
  BINGO_COLS.forEach((col, ci) => {
    player.card[col]?.forEach((val, row) => {
      if (val === ball) {
        player.mask |= (1 << (ci * 5 + row));
      }
    });
  });
}

async function awardCoins(userId, amount, description) {
  try {
    await dbQuery(
      `UPDATE wallets SET coin_balance = coin_balance + $1 WHERE user_id = $2`,
      [amount, userId]
    );
    await dbQuery(
      `INSERT INTO coin_transactions
         (user_id, rule_key, coins, balance_after, description)
       SELECT $1, 'bingo_win', $2, coin_balance, $3
       FROM wallets WHERE user_id = $1`,
      [userId, amount, description]
    );
  } catch (err) {
    console.error('[awardCoins]', err.message);
  }
}

async function refundCoins(userId, amount) {
  try {
    await dbQuery(
      `UPDATE wallets SET coin_balance = coin_balance + $1 WHERE user_id = $2`,
      [amount, userId]
    );
    await dbQuery(
      `INSERT INTO coin_transactions
         (user_id, rule_key, coins, balance_after, description)
       SELECT $1, 'refund', $2, coin_balance,
              'Bingo refund — disconnected before game started'
       FROM wallets WHERE user_id = $1`,
      [userId, amount]
    );
  } catch (err) {
    console.error('[refundCoins]', err.message);
  }
}

// ================================================================
//  GAME FUNCTIONS
// ================================================================

function drawNextBall() {
  if (gameState.drawIndex >= gameState.ballSequence.length) {
    endGame('all_balls_drawn');
    return;
  }

  const ball = gameState.ballSequence[gameState.drawIndex++];
  gameState.drawnNumbers.push(ball);

  // Update every active player's server bitmask
  gameState.players.forEach(player => {
    if (player.status === 'active') {
      updatePlayerMask(player, ball);
    }
  });

  io.emit('new_number', {
    number:      ball,
    letter:      ballLetter(ball),
    called:      gameState.drawnNumbers,
    totalCalled: gameState.drawnNumbers.length,
  });

  console.log(`[Ball] ${ballLetter(ball)}-${ball} | Total: ${gameState.drawnNumbers.length}`);
}

function startBingoRound() {
  if (gameState.isActive) return;

  gameState.ballSeed     = crypto.randomBytes(32).toString('hex');
  gameState.ballSequence = generateBallSequence(gameState.ballSeed);
  gameState.drawnNumbers = [];
  gameState.drawIndex    = 0;
  gameState.isActive     = true;
  gameState.winner       = null;
  gameState.prizePool    = gameState.players.size * BUY_IN_COINS * 0.9;

  io.emit('game_started', {
    message:     '🎯 ቢንጎ ጀምሯል!',
    playerCount: gameState.players.size,
    prizePool:   gameState.prizePool,
    ballSeed:    gameState.ballSeed,
  });

  console.log(`[Game] Started | Players: ${gameState.players.size} | Prize: ${gameState.prizePool}`);
  gameState.ballInterval = setInterval(drawNextBall, BALL_INTERVAL_MS);
}

function endGame(reason) {
  clearInterval(gameState.ballInterval);
  gameState.ballInterval = null;
  gameState.isActive     = false;

  io.emit('game_over', {
    reason,
    winner:     gameState.winner,
    prizePool:  gameState.prizePool,
    totalDrawn: gameState.drawnNumbers.length,
    message:    gameState.winner
      ? `🏆 ${gameState.winner.username} won!`
      : '😔 No winner this round.',
  });

  console.log(`[Game] Over — ${reason} | Winner: ${gameState.winner?.username ?? 'none'}`);
}

function startCountdown() {
  let count = 5;
  gameState.cdInterval = setInterval(() => {
    io.emit('countdown', { seconds: count });
    count--;
    if (count < 0) {
      clearInterval(gameState.cdInterval);
      gameState.cdInterval = null;
      startBingoRound();
    }
  }, 1000);
}

// ================================================================
//  SOCKET.IO
// ================================================================
io.on('connection', socket => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // ── join_game ────────────────────────────────────────────────
  socket.on('join_game', async userData => {
    const { userId, username } = userData || {};
    if (!userId || !username) {
      return socket.emit('error', { message: 'userId and username required' });
    }

    // ── Check for reconnect (same userId exists in players map) ──
    let existingPlayer = null;
    gameState.players.forEach(p => {
      if (p.userId === userId) existingPlayer = p;
    });

    if (existingPlayer) {
      // ── RECONNECT PATH ──────────────────────────────────────
      console.log(`[Reconnect] ${username}`);

      // Cancel grace period timer
      if (existingPlayer.dcTimer) {
        clearTimeout(existingPlayer.dcTimer);
        existingPlayer.dcTimer = null;
      }

      // Swap socket reference
      gameState.players.delete(existingPlayer.socketId);
      existingPlayer.socketId = socket.id;
      existingPlayer.status   = 'active';
      gameState.players.set(socket.id, existingPlayer);

      // Send full current state so client can catch up
      // ── NOTE: card is sent here so client cardRef can be updated ──
      socket.emit('reconnected', {
        message:      '🔄 ተመልሰዋል! Reconnected.',
        isActive:     gameState.isActive,
        drawnNumbers: gameState.drawnNumbers,
        prizePool:    gameState.prizePool,
        playerCount:  gameState.players.size,
        yourCard:     existingPlayer.card,   // ← client updates cardRef here
        yourMask:     existingPlayer.mask,
      });

      io.emit('player_count', gameState.players.size);
      io.emit('player_reconnected', {
        username,
        playerCount: gameState.players.size,
        message: `✅ ${username} ተመልሷል!`,
      });

    } else {
      // ── NEW JOIN PATH ────────────────────────────────────────

      // Deduct buy-in coins from wallet
      const { rows: [wallet] } = await dbQuery(
        `UPDATE wallets
           SET coin_balance = coin_balance - $1
         WHERE user_id = $2
           AND coin_balance >= $1
         RETURNING coin_balance`,
        [BUY_IN_COINS, userId]
      );

      if (process.env.DATABASE_URL && !wallet) {
        return socket.emit('error', {
          message: `Need ${BUY_IN_COINS} OmniCoins to join`,
        });
      }

      // Generate card with crypto seed
      const card = generateCard(`${userId}_${Date.now()}`);

      const playerEntry = {
        userId,
        username,
        socketId: socket.id,
        card,                       // { B:[],I:[],N:[],G:[],O:[] }
        mask:     1 << FREE_BIT,    // FREE center always marked
        status:   'active',
        dcTimer:  null,
        joinedAt: Date.now(),
        refunded: false,
      };

      gameState.players.set(socket.id, playerEntry);

      socket.emit('joined', {
        message:     `ተቀላቀሉ! ${username}`,
        card,                        // ← client stores in cardRef
        buyIn:       BUY_IN_COINS,
        coinBalance: wallet?.coin_balance ?? 'N/A',
        playerCount: gameState.players.size,
      });

      io.emit('player_count', gameState.players.size);
      console.log(`[Join] ${username} | Players: ${gameState.players.size}`);

      // Auto-start countdown when 2+ players
      if (
        gameState.players.size >= 2 &&
        !gameState.isActive &&
        !gameState.cdInterval
      ) {
        startCountdown();
      }
    }
  });

  // ── claim_bingo ──────────────────────────────────────────────
  socket.on('claim_bingo', async () => {
    if (!gameState.isActive) {
      return socket.emit('claim_rejected', { reason: 'no_active_game' });
    }

    const player = gameState.players.get(socket.id);
    if (!player || player.status !== 'active') {
      return socket.emit('claim_rejected', { reason: 'player_not_found' });
    }

    // ── Layer 1: server bitmask check ────────────────────────
    const primaryWin = checkWin(player.mask);

    // ── Layer 2: recompute from scratch (anti-cheat) ─────────
    const recomputed   = buildMask(player.card, new Set(gameState.drawnNumbers));
    const secondaryWin = checkWin(recomputed);

    if (!primaryWin || !secondaryWin) {
      console.log(`[Claim Rejected] ${player.username}`);
      return socket.emit('claim_rejected', {
        reason:  'no_winning_pattern',
        message: '❌ ቢንጎ አይደለም — ቀጥሉ!',
      });
    }

    // ── Valid win ────────────────────────────────────────────
    clearInterval(gameState.ballInterval);

    const coinPrize = gameState.prizePool;
    const etbPrize  = parseFloat((coinPrize * 0.05).toFixed(2));

    await awardCoins(
      player.userId,
      coinPrize,
      `Bingo win — ${gameState.drawnNumbers.length} balls drawn`
    );
    await dbQuery(
      `UPDATE wallets SET balance_etb = balance_etb + $1 WHERE user_id = $2`,
      [etbPrize, player.userId]
    );

    gameState.winner = {
      userId:    player.userId,
      username:  player.username,
      coinPrize,
      etbPrize,
    };

    endGame('winner');
  });

  // ── admin_start_round ────────────────────────────────────────
  socket.on('admin_start_round', pass => {
    if (pass !== ADMIN_PASS) {
      return socket.emit('error', { message: 'Invalid admin password' });
    }
    if (gameState.isActive) {
      return socket.emit('admin_ack', { ok: false, message: 'Already running' });
    }
    io.emit('admin_action', {
      action:  'force_start',
      message: '🔧 Admin ጨዋታ ጀምሯል!',
    });
    startBingoRound();
    socket.emit('admin_ack', {
      ok:          true,
      message:     'Round started',
      playerCount: gameState.players.size,
      prizePool:   gameState.prizePool,
    });
  });

  // ── admin_stop_round ─────────────────────────────────────────
  socket.on('admin_stop_round', pass => {
    if (pass !== ADMIN_PASS) {
      return socket.emit('error', { message: 'Invalid admin password' });
    }
    if (!gameState.isActive) {
      return socket.emit('admin_ack', { ok: false, message: 'No game running' });
    }
    io.emit('admin_action', {
      action:  'force_stop',
      message: '🔧 Admin ጨዋታ አቆሟል!',
    });
    endGame('admin_stopped');
    socket.emit('admin_ack', { ok: true, message: 'Stopped' });
  });

  // ── admin_get_state ──────────────────────────────────────────
  socket.on('admin_get_state', pass => {
    if (pass !== ADMIN_PASS) {
      return socket.emit('error', { message: 'Invalid admin password' });
    }
    socket.emit('admin_state', {
      isActive:     gameState.isActive,
      drawnCount:   gameState.drawnNumbers.length,
      drawnNumbers: gameState.drawnNumbers,
      prizePool:    gameState.prizePool,
      playerCount:  gameState.players.size,
      players: [...gameState.players.values()].map(p => ({
        username: p.username,
        status:   p.status,
        refunded: p.refunded,
      })),
    });
  });

  // ── chat ─────────────────────────────────────────────────────
  socket.on('chat', ({ text }) => {
    const player = gameState.players.get(socket.id);
    if (!player || !text?.trim()) return;
    io.emit('chat', {
      username: player.username,
      text:     text.trim().slice(0, 200),
      ts:       Date.now(),
    });
  });

  // ── keep-alive ───────────────────────────────────────────────
  socket.on('ping_client',  () => socket.emit('pong_server'));
  socket.on('pong_server',  () => { socket.isAlive = true; });

  // ── disconnect — 30-second grace period ─────────────────────
  socket.on('disconnect', reason => {
    const player = gameState.players.get(socket.id);
    if (!player) return;

    player.status = 'disconnected';
    console.log(`[DC] ${player.username} (${reason}) — grace ${GRACE_PERIOD_MS/1000}s`);

    io.emit('player_disconnected', {
      username:     player.username,
      graceSeconds: GRACE_PERIOD_MS / 1000,
      message:      `⚠️ ${player.username} ተቋርጧል — ${GRACE_PERIOD_MS/1000}s ለ reconnect`,
      playerCount:  gameState.players.size,
    });

    player.dcTimer = setTimeout(async () => {
      const current = gameState.players.get(socket.id);
      if (!current || current.status !== 'disconnected') return;

      // Refund buy-in if game hasn't started
      if (!gameState.isActive && !current.refunded) {
        await refundCoins(current.userId, BUY_IN_COINS);
        current.refunded = true;
      }

      gameState.players.delete(socket.id);

      io.emit('player_removed', {
        username:    player.username,
        playerCount: gameState.players.size,
        message:     `${player.username} ሰዓቱ አልፏል — ወጥቷል`,
      });

      console.log(`[Grace Expired] ${player.username} removed`);

      // End game if no active players remain
      const activePlayers = [...gameState.players.values()]
        .filter(p => p.status === 'active');
      if (gameState.isActive && activePlayers.length === 0) {
        endGame('all_players_disconnected');
      }

    }, GRACE_PERIOD_MS);
  });
});

// ── Heartbeat — remove zombie sockets ────────────────────────────
setInterval(() => {
  io.sockets.sockets.forEach(s => {
    if (s.isAlive === false) { s.disconnect(true); return; }
    s.isAlive = false;
    s.emit('server_ping');
  });
}, 30000);

// ================================================================
//  REST ENDPOINTS
// ================================================================

app.get('/health', (_req, res) => {
  res.json({
    status:   'ok',
    uptime:   Math.floor(process.uptime()),
    isActive: gameState.isActive,
    players:  gameState.players.size,
    services: {
      database: !!db,
      ai:       !!process.env.ANTHROPIC_API_KEY,
      chapa:    !!process.env.CHAPA_SECRET_KEY,
    },
  });
});

app.get('/admin/state', (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_PASS) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({
    isActive:    gameState.isActive,
    drawnCount:  gameState.drawnNumbers.length,
    prizePool:   gameState.prizePool,
    playerCount: gameState.players.size,
    players: [...gameState.players.values()].map(p => ({
      username: p.username,
      status:   p.status,
      refunded: p.refunded,
    })),
  });
});

app.post('/admin/start', (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_PASS) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (gameState.isActive) {
    return res.json({ ok: false, message: 'Already running' });
  }
  io.emit('admin_action', { action:'force_start', message:'🔧 Admin ጨዋታ ጀምሯል!' });
  startBingoRound();
  res.json({ ok: true, players: gameState.players.size, prizePool: gameState.prizePool });
});

app.post('/admin/stop', (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_PASS) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (!gameState.isActive) return res.json({ ok: false, message: 'No game running' });
  endGame('admin_stopped');
  res.json({ ok: true });
});

// ================================================================
//  START
// ================================================================
server.listen(PORT, () => {
  console.log('');
  console.log(`  ✅  OmniHub Server running on port ${PORT}`);
  console.log(`  📡  Socket.io : ws://localhost:${PORT}`);
  console.log(`  🔗  Health    : http://localhost:${PORT}/health`);
  console.log(`  🔒  Admin     : http://localhost:${PORT}/admin/state`);
  console.log(`  🌐  CORS OK   : ${ALLOWED_ORIGINS.join(', ')}`);
  console.log('');

  // Start AI cron jobs (daily summary, holiday rewards)
  try { registerAICronJobs(); } catch (e) {
    console.log('  ⚠️  AI cron skipped (AIAssistant.js not found)');
  }
});
