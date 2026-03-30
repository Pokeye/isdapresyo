const API_BASE = window.API_BASE || '';

const DEFAULT_TIMEOUT_MS = 8000;

const ALLOW_MOCK_FALLBACK =
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1';

// Public page script.
// Flow:
// 1) Load fish types from the backend.
// 2) When a fish is selected, fetch the latest price row.
// 3) If the backend is unreachable, fall back to sample data so the UI still demonstrates behavior.

// Simple demo data (used only if the backend is unreachable)
const MOCK_ROWS = [
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

const MOCK_BY_TYPE = new Map(MOCK_ROWS.map((r) => [r.fish_type, r]));
let usingMock = false;

const fishSelect = document.getElementById('fishSelect');
const favoriteBtn = document.getElementById('favoriteBtn');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');

const minPriceEl = document.getElementById('minPrice');
const maxPriceEl = document.getElementById('maxPrice');
const avgPriceEl = document.getElementById('avgPrice');
const lastUpdatedEl = document.getElementById('lastUpdated');
const currentTimeEl = document.getElementById('currentTime');
const nextRefreshEl = document.getElementById('nextRefresh');
const updatedBadgeEl = document.getElementById('updatedBadge');

const trendWrapEl = document.getElementById('trendWrap');
const trendChartEl = document.getElementById('trendChart');
const trendNoteEl = document.getElementById('trendNote');

const fishImageWrapEl = document.getElementById('fishImageWrap');
const fishImageEl = document.getElementById('fishImage');
const fishImageCaptionEl = document.getElementById('fishImageCaption');

const FAVORITES_KEY = 'isdaPresyo:favorites';

// Small client-side cache to reduce repeated API calls across page reloads.
// This is intentionally short-lived and best-effort.
const CLIENT_CACHE_PREFIX = 'isdaPresyo:cache:';
const LAST_SEEN_PREFIX = 'isdaPresyo:lastSeen:';

function loadClientCache(key, maxAgeMs) {
  try {
    const raw = localStorage.getItem(CLIENT_CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const ts = Number(parsed.ts);
    if (!Number.isFinite(ts)) return null;
    if (Number.isFinite(maxAgeMs) && maxAgeMs > 0 && Date.now() - ts > maxAgeMs) return null;
    return parsed.value ?? null;
  } catch {
    return null;
  }
}

function saveClientCache(key, value) {
  try {
    localStorage.setItem(CLIENT_CACHE_PREFIX + key, JSON.stringify({ ts: Date.now(), value }));
  } catch {
    // ignore
  }
}

function showUpdatedBadge() {
  if (!updatedBadgeEl) return;
  updatedBadgeEl.classList.remove('d-none');
  setTimeout(() => updatedBadgeEl.classList.add('d-none'), 4000);
}

function markLastSeen(fishType, dateUpdated) {
  try {
    if (!fishType || !dateUpdated) return;
    const key = `${LAST_SEEN_PREFIX}${String(fishType).toLowerCase()}`;
    const prev = localStorage.getItem(key);
    if (prev && prev !== String(dateUpdated)) {
      showUpdatedBadge();
    }
    localStorage.setItem(key, String(dateUpdated));
  } catch {
    // ignore
  }
}

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

let trendChart = null;

function destroyTrendChart() {
  if (trendChart) {
    trendChart.destroy();
    trendChart = null;
  }
}

function ensureTrendVisible(show) {
  if (!trendWrapEl) return;
  trendWrapEl.classList.toggle('d-none', !show);
}

async function loadAndRenderTrendChart(fishType) {
  if (!trendWrapEl || !trendChartEl) return;
  if (!fishType) {
    destroyTrendChart();
    ensureTrendVisible(false);
    return;
  }

  if (typeof Chart === 'undefined') {
    destroyTrendChart();
    ensureTrendVisible(true);
    if (trendNoteEl) {
      trendNoteEl.textContent =
        'Trend chart unavailable (Chart.js failed to load). Check your internet connection or CDN access, then refresh.';
    }
    return;
  }

  const DAYS_BACK = 150;
  const cacheKey = `trend:v2:${String(fishType).toLowerCase()}`;
  const cached = loadClientCache(cacheKey, 5 * 60 * 1000);

  let payload = cached;
  if (!payload) {
    try {
      const historyRows = await apiGet(
        `/api/fish-prices/history/${encodeURIComponent(fishType)}?days=${DAYS_BACK}`
      );

      const historyList = Array.isArray(historyRows) ? historyRows : [];
      payload = { historyRows: historyList, gasRows: [], predRows: [], daysBack: DAYS_BACK };

      if (historyList.length >= 2) {
        const fromIso = String(historyList[0].date_updated).slice(0, 10);
        const toIso = String(historyList[historyList.length - 1].date_updated).slice(0, 10);
        const [gasRows, predRows] = await Promise.all([
          apiGet(`/api/gas-prices?from=${fromIso}&to=${toIso}`),
          apiGet(`/api/predictions/${encodeURIComponent(fishType)}`),
        ]);
        payload = { ...payload, gasRows, predRows, fromIso, toIso };
      }

      saveClientCache(cacheKey, payload);
    } catch {
      destroyTrendChart();
      ensureTrendVisible(true);
      if (trendNoteEl) {
        trendNoteEl.textContent =
          'Trend data unavailable right now (API request failed). Try again in a moment.';
      }
      return;
    }
  }

  const historyRows = Array.isArray(payload.historyRows) ? payload.historyRows : [];
  const gasRows = Array.isArray(payload.gasRows) ? payload.gasRows : [];
  const predRows = Array.isArray(payload.predRows) ? payload.predRows : [];

  if (historyRows.length < 2) {
    destroyTrendChart();
    ensureTrendVisible(true);
    if (trendNoteEl) {
      trendNoteEl.textContent =
        'Not enough historical price records yet to draw a trend chart. Add more dated entries in Admin.';
    }
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

  ensureTrendVisible(true);
  if (trendNoteEl) {
    const gasNote = gasRows.length ? '' : ' (gas series missing for this range)';
    trendNoteEl.textContent = `Uses last ${payload.daysBack || DAYS_BACK} days of recorded prices and gas reference to show trend + forecast points${gasNote}.`;
  }

  destroyTrendChart();
  trendChart = new Chart(trendChartEl, {
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

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => String(v)).filter(Boolean);
  } catch {
    return [];
  }
}

function saveFavorites(favs) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
  } catch {
    // ignore
  }
}

function isFavorite(fishType) {
  if (!fishType) return false;
  const favs = loadFavorites();
  return favs.includes(String(fishType));
}

function setFavoriteButtonState(fishType) {
  if (!favoriteBtn) return;
  if (!fishType) {
    favoriteBtn.disabled = true;
    favoriteBtn.textContent = '☆';
    favoriteBtn.title = 'Add to favorites';
    return;
  }

  favoriteBtn.disabled = false;
  const fav = isFavorite(fishType);
  favoriteBtn.textContent = fav ? '★' : '☆';
  favoriteBtn.title = fav ? 'Remove from favorites' : 'Add to favorites';
}

function toggleFavorite(fishType) {
  if (!fishType) return;
  const t = String(fishType);
  const favs = loadFavorites();
  const idx = favs.indexOf(t);
  if (idx >= 0) favs.splice(idx, 1);
  else favs.unshift(t);
  saveFavorites(favs);
  setFavoriteButtonState(t);
}

function formatFetchedTimestamp(_dateUpdated) {
  const fetchedTime = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return fetchedTime;
}

function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / (24 * 3600));
  const rem = totalSec % (24 * 3600);
  const hh = String(Math.floor(rem / 3600)).padStart(2, '0');
  const mm = String(Math.floor((rem % 3600) / 60)).padStart(2, '0');
  const ss = String(rem % 60).padStart(2, '0');
  return days > 0 ? `${days}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

let scheduleTimer = null;

async function startScheduleCountdown() {
  if (!nextRefreshEl) return;

  try {
    const cached = loadClientCache('schedule', 5 * 60 * 1000);
    const status = cached || (await apiGet('/api/predictions/schedule'));
    if (!cached && status) saveClientCache('schedule', status);
    if (!status || !status.enabled || !status.nextRunAt) {
      nextRefreshEl.textContent = '—';
      return;
    }

    const next = new Date(status.nextRunAt).getTime();
    if (!Number.isFinite(next)) {
      nextRefreshEl.textContent = '—';
      return;
    }

    if (scheduleTimer) clearInterval(scheduleTimer);
    scheduleTimer = setInterval(() => {
      const ms = next - Date.now();
      nextRefreshEl.textContent = formatCountdown(ms);
    }, 1000);

    nextRefreshEl.textContent = formatCountdown(next - Date.now());
  } catch {
    nextRefreshEl.textContent = '—';
  }
}

function money(v) {
  // Format a number as Philippine Peso.
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `₱${n.toFixed(2)}`;
}

function setStatus(msg) {
  statusEl.textContent = msg || '';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fishSvgDataUrl(label) {
  // Inline SVG (no extra HTTP requests) so the image always exists.
  // Uses brand palette already present in the site.
  const text = escapeXml(label || 'Fish');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="420" viewBox="0 0 800 420">
  <rect width="800" height="420" fill="#EBF4F6"/>
  <g fill="#09637E" opacity="0.12">
    <path d="M0 290 C 120 260, 240 320, 360 290 S 600 320, 800 290 V420 H0 Z"/>
    <path d="M0 320 C 120 290, 240 350, 360 320 S 600 350, 800 320 V420 H0 Z"/>
  </g>
  <g fill="#09637E" opacity="0.9">
    <ellipse cx="420" cy="185" rx="170" ry="85"/>
    <path d="M250 185 L160 125 L160 245 Z"/>
    <circle cx="485" cy="165" r="10" fill="#EBF4F6"/>
    <circle cx="485" cy="165" r="5"/>
    <path d="M520 205 C 560 240, 600 240, 640 205" fill="none" stroke="#EBF4F6" stroke-width="10" stroke-linecap="round" opacity="0.7"/>
  </g>
  <text x="400" y="372" text-anchor="middle" font-size="42" font-family="system-ui, -apple-system, Segoe UI, Roboto, Arial" fill="#09637E" opacity="0.95">${text}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function resolveAssetUrl(maybeUrl) {
  const raw = maybeUrl == null ? '' : String(maybeUrl).trim();
  if (!raw) return null;
  if (/^data:/i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return `${API_BASE}${raw}`;
  return `${API_BASE}/${raw}`;
}

function setFishImage(fishType, imageUrl) {
  if (!fishImageWrapEl || !fishImageEl) return;
  if (!fishType) {
    fishImageWrapEl.classList.add('d-none');
    fishImageEl.removeAttribute('src');
    fishImageEl.alt = '';
    fishImageEl.onerror = null;
    if (fishImageCaptionEl) fishImageCaptionEl.textContent = '';
    return;
  }

  const resolved = resolveAssetUrl(imageUrl);
  fishImageEl.onerror = null;

  if (resolved) {
    // If the uploaded image 404s, fall back to the inline SVG.
    fishImageEl.onerror = () => {
      fishImageEl.onerror = null;
      fishImageEl.src = fishSvgDataUrl(fishType);
    };
    fishImageEl.src = resolved;
  } else {
    fishImageEl.src = fishSvgDataUrl(fishType);
  }

  fishImageEl.alt = `Picture of ${fishType}`;
  if (fishImageCaptionEl) fishImageCaptionEl.textContent = fishType;
  fishImageWrapEl.classList.remove('d-none');
}

async function apiGet(path) {
  // Minimal JSON fetch wrapper.
  // NOTE: API_BASE is injected at build time for Netlify (or empty for local same-origin).
  const url = `${API_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const err = new Error(`Request failed (${res.status})`);
      err.status = res.status;
      err.url = url;
      throw err;
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiGetWithRetry(path, { retries = 2, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await apiGet(path);
    } catch (e) {
      lastErr = e;
      const status = e && typeof e.status === 'number' ? e.status : null;
      const isAbort = e && e.name === 'AbortError';
      const isTransientHttp = status != null && status >= 500;
      const shouldRetry = isAbort || isTransientHttp;

      if (attempt >= retries || !shouldRetry) break;
      const delay = baseDelayMs * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function loadFishTypes() {
  setStatus('Loading fish types…');
  fishSelect.innerHTML = '';

  // Keep client cache very short so cross-device updates show quickly.
  const cachedTypes = loadClientCache('fish-types', 30 * 1000);
  let initialTypeFromCache = null;
  if (Array.isArray(cachedTypes) && cachedTypes.length) {
    renderFishTypes(cachedTypes);
    initialTypeFromCache = decodeURIComponent(fishSelect.value);
    setFavoriteButtonState(initialTypeFromCache);
    setFishImage(initialTypeFromCache, null);
    // Best-effort: show something immediately, but still continue to fetch fresh fish types below.
    try {
      await loadFishPrice(initialTypeFromCache);
    } catch {
      // ignore
    }
  }

  let fishTypes;
  try {
    fishTypes = await apiGetWithRetry('/api/fish-types', { retries: 2, baseDelayMs: 900 });
  } catch {
    try {
      // fallback: derive from /api/fish-prices
      setStatus('Backend is slow to respond… retrying.');
      const rows = await apiGetWithRetry('/api/fish-prices', { retries: 1, baseDelayMs: 900 });
      fishTypes = Array.from(new Set(rows.map((r) => r.fish_type))).sort();
    } catch {
      // final fallback: mock data (dev only)
      if (ALLOW_MOCK_FALLBACK) {
        usingMock = true;
        fishTypes = Array.from(MOCK_BY_TYPE.keys()).sort();
      } else {
        fishTypes = [];
        setStatus('Backend unavailable.');
      }
    }
  }

  if (!fishTypes.length) {
    fishSelect.innerHTML = '<option value="">No data yet</option>';
    if (!statusEl.textContent) setStatus('No fish prices found.');
    setFavoriteButtonState(null);
    return;
  }

  saveClientCache('fish-types', fishTypes);

  renderFishTypes(fishTypes);

  setStatus(usingMock ? 'Showing sample data (backend not connected yet).' : statusEl.textContent);
  // Load the first fish type immediately.
  const prevSelected = initialTypeFromCache;
  if (prevSelected && fishTypes.includes(prevSelected)) {
    fishSelect.value = encodeURIComponent(prevSelected);
  }

  const initialType = decodeURIComponent(fishSelect.value);
  setFavoriteButtonState(initialType);
  setFishImage(initialType, null);
  // If we already loaded a cached row for this fish type moments ago, loadFishPrice will be fast.
  await loadFishPrice(initialType);

  // Start countdown once we have a working backend.
  startScheduleCountdown();
}

function renderFishTypes(fishTypes) {
  fishSelect.innerHTML = '';

  // Put favorites first (while keeping each section alphabetically sorted).
  const favSet = new Set(loadFavorites());
  const favoriteTypes = fishTypes.filter((t) => favSet.has(t));
  const otherTypes = fishTypes.filter((t) => !favSet.has(t));
  fishTypes = [...favoriteTypes, ...otherTypes];

  fishSelect.innerHTML = fishTypes
    .map((t) => {
      const suffix = favSet.has(t) ? ' ★' : '';
      return `<option value="${encodeURIComponent(t)}">${escapeHtml(t)}${suffix}</option>`;
    })
    .join('');
}

async function loadFishPrice(fishType) {
  if (!fishType) return;
  setStatus(usingMock ? 'Showing sample data.' : 'Fetching predicted prices…');
  resultEl.classList.add('d-none');
  setFishImage(fishType, null);

  const cacheKey = `price:${String(fishType).toLowerCase()}`;
  // Keep client cache very short so cross-device updates show quickly.
  const cachedRow = loadClientCache(cacheKey, 10 * 1000);
  if (cachedRow) {
    renderRow(cachedRow, fishType);
    loadAndRenderTrendChart(fishType);
    return;
  }

  let row;
  try {
    // Predicted display (auto-refreshed by backend schedule)
    row = await apiGet(`/api/predicted-fish-prices/${encodeURIComponent(fishType)}`);
  } catch {
    // Fallback to latest recorded prices if predictions are unavailable.
    try {
      row = await apiGet(`/api/fish-prices/${encodeURIComponent(fishType)}`);
    } catch (e) {
      if (e && typeof e.status === 'number' && e.status === 404) {
        setStatus('No data yet for this fish type.');
        return;
      }
      if (ALLOW_MOCK_FALLBACK) {
        usingMock = true;
        row = MOCK_BY_TYPE.get(fishType);
        if (!row) {
          setStatus('No sample data for this fish type.');
          return;
        }
      } else {
        setStatus('Backend unavailable.');
        return;
      }
    }
  }

  if (row) saveClientCache(cacheKey, row);
  renderRow(row, fishType);
  loadAndRenderTrendChart(fishType);
}

function renderRow(row, fishType) {
  if (!row) return;
  minPriceEl.textContent = money(row.min_price);
  maxPriceEl.textContent = money(row.max_price);
  avgPriceEl.textContent = money(row.avg_price);
  lastUpdatedEl.textContent = row.date_updated;
  if (updatedBadgeEl) updatedBadgeEl.classList.add('d-none');
  if (currentTimeEl) currentTimeEl.textContent = formatFetchedTimestamp(row.date_updated);
  setFavoriteButtonState(fishType);
  setFishImage(fishType, row.image_url);

  markLastSeen(fishType, row.date_updated);

  resultEl.classList.remove('d-none');
  setStatus(usingMock ? 'Showing sample data (backend not connected yet).' : '');
}

fishSelect.addEventListener('change', async () => {
  // On selection change, re-fetch and re-render the price card.
  const fishType = decodeURIComponent(fishSelect.value);
  setFavoriteButtonState(fishType);
  setFishImage(fishType, null);
  try {
    await loadFishPrice(fishType);
  } catch (e) {
    setStatus('Failed to load price.');
  }
});

if (favoriteBtn) {
  favoriteBtn.addEventListener('click', async () => {
    const fishType = decodeURIComponent(fishSelect.value);
    toggleFavorite(fishType);
    // Reorder the dropdown to keep favorites on top.
    try {
      await loadFishTypes();
      fishSelect.value = encodeURIComponent(fishType);
      setFavoriteButtonState(fishType);
    } catch {
      // ignore
    }
  });
}

// Initial page load.
loadFishTypes().catch(() => {
  if (ALLOW_MOCK_FALLBACK) {
    usingMock = true;
    setStatus('Showing sample data (backend not connected yet).');
  } else {
    setStatus('Backend unavailable.');
  }
});
