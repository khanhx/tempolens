import { useEffect, useMemo, useRef } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { PayloadView } from '../../components/payload-view';
import { Timestamp } from '../../components/timestamp';
import { buildGroups, groupIndex } from '../../lib/history/groups';
import { eventAttributes, shortEventType } from '../../lib/temporal';
import { href, P } from '../../routes';
import type { RunContext } from '../workflow-layout';
import { GroupStatusBadge } from './history';

/** One event, fully decoded. `eventId` may also be a requestId, as upstream allows. */
export function EventDetailTab({ store, ns, wf, run, eventId }: RunContext & { eventId: string }) {
  const { url } = useLocation();
  const search = url.includes('?') ? url.slice(url.indexOf('?')) : '';
  const events = store.history.events.value;
  const complete = store.history.complete.value;
  const event = events.find((e) => e.eventId === eventId) ?? events.find((e) => eventAttributes(e).requestId === eventId);
  const groups = useMemo(() => groupIndex(buildGroups(events)), [events]);
  const requested = useRef(false);

  // An event in the unloaded middle of the history needs the full history.
  useEffect(() => {
    if (!event && !complete && !requested.current && events.length > 0) {
      requested.current = true;
      void store.history.loadAll();
    }
  }, [event, complete, events.length, store]);

  const link = (id: string) => href(P.eventDetail, { ns, wf, run, eventId: id }) + search;
  if (!event) {
    return <p class="muted">{complete ? `Event ${eventId} is not in this history.` : 'Loading the history to find this event…'}</p>;
  }
  const pos = events.indexOf(event);
  const prev = events[pos - 1];
  const next = events[pos + 1];
  const group = groups.get(event.eventId);

  return (
    <div class="event-detail">
      <nav class="toolbar">
        <a class="btn" href={href(P.history, { ns, wf, run }) + search}>
          ← History
        </a>
        {prev && (
          <a class="btn" href={link(prev.eventId)}>
            Previous ({prev.eventId})
          </a>
        )}
        {next && (
          <a class="btn" href={link(next.eventId)}>
            Next ({next.eventId})
          </a>
        )}
      </nav>
      <h2>
        #{event.eventId} {shortEventType(event.eventType)} <span class="muted">·</span> <Timestamp value={event.eventTime} />
      </h2>
      {group && group.events.length > 1 && (
        <p>
          {group.name} <GroupStatusBadge status={group.status} />{' '}
          {group.events.map((e) => (
            <a key={e.eventId} class={e === event ? 'pill pill-active' : 'pill'} href={link(e.eventId)}>
              {e.eventId} {shortEventType(e.eventType)}
            </a>
          ))}
        </p>
      )}
      <PayloadView value={event} ns={ns} openDepth={4} />
    </div>
  );
}
