// ================================================================
//  OmniHub — monitoring.js  (D: Error Monitoring)
//  Sentry + Health Check + Performance Metrics + Global Error Handler
//  Install: npm install @sentry/node @sentry/profiling-node
// ================================================================
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ── D1. SENTRY (optional — works without it) ──────────────────────
let Sentry;
try { Sentry = require('@sentry/node'); } catch(e) { Sentry = null; }

function initSentry(app) {
  if (!Sentry || !process.env.SENTRY_DSN) {
    console.warn('[Sentry] Disabled — no DSN set');
    return;
  }
  Sentry.init({
    dsn:         process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    release:     `omnihub@1.0.0`,
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    beforeSend(event) {
      // Scrub sensitive fields
      if (event.request?.headers?.authorization)
        event.request.headers.authorization = '[REDACTED]';
      if (event.request?.data?.password)
        event.request.data.password = '[REDACTED]';
      return event;
    },
  });
  console.log('[Sentry] Error monitoring active ✅');
}

function sentryRequestHandler() {
  if (!Sentry || !process.env.SENTRY_DSN) return (req, res, next) => next();
  return Sentry.Handlers.requestHandler();
}
function sentryTracingHandler() {
  if (!Sentry || !process.env.SENTRY_DSN) return (req, res, next) => next();
  return Sentry.Handlers.tracingHandler();
}
function sentryErrorHandler() {
  if (!Sentry || !process.env.SENTRY_DSN) return (err, req, res, next) => next(err);
  return Sentry.Handlers.errorHandler({
    shouldHandleError: err => (err.status || 500) >= 400,
  });
}

// ── D2. MANUAL CAPTURE ────────────────────────────────────────────
function captureError(err, context = {}) {
  console.error('[ERROR]', err?.message || err, context);
  if (Sentry && process.env.SENTRY_DSN) {
    Sentry.withScope(scope => {
      Object.entries(context).forEach(([k,v]) => scope.setExtra(k, v));
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
    });
  }
}
function captureMessage(msg, level = 'info', context = {}) {
  if (Sentry && process.env.SENTRY_DSN) {
    Sentry.withScope(scope => {
      scope.setLevel(level);
      Object.entries(context).forEach(([k,v]) => scope.setExtra(k, v));
      Sentry.captureMessage(msg);
    });
  }
}

// ── D3. HEALTH CHECK ─────────────────────────────────────────────
async function healthCheck(req, res) {
  const t0 = Date.now();
  const checks = {
    server:   { status:'ok', uptime: Math.floor(process.uptime()) },
    database: { status:'unknown' },
    memory:   { status:'ok' },
    ai:       { status: process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing' },
    payments: { status: process.env.CHAPA_SECRET_KEY   ? 'configured' : 'missing' },
  };

  // DB ping
  try {
    await db.query('SELECT 1');
    checks.database = { status:'ok', latencyMs: Date.now()-t0 };
  } catch(e) {
    checks.database = { status:'error', message: e.message };
  }

  // Memory
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed/1024/1024);
  checks.memory = {
    status:      heapMB > 450 ? 'warning' : 'ok',
    heapUsedMB:  heapMB,
    heapTotalMB: Math.round(mem.heapTotal/1024/1024),
  };

  const allOk = checks.database.status === 'ok';
  res.status(allOk ? 200 : 503).json({
    status:  allOk ? 'ok' : 'degraded',
    version: '1.0.0',
    env:     process.env.NODE_ENV || 'development',
    checks,
    totalMs: Date.now()-t0,
  });
}

// ── D4. PERFORMANCE METRICS ───────────────────────────────────────
const metrics = {
  bingoGamesStarted:   0,
  bingoWinsClaimed:    0,
  depositsInitiated:   0,
  depositsCompleted:   0,
  apiCallsTotal:       0,
  apiCallsFailed:      0,
  aiChatMessages:      0,
  activeSocketClients: 0,
};

function metricsMiddleware(req, res, next) {
  metrics.apiCallsTotal++;
  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now()-t0;
    if (res.statusCode >= 500) metrics.apiCallsFailed++;
    if (ms > 3000) console.warn(`[SLOW] ${req.method} ${req.path} ${ms}ms`);
  });
  next();
}

function getMetrics(req, res) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_PASS)
    return res.status(403).json({ error:'forbidden' });
  res.json({
    ...metrics,
    uptime:      Math.floor(process.uptime()),
    memoryMB:    Math.round(process.memoryUsage().heapUsed/1024/1024),
    nodeVersion: process.version,
    timestamp:   new Date().toISOString(),
  });
}

// ── D5. GLOBAL ERROR HANDLER (mount last in Express) ──────────────
function globalErrorHandler(err, req, res, next) {
  captureError(err, {
    path:   req.path,
    method: req.method,
    userId: req.user?.id || 'anon',
  });
  const isDev = process.env.NODE_ENV === 'development';
  res.status(err.status || 500).json({
    error:   err.code    || 'internal_server_error',
    message: err.message || 'Something went wrong',
    ...(isDev && { stack: err.stack }),
  });
}

// ── D6. PROCESS HANDLERS ──────────────────────────────────────────
function attachProcessHandlers() {
  process.on('unhandledRejection', reason => {
    console.error('[UNHANDLED REJECTION]', reason);
    captureError(reason instanceof Error ? reason : new Error(String(reason)));
  });
  process.on('uncaughtException', err => {
    console.error('[UNCAUGHT EXCEPTION]', err);
    captureError(err);
    setTimeout(() => process.exit(1), 2000);
  });
}

module.exports = {
  initSentry, sentryRequestHandler, sentryTracingHandler,
  sentryErrorHandler, captureError, captureMessage,
  healthCheck, metricsMiddleware, getMetrics,
  globalErrorHandler, attachProcessHandlers, metrics,
};
