const API_BASE = window.API_BASE || '';

// Admin page script.
// Uses JWT auth:
// - POST /api/admin/login returns a token
// - token is stored in sessionStorage and sent as Authorization: Bearer <token>
// - CRUD endpoints live under /api/fish-prices

const loginCard = document.getElementById('loginCard');
const adminPanel = document.getElementById('adminPanel');
const loginStatus = document.getElementById('loginStatus');
const adminStatus = document.getElementById('adminStatus');
const logoutBtn = document.getElementById('logoutBtn');
const loginBtn = document.getElementById('loginBtn');

const usernameEl = document.getElementById('username');
const passwordEl = document.getElementById('password');
const togglePasswordBtn = document.getElementById('togglePasswordBtn');

const fishTypeEl = document.getElementById('fish_type');
const fishTypeListEl = document.getElementById('fishTypeList');
const minEl = document.getElementById('min_price');
const maxEl = document.getElementById('max_price');
const avgEl = document.getElementById('avg_price');
const dateEl = document.getElementById('date_updated');

const loadLatestBtn = document.getElementById('loadLatestBtn');
const updateBtn = document.getElementById('updateBtn');
const deleteBtn = document.getElementById('deleteBtn');

const gasDateEl = document.getElementById('gas_date');
const gasPriceEl = document.getElementById('gas_price');
const upsertGasBtn = document.getElementById('upsertGasBtn');
const deleteGasBtn = document.getElementById('deleteGasBtn');
const clearGasBtn = document.getElementById('clearGasBtn');
const refreshGasBtn = document.getElementById('refreshGasBtn');
const gasStatus = document.getElementById('gasStatus');
const gasRowsEl = document.getElementById('gasRows');

const runPredictionsBtn = document.getElementById('runPredictionsBtn');
const predStatus = document.getElementById('predStatus');

const rowsEl = document.getElementById('rows');
const completenessEl = document.getElementById('completeness');
const tabNotice = document.getElementById('tabNotice');
const goToActiveBtn = document.getElementById('goToActiveBtn');

const previewChartBtn = document.getElementById('previewChartBtn');
const clearChartBtn = document.getElementById('clearChartBtn');
const adminChartWrap = document.getElementById('adminChartWrap');
const adminTrendChartEl = document.getElementById('adminTrendChart');
const adminChartNoteEl = document.getElementById('adminChartNote');

const dlHistoryCsvBtn = document.getElementById('dlHistoryCsvBtn');
const dlGasCsvBtn = document.getElementById('dlGasCsvBtn');
const dlPredCsvBtn = document.getElementById('dlPredCsvBtn');
const dlRunSummaryBtn = document.getElementById('dlRunSummaryBtn');

let demoMode = false;
let loadedFishPriceId = null;

// Single-tab admin lock (prevents multiple admin tabs at once).
// Note: this is UX/operational safety, not a security boundary.
const ADMIN_TAB_LOCK_KEY = 'isdaPresyo:admin:tabLock';
const ADMIN_FOCUS_REQUEST_KEY = 'isdaPresyo:admin:focusRequest';
const ADMIN_BROADCAST_CHANNEL = 'isdaPresyo:admin:channel';
const TAB_ID =
  (window.crypto && typeof window.crypto.randomUUID === 'function' && window.crypto.randomUUID()) ||
  `tab_${Math.random().toString(16).slice(2)}_${Date.now()}`;
// A longer TTL reduces accidental lock expiry due to background timer throttling.
// If the owning tab crashes, the lock will naturally expire and another tab can recover.
const LOCK_TTL_MS = 90_000;
let lockInterval = null;
let adminChannel = null;

try {
  if ('BroadcastChannel' in window) {
    adminChannel = new BroadcastChannel(ADMIN_BROADCAST_CHANNEL);
  }
} catch {
  adminChannel = null;
}

function safeFocusWindow() {
  try {
    window.focus();
  } catch {
    // ignore
  }
}

function requestFocusFromActiveTab() {
  const payload = { type: 'focus-request', from: TAB_ID, at: Date.now() };
  try {
    if (adminChannel) adminChannel.postMessage(payload);
  } catch {
    // ignore
  }
  try {
    localStorage.setItem(ADMIN_FOCUS_REQUEST_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function readLock() {
  try {
    const raw = localStorage.getItem(ADMIN_TAB_LOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const tabId = String(parsed.tabId || '');
    const ts = Number(parsed.ts);
    if (!tabId || !Number.isFinite(ts)) return null;
    return { tabId, ts };
  } catch {
    return null;
  }
}

function isLockExpired(lock) {
  if (!lock) return true;
  return Date.now() - Number(lock.ts) > LOCK_TTL_MS;
}

function writeLock() {
  try {
    localStorage.setItem(
      ADMIN_TAB_LOCK_KEY,
      JSON.stringify({ tabId: TAB_ID, ts: Date.now() })
    );
  } catch {
    // ignore
  }
}

function releaseLockIfOwned() {
  try {
    const lock = readLock();
    if (lock && lock.tabId === TAB_ID) localStorage.removeItem(ADMIN_TAB_LOCK_KEY);
  } catch {
    // ignore
  }
}

function ensureSingleAdminTab() {
  const lock = readLock();

  // If no lock or expired, claim it.
  if (!lock || isLockExpired(lock) || lock.tabId === TAB_ID) {
    writeLock();
    if (loginBtn) loginBtn.disabled = false;
    if (tabNotice) tabNotice.classList.add('d-none');
    return true;
  }

  // Another tab owns the lock.
  setToken(null);
  showAdmin(false);
  if (loginBtn) loginBtn.disabled = true;
  setLoginStatus('Admin is already open in another tab.');
  if (tabNotice) tabNotice.classList.remove('d-none');
  setAdminStatus('');
  setGasStatus('');
  setPredStatus('');
  return false;
}

function startAdminTabLockHeartbeat() {
  if (lockInterval) return;
  // Try immediately and keep refreshing so the lock doesn't expire.
  ensureSingleAdminTab();
  lockInterval = setInterval(() => {
    // Refresh the lock even in the background; otherwise the TTL can expire
    // and a second tab may become "active" simply by waiting.
    const lock = readLock();
    if (!lock || isLockExpired(lock) || lock.tabId === TAB_ID) {
      writeLock();
      if (loginBtn) loginBtn.disabled = false;
      if (tabNotice) tabNotice.classList.add('d-none');
      return;
    }

    // Another tab owns it; keep UI in sync.
    ensureSingleAdminTab();
  }, Math.floor(LOCK_TTL_MS / 2));
}

function setPredStatus(msg) {
  if (!predStatus) return;
  predStatus.textContent = msg || '';
}

function formatPredictionRunSummary(result) {
  if (!result || typeof result !== 'object') return String(result);

  const fishUpdated = Number(result.fishUpdated);
  const daysBack = Number(result.daysBack);
  const horizonDays = Number(result.horizonDays);
  const trainingFrom = result.trainingFrom ? String(result.trainingFrom) : null;
  const trainingTo = result.trainingTo ? String(result.trainingTo) : null;
  const methodsByFish = result.methodsByFish && typeof result.methodsByFish === 'object' ? result.methodsByFish : null;

  const parts = [];
  if (Number.isFinite(fishUpdated)) parts.push(`Updated ${fishUpdated} fish`);
  if (Number.isFinite(daysBack)) {
    if (trainingFrom && trainingTo) parts.push(`Training window: last ${daysBack} days (${trainingFrom} → ${trainingTo})`);
    else parts.push(`Training window: last ${daysBack} days`);
  }
  if (Number.isFinite(horizonDays)) parts.push(`Horizon: ${horizonDays} days`);

  let methodPart = '';
  if (methodsByFish) {
    const entries = Object.entries(methodsByFish)
      .map(([k, v]) => [String(k), String(v)])
      .sort((a, b) => a[0].localeCompare(b[0]));

    const mapped = entries.map(([fish, algo]) => `${fish}=${algo}`);
    const MAX = 25;
    const shown = mapped.slice(0, MAX);
    methodPart = `Methods: ${shown.join(', ')}${mapped.length > MAX ? ', …' : ''}`;
  }

  if (methodPart) parts.push(methodPart);
  return parts.filter(Boolean).join(' • ');
}

function formatPredictionRunSummaryPretty(result) {
  if (!result || typeof result !== 'object') return String(result);

  const fishUpdated = Number(result.fishUpdated);
  const daysBack = Number(result.daysBack);
  const horizonDays = Number(result.horizonDays);
  const trainingFrom = result.trainingFrom ? String(result.trainingFrom) : null;
  const trainingTo = result.trainingTo ? String(result.trainingTo) : null;
  const methodsByFish =
    result.methodsByFish && typeof result.methodsByFish === 'object' ? result.methodsByFish : null;

  const lines = [];
  lines.push('Predictions run complete.');

  if (Number.isFinite(fishUpdated)) lines.push(`- Fish updated: ${fishUpdated}`);
  if (Number.isFinite(daysBack)) {
    if (trainingFrom && trainingTo) {
      lines.push(`- Training window: last ${daysBack} days (${trainingFrom} → ${trainingTo})`);
    } else {
      lines.push(`- Training window: last ${daysBack} days`);
    }
  }
  if (Number.isFinite(horizonDays)) lines.push(`- Forecast horizon: ${horizonDays} day(s)`);

  if (methodsByFish) {
    const entries = Object.entries(methodsByFish).map(([fish, algo]) => [String(fish), String(algo)]);
    const counts = entries.reduce((acc, [, algo]) => {
      acc[algo] = (acc[algo] || 0) + 1;
      return acc;
    }, Object.create(null));

    lines.push('');
    lines.push('Methods used:');
    const countLines = Object.entries(counts)
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([algo, n]) => `- ${algo}: ${n} fish`);
    lines.push(...countLines);

    // Show a short, readable sample list per method.
    const byAlgo = Object.create(null);
    for (const [fish, algo] of entries) {
      if (!byAlgo[algo]) byAlgo[algo] = [];
      byAlgo[algo].push(fish);
    }
    for (const algo of Object.keys(byAlgo).sort()) {
      const list = byAlgo[algo].sort((a, b) => a.localeCompare(b));
      const shown = list.slice(0, 12);
      lines.push(`  ${algo}: ${shown.join(', ')}${list.length > shown.length ? ', …' : ''}`);
    }
  }

  return lines.join('\n');
}

function setGasStatus(msg) {
  if (!gasStatus) return;
  gasStatus.textContent = msg || '';
}

function syncLoadedFishActions() {
  const hasLoaded = Number.isFinite(Number(loadedFishPriceId)) && Number(loadedFishPriceId) > 0;
  if (updateBtn) updateBtn.disabled = !hasLoaded;
  if (deleteBtn) deleteBtn.disabled = !hasLoaded;
}

function setLoginStatus(msg) {
  loginStatus.textContent = msg || '';
}

function syncPasswordToggleLabel() {
  if (!togglePasswordBtn) return;
  togglePasswordBtn.textContent = passwordEl.type === 'password' ? 'Show' : 'Hide';
}

function setAdminStatus(msg) {
  adminStatus.textContent = msg || '';
}

function setCompleteness(html) {
  if (!completenessEl) return;
  completenessEl.innerHTML = html || '';
}

function getToken() {
  // Session-only storage:
  // - safer than localStorage for an MVP (clears when tab closes)
  // - simple mental model for demos (log in per session)
  return sessionStorage.getItem('adminToken');
}

function setToken(t) {
  if (t) sessionStorage.setItem('adminToken', t);
  else sessionStorage.removeItem('adminToken');
}

async function api(path, options = {}) {
  // Fetch wrapper that:
  // - attaches JSON headers
  // - attaches Authorization header when logged in
  // - throws readable errors when requests fail
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : await res.text().catch(() => null);
  if (!res.ok) {
    const msg = body && body.message ? body.message : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

function showAdmin(isAuthed) {
  // Toggle between login form and admin panel.
  loginCard.classList.toggle('d-none', isAuthed);
  adminPanel.classList.toggle('d-none', !isAuthed);
  logoutBtn.classList.toggle('d-none', !isAuthed);
}

function localIsoToday() {
  // HTML date inputs expect YYYY-MM-DD in local time.
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

function clearForm() {
  fishTypeEl.value = '';
  minEl.value = '';
  maxEl.value = '';
  avgEl.value = '';
  dateEl.value = localIsoToday();
  loadedFishPriceId = null;
  syncLoadedFishActions();
  setCompleteness('');
}

function fillForm(row) {
  loadedFishPriceId = row.id;
  fishTypeEl.value = row.fish_type;
  minEl.value = row.min_price;
  maxEl.value = row.max_price;
  avgEl.value = row.avg_price;
  // Default to today when editing so the update date reflects the change.
  dateEl.value = localIsoToday();
  syncLoadedFishActions();
  updateCompletenessIndicators(row.fish_type).catch(() => {
    // best-effort
  });
}

function computeAvgFromMinMax() {
  const min = Number(minEl?.value);
  const max = Number(maxEl?.value);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const avg = (min + max) / 2;
  if (!Number.isFinite(avg)) return null;
  return avg;
}

function formatAvg(avg) {
  if (!Number.isFinite(avg)) return '';
  // Prefer integers when possible; otherwise 2 decimals.
  if (Math.abs(avg - Math.round(avg)) < 1e-9) return String(Math.round(avg));
  return avg.toFixed(2);
}

function syncAvgFromMinMax() {
  if (!avgEl) return;
  const avg = computeAvgFromMinMax();
  if (avg == null) return;
  avgEl.value = formatAvg(avg);
}

function setFishTypeOptions(types) {
  if (!fishTypeListEl) return;
  const list = Array.isArray(types) ? types : [];
  fishTypeListEl.innerHTML = list
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .map((t) => `<option value="${escapeHtml(t)}"></option>`)
    .join('');
}

async function loadFishTypes() {
  try {
    const types = await api('/api/fish-types');
    setFishTypeOptions(types);
  } catch {
    // best-effort
  }
}

function clearGasForm() {
  if (gasDateEl) gasDateEl.value = localIsoToday();
  if (gasPriceEl) gasPriceEl.value = '';
}

function fillGasForm(row) {
  if (gasDateEl) gasDateEl.value = row.date;
  if (gasPriceEl) gasPriceEl.value = row.price;
}

function parsePayload() {
  // Build the request body for create/update.
  const fishType = fishTypeEl.value.trim();
  const min = Number(minEl.value);
  const max = Number(maxEl.value);

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error('Enter valid Min and Max prices.');
  }

  const computedAvg = computeAvgFromMinMax();
  if (computedAvg == null) {
    throw new Error('Enter Min and Max to auto-calculate Avg.');
  }

  // Keep the UI field in sync (Avg is read-only).
  if (avgEl) avgEl.value = formatAvg(computedAvg);

  const payload = {
    fish_type: fishType,
    min_price: min,
    max_price: max,
    avg_price: computedAvg,
  };

  if (dateEl.value) payload.date_updated = dateEl.value;
  return payload;
}

async function refreshTable() {
  // Pulls the latest "latest per fish" list and renders it as an HTML table.
  setAdminStatus('Loading…');
  const rows = await api('/api/fish-prices');

  rowsEl.innerHTML = rows
    .map(
      (r) => `
      <tr data-id="${r.id}" class="row-click" title="Tap this row to load it into the form above.">
        <td>${r.id}</td>
        <td>${r.fish_type}</td>
        <td>${r.min_price}</td>
        <td>${r.max_price}</td>
        <td>${r.avg_price}</td>
        <td>${r.date_updated}</td>
        <td class="text-end">
          <button class="btn btn-outline-danger btn-sm" data-del="${r.id}" title="Deletes this row (asks for confirmation)." aria-label="Delete record ${r.id}">Delete</button>
        </td>
      </tr>`
    )
    .join('');

  setAdminStatus('');
}

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function safeFilenamePart(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_\-\.]/g, '')
    .slice(0, 80) || 'unknown';
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, columns) {
  const cols = Array.isArray(columns) ? columns : [];
  const header = cols.map((c) => csvEscape(c.header)).join(',');
  const lines = [header];
  const list = Array.isArray(rows) ? rows : [];

  for (const r of list) {
    lines.push(cols.map((c) => csvEscape(c.value(r))).join(','));
  }

  return `${lines.join('\n')}\n`;
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let adminTrendChart = null;
let lastPredictionRunResult = null;

function destroyAdminTrendChart() {
  if (adminTrendChart) {
    adminTrendChart.destroy();
    adminTrendChart = null;
  }
}

function setAdminChartVisible(show) {
  if (!adminChartWrap) return;
  adminChartWrap.classList.toggle('d-none', !show);
}

function setAdminChartNote(msg) {
  if (!adminChartNoteEl) return;
  adminChartNoteEl.textContent = msg || '';
}

async function loadAndRenderAdminPreviewChart(fishType) {
  const t = String(fishType || '').trim();
  if (!adminTrendChartEl || !adminChartWrap) return;

  if (!t) {
    destroyAdminTrendChart();
    setAdminChartVisible(false);
    setAdminChartNote('Enter a fish type above, then click Preview chart.');
    return;
  }

  if (typeof Chart === 'undefined') {
    destroyAdminTrendChart();
    setAdminChartVisible(false);
    setAdminChartNote('Preview chart unavailable (Chart.js failed to load).');
    return;
  }

  const DAYS_BACK = 150;
  setAdminChartVisible(true);
  setAdminChartNote('Loading chart data…');

  let historyRows = [];
  let gasRows = [];
  let predRows = [];
  try {
    const history = await api(`/api/fish-prices/history/${encodeURIComponent(t)}?days=${DAYS_BACK}`);
    historyRows = Array.isArray(history) ? history : [];

    if (historyRows.length >= 2) {
      const fromIso = String(historyRows[0].date_updated).slice(0, 10);
      const toIso = String(historyRows[historyRows.length - 1].date_updated).slice(0, 10);
      const [gas, pred] = await Promise.all([
        api(`/api/gas-prices?from=${fromIso}&to=${toIso}`),
        api(`/api/predictions/${encodeURIComponent(t)}`),
      ]);
      gasRows = Array.isArray(gas) ? gas : [];
      predRows = Array.isArray(pred) ? pred : [];
    }
  } catch (e) {
    destroyAdminTrendChart();
    setAdminChartVisible(false);
    setAdminChartNote(`Preview chart failed to load (${e.message || 'request failed'}).`);
    return;
  }

  if (historyRows.length < 2) {
    destroyAdminTrendChart();
    setAdminChartVisible(false);
    setAdminChartNote(
      `Not enough historical records to draw a chart for “${t}”. Add more dated entries first.`
    );
    return;
  }

  const gasByDate = new Map(
    gasRows
      .map((r) => ({ d: String(r.date).slice(0, 10), v: Number(r.price) }))
      .filter((r) => r.d && Number.isFinite(r.v))
      .map((r) => [r.d, r.v])
  );

  const labels = historyRows.map((r) => String(r.date_updated).slice(0, 10));
  const actualAvg = historyRows.map((r) => {
    const n = Number(r.avg_price);
    return Number.isFinite(n) ? n : null;
  });

  const todayIso = isoDate(new Date());
  const forecast = predRows
    .map((r) => ({
      d: String(r.prediction_date).slice(0, 10),
      v: Number(r.predicted_avg_price),
    }))
    .map((p) => ({ d: p.d, v: Number.isFinite(p.v) ? p.v : null }))
    .filter((p) => p.d && p.d >= todayIso)
    .sort((a, b) => a.d.localeCompare(b.d))
    .slice(0, 10);

  const forecastLabels = forecast.map((p) => p.d);
  const allLabels = Array.from(new Set([...labels, ...forecastLabels])).sort();
  const actualByDate = new Map(labels.map((d, i) => [d, actualAvg[i]]));
  const forecastByDate = new Map(forecast.map((p) => [p.d, p.v]));

  const actualData = allLabels.map((d) => (actualByDate.has(d) ? actualByDate.get(d) : null));
  const forecastData = allLabels.map((d) => (forecastByDate.has(d) ? forecastByDate.get(d) : null));
  const gasData = allLabels.map((d) => {
    const v = gasByDate.get(d);
    return Number.isFinite(v) ? v : null;
  });

  const gasNote = gasRows.length ? '' : ' (gas series missing for this range)';
  setAdminChartNote(`Shows last ${DAYS_BACK} days of actual prices + forecast points${gasNote}.`);

  destroyAdminTrendChart();
  adminTrendChart = new Chart(adminTrendChartEl, {
    type: 'line',
    data: {
      labels: allLabels,
      datasets: [
        {
          label: 'Actual avg price (₱)',
          data: actualData,
          borderColor: '#09637E',
          backgroundColor: 'rgba(9, 99, 126, 0.08)',
          tension: 0.25,
          spanGaps: true,
          pointRadius: 0,
          borderWidth: 2,
          yAxisID: 'y',
        },
        {
          label: 'Forecast avg price (₱)',
          data: forecastData,
          borderColor: '#088395',
          backgroundColor: 'rgba(8, 131, 149, 0.10)',
          tension: 0.25,
          spanGaps: true,
          pointRadius: 3,
          borderDash: [6, 4],
          borderWidth: 2,
          yAxisID: 'y',
        },
        {
          label: 'Gas price (₱)',
          data: gasData,
          borderColor: 'rgba(9, 99, 126, 0.45)',
          tension: 0.25,
          spanGaps: true,
          pointRadius: 0,
          borderWidth: 1,
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true },
        tooltip: { mode: 'index', intersect: false },
      },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          ticks: { maxTicksLimit: 8 },
          grid: { display: false },
        },
        y: {
          position: 'left',
          beginAtZero: false,
          ticks: {
            callback: (v) => `₱${v}`,
          },
        },
        y1: {
          position: 'right',
          beginAtZero: false,
          grid: { drawOnChartArea: false },
          ticks: {
            callback: (v) => `₱${v}`,
          },
        },
      },
    },
  });
}

async function fetchChartDataForFish(fishType) {
  const t = String(fishType || '').trim();
  if (!t) throw new Error('Enter a fish type first.');

  const DAYS_BACK = 150;
  const history = await api(`/api/fish-prices/history/${encodeURIComponent(t)}?days=${DAYS_BACK}`);
  const historyRows = Array.isArray(history) ? history : [];

  let gasRows = [];
  let predRows = [];
  let fromIso = null;
  let toIso = null;

  if (historyRows.length >= 2) {
    fromIso = String(historyRows[0].date_updated).slice(0, 10);
    toIso = String(historyRows[historyRows.length - 1].date_updated).slice(0, 10);
    const [gas, pred] = await Promise.all([
      api(`/api/gas-prices?from=${fromIso}&to=${toIso}`),
      api(`/api/predictions/${encodeURIComponent(t)}`),
    ]);
    gasRows = Array.isArray(gas) ? gas : [];
    predRows = Array.isArray(pred) ? pred : [];
  }

  return { fishType: t, daysBack: DAYS_BACK, historyRows, gasRows, predRows, fromIso, toIso };
}

async function downloadHistoryCsvForFish(fishType) {
  const data = await fetchChartDataForFish(fishType);
  const csv = toCsv(data.historyRows, [
    { header: 'fish_type', value: (r) => r.fish_type },
    { header: 'date_updated', value: (r) => String(r.date_updated).slice(0, 10) },
    { header: 'min_price', value: (r) => r.min_price },
    { header: 'max_price', value: (r) => r.max_price },
    { header: 'avg_price', value: (r) => r.avg_price },
  ]);
  downloadTextFile(
    `fish_history_${safeFilenamePart(data.fishType)}_${data.fromIso || 'na'}_${data.toIso || 'na'}.csv`,
    csv,
    'text/csv;charset=utf-8'
  );
}

async function downloadGasCsvForFish(fishType) {
  const data = await fetchChartDataForFish(fishType);
  const csv = toCsv(data.gasRows, [
    { header: 'date', value: (r) => String(r.date).slice(0, 10) },
    { header: 'price', value: (r) => r.price },
  ]);
  downloadTextFile(
    `gas_${safeFilenamePart(data.fishType)}_${data.fromIso || 'na'}_${data.toIso || 'na'}.csv`,
    csv,
    'text/csv;charset=utf-8'
  );
}

async function downloadPredictionsCsvForFish(fishType) {
  const data = await fetchChartDataForFish(fishType);
  const csv = toCsv(data.predRows, [
    { header: 'fish_type', value: (r) => r.fish_type },
    { header: 'prediction_date', value: (r) => String(r.prediction_date).slice(0, 10) },
    { header: 'predicted_min_price', value: (r) => r.predicted_min_price },
    { header: 'predicted_max_price', value: (r) => r.predicted_max_price },
    { header: 'predicted_avg_price', value: (r) => r.predicted_avg_price },
    { header: 'algorithm_used', value: (r) => r.algorithm_used },
    { header: 'created_at', value: (r) => r.created_at },
  ]);
  downloadTextFile(
    `predictions_${safeFilenamePart(data.fishType)}.csv`,
    csv,
    'text/csv;charset=utf-8'
  );
}

function downloadLastRunSummaryJson() {
  if (!lastPredictionRunResult) throw new Error('Run predictions first.');
  const name = `prediction_run_${isoDate(new Date())}.json`;
  downloadTextFile(name, `${JSON.stringify(lastPredictionRunResult, null, 2)}\n`, 'application/json;charset=utf-8');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderBadges(items) {
  return items
    .map(
      (i) =>
        `<span class="badge text-bg-${i.kind} me-2 mb-1">${escapeHtml(i.text)}</span>`
    )
    .join('');
}

async function updateCompletenessIndicators(fishType) {
  if (!completenessEl) return;
  const t = String(fishType || '').trim();
  if (!t) {
    setCompleteness('');
    return;
  }

  const DAYS_BACK = 90;
  setCompleteness('<div class="text-muted">Checking data completeness…</div>');

  const history = await api(
    `/api/fish-prices/history/${encodeURIComponent(t)}?days=${DAYS_BACK}`
  );
  const historyRows = Array.isArray(history) ? history : [];

  if (historyRows.length === 0) {
    setCompleteness(
      `<div class="alert alert-warning py-2 mb-0">No historical records found for <strong>${escapeHtml(
        t
      )}</strong> in the last ${DAYS_BACK} days.</div>`
    );
    return;
  }

  const fromIso = String(historyRows[0].date_updated).slice(0, 10);
  const toIso = String(historyRows[historyRows.length - 1].date_updated).slice(0, 10);

  // Fetch gas in the same window (+ a small buffer) so we can assess forward-fill coverage.
  const gasFromIso = isoDate(addDays(new Date(fromIso), -7));
  const gas = await api(`/api/gas-prices?from=${gasFromIso}&to=${toIso}`);
  const gasRows = Array.isArray(gas) ? gas : [];

  const fishDates = historyRows.map((r) => String(r.date_updated).slice(0, 10));
  const uniqueFishDates = Array.from(new Set(fishDates));

  const gasDates = gasRows
    .map((r) => String(r.date).slice(0, 10))
    .filter(Boolean)
    .sort();

  // Determine how many fish dates have at least one gas value on or before that date.
  let gasIdx = 0;
  let lastGasDate = null;
  let coveredFishDates = 0;
  for (const d of uniqueFishDates.sort()) {
    while (gasIdx < gasDates.length && gasDates[gasIdx] <= d) {
      lastGasDate = gasDates[gasIdx];
      gasIdx++;
    }
    if (lastGasDate != null) coveredFishDates++;
  }

  const pct = uniqueFishDates.length
    ? Math.round((coveredFishDates / uniqueFishDates.length) * 100)
    : 0;

  const badges = [];
  if (historyRows.length < 6) {
    badges.push({ kind: 'warning', text: 'Needs ≥ 6 points for regression' });
    badges.push({ kind: 'secondary', text: 'Will use moving average' });
  } else {
    badges.push({ kind: 'success', text: 'Enough points for regression' });
  }

  if (!gasRows.length) {
    badges.push({ kind: 'warning', text: 'No gas entries in range' });
  } else if (pct < 80) {
    badges.push({ kind: 'warning', text: `Gas coverage low (${pct}%)` });
  } else {
    badges.push({ kind: 'success', text: `Gas coverage OK (${pct}%)` });
  }

  const html = `
    <div class="border rounded-3 bg-white p-2">
      <div class="fw-semibold mb-1">Data completeness (last ~${DAYS_BACK} days)</div>
      <div class="mb-2">${renderBadges(badges)}</div>
      <div class="text-muted">
        <div><strong>Fish records:</strong> ${historyRows.length} (dates: ${uniqueFishDates.length})</div>
        <div><strong>Fish date range:</strong> ${escapeHtml(fromIso)} → ${escapeHtml(toIso)}</div>
        <div><strong>Gas entries fetched:</strong> ${gasRows.length} (from ${escapeHtml(gasFromIso)} → ${escapeHtml(toIso)})</div>
        <div><strong>Fish dates with gas available (forward-fill):</strong> ${coveredFishDates}/${uniqueFishDates.length} (${pct}%)</div>
      </div>
    </div>`;

  setCompleteness(html);
}

async function refreshGasTable() {
  if (!gasRowsEl) return;
  setGasStatus('Loading…');

  const DAYS_BACK = 150;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const fromIso = isoDate(addDays(today, -DAYS_BACK));
  const toIso = isoDate(today);

  const rows = await api(`/api/gas-prices?from=${fromIso}&to=${toIso}`);

  const list = Array.isArray(rows) ? rows : [];
  const last = list.slice(-40).reverse();

  gasRowsEl.innerHTML = last
    .map(
      (r) => `
      <tr data-date="${r.date}" class="row-click" title="Tap this row to load the date into the gas form above.">
        <td>${r.date}</td>
        <td>${r.price}</td>
      </tr>`
    )
    .join('');

  setGasStatus('');
}

if (loginBtn) {
  loginBtn.addEventListener('click', async () => {
    if (!ensureSingleAdminTab()) return;
  // Login -> store token -> show admin panel -> load table.
  setLoginStatus('Logging in…');
  try {
    const r = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: usernameEl.value.trim(), password: passwordEl.value }),
    });
    setToken(r.token);
    demoMode = !!r.demoMode;
    showAdmin(true);
    clearForm();
    await loadFishTypes();
    await refreshTable();
    await refreshGasTable();
    setLoginStatus('');
  } catch (e) {
    setToken(null);
    showAdmin(false);
    // If demoMode is detected, show the demo credential hint to reduce confusion.
    setLoginStatus(demoMode ? 'Access denied. (Demo creds: admin / admin123)' : 'Access denied.');
  }
  });
}

if (togglePasswordBtn) {
  syncPasswordToggleLabel();
  togglePasswordBtn.addEventListener('click', () => {
    passwordEl.type = passwordEl.type === 'password' ? 'text' : 'password';
    syncPasswordToggleLabel();
    passwordEl.focus();
  });
}

if (minEl) {
  minEl.addEventListener('input', () => {
    syncAvgFromMinMax();
  });
}

if (maxEl) {
  maxEl.addEventListener('input', () => {
    syncAvgFromMinMax();
  });
}

logoutBtn.addEventListener('click', () => {
  // Clears the JWT and returns to the login view.
  setToken(null);
  showAdmin(false);
  setAdminStatus('');
  setGasStatus('');
  setPredStatus('');
  clearForm();
  clearGasForm();
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  refreshTable().catch((e) => setAdminStatus(e.message));
});

if (refreshGasBtn) {
  refreshGasBtn.addEventListener('click', () => {
    refreshGasTable().catch((e) => setGasStatus(e.message));
  });
}

document.getElementById('clearBtn').addEventListener('click', () => {
  clearForm();
});

if (clearGasBtn) {
  clearGasBtn.addEventListener('click', () => {
    clearGasForm();
    setGasStatus('');
  });
}

document.getElementById('createBtn').addEventListener('click', async () => {
  // Create a new fish price entry (admin only).
  try {
    setAdminStatus('Saving…');
    await api('/api/fish-prices', { method: 'POST', body: JSON.stringify(parsePayload()) });
    clearForm();
    loadFishTypes().catch(() => {});
    await refreshTable();
    setAdminStatus('Saved.');
  } catch (e) {
    setAdminStatus(e.message);
  }
});

if (loadLatestBtn) {
  loadLatestBtn.addEventListener('click', async () => {
    const fishType = fishTypeEl.value.trim();
    if (!fishType) {
      setAdminStatus('Enter a fish type, then click Load latest.');
      return;
    }

    try {
      setAdminStatus('Loading latest…');
      const row = await api(`/api/fish-prices/${encodeURIComponent(fishType)}`);
      fillForm(row);
      setAdminStatus('Loaded latest record.');
    } catch (e) {
      setAdminStatus(e.message);
    }
  });
}

if (updateBtn) {
  updateBtn.addEventListener('click', async () => {
    const id = Number(loadedFishPriceId);
    if (!Number.isFinite(id) || id <= 0) {
      setAdminStatus('Load a record first (tap a row or click Load latest).');
      return;
    }

    try {
      setAdminStatus('Updating…');
      await api(`/api/fish-prices/${id}`, { method: 'PUT', body: JSON.stringify(parsePayload()) });
      loadFishTypes().catch(() => {});
      await refreshTable();
      setAdminStatus('Updated.');
    } catch (e) {
      setAdminStatus(e.message);
    }
  });
}

if (deleteBtn) {
  deleteBtn.addEventListener('click', async () => {
    const id = Number(loadedFishPriceId);
    if (!Number.isFinite(id) || id <= 0) {
      setAdminStatus('Load a record first (tap a row or click Load latest).');
      return;
    }
    if (!confirm('Delete this loaded record?')) return;

    try {
      setAdminStatus('Deleting…');
      await api(`/api/fish-prices/${id}`, { method: 'DELETE' });
      clearForm();
      loadFishTypes().catch(() => {});
      await refreshTable();
      setAdminStatus('Deleted.');
    } catch (e) {
      setAdminStatus(e.message);
    }
  });
}

if (upsertGasBtn) {
  upsertGasBtn.addEventListener('click', async () => {
    const date = gasDateEl?.value;
    const price = Number(gasPriceEl?.value);
    if (!date) {
      setGasStatus('Pick a date.');
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setGasStatus('Enter a valid gas price.');
      return;
    }
    try {
      setGasStatus('Saving…');
      await api('/api/gas-prices', { method: 'POST', body: JSON.stringify({ date, price }) });
      await refreshGasTable();
      setGasStatus('Saved.');
    } catch (e) {
      setGasStatus(e.message);
    }
  });
}

if (deleteGasBtn) {
  deleteGasBtn.addEventListener('click', async () => {
    const date = gasDateEl?.value;
    if (!date) {
      setGasStatus('Pick a date to delete.');
      return;
    }
    if (!confirm(`Delete gas price for ${date}?`)) return;
    try {
      setGasStatus('Deleting…');
      await api(`/api/gas-prices/${encodeURIComponent(date)}`, { method: 'DELETE' });
      clearGasForm();
      await refreshGasTable();
      setGasStatus('Deleted.');
    } catch (e) {
      setGasStatus(e.message);
    }
  });
}

if (gasRowsEl) {
  gasRowsEl.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const date = tr.getAttribute('data-date');
    if (!date) return;
    const tds = tr.querySelectorAll('td');
    const price = tds && tds.length > 1 ? tds[1].textContent : '';
    fillGasForm({ date, price });
  });
}

if (runPredictionsBtn) {
  runPredictionsBtn.addEventListener('click', async () => {
    try {
      setPredStatus('Running predictions…');
      const r = await api('/api/admin/predictions/run', { method: 'POST', body: '{}' });
      lastPredictionRunResult = r;
      setPredStatus(formatPredictionRunSummaryPretty(r));
    } catch (e) {
      setPredStatus(e.message);
    }
  });
}

if (dlRunSummaryBtn) {
  dlRunSummaryBtn.addEventListener('click', () => {
    try {
      downloadLastRunSummaryJson();
    } catch (e) {
      setPredStatus(e.message);
    }
  });
}

if (previewChartBtn) {
  previewChartBtn.addEventListener('click', () => {
    loadAndRenderAdminPreviewChart(fishTypeEl ? fishTypeEl.value : '').catch((e) => {
      destroyAdminTrendChart();
      setAdminChartVisible(false);
      setAdminChartNote(`Preview chart failed (${e.message || 'unknown error'}).`);
    });
  });
}

if (clearChartBtn) {
  clearChartBtn.addEventListener('click', () => {
    destroyAdminTrendChart();
    setAdminChartVisible(false);
    setAdminChartNote('');
  });
}

if (dlHistoryCsvBtn) {
  dlHistoryCsvBtn.addEventListener('click', () => {
    downloadHistoryCsvForFish(fishTypeEl ? fishTypeEl.value : '').catch((e) => {
      setAdminChartNote(e.message || 'Download failed.');
    });
  });
}

if (dlGasCsvBtn) {
  dlGasCsvBtn.addEventListener('click', () => {
    downloadGasCsvForFish(fishTypeEl ? fishTypeEl.value : '').catch((e) => {
      setAdminChartNote(e.message || 'Download failed.');
    });
  });
}

if (dlPredCsvBtn) {
  dlPredCsvBtn.addEventListener('click', () => {
    downloadPredictionsCsvForFish(fishTypeEl ? fishTypeEl.value : '').catch((e) => {
      setAdminChartNote(e.message || 'Download failed.');
    });
  });
}

rowsEl.addEventListener('click', async (e) => {
  // Table click behavior:
  // - clicking Delete triggers DELETE
  // - clicking a row loads that row into the form for editing
  const delId = e.target?.dataset?.del;
  if (delId) {
    if (!confirm('Delete this record?')) return;
    try {
      setAdminStatus('Deleting…');
      await api(`/api/fish-prices/${delId}`, { method: 'DELETE' });
      loadFishTypes().catch(() => {});
      await refreshTable();
      setAdminStatus('Deleted.');
    } catch (err) {
      setAdminStatus(err.message);
    }
    return;
  }

  const tr = e.target.closest('tr');
  if (!tr) return;
  const id = tr.getAttribute('data-id');
  if (!id) return;

  // Fetch latest list row and load into form
  try {
    const rows = await api('/api/fish-prices');
    const row = rows.find((r) => String(r.id) === String(id));
    if (row) fillForm(row);
  } catch {
    // ignore
  }
});

// Auto-show admin if token exists
startAdminTabLockHeartbeat();

if (goToActiveBtn) {
  goToActiveBtn.addEventListener('click', () => {
    // User gesture improves the chance the other tab can focus itself.
    requestFocusFromActiveTab();
  });
}

if (adminChannel) {
  adminChannel.addEventListener('message', (ev) => {
    const msg = ev && ev.data;
    if (!msg || msg.type !== 'focus-request') return;

    const lock = readLock();
    if (!lock || isLockExpired(lock)) return;
    if (lock.tabId !== TAB_ID) return;
    safeFocusWindow();
  });
}

// React quickly if another tab takes/releases the lock.
window.addEventListener('storage', (e) => {
  if (e && e.key === ADMIN_TAB_LOCK_KEY) {
    ensureSingleAdminTab();
  }
});

window.addEventListener('storage', (e) => {
  if (!e || e.key !== ADMIN_FOCUS_REQUEST_KEY) return;

  const lock = readLock();
  if (!lock || isLockExpired(lock)) return;
  if (lock.tabId !== TAB_ID) return;
  safeFocusWindow();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const ok = ensureSingleAdminTab();
    if (ok) writeLock();
  }
});

window.addEventListener('beforeunload', () => {
  releaseLockIfOwned();
  try {
    if (adminChannel) adminChannel.close();
  } catch {
    // ignore
  }
});

showAdmin(!!getToken());
// Set default dates immediately for convenience.
try {
  if (dateEl && !dateEl.value) dateEl.value = localIsoToday();
  if (gasDateEl && !gasDateEl.value) gasDateEl.value = localIsoToday();
} catch {
  // ignore
}
if (getToken()) {
  ensureSingleAdminTab();
  loadFishTypes().catch(() => {});
  refreshTable().catch(() => {
    setToken(null);
    showAdmin(false);
  });

  refreshGasTable().catch(() => {
    // ignore
  });
}

syncLoadedFishActions();

// Show helpful login hint for demo mode
(async () => {
  try {
    const health = await api('/api/health', { method: 'GET' });
    demoMode = !!health.demoMode;
    if (demoMode) {
      setLoginStatus('Demo mode detected. Login: admin / admin123');
    }
  } catch {
    // ignore; backend may be offline
  }
})();
