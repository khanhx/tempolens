// Event grouping: an activity's scheduled/started/completed events, a
// timer's started/fired, a child's initiated/started/closed, and so on form
// one group, keyed by the id of the event that opened it.
import type { Failure, HistoryEvent } from '../temporal';
import { eventAttributes, shortEventType } from '../temporal';

export const CATEGORIES = [
  { id: 'workflow', label: 'Workflow' },
  { id: 'workflow-task', label: 'Workflow task' },
  { id: 'activity', label: 'Activity' },
  { id: 'timer', label: 'Timer' },
  { id: 'child-workflow', label: 'Child workflow' },
  { id: 'signal', label: 'Signal' },
  { id: 'update', label: 'Update' },
  { id: 'external', label: 'External cancel' },
  { id: 'nexus', label: 'Nexus' },
  { id: 'marker', label: 'Marker' },
] as const;

export type Category = (typeof CATEGORIES)[number]['id'];

export type GroupStatus = 'completed' | 'failed' | 'timed-out' | 'canceled' | 'terminated' | 'pending';

export const GROUP_STATUSES: readonly GroupStatus[] = ['completed', 'failed', 'timed-out', 'canceled', 'terminated', 'pending'];

export function categoryOf(eventType: string): Category {
  const t = shortEventType(eventType);
  if (t.startsWith('WorkflowTask')) return 'workflow-task';
  if (t.startsWith('ActivityTask')) return 'activity';
  if (t.startsWith('Timer')) return 'timer';
  if (t.startsWith('StartChildWorkflow') || t.startsWith('ChildWorkflow')) return 'child-workflow';
  if (t.startsWith('WorkflowExecutionUpdate')) return 'update';
  if (t === 'WorkflowExecutionSignaled' || t.startsWith('SignalExternal') || t === 'ExternalWorkflowExecutionSignaled') return 'signal';
  if (t.startsWith('RequestCancelExternal') || t === 'ExternalWorkflowExecutionCancelRequested') return 'external';
  if (t.startsWith('Nexus')) return 'nexus';
  if (t === 'MarkerRecorded') return 'marker';
  return 'workflow';
}

/** Events that leave their group open. */
const OPEN_TYPES = new Set([
  'ActivityTaskScheduled',
  'ActivityTaskStarted',
  'ActivityTaskCancelRequested',
  'TimerStarted',
  'StartChildWorkflowExecutionInitiated',
  'ChildWorkflowExecutionStarted',
  'SignalExternalWorkflowExecutionInitiated',
  'RequestCancelExternalWorkflowExecutionInitiated',
  'WorkflowTaskScheduled',
  'WorkflowTaskStarted',
  'NexusOperationScheduled',
  'NexusOperationStarted',
  'NexusOperationCancelRequested',
  'WorkflowExecutionUpdateAdmitted',
  'WorkflowExecutionUpdateAccepted',
]);

export function eventStatus(eventType: string): GroupStatus {
  const t = shortEventType(eventType);
  if (OPEN_TYPES.has(t)) return 'pending';
  if (t.endsWith('Failed') || t.endsWith('Rejected')) return 'failed';
  if (t.endsWith('TimedOut')) return 'timed-out';
  if (t.endsWith('Canceled')) return 'canceled';
  if (t.endsWith('Terminated')) return 'terminated';
  return 'completed';
}

/** Fields that point at the event that opened the group, in priority order. */
const LINK_FIELDS = ['scheduledEventId', 'initiatedEventId', 'acceptedEventId', 'startedEventId'] as const;

export function groupKey(event: HistoryEvent): string {
  const attrs = eventAttributes(event);
  for (const f of LINK_FIELDS) {
    const v = attrs[f];
    if ((typeof v === 'string' || typeof v === 'number') && String(v) !== '0') return String(v);
  }
  return event.eventId;
}

export interface EventGroup {
  /** Id of the opening event. */
  id: string;
  category: Category;
  /** Activity type, timer id, child workflow type, signal or update name. */
  name: string;
  events: HistoryEvent[];
  status: GroupStatus;
  /** Latest attempt seen on an ActivityTaskStarted event. */
  attempt?: number;
  failure?: Failure;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const nameOf = (v: unknown) => (v && typeof v === 'object' ? str((v as { name?: unknown }).name) : '');

function groupName(first: HistoryEvent): string {
  const a = eventAttributes(first);
  const t = shortEventType(first.eventType);
  return (
    nameOf(a.activityType) ||
    nameOf(a.workflowType) ||
    str(a.timerId) ||
    str(a.signalName) ||
    str(a.markerName) ||
    str(a.operation) ||
    nameOf((a.acceptedRequest as { input?: unknown } | undefined)?.input) ||
    t
  );
}

/** Groups events in eventId order of their opening event. */
export function buildGroups(events: readonly HistoryEvent[]): EventGroup[] {
  const byKey = new Map<string, EventGroup>();
  for (const event of events) {
    const key = groupKey(event);
    let g = byKey.get(key);
    if (!g) {
      g = { id: key, category: categoryOf(event.eventType), name: '', events: [], status: 'pending' };
      byKey.set(key, g);
    }
    g.events.push(event);
    const attrs = eventAttributes(event);
    if (typeof attrs.attempt === 'number') g.attempt = attrs.attempt;
    if (attrs.failure && typeof attrs.failure === 'object') g.failure = attrs.failure as Failure;
  }
  for (const g of byKey.values()) {
    const first = g.events[0];
    const last = g.events[g.events.length - 1];
    if (first) g.name = groupName(first);
    if (last) g.status = eventStatus(last.eventType);
  }
  return [...byKey.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

export function groupIndex(groups: readonly EventGroup[]): Map<string, EventGroup> {
  const index = new Map<string, EventGroup>();
  for (const g of groups) for (const e of g.events) index.set(e.eventId, g);
  return index;
}
