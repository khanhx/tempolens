// @vitest-environment happy-dom
// Each namespace row has a Details button and a ⋯ menu whose Delete namespace
// item is disabled, with the reason, unless the user is admin and the namespace is deletable.
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { LocationProvider } from 'preact-iso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../lib/me';
import { me } from '../lib/me';
import type { NamespaceEntry } from '../lib/namespaces';
import { namespaces } from '../lib/namespaces';
import Namespaces from './namespaces';

const user = (role: Me['role']): Me =>
  ({
    user: null,
    role,
    authEnabled: true,
    settings: { defaultNamespace: 'default', showSystemNamespace: false, disabledActions: role === 'admin' ? [] : ['namespace', 'searchAttribute', 'batchDelete'], codec: {}, limits: {}, version: '' },
  }) as unknown as Me;

const row = (name: string, state = 'NAMESPACE_STATE_REGISTERED') => ({ namespaceInfo: { name, state } }) as unknown as NamespaceEntry;

beforeEach(() => {
  history.replaceState(null, '', '/namespaces');
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 200 })));
  namespaces.value = [row('default'), row('tui-test-a'), row('tui-test-gone', 'NAMESPACE_STATE_DELETED')];
});

afterEach(() => {
  me.value = null;
  namespaces.value = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function mount(): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.append(root);
  await act(() => {
    render(h(LocationProvider, {}, h(Namespaces, {})), root);
  });
  return root;
}

function deleteItem(root: HTMLElement, ns: string): HTMLButtonElement {
  const tr = [...root.querySelectorAll('tbody tr')].find((r) => r.querySelector('td a')?.textContent === ns);
  const item = [...(tr?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].find((b) => b.textContent === 'Delete namespace');
  if (!item) throw new Error(`no Delete namespace item for ${ns}`);
  return item;
}

describe('Namespaces list actions', () => {
  it('shows a Details button and a labelled ⋯ menu on each row', async () => {
    me.value = user('admin');
    const root = await mount();
    const details = [...root.querySelectorAll<HTMLAnchorElement>('a.btn')].filter((a) => a.textContent === 'Details');
    expect(details.map((a) => a.getAttribute('href'))).toEqual(['/namespaces/default', '/namespaces/tui-test-a', '/namespaces/tui-test-gone']);
    expect(root.querySelector('summary[aria-label="Actions for tui-test-a"]')?.textContent).toBe('⋯');
  });

  it('lets the admin delete an ordinary namespace and opens the typed-confirm dialog', async () => {
    me.value = user('admin');
    const root = await mount();
    const item = deleteItem(root, 'tui-test-a');
    expect(item.disabled).toBe(false);
    await act(async () => {
      item.click();
    });
    await vi.waitFor(() => expect(document.querySelector('dialog')?.textContent).toContain('Delete tui-test-a'));
  });

  it('disables delete for protected and already deleting namespaces, with the reason', async () => {
    me.value = user('admin');
    const root = await mount();
    expect(deleteItem(root, 'default').disabled).toBe(true);
    expect(deleteItem(root, 'default').title).toMatch(/protected namespace/);
    expect(deleteItem(root, 'tui-test-gone').disabled).toBe(true);
    expect(deleteItem(root, 'tui-test-gone').title).toMatch(/already being deleted/);
  });

  it('disables delete for the reader and the writer with the role reason', async () => {
    for (const [role, reason] of [
      ['read', /write access/],
      ['write', /admin access/],
    ] as const) {
      me.value = user(role);
      const root = await mount();
      expect(deleteItem(root, 'tui-test-a').disabled).toBe(true);
      expect(deleteItem(root, 'tui-test-a').title).toMatch(reason);
      document.body.innerHTML = '';
    }
  });
});
