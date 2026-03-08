const API_BASE = window.API_BASE || '';

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

const FAVORITES_KEY = 'isdaPresyo:favorites';

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
    const status = await apiGet('/api/predictions/schedule');
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

async function apiGet(path) {
  // Minimal JSON fetch wrapper.
  // NOTE: API_BASE is injected at build time for Netlify (or empty for local same-origin).
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

async function loadFishTypes() {
  setStatus('Loading fish types…');
  fishSelect.innerHTML = '';

  let fishTypes;
  try {
    fishTypes = await apiGet('/api/fish-types');
  } catch {
    try {
      // fallback: derive from /api/fish-prices
      const rows = await apiGet('/api/fish-prices');
      fishTypes = Array.from(new Set(rows.map((r) => r.fish_type))).sort();
    } catch {
      // final fallback: mock data
      usingMock = true;
      fishTypes = Array.from(MOCK_BY_TYPE.keys()).sort();
    }
  }

  if (!fishTypes.length) {
    fishSelect.innerHTML = '<option value="">No data yet</option>';
    setStatus('No fish prices found.');
    setFavoriteButtonState(null);
    return;
  }

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

  setStatus(usingMock ? 'Showing sample data (backend not connected yet).' : '');
  // Load the first fish type immediately.
  const initialType = decodeURIComponent(fishSelect.value);
  setFavoriteButtonState(initialType);
  await loadFishPrice(initialType);

  // Start countdown once we have a working backend.
  startScheduleCountdown();
}

async function loadFishPrice(fishType) {
  if (!fishType) return;
  setStatus(usingMock ? 'Showing sample data.' : 'Fetching predicted prices…');
  resultEl.classList.add('d-none');

  let row;
  try {
    // Predicted display (auto-refreshed by backend schedule)
    row = await apiGet(`/api/predicted-fish-prices/${encodeURIComponent(fishType)}`);
  } catch {
    // Fallback to latest recorded prices if predictions are unavailable.
    try {
      row = await apiGet(`/api/fish-prices/${encodeURIComponent(fishType)}`);
    } catch {
      usingMock = true;
      row = MOCK_BY_TYPE.get(fishType);
      if (!row) {
        setStatus('No sample data for this fish type.');
        return;
      }
    }
  }
  minPriceEl.textContent = money(row.min_price);
  maxPriceEl.textContent = money(row.max_price);
  avgPriceEl.textContent = money(row.avg_price);
  lastUpdatedEl.textContent = row.date_updated;
  if (currentTimeEl) currentTimeEl.textContent = formatFetchedTimestamp(row.date_updated);
  setFavoriteButtonState(fishType);

  resultEl.classList.remove('d-none');
  setStatus(usingMock ? 'Showing sample data (backend not connected yet).' : '');
}

fishSelect.addEventListener('change', async () => {
  // On selection change, re-fetch and re-render the price card.
  const fishType = decodeURIComponent(fishSelect.value);
  setFavoriteButtonState(fishType);
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
  usingMock = true;
  setStatus('Showing sample data (backend not connected yet).');
});
