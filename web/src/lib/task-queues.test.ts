import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_TTL_MS,
  clearQueueCache,
  filterQueues,
  loadQueueSuggestions,
  loadRecentQueues,
  mergeQueues,
  PARTIAL_TTL_MS,
  RECENT_MAX,
  recentKey,
  recordRecentQueue,
  SCHEDULE_DESCRIBES,
} from './task-queues';

const RUNNING = 'WORKFLOW_EXECUTION_STATUS_RUNNING';
const COMPLETED = 'WORKFLOW_EXECUTION_STATUS_COMPLETED';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

type Handler = (url: URL) => Response;
let calls: string[] = [];

function serve(handler: Handler) {
  vi.stubGlobal('fetch', (url: string) => {
    calls.push(url);
    return Promise.resolve(handler(new URL(url, 'http://x')));
  });
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

const row = (id: string, taskQueue: string, status = COMPLETED) => ({ execution: { workflowId: id }, taskQueue, status });

beforeEach(() => {
  calls = [];
  clearQueueCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mergeQueues', () => {
  it('dedupes the three sources, ranks recent first, then by running count and name', () => {
    const items = mergeQueues(
      {
        workflows: new Map([
          ['b', 0],
          ['a', 0],
          ['busy', 3],
          ['seen', 1],
        ]),
        schedules: new Set(['sched', 'a']),
      },
      ['seen', 'mine'],
    );
    expect(items.map((i) => i.name)).toEqual(['seen', 'mine', 'busy', 'a', 'b', 'sched']);
    expect(items[0]).toEqual({ name: 'seen', running: 1, sources: ['recent', 'workflow'] });
    expect(items.find((i) => i.name === 'a')?.sources).toEqual(['workflow', 'schedule']);
  });
});

describe('filterQueues', () => {
  const items = mergeQueues({ workflows: new Map([['Orders-EU', 0], ['payments', 0]]), schedules: new Set() }, []);
  it('matches a case-insensitive substring', () => {
    expect(filterQueues(items, ' ders-e ').map((i) => i.name)).toEqual(['Orders-EU']);
  });
  it('keeps everything for empty text', () => {
    expect(filterQueues(items, '')).toHaveLength(2);
  });
});

describe('recent queues', () => {
  it('records most recent first, without duplicates, capped', () => {
    const s = memoryStorage();
    recordRecentQueue('ns', 'a', s);
    recordRecentQueue('ns', 'b', s);
    recordRecentQueue('ns', ' a ', s);
    expect(loadRecentQueues('ns', s)).toEqual(['a', 'b']);
    expect(loadRecentQueues('other', s)).toEqual([]);
    for (let i = 0; i < RECENT_MAX + 5; i += 1) recordRecentQueue('ns', `q${i}`, s);
    expect(loadRecentQueues('ns', s)).toHaveLength(RECENT_MAX);
  });

  it('ignores blank names, bad JSON and storage errors', () => {
    const s = memoryStorage({ [recentKey('ns')]: '{not json' });
    expect(loadRecentQueues('ns', s)).toEqual([]);
    recordRecentQueue('ns', '  ', s);
    expect(s.data.get(recentKey('ns'))).toBe('{not json');
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadRecentQueues('ns', broken)).toEqual([]);
    expect(() => recordRecentQueue('ns', 'a', broken)).not.toThrow();
  });
});

describe('loadQueueSuggestions', () => {
  it('merges workflows, schedules and recent queues and counts running rows', async () => {
    serve((u) => {
      if (u.pathname === '/api/v1/namespaces/ns/workflows') {
        return json({ executions: [row('w1', 'orders', RUNNING), row('w2', 'orders', RUNNING), row('w3', 'billing'), row('sched-a-1', 'orders')] });
      }
      if (u.pathname === '/api/v1/namespaces/ns/schedules') {
        return json({
          schedules: [
            { scheduleId: 'a', info: { recentActions: [{ startWorkflowResult: { workflowId: 'sched-a-1' } }] } },
            { scheduleId: 'b', info: {} },
          ],
        });
      }
      if (u.pathname === '/api/v1/namespaces/ns/schedules/b') {
        return json({ schedule: { action: { startWorkflow: { taskQueue: { name: 'nightly' } } } } });
      }
      return json({}, 404);
    });
    const s = memoryStorage({ [recentKey('ns')]: JSON.stringify(['manual']) });
    const res = await loadQueueSuggestions('ns', s);
    expect(res.error).toBeUndefined();
    expect(res.runningComplete).toBe(true);
    expect(res.items.map((i) => [i.name, i.running])).toEqual([
      ['manual', 0],
      ['orders', 2],
      ['billing', 0],
      ['nightly', 0],
    ]);
    // Schedule a's recent run was among the rows, so only b is described.
    expect(calls.filter((c) => c.includes('/schedules/'))).toEqual(['/api/v1/namespaces/ns/schedules/b']);
    expect(calls[0]).toBe('/api/v1/namespaces/ns/workflows?pageSize=500');
  });

  it('pages workflows politely and flags running counts that may be low', async () => {
    serve((u) => {
      if (u.pathname.endsWith('/workflows')) {
        const page = u.searchParams.get('nextPageToken') ?? '0';
        return json({ executions: [row(`w${page}`, 'q', RUNNING)], nextPageToken: `${Number(page) + 1}` });
      }
      return json({ schedules: [] });
    });
    const res = await loadQueueSuggestions('ns', memoryStorage());
    expect(calls.filter((c) => c.includes('/workflows'))).toHaveLength(2);
    expect(res.items[0]?.running).toBe(2);
    expect(res.runningComplete).toBe(false);
  });

  it('describes at most a few schedules', async () => {
    serve((u) => {
      if (u.pathname.endsWith('/workflows')) return json({});
      if (u.pathname.endsWith('/schedules')) return json({ schedules: Array.from({ length: 20 }, (_, i) => ({ scheduleId: `s${i}` })) });
      return json({ schedule: { action: { startWorkflow: { taskQueue: { name: u.pathname.split('/').pop() } } } } });
    });
    const res = await loadQueueSuggestions('ns', memoryStorage());
    expect(res.items).toHaveLength(SCHEDULE_DESCRIBES);
  });

  it('stops at a 429 and keeps what it has', async () => {
    serve((u) => {
      if (u.pathname.endsWith('/workflows') && !u.searchParams.has('nextPageToken')) return json({ executions: [row('w1', 'orders')], nextPageToken: 't' });
      return json({ code: 8, message: 'rate limited' }, 429, { 'Retry-After': '1' });
    });
    const res = await loadQueueSuggestions('ns', memoryStorage());
    expect(res.items.map((i) => i.name)).toEqual(['orders']);
    expect(res.error).toMatch(/rate limiting/);
    expect(calls).toHaveLength(2);
  });

  it('continues with schedules when the workflow list fails otherwise', async () => {
    serve((u) => {
      if (u.pathname.endsWith('/workflows')) return json({ message: 'visibility down' }, 503);
      if (u.pathname.endsWith('/schedules')) return json({ schedules: [{ scheduleId: 's' }] });
      return json({ schedule: { action: { startWorkflow: { taskQueue: { name: 'nightly' } } } } });
    });
    const res = await loadQueueSuggestions('ns', memoryStorage());
    expect(res.items.map((i) => i.name)).toEqual(['nightly']);
    expect(res.error).toBe('visibility down');
  });

  it('caches per namespace with a TTL, shares concurrent loads and rereads recent queues', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    serve((u) => (u.pathname.endsWith('/workflows') ? json({ executions: [row('w', 'orders')] }) : json({})));
    const s = memoryStorage();
    await Promise.all([loadQueueSuggestions('ns', s), loadQueueSuggestions('ns', s)]);
    expect(calls).toHaveLength(2);

    recordRecentQueue('ns', 'mine', s);
    now += CACHE_TTL_MS - 1;
    const cached = await loadQueueSuggestions('ns', s);
    expect(calls).toHaveLength(2);
    expect(cached.items.map((i) => i.name)).toEqual(['mine', 'orders']);

    await loadQueueSuggestions('other', s);
    expect(calls).toHaveLength(4);

    now += 1;
    await loadQueueSuggestions('ns', s);
    expect(calls).toHaveLength(6);
  });

  it('retries a partial result sooner', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    serve(() => json({}, 429));
    await loadQueueSuggestions('ns', memoryStorage());
    expect(calls).toHaveLength(1);
    now += PARTIAL_TTL_MS;
    await loadQueueSuggestions('ns', memoryStorage());
    expect(calls).toHaveLength(2);
  });
});
