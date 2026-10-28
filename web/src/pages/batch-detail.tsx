import { useCallback, useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { ActionDialog } from '../components/modal';
import { ReasonField, reasonOk } from '../components/reason-field';
import { GatedButton } from '../components/role-gate';
import { Timestamp } from '../components/timestamp';
import { showToast } from '../components/toast';
import { api, seg } from '../lib/api';
import type { BatchInfo } from '../lib/actions/batch';
import { isBatchRunning, stopBatchRequest } from '../lib/actions/batch';
import { sendAction } from '../lib/actions/workflow-actions';
import { href, P } from '../routes';
import { batchState, batchStateCss } from './batch-list';

const REFRESH_MS = 5000;

export default function BatchDetail() {
  const { params } = useRoute();
  const ns = params.ns ?? '';
  const jobId = params.jobId ?? '';
  const [b, setB] = useState<BatchInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      setB(await api.get<BatchInfo>(`/api/v1/namespaces/${seg(ns)}/batch-operations/${seg(jobId)}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ns, jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh every 5 s while the job runs and the tab is visible.
  const running = isBatchRunning(b);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => !document.hidden && void load(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [running, load]);

  const total = Number(b?.totalOperationCount ?? 0);
  const done = Number(b?.completeOperationCount ?? 0);
  const failed = Number(b?.failureOperationCount ?? 0);

  return (
    <section class="page">
      <p class="muted crumbs">
        <a href={href(P.batchOperations, { ns })}>{ns} batch operations</a>
      </p>
      <header class="run-head">
        <h1 class="run-title">
          {jobId} {b && <span class={`status ${batchStateCss(b.state)}`}>{batchState(b.state)}</span>}
        </h1>
        {running && (
          <GatedButton actions={['batch']} class="btn btn-danger" onClick={() => setStopping(true)}>
            Stop batch
          </GatedButton>
        )}
      </header>
      {error && (
        <p class="alert alert-error" role="alert">
          {error}
        </p>
      )}
      {b && (
        <dl class="kv-grid card card-pad">
          <div class="kv-item">
            <dt>Operation</dt>
            <dd>{(b.operationType ?? '').replace('BATCH_OPERATION_TYPE_', '').toLowerCase()}</dd>
          </div>
          <div class="kv-item">
            <dt>Progress</dt>
            <dd>
              {done.toLocaleString('en-US')} of {total.toLocaleString('en-US')} done, {failed.toLocaleString('en-US')} failed
              {total > 0 && <progress class="progress" max={total} value={done + failed} />}
            </dd>
          </div>
          <div class="kv-item">
            <dt>Started</dt>
            <dd>
              <Timestamp value={b.startTime} />
            </dd>
          </div>
          <div class="kv-item">
            <dt>Closed</dt>
            <dd>
              <Timestamp value={b.closeTime} />
            </dd>
          </div>
          <div class="kv-item">
            <dt>Identity</dt>
            <dd>{b.identity}</dd>
          </div>
          <div class="kv-item">
            <dt>Reason</dt>
            <dd>{b.reason}</dd>
          </div>
        </dl>
      )}
      {running && <p class="muted">Refreshing every 5 seconds while the job runs.</p>}
      {stopping && (
        <ActionDialog
          title={`Stop batch ${jobId}`}
          submitLabel="Stop batch"
          danger
          canSubmit={reasonOk(reason, true)}
          cli={() => {
            try {
              return stopBatchRequest(ns, jobId, reason).cli;
            } catch (err) {
              return `# ${err instanceof Error ? err.message : String(err)}`;
            }
          }}
          onClose={() => setStopping(false)}
          onSubmit={async () => {
            await sendAction(stopBatchRequest(ns, jobId, reason));
            showToast({ kind: 'success', text: 'Batch stopped.' });
            void load();
          }}
        >
          <p class="muted">Workflows already processed stay as they are; the rest are left untouched.</p>
          <ReasonField value={reason} onInput={setReason} required />
        </ActionDialog>
      )}
    </section>
  );
}
