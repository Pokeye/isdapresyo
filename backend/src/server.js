require('dotenv').config();

/*
  IsdaPresyo Backend (Express)

  Responsibilities:
  - Expose public REST endpoints under /api
  - Expose admin auth + protected write endpoints under /api/admin
  - Optionally serve the static frontend (/) and hidden admin page (/admin)

  Local development:
  - If DATABASE_URL is NOT set, the app runs in "demo mode" and uses an in-memory store.
  - In demo mode, a JWT secret is auto-generated (so you can log in without extra setup).
*/

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

const { pool } = require('./db');
const { fishPricesRouter } = require('./routes/fishPrices');
const { adminRouter } = require('./routes/admin');
const { gasPricesRouter } = require('./routes/gasPrices');
const { predictionsRouter } = require('./routes/predictions');
const { runPredictionJob } = require('./predictionService');
const predictionSchedule = require('./predictionSchedule');

const app = express();

const isProd = process.env.NODE_ENV === 'production';
const demoMode = !isProd && !process.env.DATABASE_URL;

// In demo mode (no DB yet), allow JWT to work without manual env setup.
if (demoMode && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
}

// In production, require critical configuration.
if (isProd) {
  const missing = [];
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (missing.length) {
    console.error(`FATAL: Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

app.set('trust proxy', 1);

// NOTE: `trust proxy` enables correct client IP / protocol detection behind reverse proxies
// (Render, Nginx, etc). This matters for rate limiting and optional HTTPS redirects.

// Optional HTTPS enforcement (useful behind a proxy like Render/Netlify).
// When enabled, redirects http -> https in production.

if (String(process.env.ENFORCE_HTTPS).toLowerCase() === 'true') {
  app.use((req, res, next) => {
    const proto = req.headers['x-forwarded-proto'];
    if (process.env.NODE_ENV === 'production' && proto && proto !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    }
    return next();
  });
}

app.use(helmet());
app.use(morgan('combined'));

// CORS: for local dev, allowing all origins is convenient.
// For production, set FRONTEND_ORIGIN to your Netlify (or other) domain.

const frontendOrigin = process.env.FRONTEND_ORIGIN;
app.use(
  cors({
    origin: frontendOrigin ? [frontendOrigin] : true,
    credentials: false,
  })
);

app.use(express.json({ limit: '64kb' }));

// Basic rate-limits to reduce abuse and accidental flooding.

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
app.use('/api/admin/login', loginLimiter);

// Render's default health check hits `/`.
// When hosting the frontend separately (SERVE_FRONTEND=false), return 200 here
// so the service is considered healthy.
const serveFrontend = String(process.env.SERVE_FRONTEND || 'true').toLowerCase() === 'true';
if (!serveFrontend) {
  app.head('/', (_req, res) => res.sendStatus(200));
  app.get('/', (_req, res) => res.status(200).send('OK'));
}

// Lightweight health endpoint used by the admin UI to detect demo mode.
function getDatabaseHostForDiagnostics() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.hostname || null;
  } catch {
    return 'invalid_DATABASE_URL';
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    demoMode,
    database: {
      configured: Boolean(process.env.DATABASE_URL),
      host: getDatabaseHostForDiagnostics(),
    },
  });
});

app.use('/api', fishPricesRouter);
app.use('/api', gasPricesRouter);
app.use('/api', predictionsRouter);
app.use('/api/admin', adminRouter);

// Optional: serve frontend from the same server (useful on Render/Heroku)
if (serveFrontend) {
  const adminPath = process.env.ADMIN_PATH || '/admin';
  const frontendRoot = path.join(__dirname, '..', '..', 'frontend');

  // Serves static files (frontend/index.html, CSS, JS, etc)
  // - `/` -> public UI
  // - `/admin` (or ADMIN_PATH) -> hidden admin UI
  // When deploying frontend separately (Netlify), set SERVE_FRONTEND=false.

  app.use(express.static(frontendRoot));

  app.get(adminPath, (_req, res) => {
    res.sendFile(path.join(frontendRoot, 'admin', 'index.html'));
  });

  app.get('/', (_req, res) => {
    res.sendFile(path.join(frontendRoot, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  // Avoid leaking internals
  console.error(err);
  res.status(500).json({ message: 'Server error' });
});

const port = Number(process.env.PORT || 3000);

async function ensureDbSchema() {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  console.log(`Ensuring DB schema from ${schemaPath}...`);
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  console.log('DB schema ensured.');
}

async function ensureBootstrapAdmin() {
  const username = String(process.env.BOOTSTRAP_ADMIN_USER || '').trim();
  const password = String(process.env.BOOTSTRAP_ADMIN_PASS || '');

  if (!username || !password) return;
  if (demoMode) {
    console.warn('BOOTSTRAP_ADMIN_* provided but demoMode=true; skipping admin bootstrap.');
    return;
  }

  console.log(`Bootstrapping admin user "${username}"...`);

  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO admin (username, password)
     VALUES ($1, $2)
     ON CONFLICT (username)
     DO UPDATE SET password = EXCLUDED.password`,
    [username, hash]
  );

  console.log(`Admin user "${username}" created/updated via BOOTSTRAP_ADMIN_*.`);
  console.warn('IMPORTANT: remove BOOTSTRAP_ADMIN_PASS from env vars after this deploy.');
}

async function start() {
  const autoDbInit = String(process.env.AUTO_DB_INIT || 'false').toLowerCase() === 'true';
  console.log(`Startup mode: NODE_ENV=${process.env.NODE_ENV || '(unset)'} demoMode=${demoMode}`);
  console.log(`AUTO_DB_INIT=${process.env.AUTO_DB_INIT || '(unset)'} (enabled=${autoDbInit})`);

  if (autoDbInit && !demoMode) {
    // Helpful for platforms where a "shell" is unavailable on free tier
    // or when you can't connect externally to Postgres (port 5432 blocked).
    try {
      await ensureDbSchema();
    } catch (e) {
      console.error('AUTO_DB_INIT failed; continuing startup without schema:', e);
    }
  } else if (autoDbInit && demoMode) {
    console.warn('AUTO_DB_INIT is enabled but demoMode=true; skipping schema init.');
  } else {
    console.log('AUTO_DB_INIT is disabled; skipping schema init.');
  }

  try {
    await ensureBootstrapAdmin();
  } catch (e) {
    console.error('Bootstrap admin failed (continuing startup):', e);
  }

  app.listen(port, () => {
    console.log(`IsdaPresyo backend listening on http://localhost:${port}`);

    if (demoMode) {
      console.warn('DEMO MODE: DATABASE_URL is not set. Using in-memory mock data (non-production only).');
      console.warn('DEMO MODE: Admin login uses DEMO_ADMIN_USER/DEMO_ADMIN_PASS (defaults: admin/admin123).');
    } else {
      if (!process.env.DATABASE_URL) {
        console.warn('WARN: DATABASE_URL is not set. API endpoints needing DB will fail until configured.');
      }
      if (!process.env.JWT_SECRET) {
        console.warn('WARN: JWT_SECRET is not set. Admin login will fail until configured.');
      }
    }

    // Automated prediction runner.
    // Note: this is an in-process scheduler. In multi-instance deployments you may
    // want a single scheduler or a DB-backed lock. For this MVP, upserts + unique
    // index keep it safe-ish.
    const enablePredictions = String(process.env.ENABLE_PREDICTIONS || 'true').toLowerCase() === 'true';
    const intervalDays = Math.max(1, Number(process.env.PREDICTION_INTERVAL_DAYS || 3));
    const intervalMs = intervalDays * 24 * 60 * 60 * 1000;

    predictionSchedule.configure({ isEnabled: enablePredictions, days: intervalDays });

    if (enablePredictions) {
      const run = async (reason) => {
        try {
          const r = await runPredictionJob();
          predictionSchedule.markRun(new Date());
          console.log(`Predictions generated (${reason}):`, r);
        } catch (e) {
          console.error('Prediction job failed:', e);
        }
      };

      // Run once shortly after boot (helps local dev).
      predictionSchedule.markScheduledFromNow(new Date());
      setTimeout(() => run('startup'), 2000);
      setInterval(() => run(`interval_${intervalDays}d`), intervalMs);
    }
  });
}

start().catch((err) => {
  console.error('FATAL: startup failed', err);
  process.exit(1);
});
