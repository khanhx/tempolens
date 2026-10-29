// What the console knows about each gRPC method, shared by CLI and raw mode:
// the write actions it needs (mirroring the server policy, so the page can
// disable a command before sending it), the typed confirmation destructive
// calls must carry, and a minimal request template. The server enforces all
// of it again; this only spares the user a doomed request.
import type { WriteAction } from '../me';

export const WF = '/temporal.api.workflowservice.v1.WorkflowService/';
export const OP = '/temporal.api.operatorservice.v1.OperatorService/';

/** `StartWorkflowExecution` from a full method path. */
export const shortName = (method: string): string => method.slice(method.lastIndexOf('/') + 1);

export type Json = Record<string, unknown>;

export interface Call {
  method: string;
  request: Json;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * The value at a dotted camelCase path. protojson accepts both camelCase and
 * the proto field names, so each segment is tried in both spellings.
 */
export function fieldAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (!isObj(cur)) return undefined;
    cur = key in cur ? cur[key] : cur[snake(key)];
  }
  return cur;
}

const text = (obj: unknown, path: string): string => {
  const v = fieldAt(obj, path);
  return typeof v === 'string' ? v : '';
};

/** Write actions per mutating method, as the server policy declares them. */
const ACTIONS: Record<string, readonly WriteAction[]> = {
  [`${WF}StartWorkflowExecution`]: ['start'],
  [`${WF}SignalWorkflowExecution`]: ['signal'],
  [`${WF}SignalWithStartWorkflowExecution`]: ['start', 'signal'],
  [`${WF}UpdateWorkflowExecution`]: ['update'],
  [`${WF}RequestCancelWorkflowExecution`]: ['cancel'],
  [`${WF}TerminateWorkflowExecution`]: ['terminate'],
  [`${WF}DeleteWorkflowExecution`]: ['delete'],
  [`${WF}ResetWorkflowExecution`]: ['reset'],
  [`${WF}PauseWorkflowExecution`]: ['pause'],
  [`${WF}UnpauseWorkflowExecution`]: ['pause'],
  [`${WF}RespondActivityTaskCompletedById`]: ['activity'],
  [`${WF}RespondActivityTaskFailedById`]: ['activity'],
  [`${WF}PauseActivity`]: ['activity'],
  [`${WF}UnpauseActivity`]: ['activity'],
  [`${WF}ResetActivity`]: ['activity'],
  [`${WF}UpdateActivityOptions`]: ['activity'],
  [`${WF}StartBatchOperation`]: ['batch'],
  [`${WF}StopBatchOperation`]: ['batch'],
  [`${WF}CreateSchedule`]: ['schedule', 'start'],
  [`${WF}UpdateSchedule`]: ['schedule', 'start'],
  [`${WF}PatchSchedule`]: ['schedule'],
  [`${WF}DeleteSchedule`]: ['schedule'],
  [`${OP}CreateNexusEndpoint`]: ['nexus'],
  [`${OP}UpdateNexusEndpoint`]: ['nexus'],
  [`${OP}DeleteNexusEndpoint`]: ['nexus'],
  [`${WF}RegisterNamespace`]: ['namespace'],
  [`${WF}UpdateNamespace`]: ['namespace'],
  [`${OP}DeleteNamespace`]: ['namespace'],
  [`${OP}AddSearchAttributes`]: ['searchAttribute'],
  [`${OP}RemoveSearchAttributes`]: ['searchAttribute'],
};

/** True when the console knows `method` as a write (or admin) call. */
export const isMutating = (method: string): boolean => method in ACTIONS;

/**
 * Write actions `method` needs with this request; empty for reads. Batch
 * operations add their kind, and a schedule trigger or backfill also starts
 * a workflow, as on the server.
 */
export function methodActions(method: string, request: unknown): WriteAction[] {
  const base = ACTIONS[method];
  if (!base) return [];
  const out = [...base];
  if (method === `${WF}StartBatchOperation`) {
    if (fieldAt(request, 'terminationOperation') !== undefined) out.push('terminate');
    if (fieldAt(request, 'cancellationOperation') !== undefined) out.push('cancel');
    if (fieldAt(request, 'resetOperation') !== undefined) out.push('reset');
    if (fieldAt(request, 'deletionOperation') !== undefined) out.push('batchDelete');
  }
  if (method === `${WF}PatchSchedule`) {
    const backfill = fieldAt(request, 'patch.backfillRequest');
    if (fieldAt(request, 'patch.triggerImmediately') !== undefined || (Array.isArray(backfill) && backfill.length > 0)) out.push('start');
  }
  return out;
}

export interface ConfirmSpec {
  /** What the user must type; empty when the request names no target. */
  target: string;
  /** Shown as "Type X to confirm {what}". */
  what: string;
}

/**
 * The typed confirmation a destructive call needs, or null. Terminate,
 * workflow delete, batch terminate/delete, namespace delete and search
 * attribute removal are confirmed by the server; stopping a batch and
 * deleting a schedule are confirmed here only, as the UI's dialogs do.
 */
export function confirmFor(method: string, request: unknown): ConfirmSpec | null {
  switch (method) {
    case `${WF}TerminateWorkflowExecution`:
    case `${WF}DeleteWorkflowExecution`:
      return { target: text(request, 'workflowExecution.workflowId'), what: 'the workflow ID' };
    case `${WF}StartBatchOperation`:
      if (fieldAt(request, 'terminationOperation') === undefined && fieldAt(request, 'deletionOperation') === undefined) return null;
      return { target: text(request, 'jobId'), what: 'the batch job ID' };
    case `${WF}StopBatchOperation`:
      return { target: text(request, 'jobId'), what: 'the batch job ID' };
    case `${WF}DeleteSchedule`:
      return { target: text(request, 'scheduleId'), what: 'the schedule ID' };
    case `${OP}DeleteNamespace`:
      return { target: text(request, 'namespace'), what: 'the namespace name' };
    case `${OP}RemoveSearchAttributes`: {
      const names = fieldAt(request, 'searchAttributes');
      const list = Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [];
      return { target: list.join(','), what: list.length === 1 ? 'the attribute name' : 'the attribute names' };
    }
    default:
      return null;
  }
}

/** Methods whose request has no reason field; the server wants `X-Tempolens-Reason`. */
export const needsReasonHeader = (method: string): boolean => method === `${WF}DeleteWorkflowExecution`;

/** Methods without a namespace field. */
const UNSCOPED = new Set([`${WF}ListNamespaces`, `${WF}GetClusterInfo`, `${WF}GetSystemInfo`, `${OP}ListClusters`, `${OP}ListNexusEndpoints`, `${OP}GetNexusEndpoint`]);

const exec = { workflowId: '', runId: '' };

/** Required fields beyond the namespace, per method, for the raw-mode template. */
const TEMPLATE: Record<string, Json> = {
  DescribeWorkflowExecution: { execution: exec },
  GetWorkflowExecutionHistory: { execution: exec },
  GetWorkflowExecutionHistoryReverse: { execution: exec },
  ListWorkflowExecutions: { query: '' },
  CountWorkflowExecutions: { query: '' },
  QueryWorkflow: { execution: exec, query: { queryType: '__stack_trace' } },
  StartWorkflowExecution: { workflowId: '', workflowType: { name: '' }, taskQueue: { name: '' } },
  SignalWorkflowExecution: { workflowExecution: exec, signalName: '' },
  UpdateWorkflowExecution: {
    workflowExecution: exec,
    waitPolicy: { lifecycleStage: 'UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_COMPLETED' },
    request: { meta: { updateId: '' }, input: { name: '' } },
  },
  RequestCancelWorkflowExecution: { workflowExecution: exec },
  TerminateWorkflowExecution: { workflowExecution: exec, reason: '' },
  DeleteWorkflowExecution: { workflowExecution: exec },
  ResetWorkflowExecution: { workflowExecution: exec, workflowTaskFinishEventId: '', reason: '' },
  DescribeTaskQueue: { taskQueue: { name: '', kind: 'TASK_QUEUE_KIND_NORMAL' }, taskQueueType: 'TASK_QUEUE_TYPE_WORKFLOW' },
  ListTaskQueuePartitions: { taskQueue: { name: '', kind: 'TASK_QUEUE_KIND_NORMAL' } },
  DescribeSchedule: { scheduleId: '' },
  DeleteSchedule: { scheduleId: '' },
  PatchSchedule: { scheduleId: '', patch: { triggerImmediately: {} } },
  CreateSchedule: { scheduleId: '', schedule: { spec: { interval: [{ interval: '3600s' }] }, action: { startWorkflow: { workflowId: '', workflowType: { name: '' }, taskQueue: { name: '' } } } } },
  UpdateSchedule: { scheduleId: '', schedule: {} },
  DescribeBatchOperation: { jobId: '' },
  StopBatchOperation: { jobId: '', reason: '' },
  StartBatchOperation: { jobId: '', visibilityQuery: '', reason: '', cancellationOperation: {} },
  RegisterNamespace: { workflowExecutionRetentionPeriod: '259200s' },
  UpdateNamespace: { updateInfo: { description: '' } },
  AddSearchAttributes: { searchAttributes: { CustomKeywordField: 'INDEXED_VALUE_TYPE_KEYWORD' } },
  RemoveSearchAttributes: { searchAttributes: [] },
};

/** A minimal request for `method`: the namespace (unless unscoped) and its required IDs. */
export function template(method: string, namespace: string, namespaceScoped?: boolean): Json {
  const scoped = namespaceScoped ?? !UNSCOPED.has(method);
  return { ...(scoped ? { namespace } : {}), ...structuredClone(TEMPLATE[shortName(method)] ?? {}) };
}

export interface MethodInfo {
  /** Full gRPC path. */
  method: string;
  name: string;
  service: 'WorkflowService' | 'OperatorService';
  /** The server's class when it reports one. */
  class?: 'READ' | 'WRITE' | 'ADMIN';
  namespaceScoped?: boolean;
}

const CLASSES = new Set(['READ', 'WRITE', 'ADMIN']);

function toMethodInfo(item: unknown): MethodInfo | null {
  const o = isObj(item) ? item : null;
  const raw = typeof item === 'string' ? item : o && typeof o.method === 'string' ? o.method : o && typeof o.name === 'string' ? o.name : null;
  if (!raw) return null;
  const method = raw.startsWith('/') ? raw : raw.includes('.') ? `/${raw}` : null;
  if (!method) return null;
  const service = method.startsWith(WF) ? 'WorkflowService' : method.startsWith(OP) ? 'OperatorService' : null;
  if (!service) return null;
  const cls = o && typeof o.class === 'string' && CLASSES.has(o.class.toUpperCase()) ? (o.class.toUpperCase() as MethodInfo['class']) : undefined;
  return {
    method,
    name: shortName(method),
    service,
    ...(cls ? { class: cls } : {}),
    ...(o && typeof o.namespaceScoped === 'boolean' ? { namespaceScoped: o.namespaceScoped } : {}),
  };
}

/**
 * Validates the `/api/x/console/methods` body: a list (or `{methods}`) of
 * full method paths or `{method, class?, namespaceScoped?}` objects. Entries
 * outside WorkflowService and OperatorService are dropped. Sorted by service, then name.
 */
export function parseMethods(raw: unknown): MethodInfo[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.methods) ? raw.methods : null;
  if (!list) throw new Error('The method list has an unexpected shape.');
  const seen = new Set<string>();
  const out: MethodInfo[] = [];
  for (const item of list) {
    const m = toMethodInfo(item);
    if (m && !seen.has(m.method)) {
      seen.add(m.method);
      out.push(m);
    }
  }
  return out.sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name));
}

/** True when the method mutates state, by the server's class when known, else the console's table. */
export const methodMutates = (m: MethodInfo): boolean => (m.class ? m.class !== 'READ' : isMutating(m.method));
