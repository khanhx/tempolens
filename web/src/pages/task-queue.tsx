import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { CopyButton } from '../components/copy-button';
import { cliCommand } from '../lib/actions/cli-command';
import { api, seg } from '../lib/api';
import { quoteString } from '../lib/query/build';
import type { Poller } from '../lib/temporal';
import { href, P } from '../routes';
import { PollerTable } from './tabs/workers';

const TYPES = [
  { type: 1, label: 'Workflow pollers' },
  { type: 2, label: 'Activity pollers' },
  { type: 3, label: 'Nexus pollers' },
] as const;

interface Partition {
  key?: string;
  ownerHostName?: string;
}

interface PartitionsResponse {
  workflowTaskQueuePartitions?: Partition[];
  activityTaskQueuePartitions?: Partition[];
}

interface BuildIdCompatibility {
  majorVersionSets?: { buildIds?: string[] }[];
}

interface VersioningRules {
  assignmentRules?: { rule?: { targetBuildId?: string; percentageRamp?: { rampPercentage?: number } } }[];
  compatibleRedirectRules?: { rule?: { sourceBuildId?: string; targetBuildId?: string } }[];
}

type Loaded<T> = T | Error | null;

const settle = <T,>(p: Promise<T>): Promise<T | Error> => p.catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));

function Section({ title, cli, children }: { title: string; cli: string; children: ComponentChildren }) {
  return (
    <section class="card card-pad stack">
      <div class="page-head">
        <h2>{title}</h2>
        <CopyButton text={cli} label="Copy as temporal CLI" />
      </div>
      {children}
    </section>
  );
}

function PartitionTable({ title, list }: { title: string; list: Partition[] }) {
  return (
    <table class="table">
      <caption>
        {title} ({list.length})
      </caption>
      <thead>
        <tr>
          <th scope="col">Partition</th>
          <th scope="col">Owner host</th>
        </tr>
      </thead>
      <tbody>
        {list.map((p) => (
          <tr key={p.key}>
            <td>
              <code>{p.key}</code>
            </td>
            <td>{p.ownerHostName || '–'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Versioning reads fail when the feature is off on the server (as on a default 1.24); say so instead of erroring. */
const unavailable = (e: Error) => <p class="muted">Not available on this server: {e.message}</p>;

/** Pollers on one task queue by task type, its partitions, and (when enabled) worker versioning. */
export default function TaskQueue() {
  const { params } = useRoute();
  const ns = params.ns ?? '';
  const queue = params.queue ?? '';
  const [pollers, setPollers] = useState<Record<number, Poller[] | Error> | null>(null);
  const [partitions, setPartitions] = useState<Loaded<PartitionsResponse>>(null);
  const [buildIds, setBuildIds] = useState<Loaded<BuildIdCompatibility>>(null);
  const [rules, setRules] = useState<Loaded<VersioningRules>>(null);

  const load = useCallback(async () => {
    const results = await Promise.all(
      TYPES.map((t) =>
        api.get<{ pollers?: Poller[] }>(`/api/v1/namespaces/${seg(ns)}/task-queues/${seg(queue)}`, { taskQueueType: t.type }).then(
          (r) => r.pollers ?? [],
          (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
        ),
      ),
    );
    setPollers(Object.fromEntries(TYPES.map((t, i) => [t.type, results[i] ?? []])));
    const tq = `/api/v1/namespaces/${seg(ns)}/task-queues/${seg(queue)}`;
    const [p, b, r] = await Promise.all([
      settle(api.get<PartitionsResponse>('/api/x/task-queue-partitions', { namespace: ns, taskQueue: queue })),
      settle(api.get<BuildIdCompatibility>(`${tq}/worker-build-id-compatibility`)),
      settle(api.get<VersioningRules>(`${tq}/worker-versioning-rules`)),
    ]);
    setPartitions(p);
    setBuildIds(b);
    setRules(r);
  }, [ns, queue]);

  const flags = [
    ['namespace', ns],
    ['task-queue', queue],
  ] as const;

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section class="page">
      <p class="muted crumbs">
        <a href={href(P.taskQueues, { ns })}>{ns} task queues</a>
      </p>
      <header class="page-head">
        <h1>{queue}</h1>
        <div class="toolbar-group">
          <a class="btn" href={href(P.workflows, { ns }, { query: `TaskQueue = ${quoteString(queue)}` })}>
            Workflows on this queue
          </a>
          <button type="button" class="btn" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </header>
      {!pollers && <p class="muted">Loading…</p>}
      {pollers && (
        <div class="stack">
          {TYPES.map((t) => {
            const v = pollers[t.type];
            if (v instanceof Error) {
              // Nexus task queues do not exist before Temporal 1.25; hide that error.
              return t.type === 3 ? null : (
                <p key={t.type} class="alert alert-error">
                  {t.label}: {v.message}
                </p>
              );
            }
            return <PollerTable key={t.type} title={t.label} pollers={v ?? []} />;
          })}
        </div>
      )}
      <div class="stack">
        <Section title="Partitions" cli={cliCommand(['task-queue', 'list-partition'], flags)}>
          {partitions === null ? (
            <p class="muted">Loading…</p>
          ) : partitions instanceof Error ? (
            <p class="alert alert-error">{partitions.message}</p>
          ) : (
            <>
              <PartitionTable title="Workflow task partitions" list={partitions.workflowTaskQueuePartitions ?? []} />
              <PartitionTable title="Activity task partitions" list={partitions.activityTaskQueuePartitions ?? []} />
            </>
          )}
        </Section>
        <Section title="Build ID compatibility" cli={cliCommand(['task-queue', 'get-build-ids'], flags)}>
          {buildIds === null ? (
            <p class="muted">Loading…</p>
          ) : buildIds instanceof Error ? (
            unavailable(buildIds)
          ) : !buildIds.majorVersionSets?.length ? (
            <p class="muted">No build IDs are registered on this queue.</p>
          ) : (
            <ol class="stack">
              {/* The server lists sets oldest first; the last set is the default. */}
              {buildIds.majorVersionSets.map((set, i, all) => (
                <li key={i}>
                  {(set.buildIds ?? []).map((id) => (
                    <code key={id}>{id} </code>
                  ))}
                  {i === all.length - 1 && <span class="muted">(default set)</span>}
                </li>
              ))}
            </ol>
          )}
        </Section>
        <Section title="Versioning rules" cli={cliCommand(['task-queue', 'versioning', 'get-rules'], flags)}>
          {rules === null ? (
            <p class="muted">Loading…</p>
          ) : rules instanceof Error ? (
            unavailable(rules)
          ) : !rules.assignmentRules?.length && !rules.compatibleRedirectRules?.length ? (
            <p class="muted">No versioning rules are set on this queue.</p>
          ) : (
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Rule</th>
                </tr>
              </thead>
              <tbody>
                {(rules.assignmentRules ?? []).map((a, i) => (
                  <tr key={`a${i}`}>
                    <td>Assignment #{i}</td>
                    <td>
                      → <code>{a.rule?.targetBuildId}</code>
                      {a.rule?.percentageRamp ? ` (${a.rule.percentageRamp.rampPercentage ?? 0}% ramp)` : ''}
                    </td>
                  </tr>
                ))}
                {(rules.compatibleRedirectRules ?? []).map((r, i) => (
                  <tr key={`r${i}`}>
                    <td>Redirect</td>
                    <td>
                      <code>{r.rule?.sourceBuildId}</code> → <code>{r.rule?.targetBuildId}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>
    </section>
  );
}
