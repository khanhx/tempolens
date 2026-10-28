// In-history filters, kept in the URL next to upstream's own parameters
// (`category`, `status=pending`, `sort`):
//   types=ActivityTaskFailed,TimerFired   event types (short names)
//   activity=charge                       activity type, case-insensitive substring
//   estatus=failed,timed-out              group status
//   from=…&to=…                           event time window (RFC 3339)
//   q=timeout                             failure-text substring (message, cause chain, reason)
import type { Failure, HistoryEvent } from '../temporal';
import { eventAttributes, failureMessages, shortEventType } from '../temporal';
import type { Category, EventGroup, GroupStatus } from './groups';
import { CATEGORIES, GROUP_STATUSES } from './groups';
import { parseTimestamp } from '../time';

export interface HistoryFilter {
  types: string[];
  categories: Category[];
  activity: string;
  statuses: GroupStatus[];
  from: string;
  to: string;
  q: string;
  pendingOnly: boolean;
}

export const EMPTY_FILTER: HistoryFilter = {
  types: [],
  categories: [],
  activity: '',
  statuses: [],
  from: '',
  to: '',
  q: '',
  pendingOnly: false,
};

const list = (v: string | null) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const CATEGORY_IDS = new Set<string>(CATEGORIES.map((c) => c.id));

export function parseHistoryFilter(p: URLSearchParams): HistoryFilter {
  return {
    types: list(p.get('types')),
    categories: list(p.get('category')).filter((c): c is Category => CATEGORY_IDS.has(c)),
    activity: p.get('activity') ?? '',
    statuses: list(p.get('estatus')).filter((s): s is GroupStatus => (GROUP_STATUSES as readonly string[]).includes(s)),
    from: parseTimestamp(p.get('from')) ? (p.get('from') ?? '') : '',
    to: parseTimestamp(p.get('to')) ? (p.get('to') ?? '') : '',
    q: p.get('q') ?? '',
    pendingOnly: p.get('status') === 'pending',
  };
}

/** Writes the filter into `p` (other parameters are kept). */
export function writeHistoryFilter(f: HistoryFilter, p: URLSearchParams): URLSearchParams {
  const set = (k: string, v: string) => (v ? p.set(k, v) : p.delete(k));
  set('types', f.types.join(','));
  set('category', f.categories.join(','));
  set('activity', f.activity);
  set('estatus', f.statuses.join(','));
  set('from', f.from);
  set('to', f.to);
  set('q', f.q);
  set('status', f.pendingOnly ? 'pending' : '');
  return p;
}

export const isFilterActive = (f: HistoryFilter) =>
  f.types.length > 0 ||
  f.categories.length > 0 ||
  !!f.activity ||
  f.statuses.length > 0 ||
  !!f.from ||
  !!f.to ||
  !!f.q ||
  f.pendingOnly;

/** Lower-cased failure text of an event: failure message chain plus any reason. */
export function failureText(event: HistoryEvent): string {
  const attrs = eventAttributes(event);
  const parts = failureMessages(attrs.failure as Failure | undefined);
  if (typeof attrs.reason === 'string') parts.push(attrs.reason);
  return parts.join('\n').toLowerCase();
}

function groupMatches(g: EventGroup | undefined, f: HistoryFilter): boolean {
  if (!g) return f.categories.length === 0 && !f.activity && f.statuses.length === 0 && !f.pendingOnly;
  if (f.categories.length && !f.categories.includes(g.category)) return false;
  if (f.activity && !(g.category === 'activity' && g.name.toLowerCase().includes(f.activity.toLowerCase()))) return false;
  if (f.statuses.length && !f.statuses.includes(g.status)) return false;
  if (f.pendingOnly && g.status !== 'pending') return false;
  return true;
}

function eventMatches(e: HistoryEvent, f: HistoryFilter, fromMs: number, toMs: number): boolean {
  if (f.types.length && !f.types.includes(shortEventType(e.eventType))) return false;
  if (fromMs > -Infinity || toMs < Infinity) {
    const t = parseTimestamp(e.eventTime)?.getTime();
    if (t === undefined || t < fromMs || t > toMs) return false;
  }
  if (f.q && !failureText(e).includes(f.q.toLowerCase())) return false;
  return true;
}

function bounds(f: HistoryFilter): [number, number] {
  return [parseTimestamp(f.from)?.getTime() ?? -Infinity, parseTimestamp(f.to)?.getTime() ?? Infinity];
}

/** Events that pass every filter (group-level filters apply through the event's group). */
export function filterEvents(events: readonly HistoryEvent[], index: Map<string, EventGroup>, f: HistoryFilter): HistoryEvent[] {
  if (!isFilterActive(f)) return [...events];
  const [fromMs, toMs] = bounds(f);
  return events.filter((e) => groupMatches(index.get(e.eventId), f) && eventMatches(e, f, fromMs, toMs));
}

/** Groups that pass the group-level filters and contain at least one matching event. */
export function filterGroups(groups: readonly EventGroup[], f: HistoryFilter): EventGroup[] {
  if (!isFilterActive(f)) return [...groups];
  const [fromMs, toMs] = bounds(f);
  return groups.filter((g) => groupMatches(g, f) && g.events.some((e) => eventMatches(e, f, fromMs, toMs)));
}
