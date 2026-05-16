/*
  E2E sanity check for fish CRUD against a live deployed backend.

  This script intentionally mutates data (create/update/delete) but cleans up
  after itself by deleting the created row.

  Required env vars:
    API_BASE=https://your-backend.onrender.com
    ADMIN_USER=admin
    ADMIN_PASS=yourStrongPassword

  Safety gate:
    CONFIRM_RUN=YES

  Optional:
    FISH_TYPE=TestFishCRUD

  Usage (PowerShell):
    $env:API_BASE='https://...onrender.com'
    $env:ADMIN_USER='admin'
    $env:ADMIN_PASS='...'
    $env:CONFIRM_RUN='YES'
    node scripts/verify-fish-crud-live.js
*/

const crypto = require('node:crypto');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return String(v);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpJson(base, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : null),
      ...(body ? { 'Content-Type': 'application/json' } : null),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const msg = json && json.message ? json.message : `HTTP ${res.status}`;
    const err = new Error(`${method} ${path} failed: ${msg}`);
    err.status = res.status;
    err.response = json;
    throw err;
  }

  return json;
}

async function main() {
  if (String(process.env.CONFIRM_RUN || '').trim().toUpperCase() !== 'YES') {
    throw new Error('Safety gate: set CONFIRM_RUN=YES to run this script');
  }

  const base = requireEnv('API_BASE').replace(/\/$/, '');
  const username = requireEnv('ADMIN_USER');
  const password = requireEnv('ADMIN_PASS');

  const fishTypeBase = (process.env.FISH_TYPE || 'TestFishCRUD').trim();
  const suffix = crypto.randomBytes(4).toString('hex');
  const fishType = `${fishTypeBase}-${suffix}`;

  console.log(`[live-e2e] Base: ${base}`);
  console.log(`[live-e2e] Fish type: ${fishType}`);

  // Health
  const health = await httpJson(base, 'GET', '/api/health');
  console.log(`[live-e2e] Health ok=${health.ok} demoMode=${health.demoMode}`);

  // Login
  const login = await httpJson(base, 'POST', '/api/admin/login', {
    body: { username, password },
  });

  if (!login || !login.token) throw new Error('Login did not return a token');
  const token = login.token;
  console.log('[live-e2e] Logged in as ' + login.username);

  // Create
  const created = await httpJson(base, 'POST', '/api/fish-prices', {
    token,
    body: {
      fish_type: fishType,
      min_price: 100,
      max_price: 140,
      avg_price: 120,
    },
  });

  if (!created || !created.id) throw new Error('Create did not return id');
  console.log('[live-e2e] Created row id=' + created.id);

  // Confirm public latest
  await sleep(250);
  const latest = await httpJson(base, 'GET', `/api/fish-prices/${encodeURIComponent(fishType)}`);
  if (Number(latest.id) !== Number(created.id)) {
    throw new Error('Public GET latest did not return created row');
  }

  // Update
  const updated = await httpJson(base, 'PUT', `/api/fish-prices/${created.id}`, {
    token,
    body: {
      fish_type: fishType,
      min_price: 110,
      max_price: 150,
      avg_price: 130,
    },
  });

  console.log('[live-e2e] Updated row, avg_price=' + updated.avg_price);

  await sleep(250);
  const latest2 = await httpJson(base, 'GET', `/api/fish-prices/${encodeURIComponent(fishType)}`);
  if (Number(latest2.avg_price) !== 130) {
    throw new Error('Public GET latest did not reflect updated values');
  }

  // Delete
  const del = await httpJson(base, 'DELETE', `/api/fish-prices/${created.id}`, { token });
  if (!del || del.ok !== true) throw new Error('Delete did not return ok:true');
  console.log('[live-e2e] Deleted row OK');

  // Confirm deleted
  let notFoundOk = false;
  try {
    await httpJson(base, 'GET', `/api/fish-prices/${encodeURIComponent(fishType)}`);
  } catch (e) {
    if (e.status === 404) notFoundOk = true;
  }
  if (!notFoundOk) throw new Error('Expected 404 after delete');

  console.log('[live-e2e] PASS: add/edit/delete fish price works on live backend');
}

main().catch((e) => {
  console.error('[live-e2e] FAIL:', e && e.message ? e.message : e);
  if (e && e.response) {
    console.error('[live-e2e] Response:', JSON.stringify(e.response, null, 2));
  }
  process.exitCode = 1;
});
