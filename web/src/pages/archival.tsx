import { useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { StatusBadge } from '../components/status-chips';
import { Timestamp } from '../components/timestamp';
import { api, seg } from '../lib/api';
import type { WorkflowExecutionInfo } from '../lib/temporal';
import { href, P } from '../routes';

interface ArchivalConfig {
  config?: { historyArchivalState?: string; historyArchivalUri?: string; visibilityArchivalState?: string; visibilityArchivalUri?: string };
}

const enabled = (s: string | undefined) => s === 'ARCHIVAL_STATE_ENABLED';

/** Archived workflows when visibility archival is on and queryable; otherwise a setup notice. */
export default function Archival() {
  const { params } = useRoute();
  const ns = params.ns ?? '';
  const [cfg, setCfg] = useState<ArchivalConfig['config'] | null>(null);
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [rows, setRows] = useState<WorkflowExecutionInfo[] | null>(null);
  const [token, setToken] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<ArchivalConfig>(`/api/v1/namespaces/${seg(ns)}`).then(
      (d) => setCfg(d.config ?? {}),
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, [ns]);

  const uri = cfg?.visibilityArchivalUri ?? '';
  // Upstream: s3:// and gs:// visibility archives cannot be queried from the UI.
  const queryable = enabled(cfg?.visibilityArchivalState) && !/^(s3|gs):\/\//.test(uri);

  const load = async (next?: string) => {
    try {
      const res = await api.get<{ executions?: WorkflowExecutionInfo[]; nextPageToken?: string }>(`/api/v1/namespaces/${seg(ns)}/archived-workflows`, {
        pageSize: 100,
        query: applied || undefined,
        nextPageToken: next,
      });
      setRows((r) => (next && r ? [...r, ...(res.executions ?? [])] : (res.executions ?? [])));
      setToken(res.nextPageToken || undefined);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (queryable) void load();
  }, [queryable, applied]);

  return (
    <section class="page">
      <h1>
        Archival <span class="muted">{ns}</span>
      </h1>
      {error && (
        <p class="alert alert-error" role="alert">
          {error}
        </p>
      )}
      {cfg && !queryable && (
        <div class="alert">
          <p>
            {enabled(cfg.visibilityArchivalState)
              ? `Visibility archival writes to ${uri}, which cannot be queried from here.`
              : 'Archival is not enabled for this namespace.'}
          </p>
          <p class="muted">
            History archival: {enabled(cfg.historyArchivalState) ? `enabled (${cfg.historyArchivalUri ?? ''})` : 'disabled'}. To enable it, configure an archival
            provider on the cluster, then run for example:
          </p>
          <pre class="code-block">{`temporal operator namespace update --namespace ${ns} \\\n  --history-archival-state enabled --visibility-archival-state enabled`}</pre>
        </div>
      )}
      {queryable && (
        <>
          <form
            class="raw-query"
            onSubmit={(e) => {
              e.preventDefault();
              setApplied(query.trim());
            }}
          >
            <input class="input input-mono" data-shortcut-search aria-label="Archived workflow query" value={query} placeholder='e.g. WorkflowType = "Order"' onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
            <button class="btn" type="submit">
              Apply
            </button>
          </form>
          <table class="table card">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Workflow ID</th>
                <th scope="col">Type</th>
                <th scope="col">Start</th>
                <th scope="col">End</th>
              </tr>
            </thead>
            <tbody>
              {rows?.length === 0 && (
                <tr>
                  <td colSpan={5} class="dt-empty">
                    No archived workflows.
                  </td>
                </tr>
              )}
              {rows?.map((w) => (
                <tr key={`${w.execution.workflowId}/${w.execution.runId}`}>
                  <td>
                    <StatusBadge status={w.status} />
                  </td>
                  <td>
                    <a href={href(P.archivedHistory, { ns, wf: w.execution.workflowId, run: w.execution.runId ?? '' })}>{w.execution.workflowId}</a>
                  </td>
                  <td>{w.type?.name}</td>
                  <td>
                    <Timestamp value={w.startTime} />
                  </td>
                  <td>
                    <Timestamp value={w.closeTime} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {token && (
            <button type="button" class="btn" onClick={() => void load(token)}>
              Load more
            </button>
          )}
        </>
      )}
    </section>
  );
}
