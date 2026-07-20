// ================================================================
//  OmniHub — kycRoutes.js  (Option A — KYC Flow)
//  ID upload → pending → admin review → approve/reject
//
//  Install: npm install multer sharp
//  Mount:   app.use('/api/kyc', require('./routes/kycRoutes'))
//           app.use('/',        require('./routes/kycRoutes'))  // admin routes
// ================================================================
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const sharp   = require('sharp');
const path    = require('path');
const fs      = require('fs');
const jwt     = require('jsonwebtoken');
const { Pool }= require('pg');
const crypto  = require('crypto');

const db         = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const ADMIN_PASS = process.env.ADMIN_PASS || 'OMNI_ADMIN_2026';
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads/kyc';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Auth ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  try { req.user = jwt.verify(req.headers.authorization?.replace('Bearer ',''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error:'unauthorized' }); }
}
function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_PASS) return res.status(403).json({ error:'forbidden' });
  next();
}

// ── Multer ────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5*1024*1024, files: 3 },
  fileFilter: (_req, file, cb) => {
    ['image/jpeg','image/jpg','image/png','image/webp'].includes(file.mimetype)
      ? cb(null, true) : cb(new Error('JPEG/PNG/WebP only'));
  },
});

async function saveImage(buffer, userId, type) {
  const filename = `${userId}_${type}_${crypto.randomBytes(8).toString('hex')}.jpg`;
  await sharp(buffer)
    .resize(1200, 1200, { fit:'inside', withoutEnlargement:true })
    .jpeg({ quality: 85 })
    .toFile(path.join(UPLOAD_DIR, filename));
  return filename;
}

// ── ADD TO schema.sql ─────────────────────────────────────────────
/*
CREATE TABLE IF NOT EXISTS kyc_submissions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id_type          VARCHAR(30) NOT NULL,
  id_number        VARCHAR(50),
  full_name        VARCHAR(150) NOT NULL,
  date_of_birth    DATE,
  nationality      VARCHAR(50) DEFAULT 'Ethiopian',
  id_front_file    VARCHAR(200) NOT NULL,
  selfie_file      VARCHAR(200) NOT NULL,
  id_back_file     VARCHAR(200),
  status           VARCHAR(20) NOT NULL DEFAULT 'pending',
  reviewed_by      VARCHAR(100),
  reviewed_at      TIMESTAMPTZ,
  rejection_reason TEXT,
  submitted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address       INET,
  user_agent       TEXT
);
CREATE INDEX idx_kyc_user   ON kyc_submissions(user_id);
CREATE INDEX idx_kyc_status ON kyc_submissions(status);
*/

// ── USER: GET status ──────────────────────────────────────────────
router.get('/status', auth, async (req, res) => {
  try {
    const { rows:[user] }  = await db.query(`SELECT kyc_status FROM users WHERE id=$1`,[req.user.id]);
    const { rows:[sub]  }  = await db.query(
      `SELECT id,status,id_type,full_name,submitted_at,reviewed_at,rejection_reason
       FROM kyc_submissions WHERE user_id=$1 ORDER BY submitted_at DESC LIMIT 1`,[req.user.id]);
    res.json({ kycStatus: user?.kyc_status||'pending', submission: sub||null });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── USER: POST submit ─────────────────────────────────────────────
router.post('/submit', auth,
  upload.fields([{name:'id_front',maxCount:1},{name:'selfie',maxCount:1},{name:'id_back',maxCount:1}]),
  async (req, res) => {
    try {
      const { id_type, id_number, full_name, date_of_birth, nationality } = req.body;
      const userId = req.user.id;

      if (!id_type || !full_name)      return res.status(400).json({error:'id_type and full_name required'});
      if (!['national_id','passport','drivers_license','kebele_id'].includes(id_type))
        return res.status(400).json({error:'invalid id_type'});
      if (!req.files?.id_front?.[0])   return res.status(400).json({error:'ID front photo required'});
      if (!req.files?.selfie?.[0])     return res.status(400).json({error:'Selfie photo required'});

      const { rows:[existing] } = await db.query(
        `SELECT status FROM kyc_submissions WHERE user_id=$1
         AND status IN ('approved','pending','under_review') ORDER BY submitted_at DESC LIMIT 1`,[userId]);
      if (existing?.status==='approved')      return res.status(400).json({error:'Already approved'});
      if (existing?.status==='pending'||existing?.status==='under_review')
        return res.status(400).json({error:'Submission already under review'});

      const idFrontFile = await saveImage(req.files.id_front[0].buffer, userId, 'id_front');
      const selfieFile  = await saveImage(req.files.selfie[0].buffer,   userId, 'selfie');
      const idBackFile  = req.files?.id_back?.[0]
        ? await saveImage(req.files.id_back[0].buffer, userId, 'id_back') : null;

      const { rows:[sub] } = await db.query(
        `INSERT INTO kyc_submissions
           (user_id,id_type,id_number,full_name,date_of_birth,nationality,
            id_front_file,selfie_file,id_back_file,ip_address,user_agent)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,status,submitted_at`,
        [userId,id_type,id_number||null,full_name.trim(),date_of_birth||null,
         nationality||'Ethiopian',idFrontFile,selfieFile,idBackFile,
         req.ip,req.headers['user-agent']?.slice(0,200)||null]);

      await db.query(`UPDATE users SET kyc_status='submitted' WHERE id=$1`,[userId]);

      res.json({ success:true, submissionId:sub.id, status:'pending',
        message:'KYC ማስረጃ ደረሰ — 24-48 ሰዓት ውስጥ ይረጋገጣል' });
    } catch(e){
      res.status(e.message?.includes('only')?400:500).json({error:e.message});
    }
  }
);

// ── ADMIN: list pending ───────────────────────────────────────────
router.get('/admin/kyc', adminAuth, async (req, res) => {
  try {
    const status = req.query.status||'pending';
    const limit  = Math.min(parseInt(req.query.limit||'20'),50);
    const offset = parseInt(req.query.offset||'0');

    const { rows } = await db.query(
      `SELECT ks.*,u.username,u.email,u.phone,w.balance_etb,w.coin_balance
       FROM kyc_submissions ks
       JOIN users u   ON u.id=ks.user_id
       JOIN wallets w ON w.user_id=ks.user_id
       WHERE ks.status=$1 ORDER BY ks.submitted_at ASC LIMIT $2 OFFSET $3`,
      [status,limit,offset]);

    const { rows:[counts] } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status='pending')      AS pending,
              COUNT(*) FILTER (WHERE status='under_review') AS under_review,
              COUNT(*) FILTER (WHERE status='approved')     AS approved,
              COUNT(*) FILTER (WHERE status='rejected')     AS rejected
       FROM kyc_submissions`);

    res.json({ submissions:rows, counts, limit, offset });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── ADMIN: get single + image URLs ───────────────────────────────
router.get('/admin/kyc/:id', adminAuth, async (req, res) => {
  try {
    const { rows:[sub] } = await db.query(
      `SELECT ks.*,u.username,u.email,u.phone FROM kyc_submissions ks
       JOIN users u ON u.id=ks.user_id WHERE ks.id=$1`,[req.params.id]);
    if (!sub) return res.status(404).json({error:'not_found'});
    res.json({ ...sub, images:{
      id_front:`/admin/kyc/image/${sub.id_front_file}`,
      selfie:  `/admin/kyc/image/${sub.selfie_file}`,
      id_back: sub.id_back_file?`/admin/kyc/image/${sub.id_back_file}`:null,
    }});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── ADMIN: serve image ────────────────────────────────────────────
router.get('/admin/kyc/image/:filename', adminAuth, (req, res) => {
  const fp = path.join(UPLOAD_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).json({error:'image_not_found'});
  res.sendFile(path.resolve(fp));
});

// ── ADMIN: approve ────────────────────────────────────────────────
router.post('/admin/kyc/:id/approve', adminAuth, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows:[sub] } = await client.query(
      `UPDATE kyc_submissions SET status='approved',reviewed_by='admin',reviewed_at=NOW()
       WHERE id=$1 AND status IN ('pending','under_review') RETURNING user_id,full_name`,
      [req.params.id]);
    if (!sub){ await client.query('ROLLBACK'); return res.status(404).json({error:'not_found_or_reviewed'}); }

    await client.query(`UPDATE users SET kyc_status='verified',full_name=COALESCE(full_name,$1) WHERE id=$2`,
      [sub.full_name, sub.user_id]);
    await client.query(`SELECT calculate_trust_score($1)`,[sub.user_id]);

    const { rows:[cw] } = await client.query(
      `UPDATE wallets SET coin_balance=coin_balance+200 WHERE user_id=$1 RETURNING coin_balance`,
      [sub.user_id]);
    await client.query(
      `INSERT INTO coin_transactions(user_id,rule_key,coins,balance_after,description)
       VALUES($1,'kyc_complete',200,$2,'KYC verified — bonus coins')`,
      [sub.user_id, cw.coin_balance]);

    await client.query('COMMIT');
    res.json({ ok:true, message:`✅ ${sub.full_name} KYC approved — 200 coins awarded` });
  } catch(e){ await client.query('ROLLBACK'); res.status(500).json({error:e.message}); }
  finally { client.release(); }
});

// ── ADMIN: reject ─────────────────────────────────────────────────
router.post('/admin/kyc/:id/reject', adminAuth, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({error:'rejection reason required'});

    const { rows:[sub] } = await db.query(
      `UPDATE kyc_submissions SET status='rejected',reviewed_by='admin',
       reviewed_at=NOW(),rejection_reason=$1
       WHERE id=$2 AND status IN ('pending','under_review') RETURNING user_id,full_name`,
      [reason.trim(), req.params.id]);
    if (!sub) return res.status(404).json({error:'not_found_or_reviewed'});

    await db.query(`UPDATE users SET kyc_status='rejected' WHERE id=$1`,[sub.user_id]);
    res.json({ ok:true, message:`❌ ${sub.full_name} rejected: ${reason}` });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── ADMIN: mark under_review ──────────────────────────────────────
router.post('/admin/kyc/:id/review', adminAuth, async (req, res) => {
  try {
    await db.query(`UPDATE kyc_submissions SET status='under_review' WHERE id=$1`,[req.params.id]);
    res.json({ ok:true });
  } catch(e){ res.status(500).json({error:e.message}); }
});

module.exports = router;
