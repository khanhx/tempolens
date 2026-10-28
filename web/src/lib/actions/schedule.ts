// Schedules: the spec builder behind the form, and request bodies for
// create, update, patch (pause, unpause, trigger, backfill) and delete.
import { api, seg } from '../api';
import type { Payload } from '../payload/decode';
import { parseHumanDuration, toProtoDuration } from '../time';
import { cliCommand } from './cli-command';
import type { ActionRequest } from './workflow-actions';

export interface CalendarRange {
  start?: number;
  end?: number;
  step?: number;
}

export interface StructuredCalendar {
  second?: CalendarRange[];
  minute?: CalendarRange[];
  hour?: CalendarRange[];
  dayOfMonth?: CalendarRange[];
  month?: CalendarRange[];
  year?: CalendarRange[];
  dayOfWeek?: CalendarRange[];
  comment?: string;
}

export interface ScheduleSpec {
  structuredCalendar?: StructuredCalendar[];
  cronString?: string[];
  interval?: { interval: string; phase?: string }[];
  timezoneName?: string;
  jitter?: string;
  startTime?: string;
  endTime?: string;
  [key: string]: unknown;
}

export const OVERLAP_POLICIES = [
  { value: 'SCHEDULE_OVERLAP_POLICY_SKIP', label: 'Skip', cli: 'Skip' },
  { value: 'SCHEDULE_OVERLAP_POLICY_BUFFER_ONE', label: 'Buffer one', cli: 'BufferOne' },
  { value: 'SCHEDULE_OVERLAP_POLICY_BUFFER_ALL', label: 'Buffer all', cli: 'BufferAll' },
  { value: 'SCHEDULE_OVERLAP_POLICY_CANCEL_OTHER', label: 'Cancel other', cli: 'CancelOther' },
  { value: 'SCHEDULE_OVERLAP_POLICY_TERMINATE_OTHER', label: 'Terminate other', cli: 'TerminateOther' },
  { value: 'SCHEDULE_OVERLAP_POLICY_ALLOW_ALL', label: 'Allow all', cli: 'AllowAll' },
] as const;

export type OverlapPolicy = (typeof OVERLAP_POLICIES)[number]['value'];
const overlapCli = (p: OverlapPolicy) => OVERLAP_POLICIES.find((o) => o.value === p)?.cli;

export type SpecMode = 'interval' | 'weekdays' | 'monthdays' | 'cron' | 'calendar';

export interface SpecForm {
  mode: SpecMode;
  /** Human duration, e.g. `1h` or `15m`. */
  every: string;
  /** Offset within the interval, e.g. `5m`. */
  offset: string;
  /** Days of week 0 (Sunday) to 6, or days of month 1 to 31. */
  days: number[];
  hour: number;
  minute: number;
  cron: string;
  /** Raw `structuredCalendar` JSON array. */
  calendar: string;
}

export const EMPTY_SPEC_FORM: SpecForm = { mode: 'interval', every: '1h', offset: '', days: [], hour: 0, minute: 0, cron: '', calendar: '[]' };

const duration = (human: string, what: string): string => {
  const ms = parseHumanDuration(human);
  if (ms === null || ms <= 0) throw new Error(`${what} must be a duration such as 30s, 15m or 1h30m.`);
  return toProtoDuration(ms);
};

const single = (n: number): CalendarRange[] => [{ start: n }];

function inRange(n: number, lo: number, hi: number, what: string): number {
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${what} must be between ${lo} and ${hi}.`);
  return n;
}

/** Builds the spec part the form controls. Throws with a readable message. */
export function buildSpec(f: SpecForm): ScheduleSpec {
  switch (f.mode) {
    case 'interval':
      return { interval: [{ interval: duration(f.every, 'Every'), ...(f.offset.trim() ? { phase: duration(f.offset, 'Offset') } : {}) }] };
    case 'weekdays':
    case 'monthdays': {
      if (f.days.length === 0) throw new Error('Pick at least one day.');
      const days = [...new Set(f.days)].sort((a, b) => a - b).map((d) => (f.mode === 'weekdays' ? inRange(d, 0, 6, 'Weekday') : inRange(d, 1, 31, 'Day of month')));
      return {
        structuredCalendar: [
          {
            hour: single(inRange(f.hour, 0, 23, 'Hour')),
            minute: single(inRange(f.minute, 0, 59, 'Minute')),
            ...(f.mode === 'weekdays' ? { dayOfWeek: days.map((d) => ({ start: d })) } : { dayOfMonth: days.map((d) => ({ start: d })) }),
          },
        ],
      };
    }
    case 'cron':
      if (!f.cron.trim()) throw new Error('Enter a cron expression.');
      return { cronString: [f.cron.trim()] };
    case 'calendar': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(f.calendar);
      } catch {
        throw new Error('The calendar spec is not valid JSON.');
      }
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('The calendar spec must be a non-empty JSON array.');
      return { structuredCalendar: parsed as StructuredCalendar[] };
    }
  }
}

const isSingle = (r: CalendarRange[] | undefined) => r?.length === 1 && r[0] !== undefined && (r[0].end === undefined || r[0].end === r[0].start) && !r[0].step;
const singleDays = (r: CalendarRange[] | undefined) =>
  r?.every((x) => x.start !== undefined && (x.end === undefined || x.end === x.start) && !x.step) ? r.map((x) => x.start ?? 0) : null;
const protoToHuman = (d: string | undefined) => {
  const s = Number((d ?? '').replace(/s$/, ''));
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
};

/**
 * The best form for an existing spec: simple shapes map back to their mode,
 * anything else is shown as the raw calendar. The server stores cron
 * strings as structured calendars, so cron comes back as a calendar.
 */
export function specToForm(spec: ScheduleSpec | undefined): SpecForm {
  if (!spec) return EMPTY_SPEC_FORM;
  const iv = spec.interval?.[0];
  if (iv && spec.interval?.length === 1 && !spec.structuredCalendar?.length && !spec.cronString?.length) {
    return { ...EMPTY_SPEC_FORM, mode: 'interval', every: protoToHuman(iv.interval), offset: protoToHuman(iv.phase) };
  }
  if (spec.cronString?.length === 1 && !spec.interval?.length && !spec.structuredCalendar?.length) {
    return { ...EMPTY_SPEC_FORM, mode: 'cron', cron: spec.cronString[0] ?? '' };
  }
  const cal = spec.structuredCalendar;
  const c = cal?.[0];
  if (cal?.length === 1 && c && !spec.interval?.length && isSingle(c.hour) && isSingle(c.minute) && (!c.second || (isSingle(c.second) && c.second[0]?.start === 0))) {
    const base = { ...EMPTY_SPEC_FORM, hour: c.hour?.[0]?.start ?? 0, minute: c.minute?.[0]?.start ?? 0 };
    const allMonths = !c.month || (c.month.length === 1 && c.month[0]?.start === 1 && c.month[0]?.end === 12);
    const allYears = !c.year || c.year.length === 0;
    const anyDayOfMonth = !c.dayOfMonth || (c.dayOfMonth.length === 1 && c.dayOfMonth[0]?.start === 1 && c.dayOfMonth[0]?.end === 31);
    const anyDayOfWeek = !c.dayOfWeek || (c.dayOfWeek.length === 1 && c.dayOfWeek[0]?.start === 0 && c.dayOfWeek[0]?.end === 6);
    if (allMonths && allYears) {
      const dow = singleDays(c.dayOfWeek);
      if (anyDayOfMonth && dow && !anyDayOfWeek) return { ...base, mode: 'weekdays', days: dow };
      const dom = singleDays(c.dayOfMonth);
      if (anyDayOfWeek && dom && !anyDayOfMonth) return { ...base, mode: 'monthdays', days: dom };
    }
  }
  return { ...EMPTY_SPEC_FORM, mode: 'calendar', calendar: JSON.stringify(cal ?? [], null, 2) };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number | undefined) => String(n ?? 0).padStart(2, '0');

/** One-line description for lists. */
export function describeSpec(spec: ScheduleSpec | undefined): string {
  if (!spec) return '';
  const f = specToForm(spec);
  const tz = spec.timezoneName ? ` ${spec.timezoneName}` : ' UTC';
  switch (f.mode) {
    case 'interval':
      return `Every ${f.every}${f.offset ? ` (offset ${f.offset})` : ''}`;
    case 'weekdays':
      return `${f.days.map((d) => WEEKDAYS[d] ?? d).join(', ')} at ${pad(f.hour)}:${pad(f.minute)}${tz}`;
    case 'monthdays':
      return `Day ${f.days.join(', ')} of the month at ${pad(f.hour)}:${pad(f.minute)}${tz}`;
    case 'cron':
      return `cron ${f.cron}`;
    default:
      return `${spec.structuredCalendar?.length ?? 0} calendar rule(s)${tz}`;
  }
}

export interface ScheduleForm {
  ns: string;
  scheduleId: string;
  workflowId: string;
  workflowType: string;
  taskQueue: string;
  input?: Payload[];
  spec: SpecForm;
  timezone: string;
  jitter: string;
  overlap: OverlapPolicy;
  catchupWindow: string;
  pauseOnFailure: boolean;
  paused: boolean;
  notes: string;
}

/** The `schedule` message for create and update. */
export function buildSchedule(f: ScheduleForm): Record<string, unknown> {
  if (!f.workflowId.trim() || !f.workflowType.trim() || !f.taskQueue.trim()) throw new Error('Workflow ID, type and task queue are required.');
  const spec: ScheduleSpec = {
    ...buildSpec(f.spec),
    ...(f.timezone.trim() ? { timezoneName: f.timezone.trim() } : {}),
    ...(f.jitter.trim() ? { jitter: duration(f.jitter, 'Jitter') } : {}),
  };
  return {
    spec,
    action: {
      startWorkflow: {
        workflowId: f.workflowId.trim(),
        workflowType: { name: f.workflowType.trim() },
        taskQueue: { name: f.taskQueue.trim() },
        ...(f.input ? { input: { payloads: f.input } } : {}),
      },
    },
    policies: {
      overlapPolicy: f.overlap,
      pauseOnFailure: f.pauseOnFailure,
      ...(f.catchupWindow.trim() ? { catchupWindow: duration(f.catchupWindow, 'Catch-up window') } : {}),
    },
    state: { paused: f.paused, ...(f.notes.trim() ? { notes: f.notes.trim() } : {}) },
  };
}

const schedulePath = (ns: string, id: string) => `/api/v1/namespaces/${seg(ns)}/schedules/${seg(id)}`;
const uuid = () => crypto.randomUUID();

export function createScheduleRequest(f: ScheduleForm): ActionRequest {
  if (!f.scheduleId.trim()) throw new Error('A schedule ID is required.');
  return {
    method: 'POST',
    path: schedulePath(f.ns, f.scheduleId.trim()),
    body: { schedule: buildSchedule(f), requestId: uuid() },
    cli: cliCommand(
      ['schedule', 'create'],
      [
        ['namespace', f.ns],
        ['schedule-id', f.scheduleId.trim()],
        ['workflow-id', f.workflowId.trim()],
        ['type', f.workflowType.trim()],
        ['task-queue', f.taskQueue.trim()],
        ['interval', f.spec.mode === 'interval' ? f.spec.every : undefined],
        ['cron', f.spec.mode === 'cron' ? f.spec.cron : undefined],
        ['overlap-policy', overlapCli(f.overlap)],
      ],
    ),
  };
}

export function updateScheduleRequest(f: ScheduleForm, conflictToken?: string): ActionRequest {
  return {
    method: 'POST',
    path: `${schedulePath(f.ns, f.scheduleId)}/update`,
    body: { schedule: buildSchedule(f), requestId: uuid(), ...(conflictToken ? { conflictToken } : {}) },
    cli: cliCommand(['schedule', 'update'], [['namespace', f.ns], ['schedule-id', f.scheduleId], ['workflow-id', f.workflowId], ['type', f.workflowType], ['task-queue', f.taskQueue]]),
  };
}

const patch = (ns: string, id: string, body: Record<string, unknown>, cli: string): ActionRequest => ({
  method: 'POST',
  path: `${schedulePath(ns, id)}/patch`,
  body: { patch: body, requestId: uuid() },
  cli,
});

export const pauseScheduleRequest = (ns: string, id: string, pause: boolean, note: string) =>
  patch(
    ns,
    id,
    pause ? { pause: note.trim() || 'Paused from Tempolens' } : { unpause: note.trim() || 'Unpaused from Tempolens' },
    cliCommand(['schedule', 'toggle'], [['namespace', ns], ['schedule-id', id], [pause ? 'pause' : 'unpause', true], ['reason', note.trim() || undefined]]),
  );

export const triggerScheduleRequest = (ns: string, id: string, overlap: OverlapPolicy) =>
  patch(ns, id, { triggerImmediately: { overlapPolicy: overlap } }, cliCommand(['schedule', 'trigger'], [['namespace', ns], ['schedule-id', id], ['overlap-policy', overlapCli(overlap)]]));

export function backfillScheduleRequest(ns: string, id: string, startTime: string, endTime: string, overlap: OverlapPolicy): ActionRequest {
  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new Error('Pick a start and an end time.');
  if (end <= start) throw new Error('The end must be after the start.');
  const s = new Date(start).toISOString();
  const e = new Date(end).toISOString();
  return patch(
    ns,
    id,
    { backfillRequest: [{ startTime: s, endTime: e, overlapPolicy: overlap }] },
    cliCommand(['schedule', 'backfill'], [['namespace', ns], ['schedule-id', id], ['start-time', s], ['end-time', e], ['overlap-policy', overlapCli(overlap)]]),
  );
}

export const deleteScheduleRequest = (ns: string, id: string): ActionRequest => ({
  method: 'DELETE',
  path: schedulePath(ns, id),
  cli: cliCommand(['schedule', 'delete'], [['namespace', ns], ['schedule-id', id]]),
});

/**
 * Number of schedules: CountSchedules, or on 404/501 (Temporal 1.24) the
 * count of running scheduler workflows, as upstream falls back.
 */
export async function countSchedules(ns: string): Promise<number> {
  try {
    const res = await api.get<{ count?: string }>(`/api/v1/namespaces/${seg(ns)}/schedule-count`);
    return Number(res.count ?? 0);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 404 && status !== 501 && status !== 405) throw err;
    const res = await api.get<{ count?: string }>(`/api/v1/namespaces/${seg(ns)}/workflow-count`, {
      query: 'TemporalNamespaceDivision = "TemporalScheduler" AND ExecutionStatus = "Running"',
    });
    return Number(res.count ?? 0);
  }
}
