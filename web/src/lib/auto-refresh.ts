// Periodic refresh for the workflow list: one load at a time, nothing while
// the tab is hidden, and a slower period once the server rate-limits.
import { ApiError } from './api';

/** The period a rate-limited refresh falls back to, in seconds. */
export const RATE_LIMITED_PERIOD = 15;

/** True for the server's "too many requests" answer. */
export const isRateLimited = (err: unknown) => err instanceof ApiError && err.status === 429;

type VisibilityTarget = Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;

export interface AutoRefreshOptions {
  /** Seconds between refreshes; 0 or less is off. */
  period: number;
  /** One refresh; resolves true when the server answered 429. */
  run: () => Promise<boolean>;
  /** True while a load started elsewhere (a manual refresh, the next page) is in flight; the tick is skipped. */
  busy?: () => boolean;
  /** Called once when a 429 slows a shorter period to RATE_LIMITED_PERIOD. */
  onSlowed?: () => void;
  doc?: VisibilityTarget;
}

/**
 * Starts refreshing every `period` seconds and returns the stop function.
 * A tick is skipped while the previous refresh, or another load, is in flight.
 * While the tab is hidden the timer stops; when it shows again a refresh runs
 * at once if one is due. After a 429 the period stays at RATE_LIMITED_PERIOD
 * until the next start.
 */
export function startAutoRefresh({ period, run, busy = () => false, onSlowed, doc = document }: AutoRefreshOptions): () => void {
  if (!(period > 0)) return () => undefined;
  let current = period;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let stopped = false;
  let lastRun = Date.now();

  const tick = () => {
    if (stopped || doc.hidden || inFlight || busy()) return;
    inFlight = true;
    lastRun = Date.now();
    run()
      .then(
        (limited) => {
          if (!limited || stopped || current >= RATE_LIMITED_PERIOD) return;
          current = RATE_LIMITED_PERIOD;
          schedule();
          onSlowed?.();
        },
        // The page reports its own load errors; a failed tick just waits for the next.
        () => undefined,
      )
      .finally(() => {
        inFlight = false;
      });
  };

  const schedule = () => {
    clearInterval(timer);
    timer = doc.hidden ? undefined : setInterval(tick, current * 1000);
  };

  const onVisibility = () => {
    schedule();
    if (!doc.hidden && Date.now() - lastRun >= current * 1000) tick();
  };

  doc.addEventListener('visibilitychange', onVisibility);
  schedule();
  return () => {
    stopped = true;
    clearInterval(timer);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
