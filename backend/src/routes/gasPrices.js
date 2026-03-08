const express = require('express');
const { body, param, query } = require('express-validator');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { handleValidation } = require('../middleware/validation');
const { isDemoMode } = require('../predictionService');
const mockStore = require('../mockStore');

const router = express.Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get(
  '/gas-prices',
  [query('from').optional().isISO8601().toDate(), query('to').optional().isISO8601().toDate()],
  handleValidation,
  asyncHandler(async (req, res) => {
    const from = req.query.from ? new Date(req.query.from).toISOString().slice(0, 10) : null;
    const to = req.query.to ? new Date(req.query.to).toISOString().slice(0, 10) : null;

    if (isDemoMode()) {
      return res.json(mockStore.listGasPrices({ from, to }));
    }

    const clauses = [];
    const args = [];
    if (from) {
      args.push(from);
      clauses.push(`date >= $${args.length}::date`);
    }
    if (to) {
      args.push(to);
      clauses.push(`date <= $${args.length}::date`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT id, date::text AS date, price, created_at
       FROM gas_prices
       ${where}
       ORDER BY date ASC, id ASC
       LIMIT 500`,
      args
    );

    // NOTE: Postgres DATE should be treated as a plain date string (avoid timezone shifts).
    const rows = result.rows.map((r) => ({
      ...r,
      date: String(r.date),
    }));

    return res.json(rows);
  })
);

// Admin: upsert gas price for a date.
router.post(
  '/gas-prices',
  requireAdmin,
  [body('date').isISO8601().toDate(), body('price').isFloat({ min: 0 }).toFloat()],
  handleValidation,
  asyncHandler(async (req, res) => {
    const date = new Date(req.body.date).toISOString().slice(0, 10);
    const price = Number(req.body.price);

    if (isDemoMode()) {
      const row = mockStore.upsertGasPrice({ date, price });
      return res.status(201).json(row);
    }

    const result = await pool.query(
      `INSERT INTO gas_prices (date, price)
       VALUES ($1::date, $2)
       ON CONFLICT (date)
       DO UPDATE SET price = EXCLUDED.price
       RETURNING id, date::text AS date, price, created_at`,
      [date, price]
    );

    const row = result.rows[0];
    return res.status(201).json({ ...row, date: String(row.date) });
  })
);

router.delete(
  '/gas-prices/:date',
  requireAdmin,
  [param('date').isISO8601().toDate()],
  handleValidation,
  asyncHandler(async (req, res) => {
    const date = new Date(req.params.date).toISOString().slice(0, 10);

    if (isDemoMode()) {
      const ok = mockStore.removeGasPrice(date);
      if (!ok) return res.status(404).json({ message: 'Not found' });
      return res.json({ ok: true });
    }

    const result = await pool.query('DELETE FROM gas_prices WHERE date = $1::date RETURNING id', [date]);
    if (!result.rows[0]) return res.status(404).json({ message: 'Not found' });
    return res.json({ ok: true });
  })
);

module.exports = { gasPricesRouter: router };
