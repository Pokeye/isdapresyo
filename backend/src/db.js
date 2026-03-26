const { Pool } = require('pg');

/*
  Postgres access.

  - Uses a lazily-created pg Pool so importing modules doesn't require DATABASE_URL.
  - Routes decide whether to use Postgres or the demo mock store.
  - DATABASE_URL format:
      postgresql://USER:PASSWORD@HOST:PORT/DBNAME
*/

let poolInstance = null;

function parseBoolish(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  if (['1', 'true', 'yes', 'y', 'on', 'require', 'required'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'disable', 'disabled'].includes(v)) return false;
  return null;
}

function shouldUseSsl(connectionString) {
  // Explicit override.
  const forced = parseBoolish(process.env.PGSSL ?? process.env.DATABASE_SSL);
  if (forced !== null) return forced;

  // Default: production deployments tend to require SSL.
  if (process.env.NODE_ENV === 'production') return true;

  // Heuristic: Supabase-managed Postgres generally requires SSL even outside production.
  try {
    const u = new URL(connectionString);
    const host = String(u.hostname || '').toLowerCase();
    if (host.includes('supabase') || host.endsWith('.supabase.co')) return true;
  } catch {
    // ignore URL parse errors
  }

  return false;
}

function ensurePool() {
  if (poolInstance) return poolInstance;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    // We intentionally throw here (instead of creating a pool) so callers can
    // decide whether to run in demo mode vs error out.
    throw new Error('DATABASE_URL is required');
  }

  poolInstance = new Pool({
    connectionString,
    // Managed Postgres providers (Supabase/Render/etc.) often require SSL.
    // Use PGSSL=true (or DATABASE_SSL=true) to force SSL in development.
    ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : false,
  });

  return poolInstance;
}

const pool = {
  // Use like: `await pool.query('SELECT ... WHERE id=$1', [id])`
  query: (...args) => ensurePool().query(...args),
  end: (...args) => (poolInstance ? poolInstance.end(...args) : Promise.resolve()),
};

module.exports = { pool };
