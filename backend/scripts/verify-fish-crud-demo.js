/*
  E2E sanity check for fish CRUD in demo mode.

  - Starts the backend as a child process in demo mode (no DATABASE_URL)
  - Logs in via /api/admin/login
  - Creates a fish price row, updates it, deletes it
  - Verifies public endpoints reflect each state

  Usage:
    node scripts/verify-fish-crud-demo.js
*/

const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 3999);
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServerReady(proc, timeoutMs = 15000) {
  const startedAt = Date.now();
  let buffer = '';

  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      buffer += text;

      if (buffer.includes(`IsdaPresyo backend listening on http://localhost:${PORT}`)) {
        cleanup();
        resolve();
      }
    };

    const onExit = (code) => {
      cleanup();
      reject(new Error(`Server exited early with code ${code}. Output:\n${buffer}`));
    };

    const timer = setInterval(() => {
      if (Date.now() - startedAt > timeoutMs) {
        cleanup();
        reject(new Error(`Timed out waiting for server to start. Output:\n${buffer}`));
      }
    }, 200);

    function cleanup() {
      clearInterval(timer);
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onData);
      proc.off('exit', onExit);
    }

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', onExit);
  });
}

async function httpJson(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
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
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PORT),
    JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-for-demo-only',
    ENABLE_PREDICTIONS: 'false',
    SERVE_FRONTEND: 'false',
    // Ensure demo mode:
    DATABASE_URL: '',
  };

  console.log(`[demo-e2e] Starting backend on ${BASE} ...`);

  const proc = spawn(process.execPath, ['src/server.js'], {
    cwd: require('node:path').join(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServerReady(proc);

    const login = await httpJson('POST', '/api/admin/login', {
      body: { username: 'admin', password: 'admin123' },
    });

    if (!login || !login.token) {
      throw new Error('Login did not return a token');
    }

    const token = login.token;
    console.log('[demo-e2e] Logged in (demoMode=' + String(login.demoMode) + ')');

    const fishType = 'TestFishCRUD';

    // Create
    const created = await httpJson('POST', '/api/fish-prices', {
      token,
      body: {
        fish_type: fishType,
        min_price: 100,
        max_price: 140,
        avg_price: 120,
      },
    });

    if (!created || !created.id) throw new Error('Create did not return id');
    console.log('[demo-e2e] Created row id=' + created.id);

    // Confirm public endpoints
    const latest = await httpJson('GET', `/api/fish-prices/${encodeURIComponent(fishType)}`);
    if (!latest || Number(latest.id) !== Number(created.id)) {
      throw new Error('Public GET latest did not return created row');
    }

    // Update
    const updated = await httpJson('PUT', `/api/fish-prices/${created.id}`, {
      token,
      body: {
        fish_type: fishType,
        min_price: 110,
        max_price: 150,
        avg_price: 130,
      },
    });

    if (Number(updated.min_price) !== 110 || Number(updated.max_price) !== 150 || Number(updated.avg_price) !== 130) {
      throw new Error('Update did not persist expected values');
    }
    console.log('[demo-e2e] Updated row values OK');

    const latest2 = await httpJson('GET', `/api/fish-prices/${encodeURIComponent(fishType)}`);
    if (Number(latest2.min_price) !== 110) throw new Error('Public GET latest did not reflect update');

    // Delete
    const del = await httpJson('DELETE', `/api/fish-prices/${created.id}`, { token });
    if (!del || del.ok !== true) throw new Error('Delete did not return ok:true');
    console.log('[demo-e2e] Deleted row OK');

    // Confirm deleted
    let notFoundOk = false;
    try {
      await httpJson('GET', `/api/fish-prices/${encodeURIComponent(fishType)}`);
    } catch (e) {
      if (e.status === 404) notFoundOk = true;
    }
    if (!notFoundOk) {
      throw new Error('Expected GET after delete to return 404');
    }

    console.log('[demo-e2e] PASS: add/edit/delete fish price works in demo mode');
  } finally {
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
      await sleep(250);
      proc.kill('SIGKILL');
    }
  }
}

main().catch((e) => {
  console.error('[demo-e2e] FAIL:', e);
  if (e && e.response) {
    console.error('[demo-e2e] Response:', JSON.stringify(e.response, null, 2));
  }
  process.exitCode = 1;
});
