require('dotenv').config();

const { pool } = require('../src/db');

function safeDbTarget(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return {
      host: u.hostname || null,
      port: u.port ? Number(u.port) : null,
      database: (u.pathname || '').replace(/^\//, '') || null,
      sslEnv: process.env.PGSSL ?? process.env.DATABASE_SSL ?? null,
      nodeEnv: process.env.NODE_ENV || null,
    };
  } catch {
    return { host: null, port: null, database: null, sslEnv: process.env.PGSSL ?? process.env.DATABASE_SSL ?? null, nodeEnv: process.env.NODE_ENV || null };
  }
}

async function main() {
  const out = {
    ok: false,
    target: safeDbTarget(process.env.DATABASE_URL),
    dbInfo: null,
    tables: null,
    counts: null,
    indexes: null,
    orphanAssets: null,
    warnings: [],
  };

  if (!process.env.DATABASE_URL) {
    out.warnings.push('DATABASE_URL is not set. Backend will not be able to use Postgres.');
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = 1;
    return;
  }

  try {
    const r1 = await pool.query(
      'select current_database() as db, current_user as user, inet_server_addr()::text as server_ip, inet_server_port() as server_port'
    );
    out.dbInfo = r1.rows[0] || null;

    const tablesQ =
      "select to_regclass('public.fish_prices') as fish_prices, " +
      "to_regclass('public.admin') as admin, " +
      "to_regclass('public.gas_prices') as gas_prices, " +
      "to_regclass('public.predictions') as predictions, " +
      "to_regclass('public.fish_type_assets') as fish_type_assets";

    const tables = await pool.query(tablesQ);
    out.tables = tables.rows[0] || null;

    const hasAssets = Boolean(out.tables && out.tables.fish_type_assets);

    const countParts = [
      '(select count(*) from fish_prices) as fish_prices_rows',
      '(select count(*) from predictions) as prediction_rows',
      '(select count(*) from gas_prices) as gas_rows',
    ];

    if (hasAssets) {
      countParts.push('(select count(*) from fish_type_assets) as fish_type_asset_rows');
    } else {
      out.warnings.push(
        'fish_type_assets table is missing. Image uploads will still store files, but DB linkage may fail until schema.sql is applied.'
      );
    }

    const counts = await pool.query('select ' + countParts.join(', '));
    out.counts = counts.rows[0] || null;

    const idx = await pool.query(
      "select tablename, indexname from pg_indexes where schemaname='public' and tablename in ('fish_prices','predictions','gas_prices','fish_type_assets') order by tablename, indexname"
    );
    out.indexes = idx.rows || [];

    if (hasAssets) {
      const orphanQ =
        "select a.fish_type, a.image_url, a.updated_at::text as updated_at " +
        "from fish_type_assets a " +
        "left join (select distinct fish_type from fish_prices) fp on fp.fish_type = a.fish_type " +
        "where fp.fish_type is null " +
        "order by a.updated_at desc " +
        "limit 50";
      const orphan = await pool.query(orphanQ);
      out.orphanAssets = { count: orphan.rowCount, rows: orphan.rows || [] };
      if (orphan.rowCount > 0) {
        out.warnings.push(
          'Some fish_type_assets rows have no matching fish_prices fish_type. /api/fish-types includes asset-only fish types, but the public price card will show “No data yet…” until at least one fish_prices row exists.'
        );
      }
    }

    out.ok = true;
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    out.error = String(e && e.message ? e.message : e);
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
