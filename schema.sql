-- ================================================================
--  OmniHub Super-App — Full PostgreSQL Schema v1.0
--  Tables: Users · Wallet · Ledger · OmniCoins · Loans · Holidays
--  Author: OmniHub Lead Architect
--  Timezone: Africa/Addis_Ababa (EAT, UTC+3)
-- ================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";   -- UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";    -- Secure hashing

-- ----------------------------------------------------------------
-- 1.  U S E R S
-- ----------------------------------------------------------------
CREATE TABLE users (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  username        VARCHAR(50) UNIQUE NOT NULL,
  email           VARCHAR(255) UNIQUE NOT NULL,
  phone           VARCHAR(20)  UNIQUE,
  password_hash   TEXT         NOT NULL,
  full_name       VARCHAR(150),
  avatar_url      TEXT,

  -- Localisation
  language        VARCHAR(10)  NOT NULL DEFAULT 'am',
  -- Supported: am (Amharic) | ti (Tigrinya) | om (Afaan Oromoo)
  --            en (English) | fr (Français) | sw (Kiswahili)

  -- Referral viral loop
  referral_code   VARCHAR(12)  UNIQUE
                  DEFAULT SUBSTR(MD5(RANDOM()::TEXT), 1, 12),
  referred_by     UUID         REFERENCES users(id) ON DELETE SET NULL,

  -- Identity verification
  kyc_status      VARCHAR(20)  NOT NULL DEFAULT 'pending',
  -- Values: pending | submitted | verified | rejected

  -- Engagement
  login_streak    INTEGER      NOT NULL DEFAULT 0,
  last_login_at   TIMESTAMPTZ,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Indexes for common lookups
CREATE INDEX idx_users_email        ON users(email);
CREATE INDEX idx_users_phone        ON users(phone);
CREATE INDEX idx_users_referral     ON users(referral_code);
CREATE INDEX idx_users_referred_by  ON users(referred_by);

-- ----------------------------------------------------------------
-- 2.  W A L L E T   (Dual-Currency: ETB + USD)
-- ----------------------------------------------------------------
CREATE TABLE wallets (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID          UNIQUE NOT NULL
                  REFERENCES users(id) ON DELETE CASCADE,

  -- Fiat balances (18 digits, 2 decimal places for ETB/USD)
  balance_etb     DECIMAL(18,2) NOT NULL DEFAULT 0.00
                  CONSTRAINT wallet_etb_positive CHECK (balance_etb >= 0),
  balance_usd     DECIMAL(18,8) NOT NULL DEFAULT 0.00000000
                  CONSTRAINT wallet_usd_positive CHECK (balance_usd >= 0),

  -- OmniCoin balance (integer — no fractional coins)
  coin_balance    BIGINT        NOT NULL DEFAULT 0
                  CONSTRAINT wallet_coins_positive CHECK (coin_balance >= 0),

  -- Safety flags
  is_frozen       BOOLEAN       NOT NULL DEFAULT FALSE,
  freeze_reason   TEXT,

  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wallets_user ON wallets(user_id);

-- ----------------------------------------------------------------
-- 3.  L E D G E R   (Immutable double-entry bookkeeping)
-- ----------------------------------------------------------------
-- Every financial movement creates TWO entries: one debit, one credit.
-- This table NEVER has rows deleted or updated — append-only.
CREATE TABLE ledger_entries (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id  UUID         NOT NULL DEFAULT uuid_generate_v4(),
  -- ^ Groups the debit+credit pair for one transaction

  wallet_id       UUID         NOT NULL REFERENCES wallets(id),
  entry_type      VARCHAR(10)  NOT NULL,
  -- Values: debit | credit

  amount          DECIMAL(18,8) NOT NULL
                  CONSTRAINT ledger_amount_positive CHECK (amount > 0),
  currency        VARCHAR(6)   NOT NULL,
  -- Values: ETB | USD | COIN

  balance_after   DECIMAL(18,8) NOT NULL,
  -- Snapshot of balance immediately after this entry

  -- Context for reporting / audit trail
  description     TEXT,
  reference_id    UUID,         -- e.g. bingo_room.id, loan.id
  reference_type  VARCHAR(50),
  -- Values: deposit | withdrawal | bingo_buy | bingo_win |
  --         loan_disbursement | loan_repayment | coin_reward |
  --         referral_bonus | marketplace_purchase

  metadata        JSONB,        -- extra structured info if needed
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ledger_wallet     ON ledger_entries(wallet_id);
CREATE INDEX idx_ledger_txn        ON ledger_entries(transaction_id);
CREATE INDEX idx_ledger_ref_type   ON ledger_entries(reference_type);
CREATE INDEX idx_ledger_created    ON ledger_entries(created_at);

-- ----------------------------------------------------------------
-- 4.  O M N I - C O I N   R E W A R D   S Y S T E M
-- ----------------------------------------------------------------

-- 4a. Rule definitions (what earns how many coins)
CREATE TABLE coin_rules (
  rule_key        VARCHAR(50)  PRIMARY KEY,
  -- e.g. 'daily_login' | 'referral_signup' | 'share_app'

  label_am        TEXT         NOT NULL,   -- Amharic label
  label_en        TEXT         NOT NULL,   -- English label

  base_coins      INTEGER      NOT NULL DEFAULT 0
                  CONSTRAINT rule_base_positive CHECK (base_coins >= 0),

  -- Bonus coins added per 7-day streak milestone
  streak_bonus    INTEGER      NOT NULL DEFAULT 0,

  -- How many times per day a user can earn this rule
  max_per_day     INTEGER      NOT NULL DEFAULT 1,

  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed: all earning rules
INSERT INTO coin_rules
  (rule_key,          label_am,              label_en,              base_coins, streak_bonus, max_per_day)
VALUES
  ('daily_login',     'ዕለታዊ ግቤት',           'Daily Login',         10,         5,            1),
  ('referral_signup', 'ጓደኛ ምዝገባ',            'Referral Signup',     500,        0,            20),
  ('share_app',       'አፕ አጋርኩ',             'Share App',           20,         0,            3),
  ('bingo_win',       'ቢንጎ ድል',              'Bingo Win',           100,        0,            20),
  ('kyc_complete',    'ማንነት ማረጋገጫ',          'KYC Complete',        200,        0,            1),
  ('task_complete',   'ተግባር ማጠናቀቅ',          'Task Complete',       50,         0,            5),
  ('holiday_bonus',   'የበዓል ቦነስ',            'Holiday Bonus',       150,        0,            1),
  ('sunday_bonus',    'የእሑድ ቦነስ',             'Sunday Bonus',        50,         0,            1),
  ('loan_repaid',     'ብድር ተከፈለ',            'Loan Repaid On-Time', 80,         0,            1),
  ('marketplace_buy', 'ገበያ ግዢ',              'Marketplace Purchase', 15,        0,            10);

-- 4b. Individual coin transaction log (immutable)
CREATE TABLE coin_transactions (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_key        VARCHAR(50) REFERENCES coin_rules(rule_key),

  coins           INTEGER     NOT NULL,
  -- Positive = earned, Negative = spent

  balance_after   BIGINT      NOT NULL,
  description     TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_coin_txn_user    ON coin_transactions(user_id);
CREATE INDEX idx_coin_txn_date    ON coin_transactions(created_at);
CREATE INDEX idx_coin_txn_rule    ON coin_transactions(rule_key);

-- ----------------------------------------------------------------
-- 5.  T R U S T   S C O R E   &   S M A R T   L O A N S
-- ----------------------------------------------------------------

-- 5a. Calculated trust score per user
CREATE TABLE trust_scores (
  user_id             UUID          PRIMARY KEY
                      REFERENCES users(id) ON DELETE CASCADE,

  score               DECIMAL(6,2)  NOT NULL DEFAULT 0.00,
  -- Range: 0.00 – 100.00

  -- Score component breakdown (each 0–100 before weighting)
  coin_component      DECIMAL(6,2)  NOT NULL DEFAULT 0.00, -- weight 40%
  activity_component  DECIMAL(6,2)  NOT NULL DEFAULT 0.00, -- weight 30%
  kyc_component       DECIMAL(6,2)  NOT NULL DEFAULT 0.00, -- weight 20%
  history_component   DECIMAL(6,2)  NOT NULL DEFAULT 0.00, -- weight 10%

  -- Derived loan terms
  max_loan_etb        DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  max_loan_usd        DECIMAL(18,8) NOT NULL DEFAULT 0.00,
  interest_rate_pct   DECIMAL(5,2)  NOT NULL DEFAULT 20.00,
  -- Lower score = higher rate. Min 5%, Max 20%.

  last_calculated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 5b. Loan records
CREATE TABLE loans (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID          NOT NULL REFERENCES users(id),

  amount              DECIMAL(18,2) NOT NULL
                      CONSTRAINT loan_amount_positive CHECK (amount > 0),
  currency            VARCHAR(5)    NOT NULL, -- ETB | USD

  interest_rate_pct   DECIMAL(5,2)  NOT NULL,
  term_days           INTEGER       NOT NULL DEFAULT 30,

  status              VARCHAR(20)   NOT NULL DEFAULT 'pending',
  -- Values: pending | active | repaid | overdue | rejected

  trust_score_snap    DECIMAL(6,2),
  -- Trust score at the moment of approval (for audit)

  auto_approved       BOOLEAN       NOT NULL DEFAULT FALSE,
  disbursed_at        TIMESTAMPTZ,
  due_at              TIMESTAMPTZ,

  repaid_amount       DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  repaid_at           TIMESTAMPTZ,

  rejection_reason    TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_loans_user   ON loans(user_id);
CREATE INDEX idx_loans_status ON loans(status);
CREATE INDEX idx_loans_due    ON loans(due_at);

-- ----------------------------------------------------------------
-- 6.  H O L I D A Y   S C H E D U L E
-- ----------------------------------------------------------------
CREATE TABLE holiday_schedule (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  name_am             TEXT          NOT NULL,
  name_en             TEXT          NOT NULL,

  holiday_date        DATE          NOT NULL,
  recurrence          VARCHAR(20)   NOT NULL DEFAULT 'yearly',
  -- Values: yearly | once | weekly

  -- Coin reward modifiers for this day
  coin_multiplier     DECIMAL(4,2)  NOT NULL DEFAULT 2.00,
  -- e.g. 2.0 means all coin earnings are doubled
  bonus_coins         INTEGER       NOT NULL DEFAULT 100,
  -- Flat bonus awarded at midnight to every active user

  special_message_am  TEXT,
  special_message_en  TEXT,

  is_active           BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_holiday_date ON holiday_schedule(holiday_date);

-- Seed: Ethiopian + African holidays
INSERT INTO holiday_schedule
  (name_am,                name_en,                            holiday_date, coin_multiplier, bonus_coins)
VALUES
  ('አዲስ ዓመት / ኤንቁጣጣሽ',   'Ethiopian New Year (Enkutatash)', '2025-09-11', 3.00, 300),
  ('ጥምቀት',                'Timkat (Epiphany)',                '2025-01-19', 2.50, 250),
  ('ፋሲካ',                 'Ethiopian Easter (Fasika)',        '2025-04-20', 2.50, 250),
  ('ልደት / ጎና',            'Ethiopian Christmas (Genna)',      '2025-01-07', 2.50, 200),
  ('አድዋ ድል በዓል',          'Battle of Adwa Victory Day',       '2025-03-02', 3.00, 500),
  ('የኢትዮጵያ ብሔራዊ ቀን',    'Ethiopian National Day',           '2025-05-28', 2.00, 200),
  ('አፍሪካ ቀን (AU)',        'Africa Day (African Union)',       '2025-05-25', 2.00, 200),
  ('ኢድ አል-ፈጥር',          'Eid Al-Fitr',                      '2025-03-30', 2.00, 200),
  ('ኢድ አል-አዶሃ',          'Eid Al-Adha',                      '2025-06-06', 2.00, 200),
  ('ጊዮርጊስ በዓል',          'St. George Feast Day',             '2025-11-23', 2.00, 150);

-- ----------------------------------------------------------------
-- 7.  N O T I F I C A T I O N   P R E F E R E N C E S
--     (Privacy-first — permission-based)
-- ----------------------------------------------------------------
CREATE TABLE notification_prefs (
  user_id           UUID     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bingo_updates     BOOLEAN  NOT NULL DEFAULT TRUE,
  wallet_alerts     BOOLEAN  NOT NULL DEFAULT TRUE,
  loan_updates      BOOLEAN  NOT NULL DEFAULT TRUE,
  holiday_deals     BOOLEAN  NOT NULL DEFAULT TRUE,
  marketing         BOOLEAN  NOT NULL DEFAULT FALSE,
  ai_suggestions    BOOLEAN  NOT NULL DEFAULT TRUE,
  email_enabled     BOOLEAN  NOT NULL DEFAULT TRUE,
  sms_enabled       BOOLEAN  NOT NULL DEFAULT FALSE,
  push_enabled      BOOLEAN  NOT NULL DEFAULT FALSE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 8.  D A T A B A S E   F U N C T I O N S   &   T R I G G E R S
-- ----------------------------------------------------------------

-- 8a. Auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_updated
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_wallets_updated
  BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- 8b. Calculate (or recalculate) Trust Score for a user
--     Formula:
--       Coin Component    = MIN(coins/10000, 1) * 100  → weight 40%
--       Activity Component= MIN(streak/30,  1) * 100  → weight 30%
--       KYC Component     = 100 if verified else 0     → weight 20%
--       History Component = MIN(repaid_loans*20, 100)  → weight 10%
--       Final Score       = sum of weighted components (0–100)
--       Interest Rate     = MAX(5, 20 - score*0.15)  (%)
--       Max Loan ETB      = IF score>=50: coins*0.1 + score*100 ELSE 0
CREATE OR REPLACE FUNCTION fn_calculate_trust_score(p_user_id UUID)
RETURNS DECIMAL LANGUAGE plpgsql AS $$
DECLARE
  v_coins       BIGINT;
  v_streak      INTEGER;
  v_kyc         VARCHAR(20);
  v_repaid      INTEGER;

  v_coin_raw    DECIMAL;
  v_act_raw     DECIMAL;
  v_kyc_raw     DECIMAL;
  v_hist_raw    DECIMAL;
  v_score       DECIMAL;
  v_rate        DECIMAL;
  v_max_etb     DECIMAL;
BEGIN
  -- Gather all inputs in one query
  SELECT
    w.coin_balance,
    u.login_streak,
    u.kyc_status
  INTO v_coins, v_streak, v_kyc
  FROM users u
  JOIN wallets w ON w.user_id = u.id
  WHERE u.id = p_user_id;

  SELECT COUNT(*) INTO v_repaid
  FROM loans
  WHERE user_id = p_user_id AND status = 'repaid';

  -- Raw components (0–100)
  v_coin_raw := LEAST(100, (v_coins::DECIMAL / 10000.0) * 100);
  v_act_raw  := LEAST(100, (v_streak::DECIMAL / 30.0)   * 100);
  v_kyc_raw  := CASE WHEN v_kyc = 'verified' THEN 100.0 ELSE 0.0 END;
  v_hist_raw := LEAST(100, v_repaid * 20.0);

  -- Weighted final score
  v_score := (v_coin_raw * 0.40)
           + (v_act_raw  * 0.30)
           + (v_kyc_raw  * 0.20)
           + (v_hist_raw * 0.10);

  -- Dynamic interest rate: lower score = higher rate
  v_rate := GREATEST(5.0, 20.0 - (v_score * 0.15));

  -- Max eligible loan
  v_max_etb := CASE
    WHEN v_score >= 50
    THEN (v_coins * 0.1) + (v_score * 100)
    ELSE 0
  END;

  -- Upsert result
  INSERT INTO trust_scores
    (user_id, score,
     coin_component, activity_component, kyc_component, history_component,
     max_loan_etb, interest_rate_pct, last_calculated_at)
  VALUES
    (p_user_id, ROUND(v_score, 2),
     ROUND(v_coin_raw,2), ROUND(v_act_raw,2),
     ROUND(v_kyc_raw,2),  ROUND(v_hist_raw,2),
     ROUND(v_max_etb,2),  ROUND(v_rate,2), NOW())
  ON CONFLICT (user_id) DO UPDATE SET
    score               = EXCLUDED.score,
    coin_component      = EXCLUDED.coin_component,
    activity_component  = EXCLUDED.activity_component,
    kyc_component       = EXCLUDED.kyc_component,
    history_component   = EXCLUDED.history_component,
    max_loan_etb        = EXCLUDED.max_loan_etb,
    interest_rate_pct   = EXCLUDED.interest_rate_pct,
    last_calculated_at  = NOW(),
    updated_at          = NOW();

  RETURN ROUND(v_score, 2);
END;
$$;

-- 8c. Trigger: recalculate trust score every time coins change
CREATE OR REPLACE FUNCTION fn_trigger_trust_recalc()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fn_calculate_trust_score(NEW.user_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_recalc_trust_on_coins
  AFTER INSERT ON coin_transactions
  FOR EACH ROW EXECUTE FUNCTION fn_trigger_trust_recalc();

-- 8d. Trigger: auto-create wallet + notification prefs on new user
CREATE OR REPLACE FUNCTION fn_init_new_user()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO wallets (user_id) VALUES (NEW.id);
  INSERT INTO notification_prefs (user_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_init_new_user
  AFTER INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION fn_init_new_user();

-- ----------------------------------------------------------------
-- 9.  H E L P F U L   V I E W S
-- ----------------------------------------------------------------

-- Full user dashboard snapshot (used by the API /wallet/dashboard)
CREATE OR REPLACE VIEW v_user_dashboard AS
SELECT
  u.id,
  u.username,
  u.email,
  u.language,
  u.login_streak,
  u.kyc_status,
  u.referral_code,
  w.balance_etb,
  w.balance_usd,
  w.coin_balance,
  w.is_frozen,
  ts.score              AS trust_score,
  ts.max_loan_etb,
  ts.interest_rate_pct,
  (SELECT COUNT(*) FROM loans l
   WHERE l.user_id = u.id AND l.status = 'active') AS active_loans
FROM users u
JOIN wallets w      ON w.user_id  = u.id
LEFT JOIN trust_scores ts ON ts.user_id = u.id;

-- Upcoming holidays in next 30 days
CREATE OR REPLACE VIEW v_upcoming_holidays AS
SELECT *
FROM holiday_schedule
WHERE is_active = TRUE
  AND holiday_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
ORDER BY holiday_date;
