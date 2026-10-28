import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { useLazyModule } from '../components/lazy-load';
import { GatedButton } from '../components/role-gate';
import type { NamespaceEntry } from '../lib/namespaces';
import { loadNamespaces, namespaceName, namespaces, namespacesError } from '../lib/namespaces';
import { me } from '../lib/me';
import { formatDuration, parseDuration } from '../lib/time';
import { href, P } from '../routes';

// Deletion is asynchronous: a deleted namespace stays listed until Temporal removes its data.
const stateLabel = (state: string | undefined) => (state === 'NAMESPACE_STATE_DELETED' ? 'deleting' : state ? state.replace(/^NAMESPACE_STATE_/, '').toLowerCase() : '');

interface NamespaceRow extends NamespaceEntry {
  namespaceInfo?: { name?: string; state?: string; description?: string; ownerEmail?: string };
  config?: { workflowExecutionRetentionTtl?: string };
}

/** Namespace list; `temporal-system` is hidden unless the server shows it (also enforced server-side). */
export default function Namespaces() {
  const list = namespaces.value as NamespaceRow[] | null;
  const error = namespacesError.value;
  const retry = () => void loadNamespaces(me.value?.settings.showSystemNamespace ?? false);
  const { route } = useLocation();
  const [creating, setCreating] = useState(false);
  const mod = useLazyModule(() => import('./actions/admin-dialogs'), creating);

  return (
    <section class="page">
      <header class="page-head">
        <h1>Namespaces</h1>
        <GatedButton actions={['namespace']} onClick={() => setCreating(true)}>
          Create namespace
        </GatedButton>
      </header>
      {creating && mod instanceof Error && <p class="field-error">Could not load the dialog: {mod.message}</p>}
      {creating && mod && !(mod instanceof Error) && (
        <mod.NamespaceDialog
          onClose={() => setCreating(false)}
          onDone={(name) => {
            retry();
            route(href(P.namespace, { ns: name }));
          }}
        />
      )}
      {error && (
        <div class="alert alert-error" role="alert">
          Could not load namespaces: {error.message}{' '}
          <button type="button" class="btn" onClick={retry}>
            Retry
          </button>
        </div>
      )}
      {!list && !error && <p class="muted">Loading namespaces…</p>}
      {list && list.length === 0 && <p class="muted">No namespaces.</p>}
      {list && list.length > 0 && (
        <table class="table card">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">State</th>
              <th scope="col">Retention</th>
              <th scope="col">Owner</th>
              <th scope="col">Description</th>
            </tr>
          </thead>
          <tbody>
            {list.map((n) => {
              const name = namespaceName(n);
              return (
                <tr key={name}>
                  <td>
                    <a href={href(P.workflows, { ns: name })}>{name}</a>{' '}
                    <a class="muted" href={href(P.namespace, { ns: name })}>
                      details
                    </a>
                  </td>
                  <td>{stateLabel(n.namespaceInfo?.state)}</td>
                  <td>{formatDuration(parseDuration(n.config?.workflowExecutionRetentionTtl))}</td>
                  <td>{n.namespaceInfo?.ownerEmail}</td>
                  <td>{n.namespaceInfo?.description}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
