import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import { ActionMenu } from '../components/action-menu';
import { CopyButton } from '../components/copy-button';
import { useLazyModule } from '../components/lazy-load';
import { canAll } from '../lib/me';
import { describeNamespace } from '../lib/server-info';
import { CodecErrorBanner, PayloadView } from '../components/payload-view';
import { StatusBadge } from '../components/status-chips';
import { Duration, Timestamp } from '../components/timestamp';
import { buildUrl } from '../lib/api';
import { apiPageFetcher } from '../lib/history/fetch';
import { activeCodec, decodeWithCodec } from '../lib/payload/codec';
import { stringifyJson } from '../lib/payload/json-bigint';
import { quoteString } from '../lib/query/build';
import type { RunStore } from '../lib/run-store';
import { runStore } from '../lib/run-store';
import type { HistoryEvent } from '../lib/temporal';
import { CLOSE_EVENT_TYPES, eventAttributes, isRunning, shortEventType } from '../lib/temporal';
import { durationBetween, parseDuration } from '../lib/time';
import { href, P } from '../routes';
import { CallStackTab } from './tabs/call-stack';
import { EventDetailTab } from './tabs/event-detail';
import { HistoryTab } from './tabs/history';
import { JsonTab } from './tabs/json';
import { MetadataTab } from './tabs/metadata';
import { PendingActivitiesTab } from './tabs/pending-activities';
import { QueryTab } from './tabs/query';
import { GraphTab } from './tabs/graph';
import { ResultTab } from './tabs/result';
import { TraceTab } from './tabs/trace';
import { TimelineTab } from './tabs/timeline';
import { NexusLinksTab } from './tabs/nexus-links';
import { WorkersTab } from './tabs/workers';
import type { WorkflowActionKind } from './actions/workflow-dialogs';

export type RunTab =
  | 'timeline'
  | 'history'
  | 'event'
  | 'pending-activities'
  | 'workers'
  | 'call-stack'
  | 'query'
  | 'user-metadata'
  | 'search-attributes'
  | 'memo'
  | 'nexus-links'
  | 'graph'
  | 'result'
  | 'trace'
  | 'history-json';

export interface RunContext {
  store: RunStore;
  ns: string;
  wf: string;
  run: string;
}

export function exportUrl(ns: string, wf: string, run: string): string {
  return buildUrl('/api/x/history-export', { namespace: ns, workflowId: wf, runId: run });
}

function Field({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="kv-item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Summary({ store, ns }: { store: RunStore; ns: string }) {
  const d = store.describe.value;
  const info = d?.workflowExecutionInfo;
  const cfg = d?.executionConfig;
  if (!info) return null;
  const end = info.closeTime ?? null;
  const parent = info.parentExecution;
  const root = info.rootExecution;
  const isRoot = !root || (root.workflowId === info.execution.workflowId && root.runId === info.execution.runId);
  return (
    <dl class="kv-grid">
      <Field label="Type">{info.type?.name}</Field>
      <Field label="Start">
        <Timestamp value={info.startTime} />
      </Field>
      <Field label="End">
        <Timestamp value={end} />
      </Field>
      <Field label="Duration">
        <Duration ms={end ? durationBetween(info.startTime, end) : info.startTime ? Date.now() - (Date.parse(info.startTime) || Date.now()) : null} />
      </Field>
      <Field label="Execution start">
        <Timestamp value={info.executionTime} />
      </Field>
      <Field label="Task queue">
        {info.taskQueue || cfg?.taskQueue?.name ? (
          <a href={href(P.taskQueue, { ns, queue: info.taskQueue ?? cfg?.taskQueue?.name ?? '' })}>{info.taskQueue ?? cfg?.taskQueue?.name}</a>
        ) : (
          '–'
        )}
      </Field>
      <Field label="History">
        {Number(info.historyLength ?? 0).toLocaleString('en-US')} events · {Number(info.historySizeBytes ?? 0).toLocaleString('en-US')} B
      </Field>
      <Field label="State transitions">{Number(info.stateTransitionCount ?? 0).toLocaleString('en-US')}</Field>
      <Field label="Run timeout">
        <Duration ms={parseDuration(cfg?.workflowRunTimeout) || null} />
      </Field>
      <Field label="Execution timeout">
        <Duration ms={parseDuration(cfg?.workflowExecutionTimeout) || null} />
      </Field>
      <Field label="Task timeout">
        <Duration ms={parseDuration(cfg?.defaultWorkflowTaskTimeout)} />
      </Field>
      <Field label="Parent">
        {parent ? <a href={href(P.run, { ns, wf: parent.workflowId, run: parent.runId ?? '' })}>{parent.workflowId}</a> : '–'}
      </Field>
      <Field label="Root">
        {!isRoot && root ? <a href={href(P.run, { ns, wf: root.workflowId, run: root.runId ?? '' })}>{root.workflowId}</a> : 'This run'}
      </Field>
      <Field label="Children">
        <a href={href(P.workflows, { ns }, { query: `ParentWorkflowId = ${quoteString(info.execution.workflowId)}` })}>List child workflows</a>
      </Field>
    </dl>
  );
}

/** Result shown for each kind of close event. */
function closeValue(e: HistoryEvent): { label: string; value: unknown } | null {
  const a = eventAttributes(e);
  switch (shortEventType(e.eventType)) {
    case 'WorkflowExecutionCompleted':
      return { label: 'Result', value: a.result ?? null };
    case 'WorkflowExecutionFailed':
      return { label: 'Failure', value: a.failure };
    case 'WorkflowExecutionCanceled':
      return { label: 'Cancellation details', value: a.details ?? null };
    case 'WorkflowExecutionTerminated':
      return { label: 'Termination', value: { reason: a.reason, identity: a.identity, details: a.details } };
    case 'WorkflowExecutionTimedOut':
      return { label: 'Timed out', value: { retryState: a.retryState } };
    case 'WorkflowExecutionContinuedAsNew':
      return { label: 'Continued as new', value: { newExecutionRunId: a.newExecutionRunId, input: a.input } };
    default:
      return null;
  }
}

export function InputAndResult({ store, ns }: { store: RunStore; ns: string }) {
  const events = store.history.events.value;
  const start = events[0]?.eventId === '1' ? events[0] : undefined;
  const last = events[events.length - 1];
  const close = last && CLOSE_EVENT_TYPES.has(last.eventType) ? closeValue(last) : null;
  const input = start ? eventAttributes(start).input : undefined;
  return (
    <div class="io-grid">
      <section class="card card-pad">
        <h2>Input</h2>
        {start ? <PayloadView value={input ?? null} ns={ns} /> : <p class="muted">Loading…</p>}
      </section>
      <section class="card card-pad">
        <h2>{close?.label ?? 'Result'}</h2>
        {close ? (
          <PayloadView value={close.value} ns={ns} />
        ) : (
          <p class="muted">{isRunning(store.describe.value?.workflowExecutionInfo?.status) ? 'Still running.' : 'Loading…'}</p>
        )}
      </section>
    </div>
  );
}

function ExportButtons({ ns, wf, run }: { ns: string; wf: string; run: string }) {
  const [progress, setProgress] = useState<string | null>(null);
  const exportDecoded = async () => {
    try {
      const fetchPage = apiPageFetcher(ns, wf, run);
      const all: HistoryEvent[] = [];
      let token: string | undefined;
      do {
        const page = await fetchPage('asc', token);
        all.push(...page.events);
        token = page.nextPageToken;
        setProgress(`Fetched ${all.length.toLocaleString('en-US')} events…`);
      } while (token);
      setProgress('Decoding…');
      const decoded = await decodeWithCodec(all, ns, activeCodec(), { force: true });
      const url = URL.createObjectURL(new Blob([stringifyJson(decoded)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${run}-events-decoded.json`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setProgress(null);
    } catch (err) {
      setProgress(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return (
    <div class="toolbar-group">
      <a class="btn" href={exportUrl(ns, wf, run)} download={`${run}-events.json`}>
        Download history
      </a>
      <button type="button" class="btn" disabled={progress !== null && !progress.startsWith('Download failed')} onClick={() => void exportDecoded()}>
        Download decoded
      </button>
      {progress && <span class="muted">{progress}</span>}
    </div>
  );
}

const TABS: { id: RunTab; label: string; pattern: string }[] = [
  { id: 'timeline', label: 'Timeline', pattern: P.timeline },
  { id: 'history', label: 'History', pattern: P.history },
  { id: 'pending-activities', label: 'Pending activities', pattern: P.pendingActivities },
  { id: 'workers', label: 'Workers', pattern: P.workers },
  { id: 'call-stack', label: 'Call stack', pattern: P.callStack },
  { id: 'query', label: 'Query', pattern: P.query },
  { id: 'user-metadata', label: 'Metadata', pattern: P.userMetadata },
  { id: 'nexus-links', label: 'Nexus links', pattern: P.nexusLinks },
  { id: 'result', label: 'Result', pattern: P.result },
  { id: 'graph', label: 'Relationships', pattern: P.relationships },
  { id: 'trace', label: 'Trace', pattern: P.trace },
];

function RunActions({ store }: { store: RunStore }) {
  const [dialog, setDialog] = useState<WorkflowActionKind | null>(null);
  const [pauseCapable, setPauseCapable] = useState(false);
  const mod = useLazyModule(() => import('./actions/workflow-dialogs'), dialog !== null);
  useEffect(() => {
    let cancelled = false;
    describeNamespace(store.ns).then(
      (d) => !cancelled && setPauseCapable(d.namespaceInfo?.capabilities?.workflowPause === true),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [store.ns]);
  const info = store.describe.value?.workflowExecutionInfo;
  const running = isRunning(info?.status);
  const paused = info?.status === 'WORKFLOW_EXECUTION_STATUS_PAUSED';
  const startLike = href(P.startWorkflow, { ns: store.ns }, { workflowId: store.wf, runId: store.run, taskQueue: info?.taskQueue ?? '', workflowType: info?.type?.name ?? '' });
  return (
    <>
      {canAll(['start']) && info && (
        <a class="btn" href={startLike}>
          Start like this one
        </a>
      )}
      <ActionMenu
        items={[
          { id: 'signal', label: 'Signal', actions: ['signal'], onSelect: () => setDialog('signal'), hidden: !running },
          { id: 'update', label: 'Update', actions: ['update'], onSelect: () => setDialog('update'), hidden: !running },
          { id: 'cancel', label: 'Request cancellation', actions: ['cancel'], onSelect: () => setDialog('cancel'), hidden: !running },
          { id: 'terminate', label: 'Terminate', actions: ['terminate'], onSelect: () => setDialog('terminate'), danger: true, hidden: !running },
          { id: 'reset', label: 'Reset', actions: ['reset'], onSelect: () => setDialog('reset'), danger: true, hidden: !info },
          { id: 'pause', label: 'Pause', actions: ['pause'], onSelect: () => setDialog('pause'), hidden: !pauseCapable || !running },
          { id: 'unpause', label: 'Unpause', actions: ['pause'], onSelect: () => setDialog('unpause'), hidden: !pauseCapable || !paused },
          { id: 'delete', label: 'Delete', actions: ['delete'], onSelect: () => setDialog('delete'), danger: true, hidden: !info },
        ]}
      />
      {dialog && mod instanceof Error && <span class="field-error">Could not load the dialog: {mod.message}</span>}
      {dialog && mod && !(mod instanceof Error) && <mod.default kind={dialog} store={store} onClose={() => setDialog(null)} />}
    </>
  );
}

export default function WorkflowLayout({ tab }: { tab: RunTab }) {
  const { params } = useRoute();
  const ns = params.ns ?? '';
  const wf = params.wf ?? '';
  const run = params.run ?? '';
  const { url } = useLocation();
  const store = useMemo(() => runStore(ns, wf, run), [ns, wf, run]);
  useEffect(() => store.activate(), [store]);

  const showJson = new URLSearchParams(url.split('?')[1] ?? '').has('json');

  useEffect(() => {
    // The old raw-history link now downloads through the export endpoint.
    if (tab === 'history-json') window.location.replace(exportUrl(ns, wf, run));
  }, [tab, ns, wf, run]);
  if (tab === 'history-json') return <p class="page muted">Starting the history download…</p>;

  const d = store.describe.value;
  const info = d?.workflowExecutionInfo;
  const running = isRunning(info?.status);
  const latest = store.latestRunId.value;
  const pollers = store.pollers.value;
  const pendingCount = d?.pendingActivities?.length ?? 0;
  const ctx: RunContext = { store, ns, wf, run };
  const activeTab = tab === 'event' ? 'history' : tab === 'search-attributes' || tab === 'memo' ? 'user-metadata' : tab;

  return (
    <section class="page">
      <header class="run-head">
        <div>
          <p class="muted crumbs">
            <a href={href(P.workflows, { ns })}>{ns}</a> / workflow
          </p>
          <h1 class="run-title">
            {wf} <CopyButton text={wf} label="Copy ID" />
          </h1>
          <p class="muted">
            Run <code>{run}</code> {info && <StatusBadge status={info.status} />}
          </p>
        </div>
        <div class="toolbar-group">
          <RunActions store={store} />
          <ExportButtons ns={ns} wf={wf} run={run} />
        </div>
      </header>

      <CodecErrorBanner />
      {store.describeError.value && (
        <div class="alert alert-error" role="alert">
          Could not load this run: {store.describeError.value.message}
        </div>
      )}
      {latest && latest !== run && (
        <div class="alert" role="status">
          This is not the latest run of this workflow. <a href={href(P.run, { ns, wf, run: latest })}>Go to the latest run</a>.
        </div>
      )}
      {running && pollers && pollers.workflow.length === 0 && (
        <div class="alert alert-warning" role="status">
          No workers are polling the task queue <code>{info?.taskQueue ?? d?.executionConfig?.taskQueue?.name}</code>; this workflow cannot make progress until one starts.
        </div>
      )}

      <details class="card card-pad summary" open>
        <summary>Summary</summary>
        <Summary store={store} ns={ns} />
      </details>

      <nav class="tabs" aria-label="Workflow views">
        {TABS.map((t) => (
          <a key={t.id} class="tab" href={href(t.pattern, { ns, wf, run })} aria-current={!showJson && activeTab === t.id ? 'page' : undefined}>
            {t.label}
            {t.id === 'pending-activities' && pendingCount > 0 && <span class="tab-count">{pendingCount}</span>}
          </a>
        ))}
        <a class="tab" href={`${href(P.timeline, { ns, wf, run })}?json`} aria-current={showJson ? 'page' : undefined}>
          JSON
        </a>
      </nav>

      <div class="tab-panel">
        {showJson ? (
          <JsonTab {...ctx} />
        ) : tab === 'timeline' ? (
          <TimelineTab {...ctx} />
        ) : tab === 'history' ? (
          <HistoryTab {...ctx} />
        ) : tab === 'event' ? (
          <EventDetailTab {...ctx} eventId={params.eventId ?? ''} />
        ) : tab === 'pending-activities' ? (
          <PendingActivitiesTab {...ctx} />
        ) : tab === 'workers' ? (
          <WorkersTab {...ctx} />
        ) : tab === 'call-stack' ? (
          <CallStackTab {...ctx} />
        ) : tab === 'query' ? (
          <QueryTab {...ctx} />
        ) : tab === 'nexus-links' ? (
          <NexusLinksTab {...ctx} />
        ) : tab === 'graph' ? (
          <GraphTab {...ctx} />
        ) : tab === 'result' ? (
          <ResultTab {...ctx} />
        ) : tab === 'trace' ? (
          <TraceTab {...ctx} />
        ) : (
          <MetadataTab {...ctx} focus={tab} />
        )}
      </div>
    </section>
  );
}
