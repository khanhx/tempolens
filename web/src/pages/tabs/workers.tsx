import { Timestamp } from '../../components/timestamp';
import type { Poller } from '../../lib/temporal';
import type { RunContext } from '../workflow-layout';

export function PollerTable({ title, pollers }: { title: string; pollers: Poller[] }) {
  return (
    <section class="card card-pad">
      <h2>
        {title} <span class="muted">({pollers.length})</span>
      </h2>
      {pollers.length === 0 ? (
        <p class="muted">No pollers.</p>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Identity</th>
              <th scope="col">Last poll</th>
              <th scope="col">Rate/s</th>
              <th scope="col">Build ID</th>
            </tr>
          </thead>
          <tbody>
            {pollers.map((p, i) => (
              <tr key={`${p.identity ?? ''}-${i}`}>
                <td>{p.identity}</td>
                <td>
                  <Timestamp value={p.lastAccessTime} />
                </td>
                <td>{p.ratePerSecond ?? ''}</td>
                <td>
                  <code>{p.workerVersionCapabilities?.buildId ?? ''}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Pollers on the run's task queue, by task type. */
export function WorkersTab({ store }: RunContext) {
  const p = store.pollers.value;
  const tq = store.describe.value?.executionConfig?.taskQueue?.name;
  if (!p) return <p class="muted">Loading…</p>;
  return (
    <div class="stack">
      <p class="muted">
        Task queue <code>{tq}</code>
      </p>
      <PollerTable title="Workflow pollers" pollers={p.workflow} />
      <PollerTable title="Activity pollers" pollers={p.activity} />
      {p.nexus.length > 0 && <PollerTable title="Nexus pollers" pollers={p.nexus} />}
    </div>
  );
}
