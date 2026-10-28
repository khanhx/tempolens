// Single-workflow writes. Each builder returns the request (path + body,
// exactly the proto JSON fields, because the server rejects unknown fields)
// and the equivalent CLI command. `identity` is never sent: the server
// stamps it.
import { request, seg } from '../api';
import type { Payload } from '../payload/decode';
import { cliCommand } from './cli-command';

export interface ActionRequest {
  method: 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  /** Typed target the server requires for destructive actions (contract §1.6). */
  confirm?: string;
  /** Reason sent as a header, for writes whose request has no reason field. */
  reason?: string;
  cli: string;
}

export interface WorkflowRef {
  ns: string;
  wf: string;
  run: string;
}

/** Sends a built request. */
export function sendAction<T = unknown>(r: ActionRequest): Promise<T> {
  return request<T>(r.path, { method: r.method, body: r.body, query: r.query, confirm: r.confirm, reason: r.reason });
}

const base = (r: WorkflowRef) => `/api/v1/namespaces/${seg(r.ns)}/workflows/${seg(r.wf)}`;
const execution = (r: WorkflowRef) => ({ workflowId: r.wf, runId: r.run });
const ids = (r: WorkflowRef, withRun = true) =>
  [
    ['namespace', r.ns],
    ['workflow-id', r.wf],
    ['run-id', withRun ? r.run : undefined],
  ] as const;

const uuid = () => crypto.randomUUID();

/** `inputText` is the user's JSON text, used for the CLI line only. */
export function signalRequest(r: WorkflowRef, name: string, input: Payload[] | undefined, inputText = ''): ActionRequest {
  return {
    method: 'POST',
    path: `${base(r)}/signal/${seg(name)}`,
    body: { workflowExecution: execution(r), requestId: uuid(), ...(input ? { input: { payloads: input } } : {}) },
    cli: cliCommand(['workflow', 'signal'], [...ids(r), ['name', name], ['input', inputText.trim() || undefined]]),
  };
}

export function updateRequest(r: WorkflowRef, name: string, input: Payload[] | undefined, inputText = ''): ActionRequest {
  return {
    method: 'POST',
    path: `${base(r)}/update/${seg(name)}`,
    body: {
      workflowExecution: execution(r),
      waitPolicy: { lifecycleStage: 'UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_COMPLETED' },
      request: { meta: { updateId: uuid() }, input: { name, ...(input ? { args: { payloads: input } } : {}) } },
    },
    cli: cliCommand(['workflow', 'update', 'execute'], [...ids(r), ['name', name], ['input', inputText.trim() || undefined]]),
  };
}

export function cancelRequest(r: WorkflowRef, reason = ''): ActionRequest {
  return {
    method: 'POST',
    path: `${base(r)}/cancel`,
    body: { workflowExecution: execution(r), requestId: uuid(), ...(reason.trim() ? { reason: reason.trim() } : {}) },
    cli: cliCommand(['workflow', 'cancel'], ids(r)),
  };
}

/**
 * Terminate. With `firstExecutionRunId` the latest run of the chain is
 * terminated (no runId is sent), as upstream's "terminate latest" does.
 */
export function terminateRequest(r: WorkflowRef, reason: string, firstExecutionRunId?: string): ActionRequest {
  const latest = !!firstExecutionRunId;
  return {
    method: 'POST',
    path: `${base(r)}/terminate`,
    body: {
      workflowExecution: latest ? { workflowId: r.wf } : execution(r),
      reason: reason.trim(),
      ...(latest ? { firstExecutionRunId } : {}),
    },
    confirm: r.wf,
    cli: cliCommand(['workflow', 'terminate'], [...ids(r, !latest), ['reason', reason.trim()]]),
  };
}

export type ReapplyExclude = 'signal' | 'update';

/**
 * Reset to the end of a workflow task. Never carries postResetOperations
 * (the server forbids them). `cliType` writes the CLI line with `--type`
 * (FirstWorkflowTask, LastWorkflowTask, LastContinuedAsNew) instead of the event ID.
 */
export function resetRequest(r: WorkflowRef, eventId: string, reason: string, exclude: readonly ReapplyExclude[] = [], cliType?: string, cliRunId?: string): ActionRequest {
  return {
    method: 'POST',
    path: `${base(r)}/reset`,
    body: {
      workflowExecution: execution(r),
      reason: reason.trim(),
      workflowTaskFinishEventId: eventId,
      requestId: uuid(),
      resetReapplyExcludeTypes: exclude.map((e) => `RESET_REAPPLY_EXCLUDE_TYPE_${e.toUpperCase()}`),
    },
    cli: cliCommand(
      ['workflow', 'reset'],
      [
        ['namespace', r.ns],
        ['workflow-id', r.wf],
        ['run-id', cliRunId ?? r.run],
        cliType ? ['type', cliType] : ['event-id', eventId],
        ['reason', reason.trim()],
        ['reapply-exclude', exclude.map((e) => (e === 'signal' ? 'Signal' : 'Update'))],
      ],
    ),
  };
}

export function pauseRequest(r: WorkflowRef, pause: boolean, reason = ''): ActionRequest {
  return {
    method: 'POST',
    path: `/api/v1/namespaces/${seg(r.ns)}/workflows/${seg(r.wf)}/${pause ? 'pause' : 'unpause'}`,
    body: { runId: r.run, requestId: uuid(), ...(reason.trim() ? { reason: reason.trim() } : {}) },
    cli: cliCommand(['workflow', pause ? 'pause' : 'unpause'], [...ids(r), ['reason', reason.trim() || undefined]]),
  };
}

export interface StartForm {
  ns: string;
  workflowId: string;
  workflowType: string;
  taskQueue: string;
  input?: Payload[];
  inputText?: string;
  summary?: Payload;
  details?: Payload;
  searchAttributes?: Record<string, Payload>;
  /** Protobuf duration, e.g. `"30s"`. */
  startDelay?: string;
}

/** StartWorkflowExecution; `execute` only changes the CLI line (`temporal workflow execute` waits for the result). */
export function startRequest(f: StartForm, execute = false): ActionRequest {
  const userMetadata = f.summary || f.details ? { ...(f.summary ? { summary: f.summary } : {}), ...(f.details ? { details: f.details } : {}) } : undefined;
  return {
    method: 'POST',
    path: `/api/v1/namespaces/${seg(f.ns)}/workflows/${seg(f.workflowId)}`,
    body: {
      workflowType: { name: f.workflowType },
      taskQueue: { name: f.taskQueue },
      requestId: uuid(),
      ...(f.input ? { input: { payloads: f.input } } : {}),
      ...(userMetadata ? { userMetadata } : {}),
      ...(f.searchAttributes && Object.keys(f.searchAttributes).length ? { searchAttributes: { indexedFields: f.searchAttributes } } : {}),
      ...(f.startDelay ? { workflowStartDelay: f.startDelay } : {}),
    },
    cli: cliCommand(
      ['workflow', execute ? 'execute' : 'start'],
      [
        ['namespace', f.ns],
        ['workflow-id', f.workflowId],
        ['type', f.workflowType],
        ['task-queue', f.taskQueue],
        ['input', f.inputText?.trim() || undefined],
        ['start-delay', f.startDelay],
      ],
    ),
  };
}

/** Deletes a run (or the current run when `run` is empty). Needs the typed workflow ID and a reason header. */
export function deleteWorkflowRequest(r: WorkflowRef, reason: string): ActionRequest {
  if (!reason.trim()) throw new Error('A reason is required.');
  return {
    method: 'DELETE',
    path: '/api/x/workflow',
    query: { namespace: r.ns, workflowId: r.wf, ...(r.run ? { runId: r.run } : {}) },
    confirm: r.wf,
    reason: reason.trim(),
    cli: cliCommand(['workflow', 'delete'], [...ids(r), ['reason', reason.trim()]]),
  };
}

export interface SignalWithStartForm extends StartForm {
  signalName: string;
  signalInput?: Payload[];
  signalInputText?: string;
}

/** Signals a workflow, starting it first if it is not running. */
export function signalWithStartRequest(f: SignalWithStartForm): ActionRequest {
  if (!f.signalName.trim()) throw new Error('A signal name is required.');
  const start = startRequest(f);
  const body = { ...(start.body as Record<string, unknown>), ...(f.signalInput ? { signalInput: { payloads: f.signalInput } } : {}) };
  return {
    method: 'POST',
    path: `/api/v1/namespaces/${seg(f.ns)}/workflows/${seg(f.workflowId)}/signal-with-start/${seg(f.signalName.trim())}`,
    body,
    cli: cliCommand(
      ['workflow', 'signal-with-start'],
      [
        ['namespace', f.ns],
        ['workflow-id', f.workflowId],
        ['type', f.workflowType],
        ['task-queue', f.taskQueue],
        ['input', f.inputText?.trim() || undefined],
        ['start-delay', f.startDelay],
        ['signal-name', f.signalName.trim()],
        ['signal-input', f.signalInputText?.trim() || undefined],
      ],
    ),
  };
}
