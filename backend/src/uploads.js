const os = require('os');
const path = require('path');

function getUploadsRoot({ isProd }) {
  // Allow override for platforms with persistent disks.
  // Example (Render Disk): UPLOADS_DIR=/var/data/uploads
  const override = String(process.env.UPLOADS_DIR || '').trim();
  if (override) return override;

  // Production PaaS environments can have surprising filesystem permissions.
  // Default to a temp directory that is usually writable.
  if (isProd) return path.join(os.tmpdir(), 'isdapresyo', 'uploads');

  // Local/dev: keep uploads in the repo so it's easy to inspect.
  return path.join(__dirname, '..', 'uploads');
}

function getFishUploadsDir({ isProd }) {
  return path.join(getUploadsRoot({ isProd }), 'fish');
}

module.exports = { getUploadsRoot, getFishUploadsDir };
