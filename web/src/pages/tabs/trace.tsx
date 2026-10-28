import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { CopyButton } from '../../components/copy-button';
import { cliCommand } from '../../lib/actions/cli-command';
import type { GraphResponse } from '../../lib/xapi';
import { busyText, fetchGraph } from '../../lib/xapi';
import { href, P } from '../../routes';
import { Gantt } from '../../viz/gantt';
import { traceBars } from '../../viz/gantt-layout';
import type { RunContext } from '../workflow-layout';
import { GraphWarnings } from './graph';

/**
 * `temporal workflow trace` in the browser: the run tree from /api/x/graph
 * drawn as an indented Gantt, with live runs ticking.
 */
export function TraceTab({ ns, wf, run }: RunContext) {
  const { route } = useLocation();
  const [state, setState] = useState<{ loading: boolean; data?: GraphResponse; error?: string }>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    fetchGraph(ns, wf, run, 2, controller.signal).then(
      (data) => setState({ loading: false, data }),
      (err: unknown) => !controller.signal.aborted && setState({ loading: false, error: busyText(err) ?? (err instanceof Error ? err.message : String(err)) }),
    );
    return () => controller.abort();
  }, [ns, wf, run, attempt]);

  const anyOpen = !!state.data?.nodes.some((n) => !n.closeTime && n.startTime);
  useEffect(() => {
    if (!anyOpen) return;
    const t = window.setInterval(() => !document.hidden && setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [anyOpen]);

  const bars = useMemo(() => (state.data ? traceBars(state.data.nodes, state.data.edges, now) : []), [state.data, now]);
  const focus = state.data?.nodes.find((n) => n.focus);
  const cli = cliCommand(['workflow', 'trace'], [
    ['namespace', ns],
    ['workflow-id', wf],
    ['run-id', run],
  ]);

  return (
    <div class="stack">
      <div class="toolbar">
        <CopyButton text={cli} label="Copy as temporal CLI" />
        <a class="btn" href={href(P.graph, { ns, wf, run })}>
          Open as graph
        </a>
        {state.loading && <span class="muted">Loading the run tree…</span>}
      </div>
      {state.error && (
        <p class="alert alert-error" role="alert">
          {state.error}{' '}
          <button type="button" class="btn btn-sm" onClick={() => setAttempt(attempt + 1)}>
            Retry
          </button>
        </p>
      )}
      {state.data && <GraphWarnings data={state.data} />}
      {bars.length > 0 && (
        <Gantt
          bars={bars}
          now={now}
          summary={`Trace of ${wf}: ${bars.length} runs in its tree${focus ? `, this run is ${focus.workflowId}` : ''}.`}
          onSelect={(b) => b.run && route(href(P.run, { ns: b.run.namespace, wf: b.run.workflowId, run: b.run.runId }))}
        />
      )}
    </div>
  );
}
