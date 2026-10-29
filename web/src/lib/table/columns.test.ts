import { describe, expect, it } from 'vitest';
import { listSearch, parseListState } from '../query/url-state';
import {
  clampWidth,
  columnsKey,
  decodeColumns,
  dropColumn,
  encodeColumns,
  isMemoId,
  loadColumns,
  loadWidths,
  MAX_COLUMN_WIDTH,
  memoId,
  memoKeyOf,
  memoKeys,
  MIN_COLUMN_WIDTH,
  moveColumn,
  pickerOrder,
  resolveColumns,
  saveColumns,
  saveWidths,
  widthsKey,
} from './columns';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('memo column ids', () => {
  it('maps keys to ids and back', () => {
    expect(memoId('team,region')).toBe('memo:team,region');
    expect(memoKeyOf('memo:team,region')).toBe('team,region');
    expect(isMemoId('memo:a')).toBe(true);
    expect(isMemoId('memo:')).toBe(false);
    expect(isMemoId('sa:a')).toBe(false);
  });

  it('collects memo keys from rows, sorted and unique', () => {
    const rows = [{ memo: { fields: { b: {}, a: {} } } }, {}, { memo: { fields: { a: {}, c: {} } } }];
    expect(memoKeys(rows)).toEqual(['a', 'b', 'c']);
  });
});

describe('cols URL encoding', () => {
  it('round-trips ids through the URL, including memo keys with commas, colons and percent signs', () => {
    const cols = ['status', 'sa:CustomKeyword', memoId('team,region'), memoId('50%: done'), memoId('ünïcode')];
    const search = listSearch({ ...parseListState(''), cols });
    expect(parseListState(search).cols).toEqual(cols);
    expect(parseListState(new URL(`http://x/${search}`).search).cols).toEqual(cols);
  });

  it('still reads plain comma lists from older links', () => {
    expect(parseListState('?cols=status,id,sa:Foo').cols).toEqual(['status', 'id', 'sa:Foo']);
  });

  it('reads a hand-written single-encoded memo key with a comma as one id', () => {
    const search = '?cols=status,memo%3Ateam%2Cregion';
    expect(parseListState(search).cols).toEqual(['status', 'memo:team,region']);
    expect(parseListState(new URL(`http://x/${search}`).search).cols).toEqual(['status', 'memo:team,region']);
    expect(parseListState('?cols=memo%3Ateam%2Cregion').cols).toEqual(['memo:team,region']);
    expect(parseListState('?cols=memo:team%2Cregion').cols).toEqual(['memo:team,region']);
  });

  it('reads the form the list page writes, with ids encoded inside an encoded value', () => {
    const search = listSearch({ ...parseListState(''), cols: ['status', memoId('team,region')] });
    expect(search).toBe('?cols=status%2Cmemo%253Ateam%252Cregion');
    expect(parseListState(search).cols).toEqual(['status', 'memo:team,region']);
    expect(parseListState('?cols=status%2Cid').cols).toEqual(['status', 'id']);
  });

  it('keeps stale ids in the parsed list so resolveColumns can drop them', () => {
    const cols = parseListState('?cols=status,gone,memo%3Ateam%2Cregion').cols;
    expect(cols).toEqual(['status', 'gone', 'memo:team,region']);
    expect(resolveColumns([cols], ['id'], (id) => id === 'status' || isMemoId(id))).toEqual(['status', 'memo:team,region']);
    expect(resolveColumns([parseListState('?cols=gone%2Calso-gone').cols], ['id'], () => false)).toEqual(['id']);
  });

  it('skips empty and malformed parts and duplicates', () => {
    expect(decodeColumns('id,,%E0%A4%A,id,run')).toEqual(['id', 'run']);
    expect(decodeColumns(',')).toBeNull();
    expect(decodeColumns(null)).toBeNull();
    expect(encodeColumns(['a,b', 'c'])).toBe('a%2Cb,c');
  });

  it('keeps a sort on a column id that contains colons', () => {
    const sort = { column: memoId('a:b'), dir: 'desc' as const };
    expect(parseListState(listSearch({ ...parseListState(''), sort })).sort).toEqual(sort);
    expect(parseListState('?sort=sa:Foo:asc').sort).toEqual({ column: 'sa:Foo', dir: 'asc' });
  });
});

describe('resolveColumns', () => {
  const known = (id: string) => ['status', 'id', 'run', 'type'].includes(id) || isMemoId(id);
  const fallback = ['status', 'id'];

  it('prefers the URL, then the saved order, then the default', () => {
    expect(resolveColumns([['run', 'id'], ['type']], fallback, known)).toEqual(['run', 'id']);
    expect(resolveColumns([null, ['type', 'status']], fallback, known)).toEqual(['type', 'status']);
    expect(resolveColumns([null, null], fallback, known)).toEqual(fallback);
  });

  it('drops stale ids and falls through when none are left', () => {
    expect(resolveColumns([['gone', 'run', 'memo:k', 'run']], fallback, known)).toEqual(['run', 'memo:k']);
    expect(resolveColumns([['gone'], ['also-gone', 'type']], fallback, known)).toEqual(['type']);
    expect(resolveColumns([['gone'], null], fallback, known)).toEqual(fallback);
  });
});

describe('saved column order', () => {
  it('saves, loads and clears the order per namespace', () => {
    const s = memoryStorage();
    saveColumns('ns-a', ['run', memoId('a,b'), 'id'], s);
    saveColumns('*', ['namespace', 'id'], s);
    expect(loadColumns('ns-a', s)).toEqual(['run', 'memo:a,b', 'id']);
    expect(loadColumns('*', s)).toEqual(['namespace', 'id']);
    expect(s.data.has(columnsKey('ns-a'))).toBe(true);
    saveColumns('ns-a', null, s);
    expect(loadColumns('ns-a', s)).toBeNull();
    expect(s.data.has(columnsKey('ns-a'))).toBe(false);
  });

  it('ignores corrupt or wrong-shaped values and storage errors', () => {
    const s = memoryStorage({ [columnsKey('a')]: '{', [columnsKey('b')]: '[1,2]', [columnsKey('c')]: '[]' });
    expect(loadColumns('a', s)).toBeNull();
    expect(loadColumns('b', s)).toBeNull();
    expect(loadColumns('c', s)).toBeNull();
    const failing = {
      ...s,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => saveColumns('a', ['id'], failing)).not.toThrow();
    expect(loadColumns('x', undefined)).toBeNull();
  });
});

describe('saved column widths', () => {
  it('saves, loads and clears widths per namespace, beside the order', () => {
    const s = memoryStorage();
    saveWidths('ns-a', { id: 240, [memoId('a,b')]: 90 }, s);
    saveWidths('*', { namespace: 100 }, s);
    expect(widthsKey('ns-a')).toBe(`${columnsKey('ns-a')}.widths`);
    expect(loadWidths('ns-a', s)).toEqual({ id: 240, 'memo:a,b': 90 });
    expect(loadWidths('*', s)).toEqual({ namespace: 100 });
    saveWidths('ns-a', {}, s);
    expect(loadWidths('ns-a', s)).toEqual({});
    expect(s.data.has(widthsKey('ns-a'))).toBe(false);
  });

  it('clamps to the minimum and maximum width', () => {
    expect(clampWidth(10)).toBe(MIN_COLUMN_WIDTH);
    expect(clampWidth(99.6)).toBe(100);
    expect(clampWidth(1e6)).toBe(MAX_COLUMN_WIDTH);
    expect(clampWidth(Number.NaN)).toBe(MIN_COLUMN_WIDTH);
    const s = memoryStorage({ [widthsKey('a')]: JSON.stringify({ id: 5, run: 'wide', type: 150 }) });
    expect(loadWidths('a', s)).toEqual({ id: MIN_COLUMN_WIDTH, type: 150 });
  });

  it('ignores corrupt or wrong-shaped values and storage errors', () => {
    const s = memoryStorage({ [widthsKey('a')]: '{', [widthsKey('b')]: '[1,2]', [widthsKey('c')]: 'null' });
    expect(loadWidths('a', s)).toEqual({});
    expect(loadWidths('b', s)).toEqual({});
    expect(loadWidths('c', s)).toEqual({});
    const failing = {
      ...s,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => saveWidths('a', { id: 100 }, failing)).not.toThrow();
    expect(loadWidths('x', undefined)).toEqual({});
  });
});

describe('reordering', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('moves a column to an index, clamped', () => {
    expect(moveColumn(ids, 'b', 2)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveColumn(ids, 'b', 0)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveColumn(ids, 'a', -1)).toEqual(ids);
    expect(moveColumn(ids, 'd', 9)).toEqual(ids);
    expect(moveColumn(ids, 'x', 0)).toEqual(ids);
  });

  it('drops a column before or after another', () => {
    expect(dropColumn(ids, 'd', 'b', false)).toEqual(['a', 'd', 'b', 'c']);
    expect(dropColumn(ids, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
    expect(dropColumn(ids, 'a', 'a', true)).toEqual(ids);
    expect(dropColumn(ids, 'x', 'a', true)).toEqual(ids);
  });

  it('lists visible columns in order, then hidden ones alphabetically', () => {
    const all = [
      { id: 'status', label: 'Status' },
      { id: 'id', label: 'Workflow ID' },
      { id: 'run', label: 'Run ID' },
      { id: 'memo:x', label: 'alpha' },
    ];
    const { shown, hidden } = pickerOrder(all, ['run', 'status', 'gone']);
    expect(shown.map((c) => c.id)).toEqual(['run', 'status']);
    expect(hidden.map((c) => c.id)).toEqual(['memo:x', 'id']);
  });
});
