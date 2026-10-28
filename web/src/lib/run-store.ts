// State for one workflow run, shared by every detail tab. Tabs are separate
// routes, so the store is cached by run and survives tab switches; timers
// and the live poll run only while a tab is mounted.
import { signal } from '@preact/signals';
import { api, seg } from './api';
import { HistoryStore, apiPageFetcher } from './history/fetch';
import { apiLongPollFetcher, runLivePoll } from './history/live-poll';
import type { Payload } from './payload/decode';
import { decodePayload } from './payload/decode';
import { textToBase64 } from './payload/base64';
import { stringifyJson } from './payload/json-bigint';
import type { DescribeWorkflowResponse, Poller } from './temporal';
import { CLOSE_EVENT_TYPES, isRunning } from './temporal';

export interface Pollers {
  workflow: Poller[];
  activity: Poller[];
  nexus: Poller[];
}

export interface WorkflowMetadata {
  definition?: {
    type?: string;
    queryDefinitions?: { name?: string; description?: string }[];
    signalDefinitions?: { name?: string; description?: string }[];
    updateDefinitions?: { name?: string; description?: string }[];
  };
  currentDetails?: string;
}

const DESCRIBE_REFRESH_MS = 10_000;

export function workflowPath(ns: string, wf: string): string {
  return `/api/v1/namespaces/${seg(ns)}/workflows/${seg(wf)}`;
}

/** One JSON value as a `json/plain` payload, as upstream encodes user input. */
export function jsonPayload(value: unknown): Payload {
  return { metadata: { encoding: textToBase64('json/plain') }, data: textToBase64(stringifyJson(value, 0)) };
}

interface QueryResponse {
  queryResult?: { payloads?: Payload[] };
  queryRejected?: { status?: string };
}

/** Runs QueryWorkflow (a READ) and returns the raw result payloads. */
export async function queryWorkflow(ns: string, wf: string, run: string, queryType: string, args?: Payload[]): Promise<Payload[]> {
  const res = await api.post<QueryResponse>(`${workflowPath(ns, wf)}/query/${seg(queryType)}`, {
    execution: { workflowId: wf, runId: run },
    query: { queryType, ...(args?.length ? { queryArgs: { payloads: args } } : {}) },
  });
  if (res.queryRejected) throw new Error(`Query rejected: workflow status ${res.queryRejected.status ?? 'unknown'}`);
  return res.queryResult?.payloads ?? [];
}

export class RunStore {
  readonly describe = signal<DescribeWorkflowResponse | null>(null);
  readonly describeError = signal<Error | null>(null);
  readonly pollers = signal<Pollers | null>(null);
  readonly metadata = signal<WorkflowMetadata | null>(null);
  readonly latestRunId = signal<string | null>(null);
  readonly history: HistoryStore;

  private started = false;
  private active = 0;
  private refreshTimer: number | undefined;
  private live: AbortController | null = null;
  private liveToken: string | undefined;
  private liveWanted = true;

  constructor(
    readonly ns: string,
    readonly wf: string,
    readonly run: string,
  ) {
    this.history = new HistoryStore(apiPageFetcher(ns, wf, run));
  }

  get running(): boolean {
    return isRunning(this.describe.value?.workflowExecutionInfo?.status);
  }

  async loadDescribe(): Promise<void> {
    try {
      this.describe.value = await api.get<DescribeWorkflowResponse>(workflowPath(this.ns, this.wf), { 'execution.runId': this.run });
      this.describeError.value = null;
    } catch (err) {
      this.describeError.value = err instanceof Error ? err : new Error(String(err));
    }
  }

  private async loadPollers(): Promise<void> {
    const tq = this.describe.value?.executionConfig?.taskQueue?.name ?? this.describe.value?.workflowExecutionInfo?.taskQueue;
    if (!tq) return;
    const get = (type: number) =>
      api
        .get<{ pollers?: Poller[] }>(`/api/v1/namespaces/${seg(this.ns)}/task-queues/${seg(tq)}`, { taskQueueType: type })
        .then((r) => r.pollers ?? [])
        // Nexus task queues do not exist on older servers; treat any failure as "no pollers".
        .catch(() => [] as Poller[]);
    const [workflow, activity, nexus] = await Promise.all([get(1), get(2), get(3)]);
    this.pollers.value = { workflow, activity, nexus };
  }

  /** `__temporal_workflow_metadata`, only for a running workflow with workflow pollers. */
  private async loadMetadata(): Promise<void> {
    if (!this.running || !this.pollers.value?.workflow.length) return;
    try {
      const [first] = await queryWorkflow(this.ns, this.wf, this.run, '__temporal_workflow_metadata');
      const d = first ? decodePayload(first, true) : null;
      if (d?.kind === 'value' && d.value && typeof d.value === 'object') this.metadata.value = d.value as WorkflowMetadata;
    } catch {
      // Older SDKs lack the handler; the query tab falls back to free-text query types.
    }
  }

  private async loadLatest(): Promise<void> {
    try {
      const res = await api.get<DescribeWorkflowResponse>(workflowPath(this.ns, this.wf));
      this.latestRunId.value = res.workflowExecutionInfo?.execution.runId ?? null;
    } catch {
      this.latestRunId.value = null;
    }
  }

  /** Called when a tab mounts; returns the matching deactivate. */
  activate(): () => void {
    this.active++;
    if (!this.started) {
      this.started = true;
      void this.loadDescribe().then(async () => {
        await this.loadPollers();
        await this.loadMetadata();
        this.syncLive();
      });
      void this.history.init();
      void this.loadLatest();
    } else {
      this.syncLive();
    }
    this.refreshTimer ??= window.setInterval(() => {
      if (!document.hidden && this.running) void this.loadDescribe();
    }, DESCRIBE_REFRESH_MS);
    document.addEventListener('visibilitychange', this.onVisibility);
    return () => {
      this.active--;
      if (this.active > 0) return;
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
      document.removeEventListener('visibilitychange', this.onVisibility);
      this.stopLive();
    };
  }

  private onVisibility = () => this.syncLive();

  /** `refresh_off` turns live updates off; the poll resumes from its saved token. */
  setLiveWanted(wanted: boolean): void {
    this.liveWanted = wanted;
    this.syncLive();
  }

  private syncLive(): void {
    const should = this.active > 0 && this.liveWanted && this.running && !document.hidden;
    if (should && !this.live) this.startLive();
    else if (!should) this.stopLive();
  }

  private startLive(): void {
    const controller = new AbortController();
    this.live = controller;
    void runLivePoll({
      fetchPage: apiLongPollFetcher(this.ns, this.wf, this.run),
      signal: controller.signal,
      startToken: this.liveToken,
      onEvents: (events) => {
        const added = this.history.add(events);
        if (events.some((e) => CLOSE_EVENT_TYPES.has(e.eventType))) void this.loadDescribe();
        return added;
      },
    }).then((token) => {
      this.liveToken = token;
      if (this.live === controller) this.live = null;
    });
  }

  private stopLive(): void {
    this.live?.abort();
    this.live = null;
  }
}

const cache = new Map<string, RunStore>();
const CACHE_SIZE = 5;

/** The store for a run, reused across tabs; the oldest of more than five is dropped. */
export function runStore(ns: string, wf: string, run: string): RunStore {
  const key = `${ns}\u0000${wf}\u0000${run}`;
  let store = cache.get(key);
  if (store) {
    cache.delete(key);
  } else {
    store = new RunStore(ns, wf, run);
  }
  cache.set(key, store);
  while (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return store;
}
