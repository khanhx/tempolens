// Client-side sorting of a loaded window of rows. SQL visibility cannot
// ORDER BY, so the list sorts what it has loaded and says so in a banner.
import { parseDuration, parseTimestamp } from './time';
import type { SortDir } from './query/url-state';

export type SortType = 'datetime' | 'int' | 'number' | 'duration' | 'keyword';

type Key = number | bigint | string;

/** Normalises a raw cell value to a comparable key; null sorts last. */
export function sortKey(raw: unknown, type: SortType): Key | null {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (type) {
    case 'datetime': {
      const d = parseTimestamp(String(raw));
      return d ? d.getTime() : null;
    }
    case 'int': {
      if (typeof raw === 'number' || typeof raw === 'bigint') return raw;
      const s = String(raw).trim();
      if (!/^-?\d+$/.test(s)) return null;
      const n = Number(s);
      return Number.isSafeInteger(n) ? n : BigInt(s);
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw));
      return Number.isFinite(n) ? n : null;
    }
    case 'duration':
      return parseDuration(String(raw));
    case 'keyword':
      return String(raw);
  }
}

function compareKeys(a: Key, b: Key): number {
  if (typeof a === 'string' || typeof b === 'string') {
    const x = String(a);
    const y = String(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Returns a sorted copy. Stable (equal keys keep their order), and rows
 * without a value go last in both directions.
 */
export function sortRows<T>(rows: readonly T[], get: (row: T) => unknown, type: SortType, dir: SortDir): T[] {
  const keyed = rows.map((row, index) => ({ row, index, key: sortKey(get(row), type) }));
  keyed.sort((a, b) => {
    if (a.key === null || b.key === null) {
      if (a.key === b.key) return a.index - b.index;
      return a.key === null ? 1 : -1;
    }
    const c = compareKeys(a.key, b.key);
    return (dir === 'asc' ? c : -c) || a.index - b.index;
  });
  return keyed.map((k) => k.row);
}

/** True when the visibility store can ORDER BY (Elasticsearch). */
export const supportsOrderBy = (visibilityStore: string | undefined) => !!visibilityStore?.toLowerCase().includes('elasticsearch');
