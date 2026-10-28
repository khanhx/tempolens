import { useState } from 'preact/hooks';
import { PayloadView } from '../../components/payload-view';
import type { Payload } from '../../lib/payload/decode';
import { parseJson } from '../../lib/payload/json-bigint';
import { jsonPayload, queryWorkflow } from '../../lib/run-store';
import type { RunContext } from '../workflow-layout';

/**
 * Runs a workflow query. Types come from `__temporal_workflow_metadata` when
 * the SDK provides it; otherwise any type can be typed in.
 */
export function QueryTab({ store, ns, wf, run }: RunContext) {
  const defs = (store.metadata.value?.definition?.queryDefinitions ?? []).filter((d) => d.name && !d.name.startsWith('__'));
  const [type, setType] = useState('');
  const [args, setArgs] = useState('');
  const [state, setState] = useState<{ loading: boolean; result?: Payload[]; error?: string }>({ loading: false });
  const chosen = type || defs[0]?.name || '';

  const submit = async (e: Event) => {
    e.preventDefault();
    let payloads: Payload[] | undefined;
    if (args.trim()) {
      try {
        payloads = [jsonPayload(parseJson(args))];
      } catch (err) {
        setState({ loading: false, error: `Arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
    }
    if (!chosen.trim()) {
      setState({ loading: false, error: 'Enter a query type.' });
      return;
    }
    setState({ loading: true });
    try {
      setState({ loading: false, result: await queryWorkflow(ns, wf, run, chosen.trim(), payloads) });
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const description = defs.find((d) => d.name === chosen)?.description;
  return (
    <form class="stack" onSubmit={submit}>
      <label>
        Query type{' '}
        {defs.length > 0 ? (
          <select class="select" value={chosen} onChange={(e) => setType((e.currentTarget as HTMLSelectElement).value)}>
            {defs.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        ) : (
          <input class="input" value={type} placeholder="e.g. state" onInput={(e) => setType((e.currentTarget as HTMLInputElement).value)} />
        )}
      </label>
      {description && <p class="muted">{description}</p>}
      <label>
        Arguments <span class="muted">(one JSON value, optional)</span>
        <textarea class="input input-mono" rows={4} value={args} spellcheck={false} onInput={(e) => setArgs((e.currentTarget as HTMLTextAreaElement).value)} />
      </label>
      <div>
        <button type="submit" class="btn btn-primary" disabled={state.loading}>
          {state.loading ? 'Querying…' : 'Run query'}
        </button>
      </div>
      {state.error && (
        <p class="alert alert-error" role="alert">
          {state.error}
        </p>
      )}
      {state.result && <PayloadView value={{ payloads: state.result }} ns={ns} />}
    </form>
  );
}
