import { useEffect, useState } from 'preact/hooks';
import { RoleGate } from '../components/role-gate';
import { ApiError, api } from '../lib/api';
import type { Endpoint } from '../lib/actions/nexus';
import { href, P } from '../routes';

/** True for the answers a server without Nexus gives (501 Unimplemented, or 404/405 on older gateways). */
export const nexusUnavailable = (err: unknown) => err instanceof ApiError && (err.status === 501 || err.code === 12);

export function NexusUnavailable() {
  return (
    <div class="alert" role="status">
      <strong>Nexus is not available on this Temporal server.</strong>
      <p class="muted">Nexus endpoints need a Temporal server with Nexus enabled; this one answered that the API is not implemented.</p>
    </div>
  );
}

export default function NexusList() {
  const [rows, setRows] = useState<Endpoint[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [applied, setApplied] = useState('');

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    api.get<{ endpoints?: Endpoint[] }>('/api/v1/nexus/endpoints', { pageSize: 100, name: applied || undefined }).then(
      (r) => !cancelled && setRows(r.endpoints ?? []),
      (err: unknown) => !cancelled && setError(err),
    );
    return () => {
      cancelled = true;
    };
  }, [applied]);

  return (
    <section class="page">
      <header class="page-head">
        <h1>Nexus endpoints</h1>
        <RoleGate actions={['nexus']}>
          <a class="btn btn-primary" href={P.nexusCreate}>
            Create endpoint
          </a>
        </RoleGate>
      </header>
      {nexusUnavailable(error) ? (
        <NexusUnavailable />
      ) : error ? (
        <p class="alert alert-error" role="alert">
          {error instanceof Error ? error.message : String(error)}
        </p>
      ) : (
        <>
          <form
            class="raw-query"
            onSubmit={(e) => {
              e.preventDefault();
              setApplied(name.trim());
            }}
          >
            <input class="input" data-shortcut-search aria-label="Endpoint name" placeholder="Exact endpoint name" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
            <button class="btn" type="submit">
              Search
            </button>
          </form>
          <table class="table card">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Target</th>
                <th scope="col">Version</th>
              </tr>
            </thead>
            <tbody>
              {rows === null && (
                <tr>
                  <td colSpan={3} class="dt-empty">
                    Loading…
                  </td>
                </tr>
              )}
              {rows?.length === 0 && (
                <tr>
                  <td colSpan={3} class="dt-empty">
                    No endpoints.
                  </td>
                </tr>
              )}
              {rows?.map((e) => (
                <tr key={e.id}>
                  <td>
                    <a href={href(P.nexusEndpoint, { id: e.id })}>{e.spec?.name}</a>
                  </td>
                  <td>
                    {e.spec?.target?.worker
                      ? `${e.spec.target.worker.namespace ?? ''} / ${e.spec.target.worker.taskQueue ?? ''}`
                      : (e.spec?.target?.external?.url ?? '')}
                  </td>
                  <td>{e.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
