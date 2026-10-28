// Live history updates for a running workflow: a `waitNewEvent=true`
// long-poll. The server holds the request until events arrive; a returned
// token is followed at once. With no token and nothing new the loop waits
// 2 s; after an error 5 s; after a 429 the server's Retry-After.
import { ApiError, api } from '../api';
import type { HistoryEvent } from '../temporal';
import { CLOSE_EVENT_TYPES } from '../temporal';
import type { HistoryPage } from './fetch';
import { historyPath } from './fetch';

export type LongPollFetcher = (token: string | undefined, signal: AbortSignal) => Promise<HistoryPage>;

export interface LivePollOptions {
  fetchPage: LongPollFetcher;
  /** Receives every page's events; returns how many were new. */
  onEvents: (events: HistoryEvent[]) => number;
  signal: AbortSignal;
  /** Token to resume from (returned by a previous run). */
  startToken?: string;
  idleMs?: number;
  errorMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

/** `closeOnly` asks for the close event alone, so the poll returns only when the run ends (`temporal workflow execute`). */
export function apiLongPollFetcher(ns: string, wf: string, run: string, closeOnly = false): LongPollFetcher {
  return async (token, abortSignal) => {
    const res = await api.get<{ history?: { events?: HistoryEvent[] }; nextPageToken?: string }>(
      historyPath(ns, wf),
      {
        'execution.runId': run,
        waitNewEvent: true,
        nextPageToken: token,
        historyEventFilterType: closeOnly ? 'HISTORY_EVENT_FILTER_TYPE_CLOSE_EVENT' : undefined,
      },
      abortSignal,
    );
    return { events: res.history?.events ?? [], nextPageToken: res.nextPageToken || undefined };
  };
}

/**
 * Runs until aborted or until a close event arrives. Resolves with the token
 * to resume from, so pausing (refresh off, hidden tab) loses nothing.
 */
export async function runLivePoll(opts: LivePollOptions): Promise<string | undefined> {
  const { fetchPage, onEvents, signal, idleMs = 2000, errorMs = 5000, sleep = abortableSleep } = opts;
  let token = opts.startToken;
  while (!signal.aborted) {
    try {
      const page = await fetchPage(token, signal);
      const added = onEvents(page.events);
      if (page.events.some((e) => CLOSE_EVENT_TYPES.has(e.eventType))) return undefined;
      if (page.nextPageToken) {
        token = page.nextPageToken;
      } else {
        token = undefined;
        if (added === 0) await sleep(idleMs, signal);
      }
    } catch (err) {
      if (signal.aborted) break;
      const wait = err instanceof ApiError && err.status === 429 ? (err.retryAfterMs ?? errorMs) : errorMs;
      await sleep(wait, signal);
    }
  }
  return token;
}
