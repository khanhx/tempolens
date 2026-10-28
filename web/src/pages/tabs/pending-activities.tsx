import { useState } from 'preact/hooks';
import { ActionMenu } from '../../components/action-menu';
import { useLazyModule } from '../../components/lazy-load';
import { PayloadView } from '../../components/payload-view';
import { Timestamp } from '../../components/timestamp';
import { ACTIVITY_COMMANDS_MIN_VERSION, versionAtLeast } from '../../lib/actions/activity';
import { clusterInfo } from '../../lib/server-info';
import type { PendingActivity } from '../../lib/temporal';
import { failureMessages } from '../../lib/temporal';
import type { WorkflowActionKind } from '../actions/workflow-dialogs';
import type { RunContext } from '../workflow-layout';

const stateLabel = (s: string | undefined) => (s ? s.replace(/^PENDING_ACTIVITY_STATE_/, '').toLowerCase().replace(/_/g, ' ') : '');

const isPaused = (a: PendingActivity) => a.paused === true || a.state === 'PENDING_ACTIVITY_STATE_PAUSED';

/**
 * Write actions on one pending activity. Complete and fail by ID work on
 * every server; pause, unpause, reset and update-options exist only from
 * Temporal 1.27 on, so they are hidden on older servers.
 */
function activityItems(a: PendingActivity, open: (kind: WorkflowActionKind, id: string) => void) {
  const id = a.activityId ?? '';
  const commands = versionAtLeast(clusterInfo.value?.serverVersion, ACTIVITY_COMMANDS_MIN_VERSION);
  const item = (kind: WorkflowActionKind, label: string, hidden = false, danger = false) => ({
    id: kind,
    label,
    actions: ['activity'] as const,
    onSelect: () => open(kind, id),
    hidden: hidden || !id,
    danger,
  });
  return [
    item('activity-complete', 'Complete'),
    item('activity-fail', 'Fail', false, true),
    item('activity-pause', 'Pause', !commands || isPaused(a)),
    item('activity-unpause', 'Unpause', !commands || !isPaused(a)),
    item('activity-reset', 'Reset', !commands),
    item('activity-update-options', 'Update options', !commands),
  ];
}

/** Pending activities from DescribeWorkflowExecution: attempts, last failure, heartbeat. */
export function PendingActivitiesTab({ store, ns }: RunContext) {
  const [dialog, setDialog] = useState<{ kind: WorkflowActionKind; activityId: string } | null>(null);
  const mod = useLazyModule(() => import('../actions/workflow-dialogs'), dialog !== null);
  const list = store.describe.value?.pendingActivities ?? [];
  if (!store.describe.value) return <p class="muted">Loading…</p>;
  if (list.length === 0) return <p class="muted">No pending activities.</p>;
  return (
    <div class="stack">
      {dialog && mod instanceof Error && <p class="field-error">Could not load the dialog: {mod.message}</p>}
      {dialog && mod && !(mod instanceof Error) && (
        <mod.default kind={dialog.kind} activityId={dialog.activityId} store={store} onClose={() => setDialog(null)} />
      )}
      {list.map((a) => (
        <article key={a.activityId} class="card card-pad">
          <div class="page-head">
            <h2>
              {a.activityType?.name} <span class="muted">#{a.activityId}</span> <span class="gstatus gstatus-pending">{stateLabel(a.state)}</span>
            </h2>
            <ActionMenu label="Activity actions" items={activityItems(a, (kind, activityId) => setDialog({ kind, activityId }))} />
          </div>
          <dl class="kv-grid">
            <div class="kv-item">
              <dt>Attempt</dt>
              <dd>
                {a.attempt ?? 1}
                {a.maximumAttempts ? ` of ${a.maximumAttempts}` : ' (unlimited)'}
              </dd>
            </div>
            <div class="kv-item">
              <dt>Scheduled</dt>
              <dd>
                <Timestamp value={a.scheduledTime} />
              </dd>
            </div>
            <div class="kv-item">
              <dt>Last started</dt>
              <dd>
                <Timestamp value={a.lastStartedTime} />
              </dd>
            </div>
            <div class="kv-item">
              <dt>Last heartbeat</dt>
              <dd>
                <Timestamp value={a.lastHeartbeatTime} />
              </dd>
            </div>
            <div class="kv-item">
              <dt>Expires</dt>
              <dd>
                <Timestamp value={a.expirationTime} />
              </dd>
            </div>
            <div class="kv-item">
              <dt>Last worker</dt>
              <dd>{a.lastWorkerIdentity || '–'}</dd>
            </div>
          </dl>
          {a.lastFailure && (
            <details class="failure" open>
              <summary class="field-error">Last failure: {failureMessages(a.lastFailure).join(': ')}</summary>
              <PayloadView value={a.lastFailure} ns={ns} openDepth={2} />
            </details>
          )}
          {a.heartbeatDetails && (
            <details>
              <summary>Heartbeat details</summary>
              <PayloadView value={a.heartbeatDetails} ns={ns} />
            </details>
          )}
        </article>
      ))}
    </div>
  );
}
