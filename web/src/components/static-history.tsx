import { useMemo, useState } from 'preact/hooks';
import type { HistoryFilter } from '../lib/history/filters';
import { EMPTY_FILTER, filterEvents, filterGroups } from '../lib/history/filters';
import type { EventGroup } from '../lib/history/groups';
import { buildGroups, CATEGORIES, groupIndex } from '../lib/history/groups';
import type { HistoryEvent } from '../lib/temporal';
import { failureMessages, shortEventType } from '../lib/temporal';
import { eventSummary, FilterPanel, GroupStatusBadge } from '../pages/tabs/history';
import type { Column } from './data-table';
import { DataTable } from './data-table';
import { JsonText } from './json-view';
import { PayloadView } from './payload-view';
import { Timestamp } from './timestamp';

/**
 * History views over a fixed list of events (an imported file or an
 * archived run): compact, all events and JSON, with the in-history filters
 * kept in local state. Selecting an event shows it decoded below.
 */
export function StaticHistory({ events, ns }: { events: HistoryEvent[]; ns: string }) {
  const [mode, setMode] = useState<'compact' | 'full' | 'json'>('compact');
  const [filter, setFilter] = useState<HistoryFilter>(EMPTY_FILTER);
  const [selected, setSelected] = useState<HistoryEvent | null>(null);
  const groups = useMemo(() => buildGroups(events), [events]);
  const index = useMemo(() => groupIndex(groups), [groups]);
  const shownEvents = useMemo(() => filterEvents(events, index, filter), [events, index, filter]);
  const shownGroups = useMemo(() => filterGroups(groups, filter), [groups, filter]);

  const pick = (e: HistoryEvent | undefined) => (
    <button type="button" class="link-button" onClick={() => e && setSelected(e)}>
      {e?.eventId}
    </button>
  );
  const eventColumns: Column<HistoryEvent>[] = [
    { id: 'id', label: 'ID', width: '70px', render: (e) => pick(e) },
    { id: 'time', label: 'Time', width: '170px', render: (e) => <Timestamp value={e.eventTime} /> },
    { id: 'type', label: 'Type', width: '30%', render: (e) => shortEventType(e.eventType) },
    { id: 'detail', label: 'Details', render: (e) => eventSummary(e), title: (e) => eventSummary(e) },
  ];
  const groupColumns: Column<EventGroup>[] = [
    { id: 'id', label: 'ID', width: '70px', render: (g) => pick(g.events[g.events.length - 1]) },
    { id: 'category', label: 'Kind', width: '130px', render: (g) => CATEGORIES.find((c) => c.id === g.category)?.label ?? g.category },
    { id: 'name', label: 'Name', width: '25%', render: (g) => g.name },
    { id: 'status', label: 'Status', width: '110px', render: (g) => <GroupStatusBadge status={g.status} /> },
    { id: 'start', label: 'Started', width: '160px', render: (g) => <Timestamp value={g.events[0]?.eventTime} /> },
    { id: 'detail', label: 'Details', render: (g) => failureMessages(g.failure).join(': ') },
  ];

  return (
    <div class="history">
      <div class="toolbar">
        <div class="segmented" role="group" aria-label="History view">
          {(['compact', 'full', 'json'] as const).map((m) => (
            <button key={m} type="button" class="btn" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === 'compact' ? 'Compact' : m === 'full' ? 'All events' : 'JSON'}
            </button>
          ))}
        </div>
        <span class="muted">{mode === 'compact' ? `${shownGroups.length} of ${groups.length} groups` : `${shownEvents.length} of ${events.length} events`}</span>
      </div>
      <FilterPanel filter={filter} events={events} groups={groups} onApply={setFilter} />
      {mode === 'json' ? (
        <JsonText value={shownEvents} />
      ) : mode === 'full' ? (
        <DataTable columns={eventColumns} rows={shownEvents} rowKey={(e) => e.eventId} caption="History events" empty="No events match." />
      ) : (
        <DataTable columns={groupColumns} rows={shownGroups} rowKey={(g) => g.id} caption="Grouped history" empty="No events match." />
      )}
      {selected && (
        <section class="card card-pad">
          <h2>
            #{selected.eventId} {shortEventType(selected.eventType)}{' '}
            <button type="button" class="btn btn-sm" onClick={() => setSelected(null)}>
              Close
            </button>
          </h2>
          <PayloadView value={selected} ns={ns} openDepth={4} />
        </section>
      )}
    </div>
  );
}
