import { useEffect, useState } from 'preact/hooks';
import { ActionDialog } from '../../components/modal';
import { ReasonField, reasonOk } from '../../components/reason-field';
import { StatusBadge } from '../../components/status-chips';
import { showToast, updateToast } from '../../components/toast';
import { confirmed, TypedConfirm } from '../../components/typed-confirm';
import { api, seg } from '../../lib/api';
import type { BatchInfo, BatchKind, ResetPoint } from '../../lib/actions/batch';
import { batchQuery, batchRequest, isBatchRunning, selectionQuery } from '../../lib/actions/batch';
import { sendAction } from '../../lib/actions/workflow-actions';
import type { WorkflowExecutionInfo } from '../../lib/temporal';
import { href, P } from '../../routes';

export type BatchTarget = { type: 'selection'; runIds: string[] } | { type: 'query'; query: string };

export interface BatchDialogProps {
  ns: string;
  kind: BatchKind;
  target: BatchTarget;
  onClose: () => void;
  onDone?: () => void;
}

const VERB: Record<BatchKind, string> = { terminate: 'Terminate', cancel: 'Cancel', reset: 'Reset', delete: 'Delete' };
const PREVIEW = 20;

/** Polls DescribeBatchOperation every 5 s and keeps a toast up to date until the job ends. */
export function trackBatch(ns: string, jobId: string, verb: string): void {
  const link = href(P.batchOperation, { ns, jobId });
  const id = showToast({ kind: 'info', text: `${verb} batch started.`, href: link, linkText: 'Details' }, null);
  const tick = async () => {
    try {
      const b = await api.get<BatchInfo>(`/api/v1/namespaces/${seg(ns)}/batch-operations/${seg(jobId)}`);
      const progress = `${b.completeOperationCount ?? 0}/${b.totalOperationCount ?? '?'} done, ${b.failureOperationCount ?? 0} failed`;
      if (isBatchRunning(b)) {
        updateToast(id, { text: `${verb} batch running: ${progress}.` });
        window.setTimeout(() => void tick(), 5000);
      } else {
        updateToast(id, { kind: b.state === 'BATCH_OPERATION_STATE_COMPLETED' ? 'success' : 'error', text: `${verb} batch ${(b.state ?? '').replace('BATCH_OPERATION_STATE_', '').toLowerCase()}: ${progress}.` });
      }
    } catch {
      // The job may not be visible yet; try again.
      window.setTimeout(() => void tick(), 5000);
    }
  };
  window.setTimeout(() => void tick(), 1000);
}

/**
 * Batch cancel, terminate or reset. Shows a dry-run count and the first
 * matches, and requires the reason and the exact count typed back.
 */
export default function BatchDialog({ ns, kind, target, onClose, onDone }: BatchDialogProps) {
  const [query, setQuery] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [preview, setPreview] = useState<WorkflowExecutionInfo[]>([]);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [resetPoint, setResetPoint] = useState<ResetPoint>('last');

  useEffect(() => {
    let cancelled = false;
    try {
      const q = batchQuery(kind, target.type === 'selection' ? selectionQuery(target.runIds) : target.query);
      if (!q) throw new Error('Reset needs a query: an empty query would reset every workflow in the namespace.');
      setQuery(q);
      Promise.all([
        api.get<{ count?: string }>(`/api/v1/namespaces/${seg(ns)}/workflow-count`, { query: q }),
        api.get<{ executions?: WorkflowExecutionInfo[] }>(`/api/v1/namespaces/${seg(ns)}/workflows`, { query: q, pageSize: PREVIEW }),
      ]).then(
        ([c, list]) => {
          if (cancelled) return;
          setCount(Number(c.count ?? 0));
          setPreview(list.executions ?? []);
        },
        (err: unknown) => !cancelled && setSetupError(err instanceof Error ? err.message : String(err)),
      );
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : String(err));
    }
    return () => {
      cancelled = true;
    };
  }, [ns, kind, target]);

  const verb = VERB[kind];
  const expected = count === null ? '' : String(count);
  const build = () => {
    if (!query) throw new Error(setupError ?? 'Preparing…');
    return batchRequest(ns, kind, query, reason, resetPoint);
  };

  return (
    <ActionDialog
      title={`${verb} ${target.type === 'selection' ? `${target.runIds.length} selected` : 'all matching'} workflows`}
      submitLabel={`${verb} ${expected || '…'} workflows`}
      danger
      wide
      canSubmit={!!query && count !== null && count > 0 && reasonOk(reason, true) && confirmed(expected, typed)}
      cli={() => {
        try {
          return build().cli;
        } catch (err) {
          return `# ${err instanceof Error ? err.message : String(err)}`;
        }
      }}
      onClose={onClose}
      onSubmit={async () => {
        const req = build();
        await sendAction(req);
        trackBatch(ns, req.jobId, verb);
        onDone?.();
      }}
    >
      {setupError && (
        <p class="alert alert-error" role="alert">
          {setupError}
        </p>
      )}
      {query && (
        <p>
          Query: <code>{query}</code>
        </p>
      )}
      {(kind === 'cancel' || kind === 'terminate') && <p class="muted">Only running workflows can be {kind === 'cancel' ? 'cancelled' : 'terminated'}, so the query is limited to them.</p>}
      {kind === 'delete' && <p class="alert alert-warning">Deleting removes the workflows and their histories for good, whatever their status. This cannot be undone.</p>}
      {count === null && !setupError && <p class="muted">Counting matching workflows…</p>}
      {count !== null && (
        <div>
          <p>
            <strong>{count.toLocaleString('en-US')}</strong> workflows match{count > PREVIEW ? `; the first ${PREVIEW}:` : ':'}
          </p>
          <ul class="list-plain preview-list">
            {preview.map((w) => (
              <li key={`${w.execution.workflowId}/${w.execution.runId}`}>
                <StatusBadge status={w.status} /> {w.execution.workflowId} <span class="muted">{w.type?.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {kind === 'reset' && (
        <fieldset class="field">
          <legend>Reset each workflow to</legend>
          <label class="check">
            <input type="radio" name="batch-reset" checked={resetPoint === 'first'} onChange={() => setResetPoint('first')} /> its first workflow task
          </label>
          <label class="check">
            <input type="radio" name="batch-reset" checked={resetPoint === 'last'} onChange={() => setResetPoint('last')} /> its last completed workflow task
          </label>
        </fieldset>
      )}
      <ReasonField value={reason} onInput={setReason} required />
      {count !== null && count > 0 && <TypedConfirm expected={expected} value={typed} onInput={setTyped} what={`the number of workflows to ${kind}`} />}
    </ActionDialog>
  );
}
