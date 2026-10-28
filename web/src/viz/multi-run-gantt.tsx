import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import type { WorkflowExecutionInfo } from '../lib/temporal';
import { href, P } from '../routes';
import { Gantt } from './gantt';
import { workflowBars } from './gantt-layout';

export interface MultiRunGanttProps {
  rows: readonly (WorkflowExecutionInfo & { tlNamespace?: string })[];
  namespace: string;
  /** Prefix labels with the namespace (cross-namespace view). */
  withNamespace: boolean;
}

/** One bar per loaded workflow; running bars tick, and the list's refresh feeds new rows. */
export default function MultiRunGantt({ rows, namespace, withNamespace }: MultiRunGanttProps) {
  const { route } = useLocation();
  const [now, setNow] = useState(Date.now());
  const anyOpen = rows.some((r) => !r.closeTime);
  useEffect(() => {
    if (!anyOpen) return;
    const t = window.setInterval(() => !document.hidden && setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [anyOpen]);
  const bars = useMemo(() => workflowBars(rows, now, namespace, withNamespace), [rows, now, namespace, withNamespace]);
  if (bars.length === 0) return <p class="muted">No workflows to draw.</p>;
  return (
    <Gantt
      bars={bars}
      now={now}
      summary={`Timeline of ${bars.length} workflows.`}
      onSelect={(b) => b.run && route(href(P.run, { ns: b.run.namespace, wf: b.run.workflowId, run: b.run.runId }))}
    />
  );
}
