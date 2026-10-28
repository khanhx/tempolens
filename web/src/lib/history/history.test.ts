import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import type { HistoryEvent } from '../temporal';
import type { Direction, HistoryPage } from './fetch';
import { HistoryStore } from './fetch';
import { EMPTY_FILTER, filterEvents, filterGroups, parseHistoryFilter, writeHistoryFilter } from './filters';
import { buildGroups, categoryOf, eventStatus, groupIndex } from './groups';
import { runLivePoll } from './live-poll';

const ev = (id: number, type: string, attrs: Record<string, unknown> = {}, minute = id): HistoryEvent => {
  const key = type.charAt(0).toLowerCase() + type.slice(1) + 'EventAttributes';
  return {
    eventId: String(id),
    eventTime: `2026-10-27T08:${String(minute).padStart(2, '0')}:00Z`,
    eventType: 'EVENT_TYPE_' + type.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(),
    [key]: attrs,
  };
};

// A failed run: an activity that failed on attempt 3, a timer, a child, a signal, a pending activity.
const fixture: HistoryEvent[] = [
  ev(1, 'WorkflowExecutionStarted', { workflowType: { name: 'Order' } }),
  ev(2, 'WorkflowTaskScheduled'),
  ev(3, 'WorkflowTaskStarted', { scheduledEventId: '2' }),
  ev(4, 'WorkflowTaskCompleted', { scheduledEventId: '2', startedEventId: '3' }),
  ev(5, 'ActivityTaskScheduled', { activityId: '5', activityType: { name: 'ChargeCard' } }),
  ev(6, 'TimerStarted', { timerId: 't1' }),
  ev(7, 'ActivityTaskStarted', { scheduledEventId: '5', attempt: 3 }),
  ev(8, 'ActivityTaskFailed', {
    scheduledEventId: '5',
    startedEventId: '7',
    failure: { message: 'card declined', cause: { message: 'Gateway Timeout' } },
  }),
  ev(9, 'TimerFired', { startedEventId: '6', timerId: 't1' }),
  ev(10, 'StartChildWorkflowExecutionInitiated', { workflowType: { name: 'Child' } }),
  ev(11, 'ChildWorkflowExecutionStarted', { initiatedEventId: '10' }),
  ev(12, 'WorkflowExecutionSignaled', { signalName: 'poke' }),
  ev(13, 'ActivityTaskScheduled', { activityId: '13', activityType: { name: 'ShipOrder' } }),
  ev(14, 'WorkflowExecutionTerminated', { reason: 'Stuck in prod' }),
];

describe('groups', () => {
  const groups = buildGroups(fixture);
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));

  it('groups events by their opening event', () => {
    expect(groups.map((g) => g.id)).toEqual(['1', '2', '5', '6', '10', '12', '13', '14']);
    expect(byId['5']).toMatchObject({ category: 'activity', name: 'ChargeCard', status: 'failed', attempt: 3 });
    expect(byId['5']?.failure?.message).toBe('card declined');
    expect(byId['5']?.events.map((e) => e.eventId)).toEqual(['5', '7', '8']);
    expect(byId['6']).toMatchObject({ category: 'timer', name: 't1', status: 'completed' });
    expect(byId['10']).toMatchObject({ category: 'child-workflow', name: 'Child', status: 'pending' });
    expect(byId['12']).toMatchObject({ category: 'signal', name: 'poke' });
    expect(byId['13']).toMatchObject({ name: 'ShipOrder', status: 'pending' });
    expect(byId['2']).toMatchObject({ category: 'workflow-task', status: 'completed' });
    expect(byId['14']?.status).toBe('terminated');
  });

  it('classifies event types', () => {
    expect(categoryOf('EVENT_TYPE_EXTERNAL_WORKFLOW_EXECUTION_SIGNALED')).toBe('signal');
    expect(categoryOf('EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_ACCEPTED')).toBe('update');
    expect(categoryOf('EVENT_TYPE_MARKER_RECORDED')).toBe('marker');
    expect(eventStatus('EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT')).toBe('timed-out');
    expect(eventStatus('EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_REJECTED')).toBe('failed');
  });
});

describe('filters', () => {
  const groups = buildGroups(fixture);
  const index = groupIndex(groups);
  const ids = (events: HistoryEvent[]) => events.map((e) => e.eventId);
  const f = (over: Partial<typeof EMPTY_FILTER>) => ({ ...EMPTY_FILTER, ...over });

  it('passes everything without filters', () => {
    expect(filterEvents(fixture, index, EMPTY_FILTER)).toHaveLength(fixture.length);
  });

  it('filters by type, category, activity and status', () => {
    expect(ids(filterEvents(fixture, index, f({ types: ['TimerFired'] })))).toEqual(['9']);
    expect(ids(filterEvents(fixture, index, f({ categories: ['timer'] })))).toEqual(['6', '9']);
    expect(ids(filterEvents(fixture, index, f({ activity: 'charge' })))).toEqual(['5', '7', '8']);
    expect(ids(filterEvents(fixture, index, f({ statuses: ['failed'] })))).toEqual(['5', '7', '8']);
    expect(ids(filterEvents(fixture, index, f({ pendingOnly: true })))).toEqual(['10', '11', '13']);
  });

  it('filters by time window and failure text, including the cause chain and reasons', () => {
    expect(ids(filterEvents(fixture, index, f({ from: '2026-10-27T08:12:00Z', to: '2026-10-27T08:13:00Z' })))).toEqual(['12', '13']);
    expect(ids(filterEvents(fixture, index, f({ q: 'GATEWAY timeout' })))).toEqual(['8']);
    expect(ids(filterEvents(fixture, index, f({ q: 'stuck' })))).toEqual(['14']);
  });

  it('filters groups for the compact view', () => {
    expect(filterGroups(groups, f({ q: 'declined' })).map((g) => g.id)).toEqual(['5']);
    expect(filterGroups(groups, f({ categories: ['activity'], pendingOnly: true })).map((g) => g.id)).toEqual(['13']);
  });

  it('round-trips through the URL, keeping other parameters', () => {
    const p = new URLSearchParams('sort=ascending&types=TimerFired&category=timer,bogus&estatus=failed,nope&q=x&status=pending&from=junk');
    const parsed = parseHistoryFilter(p);
    expect(parsed).toEqual({ ...EMPTY_FILTER, types: ['TimerFired'], categories: ['timer'], statuses: ['failed'], q: 'x', pendingOnly: true });
    const out = writeHistoryFilter({ ...parsed, q: '' }, new URLSearchParams('sort=ascending&q=x'));
    expect(out.toString()).toBe('sort=ascending&types=TimerFired&category=timer&estatus=failed&status=pending');
  });
});

describe('HistoryStore', () => {
  const pages = (all: HistoryEvent[], size: number) => {
    const fetchPage = vi.fn(async (dir: Direction, token: string | undefined): Promise<HistoryPage> => {
      const ordered = dir === 'asc' ? all : [...all].reverse();
      const start = token ? Number(token) : 0;
      const slice = ordered.slice(start, start + size);
      return { events: slice, nextPageToken: start + size < all.length ? String(start + size) : undefined };
    });
    return fetchPage;
  };

  it('loads head and tail concurrently, then fills the gap', async () => {
    const fetchPage = pages(fixture, 4);
    const store = new HistoryStore(fetchPage);
    await store.init();
    expect(store.events.value.map((e) => e.eventId)).toEqual(['1', '2', '3', '4', '11', '12', '13', '14']);
    expect(store.complete.value).toBe(false);
    await store.loadAll();
    expect(store.events.value.map((e) => Number(e.eventId))).toEqual(fixture.map((e) => Number(e.eventId)));
    expect(store.complete.value).toBe(true);
    // asc 0, desc 0, asc 4 (completes when it meets the tail at 11)
    expect(fetchPage.mock.calls.map((c) => `${c[0]}:${c[1] ?? ''}`)).toEqual(['asc:', 'desc:', 'asc:4', 'asc:8']);
  });

  it('is complete after one round when the history fits a page', async () => {
    const store = new HistoryStore(pages(fixture, 1000));
    await store.init();
    expect(store.complete.value).toBe(true);
    expect(store.events.value).toHaveLength(fixture.length);
  });

  it('deduplicates live events and records errors', async () => {
    const store = new HistoryStore(pages(fixture.slice(0, 3), 1000));
    await store.init();
    expect(store.add([fixture[2] as HistoryEvent, fixture[3] as HistoryEvent])).toBe(1);
    const failing = new HistoryStore(async () => {
      throw new ApiError(503, 'unavailable');
    });
    await failing.init();
    expect(failing.error.value?.message).toBe('unavailable');
    expect(failing.loading.value).toBe(false);
  });
});

describe('runLivePoll', () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);

  it('follows tokens, backs off when idle and after errors, and honours 429', async () => {
    sleeps.length = 0;
    const controller = new AbortController();
    const responses: (HistoryPage | Error)[] = [
      { events: [ev(1, 'WorkflowExecutionStarted')], nextPageToken: 't1' },
      { events: [], nextPageToken: undefined },
      new ApiError(500, 'boom'),
      new ApiError(429, 'slow', { retryAfterMs: 3000 }),
      { events: [ev(2, 'WorkflowTaskScheduled')], nextPageToken: 't2' },
    ];
    const tokens: (string | undefined)[] = [];
    const seen = new Set<string>();
    const result = runLivePoll({
      fetchPage: async (token) => {
        tokens.push(token);
        const next = responses.shift();
        if (!next) {
          controller.abort();
          throw new DOMException('aborted', 'AbortError');
        }
        if (next instanceof Error) throw next;
        return next;
      },
      onEvents: (events) => events.filter((e) => !seen.has(e.eventId) && seen.add(e.eventId)).length,
      signal: controller.signal,
      sleep,
      startToken: 'resume',
    });
    await expect(result).resolves.toBe('t2');
    expect(tokens).toEqual(['resume', 't1', undefined, undefined, undefined, 't2']);
    expect(sleeps).toEqual([2000, 5000, 3000]);
  });

  it('stops at a close event', async () => {
    const fetchPage = vi.fn(async () => ({ events: [ev(9, 'WorkflowExecutionCompleted')], nextPageToken: 'x' }));
    await expect(runLivePoll({ fetchPage, onEvents: () => 1, signal: new AbortController().signal, sleep })).resolves.toBeUndefined();
    expect(fetchPage).toHaveBeenCalledOnce();
  });
});
