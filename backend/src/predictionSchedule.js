// In-process prediction schedule state.
// Used to show a countdown in the public UI.

let enabled = false;
let intervalDays = 3;
let intervalMs = 3 * 24 * 60 * 60 * 1000;
let lastRunAt = null;
let nextRunAt = null;

function configure({ isEnabled, days }) {
  enabled = !!isEnabled;
  const d = Number(days);
  intervalDays = Number.isFinite(d) && d > 0 ? Math.floor(d) : 3;
  intervalMs = intervalDays * 24 * 60 * 60 * 1000;
}

function markRun(now = new Date()) {
  lastRunAt = now;
  nextRunAt = new Date(now.getTime() + intervalMs);
}

function markScheduledFromNow(now = new Date()) {
  nextRunAt = new Date(now.getTime() + intervalMs);
}

function getStatus(now = new Date()) {
  const next = nextRunAt;
  const last = lastRunAt;
  const msUntilNext = next ? Math.max(0, next.getTime() - now.getTime()) : null;

  return {
    enabled,
    intervalDays,
    lastRunAt: last ? last.toISOString() : null,
    nextRunAt: next ? next.toISOString() : null,
    msUntilNext,
  };
}

module.exports = {
  configure,
  markRun,
  markScheduledFromNow,
  getStatus,
};
