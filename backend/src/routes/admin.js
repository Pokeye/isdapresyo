const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { body, param } = require('express-validator');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { handleValidation } = require('../middleware/validation');
const { logAudit } = require('../audit');
const mockStore = require('../mockStore');
const { invalidatePrefix } = require('../cache');
const { getFishUploadsDir } = require('../uploads');

/*
  Admin routes.

  - POST /api/admin/login
    Validates credentials, then returns a JWT token.

  Demo mode:
  - Enabled when DATABASE_URL is not set and NODE_ENV != production.
  - Uses DEMO_ADMIN_USER/DEMO_ADMIN_PASS (defaults: admin/admin123).
  - Still issues a JWT so the admin UI works end-to-end without Postgres.
*/

const router = express.Router();

function normalizeFishType(input) {
  return String(input || '').trim();
}

function isDemoMode() {
  const isProd = process.env.NODE_ENV === 'production';
  return !isProd && !process.env.DATABASE_URL;
}

function isMissingAssetsTable(err) {
  return (
    err &&
    String(err.code || '') === '42P01' &&
    String(err.message || '').toLowerCase().includes('fish_type_assets')
  );
}

function slugifyFishType(fishType) {
  const s = normalizeFishType(fishType).toLowerCase();
  const slug = s
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return slug || 'fish';
}

function extensionForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
  if (m === 'image/png') return '.png';
  if (m === 'image/webp') return '.webp';
  return null;
}

const isProd = process.env.NODE_ENV === 'production';
const fishUploadsDir = getFishUploadsDir({ isProd });
try {
  fs.mkdirSync(fishUploadsDir, { recursive: true });
} catch {
  // ignore
}

const uploadFishImage = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, fishUploadsDir),
    filename: (req, file, cb) => {
      const fishType = normalizeFishType(req.params.fish_type);
      const ext = extensionForMime(file.mimetype) || path.extname(file.originalname || '').toLowerCase() || '.jpg';
      const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
      const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      const rand = crypto.randomBytes(6).toString('hex');
      const name = `${slugifyFishType(fishType)}_${stamp}_${rand}${safeExt === '.jpeg' ? '.jpg' : safeExt}`;
      cb(null, name);
    },
  }),
  limits: {
    fileSize: 3 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const ext = extensionForMime(file.mimetype);
    if (!ext) return cb(new Error('Only JPG, PNG, or WEBP images are allowed'));
    return cb(null, true);
  },
});

function uploadSingleFishImage(req, res, next) {
  try {
    fs.accessSync(fishUploadsDir, fs.constants.W_OK);
  } catch {
    return res.status(500).json({
      message:
        'Upload directory is not writable on this server. Configure UPLOADS_DIR to a writable path (or attach a persistent disk).',
    });
  }

  uploadFishImage.single('image')(req, res, (err) => {
    if (!err) return next();
    return res.status(400).json({ message: err.message || 'Upload failed' });
  });
}

// Wrap async route handlers so thrown errors go to Express' error middleware.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post(
  '/login',
  [
    body('username').isString().trim().isLength({ min: 1, max: 100 }),
    body('password').isString().isLength({ min: 1, max: 200 }),
  ],
  handleValidation,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;

    const isProd = process.env.NODE_ENV === 'production';
    const demoMode = !isProd && !process.env.DATABASE_URL;

    if (demoMode) {
      // Demo mode is meant for development only.
      // It allows the full admin UI flow (login -> JWT -> CRUD) without Postgres.
      const demoUser = process.env.DEMO_ADMIN_USER || 'admin';
      const demoPass = process.env.DEMO_ADMIN_PASS || 'admin123';

      if (username !== demoUser || password !== demoPass) {
        // Audit login failures for visibility (helpful during deployment / security review).
        logAudit({ type: 'login_failed_demo', ip: req.ip, path: req.originalUrl, detail: 'bad_demo_credentials' });
        return res.status(403).json({ message: 'Access denied' });
      }

      const token = jwt.sign(
        // JWT payload:
        // - `sub`: subject identifier
        // - `role`: checked by requireAdmin middleware
        { sub: 'demo-admin', username: demoUser, role: 'admin', demo: true },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
      );

      return res.json({ token, username: demoUser, demoMode: true });
    }

    // Normal mode: authenticate against the admin table in Postgres.
    const result = await pool.query('SELECT id, username, password FROM admin WHERE username = $1 LIMIT 1', [username]);
    const admin = result.rows[0];

    if (!admin) {
      logAudit({ type: 'login_failed', ip: req.ip, path: req.originalUrl, detail: 'unknown_user' });
      return res.status(403).json({ message: 'Access denied' });
    }

    const ok = await bcrypt.compare(password, admin.password);
    if (!ok) {
      logAudit({ type: 'login_failed', ip: req.ip, path: req.originalUrl, detail: 'bad_password' });
      return res.status(403).json({ message: 'Access denied' });
    }

    const token = jwt.sign(
      // Production/DB mode token identifies the admin row by id.
      { sub: String(admin.id), username: admin.username, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    return res.json({ token, username: admin.username });
  })
);

// Admin: upload/update fish type image.
// POST /api/admin/fish-types/:fish_type/image (multipart/form-data, field: image)
router.post(
  '/fish-types/:fish_type/image',
  requireAdmin,
  [param('fish_type').isString().trim().isLength({ min: 1, max: 100 })],
  handleValidation,
  uploadSingleFishImage,
  asyncHandler(async (req, res) => {
    const fishType = normalizeFishType(req.params.fish_type);
    if (!req.file) return res.status(400).json({ message: 'Missing image file' });

    const imageUrl = `/uploads/fish/${req.file.filename}`;

    // Audit for traceability.
    logAudit({
      type: 'fish_image_upload',
      ip: req.ip,
      path: req.originalUrl,
      detail: `fish_type=${fishType}`,
    });

    if (isDemoMode()) {
      mockStore.setFishTypeImageUrl(fishType, imageUrl);
      invalidatePrefix('fish-prices:');
      invalidatePrefix('fish-types');
      invalidatePrefix('predictions:predicted-fish-prices');
      return res.status(201).json({ fish_type: fishType, image_url: imageUrl });
    }

    let result;
    try {
      result = await pool.query(
        `INSERT INTO fish_type_assets (fish_type, image_url, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (fish_type)
         DO UPDATE SET image_url = EXCLUDED.image_url, updated_at = NOW()
         RETURNING fish_type, image_url, updated_at::text AS updated_at`,
        [fishType, imageUrl]
      );
    } catch (e) {
      if (!isMissingAssetsTable(e)) throw e;

      // Self-heal: create the table then retry once.
      await pool.query(
        `CREATE TABLE IF NOT EXISTS fish_type_assets (
           fish_type VARCHAR(100) PRIMARY KEY,
           image_url TEXT,
           updated_at TIMESTAMP NOT NULL DEFAULT NOW()
         )`
      );
      result = await pool.query(
        `INSERT INTO fish_type_assets (fish_type, image_url, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (fish_type)
         DO UPDATE SET image_url = EXCLUDED.image_url, updated_at = NOW()
         RETURNING fish_type, image_url, updated_at::text AS updated_at`,
        [fishType, imageUrl]
      );
    }

    invalidatePrefix('fish-prices:');
    invalidatePrefix('fish-types');
    invalidatePrefix('predictions:predicted-fish-prices');

    return res.status(201).json(result.rows[0]);
  })
);

module.exports = { adminRouter: router };
