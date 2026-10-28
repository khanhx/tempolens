import { describe, expect, it } from 'vitest';
import {
  durationBetween,
  formatAbsolute,
  formatDuration,
  formatRelative,
  formatTimestamp,
  parseDuration,
  parseTimestamp,
} from './time';

describe('parseTimestamp', () => {
  it('accepts nanosecond precision and keeps milliseconds', () => {
    expect(parseTimestamp('2026-10-27T08:00:00.123456789Z')?.toISOString()).toBe('2026-10-27T08:00:00.123Z');
    expect(parseTimestamp('2026-10-27T08:00:00.5Z')?.toISOString()).toBe('2026-10-27T08:00:00.500Z');
    expect(parseTimestamp('2026-10-27T15:00:00+07:00')?.toISOString()).toBe('2026-10-27T08:00:00.000Z');
  });

  it('returns null for empty or invalid input', () => {
    expect(parseTimestamp(undefined)).toBeNull();
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('yesterday')).toBeNull();
  });
});

describe('formatAbsolute', () => {
  it('formats UTC with milliseconds and a 24-hour clock', () => {
    expect(formatAbsolute(new Date('2026-10-27T00:05:09.007Z'), 'utc')).toBe('2026-10-27 00:05:09.007 UTC');
    expect(formatAbsolute(new Date('2026-10-27T23:59:59.999Z'), 'utc')).toBe('2026-10-27 23:59:59.999 UTC');
  });

  it('formats local time with a zone name', () => {
    expect(formatAbsolute(new Date('2026-10-27T00:00:00Z'), 'local')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \S+/,
    );
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-10-27T08:00:00Z');
  it('picks the largest fitting unit', () => {
    expect(formatRelative(new Date(now), now)).toBe('now');
    expect(formatRelative(new Date(now - 30_000), now)).toBe('30 seconds ago');
    expect(formatRelative(new Date(now - 5 * 60_000), now)).toBe('5 minutes ago');
    expect(formatRelative(new Date(now - 3 * 3_600_000), now)).toBe('3 hours ago');
    expect(formatRelative(new Date(now - 86_400_000), now)).toBe('yesterday');
    expect(formatRelative(new Date(now + 2 * 3_600_000), now)).toBe('in 2 hours');
  });
});

describe('formatTimestamp', () => {
  const now = Date.parse('2026-10-27T08:00:00Z');
  it('follows mode and zone', () => {
    expect(formatTimestamp('2026-10-27T07:58:00Z', { mode: 'relative', zone: 'utc', now })).toBe('2 minutes ago');
    expect(formatTimestamp('2026-10-27T07:58:00Z', { mode: 'absolute', zone: 'utc', now })).toBe(
      '2026-10-27 07:58:00.000 UTC',
    );
    expect(formatTimestamp(null, { mode: 'absolute', zone: 'utc' })).toBe('');
  });
});

describe('durations', () => {
  it('parses protobuf durations', () => {
    expect(parseDuration('12.5s')).toBe(12_500);
    expect(parseDuration('0.000100s')).toBeCloseTo(0.1);
    expect(parseDuration('-3s')).toBe(-3000);
    expect(parseDuration('3m')).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
  });

  it('formats human durations', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(12_345)).toBe('12.35s');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(3_723_000)).toBe('1h 2m 3s');
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000 + 5_000)).toBe('3d 4h 5s');
    expect(formatDuration(-1500)).toBe('-1.5s');
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });

  it('computes the span between timestamps', () => {
    expect(durationBetween('2026-10-27T08:00:00Z', '2026-10-27T08:00:01.250Z')).toBe(1250);
    expect(durationBetween('2026-10-27T08:00:00Z', null)).toBeNull();
  });
});
