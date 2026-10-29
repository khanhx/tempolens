import { useEffect, useMemo, useRef } from 'preact/hooks';
import { PayloadView } from '../../components/payload-view';
import { Duration, Timestamp } from '../../components/timestamp';
import { summarizeGroup } from '../../lib/history/group-summary';
import type { EventGroup } from '../../lib/history/groups';
import { CATEGORIES } from '../../lib/history/groups';
import type { Failure, PendingActivity } from '../../lib/temporal';
import { failureMessages, shortEventType } from '../../lib/temporal';
import { GroupStatusBadge } from './history';

/** Each level of the failure chain with its stack trace, outermost first. */
function FailureSummary({ failure }: { failure: Failure }) {
  const chain: Failure[] = [];
  for (let f: Failure | undefined = failure, i = 0; f && i < 20; f = f.cause, i++) chain.push(f);
  return (
    <details class="failure" open>
      <summary class="field-error">Failure: {failureMessages(failure).join(': ') || '(no message)'}</summary>
      {chain.map((f, i) =>
        f.stackTrace ? (
          <pre key={i} class="code-block">
            {f.stackTrace}
          </pre>
        ) : null,
      )}
    </details>
  );
}

export interface EventPanelProps {
  /** Requested event id (`?event=`). */
  eventId: string;
  /** The group holding `eventId`; undefined when that event is not loaded. */
  group: EventGroup | undefined;
  pending?: PendingActivity;
  ns: string;
  /** The dedicated event page. */
  fullHref: string;
  onClose: () => void;
}

/**
 * Side panel of the history tab: a compact summary of the selected event's
 * group, then every event of the group as JSON.
 */
export function EventPanel({ eventId, group, pending, ns, fullHref, onClose }: EventPanelProps) {
  const ref = useRef<HTMLElement>(null);
  const summary = useMemo(() => (group ? summarizeGroup(group, pending) : null), [group, pending]);
  // Opening moves focus here so the drawer is usable from the keyboard; the
  // list keeps its scroll position.
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const kind = group ? (CATEGORIES.find((c) => c.id === group.category)?.label ?? group.category) : '';

  return (
    <aside class="history-panel" ref={ref} tabIndex={-1} aria-label={`Event ${eventId} details`}>
      <div class="history-panel-head">
        <h2>
          #{group?.id ?? eventId} {kind} {group && group.name !== kind && <span>{group.name}</span>} {group && <GroupStatusBadge status={group.status} />}
        </h2>
        <a class="btn btn-sm" href={fullHref}>
          Open full page
        </a>
        <button type="button" class="btn btn-ghost btn-sm" aria-label="Close event details" title="Close (Esc)" onClick={onClose}>
          ×
        </button>
      </div>
      {!group || !summary ? (
        <p class="muted">Event {eventId} is not in the loaded events. Load more of the history, or open the full page.</p>
      ) : (
        <>
          <dl class="kv-grid">
            {summary.fields.map((f) => (
              <div key={f.label} class="kv-item">
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
            {summary.times.map((t) => (
              <div key={t.eventId} class="kv-item">
                <dt>
                  {t.label} <span class="muted">#{t.eventId}</span>
                </dt>
                <dd>
                  <Timestamp value={t.time} />
                </dd>
              </div>
            ))}
            {summary.durationMs !== null && (
              <div class="kv-item">
                <dt>Duration</dt>
                <dd>
                  <Duration ms={summary.durationMs} />
                </dd>
              </div>
            )}
          </dl>
          {summary.failure && <FailureSummary failure={summary.failure} />}
          {summary.payloads.map((p) => (
            <section key={p.label}>
              <h3>{p.label}</h3>
              <PayloadView value={p.value} ns={ns} />
            </section>
          ))}
          <h3>Events</h3>
          {group.events.map((e) => (
            <details key={e.eventId} class="history-panel-event" open={e.eventId === eventId || group.events.length <= 3}>
              <summary aria-current={e.eventId === eventId ? 'true' : undefined}>
                #{e.eventId} {shortEventType(e.eventType)} <span class="muted">·</span> <Timestamp value={e.eventTime} />
              </summary>
              <PayloadView value={e} ns={ns} openDepth={2} />
            </details>
          ))}
        </>
      )}
    </aside>
  );
}
