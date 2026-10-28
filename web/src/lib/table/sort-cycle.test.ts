import { describe, expect, it } from 'vitest';
import type { SortType } from '../sort';
import { firstDirection, nextSort } from './sort-cycle';

describe('sort cycle', () => {
  it('starts descending for times, durations and numbers, ascending for text', () => {
    const first: Record<SortType, string> = { datetime: 'desc', duration: 'desc', int: 'desc', number: 'desc', keyword: 'asc' };
    for (const [type, dir] of Object.entries(first)) expect(firstDirection(type as SortType), type).toBe(dir);
  });

  it('cycles a text column: ascending, descending, off', () => {
    const a = nextSort(null, 'type', 'keyword');
    expect(a).toEqual({ column: 'type', dir: 'asc' });
    const b = nextSort(a, 'type', 'keyword');
    expect(b).toEqual({ column: 'type', dir: 'desc' });
    expect(nextSort(b, 'type', 'keyword')).toBeNull();
  });

  it('cycles a datetime column: descending, ascending, off', () => {
    const a = nextSort(null, 'start', 'datetime');
    expect(a).toEqual({ column: 'start', dir: 'desc' });
    const b = nextSort(a, 'start', 'datetime');
    expect(b).toEqual({ column: 'start', dir: 'asc' });
    expect(nextSort(b, 'start', 'datetime')).toBeNull();
  });

  it('starts over at the natural direction when another column is clicked', () => {
    expect(nextSort({ column: 'start', dir: 'asc' }, 'history-length', 'int')).toEqual({ column: 'history-length', dir: 'desc' });
    expect(nextSort({ column: 'start', dir: 'desc' }, 'memo:owner', 'keyword')).toEqual({ column: 'memo:owner', dir: 'asc' });
  });
});
