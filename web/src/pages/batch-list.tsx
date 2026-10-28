import { useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { Timestamp } from '../components/timestamp';
import { api, seg } from '../lib/api';
import type { BatchInfo } from '../lib/actions/batch';
import { href, P } from '../routes';

export const batchState = (s: string | undefined) => (s ?? '').replace('BATCH_OPERATION_STATE_', '').toLowerCase() || 'unknown';
export const batchStateCss = (s: string | undefined) =>
  s === 'BATCH_OPERATION_STATE_RUNNING' ? 'status-running' : s === 'BATCH_OPERATION_STATE_COMPLETED' ? 'status-completed' : s === 'BATCH_OPERATION_STATE_FAILED' ? 'status-failed' : 'status-unknown';

/** ListBatchOperations (first page only, as upstream). */
export default function BatchList() {
  const { params } = useRoute();
  const ns = params.ns ?? '';
  const [rows, setRows] = useState<BatchInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ operationInfo?: BatchInfo[] }>(`/api/v1/namespaces/${seg(ns)}/batch-operations`, { pageSize: 100 }).then(
      (r) => !cancelled && setRows(r.operationInfo ?? []),
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [ns]);

  return (
    <section class="page">
      <h1>
        Batch operations <span class="muted">{ns}</span>
      </h1>
      <p class="muted">Batches are started from the workflow list (select workflows, then Bulk actions).</p>
      {error && (
        <p class="alert alert-error" role="alert">
          {error}
        </p>
      )}
      <table class="table card">
        <thead>
          <tr>
            <th scope="col">State</th>
            <th scope="col">Job ID</th>
            <th scope="col">Started</th>
            <th scope="col">Closed</th>
          </tr>
        </thead>
        <tbody>
          {rows === null && !error && (
            <tr>
              <td colSpan={4} class="dt-empty">
                Loading…
              </td>
            </tr>
          )}
          {rows?.length === 0 && (
            <tr>
              <td colSpan={4} class="dt-empty">
                No batch operations.
              </td>
            </tr>
          )}
          {rows?.map((b) => (
            <tr key={b.jobId}>
              <td>
                <span class={`status ${batchStateCss(b.state)}`}>{batchState(b.state)}</span>
              </td>
              <td>
                <a href={href(P.batchOperation, { ns, jobId: b.jobId ?? '' })}>{b.jobId}</a>
              </td>
              <td>
                <Timestamp value={b.startTime} />
              </td>
              <td>
                <Timestamp value={b.closeTime} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
