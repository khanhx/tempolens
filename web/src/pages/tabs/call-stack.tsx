import { useCallback, useEffect, useState } from 'preact/hooks';
import { CopyButton } from '../../components/copy-button';
import { decodeWithCodec } from '../../lib/payload/codec';
import { stringifyJson } from '../../lib/payload/json-bigint';
import { queryWorkflow } from '../../lib/run-store';
import type { RunContext } from '../workflow-layout';

/** The `__stack_trace` query: where each coroutine of the workflow is blocked. */
export function CallStackTab({ store, ns, wf, run }: RunContext) {
  const [state, setState] = useState<{ loading: boolean; text?: string; error?: string }>({ loading: false });
  const running = store.running;

  const load = useCallback(async () => {
    setState({ loading: true });
    try {
      const payloads = await queryWorkflow(ns, wf, run, '__stack_trace');
      const decoded = await decodeWithCodec(payloads, ns, undefined, { force: true });
      const first = Array.isArray(decoded) ? decoded[0] : decoded;
      setState({ loading: false, text: typeof first === 'string' ? first : stringifyJson(first) });
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  }, [ns, wf, run]);

  useEffect(() => {
    if (running) void load();
  }, [running, load]);

  if (!store.describe.value) return <p class="muted">Loading…</p>;
  return (
    <div>
      <div class="toolbar">
        <button type="button" class="btn" disabled={state.loading} onClick={() => void load()}>
          {state.loading ? 'Querying…' : 'Refresh call stack'}
        </button>
        {state.text && <CopyButton text={state.text} />}
      </div>
      {!running && !state.text && !state.error && (
        <p class="muted">The workflow is not running. A call stack needs a worker to replay it; you can still try the query.</p>
      )}
      {state.error && (
        <p class="alert alert-error" role="alert">
          {state.error}
        </p>
      )}
      {state.text !== undefined && <pre class="code-block">{state.text || '(empty)'}</pre>}
    </div>
  );
}
