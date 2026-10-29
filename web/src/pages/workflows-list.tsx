import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import type { Column } from '../components/data-table';
import { ActionMenu } from '../components/action-menu';
import { ColumnPicker, DataTable } from '../components/data-table';
import { useLazyModule } from '../components/lazy-load';
import { Modal } from '../components/modal';
import { GatedButton } from '../components/role-gate';
import type { BatchKind } from '../lib/actions/batch';
import { BATCH_ACTION } from '../lib/actions/batch';
import { canAll } from '../lib/me';
import { isRunning } from '../lib/temporal';
import type { BatchTarget } from './actions/batch-dialog';
import type { WorkflowActionKind } from './actions/workflow-dialogs';
import { FilterBuilder } from '../components/filter-builder';
import { useShortcuts } from '../components/keyboard';
import { RawQuery } from '../components/raw-query';
import { StatusBadge, StatusCounts } from '../components/status-chips';
import { Timestamp } from '../components/timestamp';
import type { ApiError } from '../lib/api';
import { api, seg } from '../lib/api';
import type { Payload } from '../lib/payload/decode';
import { decodeFields, decodePayload } from '../lib/payload/decode';
import { stringifyJson } from '../lib/payload/json-bigint';
import { autoRefresh, listView } from '../lib/prefs';
import type { Filter, SAType } from '../lib/query/build';
import { buildQuery, quoteString } from '../lib/query/build';
import { parseQuery } from '../lib/query/parse';
import type { Preset } from '../lib/query/presets';
import { deletePreset, listPresets, savePreset } from '../lib/query/presets';
import { activeQuickFilter, quickFilters } from '../lib/query/quick-filters';
import { describeRange, parseRange, RANGE_PRESETS, rangeClause } from '../lib/query/range';
import type { ListState } from '../lib/query/url-state';
import { listSearch, parseListState, PER_PAGE_OPTIONS } from '../lib/query/url-state';
import { splitOrderBy, withOrderBy, wrap } from '../lib/query/wrap';
import type { NamespaceSearchAttributes } from '../lib/server-info';
import { clusterInfo, describeNamespace, hasCapability, searchAttributes } from '../lib/server-info';
import type { SortType } from '../lib/sort';
import { sortRows, supportsOrderBy } from '../lib/sort';
import type { ColumnWidths } from '../lib/table/columns';
import { isMemoId, loadColumns, loadWidths, memoId, memoKeyOf, memoKeys, dropColumn, resolveColumns, saveColumns, saveWidths } from '../lib/table/columns';
import type * as MemoDecode from '../lib/table/memo-decode';
import { nextSort } from '../lib/table/sort-cycle';
import type { WorkflowExecutionInfo } from '../lib/temporal';
import { formatDuration, parseDuration } from '../lib/time';
import { NamespaceErrorsBanner } from '../components/partial-banner';
import { namespaceName, namespaces as namespaceList } from '../lib/namespaces';
import type { NamespaceError, NamespaceSelection } from '../lib/xapi';
import { commonAttributes, X_PAGE_SIZE_MAX, xapi } from '../lib/xapi';
import { href, P, searchHref } from '../routes';

/** A list row; `tlNamespace` is set on cross-namespace rows. */
type Row = WorkflowExecutionInfo & { tlNamespace?: string };
const rowNamespace = (r: Row, fallback: string) => r.tlNamespace ?? fallback;

/** SQL visibility sorts only this many loaded rows on the client. */
const CLIENT_SORT_WINDOW = 1000;

const saCache = new WeakMap<Row, Record<string, unknown>>();
function rowAttributes(row: Row): Record<string, unknown> {
  let v = saCache.get(row);
  if (!v) {
    v = decodeFields(row.searchAttributes?.indexedFields);
    saCache.set(row, v);
  }
  return v;
}

const display = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : stringifyJson(v, 0));
const num = (v: string | undefined) => (v ? Number(v).toLocaleString('en-US') : '');

interface ColumnDef {
  id: string;
  label: string;
  width?: string;
  get: (r: Row) => unknown;
  sortType?: SortType;
  /** True while the sort type is not known yet (memo values still decoding); a header click waits for it. */
  sortPending?: boolean;
  /** Search attribute for a server-side ORDER BY (Elasticsearch only). */
  sortField?: string;
  render?: (r: Row, ns: string) => preact.ComponentChildren;
  tag?: string;
  hint?: string;
}

const BASE_COLUMNS: ColumnDef[] = [
  { id: 'status', label: 'Status', width: '120px', get: (r) => r.status, sortType: 'keyword', sortField: 'ExecutionStatus', render: (r) => <StatusBadge status={r.status} /> },
  {
    id: 'id',
    label: 'Workflow ID',
    width: '28%',
    get: (r) => r.execution.workflowId,
    sortType: 'keyword',
    sortField: 'WorkflowId',
    render: (r, ns) => (
      <span class="cell-id">
        <a href={href(P.run, { ns, wf: r.execution.workflowId, run: r.execution.runId ?? '' })}>{r.execution.workflowId}</a>
        <a
          class="cell-aside"
          href={href(P.workflows, { ns }, { query: `ParentWorkflowId = ${quoteString(r.execution.workflowId)}` })}
          title="Show child workflows"
          aria-label={`Show child workflows of ${r.execution.workflowId}`}
        >
          children
        </a>
      </span>
    ),
  },
  { id: 'run', label: 'Run ID', width: '22%', get: (r) => r.execution.runId, sortType: 'keyword', sortField: 'RunId', render: (r) => <code>{r.execution.runId}</code> },
  { id: 'type', label: 'Type', width: '16%', get: (r) => r.type?.name, sortType: 'keyword', sortField: 'WorkflowType' },
  { id: 'start', label: 'Start', width: '150px', get: (r) => r.startTime, sortType: 'datetime', sortField: 'StartTime', render: (r) => <Timestamp value={r.startTime} /> },
  { id: 'end', label: 'End (close time)', width: '150px', get: (r) => r.closeTime, sortType: 'datetime', sortField: 'CloseTime', render: (r) => <Timestamp value={r.closeTime} /> },
  {
    id: 'duration',
    label: 'Duration',
    width: '100px',
    get: (r) => r.executionDuration,
    sortType: 'duration',
    sortField: 'ExecutionDuration',
    render: (r) => formatDuration(parseDuration(r.executionDuration)),
  },
  { id: 'exec-time', label: 'Execution time', width: '150px', get: (r) => r.executionTime, sortType: 'datetime', sortField: 'ExecutionTime', render: (r) => <Timestamp value={r.executionTime} /> },
  { id: 'history-length', label: 'History length', width: '110px', get: (r) => r.historyLength, sortType: 'int', sortField: 'HistoryLength', render: (r) => num(r.historyLength) },
  { id: 'history-size', label: 'History size (B)', width: '120px', get: (r) => r.historySizeBytes, sortType: 'int', sortField: 'HistorySizeBytes', render: (r) => num(r.historySizeBytes) },
  { id: 'transitions', label: 'State transitions', width: '120px', get: (r) => r.stateTransitionCount, sortType: 'int', sortField: 'StateTransitionCount', render: (r) => num(r.stateTransitionCount) },
  { id: 'task-queue', label: 'Task queue', width: '14%', get: (r) => r.taskQueue, sortType: 'keyword', sortField: 'TaskQueue' },
  { id: 'parent', label: 'Parent workflow', width: '18%', get: (r) => r.parentExecution?.workflowId, sortType: 'keyword', sortField: 'ParentWorkflowId' },
  { id: 'root', label: 'Root workflow', width: '18%', get: (r) => r.rootExecution?.workflowId, sortType: 'keyword', sortField: 'RootWorkflowId' },
];

const DEFAULT_COLUMNS = ['status', 'id', 'run', 'type', 'start', 'end'];

const NAMESPACE_COLUMN: ColumnDef = {
  id: 'namespace',
  label: 'Namespace',
  width: '130px',
  get: (r) => r.tlNamespace,
  sortType: 'keyword',
  render: (_r, ns) => <a href={href(P.workflows, { ns })}>{ns}</a>,
};

const rowKeyOf = (r: Row) => `${r.tlNamespace ?? ''}/${r.execution.workflowId}/${r.execution.runId ?? ''}`;

function dedupeErrors(errors: NamespaceError[]): NamespaceError[] {
  const seen = new Map<string, NamespaceError>();
  for (const e of errors) seen.set(`${e.namespace}:${e.code}:${e.message}`, e);
  return [...seen.values()];
}

const SA_SORT: Partial<Record<SAType, SortType>> = { Int: 'int', Double: 'number', Datetime: 'datetime', Keyword: 'keyword', Text: 'keyword', Bool: 'keyword' };

function attributeColumn(name: string, type: SAType): ColumnDef {
  return {
    id: `sa:${name}`,
    label: name,
    width: '140px',
    get: (r) => {
      const v = rowAttributes(r)[name];
      return type === 'Int' || type === 'Double' || type === 'Datetime' ? v : display(v);
    },
    sortType: SA_SORT[type],
    sortField: type === 'KeywordList' ? undefined : name,
    render: (r) => display(rowAttributes(r)[name]),
  };
}

type MemoModule = typeof MemoDecode;

/**
 * A memo column; values appear once the lazily loaded decoder has decoded them.
 * Its sort type comes from the decoded values, so it is pending until they
 * arrive, unless the decoder failed to load and never will.
 */
function memoColumn(key: string, memo: MemoModule | null, memoFailed: boolean, rows: readonly Row[]): ColumnDef {
  const get = (r: Row) => memo?.memoValue(r, key);
  const ready = (r: Row) => (memo ? memo.memoReady(r, key) : !r.memo?.fields?.[key]);
  const sortType = memo ? memo.memoSortType(rows, key) : memoFailed || rows.every(ready) ? 'keyword' : null;
  return {
    id: memoId(key),
    label: key,
    width: '140px',
    tag: 'memo',
    hint: `Memo ${key}: display and client sort only; not server-filterable`,
    get,
    sortType: sortType ?? 'keyword',
    sortPending: sortType === null,
    render: (r) => (ready(r) ? display(get(r)) : <span class="muted">…</span>),
  };
}

/** Says that a sort covers the loaded rows only, and why the server cannot sort. */
function LocalSortNotice({ reason, loaded, more, loading, onMore }: { reason: string; loaded: number; more: number | null; loading: boolean; onMore: () => void }) {
  return (
    <div class="alert" role="status">
      Sorted locally across {loaded.toLocaleString('en-US')} loaded rows (sorts loaded rows only) — {reason}.
      {more !== null && loaded < CLIENT_SORT_WINDOW && (
        <>
          {' '}
          <button type="button" class="btn btn-sm" disabled={loading} onClick={onMore}>
            Load {more} more
          </button>
        </>
      )}
      {more !== null && loaded >= CLIENT_SORT_WINDOW && <> The sort window is full at {CLIENT_SORT_WINDOW} rows; narrow the query to sort the rest.</>}
    </div>
  );
}

/** The memo-key half of the column picker: a free-text key becomes a `memo:<key>` column. */
function MemoKeyForm({ onAdd }: { onAdd: (key: string) => void }) {
  const [key, setKey] = useState('');
  return (
    <form
      class="menu-item"
      onSubmit={(e) => {
        e.preventDefault();
        if (key.trim()) onAdd(key.trim());
        setKey('');
      }}
    >
      <input class="input" placeholder="Memo key" aria-label="Memo key" value={key} onInput={(e) => setKey((e.currentTarget as HTMLInputElement).value)} />
      <button class="btn btn-sm" type="submit" disabled={!key.trim()}>
        Add memo column
      </button>
    </form>
  );
}

interface CountResponse {
  count?: string;
  groups?: { groupValues?: Payload[]; count?: string }[];
}

function parseCounts(res: CountResponse): { total: number; byStatus: Record<string, number> } {
  const byStatus: Record<string, number> = {};
  for (const g of res.groups ?? []) {
    const first = g.groupValues?.[0];
    const d = first ? decodePayload(first) : null;
    if (d?.kind === 'value' && typeof d.value === 'string') byStatus[d.value] = Number(g.count ?? 0);
  }
  return { total: Number(res.count ?? 0), byStatus };
}

/** The single `ExecutionStatus = x` value in a parseable query, if any. */
function statusFilterValue(filters: Filter[] | null): string | null {
  const s = filters?.filter((f) => f.field === 'ExecutionStatus');
  return s?.length === 1 && s[0]?.op === '=' ? (s[0].values[0] ?? null) : null;
}

const FALLBACK_TYPES: Record<string, SAType> = {
  WorkflowId: 'Keyword',
  WorkflowType: 'Keyword',
  ExecutionStatus: 'Keyword',
  RunId: 'Keyword',
  StartTime: 'Datetime',
  CloseTime: 'Datetime',
  TaskQueue: 'Keyword',
};

function RangePicker({ value, onChange }: { value: string; onChange: (range: string) => void }) {
  const parsed = parseRange(value);
  const close = parsed?.field === 'CloseTime';
  const spec = value.replace(/^close:/, '');
  const isCustom = parsed?.kind === 'between';
  const [custom, setCustom] = useState(isCustom);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const withField = (s: string, closeField = close) => (s ? `${closeField ? 'close:' : ''}${s}` : '');

  return (
    <div class="toolbar-group" role="group" aria-label="Time range">
      <select
        class="select"
        aria-label="Time range"
        value={custom || isCustom ? 'custom' : spec}
        onChange={(e) => {
          const v = (e.currentTarget as HTMLSelectElement).value;
          if (v === 'custom') return setCustom(true);
          setCustom(false);
          onChange(withField(v));
        }}
      >
        <option value="">Any time</option>
        {RANGE_PRESETS.map((p) => (
          <option key={p} value={p}>
            Last {p}
          </option>
        ))}
        <option value=">1h">Older than 1h</option>
        <option value=">24h">Older than 24h</option>
        <option value="custom">Custom…</option>
      </select>
      <select class="select" aria-label="Time field" value={close ? 'close' : 'start'} onChange={(e) => onChange(withField(spec, (e.currentTarget as HTMLSelectElement).value === 'close'))}>
        <option value="start">Start time</option>
        <option value="close">Close time</option>
      </select>
      {(custom || isCustom) && (
        <form
          class="toolbar-group"
          onSubmit={(e) => {
            e.preventDefault();
            const f = from ? new Date(from).toISOString() : '';
            const t = to ? new Date(to).toISOString() : '';
            if (f || t) onChange(withField(`${f}..${t}`));
          }}
        >
          <input class="input" type="datetime-local" step="1" aria-label="From" value={from} onInput={(e) => setFrom((e.currentTarget as HTMLInputElement).value)} />
          <input class="input" type="datetime-local" step="1" aria-label="To" value={to} onInput={(e) => setTo((e.currentTarget as HTMLInputElement).value)} />
          <button class="btn" type="submit">
            Apply
          </button>
        </form>
      )}
      {parsed && <span class="muted">{describeRange(parsed)}</span>}
    </div>
  );
}

function PresetMenu({ ns, state, onApply }: { ns: string; state: ListState; onApply: (p: Preset) => void }) {
  const [presets, setPresets] = useState<Preset[]>(() => listPresets(ns));
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setPresets(listPresets(ns)), [ns]);
  const run = (fn: () => Preset[]) => {
    try {
      setPresets(fn());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <details class="menu">
      <summary class="btn">Saved views{presets.length ? ` (${presets.length})` : ''}</summary>
      <div class="menu-panel">
        {presets.length === 0 && <p class="muted">No saved views in this namespace.</p>}
        {presets.map((p) => (
          <div key={p.name} class="menu-item">
            <button type="button" class="btn btn-ghost btn-sm" title={p.query || 'All workflows'} onClick={() => onApply(p)}>
              {p.name}
            </button>
            <button type="button" class="btn btn-ghost btn-sm" aria-label={`Delete saved view ${p.name}`} onClick={() => run(() => deletePreset(ns, p.name))}>
              ×
            </button>
          </div>
        ))}
        <form
          class="menu-item"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => savePreset(ns, { name, query: state.query, range: state.range }));
            setName('');
          }}
        >
          <input class="input" placeholder="Save current view as…" aria-label="Saved view name" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
          <button class="btn btn-sm" type="submit">
            Save
          </button>
        </form>
        {error && (
          <p class="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}

function RowActions({ row, ns, onPick, onClose }: { row: Row; ns: string; onPick: (kind: WorkflowActionKind) => void; onClose: () => void }) {
  const running = isRunning(row.status);
  const items: { kind: 'signal' | 'cancel' | 'terminate' | 'reset' | 'delete'; label: string; show: boolean }[] = [
    { kind: 'signal', label: 'Signal', show: running },
    { kind: 'cancel', label: 'Request cancellation', show: running },
    { kind: 'terminate', label: 'Terminate', show: running },
    { kind: 'reset', label: 'Reset', show: true },
    { kind: 'delete', label: 'Delete', show: true },
  ];
  return (
    <Modal title={row.execution.workflowId} onClose={onClose}>
      <div class="stack">
        <a class="btn" href={href(P.run, { ns, wf: row.execution.workflowId, run: row.execution.runId ?? '' })}>
          Open
        </a>
        {items
          .filter((i) => i.show)
          .map((i) => (
            <GatedButton key={i.kind} actions={[i.kind]} onClick={() => onPick(i.kind)}>
              {i.label}
            </GatedButton>
          ))}
        <button type="button" class="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

interface ListData {
  errors: NamespaceError[];
  rows: Row[];
  token: string | undefined;
  loading: boolean;
  error: ApiError | Error | null;
}

function NamespacePicker({ selected, onChange }: { selected: string[] | null; onChange: (ns: string[] | null) => void }) {
  const names = (namespaceList.value ?? []).map(namespaceName);
  const toggle = (n: string) => {
    const cur = selected ?? [];
    const next = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n];
    onChange(next.length ? next : null);
  };
  return (
    <details class="menu">
      <summary class="btn">{selected ? `${selected.length} namespace${selected.length === 1 ? '' : 's'}` : 'All namespaces'} ▾</summary>
      <div class="menu-panel" role="group" aria-label="Namespaces">
        <label class="menu-item">
          <input type="checkbox" checked={!selected} onChange={() => onChange(null)} /> All namespaces
        </label>
        {names.map((n) => (
          <label key={n} class="menu-item">
            <input type="checkbox" checked={!!selected?.includes(n)} onChange={() => toggle(n)} /> {n}
          </label>
        ))}
      </div>
    </details>
  );
}

export default function WorkflowsList() {
  const { params } = useRoute();
  // `/workflows` (no namespace in the path) is the cross-namespace view.
  const cross = !params.ns;
  const ns = params.ns ?? '';
  const { path, url, route } = useLocation();
  const search = url.includes('?') ? url.slice(url.indexOf('?')) : '';
  const state = useMemo(() => parseListState(search), [search]);
  const update = (patch: Partial<ListState>) => route(path + listSearch({ ...state, ...patch }));

  const [sa, setSa] = useState<NamespaceSearchAttributes>({ types: FALLBACK_TYPES, custom: [] });
  // Until the attribute list arrives, `sa:` ids cannot be checked, so they are kept rather than dropped.
  const [saLoaded, setSaLoaded] = useState(false);
  const [missingAttrs, setMissingAttrs] = useState<Record<string, string[]>>({});
  const [reportedProblems, setReportedProblems] = useState(false);
  const selection: NamespaceSelection = state.ns?.length ? state.ns : '*';
  const selectionKey = selection === '*' ? '*' : selection.join(',');
  const allNames = (namespaceList.value ?? []).map(namespaceName).join(',');

  // Cross-namespace: only attributes every selected namespace has can be queried.
  useEffect(() => {
    if (!cross) return;
    const names = selection === '*' ? allNames.split(',').filter(Boolean) : [...selection];
    if (names.length === 0) return;
    let cancelled = false;
    setSaLoaded(false);
    Promise.all(names.map((n) => searchAttributes(n).then((v) => [n, v] as const))).then(
      (pairs) => {
        if (cancelled) return;
        const common = commonAttributes(Object.fromEntries(pairs));
        setSa({ types: { ...FALLBACK_TYPES, ...common.types }, custom: common.custom });
        setSaLoaded(true);
        setMissingAttrs(common.missing);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [cross, selectionKey, allNames]);

  useEffect(() => {
    if (cross) return;
    let cancelled = false;
    setSaLoaded(false);
    searchAttributes(ns).then(
      (v) => {
        if (cancelled) return;
        setSa(v);
        setSaLoaded(true);
      },
      () => undefined,
    );
    describeNamespace(ns).then(
      (d) => !cancelled && setReportedProblems(d.namespaceInfo?.capabilities?.reportedProblemsSearchAttribute === true),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [ns]);

  const caps = { prefixSearch: hasCapability('prefixSearch') };
  // /api/x orders rows itself and rejects ORDER BY, so the cross view always sorts locally.
  const es = !cross && supportsOrderBy(clusterInfo.value?.visibilityStore);
  const pageSize = cross ? Math.min(state.perPage, X_PAGE_SIZE_MAX) : state.perPage;
  const prefsKey = cross ? '*' : ns;

  const [data, setData] = useState<ListData>({ rows: [], token: undefined, loading: true, error: null, errors: [] });

  const fixedColumns = useMemo(
    () => [...(cross ? [NAMESPACE_COLUMN] : []), ...BASE_COLUMNS, ...sa.custom.map((n) => attributeColumn(n, sa.types[n] ?? 'Keyword'))],
    [sa, cross],
  );
  // URL > saved preference > default; ids that name no column (any more) are dropped.
  const fixedIds = new Set(fixedColumns.map((c) => c.id));
  const visibleIds = resolveColumns([state.cols, loadColumns(prefsKey)], cross ? ['namespace', ...DEFAULT_COLUMNS] : DEFAULT_COLUMNS, (id) => fixedIds.has(id) || isMemoId(id) || (!saLoaded && id.startsWith('sa:')));
  const visibleMemoKeys = visibleIds.filter(isMemoId).map(memoKeyOf);
  const memoKeysKey = JSON.stringify(visibleMemoKeys);
  const memoModule = useLazyModule(() => import('../lib/table/memo-decode'), visibleMemoKeys.length > 0);
  const memo = memoModule instanceof Error ? null : memoModule;
  const memoFailed = memoModule instanceof Error;
  const [memoVersion, setMemoVersion] = useState(0);
  const discoveredMemoKeys = useMemo(() => memoKeys(data.rows), [data.rows]);
  // Serialised so the memo below only recomputes when the set of keys changes.
  const memoKeysAll = JSON.stringify([...new Set([...discoveredMemoKeys, ...visibleMemoKeys])]);
  const allColumns = useMemo(
    () => [...fixedColumns, ...(JSON.parse(memoKeysAll) as string[]).map((k) => memoColumn(k, memo, memoFailed, data.rows))],
    [fixedColumns, memoKeysAll, memo, memoFailed, memoVersion, data.rows],
  );

  // Memo payloads of the loaded rows are decoded once each, one batch per load.
  useEffect(() => {
    if (!memo || visibleMemoKeys.length === 0) return;
    memo.decodeMemos(data.rows, visibleMemoKeys, (r) => rowNamespace(r, ns)).then(
      (n) => n > 0 && setMemoVersion((v) => v + 1),
      // decodeMemos handles codec failures itself; anything else leaves the cells pending.
      () => undefined,
    );
  }, [memo, data.rows, memoKeysKey, ns]);

  const sortCol = state.sort ? allColumns.find((c) => c.id === state.sort?.column) : undefined;
  // Elasticsearch sorts a column with a sort attribute; everything else sorts the loaded rows.
  const serverOrder = es && state.sort && sortCol?.sortField ? `ORDER BY ${sortCol.sortField} ${state.sort.dir.toUpperCase()}` : '';
  const clientSort = !serverOrder && state.sort && sortCol?.sortType ? { col: sortCol, dir: state.sort.dir } : null;
  const localSortReason = cross
    ? 'the all-namespaces view cannot sort on the server'
    : !es
      ? 'SQL visibility cannot sort'
      : `${sortCol?.label ?? 'this column'} cannot be sorted by the server`;

  // Relative ranges resolve at fetch time, so this is a function, not a value.
  const effectiveQuery = useCallback(() => {
    const r = parseRange(state.range);
    const base = wrap(state.query, r ? rangeClause(r) : '');
    return serverOrder ? withOrderBy(base, serverOrder) : base;
  }, [state.query, state.range, serverOrder]);

  const [countErrors, setCountErrors] = useState<NamespaceError[]>([]);
  const [counts, setCounts] = useState<{ total: number | null; byStatus: Record<string, number>; loading: boolean }>({ total: null, byStatus: {}, loading: true });
  const [page, setPage] = useState(0);
  const generation = useRef(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [batch, setBatch] = useState<{ kind: BatchKind; target: BatchTarget } | null>(null);
  const batchModule = useLazyModule(() => import('./actions/batch-dialog'), batch !== null);
  const [rowAction, setRowAction] = useState<{ row: Row; kind: WorkflowActionKind | null } | null>(null);
  const dialogModule = useLazyModule(() => import('./actions/workflow-dialogs'), !!rowAction?.kind);
  const timelineModule = useLazyModule(() => import('../viz/multi-run-gantt'), listView.value === 'timeline');

  const fetchPage = useCallback(
    async (token: string | undefined): Promise<{ executions: Row[]; nextPageToken?: string; errors: NamespaceError[] }> => {
      if (cross) {
        // /api/x rejects ORDER BY (it always uses the visibility order); the cross view sorts locally instead.
        const res = await xapi.workflows(selection, { query: splitOrderBy(effectiveQuery()).where, pageSize, pageToken: token });
        return {
          executions: (res.executions ?? []).map((e) => ({ ...e.execution, tlNamespace: e.namespace })),
          nextPageToken: res.nextPageToken,
          errors: res.errors ?? [],
        };
      }
      const res = await api.get<{ executions?: Row[]; nextPageToken?: string }>(`/api/v1/namespaces/${seg(ns)}/workflows`, {
        query: effectiveQuery() || undefined,
        pageSize,
        nextPageToken: token,
      });
      return { executions: res.executions ?? [], nextPageToken: res.nextPageToken, errors: [] };
    },
    [cross, selectionKey, ns, effectiveQuery, pageSize],
  );

  const loadCounts = useCallback(async () => {
    const g = generation.current;
    setCounts((c) => ({ ...c, loading: true }));
    try {
      const where = splitOrderBy(effectiveQuery()).where;
      if (cross) {
        const res = await xapi.count(selection, where);
        if (g !== generation.current) return;
        setCounts({ total: res.total ?? 0, byStatus: res.byStatus ?? {}, loading: false });
        setCountErrors(res.errors ?? []);
        return;
      }
      const res = await api.get<CountResponse>(`/api/v1/namespaces/${seg(ns)}/workflow-count`, { query: `${where} GROUP BY ExecutionStatus`.trim() });
      if (g === generation.current) setCounts({ ...parseCounts(res), loading: false });
    } catch {
      if (g === generation.current) setCounts({ total: null, byStatus: {}, loading: false });
    }
  }, [cross, selectionKey, ns, effectiveQuery]);

  const loadFirst = useCallback(async () => {
    const g = ++generation.current;
    setData((d) => ({ ...d, loading: true, error: null }));
    void loadCounts();
    try {
      const res = await fetchPage(undefined);
      if (g !== generation.current) return;
      setData({ rows: res.executions, token: res.nextPageToken || undefined, loading: false, error: null, errors: res.errors });
      setPage(0);
      setSelected(new Set());
    } catch (err) {
      if (g !== generation.current) return;
      setData({ rows: [], token: undefined, loading: false, error: err instanceof Error ? err : new Error(String(err)), errors: [] });
    }
  }, [fetchPage, loadCounts]);

  const loadMore = useCallback(async (): Promise<boolean> => {
    if (!data.token || data.loading) return false;
    const g = generation.current;
    setData((d) => ({ ...d, loading: true }));
    try {
      const res = await fetchPage(data.token);
      if (g !== generation.current) return false;
      setData((d) => {
        // Defensive: never show a row twice, even if a page overlaps the previous one.
        const seen = new Set(d.rows.map(rowKeyOf));
        const fresh = res.executions.filter((r) => !seen.has(rowKeyOf(r)));
        return { rows: [...d.rows, ...fresh], token: res.nextPageToken || undefined, loading: false, error: null, errors: [...d.errors, ...res.errors] };
      });
      return true;
    } catch (err) {
      if (g === generation.current) setData((d) => ({ ...d, loading: false, error: err instanceof Error ? err : new Error(String(err)) }));
      return false;
    }
  }, [data.token, data.loading, fetchPage]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  const refresh = useCallback(() => {
    // Reloading the list resets the loaded window, so only do it on the first page.
    if (page === 0 && data.rows.length <= pageSize) void loadFirst();
    else void loadCounts();
  }, [page, data.rows.length, pageSize, loadFirst, loadCounts]);

  useEffect(() => {
    const period = autoRefresh.value;
    if (!period) return;
    const t = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, period * 1000);
    return () => window.clearInterval(t);
  }, [autoRefresh.value, refresh]);

  const sorted = useMemo(
    () => (clientSort && clientSort.col.sortType ? sortRows(data.rows, clientSort.col.get, clientSort.col.sortType, clientSort.dir) : data.rows),
    [data.rows, clientSort?.col, clientSort?.dir],
  );
  const pageCount = Math.max(1, Math.ceil(data.rows.length / pageSize));
  const shown = clientSort ? sorted : sorted.slice(page * pageSize, (page + 1) * pageSize);
  const hasNext = !clientSort && ((page + 1) * pageSize < data.rows.length || !!data.token);

  const next = async () => {
    if (clientSort || !hasNext) return;
    if ((page + 1) * pageSize < data.rows.length || (await loadMore())) setPage(page + 1);
  };
  const prev = () => !clientSort && page > 0 && setPage(page - 1);

  useShortcuts({ ArrowLeft: prev, ArrowRight: () => void next(), r: refresh });

  const filters = useMemo(() => parseQuery(state.query, sa.types), [state.query, sa.types]);
  const activeStatus = statusFilterValue(filters);
  const selectStatus = (value: string | null) => {
    if (filters) {
      const rest = filters.filter((f) => f.field !== 'ExecutionStatus');
      update({ query: buildQuery(value ? [...rest, { field: 'ExecutionStatus', op: '=', values: [value] }] : rest, sa.types, caps) });
    } else if (value) {
      update({ query: wrap(state.query, `ExecutionStatus = ${quoteString(value)}`) });
    }
  };

  const quick = quickFilters(new Date(), { reportedProblems: !cross && reportedProblems });
  const activeQuick = activeQuickFilter(quick, state.query, state.range);

  // A click on a column whose sort type is still pending is held until the
  // type is known, so a numeric memo column starts descending like any number.
  const [heldSort, setHeldSort] = useState<string | null>(null);
  const onSort = (column: string) => {
    const col = allColumns.find((c) => c.id === column);
    if (col?.sortPending) {
      setHeldSort(column);
      return;
    }
    setHeldSort(null);
    update({ sort: nextSort(state.sort, column, col?.sortType ?? 'keyword') });
  };
  useEffect(() => {
    if (heldSort === null) return;
    const col = allColumns.find((c) => c.id === heldSort);
    if (col?.sortPending) return;
    setHeldSort(null);
    if (col) update({ sort: nextSort(state.sort, heldSort, col.sortType ?? 'keyword') });
  }, [heldSort, allColumns]);

  const visibleColumns = visibleIds.map((id) => allColumns.find((c) => c.id === id)).filter((c): c is ColumnDef => !!c);
  const tableColumns: Column<Row>[] = visibleColumns.map((c) => ({
    id: c.id,
    label: c.label,
    width: c.width,
    sortable: !!c.sortType,
    movable: true,
    resizable: true,
    tag: c.tag,
    hint: c.hint,
    render: c.render ? (r) => c.render?.(r, rowNamespace(r, ns)) : (r) => display(c.get(r)),
    title: (r) => display(c.get(r)),
  }));

  // Batches are namespace-scoped, so bulk actions exist only in a single namespace.
  const canBatch = !cross && canAll(['batch']);
  const writer = canAll([]);
  const runIdOf = (r: Row) => r.execution.runId ?? '';
  const allShownSelected = shown.length > 0 && shown.every((r) => selected.has(runIdOf(r)));
  const toggleRow = (r: Row) => {
    const next = new Set(selected);
    if (next.has(runIdOf(r))) next.delete(runIdOf(r));
    else next.add(runIdOf(r));
    setSelected(next);
  };
  const toggleAll = () => setSelected(allShownSelected ? new Set() : new Set(shown.map(runIdOf)));
  if (canBatch) {
    tableColumns.unshift({
      id: 'select',
      label: 'Select',
      width: '36px',
      header: <input type="checkbox" aria-label="Select all rows on this page" checked={allShownSelected} onChange={toggleAll} />,
      render: (r) => <input type="checkbox" aria-label={`Select ${r.execution.workflowId}`} checked={selected.has(runIdOf(r))} onChange={() => toggleRow(r)} />,
    });
  }
  if (writer) {
    tableColumns.push({
      id: 'row-actions',
      label: 'Actions',
      width: '64px',
      resizable: true,
      render: (r) => (
        <button type="button" class="btn btn-ghost btn-sm" aria-label={`Actions for ${r.execution.workflowId}`} onClick={() => setRowAction({ row: r, kind: null })}>
          ⋯
        </button>
      ),
    });
  }
  const bulkItems = (['cancel', 'terminate', 'reset', 'delete'] as const).flatMap((kind) => {
    const verb = kind === 'cancel' ? 'Cancel' : kind === 'terminate' ? 'Terminate' : kind === 'reset' ? 'Reset' : 'Delete';
    return [
      { id: `${kind}-sel`, label: `${verb} ${selected.size} selected`, actions: ['batch', BATCH_ACTION[kind]] as const, hidden: selected.size === 0 || (kind === 'delete' && !canAll(['batchDelete'])), danger: kind !== 'cancel', onSelect: () => setBatch({ kind, target: { type: 'selection', runIds: [...selected] } }) },
      {
        id: `${kind}-all`,
        label: `${verb} all matching`,
        actions: ['batch', BATCH_ACTION[kind]] as const,
        hidden: kind === 'delete' && !canAll(['batchDelete']),
        danger: kind !== 'cancel',
        onSelect: () => setBatch({ kind, target: { type: 'query', query: effectiveQuery() } }),
      },
    ];
  });

  // Every change goes to the saved preference and the URL; reset clears both.
  const setColumns = (ids: string[] | null) => {
    saveColumns(prefsKey, ids);
    update({ cols: ids?.length ? ids : null });
  };
  // Widths are saved beside the order but kept out of the URL, so links stay short.
  // The state keeps them for the page when storage is unavailable.
  const storedWidths = useMemo(() => loadWidths(prefsKey), [prefsKey]);
  const [widthEdit, setWidthEdit] = useState<{ key: string; widths: ColumnWidths } | null>(null);
  const widths = widthEdit?.key === prefsKey ? widthEdit.widths : storedWidths;
  const setWidths = (next: ColumnWidths) => {
    saveWidths(prefsKey, next);
    setWidthEdit({ key: prefsKey, widths: next });
  };
  const resetColumns = () => {
    setColumns(null);
    setWidths({});
  };

  return (
    <section class="page page-fill" aria-busy={data.loading}>
      <header class="page-head">
        <h1>
          Workflows <span class="muted">{cross ? (state.ns ? state.ns.join(', ') : 'all namespaces') : ns}</span>
        </h1>
        {cross && <NamespacePicker selected={state.ns} onChange={(sel) => update({ ns: sel })} />}
        {!cross && canAll(['start']) && (
          <a class="btn btn-primary" href={href(P.startWorkflow, { ns })}>
            Start workflow
          </a>
        )}
        <StatusCounts total={counts.total} counts={counts.byStatus} active={activeStatus} onSelect={selectStatus} loading={counts.loading} />
      </header>

      <nav class="quick-filters" aria-label="Quick filters">
        {quick.map((f) => (
          <button key={f.id} type="button" class="pill" aria-pressed={activeQuick?.id === f.id} onClick={() => update({ query: f.query, range: f.range })}>
            {f.label}
          </button>
        ))}
        <a class="pill" href={searchHref({ ns: cross ? (state.ns ?? '*') : [ns], kind: 'activity', mode: 'pending', minAttempt: '3', query: state.query })}>
          Stuck activities…
        </a>
      </nav>

      <RawQuery query={state.query} onSubmit={(query) => update({ query })} />
      <FilterBuilder query={state.query} types={sa.types} custom={sa.custom} caps={caps} onChange={(query) => update({ query })} />
      {cross && Object.keys(missingAttrs).length > 0 && (
        <p class="muted filter-note">
          Not offered because some selected namespaces lack them:{' '}
          {Object.entries(missingAttrs)
            .map(([a, nss]) => `${a} (missing in ${nss.join(', ')})`)
            .join('; ')}
          .
        </p>
      )}
      <NamespaceErrorsBanner errors={dedupeErrors([...data.errors, ...countErrors])} />
      {cross && splitOrderBy(state.query).orderBy && (
        <p class="alert alert-warning" role="status">
          ORDER BY is not supported across namespaces, so <code>{splitOrderBy(state.query).orderBy}</code> was not sent; sort by a column header to sort the loaded rows locally instead.
        </p>
      )}
      {memoModule instanceof Error && <p class="alert alert-error">Could not load memo decoding: {memoModule.message}</p>}
      {memo?.memoCodecError.value && (
        <p class="alert alert-error" role="alert">
          Memo values could not be decoded by the codec server; they are shown undecoded. <span class="muted">({memo.memoCodecError.value})</span>
        </p>
      )}

      <div class="toolbar">
        <RangePicker value={state.range} onChange={(range) => update({ range })} />
        <div class="toolbar-spacer" />
        {canBatch && <ActionMenu label={selected.size ? `Bulk actions (${selected.size})` : 'Bulk actions'} items={bulkItems} />}
        <PresetMenu ns={prefsKey} state={state} onApply={(p) => update({ query: p.query, range: p.range })} />
        <ColumnPicker all={allColumns.map((c) => ({ id: c.id, label: c.label, tag: c.tag }))} visible={visibleIds} onChange={setColumns} onReset={resetColumns}>
          <MemoKeyForm onAdd={(key) => !visibleIds.includes(memoId(key)) && setColumns([...visibleIds, memoId(key)])} />
        </ColumnPicker>
        {!cross && (
          <select class="select" aria-label="Rows per page" value={String(state.perPage)} onChange={(e) => update({ perPage: Number((e.currentTarget as HTMLSelectElement).value) })}>
          {PER_PAGE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n} per page
            </option>
          ))}
        </select>
        )}
        <select
          class="select"
          aria-label="Auto-refresh"
          value={String(autoRefresh.value)}
          onChange={(e) => (autoRefresh.value = Number((e.currentTarget as HTMLSelectElement).value) as 0 | 15 | 60)}
        >
          <option value="0">Auto-refresh off</option>
          <option value="15">Refresh every 15 s</option>
          <option value="60">Refresh every 60 s</option>
        </select>
        <div class="segmented" role="group" aria-label="List view">
          <button type="button" class="btn" aria-pressed={listView.value === 'table'} onClick={() => (listView.value = 'table')}>
            Table
          </button>
          <button type="button" class="btn" aria-pressed={listView.value === 'timeline'} onClick={() => (listView.value = 'timeline')}>
            Timeline
          </button>
        </div>
        <button type="button" class="btn" onClick={refresh} title="Refresh (r)">
          Refresh
        </button>
      </div>

      {data.error && (
        <div class="alert alert-error" role="alert">
          {data.error.message}
        </div>
      )}
      {clientSort && <LocalSortNotice reason={localSortReason} loaded={data.rows.length} more={data.token ? pageSize : null} loading={data.loading} onMore={() => void loadMore()} />}

      {listView.value === 'timeline' ? (
        timelineModule instanceof Error ? (
          <p class="alert alert-error">Could not load the timeline: {timelineModule.message}</p>
        ) : timelineModule ? (
          <timelineModule.default rows={shown} namespace={ns} withNamespace={cross} />
        ) : (
          <p class="muted">Loading the timeline…</p>
        )
      ) : (
        <DataTable
          columns={tableColumns}
          rows={shown}
          rowKey={rowKeyOf}
          sort={state.sort}
          onSort={onSort}
          onMove={(id, target, after) => setColumns(dropColumn(visibleIds, id, target, after))}
          widths={widths}
          onResize={(id, width) => setWidths({ ...widths, [id]: width })}
          caption={cross ? 'Workflows in all selected namespaces' : `Workflows in ${ns}`}
          empty={data.loading ? 'Loading…' : 'No workflows match.'}
        />
      )}

      {batch && batchModule instanceof Error && <p class="field-error">Could not load the dialog: {batchModule.message}</p>}
      {batch && batchModule && !(batchModule instanceof Error) && (
        <batchModule.default ns={ns} kind={batch.kind} target={batch.target} onClose={() => setBatch(null)} onDone={() => void loadFirst()} />
      )}
      {rowAction && !rowAction.kind && (
        <RowActions row={rowAction.row} ns={rowNamespace(rowAction.row, ns)} onPick={(kind) => setRowAction({ row: rowAction.row, kind })} onClose={() => setRowAction(null)} />
      )}
      {rowAction?.kind && dialogModule && !(dialogModule instanceof Error) && (
        <dialogModule.WorkflowActionDialogForRun
          kind={rowAction.kind}
          ns={rowNamespace(rowAction.row, ns)}
          wf={rowAction.row.execution.workflowId}
          run={rowAction.row.execution.runId ?? ''}
          onClose={() => setRowAction(null)}
          onDone={refresh}
        />
      )}

      {!clientSort && (
        <footer class="pager">
          <button type="button" class="btn" disabled={page === 0} onClick={prev} title="Previous page (←)">
            ← Previous
          </button>
          <span class="muted">
            Page {page + 1} of {pageCount}
            {data.token ? '+' : ''} · {data.rows.length.toLocaleString('en-US')} loaded
          </span>
          <button type="button" class="btn" disabled={!hasNext || data.loading} onClick={() => void next()} title="Next page (→)">
            Next →
          </button>
          {data.loading && <span class="muted">Loading…</span>}
        </footer>
      )}
    </section>
  );
}
