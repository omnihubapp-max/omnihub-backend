-- ================================================================
--  OmniHub — Payment Tables (add to existing schema.sql)
--  Run this AFTER the main schema.sql
-- ================================================================

-- ── Payment transactions log ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_transactions (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID        NOT NULL REFERENCES users(id),

  provider        VARCHAR(20) NOT NULL,
  -- Values: chapa | telebirr | cbebirr | stripe

  tx_type         VARCHAR(20) NOT NULL DEFAULT 'deposit',
  -- Values: deposit | withdrawal | refund

  amount_etb      DECIMAL(18,2) NOT NULL
                  CONSTRAINT amount_positive CHECK (amount_etb > 0),

  tx_ref          VARCHAR(100) UNIQUE NOT NULL,
  -- Our internal reference — sent to provider

  provider_ref    VARCHAR(200),
  -- Provider's own transaction ID (filled on webhook)

  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- Values: pending | completed | failed | refunded | cancelled

  wallet_credited BOOLEAN NOT NULL DEFAULT FALSE,
  -- Safety flag: prevents double-crediting on duplicate webhooks

  metadata        JSONB,
  -- Extra data: checkout_url, phone, account_number, etc.

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_payments_user    ON payment_transactions(user_id);
CREATE INDEX idx_payments_txref   ON payment_transactions(tx_ref);
CREATE INDEX idx_payments_status  ON payment_transactions(status);
CREATE INDEX idx_payments_created ON payment_transactions(created_at);

-- ── Webhook log (debugging & audit) ─────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_logs (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider     VARCHAR(20) NOT NULL,
  body         JSONB,
  result       JSONB,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhooks_provider ON webhook_logs(provider);
CREATE INDEX idx_webhooks_received ON webhook_logs(received_at);

-- ── Add tx_type column if upgrading existing schema ──────────────
ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS tx_type VARCHAR(20) NOT NULL DEFAULT 'deposit';

-- ── View: user payment summary ───────────────────────────────────
CREATE OR REPLACE VIEW v_user_payments AS
SELECT
  pt.user_id,
  COUNT(*) FILTER (WHERE pt.status = 'completed' AND pt.tx_type = 'deposit')
    AS total_deposits,
  COALESCE(SUM(pt.amount_etb) FILTER (WHERE pt.status = 'completed' AND pt.tx_type = 'deposit'), 0)
    AS total_deposited_etb,
  COALESCE(SUM(pt.amount_etb) FILTER (WHERE pt.status = 'completed' AND pt.tx_type = 'withdrawal'), 0)
    AS total_withdrawn_etb,
  MAX(pt.completed_at) FILTER (WHERE pt.status = 'completed')
    AS last_transaction_at
FROM payment_transactions pt
GROUP BY pt.user_id;
