import { useMemo, useState } from 'preact/hooks';
import type { Filter, Op, QueryCaps, SAType } from '../lib/query/build';
import { arity, buildClause, buildQuery, opsFor } from '../lib/query/build';
import { parseQuery } from '../lib/query/parse';
import { wrap } from '../lib/query/wrap';
import { STATUSES } from '../lib/temporal';

const COMMON_FIELDS = [
  'WorkflowType',
  'WorkflowId',
  'ExecutionStatus',
  'StartTime',
  'CloseTime',
  'RunId',
  'TaskQueue',
  'ParentWorkflowId',
  'ExecutionDuration',
  'HistoryLength',
];

export interface FilterBuilderProps {
  query: string;
  types: Record<string, SAType>;
  custom: string[];
  caps: QueryCaps;
  onChange: (query: string) => void;
}

const describe = (f: Filter) => {
  if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') return `${f.field} ${f.op.toLowerCase()}`;
  if (f.op === 'BETWEEN') return `${f.field} between ${f.values[0]} and ${f.values[1]}`;
  if (f.op === 'IN') return `${f.field} in ${f.values.join(', ')}`;
  return `${f.field} ${f.op === 'STARTS_WITH' ? 'starts with' : f.op} ${f.values[0]}`;
};

/** `datetime-local` value (local time) → RFC 3339 UTC. */
const localToIso = (v: string) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : v);

function ValueInput({ type, field, value, onInput, label }: { type: SAType; field: string; value: string; onInput: (v: string) => void; label: string }) {
  const set = (e: Event) => onInput((e.currentTarget as HTMLInputElement | HTMLSelectElement).value);
  if (field === 'ExecutionStatus') {
    return (
      <select class="select" aria-label={label} value={value} onChange={set}>
        <option value="">Status…</option>
        {STATUSES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
    );
  }
  if (type === 'Bool') {
    return (
      <select class="select" aria-label={label} value={value} onChange={set}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (type === 'Datetime') return <input class="input" type="datetime-local" step="1" aria-label={label} value={value} onInput={set} />;
  return <input class="input" aria-label={label} value={value} inputMode={type === 'Int' || type === 'Double' ? 'decimal' : undefined} onInput={set} />;
}

/**
 * Structured view of the query. Each chip is one clause of a plain
 * AND-conjunction; a query the parser cannot represent stays raw-only.
 */
export function FilterBuilder({ query, types, custom, caps, onChange }: FilterBuilderProps) {
  const filters = useMemo(() => parseQuery(query, types), [query, types]);
  const fields = useMemo(() => {
    const rest = Object.keys(types)
      .filter((f) => !COMMON_FIELDS.includes(f) && !custom.includes(f))
      .sort();
    return [...COMMON_FIELDS.filter((f) => types[f]), ...custom, ...rest];
  }, [types, custom]);

  const [field, setField] = useState('WorkflowType');
  const type: SAType = types[field] ?? 'Keyword';
  const ops = opsFor(type, caps);
  const [op, setOp] = useState<Op>('=');
  const activeOp = ops.includes(op) ? op : (ops[0] ?? '=');
  const [v1, setV1] = useState('');
  const [v2, setV2] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = (e: Event) => {
    e.preventDefault();
    const n = arity(activeOp);
    const raw = n === -1 ? v1.split(',').map((s) => s.trim()).filter(Boolean) : n === 2 ? [v1, v2] : n === 1 ? [v1 || (type === 'Bool' ? 'true' : '')] : [];
    const values = type === 'Datetime' ? raw.map(localToIso) : raw;
    const filter: Filter = { field, op: activeOp, values };
    try {
      if (n !== 0 && values.some((v) => v === '')) throw new Error('Enter a value.');
      const clause = buildClause(filter, type, caps);
      onChange(filters ? buildQuery([...filters, filter], types, caps) : wrap(query, clause));
      setV1('');
      setV2('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = (index: number) => {
    if (!filters) return;
    onChange(buildQuery(filters.filter((_, i) => i !== index), types, caps));
  };

  return (
    <div class="filter-builder">
      {filters === null ? (
        <p class="muted filter-note">This query uses OR, parentheses or ordering, so it can only be edited as raw text. New filters are added with AND.</p>
      ) : (
        filters.length > 0 && (
          <ul class="chips" aria-label="Active filters">
            {filters.map((f, i) => (
              <li key={`${i}-${f.field}`} class="chip">
                <span>{describe(f)}</span>
                <button type="button" class="chip-remove" aria-label={`Remove filter ${describe(f)}`} onClick={() => remove(i)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )
      )}
      <form class="filter-add" onSubmit={add}>
        <select class="select" aria-label="Field" value={field} onChange={(e) => setField((e.currentTarget as HTMLSelectElement).value)}>
          {fields.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <select class="select" aria-label="Operator" value={activeOp} onChange={(e) => setOp((e.currentTarget as HTMLSelectElement).value as Op)}>
          {ops.map((o) => (
            <option key={o} value={o}>
              {o === 'STARTS_WITH' ? 'starts with' : o.toLowerCase()}
            </option>
          ))}
        </select>
        {arity(activeOp) !== 0 && (
          <ValueInput type={type} field={field} value={v1} onInput={setV1} label={arity(activeOp) === -1 ? 'Values, comma separated' : 'Value'} />
        )}
        {arity(activeOp) === 2 && <ValueInput type={type} field={field} value={v2} onInput={setV2} label="Upper bound" />}
        <button type="submit" class="btn">
          Add filter
        </button>
        {error && (
          <span class="field-error" role="alert">
            {error}
          </span>
        )}
      </form>
    </div>
  );
}
