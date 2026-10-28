import { describe, expect, it } from 'vitest';
import { sortRows, sortKey } from '../sort';
import type { Filter, SAType } from './build';
import { buildClause, buildQuery, literal, opsFor, quoteField } from './build';
import { parseQuery, tokenize } from './parse';
import { deletePreset, listPresets, MAX_PRESETS, savePreset } from './presets';
import { activeQuickFilter, quickFilters } from './quick-filters';
import { describeRange, formatRange, parseRange, rangeClause } from './range';
import { listSearch, parseListState } from './url-state';
import { splitOrderBy, withOrderBy, wrap } from './wrap';

const types: Record<string, SAType> = {
  WorkflowType: 'Keyword',
  WorkflowId: 'Keyword',
  ExecutionStatus: 'Keyword',
  StartTime: 'Datetime',
  HistoryLength: 'Int',
  Score: 'Double',
  Flag: 'Bool',
  BuildIds: 'KeywordList',
  Note: 'Text',
  'Odd-Name': 'Keyword',
  ParentWorkflowId: 'Keyword',
};

describe('build', () => {
  it('quotes and escapes strings', () => {
    expect(buildClause({ field: 'WorkflowId', op: '=', values: ['a"b\\c'] }, 'Keyword')).toBe('WorkflowId = "a\\"b\\\\c"');
    expect(quoteField('Odd-Name')).toBe('`Odd-Name`');
  });

  it('builds every operator shape', () => {
    const q = buildQuery(
      [
        { field: 'BuildIds', op: 'IN', values: ['a', 'b'] },
        { field: 'HistoryLength', op: 'BETWEEN', values: ['1', '10'] },
        { field: 'StartTime', op: '>=', values: ['2026-10-27T00:00:00Z'] },
        { field: 'WorkflowType', op: 'IS NOT NULL', values: [] },
        { field: 'Flag', op: '=', values: ['true'] },
      ],
      types,
    );
    expect(q).toBe(
      'BuildIds IN ("a", "b") AND HistoryLength BETWEEN 1 AND 10 AND StartTime >= "2026-10-27T00:00:00Z" AND WorkflowType IS NOT NULL AND Flag = true',
    );
  });

  it('gates STARTS_WITH on the capability', () => {
    const f: Filter = { field: 'WorkflowId', op: 'STARTS_WITH', values: ['seed-'] };
    expect(() => buildClause(f, 'Keyword')).toThrow(/not supported/);
    expect(buildClause(f, 'Keyword', { prefixSearch: true })).toBe('WorkflowId STARTS_WITH "seed-"');
    expect(opsFor('Keyword')).not.toContain('STARTS_WITH');
  });

  it('validates values', () => {
    expect(() => literal('Int', '1.5')).toThrow();
    expect(() => literal('Bool', 'yes')).toThrow();
    expect(() => literal('Datetime', 'soon')).toThrow();
    expect(literal('Datetime', '2026-10-27')).toBe('"2026-10-27T00:00:00.000Z"');
    expect(() => buildQuery([{ field: 'Nope', op: '=', values: ['x'] }], types)).toThrow(/unknown/);
    expect(() => buildClause({ field: 'HistoryLength', op: 'BETWEEN', values: ['1'] }, 'Int')).toThrow();
  });
});

describe('parse', () => {
  const roundTrip: Filter[][] = [
    [{ field: 'WorkflowId', op: '=', values: ['a"b'] }],
    [{ field: 'BuildIds', op: 'IN', values: ['x', 'y z'] }],
    [{ field: 'HistoryLength', op: 'BETWEEN', values: ['1', '20'] }],
    [{ field: 'WorkflowType', op: 'IS NULL', values: [] }],
    [{ field: 'WorkflowId', op: 'STARTS_WITH', values: ['seed-'] }],
    [
      { field: 'ExecutionStatus', op: '!=', values: ['Running'] },
      { field: 'StartTime', op: '<', values: ['2026-10-27T08:00:00Z'] },
      { field: 'Score', op: '>=', values: ['0.5'] },
      { field: 'Flag', op: '=', values: ['false'] },
      { field: 'Odd-Name', op: '=', values: ['v'] },
    ],
  ];

  it('round-trips build → parse', () => {
    for (const filters of roundTrip) {
      const q = buildQuery(filters, types, { prefixSearch: true });
      expect(parseQuery(q, types), q).toEqual(filters);
    }
  });

  it('accepts upstream spellings', () => {
    expect(parseQuery(`WorkflowType='x' and ExecutionStatus<>"Failed" AND WorkflowId is not null`, types)).toEqual([
      { field: 'WorkflowType', op: '=', values: ['x'] },
      { field: 'ExecutionStatus', op: '!=', values: ['Failed'] },
      { field: 'WorkflowId', op: 'IS NOT NULL', values: [] },
    ]);
    expect(parseQuery('', types)).toEqual([]);
  });

  it('keeps unsupported queries raw', () => {
    for (const q of [
      'WorkflowId = "a" OR WorkflowId = "b"',
      '(WorkflowId = "a")',
      'WorkflowId = "a" ORDER BY StartTime',
      'Unknown = "x"',
      'HistoryLength = "5"',
      'WorkflowType > "a"',
      'WorkflowId = "unterminated',
      'WorkflowId =',
    ]) {
      expect(parseQuery(q, types), q).toBeNull();
    }
    expect(tokenize('a ! b')).toBeNull();
  });
});

describe('wrap', () => {
  it('wraps the user query before appending', () => {
    expect(wrap('a OR b', 'c')).toBe('(a OR b) AND c');
    expect(wrap('', 'c', '', 'd')).toBe('c AND d');
    expect(wrap('a', '')).toBe('a');
    expect(wrap('a OR b ORDER BY StartTime DESC', 'c')).toBe('(a OR b) AND c ORDER BY StartTime DESC');
  });

  it('ignores ORDER BY inside quotes', () => {
    expect(splitOrderBy('WorkflowId = "x ORDER BY y"')).toEqual({ where: 'WorkflowId = "x ORDER BY y"', orderBy: '' });
    expect(withOrderBy('a ORDER BY X', 'ORDER BY Y ASC')).toBe('a ORDER BY Y ASC');
    expect(withOrderBy('a ORDER BY X', '')).toBe('a');
  });
});

describe('range', () => {
  const now = Date.parse('2026-10-27T08:00:00Z');
  it('parses, formats and resolves relative ranges at fetch time', () => {
    const r = parseRange('24h');
    expect(r).toEqual({ field: 'StartTime', kind: 'last', amount: 24, unit: 'h' });
    expect(r && rangeClause(r, now)).toBe('StartTime >= "2026-10-26T08:00:00.000Z"');
    const older = parseRange('close:>1h');
    expect(older && rangeClause(older, now)).toBe('CloseTime < "2026-10-27T07:00:00.000Z"');
    expect(older && formatRange(older)).toBe('close:>1h');
    expect(older && describeRange(older)).toBe('Closed more than 1 hour ago');
  });

  it('handles absolute bounds', () => {
    const r = parseRange('2026-10-27T00:00:00Z..2026-10-28T00:00:00Z');
    expect(r && rangeClause(r)).toBe('StartTime BETWEEN "2026-10-27T00:00:00.000Z" AND "2026-10-28T00:00:00.000Z"');
    const open = parseRange('close:..2026-10-28T00:00:00Z');
    expect(open && rangeClause(open)).toBe('CloseTime <= "2026-10-28T00:00:00.000Z"');
  });

  it('rejects junk', () => {
    for (const s of ['', '0h', '5y', 'x..y', '..', 'close:']) expect(parseRange(s), s).toBeNull();
  });
});

describe('url-state', () => {
  it('loads an old upstream ?query= link', () => {
    const s = parseListState('?query=WorkflowType%3D%22x%22&per-page=250&page=3');
    expect(s).toEqual({ query: 'WorkflowType="x"', range: '', sort: null, perPage: 250, cols: null, ns: null });
  });

  it('round-trips and omits defaults', () => {
    const s = parseListState('?query=a&range=close%3A24h&sort=start%3Adesc&per-page=500&cols=status,id&ns=a,b');
    expect(s.sort).toEqual({ column: 'start', dir: 'desc' });
    expect(parseListState(listSearch(s))).toEqual(s);
    expect(listSearch(parseListState(''))).toBe('');
  });

  it('drops invalid values', () => {
    const s = parseListState('?per-page=7&sort=start:sideways&range=bogus&cols=,');
    expect(s).toMatchObject({ perPage: 100, sort: null, range: '', cols: null });
  });
});

describe('quick filters', () => {
  it('gates task failures and detects the active filter', () => {
    const now = new Date('2026-10-27T08:00:00Z');
    expect(quickFilters(now).some((f) => f.id === 'task-failures')).toBe(false);
    const all = quickFilters(now, { reportedProblems: true });
    expect(all.some((f) => f.id === 'task-failures')).toBe(true);
    expect(activeQuickFilter(all, 'ExecutionStatus = "Failed"', 'close:24h')?.id).toBe('failed-24h');
    expect(activeQuickFilter(all, '', '')?.id).toBe('all');
    for (const f of all) {
      if (f.query) expect(parseQuery(f.query, { ...types, TemporalReportedProblems: 'KeywordList' }), f.id).not.toBeNull();
      if (f.range) expect(parseRange(f.range), f.id).not.toBeNull();
    }
  });
});

describe('presets', () => {
  class Mem {
    data = new Map<string, string>();
    getItem = (k: string) => this.data.get(k) ?? null;
    setItem = (k: string, v: string) => void this.data.set(k, v);
  }

  it('saves, replaces by name, deletes, and caps per namespace', () => {
    const s = new Mem();
    savePreset('a', { name: 'x', query: 'q1', range: '' }, s);
    savePreset('a', { name: 'x', query: 'q2', range: '1h' }, s);
    expect(listPresets('a', s)).toEqual([{ name: 'x', query: 'q2', range: '1h' }]);
    expect(listPresets('b', s)).toEqual([]);
    expect(deletePreset('a', 'x', s)).toEqual([]);
    for (let i = 0; i < MAX_PRESETS; i++) savePreset('a', { name: `p${i}`, query: '', range: '' }, s);
    expect(() => savePreset('a', { name: 'one-more', query: '', range: '' }, s)).toThrow(/50/);
    expect(() => savePreset('a', { name: '  ', query: '', range: '' }, s)).toThrow(/name/);
    s.setItem('tempolens.presets.c', '{bad');
    expect(listPresets('c', s)).toEqual([]);
  });
});

describe('sort', () => {
  const rows = [
    { id: 'a', t: '2026-10-27T08:00:00.5Z', n: '10' },
    { id: 'b', t: undefined, n: '9' },
    { id: 'c', t: '2026-10-27T07:00:00Z', n: '9007199254740993' },
    { id: 'd', t: '2026-10-27T08:00:00.5Z', n: undefined },
  ];
  it('sorts datetimes, keeps ties stable and puts nulls last', () => {
    expect(sortRows(rows, (r) => r.t, 'datetime', 'asc').map((r) => r.id)).toEqual(['c', 'a', 'd', 'b']);
    expect(sortRows(rows, (r) => r.t, 'datetime', 'desc').map((r) => r.id)).toEqual(['a', 'd', 'c', 'b']);
  });

  it('sorts int64 strings numerically', () => {
    expect(sortRows(rows, (r) => r.n, 'int', 'asc').map((r) => r.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(sortKey('9007199254740993', 'int')).toBe(9007199254740993n);
  });

  it('sorts keywords and durations', () => {
    expect(sortRows([{ k: 'b' }, { k: 'B' }, { k: 'a' }], (r) => r.k, 'keyword', 'asc').map((r) => r.k)).toEqual(['B', 'a', 'b']);
    expect(sortRows([{ d: '10s' }, { d: '2.5s' }], (r) => r.d, 'duration', 'asc').map((r) => r.d)).toEqual(['2.5s', '10s']);
  });
});
