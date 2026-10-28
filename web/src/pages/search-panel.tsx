import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { PartialBanner } from '../components/partial-banner';
import { StatusBadge } from '../components/status-chips';
import { Timestamp } from '../components/timestamp';
import { namespaceName, namespaces as namespaceList } from '../lib/namespaces';
import { lastNamespace } from '../lib/prefs';
import { me } from '../lib/me';
import { shortEventType } from '../lib/temporal';
import type { NamespaceSelection, SearchMatch, SearchResponse } from '../lib/xapi';
import { busyText, xapi } from '../lib/xapi';
import { href, P, searchHref } from '../routes';

const EVENT_TYPES = [
  'ACTIVITY_TASK_FAILED',
  'ACTIVITY_TASK_TIMED_OUT',
  'WORKFLOW_TASK_FAILED',
  'WORKFLOW_TASK_TIMED_OUT',
  'WORKFLOW_EXECUTION_FAILED',
  'WORKFLOW_EXECUTION_TIMED_OUT',
  'WORKFLOW_EXECUTION_TERMINATED',
  'WORKFLOW_EXECUTION_CANCELED',
  'CHILD_WORKFLOW_EXECUTION_FAILED',
  'CHILD_WORKFLOW_EXECUTION_TIMED_OUT',
  'START_CHILD_WORKFLOW_EXECUTION_FAILED',
  'SIGNAL_EXTERNAL_WORKFLOW_EXECUTION_FAILED',
  'REQUEST_CANCEL_EXTERNAL_WORKFLOW_EXECUTION_FAILED',
  'NEXUS_OPERATION_FAILED',
  'NEXUS_OPERATION_TIMED_OUT',
  'WORKFLOW_EXECUTION_SIGNALED',
  'WORKFLOW_EXECUTION_CANCEL_REQUESTED',
  'WORKFLOW_EXECUTION_CONTINUED_AS_NEW',
  'WORKFLOW_EXECUTION_UPDATE_ACCEPTED',
  'WORKFLOW_EXECUTION_UPDATE_REJECTED',
  'WORKFLOW_EXECUTION_UPDATE_COMPLETED',
  'ACTIVITY_TASK_SCHEDULED',
  'ACTIVITY_TASK_CANCELED',
  'TIMER_FIRED',
  'TIMER_CANCELED',
  'MARKER_RECORDED',
  'START_CHILD_WORKFLOW_EXECUTION_INITIATED',
  'SIGNAL_EXTERNAL_WORKFLOW_EXECUTION_INITIATED',
  'REQUEST_CANCEL_EXTERNAL_WORKFLOW_EXECUTION_INITIATED',
  'UPSERT_WORKFLOW_SEARCH_ATTRIBUTES',
  'WORKFLOW_PROPERTIES_MODIFIED',
  'NEXUS_OPERATION_SCHEDULED',
].map((t) => `EVENT_TYPE_${t}`);

interface SearchForm {
  ns: string;
  kind: 'activity' | 'event';
  query: string;
  activityType: string;
  mode: 'pending' | 'history';
  minAttempt: string;
  eventType: string;
  failureText: string;
  max: string;
}

function formFrom(p: URLSearchParams, fallbackNs: string): SearchForm {
  return {
    ns: p.get('ns') || fallbackNs,
    kind: p.get('kind') === 'event' ? 'event' : 'activity',
    query: p.get('query') ?? '',
    activityType: p.get('activityType') ?? '',
    mode: p.get('mode') === 'history' ? 'history' : 'pending',
    minAttempt: p.get('minAttempt') ?? '',
    eventType: p.get('eventType') ?? '',
    failureText: p.get('failureText') ?? '',
    max: p.get('max') ?? '',
  };
}

const selectionOf = (ns: string): NamespaceSelection => (ns === '*' ? '*' : ns.split(',').map((s) => s.trim()).filter(Boolean));
const ready = (f: SearchForm) => (f.kind === 'activity' ? !!f.activityType.trim() : !!(f.eventType || f.failureText.trim()));

function Results({ result }: { result: SearchResponse }) {
  const link = (m: SearchMatch, eventId?: string) =>
    m.runId ? (eventId ? href(P.eventDetail, { ns: m.namespace, wf: m.workflowId, run: m.runId, eventId }) : href(P.run, { ns: m.namespace, wf: m.workflowId, run: m.runId })) : href(P.workflowLatest, { ns: m.namespace, wf: m.workflowId });
  return (
    <>
      <PartialBanner result={result} />
      <p class="muted">
        {result.matches.length.toLocaleString('en-US')} matching workflow{result.matches.length === 1 ? '' : 's'}; scanned {result.scanned.toLocaleString('en-US')} of{' '}
        {result.candidates.toLocaleString('en-US')} candidates in {(result.elapsedMs / 1000).toFixed(1)} s.
      </p>
      <table class="table card">
        <thead>
          <tr>
            <th scope="col">Namespace</th>
            <th scope="col">Workflow</th>
            <th scope="col">Type</th>
            <th scope="col">Status</th>
            <th scope="col">Started</th>
            <th scope="col">Hits</th>
          </tr>
        </thead>
        <tbody>
          {result.matches.length === 0 && (
            <tr>
              <td colSpan={6} class="dt-empty">
                No matches among the scanned workflows.
              </td>
            </tr>
          )}
          {result.matches.map((m) => (
            <tr key={`${m.namespace}/${m.workflowId}/${m.runId}`}>
              <td>{m.namespace}</td>
              <td>
                <a href={link(m)}>{m.workflowId}</a>
              </td>
              <td>{m.workflowType}</td>
              <td>
                <StatusBadge status={m.status} />
              </td>
              <td>
                <Timestamp value={m.startTime} />
              </td>
              <td>
                <ul class="list-plain">
                  {m.hits.slice(0, 5).map((h, i) => (
                    <li key={i}>
                      {h.eventId ? <a href={link(m, h.eventId)}>event {h.eventId}</a> : h.activityId ? `activity ${h.activityId}` : ''}
                      {h.attempt ? ` · attempt ${h.attempt}` : ''} {h.detail && <span class="muted">{h.detail}</span>}
                    </li>
                  ))}
                  {m.hits.length > 5 && <li class="muted">and {m.hits.length - 5} more</li>}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** Find workflows by activity type (pending or in history, the stuck finder) or by event type and failure text. */
export default function SearchPanel() {
  const { url, route } = useLocation();
  const params = useMemo(() => new URLSearchParams(url.split('?')[1] ?? ''), [url]);
  const fallbackNs = lastNamespace.value ?? me.value?.settings.defaultNamespace ?? 'default';
  const applied = useMemo(() => formFrom(params, fallbackNs), [params, fallbackNs]);
  const [form, setForm] = useState<SearchForm>(applied);
  useEffect(() => setForm(applied), [applied]);
  const [state, setState] = useState<{ loading: boolean; result?: SearchResponse; error?: string; busy?: boolean }>({ loading: false });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!ready(applied)) return setState({ loading: false });
    const controller = new AbortController();
    setState({ loading: true });
    const max = applied.max ? Number(applied.max) : undefined;
    const run = async () => {
      const namespaces = selectionOf(applied.ns);
      return applied.kind === 'activity'
        ? xapi.searchActivity(
            { namespaces, query: applied.query, activityType: applied.activityType, mode: applied.mode, minAttempt: applied.mode === 'pending' && applied.minAttempt ? Number(applied.minAttempt) : undefined, max },
            controller.signal,
          )
        : xapi.searchEvent({ namespaces, query: applied.query, eventType: applied.eventType || undefined, failureText: applied.failureText, max }, controller.signal);
    };
    run().then(
      (result) => setState({ loading: false, result }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        const busy = busyText(err);
        setState({ loading: false, error: busy ?? (err instanceof Error ? err.message : String(err)), busy: !!busy });
      },
    );
    return () => controller.abort();
  }, [applied, attempt]);

  const set = (patch: Partial<SearchForm>) => setForm({ ...form, ...patch });
  const submit = (e: Event) => {
    e.preventDefault();
    const p = new URLSearchParams(
      searchHref({
        ns: selectionOf(form.ns),
        kind: form.kind,
        query: form.query,
        activityType: form.kind === 'activity' ? form.activityType : undefined,
        mode: form.kind === 'activity' ? form.mode : undefined,
        minAttempt: form.kind === 'activity' && form.mode === 'pending' ? form.minAttempt : undefined,
        eventType: form.kind === 'event' ? form.eventType : undefined,
        failureText: form.kind === 'event' ? form.failureText : undefined,
      }).split('?')[1] ?? '',
    );
    if (form.max.trim()) p.set('max', form.max.trim());
    route(`${P.search}?${p.toString()}`);
  };

  const names = (namespaceList.value ?? []).map(namespaceName);
  return (
    <section class="page">
      <h1>Search workflows by activity or event</h1>
      <p class="muted">
        A bounded scan: the visibility query picks candidate workflows (at most {me.value?.settings.limits.scanMaxWorkflows ?? 200}), then their pending activities or
        histories are read. Narrow the query to scan less.
      </p>
      <form class="form-grid card card-pad" onSubmit={submit}>
        <div class="segmented form-wide" role="group" aria-label="Search for">
          <button type="button" class="btn" aria-pressed={form.kind === 'activity'} onClick={() => set({ kind: 'activity' })}>
            Activity type
          </button>
          <button type="button" class="btn" aria-pressed={form.kind === 'event'} onClick={() => set({ kind: 'event' })}>
            Event type / failure text
          </button>
        </div>
        <label class="field">
          <span>Namespaces</span>
          <select class="select" value={names.includes(form.ns) || form.ns === '*' ? form.ns : ''} onChange={(e) => set({ ns: (e.currentTarget as HTMLSelectElement).value })}>
            <option value="*">All namespaces</option>
            {!names.includes(form.ns) && form.ns !== '*' && <option value="">{form.ns}</option>}
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label class="field form-wide">
          <span>
            Visibility query <span class="muted">(optional, narrows the candidates)</span>
          </span>
          <input class="input input-mono" data-shortcut-search value={form.query} placeholder='e.g. ExecutionStatus = "Running" AND StartTime > "2026-10-27T00:00:00Z"' onInput={(e) => set({ query: (e.currentTarget as HTMLInputElement).value })} />
        </label>
        {form.kind === 'activity' ? (
          <>
            <label class="field">
              <span>Activity type (exact)</span>
              <input class="input" required value={form.activityType} onInput={(e) => set({ activityType: (e.currentTarget as HTMLInputElement).value })} />
            </label>
            <label class="field">
              <span>Look in</span>
              <select class="select" value={form.mode} onChange={(e) => set({ mode: (e.currentTarget as HTMLSelectElement).value as 'pending' | 'history' })}>
                <option value="pending">Pending activities of running workflows</option>
                <option value="history">Scheduled activities in any history</option>
              </select>
            </label>
            {form.mode === 'pending' && (
              <label class="field">
                <span>
                  Minimum attempt <span class="muted">(stuck finder)</span>
                </span>
                <input class="input" type="number" min={1} value={form.minAttempt} onInput={(e) => set({ minAttempt: (e.currentTarget as HTMLInputElement).value })} />
              </label>
            )}
          </>
        ) : (
          <>
            <label class="field">
              <span>Event type</span>
              <select class="select" value={form.eventType} onChange={(e) => set({ eventType: (e.currentTarget as HTMLSelectElement).value })}>
                <option value="">Any</option>
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {shortEventType(t)}
                  </option>
                ))}
              </select>
            </label>
            <label class="field">
              <span>Failure text</span>
              <input class="input" value={form.failureText} placeholder="substring of the failure message or its causes" onInput={(e) => set({ failureText: (e.currentTarget as HTMLInputElement).value })} />
            </label>
          </>
        )}
        <label class="field">
          <span>
            Candidate cap <span class="muted">(optional)</span>
          </span>
          <input class="input" type="number" min={1} max={1000} value={form.max} onInput={(e) => set({ max: (e.currentTarget as HTMLInputElement).value })} />
        </label>
        <div class="form-wide">
          <button type="submit" class="btn btn-primary" disabled={!ready(form) || state.loading}>
            {state.loading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>
      {state.error && (
        <p class={state.busy ? 'alert alert-warning' : 'alert alert-error'} role="alert">
          {state.error}{' '}
          <button type="button" class="btn btn-sm" onClick={() => setAttempt(attempt + 1)}>
            Retry
          </button>
        </p>
      )}
      {state.loading && <p class="muted">Scanning…</p>}
      {state.result && !state.loading && <Results result={state.result} />}
    </section>
  );
}
