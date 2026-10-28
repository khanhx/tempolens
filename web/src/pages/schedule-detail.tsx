import { useCallback, useEffect, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import { JsonView } from '../components/json-view';
import { ActionDialog } from '../components/modal';
import { PayloadView } from '../components/payload-view';
import { GatedButton } from '../components/role-gate';
import { Timestamp } from '../components/timestamp';
import { showToast } from '../components/toast';
import { confirmed, TypedConfirm } from '../components/typed-confirm';
import { api, seg } from '../lib/api';
import type { OverlapPolicy, ScheduleSpec } from '../lib/actions/schedule';
import { backfillScheduleRequest, deleteScheduleRequest, describeSpec, OVERLAP_POLICIES, pauseScheduleRequest, triggerScheduleRequest } from '../lib/actions/schedule';
import { sendAction } from '../lib/actions/workflow-actions';
import type { ActionRequest } from '../lib/actions/workflow-actions';
import { SCHEDULE_GATES } from '../lib/me';
import { decodeFields } from '../lib/payload/decode';
import type { Payload } from '../lib/payload/decode';
import { formatDuration, parseDuration } from '../lib/time';
import { href, P } from '../routes';

export interface DescribeScheduleResponse {
  schedule?: {
    spec?: ScheduleSpec;
    action?: { startWorkflow?: { workflowId?: string; workflowType?: { name?: string }; taskQueue?: { name?: string }; input?: { payloads?: Payload[] } } };
    policies?: { overlapPolicy?: string; catchupWindow?: string; pauseOnFailure?: boolean };
    state?: { notes?: string; paused?: boolean };
  };
  info?: {
    actionCount?: string;
    runningWorkflows?: { workflowId?: string; runId?: string }[];
    recentActions?: { scheduleTime?: string; actualTime?: string; startWorkflowResult?: { workflowId?: string; runId?: string } }[];
    futureActionTimes?: string[];
    createTime?: string;
    updateTime?: string;
    invalidScheduleError?: string;
  };
  searchAttributes?: { indexedFields?: Record<string, Payload> };
  memo?: { fields?: Record<string, Payload> };
  conflictToken?: string;
}

type Dialog = 'pause' | 'trigger' | 'backfill' | 'delete' | null;

const cliOf = (build: () => ActionRequest) => () => {
  try {
    return build().cli;
  } catch (err) {
    return `# ${err instanceof Error ? err.message : String(err)}`;
  }
};

const localToIso = (v: string) => (v ? new Date(v).toISOString() : '');

function OverlapSelect({ value, onChange }: { value: OverlapPolicy; onChange: (v: OverlapPolicy) => void }) {
  return (
    <label class="field">
      <span>Overlap policy</span>
      <select class="select" value={value} onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value as OverlapPolicy)}>
        {OVERLAP_POLICIES.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function ScheduleDetail() {
  const { params } = useRoute();
  const ns = params.ns ?? '';
  const id = params.id ?? '';
  const { route } = useLocation();
  const [data, setData] = useState<DescribeScheduleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [note, setNote] = useState('');
  const [overlap, setOverlap] = useState<OverlapPolicy>('SCHEDULE_OVERLAP_POLICY_SKIP');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [typed, setTyped] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api.get<DescribeScheduleResponse>(`/api/v1/namespaces/${seg(ns)}/schedules/${seg(id)}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ns, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (d: Dialog) => {
    setNote('');
    setTyped('');
    setDialog(d);
  };
  const run = async (req: ActionRequest, text: string) => {
    await sendAction(req);
    showToast({ kind: 'success', text });
    void load();
  };

  const s = data?.schedule;
  const paused = !!s?.state?.paused;
  const action = s?.action?.startWorkflow;

  return (
    <section class="page">
      <p class="muted crumbs">
        <a href={href(P.schedules, { ns })}>{ns} schedules</a>
      </p>
      <header class="run-head">
        <h1 class="run-title">
          {id} {data && (paused ? <span class="status status-canceled">Paused</span> : <span class="status status-running">Active</span>)}
        </h1>
        {data && (
          <div class="toolbar-group">
            <GatedButton actions={SCHEDULE_GATES.pause} onClick={() => open('pause')}>
              {paused ? 'Unpause' : 'Pause'}
            </GatedButton>
            <GatedButton actions={SCHEDULE_GATES.trigger} onClick={() => open('trigger')}>
              Trigger now
            </GatedButton>
            <GatedButton actions={SCHEDULE_GATES.backfill} onClick={() => open('backfill')}>
              Backfill
            </GatedButton>
            <GatedButton actions={SCHEDULE_GATES.edit} onClick={() => route(href(P.scheduleEdit, { ns, id }))}>
              Edit
            </GatedButton>
            <GatedButton actions={SCHEDULE_GATES.delete} class="btn btn-danger" onClick={() => open('delete')}>
              Delete
            </GatedButton>
          </div>
        )}
      </header>
      {error && (
        <p class="alert alert-error" role="alert">
          {error}
        </p>
      )}
      {data?.info?.invalidScheduleError && <p class="alert alert-error">{data.info.invalidScheduleError}</p>}
      {s?.state?.notes && <p class="alert">Note: {s.state.notes}</p>}
      {data && (
        <div class="stack">
          <dl class="kv-grid card card-pad">
            <div class="kv-item">
              <dt>Spec</dt>
              <dd>{describeSpec(s?.spec)}</dd>
            </div>
            <div class="kv-item">
              <dt>Workflow type</dt>
              <dd>{action?.workflowType?.name}</dd>
            </div>
            <div class="kv-item">
              <dt>Workflow ID</dt>
              <dd>{action?.workflowId}</dd>
            </div>
            <div class="kv-item">
              <dt>Task queue</dt>
              <dd>{action?.taskQueue?.name}</dd>
            </div>
            <div class="kv-item">
              <dt>Overlap</dt>
              <dd>{OVERLAP_POLICIES.find((o) => o.value === s?.policies?.overlapPolicy)?.label ?? 'Skip'}</dd>
            </div>
            <div class="kv-item">
              <dt>Catch-up window</dt>
              <dd>{formatDuration(parseDuration(s?.policies?.catchupWindow)) || '–'}</dd>
            </div>
            <div class="kv-item">
              <dt>Pause on failure</dt>
              <dd>{s?.policies?.pauseOnFailure ? 'Yes' : 'No'}</dd>
            </div>
            <div class="kv-item">
              <dt>Actions taken</dt>
              <dd>{data.info?.actionCount ?? 0}</dd>
            </div>
            <div class="kv-item">
              <dt>Created</dt>
              <dd>
                <Timestamp value={data.info?.createTime} />
              </dd>
            </div>
            <div class="kv-item">
              <dt>Updated</dt>
              <dd>
                <Timestamp value={data.info?.updateTime} />
              </dd>
            </div>
          </dl>
          <div class="io-grid">
            <section class="card card-pad">
              <h2>Recent runs</h2>
              <ul class="list-plain">
                {(data.info?.recentActions ?? [])
                  .slice()
                  .reverse()
                  .map((a, i) => (
                    <li key={i}>
                      <Timestamp value={a.actualTime} />{' '}
                      {a.startWorkflowResult?.workflowId && a.startWorkflowResult.runId && (
                        <a href={href(P.run, { ns, wf: a.startWorkflowResult.workflowId, run: a.startWorkflowResult.runId })}>{a.startWorkflowResult.workflowId}</a>
                      )}
                    </li>
                  ))}
                {!data.info?.recentActions?.length && <li class="muted">None yet.</li>}
              </ul>
              {!!data.info?.runningWorkflows?.length && (
                <>
                  <h3>Running now</h3>
                  <ul class="list-plain">
                    {data.info.runningWorkflows.map((w) => (
                      <li key={w.runId}>
                        <a href={href(P.run, { ns, wf: w.workflowId ?? '', run: w.runId ?? '' })}>{w.workflowId}</a>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
            <section class="card card-pad">
              <h2>Upcoming runs</h2>
              <ul class="list-plain">
                {(data.info?.futureActionTimes ?? []).map((t) => (
                  <li key={t}>
                    <Timestamp value={t} />
                  </li>
                ))}
                {!data.info?.futureActionTimes?.length && <li class="muted">None.</li>}
              </ul>
            </section>
          </div>
          <section class="card card-pad">
            <h2>Input</h2>
            <PayloadView value={action?.input ?? null} ns={ns} />
            <h3>Search attributes</h3>
            <JsonView value={decodeFields(data.searchAttributes?.indexedFields)} />
            <h3>Spec (raw)</h3>
            <JsonView value={s?.spec ?? {}} openDepth={2} />
          </section>
        </div>
      )}

      {dialog === 'pause' && (
        <ActionDialog
          title={`${paused ? 'Unpause' : 'Pause'} ${id}`}
          submitLabel={paused ? 'Unpause' : 'Pause'}
          cli={cliOf(() => pauseScheduleRequest(ns, id, !paused, note))}
          onClose={() => setDialog(null)}
          onSubmit={() => run(pauseScheduleRequest(ns, id, !paused, note), paused ? 'Schedule unpaused.' : 'Schedule paused.')}
        >
          <label class="field">
            <span>
              Note <span class="muted">(shown on the schedule)</span>
            </span>
            <input class="input" value={note} onInput={(e) => setNote((e.currentTarget as HTMLInputElement).value)} />
          </label>
        </ActionDialog>
      )}
      {dialog === 'trigger' && (
        <ActionDialog
          title={`Trigger ${id} now`}
          submitLabel="Trigger"
          cli={cliOf(() => triggerScheduleRequest(ns, id, overlap))}
          onClose={() => setDialog(null)}
          onSubmit={() => run(triggerScheduleRequest(ns, id, overlap), 'Schedule triggered.')}
        >
          <OverlapSelect value={overlap} onChange={setOverlap} />
        </ActionDialog>
      )}
      {dialog === 'backfill' && (
        <ActionDialog
          title={`Backfill ${id}`}
          submitLabel="Backfill"
          cli={cliOf(() => backfillScheduleRequest(ns, id, localToIso(from), localToIso(to), overlap))}
          onClose={() => setDialog(null)}
          onSubmit={() => run(backfillScheduleRequest(ns, id, localToIso(from), localToIso(to), overlap), 'Backfill requested.')}
        >
          <p class="muted">Runs every action the schedule would have taken in this range (your local time).</p>
          <label class="field">
            <span>From</span>
            <input class="input" type="datetime-local" step="1" required value={from} onInput={(e) => setFrom((e.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span>To</span>
            <input class="input" type="datetime-local" step="1" required value={to} onInput={(e) => setTo((e.currentTarget as HTMLInputElement).value)} />
          </label>
          <OverlapSelect value={overlap} onChange={setOverlap} />
        </ActionDialog>
      )}
      {dialog === 'delete' && (
        <ActionDialog
          title={`Delete ${id}`}
          submitLabel="Delete schedule"
          danger
          canSubmit={confirmed(id, typed)}
          cli={cliOf(() => deleteScheduleRequest(ns, id))}
          onClose={() => setDialog(null)}
          onSubmit={async () => {
            await sendAction(deleteScheduleRequest(ns, id));
            showToast({ kind: 'success', text: `Schedule ${id} deleted.` });
            route(href(P.schedules, { ns }));
          }}
        >
          <p>Deleting stops future runs. Workflows already started keep running.</p>
          <TypedConfirm expected={id} value={typed} onInput={setTyped} what="the schedule ID" />
        </ActionDialog>
      )}
    </section>
  );
}
