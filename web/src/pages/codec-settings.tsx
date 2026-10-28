import { useState } from 'preact/hooks';
import { showToast } from '../components/toast';
import { me } from '../lib/me';
import { activeCodec, codecOverride, saveCodecOverride } from '../lib/payload/codec';

/**
 * Codec server settings: the server's configuration (read-only) and a
 * browser override stored under upstream's localStorage keys. The local
 * endpoint applies only when the override is on and the endpoint is set.
 */
export default function CodecSettings() {
  const server = me.value?.settings.codec;
  const [draft, setDraft] = useState(codecOverride.value);
  const [error, setError] = useState<string | null>(null);
  const active = activeCodec();

  const save = (e: Event) => {
    e.preventDefault();
    const endpoint = draft.endpoint.trim();
    if (endpoint) {
      try {
        const u = new URL(endpoint);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('The endpoint must be an http(s) URL.');
      } catch (err) {
        setError(err instanceof Error && err.message.startsWith('The endpoint') ? err.message : 'The endpoint is not a valid URL.');
        return;
      }
    }
    try {
      saveCodecOverride(draft);
      setError(null);
      showToast({ kind: 'success', text: 'Codec settings saved in this browser.' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section class="page">
      <h1>Codec server</h1>
      <p class="muted">A codec server decodes payloads for display and encodes input on writes. The browser calls it directly; Tempolens never sees decoded data.</p>
      <section class="card card-pad stack">
        <h2>In effect</h2>
        <p>{active ? <code>{active.endpoint}</code> : 'No codec: payloads are base64/JSON-decoded only.'}</p>
      </section>
      <section class="card card-pad stack">
        <h2>Server configuration</h2>
        <dl class="kv-grid">
          <div class="kv-item">
            <dt>Endpoint</dt>
            <dd>{server?.endpoint ? <code>{server.endpoint}</code> : 'None'}</dd>
          </div>
          <div class="kv-item">
            <dt>Include credentials</dt>
            <dd>{server?.includeCredentials ? 'Yes' : 'No'}</dd>
          </div>
          <div class="kv-item">
            <dt>Error message</dt>
            <dd>{server?.defaultErrorMessage || '–'}</dd>
          </div>
          <div class="kv-item">
            <dt>Error link</dt>
            <dd>{server?.defaultErrorLink || '–'}</dd>
          </div>
        </dl>
      </section>
      <form class="card card-pad stack" onSubmit={save}>
        <h2>Browser override</h2>
        <label class="field">
          <span>Endpoint</span>
          <input class="input" type="url" placeholder="http://localhost:8888" value={draft.endpoint} onInput={(e) => setDraft({ ...draft, endpoint: (e.currentTarget as HTMLInputElement).value })} />
        </label>
        <label class="check">
          <input type="checkbox" checked={draft.includeCredentials} onChange={() => setDraft({ ...draft, includeCredentials: !draft.includeCredentials })} /> Include cookies
          (credentials: include)
        </label>
        <label class="check">
          <input type="checkbox" checked={draft.override} onChange={() => setDraft({ ...draft, override: !draft.override })} /> Use this endpoint instead of the server's
        </label>
        {error && (
          <p class="field-error" role="alert">
            {error}
          </p>
        )}
        <div>
          <button type="submit" class="btn btn-primary">
            Save
          </button>
        </div>
      </form>
    </section>
  );
}
