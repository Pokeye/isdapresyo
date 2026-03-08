// Prediction engine for IsdaPresyo.
//
// Goal: keep this dependency-free and robust for small datasets.
// - Primary model: linear regression using time index + gas price as features.
// - Fallback model: simple moving average (window N).

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mean(nums) {
  const xs = nums.filter((n) => Number.isFinite(n));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function clampMin(n, min) {
  if (!Number.isFinite(n)) return n;
  return n < min ? min : n;
}

function solveLinearSystem(A, b) {
  // Gaussian elimination with partial pivoting.
  // A: kxk, b: k
  const k = A.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < k; col++) {
    // Pivot
    let pivotRow = col;
    let pivotAbs = Math.abs(M[col][col]);
    for (let r = col + 1; r < k; r++) {
      const abs = Math.abs(M[r][col]);
      if (abs > pivotAbs) {
        pivotAbs = abs;
        pivotRow = r;
      }
    }

    if (!Number.isFinite(pivotAbs) || pivotAbs < 1e-12) return null;

    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }

    // Normalize pivot row
    const pivot = M[col][col];
    for (let c = col; c <= k; c++) M[col][c] /= pivot;

    // Eliminate other rows
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let c = col; c <= k; c++) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }

  return M.map((row) => row[k]);
}

function fitLinearRegression(features, targets) {
  // Ordinary Least Squares using normal equation:
  // beta = (X'X)^-1 X'y
  // features: N x k
  // targets: N
  const N = features.length;
  if (!N) return null;
  const k = features[0].length;

  const XtX = Array.from({ length: k }, () => Array.from({ length: k }, () => 0));
  const XtY = Array.from({ length: k }, () => 0);

  for (let i = 0; i < N; i++) {
    const x = features[i];
    const y = targets[i];
    if (!Number.isFinite(y)) continue;

    for (let a = 0; a < k; a++) {
      const xa = x[a];
      if (!Number.isFinite(xa)) continue;
      XtY[a] += xa * y;
      for (let b = 0; b < k; b++) {
        const xb = x[b];
        if (!Number.isFinite(xb)) continue;
        XtX[a][b] += xa * xb;
      }
    }
  }

  const beta = solveLinearSystem(XtX, XtY);
  if (!beta || beta.some((v) => !Number.isFinite(v))) return null;
  return beta;
}

function movingAverage(values, windowSize) {
  const xs = values.filter((v) => Number.isFinite(v));
  if (!xs.length) return null;
  const w = Math.max(1, Math.min(windowSize || 7, xs.length));
  const tail = xs.slice(xs.length - w);
  return mean(tail);
}

function computeAverageSpreads(priceRows, windowSize) {
  // Returns typical spreads so we can reconstruct min/max around predicted avg.
  const rows = Array.isArray(priceRows) ? priceRows : [];
  const w = Math.max(1, Math.min(windowSize || 14, rows.length));
  const tail = rows.slice(rows.length - w);

  const lower = [];
  const upper = [];

  for (const r of tail) {
    const minP = toNumber(r.min_price);
    const maxP = toNumber(r.max_price);
    const avgP = toNumber(r.avg_price);
    if (minP == null || maxP == null || avgP == null) continue;
    lower.push(avgP - minP);
    upper.push(maxP - avgP);
  }

  return {
    lower: mean(lower) ?? 0,
    upper: mean(upper) ?? 0,
  };
}

function predictNext({ priceRows, gasByDate, horizonDays = 3 }) {
  // priceRows: ascending by date
  const rows = Array.isArray(priceRows) ? priceRows : [];
  if (!rows.length) return [];

  const y = [];
  const X = [];
  const dates = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const avgP = toNumber(row.avg_price);
    if (avgP == null) continue;

    const date = String(row.date_updated);
    const gas = gasByDate && gasByDate[date] != null ? toNumber(gasByDate[date]) : null;

    // Feature vector: [1, time_index, gas_price]
    // If gas is missing, we still include the row but set gas to 0 so the model can fit.
    const t = i;
    X.push([1, t, gas == null ? 0 : gas]);
    y.push(avgP);
    dates.push(date);
  }

  const spreads = computeAverageSpreads(rows, 14);

  const beta = X.length >= 6 ? fitLinearRegression(X, y) : null;

  const lastRow = rows[rows.length - 1];
  const lastAvg = toNumber(lastRow.avg_price) ?? movingAverage(y, 7) ?? 0;
  const lastDate = new Date(String(lastRow.date_updated));
  const lastGas = gasByDate && gasByDate[String(lastRow.date_updated)] != null ? toNumber(gasByDate[String(lastRow.date_updated)]) : null;

  const horizon = Math.max(1, Math.min(90, Number(horizonDays) || 3));
  const preds = [];

  for (let d = 1; d <= horizon; d++) {
    const predDate = new Date(lastDate.getTime());
    predDate.setDate(predDate.getDate() + d);
    const predDateIso = predDate.toISOString().slice(0, 10);

    let predAvg;
    if (beta) {
      const tFuture = (X.length ? X[X.length - 1][1] : rows.length - 1) + d;
      const gasFuture = lastGas == null ? 0 : lastGas;
      predAvg = beta[0] + beta[1] * tFuture + beta[2] * gasFuture;
    }

    if (!Number.isFinite(predAvg)) {
      predAvg = movingAverage(y, 7);
    }

    if (!Number.isFinite(predAvg)) predAvg = lastAvg;

    predAvg = clampMin(predAvg, 0);

    const predMin = clampMin(predAvg - (spreads.lower || 0), 0);
    const predMax = clampMin(predAvg + (spreads.upper || 0), 0);

    preds.push({
      prediction_date: predDateIso,
      predicted_min_price: predMin,
      predicted_max_price: predMax,
      predicted_avg_price: predAvg,
      algorithm_used: beta ? 'linear_regression_gas' : 'moving_average',
    });
  }

  return preds;
}

module.exports = {
  predictNext,
};
