// @vitest-environment happy-dom
// The console page sends parsed commands to the invoke endpoint, gates
// writes by role, and asks for typed confirmation before destructive calls.
import type { VNode } from 'preact';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { LocationProvider, Route, Router } from 'preact-iso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../../lib/me';
import { me } from '../../lib/me';
import Console from './index';

const user = (role: Me['role']): Me =>
  ({ user: null, role, authEnabled: true, settings: { defaultNamespace: 'default', showSystemNamespace: false, disabledActions: [], codec: {}, limits: {}, version: '' } }) as unknown as Me;

let calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];

beforeEach(() => {
  calls = [];
  history.replaceState(null, '', '/namespaces/ns1/console');
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined, headers: init.headers as Record<string, string> });
    return Promise.resolve(new Response(JSON.stringify({ executions: [{ execution: { workflowId: 'w1', runId: 'r1' } }] }), { status: 200 }));
  });
});

afterEach(() => {
  me.value = null;
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

async function mount(): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.append(root);
  await act(() => {
    // Router types its children as plain VNodes; the Route vnode's props are narrower.
    const route = h(Route, { path: '/namespaces/:ns/console', component: Console }) as unknown as VNode;
    const routes = h(Router, { children: [route] });
    render(h(LocationProvider, {}, routes), root);
  });
  return root;
}

async function type(root: HTMLElement, text: string) {
  const input = root.querySelector<HTMLInputElement>('input[aria-label="Command"]') as HTMLInputElement;
  await act(() => {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const runButton = (root: HTMLElement) => [...root.querySelectorAll('button')].find((b) => b.textContent === 'Run') as HTMLButtonElement;

async function submit(root: HTMLElement) {
  await act(async () => {
    root.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('Console page', () => {
  it('runs a read command in the page namespace and shows a table', async () => {
    me.value = user('read');
    const root = await mount();
    await type(root, 'workflow list --limit 5');
    await submit(root);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/x/console/invoke');
    expect(calls[0]?.body).toEqual({ method: '/temporal.api.workflowservice.v1.WorkflowService/ListWorkflowExecutions', request: { namespace: 'ns1', pageSize: 5 } });
    expect(root.querySelector('table')?.textContent).toContain('w1');
    expect([...root.querySelectorAll('button')].some((b) => b.textContent === 'Copy as CLI')).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('tempolens.console.history') ?? '[]')).toEqual(['workflow list --limit 5']);
  });

  it('disables a mutating command for a read user, with the reason', async () => {
    me.value = user('read');
    const root = await mount();
    await type(root, 'workflow terminate -w w1 --reason r');
    expect(runButton(root).disabled).toBe(true);
    expect(root.textContent).toContain('needs write access');
  });

  it('shows the parse error with the offending token', async () => {
    me.value = user('write');
    const root = await mount();
    await type(root, 'workflow describe --bogus 1');
    await submit(root);
    expect(calls).toHaveLength(0);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('--bogus');
  });

  it('asks for the typed workflow ID before terminating and sends the confirm header', async () => {
    me.value = user('write');
    const root = await mount();
    await type(root, 'workflow terminate -w wf/1 --reason stuck');
    await submit(root);
    expect(calls).toHaveLength(0);
    const dialog = document.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.textContent).toContain('Type wf/1 to confirm the workflow ID');
    const confirmBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Confirm and run') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    const input = dialog.querySelector('input') as HTMLInputElement;
    await act(() => {
      input.value = 'wf/1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(confirmBtn.disabled).toBe(false);
    await act(async () => {
      dialog.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers['X-Tempolens-Confirm']).toBe('wf%2F1');
    expect(calls[0]?.body).toMatchObject({ method: '/temporal.api.workflowservice.v1.WorkflowService/TerminateWorkflowExecution' });
  });
});
