import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { ActionMenu } from '../components/action-menu';
import { useLazyModule } from '../components/lazy-load';
import { GatedButton } from '../components/role-gate';
import { protectedReason } from '../lib/actions/admin';
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
  const [deleting, setDeleting] = useState<string | null>(null);
  const mod = useLazyModule(() => import('./actions/admin-dialogs'), creating || deleting !== null);
  const dialogOpen = creating || deleting !== null;

  return (
    <section class="page">
      <header class="page-head">
        <h1>Namespaces</h1>
        <GatedButton actions={['namespace']} onClick={() => setCreating(true)}>
          Create namespace
        </GatedButton>
      </header>
      {dialogOpen && mod instanceof Error && <p class="field-error">Could not load the dialog: {mod.message}</p>}
      {creating && mod && !(mod instanceof Error) && (
        <mod.NamespaceDialog
          onClose={() => setCreating(false)}
          onDone={(name) => {
            retry();
            route(href(P.namespace, { ns: name }));
          }}
        />
      )}
      {deleting !== null && mod && !(mod instanceof Error) && (
        <mod.DeleteNamespaceDialog ns={deleting} onClose={() => setDeleting(null)} onDone={retry} />
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
              <th scope="col">
                <span class="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((n) => {
              const name = namespaceName(n);
              const gone = n.namespaceInfo?.state === 'NAMESPACE_STATE_DELETED';
              return (
                <tr key={name}>
                  <td>
                    <a href={href(P.workflows, { ns: name })}>{name}</a>
                  </td>
                  <td>{stateLabel(n.namespaceInfo?.state)}</td>
                  <td>{formatDuration(parseDuration(n.config?.workflowExecutionRetentionTtl))}</td>
                  <td>{n.namespaceInfo?.ownerEmail}</td>
                  <td>{n.namespaceInfo?.description}</td>
                  <td>
                    <div class="row-actions">
                      <a class="btn btn-sm" href={href(P.namespace, { ns: name })}>
                        Details
                      </a>
                      <ActionMenu
                        label="⋯"
                        caret={false}
                        ariaLabel={`Actions for ${name}`}
                        items={[
                          {
                            id: 'delete',
                            label: 'Delete namespace',
                            actions: ['namespace'],
                            danger: true,
                            disabledReason: gone ? `${name} is already being deleted.` : protectedReason(name, me.value),
                            onSelect: () => setDeleting(name),
                          },
                        ]}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
