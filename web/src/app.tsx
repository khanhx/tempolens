import { useSignalEffect } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { ErrorBoundary, lazy, LocationProvider, Route, Router, useLocation, useRoute } from 'preact-iso';
import { focusSearch, helpOpen, useShortcuts } from './components/keyboard';
import { KeyboardHelp } from './components/keyboard-help';
import { SessionBanner } from './components/session-banner';
import { Toasts } from './components/toast';
import { Header, routeLoading } from './components/shell/header';
import { Nav } from './components/shell/nav';
import { loginUrl, sessionExpired } from './lib/api';
import type { Me } from './lib/me';
import { loadMe, me, meError } from './lib/me';
import { loadNamespaces } from './lib/namespaces';
import { lastNamespace, navCollapsed } from './lib/prefs';
import { loadServerInfo } from './lib/server-info';
import { href, namespaceFromPath, P } from './routes';

// Every page is its own lazy chunk; the entry holds only the shell and vendor code.
const Namespaces = lazy(() => import('./pages/namespaces'));
const WorkflowsList = lazy(() => import('./pages/workflows-list'));
const WorkflowLatest = lazy(() => import('./pages/workflow-latest'));
const WorkflowLayout = lazy(() => import('./pages/workflow-layout'));
const NamespaceDetail = lazy(() => import('./pages/namespace-detail'));
const StartWorkflow = lazy(() => import('./pages/start-workflow'));
const SchedulesList = lazy(() => import('./pages/schedules-list'));
const ScheduleDetail = lazy(() => import('./pages/schedule-detail'));
const ScheduleForm = lazy(() => import('./pages/schedule-form'));
const BatchList = lazy(() => import('./pages/batch-list'));
const BatchDetail = lazy(() => import('./pages/batch-detail'));
const Archival = lazy(() => import('./pages/archival'));
const ArchivalHistory = lazy(() => import('./pages/archival-history'));
const TaskQueues = lazy(() => import('./pages/task-queues'));
const TaskQueue = lazy(() => import('./pages/task-queue'));
const NexusList = lazy(() => import('./pages/nexus-list'));
const NexusDetail = lazy(() => import('./pages/nexus-detail'));
const NexusForm = lazy(() => import('./pages/nexus-form'));
const ImportHistory = lazy(() => import('./pages/import'));
const CodecSettings = lazy(() => import('./pages/codec-settings'));
const SearchPanel = lazy(() => import('./pages/search-panel'));
const Cluster = lazy(() => import('./pages/cluster'));

/** Client-side redirect that replaces the history entry and keeps the query string. */
function Redirect({ to }: { to: string }) {
  const { route } = useLocation();
  useEffect(() => route(to + window.location.search, true), [to]);
  return null;
}

/** Redirects to `to` (a pattern from P), filled with the current route's params. */
function PatternRedirect({ to }: { to: string }) {
  const { params } = useRoute();
  return <Redirect to={href(to, params)} />;
}

function Home({ defaultNamespace }: { defaultNamespace: string }) {
  return <Redirect to={href(P.workflows, { ns: lastNamespace.value ?? defaultNamespace })} />;
}

function NotFound() {
  return (
    <section class="page">
      <h1>Page not found</h1>
      <p>
        No page matches this address. <a href="/">Go to the workflow list</a>.
      </p>
    </section>
  );
}

function RouteError({ error }: { error: Error }) {
  return (
    <section class="page">
      <div class="alert alert-error" role="alert">
        This page failed to load: {error.message}{' '}
        <button type="button" class="btn" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </section>
  );
}

function Routes({ me }: { me: Me }) {
  return (
    <Router onLoadStart={() => (routeLoading.value = true)} onLoadEnd={() => (routeLoading.value = false)}>
      <Route path={P.root} component={Home} defaultNamespace={me.settings.defaultNamespace} />
      <Route path={P.selectNamespace} component={Redirect} to={P.namespaces} />
      <Route path={P.namespaces} component={Namespaces} />
      <Route path={P.namespace} component={NamespaceDetail} />
      <Route path={P.allWorkflows} component={WorkflowsList} />
      <Route path={P.search} component={SearchPanel} />
      <Route path={P.cluster} component={Cluster} />

      <Route path={P.workflows} component={WorkflowsList} />
      <Route path={P.startWorkflow} component={StartWorkflow} />
      <Route path={P.workflowLatest} component={WorkflowLatest} />
      <Route path={P.run} component={PatternRedirect} to={P.timeline} />
      <Route path={P.timeline} component={WorkflowLayout} tab="timeline" />
      <Route path={P.history} component={WorkflowLayout} tab="history" />
      <Route path={P.eventDetail} component={WorkflowLayout} tab="event" />
      <Route path={P.historyLegacyMode} component={PatternRedirect} to={P.history} />
      <Route path={P.historyJson} component={WorkflowLayout} tab="history-json" />
      <Route path={P.relationships} component={WorkflowLayout} tab="graph" />
      <Route path={P.graph} component={WorkflowLayout} tab="graph" />
      <Route path={P.result} component={WorkflowLayout} tab="result" />
      <Route path={P.trace} component={WorkflowLayout} tab="trace" />
      <Route path={P.workers} component={WorkflowLayout} tab="workers" />
      <Route path={P.pendingActivities} component={WorkflowLayout} tab="pending-activities" />
      <Route path={P.callStack} component={WorkflowLayout} tab="call-stack" />
      <Route path={P.stackTrace} component={PatternRedirect} to={P.callStack} />
      <Route path={P.query} component={WorkflowLayout} tab="query" />
      <Route path={P.userMetadata} component={WorkflowLayout} tab="user-metadata" />
      <Route path={P.searchAttributes} component={WorkflowLayout} tab="search-attributes" />
      <Route path={P.memo} component={WorkflowLayout} tab="memo" />
      <Route path={P.nexusLinks} component={WorkflowLayout} tab="nexus-links" />

      <Route path={P.schedules} component={SchedulesList} />
      <Route path={P.scheduleCreate} component={ScheduleForm} />
      <Route path={P.schedule} component={ScheduleDetail} />
      <Route path={P.scheduleEdit} component={ScheduleForm} />
      <Route path={P.batchOperations} component={BatchList} />
      <Route path={P.batchOperation} component={BatchDetail} />
      <Route path={P.archival} component={Archival} />
      <Route path={P.archivedHistory} component={ArchivalHistory} />
      <Route path={P.taskQueues} component={TaskQueues} />
      <Route path={P.taskQueue} component={TaskQueue} />

      <Route path={P.nexus} component={NexusList} />
      <Route path={P.nexusCreate} component={NexusForm} />
      <Route path={P.nexusEndpoint} component={NexusDetail} />
      <Route path={P.nexusEdit} component={NexusForm} />
      <Route path={P.import} component={ImportHistory} />
      <Route path={P.codecSettings} component={CodecSettings} />
      <Route path={P.importEvents} component={Redirect} to={P.import} />
      <Route default component={NotFound} />
    </Router>
  );
}

function Shell({ me }: { me: Me }) {
  const { path } = useLocation();
  const fromPath = namespaceFromPath(path);
  const ns = fromPath ?? lastNamespace.value ?? me.settings.defaultNamespace;
  const [routeError, setRouteError] = useState<Error | null>(null);

  useEffect(() => {
    if (fromPath) lastNamespace.value = fromPath;
  }, [fromPath]);
  useEffect(() => {
    void loadNamespaces(me.settings.showSystemNamespace);
  }, [me.settings.showSystemNamespace]);
  useEffect(() => setRouteError(null), [path]);
  useEffect(() => void loadServerInfo(), []);
  useShortcuts({
    '/': focusSearch,
    '?': () => (helpOpen.value = true),
    Escape: () => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    },
  });

  return (
    <div class="app" data-nav={navCollapsed.value ? 'collapsed' : 'expanded'}>
      <Header me={me} ns={ns} />
      <Nav ns={ns} version={me.settings.version} />
      <main class="app-main" id="main">
        <SessionBanner />
        {routeError ? (
          <RouteError error={routeError} />
        ) : (
          <ErrorBoundary onError={(err: Error) => setRouteError(err)}>
            <Routes me={me} />
          </ErrorBoundary>
        )}
      </main>
      <KeyboardHelp />
      <Toasts />
    </div>
  );
}

function Boot() {
  // Contract §1.3: a 401 at start-up goes straight to login, returning to the
  // same URL. Once the app has loaded, the session banner offers the same
  // login link instead, so unsaved input on the page is not thrown away.
  useSignalEffect(() => {
    if (sessionExpired.value && !me.peek()) window.location.assign(loginUrl());
  });

  const current = me.value;
  const error = meError.value;
  if (current) return <Shell me={current} />;
  if (error && !sessionExpired.value) {
    return (
      <div class="boot">
        <div class="boot-panel alert alert-error" role="alert">
          <strong>Tempolens could not start.</strong>
          <span>{error.message}</span>
          <div>
            <button type="button" class="btn" onClick={() => void loadMe()}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div class="boot muted" role="status">
      {sessionExpired.value ? 'Redirecting to sign in…' : 'Loading…'}
    </div>
  );
}

export function App() {
  return (
    <LocationProvider>
      <Boot />
    </LocationProvider>
  );
}
