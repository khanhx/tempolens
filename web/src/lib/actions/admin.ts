// Admin actions: namespaces and search attributes. The server allows them
// to the admin role only and refuses protected namespaces and system
// attributes; deletes must name their target (contract §1.6).
import { ApiError, seg } from '../api';
import type { SAType } from '../query/build';
import { parseDuration, parseHumanDuration, toProtoDuration } from '../time';
import type { Me } from '../me';
import { cliCommand } from './cli-command';
import type { ActionRequest } from './workflow-actions';

/** Always protected, whatever TEMPOLENS_PROTECTED_NAMESPACES says. */
export const ALWAYS_PROTECTED: readonly string[] = ['default', 'temporal-system'];

/** Why the server refuses to delete `name`, or null when it may be deleted. */
export function protectedReason(name: string, current: Me | null): string | null {
  if (ALWAYS_PROTECTED.includes(name) || current?.settings.protectedNamespaces?.includes(name)) {
    return `${name} is a protected namespace; the server refuses to delete it.`;
  }
  return null;
}

export type ArchivalState = '' | 'ARCHIVAL_STATE_ENABLED' | 'ARCHIVAL_STATE_DISABLED';

export interface NamespaceForm {
  name: string;
  description: string;
  ownerEmail: string;
  /** Human duration, e.g. `3d` or `72h`. */
  retention: string;
  historyArchival: ArchivalState;
  visibilityArchival: ArchivalState;
}

/** A protobuf retention (`"259200s"`) as an editable duration: `3d`, `36h` or `90000s`. */
export function humanRetention(proto: string | undefined): string {
  const ms = parseDuration(proto);
  if (ms === null || ms <= 0) return '';
  for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000]] as const) if (ms % size === 0) return `${ms / size}${unit}`;
  return `${Math.round(ms / 1000)}s`;
}

const archivalFlag = (s: ArchivalState) => (s ? (s === 'ARCHIVAL_STATE_ENABLED' ? 'enabled' : 'disabled') : undefined);

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

function retention(human: string): string {
  const ms = parseHumanDuration(human);
  if (ms === null || ms < 86_400_000) throw new Error('Retention must be a duration of at least one day, e.g. 3d or 72h.');
  return toProtoDuration(ms);
}

export function registerNamespaceRequest(f: NamespaceForm): ActionRequest {
  const name = f.name.trim();
  if (!NAME.test(name)) throw new Error('The name must start with a letter or digit and use letters, digits, ".", "_" and "-".');
  const ret = retention(f.retention);
  return {
    method: 'POST',
    path: '/api/v1/namespaces',
    body: {
      namespace: name,
      workflowExecutionRetentionPeriod: ret,
      ...(f.description.trim() ? { description: f.description.trim() } : {}),
      ...(f.ownerEmail.trim() ? { ownerEmail: f.ownerEmail.trim() } : {}),
      ...(f.historyArchival ? { historyArchivalState: f.historyArchival } : {}),
      ...(f.visibilityArchival ? { visibilityArchivalState: f.visibilityArchival } : {}),
    },
    cli: cliCommand(
      ['operator', 'namespace', 'create'],
      [
        ['namespace', name],
        ['retention', f.retention.trim()],
        ['description', f.description.trim() || undefined],
        ['email', f.ownerEmail.trim() || undefined],
        ['history-archival-state', archivalFlag(f.historyArchival)],
        ['visibility-archival-state', archivalFlag(f.visibilityArchival)],
      ],
    ),
  };
}

/** UpdateNamespace for description, owner, retention and archival states; never `promoteNamespace`. */
export function updateNamespaceRequest(f: NamespaceForm): ActionRequest {
  const name = f.name.trim();
  const config: Record<string, unknown> = { workflowExecutionRetentionTtl: retention(f.retention) };
  if (f.historyArchival) config.historyArchivalState = f.historyArchival;
  if (f.visibilityArchival) config.visibilityArchivalState = f.visibilityArchival;
  return {
    method: 'POST',
    path: `/api/v1/namespaces/${seg(name)}/update`,
    body: { updateInfo: { description: f.description.trim(), ownerEmail: f.ownerEmail.trim() }, config },
    cli: cliCommand(
      ['operator', 'namespace', 'update'],
      [
        ['namespace', name],
        ['retention', f.retention.trim()],
        ['description', f.description.trim() || undefined],
        ['email', f.ownerEmail.trim() || undefined],
        ['history-archival-state', archivalFlag(f.historyArchival)],
        ['visibility-archival-state', archivalFlag(f.visibilityArchival)],
      ],
    ),
  };
}

export function deleteNamespaceRequest(name: string): ActionRequest {
  return {
    method: 'DELETE',
    path: '/api/x/namespace',
    query: { namespace: name },
    confirm: name,
    cli: cliCommand(['operator', 'namespace', 'delete'], [['namespace', name], ['yes', true]]),
  };
}

const SA_API_TYPE: Record<SAType, string> = {
  Keyword: 'INDEXED_VALUE_TYPE_KEYWORD',
  Text: 'INDEXED_VALUE_TYPE_TEXT',
  Int: 'INDEXED_VALUE_TYPE_INT',
  Double: 'INDEXED_VALUE_TYPE_DOUBLE',
  Bool: 'INDEXED_VALUE_TYPE_BOOL',
  Datetime: 'INDEXED_VALUE_TYPE_DATETIME',
  KeywordList: 'INDEXED_VALUE_TYPE_KEYWORD_LIST',
};

export const SEARCH_ATTRIBUTE_TYPES = Object.keys(SA_API_TYPE) as SAType[];

const SA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function addSearchAttributeRequest(ns: string, name: string, type: SAType): ActionRequest {
  const n = name.trim();
  if (!SA_NAME.test(n)) throw new Error('Search attribute names use letters, digits and "_", and cannot start with a digit.');
  if (n.startsWith('Temporal')) throw new Error('Names starting with "Temporal" are reserved.');
  return {
    method: 'POST',
    path: '/api/x/search-attributes',
    query: { namespace: ns },
    body: { searchAttributes: { [n]: SA_API_TYPE[type] } },
    cli: cliCommand(['operator', 'search-attribute', 'create'], [['namespace', ns], ['name', n], ['type', type]]),
  };
}

/**
 * Right after RegisterNamespace, Temporal answers NotFound for a few seconds
 * while the namespace propagates; say so instead of "namespace not found".
 */
export function explainAddSearchAttributeError(err: unknown): unknown {
  if (err instanceof ApiError && (err.status === 404 || err.code === 5)) {
    return new Error('The namespace is still being registered; try again in a few seconds.');
  }
  return err;
}

/** Removes attributes; the confirmation is the names, comma-separated in request order. */
export function removeSearchAttributesRequest(ns: string, names: readonly string[]): ActionRequest {
  if (names.length === 0) throw new Error('Choose at least one attribute.');
  return {
    method: 'DELETE',
    path: `/api/x/search-attributes?${new URLSearchParams([['namespace', ns], ...names.map((n): [string, string] => ['name', n])]).toString()}`,
    confirm: names.join(','),
    cli: cliCommand(['operator', 'search-attribute', 'remove'], [['namespace', ns], ['name', names], ['yes', true]]),
  };
}
