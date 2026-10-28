import { useEffect, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import { api, seg } from '../lib/api';
import { quoteString } from '../lib/query/build';
import type { WorkflowExecutionInfo } from '../lib/temporal';
import { href, P } from '../routes';

/**
 * `/namespaces/:ns/workflows/:wf` → the latest run, found as upstream does
 * with `WorkflowId = "…"` and pageSize 1.
 */
export default function WorkflowLatest() {
  const { params } = useRoute();
  const ns = params.ns ?? '';
  const wf = params.wf ?? '';
  const { route } = useLocation();
  const [state, setState] = useState<{ error?: string; notFound?: boolean }>({});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({});
    api
      .get<{ executions?: WorkflowExecutionInfo[] }>(`/api/v1/namespaces/${seg(ns)}/workflows`, {
        query: `WorkflowId = ${quoteString(wf)}`,
        pageSize: 1,
      })
      .then(
        (res) => {
          if (cancelled) return;
          const run = res.executions?.[0]?.execution.runId;
          if (run) route(href(P.run, { ns, wf, run }) + window.location.search, true);
          else setState({ notFound: true });
        },
        (err: unknown) => !cancelled && setState({ error: err instanceof Error ? err.message : String(err) }),
      );
    return () => {
      cancelled = true;
    };
  }, [ns, wf, attempt]);

  return (
    <section class="page">
      <h1>{wf}</h1>
      {!state.error && !state.notFound && <p class="muted">Finding the latest run…</p>}
      {state.error && (
        <div class="alert alert-error" role="alert">
          {state.error}{' '}
          <button type="button" class="btn btn-sm" onClick={() => setAttempt(attempt + 1)}>
            Try again
          </button>
        </div>
      )}
      {state.notFound && (
        <div class="alert" role="status">
          <p>
            No run of <code>{wf}</code> was found in <strong>{ns}</strong>.
          </p>
          <p class="muted">
            Visibility is eventually consistent: a workflow started a moment ago can take a few seconds to appear. Check the ID, or try again shortly.
          </p>
          <button type="button" class="btn" onClick={() => setAttempt(attempt + 1)}>
            Try again
          </button>
        </div>
      )}
    </section>
  );
}
