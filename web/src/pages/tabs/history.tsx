import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import type { Column } from '../../components/data-table';
import { DataTable } from '../../components/data-table';
import { JsonText } from '../../components/json-view';
import { Duration, Timestamp } from '../../components/timestamp';
import { LOAD_ALL_WARN_EVENTS } from '../../lib/history/fetch';
import type { HistoryFilter } from '../../lib/history/filters';
import { EMPTY_FILTER, filterEvents, filterGroups, isFilterActive, parseHistoryFilter, writeHistoryFilter } from '../../lib/history/filters';
import type { EventGroup, GroupStatus } from '../../lib/history/groups';
import { buildGroups, CATEGORIES, GROUP_STATUSES, groupIndex } from '../../lib/history/groups';
import { eventView } from '../../lib/prefs';
import type { RunStore } from '../../lib/run-store';
import type { Failure, HistoryEvent, PendingActivity } from '../../lib/temporal';
import { eventAttributes, failureMessages, shortEventType } from '../../lib/temporal';
import { durationBetween } from '../../lib/time';
import { href, P } from '../../routes';
import type { RunContext } from '../workflow-layout';

const nameOf = (v: unknown) => (v && typeof v === 'object' ? String((v as { name?: unknown }).name ?? '') : '');

/** One-line description of an event for the full table. */
export function eventSummary(e: HistoryEvent): string {
  const a = eventAttributes(e);
  const failure = failureMessages(a.failure as Failure | undefined)[0];
  const parts = [
    nameOf(a.activityType),
    nameOf(a.workflowType),
    typeof a.timerId === 'string' ? `timer ${a.timerId}` : '',
    typeof a.signalName === 'string' ? `signal ${a.signalName}` : '',
    typeof a.markerName === 'string' ? `marker ${a.markerName}` : '',
    typeof a.attempt === 'number' && a.attempt > 1 ? `attempt ${a.attempt}` : '',
    typeof a.identity === 'string' ? a.identity : '',
    failure ?? '',
    typeof a.reason === 'string' ? a.reason : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

const STATUS_LABEL: Record<GroupStatus, string> = {
  completed: 'Completed',
  failed: 'Failed',
  'timed-out': 'Timed out',
  canceled: 'Canceled',
  terminated: 'Terminated',
  pending: 'Pending',
};

export function GroupStatusBadge({ status }: { status: GroupStatus }) {
  return <span class={`gstatus gstatus-${status}`}>{STATUS_LABEL[status]}</span>;
}

/** Loaded-range notice with "load more / load all"; filters apply to loaded events only. */
export function Coverage({ store }: { store: RunStore }) {
  const [progress, setProgress] = useState<number | null>(null);
  const h = store.history;
  const total = Number(store.describe.value?.workflowExecutionInfo?.historyLength ?? 0);
  if (h.complete.value) return null;
  const loaded = h.events.value.length;
  const loadAll = () => {
    if (total > LOAD_ALL_WARN_EVENTS && !window.confirm(`This history has ${total.toLocaleString('en-US')} events. Loading all of them can take a while and use a lot of memory. Continue?`)) return;
    setProgress(loaded);
    void h.loadAll(undefined, setProgress).then(() => setProgress(null));
  };
  return (
    <div class="alert" role="status">
      Showing {loaded.toLocaleString('en-US')}
      {total ? ` of ${total.toLocaleString('en-US')}` : ''} events: the beginning and the end of the history. Filters and views use the loaded events only.{' '}
      <button type="button" class="btn btn-sm" disabled={h.loading.value} onClick={() => void h.loadNext()}>
        Load next page
      </button>{' '}
      <button type="button" class="btn btn-sm" disabled={h.loading.value} onClick={loadAll}>
        Load all
      </button>
      {progress !== null && <span class="muted"> Loaded {progress.toLocaleString('en-US')}…</span>}
    </div>
  );
}

export function FilterPanel({ filter, events, groups, onApply }: { filter: HistoryFilter; events: HistoryEvent[]; groups: EventGroup[]; onApply: (f: HistoryFilter) => void }) {
  const [draft, setDraft] = useState(filter);
  useEffect(() => setDraft(filter), [filter]);
  const types = useMemo(() => [...new Set(events.map((e) => shortEventType(e.eventType)))].sort(), [events]);
  const activities = useMemo(() => [...new Set(groups.filter((g) => g.category === 'activity').map((g) => g.name))].sort(), [groups]);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const localValue = (iso: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  };
  const fromLocal = (v: string) => (v ? new Date(v).toISOString() : '');

  return (
    <details class="card card-pad filter-panel" open={isFilterActive(filter)}>
      <summary>Filters{isFilterActive(filter) ? ' (active)' : ''}</summary>
      <form
        class="filter-grid"
        onSubmit={(e) => {
          e.preventDefault();
          onApply(draft);
        }}
      >
        <label>
          Event types <span class="muted">(comma separated)</span>
          <input class="input" list="history-event-types" value={draft.types.join(', ')} onInput={(e) => setDraft({ ...draft, types: (e.currentTarget as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean) })} />
          <datalist id="history-event-types">
            {types.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label>
          Activity type
          <input class="input" list="history-activity-types" value={draft.activity} onInput={(e) => setDraft({ ...draft, activity: (e.currentTarget as HTMLInputElement).value })} />
          <datalist id="history-activity-types">
            {activities.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label>
          Failure text
          <input class="input" value={draft.q} placeholder="message, cause or reason" onInput={(e) => setDraft({ ...draft, q: (e.currentTarget as HTMLInputElement).value })} />
        </label>
        <label>
          From
          <input class="input" type="datetime-local" step="1" value={localValue(draft.from)} onInput={(e) => setDraft({ ...draft, from: fromLocal((e.currentTarget as HTMLInputElement).value) })} />
        </label>
        <label>
          To
          <input class="input" type="datetime-local" step="1" value={localValue(draft.to)} onInput={(e) => setDraft({ ...draft, to: fromLocal((e.currentTarget as HTMLInputElement).value) })} />
        </label>
        <fieldset>
          <legend>Category</legend>
          {CATEGORIES.map((c) => (
            <label key={c.id} class="check">
              <input type="checkbox" checked={draft.categories.includes(c.id)} onChange={() => setDraft({ ...draft, categories: toggle(draft.categories, c.id) })} /> {c.label}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Status</legend>
          {GROUP_STATUSES.map((s) => (
            <label key={s} class="check">
              <input type="checkbox" checked={draft.statuses.includes(s)} onChange={() => setDraft({ ...draft, statuses: toggle(draft.statuses, s) })} /> {STATUS_LABEL[s]}
            </label>
          ))}
          <label class="check">
            <input type="checkbox" checked={draft.pendingOnly} onChange={() => setDraft({ ...draft, pendingOnly: !draft.pendingOnly })} /> Pending only
          </label>
        </fieldset>
        <div class="toolbar-group">
          <button type="submit" class="btn btn-primary">
            Apply filters
          </button>
          <button type="button" class="btn btn-ghost" onClick={() => onApply(EMPTY_FILTER)}>
            Clear
          </button>
        </div>
      </form>
    </details>
  );
}

export function HistoryTab({ store, ns, wf, run }: RunContext) {
  const { url, path, route } = useLocation();
  const params = useMemo(() => new URLSearchParams(url.split('?')[1] ?? ''), [url]);
  const filter = useMemo(() => parseHistoryFilter(params), [params]);
  const ascending = params.get('sort') === 'ascending';
  const refreshOff = params.get('refresh_off') === 'true';
  useEffect(() => store.setLiveWanted(!refreshOff), [store, refreshOff]);

  const setParams = (fn: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(params);
    fn(next);
    const s = next.toString();
    route(path + (s ? `?${s}` : ''));
  };

  const events = store.history.events.value;
  const groups = useMemo(() => buildGroups(events), [events]);
  const index = useMemo(() => groupIndex(groups), [groups]);
  const pending = useMemo(() => {
    const m = new Map<string, PendingActivity>();
    for (const p of store.describe.value?.pendingActivities ?? []) if (p.activityId) m.set(p.activityId, p);
    return m;
  }, [store.describe.value]);

  const order = <T,>(rows: T[]) => (ascending ? rows : [...rows].reverse());
  const shownEvents = useMemo(() => order(filterEvents(events, index, filter)), [events, index, filter, ascending]);
  const shownGroups = useMemo(() => order(filterGroups(groups, filter)), [groups, filter, ascending]);
  const search = params.toString() ? `?${params.toString()}` : '';
  const eventHref = (id: string) => href(P.eventDetail, { ns, wf, run, eventId: id }) + search;

  const eventColumns: Column<HistoryEvent>[] = [
    { id: 'id', label: 'ID', width: '70px', render: (e) => <a href={eventHref(e.eventId)}>{e.eventId}</a> },
    { id: 'time', label: 'Time', width: '170px', render: (e) => <Timestamp value={e.eventTime} /> },
    { id: 'type', label: 'Type', width: '30%', render: (e) => shortEventType(e.eventType), title: (e) => e.eventType },
    { id: 'group', label: 'Status', width: '110px', render: (e) => { const g = index.get(e.eventId); return g ? <GroupStatusBadge status={g.status} /> : null; } },
    { id: 'detail', label: 'Details', render: (e) => eventSummary(e), title: (e) => eventSummary(e) },
  ];

  const groupColumns: Column<EventGroup>[] = [
    { id: 'id', label: 'ID', width: '70px', render: (g) => <a href={eventHref(g.events[g.events.length - 1]?.eventId ?? g.id)}>{g.id}</a> },
    { id: 'category', label: 'Kind', width: '120px', render: (g) => CATEGORIES.find((c) => c.id === g.category)?.label ?? g.category },
    { id: 'name', label: 'Name', width: '22%', render: (g) => g.name, title: (g) => g.name },
    { id: 'status', label: 'Status', width: '110px', render: (g) => <GroupStatusBadge status={g.status} /> },
    {
      id: 'attempt',
      label: 'Attempt',
      width: '80px',
      render: (g) => {
        const activityId = eventAttributes(g.events[0] ?? { eventId: '', eventType: '' }).activityId;
        const p = typeof activityId === 'string' ? pending.get(activityId) : undefined;
        return p?.attempt ?? g.attempt ?? '';
      },
    },
    { id: 'start', label: 'Started', width: '160px', render: (g) => <Timestamp value={g.events[0]?.eventTime} /> },
    { id: 'duration', label: 'Duration', width: '100px', render: (g) => <Duration ms={g.events.length > 1 ? durationBetween(g.events[0]?.eventTime, g.events[g.events.length - 1]?.eventTime) : null} /> },
    { id: 'detail', label: 'Details', render: (g) => failureMessages(g.failure).join(': '), title: (g) => failureMessages(g.failure).join('\n') },
  ];

  const mode = eventView.value;
  return (
    <div class="history">
      <div class="toolbar">
        <div class="segmented" role="group" aria-label="History view">
          {(['compact', 'full', 'json'] as const).map((m) => (
            <button key={m} type="button" class="btn" aria-pressed={mode === m} onClick={() => (eventView.value = m)}>
              {m === 'compact' ? 'Compact' : m === 'full' ? 'All events' : 'JSON'}
            </button>
          ))}
        </div>
        <button type="button" class="btn" onClick={() => setParams((p) => (ascending ? p.delete('sort') : p.set('sort', 'ascending')))}>
          {ascending ? 'Oldest first' : 'Newest first'}
        </button>
        {store.running && (
          <button type="button" class="btn" aria-pressed={!refreshOff} onClick={() => setParams((p) => (refreshOff ? p.delete('refresh_off') : p.set('refresh_off', 'true')))}>
            {refreshOff ? 'Live updates off' : 'Live updates on'}
          </button>
        )}
        <span class="muted">
          {mode === 'compact' ? `${shownGroups.length} of ${groups.length} groups` : `${shownEvents.length} of ${events.length} events`}
        </span>
      </div>
      <Coverage store={store} />
      {store.history.error.value && (
        <div class="alert alert-error" role="alert">
          History could not be loaded: {store.history.error.value.message}
        </div>
      )}
      <FilterPanel filter={filter} events={events} groups={groups} onApply={(f) => setParams((p) => void writeHistoryFilter(f, p))} />
      {mode === 'json' ? (
        <JsonText value={shownEvents} />
      ) : mode === 'full' ? (
        <DataTable columns={eventColumns} rows={shownEvents} rowKey={(e) => e.eventId} caption="History events" empty={store.history.loading.value ? 'Loading…' : 'No events match.'} />
      ) : (
        <DataTable columns={groupColumns} rows={shownGroups} rowKey={(g) => g.id} caption="Grouped history" empty={store.history.loading.value ? 'Loading…' : 'No events match.'} />
      )}
    </div>
  );
}
