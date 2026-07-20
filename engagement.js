// ================================================================
//  OmniHub — engagement.js  (E: Leaderboard + Streaks + Referrals)
//  Mount: app.use('/api/engagement', engagementRouter)
// ================================================================
const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ── auth middleware (inline if security.js not available) ─────────
function auth(req, res, next) {
  try {
    const jwt   = require('jsonwebtoken');
    const token = req.headers.authorization?.replace('Bearer ','');
    if (!token) return res.status(401).json({ error:'no_token' });
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ error:'invalid_token' }); }
}
function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_PASS)
    return res.status(403).json({ error:'forbidden' });
  next();
}

// ================================================================
//  E1. LEADERBOARD
// ================================================================

// GET /api/engagement/leaderboard?period=daily|weekly|monthly&type=coins|bingo|marketplace
router.get('/leaderboard', async (req, res) => {
  try {
    const { period='weekly', type='coins', limit='50' } = req.query;
    const periodMap = {
      daily:   "NOW() - INTERVAL '1 day'",
      weekly:  "NOW() - INTERVAL '7 days'",
      monthly: "NOW() - INTERVAL '30 days'",
      alltime: "NOW() - INTERVAL '10 years'",
    };
    const since = periodMap[period] || periodMap.weekly;
    const lim   = Math.min(parseInt(limit) || 50, 100);
    let rows;

    if (type === 'bingo') {
      ({ rows } = await db.query(`
        SELECT u.id, u.username, u.badge, u.avatar_url,
               COUNT(bs.id)               AS games_won,
               COALESCE(SUM(t.amount),0)  AS total_etb_won
        FROM users u
        JOIN bingo_sessions bs ON bs.winner_id = u.id AND bs.ended_at > ${since}
        LEFT JOIN transactions t
          ON t.user_id=u.id AND t.type='bingo_win'
          AND t.status='completed' AND t.created_at > ${since}
        GROUP BY u.id,u.username,u.badge,u.avatar_url
        ORDER BY games_won DESC, total_etb_won DESC
        LIMIT $1`, [lim]));

    } else if (type === 'marketplace') {
      ({ rows } = await db.query(`
        SELECT u.id, u.username, u.badge, u.avatar_url,
               COUNT(o.id)                    AS orders_done,
               COALESCE(SUM(o.total_etb),0)   AS total_spent
        FROM users u
        JOIN orders o ON o.buyer_id=u.id AND o.status='completed'
          AND o.completed_at > ${since}
        GROUP BY u.id,u.username,u.badge,u.avatar_url
        ORDER BY total_spent DESC
        LIMIT $1`, [lim]));

    } else {
      // Default: coins earned in period
      ({ rows } = await db.query(`
        SELECT u.id, u.username, u.badge, u.avatar_url,
               cb.total_coins, cb.streak_days,
               COALESCE(SUM(cl.coins) FILTER(WHERE cl.created_at > ${since} AND cl.coins>0),0)
                 AS coins_period
        FROM users u
        JOIN coin_balances cb ON cb.user_id=u.id
        LEFT JOIN coin_ledger cl ON cl.user_id=u.id
        GROUP BY u.id,u.username,u.badge,u.avatar_url,cb.total_coins,cb.streak_days
        ORDER BY coins_period DESC, cb.total_coins DESC
        LIMIT $1`, [lim]));
    }

    res.json({
      leaderboard: rows.map((r,i) => ({ ...r, rank: i+1 })),
      period, type,
      generatedAt: new Date().toISOString(),
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/engagement/leaderboard/my-rank
router.get('/leaderboard/my-rank', auth, async (req, res) => {
  try {
    const { rows:[r] } = await db.query(
      `SELECT COUNT(*)+1 AS rank
       FROM coin_balances
       WHERE total_coins > (
         SELECT COALESCE(total_coins,0) FROM coin_balances WHERE user_id=$1
       )`,
      [req.user.id]
    );
    const { rows:[s] } = await db.query(
      `SELECT cb.total_coins, cb.streak_days,
              u.username, u.badge,
              (SELECT COUNT(*) FROM bingo_sessions WHERE winner_id=$1) AS bingo_wins
       FROM coin_balances cb JOIN users u ON u.id=cb.user_id
       WHERE cb.user_id=$1`,
      [req.user.id]
    );
    res.json({ rank: parseInt(r?.rank||1), ...s });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
//  E2. STREAK ENGINE
// ================================================================

// POST /api/engagement/daily-login  — call on every user login
router.post('/daily-login', auth, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const uid = req.user.id;

    const { rows:[bal] } = await client.query(
      `SELECT streak_days, last_login, total_coins
       FROM coin_balances WHERE user_id=$1 FOR UPDATE`,
      [uid]
    );

    const today = new Date().toISOString().slice(0,10);
    const yest  = new Date(Date.now()-86400000).toISOString().slice(0,10);
    const last  = bal?.last_login?.toISOString?.()?.slice(0,10);

    if (last === today) {
      await client.query('ROLLBACK');
      return res.json({ alreadyClaimed:true, streak: bal?.streak_days||1 });
    }

    const continued  = last === yest;
    const newStreak  = continued ? (bal?.streak_days||0)+1 : 1;
    const tier       = Math.floor(newStreak/7);
    const base       = 10 + tier*5;
    const milestone  = newStreak%7===0 ? 50 : 0;
    const total      = base + milestone;

    // Earn badge at milestones
    let badge = null;
    if      (newStreak>=365) badge='legend';
    else if (newStreak>=90)  badge='champion';
    else if (newStreak>=30)  badge='dedicated';
    else if (newStreak>=7)   badge='active';

    if (bal) {
      await client.query(
        `UPDATE coin_balances
         SET streak_days=$1, last_login=$2,
             total_coins=total_coins+$3, updated_at=NOW()
         WHERE user_id=$4`,
        [newStreak, today, total, uid]
      );
    } else {
      await client.query(
        `INSERT INTO coin_balances(user_id,streak_days,last_login,total_coins)
         VALUES($1,$2,$3,$4)`,
        [uid, newStreak, today, total]
      );
    }

    await client.query(
      `INSERT INTO coin_ledger(user_id,action,coins,streak_day,metadata)
       VALUES($1,'daily_login',$2,$3,$4)`,
      [uid, total, newStreak, JSON.stringify({ base, milestone })]
    );

    if (badge) {
      await client.query(`UPDATE users SET badge=$1 WHERE id=$2`, [badge, uid]);
      await client.query(
        `INSERT INTO badges(user_id,badge_type) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [uid, badge]
      );
    }

    await client.query(`UPDATE users SET last_login=NOW() WHERE id=$1`, [uid]);
    await client.query('COMMIT');

    res.json({
      ok:true, streak:newStreak, coinsEarned:total,
      base, milestone, badge,
      weeklyMilestone: newStreak%7===0,
      message: newStreak%7===0
        ? `🔥 ${newStreak} day streak! +${total} coins (milestone bonus!)`
        : `🌅 Day ${newStreak} streak! +${total} coins`,
    });
  } catch(err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// GET /api/engagement/streak
router.get('/streak', auth, async (req, res) => {
  try {
    const { rows:[d] } = await db.query(
      `SELECT cb.streak_days, cb.last_login, cb.total_coins, u.badge, u.username
       FROM coin_balances cb JOIN users u ON u.id=cb.user_id
       WHERE cb.user_id=$1`,
      [req.user.id]
    );
    if (!d) return res.json({ streak:0, totalCoins:0 });
    const today = new Date().toISOString().slice(0,10);
    res.json({
      streak:       d.streak_days||0,
      totalCoins:   parseInt(d.total_coins||0),
      badge:        d.badge,
      username:     d.username,
      claimedToday: d.last_login?.toISOString?.()?.slice(0,10) === today,
      nextMilestone:7 - ((d.streak_days||0)%7),
      nextBonus:    50,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
//  E3. REFERRAL SYSTEM
// ================================================================

// GET /api/engagement/referral
router.get('/referral', auth, async (req, res) => {
  try {
    const { rows:[u] } = await db.query(
      `SELECT referral_code FROM users WHERE id=$1`, [req.user.id]
    );
    const { rows:refs } = await db.query(
      `SELECT username, created_at FROM users WHERE referred_by=$1 ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    );
    const { rows:[earn] } = await db.query(
      `SELECT COALESCE(SUM(coins),0) AS total FROM coin_ledger
       WHERE user_id=$1 AND action LIKE 'referral%'`,
      [req.user.id]
    );
    res.json({
      referralCode:   u?.referral_code,
      referralUrl:    `${process.env.FRONTEND_URL}?ref=${u?.referral_code}`,
      totalReferrals: refs.length,
      coinsEarned:    parseInt(earn?.total||0),
      referrals:      refs,
      rewards: { perSignup:100, perDeposit:200 },
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/engagement/referral/apply
router.post('/referral/apply', auth, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { code } = req.body;
    if (!code?.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error:'code_required' });
    }

    const { rows:[referrer] } = await client.query(
      `SELECT id FROM users WHERE referral_code=$1 AND id<>$2`,
      [code.trim(), req.user.id]
    );
    if (!referrer) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error:'invalid_code' });
    }

    const { rows:[me] } = await client.query(
      `SELECT referred_by FROM users WHERE id=$1`, [req.user.id]
    );
    if (me?.referred_by) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error:'already_referred' });
    }

    await client.query(`UPDATE users SET referred_by=$1 WHERE id=$2`, [referrer.id, req.user.id]);

    // +100 coins for referrer
    await client.query(
      `UPDATE coin_balances SET total_coins=total_coins+100 WHERE user_id=$1`, [referrer.id]
    );
    await client.query(
      `INSERT INTO coin_ledger(user_id,action,coins,metadata)
       VALUES($1,'referral_signup',100,$2)`,
      [referrer.id, JSON.stringify({ newUser: req.user.id })]
    );

    // +50 coins for new user
    await client.query(
      `INSERT INTO coin_balances(user_id,total_coins) VALUES($1,50)
       ON CONFLICT(user_id) DO UPDATE SET total_coins=coin_balances.total_coins+50`,
      [req.user.id]
    );
    await client.query(
      `INSERT INTO coin_ledger(user_id,action,coins,metadata)
       VALUES($1,'referral_joined',50,$2)`,
      [req.user.id, JSON.stringify({ referredBy: referrer.id })]
    );

    await client.query('COMMIT');
    res.json({ ok:true, coinsEarned:50, message:'Referral applied! +50 for you, +100 for your friend!' });
  } catch(err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ================================================================
//  E4. BADGES
// ================================================================
const ALL_BADGES = [
  { key:'newcomer',    label:'Newcomer',     am:'አዲስ ቤተኛ',    icon:'🌱', desc:'Joined OmniHub' },
  { key:'active',      label:'Active',       am:'ንቁ',           icon:'⚡', desc:'7-day streak' },
  { key:'dedicated',   label:'Dedicated',    am:'ቆራጥ',        icon:'🔥', desc:'30-day streak' },
  { key:'champion',    label:'Champion',     am:'ሻምፒዮን',      icon:'🏆', desc:'90-day streak' },
  { key:'legend',      label:'Legend',       am:'ታሪካዊ',       icon:'👑', desc:'365-day streak' },
  { key:'bingo_ace',   label:'Bingo Ace',    am:'ቢንጎ ጀምበር',  icon:'🎯', desc:'Win 10 Bingo games' },
  { key:'top_earner',  label:'Top Earner',   am:'ከፍተኛ ገቢ',   icon:'💰', desc:'Earn 10,000 coins' },
  { key:'contributor', label:'Contributor',  am:'አስተዋጽዖ',    icon:'🛠️', desc:'Complete 5 tasks' },
  { key:'verified',    label:'Verified',     am:'ተረጋግጧል',     icon:'✅', desc:'KYC approved' },
  { key:'social_star', label:'Social Star',  am:'ማህበራዊ ኮከብ', icon:'💬', desc:'Post 20 times' },
];

router.get('/badges', auth, async (req, res) => {
  try {
    const { rows:earned } = await db.query(
      `SELECT badge_type, awarded_at FROM badges WHERE user_id=$1 ORDER BY awarded_at DESC`,
      [req.user.id]
    );
    const earnedKeys = new Set(earned.map(e => e.badge_type));
    res.json({
      earned,
      all: ALL_BADGES.map(b => ({ ...b, unlocked: earnedKeys.has(b.key) })),
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
//  E5. ADMIN STATS
// ================================================================
router.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const { rows:[s] } = await db.query(`
      SELECT
        COUNT(*) FILTER(WHERE u.created_at > NOW()-INTERVAL '24h')   AS new_today,
        COUNT(*) FILTER(WHERE u.last_login  > NOW()-INTERVAL '24h')  AS dau,
        COUNT(*) FILTER(WHERE u.last_login  > NOW()-INTERVAL '7d')   AS wau,
        COUNT(*) FILTER(WHERE u.last_login  > NOW()-INTERVAL '30d')  AS mau,
        ROUND(AVG(cb.streak_days),1)                                  AS avg_streak,
        MAX(cb.streak_days)                                           AS max_streak,
        SUM(cb.total_coins)                                           AS total_coins_issued
      FROM users u
      LEFT JOIN coin_balances cb ON cb.user_id=u.id
    `);
    res.json(s);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
