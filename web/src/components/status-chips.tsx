import { STATUSES, statusInfo } from '../lib/temporal';

/** Workflow status badge; accepts the API enum name or the visibility value. */
export function StatusBadge({ status }: { status: string | undefined }) {
  const info = statusInfo(status);
  if (!info) return <span class="status status-unknown">{status ? status.replace(/^WORKFLOW_EXECUTION_STATUS_/, '') : 'Unknown'}</span>;
  return <span class={`status status-${info.css}`}>{info.label}</span>;
}

export interface StatusCountsProps {
  total: number | null;
  /** Count per visibility status value (`Running`, `Failed`, …). */
  counts: Record<string, number>;
  /** Status value currently filtered on, if exactly one. */
  active: string | null;
  onSelect: (value: string | null) => void;
  loading?: boolean;
}

/** Count chips from `GROUP BY ExecutionStatus`; clicking one filters on that status. */
export function StatusCounts({ total, counts, active, onSelect, loading }: StatusCountsProps) {
  return (
    <div class="count-chips" role="group" aria-label="Workflow counts by status">
      <button type="button" class="count-chip" aria-pressed={active === null} onClick={() => onSelect(null)}>
        All <strong>{loading && total === null ? '…' : (total ?? 0).toLocaleString('en-US')}</strong>
      </button>
      {STATUSES.filter((s) => (counts[s.value] ?? 0) > 0 || active === s.value).map((s) => (
        <button
          key={s.value}
          type="button"
          class={`count-chip count-chip-${s.css}`}
          aria-pressed={active === s.value}
          onClick={() => onSelect(active === s.value ? null : s.value)}
        >
          {s.label} <strong>{(counts[s.value] ?? 0).toLocaleString('en-US')}</strong>
        </button>
      ))}
    </div>
  );
}
