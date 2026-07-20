-- ================================================================
--  OmniHub — schema_additions.sql
--  Add to schema.sql AFTER the main tables
--  Run: psql $DATABASE_URL -f db/schema_additions.sql
--
--  Covers: B (push_tokens, notifications)
--          E (streaks already in coin_balances, badges)
--          G (ussd_sessions)
-- ================================================================

-- ── B: PUSH NOTIFICATIONS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_tokens (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT        NOT NULL,
  platform   VARCHAR(20) DEFAULT 'web',
  active     BOOLEAN     DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, token)
);
CREATE INDEX IF NOT EXISTS idx_push_user   ON push_tokens(user_id) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_push_token  ON push_tokens(token)   WHERE active = true;

CREATE TABLE IF NOT EXISTS notifications (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      VARCHAR(200) NOT NULL,
  body       TEXT,
  data       JSONB,
  type       VARCHAR(50)  DEFAULT 'general',
  read       BOOLEAN      DEFAULT false,
  created_at TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_user   ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(user_id) WHERE read = false;

-- ── E: ENGAGEMENT — leaderboard view ────────────────────────────
CREATE OR REPLACE VIEW v_leaderboard_coins AS
SELECT
  u.id,
  u.username,
  u.badge,
  u.avatar_url,
  COALESCE(cb.total_coins, 0)  AS total_coins,
  COALESCE(cb.streak_days, 0)  AS streak_days,
  cb.last_login,
  RANK() OVER (ORDER BY COALESCE(cb.total_coins,0) DESC) AS rank
FROM users u
LEFT JOIN coin_balances cb ON cb.user_id = u.id
WHERE u.created_at > NOW() - INTERVAL '90 days';

CREATE OR REPLACE VIEW v_leaderboard_bingo AS
SELECT
  u.id,
  u.username,
  u.badge,
  u.avatar_url,
  COUNT(bs.id)                          AS games_won,
  COALESCE(SUM(t.amount), 0)            AS total_etb_won,
  RANK() OVER (ORDER BY COUNT(bs.id) DESC) AS rank
FROM users u
LEFT JOIN bingo_sessions bs ON bs.winner_id = u.id
  AND bs.ended_at > NOW() - INTERVAL '30 days'
LEFT JOIN transactions t ON t.user_id = u.id
  AND t.type = 'bingo_win'
  AND t.status = 'completed'
  AND t.created_at > NOW() - INTERVAL '30 days'
GROUP BY u.id, u.username, u.badge, u.avatar_url;

-- Add telegram_id + last_login to users if not exists
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id  VARCHAR(50)  UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login   TIMESTAMPTZ  DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status   VARCHAR(20)  DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id) WHERE telegram_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_last_login ON users(last_login DESC);

-- ── G: USSD SESSIONS (optional — we use in-memory in ussd.js) ───
CREATE TABLE IF NOT EXISTS ussd_sessions (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id   VARCHAR(100) NOT NULL UNIQUE,
  phone        VARCHAR(20)  NOT NULL,
  step         VARCHAR(50)  DEFAULT 'main',
  lang         VARCHAR(5)   DEFAULT 'am',
  data         JSONB,
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ussd_session ON ussd_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_ussd_phone   ON ussd_sessions(phone);

-- Auto-cleanup USSD sessions older than 10 min
CREATE OR REPLACE FUNCTION cleanup_ussd_sessions()
RETURNS void LANGUAGE sql AS $$
  DELETE FROM ussd_sessions WHERE updated_at < NOW() - INTERVAL '10 minutes';
$$;

-- ── KYC table (if not in main schema) ───────────────────────────
CREATE TABLE IF NOT EXISTS kyc_submissions (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id_type          VARCHAR(30) NOT NULL,
  id_number        VARCHAR(50),
  full_name        VARCHAR(150) NOT NULL,
  date_of_birth    DATE,
  nationality      VARCHAR(50)  DEFAULT 'Ethiopian',
  id_front_file    VARCHAR(200) NOT NULL,
  selfie_file      VARCHAR(200) NOT NULL,
  id_back_file     VARCHAR(200),
  status           VARCHAR(20)  NOT NULL DEFAULT 'pending',
  reviewed_by      VARCHAR(100),
  reviewed_at      TIMESTAMPTZ,
  rejection_reason TEXT,
  submitted_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ip_address       INET
);
CREATE INDEX IF NOT EXISTS idx_kyc_user   ON kyc_submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_submissions(status);

-- ── VERIFY ALL TABLES EXIST ──────────────────────────────────────
DO $$
DECLARE
  required_tables TEXT[] := ARRAY[
    'users','wallets','transactions','coin_ledger','coin_balances',
    'trust_scores','loans','bingo_sessions','bingo_cards',
    'badges','holiday_schedule','contributor_tasks',
    'push_tokens','notifications','kyc_submissions'
  ];
  t TEXT;
  missing TEXT[] := '{}';
BEGIN
  FOREACH t IN ARRAY required_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name=t
    ) THEN
      missing := missing || t;
    END IF;
  END LOOP;

  IF array_length(missing, 1) > 0 THEN
    RAISE WARNING 'Missing tables: %', array_to_string(missing, ', ');
  ELSE
    RAISE NOTICE '✅ All required tables exist';
  END IF;
END $$;
