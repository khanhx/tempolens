import { useEffect, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import { CopyButton } from '../components/copy-button';
import { showToast } from '../components/toast';
import { api, seg } from '../lib/api';
import type { Endpoint, EndpointForm } from '../lib/actions/nexus';
import { createEndpointRequest, endpointSpec, updateEndpointRequest } from '../lib/actions/nexus';
import { sendAction } from '../lib/actions/workflow-actions';
import { canAll, deniedReason } from '../lib/me';
import { decodePayload } from '../lib/payload/decode';
import { href, P } from '../routes';
import { NexusUnavailable, nexusUnavailable } from './nexus-list';

const EMPTY: EndpointForm = { name: '', description: '', targetNamespace: '', targetTaskQueue: '' };

/** Create (`/nexus/create`) or edit (`/nexus/:id/edit`) an endpoint; edits send the current version. */
export default function NexusFormPage() {
  const { params } = useRoute();
  const editId = params.id;
  const { route } = useLocation();
  const [form, setForm] = useState<EndpointForm>(EMPTY);
  const [version, setVersion] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editId) return;
    api.get<{ endpoint?: Endpoint }>(`/api/v1/nexus/endpoints/${seg(editId)}`).then(
      (r) => {
        const e = r.endpoint;
        const d = e?.spec?.description ? decodePayload(e.spec.description, true) : null;
        setForm({
          name: e?.spec?.name ?? '',
          description: d?.kind === 'value' && typeof d.value === 'string' ? d.value : '',
          targetNamespace: e?.spec?.target?.worker?.namespace ?? '',
          targetTaskQueue: e?.spec?.target?.worker?.taskQueue ?? '',
        });
        setVersion(e?.version ?? '');
      },
      (err: unknown) => setError(err),
    );
  }, [editId]);

  if (!canAll(['nexus'])) {
    return (
      <section class="page">
        <h1>Nexus endpoint</h1>
        <p class="alert">{deniedReason(['nexus'])}</p>
      </section>
    );
  }

  const build = () => (editId ? updateEndpointRequest(editId, version, endpointSpec(form)) : createEndpointRequest(endpointSpec(form)));
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await sendAction<{ endpoint?: Endpoint }>(build());
      showToast({ kind: 'success', text: editId ? 'Endpoint updated.' : 'Endpoint created.' });
      const id = editId ?? res?.endpoint?.id;
      route(id ? href(P.nexusEndpoint, { id }) : P.nexus);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  const field = (label: string, key: keyof EndpointForm) => (
    <label class="field">
      <span>{label}</span>
      <input class="input" required={key !== 'description'} value={form[key]} onInput={(e) => setForm({ ...form, [key]: (e.currentTarget as HTMLInputElement).value })} />
    </label>
  );

  return (
    <section class="page">
      <p class="muted crumbs">
        <a href={P.nexus}>Nexus endpoints</a>
      </p>
      <h1>{editId ? `Edit ${form.name || editId}` : 'Create a Nexus endpoint'}</h1>
      {nexusUnavailable(error) ? (
        <NexusUnavailable />
      ) : (
        <form class="form-grid" onSubmit={submit}>
          {field('Name', 'name')}
          {field('Target namespace', 'targetNamespace')}
          {field('Target task queue', 'targetTaskQueue')}
          {field('Description (optional)', 'description')}
          {!!error && (
            <p class="alert alert-error form-wide" role="alert">
              {error instanceof Error ? error.message : String(error)}
            </p>
          )}
          <div class="dialog-footer form-wide">
            <CopyButton
              text={() => {
                try {
                  return build().cli;
                } catch (err) {
                  return `# ${err instanceof Error ? err.message : String(err)}`;
                }
              }}
              label="Copy as temporal CLI"
            />
            <span class="toolbar-spacer" />
            <a class="btn" href={editId ? href(P.nexusEndpoint, { id: editId }) : P.nexus}>
              Cancel
            </a>
            <button type="submit" class="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : editId ? 'Save endpoint' : 'Create endpoint'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
