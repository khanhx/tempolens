import { useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { useLazyModule } from '../components/lazy-load';
import { GatedButton } from '../components/role-gate';
import type { ArchivalState } from '../lib/actions/admin';
import { humanRetention, protectedReason } from '../lib/actions/admin';
import { api, seg } from '../lib/api';
import { loadNamespaces } from '../lib/namespaces';
import { canAll, deniedReason, me, WRITE_ACTIONS } from '../lib/me';
import type { NamespaceSearchAttributes } from '../lib/server-info';
import { searchAttributes } from '../lib/server-info';
import { formatDuration, parseDuration } from '../lib/time';
import { href, P } from '../routes';

interface NamespaceInfo {
  namespaceInfo?: { name?: string; state?: string; description?: string; ownerEmail?: string; id?: string; capabilities?: Record<string, boolean> };
  config?: {
    workflowExecutionRetentionTtl?: string;
    historyArchivalState?: string;
    historyArchivalUri?: string;
    visibilityArchivalState?: string;
    visibilityArchivalUri?: string;
  };
  replicationConfig?: { activeClusterName?: string; clusters?: { clusterName?: string }[]; state?: string };
  failoverVersion?: string;
  isGlobalNamespace?: boolean;
}

const enumLabel = (v: string | undefined, prefix: string) => (v ? v.replace(prefix, '').toLowerCase() : '–');
// Deletion is asynchronous: a deleted namespace is still listed until Temporal removes its data.
const stateLabel = (v: string | undefined) => (v === 'NAMESPACE_STATE_DELETED' ? 'deleting' : enumLabel(v, 'NAMESPACE_STATE_'));
const archival = (v: string | undefined): ArchivalState => (v === 'ARCHIVAL_STATE_ENABLED' || v === 'ARCHIVAL_STATE_DISABLED' ? v : '');

type AdminDialog = { kind: 'edit' } | { kind: 'delete' } | { kind: 'sa-add' } | { kind: 'sa-remove'; names: string[] };

/**
 * Namespace page: info, archival, clusters, which actions this user may run,
 * and search attributes. Admins can edit or delete the namespace and add or
 * remove search attributes.
 */
export default function NamespaceDetail() {
  const { params } = useRoute();
  const ns = params.ns ?? '';
  const [d, setD] = useState<NamespaceInfo | null>(null);
  const [sa, setSa] = useState<NamespaceSearchAttributes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [dialog, setDialog] = useState<AdminDialog | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const mod = useLazyModule(() => import('./actions/admin-dialogs'), dialog !== null);
  const refresh = () => {
    setPicked([]);
    setReload(reload + 1);
  };

  useEffect(() => {
    let cancelled = false;
    // Not the cached describe: this page should show current values.
    api.get<NamespaceInfo>(`/api/v1/namespaces/${seg(ns)}`).then(
      (v) => !cancelled && setD(v),
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    );
    searchAttributes(ns).then((v) => !cancelled && setSa(v), () => undefined);
    return () => {
      cancelled = true;
    };
  }, [ns, reload]);

  const caps = Object.entries(d?.namespaceInfo?.capabilities ?? {}).filter(([, v]) => v);

  const isDeleting = deleting !== null || d?.namespaceInfo?.state === 'NAMESPACE_STATE_DELETED';
  const protectedWhy = protectedReason(ns, me.value);
  const canAdmin = canAll(['namespace']);
  const canSa = canAll(['searchAttribute']) && !isDeleting;
  const close = () => setDialog(null);

  return (
    <section class="page">
      <header class="page-head">
        <h1>{ns}</h1>
        <div class="toolbar-group">
          <a class="btn" href={href(P.workflows, { ns })}>
            Workflows
          </a>
          {d && !isDeleting && (
            <GatedButton actions={['namespace']} onClick={() => setDialog({ kind: 'edit' })}>
              Edit
            </GatedButton>
          )}
          {d && !isDeleting && (
            <button
              type="button"
              class="btn btn-danger"
              disabled={!canAdmin || !!protectedWhy}
              title={protectedWhy ?? deniedReason(['namespace']) ?? undefined}
              onClick={() => setDialog({ kind: 'delete' })}
            >
              Delete namespace
            </button>
          )}
        </div>
      </header>
      {d && !isDeleting && canAdmin && protectedWhy && <p class="muted">{protectedWhy}</p>}
      {isDeleting && (
        <p class="alert alert-warning" role="status">
          This namespace is being deleted{deleting ? <> (renamed to <code>{deleting}</code>)</> : ''}. Temporal removes its workflows and data in the background; it disappears from
          the list when that finishes.
        </p>
      )}
      {error && (
        <p class="alert alert-error" role="alert">
          {error}
        </p>
      )}
      {dialog && mod instanceof Error && <p class="field-error">Could not load the dialog: {mod.message}</p>}
      {dialog && mod && !(mod instanceof Error) && d && (
        <>
          {dialog.kind === 'edit' && (
            <mod.NamespaceDialog
              initial={{
                name: ns,
                description: d.namespaceInfo?.description ?? '',
                ownerEmail: d.namespaceInfo?.ownerEmail ?? '',
                retention: humanRetention(d.config?.workflowExecutionRetentionTtl),
                historyArchival: archival(d.config?.historyArchivalState),
                visibilityArchival: archival(d.config?.visibilityArchivalState),
              }}
              onClose={close}
              onDone={refresh}
            />
          )}
          {dialog.kind === 'delete' && (
            <mod.DeleteNamespaceDialog
              ns={ns}
              onClose={close}
              onDone={(renamed) => {
                setDeleting(renamed);
                void loadNamespaces(me.value?.settings.showSystemNamespace ?? false);
              }}
            />
          )}
          {dialog.kind === 'sa-add' && <mod.AddSearchAttributeDialog ns={ns} onClose={close} onDone={refresh} />}
          {dialog.kind === 'sa-remove' && <mod.RemoveSearchAttributesDialog ns={ns} names={dialog.names} onClose={close} onDone={refresh} />}
        </>
      )}
      {d && (
        <div class="stack">
          <dl class="kv-grid card card-pad">
            <div class="kv-item">
              <dt>State</dt>
              <dd>{isDeleting ? 'deleting' : stateLabel(d.namespaceInfo?.state)}</dd>
            </div>
            <div class="kv-item">
              <dt>Retention</dt>
              <dd>{formatDuration(parseDuration(d.config?.workflowExecutionRetentionTtl)) || '–'}</dd>
            </div>
            <div class="kv-item">
              <dt>Owner</dt>
              <dd>{d.namespaceInfo?.ownerEmail || '–'}</dd>
            </div>
            <div class="kv-item">
              <dt>Description</dt>
              <dd>{d.namespaceInfo?.description || '–'}</dd>
            </div>
            <div class="kv-item">
              <dt>History archival</dt>
              <dd>
                {enumLabel(d.config?.historyArchivalState, 'ARCHIVAL_STATE_')} {d.config?.historyArchivalUri && <code>{d.config.historyArchivalUri}</code>}
              </dd>
            </div>
            <div class="kv-item">
              <dt>Visibility archival</dt>
              <dd>
                {enumLabel(d.config?.visibilityArchivalState, 'ARCHIVAL_STATE_')} {d.config?.visibilityArchivalUri && <code>{d.config.visibilityArchivalUri}</code>}
              </dd>
            </div>
            <div class="kv-item">
              <dt>Global</dt>
              <dd>{d.isGlobalNamespace ? 'Yes' : 'No'}</dd>
            </div>
            <div class="kv-item">
              <dt>Active cluster</dt>
              <dd>{d.replicationConfig?.activeClusterName ?? '–'}</dd>
            </div>
            <div class="kv-item">
              <dt>Clusters</dt>
              <dd>{(d.replicationConfig?.clusters ?? []).map((c) => c.clusterName).join(', ') || '–'}</dd>
            </div>
            <div class="kv-item">
              <dt>Failover version</dt>
              <dd>{d.failoverVersion ?? '–'}</dd>
            </div>
            <div class="kv-item">
              <dt>Capabilities</dt>
              <dd>{caps.map(([k]) => k).join(', ') || '–'}</dd>
            </div>
          </dl>
          <section class="card card-pad">
            <h2>Actions for you</h2>
            <p class="muted">Your role is {me.value?.role ?? '…'}. The server enforces these; the UI only hides what it would refuse.</p>
            <table class="table">
              <tbody>
                {WRITE_ACTIONS.map((a) => (
                  <tr key={a}>
                    <th scope="row">{a}</th>
                    <td>{canAll([a]) ? 'Allowed' : deniedReason([a])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section class="card card-pad">
            <div class="page-head">
              <h2>Search attributes</h2>
              {!isDeleting && (
                <div class="toolbar-group">
                  <GatedButton actions={['searchAttribute']} onClick={() => setDialog({ kind: 'sa-add' })}>
                    Add attribute
                  </GatedButton>
                  {canSa && (
                    <button type="button" class="btn btn-danger" disabled={picked.length === 0} onClick={() => setDialog({ kind: 'sa-remove', names: picked })}>
                      Remove selected{picked.length ? ` (${picked.length})` : ''}
                    </button>
                  )}
                </div>
              )}
            </div>
            {sa ? (
              <table class="table">
                <thead>
                  <tr>
                    {canSa && (
                      <th scope="col">
                        <span class="visually-hidden">Select</span>
                      </th>
                    )}
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col">Kind</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(sa.types)
                    .sort(([a], [b]) => (sa.custom.includes(a) === sa.custom.includes(b) ? a.localeCompare(b) : sa.custom.includes(a) ? -1 : 1))
                    .map(([name, type]) => (
                      <tr key={name}>
                        {canSa && (
                          <td>
                            {sa.custom.includes(name) && (
                              <input
                                type="checkbox"
                                aria-label={`Select ${name}`}
                                checked={picked.includes(name)}
                                onChange={() => setPicked(picked.includes(name) ? picked.filter((n) => n !== name) : [...picked, name])}
                              />
                            )}
                          </td>
                        )}
                        <td>
                          <code>{name}</code>
                        </td>
                        <td>{type}</td>
                        <td>{sa.custom.includes(name) ? 'custom' : 'system'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : (
              <p class="muted">Loading…</p>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
