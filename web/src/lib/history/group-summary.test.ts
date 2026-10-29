import { describe, expect, it } from 'vitest';
import type { HistoryEvent } from '../temporal';
import { phaseLabel, retryPolicyText, summarizeGroup } from './group-summary';
import { buildGroups } from './groups';

const ev = (id: number, type: string, attrs: Record<string, unknown> = {}, second = id): HistoryEvent => {
  const key = type.charAt(0).toLowerCase() + type.slice(1) + 'EventAttributes';
  return {
    eventId: String(id),
    eventTime: `2026-10-27T08:00:${String(second).padStart(2, '0')}Z`,
    eventType: 'EVENT_TYPE_' + type.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(),
    [key]: attrs,
  };
};

const groupOf = (events: HistoryEvent[]) => {
  const g = buildGroups(events)[0];
  if (!g) throw new Error('no group');
  return g;
};

const field = (s: ReturnType<typeof summarizeGroup>, label: string) => s.fields.find((f) => f.label === label)?.value;

describe('summarizeGroup', () => {
  it('summarizes a failed activity with retry policy, times and payloads', () => {
    const s = summarizeGroup(
      groupOf([
        ev(5, 'ActivityTaskScheduled', {
          activityId: 'charge-1',
          activityType: { name: 'ChargeCard' },
          taskQueue: { name: 'payments' },
          input: { payloads: [{ data: 'aW4=' }] },
          startToCloseTimeout: '10s',
          scheduleToCloseTimeout: '0s',
          retryPolicy: { initialInterval: '1s', backoffCoefficient: 2, maximumInterval: '100s', maximumAttempts: 3 },
        }),
        ev(7, 'ActivityTaskStarted', { scheduledEventId: '5', attempt: 3, identity: 'worker@host' }),
        ev(
          8,
          'ActivityTaskFailed',
          { scheduledEventId: '5', startedEventId: '7', retryState: 'RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED', failure: { message: 'card declined', stackTrace: 'at charge()' } },
          20,
        ),
      ]),
    );
    expect(field(s, 'Activity type')).toBe('ChargeCard');
    expect(field(s, 'Activity ID')).toBe('charge-1');
    expect(field(s, 'Task queue')).toBe('payments');
    expect(field(s, 'Attempt')).toBe('3');
    expect(field(s, 'Retry policy')).toBe('max 3 attempts · initial 1s · backoff 2 · max interval 1m 40s');
    expect(field(s, 'Start to close')).toBe('10s');
    expect(field(s, 'Schedule to close')).toBeUndefined();
    expect(field(s, 'Worker')).toBe('worker@host');
    expect(field(s, 'Retry state')).toBe('maximum attempts reached');
    expect(s.times.map((t) => `${t.label} ${t.eventId}`)).toEqual(['Scheduled 5', 'Started 7', 'Failed 8']);
    expect(s.durationMs).toBe(15_000);
    expect(s.payloads.map((p) => p.label)).toEqual(['Input']);
    expect(s.failure?.stackTrace).toBe('at charge()');
  });

  it('prefers the pending activity for attempt and heartbeat details', () => {
    const group = groupOf([ev(5, 'ActivityTaskScheduled', { activityId: 'a', activityType: { name: 'Poll' } }), ev(6, 'ActivityTaskStarted', { scheduledEventId: '5', attempt: 1 })]);
    const s = summarizeGroup(group, { activityId: 'a', attempt: 4, heartbeatDetails: { payloads: [] } });
    expect(field(s, 'Attempt')).toBe('4');
    expect(s.payloads).toEqual([{ label: 'Last heartbeat details', value: { payloads: [] } }]);
  });

  it('reads heartbeat details from a heartbeat timeout', () => {
    const details = { payloads: [{ data: 'aGI=' }] };
    const group = groupOf([
      ev(5, 'ActivityTaskScheduled', { activityType: { name: 'Poll' } }),
      ev(6, 'ActivityTaskTimedOut', { scheduledEventId: '5', failure: { message: 'activity timeout', timeoutFailureInfo: { timeoutType: 'TIMEOUT_TYPE_HEARTBEAT', lastHeartbeatDetails: details } } }),
    ]);
    expect(summarizeGroup(group).payloads.find((p) => p.label === 'Last heartbeat details')?.value).toBe(details);
  });

  it('summarizes a timer', () => {
    const s = summarizeGroup(groupOf([ev(6, 'TimerStarted', { timerId: 't1', startToFireTimeout: '90s' }), ev(9, 'TimerFired', { timerId: 't1', startedEventId: '6' })]));
    expect(field(s, 'Timer ID')).toBe('t1');
    expect(field(s, 'Start to fire')).toBe('1m 30s');
    expect(s.times.map((t) => t.label)).toEqual(['Started', 'Fired']);
  });

  it('summarizes a signal, an update and a workflow task', () => {
    const signal = summarizeGroup(groupOf([ev(12, 'WorkflowExecutionSignaled', { signalName: 'poke', input: { payloads: [] }, identity: 'cli' })]));
    expect(field(signal, 'Signal')).toBe('poke');
    expect(signal.payloads[0]?.label).toBe('Input');
    expect(signal.durationMs).toBeNull();

    const update = summarizeGroup(
      groupOf([
        ev(20, 'WorkflowExecutionUpdateAccepted', { protocolInstanceId: 'u1', acceptedRequest: { meta: { updateId: 'u1' }, input: { name: 'setPrice', args: { payloads: [] } } } }),
        ev(21, 'WorkflowExecutionUpdateCompleted', { acceptedEventId: '20', meta: { updateId: 'u1' }, outcome: { failure: { message: 'bad price' } } }),
      ]),
    );
    expect(field(update, 'Update')).toBe('setPrice');
    expect(field(update, 'Update ID')).toBe('u1');
    expect(update.payloads.map((p) => p.label)).toEqual(['Input']);
    expect(update.failure?.message).toBe('bad price');

    const task = summarizeGroup(
      groupOf([
        ev(2, 'WorkflowTaskScheduled', { taskQueue: { name: 'main' }, startToCloseTimeout: '10s', attempt: 1 }),
        ev(3, 'WorkflowTaskStarted', { scheduledEventId: '2', identity: 'w1' }),
        ev(4, 'WorkflowTaskFailed', { scheduledEventId: '2', startedEventId: '3', cause: 'WORKFLOW_TASK_FAILED_CAUSE_UNHANDLED_COMMAND' }),
      ]),
    );
    expect(field(task, 'Cause')).toBe('unhandled command');
    expect(field(task, 'Worker')).toBe('w1');
  });
});

describe('helpers', () => {
  it('names phases without the group prefix', () => {
    expect(phaseLabel('EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED')).toBe('Initiated');
    expect(phaseLabel('EVENT_TYPE_ACTIVITY_TASK_CANCEL_REQUESTED')).toBe('Cancel Requested');
    expect(phaseLabel('EVENT_TYPE_MARKER_RECORDED')).toBe('MarkerRecorded');
  });

  it('describes an unlimited retry policy', () => {
    expect(retryPolicyText({ maximumAttempts: 0, nonRetryableErrorTypes: ['Fatal'] })).toBe('unlimited attempts · non-retryable: Fatal');
    expect(retryPolicyText(undefined)).toBe('');
  });
});
