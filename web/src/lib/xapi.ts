// Typed clients for the Tempolens /api/x extensions (contract §3) and the
// helpers the views share: partial-result and 429 messages, and the
// search attributes common to several namespaces.
import type { Query } from './api';
import { ApiError, api } from './api';
import type { SAType } from './query/build';
import type { NamespaceSearchAttributes } from './server-info';
import type { WorkflowExecutionInfo } from './temporal';

/** `*` means every namespace the user may read. */
export type NamespaceSelection = '*' | readonly string[];

export interface NamespaceError {
  namespace: string;
  code: number;
  message: string;
}

export interface XListResponse {
  executions: { namespace: string; execution: WorkflowExecutionInfo }[];
  nextPageToken: string;
  errors: NamespaceError[];
}

export interface XCountResponse {
  total: number;
  byStatus: Record<string, number>;
  perNamespace: Record<string, { total: number; byStatus: Record<string, number> }>;
  errors: NamespaceError[];
}

export interface SearchHit {
  eventId?: string;
  activityId?: string;
  attempt?: number;
  eventTime?: string | null;
  detail?: string;
}

export interface SearchMatch {
  namespace: string;
  workflowId: string;
  runId: string;
  workflowType: string;
  status: string;
  startTime: string | null;
  closeTime: string | null;
  hits: SearchHit[];
}

export type PartialReason = 'cap' | 'timeout' | 'error';

export interface SearchResponse {
  matches: SearchMatch[];
  candidates: number;
  scanned: number;
  partial: boolean;
  partialReasons: PartialReason[];
  elapsedMs: number;
}

export const X_PAGE_SIZE_MAX = 100;

export function namespacesParam(sel: NamespaceSelection): string {
  if (sel === '*') return '*';
  const names = [...new Set(sel.map((s) => s.trim()).filter(Boolean))];
  if (names.length === 0) throw new Error('Choose at least one namespace.');
  return names.join(',');
}

export interface ListParams {
  query?: string;
  pageSize?: number;
  pageToken?: string;
}

export function listQuery(sel: NamespaceSelection, p: ListParams): Query {
  return {
    namespaces: namespacesParam(sel),
    query: p.query?.trim() || undefined,
    pageSize: Math.min(Math.max(1, p.pageSize ?? 50), X_PAGE_SIZE_MAX),
    pageToken: p.pageToken || undefined,
  };
}

export interface ActivitySearch {
  namespaces: NamespaceSelection;
  query?: string;
  activityType: string;
  mode: 'pending' | 'history';
  minAttempt?: number;
  max?: number;
}

export interface EventSearch {
  namespaces: NamespaceSelection;
  query?: string;
  eventType?: string;
  failureText?: string;
  max?: number;
}

export function activityQuery(s: ActivitySearch): Query {
  if (!s.activityType.trim()) throw new Error('Enter an activity type.');
  if (s.minAttempt !== undefined && s.mode !== 'pending') throw new Error('Minimum attempt only applies to pending activities.');
  if (s.minAttempt !== undefined && (!Number.isInteger(s.minAttempt) || s.minAttempt < 1)) throw new Error('Minimum attempt must be a whole number of at least 1.');
  return {
    namespaces: namespacesParam(s.namespaces),
    query: s.query?.trim() || undefined,
    activityType: s.activityType.trim(),
    mode: s.mode,
    minAttempt: s.minAttempt,
    max: s.max,
  };
}

export function eventQuery(s: EventSearch): Query {
  if (!s.eventType?.trim() && !s.failureText?.trim()) throw new Error('Choose an event type or enter failure text.');
  return {
    namespaces: namespacesParam(s.namespaces),
    query: s.query?.trim() || undefined,
    eventType: s.eventType?.trim() || undefined,
    failureText: s.failureText?.trim() || undefined,
    max: s.max,
  };
}

export const xapi = {
  workflows: (sel: NamespaceSelection, p: ListParams, signal?: AbortSignal) => api.get<XListResponse>('/api/x/workflows', listQuery(sel, p), signal),
  count: (sel: NamespaceSelection, query?: string, signal?: AbortSignal) =>
    api.get<XCountResponse>('/api/x/workflows/count', { namespaces: namespacesParam(sel), query: query?.trim() || undefined }, signal),
  searchActivity: (s: ActivitySearch, signal?: AbortSignal) => api.get<SearchResponse>('/api/x/search/activity', activityQuery(s), signal),
  searchEvent: (s: EventSearch, signal?: AbortSignal) => api.get<SearchResponse>('/api/x/search/event', eventQuery(s), signal),
};

const REASON_TEXT: Record<PartialReason, string> = {
  cap: 'a scan limit was reached (candidates, history size or hits per workflow)',
  timeout: 'the scan timed out',
  error: 'some workflows could not be read',
};

/** Banner text for an incomplete scan, or null when the result is complete. */
export function partialText(r: Pick<SearchResponse, 'partial' | 'partialReasons' | 'scanned' | 'candidates'>): string | null {
  if (!r.partial) return null;
  const reasons = r.partialReasons.length ? r.partialReasons : (['error'] as PartialReason[]);
  const why = reasons.map((x) => `${REASON_TEXT[x] ?? x} (${x})`).join('; ');
  const advice = reasons.includes('cap') || reasons.includes('timeout') ? ' Narrow the query, for example with a time range or a status, to see everything.' : '';
  return `Partial result: scanned ${r.scanned.toLocaleString('en-US')} of ${r.candidates.toLocaleString('en-US')} candidate workflows; ${why}.${advice}`;
}

/** "Busy, retry in N s" for a 429, or null for any other error. */
export function busyText(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 429) return null;
  const s = err.retryAfterMs !== undefined ? Math.max(1, Math.ceil(err.retryAfterMs / 1000)) : null;
  return s ? `The server is busy; retry in ${s} s.` : 'The server is busy; retry in a few seconds.';
}

/** One line per failing namespace, for the list banners. */
export const namespaceErrorText = (errors: readonly NamespaceError[]) => errors.map((e) => `${e.namespace}: ${e.message} (code ${e.code})`);

export interface CommonAttributes {
  types: Record<string, SAType>;
  /** Custom attributes present, with the same type, in every namespace. */
  custom: string[];
  /** Custom attributes left out, with the namespaces that lack them. */
  missing: Record<string, string[]>;
}

/**
 * System attributes plus the custom attributes every selected namespace
 * has (with one type). A query on the others would fail in some namespaces.
 */
export function commonAttributes(perNamespace: Record<string, NamespaceSearchAttributes>): CommonAttributes {
  const names = Object.keys(perNamespace);
  const types: Record<string, SAType> = {};
  const custom: string[] = [];
  const missing: Record<string, string[]> = {};
  const allCustom = new Set(names.flatMap((n) => perNamespace[n]?.custom ?? []));
  for (const n of names) {
    const sa = perNamespace[n];
    if (!sa) continue;
    for (const [attr, t] of Object.entries(sa.types)) if (!sa.custom.includes(attr)) types[attr] = t;
  }
  for (const attr of [...allCustom].sort()) {
    const lacking = names.filter((n) => perNamespace[n]?.types[attr] === undefined || !perNamespace[n]?.custom.includes(attr));
    const kinds = new Set(names.map((n) => perNamespace[n]?.types[attr]).filter(Boolean));
    if (lacking.length === 0 && kinds.size === 1) {
      custom.push(attr);
      types[attr] = [...kinds][0] as SAType;
    } else {
      missing[attr] = lacking.length ? lacking : names;
    }
  }
  return { types, custom, missing };
}

export interface GraphNode {
  id: string;
  namespace: string;
  workflowId: string;
  runId: string;
  workflowType: string;
  status: string;
  startTime: string | null;
  closeTime: string | null;
  focus: boolean;
  root: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'child' | 'continuedAsNew' | 'reset' | 'signal' | 'cancelRequest';
  eventId?: string;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  partial: boolean;
  notes: string[];
}

/**
 * Warnings for an incomplete graph, for the graph and trace banners. The
 * server puts the cause of a partial walk (timeout, RPC error such as a rate
 * limit) in `notes`, so they are always shown.
 */
export function graphWarnings(g: Pick<GraphResponse, 'truncated' | 'partial' | 'notes'>): string[] {
  const out: string[] = [];
  if (g.truncated) out.push("The graph was cut off at the server's node limit; some relatives are not shown.");
  if (g.partial) out.push('Part of the graph could not be read; it may be incomplete.');
  return [...out, ...g.notes];
}

export function graphQuery(namespace: string, workflowId: string, runId: string, depth: number): Query {
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) throw new Error('Depth must be 1, 2 or 3.');
  return { namespace, workflowId, runId, depth };
}

export const fetchGraph = (namespace: string, workflowId: string, runId: string, depth: number, signal?: AbortSignal) =>
  api.get<GraphResponse>('/api/x/graph', graphQuery(namespace, workflowId, runId, depth), signal);
