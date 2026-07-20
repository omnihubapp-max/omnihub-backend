// ================================================================
//  OmniHub — aiRoutes.js
//  Express routes for the AI chat endpoint
// ================================================================
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { chat, clearHistory, generateExecutiveSummary } = require('../ai/AIAssistant');

function auth(req, res, next) {
  try {
    req.user = jwt.verify(
      req.headers.authorization?.replace('Bearer ', ''),
      process.env.JWT_SECRET || 'dev_secret'
    );
    next();
  } catch { res.status(401).json({ error: 'unauthorized' }); }
}

// POST /api/ai/chat
// Body: { message }
router.post('/chat', auth, async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });
  if (message.length > 500) return res.status(400).json({ error: 'message too long (max 500 chars)' });

  const result = await chat(req.user.id, message.trim());
  res.json(result);
});

// DELETE /api/ai/history — clear conversation memory
router.delete('/history', auth, (req, res) => {
  clearHistory(req.user.id);
  res.json({ ok: true });
});

// POST /api/ai/summary — trigger summary manually (admin only)
router.post('/summary', auth, async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_PASS) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const summary = await generateExecutiveSummary();
  res.json({ ok: true, summary });
});

module.exports = router;

// ================================================================
//  ADD THESE TABLES TO YOUR schema.sql
// ================================================================
/*
-- AI conversation logs
CREATE TABLE IF NOT EXISTS ai_conversation_logs (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID        NOT NULL REFERENCES users(id),
  user_message     TEXT        NOT NULL,
  assistant_message TEXT       NOT NULL,
  language         VARCHAR(5)  NOT NULL DEFAULT 'en',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ai_logs_user ON ai_conversation_logs(user_id);
CREATE INDEX idx_ai_logs_date ON ai_conversation_logs(created_at);

-- Executive summaries
CREATE TABLE IF NOT EXISTS executive_summaries (
  summary_date     DATE        PRIMARY KEY,
  total_users      INTEGER,
  new_users_today  INTEGER,
  revenue_etb      DECIMAL(18,2),
  withdrawals_etb  DECIMAL(18,2),
  bingo_games      INTEGER,
  coins_issued     BIGINT,
  loans_count      INTEGER,
  ai_summary       TEXT,
  generated_at     TIMESTAMPTZ DEFAULT NOW()
);
*/
