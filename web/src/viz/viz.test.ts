import { describe, expect, it } from 'vitest';
import { buildGroups } from '../lib/history/groups';
import type { HistoryEvent } from '../lib/temporal';
import { assignLayers, countCrossings, layoutDag } from './dag-layout';
import type { LayoutEdgeInput } from './dag-layout';
import { fullView, panView, runBars, ticks, timeToX, workflowBars, zoomView } from './gantt-layout';

const T0 = Date.parse('2026-10-27T08:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ev = (id: number, type: string, s: number, attrs: Record<string, unknown> = {}): HistoryEvent => ({
  eventId: String(id),
  eventTime: at(s),
  eventType: 'EVENT_TYPE_' + type.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(),
  [type.charAt(0).toLowerCase() + type.slice(1) + 'EventAttributes']: attrs,
});

describe('gantt layout', () => {
  const events = [
    ev(1, 'WorkflowExecutionStarted', 0),
    ev(2, 'WorkflowTaskScheduled', 0),
    ev(3, 'WorkflowTaskStarted', 1, { scheduledEventId: '2' }),
    ev(4, 'WorkflowTaskCompleted', 1, { scheduledEventId: '2' }),
    ev(5, 'ActivityTaskScheduled', 1, { activityId: '5', activityType: { name: 'Charge' } }),
    ev(6, 'TimerStarted', 1, { timerId: 't1' }),
    ev(7, 'StartChildWorkflowExecutionInitiated', 2, { workflowType: { name: 'Child' }, namespace: 'tui-seed-a' }),
    ev(8, 'ChildWorkflowExecutionStarted', 3, { initiatedEventId: '7', workflowExecution: { workflowId: 'kid', runId: 'kid-run' } }),
    ev(9, 'WorkflowExecutionSignaled', 4, { signalName: 'poke' }),
    ev(10, 'ActivityTaskStarted', 20, { scheduledEventId: '5', attempt: 3 }),
    ev(11, 'ActivityTaskCompleted', 25, { scheduledEventId: '5', startedEventId: '10' }),
    ev(12, 'TimerFired', 31, { startedEventId: '6' }),
    ev(13, 'ActivityTaskScheduled', 32, { activityId: '13', activityType: { name: 'Ship' } }),
  ];
  const now = T0 + 60_000;
  const { bars } = runBars(events, buildGroups(events), { now, runStatus: 'WORKFLOW_EXECUTION_STATUS_RUNNING', pendingActivities: [{ activityId: '13', attempt: 2, lastStartedTime: at(40) }] });
  const byLabel = Object.fromEntries(bars.map((b) => [b.label, b]));

  it('draws an activity with three attempts as a bar with retry markers', () => {
    expect(byLabel.Charge).toMatchObject({ start: T0 + 1000, lastStart: T0 + 20_000, end: T0 + 25_000, attempts: 3, open: false, tone: 'completed' });
  });

  it('extends a pending activity and the running run to now', () => {
    expect(byLabel.Ship).toMatchObject({ open: true, end: now, attempts: 2, lastStart: T0 + 40_000, tone: 'running' });
    expect(bars[0]).toMatchObject({ lane: 'workflow', open: true, end: now, start: T0 });
  });

  it('draws timers, children and signal points', () => {
    expect(byLabel.t1).toMatchObject({ lane: 'timer', start: T0 + 1000, end: T0 + 31_000 });
    expect(byLabel['Child · kid']).toMatchObject({ lane: 'child-workflow', open: true, child: { workflowId: 'kid', runId: 'kid-run', namespace: 'tui-seed-a' } });
    expect(byLabel.poke).toMatchObject({ point: true, start: T0 + 4000, end: T0 + 4000 });
    expect(bars.some((b) => b.lane === 'workflow-task')).toBe(false);
    expect(runBars(events, buildGroups(events), { now, workflowTasks: true }).bars.some((b) => b.lane === 'workflow-task')).toBe(true);
  });

  it('maps time to x monotonically, also after zoom and pan', () => {
    const view = fullView(bars, now);
    for (const v of [view, zoomView(view, 4, T0 + 20_000), panView(zoomView(view, 2), 0.3)]) {
      const xs = [0, 1, 5, 20, 59].map((s) => timeToX(T0 + s * 1000, v, 1000));
      for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1] as number);
    }
    const z = zoomView(view, 4, T0 + 20_000);
    expect(z.end - z.start).toBeCloseTo((view.end - view.start) / 4);
    expect(timeToX(T0 + 20_000, z, 1000)).toBeCloseTo(timeToX(T0 + 20_000, view, 1000));
    const t = ticks(view);
    expect(t.length).toBeGreaterThan(1);
    expect(t.length).toBeLessThanOrEqual(9);
  });

  it('builds one bar per listed run, prefixed with the namespace in the cross view', () => {
    const rows = [
      { execution: { workflowId: 'a', runId: 'r1' }, startTime: at(0), closeTime: at(10), status: 'WORKFLOW_EXECUTION_STATUS_FAILED', tlNamespace: 'ns1' },
      { execution: { workflowId: 'b', runId: 'r2' }, startTime: at(5), status: 'WORKFLOW_EXECUTION_STATUS_RUNNING' },
    ];
    const out = workflowBars(rows, now, 'dflt', true);
    expect(out.map((b) => [b.label, b.tone, b.open])).toEqual([
      ['ns1 / a', 'failed', false],
      ['dflt / b', 'running', true],
    ]);
    expect(out[1]?.end).toBe(now);
  });
});

describe('dag layout', () => {
  it('lays a continue-as-new chain of four runs on four layers', () => {
    const ids = ['r1', 'r2', 'r3', 'r4'];
    const edges: LayoutEdgeInput[] = [
      { from: 'r1', to: 'r2', kind: 'continuedAsNew' },
      { from: 'r2', to: 'r3', kind: 'continuedAsNew' },
      { from: 'r3', to: 'r4', kind: 'continuedAsNew' },
    ];
    const l = layoutDag(ids, edges);
    expect(l.nodes.map((n) => n.layer)).toEqual([0, 1, 2, 3]);
    expect(l.rows).toBe(4);
  });

  it('puts two children in one layer without overlap', () => {
    const l = layoutDag(['p', 'c1', 'c2'], [
      { from: 'p', to: 'c1', kind: 'child' },
      { from: 'p', to: 'c2', kind: 'child' },
    ]);
    const c1 = l.nodes.find((n) => n.id === 'c1');
    const c2 = l.nodes.find((n) => n.id === 'c2');
    expect(c1?.layer).toBe(1);
    expect(c2?.layer).toBe(1);
    expect(c1?.y).toBe(c2?.y);
    expect(c1?.x).not.toBe(c2?.x);
  });

  it('terminates on signal cycles and draws them as overlays', () => {
    const l = layoutDag(['a', 'b'], [
      { from: 'a', to: 'b', kind: 'signal' },
      { from: 'b', to: 'a', kind: 'signal' },
    ]);
    expect(l.nodes).toHaveLength(2);
    expect(l.edges.every((e) => e.overlay)).toBe(true);
    // A cycle in layering edges is also safe.
    expect(assignLayers(['x', 'y'], [{ from: 'x', to: 'y', kind: 'child' }, { from: 'y', to: 'x', kind: 'child' }]).size).toBe(2);
  });

  it('pins the root to the top and inserts dummies for long edges', () => {
    const l = layoutDag(['root', 'mid', 'leaf'], [
      { from: 'root', to: 'mid', kind: 'child' },
      { from: 'mid', to: 'leaf', kind: 'child' },
      { from: 'root', to: 'leaf', kind: 'reset' },
    ], { root: 'root' });
    expect(l.nodes.find((n) => n.id === 'root')?.layer).toBe(0);
    expect(l.nodes.some((n) => n.dummy)).toBe(true);
    expect(l.edges.find((e) => e.kind === 'reset')?.points).toHaveLength(3);
  });

  it('reduces crossings with the barycenter sweeps', () => {
    // Two parents whose children are listed crosswise.
    const ids = ['p1', 'p2', 'c2a', 'c1a', 'c2b', 'c1b'];
    const edges: LayoutEdgeInput[] = [
      { from: 'p1', to: 'c1a', kind: 'child' },
      { from: 'p1', to: 'c1b', kind: 'child' },
      { from: 'p2', to: 'c2a', kind: 'child' },
      { from: 'p2', to: 'c2b', kind: 'child' },
    ];
    const naive = countCrossings([['p1', 'p2'], ['c2a', 'c1a', 'c2b', 'c1b']], edges);
    const l = layoutDag(ids, edges);
    const order = [0, 1].map((layer) => l.nodes.filter((n) => n.layer === layer).sort((a, b) => a.x - b.x).map((n) => n.id));
    expect(naive).toBeGreaterThan(0);
    expect(countCrossings(order, edges)).toBe(0);
  });

  it('wraps wide layers and lays out 300 nodes in under 50 ms', () => {
    const ids = ['root', ...Array.from({ length: 299 }, (_, i) => `n${i}`)];
    const edges: LayoutEdgeInput[] = ids.slice(1).map((id, i) => ({ from: i < 30 ? 'root' : `n${i % 30}`, to: id, kind: 'child' }));
    const t = performance.now();
    const l = layoutDag(ids, edges, { root: 'root' });
    const elapsed = performance.now() - t;
    expect(l.nodes.filter((n) => !n.dummy)).toHaveLength(300);
    expect(l.columns).toBeLessThanOrEqual(30);
    expect(elapsed).toBeLessThan(50);
  });
});

describe('trace bars', () => {
  it('orders the tree depth-first from the root and indents by depth', async () => {
    const { traceBars } = await import('./gantt-layout');
    const node = (id: string, s: number, extra: Record<string, unknown> = {}) => ({
      id,
      namespace: 'ns',
      workflowId: id,
      runId: `${id}-run`,
      workflowType: 'T',
      status: 'WORKFLOW_EXECUTION_STATUS_COMPLETED',
      startTime: at(s),
      closeTime: at(s + 5),
      root: false,
      ...extra,
    });
    const bars = traceBars(
      [node('kid2', 3), node('grand', 2), node('root', 0, { root: true }), node('kid1', 1), node('partner', 0.5, { closeTime: null, status: 'WORKFLOW_EXECUTION_STATUS_RUNNING' })],
      [
        { from: 'root', to: 'kid2', kind: 'child' },
        { from: 'root', to: 'kid1', kind: 'child' },
        { from: 'kid1', to: 'grand', kind: 'child' },
        { from: 'root', to: 'partner', kind: 'signal' },
      ],
      T0 + 60_000,
    );
    expect(bars.map((b) => [b.id, b.depth])).toEqual([
      ['root', 0],
      ['kid1', 1],
      ['grand', 2],
      ['kid2', 1],
      ['partner', 0],
    ]);
    expect(bars[4]).toMatchObject({ open: true, tone: 'running', end: T0 + 60_000 });
  });
});
