// Demo-mode data store.
// Used when DATABASE_URL is not set (non-production only).
// This data is in-memory and will reset when the server restarts.

const demoRows = [
  {
    id: 1,
    fish_type: 'Galunggong',
    min_price: 120,
    max_price: 160,
    avg_price: 140,
    date_updated: '2026-01-22',
  },
  {
    id: 2,
    fish_type: 'Tamban',
    min_price: 80,
    max_price: 110,
    avg_price: 95,
    date_updated: '2026-01-22',
  },
];

let rows = [...demoRows];
let nextId = Math.max(...rows.map((r) => r.id), 0) + 1;

let gasPrices = [
  { id: 1, date: '2026-01-22', price: 70.5, created_at: new Date().toISOString() },
];
let nextGasId = Math.max(...gasPrices.map((r) => r.id), 0) + 1;

let predictions = [];
let nextPredictionId = 1;

function toIsoDate(value) {
  // Keep demo-mode dates consistent with the DB shape (YYYY-MM-DD).
  if (!value) return new Date().toISOString().slice(0, 10);

  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
    return new Date().toISOString().slice(0, 10);
  }

  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function listLatestByType() {
  const latest = new Map();
  for (const row of rows) {
    const key = String(row.fish_type);
    const prev = latest.get(key);
    if (!prev) {
      latest.set(key, row);
      continue;
    }

    const prevDate = new Date(prev.date_updated).getTime();
    const rowDate = new Date(row.date_updated).getTime();
    if (rowDate > prevDate || (rowDate === prevDate && row.id > prev.id)) {
      latest.set(key, row);
    }
  }

  return Array.from(latest.values()).sort((a, b) => String(a.fish_type).localeCompare(String(b.fish_type)));
}

function listFishTypes() {
  return Array.from(new Set(rows.map((r) => r.fish_type))).sort((a, b) => String(a).localeCompare(String(b)));
}

function getLatestByFishType(fishType) {
  const matches = rows
    .filter((r) => String(r.fish_type) === String(fishType))
    .sort((a, b) => {
      const ad = new Date(a.date_updated).getTime();
      const bd = new Date(b.date_updated).getTime();
      if (ad !== bd) return bd - ad;
      return b.id - a.id;
    });

  return matches[0] || null;
}

function create(row) {
  const newRow = {
    id: nextId++,
    fish_type: String(row.fish_type).trim(),
    min_price: Number(row.min_price),
    max_price: Number(row.max_price),
    avg_price: Number(row.avg_price),
    date_updated: toIsoDate(row.date_updated),
  };
  rows.push(newRow);
  return newRow;
}

function update(id, row) {
  const idx = rows.findIndex((r) => Number(r.id) === Number(id));
  if (idx === -1) return null;

  const updated = {
    ...rows[idx],
    fish_type: String(row.fish_type).trim(),
    min_price: Number(row.min_price),
    max_price: Number(row.max_price),
    avg_price: Number(row.avg_price),
    date_updated: row.date_updated ? toIsoDate(row.date_updated) : rows[idx].date_updated,
  };

  rows[idx] = updated;
  return updated;
}

function remove(id) {
  const idx = rows.findIndex((r) => Number(r.id) === Number(id));
  if (idx === -1) return false;
  rows.splice(idx, 1);
  return true;
}

function listHistoryByFishType(fishType, daysBack) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (Number(daysBack) || 90));

  return rows
    .filter((r) => String(r.fish_type) === String(fishType))
    .filter((r) => {
      const d = new Date(r.date_updated);
      return !Number.isNaN(d.getTime()) && d >= cutoff;
    })
    .sort((a, b) => {
      const ad = new Date(a.date_updated).getTime();
      const bd = new Date(b.date_updated).getTime();
      if (ad !== bd) return ad - bd;
      return a.id - b.id;
    });
}

function listGasPrices({ from, to } = {}) {
  const fromD = from ? new Date(from).toISOString().slice(0, 10) : null;
  const toD = to ? new Date(to).toISOString().slice(0, 10) : null;

  return gasPrices
    .filter((r) => (!fromD ? true : r.date >= fromD))
    .filter((r) => (!toD ? true : r.date <= toD))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function listGasByDate(daysBack) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (Number(daysBack) || 90));
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const byDate = Object.create(null);
  for (const r of gasPrices) {
    if (String(r.date) < cutoffIso) continue;
    byDate[String(r.date)] = Number(r.price);
  }
  return byDate;
}

function upsertGasPrice({ date, price }) {
  const d = toIsoDate(date);
  const p = Number(price);
  const idx = gasPrices.findIndex((r) => String(r.date) === d);
  if (idx >= 0) {
    gasPrices[idx] = { ...gasPrices[idx], price: p };
    return gasPrices[idx];
  }

  const row = { id: nextGasId++, date: d, price: p, created_at: new Date().toISOString() };
  gasPrices.push(row);
  return row;
}

function removeGasPrice(date) {
  const d = toIsoDate(date);
  const idx = gasPrices.findIndex((r) => String(r.date) === d);
  if (idx === -1) return false;
  gasPrices.splice(idx, 1);
  return true;
}

function upsertPredictions(fishType, preds) {
  const t = String(fishType);
  for (const p of preds || []) {
    const keyDate = toIsoDate(p.prediction_date);
    const algo = String(p.algorithm_used);
    const idx = predictions.findIndex(
      (r) => String(r.fish_type) === t && String(r.prediction_date) === keyDate && String(r.algorithm_used) === algo
    );

    const row = {
      id: idx >= 0 ? predictions[idx].id : nextPredictionId++,
      fish_type: t,
      predicted_min_price: Number(p.predicted_min_price),
      predicted_max_price: Number(p.predicted_max_price),
      predicted_avg_price: Number(p.predicted_avg_price),
      prediction_date: keyDate,
      algorithm_used: algo,
      created_at: new Date().toISOString(),
    };

    if (idx >= 0) predictions[idx] = row;
    else predictions.push(row);
  }
}

function listPredictions({ fishType, from, to } = {}) {
  const ft = fishType ? String(fishType) : null;
  const fromD = from ? toIsoDate(from) : null;
  const toD = to ? toIsoDate(to) : null;

  return predictions
    .filter((r) => (!ft ? true : String(r.fish_type) === ft))
    .filter((r) => (!fromD ? true : String(r.prediction_date) >= fromD))
    .filter((r) => (!toD ? true : String(r.prediction_date) <= toD))
    .sort((a, b) => {
      const d = String(a.prediction_date).localeCompare(String(b.prediction_date));
      if (d !== 0) return d;
      return String(a.fish_type).localeCompare(String(b.fish_type));
    });
}

module.exports = {
  listLatestByType,
  listFishTypes,
  getLatestByFishType,
  create,
  update,
  remove,
  listHistoryByFishType,
  listGasPrices,
  listGasByDate,
  upsertGasPrice,
  removeGasPrice,
  upsertPredictions,
  listPredictions,
};
