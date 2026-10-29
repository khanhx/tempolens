import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { api } from '../../lib/api';
import type { Me } from '../../lib/me';
import { timeMode, timeZone } from '../../lib/prefs';
import { NamespaceSwitcher } from './namespace-switcher';
import { ThemeToggle } from './theme-toggle';

/** True while a lazy route chunk is loading; drives the thin progress bar. */
export const routeLoading = signal(false);

function TimeControls() {
  const relative = timeMode.value === 'relative';
  const utc = timeZone.value === 'utc';
  return (
    <div class="header-group" role="group" aria-label="Time display">
      <button
        type="button"
        class="btn btn-ghost"
        aria-pressed={relative}
        title={relative ? 'Showing relative times. Switch to absolute.' : 'Showing absolute times. Switch to relative.'}
        onClick={() => (timeMode.value = relative ? 'absolute' : 'relative')}
      >
        {relative ? 'Relative' : 'Absolute'}
      </button>
      <button
        type="button"
        class="btn btn-ghost"
        aria-pressed={utc}
        title={utc ? 'Showing UTC. Switch to local time.' : 'Showing local time. Switch to UTC.'}
        onClick={() => (timeZone.value = utc ? 'local' : 'utc')}
      >
        {utc ? 'UTC' : 'Local'}
      </button>
    </div>
  );
}

export function UserMenu({ me }: { me: Me }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The email is empty when the identity provider did not verify it.
  const name = me.user ? me.user.name || me.user.email || me.user.sub : 'Local dev (auth disabled)';

  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/logout');
      // Not '/': with no session that starts a login, and Dex, whose session is
      // still live, signs the user straight back in. This page does not redirect.
      window.location.assign('/auth/signed-out');
    } catch (err) {
      setError(`Sign out failed: ${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
    }
  };

  return (
    <div class="header-user">
      <span class="header-user-name" title={me.user?.email || name}>
        {name}
      </span>
      <span
        class={me.role === 'read' ? 'badge' : 'badge badge-write'}
        title={me.role === 'admin' ? 'You can run write and admin actions' : me.role === 'write' ? 'You can run write actions' : 'Read-only access'}
      >
        {me.role}
      </span>
      {me.authEnabled && (
        <button type="button" class="btn" disabled={busy} onClick={logout}>
          Sign out
        </button>
      )}
      {error && (
        <span class="header-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function Header({ me, ns }: { me: Me; ns: string }) {
  return (
    <header class="header">
      <a class="header-brand" href="/">
        Tempolens
      </a>
      <NamespaceSwitcher fallback={ns} />
      <div class="header-spacer" />
      <TimeControls />
      <ThemeToggle />
      <UserMenu me={me} />
      {routeLoading.value && <div class="route-progress" role="progressbar" aria-label="Loading page" />}
    </header>
  );
}
