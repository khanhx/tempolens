import { describe, expect, it } from 'vitest';
import type { Payload } from '../payload/decode';
import { decodePayload } from '../payload/decode';
import { OP, WF } from './methods';
import { ParseError, parseCommand, tokenize } from './parse';

const ctx = { namespace: 'page-ns', uuid: () => 'uuid-1' };
const parse = (line: string) => parseCommand(line, ctx);

/** The decoded JSON values of a `{payloads}` field. */
const values = (field: unknown) => ((field as { payloads: Payload[] }).payloads ?? []).map((p) => (decodePayload(p) as { value: unknown }).value);
const value = (p: unknown) => (decodePayload(p as Payload) as { value: unknown }).value;

function parseError(line: string): ParseError {
  try {
    parse(line);
  } catch (err) {
    if (err instanceof ParseError) return err;
    throw err;
  }
  throw new Error(`"${line}" parsed without error`);
}

describe('tokenize', () => {
  it('splits on whitespace and honours quotes and escapes', () => {
    expect(tokenize(`a  b\t'c d' "e \\"f\\" g" h\\ i ''`)).toEqual(['a', 'b', 'c d', 'e "f" g', 'h i', '']);
    expect(tokenize(`--query='WorkflowType = "x"'`)).toEqual(['--query=WorkflowType = "x"']);
  });

  it('rejects unterminated quotes', () => {
    expect(() => tokenize(`a 'b`)).toThrow(/Unterminated single quote/);
    expect(() => tokenize(`a "b`)).toThrow(/Unterminated double quote/);
  });
});

describe('parseCommand: workflow', () => {
  it('list with query, limit and the page namespace', () => {
    const c = parse(`temporal workflow list -q 'ExecutionStatus = "Running"' --limit 10`);
    expect(c.method).toBe(`${WF}ListWorkflowExecutions`);
    expect(c.request).toEqual({ namespace: 'page-ns', query: 'ExecutionStatus = "Running"', pageSize: 10 });
    expect(c.actions).toEqual([]);
    expect(c.confirm).toBeNull();
    expect(c.plan).toEqual({ kind: 'call' });
    expect(c.cli).toBe(`temporal workflow list --namespace page-ns --query 'ExecutionStatus = "Running"' --limit 10`);
  });

  it('--namespace and -n override the page namespace, also as --flag=value', () => {
    expect(parse('workflow count -n other').request).toEqual({ namespace: 'other' });
    expect(parse('workflow count --namespace=other --query=x').request).toEqual({ namespace: 'other', query: 'x' });
  });

  it('describe and show', () => {
    expect(parse('workflow describe -w wf-1 -r run-1')).toMatchObject({
      method: `${WF}DescribeWorkflowExecution`,
      request: { namespace: 'page-ns', execution: { workflowId: 'wf-1', runId: 'run-1' } },
    });
    expect(parse('workflow show --workflow-id wf-1')).toMatchObject({
      method: `${WF}GetWorkflowExecutionHistory`,
      request: { namespace: 'page-ns', execution: { workflowId: 'wf-1' } },
    });
  });

  it('start with JSON input, memo, search attributes and options', () => {
    const c = parse(
      `workflow start -w wf-1 --type Greet -t tq -i '{"name":"x"}' -i 42 --memo 'note="hi"' --search-attribute 'CustomKeywordField="k"' --execution-timeout 1h --id-reuse-policy rejectduplicate --id-conflict-policy UseExisting --start-delay 30s`,
    );
    expect(c.method).toBe(`${WF}StartWorkflowExecution`);
    const r = c.request as Record<string, Record<string, unknown>>;
    expect(r).toMatchObject({
      namespace: 'page-ns',
      workflowId: 'wf-1',
      workflowType: { name: 'Greet' },
      taskQueue: { name: 'tq' },
      requestId: 'uuid-1',
      workflowExecutionTimeout: '3600s',
      workflowIdReusePolicy: 'WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE',
      workflowIdConflictPolicy: 'WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING',
      workflowStartDelay: '30s',
    });
    expect(values(r.input)).toEqual([{ name: 'x' }, 42]);
    expect(value((r.memo as { fields: Record<string, unknown> }).fields.note)).toBe('hi');
    expect(value((r.searchAttributes as { indexedFields: Record<string, unknown> }).indexedFields.CustomKeywordField)).toBe('k');
    expect(c.actions).toEqual(['start']);
  });

  it('start generates a workflow ID when none is given and accepts a JSON-object memo', () => {
    const c = parse(`workflow start --type T -t q --memo '{"a":1,"b":"two"}'`);
    expect(c.request.workflowId).toBe('uuid-1');
    const fields = (c.request.memo as { fields: Record<string, unknown> }).fields;
    expect([value(fields.a), value(fields.b)]).toEqual([1, 'two']);
  });

  it('start reports invalid JSON input with the offending value', () => {
    const err = parseError(`workflow start --type T -t q -i '{bad'`);
    expect(err.message).toMatch(/--input is not valid JSON/);
    expect(err.token).toBe('{bad');
  });

  it('execute starts, then waits for the close event', () => {
    const c = parse('workflow execute -w wf-1 --type T -t q');
    expect(c.method).toBe(`${WF}StartWorkflowExecution`);
    expect(c.plan).toEqual({
      kind: 'execute',
      wait: {
        method: `${WF}GetWorkflowExecutionHistory`,
        request: { namespace: 'page-ns', execution: { workflowId: 'wf-1' }, waitNewEvent: true, historyEventFilterType: 'HISTORY_EVENT_FILTER_TYPE_CLOSE_EVENT' },
      },
    });
    expect(c.cli).toBe('temporal workflow execute --namespace page-ns --workflow-id wf-1 --type T --task-queue q');
  });

  it('signal, query and stack', () => {
    const s = parse(`workflow signal -w wf-1 --name go -i '"x"'`);
    expect(s).toMatchObject({ method: `${WF}SignalWorkflowExecution`, request: { workflowExecution: { workflowId: 'wf-1' }, signalName: 'go', requestId: 'uuid-1' }, actions: ['signal'] });
    expect(values(s.request.input)).toEqual(['x']);

    const q = parse('workflow query -w wf-1 --type state');
    expect(q).toMatchObject({ method: `${WF}QueryWorkflow`, request: { execution: { workflowId: 'wf-1' }, query: { queryType: 'state' } }, actions: [] });
    expect(q.cli).toContain('--name state');

    const st = parse('workflow stack -w wf-1');
    expect(st).toMatchObject({ method: `${WF}QueryWorkflow`, request: { query: { queryType: '__stack_trace' } }, output: 'stack' });
  });

  it('update execute, update start and bare update', () => {
    const exec = parse(`workflow update execute -w wf-1 --name set -i 1`);
    expect(exec.method).toBe(`${WF}UpdateWorkflowExecution`);
    expect(exec.request).toMatchObject({
      workflowExecution: { workflowId: 'wf-1' },
      waitPolicy: { lifecycleStage: 'UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_COMPLETED' },
      request: { meta: { updateId: 'uuid-1' }, input: { name: 'set' } },
    });
    expect(parse('workflow update start -w wf-1 --name set --update-id u1').request).toMatchObject({
      waitPolicy: { lifecycleStage: 'UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_ACCEPTED' },
      request: { meta: { updateId: 'u1' } },
    });
    const bare = parse('workflow update -w wf-1 --name set');
    expect(bare.path).toEqual(['workflow', 'update']);
    expect(bare.cli.startsWith('temporal workflow update execute ')).toBe(true);
    expect(bare.actions).toEqual(['update']);
  });

  it('cancel with an optional reason', () => {
    expect(parse('workflow cancel -w wf-1')).toMatchObject({ method: `${WF}RequestCancelWorkflowExecution`, request: { workflowExecution: { workflowId: 'wf-1' }, requestId: 'uuid-1' }, actions: ['cancel'] });
    expect(parse('workflow cancel -w wf-1 --reason bye').request.reason).toBe('bye');
  });

  it('terminate needs a reason and a typed workflow ID', () => {
    const c = parse(`workflow terminate -w wf-1 -r run-1 --reason 'stuck job'`);
    expect(c.method).toBe(`${WF}TerminateWorkflowExecution`);
    expect(c.request).toEqual({ namespace: 'page-ns', workflowExecution: { workflowId: 'wf-1', runId: 'run-1' }, reason: 'stuck job' });
    expect(c.confirm).toEqual({ target: 'wf-1', what: 'the workflow ID' });
    expect(c.actions).toEqual(['terminate']);
    expect(parseError('workflow terminate -w wf-1').message).toMatch(/needs --reason/);
  });

  it('reset to an event ID', () => {
    const c = parse('workflow reset -w wf-1 -e 4 --reason r --reapply-exclude Signal --reapply-exclude update');
    expect(c.method).toBe(`${WF}ResetWorkflowExecution`);
    expect(c.request).toEqual({
      namespace: 'page-ns',
      workflowExecution: { workflowId: 'wf-1' },
      reason: 'r',
      workflowTaskFinishEventId: '4',
      requestId: 'uuid-1',
      resetReapplyExcludeTypes: ['RESET_REAPPLY_EXCLUDE_TYPE_SIGNAL', 'RESET_REAPPLY_EXCLUDE_TYPE_UPDATE'],
    });
    expect(c.plan).toEqual({ kind: 'call' });
  });

  it('reset by type looks the event up first', () => {
    const last = parse('workflow reset -w wf-1 --type LastWorkflowTask --reason r');
    expect(last.plan).toEqual({
      kind: 'reset-to-task',
      which: 'last',
      lookup: { method: `${WF}GetWorkflowExecutionHistoryReverse`, request: { namespace: 'page-ns', execution: { workflowId: 'wf-1' }, maximumPageSize: 100 } },
    });
    expect(last.request.workflowTaskFinishEventId).toBeUndefined();
    const first = parse('workflow reset -w wf-1 --type firstworkflowtask --reason r');
    expect(first.plan).toMatchObject({ kind: 'reset-to-task', which: 'first', lookup: { method: `${WF}GetWorkflowExecutionHistory` } });
  });

  it('reset rejects both or neither of --event-id and --type, and a bad type', () => {
    expect(parseError('workflow reset -w wf-1 --reason r').message).toMatch(/exactly one of --event-id or --type/);
    expect(parseError('workflow reset -w wf-1 -e 3 --type LastWorkflowTask --reason r').message).toMatch(/exactly one/);
    expect(parseError('workflow reset -w wf-1 --type Nope --reason r').token).toBe('Nope');
    expect(parseError('workflow reset -w wf-1 -e x --reason r').token).toBe('x');
  });

  it('delete sends its reason as a header and needs the typed workflow ID', () => {
    const c = parse('workflow delete -w wf-1 --reason cleanup');
    expect(c.method).toBe(`${WF}DeleteWorkflowExecution`);
    expect(c.request).toEqual({ namespace: 'page-ns', workflowExecution: { workflowId: 'wf-1' } });
    expect(c.reasonHeader).toBe('cleanup');
    expect(c.confirm).toEqual({ target: 'wf-1', what: 'the workflow ID' });
    expect(c.actions).toEqual(['delete']);
  });

  it('a missing workflow ID is named', () => {
    expect(parseError('workflow describe').message).toBe('"workflow describe" needs --workflow-id.');
  });
});

describe('parseCommand: schedule', () => {
  it('list and describe', () => {
    expect(parse('schedule list --limit 5')).toMatchObject({ method: `${WF}ListSchedules`, request: { namespace: 'page-ns', maximumPageSize: 5 } });
    expect(parse('schedule describe -s nightly')).toMatchObject({ method: `${WF}DescribeSchedule`, request: { namespace: 'page-ns', scheduleId: 'nightly' } });
  });

  it('create builds the spec, action, policies and state', () => {
    const c = parse(
      `schedule create -s nightly --cron '0 1 * * *' --interval 1h/5m --calendar '{"dayOfWeek":"Fri","hour":"17"}' --time-zone UTC -w wf --type T -t q -i '{"a":1}' --overlap-policy BufferOne --catchup-window 10m --paused --notes n`,
    );
    expect(c.method).toBe(`${WF}CreateSchedule`);
    const schedule = c.request.schedule as Record<string, Record<string, unknown>>;
    expect(c.request).toMatchObject({ namespace: 'page-ns', scheduleId: 'nightly', requestId: 'uuid-1' });
    expect(schedule.spec).toEqual({
      cronString: ['0 1 * * *'],
      interval: [{ interval: '3600s', phase: '300s' }],
      calendar: [{ dayOfWeek: 'Fri', hour: '17' }],
      timezoneName: 'UTC',
    });
    expect(schedule.action).toMatchObject({ startWorkflow: { workflowId: 'wf', workflowType: { name: 'T' }, taskQueue: { name: 'q' } } });
    expect(schedule.policies).toEqual({ overlapPolicy: 'SCHEDULE_OVERLAP_POLICY_BUFFER_ONE', catchupWindow: '600s' });
    expect(schedule.state).toEqual({ paused: true, notes: 'n' });
    expect(c.actions).toEqual(['schedule', 'start']);
  });

  it('update replaces the schedule', () => {
    const c = parse('schedule update -s nightly --interval 2h -w wf --type T -t q');
    expect(c.method).toBe(`${WF}UpdateSchedule`);
    expect((c.request.schedule as { spec: unknown }).spec).toEqual({ interval: [{ interval: '7200s' }] });
  });

  it('toggle pauses or unpauses with a note', () => {
    expect(parse('schedule toggle -s s1 --pause --reason maint').request).toMatchObject({ scheduleId: 's1', patch: { pause: 'maint' } });
    expect(parse('schedule toggle -s s1 --unpause').request).toMatchObject({ patch: { unpause: '(no reason provided)' } });
    expect(parse('schedule toggle -s s1 --pause').actions).toEqual(['schedule']);
    expect(parseError('schedule toggle -s s1').message).toMatch(/exactly one of --pause or --unpause/);
  });

  it('trigger needs start as well', () => {
    const c = parse('schedule trigger -s s1 --overlap-policy AllowAll');
    expect(c).toMatchObject({ method: `${WF}PatchSchedule`, request: { patch: { triggerImmediately: { overlapPolicy: 'SCHEDULE_OVERLAP_POLICY_ALLOW_ALL' } } } });
    expect(c.actions).toEqual(['schedule', 'start']);
  });

  it('delete is confirmed by the schedule ID', () => {
    const c = parse('schedule delete -s s1');
    expect(c).toMatchObject({ method: `${WF}DeleteSchedule`, request: { namespace: 'page-ns', scheduleId: 's1' }, confirm: { target: 's1' } });
  });

  it('rejects a bad interval and a bad calendar', () => {
    expect(parseError('schedule create -s s --interval soon -w w --type T -t q').token).toBe('soon');
    expect(parseError(`schedule create -s s --calendar '[1]' -w w --type T -t q`).message).toMatch(/--calendar must be a JSON object/);
  });
});

describe('parseCommand: batch and task queue', () => {
  it('batch list, describe and terminate', () => {
    expect(parse('batch list --limit 3')).toMatchObject({ method: `${WF}ListBatchOperations`, request: { namespace: 'page-ns', pageSize: 3 } });
    expect(parse('batch describe --job-id j1')).toMatchObject({ method: `${WF}DescribeBatchOperation`, request: { jobId: 'j1' } });
    const t = parse('batch terminate --job-id j1 --reason stop');
    expect(t).toMatchObject({ method: `${WF}StopBatchOperation`, request: { namespace: 'page-ns', jobId: 'j1', reason: 'stop' }, confirm: { target: 'j1' }, actions: ['batch'] });
  });

  it('task-queue describe defaults to the workflow type', () => {
    expect(parse('task-queue describe -t q').request).toEqual({ namespace: 'page-ns', taskQueue: { name: 'q', kind: 'TASK_QUEUE_KIND_NORMAL' }, taskQueueType: 'TASK_QUEUE_TYPE_WORKFLOW' });
    expect(parse('task-queue describe -t q --task-queue-type activity').request.taskQueueType).toBe('TASK_QUEUE_TYPE_ACTIVITY');
  });
});

describe('parseCommand: operator', () => {
  it('namespace list has no namespace', () => {
    const c = parse('operator namespace list');
    expect(c).toMatchObject({ method: `${WF}ListNamespaces`, request: {} });
    expect(c.cli).toBe('temporal operator namespace list');
    expect(parseError('operator namespace list -n x').message).toMatch(/Unknown flag "-n"/);
  });

  it('namespace describe takes the page namespace, a positional name or an ID', () => {
    expect(parse('operator namespace describe').request).toEqual({ namespace: 'page-ns' });
    expect(parse('operator namespace describe other').request).toEqual({ namespace: 'other' });
    expect(parse('operator namespace describe --namespace-id abc').request).toEqual({ id: 'abc' });
  });

  it('namespace create needs an explicit name and defaults the retention', () => {
    const c = parse('operator namespace create -n fresh --description d --email a@b.c --data k=v --history-archival-state enabled');
    expect(c.method).toBe(`${WF}RegisterNamespace`);
    expect(c.request).toEqual({
      namespace: 'fresh',
      workflowExecutionRetentionPeriod: '259200s',
      description: 'd',
      ownerEmail: 'a@b.c',
      data: { k: 'v' },
      historyArchivalState: 'ARCHIVAL_STATE_ENABLED',
    });
    expect(c.actions).toEqual(['namespace']);
    expect(parse('operator namespace create fresh --retention 7d').request.workflowExecutionRetentionPeriod).toBe('604800s');
    expect(parseError('operator namespace create').message).toMatch(/needs --namespace \(it is not taken from the page\)/);
  });

  it('namespace update sends only what changes', () => {
    expect(parse('operator namespace update -n x --retention 2d').request).toEqual({ namespace: 'x', config: { workflowExecutionRetentionTtl: '172800s' } });
    expect(parse('operator namespace update -n x --description d').request).toEqual({ namespace: 'x', updateInfo: { description: 'd' } });
    expect(parseError('operator namespace update -n x').message).toMatch(/changes nothing/);
  });

  it('namespace delete is confirmed by name and adds --yes to the CLI line', () => {
    const c = parse('operator namespace delete -n doomed');
    expect(c).toMatchObject({ method: `${OP}DeleteNamespace`, request: { namespace: 'doomed' }, confirm: { target: 'doomed', what: 'the namespace name' } });
    expect(c.cli).toBe('temporal operator namespace delete --namespace doomed --yes');
    expect(parseError('operator namespace delete').message).toMatch(/needs --namespace/);
  });

  it('search attributes: list, create and remove', () => {
    expect(parse('operator search-attribute list')).toMatchObject({ method: `${OP}ListSearchAttributes`, request: { namespace: 'page-ns' } });
    const add = parse('operator search-attribute create --name A --type keyword --name B --type KeywordList');
    expect(add).toMatchObject({
      method: `${OP}AddSearchAttributes`,
      request: { namespace: 'page-ns', searchAttributes: { A: 'INDEXED_VALUE_TYPE_KEYWORD', B: 'INDEXED_VALUE_TYPE_KEYWORD_LIST' } },
      actions: ['searchAttribute'],
    });
    expect(parseError('operator search-attribute create --name A').message).toMatch(/one --type for each --name/);
    expect(parseError('operator search-attribute create --name 1A --type Int').token).toBe('1A');
    const rm = parse('operator search-attribute remove --name A --name B -y');
    expect(rm).toMatchObject({ method: `${OP}RemoveSearchAttributes`, request: { searchAttributes: ['A', 'B'] }, confirm: { target: 'A,B', what: 'the attribute names' } });
    expect(rm.cli).toBe('temporal operator search-attribute remove --namespace page-ns --name A --name B --yes');
  });

  it('cluster health and system, with or without the operator prefix', () => {
    expect(parse('cluster health')).toMatchObject({ method: `${WF}GetClusterInfo`, request: {} });
    expect(parse('operator cluster health').method).toBe(`${WF}GetClusterInfo`);
    expect(parse('temporal cluster system')).toMatchObject({ method: `${WF}GetSystemInfo`, request: {} });
  });
});

describe('parseCommand: every supported command', () => {
  // One line per command in the console's command list, with the method it calls and its request.
  const cases: [string, string, Record<string, unknown>][] = [
    ['workflow list', `${WF}ListWorkflowExecutions`, { namespace: 'page-ns' }],
    ['workflow describe -w a', `${WF}DescribeWorkflowExecution`, { namespace: 'page-ns', execution: { workflowId: 'a' } }],
    ['workflow show -w a', `${WF}GetWorkflowExecutionHistory`, { namespace: 'page-ns', execution: { workflowId: 'a' } }],
    ['workflow start -w a --type T -t q', `${WF}StartWorkflowExecution`, { namespace: 'page-ns', workflowId: 'a', workflowType: { name: 'T' }, taskQueue: { name: 'q' }, requestId: 'uuid-1' }],
    ['workflow execute -w a --type T -t q', `${WF}StartWorkflowExecution`, { namespace: 'page-ns', workflowId: 'a', workflowType: { name: 'T' }, taskQueue: { name: 'q' }, requestId: 'uuid-1' }],
    ['workflow signal -w a --name s', `${WF}SignalWorkflowExecution`, { namespace: 'page-ns', workflowExecution: { workflowId: 'a' }, signalName: 's', requestId: 'uuid-1' }],
    ['workflow query -w a --name q', `${WF}QueryWorkflow`, { namespace: 'page-ns', execution: { workflowId: 'a' }, query: { queryType: 'q' } }],
    [
      'workflow update -w a --name u',
      `${WF}UpdateWorkflowExecution`,
      {
        namespace: 'page-ns',
        workflowExecution: { workflowId: 'a' },
        waitPolicy: { lifecycleStage: 'UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_COMPLETED' },
        request: { meta: { updateId: 'uuid-1' }, input: { name: 'u' } },
      },
    ],
    ['workflow cancel -w a', `${WF}RequestCancelWorkflowExecution`, { namespace: 'page-ns', workflowExecution: { workflowId: 'a' }, requestId: 'uuid-1' }],
    ['workflow terminate -w a --reason r', `${WF}TerminateWorkflowExecution`, { namespace: 'page-ns', workflowExecution: { workflowId: 'a' }, reason: 'r' }],
    ['workflow reset -w a -e 3 --reason r', `${WF}ResetWorkflowExecution`, { namespace: 'page-ns', workflowExecution: { workflowId: 'a' }, reason: 'r', workflowTaskFinishEventId: '3', requestId: 'uuid-1' }],
    ['workflow delete -w a --reason r', `${WF}DeleteWorkflowExecution`, { namespace: 'page-ns', workflowExecution: { workflowId: 'a' } }],
    ['workflow count -q x', `${WF}CountWorkflowExecutions`, { namespace: 'page-ns', query: 'x' }],
    ['workflow stack -w a', `${WF}QueryWorkflow`, { namespace: 'page-ns', execution: { workflowId: 'a' }, query: { queryType: '__stack_trace' } }],
    ['schedule list', `${WF}ListSchedules`, { namespace: 'page-ns' }],
    ['schedule describe -s s', `${WF}DescribeSchedule`, { namespace: 'page-ns', scheduleId: 's' }],
    [
      'schedule create -s s --interval 1h -w w --type T -t q',
      `${WF}CreateSchedule`,
      { namespace: 'page-ns', scheduleId: 's', requestId: 'uuid-1', schedule: { spec: { interval: [{ interval: '3600s' }] }, action: { startWorkflow: { workflowId: 'w', workflowType: { name: 'T' }, taskQueue: { name: 'q' } } } } },
    ],
    [
      'schedule update -s s --interval 1h -w w --type T -t q',
      `${WF}UpdateSchedule`,
      { namespace: 'page-ns', scheduleId: 's', requestId: 'uuid-1', schedule: { spec: { interval: [{ interval: '3600s' }] }, action: { startWorkflow: { workflowId: 'w', workflowType: { name: 'T' }, taskQueue: { name: 'q' } } } } },
    ],
    ['schedule toggle -s s --pause --reason r', `${WF}PatchSchedule`, { namespace: 'page-ns', scheduleId: 's', patch: { pause: 'r' }, requestId: 'uuid-1' }],
    ['schedule trigger -s s', `${WF}PatchSchedule`, { namespace: 'page-ns', scheduleId: 's', patch: { triggerImmediately: {} }, requestId: 'uuid-1' }],
    ['schedule delete -s s', `${WF}DeleteSchedule`, { namespace: 'page-ns', scheduleId: 's' }],
    ['batch list', `${WF}ListBatchOperations`, { namespace: 'page-ns' }],
    ['batch describe --job-id j', `${WF}DescribeBatchOperation`, { namespace: 'page-ns', jobId: 'j' }],
    ['batch terminate --job-id j --reason r', `${WF}StopBatchOperation`, { namespace: 'page-ns', jobId: 'j', reason: 'r' }],
    ['task-queue describe -t q', `${WF}DescribeTaskQueue`, { namespace: 'page-ns', taskQueue: { name: 'q', kind: 'TASK_QUEUE_KIND_NORMAL' }, taskQueueType: 'TASK_QUEUE_TYPE_WORKFLOW' }],
    ['operator namespace list', `${WF}ListNamespaces`, {}],
    ['operator namespace describe', `${WF}DescribeNamespace`, { namespace: 'page-ns' }],
    ['operator namespace create -n x', `${WF}RegisterNamespace`, { namespace: 'x', workflowExecutionRetentionPeriod: '259200s' }],
    ['operator namespace update -n x --email e', `${WF}UpdateNamespace`, { namespace: 'x', updateInfo: { ownerEmail: 'e' } }],
    ['operator namespace delete -n x', `${OP}DeleteNamespace`, { namespace: 'x' }],
    ['operator search-attribute list', `${OP}ListSearchAttributes`, { namespace: 'page-ns' }],
    ['operator search-attribute create --name A --type Int', `${OP}AddSearchAttributes`, { namespace: 'page-ns', searchAttributes: { A: 'INDEXED_VALUE_TYPE_INT' } }],
    ['operator search-attribute remove --name A', `${OP}RemoveSearchAttributes`, { namespace: 'page-ns', searchAttributes: ['A'] }],
    ['cluster health', `${WF}GetClusterInfo`, {}],
    ['cluster system', `${WF}GetSystemInfo`, {}],
  ];

  it.each(cases)('%s', (line, method, request) => {
    const c = parse(line);
    expect(c.method).toBe(method);
    expect(c.request).toEqual(request);
  });
});

describe('parseCommand: errors', () => {
  it('names the offending token', () => {
    expect(parseError('').message).toMatch(/Type a command/);
    const unknown = parseError('workflow frobnicate');
    expect(unknown.token).toBe('frobnicate');
    expect(unknown.message).toMatch(/Unknown command "frobnicate" for "workflow"/);
    expect(parseError('nope').message).toMatch(/Use one of: workflow, schedule/);
    expect(parseError('workflow').message).toMatch(/Incomplete command/);
    expect(parseError('workflow describe --bogus 1').token).toBe('--bogus');
    expect(parseError('workflow describe stray').token).toBe('stray');
    expect(parseError('workflow describe -w').message).toBe('--workflow-id needs a value.');
    expect(parseError('workflow describe -w a -w b').message).toMatch(/more than once/);
    expect(parseError('workflow list --limit 0').token).toBe('0');
    expect(parseError('task-queue describe -t q --task-queue-type bogus').token).toBe('bogus');
  });

  it('needs a namespace when the page has none', () => {
    expect(() => parseCommand('workflow list', { namespace: '' })).toThrow(/needs --namespace/);
  });
});
