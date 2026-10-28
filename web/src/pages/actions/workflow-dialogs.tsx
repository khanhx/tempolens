import { useEffect, useMemo, useState } from 'preact/hooks';
import type { InputValue } from '../../components/input-editor';
import { EMPTY_INPUT, InputEditor } from '../../components/input-editor';
import { ActionDialog } from '../../components/modal';
import { confirmed, TypedConfirm } from '../../components/typed-confirm';
import { ReasonField, reasonOk } from '../../components/reason-field';
import { showToast } from '../../components/toast';
import { encodeForWrite, parseInput } from '../../lib/actions/encode';
import type { ActionRequest, ReapplyExclude, WorkflowRef } from '../../lib/actions/workflow-actions';
import { cancelRequest, deleteWorkflowRequest, pauseRequest, resetRequest, sendAction, signalRequest, terminateRequest, updateRequest } from '../../lib/actions/workflow-actions';
import type { ActivityCommand, ActivityOptionsForm } from '../../lib/actions/activity';
import { activityCommandRequest, completeActivityRequest, failActivityRequest, updateActivityOptionsRequest } from '../../lib/actions/activity';
import { href, P } from '../../routes';
import type { Payload } from '../../lib/payload/decode';
import type { ResetType } from '../../lib/actions/reset-points';
import { firstWorkflowTask, lastWorkflowTask, previousRunId } from '../../lib/actions/reset-points';
import { apiPageFetcher } from '../../lib/history/fetch';
import type { RunStore } from '../../lib/run-store';
import { runStore } from '../../lib/run-store';
import type { Failure } from '../../lib/temporal';
import { eventAttributes, failureMessages, shortEventType } from '../../lib/temporal';

export type WorkflowActionKind =
  | 'signal'
  | 'update'
  | 'cancel'
  | 'terminate'
  | 'reset'
  | 'pause'
  | 'unpause'
  | 'delete'
  | 'activity-complete'
  | 'activity-fail'
  | 'activity-pause'
  | 'activity-unpause'
  | 'activity-reset'
  | 'activity-update-options';

export interface WorkflowDialogProps {
  kind: WorkflowActionKind;
  store: RunStore;
  onClose: () => void;
  /** Called after a successful write (the list refreshes, for example). */
  onDone?: () => void;
  /** Target of the activity-* kinds. */
  activityId?: string;
}

const ref = (s: RunStore): WorkflowRef => ({ ns: s.ns, wf: s.wf, run: s.run });

async function encodedInput(store: RunStore, input: InputValue): Promise<Payload[] | undefined> {
  return encodeForWrite(parseInput(input.text, input.encoding, input.messageType), store.ns);
}

function done(store: RunStore, text: string, onDone?: () => void) {
  showToast({ kind: 'success', text });
  void store.loadDescribe();
  onDone?.();
}

/** Builds the CLI line, or explains why it cannot yet. */
const cliOf = (build: () => ActionRequest) => () => {
  try {
    return build().cli;
  } catch (err) {
    return `# ${err instanceof Error ? err.message : String(err)}`;
  }
};

function NamedPayloadDialog({ kind, store, onClose, onDone }: WorkflowDialogProps & { kind: 'signal' | 'update' }) {
  const defs = store.metadata.value?.definition?.[kind === 'signal' ? 'signalDefinitions' : 'updateDefinitions'] ?? [];
  const [name, setName] = useState(defs[0]?.name ?? '');
  const [input, setInput] = useState<InputValue>(EMPTY_INPUT);
  const build = (payloads?: Payload[]) => (kind === 'signal' ? signalRequest : updateRequest)(ref(store), name.trim(), payloads, input.text);
  const listId = `${kind}-names`;
  return (
    <ActionDialog
      title={kind === 'signal' ? `Signal ${store.wf}` : `Update ${store.wf}`}
      submitLabel={kind === 'signal' ? 'Send signal' : 'Run update'}
      canSubmit={!!name.trim()}
      cli={cliOf(() => build())}
      onClose={onClose}
      onSubmit={async () => {
        const req = build(await encodedInput(store, input));
        const res = await sendAction<{ outcome?: { success?: unknown; failure?: Failure } }>(req);
        if (res?.outcome?.failure) throw new Error(`The update failed: ${failureMessages(res.outcome.failure).join(': ')}`);
        done(store, kind === 'signal' ? `Signal ${name} sent.` : `Update ${name} completed.`, onDone);
      }}
    >
      <label class="field">
        <span>{kind === 'signal' ? 'Signal name' : 'Update name'}</span>
        <input class="input" list={listId} required value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        <datalist id={listId}>
          {defs.map((d) => (
            <option key={d.name} value={d.name} />
          ))}
        </datalist>
      </label>
      <InputEditor value={input} onChange={setInput} />
    </ActionDialog>
  );
}

function CancelDialog({ store, onClose, onDone }: WorkflowDialogProps) {
  const [reason, setReason] = useState('');
  return (
    <ActionDialog
      title={`Cancel ${store.wf}`}
      submitLabel="Request cancellation"
      danger
      cli={cliOf(() => cancelRequest(ref(store), reason))}
      onClose={onClose}
      onSubmit={async () => {
        await sendAction(cancelRequest(ref(store), reason));
        done(store, 'Cancellation requested.', onDone);
      }}
    >
      <p class="muted">The workflow is asked to cancel; its code decides how to clean up.</p>
      <ReasonField value={reason} onInput={setReason} />
    </ActionDialog>
  );
}

function TerminateDialog({ store, onClose, onDone }: WorkflowDialogProps) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [latest, setLatest] = useState(false);
  const firstRunId = store.describe.value?.workflowExecutionInfo?.firstRunId;
  const build = () => terminateRequest(ref(store), reason, latest ? firstRunId : undefined);
  return (
    <ActionDialog
      title={`Terminate ${store.wf}`}
      submitLabel="Terminate"
      danger
      canSubmit={reasonOk(reason, true) && confirmed(store.wf, typed)}
      cli={cliOf(build)}
      onClose={onClose}
      onSubmit={async () => {
        await sendAction(build());
        done(store, 'Workflow terminated.', onDone);
      }}
    >
      <p class="muted">Terminating stops the workflow at once; no cleanup code runs.</p>
      <ReasonField value={reason} onInput={setReason} required />
      {firstRunId && (
        <label class="check">
          <input type="checkbox" checked={latest} onChange={() => setLatest(!latest)} /> Terminate the latest run of this workflow chain instead of this run
        </label>
      )}
      <TypedConfirm expected={store.wf} value={typed} onInput={setTyped} what="the workflow ID" />
    </ActionDialog>
  );
}

const RESET_POINT_TYPES = new Set(['EVENT_TYPE_WORKFLOW_TASK_COMPLETED', 'EVENT_TYPE_WORKFLOW_TASK_FAILED', 'EVENT_TYPE_WORKFLOW_TASK_TIMED_OUT']);

function ResetDialog({ store, onClose, onDone }: WorkflowDialogProps) {
  useEffect(() => {
    void store.history.init();
  }, [store]);
  const events = store.history.events.value;
  const points = useMemo(() => events.filter((e) => RESET_POINT_TYPES.has(e.eventType)), [events]);
  const [point, setPoint] = useState<ResetType | 'event'>('LastWorkflowTask');
  const [eventId, setEventId] = useState('');
  const [reason, setReason] = useState('');
  const [exclude, setExclude] = useState<ReapplyExclude[]>([]);
  const prevRun = previousRunId(events);
  // LastContinuedAsNew resets the previous run of the chain to its last workflow task, as the CLI does.
  const [prev, setPrev] = useState<{ eventId?: string; error?: string } | null>(null);
  useEffect(() => {
    if (point !== 'LastContinuedAsNew' || !prevRun || prev) return;
    apiPageFetcher(store.ns, store.wf, prevRun)('desc', undefined).then(
      (page) => setPrev({ eventId: lastWorkflowTask([...page.events].reverse()) }),
      (err: unknown) => setPrev({ error: err instanceof Error ? err.message : String(err) }),
    );
  }, [point, prevRun]);

  const first = firstWorkflowTask(events);
  const last = lastWorkflowTask(events);
  const target = point === 'FirstWorkflowTask' ? first : point === 'LastWorkflowTask' ? last : point === 'LastContinuedAsNew' ? prev?.eventId : eventId.trim();
  const build = () => {
    if (!target) throw new Error(point === 'LastContinuedAsNew' && !prevRun ? 'This run did not continue from another run.' : 'Pick the workflow task to reset to.');
    if (point === 'LastContinuedAsNew' && prevRun) {
      return resetRequest({ ...ref(store), run: prevRun }, target, reason, exclude, 'LastContinuedAsNew', store.run);
    }
    return resetRequest(ref(store), target, reason, exclude, point === 'event' ? undefined : point);
  };
  const toggle = (x: ReapplyExclude) => setExclude(exclude.includes(x) ? exclude.filter((e) => e !== x) : [...exclude, x]);
  const option = (value: ResetType, label: string, detail: string) => (
    <label class="check">
      <input type="radio" name="reset-point" checked={point === value} onChange={() => setPoint(value)} /> {label} <span class="muted">{detail}</span>
    </label>
  );
  return (
    <ActionDialog
      title={`Reset ${store.wf}`}
      submitLabel="Reset"
      danger
      canSubmit={reasonOk(reason, true) && !!target}
      cli={cliOf(build)}
      onClose={onClose}
      onSubmit={async () => {
        const res = await sendAction<{ runId?: string }>(build());
        done(store, res?.runId ? `Reset done; new run ${res.runId}.` : 'Reset done.', onDone);
      }}
    >
      <p class="muted">A reset starts a new run that replays history up to the chosen workflow task.</p>
      <fieldset class="field">
        <legend>Reset to</legend>
        {option('FirstWorkflowTask', 'First workflow task', first ? `(event ${first})` : '(none loaded)')}
        {option('LastWorkflowTask', 'Last workflow task', last ? `(event ${last})` : '(none loaded)')}
        {option(
          'LastContinuedAsNew',
          'Last workflow task of the previous run',
          !prevRun ? '(this run did not continue as new)' : prev?.error ? `(${prev.error})` : prev?.eventId ? `(run ${prevRun.slice(0, 8)}…, event ${prev.eventId})` : point === 'LastContinuedAsNew' ? '(looking it up…)' : '',
        )}
        <label class="check">
          <input type="radio" name="reset-point" checked={point === 'event'} onChange={() => setPoint('event')} /> A specific event:
          <select class="select" disabled={point !== 'event'} value={eventId} onChange={(e) => setEventId((e.currentTarget as HTMLSelectElement).value)}>
            <option value="">Choose…</option>
            {points.map((e) => (
              <option key={e.eventId} value={e.eventId}>
                {e.eventId} {shortEventType(e.eventType)}
                {typeof eventAttributes(e).identity === 'string' ? ` (${String(eventAttributes(e).identity)})` : ''}
              </option>
            ))}
          </select>
        </label>
        {!store.history.complete.value && <p class="muted">Only loaded events are listed; load the full history on the History tab to see all of them.</p>}
      </fieldset>
      <fieldset class="field">
        <legend>Do not reapply after the reset point</legend>
        <label class="check">
          <input type="checkbox" checked={exclude.includes('signal')} onChange={() => toggle('signal')} /> Signals
        </label>
        <label class="check">
          <input type="checkbox" checked={exclude.includes('update')} onChange={() => toggle('update')} /> Updates
        </label>
      </fieldset>
      <ReasonField value={reason} onInput={setReason} required />
    </ActionDialog>
  );
}

function PauseDialog({ kind, store, onClose, onDone }: WorkflowDialogProps) {
  const pause = kind === 'pause';
  const [reason, setReason] = useState('');
  return (
    <ActionDialog
      title={`${pause ? 'Pause' : 'Unpause'} ${store.wf}`}
      submitLabel={pause ? 'Pause' : 'Unpause'}
      cli={cliOf(() => pauseRequest(ref(store), pause, reason))}
      onClose={onClose}
      onSubmit={async () => {
        await sendAction(pauseRequest(ref(store), pause, reason));
        done(store, pause ? 'Workflow paused.' : 'Workflow unpaused.', onDone);
      }}
    >
      <ReasonField value={reason} onInput={setReason} />
    </ActionDialog>
  );
}

function DeleteDialog({ store, onClose, onDone }: WorkflowDialogProps) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const build = () => deleteWorkflowRequest(ref(store), reason);
  return (
    <ActionDialog
      title={`Delete ${store.wf}`}
      submitLabel="Delete run"
      danger
      canSubmit={reasonOk(reason, true) && confirmed(store.wf, typed)}
      cli={cliOf(build)}
      onClose={onClose}
      onSubmit={async () => {
        await sendAction(build());
        // Deletion is asynchronous: the run stays listed for a few seconds.
        showToast({ kind: 'success', text: `Deleting the run of ${store.wf}; it disappears from the list in a few seconds.` });
        // From a list the caller refreshes; on the run page the run is gone, so go back to the list.
        if (onDone) onDone();
        else window.location.assign(href(P.workflows, { ns: store.ns }));
      }}
    >
      <p class="alert alert-warning">Deleting removes this run and its history for good. A running workflow is terminated first. This cannot be undone.</p>
      <ReasonField value={reason} onInput={setReason} required />
      <TypedConfirm expected={store.wf} value={typed} onInput={setTyped} what="the workflow ID" />
    </ActionDialog>
  );
}

function ActivityDialog({ kind, store, onClose, onDone, activityId = '' }: WorkflowDialogProps) {
  const [result, setResult] = useState<InputValue>(EMPTY_INPUT);
  const [message, setMessage] = useState('');
  const [type, setType] = useState('');
  const [nonRetryable, setNonRetryable] = useState(false);
  const [reason, setReason] = useState('');
  const [options, setOptions] = useState<ActivityOptionsForm>({ startToCloseTimeout: '', scheduleToCloseTimeout: '', heartbeatTimeout: '', maximumAttempts: '' });
  const r = ref(store);
  const build = (payloads?: Payload[]) =>
    kind === 'activity-complete'
      ? completeActivityRequest(r, activityId, payloads, result.text)
      : kind === 'activity-fail'
        ? failActivityRequest(r, activityId, { message, type, nonRetryable })
        : kind === 'activity-update-options'
          ? updateActivityOptionsRequest(r, activityId, options)
          : activityCommandRequest(r, activityId, kind.replace('activity-', '') as ActivityCommand, reason);
  const label =
    { 'activity-complete': 'Complete', 'activity-fail': 'Fail', 'activity-pause': 'Pause', 'activity-unpause': 'Unpause', 'activity-reset': 'Reset', 'activity-update-options': 'Update options of' }[kind as string] ??
    kind;
  const optionField = (key: keyof ActivityOptionsForm, text: string, hint: string) => (
    <label class="field">
      <span>
        {text} <span class="muted">({hint})</span>
      </span>
      <input class="input" value={options[key]} onInput={(e) => setOptions({ ...options, [key]: (e.currentTarget as HTMLInputElement).value })} />
    </label>
  );
  return (
    <ActionDialog
      title={`${label} activity ${activityId}`}
      submitLabel={kind === 'activity-update-options' ? 'Update options' : `${label} activity`}
      danger={kind === 'activity-fail'}
      canSubmit={kind !== 'activity-fail' || !!message.trim()}
      cli={cliOf(() => build(kind === 'activity-complete' ? parseInput(result.text, result.encoding, result.messageType) : undefined))}
      onClose={onClose}
      onSubmit={async () => {
        const payloads = kind === 'activity-complete' ? await encodedInput(store, result) : undefined;
        await sendAction(build(payloads));
        done(store, `Activity ${activityId}: ${label.toLowerCase()} sent.`, onDone);
      }}
    >
      {kind === 'activity-complete' && (
        <>
          <p class="muted">Completes the current attempt with this result, as if the worker had returned it.</p>
          <InputEditor value={result} onChange={setResult} label="Result" />
        </>
      )}
      {kind === 'activity-fail' && (
        <>
          <p class="muted">Fails the current attempt; the retry policy decides whether it runs again unless it is marked non-retryable.</p>
          <label class="field">
            <span>Failure message</span>
            <input class="input" required value={message} onInput={(e) => setMessage((e.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span>
              Error type <span class="muted">(optional)</span>
            </span>
            <input class="input" value={type} onInput={(e) => setType((e.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="check">
            <input type="checkbox" checked={nonRetryable} onChange={() => setNonRetryable(!nonRetryable)} /> Non-retryable
          </label>
        </>
      )}
      {kind === 'activity-pause' && <ReasonField value={reason} onInput={setReason} />}
      {kind === 'activity-update-options' && (
        <>
          <p class="muted">Only the fields you fill in are changed; the rest keep their current values.</p>
          {optionField('startToCloseTimeout', 'Start-to-close timeout', 'e.g. 30s')}
          {optionField('scheduleToCloseTimeout', 'Schedule-to-close timeout', 'e.g. 10m')}
          {optionField('heartbeatTimeout', 'Heartbeat timeout', 'e.g. 15s')}
          {optionField('maximumAttempts', 'Retry maximum attempts', '0 = unlimited')}
        </>
      )}
    </ActionDialog>
  );
}

/** The same dialogs for a run that has no open store yet (the workflow list's row menu). */
export function WorkflowActionDialogForRun({ ns, wf, run, ...rest }: Omit<WorkflowDialogProps, 'store'> & WorkflowRef) {
  const store = useMemo(() => runStore(ns, wf, run), [ns, wf, run]);
  useEffect(() => {
    if (!store.describe.value) void store.loadDescribe();
  }, [store]);
  return <WorkflowActionDialog {...rest} store={store} />;
}

export default function WorkflowActionDialog(props: WorkflowDialogProps) {
  switch (props.kind) {
    case 'signal':
    case 'update':
      return <NamedPayloadDialog {...props} kind={props.kind} />;
    case 'cancel':
      return <CancelDialog {...props} />;
    case 'terminate':
      return <TerminateDialog {...props} />;
    case 'reset':
      return <ResetDialog {...props} />;
    case 'pause':
    case 'unpause':
      return <PauseDialog {...props} />;
    case 'delete':
      return <DeleteDialog {...props} />;
    default:
      return <ActivityDialog {...props} />;
  }
}
