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
const exposeDiagnostics = String(process.env.EXPOSE_DIAGNOSTICS || 'false').toLowerCase() === 'true';

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

// Basic caching for public GET endpoints.
// Helps browsers/CDNs avoid refetching the same data repeatedly (especially during bot/traffic spikes).
app.use((req, res, next) => {
  if (req.method === 'GET' && req.path.startsWith('/api/') && !req.path.startsWith('/api/admin')) {
    // Fish prices and fish type lists are actively edited by admins.
    // Avoid caching them in browsers/CDNs so cross-device updates show up immediately.
    const noStorePrefixes = ['/api/fish-types', '/api/fish-prices'];
    const isNoStore = noStorePrefixes.some((p) => req.path === p || req.path.startsWith(`${p}/`));
    res.setHeader('Cache-Control', isNoStore ? 'no-store' : 'public, max-age=60');
  }
  return next();
});

// CORS: for local dev, allowing all origins is convenient.
// For production, set FRONTEND_ORIGIN to your Netlify (or other) domain.

function parseAllowedOrigins(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const allowedOrigins = parseAllowedOrigins(process.env.FRONTEND_ORIGIN);

if (isProd && !allowedOrigins.length) {
  console.warn('WARN: FRONTEND_ORIGIN is not set; allowing all cross-origin requests (no credentials).');
  console.warn('      Recommended: set FRONTEND_ORIGIN to your exact frontend origin to restrict access.');
}

app.use(
  cors({
    // Same-origin requests (backend serving the frontend) do not require CORS.
    // For separately hosted frontends (Vercel/Netlify), allow-listing is recommended.
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.length > 0) return cb(null, allowedOrigins.includes(origin));
      // If FRONTEND_ORIGIN is not configured, default to allowing cross-origin requests.
      // This avoids broken deployments where the frontend cannot reach the API.
      return cb(null, true);
    },
    credentials: false,
  })
);

app.use(express.json({ limit: '64kb' }));

// Publicly serve uploaded assets (fish photos, etc.).
// NOTE: This stores files on the server filesystem. In serverless/ephemeral hosting,
// use object storage instead.
const uploadsRoot = path.join(__dirname, '..', 'uploads');
try {
  fs.mkdirSync(uploadsRoot, { recursive: true });
} catch {
  // ignore
}
app.use(
  '/uploads',
  express.static(uploadsRoot, {
    maxAge: isProd ? '30d' : 0,
    etag: true,
    fallthrough: true,
  })
);

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
      host: isProd && !exposeDiagnostics ? null : getDatabaseHostForDiagnostics(),
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

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(s) {
  const h = crypto.createHash('sha256').update(String(s)).digest();
  return h.readUInt32LE(0);
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function titleCase(s) {
  return String(s)
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

// Seed ranges (based on your Nov/Dec/Jan list). Used only when explicitly enabled.
const SEED_FISH_RANGES = [
  { fish_type: 'Bangus', min: 200, max: 250 },
  { fish_type: 'Tilapia', min: 130, max: 180 },
  { fish_type: 'Galunggong', min: 200, max: 320 },
  { fish_type: 'Tulingan', min: 360, max: 420 },
  { fish_type: 'Alumahan', min: 300, max: 300 },
  { fish_type: 'Pusit', min: 380, max: 450 },
  { fish_type: 'Pompano', min: 380, max: 380 },
  { fish_type: 'Tambakol', min: 200, max: 360 },
  { fish_type: 'Pasagan', min: 360, max: 360 },
  { fish_type: 'Tangigue', min: 380, max: 380 },
  { fish_type: 'Matambaka', min: 180, max: 250 },
  { fish_type: 'Pakol', min: 380, max: 420 },
  { fish_type: 'Sibubog', min: 180, max: 240 },
  { fish_type: 'Butete', min: 320, max: 380 },
  { fish_type: 'Pagi', min: 380, max: 450 },
  { fish_type: 'Shrimp', min: 280, max: 450 },
  { fish_type: 'Tahong', min: 80, max: 120 },
  { fish_type: 'Lato', min: 80, max: 300 },
  { fish_type: 'Suga', min: 180, max: 240 },
  { fish_type: 'Sapsap', min: 120, max: 180 },
  { fish_type: 'Dilis', min: 140, max: 220 },
  { fish_type: 'Lapu-Lapu', min: 450, max: 800 },
  { fish_type: 'Malasugi', min: 380, max: 550 },
  { fish_type: 'Hasa-Hasa', min: 200, max: 260 },
  { fish_type: 'Maya-Maya', min: 300, max: 500 },
  { fish_type: 'Pating', min: 400, max: 1200 },
  { fish_type: 'Kitang', min: 200, max: 300 },
  { fish_type: 'Mamsa', min: 140, max: 260 },
  { fish_type: 'Asuhos', min: 180, max: 260 },
  { fish_type: 'Bisugo', min: 240, max: 340 },
  { fish_type: 'Law-law', min: 100, max: 220 },
];

// Optional gasoline monthly ranges (used only if month is present).
const SEED_GAS_MONTHLY_RANGES = [
  { month: '2025-12', min: 64, max: 65 },
  { month: '2026-01', min: 65, max: 66 },
  { month: '2026-02', min: 66, max: 67 },
  { month: '2026-03', min: 67, max: 68 },
];

function gasRangeForDate(dateIso) {
  const month = String(dateIso).slice(0, 7);
  return SEED_GAS_MONTHLY_RANGES.find((m) => m.month === month) || null;
}

function synthFishRow({ fish_type, overallMin, overallMax, dateIso }) {
  const ft = titleCase(fish_type);

  if (overallMin === overallMax) {
    return {
      fish_type: ft,
      min_price: overallMin,
      max_price: overallMax,
      avg_price: overallMin,
      date_updated: dateIso,
    };
  }

  const rand = mulberry32(seedFromString(`${ft}|${dateIso}`));
  const span = overallMax - overallMin;

  const avg = overallMin + rand() * span;

  // Band width varies per date.
  const maxBand = Math.max(1, span * (0.08 + rand() * 0.18));
  const down = rand() * Math.min(maxBand, avg - overallMin);
  const up = rand() * Math.min(maxBand, overallMax - avg);

  const minP = avg - down;
  const maxP = avg + up;

  return {
    fish_type: ft,
    min_price: round2(Math.max(overallMin, minP)),
    max_price: round2(Math.min(overallMax, maxP)),
    avg_price: round2(Math.min(Math.max(avg, overallMin), overallMax)),
    date_updated: dateIso,
  };
}

function synthGasRow({ dateIso }) {
  const range = gasRangeForDate(dateIso);
  if (!range) return null;

  const rand = mulberry32(seedFromString(`gasoline|${dateIso}`));
  const price = range.min + rand() * (range.max - range.min);

  return {
    date: dateIso,
    price: round2(price),
  };
}

async function seedSyntheticIfEmpty() {
  const enabled = String(process.env.SEED_SYNTHETIC_ON_START || 'false').toLowerCase() === 'true';
  if (!enabled) return;
  if (demoMode) {
    console.warn('SEED_SYNTHETIC_ON_START enabled but demoMode=true; skipping.');
    return;
  }

  const existing = await pool.query('SELECT COUNT(*)::int AS n FROM fish_prices');
  const n = Number(existing.rows?.[0]?.n || 0);
  if (n > 0) {
    console.log(`Synthetic seed skipped: fish_prices already has ${n} row(s).`);
    return;
  }

  const intervalDaysRaw = Number(process.env.SEED_SYNTHETIC_INTERVAL_DAYS || 3);
  const daysBackRaw = Number(process.env.SEED_SYNTHETIC_DAYS_BACK || 120);
  const intervalDays = Number.isFinite(intervalDaysRaw) && intervalDaysRaw > 0 ? Math.floor(intervalDaysRaw) : 3;
  const daysBack = Number.isFinite(daysBackRaw) && daysBackRaw > 0 ? Math.floor(daysBackRaw) : 120;

  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = addDays(end, -daysBack);

  const dates = [];
  for (let d = new Date(start.getTime()); d <= end; d = addDays(d, intervalDays)) {
    dates.push(isoDate(d));
  }

  console.log(`Seeding synthetic fish history from ${isoDate(start)} to ${isoDate(end)} every ${intervalDays} day(s)...`);
  await pool.query('BEGIN');
  try {
    // Gas (optional).
    let gasUpserted = 0;
    for (const dateIso of dates) {
      const gas = synthGasRow({ dateIso });
      if (!gas) continue;
      await pool.query(
        `INSERT INTO gas_prices (date, price)
         VALUES ($1::date, $2)
         ON CONFLICT (date)
         DO UPDATE SET price = EXCLUDED.price`,
        [gas.date, gas.price]
      );
      gasUpserted++;
    }

    // Fish.
    let fishInserted = 0;
    for (const fr of SEED_FISH_RANGES) {
      for (const dateIso of dates) {
        const row = synthFishRow({
          fish_type: fr.fish_type,
          overallMin: Number(fr.min),
          overallMax: Number(fr.max),
          dateIso,
        });

        await pool.query(
          `INSERT INTO fish_prices (fish_type, min_price, max_price, avg_price, date_updated)
           VALUES ($1, $2, $3, $4, $5::date)`,
          [row.fish_type, row.min_price, row.max_price, row.avg_price, row.date_updated]
        );
        fishInserted++;
      }
    }

    await pool.query('COMMIT');
    console.log(`Synthetic seed complete. Inserted fish rows: ${fishInserted}. Upserted gas rows: ${gasUpserted}.`);
    console.warn('IMPORTANT: remove SEED_SYNTHETIC_ON_START from env vars after this deploy.');
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  }
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

  try {
    await seedSyntheticIfEmpty();
  } catch (e) {
    console.error('Synthetic seed failed (continuing startup):', e);
  }

  const server = app.listen(port, () => {
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

      // Run once shortly after boot.
      // Optimization: avoid hammering the DB right after every restart when predictions already exist.
      predictionSchedule.markScheduledFromNow(new Date());
      setTimeout(async () => {
        if (demoMode) {
          return run('startup_demo');
        }

        try {
          const existing = await pool.query(
            'SELECT 1 FROM predictions WHERE prediction_date >= CURRENT_DATE LIMIT 1'
          );
          if (existing.rows && existing.rows.length) {
            console.log('Startup prediction run skipped: future predictions already exist.');
            return;
          }
        } catch (e) {
          // If the check fails (e.g., schema missing), fall back to attempting a run.
          console.warn('Startup prediction existence check failed; attempting run anyway.');
        }

        return run('startup');
      }, 2000);
      setInterval(() => run(`interval_${intervalDays}d`), intervalMs);
    }
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`FATAL: Port ${port} is already in use.`);
      console.error('Stop the other process using this port, or start with a different PORT.');
      console.error('Examples:');
      console.error('  PowerShell: $env:PORT=3001; npm start');
      console.error('  cmd.exe:    set PORT=3001 && npm start');
      process.exit(1);
      return;
    }

    console.error('FATAL: server listen error', err);
    process.exit(1);
  });
}

start().catch((err) => {
  console.error('FATAL: startup failed', err);
  process.exit(1);
});
