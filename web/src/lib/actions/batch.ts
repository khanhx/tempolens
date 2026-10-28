// Batch operations. Targets are always a visibility query: the server
// rejects `executions` and `targetExecutions`, and allows only terminate,
// cancel and reset (reset without postResetOperations).
import { seg } from '../api';
import type { WriteAction } from '../me';
import { quoteString } from '../query/build';
import { splitOrderBy, wrap } from '../query/wrap';
import { cliCommand } from './cli-command';
import type { ActionRequest } from './workflow-actions';

export type BatchKind = 'terminate' | 'cancel' | 'reset' | 'delete';
export type ResetPoint = 'first' | 'last';

/** The per-action key each batch type needs on top of `batch`. */
export const BATCH_ACTION: Record<BatchKind, WriteAction> = { terminate: 'terminate', cancel: 'cancel', reset: 'reset', delete: 'batchDelete' };

export const MAX_SELECTION = 100;

/** Selected runs as `RunId = "a" OR RunId = "b"`; 1 to 100 runs. */
export function selectionQuery(runIds: readonly string[]): string {
  const unique = [...new Set(runIds.filter(Boolean))];
  if (unique.length === 0) throw new Error('Select at least one workflow.');
  if (unique.length > MAX_SELECTION) throw new Error(`At most ${MAX_SELECTION} selected workflows per batch; use "all matching" with a query instead.`);
  return unique.map((id) => `RunId = ${quoteString(id)}`).join(' OR ');
}

/**
 * The query a batch runs on. Cancel and terminate only affect running
 * workflows, so they are narrowed to them; the count preview then matches
 * what the batch will touch. Any ORDER BY is dropped.
 */
export function batchQuery(kind: BatchKind, target: string): string {
  const where = splitOrderBy(target).where;
  if (kind === 'reset' || kind === 'delete') return where;
  return wrap(where, 'ExecutionStatus = "Running"');
}

export function batchRequest(ns: string, kind: BatchKind, visibilityQuery: string, reason: string, resetPoint: ResetPoint = 'last', jobId: string = crypto.randomUUID()): ActionRequest & { jobId: string } {
  if (!visibilityQuery.trim()) throw new Error('A batch needs a query.');
  if (!reason.trim()) throw new Error('A reason is required.');
  const op =
    kind === 'terminate'
      ? { terminationOperation: {} }
      : kind === 'cancel'
        ? { cancellationOperation: {} }
        : kind === 'delete'
          ? { deletionOperation: {} }
          : { resetOperation: { options: resetPoint === 'first' ? { firstWorkflowTask: {} } : { lastWorkflowTask: {} } } };
  return {
    jobId,
    method: 'POST',
    path: `/api/v1/namespaces/${seg(ns)}/batch-operations/${seg(jobId)}`,
    body: { visibilityQuery, reason: reason.trim(), ...op },
    // Batch terminate and batch delete must name their job (contract §1.6).
    ...(kind === 'terminate' || kind === 'delete' ? { confirm: jobId } : {}),
    cli: cliCommand(
      ['workflow', kind],
      [
        ['namespace', ns],
        ['query', visibilityQuery],
        ['reason', kind === 'cancel' || kind === 'delete' ? undefined : reason.trim()],
        ['type', kind === 'reset' ? (resetPoint === 'first' ? 'FirstWorkflowTask' : 'LastWorkflowTask') : undefined],
        ['yes', true],
      ],
    ),
  };
}

export function stopBatchRequest(ns: string, jobId: string, reason: string): ActionRequest {
  if (!reason.trim()) throw new Error('A reason is required.');
  return {
    method: 'POST',
    path: `/api/v1/namespaces/${seg(ns)}/batch-operations/${seg(jobId)}/stop`,
    body: { reason: reason.trim() },
    cli: cliCommand(['batch', 'terminate'], [['namespace', ns], ['job-id', jobId], ['reason', reason.trim()]]),
  };
}

export interface BatchInfo {
  operationType?: string;
  jobId?: string;
  state?: string;
  startTime?: string;
  closeTime?: string;
  totalOperationCount?: string;
  completeOperationCount?: string;
  failureOperationCount?: string;
  identity?: string;
  reason?: string;
}

export const isBatchRunning = (b: BatchInfo | null | undefined) => b?.state === 'BATCH_OPERATION_STATE_RUNNING';
