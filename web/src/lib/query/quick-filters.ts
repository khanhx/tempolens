// One-click views: upstream's system saved views plus the on-call filters.
// Each is a query plus a range; relative ranges are resolved at fetch time.

export interface QuickFilter {
  id: string;
  label: string;
  query: string;
  range: string;
}

export interface QuickFilterCaps {
  /** `namespaceInfo.capabilities.reportedProblemsSearchAttribute`. */
  reportedProblems?: boolean;
}

/** Local midnight today as RFC 3339, for the "Today" view. */
function localMidnight(now: Date): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function quickFilters(now: Date = new Date(), caps: QuickFilterCaps = {}): QuickFilter[] {
  const filters: QuickFilter[] = [
    { id: 'all', label: 'All', query: '', range: '' },
    { id: 'running', label: 'Running', query: 'ExecutionStatus = "Running"', range: '' },
    { id: 'parents', label: 'Parent workflows', query: 'ParentWorkflowId IS NULL', range: '' },
    { id: 'today', label: 'Today', query: '', range: `${localMidnight(now)}..` },
    { id: 'last-hour', label: 'Last hour', query: '', range: '1h' },
    { id: 'failed-24h', label: 'Failed, 24 h', query: 'ExecutionStatus = "Failed"', range: 'close:24h' },
    { id: 'running-1h', label: 'Running > 1 h', query: 'ExecutionStatus = "Running"', range: '>1h' },
    { id: 'timed-out-24h', label: 'Timed out, 24 h', query: 'ExecutionStatus = "TimedOut"', range: 'close:24h' },
    { id: 'terminated-24h', label: 'Terminated, 24 h', query: 'ExecutionStatus = "Terminated"', range: 'close:24h' },
  ];
  if (caps.reportedProblems) {
    filters.splice(3, 0, {
      id: 'task-failures',
      label: 'Task failures',
      query:
        'ExecutionStatus = "Running" AND TemporalReportedProblems IN ("category=WorkflowTaskFailed", "category=WorkflowTaskTimedOut")',
      range: '',
    });
  }
  return filters;
}

/** The quick filter that matches the current state exactly, if any. */
export function activeQuickFilter(filters: QuickFilter[], query: string, range: string): QuickFilter | undefined {
  return filters.find((f) => f.query === query.trim() && f.range === range);
}
