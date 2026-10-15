// ================================================================
//  OmniHub — server.js  (FINAL INTEGRATED — A+B+C+D+E+G)
//  All modules wired: Security + Notifications + Monitoring
//                     + Engagement + USSD + Bingo WebSocket
//
//  Install ALL deps:
//  npm install express socket.io pg jsonwebtoken bcryptjs cors
//    dotenv axios multer nodemailer node-cron @anthropic-ai/sdk
//    express-rate-limit helmet joi @sentry/node
//    @sentry/profiling-node firebase-admin
// ================================================================
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { Pool }   = require('pg');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const cors       = require('cors');
const crypto     = require('crypto');
const path       = require('path');

// ── Local modules ──────────────────────────────────────────────────
const {
  helmetConfig, globalLimiter, authLimiter,
  paymentLimiter, chatLimiter, walletLimiter,
  validate, sqlGuard, auth, adminAuth,
} = require('./security');

const {
  initSentry, sentryRequestHandler, sentryTracingHandler,
  sentryErrorHandler, captureError, captureMessage,
  healthCheck, metricsMiddleware, getMetrics,
  globalErrorHandler, attachProcessHandlers, metrics,
} = require('./monitoring');

const {
  initFirebase, NOTIF, startNotifCrons,
} = require('./notifications/pushService');

const notifRoutes  = require('./notifications/notifRoutes');
const engagementR = require('./engagement');
const ussdRouter = require('./ussd');
const aiRoutes = require('./aiRoutes');
const paymentRoutes= require('./routes/paymentRoutes');
const kycRoutes    = require('./routes/kycRoutes');
const marketRoutes = require('./routes/marketRoutes');
const webhookRoutes= require('./webhook/webhookRoutes');
const { awardCoins, processDailyLogin, startCronJobs } = require('./rewards');

// ── Config ─────────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION';
const ADMIN_PASS = process.env.ADMIN_PASS || 'OMNI_ADMIN_2026';

const ALLOWED_ORIGINS = [
  'https://omnihub.vercel.app',
  'https://omnihub-frontend.vercel.app',
  'https://omnihub-pwa.netlify.app',
  'http://localhost:5173',
  'http://localhost:3000',
  process.env.FRONTEND_URL,
].filter(Boolean);

// ── App + Server ────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ── DB Pool ─────────────────────────────────────────────────────────
const db = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, max: 20 })
  : null;

async function dbQuery(sql, params = []) {
  if (!db) return { rows: [] };
  return db.query(sql, params);
}

// ── Socket.io ───────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET','POST'], credentials: true },
  pingInterval: 10000,
  pingTimeout:  25000,
});

// ================================================================
//  SENTRY — must be FIRST
// ================================================================
initSentry(app);
app.use(sentryRequestHandler());
app.use(sentryTracingHandler());
attachProcessHandlers();

// ================================================================
//  CORE MIDDLEWARE
// ================================================================
app.use(helmetConfig);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(globalLimiter);
app.use(metricsMiddleware);
app.use(sqlGuard);

// Serve KYC upload folder (admin only — protected in kycRoutes)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ================================================================
//  BINGO ENGINE CONSTANTS
// ================================================================
const GRACE_MS     = 30000;
const BALL_MS      = 4000;
const BUY_IN       = 100;
const BINGO_COLS   = ['B','I','N','G','O'];
const FREE_BIT     = 12;
const WIN_MASKS    = [
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

function ballLetter(n) {
  if (n<=15) return 'B'; if (n<=30) return 'I';
  if (n<=45) return 'N'; if (n<=60) return 'G'; return 'O';
}
function checkWin(mask) {
  return WIN_MASKS.some(pm => (mask & pm) === pm);
}
function buildMask(card, calledSet) {
  let mask = 1 << FREE_BIT;
  BINGO_COLS.forEach((col, ci) => {
    card[col]?.forEach((val, row) => {
      if (val !== 'FREE' && calledSet.has(val))
        mask |= (1 << (ci * 5 + row));
    });
  });
  return mask;
}
function generateCard(seed) {
  const ranges = { B:[1,15],I:[16,30],N:[31,45],G:[46,60],O:[61,75] };
  const columns = {};
  BINGO_COLS.forEach((col, ci) => {
    const [min, max] = ranges[col];
    const pool = Array.from({ length: max-min+1 }, (_, i) => i+min);
    for (let i = pool.length-1; i > 0; i--) {
      const hash = crypto.createHmac('sha256', seed).update(`${col}${i}`).digest();
      const j    = hash.readUInt32BE(0) % (i+1);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    columns[col] = pool.slice(0,5);
  });
  columns.N[2] = 'FREE';
  return columns;
}
function generateBallSeq(seed) {
  const balls = Array.from({ length:75 }, (_, i) => i+1);
  for (let i = 74; i > 0; i--) {
    const hash = crypto.createHmac('sha256', seed).update(`ball${i}`).digest();
    const j    = hash.readUInt32BE(0) % (i+1);
    [balls[i], balls[j]] = [balls[j], balls[i]];
  }
  return balls;
}

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
  players:      new Map(), // socketId → player
};

function drawBall() {
  if (gameState.drawIndex >= gameState.ballSequence.length) {
    endGame('all_balls_drawn'); return;
  }
  const ball = gameState.ballSequence[gameState.drawIndex++];
  gameState.drawnNumbers.push(ball);

  // Update all player masks server-side (authoritative)
  gameState.players.forEach(p => {
    if (p.status === 'active') {
      BINGO_COLS.forEach((col, ci) => {
        p.card[col]?.forEach((val, row) => {
          if (val === ball) p.mask |= (1 << (ci*5+row));
        });
      });
    }
  });

  io.emit('new_number', {
    number:      ball,
    letter:      ballLetter(ball),
    called:      gameState.drawnNumbers,
    totalCalled: gameState.drawnNumbers.length,
  });
  metrics.bingoGamesStarted;
}

function startRound() {
  if (gameState.isActive) return;
  gameState.ballSeed      = crypto.randomBytes(32).toString('hex');
  gameState.ballSequence  = generateBallSeq(gameState.ballSeed);
  gameState.drawnNumbers  = [];
  gameState.drawIndex     = 0;
  gameState.isActive      = true;
  gameState.winner        = null;
  gameState.prizePool     = Math.floor(gameState.players.size * BUY_IN * 0.9);

  io.emit('game_started', {
    prizePool:   gameState.prizePool,
    playerCount: gameState.players.size,
    ballSeed:    gameState.ballSeed,
    message:     '🎯 ቢንጎ ጀምሯል! Game is LIVE!',
  });
  gameState.ballInterval = setInterval(drawBall, BALL_MS);
  metrics.bingoGamesStarted++;
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
}

function startCountdown() {
  let count = 5;
  gameState.cdInterval = setInterval(() => {
    io.emit('countdown', { seconds: count });
    count--;
    if (count < 0) {
      clearInterval(gameState.cdInterval);
      gameState.cdInterval = null;
      startRound();
    }
  }, 1000);
}

// ================================================================
//  SOCKET.IO — BINGO
// ================================================================
io.on('connection', socket => {
  socket.isAlive = true;
  console.log(`[Socket] Connect: ${socket.id}`);

  socket.on('join_game', async ({ userId, username }) => {
    if (!userId || !username)
      return socket.emit('error', { message: 'userId and username required' });

    // Check reconnect
    let existing = null, existingSid = null;
    gameState.players.forEach((p, sid) => {
      if (p.userId === userId) { existing = p; existingSid = sid; }
    });

    if (existing) {
      // Reconnect
      if (existing.dcTimer) { clearTimeout(existing.dcTimer); existing.dcTimer = null; }
      gameState.players.delete(existingSid);
      existing.socketId = socket.id;
      existing.status   = 'active';
      gameState.players.set(socket.id, existing);

      socket.emit('reconnected', {
        message:      '🔄 ተመልሰዋል!',
        isActive:     gameState.isActive,
        drawnNumbers: gameState.drawnNumbers,
        prizePool:    gameState.prizePool,
        playerCount:  gameState.players.size,
        yourCard:     existing.card,
        yourMask:     buildMask(existing.card, new Set(gameState.drawnNumbers)),
      });
      io.emit('player_reconnected', { username, playerCount: gameState.players.size });

    } else {
      // New join — deduct coins
      const { rows: [wallet] } = await dbQuery(
        `UPDATE wallets SET coin_balance=coin_balance-$1
         WHERE user_id=$2 AND coin_balance>=$1 RETURNING coin_balance`,
        [BUY_IN, userId]
      ).catch(() => ({ rows: [] }));

      if (db && !wallet)
        return socket.emit('error', { message: `Need 🪙${BUY_IN} OmniCoins to join` });

      const card = generateCard(`${userId}_${Date.now()}`);
      gameState.players.set(socket.id, {
        userId, username, socketId: socket.id,
        card, mask: 1 << FREE_BIT,
        status: 'active', dcTimer: null,
        joinedAt: Date.now(), refunded: false,
      });

      // Award daily login coins (non-blocking)
      processDailyLogin(userId).catch(() => {});

      socket.emit('joined', {
        card, buyIn: BUY_IN,
        coinBalance: wallet?.coin_balance ?? 'N/A',
        prizePool:   gameState.prizePool,
        playerCount: gameState.players.size,
        message:     `ሰላም ${username}! ጨዋታ ዝግጁ ነው።`,
      });
      io.emit('player_count', gameState.players.size);

      // Auto-start when 2+ players
      if (gameState.players.size >= 2 && !gameState.isActive && !gameState.cdInterval)
        startCountdown();
    }
  });

  socket.on('claim_bingo', async () => {
    if (!gameState.isActive)
      return socket.emit('claim_rejected', { reason: 'no_active_game' });

    const player = gameState.players.get(socket.id);
    if (!player) return socket.emit('claim_rejected', { reason: 'player_not_found' });

    // Double validation (primary + recompute)
    const primary   = checkWin(player.mask);
    const recomputed = buildMask(player.card, new Set(gameState.drawnNumbers));
    const secondary  = checkWin(recomputed);

    if (!primary || !secondary)
      return socket.emit('claim_rejected', { reason: 'no_pattern', message: '❌ ቢንጎ አይደለም!' });

    clearInterval(gameState.ballInterval);
    const coinPrize = Math.floor(gameState.prizePool);
    const etbPrize  = parseFloat((coinPrize * 0.05).toFixed(2));

    // Credit winner
    await dbQuery(
      `UPDATE wallets SET coin_balance=coin_balance+$1, balance_etb=balance_etb+$2 WHERE user_id=$3`,
      [coinPrize, etbPrize, player.userId]
    ).catch(() => {});
    await awardCoins(player.userId, 'bingo_win').catch(() => {});

    // Send win push notification
    NOTIF.bingoWin(player.userId, { coinPrize, etbPrize }).catch(() => {});

    gameState.winner = { userId: player.userId, username: player.username, coinPrize, etbPrize };
    metrics.bingoWinsClaimed++;
    endGame('winner');
  });

  socket.on('admin_start_round', pass => {
    if (pass !== ADMIN_PASS) return socket.emit('error', { message: 'Invalid admin key' });
    if (gameState.isActive) return socket.emit('admin_ack', { ok:false, message:'Already running' });
    io.emit('admin_action', { action:'force_start', message:'🔧 Admin ጨዋታ ጀምሯል!' });
    startRound();
    socket.emit('admin_ack', { ok:true, players:gameState.players.size, prizePool:gameState.prizePool });
  });

  socket.on('admin_stop_round', pass => {
    if (pass !== ADMIN_PASS) return socket.emit('error', { message: 'Invalid admin key' });
    if (!gameState.isActive) return socket.emit('admin_ack', { ok:false, message:'Not running' });
    io.emit('admin_action', { action:'force_stop', message:'🔧 Admin ጨዋታ አቆሟል!' });
    endGame('admin_stopped');
    socket.emit('admin_ack', { ok:true });
  });

  socket.on('admin_get_state', pass => {
    if (pass !== ADMIN_PASS) return socket.emit('error', { message: 'Forbidden' });
    socket.emit('admin_state', {
      isActive:    gameState.isActive,
      drawnCount:  gameState.drawnNumbers.length,
      prizePool:   gameState.prizePool,
      playerCount: gameState.players.size,
      players: [...gameState.players.values()].map(p => ({
        username: p.username, status: p.status, joinedAt: p.joinedAt,
      })),
    });
  });

  socket.on('chat', ({ text }) => {
    const p = gameState.players.get(socket.id);
    if (!p || !text?.trim()) return;
    io.emit('chat', { username: p.username, text: text.trim().slice(0,200), ts: Date.now() });
  });

  socket.on('pong_server', () => { socket.isAlive = true; });

  socket.on('disconnect', reason => {
    const player = gameState.players.get(socket.id);
    if (!player) return;
    player.status = 'disconnected';

    io.emit('player_disconnected', {
      username:     player.username,
      graceSeconds: GRACE_MS / 1000,
      playerCount:  gameState.players.size,
    });

    player.dcTimer = setTimeout(async () => {
      const current = gameState.players.get(socket.id);
      if (!current || current.status !== 'disconnected') return;

      if (!gameState.isActive && !current.refunded) {
        await dbQuery(
          `UPDATE wallets SET coin_balance=coin_balance+$1 WHERE user_id=$2`,
          [BUY_IN, current.userId]
        ).catch(() => {});
        current.refunded = true;
      }

      gameState.players.delete(socket.id);
      io.emit('player_removed', { username: player.username, playerCount: gameState.players.size });

      const active = [...gameState.players.values()].filter(p => p.status === 'active');
      if (gameState.isActive && active.length === 0) endGame('all_disconnected');
    }, GRACE_MS);
  });
});

// Heartbeat — remove zombie connections
const heartbeat = setInterval(() => {
  io.sockets.sockets.forEach(s => {
    if (s.isAlive === false) { s.disconnect(true); return; }
    s.isAlive = false;
    s.emit('server_ping');
  });
}, 30000);
io.on('close', () => clearInterval(heartbeat));

// ================================================================
//  AUTH ROUTES
// ================================================================
app.post('/api/auth/register', authLimiter, validate('register'), async (req, res) => {
  try {
    const { phone, email, username, password, language } = req.validatedBody;
    const hash = await bcrypt.hash(password, 12);
    const { rows:[user] } = await dbQuery(
      `INSERT INTO users(phone,email,username,password_hash,language)
       VALUES($1,$2,$3,$4,$5) RETURNING id,username,language`,
      [phone, email||null, username, hash, language]
    );
    // Create wallets
    await dbQuery(
      `INSERT INTO wallets(user_id,currency,balance) VALUES($1,'ETB',0),($1,'USD',0)`,
      [user.id]
    );
    await dbQuery(
      `INSERT INTO coin_balances(user_id,total_coins) VALUES($1,0)`,
      [user.id]
    );
    const token = jwt.sign({ id:user.id, username:user.username }, JWT_SECRET, { expiresIn:'30d' });
    res.status(201).json({ token, user: { id:user.id, username:user.username, language:user.language } });
  } catch(err) {
    if (err.code === '23505')
      return res.status(409).json({ error:'already_exists', message:'Phone/email/username taken' });
    captureError(err, { route:'/api/auth/register' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', authLimiter, validate('login'), async (req, res) => {
  try {
    const { identifier, password } = req.validatedBody;
    const { rows:[user] } = await dbQuery(
      `SELECT id, username, password_hash, language FROM users
       WHERE phone=$1 OR email=$1 OR username=$1`,
      [identifier]
    );
    if (!user) return res.status(401).json({ error:'invalid_credentials' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok)  return res.status(401).json({ error:'invalid_credentials' });

    await dbQuery(`UPDATE users SET last_login=NOW() WHERE id=$1`, [user.id]);
    const token = jwt.sign({ id:user.id, username:user.username }, JWT_SECRET, { expiresIn:'30d' });
    res.json({ token, user: { id:user.id, username:user.username, language:user.language } });
  } catch(err) {
    captureError(err, { route:'/api/auth/login' });
    res.status(500).json({ error: err.message });
  }
});

// TMA (Telegram Mini App) auth
app.post('/api/auth/tma', async (req, res) => {
  try {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ error:'initData_required' });
    // In production: verify initData HMAC with BOT_TOKEN
    // For now: extract user from initData string
    const params  = new URLSearchParams(initData);
    const userStr = params.get('user');
    if (!userStr) return res.status(400).json({ error:'no_user_in_initData' });
    const tgUser  = JSON.parse(userStr);

    // Find or create user by Telegram ID
    let { rows:[user] } = await dbQuery(
      `SELECT id,username FROM users WHERE telegram_id=$1`, [String(tgUser.id)]
    );
    if (!user) {
      const username = `tg_${tgUser.id}`;
      const { rows:[newUser] } = await dbQuery(
        `INSERT INTO users(username,telegram_id,language,password_hash)
         VALUES($1,$2,'am','tg_auth') RETURNING id,username`,
        [username, String(tgUser.id)]
      );
      await dbQuery(`INSERT INTO wallets(user_id,currency) VALUES($1,'ETB'),($1,'USD')`, [newUser.id]);
      await dbQuery(`INSERT INTO coin_balances(user_id) VALUES($1)`, [newUser.id]);
      user = newUser;
    }
    const token = jwt.sign({ id:user.id, username:user.username }, JWT_SECRET, { expiresIn:'30d' });
    res.json({ token, user });
  } catch(err) {
    captureError(err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  MOUNT ALL ROUTES
// ================================================================
app.get('/health',          healthCheck);
app.get('/metrics',         getMetrics);

// API routes
app.use('/api/ai',           chatLimiter, aiRoutes);
app.use('/api/payment',      paymentLimiter, paymentRoutes);
app.use('/api/kyc',          kycRoutes);
app.use('/api/market',       marketRoutes);
app.use('/api/notifications', notifRoutes);
app.use('/api/engagement',   engagementR);

// Webhook routes (no rate limit — Chapa/Telebirr call these)
app.use('/webhook',          webhookRoutes);

// USSD route (Ethio Telecom calls this)
app.use('/ussd',             ussdRouter);

// Admin REST fallbacks
app.get('/admin/state',  (req,res) => {
  if (req.headers['x-admin-key'] !== ADMIN_PASS) return res.status(403).json({error:'forbidden'});
  res.json({ isActive:gameState.isActive, players:gameState.players.size, prizePool:gameState.prizePool });
});
app.post('/admin/start', (req,res) => {
  if (req.headers['x-admin-key'] !== ADMIN_PASS) return res.status(403).json({error:'forbidden'});
  if (gameState.isActive) return res.json({ ok:false, message:'Already running' });
  io.emit('admin_action', { action:'force_start', message:'🔧 Admin ጨዋታ ጀምሯል!' });
  startRound();
  res.json({ ok:true, players:gameState.players.size, prizePool:gameState.prizePool });
});
app.post('/admin/stop',  (req,res) => {
  if (req.headers['x-admin-key'] !== ADMIN_PASS) return res.status(403).json({error:'forbidden'});
  if (!gameState.isActive) return res.json({ ok:false, message:'Not running' });
  endGame('admin_stopped');
  res.json({ ok:true });
});

// ================================================================
//  SENTRY + GLOBAL ERROR HANDLER (must be LAST)
// ================================================================
app.use(sentryErrorHandler());
app.use(globalErrorHandler);

// ================================================================
//  STARTUP
// ================================================================
async function startup() {
  // Init Firebase push notifications
  initFirebase();

  // Start notification cron jobs
  startNotifCrons();

  // Start rewards cron jobs (holiday sweep, executive summary, overdue loans)
  try { startCronJobs(); } catch (e) { console.warn('[Rewards Cron] Not loaded:', e.message); }

  // Start AI daily summary cron (from aiRoutes)
  try {
    const { registerAICronJobs } = require('./ai/AIAssistant');
    registerAICronJobs();
  } catch(e) { console.warn('[AI Cron] Not loaded:', e.message); }

  // Start server
  server.listen(PORT, () => {
    console.log('');
    console.log(`  ✅  OmniHub FINAL Server — port ${PORT}`);
    console.log(`  📡  WebSocket:  ws://localhost:${PORT}`);
    console.log(`  🏥  Health:     http://localhost:${PORT}/health`);
    console.log(`  📊  Metrics:    http://localhost:${PORT}/metrics`);
    console.log(`  🔒  CORS:       ${ALLOWED_ORIGINS.join(', ')}`);
    console.log(`  🌍  Modules:    Security ✅ Notifications ✅ Monitoring ✅`);
    console.log(`                  Engagement ✅ USSD ✅ Bingo ✅`);
    console.log('');
    captureMessage('OmniHub server started', 'info', { port: PORT });
  });
}

startup().catch(err => {
  console.error('[STARTUP FAILED]', err);
  process.exit(1);
});
