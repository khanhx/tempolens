// Cluster/system info and per-namespace metadata, fetched once and cached.
// They drive capability gating (Nexus, prefix search, ORDER BY support).
import { signal } from '@preact/signals';
import { api, seg } from './api';
import type { SAType } from './query/build';
import { saTypeFromApi } from './query/build';

export interface ClusterInfo {
  serverVersion?: string;
  visibilityStore?: string;
  persistenceStore?: string;
  clusterName?: string;
}

export interface SystemInfo {
  serverVersion?: string;
  capabilities?: Record<string, boolean>;
}

export const clusterInfo = signal<ClusterInfo | null>(null);
export const systemInfo = signal<SystemInfo | null>(null);

let serverInfoLoad: Promise<void> | null = null;

/** Loads cluster-info and system-info once; a failure leaves them null (features stay hidden). */
export function loadServerInfo(): Promise<void> {
  serverInfoLoad ??= Promise.all([
    api.get<ClusterInfo>('/api/v1/cluster-info').then(
      (v) => void (clusterInfo.value = v),
      () => undefined,
    ),
    api.get<SystemInfo>('/api/v1/system-info').then(
      (v) => void (systemInfo.value = v),
      () => undefined,
    ),
  ]).then(() => undefined);
  return serverInfoLoad;
}

export const hasCapability = (name: string) => systemInfo.value?.capabilities?.[name] === true;

export interface NamespaceSearchAttributes {
  /** Every attribute (system and custom) by name. */
  types: Record<string, SAType>;
  /** Custom attribute names, sorted. */
  custom: string[];
}

interface SearchAttributesResponse {
  customAttributes?: Record<string, string>;
  systemAttributes?: Record<string, string>;
}

/**
 * Extra fields that queries accept but ListSearchAttributes does not list on
 * every server version.
 */
const IMPLICIT_ATTRIBUTES: Record<string, SAType> = {
  WorkflowId: 'Keyword',
  WorkflowType: 'Keyword',
  ExecutionStatus: 'Keyword',
};

const saCache = new Map<string, Promise<NamespaceSearchAttributes>>();

export function searchAttributes(ns: string): Promise<NamespaceSearchAttributes> {
  let p = saCache.get(ns);
  if (!p) {
    p = api.get<SearchAttributesResponse>(`/api/v1/namespaces/${seg(ns)}/search-attributes`).then((res) => {
      const types: Record<string, SAType> = { ...IMPLICIT_ATTRIBUTES };
      const custom: string[] = [];
      for (const [name, apiType] of Object.entries(res.systemAttributes ?? {})) {
        const t = saTypeFromApi(apiType);
        if (t) types[name] = t;
      }
      for (const [name, apiType] of Object.entries(res.customAttributes ?? {})) {
        const t = saTypeFromApi(apiType);
        if (t) {
          types[name] = t;
          custom.push(name);
        }
      }
      return { types, custom: custom.sort() };
    });
    // Do not cache failures.
    p.catch(() => saCache.delete(ns));
    saCache.set(ns, p);
  }
  return p;
}

export interface NamespaceDescription {
  namespaceInfo?: {
    name?: string;
    state?: string;
    description?: string;
    ownerEmail?: string;
    capabilities?: Record<string, boolean>;
  };
  config?: { workflowExecutionRetentionTtl?: string; historyArchivalState?: string; visibilityArchivalState?: string };
  [key: string]: unknown;
}

const nsCache = new Map<string, Promise<NamespaceDescription>>();

export function describeNamespace(ns: string): Promise<NamespaceDescription> {
  let p = nsCache.get(ns);
  if (!p) {
    p = api.get<NamespaceDescription>(`/api/v1/namespaces/${seg(ns)}`);
    p.catch(() => nsCache.delete(ns));
    nsCache.set(ns, p);
  }
  return p;
}

/** Drops the cached describe and search attributes of `ns` after an admin change. */
export function invalidateNamespace(ns: string): void {
  nsCache.delete(ns);
  saCache.delete(ns);
}
