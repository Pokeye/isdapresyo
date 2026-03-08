const express = require('express');
const { param, query } = require('express-validator');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { handleValidation } = require('../middleware/validation');
const { runPredictionJob, isDemoMode } = require('../predictionService');
const mockStore = require('../mockStore');
const predictionSchedule = require('../predictionSchedule');

const router = express.Router();

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get(
  '/predictions',
  [
    query('fish_type').optional().isString().trim().isLength({ min: 1, max: 100 }),
    query('from').optional().isISO8601().toDate(),
    query('to').optional().isISO8601().toDate(),
  ],
  handleValidation,
  asyncHandler(async (req, res) => {
    const fishType = req.query.fish_type ? String(req.query.fish_type).trim() : null;
    const from = req.query.from ? new Date(req.query.from).toISOString().slice(0, 10) : null;
    const to = req.query.to ? new Date(req.query.to).toISOString().slice(0, 10) : null;

    if (isDemoMode()) {
      return res.json(mockStore.listPredictions({ fishType, from, to }));
    }

    const clauses = [];
    const args = [];

    if (fishType) {
      args.push(fishType);
      clauses.push(`fish_type = $${args.length}`);
    }
    if (from) {
      args.push(from);
      clauses.push(`prediction_date >= $${args.length}::date`);
    }
    if (to) {
      args.push(to);
      clauses.push(`prediction_date <= $${args.length}::date`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT id, fish_type, predicted_min_price, predicted_max_price, predicted_avg_price,
              prediction_date::text AS prediction_date, algorithm_used, created_at
       FROM predictions
       ${where}
       ORDER BY prediction_date ASC, fish_type ASC, id ASC
       LIMIT 500`,
      args
    );

    return res.json(result.rows);
  })
);

// Public: schedule status so the UI can show a countdown.
router.get('/predictions/schedule', (_req, res) => {
  return res.json(predictionSchedule.getStatus(new Date()));
});

function algoPreferenceOrderSql() {
  // Prefer linear regression when available.
  // Lower value = higher priority.
  return `CASE
    WHEN algorithm_used = 'linear_regression_gas' THEN 0
    WHEN algorithm_used = 'moving_average' THEN 1
    ELSE 2
  END`;
}

// Public: predicted price list for the next available prediction date.
// Response is shaped like /api/fish-prices so the public UI can reuse rendering.
router.get(
  '/predicted-fish-prices',
  asyncHandler(async (_req, res) => {
    if (isDemoMode()) {
      const all = mockStore.listPredictions();
      const today = new Date().toISOString().slice(0, 10);
      const nextDate = all
        .map((r) => String(r.prediction_date))
        .filter((d) => d >= today)
        .sort()[0];

      if (!nextDate) return res.json([]);

      const rows = all
        .filter((r) => String(r.prediction_date) === nextDate)
        .sort((a, b) => String(a.fish_type).localeCompare(String(b.fish_type)))
        .map((r) => ({
          id: r.id,
          fish_type: r.fish_type,
          min_price: r.predicted_min_price,
          max_price: r.predicted_max_price,
          avg_price: r.predicted_avg_price,
          date_updated: String(r.prediction_date),
        }));

      return res.json(rows);
    }

    const result = await pool.query(
      `WITH next_date AS (
         SELECT MIN(prediction_date) AS d
         FROM predictions
         WHERE prediction_date >= CURRENT_DATE
       )
       SELECT DISTINCT ON (p.fish_type)
         p.id,
         p.fish_type,
         p.predicted_min_price AS min_price,
         p.predicted_max_price AS max_price,
         p.predicted_avg_price AS avg_price,
         p.prediction_date::text AS date_updated
       FROM predictions p
       JOIN next_date nd ON p.prediction_date = nd.d
       ORDER BY p.fish_type,
                ${algoPreferenceOrderSql()} ASC,
                p.created_at DESC,
                p.id DESC`
    );

    return res.json(result.rows);
  })
);

// Public: predicted price row for a single fish type.
router.get(
  '/predicted-fish-prices/:fish_type',
  [param('fish_type').isString().trim().isLength({ min: 1, max: 100 })],
  handleValidation,
  asyncHandler(async (req, res) => {
    const fishType = String(req.params.fish_type).trim();

    if (isDemoMode()) {
      const all = mockStore.listPredictions({ fishType });
      const today = new Date().toISOString().slice(0, 10);
      const next = all
        .filter((r) => String(r.prediction_date) >= today)
        .sort((a, b) => String(a.prediction_date).localeCompare(String(b.prediction_date)))[0];
      if (!next) return res.status(404).json({ message: 'Not found' });

      return res.json({
        id: next.id,
        fish_type: next.fish_type,
        min_price: next.predicted_min_price,
        max_price: next.predicted_max_price,
        avg_price: next.predicted_avg_price,
        date_updated: String(next.prediction_date),
      });
    }

    const result = await pool.query(
      `SELECT id,
              fish_type,
              predicted_min_price AS min_price,
              predicted_max_price AS max_price,
              predicted_avg_price AS avg_price,
              prediction_date::text AS date_updated
       FROM predictions
       WHERE fish_type = $1
         AND prediction_date >= CURRENT_DATE
       ORDER BY prediction_date ASC,
                ${algoPreferenceOrderSql()} ASC,
                created_at DESC,
                id DESC
       LIMIT 1`,
      [fishType]
    );

    const row = result.rows[0];
    if (!row) return res.status(404).json({ message: 'Not found' });
    return res.json(row);
  })
);

router.get(
  '/predictions/:fish_type',
  [param('fish_type').isString().trim().isLength({ min: 1, max: 100 })],
  handleValidation,
  asyncHandler(async (req, res) => {
    const fishType = String(req.params.fish_type).trim();

    if (isDemoMode()) {
      return res.json(mockStore.listPredictions({ fishType }));
    }

    const result = await pool.query(
      `SELECT id, fish_type, predicted_min_price, predicted_max_price, predicted_avg_price,
              prediction_date::text AS prediction_date, algorithm_used, created_at
       FROM predictions
       WHERE fish_type = $1
       ORDER BY prediction_date ASC, id ASC
       LIMIT 500`,
      [fishType]
    );

    return res.json(result.rows);
  })
);

// Admin: manually trigger prediction run.
router.post(
  '/admin/predictions/run',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const r = await runPredictionJob();
    return res.json(r);
  })
);

module.exports = { predictionsRouter: router };
