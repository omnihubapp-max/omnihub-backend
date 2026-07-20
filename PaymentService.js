// ================================================================
//  OmniHub — PaymentService.js
//  Covers: CBEbirr · Telebirr · Chapa
//
//  Each provider has:
//    initiate()   → start a payment, return checkout URL or USSD
//    verify()     → confirm payment status
//    webhook()    → handle server-to-server callback
//    refund()     → reverse a transaction
// ================================================================

const axios  = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Exchange rate (update daily via cron) ────────────────────────
// 1 USD ≈ 55 ETB — store in DB or env and refresh
const ETB_PER_USD = parseFloat(process.env.ETB_PER_USD || '55.5');

// ================================================================
//  SHARED LEDGER HELPER
//  Every confirmed payment writes two records:
//    1. ledger_entries  — immutable financial log
//    2. wallets         — updated balance
// ================================================================
async function creditWallet(userId, amountETB, amountUSD, txRef, provider) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Update wallet balances
    const { rows: [wallet] } = await client.query(
      `UPDATE wallets
         SET balance_etb   = balance_etb   + $1,
             balance_usd   = balance_usd   + $2,
             updated_at    = NOW()
       WHERE user_id = $3
       RETURNING balance_etb, balance_usd`,
      [amountETB, amountUSD, userId]
    );

    if (!wallet) throw new Error(`Wallet not found for user ${userId}`);

    // Immutable ledger entry
    await client.query(
      `INSERT INTO ledger_entries
         (wallet_id, entry_type, amount, currency,
          balance_after, description, reference_id, reference_type, metadata)
       SELECT w.id, 'credit', $1, 'ETB',
              $2, $3, $4, 'deposit', $5
       FROM wallets w WHERE w.user_id = $6`,
      [
        amountETB,
        wallet.balance_etb,
        `Deposit via ${provider}`,
        txRef,
        JSON.stringify({ provider, amountUSD, txRef }),
        userId,
      ]
    );

    // Mark transaction as completed in payments table
    await client.query(
      `UPDATE payment_transactions
         SET status        = 'completed',
             completed_at  = NOW(),
             wallet_credited = true
       WHERE tx_ref = $1`,
      [txRef]
    );

    await client.query('COMMIT');
    return wallet;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Deduct from wallet (for withdrawals)
async function debitWallet(userId, amountETB, txRef, provider) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [wallet] } = await client.query(
      `UPDATE wallets
         SET balance_etb = balance_etb - $1
       WHERE user_id = $2 AND balance_etb >= $1
       RETURNING balance_etb`,
      [amountETB, userId]
    );

    if (!wallet) throw new Error('Insufficient ETB balance');

    await client.query(
      `INSERT INTO ledger_entries
         (wallet_id, entry_type, amount, currency,
          balance_after, description, reference_id, reference_type)
       SELECT w.id, 'debit', $1, 'ETB', $2, $3, $4, 'withdrawal'
       FROM wallets w WHERE w.user_id = $5`,
      [amountETB, wallet.balance_etb, `Withdrawal via ${provider}`, txRef, userId]
    );

    await client.query('COMMIT');
    return wallet;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Create a pending payment record
async function createPaymentRecord(userId, provider, amountETB, txRef, meta = {}) {
  await db.query(
    `INSERT INTO payment_transactions
       (user_id, provider, amount_etb, tx_ref, status, metadata)
     VALUES ($1, $2, $3, $4, 'pending', $5)
     ON CONFLICT (tx_ref) DO NOTHING`,
    [userId, provider, amountETB, txRef, JSON.stringify(meta)]
  );
}

// ================================================================
//  1.  CHAPA  (https://chapa.co)
//  Best documented Ethiopian payment API — start here.
//  Supports: Telebirr, CBE, Amole, HelloCash, card
//  Sandbox:  https://api.chapa.co/v1  (use test keys)
// ================================================================
const ChapaService = {
  BASE_URL:   'https://api.chapa.co/v1',
  SECRET_KEY: process.env.CHAPA_SECRET_KEY || 'CHASECK_TEST-xxxxxx',

  // ── Initiate payment ─────────────────────────────────────────
  // Returns: { checkout_url } — redirect user here
  async initiate({ userId, amountETB, email, firstName, lastName, phone }) {
    const txRef = `OMNI-CHAPA-${userId}-${Date.now()}`;

    try {
      const res = await axios.post(
        `${this.BASE_URL}/transaction/initialize`,
        {
          amount:        amountETB.toFixed(2),
          currency:      'ETB',
          email:         email || `${userId}@omnihub.app`,
          first_name:    firstName || 'OmniHub',
          last_name:     lastName  || 'User',
          phone_number:  phone     || '',
          tx_ref:        txRef,
          callback_url:  `${process.env.SERVER_URL}/webhook/chapa`,
          return_url:    `${process.env.FRONTEND_URL}/wallet?deposit=success`,
          customization: {
            title:       'OmniHub Wallet Deposit',
            description: `Add ETB ${amountETB} to your OmniHub wallet`,
            logo:        `${process.env.FRONTEND_URL}/logo.png`,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${this.SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Save pending record
      await createPaymentRecord(userId, 'chapa', amountETB, txRef, {
        checkout_url: res.data.data.checkout_url,
      });

      return {
        success:      true,
        txRef,
        checkoutUrl:  res.data.data.checkout_url,
        provider:     'chapa',
      };
    } catch (err) {
      console.error('[Chapa Init]', err.response?.data || err.message);
      throw new Error('Chapa payment initiation failed: ' + (err.response?.data?.message || err.message));
    }
  },

  // ── Verify payment ───────────────────────────────────────────
  async verify(txRef) {
    try {
      const res = await axios.get(
        `${this.BASE_URL}/transaction/verify/${txRef}`,
        { headers: { Authorization: `Bearer ${this.SECRET_KEY}` } }
      );

      const tx = res.data.data;
      return {
        verified:  tx.status === 'success',
        status:    tx.status,
        amount:    parseFloat(tx.amount),
        currency:  tx.currency,
        txRef:     tx.tx_ref,
        raw:       tx,
      };
    } catch (err) {
      console.error('[Chapa Verify]', err.response?.data || err.message);
      return { verified: false, status: 'error', error: err.message };
    }
  },

  // ── Webhook handler ──────────────────────────────────────────
  // Chapa sends POST to /webhook/chapa with tx_ref in body
  async handleWebhook(body, chapaSignature) {
    // Verify webhook signature
    const hash = crypto
      .createHmac('sha256', this.SECRET_KEY)
      .update(JSON.stringify(body))
      .digest('hex');

    if (hash !== chapaSignature) {
      console.warn('[Chapa Webhook] Invalid signature');
      return { ok: false, reason: 'invalid_signature' };
    }

    const { tx_ref, status } = body;
    if (status !== 'success') {
      return { ok: false, reason: `payment_status_${status}` };
    }

    // Look up pending payment
    const { rows: [payment] } = await db.query(
      `SELECT * FROM payment_transactions
       WHERE tx_ref = $1 AND status = 'pending'`,
      [tx_ref]
    );

    if (!payment) return { ok: false, reason: 'payment_not_found_or_already_processed' };

    // Credit wallet
    const amountUSD = payment.amount_etb / ETB_PER_USD;
    await creditWallet(payment.user_id, payment.amount_etb, amountUSD, tx_ref, 'Chapa');

    console.log(`[Chapa] Credited ${payment.amount_etb} ETB to user ${payment.user_id}`);
    return { ok: true, userId: payment.user_id, amountETB: payment.amount_etb };
  },
};

// ================================================================
//  2.  TELEBIRR  (Ethio Telecom)
//  Integration via Ethio Telecom partner API.
//  Requires: Partner credentials from Ethio Telecom
//  Flow: initiate → user gets USSD push → confirm → webhook
// ================================================================
const TelebirrService = {
  BASE_URL:  process.env.TELEBIRR_BASE_URL  || 'https://196.188.120.3:38443/apiaccess/payment/gateway',
  APP_ID:    process.env.TELEBIRR_APP_ID    || '',
  APP_KEY:   process.env.TELEBIRR_APP_KEY   || '',
  PUBLIC_KEY:process.env.TELEBIRR_PUBLIC_KEY|| '', // RSA public key from Ethio Telecom

  // ── Build signed payload ─────────────────────────────────────
  _buildPayload(params) {
    // Telebirr requires RSA encryption of the payload
    // In production: use node-forge or native crypto with the Ethio Telecom public key
    const rawStr = Object.entries(params)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([k,v]) => `${k}=${v}`)
      .join('&');

    // Simplified: in production replace with actual RSA-OAEP encryption
    const sign = crypto
      .createHash('sha256')
      .update(rawStr + this.APP_KEY)
      .digest('hex');

    return { ...params, sign };
  },

  // ── Initiate (H5 web checkout) ───────────────────────────────
  async initiateH5({ userId, amountETB, phone, subject }) {
    const outTradeNo = `OMNI-TB-${userId}-${Date.now()}`;
    const nonce      = crypto.randomBytes(8).toString('hex');
    const timestamp  = Math.floor(Date.now() / 1000).toString();

    const params = {
      appId:        this.APP_ID,
      notifyUrl:    `${process.env.SERVER_URL}/webhook/telebirr`,
      returnUrl:    `${process.env.FRONTEND_URL}/wallet?deposit=success`,
      shortCode:    process.env.TELEBIRR_SHORT_CODE || '',
      subject:      subject || 'OmniHub Wallet Deposit',
      timeoutExpress:'30',
      timestamp,
      nonce,
      outTradeNo,
      totalAmount:  amountETB.toFixed(2),
      receiverIdentifier: phone,
    };

    const signed = this._buildPayload(params);

    try {
      const res = await axios.post(
        `${this.BASE_URL}/h5pay`,
        { appid: this.APP_ID, sign: signed.sign, ussd: JSON.stringify(params) },
        {
          headers: { 'Content-Type': 'application/json' },
          // Note: Telebirr uses a self-signed cert in sandbox
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
        }
      );

      if (res.data.code !== '0') {
        throw new Error(res.data.msg || 'Telebirr initiation failed');
      }

      await createPaymentRecord(userId, 'telebirr', amountETB, outTradeNo, {
        toPayUrl: res.data.data?.toPayUrl,
        phone,
      });

      return {
        success:   true,
        txRef:     outTradeNo,
        toPayUrl:  res.data.data?.toPayUrl,
        provider:  'telebirr',
      };
    } catch (err) {
      console.error('[Telebirr Init]', err.response?.data || err.message);
      throw new Error('Telebirr initiation failed: ' + err.message);
    }
  },

  // ── Verify ───────────────────────────────────────────────────
  async verify(outTradeNo) {
    const params = {
      appId:       this.APP_ID,
      outTradeNo,
      timestamp:   Math.floor(Date.now() / 1000).toString(),
      nonce:       crypto.randomBytes(8).toString('hex'),
    };
    const signed = this._buildPayload(params);

    try {
      const res = await axios.post(
        `${this.BASE_URL}/queryTransaction`,
        { appid: this.APP_ID, sign: signed.sign, ussd: JSON.stringify(params) },
        { httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }) }
      );

      return {
        verified: res.data.code === '0' && res.data.data?.tradeStatus === 'SUCCESS',
        status:   res.data.data?.tradeStatus,
        raw:      res.data,
      };
    } catch (err) {
      return { verified: false, error: err.message };
    }
  },

  // ── Webhook ──────────────────────────────────────────────────
  async handleWebhook(body) {
    const { outTradeNo, tradeStatus, totalAmount } = body;

    if (tradeStatus !== 'SUCCESS') {
      return { ok: false, reason: `trade_status_${tradeStatus}` };
    }

    const { rows: [payment] } = await db.query(
      `SELECT * FROM payment_transactions
       WHERE tx_ref = $1 AND status = 'pending'`,
      [outTradeNo]
    );

    if (!payment) return { ok: false, reason: 'not_found_or_processed' };

    const amountETB = parseFloat(totalAmount || payment.amount_etb);
    const amountUSD = amountETB / ETB_PER_USD;

    await creditWallet(payment.user_id, amountETB, amountUSD, outTradeNo, 'Telebirr');
    console.log(`[Telebirr] Credited ${amountETB} ETB to user ${payment.user_id}`);
    return { ok: true, userId: payment.user_id, amountETB };
  },
};

// ================================================================
//  3.  CBEbirr  (Commercial Bank of Ethiopia)
//  Integration via CBE Birr merchant API
//  Requires: Merchant registration with CBE
//  Flow: initiate → push notification to customer → confirm
// ================================================================
const CBEbirrService = {
  BASE_URL:    process.env.CBEBIRR_BASE_URL    || 'https://merchant.cbebirr.com/api',
  MERCHANT_ID: process.env.CBEBIRR_MERCHANT_ID || '',
  API_KEY:     process.env.CBEBIRR_API_KEY      || '',
  API_SECRET:  process.env.CBEBIRR_API_SECRET   || '',

  // ── Generate HMAC signature ──────────────────────────────────
  _sign(payload) {
    return crypto
      .createHmac('sha256', this.API_SECRET)
      .update(JSON.stringify(payload))
      .digest('hex');
  },

  // ── Initiate payment ─────────────────────────────────────────
  async initiate({ userId, amountETB, phone, description }) {
    const invoiceNo = `OMNI-CBE-${userId}-${Date.now()}`;

    const payload = {
      merchantId:   this.MERCHANT_ID,
      invoiceNo,
      amount:       amountETB.toFixed(2),
      currency:     'ETB',
      description:  description || 'OmniHub Wallet Deposit',
      customerPhone:phone,
      callbackUrl:  `${process.env.SERVER_URL}/webhook/cbebirr`,
      redirectUrl:  `${process.env.FRONTEND_URL}/wallet?deposit=success`,
      timestamp:    new Date().toISOString(),
    };

    payload.signature = this._sign(payload);

    try {
      const res = await axios.post(
        `${this.BASE_URL}/payment/initiate`,
        payload,
        {
          headers: {
            'X-Api-Key':     this.API_KEY,
            'Content-Type':  'application/json',
          },
        }
      );

      if (!res.data.success) {
        throw new Error(res.data.message || 'CBEbirr initiation failed');
      }

      await createPaymentRecord(userId, 'cbebirr', amountETB, invoiceNo, {
        paymentUrl: res.data.paymentUrl,
        phone,
      });

      return {
        success:    true,
        txRef:      invoiceNo,
        paymentUrl: res.data.paymentUrl,
        provider:   'cbebirr',
      };
    } catch (err) {
      console.error('[CBEbirr Init]', err.response?.data || err.message);
      throw new Error('CBEbirr initiation failed: ' + err.message);
    }
  },

  // ── Verify ───────────────────────────────────────────────────
  async verify(invoiceNo) {
    const payload   = { merchantId: this.MERCHANT_ID, invoiceNo,
      timestamp: new Date().toISOString() };
    payload.signature = this._sign(payload);

    try {
      const res = await axios.post(
        `${this.BASE_URL}/payment/status`,
        payload,
        { headers: { 'X-Api-Key': this.API_KEY } }
      );

      return {
        verified: res.data.status === 'PAID',
        status:   res.data.status,
        amount:   res.data.amount,
        raw:      res.data,
      };
    } catch (err) {
      return { verified: false, error: err.message };
    }
  },

  // ── Webhook ──────────────────────────────────────────────────
  async handleWebhook(body, signature) {
    // Verify signature
    const { signature: sig, ...rest } = body;
    const expected = this._sign(rest);
    if (expected !== signature && expected !== sig) {
      console.warn('[CBEbirr Webhook] Signature mismatch');
      return { ok: false, reason: 'invalid_signature' };
    }

    const { invoiceNo, status, amount } = body;
    if (status !== 'PAID') return { ok: false, reason: `status_${status}` };

    const { rows: [payment] } = await db.query(
      `SELECT * FROM payment_transactions
       WHERE tx_ref = $1 AND status = 'pending'`,
      [invoiceNo]
    );

    if (!payment) return { ok: false, reason: 'not_found_or_processed' };

    const amountETB = parseFloat(amount || payment.amount_etb);
    const amountUSD = amountETB / ETB_PER_USD;

    await creditWallet(payment.user_id, amountETB, amountUSD, invoiceNo, 'CBEbirr');
    console.log(`[CBEbirr] Credited ${amountETB} ETB to user ${payment.user_id}`);
    return { ok: true, userId: payment.user_id, amountETB };
  },
};

// ================================================================
//  WITHDRAWAL SERVICE (ETB → mobile money)
// ================================================================
const WithdrawalService = {

  // ── Request a withdrawal ─────────────────────────────────────
  async request({ userId, amountETB, provider, accountNumber, accountName }) {
    if (amountETB < 10) throw new Error('Minimum withdrawal is 10 ETB');
    if (amountETB > 10000) throw new Error('Maximum single withdrawal is 10,000 ETB');

    const txRef = `OMNI-WD-${userId}-${Date.now()}`;

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Debit wallet first
      const { rows: [wallet] } = await client.query(
        `UPDATE wallets
           SET balance_etb = balance_etb - $1
         WHERE user_id = $2 AND balance_etb >= $1
         RETURNING balance_etb`,
        [amountETB, userId]
      );
      if (!wallet) throw new Error('Insufficient ETB balance');

      // Create withdrawal record (pending manual/auto processing)
      await client.query(
        `INSERT INTO payment_transactions
           (user_id, provider, amount_etb, tx_ref, status,
            tx_type, metadata)
         VALUES ($1, $2, $3, $4, 'pending', 'withdrawal', $5)`,
        [
          userId, provider, amountETB, txRef,
          JSON.stringify({ accountNumber, accountName }),
        ]
      );

      // Ledger debit entry
      await client.query(
        `INSERT INTO ledger_entries
           (wallet_id, entry_type, amount, currency,
            balance_after, description, reference_id, reference_type)
         SELECT w.id, 'debit', $1, 'ETB', $2,
                $3, $4, 'withdrawal'
         FROM wallets w WHERE w.user_id = $5`,
        [amountETB, wallet.balance_etb,
          `Withdrawal to ${provider} — ${accountNumber}`, txRef, userId]
      );

      await client.query('COMMIT');

      // For Chapa: use their transfer API
      if (provider === 'chapa') {
        await this._chapaTransfer({ txRef, amountETB, accountNumber, accountName });
      }

      return { success: true, txRef, status: 'pending', amountETB };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // Chapa transfer API (pay out to mobile money)
  async _chapaTransfer({ txRef, amountETB, accountNumber, accountName }) {
    try {
      const res = await axios.post(
        'https://api.chapa.co/v1/transfers',
        {
          account_name:   accountName,
          account_number: accountNumber,
          amount:         amountETB.toFixed(2),
          currency:       'ETB',
          reference:      txRef,
          bank_code:      'TELEBIRR', // or 'CBE' etc.
        },
        { headers: { Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}` } }
      );

      await db.query(
        `UPDATE payment_transactions
           SET status = $1, metadata = metadata || $2
         WHERE tx_ref = $3`,
        [
          res.data.status === 'success' ? 'completed' : 'pending',
          JSON.stringify({ chapa_transfer: res.data }),
          txRef,
        ]
      );

      return res.data;
    } catch (err) {
      console.error('[Chapa Transfer]', err.response?.data || err.message);
      // Don't throw — withdrawal record already created, handle manually
    }
  },
};

module.exports = {
  ChapaService,
  TelebirrService,
  CBEbirrService,
  WithdrawalService,
  creditWallet,
  debitWallet,
};
