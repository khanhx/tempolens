import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { StaticHistory } from '../components/static-history';
import { parseJson } from '../lib/payload/json-bigint';
import { me } from '../lib/me';
import { lastNamespace } from '../lib/prefs';
import type { HistoryEvent } from '../lib/temporal';

/** The imported history lives in memory only; it is gone on reload. */
const imported = signal<{ name: string; events: HistoryEvent[] } | null>(null);

const MAX_FILE_BYTES = 200 * 1024 * 1024;

/** Accepts `[event…]`, `{events:[…]}` or `{history:{events:[…]}}` (a GetWorkflowExecutionHistory response). */
export function parseHistoryFile(text: string): HistoryEvent[] {
  const raw = parseJson(text);
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? ((raw as { events?: unknown }).events ?? (raw as { history?: { events?: unknown } }).history?.events)
      : undefined;
  if (!Array.isArray(list)) throw new Error('Expected a JSON array of events, or an object with "events".');
  const events = list.filter((e): e is HistoryEvent => !!e && typeof e === 'object' && (typeof e.eventId === 'string' || typeof e.eventId === 'number') && typeof e.eventType === 'string');
  if (events.length === 0) throw new Error('The file contains no history events.');
  if (events.length !== list.length) throw new Error(`${list.length - events.length} entries are not history events (each needs eventId and eventType).`);
  return events.map((e) => ({ ...e, eventId: String(e.eventId) })).sort((a, b) => Number(a.eventId) - Number(b.eventId));
}

export default function ImportHistory() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onFile = async (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    setError(null);
    if (file.size > MAX_FILE_BYTES) {
      setError('The file is larger than 200 MB.');
      return;
    }
    setBusy(true);
    try {
      imported.value = { name: file.name, events: parseHistoryFile(await file.text()) };
    } catch (err) {
      setError(`Could not import ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const data = imported.value;
  return (
    <section class="page">
      <h1>Import event history</h1>
      <p class="muted">
        Open a history JSON file, for example a Tempolens or upstream download. It is read in the browser and never uploaded. Payloads are decoded with the configured codec, if any,
        using your last namespace.
      </p>
      <label class="field">
        <span>History file</span>
        <input type="file" accept="application/json,.json" disabled={busy} onChange={(e) => void onFile(e)} />
      </label>
      {error && (
        <p class="alert alert-error" role="alert">
          {error}
        </p>
      )}
      {data && (
        <>
          <h2>
            {data.name} <span class="muted">({data.events.length.toLocaleString('en-US')} events)</span>{' '}
            <button type="button" class="btn btn-sm" onClick={() => (imported.value = null)}>
              Clear
            </button>
          </h2>
          <StaticHistory events={data.events} ns={lastNamespace.value ?? me.value?.settings.defaultNamespace ?? 'default'} />
        </>
      )}
    </section>
  );
}
