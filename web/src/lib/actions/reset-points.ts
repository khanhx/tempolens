// Reset points as the temporal CLI's `--type` computes them.
import type { HistoryEvent } from '../temporal';
import { eventAttributes } from '../temporal';

export type ResetType = 'FirstWorkflowTask' | 'LastWorkflowTask' | 'LastContinuedAsNew';

const COMPLETED = 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED';

/** The first WorkflowTaskCompleted event ID. */
export function firstWorkflowTask(events: readonly HistoryEvent[]): string | undefined {
  return events.find((e) => e.eventType === COMPLETED)?.eventId;
}

/** The last WorkflowTaskCompleted event ID. */
export function lastWorkflowTask(events: readonly HistoryEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.eventType === COMPLETED) return e.eventId;
  }
  return undefined;
}

/**
 * The run this run continued from (`continuedExecutionRunId` on its start
 * event). LastContinuedAsNew resets that run to its last workflow task.
 */
export function previousRunId(events: readonly HistoryEvent[]): string | undefined {
  const start = events.find((e) => e.eventType === 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED');
  const id = start ? eventAttributes(start).continuedExecutionRunId : undefined;
  return typeof id === 'string' && id ? id : undefined;
}
