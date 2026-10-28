import { useMemo } from 'preact/hooks';
import { JsonView } from '../../components/json-view';
import { Timestamp } from '../../components/timestamp';
import { buildGroups } from '../../lib/history/groups';
import type { HistoryEvent } from '../../lib/temporal';
import { eventAttributes, shortEventType } from '../../lib/temporal';
import { href, P } from '../../routes';
import type { RunContext } from '../workflow-layout';
import { Coverage, GroupStatusBadge } from './history';

interface WorkflowEventLink {
  workflowEvent?: { namespace?: string; workflowId?: string; runId?: string; eventRef?: { eventId?: string; eventType?: string } };
  batchJob?: { jobId?: string };
}

interface Callback {
  callback?: { nexus?: { url?: string } };
  state?: string;
  attempt?: number;
  registrationTime?: string;
  lastAttemptCompleteTime?: string;
  blockedReason?: string;
  [key: string]: unknown;
}

/** Nexus callbacks from describe, links on history events, and Nexus operations started by this run. */
export function NexusLinksTab({ store, ns }: RunContext) {
  const events = store.history.events.value;
  const links = useMemo(
    () => events.flatMap((e) => ((e.links as WorkflowEventLink[] | undefined) ?? []).map((link) => ({ event: e, link }))),
    [events],
  );
  const operations = useMemo(() => buildGroups(events).filter((g) => g.category === 'nexus'), [events]);
  const callbacks = (store.describe.value?.callbacks ?? []) as Callback[];

  const eventLink = (e: HistoryEvent) => href(P.eventDetail, { ns, wf: store.wf, run: store.run, eventId: e.eventId });

  return (
    <div class="stack">
      <Coverage store={store} />
      <section class="card card-pad">
        <h2>Callbacks</h2>
        {callbacks.length === 0 ? (
          <p class="muted">No completion callbacks are attached to this run.</p>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th scope="col">URL</th>
                <th scope="col">State</th>
                <th scope="col">Attempt</th>
                <th scope="col">Registered</th>
                <th scope="col">Last attempt</th>
              </tr>
            </thead>
            <tbody>
              {callbacks.map((c, i) => (
                <tr key={i}>
                  <td>
                    <code>{c.callback?.nexus?.url ?? ''}</code>
                    {c.blockedReason && <div class="field-error">{c.blockedReason}</div>}
                  </td>
                  <td>{(c.state ?? '').replace('CALLBACK_STATE_', '').toLowerCase()}</td>
                  <td>{c.attempt ?? ''}</td>
                  <td>
                    <Timestamp value={c.registrationTime} />
                  </td>
                  <td>
                    <Timestamp value={c.lastAttemptCompleteTime} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section class="card card-pad">
        <h2>Nexus operations</h2>
        {operations.length === 0 ? (
          <p class="muted">This run started no Nexus operations.</p>
        ) : (
          <ul class="list-plain stack">
            {operations.map((g) => {
              const a = eventAttributes(g.events[0] ?? { eventId: '', eventType: '' });
              return (
                <li key={g.id}>
                  <a href={g.events[0] ? eventLink(g.events[0]) : '#'}>#{g.id}</a> {String(a.endpoint ?? '')} / {String(a.service ?? '')} / {String(a.operation ?? '')}{' '}
                  <GroupStatusBadge status={g.status} />
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section class="card card-pad">
        <h2>Event links</h2>
        {links.length === 0 ? (
          <p class="muted">No history event carries a link.</p>
        ) : (
          <ul class="list-plain stack">
            {links.map(({ event, link }, i) => {
              const w = link.workflowEvent;
              return (
                <li key={i}>
                  <a href={eventLink(event)}>
                    #{event.eventId} {shortEventType(event.eventType)}
                  </a>{' '}
                  →{' '}
                  {w?.workflowId && w.namespace ? (
                    <a href={w.runId ? href(P.run, { ns: w.namespace, wf: w.workflowId, run: w.runId }) : href(P.workflowLatest, { ns: w.namespace, wf: w.workflowId })}>
                      {w.namespace}/{w.workflowId}
                      {w.eventRef?.eventId ? ` event ${w.eventRef.eventId}` : ''}
                    </a>
                  ) : link.batchJob?.jobId ? (
                    <a href={href(P.batchOperation, { ns, jobId: link.batchJob.jobId })}>batch {link.batchJob.jobId}</a>
                  ) : (
                    <JsonView value={link} openDepth={1} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
