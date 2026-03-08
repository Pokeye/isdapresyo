require('dotenv').config();

const crypto = require('crypto');
const { pool } = require('../src/db');

function usage() {
  console.log('Usage: node scripts/seed-synthetic.js [--wipe] [--intervalDays=3] [--daysBack=120]');
  console.log('Seeds synthetic fish price + gasoline history every N days using provided ranges.');
}

function parseArgs(argv) {
  const args = { wipe: false, intervalDays: 3, daysBack: 120 };
  for (const a of argv.slice(2)) {
    if (a === '--wipe') args.wipe = true;
    else if (a.startsWith('--intervalDays=')) args.intervalDays = Number(a.split('=')[1]);
    else if (a.startsWith('--daysBack=')) args.daysBack = Number(a.split('=')[1]);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(s) {
  const h = crypto.createHash('sha256').update(String(s)).digest();
  return h.readUInt32LE(0);
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function titleCase(s) {
  return String(s)
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

const FISH_RANGES = [
  { fish_type: 'Bangus', min: 200, max: 250 },
  { fish_type: 'Tilapia', min: 130, max: 180 },
  { fish_type: 'Galunggong', min: 200, max: 320 },
  { fish_type: 'Tulingan', min: 360, max: 420 },
  { fish_type: 'Alumahan', min: 300, max: 300 },
  { fish_type: 'Pusit', min: 380, max: 450 },
  { fish_type: 'Pompano', min: 380, max: 380 },
  { fish_type: 'Tambakol', min: 200, max: 360 },
  { fish_type: 'Pasagan', min: 360, max: 360 },
  { fish_type: 'Tangigue', min: 380, max: 380 },
  { fish_type: 'Matambaka', min: 180, max: 250 },
  { fish_type: 'Pakol', min: 380, max: 420 },
  { fish_type: 'Sibubog', min: 180, max: 240 },
  { fish_type: 'Butete', min: 320, max: 380 },
  { fish_type: 'Pagi', min: 380, max: 450 },
  { fish_type: 'Shrimp', min: 280, max: 450 },
  { fish_type: 'Tahong', min: 80, max: 120 },
  { fish_type: 'Lato', min: 80, max: 300 },
  { fish_type: 'Suga', min: 180, max: 240 },
  { fish_type: 'Sapsap', min: 120, max: 180 },
  { fish_type: 'Dilis', min: 140, max: 220 },
  { fish_type: 'Lapu-Lapu', min: 450, max: 800 },
  { fish_type: 'Malasugi', min: 380, max: 550 },
  { fish_type: 'Hasa-Hasa', min: 200, max: 260 },
  { fish_type: 'Maya-Maya', min: 300, max: 500 },
  { fish_type: 'Pating', min: 400, max: 1200 },
  { fish_type: 'Kitang', min: 200, max: 300 },
  { fish_type: 'Mamsa', min: 140, max: 260 },
  { fish_type: 'Asuhos', min: 180, max: 260 },
  { fish_type: 'Bisugo', min: 240, max: 340 },
  { fish_type: 'Law-law', min: 100, max: 220 },
];

// Monthly gasoline ranges (PHP per liter) provided by you.
const GAS_MONTHLY_RANGES = [
  { month: '2025-12', min: 64, max: 65 },
  { month: '2026-01', min: 65, max: 66 },
  { month: '2026-02', min: 66, max: 67 },
  { month: '2026-03', min: 67, max: 68 },
];

function gasRangeForDate(dateIso) {
  const month = String(dateIso).slice(0, 7);
  return GAS_MONTHLY_RANGES.find((m) => m.month === month) || null;
}

function synthFishRow({ fish_type, overallMin, overallMax, dateIso }) {
  const ft = titleCase(fish_type);

  if (overallMin === overallMax) {
    return {
      fish_type: ft,
      min_price: overallMin,
      max_price: overallMax,
      avg_price: overallMin,
      date_updated: dateIso,
    };
  }

  const rand = mulberry32(seedFromString(`${ft}|${dateIso}`));
  const span = overallMax - overallMin;

  const avg = overallMin + rand() * span;

  // Band width varies per date (keeps min/max realistic).
  const maxBand = Math.max(1, span * (0.08 + rand() * 0.18));
  const down = rand() * Math.min(maxBand, avg - overallMin);
  const up = rand() * Math.min(maxBand, overallMax - avg);

  const minP = avg - down;
  const maxP = avg + up;

  return {
    fish_type: ft,
    min_price: round2(Math.max(overallMin, minP)),
    max_price: round2(Math.min(overallMax, maxP)),
    avg_price: round2(Math.min(Math.max(avg, overallMin), overallMax)),
    date_updated: dateIso,
  };
}

function synthGasRow({ dateIso }) {
  const range = gasRangeForDate(dateIso);
  if (!range) return null;

  const rand = mulberry32(seedFromString(`gasoline|${dateIso}`));
  const price = range.min + rand() * (range.max - range.min);

  return {
    date: dateIso,
    price: round2(price),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  const intervalDays = Number.isFinite(args.intervalDays) && args.intervalDays > 0 ? Math.floor(args.intervalDays) : 3;
  const daysBack = Number.isFinite(args.daysBack) && args.daysBack > 0 ? Math.floor(args.daysBack) : 120;

  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = addDays(end, -daysBack);

  const dates = [];
  for (let d = new Date(start.getTime()); d <= end; d = addDays(d, intervalDays)) {
    dates.push(isoDate(d));
  }

  console.log(`Seeding synthetic history from ${isoDate(start)} to ${isoDate(end)} every ${intervalDays} day(s).`);

  await pool.query('BEGIN');
  try {
    if (args.wipe) {
      console.log('Wiping existing fish_prices, gas_prices, predictions…');
      await pool.query('DELETE FROM predictions');
      await pool.query('DELETE FROM gas_prices');
      await pool.query('DELETE FROM fish_prices');
    }

    // Insert gas prices first.
    let gasInserted = 0;
    for (const dateIso of dates) {
      const gas = synthGasRow({ dateIso });
      if (!gas) continue;
      await pool.query(
        `INSERT INTO gas_prices (date, price)
         VALUES ($1::date, $2)
         ON CONFLICT (date)
         DO UPDATE SET price = EXCLUDED.price`,
        [gas.date, gas.price]
      );
      gasInserted++;
    }

    // Insert fish prices.
    let fishInserted = 0;
    for (const fr of FISH_RANGES) {
      for (const dateIso of dates) {
        const row = synthFishRow({
          fish_type: fr.fish_type,
          overallMin: Number(fr.min),
          overallMax: Number(fr.max),
          dateIso,
        });

        await pool.query(
          `INSERT INTO fish_prices (fish_type, min_price, max_price, avg_price, date_updated)
           VALUES ($1, $2, $3, $4, $5::date)`,
          [row.fish_type, row.min_price, row.max_price, row.avg_price, row.date_updated]
        );
        fishInserted++;
      }
    }

    await pool.query('COMMIT');
    console.log(`Seed complete. Inserted fish rows: ${fishInserted}. Upserted gas rows: ${gasInserted}.`);
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
