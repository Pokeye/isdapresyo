const { pool } = require('./db');
const mockStore = require('./mockStore');
const { predictNext } = require('./predictionEngine');

function isDemoMode() {
  return process.env.NODE_ENV !== 'production' && !process.env.DATABASE_URL;
}

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function coerceDays(n, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.floor(v);
}

async function loadFishTypesDb() {
  const result = await pool.query('SELECT fish_type FROM fish_prices GROUP BY fish_type ORDER BY fish_type ASC');
  return result.rows.map((r) => r.fish_type);
}

async function loadTrainingRowsDb(fishType, daysBack) {
  // Ascending by date so time index increases.
  const result = await pool.query(
    `SELECT fish_type, min_price, max_price, avg_price, date_updated::text AS date_updated
     FROM fish_prices
     WHERE fish_type = $1
       AND date_updated >= (CURRENT_DATE - ($2::int * INTERVAL '1 day'))
     ORDER BY date_updated ASC, id ASC`,
    [fishType, daysBack]
  );
  return result.rows;
}

async function loadGasByDateDb(daysBack) {
  const result = await pool.query(
    `SELECT date::text AS date, price
     FROM gas_prices
     WHERE date >= (CURRENT_DATE - ($1::int * INTERVAL '1 day'))
     ORDER BY date ASC`,
    [daysBack]
  );

  const byDate = Object.create(null);
  for (const r of result.rows) {
    const d = String(r.date);
    byDate[d] = Number(r.price);
  }
  return byDate;
}

function forwardFillGas(priceRows, gasByDate) {
  // If gas is missing for a fish price date, fill with the most recent gas price.
  const filled = Object.create(null);
  let last = null;

  // Sort all gas dates so we can walk them.
  const gasDates = Object.keys(gasByDate || {}).sort();
  let gIdx = 0;

  for (const row of priceRows) {
    const date = String(row.date_updated);
    while (gIdx < gasDates.length && gasDates[gIdx] <= date) {
      const v = Number(gasByDate[gasDates[gIdx]]);
      if (Number.isFinite(v)) last = v;
      gIdx++;
    }
    if (last != null) filled[date] = last;
    else if (gasByDate && gasByDate[date] != null) filled[date] = Number(gasByDate[date]);
  }

  return filled;
}

async function upsertPredictionsDb(fishType, predictions) {
  for (const p of predictions) {
    await pool.query(
      `INSERT INTO predictions (
         fish_type,
         predicted_min_price,
         predicted_max_price,
         predicted_avg_price,
         prediction_date,
         algorithm_used
       ) VALUES ($1, $2, $3, $4, $5::date, $6)
       ON CONFLICT (fish_type, prediction_date, algorithm_used)
       DO UPDATE SET
         predicted_min_price = EXCLUDED.predicted_min_price,
         predicted_max_price = EXCLUDED.predicted_max_price,
         predicted_avg_price = EXCLUDED.predicted_avg_price,
         created_at = NOW()`,
      [
        fishType,
        Number(p.predicted_min_price),
        Number(p.predicted_max_price),
        Number(p.predicted_avg_price),
        p.prediction_date,
        String(p.algorithm_used),
      ]
    );
  }
}

async function runPredictionJob(options = {}) {
  const daysBack = coerceDays(options.daysBack, coerceDays(process.env.PREDICTION_TRAINING_DAYS, 90));
  const horizonDays = coerceDays(options.horizonDays, coerceDays(process.env.PREDICTION_HORIZON_DAYS, 3));

  if (isDemoMode()) {
    const fishTypes = mockStore.listFishTypes();
    const gasByDate = mockStore.listGasByDate(daysBack);

    for (const fishType of fishTypes) {
      const rows = mockStore.listHistoryByFishType(fishType, daysBack);
      if (!rows.length) continue;
      const gasFilled = forwardFillGas(rows, gasByDate);
      const preds = predictNext({ priceRows: rows, gasByDate: gasFilled, horizonDays });
      mockStore.upsertPredictions(fishType, preds);
    }

    return { ok: true, demoMode: true, daysBack, horizonDays };
  }

  const fishTypes = await loadFishTypesDb();
  const gasByDateRaw = await loadGasByDateDb(daysBack);

  for (const fishType of fishTypes) {
    const rows = await loadTrainingRowsDb(fishType, daysBack);
    if (!rows.length) continue;

    const gasFilled = forwardFillGas(rows, gasByDateRaw);
    const preds = predictNext({ priceRows: rows, gasByDate: gasFilled, horizonDays });
    await upsertPredictionsDb(fishType, preds);
  }

  return { ok: true, demoMode: false, daysBack, horizonDays };
}

module.exports = {
  runPredictionJob,
  isDemoMode,
};
