// @vitest-environment happy-dom
// The history tab opens the selected event's group in a side panel: the
// selection lives in `?event=`, survives a reload, moves with ↑/↓ and j/k,
// closes with Esc, and links to the dedicated event page.
import { signal } from '@preact/signals';
import type { VNode } from 'preact';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { LocationProvider, Route, Router } from 'preact-iso';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventView } from '../../lib/prefs';
import type { RunStore } from '../../lib/run-store';
import type { HistoryEvent } from '../../lib/temporal';
import { P } from '../../routes';
import { HistoryTab } from './history';

const ev = (id: number, type: string, attrs: Record<string, unknown> = {}): HistoryEvent => {
  const key = type.charAt(0).toLowerCase() + type.slice(1) + 'EventAttributes';
  return {
    eventId: String(id),
    eventTime: `2026-10-27T08:00:${String(id).padStart(2, '0')}Z`,
    eventType: 'EVENT_TYPE_' + type.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(),
    [key]: attrs,
  };
};

const events: HistoryEvent[] = [
  ev(1, 'WorkflowExecutionStarted', { workflowType: { name: 'Order' } }),
  ev(2, 'ActivityTaskScheduled', { activityId: 'charge-1', activityType: { name: 'ChargeCard' }, taskQueue: { name: 'payments' } }),
  ev(3, 'ActivityTaskStarted', { scheduledEventId: '2', attempt: 2 }),
  ev(4, 'ActivityTaskFailed', { scheduledEventId: '2', startedEventId: '3', failure: { message: 'card declined', stackTrace: 'at charge()' } }),
  ev(5, 'TimerStarted', { timerId: 't1', startToFireTimeout: '60s' }),
  ev(6, 'TimerFired', { timerId: 't1', startedEventId: '5' }),
];

const store = {
  history: {
    events: signal(events),
    complete: signal(true),
    loading: signal(false),
    error: signal(null),
    loadNext: () => Promise.resolve(false),
    loadAll: () => Promise.resolve(),
  },
  describe: signal(null),
  running: false,
  setLiveWanted: () => undefined,
} as unknown as RunStore;

const BASE = '/namespaces/ns1/workflows/w1/r1/history';

let roots: HTMLElement[] = [];

afterEach(() => {
  // Unmounting removes each tab's document key listener.
  for (const root of roots) render(null, root);
  roots = [];
  document.body.innerHTML = '';
  eventView.value = 'compact';
  vi.restoreAllMocks();
});

async function mount(url: string, mode: 'compact' | 'full' = 'compact'): Promise<HTMLElement> {
  eventView.value = mode;
  history.replaceState(null, '', url);
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  const Tab = () => h(HistoryTab, { store, ns: 'ns1', wf: 'w1', run: 'r1' });
  await act(() => {
    // Router types its children as plain VNodes; the Route vnode's props are narrower.
    const route = h(Route, { path: P.history, component: Tab }) as unknown as VNode;
    render(h(LocationProvider, {}, h(Router, { children: [route] })), root);
  });
  await settle();
  return root;
}

/** Lets payload decoding and animation frames finish. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

const panel = (root: HTMLElement) => root.querySelector<HTMLElement>('aside.history-panel');
const current = () => location.pathname + location.search;
const selectedLinks = (root: HTMLElement) => [...root.querySelectorAll('a.history-row-link[aria-current="true"]')].map((a) => a.textContent);

async function key(k: string, target: EventTarget = document.body) {
  await act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
  await settle();
}

describe('History detail panel', () => {
  it('opens the clicked row in a panel and keeps the other query parameters', async () => {
    const root = await mount(`${BASE}?sort=ascending`);
    expect(panel(root)).toBeNull();
    const row = [...root.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('a.history-row-link')?.textContent === '2');
    await act(() => (row?.querySelector('td:nth-child(3)') as HTMLElement).click());
    await settle();
    expect(current()).toBe(`${BASE}?sort=ascending&event=2`);
    const p = panel(root);
    expect(p?.getAttribute('aria-label')).toBe('Event 2 details');
    expect(p?.textContent).toContain('ChargeCard');
    expect(p?.textContent).toContain('payments');
    expect(p?.textContent).toContain('card declined');
    expect(p?.textContent).toContain('at charge()');
    expect(p?.querySelectorAll('details.history-panel-event')).toHaveLength(3);
    expect(p?.querySelector('button[aria-label="Expand all JSON nodes"]')).not.toBeNull();
    expect(selectedLinks(root)).toEqual(['2']);
  });

  it('restores the selection from ?event on load and links to the full page', async () => {
    const root = await mount(`${BASE}?sort=ascending&event=4`);
    // Event 4 belongs to the activity group opened by event 2.
    expect(selectedLinks(root)).toEqual(['2']);
    expect(panel(root)?.querySelector('summary[aria-current="true"]')?.textContent).toContain('#4 ActivityTaskFailed');
    const full = [...(panel(root)?.querySelectorAll('a') ?? [])].find((a) => a.textContent === 'Open full page');
    expect(full?.getAttribute('href')).toBe('/namespaces/ns1/workflows/w1/r1/history/events/4?sort=ascending');
    expect(root.querySelector('a.history-row-link')?.getAttribute('href')).toBe(`${BASE}?sort=ascending&event=1`);
  });

  it('closes with Esc and with the close button', async () => {
    const root = await mount(`${BASE}?sort=ascending&event=5`);
    expect(panel(root)).not.toBeNull();
    await key('Escape');
    expect(panel(root)).toBeNull();
    expect(current()).toBe(`${BASE}?sort=ascending`);

    const again = await mount(`${BASE}?event=5`);
    await act(() => again.querySelector<HTMLButtonElement>('button[aria-label="Close event details"]')?.click());
    expect(panel(again)).toBeNull();
    expect(current()).toBe(BASE);
  });

  it('moves the selection with ↑/↓ and j/k, replacing the history entry', async () => {
    const root = await mount(`${BASE}?sort=ascending&event=1`);
    const push = vi.spyOn(history, 'pushState');
    await key('ArrowDown');
    expect(current()).toBe(`${BASE}?sort=ascending&event=2`);
    await key('j');
    expect(current()).toBe(`${BASE}?sort=ascending&event=5`);
    expect(panel(root)?.textContent).toContain('t1');
    await key('j');
    expect(current()).toBe(`${BASE}?sort=ascending&event=5`);
    await key('k');
    await key('ArrowUp');
    expect(current()).toBe(`${BASE}?sort=ascending&event=1`);
    expect(push).not.toHaveBeenCalled();
  });

  it('moves event by event in All events mode', async () => {
    const root = await mount(`${BASE}?sort=ascending&event=3`, 'full');
    expect(selectedLinks(root)).toEqual(['3']);
    await key('j');
    expect(current()).toBe(`${BASE}?sort=ascending&event=4`);
    expect(selectedLinks(root)).toEqual(['4']);
  });

  it('ignores the keys while typing in a field', async () => {
    const root = await mount(`${BASE}?sort=ascending&event=2`);
    const input = root.querySelector<HTMLInputElement>('.filter-panel input') as HTMLInputElement;
    await key('j', input);
    await key('Escape', input);
    expect(current()).toBe(`${BASE}?sort=ascending&event=2`);
    expect(panel(root)).not.toBeNull();
  });
});
