// Activity commands. Complete and fail by ID work on every server; pause,
// unpause and reset need Temporal 1.27+ and are hidden on older servers.
import { seg } from '../api';
import type { Payload } from '../payload/decode';
import { parseHumanDuration, toProtoDuration } from '../time';
import { cliCommand } from './cli-command';
import type { ActionRequest, WorkflowRef } from './workflow-actions';

/** Activity pause/unpause/reset exist from this server version on. */
export const ACTIVITY_COMMANDS_MIN_VERSION = [1, 27, 0] as const;

/** True when a `1.27.1`-style version is at least `min`. */
export function versionAtLeast(version: string | undefined, min: readonly number[]): boolean {
  const parts = (version ?? '').split(/[.-]/).map((p) => Number(p));
  for (let i = 0; i < min.length; i++) {
    const v = parts[i];
    const m = min[i] ?? 0;
    if (v === undefined || Number.isNaN(v)) return false;
    if (v !== m) return v > m;
  }
  return true;
}

const ids = (r: WorkflowRef, activityId: string) =>
  [
    ['namespace', r.ns],
    ['workflow-id', r.wf],
    ['run-id', r.run],
    ['activity-id', activityId],
  ] as const;

const byId = (r: WorkflowRef, activityId: string, op: string) => `/api/v1/namespaces/${seg(r.ns)}/workflows/${seg(r.wf)}/activities/${seg(activityId)}/${op}`;

export function completeActivityRequest(r: WorkflowRef, activityId: string, result: Payload[] | undefined, resultText = ''): ActionRequest {
  return {
    method: 'POST',
    path: byId(r, activityId, 'complete'),
    body: { runId: r.run, ...(result ? { result: { payloads: result } } : {}) },
    cli: cliCommand(['activity', 'complete'], [...ids(r, activityId), ['result', resultText.trim() || 'null']]),
  };
}

export interface ActivityFailure {
  message: string;
  type?: string;
  nonRetryable?: boolean;
}

export function failActivityRequest(r: WorkflowRef, activityId: string, f: ActivityFailure): ActionRequest {
  if (!f.message.trim()) throw new Error('A failure message is required.');
  return {
    method: 'POST',
    path: byId(r, activityId, 'fail'),
    body: {
      runId: r.run,
      failure: {
        message: f.message.trim(),
        source: 'Tempolens',
        applicationFailureInfo: { ...(f.type?.trim() ? { type: f.type.trim() } : {}), nonRetryable: !!f.nonRetryable },
      },
    },
    cli: cliCommand(['activity', 'fail'], [...ids(r, activityId), ['reason', f.message.trim()], ['detail', f.type?.trim() || undefined]]),
  };
}

export type ActivityCommand = 'pause' | 'unpause' | 'reset';

/** PauseActivity / UnpauseActivity / ResetActivity by activity ID (Temporal 1.27+). */
export function activityCommandRequest(r: WorkflowRef, activityId: string, cmd: ActivityCommand, reason = ''): ActionRequest {
  const execution = { workflowId: r.wf, runId: r.run };
  const body =
    cmd === 'pause'
      ? { execution, id: activityId, requestId: crypto.randomUUID(), ...(reason.trim() ? { reason: reason.trim() } : {}) }
      : cmd === 'unpause'
        ? { execution, id: activityId }
        : { execution, id: activityId, resetHeartbeat: true };
  return {
    method: 'POST',
    path: `/api/v1/namespaces/${seg(r.ns)}/activities-deprecated/${cmd}`,
    body,
    cli: cliCommand(['activity', cmd], [...ids(r, activityId), ['reason', cmd === 'pause' ? reason.trim() || undefined : undefined]]),
  };
}

export interface ActivityOptionsForm {
  /** Human durations (`30s`, `5m`); empty leaves the option unchanged. */
  startToCloseTimeout: string;
  scheduleToCloseTimeout: string;
  heartbeatTimeout: string;
  /** Empty leaves it unchanged; 0 means unlimited. */
  maximumAttempts: string;
}

const OPTION_DURATIONS = [
  ['startToCloseTimeout', 'start-to-close-timeout'],
  ['scheduleToCloseTimeout', 'schedule-to-close-timeout'],
  ['heartbeatTimeout', 'heartbeat-timeout'],
] as const;

/** UpdateActivityOptions by activity ID (Temporal 1.27+); only the filled fields are sent and masked. */
export function updateActivityOptionsRequest(r: WorkflowRef, activityId: string, f: ActivityOptionsForm): ActionRequest {
  const options: Record<string, unknown> = {};
  const mask: string[] = [];
  const flags: [string, string | undefined][] = [];
  for (const [key, flag] of OPTION_DURATIONS) {
    const text = f[key].trim();
    if (!text) continue;
    const ms = parseHumanDuration(text);
    if (ms === null || ms <= 0) throw new Error(`${flag} must be a duration such as 30s or 5m.`);
    options[key] = toProtoDuration(ms);
    mask.push(key);
    flags.push([flag, text]);
  }
  const attempts = f.maximumAttempts.trim();
  if (attempts) {
    if (!/^\d+$/.test(attempts)) throw new Error('Maximum attempts must be a whole number (0 = unlimited).');
    options.retryPolicy = { maximumAttempts: Number(attempts) };
    mask.push('retryPolicy.maximumAttempts');
    flags.push(['retry-maximum-attempts', attempts]);
  }
  if (mask.length === 0) throw new Error('Change at least one option.');
  return {
    method: 'POST',
    path: `/api/v1/namespaces/${seg(r.ns)}/activities-deprecated/update-options`,
    // A FieldMask is a comma-separated string of lowerCamel paths in proto JSON.
    body: { execution: { workflowId: r.wf, runId: r.run }, id: activityId, activityOptions: options, updateMask: mask.join(',') },
    cli: cliCommand(['activity', 'update-options'], [...ids(r, activityId), ...flags]),
  };
}
