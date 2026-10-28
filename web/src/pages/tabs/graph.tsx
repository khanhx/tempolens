import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { me } from '../../lib/me';
import type { GraphResponse } from '../../lib/xapi';
import { busyText, fetchGraph, graphWarnings } from '../../lib/xapi';
import { href, P } from '../../routes';
import { GraphView } from '../../viz/graph';
import type { RunContext } from '../workflow-layout';

/** The reasons a graph is incomplete; nothing when it is complete. Shared with the trace tab. */
export function GraphWarnings({ data }: { data: GraphResponse }) {
  const warnings = graphWarnings(data);
  if (warnings.length === 0) return null;
  return (
    <div class="alert alert-warning" role="status">
      <ul class="list-plain">
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

/** Relationship graph from /api/x/graph, rooted at the tree root with this run highlighted. */
export function GraphTab({ ns, wf, run }: RunContext) {
  const { route } = useLocation();
  const maxDepth = me.value?.settings.limits.graphDepthMax ?? 3;
  const [depth, setDepth] = useState(Math.min(2, maxDepth));
  const [state, setState] = useState<{ loading: boolean; data?: GraphResponse; error?: string }>({ loading: true });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ loading: true, data: s.data }));
    fetchGraph(ns, wf, run, depth, controller.signal).then(
      (data) => setState({ loading: false, data }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setState({ loading: false, error: busyText(err) ?? (err instanceof Error ? err.message : String(err)) });
      },
    );
    return () => controller.abort();
  }, [ns, wf, run, depth, attempt]);

  const data = state.data;
  return (
    <div class="stack">
      <div class="toolbar">
        <span>
          Depth {depth} of {maxDepth}
        </span>
        <button type="button" class="btn" disabled={depth >= maxDepth || state.loading} onClick={() => setDepth(depth + 1)}>
          Load more depth
        </button>
        {state.loading && <span class="muted">Walking the graph…</span>}
      </div>
      {state.error && (
        <p class="alert alert-error" role="alert">
          {state.error}{' '}
          <button type="button" class="btn btn-sm" onClick={() => setAttempt(attempt + 1)}>
            Retry
          </button>
        </p>
      )}
      {data && <GraphWarnings data={data} />}
      {data && data.nodes.length <= 1 && data.edges.length === 0 && <p class="muted">This run has no parent, children, continue-as-new, reset, signal or cancel links.</p>}
      {data && (data.nodes.length > 1 || data.edges.length > 0) && (
        <GraphView
          data={data}
          onOpen={(n) => route(n.runId ? href(P.graph, { ns: n.namespace, wf: n.workflowId, run: n.runId }) : href(P.workflowLatest, { ns: n.namespace, wf: n.workflowId }))}
        />
      )}
    </div>
  );
}
