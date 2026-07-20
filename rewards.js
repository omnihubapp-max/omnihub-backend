// ================================================================
//  OmniHub — rewards.js
//  Holiday Reward Engine & Coin Service
//  Runtime: Node.js 20+ (CommonJS — matches the rest of the backend)
//  Dependencies: pg, node-cron
//
//  NOTE: the original draft of this file was written in ESM
//  (import/export) and required a live Redis instance. Neither
//  render.yaml nor package.json provision Redis, so this version
//  keeps the exact same business logic but:
//    1) uses CommonJS (require/module.exports) so `require('./rewards')`
//       in server.js works,
//    2) uses a small in-memory TTL cache instead of Redis by default.
//  If you later add a real Redis instance, set REDIS_URL and swap
//  the `cache` object below for a real client — every call site
//  already uses the same get/setEx interface.
// ================================================================

const { Pool } = require('pg');
const cron     = require('node-cron');

// ── Database connection ───────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
});

// ── Cache (in-memory TTL map; same interface as a Redis client) ───
const _store = new Map(); // key -> { value, expiresAt }

const cache = {
  async get(key) {
    const entry = _store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      _store.delete(key);
      return null;
    }
    return entry.value;
  },
  async set(key, value) {
    _store.set(key, { value, expiresAt: null });
  },
  async setEx(key, ttlSeconds, value) {
    _store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  },
};

// Periodically sweep expired keys so the Map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _store.entries()) {
    if (entry.expiresAt && entry.expiresAt < now) _store.delete(key);
  }
}, 5 * 60 * 1000).unref?.();

// ================================================================
//  C O I N   S E R V I C E
//  Handles all OmniCoin earning and spending.
// ================================================================
const CoinService = {

  // ──────────────────────────────────────────────────────────────
  // awardCoins()
  //   Awards coins to a user for a specific rule action.
  //   Handles: daily limits · holiday multiplier · streak bonus
  //   All DB operations wrapped in a transaction for atomicity.
  // ──────────────────────────────────────────────────────────────
  async awardCoins(userId, ruleKey, metadata = {}) {
    // ── 1. Load rule from cache (refreshes every 10 min) ────────
    let rule = await this._getCachedRule(ruleKey);
    if (!rule) return { awarded: false, reason: `unknown_rule: ${ruleKey}` };
    if (!rule.is_active) return { awarded: false, reason: 'rule_inactive' };

    // ── 2. Daily limit check via cache (O(1), no DB hit) ────────
    const dateKey  = new Date().toISOString().slice(0, 10); // "2025-03-02"
    const limitKey = `coin_limit:${userId}:${ruleKey}:${dateKey}`;
    const usedToday = parseInt((await cache.get(limitKey)) ?? '0');

    if (usedToday >= rule.max_per_day) {
      return {
        awarded: false,
        reason:  'daily_limit_reached',
        resetAt: 'midnight EAT',
      };
    }

    // ── 3. Get today's holiday/Sunday multiplier ─────────────────
    const { multiplier, holidayName } = await HolidayService.getTodayMultiplier();

    // ── 4. Calculate total coins ─────────────────────────────────
    //   base coins + streak bonus (every 7 days) × holiday multiplier
    const { rows: [user] } = await pool.query(
      'SELECT login_streak FROM users WHERE id = $1', [userId]
    );
    const streakTier  = Math.floor((user?.login_streak ?? 0) / 7);
    const earnedCoins = Math.ceil(
      (rule.base_coins + streakTier * rule.streak_bonus) * multiplier
    );

    // ── 5. Atomic DB transaction ─────────────────────────────────
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update wallet coin balance
      const { rows: [wallet] } = await client.query(
        `UPDATE wallets
            SET coin_balance = coin_balance + $1
          WHERE user_id = $2
          RETURNING coin_balance`,
        [earnedCoins, userId]
      );

      if (!wallet) {
        await client.query('ROLLBACK');
        return { awarded: false, reason: 'wallet_not_found' };
      }

      // Write immutable coin transaction log
      await client.query(
        `INSERT INTO coin_transactions
           (user_id, rule_key, coins, balance_after, description, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          userId,
          ruleKey,
          earnedCoins,
          wallet.coin_balance,
          rule.label_en + (holidayName ? ` (${holidayName} ×${multiplier})` : ''),
          JSON.stringify({ ...metadata, multiplier, holidayName }),
        ]
      );

      await client.query('COMMIT');

      // ── 6. Increment daily counter (TTL = 25 hours) ────────────
      //   25hr (not 24) prevents edge cases around midnight EAT
      await cache.setEx(limitKey, 90000, String(usedToday + 1));

      return {
        awarded:     true,
        coins:       earnedCoins,
        newBalance:  wallet.coin_balance,
        multiplier,
        holidayName: holidayName ?? null,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // ──────────────────────────────────────────────────────────────
  // processDailyLogin()
  //   Called on every successful user login.
  //   Updates streak, then awards daily_login coins.
  //   Idempotent: calling it twice the same day is safe.
  // ──────────────────────────────────────────────────────────────
  async processDailyLogin(userId) {
    const dateKey  = new Date().toISOString().slice(0, 10);
    const loginKey = `login_processed:${userId}:${dateKey}`;

    // Already processed today?
    if (await cache.get(loginKey)) {
      return { alreadyProcessed: true };
    }

    // Update streak in DB
    //   If last login was within the past 48 hours → increment streak
    //   Otherwise reset to 1 (missed a day)
    const { rows: [user] } = await pool.query(
      `UPDATE users
          SET login_streak  = CASE
                WHEN last_login_at > NOW() - INTERVAL '48 hours'
                THEN login_streak + 1
                ELSE 1
              END,
              last_login_at = NOW()
        WHERE id = $1
        RETURNING login_streak`,
      [userId]
    );

    // Award coins for today's login
    const result = await this.awardCoins(userId, 'daily_login', {
      streak: user.login_streak,
    });

    // Mark as processed for today (TTL 25 hr)
    await cache.setEx(loginKey, 90000, '1');

    return { ...result, streak: user.login_streak };
  },

  // ──────────────────────────────────────────────────────────────
  // spendCoins() — deduct coins from a user's balance
  // ──────────────────────────────────────────────────────────────
  async spendCoins(userId, amount, reason) {
    if (amount <= 0) throw new Error('amount must be positive');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [wallet] } = await client.query(
        `UPDATE wallets
            SET coin_balance = coin_balance - $1
          WHERE user_id = $2
            AND coin_balance >= $1
          RETURNING coin_balance`,
        [amount, userId]
      );

      if (!wallet) {
        await client.query('ROLLBACK');
        throw new Error('insufficient_coin_balance');
      }

      await client.query(
        `INSERT INTO coin_transactions
           (user_id, coins, balance_after, description)
         VALUES ($1, $2, $3, $4)`,
        [userId, -amount, wallet.coin_balance, reason]
      );

      await client.query('COMMIT');
      return { success: true, newBalance: wallet.coin_balance };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // ── Internal: cache coin rules for 10 minutes ─────────────────
  async _getCachedRule(ruleKey) {
    const key    = `coin_rule:${ruleKey}`;
    const cached = await cache.get(key);
    if (cached) return JSON.parse(cached);

    const { rows: [rule] } = await pool.query(
      'SELECT * FROM coin_rules WHERE rule_key = $1', [ruleKey]
    );
    if (rule) await cache.setEx(key, 600, JSON.stringify(rule));
    return rule ?? null;
  },
};

// ================================================================
//  H O L I D A Y   S E R V I C E
//  Determines today's coin multiplier and runs midnight sweeps.
// ================================================================
const HolidayService = {

  // ──────────────────────────────────────────────────────────────
  // getTodayMultiplier()
  //   Returns { multiplier, bonusCoins, holidayName } for today.
  //   Checks in order: 1) Ethiopian/African holiday  2) Sunday
  //   Result is cached for 1 hour (refreshes at next hour mark).
  // ──────────────────────────────────────────────────────────────
  async getTodayMultiplier() {
    const dateKey  = new Date().toISOString().slice(0, 10);
    const cacheKey = `holiday_multiplier:${dateKey}`;
    const cached   = await cache.get(cacheKey);

    if (cached) return JSON.parse(cached);

    // Check for a scheduled holiday today
    const { rows: [holiday] } = await pool.query(
      `SELECT coin_multiplier, bonus_coins, name_en, name_am
         FROM holiday_schedule
        WHERE holiday_date = CURRENT_DATE
          AND is_active = TRUE
        LIMIT 1`
    );

    let result;

    if (holiday) {
      // It's a public holiday 🎉
      result = {
        multiplier:  parseFloat(holiday.coin_multiplier),
        bonusCoins:  holiday.bonus_coins,
        holidayName: holiday.name_en,
        holidayAmharic: holiday.name_am,
        type:        'holiday',
      };
    } else if (new Date().getDay() === 0) {
      // It's Sunday — always a bonus day
      result = {
        multiplier:  1.5,
        bonusCoins:  50,
        holidayName: 'Sunday Bonus',
        holidayAmharic: 'የእሑድ ቦነስ',
        type:        'sunday',
      };
    } else {
      // Normal weekday — no multiplier
      result = {
        multiplier:  1.0,
        bonusCoins:  0,
        holidayName: null,
        holidayAmharic: null,
        type:        'normal',
      };
    }

    // Cache for 1 hour
    await cache.setEx(cacheKey, 3600, JSON.stringify(result));
    return result;
  },

  // ──────────────────────────────────────────────────────────────
  // runMidnightSweep()
  //   Runs at 00:00 EAT.
  //   If today is a holiday or Sunday, awards bonus_coins to
  //   every active user in the system (batched for safety).
  // ──────────────────────────────────────────────────────────────
  async runMidnightSweep() {
    const today = await this.getTodayMultiplier();

    if (today.type === 'normal') {
      console.log('[HolidayEngine] No holiday today — sweep skipped.');
      return { processed: 0, skipped: true };
    }

    const ruleKey = today.type === 'holiday' ? 'holiday_bonus' : 'sunday_bonus';

    console.log(
      `[HolidayEngine] Running sweep for: ${today.holidayName}`,
      `| Multiplier: ${today.multiplier}× | Bonus: ${today.bonusCoins} coins`
    );

    // Load all active user IDs
    const { rows: users } = await pool.query(
      `SELECT id FROM users WHERE is_active = TRUE`
    );

    let processed = 0;
    let failed    = 0;

    // Process in batches of 50 to avoid DB overload
    const BATCH_SIZE = 50;

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);

      // Run batch concurrently
      const results = await Promise.allSettled(
        batch.map(u =>
          CoinService.awardCoins(u.id, ruleKey, {
            holiday:    today.holidayName,
            holidayAm:  today.holidayAmharic,
            multiplier: today.multiplier,
          })
        )
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.awarded) processed++;
        else failed++;
      }

      // Small pause between batches (100ms) to stay DB-friendly
      if (i + BATCH_SIZE < users.length) {
        await new Promise(res => setTimeout(res, 100));
      }
    }

    console.log(
      `[HolidayEngine] Sweep complete.`,
      `Awarded: ${processed} | Failed: ${failed}`
    );

    return {
      processed,
      failed,
      holiday:    today.holidayName,
      ruleKey,
      multiplier: today.multiplier,
    };
  },

  // ──────────────────────────────────────────────────────────────
  // getUpcomingHolidays()
  //   Returns list of holidays in the next 30 days.
  //   Used by the AI Executive Summary and frontend banners.
  // ──────────────────────────────────────────────────────────────
  async getUpcomingHolidays() {
    const { rows } = await pool.query(
      `SELECT * FROM v_upcoming_holidays LIMIT 10`
    );
    return rows;
  },
};

// ================================================================
//  A I   E X E C U T I V E   S U M M A R Y
//  Runs daily at 06:00 EAT and stores in the DB.
//  The owner (admin) can read this via GET /api/admin/summary/today
// ================================================================
async function generateExecutiveSummary() {
  const { rows: [stats] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE is_active = TRUE)
        AS total_active_users,

      (SELECT COUNT(*) FROM users WHERE DATE(created_at AT TIME ZONE 'EAT') = CURRENT_DATE)
        AS new_users_today,

      (SELECT COUNT(DISTINCT user_id)
         FROM user_sessions
        WHERE created_at > NOW() - INTERVAL '24 hours')
        AS dau,

      (SELECT COALESCE(SUM(amount), 0)
         FROM ledger_entries
        WHERE currency = 'ETB'
          AND entry_type = 'credit'
          AND created_at > NOW() - INTERVAL '24 hours')
        AS revenue_etb_today,

      (SELECT COALESCE(SUM(amount), 0)
         FROM ledger_entries
        WHERE currency = 'USD'
          AND entry_type = 'credit'
          AND created_at > NOW() - INTERVAL '24 hours')
        AS revenue_usd_today,

      (SELECT COALESCE(SUM(coins), 0)
         FROM coin_transactions
        WHERE coins > 0
          AND created_at > NOW() - INTERVAL '24 hours')
        AS coins_awarded_today,

      (SELECT COUNT(*)
         FROM loans
        WHERE DATE(disbursed_at AT TIME ZONE 'EAT') = CURRENT_DATE)
        AS loans_issued_today,

      (SELECT COALESCE(SUM(amount), 0)
         FROM loans
        WHERE DATE(disbursed_at AT TIME ZONE 'EAT') = CURRENT_DATE
          AND status IN ('active', 'repaid'))
        AS loan_volume_etb_today
  `);

  // Upsert into executive_summaries (create table if needed)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS executive_summaries (
      summary_date        DATE PRIMARY KEY,
      total_active_users  INTEGER,
      new_users_today     INTEGER,
      dau                 INTEGER,
      revenue_etb_today   DECIMAL(18,2),
      revenue_usd_today   DECIMAL(18,8),
      coins_awarded_today BIGINT,
      loans_issued_today  INTEGER,
      loan_volume_etb     DECIMAL(18,2),
      generated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    INSERT INTO executive_summaries
      (summary_date, total_active_users, new_users_today, dau,
       revenue_etb_today, revenue_usd_today, coins_awarded_today,
       loans_issued_today, loan_volume_etb)
    VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (summary_date) DO UPDATE SET
      total_active_users  = EXCLUDED.total_active_users,
      dau                 = EXCLUDED.dau,
      revenue_etb_today   = EXCLUDED.revenue_etb_today,
      revenue_usd_today   = EXCLUDED.revenue_usd_today,
      coins_awarded_today = EXCLUDED.coins_awarded_today,
      loans_issued_today  = EXCLUDED.loans_issued_today,
      loan_volume_etb     = EXCLUDED.loan_volume_etb,
      generated_at        = NOW()
  `, [
    stats.total_active_users, stats.new_users_today, stats.dau,
    stats.revenue_etb_today,  stats.revenue_usd_today,
    stats.coins_awarded_today, stats.loans_issued_today,
    stats.loan_volume_etb_today,
  ]);

  console.log('[ExecutiveSummary] Generated for', new Date().toDateString());
  console.log('[ExecutiveSummary]', stats);
  return stats;
}

// ================================================================
//  S C H E D U L E D   C R O N   J O B S
//  All times are Africa/Addis_Ababa (EAT = UTC+3)
// ================================================================
function startCronJobs() {

  // ── 00:00 EAT — Holiday / Sunday reward sweep ─────────────────
  cron.schedule('0 0 * * *', async () => {
    console.log('[CRON 00:00] Holiday midnight sweep starting...');
    try {
      const result = await HolidayService.runMidnightSweep();
      console.log('[CRON 00:00] Sweep result:', result);
    } catch (err) {
      console.error('[CRON 00:00] Sweep failed:', err.message);
    }
  }, { timezone: 'Africa/Addis_Ababa' });

  // ── 06:00 EAT — AI Executive Summary generation ───────────────
  cron.schedule('0 6 * * *', async () => {
    console.log('[CRON 06:00] Generating Executive Summary...');
    try {
      await generateExecutiveSummary();
    } catch (err) {
      console.error('[CRON 06:00] Summary failed:', err.message);
    }
  }, { timezone: 'Africa/Addis_Ababa' });

  // ── Every 10 minutes — Mark overdue loans ─────────────────────
  cron.schedule('*/10 * * * *', async () => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE loans
            SET status = 'overdue'
          WHERE status = 'active'
            AND due_at < NOW()`
      );
      if (rowCount > 0) {
        console.log(`[CRON] Marked ${rowCount} loan(s) as overdue.`);
      }
    } catch (err) {
      console.error('[CRON] Overdue loan check failed:', err.message);
    }
  });

  console.log('[CRON] All scheduled jobs registered (timezone: Africa/Addis_Ababa)');
}

// ================================================================
//  EXPORTS
//  server.js does: const { awardCoins, processDailyLogin } = require('./rewards')
//  so those two are exported flat (bound to CoinService), plus the
//  full services in case other modules need them.
// ================================================================
module.exports = {
  CoinService,
  HolidayService,
  startCronJobs,
  generateExecutiveSummary,
  awardCoins:        CoinService.awardCoins.bind(CoinService),
  processDailyLogin: CoinService.processDailyLogin.bind(CoinService),
  spendCoins:        CoinService.spendCoins.bind(CoinService),
};
