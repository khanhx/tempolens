import type { Query } from './lib/api';
import { buildUrl, seg } from './lib/api';

const NS = '/namespaces/:ns';
const RUN = `${NS}/workflows/:wf/:run`;

/**
 * Route patterns. They mirror upstream temporalio/ui paths so existing deep
 * links keep working; `allWorkflows` and `graph` are Tempolens additions.
 * Order matters where patterns overlap (`start-workflow` before `:wf`,
 * `create` before `:id`); app.tsx lists them in that order.
 */
export const P = {
  root: '/',
  selectNamespace: '/select-namespace',
  namespaces: '/namespaces',
  namespace: NS,
  allWorkflows: '/workflows',
  workflows: `${NS}/workflows`,
  startWorkflow: `${NS}/workflows/start-workflow`,
  workflowLatest: `${NS}/workflows/:wf`,
  run: RUN,
  timeline: `${RUN}/timeline`,
  history: `${RUN}/history`,
  historyLegacyMode: `${RUN}/history/:mode`,
  eventDetail: `${RUN}/history/events/:eventId`,
  historyJson: `${RUN}/history.json`,
  relationships: `${RUN}/relationships`,
  graph: `${RUN}/graph`,
  workers: `${RUN}/workers`,
  pendingActivities: `${RUN}/pending-activities`,
  callStack: `${RUN}/call-stack`,
  stackTrace: `${RUN}/stack-trace`,
  query: `${RUN}/query`,
  userMetadata: `${RUN}/user-metadata`,
  searchAttributes: `${RUN}/search-attributes`,
  memo: `${RUN}/memo`,
  nexusLinks: `${RUN}/nexus-links`,
  result: `${RUN}/result`,
  trace: `${RUN}/trace`,
  schedules: `${NS}/schedules`,
  scheduleCreate: `${NS}/schedules/create`,
  schedule: `${NS}/schedules/:id`,
  scheduleEdit: `${NS}/schedules/:id/edit`,
  batchOperations: `${NS}/batch-operations`,
  batchOperation: `${NS}/batch-operations/:jobId`,
  archival: `${NS}/archival`,
  archivedHistory: `${NS}/archival/:wf/:run/history`,
  taskQueues: `${NS}/task-queues`,
  taskQueue: `${NS}/task-queues/:queue`,
  console: `${NS}/console`,
  nexus: '/nexus',
  nexusCreate: '/nexus/create',
  nexusEndpoint: '/nexus/:id',
  nexusEdit: '/nexus/:id/edit',
  codecSettings: '/settings/codec',
  search: '/search',
  cluster: '/cluster',
  import: '/import',
  importEvents: '/import/events',
} as const;

/** Parameter names of a pattern, e.g. `'ns' | 'wf' | 'run'`. */
export type RouteParams<T extends string> = T extends `${string}:${infer Name}/${infer Rest}`
  ? Name | RouteParams<`/${Rest}`>
  : T extends `${string}:${infer Name}`
    ? Name
    : never;

/** Fills a pattern; each parameter is encoded exactly once. */
export function href<T extends string>(pattern: T, params: Record<RouteParams<T>, string>, query?: Query): string {
  const values = params as Record<string, string>;
  const path = pattern.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    const value = values[name];
    if (value === undefined || value === '') throw new Error(`href: missing route parameter "${name}"`);
    return seg(value);
  });
  return query ? buildUrl(path, query) : path;
}

/** The decoded namespace of a `/namespaces/:ns/...` path, or null. */
export function namespaceFromPath(path: string): string | null {
  const m = /^\/namespaces\/([^/]+)/.exec(path);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** Namespace sections whose list page exists in every namespace. */
const SWITCHABLE_SECTIONS = new Set(['workflows', 'schedules', 'batch-operations', 'archival', 'task-queues', 'console']);

/**
 * Target of the namespace switcher: the same section's list page in the new
 * namespace when the current page is in a switchable section, otherwise the
 * workflow list. Deeper pages (one workflow, one schedule) do not carry over.
 */
export function switchNamespacePath(path: string, ns: string): string {
  const section = /^\/namespaces\/[^/]+\/([^/]+)/.exec(path)?.[1];
  return section && SWITCHABLE_SECTIONS.has(section) ? `/namespaces/${seg(ns)}/${section}` : href(P.workflows, { ns });
}

export interface SearchLink {
  /** Namespaces to search, or `*`. */
  ns: readonly string[] | '*';
  kind?: 'activity' | 'event';
  query?: string;
  activityType?: string;
  mode?: 'pending' | 'history';
  minAttempt?: string;
  eventType?: string;
  failureText?: string;
}

/** Link to the activity/event search page with its form pre-filled. */
export function searchHref(l: SearchLink): string {
  return buildUrl(P.search, {
    ns: l.ns === '*' ? '*' : l.ns.join(','),
    kind: l.kind,
    query: l.query || undefined,
    activityType: l.activityType || undefined,
    mode: l.mode,
    minAttempt: l.minAttempt || undefined,
    eventType: l.eventType || undefined,
    failureText: l.failureText || undefined,
  });
}
