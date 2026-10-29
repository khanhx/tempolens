// @vitest-environment happy-dom
// The task queue index suggests queue names in a combobox and opens the
// workers page for a chosen suggestion or for free text.
import type { VNode } from 'preact';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { LocationProvider, Route, Router } from 'preact-iso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearQueueCache, loadRecentQueues, recentKey } from '../lib/task-queues';
import TaskQueues from './task-queues';

const RUNNING = 'WORKFLOW_EXECUTION_STATUS_RUNNING';

beforeEach(() => {
  clearQueueCache();
  localStorage.setItem(recentKey('ns1'), JSON.stringify(['mine']));
  history.replaceState(null, '', '/namespaces/ns1/task-queues');
  vi.stubGlobal('fetch', (url: string) => {
    const body = url.startsWith('/api/v1/namespaces/ns1/workflows')
      ? {
          executions: [
            { execution: { workflowId: 'w1' }, taskQueue: 'orders', status: RUNNING },
            { execution: { workflowId: 'w2' }, taskQueue: 'orders', status: RUNNING },
            { execution: { workflowId: 'w3' }, taskQueue: 'billing' },
          ],
        }
      : {};
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function mount(): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.append(root);
  await act(async () => {
    // Router types its children as plain VNodes; the Route vnode's props are narrower.
    const index = h(Route, { path: '/namespaces/:ns/task-queues', component: TaskQueues }) as unknown as VNode;
    const detail = h(Route, { path: '/namespaces/:ns/task-queues/:queue', component: () => h('h1', {}, 'workers') }) as unknown as VNode;
    render(h(LocationProvider, {}, h(Router, { children: [index, detail] })), root);
  });
  // The sources load one request at a time.
  for (let i = 0; i < 50 && root.textContent?.includes('Loading suggestions'); i += 1) await settle();
  return root;
}

const input = (root: HTMLElement) => root.querySelector<HTMLInputElement>('input[role="combobox"]') as HTMLInputElement;
const options = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[role="option"]')];
const names = (root: HTMLElement) => options(root).map((o) => o.querySelector('.combo-value')?.textContent);

async function focus(root: HTMLElement) {
  await act(() => {
    input(root).dispatchEvent(new FocusEvent('focus'));
  });
}

async function type(root: HTMLElement, text: string) {
  await act(() => {
    input(root).value = text;
    input(root).dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(root: HTMLElement, k: string) {
  await act(() => {
    input(root).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('Task queues page', () => {
  it('lists inferred queues with running counts and says the list may be incomplete', async () => {
    const root = await mount();
    const el = input(root);
    expect(el.hasAttribute('data-shortcut-search')).toBe(true);
    expect(el.getAttribute('aria-expanded')).toBe('false');
    expect(root.textContent).toContain('the list may be incomplete');
    await focus(root);
    expect(el.getAttribute('aria-expanded')).toBe('true');
    expect(el.getAttribute('aria-controls')).toBe(root.querySelector('[role="listbox"]')?.id);
    expect(names(root)).toEqual(['mine', 'orders', 'billing']);
    expect(options(root)[1]?.textContent).toContain('2 running');
    expect(options(root)[0]?.textContent).toContain('recent');
  });

  it('filters by a case-insensitive substring', async () => {
    const root = await mount();
    await type(root, 'ORD');
    expect(names(root)).toEqual(['orders']);
    await type(root, 'nothing-like-it');
    expect(options(root)).toHaveLength(0);
    expect(input(root).getAttribute('aria-expanded')).toBe('false');
  });

  it('moves with the arrow keys and opens the highlighted queue on Enter', async () => {
    const root = await mount();
    await focus(root);
    await key(root, 'ArrowDown');
    await key(root, 'ArrowDown');
    expect(input(root).getAttribute('aria-activedescendant')).toBe(options(root)[1]?.id);
    expect(options(root)[1]?.getAttribute('aria-selected')).toBe('true');
    await key(root, 'ArrowUp');
    await key(root, 'ArrowUp');
    expect(options(root)[2]?.getAttribute('aria-selected')).toBe('true');
    await key(root, 'Escape');
    expect(input(root).getAttribute('aria-expanded')).toBe('false');
    await key(root, 'ArrowDown');
    await key(root, 'ArrowDown');
    await key(root, 'Enter');
    await settle();
    expect(location.pathname).toBe('/namespaces/ns1/task-queues/orders');
    expect(loadRecentQueues('ns1')).toEqual(['orders', 'mine']);
  });

  it('opens a queue chosen with the mouse', async () => {
    const root = await mount();
    await type(root, 'bill');
    await act(() => {
      options(root)[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(location.pathname).toBe('/namespaces/ns1/task-queues/billing');
  });

  it('opens free text that matches no suggestion', async () => {
    const root = await mount();
    await type(root, 'custom queue');
    await act(() => {
      root.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(location.pathname).toBe('/namespaces/ns1/task-queues/custom%20queue');
  });

  it('shows an unobtrusive error and keeps the suggestions it has', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ message: 'slow down' }), { status: 429 })));
    const root = await mount();
    expect(root.textContent).toContain('Some suggestions could not be loaded');
    await focus(root);
    expect(names(root)).toEqual(['mine']);
  });
});
