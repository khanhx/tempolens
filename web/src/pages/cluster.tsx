import { useCallback, useEffect, useState } from 'preact/hooks';
import { CopyButton } from '../components/copy-button';
import { JsonView } from '../components/json-view';
import { api } from '../lib/api';
import { cliCommand } from '../lib/actions/cli-command';
import { me } from '../lib/me';
import type { ClusterInfo, SystemInfo } from '../lib/server-info';

interface Readiness {
  status?: string;
  temporal?: string;
  oidc?: string;
}

interface FullClusterInfo extends ClusterInfo {
  clusterId?: string;
  historyShardCount?: number;
  supportedClients?: Record<string, string>;
  [key: string]: unknown;
}

/** Cluster info, system capabilities and Tempolens health, refreshed on demand. */
export default function Cluster() {
  const [cluster, setCluster] = useState<FullClusterInfo | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [ready, setReady] = useState<{ http: number; body: Readiness } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [c, s] = await Promise.all([api.get<FullClusterInfo>('/api/v1/cluster-info'), api.get<SystemInfo>('/api/v1/system-info')]);
      setCluster(c);
      setSystem(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    // /readyz answers 503 with the same JSON shape when not ready, so read it directly.
    try {
      const res = await fetch('/readyz', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      setReady({ http: res.status, body: (await res.json()) as Readiness });
    } catch {
      setReady({ http: 0, body: { status: 'unreachable' } });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const caps = Object.entries(system?.capabilities ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const ok = (v: string | undefined) => v === 'ok' || v === 'disabled';

  return (
    <section class="page">
      <header class="page-head">
        <h1>Cluster</h1>
        <div class="toolbar-group">
          <CopyButton text={cliCommand(['operator', 'cluster', 'describe'], [['detail', true]])} label="Copy as temporal CLI" />
          <button type="button" class="btn" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </header>
      {error && (
        <p class="alert alert-error" role="alert">
          {error}
        </p>
      )}
      <div class="stack">
        <section class="card card-pad">
          <h2>Health</h2>
          {ready ? (
            <dl class="kv-grid">
              <div class="kv-item">
                <dt>Tempolens readiness</dt>
                <dd>
                  <span class={`status ${ready.http === 200 ? 'status-completed' : 'status-failed'}`}>{ready.body.status ?? ready.http}</span>
                </dd>
              </div>
              <div class="kv-item">
                <dt>Temporal frontend</dt>
                <dd class={ok(ready.body.temporal) ? '' : 'field-error'}>{ready.body.temporal ?? '–'}</dd>
              </div>
              <div class="kv-item">
                <dt>OIDC discovery</dt>
                <dd class={ok(ready.body.oidc) || ready.body.oidc === undefined ? '' : 'field-error'}>{ready.body.oidc ?? '–'}</dd>
              </div>
              <div class="kv-item">
                <dt>Tempolens version</dt>
                <dd>{me.value?.settings.version ?? '–'}</dd>
              </div>
            </dl>
          ) : (
            <p class="muted">Checking…</p>
          )}
        </section>
        {cluster && (
          <section class="card card-pad">
            <h2>Cluster</h2>
            <dl class="kv-grid">
              <div class="kv-item">
                <dt>Server version</dt>
                <dd>{cluster.serverVersion ?? '–'}</dd>
              </div>
              <div class="kv-item">
                <dt>Cluster name</dt>
                <dd>{cluster.clusterName ?? '–'}</dd>
              </div>
              <div class="kv-item">
                <dt>Cluster ID</dt>
                <dd>
                  <code>{cluster.clusterId ?? '–'}</code>
                </dd>
              </div>
              <div class="kv-item">
                <dt>History shards</dt>
                <dd>{cluster.historyShardCount ?? '–'}</dd>
              </div>
              <div class="kv-item">
                <dt>Persistence store</dt>
                <dd>{cluster.persistenceStore ?? '–'}</dd>
              </div>
              <div class="kv-item">
                <dt>Visibility store</dt>
                <dd>{cluster.visibilityStore ?? '–'}</dd>
              </div>
            </dl>
            {cluster.supportedClients && (
              <>
                <h3>Supported clients</h3>
                <table class="table">
                  <tbody>
                    {Object.entries(cluster.supportedClients).map(([k, v]) => (
                      <tr key={k}>
                        <th scope="row">{k}</th>
                        <td>
                          <code>{v}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        )}
        {system && (
          <section class="card card-pad">
            <h2>Capabilities</h2>
            {caps.length === 0 ? (
              <p class="muted">The server reported no capabilities.</p>
            ) : (
              <ul class="chips">
                {caps.map(([k, v]) => (
                  <li key={k} class="chip" title={v ? 'supported' : 'not supported'}>
                    {v ? '✓' : '✗'} {k}
                  </li>
                ))}
              </ul>
            )}
            <h3>Raw</h3>
            <JsonView value={{ clusterInfo: cluster, systemInfo: system }} openDepth={1} />
          </section>
        )}
      </div>
    </section>
  );
}
