const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** Compact "how long ago" label for `timestamp` (ms since the epoch), e.g. "just now", "5m ago", "2h ago", "3d ago". */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  // A clock that moved backwards (or a synced timestamp from a machine running ahead) shouldn't show a negative age.
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d ago`;
  if (elapsed < MONTH) return `${Math.floor(elapsed / WEEK)}w ago`;
  if (elapsed < YEAR) return `${Math.floor(elapsed / MONTH)}mo ago`;
  return `${Math.floor(elapsed / YEAR)}y ago`;
}
