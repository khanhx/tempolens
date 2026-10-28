import type { TimeMode, TimeZoneMode } from './prefs';

const FRACTION = /\.(\d+)/;

/**
 * Parses an RFC 3339 timestamp as Temporal emits it (up to nanosecond
 * precision). The fraction is cut to milliseconds before Date.parse.
 * Returns null for empty or invalid input.
 */
export function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const ms = Date.parse(value.replace(FRACTION, (_m, digits: string) => `.${digits.slice(0, 3).padEnd(3, '0')}`));
  return Number.isNaN(ms) ? null : new Date(ms);
}

const absoluteFormatters = new Map<TimeZoneMode, Intl.DateTimeFormat>();

function absoluteFormatter(zone: TimeZoneMode): Intl.DateTimeFormat {
  let f = absoluteFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hourCycle: 'h23',
      timeZone: zone === 'utc' ? 'UTC' : undefined,
      timeZoneName: zone === 'utc' ? undefined : 'short',
    });
    absoluteFormatters.set(zone, f);
  }
  return f;
}

/** `2026-10-27 08:00:00.123 UTC`, or with the local short zone name (`GMT+7`). */
export function formatAbsolute(date: Date, zone: TimeZoneMode): string {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const p of absoluteFormatter(zone).formatToParts(date)) parts[p.type] = p.value;
  const suffix = zone === 'utc' ? 'UTC' : (parts.timeZoneName ?? '');
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond} ${suffix}`.trim();
}

const relativeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

/** `5 minutes ago`, `in 2 hours`, `now`. */
export function formatRelative(date: Date, now: number = Date.now()): string {
  const seconds = Math.round((date.getTime() - now) / 1000);
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size || unit === 'second') {
      return relativeFormatter.format(Math.trunc(seconds / size), unit);
    }
  }
  return relativeFormatter.format(0, 'second');
}

export interface TimestampOptions {
  mode: TimeMode;
  zone: TimeZoneMode;
  now?: number;
}

/** Formats a timestamp per the user's time preferences; empty input gives an empty string. */
export function formatTimestamp(value: string | Date | null | undefined, opts: TimestampOptions): string {
  const date = value instanceof Date ? value : parseTimestamp(value);
  if (!date) return '';
  return opts.mode === 'relative' ? formatRelative(date, opts.now) : formatAbsolute(date, opts.zone);
}

/**
 * Parses a protobuf JSON Duration (`"12.5s"`, `"0.000100s"`, `"-3s"`) into
 * milliseconds. Returns null for anything else.
 */
export function parseDuration(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(-?\d+(?:\.\d+)?)s$/.exec(value.trim());
  return m?.[1] ? Number(m[1]) * 1000 : null;
}

const DURATION_UNITS: readonly [string, number][] = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1000],
];

/**
 * Human duration: `850ms`, `12.35s`, `1h 2m 3s`, `3d 4h`. Units above a
 * minute show at most the three largest non-zero parts.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign}${Math.round(abs)}ms`;
  if (abs < 60_000) return `${sign}${Number((abs / 1000).toFixed(2))}s`;
  const parts: string[] = [];
  let rest = Math.floor(abs);
  for (const [label, size] of DURATION_UNITS) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0) parts.push(`${n}${label}`);
  }
  return sign + parts.slice(0, 3).join(' ');
}

/** Duration between two timestamps; null when either side is missing. */
export function durationBetween(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  const a = parseTimestamp(start);
  const b = parseTimestamp(end);
  return a && b ? b.getTime() - a.getTime() : null;
}

const HUMAN_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parses a human duration such as `90s`, `5m`, `1h30m` or `2d`; a bare
 * number means seconds. Returns milliseconds, or null when invalid.
 */
export function parseHumanDuration(value: string): number | null {
  const s = value.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gy;
  let total = 0;
  let consumed = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    total += Number(m[1]) * (HUMAN_UNITS[m[2] ?? ''] ?? 0);
    consumed = re.lastIndex;
  }
  return consumed === s.length && consumed > 0 ? total : null;
}

/** Milliseconds → protobuf JSON Duration (`"90s"`, `"0.5s"`). */
export function toProtoDuration(ms: number): string {
  return `${Number((ms / 1000).toFixed(3))}s`;
}
