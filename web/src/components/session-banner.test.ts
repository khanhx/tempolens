// @vitest-environment happy-dom
// After a 401 the banner appears, and signing in again returns to the current URL.
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionExpired } from '../lib/api';
import { SessionBanner } from './session-banner';

function mount(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  render(h(SessionBanner, {}), root);
  return root;
}

afterEach(() => {
  sessionExpired.value = false;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('SessionBanner', () => {
  it('renders nothing while the session is valid', () => {
    expect(mount().innerHTML).toBe('');
  });

  it('appears when sessionExpired is set', async () => {
    const root = mount();
    await act(() => {
      sessionExpired.value = true;
    });
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Your session has ended.');
  });

  it('signs in again with the current path and query as returnTo', async () => {
    window.history.pushState({}, '', '/namespaces/tui-test-ui-a/workflows?query=WorkflowType%3D%22x%22&page=2');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
    sessionExpired.value = true;
    const root = mount();
    await act(() => {
      root.querySelector('button')?.click();
    });
    expect(assign).toHaveBeenCalledTimes(1);
    const target = new URL(String(assign.mock.calls[0]?.[0]), 'http://localhost');
    expect(target.pathname).toBe('/auth/sso');
    expect(target.searchParams.get('returnTo')).toBe('/namespaces/tui-test-ui-a/workflows?query=WorkflowType%3D%22x%22&page=2');
  });
});
