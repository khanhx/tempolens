// Pure Gantt layout: history groups (or list rows) → bars on a time axis.
import type { Category, EventGroup, GroupStatus } from '../lib/history/groups';
import type { HistoryEvent, PendingActivity, WorkflowExecutionInfo } from '../lib/temporal';
import { CLOSE_EVENT_TYPES, eventAttributes, shortEventType, statusInfo } from '../lib/temporal';
import { parseTimestamp } from '../lib/time';

export type BarTone = 'running' | 'completed' | 'failed' | 'canceled' | 'terminated' | 'timedout' | 'continued' | 'unknown';

export interface ChildRef {
  namespace?: string;
  workflowId: string;
  runId: string;
}

export interface Bar {
  id: string;
  label: string;
  /** Lane: `workflow` for whole-run rows, else the group category. */
  lane: 'workflow' | Category;
  start: number;
  end: number;
  /** Still running: `end` is "now" and moves. */
  open: boolean;
  tone: BarTone;
  /** A single instant (signal received, marker), drawn as a diamond. */
  point?: boolean;
  /** For an activity: when its last attempt started; before that it was scheduled or retrying. */
  lastStart?: number;
  attempts?: number;
  /** Event to open on click. */
  eventId?: string;
  /** A child workflow that can be expanded. */
  child?: ChildRef;
  /** Link target for whole-run bars. */
  run?: { namespace: string; workflowId: string; runId: string };
  depth: number;
}

export const MAX_BARS = 2000;

const ms = (e: HistoryEvent | undefined) => parseTimestamp(e?.eventTime)?.getTime() ?? null;

const GROUP_TONE: Record<GroupStatus, BarTone> = {
  completed: 'completed',
  failed: 'failed',
  'timed-out': 'timedout',
  canceled: 'canceled',
  terminated: 'terminated',
  pending: 'running',
};

/** Tone for a workflow status enum name. */
export function statusTone(status: string | undefined): BarTone {
  return (statusInfo(status)?.css as BarTone | undefined) ?? 'unknown';
}

const POINT_TYPES = new Set(['WorkflowExecutionSignaled', 'MarkerRecorded', 'UpsertWorkflowSearchAttributes', 'WorkflowPropertiesModified', 'WorkflowExecutionCancelRequested']);

export interface RunBarsOptions {
  now: number;
  /** Show workflow tasks as a thin lane. */
  workflowTasks?: boolean;
  pendingActivities?: readonly PendingActivity[];
  /** Workflow status enum, for the whole-run bar. */
  runStatus?: string;
  depth?: number;
  idPrefix?: string;
}

/**
 * Bars for one run: a whole-run bar, then one bar per activity, timer, child,
 * update, Nexus operation or external request, and points for signals and
 * markers. Open items end at `now`. At most MAX_BARS bars are returned.
 */
export function runBars(events: readonly HistoryEvent[], groups: readonly EventGroup[], opts: RunBarsOptions): { bars: Bar[]; truncated: boolean } {
  const { now, depth = 0, idPrefix = '' } = opts;
  const bars: Bar[] = [];
  const first = ms(events[0]);
  if (first !== null) {
    const last = events[events.length - 1];
    const closed = last && CLOSE_EVENT_TYPES.has(last.eventType) ? ms(last) : null;
    bars.push({
      id: `${idPrefix}run`,
      label: 'Workflow run',
      lane: 'workflow',
      start: first,
      end: closed ?? now,
      open: closed === null,
      tone: closed === null ? 'running' : statusTone(opts.runStatus),
      depth,
      eventId: '1',
    });
  }
  const pendingById = new Map((opts.pendingActivities ?? []).filter((p) => p.activityId).map((p) => [p.activityId as string, p]));

  for (const g of groups) {
    if (g.category === 'workflow') continue;
    if (g.category === 'workflow-task' && !opts.workflowTasks) continue;
    const firstEvent = g.events[0];
    const lastEvent = g.events[g.events.length - 1];
    const start = ms(firstEvent);
    if (start === null || !firstEvent || !lastEvent) continue;
    const single = g.events.length === 1 && POINT_TYPES.has(shortEventType(firstEvent.eventType));
    const open = g.status === 'pending';
    const bar: Bar = {
      id: `${idPrefix}g${g.id}`,
      label: g.name,
      lane: g.category,
      start,
      end: open ? Math.max(now, start) : (ms(lastEvent) ?? start),
      open,
      tone: GROUP_TONE[g.status],
      depth,
      eventId: lastEvent.eventId,
      ...(single ? { point: true, end: start, open: false } : {}),
    };
    if (g.category === 'activity' || g.category === 'nexus') {
      const startedEvents = g.events.filter((e) => /TaskStarted$|OperationStarted$/.test(shortEventType(e.eventType)));
      const started = ms(startedEvents[startedEvents.length - 1]);
      if (started !== null && started > start) bar.lastStart = started;
      if (g.attempt) bar.attempts = g.attempt;
      const activityId = eventAttributes(firstEvent).activityId;
      const p = typeof activityId === 'string' ? pendingById.get(activityId) : undefined;
      if (p) {
        if (p.attempt) bar.attempts = p.attempt;
        const ls = parseTimestamp(p.lastStartedTime)?.getTime();
        if (ls && ls > start) bar.lastStart = ls;
      }
    }
    if (g.category === 'child-workflow') {
      const startedEvent = g.events.find((e) => shortEventType(e.eventType) === 'ChildWorkflowExecutionStarted');
      const exec = startedEvent ? (eventAttributes(startedEvent).workflowExecution as { workflowId?: string; runId?: string } | undefined) : undefined;
      if (exec?.workflowId && exec.runId) {
        const ns = eventAttributes(firstEvent).namespace;
        bar.child = { workflowId: exec.workflowId, runId: exec.runId, namespace: typeof ns === 'string' && ns ? ns : undefined };
        bar.label = `${g.name} · ${exec.workflowId}`;
      }
    }
    bars.push(bar);
  }

  const sorted = bars.sort((a, b) => (a.lane === 'workflow' ? -1 : b.lane === 'workflow' ? 1 : a.start - b.start || a.id.localeCompare(b.id)));
  return { bars: sorted.slice(0, MAX_BARS), truncated: sorted.length > MAX_BARS };
}

/** One bar per listed workflow, start to close (or now); the namespace prefixes the label in the cross view. */
export function workflowBars(rows: readonly (WorkflowExecutionInfo & { tlNamespace?: string })[], now: number, fallbackNamespace: string, withNamespace: boolean): Bar[] {
  const bars: Bar[] = [];
  for (const r of rows) {
    const start = parseTimestamp(r.startTime)?.getTime();
    if (start === undefined) continue;
    const close = parseTimestamp(r.closeTime)?.getTime() ?? null;
    const ns = r.tlNamespace ?? fallbackNamespace;
    bars.push({
      id: `${ns}/${r.execution.workflowId}/${r.execution.runId ?? ''}`,
      label: `${withNamespace ? `${ns} / ` : ''}${r.execution.workflowId}`,
      lane: 'workflow',
      start,
      end: close ?? Math.max(now, start),
      open: close === null,
      tone: statusTone(r.status),
      depth: 0,
      run: { namespace: ns, workflowId: r.execution.workflowId, runId: r.execution.runId ?? '' },
    });
  }
  return bars.slice(0, MAX_BARS);
}

export interface TimeView {
  start: number;
  end: number;
}

const MIN_SPAN = 10;

/** A view covering every bar with a small margin. */
export function fullView(bars: readonly Bar[], now: number): TimeView {
  if (bars.length === 0) return { start: now - 60_000, end: now };
  const start = Math.min(...bars.map((b) => b.start));
  const end = Math.max(...bars.map((b) => b.end));
  const span = Math.max(end - start, 1000);
  return { start: start - span * 0.01, end: start + span * 1.03 };
}

export function timeToX(t: number, view: TimeView, width: number): number {
  return ((t - view.start) / Math.max(view.end - view.start, MIN_SPAN)) * width;
}

/** Zooms by `factor` (>1 zooms in) around `center`. */
export function zoomView(view: TimeView, factor: number, center = (view.start + view.end) / 2): TimeView {
  const span = Math.max((view.end - view.start) / factor, MIN_SPAN);
  const ratio = (center - view.start) / Math.max(view.end - view.start, MIN_SPAN);
  const start = center - span * ratio;
  return { start, end: start + span };
}

/** Moves the view by a fraction of its width (negative = earlier). */
export function panView(view: TimeView, fraction: number): TimeView {
  const d = (view.end - view.start) * fraction;
  return { start: view.start + d, end: view.end + d };
}

const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000, 172_800_000, 604_800_000];

/** Round tick times inside the view, at most `max` of them. */
export function ticks(view: TimeView, max = 8): number[] {
  const span = view.end - view.start;
  const step = STEPS.find((s) => span / s <= max) ?? Math.ceil(span / max / 86_400_000) * 86_400_000;
  const out: number[] = [];
  for (let t = Math.ceil(view.start / step) * step; t <= view.end && out.length <= max; t += step) out.push(t);
  return out;
}

export interface TraceNode {
  id: string;
  namespace: string;
  workflowId: string;
  runId: string;
  workflowType: string;
  status: string;
  startTime: string | null;
  closeTime: string | null;
  root: boolean;
}

/**
 * A trace (as `temporal workflow trace`): the run tree as Gantt rows, in
 * depth-first order from the root over child and continue-as-new edges,
 * indented by depth. Nodes outside the tree (signal partners) follow at depth 0.
 */
export function traceBars(nodes: readonly TraceNode[], edges: readonly { from: string; to: string; kind: string }[], now: number): Bar[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== 'child' && e.kind !== 'continuedAsNew') continue;
    kids.set(e.from, [...(kids.get(e.from) ?? []), e.to]);
  }
  const startOf = (id: string) => parseTimestamp(byId.get(id)?.startTime)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const order: [string, number][] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (seen.has(id) || !byId.has(id)) return;
    seen.add(id);
    order.push([id, depth]);
    for (const k of [...(kids.get(id) ?? [])].sort((a, b) => startOf(a) - startOf(b))) visit(k, depth + 1);
  };
  const root = nodes.find((n) => n.root);
  if (root) visit(root.id, 0);
  for (const n of [...nodes].sort((a, b) => startOf(a.id) - startOf(b.id))) visit(n.id, 0);

  const bars: Bar[] = [];
  for (const [id, depth] of order) {
    const n = byId.get(id);
    const start = parseTimestamp(n?.startTime)?.getTime();
    if (!n || start === undefined) continue;
    const close = parseTimestamp(n.closeTime)?.getTime() ?? null;
    bars.push({
      id,
      label: `${n.workflowType || 'unknown'} · ${n.workflowId}`,
      lane: 'workflow',
      start,
      end: close ?? Math.max(now, start),
      open: close === null,
      tone: statusTone(n.status),
      depth,
      run: n.runId ? { namespace: n.namespace, workflowId: n.workflowId, runId: n.runId } : undefined,
    });
  }
  return bars;
}
