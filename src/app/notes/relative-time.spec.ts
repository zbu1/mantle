import { formatRelativeTime } from './relative-time';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatRelativeTime', () => {
  it('says "just now" under a minute', () => {
    expect(formatRelativeTime(NOW, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 59_000, NOW)).toBe('just now');
  });

  it('counts minutes, hours and days', () => {
    expect(formatRelativeTime(NOW - MINUTE, NOW)).toBe('1m ago');
    expect(formatRelativeTime(NOW - 59 * MINUTE, NOW)).toBe('59m ago');
    expect(formatRelativeTime(NOW - 2 * HOUR, NOW)).toBe('2h ago');
    expect(formatRelativeTime(NOW - 23 * HOUR, NOW)).toBe('23h ago');
    expect(formatRelativeTime(NOW - 3 * DAY, NOW)).toBe('3d ago');
  });

  it('falls back to weeks, months and years', () => {
    expect(formatRelativeTime(NOW - 7 * DAY, NOW)).toBe('1w ago');
    expect(formatRelativeTime(NOW - 3 * 7 * DAY, NOW)).toBe('3w ago');
    expect(formatRelativeTime(NOW - 60 * DAY, NOW)).toBe('2mo ago');
    expect(formatRelativeTime(NOW - 400 * DAY, NOW)).toBe('1y ago');
  });

  it('treats a timestamp in the future as "just now"', () => {
    expect(formatRelativeTime(NOW + HOUR, NOW)).toBe('just now');
  });
});
