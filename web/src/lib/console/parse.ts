// CLI mode: a parser for a subset of `temporal` CLI syntax. Each command
// maps to one gRPC method and its protojson request, sent through the
// console endpoint; `execute` and `reset --type` add a small step plan the
// page runs client-side. Nothing here talks to the network.
import { encodeValue, parseInput } from '../actions/encode';
import { cliCommand } from '../actions/cli-command';
import type { CliFlag } from '../actions/cli-command';
import { OVERLAP_POLICIES } from '../actions/schedule';
import type { WriteAction } from '../me';
import type { Payload } from '../payload/decode';
import { parseJson } from '../payload/json-bigint';
import { parseHumanDuration, toProtoDuration } from '../time';
import type { Call, ConfirmSpec, Json } from './methods';
import { confirmFor, methodActions, needsReasonHeader, OP, WF } from './methods';

/** A command the user typed that cannot be mapped; `token` is the offending input. */
export class ParseError extends Error {
  readonly token: string | undefined;
  constructor(message: string, token?: string) {
    super(message);
    this.name = 'ParseError';
    this.token = token;
  }
}

/**
 * How a command runs: one call, `execute` (start, then wait for the close
 * event, with the run ID from the start response), or reset to the first or
 * last workflow task (look the event ID up in the history, then reset).
 */
export type Plan = { kind: 'call' } | { kind: 'execute'; wait: Call } | { kind: 'reset-to-task'; which: 'first' | 'last'; lookup: Call };

export interface ParsedCommand extends Call {
  /** Canonical command path, e.g. `['workflow', 'describe']`. */
  path: readonly string[];
  plan: Plan;
  /** The equivalent `temporal …` line, with the namespace spelled out. */
  cli: string;
  /** Write actions the command needs; empty for reads. */
  actions: WriteAction[];
  confirm: ConfirmSpec | null;
  /** Sent as `X-Tempolens-Reason` for methods whose request has no reason field. */
  reasonHeader?: string;
  /** How to present the response. */
  output?: 'stack';
}

export interface ParseContext {
  /** The page's namespace, used when `--namespace` is absent. */
  namespace: string;
  /** Request and update IDs; injectable for tests. */
  uuid?: () => string;
}

// ---------------------------------------------------------------- tokens

/**
 * Splits a command line the way a POSIX shell would for plain words: single
 * quotes are literal, double quotes allow `\"` and `\\`, a backslash outside
 * quotes escapes the next character. No expansion of any kind.
 */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inToken = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new ParseError('Unterminated single quote.', line.slice(i));
      cur += line.slice(i + 1, end);
      i = end;
      inToken = true;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && (line[j + 1] === '"' || line[j + 1] === '\\')) j++;
        cur += line[j];
      }
      if (j >= line.length) throw new ParseError('Unterminated double quote.', line.slice(i));
      i = j;
      inToken = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      inToken = true;
    } else if (/\s/.test(c)) {
      if (inToken) out.push(cur);
      cur = '';
      inToken = false;
    } else {
      cur += c;
      inToken = true;
    }
  }
  if (inToken) out.push(cur);
  return out;
}

// ---------------------------------------------------------------- flags

export interface FlagSpec {
  /** `list` flags repeat; `bool` flags take no value. Default: a single string. */
  kind?: 'string' | 'bool' | 'list';
  /** Other names, e.g. `w` for `-w`. */
  alias?: readonly string[];
  /** Allowed values, for autocomplete and validation. */
  values?: readonly string[];
}

type FlagValue = string | string[] | true;

class Flags {
  constructor(
    private readonly command: string,
    private readonly values: Map<string, FlagValue>,
  ) {}

  has(name: string): boolean {
    return this.values.has(name);
  }

  str(name: string): string | undefined {
    const v = this.values.get(name);
    return typeof v === 'string' ? v : undefined;
  }

  req(name: string): string {
    const v = this.str(name);
    if (v === undefined || v.trim() === '') throw new ParseError(`"${this.command}" needs --${name}.`);
    return v;
  }

  list(name: string): string[] {
    const v = this.values.get(name);
    return Array.isArray(v) ? v : [];
  }

  bool(name: string): boolean {
    return this.values.get(name) === true;
  }

  int(name: string): number | undefined {
    const v = this.str(name);
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v) || Number(v) <= 0) throw new ParseError(`--${name} must be a positive whole number.`, v);
    return Number(v);
  }

  duration(name: string): string | undefined {
    const v = this.str(name);
    return v === undefined ? undefined : protoDuration(name, v);
  }
}

function protoDuration(flag: string, value: string): string {
  const ms = parseHumanDuration(value);
  if (ms === null || ms <= 0) throw new ParseError(`--${flag} must be a duration such as 30s, 15m or 1h30m.`, value);
  return toProtoDuration(ms);
}

function json(flag: string, value: string): unknown {
  try {
    return parseJson(value);
  } catch (err) {
    throw new ParseError(`--${flag} is not valid JSON: ${err instanceof Error ? err.message : String(err)}.`, value);
  }
}

/** One payload per `--input`; each value is JSON (a raw `{metadata, data}` payload passes through). */
function payloads(f: Flags, flag: string): { payloads: Payload[] } | undefined {
  const all: Payload[] = [];
  for (const v of f.list(flag)) {
    try {
      all.push(...(parseInput(v) ?? []));
    } catch (err) {
      throw new ParseError(`--${flag} is not valid JSON: ${err instanceof Error ? err.message.replace(/^Input is not valid JSON: /, '') : String(err)}.`, v);
    }
  }
  return all.length ? { payloads: all } : undefined;
}

/** `KEY=JSON` pairs (or one JSON object) as payload fields, for memo and search attributes. */
function payloadFields(f: Flags, flag: string): Record<string, Payload> | undefined {
  const out: Record<string, Payload> = {};
  for (const v of f.list(flag)) {
    if (v.trim().startsWith('{')) {
      const obj = json(flag, v);
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new ParseError(`--${flag} must be KEY=JSON or a JSON object.`, v);
      for (const [k, value] of Object.entries(obj)) out[k] = payloadOf(value);
      continue;
    }
    const eq = v.indexOf('=');
    if (eq <= 0) throw new ParseError(`--${flag} must be KEY=JSON, e.g. ${flag === 'memo' ? 'note="hello"' : 'CustomKeywordField="x"'}.`, v);
    out[v.slice(0, eq)] = payloadOf(json(flag, v.slice(eq + 1)));
  }
  return Object.keys(out).length ? out : undefined;
}

const payloadOf = (value: unknown): Payload => encodeValue(value);

/** `KEY=VALUE` pairs as a string map. */
function stringMap(f: Flags, flag: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const v of f.list(flag)) {
    const eq = v.indexOf('=');
    if (eq <= 0) throw new ParseError(`--${flag} must be KEY=VALUE.`, v);
    out[v.slice(0, eq)] = v.slice(eq + 1);
  }
  return Object.keys(out).length ? out : undefined;
}

const upperSnake = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toUpperCase();

/** A CLI enum value (`AllowDuplicate`, case-insensitive) as its proto name (`PREFIX_ALLOW_DUPLICATE`). */
function enumValue(flag: string, value: string | undefined, prefix: string, allowed: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  const match = allowed.find((a) => a.toLowerCase() === value.toLowerCase());
  if (!match) throw new ParseError(`--${flag} must be one of ${allowed.join(', ')}.`, value);
  return `${prefix}${upperSnake(match)}`;
}

const opt = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

// ---------------------------------------------------------------- commands

interface Built {
  method: string;
  request: Json;
  plan?: Plan;
  reasonHeader?: string;
  output?: 'stack';
}

export interface CommandSpec {
  path: readonly string[];
  /** The path the CLI line uses when it differs (`workflow update` → `workflow update execute`). */
  cliPath?: readonly string[];
  /** `default`: the page namespace when absent; `explicit`: must be given; `none`: no namespace. */
  ns: 'default' | 'explicit' | 'none';
  flags: Record<string, FlagSpec>;
  /** Flag that one positional argument fills. */
  positional?: string;
  /** Add `--yes` to the CLI line (the real CLI prompts otherwise). */
  cliYes?: boolean;
  build(f: Flags, ns: string, uuid: () => string): Built;
}

const W = { workflowId: { alias: ['w'] }, runId: { alias: ['r'] } };
const WF_FLAGS: Record<string, FlagSpec> = { 'workflow-id': W.workflowId, 'run-id': W.runId };
const QUERY: FlagSpec = { alias: ['q'] };
const INPUT: FlagSpec = { kind: 'list', alias: ['i'] };
const REASON: FlagSpec = {};

const execution = (f: Flags) => ({ workflowId: f.req('workflow-id'), ...opt('runId', f.str('run-id')) });

const ID_REUSE = ['AllowDuplicate', 'AllowDuplicateFailedOnly', 'RejectDuplicate', 'TerminateIfRunning'] as const;
const ID_CONFLICT = ['Fail', 'UseExisting', 'TerminateExisting'] as const;
const OVERLAP = OVERLAP_POLICIES.map((o) => o.cli);
const REAPPLY_EXCLUDE = ['Signal', 'Update', 'CancelRequest', 'Nexus'] as const;
const RESET_TYPES = ['FirstWorkflowTask', 'LastWorkflowTask'] as const;
const TASK_QUEUE_TYPES = ['workflow', 'activity', 'nexus'] as const;
const ARCHIVAL = ['enabled', 'disabled'] as const;
const SA_TYPES = ['Keyword', 'Text', 'Int', 'Double', 'Bool', 'Datetime', 'KeywordList'] as const;
const SA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const START_FLAGS: Record<string, FlagSpec> = {
  'workflow-id': W.workflowId,
  type: {},
  'task-queue': { alias: ['t'] },
  input: INPUT,
  'execution-timeout': {},
  'run-timeout': {},
  'task-timeout': {},
  cron: {},
  'id-reuse-policy': { values: ID_REUSE },
  'id-conflict-policy': { values: ID_CONFLICT },
  memo: { kind: 'list' },
  'search-attribute': { kind: 'list' },
  'start-delay': {},
};

function startRequest(f: Flags, ns: string, uuid: () => string): Json {
  const memo = payloadFields(f, 'memo');
  const sa = payloadFields(f, 'search-attribute');
  return {
    namespace: ns,
    workflowId: f.str('workflow-id') || uuid(),
    workflowType: { name: f.req('type') },
    taskQueue: { name: f.req('task-queue') },
    requestId: uuid(),
    ...opt('input', payloads(f, 'input')),
    ...opt('workflowExecutionTimeout', f.duration('execution-timeout')),
    ...opt('workflowRunTimeout', f.duration('run-timeout')),
    ...opt('workflowTaskTimeout', f.duration('task-timeout')),
    ...opt('cronSchedule', f.str('cron')),
    ...opt('workflowIdReusePolicy', enumValue('id-reuse-policy', f.str('id-reuse-policy'), 'WORKFLOW_ID_REUSE_POLICY_', ID_REUSE)),
    ...opt('workflowIdConflictPolicy', enumValue('id-conflict-policy', f.str('id-conflict-policy'), 'WORKFLOW_ID_CONFLICT_POLICY_', ID_CONFLICT)),
    ...opt('memo', memo && { fields: memo }),
    ...opt('searchAttributes', sa && { indexedFields: sa }),
    ...opt('workflowStartDelay', f.duration('start-delay')),
  };
}

function requireReason(f: Flags, command: string): string {
  const reason = f.str('reason')?.trim();
  if (!reason) throw new ParseError(`"${command}" needs --reason (the server records it).`);
  return reason;
}

const UPDATE_FLAGS: Record<string, FlagSpec> = { ...WF_FLAGS, name: {}, input: INPUT, 'update-id': {} };

function updateBuild(stage: 'COMPLETED' | 'ACCEPTED') {
  return (f: Flags, ns: string, uuid: () => string): Built => ({
    method: `${WF}UpdateWorkflowExecution`,
    request: {
      namespace: ns,
      workflowExecution: execution(f),
      waitPolicy: { lifecycleStage: `UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_${stage}` },
      request: { meta: { updateId: f.str('update-id') || uuid() }, input: { name: f.req('name'), ...opt('args', payloads(f, 'input')) } },
    },
  });
}

const SCHEDULE_ID: FlagSpec = { alias: ['s'] };

const SCHEDULE_FLAGS: Record<string, FlagSpec> = {
  'schedule-id': SCHEDULE_ID,
  cron: { kind: 'list' },
  interval: { kind: 'list' },
  calendar: { kind: 'list' },
  'start-time': {},
  'end-time': {},
  'time-zone': {},
  jitter: {},
  'workflow-id': W.workflowId,
  type: {},
  'task-queue': { alias: ['t'] },
  input: INPUT,
  'execution-timeout': {},
  'run-timeout': {},
  'task-timeout': {},
  'overlap-policy': { values: OVERLAP },
  'catchup-window': {},
  'pause-on-failure': { kind: 'bool' },
  paused: { kind: 'bool' },
  notes: {},
};

function timestamp(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Number.isNaN(Date.parse(value))) throw new ParseError(`--${flag} must be an RFC 3339 time, e.g. 2026-01-01T00:00:00Z.`, value);
  return value;
}

/** The `schedule` of CreateSchedule and UpdateSchedule (an update replaces the whole schedule, as in the CLI). */
function scheduleBody(f: Flags): Json {
  const interval = f.list('interval').map((v) => {
    const [every = '', phase] = v.split('/');
    return { interval: protoDuration('interval', every), ...opt('phase', phase === undefined ? undefined : protoDuration('interval', phase)) };
  });
  const calendar = f.list('calendar').map((v) => {
    const c = json('calendar', v);
    if (typeof c !== 'object' || c === null || Array.isArray(c)) throw new ParseError('--calendar must be a JSON object, e.g. {"dayOfWeek":"Fri","hour":"17"}.', v);
    return c;
  });
  const cron = f.list('cron');
  const policies = {
    ...opt('overlapPolicy', enumValue('overlap-policy', f.str('overlap-policy'), 'SCHEDULE_OVERLAP_POLICY_', OVERLAP)),
    ...opt('catchupWindow', f.duration('catchup-window')),
    ...(f.bool('pause-on-failure') ? { pauseOnFailure: true } : {}),
  };
  const state = { ...(f.bool('paused') ? { paused: true } : {}), ...opt('notes', f.str('notes')) };
  return {
    spec: {
      ...(cron.length ? { cronString: cron } : {}),
      ...(interval.length ? { interval } : {}),
      ...(calendar.length ? { calendar } : {}),
      ...opt('startTime', timestamp('start-time', f.str('start-time'))),
      ...opt('endTime', timestamp('end-time', f.str('end-time'))),
      ...opt('timezoneName', f.str('time-zone')),
      ...opt('jitter', f.duration('jitter')),
    },
    action: {
      startWorkflow: {
        workflowId: f.req('workflow-id'),
        workflowType: { name: f.req('type') },
        taskQueue: { name: f.req('task-queue') },
        ...opt('input', payloads(f, 'input')),
        ...opt('workflowExecutionTimeout', f.duration('execution-timeout')),
        ...opt('workflowRunTimeout', f.duration('run-timeout')),
        ...opt('workflowTaskTimeout', f.duration('task-timeout')),
      },
    },
    ...(Object.keys(policies).length ? { policies } : {}),
    ...(Object.keys(state).length ? { state } : {}),
  };
}

const NAMESPACE_EDIT_FLAGS: Record<string, FlagSpec> = {
  retention: {},
  description: {},
  email: {},
  data: { kind: 'list' },
  'history-archival-state': { values: ARCHIVAL },
  'visibility-archival-state': { values: ARCHIVAL },
};

const archival = (f: Flags, flag: string) => enumValue(flag, f.str(flag), 'ARCHIVAL_STATE_', ARCHIVAL);

export const COMMANDS: readonly CommandSpec[] = [
  {
    path: ['workflow', 'list'],
    ns: 'default',
    flags: { query: QUERY, limit: {} },
    build: (f, ns) => ({ method: `${WF}ListWorkflowExecutions`, request: { namespace: ns, ...opt('query', f.str('query')), ...opt('pageSize', f.int('limit')) } }),
  },
  {
    path: ['workflow', 'count'],
    ns: 'default',
    flags: { query: QUERY },
    build: (f, ns) => ({ method: `${WF}CountWorkflowExecutions`, request: { namespace: ns, ...opt('query', f.str('query')) } }),
  },
  {
    path: ['workflow', 'describe'],
    ns: 'default',
    flags: WF_FLAGS,
    build: (f, ns) => ({ method: `${WF}DescribeWorkflowExecution`, request: { namespace: ns, execution: execution(f) } }),
  },
  {
    path: ['workflow', 'show'],
    ns: 'default',
    flags: WF_FLAGS,
    build: (f, ns) => ({ method: `${WF}GetWorkflowExecutionHistory`, request: { namespace: ns, execution: execution(f) } }),
  },
  {
    path: ['workflow', 'start'],
    ns: 'default',
    flags: START_FLAGS,
    build: (f, ns, uuid) => ({ method: `${WF}StartWorkflowExecution`, request: startRequest(f, ns, uuid) }),
  },
  {
    path: ['workflow', 'execute'],
    ns: 'default',
    flags: START_FLAGS,
    build: (f, ns, uuid) => {
      const request = startRequest(f, ns, uuid);
      return {
        method: `${WF}StartWorkflowExecution`,
        request,
        plan: {
          kind: 'execute',
          wait: {
            method: `${WF}GetWorkflowExecutionHistory`,
            request: { namespace: ns, execution: { workflowId: request.workflowId }, waitNewEvent: true, historyEventFilterType: 'HISTORY_EVENT_FILTER_TYPE_CLOSE_EVENT' },
          },
        },
      };
    },
  },
  {
    path: ['workflow', 'signal'],
    ns: 'default',
    flags: { ...WF_FLAGS, name: {}, input: INPUT },
    build: (f, ns, uuid) => ({
      method: `${WF}SignalWorkflowExecution`,
      request: { namespace: ns, workflowExecution: execution(f), signalName: f.req('name'), requestId: uuid(), ...opt('input', payloads(f, 'input')) },
    }),
  },
  {
    path: ['workflow', 'query'],
    ns: 'default',
    // Older CLI releases call the query name --type.
    flags: { ...WF_FLAGS, name: { alias: ['type'] }, input: INPUT },
    build: (f, ns) => ({
      method: `${WF}QueryWorkflow`,
      request: { namespace: ns, execution: execution(f), query: { queryType: f.req('name'), ...opt('queryArgs', payloads(f, 'input')) } },
    }),
  },
  {
    path: ['workflow', 'stack'],
    ns: 'default',
    flags: WF_FLAGS,
    build: (f, ns) => ({ method: `${WF}QueryWorkflow`, request: { namespace: ns, execution: execution(f), query: { queryType: '__stack_trace' } }, output: 'stack' }),
  },
  { path: ['workflow', 'update', 'execute'], ns: 'default', flags: UPDATE_FLAGS, build: updateBuild('COMPLETED') },
  { path: ['workflow', 'update', 'start'], ns: 'default', flags: UPDATE_FLAGS, build: updateBuild('ACCEPTED') },
  { path: ['workflow', 'update'], cliPath: ['workflow', 'update', 'execute'], ns: 'default', flags: UPDATE_FLAGS, build: updateBuild('COMPLETED') },
  {
    path: ['workflow', 'cancel'],
    ns: 'default',
    flags: { ...WF_FLAGS, reason: REASON },
    build: (f, ns, uuid) => ({
      method: `${WF}RequestCancelWorkflowExecution`,
      request: { namespace: ns, workflowExecution: execution(f), requestId: uuid(), ...opt('reason', f.str('reason')?.trim() || undefined) },
    }),
  },
  {
    path: ['workflow', 'terminate'],
    ns: 'default',
    flags: { ...WF_FLAGS, reason: REASON },
    build: (f, ns) => ({
      method: `${WF}TerminateWorkflowExecution`,
      request: { namespace: ns, workflowExecution: execution(f), reason: requireReason(f, 'workflow terminate') },
    }),
  },
  {
    path: ['workflow', 'reset'],
    ns: 'default',
    flags: { ...WF_FLAGS, 'event-id': { alias: ['e'] }, type: { values: RESET_TYPES }, reason: REASON, 'reapply-exclude': { kind: 'list', values: REAPPLY_EXCLUDE } },
    build: (f, ns, uuid) => {
      const eventId = f.str('event-id');
      const type = f.str('type');
      if ((eventId === undefined) === (type === undefined)) throw new ParseError('"workflow reset" needs exactly one of --event-id or --type.');
      if (eventId !== undefined && !/^\d+$/.test(eventId)) throw new ParseError('--event-id must be a whole number.', eventId);
      const exclude = f.list('reapply-exclude').map((v) => enumValue('reapply-exclude', v, 'RESET_REAPPLY_EXCLUDE_TYPE_', REAPPLY_EXCLUDE) as string);
      const exec = execution(f);
      const request: Json = {
        namespace: ns,
        workflowExecution: exec,
        reason: requireReason(f, 'workflow reset'),
        ...opt('workflowTaskFinishEventId', eventId),
        requestId: uuid(),
        ...(exclude.length ? { resetReapplyExcludeTypes: exclude } : {}),
      };
      if (eventId !== undefined) return { method: `${WF}ResetWorkflowExecution`, request };
      const which = enumValue('type', type, '', RESET_TYPES) === 'FIRST_WORKFLOW_TASK' ? 'first' : 'last';
      return {
        method: `${WF}ResetWorkflowExecution`,
        request,
        plan: {
          kind: 'reset-to-task',
          which,
          lookup: {
            method: which === 'first' ? `${WF}GetWorkflowExecutionHistory` : `${WF}GetWorkflowExecutionHistoryReverse`,
            request: { namespace: ns, execution: exec, maximumPageSize: 100 },
          },
        },
      };
    },
  },
  {
    path: ['workflow', 'delete'],
    ns: 'default',
    flags: { ...WF_FLAGS, reason: REASON },
    build: (f, ns) => ({
      method: `${WF}DeleteWorkflowExecution`,
      request: { namespace: ns, workflowExecution: execution(f) },
      reasonHeader: requireReason(f, 'workflow delete'),
    }),
  },

  {
    path: ['schedule', 'list'],
    ns: 'default',
    flags: { query: QUERY, limit: {} },
    build: (f, ns) => ({ method: `${WF}ListSchedules`, request: { namespace: ns, ...opt('query', f.str('query')), ...opt('maximumPageSize', f.int('limit')) } }),
  },
  {
    path: ['schedule', 'describe'],
    ns: 'default',
    flags: { 'schedule-id': SCHEDULE_ID },
    build: (f, ns) => ({ method: `${WF}DescribeSchedule`, request: { namespace: ns, scheduleId: f.req('schedule-id') } }),
  },
  {
    path: ['schedule', 'create'],
    ns: 'default',
    flags: SCHEDULE_FLAGS,
    build: (f, ns, uuid) => ({ method: `${WF}CreateSchedule`, request: { namespace: ns, scheduleId: f.req('schedule-id'), schedule: scheduleBody(f), requestId: uuid() } }),
  },
  {
    path: ['schedule', 'update'],
    ns: 'default',
    flags: SCHEDULE_FLAGS,
    build: (f, ns, uuid) => ({ method: `${WF}UpdateSchedule`, request: { namespace: ns, scheduleId: f.req('schedule-id'), schedule: scheduleBody(f), requestId: uuid() } }),
  },
  {
    path: ['schedule', 'toggle'],
    ns: 'default',
    flags: { 'schedule-id': SCHEDULE_ID, pause: { kind: 'bool' }, unpause: { kind: 'bool' }, reason: REASON },
    build: (f, ns, uuid) => {
      if (f.bool('pause') === f.bool('unpause')) throw new ParseError('"schedule toggle" needs exactly one of --pause or --unpause.');
      // An empty note would not pause at all; the CLI uses the same default.
      const note = f.str('reason')?.trim() || '(no reason provided)';
      return {
        method: `${WF}PatchSchedule`,
        request: { namespace: ns, scheduleId: f.req('schedule-id'), patch: f.bool('pause') ? { pause: note } : { unpause: note }, requestId: uuid() },
      };
    },
  },
  {
    path: ['schedule', 'trigger'],
    ns: 'default',
    flags: { 'schedule-id': SCHEDULE_ID, 'overlap-policy': { values: OVERLAP } },
    build: (f, ns, uuid) => ({
      method: `${WF}PatchSchedule`,
      request: {
        namespace: ns,
        scheduleId: f.req('schedule-id'),
        patch: { triggerImmediately: { ...opt('overlapPolicy', enumValue('overlap-policy', f.str('overlap-policy'), 'SCHEDULE_OVERLAP_POLICY_', OVERLAP)) } },
        requestId: uuid(),
      },
    }),
  },
  {
    path: ['schedule', 'delete'],
    ns: 'default',
    flags: { 'schedule-id': SCHEDULE_ID },
    build: (f, ns) => ({ method: `${WF}DeleteSchedule`, request: { namespace: ns, scheduleId: f.req('schedule-id') } }),
  },

  {
    path: ['batch', 'list'],
    ns: 'default',
    flags: { limit: {} },
    build: (f, ns) => ({ method: `${WF}ListBatchOperations`, request: { namespace: ns, ...opt('pageSize', f.int('limit')) } }),
  },
  {
    path: ['batch', 'describe'],
    ns: 'default',
    flags: { 'job-id': {} },
    build: (f, ns) => ({ method: `${WF}DescribeBatchOperation`, request: { namespace: ns, jobId: f.req('job-id') } }),
  },
  {
    path: ['batch', 'terminate'],
    ns: 'default',
    flags: { 'job-id': {}, reason: REASON },
    build: (f, ns) => ({ method: `${WF}StopBatchOperation`, request: { namespace: ns, jobId: f.req('job-id'), reason: requireReason(f, 'batch terminate') } }),
  },

  {
    path: ['task-queue', 'describe'],
    ns: 'default',
    flags: { 'task-queue': { alias: ['t'] }, 'task-queue-type': { values: TASK_QUEUE_TYPES } },
    build: (f, ns) => ({
      method: `${WF}DescribeTaskQueue`,
      request: {
        namespace: ns,
        taskQueue: { name: f.req('task-queue'), kind: 'TASK_QUEUE_KIND_NORMAL' },
        taskQueueType: enumValue('task-queue-type', f.str('task-queue-type') ?? 'workflow', 'TASK_QUEUE_TYPE_', TASK_QUEUE_TYPES),
      },
    }),
  },

  {
    path: ['operator', 'namespace', 'list'],
    ns: 'none',
    flags: {},
    build: () => ({ method: `${WF}ListNamespaces`, request: {} }),
  },
  {
    path: ['operator', 'namespace', 'describe'],
    ns: 'default',
    positional: 'namespace',
    flags: { 'namespace-id': {} },
    build: (f, ns) => ({ method: `${WF}DescribeNamespace`, request: f.has('namespace-id') ? { id: f.req('namespace-id') } : { namespace: ns } }),
  },
  {
    path: ['operator', 'namespace', 'create'],
    ns: 'explicit',
    positional: 'namespace',
    flags: { ...NAMESPACE_EDIT_FLAGS, global: { kind: 'bool' } },
    build: (f, ns) => {
      const data = stringMap(f, 'data');
      return {
        method: `${WF}RegisterNamespace`,
        request: {
          namespace: ns,
          // The CLI's default retention.
          workflowExecutionRetentionPeriod: protoDuration('retention', f.str('retention') ?? '72h'),
          ...opt('description', f.str('description')),
          ...opt('ownerEmail', f.str('email')),
          ...opt('data', data),
          ...(f.bool('global') ? { isGlobalNamespace: true } : {}),
          ...opt('historyArchivalState', archival(f, 'history-archival-state')),
          ...opt('visibilityArchivalState', archival(f, 'visibility-archival-state')),
        },
      };
    },
  },
  {
    path: ['operator', 'namespace', 'update'],
    ns: 'explicit',
    positional: 'namespace',
    flags: NAMESPACE_EDIT_FLAGS,
    build: (f, ns) => {
      const updateInfo = { ...opt('description', f.str('description')), ...opt('ownerEmail', f.str('email')), ...opt('data', stringMap(f, 'data')) };
      const config = {
        ...opt('workflowExecutionRetentionTtl', f.duration('retention')),
        ...opt('historyArchivalState', archival(f, 'history-archival-state')),
        ...opt('visibilityArchivalState', archival(f, 'visibility-archival-state')),
      };
      if (!Object.keys(updateInfo).length && !Object.keys(config).length) {
        throw new ParseError('"operator namespace update" changes nothing; give --description, --email, --data, --retention or an archival state.');
      }
      return {
        method: `${WF}UpdateNamespace`,
        request: { namespace: ns, ...(Object.keys(updateInfo).length ? { updateInfo } : {}), ...(Object.keys(config).length ? { config } : {}) },
      };
    },
  },
  {
    path: ['operator', 'namespace', 'delete'],
    ns: 'explicit',
    positional: 'namespace',
    cliYes: true,
    flags: {},
    build: (_f, ns) => ({ method: `${OP}DeleteNamespace`, request: { namespace: ns } }),
  },

  {
    path: ['operator', 'search-attribute', 'list'],
    ns: 'default',
    flags: {},
    build: (_f, ns) => ({ method: `${OP}ListSearchAttributes`, request: { namespace: ns } }),
  },
  {
    path: ['operator', 'search-attribute', 'create'],
    ns: 'default',
    flags: { name: { kind: 'list' }, type: { kind: 'list', values: SA_TYPES } },
    build: (f, ns) => {
      const names = f.list('name');
      const types = f.list('type');
      if (!names.length) throw new ParseError('"operator search-attribute create" needs --name.');
      if (names.length !== types.length) throw new ParseError('Give one --type for each --name.');
      const searchAttributes: Record<string, string> = {};
      names.forEach((name, i) => {
        if (!SA_NAME.test(name)) throw new ParseError('Search attribute names use letters, digits and "_", and cannot start with a digit.', name);
        searchAttributes[name] = enumValue('type', types[i], 'INDEXED_VALUE_TYPE_', SA_TYPES) as string;
      });
      return { method: `${OP}AddSearchAttributes`, request: { namespace: ns, searchAttributes } };
    },
  },
  {
    path: ['operator', 'search-attribute', 'remove'],
    ns: 'default',
    cliYes: true,
    flags: { name: { kind: 'list' } },
    build: (f, ns) => {
      const names = f.list('name');
      if (!names.length) throw new ParseError('"operator search-attribute remove" needs --name.');
      return { method: `${OP}RemoveSearchAttributes`, request: { namespace: ns, searchAttributes: names } };
    },
  },

  // The CLI's `operator cluster health` calls grpc.health, which the console
  // endpoint does not expose; GetClusterInfo answers the same question.
  { path: ['operator', 'cluster', 'health'], ns: 'none', flags: {}, build: () => ({ method: `${WF}GetClusterInfo`, request: {} }) },
  { path: ['operator', 'cluster', 'describe'], ns: 'none', flags: {}, build: () => ({ method: `${WF}GetClusterInfo`, request: {} }) },
  { path: ['operator', 'cluster', 'system'], ns: 'none', flags: {}, build: () => ({ method: `${WF}GetSystemInfo`, request: {} }) },
];

/** Global flags every command accepts (namespace only where it applies). */
export const GLOBAL_FLAGS: Record<string, FlagSpec> = { namespace: { alias: ['n'] }, yes: { kind: 'bool', alias: ['y'] } };

/** Strips `temporal` and expands the `cluster …` shorthand to `operator cluster …`. */
function commandWords(tokens: readonly string[]): string[] {
  const words = tokens[0] === 'temporal' ? tokens.slice(1) : [...tokens];
  return words[0] === 'cluster' ? ['operator', ...words] : words;
}

/** The longest command whose path prefixes `words`, or null. */
export function findCommand(words: readonly string[]): CommandSpec | null {
  let best: CommandSpec | null = null;
  for (const c of COMMANDS) {
    if (c.path.every((p, i) => words[i] === p) && (!best || c.path.length > best.path.length)) best = c;
  }
  return best;
}

/** The next words that can follow `prefix` in the command tree. */
export function nextWords(prefix: readonly string[]): string[] {
  const out = new Set<string>();
  for (const c of COMMANDS) {
    if (c.path.length > prefix.length && prefix.every((p, i) => c.path[i] === p)) out.add(c.path[prefix.length] as string);
  }
  return [...out];
}

/** Every flag `spec` accepts, including the global ones that apply. */
export function commandFlags(spec: CommandSpec): Record<string, FlagSpec> {
  const globals = spec.ns === 'none' ? { yes: GLOBAL_FLAGS.yes as FlagSpec } : GLOBAL_FLAGS;
  return { ...globals, ...spec.flags };
}

function unknownCommand(words: readonly string[]): ParseError {
  let depth = 0;
  while (depth < words.length && nextWords(words.slice(0, depth)).includes(words[depth] as string)) depth++;
  const known = words.slice(0, depth);
  const options = nextWords(known);
  const bad = words[depth];
  const where = known.length ? `"${known.join(' ')}"` : 'the console';
  return bad === undefined || bad.startsWith('-')
    ? new ParseError(`Incomplete command. After ${where}, use one of: ${options.join(', ')}.`, bad)
    : new ParseError(`Unknown command "${bad}" for ${where}. Use one of: ${options.join(', ')}.`, bad);
}

/**
 * Parses one command line into its method, request and plan. Throws
 * ParseError, naming the offending token, for anything it cannot map.
 */
export function parseCommand(line: string, ctx: ParseContext): ParsedCommand {
  const uuid = ctx.uuid ?? (() => crypto.randomUUID());
  const words = commandWords(tokenize(line));
  if (words.length === 0) throw new ParseError('Type a command, for example "workflow list".');
  const spec = findCommand(words);
  if (!spec) throw unknownCommand(words);
  const name = spec.path.join(' ');
  const flagSpecs = commandFlags(spec);
  const byAlias = new Map<string, string>();
  for (const [flag, s] of Object.entries(flagSpecs)) {
    byAlias.set(flag, flag);
    for (const a of s.alias ?? []) byAlias.set(a, flag);
  }

  const values = new Map<string, FlagValue>();
  const given: [string, string | true][] = [];
  const rest = words.slice(spec.path.length);
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i] as string;
    if (!tok.startsWith('-') || tok === '-') {
      if (spec.positional && !values.has(spec.positional)) {
        values.set(spec.positional, tok);
        given.push([spec.positional, tok]);
        continue;
      }
      throw new ParseError(`Unexpected argument "${tok}" for "${name}"; values follow a flag, e.g. --workflow-id ${tok}.`, tok);
    }
    const body = tok.replace(/^--?/, '');
    const eq = body.indexOf('=');
    const key = eq >= 0 ? body.slice(0, eq) : body;
    const flag = byAlias.get(key);
    if (!flag) throw new ParseError(`Unknown flag "${tok}" for "${name}".`, tok);
    const fs = flagSpecs[flag] as FlagSpec;
    let value: string | true;
    if (fs.kind === 'bool') {
      const inline = eq >= 0 ? body.slice(eq + 1) : 'true';
      if (inline !== 'true' && inline !== 'false') throw new ParseError(`--${flag} takes no value (or =true/=false).`, tok);
      if (inline === 'false') continue;
      value = true;
    } else if (eq >= 0) {
      value = body.slice(eq + 1);
    } else {
      const next = rest[i + 1];
      if (next === undefined) throw new ParseError(`--${flag} needs a value.`, tok);
      value = next;
      i++;
    }
    if (fs.values && typeof value === 'string' && fs.kind !== 'list' && !fs.values.some((v) => v.toLowerCase() === (value as string).toLowerCase())) {
      throw new ParseError(`--${flag} must be one of ${fs.values.join(', ')}.`, value);
    }
    if (fs.kind === 'list') {
      const list = (values.get(flag) as string[] | undefined) ?? [];
      list.push(value as string);
      values.set(flag, list);
    } else {
      if (values.has(flag) && flag !== 'yes') throw new ParseError(`--${flag} is given more than once.`, tok);
      values.set(flag, value);
    }
    given.push([flag, value]);
  }

  let ns = '';
  if (spec.ns !== 'none') {
    const explicit = values.get('namespace');
    ns = typeof explicit === 'string' ? explicit.trim() : spec.ns === 'default' ? ctx.namespace : '';
    if (!ns) throw new ParseError(spec.ns === 'explicit' ? `"${name}" needs --namespace (it is not taken from the page).` : `"${name}" needs --namespace.`);
  }

  const built = spec.build(new Flags(name, values), ns, uuid);
  const usesNamespace = spec.ns !== 'none' && 'namespace' in built.request;
  const cliFlags: CliFlag[] = [
    ...(usesNamespace ? [['namespace', ns] as CliFlag] : []),
    ...given.filter(([flag]) => flag !== 'namespace' && flag !== 'yes'),
    ...(spec.cliYes || values.has('yes') ? [['yes', true] as CliFlag] : []),
  ];
  return {
    path: spec.path,
    method: built.method,
    request: built.request,
    plan: built.plan ?? { kind: 'call' },
    cli: cliCommand(spec.cliPath ?? spec.path, cliFlags),
    actions: methodActions(built.method, built.request),
    confirm: confirmFor(built.method, built.request),
    ...(built.reasonHeader !== undefined || needsReasonHeader(built.method) ? { reasonHeader: built.reasonHeader ?? '' } : {}),
    ...(built.output ? { output: built.output } : {}),
  };
}
