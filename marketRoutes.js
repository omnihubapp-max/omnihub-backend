// ================================================================
//  OmniHub — marketRoutes.js
//
//  NOTE: this file was referenced by server.js (app.use('/api/market', ...))
//  and by db/schema.sql (rule_key 'marketplace_buy') but was not part of
//  the files you provided — it did not exist anywhere in the upload.
//  Without it, `require('./routes/marketRoutes')` in server.js would
//  crash the whole backend on startup.
//
//  This is a working placeholder: basic listing CRUD + coin-based
//  purchase, using the same auth/style conventions as paymentRoutes.js
//  and kycRoutes.js. It creates its own table on first use so it runs
//  without a manual migration. Extend it once you decide exactly what
//  the marketplace should sell (digital goods, physical goods, etc.).
// ================================================================

const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const { Pool } = require('pg');

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ── JWT auth middleware (same pattern as paymentRoutes.js) ────────
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

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS marketplace_listings (
      id            SERIAL PRIMARY KEY,
      seller_id     INTEGER NOT NULL REFERENCES users(id),
      title         VARCHAR(120) NOT NULL,
      description   TEXT,
      price_coins   INTEGER NOT NULL CHECK (price_coins > 0),
      image_url     TEXT,
      is_active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  tableReady = true;
}

// ================================================================
//  GET /api/market/listings — browse active listings
// ================================================================
router.get('/listings', async (req, res) => {
  try {
    await ensureTable();
    const limit  = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;
    const { rows } = await db.query(
      `SELECT id, seller_id, title, description, price_coins, image_url, created_at
         FROM marketplace_listings
        WHERE is_active = TRUE
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ listings: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  GET /api/market/listings/:id
// ================================================================
router.get('/listings/:id', async (req, res) => {
  try {
    await ensureTable();
    const { rows: [listing] } = await db.query(
      `SELECT * FROM marketplace_listings WHERE id = $1 AND is_active = TRUE`,
      [req.params.id]
    );
    if (!listing) return res.status(404).json({ error: 'not_found' });
    res.json({ listing });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  POST /api/market/listings — create a listing (auth required)
//  Body: { title, description?, priceCoins, imageUrl? }
// ================================================================
router.post('/listings', auth, async (req, res) => {
  try {
    await ensureTable();
    const { title, description, priceCoins, imageUrl } = req.body;
    if (!title || !priceCoins || priceCoins <= 0) {
      return res.status(400).json({ error: 'title_and_positive_priceCoins_required' });
    }
    const { rows: [listing] } = await db.query(
      `INSERT INTO marketplace_listings (seller_id, title, description, price_coins, image_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.id, title, description || null, priceCoins, imageUrl || null]
    );
    res.status(201).json({ listing });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  DELETE /api/market/listings/:id — remove your own listing
// ================================================================
router.delete('/listings/:id', auth, async (req, res) => {
  try {
    const { rowCount } = await db.query(
      `UPDATE marketplace_listings SET is_active = FALSE
        WHERE id = $1 AND seller_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'not_found_or_not_owner' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  POST /api/market/listings/:id/purchase — buy with OmniCoins
//  Transfers price_coins from buyer's wallet to seller's wallet.
// ================================================================
router.post('/listings/:id/purchase', auth, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [listing] } = await client.query(
      `SELECT * FROM marketplace_listings WHERE id = $1 AND is_active = TRUE FOR UPDATE`,
      [req.params.id]
    );
    if (!listing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'listing_not_found' });
    }
    if (listing.seller_id === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'cannot_buy_own_listing' });
    }

    const { rows: [buyerWallet] } = await client.query(
      `UPDATE wallets SET coin_balance = coin_balance - $1
        WHERE user_id = $2 AND coin_balance >= $1
        RETURNING coin_balance`,
      [listing.price_coins, req.user.id]
    );
    if (!buyerWallet) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'insufficient_coin_balance' });
    }

    await client.query(
      `UPDATE wallets SET coin_balance = coin_balance + $1 WHERE user_id = $2`,
      [listing.price_coins, listing.seller_id]
    );

    await client.query(
      `INSERT INTO coin_transactions (user_id, rule_key, coins, balance_after, description)
       VALUES ($1, 'marketplace_purchase', $2, $3, $4)`,
      [req.user.id, -listing.price_coins, buyerWallet.coin_balance, `Purchased: ${listing.title}`]
    );

    await client.query(
      `UPDATE marketplace_listings SET is_active = FALSE WHERE id = $1`,
      [listing.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true, listing: listing.title, coinsSpent: listing.price_coins });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
