// ================================================================
//  OmniHub — security.js  (B: Security Hardening)
//  Helmet + Rate Limiting + Joi Validation + JWT + SQL Guard
//  npm install express-rate-limit helmet joi
// ================================================================
const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');
const Joi       = require('joi');
const jwt       = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASS = process.env.ADMIN_PASS;

// ── HELMET ────────────────────────────────────────────────────────
const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'","'unsafe-inline'","https://telegram.org"],
      styleSrc:   ["'self'","'unsafe-inline'","https://fonts.googleapis.com"],
      fontSrc:    ["'self'","https://fonts.gstatic.com"],
      imgSrc:     ["'self'","data:","blob:","https:"],
      connectSrc: ["'self'","wss:","https://api.anthropic.com","https://api.chapa.co"],
      frameSrc:   ["'none'"],
      objectSrc:  ["'none'"],
    },
  },
  hsts: { maxAge:31536000, includeSubDomains:true, preload:true },
  referrerPolicy: { policy:'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false,
});

// ── RATE LIMITERS ─────────────────────────────────────────────────
const globalLimiter  = rateLimit({ windowMs:15*60*1000, max:200, standardHeaders:true, legacyHeaders:false, skip: req => req.path==='/health', message:{error:'too_many_requests'} });
const authLimiter    = rateLimit({ windowMs:15*60*1000, max:10,  message:{error:'too_many_login_attempts'} });
const paymentLimiter = rateLimit({ windowMs:60*60*1000, max:20,  message:{error:'payment_rate_limit'} });
const chatLimiter    = rateLimit({ windowMs:60*1000,    max:30,  message:{error:'chat_rate_limit'} });
const walletLimiter  = rateLimit({ windowMs:60*1000,    max:10,  message:{error:'wallet_rate_limit'} });

// ── JOI SCHEMAS ───────────────────────────────────────────────────
const schemas = {
  register: Joi.object({
    phone:    Joi.string().pattern(/^\+?[0-9]{9,15}$/).required(),
    email:    Joi.string().email().optional(),
    username: Joi.string().alphanum().min(3).max(30).required(),
    password: Joi.string().min(8).max(128).pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).required()
      .messages({'string.pattern.base':'Must have uppercase, lowercase and number'}),
    language: Joi.string().valid('am','en','ti','om','fr','sw').default('am'),
  }),
  login: Joi.object({
    identifier: Joi.string().max(255).required(),
    password:   Joi.string().max(128).required(),
  }),
  deposit: Joi.object({
    amountETB: Joi.number().positive().min(10).max(500000).required(),
    provider:  Joi.string().valid('chapa','telebirr','cbebirr').required(),
    phone:     Joi.string().pattern(/^\+?[0-9]{9,15}$/).optional(),
    currency:  Joi.string().valid('ETB','USD').default('ETB'),
  }),
  transfer: Joi.object({
    toIdentifier: Joi.string().max(255).required(),
    amount:       Joi.number().positive().min(1).max(500000).required(),
    currency:     Joi.string().valid('ETB','USD').required(),
    note:         Joi.string().max(200).optional(),
  }),
  withdraw: Joi.object({
    amount:        Joi.number().positive().min(10).max(100000).required(),
    currency:      Joi.string().valid('ETB','USD').required(),
    provider:      Joi.string().valid('telebirr','cbebirr','bank').required(),
    accountNumber: Joi.string().max(50).required(),
  }),
  chatMessage: Joi.object({
    message:  Joi.string().min(1).max(2000).required(),
    language: Joi.string().valid('am','en','ti','om','fr','sw').optional(),
  }),
  product: Joi.object({
    title:       Joi.string().min(3).max(200).required(),
    titleAm:     Joi.string().max(200).optional(),
    description: Joi.string().max(2000).optional(),
    category:    Joi.string().valid('electronics','clothing','food','digital','crafts','books','services','other').required(),
    productType: Joi.string().valid('physical','digital').default('physical'),
    priceETB:    Joi.number().positive().min(1).required(),
    stock:       Joi.number().integer().min(0).default(1),
    location:    Joi.string().max(100).optional(),
  }),
};

// ── VALIDATE MIDDLEWARE ───────────────────────────────────────────
function validate(schemaName) {
  return function(req, res, next) {
    const schema = schemas[schemaName];
    if (!schema) return next();
    const { error, value } = schema.validate(req.body, { abortEarly:false, stripUnknown:true });
    if (error) return res.status(400).json({
      error:'validation_error',
      details: error.details.map(d => ({ field:d.path.join('.'), msg:d.message })),
    });
    req.validatedBody = value;
    next();
  };
}

// ── SQL GUARD ─────────────────────────────────────────────────────
function sqlGuard(req, res, next) {
  const dangerous = /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE|EXEC)\b)/i;
  const str = JSON.stringify({ b:req.body||{}, q:req.query||{} });
  if (dangerous.test(str)) return res.status(400).json({ error:'invalid_input' });
  next();
}

// ── JWT MIDDLEWARES ───────────────────────────────────────────────
function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ','');
    if (!token) return res.status(401).json({ error:'no_token' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(err) {
    if (err.name === 'TokenExpiredError')
      return res.status(401).json({ error:'token_expired', message:'Please log in again' });
    return res.status(401).json({ error:'invalid_token' });
  }
}
function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_PASS)
    return res.status(403).json({ error:'forbidden' });
  next();
}
function optionalAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ','');
    if (token) req.user = jwt.verify(token, JWT_SECRET);
  } catch {}
  next();
}

module.exports = {
  helmetConfig,
  globalLimiter, authLimiter, paymentLimiter, chatLimiter, walletLimiter,
  validate, sqlGuard,
  auth, adminAuth, optionalAuth,
  schemas,
};
