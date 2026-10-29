// @vitest-environment happy-dom
// Sign out ends the session and opens the signed-out page, never '/', which would sign the user back in.
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../../lib/me';
import { UserMenu } from './header';

const fetchMock = vi.fn<typeof fetch>();

const me = (authEnabled: boolean): Me =>
  ({
    user: authEnabled ? { sub: 's', name: 'Writer', email: 'writer@example.test' } : null,
    role: 'write',
    authEnabled,
    settings: { defaultNamespace: 'default', showSystemNamespace: false, disabledActions: [], codec: {}, limits: {}, version: '' },
  }) as unknown as Me;

function mount(authEnabled = true): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  render(h(UserMenu, { me: me(authEnabled) }), root);
  return root;
}

function signOutButton(root: HTMLElement): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find((b) => b.textContent === 'Sign out');
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('UserMenu sign out', () => {
  it('posts the logout and then opens the signed-out page', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
    const root = mount();
    await act(async () => {
      signOutButton(root)?.click();
    });
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/auth/logout');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(assign).toHaveBeenCalledWith('/auth/signed-out');
  });

  it('stays on the page and shows the error when logout fails', async () => {
    fetchMock.mockResolvedValue(new Response('{"code":13,"message":"boom","details":[]}', { status: 500 }));
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
    const root = mount();
    await act(async () => {
      signOutButton(root)?.click();
    });
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('Sign out failed'));
    expect(assign).not.toHaveBeenCalled();
  });

  it('has no Sign out button when auth is disabled', () => {
    expect(signOutButton(mount(false))).toBeUndefined();
  });
});
