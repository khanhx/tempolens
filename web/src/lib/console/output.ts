// Presenting console responses: a table for the list responses the console
// knows, the stack trace text of a `__stack_trace` query, and readable errors.
import { ApiError } from '../api';
import { decodePayload, decodedValue, isPayload } from '../payload/decode';
import type { Json } from './methods';
import { fieldAt, OP, WF } from './methods';

export interface Table {
  columns: string[];
  rows: string[][];
}

type Column = [label: string, path: string];

const cell = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** List responses with a table view: the array field and its columns. */
const LISTS: Record<string, { field: string; columns: Column[] }> = {
  [`${WF}ListWorkflowExecutions`]: {
    field: 'executions',
    columns: [
      ['Workflow ID', 'execution.workflowId'],
      ['Run ID', 'execution.runId'],
      ['Type', 'type.name'],
      ['Status', 'status'],
      ['Start', 'startTime'],
      ['Close', 'closeTime'],
      ['Task queue', 'taskQueue'],
    ],
  },
  [`${WF}ListSchedules`]: {
    field: 'schedules',
    columns: [
      ['Schedule ID', 'scheduleId'],
      ['Workflow type', 'info.workflowType.name'],
      ['Paused', 'info.paused'],
      ['Notes', 'info.notes'],
    ],
  },
  [`${WF}ListNamespaces`]: {
    field: 'namespaces',
    columns: [
      ['Name', 'namespaceInfo.name'],
      ['State', 'namespaceInfo.state'],
      ['Retention', 'config.workflowExecutionRetentionTtl'],
      ['Owner', 'namespaceInfo.ownerEmail'],
      ['Description', 'namespaceInfo.description'],
    ],
  },
  [`${WF}ListBatchOperations`]: {
    field: 'operationInfo',
    columns: [
      ['Job ID', 'jobId'],
      ['State', 'state'],
      ['Start', 'startTime'],
      ['Close', 'closeTime'],
    ],
  },
};

const SA_TYPE_PREFIX = 'INDEXED_VALUE_TYPE_';

function searchAttributeTable(response: unknown): Table | null {
  if (!isObj(response)) return null;
  const rows: string[][] = [];
  for (const [field, kind] of [['customAttributes', 'Custom'], ['systemAttributes', 'System']] as const) {
    const map = response[field];
    if (!isObj(map)) continue;
    for (const [name, type] of Object.entries(map).sort(([a], [b]) => a.localeCompare(b))) {
      rows.push([name, cell(type).replace(SA_TYPE_PREFIX, ''), kind]);
    }
  }
  return { columns: ['Name', 'Type', 'Kind'], rows };
}

/** A table for list responses the console knows, or null to show JSON only. */
export function listTable(method: string, response: unknown): Table | null {
  if (method === `${OP}ListSearchAttributes`) return searchAttributeTable(response);
  const spec = LISTS[method];
  if (!spec) return null;
  const list = fieldAt(response, spec.field);
  const items = Array.isArray(list) ? list : [];
  return { columns: spec.columns.map(([label]) => label), rows: items.map((item) => spec.columns.map(([, path]) => cell(fieldAt(item, path)))) };
}

/** The decoded text of a `__stack_trace` query result, or null when there is none. */
export function stackText(response: unknown): string | null {
  const list = fieldAt(response, 'queryResult.payloads');
  const first: unknown = Array.isArray(list) ? list[0] : undefined;
  if (!isPayload(first)) return null;
  const value = decodedValue(decodePayload(first, true));
  return typeof value === 'string' ? value : null;
}

const GRPC_CODES = [
  'OK',
  'Canceled',
  'Unknown',
  'InvalidArgument',
  'DeadlineExceeded',
  'NotFound',
  'AlreadyExists',
  'PermissionDenied',
  'ResourceExhausted',
  'FailedPrecondition',
  'Aborted',
  'OutOfRange',
  'Unimplemented',
  'Internal',
  'Unavailable',
  'DataLoss',
  'Unauthenticated',
];

/** `HTTP 403 PermissionDenied: message` for API errors; the message otherwise. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const code = err.code !== undefined ? GRPC_CODES[err.code] : undefined;
    const retry = err.retryAfterMs !== undefined ? ` Retry in ${Math.ceil(err.retryAfterMs / 1000)} s.` : '';
    return `${err.status ? `HTTP ${err.status}` : 'Network'}${code ? ` ${code}` : ''}: ${err.message}${retry}`;
  }
  return err instanceof Error ? err.message : String(err);
}
