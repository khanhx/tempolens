// Header-click sort cycle: natural direction first, then the opposite, then off.
import type { Sort, SortDir } from '../query/url-state';
import type { SortType } from '../sort';

/** Newest or biggest first for times, durations and numbers; A→Z for text. */
export const firstDirection = (type: SortType): SortDir => (type === 'keyword' ? 'asc' : 'desc');

/** The sort after clicking `column`: a new column starts at its natural direction, a second click flips, a third clears. */
export function nextSort(current: Sort | null, column: string, type: SortType): Sort | null {
  const first = firstDirection(type);
  if (current?.column !== column) return { column, dir: first };
  return current.dir === first ? { column, dir: first === 'asc' ? 'desc' : 'asc' } : null;
}
