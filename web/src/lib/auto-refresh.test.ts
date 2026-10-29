import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { isRateLimited, RATE_LIMITED_PERIOD, startAutoRefresh } from './auto-refresh';

/** A document stand-in whose visibility the test flips. */
function fakeDoc() {
  const listeners = new Set<() => void>();
  return {
    hidden: false,
    addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
    setHidden(hidden: boolean) {
      this.hidden = hidden;
      for (const fn of listeners) fn();
    },
    listeners,
  };
}

/** A run whose calls resolve only when the test says so. */
function controlledRun() {
  const pending: ((limited: boolean) => void)[] = [];
  const run = vi.fn(() => new Promise<boolean>((resolve) => pending.push(resolve)));
  return { run, finish: (limited = false) => pending.shift()?.(limited) };
}

const start = (opts: Partial<Parameters<typeof startAutoRefresh>[0]> & { run: () => Promise<boolean> }, doc = fakeDoc()) => {
  const stop = startAutoRefresh({ period: 5, doc: doc as unknown as Document, ...opts });
  return { stop, doc };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startAutoRefresh', () => {
  it('refreshes every 5 s and stops when told', async () => {
    const run = vi.fn(async () => false);
    const { stop, doc } = start({ run });
    await vi.advanceTimersByTimeAsync(4999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(doc.listeners.size).toBe(0);
  });

  it('does nothing when off', async () => {
    const run = vi.fn(async () => false);
    start({ run, period: 0 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('skips ticks while the previous refresh is in flight', async () => {
    const { run, finish } = controlledRun();
    start({ run });
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('skips ticks while another load is busy', async () => {
    const run = vi.fn(async () => false);
    let busy = true;
    start({ run, busy: () => busy });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('pauses while the tab is hidden and refreshes once it shows again', async () => {
    const run = vi.fn(async () => false);
    const { doc } = start({ run });
    doc.setHidden(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();
    // Overdue: one refresh at once, then the normal period.
    doc.setHidden(false);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not refresh early when the tab shows again before a refresh is due', async () => {
    const run = vi.fn(async () => false);
    const { doc } = start({ run });
    await vi.advanceTimersByTimeAsync(1000);
    doc.setHidden(true);
    doc.setHidden(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('slows to 15 s after a 429 and says so once', async () => {
    const run = vi.fn(async () => true);
    const onSlowed = vi.fn();
    start({ run, onSlowed });
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onSlowed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RATE_LIMITED_PERIOD * 1000 - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onSlowed).toHaveBeenCalledTimes(1);
  });

  it('keeps a period of 15 s or more after a 429', async () => {
    const run = vi.fn(async () => true);
    const onSlowed = vi.fn();
    start({ run, onSlowed, period: 60 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onSlowed).not.toHaveBeenCalled();
  });

  it('keeps going after a failed refresh', async () => {
    const run = vi.fn(async () => {
      throw new Error('boom');
    });
    start({ run });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('isRateLimited', () => {
  it('matches HTTP 429 only', () => {
    expect(isRateLimited(new ApiError(429, 'slow down'))).toBe(true);
    expect(isRateLimited(new ApiError(503, 'unavailable'))).toBe(false);
    expect(isRateLimited(new Error('429'))).toBe(false);
  });
});
