import { signal } from '@preact/signals';
import { api } from './api';

export const SYSTEM_NAMESPACE = 'temporal-system';

/** The parts of a DescribeNamespaceResponse the shell uses; the rest stays untyped until needed. */
export interface NamespaceEntry {
  namespaceInfo?: { name?: string; state?: string; description?: string };
  [key: string]: unknown;
}

interface ListNamespacesResponse {
  namespaces?: NamespaceEntry[];
  nextPageToken?: string;
}

/** Safety stop for a server that keeps returning page tokens. */
const MAX_PAGES = 50;

/** Fetches every page of ListNamespaces, hiding temporal-system unless it is enabled. */
export async function fetchNamespaces(showSystem: boolean, abortSignal?: AbortSignal): Promise<NamespaceEntry[]> {
  const all: NamespaceEntry[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await api.get<ListNamespacesResponse>(
      '/api/v1/namespaces',
      { pageSize: 200, nextPageToken: token },
      abortSignal,
    );
    all.push(...(res.namespaces ?? []));
    token = res.nextPageToken || undefined;
    if (!token) break;
  }
  return all
    .filter((n) => n.namespaceInfo?.name && (showSystem || n.namespaceInfo.name !== SYSTEM_NAMESPACE))
    .sort((a, b) => (a.namespaceInfo?.name ?? '').localeCompare(b.namespaceInfo?.name ?? ''));
}

export const namespaces = signal<NamespaceEntry[] | null>(null);
export const namespacesError = signal<Error | null>(null);

export async function loadNamespaces(showSystem: boolean): Promise<void> {
  namespacesError.value = null;
  try {
    namespaces.value = await fetchNamespaces(showSystem);
  } catch (err) {
    namespacesError.value = err instanceof Error ? err : new Error(String(err));
  }
}

export const namespaceName = (n: NamespaceEntry): string => n.namespaceInfo?.name ?? '';
