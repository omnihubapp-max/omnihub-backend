// ================================================================
//  OmniHub — webhookRoutes.js
//  Handles server-to-server callbacks from payment providers.
//
//  IMPORTANT:
//    • These routes must be PUBLIC (no auth middleware)
//    • Each provider calls these when payment is confirmed
//    • Always verify the signature before crediting wallet
//    • Always return HTTP 200 quickly — provider retries on timeout
// ================================================================

const express = require('express');
const router  = express.Router();
const { Pool }= require('pg');

const {
  ChapaService,
  TelebirrService,
  CBEbirrService,
} = require('../services/PaymentService');

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Webhook log helper (for debugging) ──────────────────────────
async function logWebhook(provider, body, result) {
  try {
    await db.query(
      `INSERT INTO webhook_logs (provider, body, result, received_at)
       VALUES ($1, $2, $3, NOW())`,
      [provider, JSON.stringify(body), JSON.stringify(result)]
    );
  } catch {}  // Never let logging break a webhook
}

// ================================================================
//  CHAPA WEBHOOK
//  URL: POST /webhook/chapa
//  Header: Chapa-Signature (HMAC-SHA256)
// ================================================================
router.post('/chapa', express.json(), async (req, res) => {
  // Always respond 200 first — then process
  res.status(200).json({ status: 'received' });

  const signature = req.headers['chapa-signature'] || '';
  const body      = req.body;

  try {
    const result = await ChapaService.handleWebhook(body, signature);
    await logWebhook('chapa', body, result);

    if (result.ok) {
      console.log(`[Webhook/Chapa] ✅ Credited ${result.amountETB} ETB → user ${result.userId}`);
    } else {
      console.warn(`[Webhook/Chapa] ⚠️  ${result.reason}`);
    }
  } catch (err) {
    console.error('[Webhook/Chapa] Error:', err.message);
    await logWebhook('chapa', body, { error: err.message });
  }
});

// ================================================================
//  TELEBIRR WEBHOOK
//  URL: POST /webhook/telebirr
//  Telebirr sends: { outTradeNo, tradeStatus, totalAmount, ... }
// ================================================================
router.post('/telebirr', express.json(), async (req, res) => {
  res.status(200).json({ code: '0', msg: 'success' });

  const body = req.body;

  try {
    const result = await TelebirrService.handleWebhook(body);
    await logWebhook('telebirr', body, result);

    if (result.ok) {
      console.log(`[Webhook/Telebirr] ✅ Credited ${result.amountETB} ETB → user ${result.userId}`);
    } else {
      console.warn(`[Webhook/Telebirr] ⚠️  ${result.reason}`);
    }
  } catch (err) {
    console.error('[Webhook/Telebirr] Error:', err.message);
    await logWebhook('telebirr', body, { error: err.message });
  }
});

// ================================================================
//  CBEBIRR WEBHOOK
//  URL: POST /webhook/cbebirr
//  Header: X-CBE-Signature
// ================================================================
router.post('/cbebirr', express.json(), async (req, res) => {
  res.status(200).json({ status: 'ok' });

  const signature = req.headers['x-cbe-signature'] || '';
  const body      = req.body;

  try {
    const result = await CBEbirrService.handleWebhook(body, signature);
    await logWebhook('cbebirr', body, result);

    if (result.ok) {
      console.log(`[Webhook/CBEbirr] ✅ Credited ${result.amountETB} ETB → user ${result.userId}`);
    } else {
      console.warn(`[Webhook/CBEbirr] ⚠️  ${result.reason}`);
    }
  } catch (err) {
    console.error('[Webhook/CBEbirr] Error:', err.message);
    await logWebhook('cbebirr', body, { error: err.message });
  }
});

module.exports = router;
