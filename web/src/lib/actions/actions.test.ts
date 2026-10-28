import { describe, expect, it, vi } from 'vitest';
import { canAll, deniedReason, parseMe, SCHEDULE_GATES, WRITE_ACTIONS } from '../me';
import type { WriteAction } from '../me';
import { base64ToText, textToBase64 } from '../payload/base64';
import { readCodecOverride, resolveCodec } from '../payload/codec';
import { BATCH_ACTION, batchQuery, batchRequest, MAX_SELECTION, selectionQuery, stopBatchRequest } from './batch';
import { cliCommand, shellQuote } from './cli-command';
import { encodeForWrite, encodeValue, parseInput } from './encode';
import { createEndpointRequest, deleteEndpointRequest, endpointSpec } from './nexus';
import type { ScheduleForm, SpecForm } from './schedule';
import {
  backfillScheduleRequest,
  buildSpec,
  createScheduleRequest,
  describeSpec,
  EMPTY_SPEC_FORM,
  pauseScheduleRequest,
  specToForm,
  triggerScheduleRequest,
} from './schedule';
import { cancelRequest, deleteWorkflowRequest, resetRequest, signalRequest, signalWithStartRequest, startRequest, terminateRequest, updateRequest } from './workflow-actions';
import { ACTIVITY_COMMANDS_MIN_VERSION, completeActivityRequest, failActivityRequest, updateActivityOptionsRequest, versionAtLeast } from './activity';
import {
  addSearchAttributeRequest,
  deleteNamespaceRequest,
  humanRetention,
  protectedReason,
  registerNamespaceRequest,
  removeSearchAttributesRequest,
  updateNamespaceRequest,
} from './admin';

const ref = { ns: 'tui-seed-a', wf: 'order 42 "x"', run: 'r-1' };
const dec = (b64: string | undefined) => base64ToText(b64 ?? '');

describe('cli-command', () => {
  it('quotes values with spaces and quotes', () => {
    expect(shellQuote('plain-id_1')).toBe('plain-id_1');
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
    expect(shellQuote('a "b"')).toBe(`'a "b"'`);
  });

  it('builds commands with namespace, ids, JSON input and repeated flags', () => {
    expect(signalRequest(ref, 'poke', undefined, '{"n": 1}').cli).toBe(
      `temporal workflow signal --namespace tui-seed-a --workflow-id 'order 42 "x"' --run-id r-1 --name poke --input '{"n": 1}'`,
    );
    expect(terminateRequest(ref, 'stuck in prod').cli).toBe(
      `temporal workflow terminate --namespace tui-seed-a --workflow-id 'order 42 "x"' --run-id r-1 --reason 'stuck in prod'`,
    );
    expect(cliCommand(['x'], [['f', ['a', 'b']], ['empty', ''], ['off', false], ['on', true]])).toBe('temporal x --f a --f b --on');
  });
});

describe('encode', () => {
  it('encodes json/plain and json/protobuf', () => {
    const plain = encodeValue({ id: 9007199254740993n });
    expect(dec(plain.metadata?.encoding)).toBe('json/plain');
    expect(dec(plain.data)).toBe('{"id":9007199254740993}');
    const proto = encodeValue({ a: 1 }, 'json/protobuf', 'my.pkg.Msg');
    expect(dec(proto.metadata?.encoding)).toBe('json/protobuf');
    expect(dec(proto.metadata?.messageType)).toBe('my.pkg.Msg');
    expect(() => encodeValue(1, 'json/protobuf', '')).toThrow(/message type/);
  });

  it('parses input, passing raw payloads through', () => {
    expect(parseInput('  ')).toBeUndefined();
    const raw = { metadata: { encoding: textToBase64('binary/encrypted') }, data: 'AAEC' };
    expect(parseInput(JSON.stringify(raw))).toEqual([raw]);
    expect(dec(parseInput('"hi"')?.[0]?.data)).toBe('"hi"');
    expect(() => parseInput('{bad')).toThrow(/not valid JSON/);
  });

  it('calls the codec /encode when configured', async () => {
    const encoded = { metadata: { encoding: textToBase64('binary/encrypted') }, data: 'Zm9v' };
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ payloads: [encoded] })));
    const cfg = { endpoint: 'https://codec.test', includeCredentials: false, defaultErrorMessage: '', defaultErrorLink: '' };
    await expect(encodeForWrite([encodeValue(1)], 'ns', cfg, fetchFn)).resolves.toEqual([encoded]);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe('https://codec.test/encode');
    await expect(encodeForWrite([encodeValue(1)], 'ns', null)).resolves.toHaveLength(1);
  });

  it('resolves the codec override as upstream does', () => {
    const server = { endpoint: 'https://server', includeCredentials: false, defaultErrorMessage: 'm', defaultErrorLink: '' };
    expect(resolveCodec(server, { endpoint: 'http://local', includeCredentials: true, override: false })?.endpoint).toBe('https://server');
    expect(resolveCodec(server, { endpoint: '  ', includeCredentials: true, override: true })?.endpoint).toBe('https://server');
    expect(resolveCodec(server, { endpoint: 'http://local', includeCredentials: true, override: true })).toMatchObject({ endpoint: 'http://local', includeCredentials: true, defaultErrorMessage: 'm' });
    expect(resolveCodec(undefined, { endpoint: '', includeCredentials: false, override: false })).toBeNull();
    const store = new Map([['endpoint', '"http://x"'], ['overrideRemoteCodecConfiguration', 'true']]);
    expect(readCodecOverride({ getItem: (k) => store.get(k) ?? null, setItem: () => undefined })).toEqual({ endpoint: 'http://x', includeCredentials: false, override: true });
  });
});

describe('workflow action bodies', () => {
  it('uses only proto fields and never sends identity', () => {
    const all = [
      signalRequest(ref, 's', undefined),
      updateRequest(ref, 'u', [encodeValue(1)]),
      cancelRequest(ref),
      terminateRequest(ref, 'r'),
      resetRequest(ref, '4', 'r', ['signal']),
      startRequest({ ns: 'a', workflowId: 'w', workflowType: 't', taskQueue: 'q' }),
    ];
    for (const r of all) expect(JSON.stringify(r.body)).not.toContain('identity');
    expect(updateRequest(ref, 'u', undefined).path).toBe('/api/v1/namespaces/tui-seed-a/workflows/order%2042%20%22x%22/update/u');
  });

  it('terminates the latest run through firstExecutionRunId', () => {
    expect(terminateRequest(ref, ' why ', 'first-run').body).toEqual({ workflowExecution: { workflowId: ref.wf }, reason: 'why', firstExecutionRunId: 'first-run' });
    expect(terminateRequest(ref, 'why').body).toEqual({ workflowExecution: { workflowId: ref.wf, runId: 'r-1' }, reason: 'why' });
  });

  it('resets with exclude types and without postResetOperations', () => {
    const body = resetRequest(ref, '7', 'bad deploy', ['signal', 'update']).body as Record<string, unknown>;
    expect(body).toMatchObject({ workflowTaskFinishEventId: '7', reason: 'bad deploy', resetReapplyExcludeTypes: ['RESET_REAPPLY_EXCLUDE_TYPE_SIGNAL', 'RESET_REAPPLY_EXCLUDE_TYPE_UPDATE'] });
    expect(body).not.toHaveProperty('postResetOperations');
  });

  it('builds a start request with metadata and search attributes', () => {
    const r = startRequest({ ns: 'a', workflowId: 'w/1', workflowType: 't', taskQueue: 'q', summary: encodeValue('s'), searchAttributes: { SeedRun: encodeValue('t2') }, startDelay: '30s' });
    expect(r.path).toBe('/api/v1/namespaces/a/workflows/w%2F1');
    expect(r.body).toMatchObject({ workflowType: { name: 't' }, taskQueue: { name: 'q' }, userMetadata: { summary: {} }, searchAttributes: { indexedFields: { SeedRun: {} } }, workflowStartDelay: '30s' });
  });
});

describe('batch', () => {
  it('turns a selection into a quoted RunId OR-query, capped at 100', () => {
    expect(selectionQuery(['a', 'b"c', 'a'])).toBe('RunId = "a" OR RunId = "b\\"c"');
    expect(() => selectionQuery([])).toThrow();
    expect(() => selectionQuery(Array.from({ length: MAX_SELECTION + 1 }, (_, i) => `r${i}`))).toThrow(/100/);
    expect(selectionQuery(Array.from({ length: MAX_SELECTION }, (_, i) => `r${i}`)).split(' OR ')).toHaveLength(100);
  });

  it('wraps the target and narrows cancel/terminate to running workflows', () => {
    expect(batchQuery('terminate', 'RunId = "a" OR RunId = "b"')).toBe('(RunId = "a" OR RunId = "b") AND ExecutionStatus = "Running"');
    expect(batchQuery('cancel', '')).toBe('ExecutionStatus = "Running"');
    expect(batchQuery('reset', 'WorkflowType = "x" ORDER BY StartTime')).toBe('WorkflowType = "x"');
  });

  it('sends visibilityQuery only, never executions, and reset without postResetOperations', () => {
    const t = batchRequest('ns', 'terminate', 'q', 'r', 'last', 'job-1');
    expect(t.path).toBe('/api/v1/namespaces/ns/batch-operations/job-1');
    expect(t.body).toEqual({ visibilityQuery: 'q', reason: 'r', terminationOperation: {} });
    const reset = batchRequest('ns', 'reset', 'q', 'r', 'first', 'job-2').body as Record<string, unknown>;
    expect(reset).toEqual({ visibilityQuery: 'q', reason: 'r', resetOperation: { options: { firstWorkflowTask: {} } } });
    for (const b of [t.body, reset, batchRequest('ns', 'cancel', 'q', 'r').body]) {
      expect(JSON.stringify(b)).not.toMatch(/executions|targetExecutions|postResetOperations|identity/i);
    }
    expect(() => batchRequest('ns', 'cancel', 'q', '  ')).toThrow(/reason/);
    expect(() => batchRequest('ns', 'cancel', '', 'r')).toThrow(/query/);
    expect(stopBatchRequest('ns', 'job-1', 'oops').body).toEqual({ reason: 'oops' });
  });
});

describe('schedule spec', () => {
  const form = (over: Partial<SpecForm>): SpecForm => ({ ...EMPTY_SPEC_FORM, ...over });

  it('round-trips interval, weekdays, monthdays and cron', () => {
    for (const f of [
      form({ mode: 'interval', every: '90m', offset: '5m' }),
      form({ mode: 'weekdays', days: [1, 3, 5], hour: 9, minute: 30 }),
      form({ mode: 'monthdays', days: [1, 15], hour: 23, minute: 0 }),
      form({ mode: 'cron', cron: '0 */2 * * *' }),
    ]) {
      const back = specToForm(buildSpec(f));
      expect(back.mode, f.mode).toBe(f.mode);
      expect(buildSpec(back)).toEqual(buildSpec(f));
    }
    expect(buildSpec(form({ mode: 'interval', every: '1h30m' }))).toEqual({ interval: [{ interval: '5400s' }] });
  });

  it('reads the server-normalised calendar back as weekdays', () => {
    const normalised = {
      structuredCalendar: [{ second: [{ start: 0 }], minute: [{ start: 30 }], hour: [{ start: 9 }], dayOfMonth: [{ start: 1, end: 31 }], month: [{ start: 1, end: 12 }], dayOfWeek: [{ start: 1 }, { start: 5 }] }],
    };
    expect(specToForm(normalised)).toMatchObject({ mode: 'weekdays', days: [1, 5], hour: 9, minute: 30 });
    expect(describeSpec(normalised)).toBe('Mon, Fri at 09:30 UTC');
    const odd = { structuredCalendar: [{ hour: [{ start: 1, end: 5, step: 2 }] }] };
    expect(specToForm(odd).mode).toBe('calendar');
    expect(buildSpec(specToForm(odd))).toEqual(odd);
  });

  it('validates', () => {
    expect(() => buildSpec(form({ mode: 'interval', every: 'soon' }))).toThrow(/duration/);
    expect(() => buildSpec(form({ mode: 'weekdays', days: [] }))).toThrow(/day/);
    expect(() => buildSpec(form({ mode: 'weekdays', days: [7] }))).toThrow(/Weekday/);
    expect(() => buildSpec(form({ mode: 'calendar', calendar: '{' }))).toThrow(/JSON/);
  });

  it('builds create and patch bodies', () => {
    const f: ScheduleForm = {
      ns: 'a',
      scheduleId: 's1',
      workflowId: 'w',
      workflowType: 't',
      taskQueue: 'q',
      spec: form({ mode: 'interval', every: '1h' }),
      timezone: 'Asia/Saigon',
      jitter: '30s',
      overlap: 'SCHEDULE_OVERLAP_POLICY_SKIP',
      catchupWindow: '',
      pauseOnFailure: true,
      paused: false,
      notes: '',
    };
    expect(createScheduleRequest(f).body).toMatchObject({
      schedule: {
        spec: { interval: [{ interval: '3600s' }], timezoneName: 'Asia/Saigon', jitter: '30s' },
        action: { startWorkflow: { workflowId: 'w', workflowType: { name: 't' }, taskQueue: { name: 'q' } } },
        policies: { overlapPolicy: 'SCHEDULE_OVERLAP_POLICY_SKIP', pauseOnFailure: true },
        state: { paused: false },
      },
    });
    expect(pauseScheduleRequest('a', 's1', true, 'maintenance').body).toMatchObject({ patch: { pause: 'maintenance' } });
    expect(pauseScheduleRequest('a', 's1', false, '').body).toMatchObject({ patch: { unpause: 'Unpaused from Tempolens' } });
    const trig = triggerScheduleRequest('a', 's1', 'SCHEDULE_OVERLAP_POLICY_ALLOW_ALL');
    expect(trig.body).toMatchObject({ patch: { triggerImmediately: { overlapPolicy: 'SCHEDULE_OVERLAP_POLICY_ALLOW_ALL' } } });
    expect(trig.cli).toBe('temporal schedule trigger --namespace a --schedule-id s1 --overlap-policy AllowAll');
    expect(backfillScheduleRequest('a', 's1', '2026-10-27T00:00:00Z', '2026-10-27T06:00:00Z', 'SCHEDULE_OVERLAP_POLICY_BUFFER_ALL').body).toMatchObject({
      patch: { backfillRequest: [{ startTime: '2026-10-27T00:00:00.000Z', endTime: '2026-10-27T06:00:00.000Z', overlapPolicy: 'SCHEDULE_OVERLAP_POLICY_BUFFER_ALL' }] },
    });
    expect(() => backfillScheduleRequest('a', 's1', '2026-10-27T06:00:00Z', '2026-10-27T00:00:00Z', 'SCHEDULE_OVERLAP_POLICY_SKIP')).toThrow(/after/);
  });
});

describe('nexus', () => {
  it('validates and builds endpoint requests', () => {
    expect(() => endpointSpec({ name: '1bad', description: '', targetNamespace: 'a', targetTaskQueue: 'q' })).toThrow();
    const spec = endpointSpec({ name: 'ep_1', description: 'hi', targetNamespace: 'a', targetTaskQueue: 'q' });
    expect(createEndpointRequest(spec).body).toMatchObject({ spec: { name: 'ep_1', target: { worker: { namespace: 'a', taskQueue: 'q' } } } });
    expect(deleteEndpointRequest('id/1', '3', 'ep_1')).toMatchObject({ method: 'DELETE', path: '/api/v1/nexus/endpoints/id%2F1', query: { version: '3' } });
  });
});

describe('role gating', () => {
  const mk = (role: 'read' | 'write', disabled: WriteAction[]) =>
    parseMe({ role, settings: { disabledActions: disabled } });

  it('matches role × disabledActions', () => {
    for (const role of ['read', 'write'] as const) {
      for (const a of WRITE_ACTIONS) {
        expect(canAll([a], mk(role, [])), `${role} ${a}`).toBe(role === 'write');
        expect(canAll([a], mk(role, [a])), `${role} ${a} disabled`).toBe(false);
      }
    }
    expect(canAll(SCHEDULE_GATES.trigger, mk('write', ['start']))).toBe(false);
    expect(canAll(SCHEDULE_GATES.pause, mk('write', ['start']))).toBe(true);
    expect(canAll(['batch', 'reset'], mk('write', ['reset']))).toBe(false);
    expect(canAll([], mk('read', []))).toBe(false);
    expect(deniedReason(['terminate'], mk('read', []))).toMatch(/write group/);
    expect(deniedReason(['terminate'], mk('write', ['terminate']))).toMatch(/Disabled/);
    expect(deniedReason(['terminate'], mk('write', []))).toBeNull();
  });
});

describe('reset types', () => {
  const e = (id: number, type: string, attrs: Record<string, unknown> = {}) => ({
    eventId: String(id),
    eventType: `EVENT_TYPE_${type}`,
    [type === 'WORKFLOW_EXECUTION_STARTED' ? 'workflowExecutionStartedEventAttributes' : 'x']: attrs,
  });
  const events = [
    e(1, 'WORKFLOW_EXECUTION_STARTED', { continuedExecutionRunId: 'prev-run' }),
    e(2, 'WORKFLOW_TASK_SCHEDULED'),
    e(4, 'WORKFLOW_TASK_COMPLETED'),
    e(9, 'WORKFLOW_TASK_COMPLETED'),
    e(10, 'WORKFLOW_TASK_FAILED'),
  ];

  it('computes the CLI reset points', async () => {
    const { firstWorkflowTask, lastWorkflowTask, previousRunId } = await import('./reset-points');
    expect(firstWorkflowTask(events)).toBe('4');
    expect(lastWorkflowTask(events)).toBe('9');
    expect(previousRunId(events)).toBe('prev-run');
    expect(previousRunId(events.slice(1))).toBeUndefined();
    expect(lastWorkflowTask([])).toBeUndefined();
  });

  it('writes --type on the CLI line and keeps the event ID in the body', () => {
    const r = resetRequest({ ns: 'a', wf: 'w', run: 'prev-run' }, '9', 'why', [], 'LastContinuedAsNew', 'cur-run');
    expect(r.cli).toBe('temporal workflow reset --namespace a --workflow-id w --run-id cur-run --type LastContinuedAsNew --reason why');
    expect(r.body).toMatchObject({ workflowExecution: { workflowId: 'w', runId: 'prev-run' }, workflowTaskFinishEventId: '9' });
  });
});

describe('typed confirmation header', () => {
  it('sends X-Tempolens-Confirm when a request carries confirm', async () => {
    const { sendAction } = await import('./workflow-actions');
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendAction({ method: 'DELETE', path: '/x', confirm: 'tui-test-ns', cli: '' });
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)['X-Tempolens-Confirm']).toBe('tui-test-ns');
    await sendAction({ method: 'POST', path: '/y', body: {}, cli: '' });
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>)['X-Tempolens-Confirm']).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe('CLI-parity workflow requests', () => {
  const ref = { ns: 'a', wf: 'w/1', run: 'r1' };

  it('deletes through /api/x with the typed ID and a reason header', () => {
    const r = deleteWorkflowRequest(ref, '  cleanup ');
    expect(r).toMatchObject({ method: 'DELETE', path: '/api/x/workflow', query: { namespace: 'a', workflowId: 'w/1', runId: 'r1' }, confirm: 'w/1', reason: 'cleanup' });
    expect(r.body).toBeUndefined();
    expect(r.cli).toBe('temporal workflow delete --namespace a --workflow-id w/1 --run-id r1 --reason cleanup');
    expect(() => deleteWorkflowRequest(ref, ' ')).toThrow(/reason/);
    expect(deleteWorkflowRequest({ ...ref, run: '' }, 'x').query).toEqual({ namespace: 'a', workflowId: 'w/1' });
  });

  it('signals with start on the gateway path, carrying the start fields', () => {
    const f = { ns: 'a', workflowId: 'w/1', workflowType: 'T', taskQueue: 'q', signalName: 'go', signalInput: [encodeValue(1)], signalInputText: '1' };
    const r = signalWithStartRequest(f);
    expect(r.path).toBe('/api/v1/namespaces/a/workflows/w%2F1/signal-with-start/go');
    expect(r.body).toMatchObject({ workflowType: { name: 'T' }, taskQueue: { name: 'q' }, signalInput: { payloads: [expect.anything()] } });
    expect(r.cli).toBe('temporal workflow signal-with-start --namespace a --workflow-id w/1 --type T --task-queue q --signal-name go --signal-input 1');
    expect(() => signalWithStartRequest({ ...f, signalName: ' ' })).toThrow(/signal name/);
  });

  it('writes `workflow execute` for execute mode with the same body', () => {
    const f = { ns: 'a', workflowId: 'w', workflowType: 'T', taskQueue: 'q' };
    expect(startRequest(f, true).cli).toBe('temporal workflow execute --namespace a --workflow-id w --type T --task-queue q');
    expect(startRequest(f, true).path).toBe(startRequest(f).path);
  });
});

describe('activity requests', () => {
  const ref = { ns: 'a', wf: 'w', run: 'r' };

  it('completes and fails by ID with the CLI equivalent', () => {
    const c = completeActivityRequest(ref, '5', [encodeValue('ok')], '"ok"');
    expect(c.path).toBe('/api/v1/namespaces/a/workflows/w/activities/5/complete');
    expect(c.body).toMatchObject({ runId: 'r', result: { payloads: [expect.anything()] } });
    expect(c.cli).toBe(`temporal activity complete --namespace a --workflow-id w --run-id r --activity-id 5 --result '"ok"'`);
    const f = failActivityRequest(ref, '5', { message: 'boom', nonRetryable: true });
    expect(f.body).toMatchObject({ runId: 'r', failure: { message: 'boom', applicationFailureInfo: { nonRetryable: true } } });
    expect(() => failActivityRequest(ref, '5', { message: ' ' })).toThrow();
  });

  it('gates pause/unpause/reset on the server version', () => {
    expect(versionAtLeast('1.24.3', ACTIVITY_COMMANDS_MIN_VERSION)).toBe(false);
    expect(versionAtLeast('1.27.0', ACTIVITY_COMMANDS_MIN_VERSION)).toBe(true);
    expect(versionAtLeast('1.28.1-rc', ACTIVITY_COMMANDS_MIN_VERSION)).toBe(true);
    expect(versionAtLeast(undefined, ACTIVITY_COMMANDS_MIN_VERSION)).toBe(false);
  });

  it('updates only the filled options, with a matching field mask', () => {
    const r = updateActivityOptionsRequest(ref, '5', { startToCloseTimeout: '30s', scheduleToCloseTimeout: '', heartbeatTimeout: '', maximumAttempts: '3' });
    expect(r.body).toEqual({
      execution: { workflowId: 'w', runId: 'r' },
      id: '5',
      activityOptions: { startToCloseTimeout: '30s', retryPolicy: { maximumAttempts: 3 } },
      updateMask: 'startToCloseTimeout,retryPolicy.maximumAttempts',
    });
    expect(r.cli).toBe('temporal activity update-options --namespace a --workflow-id w --run-id r --activity-id 5 --start-to-close-timeout 30s --retry-maximum-attempts 3');
    const empty = { startToCloseTimeout: '', scheduleToCloseTimeout: '', heartbeatTimeout: '', maximumAttempts: '' };
    expect(() => updateActivityOptionsRequest(ref, '5', empty)).toThrow(/at least one/);
    expect(() => updateActivityOptionsRequest(ref, '5', { ...empty, heartbeatTimeout: 'soon' })).toThrow(/duration/);
    expect(() => updateActivityOptionsRequest(ref, '5', { ...empty, maximumAttempts: '-1' })).toThrow(/whole number/);
  });
});

describe('admin requests', () => {
  const form = { name: 'tui-test-ui-1', description: 'd', ownerEmail: '', retention: '3d', historyArchival: '' as const, visibilityArchival: '' as const };

  it('registers a namespace with a proto retention and validates it', () => {
    const r = registerNamespaceRequest(form);
    expect(r).toMatchObject({ method: 'POST', path: '/api/v1/namespaces', body: { namespace: 'tui-test-ui-1', workflowExecutionRetentionPeriod: '259200s', description: 'd' } });
    expect(r.cli).toBe('temporal operator namespace create --namespace tui-test-ui-1 --retention 3d --description d');
    expect(() => registerNamespaceRequest({ ...form, retention: '2h' })).toThrow(/one day/);
    expect(() => registerNamespaceRequest({ ...form, name: '-bad' })).toThrow(/name/);
  });

  it('updates without promoteNamespace and round-trips the retention', () => {
    const r = updateNamespaceRequest({ ...form, retention: humanRetention('259200s'), historyArchival: 'ARCHIVAL_STATE_DISABLED' });
    expect(r.path).toBe('/api/v1/namespaces/tui-test-ui-1/update');
    expect(r.body).toEqual({
      updateInfo: { description: 'd', ownerEmail: '' },
      config: { workflowExecutionRetentionTtl: '259200s', historyArchivalState: 'ARCHIVAL_STATE_DISABLED' },
    });
    expect(r.cli).toContain('--history-archival-state disabled');
    expect(humanRetention('129600s')).toBe('36h');
    expect(humanRetention('90061s')).toBe('90061s');
    expect(humanRetention(undefined)).toBe('');
  });

  it('deletes a namespace naming it in the confirm header', () => {
    expect(deleteNamespaceRequest('tui-test-ui-1')).toMatchObject({ method: 'DELETE', path: '/api/x/namespace', query: { namespace: 'tui-test-ui-1' }, confirm: 'tui-test-ui-1' });
  });

  it('knows the protected namespaces', () => {
    const m = parseMe({ role: 'admin', settings: { protectedNamespaces: ['prod', 7] } });
    expect(m.settings.protectedNamespaces).toEqual(['prod']);
    expect(protectedReason('default', null)).toMatch(/protected/);
    expect(protectedReason('temporal-system', m)).toMatch(/protected/);
    expect(protectedReason('prod', m)).toMatch(/protected/);
    expect(protectedReason('tui-test-ui-1', m)).toBeNull();
  });

  it('adds and removes search attributes with ordered confirmation', () => {
    const add = addSearchAttributeRequest('a', ' CustomerId ', 'Keyword');
    expect(add).toMatchObject({ method: 'POST', path: '/api/x/search-attributes', query: { namespace: 'a' }, body: { searchAttributes: { CustomerId: 'INDEXED_VALUE_TYPE_KEYWORD' } } });
    expect(add.cli).toBe('temporal operator search-attribute create --namespace a --name CustomerId --type Keyword');
    expect(() => addSearchAttributeRequest('a', 'TemporalX', 'Int')).toThrow(/reserved/);
    expect(() => addSearchAttributeRequest('a', '1x', 'Int')).toThrow();
    const rm = removeSearchAttributesRequest('a b', ['B', 'A']);
    expect(rm.path).toBe('/api/x/search-attributes?namespace=a+b&name=B&name=A');
    expect(rm.confirm).toBe('B,A');
    expect(rm.cli).toBe(`temporal operator search-attribute remove --namespace 'a b' --name B --name A --yes`);
    expect(() => removeSearchAttributesRequest('a', [])).toThrow();
  });

  it('batch delete is admin-only, names its job and has no running filter', () => {
    expect(BATCH_ACTION.delete).toBe('batchDelete');
    expect(batchQuery('delete', 'WorkflowType = "T"')).toBe('WorkflowType = "T"');
    const r = batchRequest('a', 'delete', 'WorkflowType = "T"', 'why');
    expect(r.body).toMatchObject({ visibilityQuery: 'WorkflowType = "T"', reason: 'why', deletionOperation: {} });
    expect(r.confirm).toBe(r.jobId);
  });
});

describe('add search attribute errors', () => {
  it('explains NotFound on a namespace that is still propagating', async () => {
    const { ApiError } = await import('../api');
    const { explainAddSearchAttributeError } = await import('./admin');
    const notFound = explainAddSearchAttributeError(new ApiError(404, 'Namespace tui-test-ui-x is not found.', { code: 5 }));
    expect((notFound as Error).message).toBe('The namespace is still being registered; try again in a few seconds.');
    const denied = new ApiError(403, 'permission denied', { code: 7 });
    expect(explainAddSearchAttributeError(denied)).toBe(denied);
  });
});
