import { loginUrl, sessionExpired } from '../lib/api';

/**
 * Shown when an API call answers 401 after the app has loaded. Signing in
 * again returns to the current URL (pathname and query), so filters and the
 * open workflow are kept; nothing is lost by not redirecting immediately.
 */
export function SessionBanner() {
  if (!sessionExpired.value) return null;
  return (
    <div class="banner banner-warning" role="alert">
      Your session has ended.{' '}
      <button type="button" class="btn btn-sm" onClick={() => window.location.assign(loginUrl())}>
        Sign in again
      </button>{' '}
      <span class="muted">You will come back to this page.</span>
    </div>
  );
}
