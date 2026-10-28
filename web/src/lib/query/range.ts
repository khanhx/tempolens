// Time-range filter kept in the URL as `range=` and resolved at fetch time,
// so a bookmarked "last 24 h" stays relative. Grammar:
//   [close:]<n><m|h|d>     within the last n units
//   [close:]><n><m|h|d>    older than n units
//   [close:]<from>..<to>   absolute RFC 3339 bounds; either side may be empty
// The default field is StartTime; `close:` switches to CloseTime.
import { quoteString } from './build';

export type RangeField = 'StartTime' | 'CloseTime';

export type TimeRange =
  | { field: RangeField; kind: 'last' | 'older'; amount: number; unit: 'm' | 'h' | 'd' }
  | { field: RangeField; kind: 'between'; from: string; to: string };

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export const RANGE_PRESETS = ['15m', '1h', '24h', '7d', '30d'] as const;

export function parseRange(s: string | null | undefined): TimeRange | null {
  if (!s) return null;
  let rest = s.trim();
  let field: RangeField = 'StartTime';
  if (rest.startsWith('close:')) {
    field = 'CloseTime';
    rest = rest.slice(6);
  }
  const rel = /^(>?)(\d{1,5})([mhd])$/.exec(rest);
  if (rel?.[2] && rel[3]) {
    const amount = Number(rel[2]);
    if (amount <= 0) return null;
    return { field, kind: rel[1] ? 'older' : 'last', amount, unit: rel[3] as 'm' | 'h' | 'd' };
  }
  const sep = rest.indexOf('..');
  if (sep >= 0) {
    const from = rest.slice(0, sep);
    const to = rest.slice(sep + 2);
    if (!from && !to) return null;
    if ((from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to)))) return null;
    return { field, kind: 'between', from, to };
  }
  return null;
}

export function formatRange(r: TimeRange): string {
  const prefix = r.field === 'CloseTime' ? 'close:' : '';
  if (r.kind === 'between') return `${prefix}${r.from}..${r.to}`;
  return `${prefix}${r.kind === 'older' ? '>' : ''}${r.amount}${r.unit}`;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The query clause for a range at time `now`. */
export function rangeClause(r: TimeRange, now: number = Date.now()): string {
  if (r.kind !== 'between') {
    return `${r.field} ${r.kind === 'last' ? '>=' : '<'} ${quoteString(iso(now - r.amount * UNIT_MS[r.unit]))}`;
  }
  const from = r.from ? quoteString(iso(Date.parse(r.from))) : '';
  const to = r.to ? quoteString(iso(Date.parse(r.to))) : '';
  if (from && to) return `${r.field} BETWEEN ${from} AND ${to}`;
  return from ? `${r.field} >= ${from}` : `${r.field} <= ${to}`;
}

const UNIT_LABEL = { m: 'minute', h: 'hour', d: 'day' } as const;

export function describeRange(r: TimeRange): string {
  const what = r.field === 'CloseTime' ? 'Closed' : 'Started';
  if (r.kind === 'between') return `${what} ${r.from ? `from ${r.from}` : ''} ${r.to ? `to ${r.to}` : ''}`.replace(/\s+/g, ' ').trim();
  const span = `${r.amount} ${UNIT_LABEL[r.unit]}${r.amount === 1 ? '' : 's'}`;
  return r.kind === 'last' ? `${what} in the last ${span}` : `${what} more than ${span} ago`;
}
