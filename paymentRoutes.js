// ================================================================
//  OmniHub — paymentRoutes.js
//  Express router: deposit, verify, withdraw, history
// ================================================================

const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const { Pool } = require('pg');

const {
  ChapaService,
  TelebirrService,
  CBEbirrService,
  WithdrawalService,
} = require('../services/PaymentService');

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ── JWT auth middleware ───────────────────────────────────────────
function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'no_token' });
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}

// ── Input validation helper ───────────────────────────────────────
function validateAmount(amount, min = 10, max = 50000) {
  const n = parseFloat(amount);
  if (isNaN(n) || n < min) return `Minimum amount is ${min} ETB`;
  if (n > max)             return `Maximum amount is ${max} ETB`;
  return null;
}

// ================================================================
//  DEPOSIT ROUTES
// ================================================================

// POST /api/payment/deposit/chapa
// Body: { amountETB, email?, firstName?, lastName?, phone? }
router.post('/deposit/chapa', auth, async (req, res) => {
  try {
    const { amountETB, email, firstName, lastName, phone } = req.body;
    const err = validateAmount(amountETB);
    if (err) return res.status(400).json({ error: err });

    // Load user details from DB for prefilling
    const { rows: [user] } = await db.query(
      `SELECT email, full_name, phone FROM users WHERE id = $1`,
      [req.user.id]
    );

    const result = await ChapaService.initiate({
      userId:    req.user.id,
      amountETB: parseFloat(amountETB),
      email:     email      || user?.email,
      firstName: firstName  || user?.full_name?.split(' ')[0],
      lastName:  lastName   || user?.full_name?.split(' ')[1] || '',
      phone:     phone      || user?.phone || '',
    });

    res.json(result);
  } catch (err) {
    console.error('[/deposit/chapa]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payment/deposit/telebirr
// Body: { amountETB, phone }
router.post('/deposit/telebirr', auth, async (req, res) => {
  try {
    const { amountETB, phone } = req.body;
    const err = validateAmount(amountETB);
    if (err) return res.status(400).json({ error: err });
    if (!phone) return res.status(400).json({ error: 'phone required for Telebirr' });

    const result = await TelebirrService.initiateH5({
      userId:    req.user.id,
      amountETB: parseFloat(amountETB),
      phone,
      subject:   'OmniHub Wallet Top-Up',
    });

    res.json(result);
  } catch (err) {
    console.error('[/deposit/telebirr]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payment/deposit/cbebirr
// Body: { amountETB, phone }
router.post('/deposit/cbebirr', auth, async (req, res) => {
  try {
    const { amountETB, phone } = req.body;
    const err = validateAmount(amountETB);
    if (err) return res.status(400).json({ error: err });
    if (!phone) return res.status(400).json({ error: 'phone required for CBEbirr' });

    const result = await CBEbirrService.initiate({
      userId:      req.user.id,
      amountETB:   parseFloat(amountETB),
      phone,
      description: 'OmniHub Wallet Deposit',
    });

    res.json(result);
  } catch (err) {
    console.error('[/deposit/cbebirr]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  VERIFY (manual poll — also triggered by webhook)
// ================================================================

// GET /api/payment/verify/:txRef
router.get('/verify/:txRef', auth, async (req, res) => {
  try {
    const { txRef } = req.params;

    // Look up which provider this belongs to
    const { rows: [payment] } = await db.query(
      `SELECT * FROM payment_transactions
       WHERE tx_ref = $1 AND user_id = $2`,
      [txRef, req.user.id]
    );

    if (!payment) return res.status(404).json({ error: 'transaction_not_found' });
    if (payment.status === 'completed') {
      return res.json({ status: 'completed', alreadyCredited: true });
    }

    // Verify with the correct provider
    let result;
    if (payment.provider === 'chapa')   result = await ChapaService.verify(txRef);
    if (payment.provider === 'telebirr')result = await TelebirrService.verify(txRef);
    if (payment.provider === 'cbebirr') result = await CBEbirrService.verify(txRef);

    if (result?.verified) {
      // Credit wallet if not yet done
      const { creditWallet } = require('../services/PaymentService');
      const amountUSD = payment.amount_etb / parseFloat(process.env.ETB_PER_USD || '55.5');
      await creditWallet(req.user.id, payment.amount_etb, amountUSD, txRef, payment.provider);
    }

    res.json({ status: result?.status, verified: result?.verified });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  WITHDRAWAL
// ================================================================

// POST /api/payment/withdraw
// Body: { amountETB, provider, accountNumber, accountName }
router.post('/withdraw', auth, async (req, res) => {
  try {
    const { amountETB, provider, accountNumber, accountName } = req.body;

    const err = validateAmount(amountETB, 10, 10000);
    if (err) return res.status(400).json({ error: err });

    if (!['telebirr','cbebirr','chapa'].includes(provider)) {
      return res.status(400).json({ error: 'Invalid provider' });
    }
    if (!accountNumber) return res.status(400).json({ error: 'accountNumber required' });

    // KYC check — must be verified to withdraw
    const { rows: [user] } = await db.query(
      `SELECT kyc_status FROM users WHERE id = $1`, [req.user.id]
    );
    if (user?.kyc_status !== 'verified') {
      return res.status(403).json({
        error: 'KYC verification required before withdrawal',
        kyc_status: user?.kyc_status,
      });
    }

    const result = await WithdrawalService.request({
      userId:        req.user.id,
      amountETB:     parseFloat(amountETB),
      provider,
      accountNumber,
      accountName:   accountName || '',
    });

    res.json(result);
  } catch (err) {
    console.error('[/withdraw]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ================================================================
//  TRANSACTION HISTORY
// ================================================================

// GET /api/payment/history?limit=20&offset=0
router.get('/history', auth, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '20'), 50);
    const offset = parseInt(req.query.offset || '0');

    const { rows } = await db.query(
      `SELECT tx_ref, provider, amount_etb, status, tx_type,
              created_at, completed_at
       FROM payment_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    res.json({ transactions: rows, limit, offset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payment/wallet — current wallet balances
router.get('/wallet', auth, async (req, res) => {
  try {
    const { rows: [wallet] } = await db.query(
      `SELECT balance_etb, balance_usd, coin_balance
       FROM wallets WHERE user_id = $1`,
      [req.user.id]
    );
    res.json(wallet || { balance_etb: 0, balance_usd: 0, coin_balance: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
