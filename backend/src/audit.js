const fs = require('fs');
const path = require('path');

const auditLogPath = path.join(__dirname, '..', 'logs', 'audit.log');

// Append-only audit log for security-relevant events (auth failures, login failures, etc).
// Logging failures must NEVER break the request path.

const MAX_QUEUE_LINES = 1000;
let queue = [];
let flushing = false;

function flushQueue() {
  if (flushing) return;
  if (!queue.length) return;

  flushing = true;
  const lines = queue;
  queue = [];

  // Async write so we never block request processing.
  fs.promises
    .appendFile(auditLogPath, lines.join('\n') + '\n', 'utf8')
    .catch(() => {
      // Do not crash request path on logging failure
    })
    .finally(() => {
      flushing = false;
      if (queue.length) setImmediate(flushQueue);
    });
}

function logAudit(event) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...event,
    });

    queue.push(line);
    if (queue.length > MAX_QUEUE_LINES) {
      // Avoid unbounded memory growth if a client spams login failures.
      queue.shift();
    }
    flushQueue();
  } catch {
    // Do not crash request path on logging failure
  }
}

module.exports = { logAudit };
