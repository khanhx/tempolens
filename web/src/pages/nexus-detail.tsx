import { useEffect, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import { ActionDialog } from '../components/modal';
import { PayloadView } from '../components/payload-view';
import { GatedButton } from '../components/role-gate';
import { Timestamp } from '../components/timestamp';
import { showToast } from '../components/toast';
import { confirmed, TypedConfirm } from '../components/typed-confirm';
import { api, seg } from '../lib/api';
import type { Endpoint } from '../lib/actions/nexus';
import { deleteEndpointRequest } from '../lib/actions/nexus';
import { sendAction } from '../lib/actions/workflow-actions';
import { href, P } from '../routes';
import { NexusUnavailable, nexusUnavailable } from './nexus-list';

export default function NexusDetail() {
  const { params } = useRoute();
  const id = params.id ?? '';
  const { route } = useLocation();
  const [e, setE] = useState<Endpoint | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    api.get<{ endpoint?: Endpoint }>(`/api/v1/nexus/endpoints/${seg(id)}`).then(
      (r) => setE(r.endpoint ?? null),
      (err: unknown) => setError(err),
    );
  }, [id]);

  const name = e?.spec?.name ?? id;
  return (
    <section class="page">
      <p class="muted crumbs">
        <a href={P.nexus}>Nexus endpoints</a>
      </p>
      <header class="run-head">
        <h1 class="run-title">{name}</h1>
        {e && (
          <div class="toolbar-group">
            <GatedButton actions={['nexus']} onClick={() => route(href(P.nexusEdit, { id }))}>
              Edit
            </GatedButton>
            <GatedButton actions={['nexus']} class="btn btn-danger" onClick={() => setDeleting(true)}>
              Delete
            </GatedButton>
          </div>
        )}
      </header>
      {nexusUnavailable(error) && <NexusUnavailable />}
      {!!error && !nexusUnavailable(error) && <p class="alert alert-error">{error instanceof Error ? error.message : String(error)}</p>}
      {e && (
        <div class="stack">
          <dl class="kv-grid card card-pad">
            <div class="kv-item">
              <dt>Target</dt>
              <dd>{e.spec?.target?.worker ? `${e.spec.target.worker.namespace ?? ''} / ${e.spec.target.worker.taskQueue ?? ''}` : (e.spec?.target?.external?.url ?? '–')}</dd>
            </div>
            <div class="kv-item">
              <dt>URL prefix</dt>
              <dd>
                <code>{e.urlPrefix ?? '–'}</code>
              </dd>
            </div>
            <div class="kv-item">
              <dt>Version</dt>
              <dd>{e.version}</dd>
            </div>
            <div class="kv-item">
              <dt>Created</dt>
              <dd>
                <Timestamp value={e.createdTime} />
              </dd>
            </div>
            <div class="kv-item">
              <dt>Modified</dt>
              <dd>
                <Timestamp value={e.lastModifiedTime} />
              </dd>
            </div>
          </dl>
          <section class="card card-pad">
            <h2>Description</h2>
            <PayloadView value={e.spec?.description ?? null} ns={e.spec?.target?.worker?.namespace ?? 'default'} />
          </section>
        </div>
      )}
      {deleting && e && (
        <ActionDialog
          title={`Delete ${name}`}
          submitLabel="Delete endpoint"
          danger
          canSubmit={confirmed(name, typed)}
          cli={() => deleteEndpointRequest(id, e.version, name).cli}
          onClose={() => setDeleting(false)}
          onSubmit={async () => {
            await sendAction(deleteEndpointRequest(id, e.version, name));
            showToast({ kind: 'success', text: `Endpoint ${name} deleted.` });
            route(P.nexus);
          }}
        >
          <p>Callers that use this endpoint will start to fail.</p>
          <TypedConfirm expected={name} value={typed} onInput={setTyped} what="the endpoint name" />
        </ActionDialog>
      )}
    </section>
  );
}
