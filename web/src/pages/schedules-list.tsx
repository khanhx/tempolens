import { useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { RoleGate } from '../components/role-gate';
import { Timestamp } from '../components/timestamp';
import { api, seg } from '../lib/api';
import type { ScheduleSpec } from '../lib/actions/schedule';
import { countSchedules, describeSpec } from '../lib/actions/schedule';
import { SCHEDULE_GATES } from '../lib/me';
import { href, P } from '../routes';

export interface ScheduleListEntry {
  scheduleId: string;
  info?: {
    spec?: ScheduleSpec;
    workflowType?: { name?: string };
    notes?: string;
    paused?: boolean;
    recentActions?: { scheduleTime?: string; actualTime?: string; startWorkflowResult?: { workflowId?: string; runId?: string } }[];
    futureActionTimes?: string[];
  };
}

export default function SchedulesList() {
  const { params } = useRoute();
  const ns = params.ns ?? '';
  const [rows, setRows] = useState<ScheduleListEntry[]>([]);
  const [token, setToken] = useState<string | undefined>();
  const [count, setCount] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [state, setState] = useState<{ loading: boolean; error?: string }>({ loading: true });

  const load = async (next?: string) => {
    setState({ loading: true });
    try {
      const res = await api.get<{ schedules?: ScheduleListEntry[]; nextPageToken?: string }>(`/api/v1/namespaces/${seg(ns)}/schedules`, {
        maximumPageSize: 100,
        nextPageToken: next,
        query: applied || undefined,
      });
      setRows((r) => (next ? [...r, ...(res.schedules ?? [])] : (res.schedules ?? [])));
      setToken(res.nextPageToken || undefined);
      setState({ loading: false });
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  useEffect(() => {
    void load();
    countSchedules(ns).then(setCount, () => setCount(null));
  }, [ns, applied]);

  return (
    <section class="page">
      <header class="page-head">
        <h1>
          Schedules <span class="muted">{ns}</span> {count !== null && <span class="badge">{count}</span>}
        </h1>
        <RoleGate actions={SCHEDULE_GATES.create}>
          <a class="btn btn-primary" href={href(P.scheduleCreate, { ns })}>
            Create schedule
          </a>
        </RoleGate>
      </header>
      <form
        class="raw-query"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(query.trim());
        }}
      >
        <input class="input input-mono" data-shortcut-search aria-label="Schedule query" placeholder='Visibility query, e.g. TemporalSchedulePaused = true' value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
        <button class="btn" type="submit">
          Apply
        </button>
      </form>
      {state.error && (
        <p class="alert alert-error" role="alert">
          {state.error}
        </p>
      )}
      <table class="table card">
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Schedule ID</th>
            <th scope="col">Workflow type</th>
            <th scope="col">Spec</th>
            <th scope="col">Last run</th>
            <th scope="col">Next run</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} class="dt-empty">
                {state.loading ? 'Loading…' : 'No schedules.'}
              </td>
            </tr>
          )}
          {rows.map((s) => {
            const last = s.info?.recentActions?.[s.info.recentActions.length - 1];
            return (
              <tr key={s.scheduleId}>
                <td>{s.info?.paused ? <span class="status status-canceled">Paused</span> : <span class="status status-running">Active</span>}</td>
                <td>
                  <a href={href(P.schedule, { ns, id: s.scheduleId })}>{s.scheduleId}</a>
                </td>
                <td>{s.info?.workflowType?.name}</td>
                <td>{describeSpec(s.info?.spec)}</td>
                <td>
                  {last?.startWorkflowResult?.workflowId && last.startWorkflowResult.runId ? (
                    <a href={href(P.run, { ns, wf: last.startWorkflowResult.workflowId, run: last.startWorkflowResult.runId })}>
                      <Timestamp value={last.actualTime} />
                    </a>
                  ) : (
                    <Timestamp value={last?.actualTime} />
                  )}
                </td>
                <td>
                  <Timestamp value={s.info?.futureActionTimes?.[0]} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {token && (
        <button type="button" class="btn" disabled={state.loading} onClick={() => void load(token)}>
          Load more
        </button>
      )}
    </section>
  );
}
