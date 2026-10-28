import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { apiPageFetcher } from '../../lib/history/fetch';
import { buildGroups } from '../../lib/history/groups';
import { CLOSE_EVENT_TYPES, shortEventType } from '../../lib/temporal';
import { href, P } from '../../routes';
import { Gantt } from '../../viz/gantt';
import type { Bar } from '../../viz/gantt-layout';
import { runBars } from '../../viz/gantt-layout';
import type { RunContext } from '../workflow-layout';
import { InputAndResult } from '../workflow-layout';
import { Coverage, HistoryTab } from './history';

const STATUS_BY_CLOSE: Record<string, string> = {
  WorkflowExecutionCompleted: 'WORKFLOW_EXECUTION_STATUS_COMPLETED',
  WorkflowExecutionFailed: 'WORKFLOW_EXECUTION_STATUS_FAILED',
  WorkflowExecutionTimedOut: 'WORKFLOW_EXECUTION_STATUS_TIMED_OUT',
  WorkflowExecutionCanceled: 'WORKFLOW_EXECUTION_STATUS_CANCELED',
  WorkflowExecutionTerminated: 'WORKFLOW_EXECUTION_STATUS_TERMINATED',
  WorkflowExecutionContinuedAsNew: 'WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW',
};

/** Per-run Gantt (live while running) above the input, result and grouped history. */
export function TimelineTab(ctx: RunContext) {
  const { store, ns, wf, run } = ctx;
  const { route } = useLocation();
  const events = store.history.events.value;
  const groups = useMemo(() => buildGroups(events), [events]);
  const describe = store.describe.value;
  const running = store.running;
  const [now, setNow] = useState(Date.now());
  const [workflowTasks, setWorkflowTasks] = useState(false);

  // Running items extend to "now", which ticks every second while the run is live.
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => !document.hidden && setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  const { bars, truncated } = useMemo(
    () =>
      runBars(events, groups, {
        now,
        workflowTasks,
        pendingActivities: describe?.pendingActivities,
        runStatus: describe?.workflowExecutionInfo?.status,
      }),
    [events, groups, now, workflowTasks, describe],
  );

  /** A child's first history page, as nested bars that can expand further. */
  const loadChild = async (bar: Bar): Promise<Bar[]> => {
    const c = bar.child;
    if (!c) return [];
    const childNs = c.namespace ?? ns;
    const page = await apiPageFetcher(childNs, c.workflowId, c.runId)('asc', undefined);
    const last = page.events[page.events.length - 1];
    const status = last && CLOSE_EVENT_TYPES.has(last.eventType) ? STATUS_BY_CLOSE[shortEventType(last.eventType)] : 'WORKFLOW_EXECUTION_STATUS_RUNNING';
    const nested = runBars(page.events, buildGroups(page.events), { now, runStatus: status, depth: bar.depth + 1, idPrefix: `${bar.id}/` }).bars;
    return nested.map((b) => ({ ...b, label: b.lane === 'workflow' ? `${c.workflowId}${page.nextPageToken ? ' (first page)' : ''}` : b.label, run: { namespace: childNs, workflowId: c.workflowId, runId: c.runId } }));
  };

  const onSelect = (b: Bar) => {
    if (b.run) {
      route(b.eventId ? href(P.eventDetail, { ns: b.run.namespace, wf: b.run.workflowId, run: b.run.runId, eventId: b.eventId }) : href(P.run, { ns: b.run.namespace, wf: b.run.workflowId, run: b.run.runId }));
    } else if (b.eventId) {
      route(href(P.eventDetail, { ns, wf, run, eventId: b.eventId }));
    }
  };

  return (
    <div class="stack">
      <InputAndResult store={store} ns={ns} />
      <section class="card card-pad">
        <div class="toolbar">
          <h2>Timeline</h2>
          <label class="check">
            <input type="checkbox" checked={workflowTasks} onChange={() => setWorkflowTasks(!workflowTasks)} /> Workflow tasks
          </label>
        </div>
        <Coverage store={store} />
        {events.length === 0 ? (
          <p class="muted">{store.history.loading.value ? 'Loading history…' : 'No events.'}</p>
        ) : (
          <Gantt
            bars={bars}
            now={now}
            truncated={truncated}
            onSelect={onSelect}
            loadChild={loadChild}
            summary={`Timeline of ${wf}: ${bars.length} items${running ? ', still running' : ''}.`}
          />
        )}
      </section>
      <HistoryTab {...ctx} />
    </div>
  );
}
