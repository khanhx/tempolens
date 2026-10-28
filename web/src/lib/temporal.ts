// Shapes of the upstream /api/v1 JSON (grpc-gateway, lowerCamel, int64 as
// strings). Only the fields the UI reads are typed; everything else stays
// reachable through the index signatures.
import type { Payload } from './payload/decode';

export interface Execution {
  workflowId: string;
  runId?: string;
}

export interface Payloads {
  payloads?: Payload[];
}

export interface WorkflowExecutionInfo {
  execution: Execution;
  type?: { name?: string };
  startTime?: string;
  closeTime?: string;
  executionTime?: string;
  status?: string;
  historyLength?: string;
  historySizeBytes?: string;
  stateTransitionCount?: string;
  executionDuration?: string;
  taskQueue?: string;
  parentNamespaceId?: string;
  parentExecution?: Execution;
  rootExecution?: Execution;
  memo?: { fields?: Record<string, Payload> };
  searchAttributes?: { indexedFields?: Record<string, Payload> };
  firstRunId?: string;
  [key: string]: unknown;
}

export interface PendingActivity {
  activityId?: string;
  activityType?: { name?: string };
  state?: string;
  attempt?: number;
  maximumAttempts?: number;
  scheduledTime?: string;
  lastStartedTime?: string;
  lastHeartbeatTime?: string;
  expirationTime?: string;
  lastFailure?: Failure;
  heartbeatDetails?: Payloads;
  lastWorkerIdentity?: string;
  [key: string]: unknown;
}

export interface DescribeWorkflowResponse {
  executionConfig?: {
    taskQueue?: { name?: string; kind?: string };
    workflowExecutionTimeout?: string;
    workflowRunTimeout?: string;
    defaultWorkflowTaskTimeout?: string;
    userMetadata?: { summary?: Payload; details?: Payload };
  };
  workflowExecutionInfo?: WorkflowExecutionInfo;
  pendingActivities?: PendingActivity[];
  pendingChildren?: { workflowId?: string; runId?: string; workflowTypeName?: string; initiatedId?: string }[];
  pendingWorkflowTask?: Record<string, unknown>;
  callbacks?: unknown[];
  [key: string]: unknown;
}

export interface Failure {
  message?: string;
  source?: string;
  stackTrace?: string;
  cause?: Failure;
  [key: string]: unknown;
}

export interface HistoryEvent {
  eventId: string;
  eventTime?: string;
  eventType: string;
  taskId?: string;
  [key: string]: unknown;
}

export interface Poller {
  identity?: string;
  lastAccessTime?: string;
  ratePerSecond?: number;
  workerVersionCapabilities?: { buildId?: string };
}

/** Workflow statuses: API enum name, visibility query value, label, CSS suffix. */
export const STATUSES = [
  { name: 'WORKFLOW_EXECUTION_STATUS_RUNNING', value: 'Running', label: 'Running', css: 'running' },
  { name: 'WORKFLOW_EXECUTION_STATUS_COMPLETED', value: 'Completed', label: 'Completed', css: 'completed' },
  { name: 'WORKFLOW_EXECUTION_STATUS_FAILED', value: 'Failed', label: 'Failed', css: 'failed' },
  { name: 'WORKFLOW_EXECUTION_STATUS_CANCELED', value: 'Canceled', label: 'Canceled', css: 'canceled' },
  { name: 'WORKFLOW_EXECUTION_STATUS_TERMINATED', value: 'Terminated', label: 'Terminated', css: 'terminated' },
  {
    name: 'WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW',
    value: 'ContinuedAsNew',
    label: 'Continued as new',
    css: 'continued',
  },
  { name: 'WORKFLOW_EXECUTION_STATUS_TIMED_OUT', value: 'TimedOut', label: 'Timed out', css: 'timedout' },
] as const;

export type StatusInfo = (typeof STATUSES)[number];

export function statusInfo(nameOrValue: string | undefined): StatusInfo | undefined {
  return STATUSES.find((s) => s.name === nameOrValue || s.value === nameOrValue);
}

export const isRunning = (status: string | undefined) => status === 'WORKFLOW_EXECUTION_STATUS_RUNNING';

/** `EVENT_TYPE_ACTIVITY_TASK_FAILED` → `ActivityTaskFailed`. */
export function shortEventType(eventType: string): string {
  return eventType
    .replace(/^EVENT_TYPE_/, '')
    .toLowerCase()
    .replace(/(^|_)([a-z])/g, (_m, _s, c: string) => c.toUpperCase());
}

/** The `*EventAttributes` object of an event, or an empty object. */
export function eventAttributes(event: HistoryEvent): Record<string, unknown> {
  for (const [key, value] of Object.entries(event)) {
    if (key.endsWith('EventAttributes') && value && typeof value === 'object') return value as Record<string, unknown>;
  }
  return {};
}

/** Failure messages from the outermost failure down its cause chain. */
export function failureMessages(failure: Failure | undefined): string[] {
  const out: string[] = [];
  for (let f = failure, depth = 0; f && depth < 20; f = f.cause, depth++) {
    if (f.message) out.push(f.message);
  }
  return out;
}

/** Event types that close a run. */
export const CLOSE_EVENT_TYPES = new Set([
  'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED',
  'EVENT_TYPE_WORKFLOW_EXECUTION_FAILED',
  'EVENT_TYPE_WORKFLOW_EXECUTION_TIMED_OUT',
  'EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED',
  'EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED',
  'EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW',
]);
