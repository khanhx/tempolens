// Task queue suggestions. Temporal 1.24 cannot list task queues, so candidates
// are inferred from recent workflows (visibility), from schedules' start-workflow
// actions, and from the queues this browser opened recently. Remote results are
// cached per namespace; recent queues are read from storage on every call.
import { api, ApiError, seg } from './api';
import { isRunning } from './temporal';

export type QueueSource = 'workflow' | 'schedule' | 'recent';

export interface QueueSuggestion {
  name: string;
  /** Running workflows on the queue among the rows fetched. */
  running: number;
  sources: QueueSource[];
}

export interface QueueSuggestions {
  items: QueueSuggestion[];
  /** False when the running counts may be low: more running workflows exist than were fetched. */
  runningComplete: boolean;
  /** Set when a source failed or was cut short; the items are what was gathered before that. */
  error?: string;
}

interface Remote {
  /** Queue name to running count, from workflow rows. */
  workflows: Map<string, number>;
  schedules: Set<string>;
  runningComplete: boolean;
  error?: string;
}

/** Workflow rows per page and pages read: about the 1000 most recent executions, running ones first. */
export const WORKFLOW_PAGE_SIZE = 500;
export const WORKFLOW_PAGES = 2;
/** One page of schedules; ListSchedules has no task queue, so a few are described. */
export const SCHEDULE_PAGE_SIZE = 100;
export const SCHEDULE_DESCRIBES = 5;
/** How long a namespace's remote result is reused; a result cut short by an error is retried sooner. */
export const CACHE_TTL_MS = 3 * 60_000;
export const PARTIAL_TTL_MS = 30_000;
export const RECENT_MAX = 10;

interface WorkflowRow {
  execution?: { workflowId?: string };
  taskQueue?: string;
  status?: string;
}

interface ScheduleEntry {
  scheduleId?: string;
  info?: { recentActions?: { startWorkflowResult?: { workflowId?: string } }[] };
}

interface DescribeSchedule {
  schedule?: { action?: { startWorkflow?: { taskQueue?: { name?: string } } } };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const rateLimited = (err: unknown) => err instanceof ApiError && err.status === 429;

/**
 * Reads the sources one request at a time, so a load stays inside the per-user
 * rate limit. A 429 stops the load; any other failure ends only its source.
 */
async function fetchRemote(ns: string): Promise<Remote> {
  const out: Remote = { workflows: new Map(), schedules: new Set(), runningComplete: true };
  const fail = (err: unknown) => {
    out.error ??= rateLimited(err) ? 'The server is rate limiting requests; suggestions are partial.' : message(err);
  };
  const seenWorkflowIds = new Set<string>();

  try {
    let token: string | undefined;
    let lastRunning = false;
    for (let page = 0; page < WORKFLOW_PAGES; page += 1) {
      const res = await api.get<{ executions?: WorkflowRow[]; nextPageToken?: string }>(`/api/v1/namespaces/${seg(ns)}/workflows`, {
        pageSize: WORKFLOW_PAGE_SIZE,
        nextPageToken: token,
      });
      for (const row of res.executions ?? []) {
        if (row.execution?.workflowId) seenWorkflowIds.add(row.execution.workflowId);
        lastRunning = isRunning(row.status);
        const q = row.taskQueue;
        if (!q) continue;
        out.workflows.set(q, (out.workflows.get(q) ?? 0) + (lastRunning ? 1 : 0));
      }
      token = res.nextPageToken || undefined;
      if (!token) break;
    }
    // Running workflows come first, so the counts are complete unless the last row read still runs.
    out.runningComplete = !token || !lastRunning;
  } catch (err) {
    fail(err);
    out.runningComplete = false;
    if (rateLimited(err)) return out;
  }

  try {
    const res = await api.get<{ schedules?: ScheduleEntry[] }>(`/api/v1/namespaces/${seg(ns)}/schedules`, { maximumPageSize: SCHEDULE_PAGE_SIZE });
    // A schedule whose recent run is among the rows read already gave its queue.
    const unknown = (res.schedules ?? []).filter(
      (s) => s.scheduleId && !(s.info?.recentActions ?? []).some((a) => seenWorkflowIds.has(a.startWorkflowResult?.workflowId ?? '')),
    );
    for (const s of unknown.slice(0, SCHEDULE_DESCRIBES)) {
      const d = await api.get<DescribeSchedule>(`/api/v1/namespaces/${seg(ns)}/schedules/${seg(s.scheduleId as string)}`);
      const q = d.schedule?.action?.startWorkflow?.taskQueue?.name;
      if (q) out.schedules.add(q);
    }
  } catch (err) {
    fail(err);
  }
  return out;
}

interface CacheEntry {
  at: number;
  ttl: number;
  promise: Promise<Remote>;
}

const cache = new Map<string, CacheEntry>();

/** Forgets every cached result; for tests. */
export function clearQueueCache() {
  cache.clear();
}

/** The namespace's remote sources, cached; concurrent callers share one load. */
function remote(ns: string, now: number): Promise<Remote> {
  const hit = cache.get(ns);
  if (hit && now - hit.at < hit.ttl) return hit.promise;
  const entry: CacheEntry = { at: now, ttl: CACHE_TTL_MS, promise: fetchRemote(ns) };
  // fetchRemote does not reject; a partial result keeps a shorter lifetime.
  void entry.promise.then((r) => {
    if (r.error) entry.ttl = PARTIAL_TTL_MS;
  });
  cache.set(ns, entry);
  return entry.promise;
}

/**
 * Merges the sources: recent queues first in the order opened, then the rest
 * by running count (highest first) and name.
 */
export function mergeQueues(r: Pick<Remote, 'workflows' | 'schedules'>, recent: readonly string[]): QueueSuggestion[] {
  const byName = new Map<string, QueueSuggestion>();
  const add = (name: string, source: QueueSource, running = 0) => {
    const item = byName.get(name) ?? { name, running: 0, sources: [] };
    item.running += running;
    if (!item.sources.includes(source)) item.sources.push(source);
    byName.set(name, item);
  };
  for (const name of recent) add(name, 'recent');
  for (const [name, running] of r.workflows) add(name, 'workflow', running);
  for (const name of r.schedules) add(name, 'schedule');
  const rank = new Map(recent.map((name, i) => [name, i]));
  return [...byName.values()].sort((a, b) => {
    const ra = rank.get(a.name) ?? Infinity;
    const rb = rank.get(b.name) ?? Infinity;
    if (ra !== rb) return ra - rb;
    return b.running - a.running || a.name.localeCompare(b.name);
  });
}

export async function loadQueueSuggestions(ns: string, storage: StorageLike | undefined = defaultStorage()): Promise<QueueSuggestions> {
  const r = await remote(ns, Date.now());
  return { items: mergeQueues(r, loadRecentQueues(ns, storage)), runningComplete: r.runningComplete, error: r.error };
}

/** Case-insensitive substring match on the name; an empty text keeps every item. */
export function filterQueues(items: readonly QueueSuggestion[], text: string): QueueSuggestion[] {
  const needle = text.trim().toLowerCase();
  return needle ? items.filter((i) => i.name.toLowerCase().includes(needle)) : [...items];
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export const recentKey = (ns: string) => `tempolens.taskQueues.recent.${ns}`;

/** Queues opened in this namespace, most recent first. */
export function loadRecentQueues(ns: string, storage: StorageLike | undefined = defaultStorage()): string[] {
  try {
    const v: unknown = JSON.parse(storage?.getItem(recentKey(ns)) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Moves the queue to the front of the namespace's recent list. Storage errors are ignored. */
export function recordRecentQueue(ns: string, queue: string, storage: StorageLike | undefined = defaultStorage()) {
  const name = queue.trim();
  if (!name) return;
  const next = [name, ...loadRecentQueues(ns, storage).filter((q) => q !== name)].slice(0, RECENT_MAX);
  try {
    storage?.setItem(recentKey(ns), JSON.stringify(next));
  } catch {
    // Private mode or a full quota: the list is a convenience only.
  }
}
