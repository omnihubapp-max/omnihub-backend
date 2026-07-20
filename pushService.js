// ================================================================
//  OmniHub — pushService.js  (C: Push Notifications)
//  Firebase FCM + In-App Notifications + Cron Reminders
//  Install: npm install firebase-admin node-cron
// ================================================================
const cron = require('node-cron');
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

let admin;
let fbApp;

function initFirebase() {
  if (fbApp) return fbApp;
  try {
    admin = require('firebase-admin');
    if (!process.env.FIREBASE_PROJECT_ID) {
      console.warn('[FCM] No Firebase config — DB-only mode');
      return null;
    }
    fbApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
    console.log('[FCM] Firebase initialized ✅');
    return fbApp;
  } catch(e) {
    console.warn('[FCM] Firebase init failed:', e.message);
    return null;
  }
}

// ── SAVE TOKEN ────────────────────────────────────────────────────
async function saveFCMToken(userId, token, platform = 'web') {
  try {
    await db.query(
      `INSERT INTO push_tokens(user_id,token,platform,updated_at)
       VALUES($1,$2,$3,NOW())
       ON CONFLICT(user_id,token) DO UPDATE
       SET platform=$3, updated_at=NOW(), active=true`,
      [userId, token, platform]
    );
  } catch(e) { console.error('[FCM] saveFCMToken:', e.message); }
}

// ── SEND TO ONE USER ─────────────────────────────────────────────
async function sendToUser(userId, { title, body, data = {} }) {
  // 1. Always store in-app
  await db.query(
    `INSERT INTO notifications(user_id,title,body,data,type)
     VALUES($1,$2,$3,$4,$5)`,
    [userId, title, body, JSON.stringify(data), data.type || 'general']
  ).catch(() => {});

  if (!fbApp || !admin) return { sent: 0, stored: true };

  // 2. Get active tokens
  const { rows } = await db.query(
    `SELECT token FROM push_tokens WHERE user_id=$1 AND active=true LIMIT 10`,
    [userId]
  ).catch(() => ({ rows: [] }));

  if (!rows.length) return { sent: 0, stored: true };

  // 3. Build and send messages
  const dataStr = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v)])
  );

  const results = await Promise.allSettled(
    rows.map(({ token }) => admin.messaging().send({
      token,
      notification: { title, body },
      data: dataStr,
      android: {
        priority: 'high',
        notification: { sound:'default', channelId:'omnihub_main', color:'#d4af37' },
      },
      apns: { payload: { aps: { sound:'default', badge:1 } } },
      webpush: {
        notification: { icon:'/icons/icon-192.png', badge:'/icons/icon-72.png' },
        fcmOptions:   { link: data.url || '/' },
      },
    }))
  );

  // 4. Deactivate dead tokens
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      const code = results[i].reason?.errorInfo?.code || '';
      if (code.includes('not-registered') || code.includes('invalid-registration')) {
        await db.query(
          `UPDATE push_tokens SET active=false WHERE user_id=$1 AND token=$2`,
          [userId, rows[i].token]
        ).catch(() => {});
      }
    }
  }

  return { sent: results.filter(r => r.status === 'fulfilled').length };
}

// ── SEND TO MANY USERS ───────────────────────────────────────────
async function sendToMany(userIds, payload) {
  if (!userIds?.length) return { sent: 0, total: 0 };
  const results = await Promise.allSettled(
    userIds.map(uid => sendToUser(uid, payload))
  );
  return {
    sent:  results.filter(r => r.status === 'fulfilled').length,
    total: userIds.length,
  };
}

// ── SEND TO ALL ACTIVE USERS ─────────────────────────────────────
async function sendToAll(payload) {
  const { rows } = await db.query(
    `SELECT DISTINCT user_id FROM push_tokens WHERE active=true LIMIT 10000`
  ).catch(() => ({ rows: [] }));
  return sendToMany(rows.map(r => r.user_id), payload);
}

// ── TYPED NOTIFICATION HELPERS ───────────────────────────────────
const NOTIF = {

  bingoWin: (uid, { coinPrize, etbPrize }) =>
    sendToUser(uid, {
      title: '🏆 BINGO! You Won!',
      body:  `+₵${coinPrize} coins & ${etbPrize} ETB credited to your wallet!`,
      data:  { type:'bingo_win', url:'/#bingo' },
    }),

  bingoStart: (uids, { prizePool, playerCount }) =>
    sendToMany(uids, {
      title: '🎯 Bingo Game Starting!',
      body:  `${playerCount} players joined. Prize pool: ₵${prizePool}`,
      data:  { type:'bingo_start', url:'/#bingo' },
    }),

  depositDone: (uid, { amountETB, provider }) =>
    sendToUser(uid, {
      title: '✅ Deposit Confirmed',
      body:  `${Number(amountETB).toLocaleString()} ETB added via ${provider}`,
      data:  { type:'deposit_confirmed', url:'/#wallet' },
    }),

  withdrawDone: (uid, { amountETB, provider }) =>
    sendToUser(uid, {
      title: '💸 Withdrawal Sent',
      body:  `${Number(amountETB).toLocaleString()} ETB sent via ${provider}`,
      data:  { type:'withdrawal_done', url:'/#wallet' },
    }),

  transferIn: (uid, { fromUser, amountETB }) =>
    sendToUser(uid, {
      title: '💰 Money Received!',
      body:  `${fromUser} sent you ${Number(amountETB).toLocaleString()} ETB`,
      data:  { type:'transfer_received', url:'/#wallet' },
    }),

  kycApproved: (uid) =>
    sendToUser(uid, {
      title: '✅ KYC Approved! ማንነት ተፈቀደ',
      body:  '+200 OmniCoins bonus credited! Withdrawals unlocked.',
      data:  { type:'kyc_approved', url:'/#wallet' },
    }),

  kycRejected: (uid, { reason }) =>
    sendToUser(uid, {
      title: '❌ KYC Rejected — Please Resubmit',
      body:  `Reason: ${reason}`,
      data:  { type:'kyc_rejected', url:'/#kyc' },
    }),

  orderShipped: (uid, { productTitle, trackingCode }) =>
    sendToUser(uid, {
      title: '📦 Order Shipped!',
      body:  `"${productTitle}" on the way. Track: ${trackingCode || 'N/A'}`,
      data:  { type:'order_shipped', url:'/#market' },
    }),

  itemSold: (uid, { productTitle, amountETB }) =>
    sendToUser(uid, {
      title: '🛍️ Your Item Sold!',
      body:  `"${productTitle}" sold for ${Number(amountETB).toLocaleString()} ETB`,
      data:  { type:'item_sold', url:'/#market' },
    }),

  holidayBonus: (uids, { name, nameAm, coins, mult }) =>
    sendToMany(uids, {
      title: `🎉 ${name} Bonus!`,
      body:  `${nameAm} — +${coins} OmniCoins · ${mult}× multiplier on all games today!`,
      data:  { type:'holiday_bonus', url:'/' },
    }),

  dailyStreak: (uid, { coins, streak }) =>
    sendToUser(uid, {
      title: `🔥 Day ${streak} Streak!`,
      body:  `+${coins} OmniCoins daily bonus. Keep it going!`,
      data:  { type:'daily_login', url:'/' },
    }),

  socialMention: (uid, { fromUser }) =>
    sendToUser(uid, {
      title: `💬 ${fromUser} mentioned you`,
      body:  'Tap to see the post',
      data:  { type:'social_mention', url:'/#social' },
    }),
};

// ── IN-APP NOTIFICATION QUERIES ──────────────────────────────────
async function getNotifications(userId, limit = 20, offset = 0) {
  const { rows } = await db.query(
    `SELECT id,title,body,data,type,read,created_at
     FROM notifications WHERE user_id=$1
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  const { rows: [{ count }] } = await db.query(
    `SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND read=false`,
    [userId]
  );
  return { notifications: rows, unreadCount: parseInt(count) };
}

async function markRead(userId, ids) {
  await db.query(
    `UPDATE notifications SET read=true WHERE user_id=$1 AND id=ANY($2::uuid[])`,
    [userId, ids]
  );
}

async function markAllRead(userId) {
  await db.query(
    `UPDATE notifications SET read=true WHERE user_id=$1`, [userId]
  );
}

// ── SCHEDULED NOTIFICATION CRONS ────────────────────────────────
function startNotifCrons() {
  // 8am EAT (5am UTC) — re-engage inactive users
  cron.schedule('0 5 * * *', async () => {
    try {
      const { rows } = await db.query(
        `SELECT id FROM users
         WHERE last_login < NOW()-INTERVAL '24 hours'
           AND created_at > NOW()-INTERVAL '30 days'
         LIMIT 1000`
      );
      if (!rows.length) return;
      await sendToMany(rows.map(r => r.id), {
        title: '🎲 OmniHub misses you!',
        body:  'New Bingo games starting — your daily streak resets soon!',
        data:  { type:'comeback', url:'/' },
      });
      console.log(`[NOTIF Cron] Comeback push → ${rows.length} users`);
    } catch(e) { console.error('[NOTIF Cron daily]', e.message); }
  });

  // Sunday 9am EAT (6am UTC) — Sunday bonus reminder
  cron.schedule('0 6 * * 0', async () => {
    try {
      const { rows } = await db.query(
        `SELECT id FROM users WHERE created_at > NOW()-INTERVAL '90 days' LIMIT 5000`
      );
      await sendToMany(rows.map(r => r.id), {
        title: '☀️ Sunday Bonus Active!',
        body:  '1.5× OmniCoins on ALL games today only! ₵ Sunday ₵',
        data:  { type:'sunday_bonus', url:'/' },
      });
      console.log(`[NOTIF Cron] Sunday bonus → ${rows.length} users`);
    } catch(e) { console.error('[NOTIF Cron sunday]', e.message); }
  });

  console.log('[NOTIF] Cron jobs started ✅');
}

/*
── DB SCHEMA (add to schema.sql) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS push_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  platform   VARCHAR(20) DEFAULT 'web',
  active     BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, token)
);
CREATE INDEX idx_push_user ON push_tokens(user_id) WHERE active=true;

CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      VARCHAR(200) NOT NULL,
  body       TEXT,
  data       JSONB,
  type       VARCHAR(50) DEFAULT 'general',
  read       BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_notif_user   ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notif_unread ON notifications(user_id) WHERE read=false;
*/

module.exports = {
  initFirebase, saveFCMToken, sendToUser, sendToMany, sendToAll,
  NOTIF, getNotifications, markRead, markAllRead, startNotifCrons,
};
