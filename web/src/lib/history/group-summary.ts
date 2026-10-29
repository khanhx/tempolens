// Compact summary of an event group for the history detail panel: the
// identifying fields, one time per event, the payloads and the failure,
// read from whichever event of the group carries them.
import type { Failure, PendingActivity } from '../temporal';
import { eventAttributes, shortEventType } from '../temporal';
import { durationBetween, formatDuration, parseDuration } from '../time';
import type { EventGroup } from './groups';

export interface SummaryField {
  label: string;
  value: string;
}

export interface SummaryTime {
  /** Phase of the group, e.g. `Scheduled`, `Fired`. */
  label: string;
  eventId: string;
  time?: string;
}

export interface SummaryPayload {
  label: string;
  value: unknown;
}

export interface GroupSummary {
  fields: SummaryField[];
  times: SummaryTime[];
  /** First to last event; null for a single event. */
  durationMs: number | null;
  payloads: SummaryPayload[];
  failure?: Failure;
}

type Attrs = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : '');
const obj = (v: unknown): Attrs | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Attrs) : undefined);

/** `a.b.c` read from nested objects. */
function at(attrs: Attrs, path: string): unknown {
  let v: unknown = attrs;
  for (const key of path.split('.')) v = obj(v)?.[key];
  return v;
}

/** A protobuf duration as `1m 30s`; zero and unset durations mean "none". */
function durationText(v: unknown): string {
  const ms = parseDuration(str(v));
  return ms ? formatDuration(ms) : '';
}

/** `RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED` as `maximum attempts reached`. */
function enumText(v: unknown, prefix: string): string {
  const s = str(v);
  if (!s || /(^|_)UNSPECIFIED$/.test(s)) return '';
  return (s.startsWith(prefix) ? s.slice(prefix.length) : s).toLowerCase().replaceAll('_', ' ');
}

export function retryPolicyText(v: unknown): string {
  const p = obj(v);
  if (!p) return '';
  const max = Number(p.maximumAttempts ?? 0);
  const nonRetryable = Array.isArray(p.nonRetryableErrorTypes) ? p.nonRetryableErrorTypes.map(str).filter(Boolean) : [];
  return [
    max > 0 ? `max ${max} attempt${max === 1 ? '' : 's'}` : 'unlimited attempts',
    durationText(p.initialInterval) && `initial ${durationText(p.initialInterval)}`,
    p.backoffCoefficient !== undefined && `backoff ${str(p.backoffCoefficient)}`,
    durationText(p.maximumInterval) && `max interval ${durationText(p.maximumInterval)}`,
    nonRetryable.length > 0 && `non-retryable: ${nonRetryable.join(', ')}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Summary fields in display order. `pick` chooses which event wins when
 * several carry the field: the first (where the group was opened) or the
 * last (the latest attempt or worker).
 */
const FIELDS: { label: string; paths: string[]; pick?: 'last'; format?: (v: unknown) => string }[] = [
  { label: 'Activity type', paths: ['activityType.name'] },
  { label: 'Activity ID', paths: ['activityId'] },
  { label: 'Workflow type', paths: ['workflowType.name'] },
  { label: 'Workflow ID', paths: ['workflowId', 'workflowExecution.workflowId'] },
  { label: 'Run ID', paths: ['workflowExecution.runId'], pick: 'last' },
  { label: 'Timer ID', paths: ['timerId'] },
  { label: 'Signal', paths: ['signalName'] },
  { label: 'Update', paths: ['acceptedRequest.input.name', 'request.input.name', 'rejectedRequest.input.name'] },
  { label: 'Update ID', paths: ['acceptedRequest.meta.updateId', 'request.meta.updateId', 'rejectedRequest.meta.updateId', 'meta.updateId', 'protocolInstanceId'] },
  { label: 'Marker', paths: ['markerName'] },
  { label: 'Endpoint', paths: ['endpoint'] },
  { label: 'Service', paths: ['service'] },
  { label: 'Operation', paths: ['operation'] },
  { label: 'Namespace', paths: ['namespace'] },
  { label: 'Task queue', paths: ['taskQueue.name'] },
  { label: 'Attempt', paths: ['attempt'], pick: 'last' },
  { label: 'Retry policy', paths: ['retryPolicy'], format: retryPolicyText },
  { label: 'Start to fire', paths: ['startToFireTimeout'], format: durationText },
  { label: 'Schedule to close', paths: ['scheduleToCloseTimeout'], format: durationText },
  { label: 'Schedule to start', paths: ['scheduleToStartTimeout'], format: durationText },
  { label: 'Start to close', paths: ['startToCloseTimeout'], format: durationText },
  { label: 'Heartbeat timeout', paths: ['heartbeatTimeout'], format: durationText },
  { label: 'Run timeout', paths: ['workflowRunTimeout'], format: durationText },
  { label: 'Execution timeout', paths: ['workflowExecutionTimeout'], format: durationText },
  { label: 'Worker', paths: ['identity'], pick: 'last' },
  { label: 'Timeout type', paths: ['timeoutType'], pick: 'last', format: (v) => enumText(v, 'TIMEOUT_TYPE_') },
  { label: 'Retry state', paths: ['retryState'], pick: 'last', format: (v) => enumText(v, 'RETRY_STATE_') },
  { label: 'Cause', paths: ['cause'], pick: 'last', format: (v) => enumText(str(v).replace(/^.*_CAUSE_/, ''), '') },
  { label: 'Reason', paths: ['reason'], pick: 'last' },
];

/** Payloads in display order; the first event carrying one wins unless `pick` is `last`. */
const PAYLOADS: { label: string; paths: string[]; pick?: 'last' }[] = [
  { label: 'Input', paths: ['input', 'acceptedRequest.input.args', 'request.input.args'] },
  { label: 'Result', paths: ['result', 'outcome.success'], pick: 'last' },
  { label: 'Details', paths: ['details'], pick: 'last' },
];

/** Event type prefixes that name the group; what is left names the phase. */
const PHASE_PREFIXES = [
  'StartChildWorkflowExecution',
  'ChildWorkflowExecution',
  'SignalExternalWorkflowExecution',
  'RequestCancelExternalWorkflowExecution',
  'ExternalWorkflowExecution',
  'WorkflowExecutionUpdate',
  'WorkflowExecution',
  'WorkflowTask',
  'ActivityTask',
  'NexusOperation',
  'Timer',
];

export function phaseLabel(eventType: string): string {
  const t = shortEventType(eventType);
  const prefix = PHASE_PREFIXES.find((p) => t.startsWith(p) && t.length > p.length);
  return prefix ? t.slice(prefix.length).replace(/([a-z])([A-Z])/g, '$1 $2') : t;
}

function lastHeartbeat(failure: Failure | undefined): unknown {
  for (let f = failure, depth = 0; f && depth < 20; f = f.cause, depth++) {
    const details = at(f, 'timeoutFailureInfo.lastHeartbeatDetails');
    if (details !== undefined) return details;
  }
  return undefined;
}

/**
 * Summarizes `group`. `pending` is the activity's entry in
 * DescribeWorkflowExecution, when it is still pending: its heartbeat
 * details and current attempt are newer than the history.
 */
export function summarizeGroup(group: EventGroup, pending?: PendingActivity): GroupSummary {
  const attrs = group.events.map(eventAttributes);
  const find = (paths: string[], pick?: 'last') => {
    const list = pick === 'last' ? [...attrs].reverse() : attrs;
    for (const a of list) {
      for (const p of paths) {
        const v = at(a, p);
        if (v !== undefined && v !== null && v !== '') return v;
      }
    }
    return undefined;
  };

  const fields: SummaryField[] = [];
  for (const f of FIELDS) {
    const v = f.label === 'Attempt' && pending?.attempt ? pending.attempt : find(f.paths, f.pick);
    const value = f.format ? f.format(v) : str(v);
    if (value) fields.push({ label: f.label, value });
  }

  const payloads: SummaryPayload[] = [];
  for (const p of PAYLOADS) {
    const v = find(p.paths, p.pick);
    if (v !== undefined) payloads.push({ label: p.label, value: v });
  }
  const failure = group.failure ?? (obj(find(['outcome.failure'], 'last')) as Failure | undefined);
  const heartbeat = pending?.heartbeatDetails ?? lastHeartbeat(failure);
  if (heartbeat !== undefined) payloads.push({ label: 'Last heartbeat details', value: heartbeat });

  const first = group.events[0];
  const last = group.events[group.events.length - 1];
  return {
    fields,
    times: group.events.map((e) => ({ label: phaseLabel(e.eventType), eventId: e.eventId, time: e.eventTime })),
    durationMs: group.events.length > 1 ? durationBetween(first?.eventTime, last?.eventTime) : null,
    payloads,
    failure,
  };
}
