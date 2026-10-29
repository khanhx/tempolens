import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import type { Me } from '../me';
import { textToBase64 } from '../payload/base64';
import { suggest } from './complete';
import { callDenied } from './gate';
import { createHistory, recall } from './history';
import { confirmFor, fieldAt, methodActions, methodMutates, needsReasonHeader, OP, parseMethods, template, WF } from './methods';
import { errorText, listTable, stackText } from './output';
import type { Invoke } from './run';
import { describePlan, runCall } from './run';

class MemoryStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

describe('confirmFor', () => {
  it('extracts the target of every destructive call, in camelCase or proto names', () => {
    expect(confirmFor(`${WF}TerminateWorkflowExecution`, { workflowExecution: { workflowId: 'wf' } })).toEqual({ target: 'wf', what: 'the workflow ID' });
    expect(confirmFor(`${WF}DeleteWorkflowExecution`, { workflow_execution: { workflow_id: 'wf2' } })?.target).toBe('wf2');
    expect(confirmFor(`${WF}StartBatchOperation`, { jobId: 'j', terminationOperation: {} })).toEqual({ target: 'j', what: 'the batch job ID' });
    expect(confirmFor(`${WF}StartBatchOperation`, { job_id: 'j', deletion_operation: {} })?.target).toBe('j');
    expect(confirmFor(`${WF}StopBatchOperation`, { jobId: 'j3' })?.target).toBe('j3');
    expect(confirmFor(`${WF}DeleteSchedule`, { scheduleId: 's' })?.target).toBe('s');
    expect(confirmFor(`${OP}DeleteNamespace`, { namespace: 'ns' })).toEqual({ target: 'ns', what: 'the namespace name' });
    expect(confirmFor(`${OP}RemoveSearchAttributes`, { searchAttributes: ['A', 'B'] })).toEqual({ target: 'A,B', what: 'the attribute names' });
    expect(confirmFor(`${OP}RemoveSearchAttributes`, { search_attributes: ['A'] })).toEqual({ target: 'A', what: 'the attribute name' });
  });

  it('is null for non-destructive calls and gives an empty target when the request names none', () => {
    expect(confirmFor(`${WF}StartBatchOperation`, { jobId: 'j', cancellationOperation: {} })).toBeNull();
    expect(confirmFor(`${WF}DescribeWorkflowExecution`, {})).toBeNull();
    expect(confirmFor(`${WF}TerminateWorkflowExecution`, {})?.target).toBe('');
    expect(confirmFor(`${WF}TerminateWorkflowExecution`, undefined)?.target).toBe('');
  });

  it('only workflow delete needs the reason header', () => {
    expect(needsReasonHeader(`${WF}DeleteWorkflowExecution`)).toBe(true);
    expect(needsReasonHeader(`${WF}TerminateWorkflowExecution`)).toBe(false);
  });
});

describe('methodActions', () => {
  it('mirrors the server policy, including batch kinds and schedule triggers', () => {
    expect(methodActions(`${WF}ListWorkflowExecutions`, {})).toEqual([]);
    expect(methodActions(`${WF}StartBatchOperation`, { terminationOperation: {} })).toEqual(['batch', 'terminate']);
    expect(methodActions(`${WF}StartBatchOperation`, { deletion_operation: {} })).toEqual(['batch', 'batchDelete']);
    expect(methodActions(`${WF}PatchSchedule`, { patch: { pause: 'x' } })).toEqual(['schedule']);
    expect(methodActions(`${WF}PatchSchedule`, { patch: { backfillRequest: [{}] } })).toEqual(['schedule', 'start']);
    expect(methodActions(`${OP}RemoveSearchAttributes`, {})).toEqual(['searchAttribute']);
  });

  it('fieldAt reads either spelling', () => {
    expect(fieldAt({ a_b: { c_d: 1 } }, 'aB.cD')).toBe(1);
    expect(fieldAt({ aB: 2 }, 'aB')).toBe(2);
    expect(fieldAt(null, 'a')).toBeUndefined();
  });
});

describe('parseMethods and template', () => {
  it('accepts strings or objects, in a list or {methods}, and drops other services', () => {
    const list = parseMethods({
      methods: [
        `${WF}ListNamespaces`,
        { method: `${OP}DeleteNamespace`, class: 'admin', namespaceScoped: true },
        'temporal.api.workflowservice.v1.WorkflowService/DescribeNamespace',
        '/grpc.health.v1.Health/Check',
        42,
        `${WF}ListNamespaces`,
      ],
    });
    expect(list.map((m) => m.name)).toEqual(['DeleteNamespace', 'DescribeNamespace', 'ListNamespaces']);
    expect(list[0]).toEqual({ method: `${OP}DeleteNamespace`, name: 'DeleteNamespace', service: 'OperatorService', class: 'ADMIN', namespaceScoped: true });
    expect(methodMutates(list[0] as never)).toBe(true);
    expect(methodMutates(list[2] as never)).toBe(false);
    expect(parseMethods([{ name: `${WF}TerminateWorkflowExecution` }]).map((m) => methodMutates(m))).toEqual([true]);
    expect(() => parseMethods({ nope: 1 })).toThrow(/unexpected shape/);
  });

  it('prefills the namespace and required IDs; unscoped methods get no namespace', () => {
    expect(template(`${WF}TerminateWorkflowExecution`, 'ns')).toEqual({ namespace: 'ns', workflowExecution: { workflowId: '', runId: '' }, reason: '' });
    expect(template(`${WF}ListNamespaces`, 'ns')).toEqual({});
    expect(template(`${WF}SomethingNew`, 'ns')).toEqual({ namespace: 'ns' });
    expect(template(`${WF}SomethingNew`, 'ns', false)).toEqual({});
    const a = template(`${WF}DescribeWorkflowExecution`, 'ns');
    (a.execution as { workflowId: string }).workflowId = 'changed';
    expect(template(`${WF}DescribeWorkflowExecution`, 'ns')).toEqual({ namespace: 'ns', execution: { workflowId: '', runId: '' } });
  });
});

describe('history', () => {
  it('stores lines in session storage, skipping blanks and repeats, up to the limit', () => {
    const storage = new MemoryStorage();
    const h = createHistory(storage, 'k', 3);
    h.push('a');
    h.push('  ');
    h.push('b');
    h.push('b');
    h.push(' c ');
    h.push('d');
    expect(h.entries()).toEqual(['b', 'c', 'd']);
    expect(JSON.parse(storage.getItem('k') as string)).toEqual(['b', 'c', 'd']);
    expect(createHistory(storage, 'k', 3).entries()).toEqual(['b', 'c', 'd']);
    h.clear();
    expect(h.entries()).toEqual([]);
  });

  it('survives corrupt storage, a throwing setItem and no storage', () => {
    const storage = new MemoryStorage();
    storage.setItem('k', '{not json');
    expect(createHistory(storage, 'k').entries()).toEqual([]);
    storage.setItem('k', '["a", 3, "b"]');
    expect(createHistory(storage, 'k').entries()).toEqual(['a', 'b']);
    const throwing = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(() => createHistory(throwing, 'k').push('x')).not.toThrow();
    const none = createHistory(undefined, 'k');
    none.push('x');
    expect(none.entries()).toEqual(['x']);
  });

  it('recall walks up to the oldest and back down to the draft', () => {
    const e = ['a', 'b', 'c'];
    expect(recall(e, null, 'up')).toBe(2);
    expect(recall(e, 2, 'up')).toBe(1);
    expect(recall(e, 0, 'up')).toBe(0);
    expect(recall(e, 1, 'down')).toBe(2);
    expect(recall(e, 2, 'down')).toBeNull();
    expect(recall(e, null, 'down')).toBeNull();
    expect(recall([], null, 'up')).toBeNull();
  });
});

describe('suggest', () => {
  const ns = ['default', 'orders', 'payments'];
  it('completes command words', () => {
    expect(suggest('', ns).items).toEqual(['workflow', 'schedule', 'batch', 'task-queue', 'operator']);
    expect(suggest('wo', ns)).toEqual({ from: 0, items: ['workflow'] });
    expect(suggest('temporal workflow de', ns)).toEqual({ from: 18, items: ['describe', 'delete'] });
    expect(suggest('workflow update ', ns).items).toEqual(['execute', 'start']);
    expect(suggest('cluster h', ns).items).toEqual(['health']);
  });

  it('completes flags, leaving out single flags already used', () => {
    const items = suggest('workflow describe --', ns).items;
    expect(items).toEqual(expect.arrayContaining(['--namespace', '--workflow-id', '--run-id']));
    expect(suggest('workflow describe --workflow-id x --', ns).items).not.toContain('--workflow-id');
    expect(suggest('workflow start -i 1 --in', ns).items).toEqual(['--input']);
  });

  it('completes namespaces and enum values after their flags', () => {
    expect(suggest('workflow list -n or', ns)).toEqual({ from: 17, items: ['orders'] });
    expect(suggest('workflow list --namespace ', ns).items).toEqual(ns);
    expect(suggest('operator namespace describe pa', ns).items).toEqual(['payments']);
    expect(suggest('task-queue describe --task-queue-type a', ns).items).toEqual(['activity']);
    expect(suggest('workflow describe -w ', ns).items).toEqual([]);
  });
});

describe('runCall', () => {
  type Seen = { method: string; request: unknown; confirm?: string; reason?: string };
  const fake = (responses: unknown[]): { invoke: Invoke; seen: Seen[] } => {
    const seen: Seen[] = [];
    return {
      seen,
      invoke: (call, opts) => {
        seen.push({ method: call.method, request: call.request, confirm: opts.confirm, reason: opts.reason });
        return Promise.resolve(responses.shift());
      },
    };
  };

  it('runs a single call with the confirmation and reason', async () => {
    const { invoke, seen } = fake([{ ok: true }]);
    const res = await runCall({ method: 'm', request: { a: 1 }, plan: { kind: 'call' }, confirm: 'wf', reason: 'r' }, invoke);
    expect(res.response).toEqual({ ok: true });
    expect(seen).toEqual([{ method: 'm', request: { a: 1 }, confirm: 'wf', reason: 'r' }]);
  });

  it('execute starts, then long-polls with the run ID and page token until the close event', async () => {
    const close = { eventId: '9', eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED' };
    const { invoke, seen } = fake([{ runId: 'r1' }, { history: { events: [] }, nextPageToken: 't1' }, { history: { events: [close] } }]);
    const wait = { method: 'hist', request: { namespace: 'ns', execution: { workflowId: 'wf' }, waitNewEvent: true } };
    const steps: string[] = [];
    const res = await runCall({ method: 'start', request: { s: 1 }, plan: { kind: 'execute', wait } }, invoke, undefined, (s) => steps.push(s.method));
    expect(res.response).toEqual(close);
    expect(steps).toEqual(['start', 'hist', 'hist']);
    expect(seen[1]?.request).toEqual({ namespace: 'ns', execution: { workflowId: 'wf', runId: 'r1' }, waitNewEvent: true });
    expect(seen[2]?.request).toMatchObject({ nextPageToken: 't1' });
    expect(seen[1]?.confirm).toBeUndefined();
  });

  it('execute polls again after a 504 call timeout', async () => {
    let n = 0;
    const invoke: Invoke = () => {
      n++;
      if (n === 1) return Promise.resolve({ runId: 'r' });
      if (n === 2) return Promise.reject(new ApiError(504, 'deadline', { code: 4 }));
      return Promise.resolve({ history: { events: [{ eventId: '5' }] } });
    };
    const res = await runCall({ method: 's', request: {}, plan: { kind: 'execute', wait: { method: 'h', request: {} } } }, invoke);
    expect(res.response).toEqual({ eventId: '5' });
    expect(n).toBe(3);
  });

  it('execute fails clearly without a run ID, and stops when aborted', async () => {
    await expect(runCall({ method: 's', request: {}, plan: { kind: 'execute', wait: { method: 'h', request: {} } } }, fake([{}]).invoke)).rejects.toThrow(/no run ID/);
    const ctrl = new AbortController();
    const { invoke } = fake([{ runId: 'r' }, { history: { events: [] } }]);
    const run = runCall({ method: 's', request: {}, plan: { kind: 'execute', wait: { method: 'h', request: {} } } }, invoke, ctrl.signal, (s) => {
      if (s.method === 'h') ctrl.abort();
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reset-to-task finds the completed workflow task across pages, then resets to it', async () => {
    const { invoke, seen } = fake([
      { history: { events: [{ eventId: '12', eventType: 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED' }] }, nextPageToken: 'p2' },
      { history: { events: [{ eventId: '8', eventType: 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED' }] } },
      { runId: 'new' },
    ]);
    const lookup = { method: 'reverse', request: { namespace: 'ns', maximumPageSize: 100 } };
    const res = await runCall({ method: 'reset', request: { reason: 'r' }, plan: { kind: 'reset-to-task', which: 'last', lookup } }, invoke);
    expect(res.response).toEqual({ runId: 'new' });
    expect(seen.map((s) => s.method)).toEqual(['reverse', 'reverse', 'reset']);
    expect(seen[1]?.request).toMatchObject({ nextPageToken: 'p2' });
    expect(seen[2]?.request).toEqual({ reason: 'r', workflowTaskFinishEventId: '8' });
  });

  it('reset-to-task reports when there is no workflow task', async () => {
    const { invoke } = fake([{ history: { events: [] } }]);
    await expect(runCall({ method: 'reset', request: {}, plan: { kind: 'reset-to-task', which: 'first', lookup: { method: 'h', request: {} } } }, invoke)).rejects.toThrow(/No completed workflow task/);
  });

  it('describePlan lists the steps', () => {
    expect(describePlan({ method: `${WF}X`, request: {}, plan: { kind: 'call' } })).toEqual(['X']);
    expect(describePlan({ method: `${WF}Start`, request: {}, plan: { kind: 'execute', wait: { method: `${WF}Hist`, request: {} } } })).toHaveLength(2);
  });
});

describe('output', () => {
  it('tables the list responses the console knows', () => {
    const t = listTable(`${WF}ListWorkflowExecutions`, {
      executions: [{ execution: { workflowId: 'w', runId: 'r' }, type: { name: 'T' }, status: 'WORKFLOW_EXECUTION_STATUS_RUNNING', startTime: 's', taskQueue: 'q' }],
    });
    expect(t?.columns[0]).toBe('Workflow ID');
    expect(t?.rows).toEqual([['w', 'r', 'T', 'WORKFLOW_EXECUTION_STATUS_RUNNING', 's', '', 'q']]);
    expect(listTable(`${WF}ListNamespaces`, {})?.rows).toEqual([]);
    expect(listTable(`${WF}ListSchedules`, { schedules: [{ scheduleId: 's', info: { paused: true } }] })?.rows).toEqual([['s', '', 'true', '']]);
    expect(listTable(`${OP}ListSearchAttributes`, { customAttributes: { B: 'INDEXED_VALUE_TYPE_INT', A: 'INDEXED_VALUE_TYPE_KEYWORD' }, systemAttributes: { WorkflowId: 'INDEXED_VALUE_TYPE_KEYWORD' } })?.rows).toEqual([
      ['A', 'KEYWORD', 'Custom'],
      ['B', 'INT', 'Custom'],
      ['WorkflowId', 'KEYWORD', 'System'],
    ]);
    expect(listTable(`${WF}DescribeWorkflowExecution`, {})).toBeNull();
  });

  it('decodes the stack trace text', () => {
    const payload = { metadata: { encoding: textToBase64('json/plain') }, data: textToBase64(JSON.stringify('goroutine 1')) };
    expect(stackText({ queryResult: { payloads: [payload] } })).toBe('goroutine 1');
    expect(stackText({})).toBeNull();
  });

  it('formats API errors with status and gRPC code', () => {
    expect(errorText(new ApiError(403, 'denied', { code: 7 }))).toBe('HTTP 403 PermissionDenied: denied');
    expect(errorText(new ApiError(429, 'slow down', { code: 8, retryAfterMs: 2500 }))).toBe('HTTP 429 ResourceExhausted: slow down Retry in 3 s.');
    expect(errorText(new ApiError(0, 'Network error: x'))).toBe('Network: Network error: x');
    expect(errorText(new Error('plain'))).toBe('plain');
  });
});

describe('callDenied', () => {
  const user = (role: Me['role'], disabledActions: Me['settings']['disabledActions'] = []): Me =>
    ({ user: null, role, authEnabled: true, settings: { defaultNamespace: 'default', showSystemNamespace: false, disabledActions, codec: {}, limits: {}, version: '' } }) as unknown as Me;

  it('lets everyone read and gates writes by role and disabled actions', () => {
    expect(callDenied(false, [], user('read'))).toBeNull();
    expect(callDenied(true, ['terminate'], user('read'))).toMatch(/needs write access/);
    expect(callDenied(true, ['terminate'], user('write'))).toBeNull();
    expect(callDenied(true, ['terminate'], user('write', ['terminate']))).toMatch(/Disabled on this server/);
    expect(callDenied(true, [], user('read'))).toMatch(/needs write access/);
  });

  it('admin operations need the admin role', () => {
    expect(callDenied(true, ['namespace'], user('write'))).toMatch(/needs admin access/);
    expect(callDenied(true, ['namespace'], user('admin'))).toBeNull();
    expect(callDenied(true, [], user('write'), true)).toMatch(/needs admin access/);
  });
});
