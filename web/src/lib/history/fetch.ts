// History loading. The first ascending page and the first reversed page are
// fetched concurrently, so the start (input) and the end (result, latest
// events) show at once; the gap between them is filled lazily.
import { signal } from '@preact/signals';
import { api, seg } from '../api';
import type { HistoryEvent } from '../temporal';

export interface HistoryPage {
  events: HistoryEvent[];
  nextPageToken?: string;
}

export type Direction = 'asc' | 'desc';
export type PageFetcher = (dir: Direction, token: string | undefined, signal?: AbortSignal) => Promise<HistoryPage>;

export const PAGE_SIZE = 1000;
/** "Load all" asks for confirmation above this many events. */
export const LOAD_ALL_WARN_EVENTS = 50_000;

interface HistoryResponse {
  history?: { events?: HistoryEvent[] };
  nextPageToken?: string;
}

export function historyPath(ns: string, wf: string, reverse = false): string {
  return `/api/v1/namespaces/${seg(ns)}/workflows/${seg(wf)}/${reverse ? 'history-reverse' : 'history'}`;
}

/** Fetches one page of GetWorkflowExecutionHistory(Reverse) through /api/v1. */
export function apiPageFetcher(ns: string, wf: string, run: string): PageFetcher {
  return async (dir, token, abortSignal) => {
    const res = await api.get<HistoryResponse>(
      historyPath(ns, wf, dir === 'desc'),
      { 'execution.runId': run, maximumPageSize: PAGE_SIZE, waitNewEvent: dir === 'asc' ? false : undefined, nextPageToken: token },
      abortSignal,
    );
    return { events: res.history?.events ?? [], nextPageToken: res.nextPageToken || undefined };
  };
}

const idOf = (e: HistoryEvent) => Number(e.eventId);

/**
 * Event store for one run. Events are deduplicated by eventId and kept in
 * ascending order. `complete` means every event from 1 to the newest known
 * one is loaded.
 */
export class HistoryStore {
  readonly events = signal<HistoryEvent[]>([]);
  readonly complete = signal(false);
  readonly loading = signal(false);
  readonly error = signal<Error | null>(null);

  private byId = new Map<number, HistoryEvent>();
  private ascToken: string | undefined;
  /** Highest id loaded contiguously from event 1. */
  private head = 0;
  /** Lowest id loaded by the reversed read. */
  private tail = Infinity;
  private started = false;

  constructor(private readonly fetchPage: PageFetcher) {}

  /** Adds events, returning how many were new. */
  add(events: HistoryEvent[]): number {
    let added = 0;
    for (const e of events) {
      const id = idOf(e);
      if (!Number.isFinite(id) || this.byId.has(id)) continue;
      this.byId.set(id, e);
      added++;
    }
    while (this.byId.has(this.head + 1)) this.head++;
    if (added > 0) this.events.value = [...this.byId.values()].sort((a, b) => idOf(a) - idOf(b));
    return added;
  }

  private updateComplete(): void {
    if (this.complete.value) return;
    if (this.ascToken === undefined || this.head >= this.tail - 1) {
      this.complete.value = true;
      this.ascToken = undefined;
    }
  }

  private async run<T>(work: () => Promise<T>): Promise<T | undefined> {
    this.loading.value = true;
    this.error.value = null;
    try {
      return await work();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return undefined;
      this.error.value = err instanceof Error ? err : new Error(String(err));
      return undefined;
    } finally {
      this.loading.value = false;
    }
  }

  /** First ascending and first reversed page, concurrently. Runs once. */
  async init(abortSignal?: AbortSignal): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.run(async () => {
      const [asc, desc] = await Promise.all([
        this.fetchPage('asc', undefined, abortSignal),
        this.fetchPage('desc', undefined, abortSignal),
      ]);
      this.add(asc.events);
      this.ascToken = asc.nextPageToken;
      if (desc.events.length) {
        this.tail = Math.min(...desc.events.map(idOf));
        this.add(desc.events);
      }
      // The reversed read reached event 1: everything is loaded.
      if (!desc.nextPageToken) this.ascToken = undefined;
      this.updateComplete();
    });
  }

  /** Loads the next ascending page into the gap. Returns false when nothing is left. */
  async loadNext(abortSignal?: AbortSignal): Promise<boolean> {
    if (this.complete.value || this.ascToken === undefined) return false;
    const token = this.ascToken;
    const ok = await this.run(async () => {
      const page = await this.fetchPage('asc', token, abortSignal);
      this.add(page.events);
      this.ascToken = page.nextPageToken;
      this.updateComplete();
      return true;
    });
    return ok === true && !this.complete.value;
  }

  /** Loads every remaining page, reporting the loaded count after each page. */
  async loadAll(abortSignal?: AbortSignal, onProgress?: (loaded: number) => void): Promise<void> {
    await this.init(abortSignal);
    while (!this.complete.value && !abortSignal?.aborted && !this.error.value) {
      const more = await this.loadNext(abortSignal);
      onProgress?.(this.byId.size);
      if (!more) break;
    }
  }
}
