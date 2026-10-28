import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { activityQuery, busyText, commonAttributes, eventQuery, graphWarnings, listQuery, namespacesParam, partialText, xapi } from './xapi';

afterEach(() => vi.unstubAllGlobals());

describe('xapi parameters', () => {
  it('builds namespace selections', () => {
    expect(namespacesParam('*')).toBe('*');
    expect(namespacesParam([' a', 'b', 'a', ''])).toBe('a,b');
    expect(() => namespacesParam([])).toThrow();
  });

  it('clamps the page size and passes the token through', () => {
    expect(listQuery('*', { query: ' q ', pageSize: 500, pageToken: 'tok' })).toEqual({ namespaces: '*', query: 'q', pageSize: 100, pageToken: 'tok' });
    expect(listQuery(['a'], {})).toEqual({ namespaces: 'a', query: undefined, pageSize: 50, pageToken: undefined });
  });

  it('validates searches and passes max', () => {
    expect(activityQuery({ namespaces: ['a'], activityType: 'AlwaysFail', mode: 'pending', minAttempt: 3, max: 50 })).toEqual({
      namespaces: 'a',
      query: undefined,
      activityType: 'AlwaysFail',
      mode: 'pending',
      minAttempt: 3,
      max: 50,
    });
    expect(() => activityQuery({ namespaces: '*', activityType: 'x', mode: 'history', minAttempt: 2 })).toThrow(/pending/);
    expect(() => activityQuery({ namespaces: '*', activityType: ' ', mode: 'pending' })).toThrow();
    expect(() => eventQuery({ namespaces: '*' })).toThrow(/event type/);
    expect(eventQuery({ namespaces: '*', failureText: 'boom', max: 5 })).toMatchObject({ failureText: 'boom', max: 5, eventType: undefined });
  });

  it('calls the endpoints with encoded parameters', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await xapi.workflows('*', { pageSize: 20, pageToken: 'a+b' });
    await xapi.count(['a', 'b'], 'ExecutionStatus = "Running"');
    await xapi.searchEvent({ namespaces: ['tui-seed-a'], eventType: 'EVENT_TYPE_ACTIVITY_TASK_FAILED', max: 5 });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      '/api/x/workflows?namespaces=*&pageSize=20&pageToken=a%2Bb',
      '/api/x/workflows/count?namespaces=a%2Cb&query=ExecutionStatus+%3D+%22Running%22',
      '/api/x/search/event?namespaces=tui-seed-a&eventType=EVENT_TYPE_ACTIVITY_TASK_FAILED&max=5',
    ]);
  });
});

describe('messages', () => {
  const base = { scanned: 200, candidates: 200 };

  it('describes each partial reason', () => {
    expect(partialText({ ...base, partial: false, partialReasons: [] })).toBeNull();
    expect(partialText({ ...base, partial: true, partialReasons: ['cap'] })).toBe(
      'Partial result: scanned 200 of 200 candidate workflows; a scan limit was reached (candidates, history size or hits per workflow) (cap). Narrow the query, for example with a time range or a status, to see everything.',
    );
    expect(partialText({ scanned: 12, candidates: 40, partial: true, partialReasons: ['timeout'] })).toMatch(/scanned 12 of 40.*timed out \(timeout\)\. Narrow/);
    expect(partialText({ ...base, partial: true, partialReasons: ['error'] })).toBe('Partial result: scanned 200 of 200 candidate workflows; some workflows could not be read (error).');
    expect(partialText({ ...base, partial: true, partialReasons: ['cap', 'error'] })).toMatch(/\(cap\); some workflows could not be read \(error\)/);
  });

  it('turns 429 into a retry message', () => {
    expect(busyText(new ApiError(429, 'x', { retryAfterMs: 4200 }))).toBe('The server is busy; retry in 5 s.');
    expect(busyText(new ApiError(429, 'x'))).toBe('The server is busy; retry in a few seconds.');
    expect(busyText(new ApiError(500, 'x'))).toBeNull();
    expect(busyText(new Error('x'))).toBeNull();
  });
});

describe('commonAttributes', () => {
  it('keeps system attributes and custom ones every namespace shares', () => {
    const sys = { WorkflowType: 'Keyword', StartTime: 'Datetime' } as const;
    const out = commonAttributes({
      'tui-seed-a': { types: { ...sys, SeedRun: 'Keyword', SeedPriority: 'Int', OnlyA: 'Text' }, custom: ['OnlyA', 'SeedPriority', 'SeedRun'] },
      'tui-seed-b': { types: { ...sys, SeedRun: 'Keyword', SeedPriority: 'Keyword' }, custom: ['SeedPriority', 'SeedRun'] },
      default: { types: { ...sys }, custom: [] },
    });
    expect(out.custom).toEqual([]);
    expect(out.types).toEqual(sys);
    expect(out.missing).toEqual({ OnlyA: ['tui-seed-b', 'default'], SeedPriority: ['default'], SeedRun: ['default'] });

    const ab = commonAttributes({
      a: { types: { SeedRun: 'Keyword', SeedPriority: 'Int' }, custom: ['SeedPriority', 'SeedRun'] },
      b: { types: { SeedRun: 'Keyword', SeedPriority: 'Keyword' }, custom: ['SeedPriority', 'SeedRun'] },
    });
    expect(ab.custom).toEqual(['SeedRun']);
    expect(ab.missing).toEqual({ SeedPriority: ['a', 'b'] });
  });
});

describe('graphWarnings', () => {
  it('shows a partial walk with the server reason from notes', () => {
    const w = graphWarnings({ truncated: false, partial: true, notes: ['could not read the history of wf-1: namespace rate limit exceeded'] });
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/could not be read/);
    expect(w[1]).toContain('namespace rate limit exceeded');
  });

  it('is empty for a complete graph and reports truncation', () => {
    expect(graphWarnings({ truncated: false, partial: false, notes: [] })).toEqual([]);
    expect(graphWarnings({ truncated: true, partial: false, notes: [] })[0]).toMatch(/node limit/);
  });
});
