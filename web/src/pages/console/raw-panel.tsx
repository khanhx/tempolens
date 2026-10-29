import { useEffect, useState } from 'preact/hooks';
import { api } from '../../lib/api';
import { callDenied } from '../../lib/console/gate';
import type { Json, MethodInfo } from '../../lib/console/methods';
import { confirmFor, methodActions, methodMutates, needsReasonHeader, parseMethods, template, WF } from '../../lib/console/methods';
import { errorText } from '../../lib/console/output';
import { me } from '../../lib/me';
import type { Prepared } from './index';

const PREFERRED = `${WF}DescribeNamespace`;

function prepare(info: MethodInfo, text: string): Prepared {
  let request: unknown;
  try {
    request = JSON.parse(text);
  } catch (err) {
    throw new Error(`Request JSON is not valid: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) throw new Error('Request JSON must be an object.');
  const req = request as Json;
  return {
    label: info.name,
    method: info.method,
    request: req,
    plan: { kind: 'call' },
    confirm: confirmFor(info.method, req),
    ...(needsReasonHeader(info.method) ? { reasonHeader: '' } : {}),
  };
}

/** Raw mode: pick an allowlisted method, edit its protojson request, send it as is. */
export function RawPanel({ ns, onRun, busy }: { ns: string; onRun: (p: Prepared) => void; busy: boolean }) {
  const [methods, setMethods] = useState<MethodInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [method, setMethod] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const choose = (info: MethodInfo) => {
    setMethod(info.method);
    setText(JSON.stringify(template(info.method, ns, info.namespaceScoped), null, 2));
    setError(null);
  };

  const load = async (signal?: AbortSignal) => {
    setLoadError(null);
    try {
      const list = parseMethods(await api.get<unknown>('/api/x/console/methods', undefined, signal));
      setMethods(list);
      const first = list.find((m) => m.method === PREFERRED) ?? list[0];
      if (first) choose(first);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setLoadError(errorText(err));
    }
  };

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, []);

  const info = methods?.find((m) => m.method === method);
  const denied = info ? callDenied(methodMutates(info), methodActions(info.method, safeParse(text)), me.value, info.class === 'ADMIN') : null;

  const submit = (e: Event) => {
    e.preventDefault();
    if (!info) return;
    try {
      setError(null);
      onRun(prepare(info, text));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loadError) {
    return (
      <div class="alert alert-error" role="alert">
        The method list could not be loaded: {loadError}{' '}
        <button type="button" class="btn btn-sm" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }
  if (!methods) return <p class="muted">Loading methods…</p>;

  const groups = ['WorkflowService', 'OperatorService'] as const;
  return (
    <form class="console-form" onSubmit={submit}>
      <label class="field">
        <span>Method</span>
        <select
          class="input"
          value={method}
          onChange={(e) => {
            const next = methods.find((m) => m.method === e.currentTarget.value);
            if (next) choose(next);
          }}
        >
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {methods
                .filter((m) => m.service === g)
                .map((m) => (
                  <option key={m.method} value={m.method}>
                    {m.name}
                    {m.class && m.class !== 'READ' ? ` (${m.class.toLowerCase()})` : ''}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label class="field">
        <span>Request JSON</span>
        <textarea class="input input-mono console-editor" spellcheck={false} autocomplete="off" value={text} onInput={(e) => setText(e.currentTarget.value)} />
      </label>
      {error && (
        <p class="alert alert-error" role="alert">
          {error}
        </p>
      )}
      {denied && (
        <p class="alert alert-warning" id="console-raw-denied">
          {denied}
        </p>
      )}
      <div class="toolbar">
        <button type="submit" class="btn btn-primary" disabled={busy || !info || denied !== null} aria-describedby={denied ? 'console-raw-denied' : undefined}>
          Run
        </button>
      </div>
    </form>
  );
}

/** The request for gating, or undefined while the text is not valid JSON. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
