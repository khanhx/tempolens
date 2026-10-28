import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import { CopyButton } from '../components/copy-button';
import type { InputValue } from '../components/input-editor';
import { EMPTY_INPUT, InputEditor } from '../components/input-editor';
import { showToast } from '../components/toast';
import { api, seg } from '../lib/api';
import { encodeForWrite, encodeValue, parseInput, textPayload } from '../lib/actions/encode';
import { sendAction, signalWithStartRequest, startRequest } from '../lib/actions/workflow-actions';
import type { StartForm } from '../lib/actions/workflow-actions';
import { canAll, deniedReason } from '../lib/me';
import type { Payload } from '../lib/payload/decode';
import { decodePayload } from '../lib/payload/decode';
import { parseJson, stringifyJson } from '../lib/payload/json-bigint';
import type { SAType } from '../lib/query/build';
import type { NamespaceSearchAttributes } from '../lib/server-info';
import { searchAttributes } from '../lib/server-info';
import { workflowPath } from '../lib/run-store';
import type { DescribeWorkflowResponse, HistoryEvent, Poller } from '../lib/temporal';
import { CLOSE_EVENT_TYPES, eventAttributes } from '../lib/temporal';
import { apiLongPollFetcher, runLivePoll } from '../lib/history/live-poll';
import { parseHumanDuration, toProtoDuration } from '../lib/time';
import { href, P } from '../routes';
import { CloseOutcome } from './tabs/result';

type StartMode = 'start' | 'execute' | 'signal-with-start';

interface Executed {
  wf: string;
  run: string;
  /** The close event, once the run has ended. */
  close?: HistoryEvent;
}

interface AttributeRow {
  name: string;
  value: string;
}

const payloadText = (p: Payload | undefined): string => {
  if (!p) return '';
  const d = decodePayload(p, true);
  if (d.kind !== 'value') return stringifyJson(p);
  return typeof d.value === 'string' ? d.value : stringifyJson(d.value);
};

/** Converts a typed attribute value to the JSON value Temporal expects for its type. */
export function attributeValue(type: SAType, raw: string): unknown {
  const v = raw.trim();
  switch (type) {
    case 'Int':
      if (!/^-?\d+$/.test(v)) throw new Error(`"${raw}" is not an integer`);
      return parseJson(v);
    case 'Double':
      if (Number.isNaN(Number(v)) || v === '') throw new Error(`"${raw}" is not a number`);
      return Number(v);
    case 'Bool':
      if (v !== 'true' && v !== 'false') throw new Error(`"${raw}" is not true or false`);
      return v === 'true';
    case 'Datetime':
      if (Number.isNaN(Date.parse(v))) throw new Error(`"${raw}" is not a date`);
      return new Date(v).toISOString();
    case 'KeywordList': {
      const list = v.startsWith('[') ? parseJson(v) : v.split(',').map((s) => s.trim()).filter(Boolean);
      if (!Array.isArray(list)) throw new Error('A keyword list must be a JSON array or a comma list.');
      return list;
    }
    default:
      return raw;
  }
}

function PollerCheck({ ns, taskQueue }: { ns: string; taskQueue: string }) {
  const [state, setState] = useState<{ count?: number; error?: string } | null>(null);
  useEffect(() => {
    if (!taskQueue.trim()) return setState(null);
    let cancelled = false;
    const t = window.setTimeout(() => {
      api
        .get<{ pollers?: Poller[] }>(`/api/v1/namespaces/${seg(ns)}/task-queues/${seg(taskQueue.trim())}`, { taskQueueType: 1 })
        .then(
          (r) => !cancelled && setState({ count: r.pollers?.length ?? 0 }),
          (err: unknown) => !cancelled && setState({ error: err instanceof Error ? err.message : String(err) }),
        );
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [ns, taskQueue]);
  if (!state) return null;
  if (state.error) return <span class="field-error">{state.error}</span>;
  return state.count ? (
    <span class="muted">
      {state.count} workflow worker{state.count === 1 ? '' : 's'} polling
    </span>
  ) : (
    <span class="field-error">No workers are polling this task queue; the workflow will wait until one starts.</span>
  );
}

export default function StartWorkflow() {
  const { params } = useRoute();
  const ns = params.ns ?? '';
  const { url, route } = useLocation();
  const q = new URLSearchParams(url.split('?')[1] ?? '');
  const [workflowId, setWorkflowId] = useState(q.get('workflowId') ?? '');
  const [workflowType, setWorkflowType] = useState(q.get('workflowType') ?? '');
  const [taskQueue, setTaskQueue] = useState(q.get('taskQueue') ?? '');
  const [input, setInput] = useState<InputValue>(EMPTY_INPUT);
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [delay, setDelay] = useState('');
  const [attrs, setAttrs] = useState<AttributeRow[]>([]);
  const [sa, setSa] = useState<NamespaceSearchAttributes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefill, setPrefill] = useState<string | null>(null);
  const [mode, setMode] = useState<StartMode>('start');
  const [signalName, setSignalName] = useState('');
  const [signalInput, setSignalInput] = useState<InputValue>(EMPTY_INPUT);
  const [executed, setExecuted] = useState<Executed | null>(null);
  const waiting = useRef<AbortController | null>(null);
  useEffect(() => () => waiting.current?.abort(), []);

  useEffect(() => {
    searchAttributes(ns).then(setSa, () => undefined);
  }, [ns]);

  // "Start like this one": copy input, metadata and custom attributes from an existing run.
  useEffect(() => {
    const wf = q.get('workflowId');
    const run = q.get('runId');
    if (!wf || !run) return;
    let cancelled = false;
    setPrefill('Copying from the original run…');
    Promise.all([
      api.get<DescribeWorkflowResponse>(workflowPath(ns, wf), { 'execution.runId': run }),
      api.get<{ history?: { events?: HistoryEvent[] } }>(`${workflowPath(ns, wf)}/history`, { 'execution.runId': run, maximumPageSize: 1 }),
      searchAttributes(ns),
    ]).then(
      ([d, h, attributes]) => {
        if (cancelled) return;
        const first = h.history?.events?.[0];
        const payloads = (first ? eventAttributes(first).input : undefined) as { payloads?: Payload[] } | undefined;
        const p0 = payloads?.payloads?.[0];
        if (p0) setInput({ ...EMPTY_INPUT, text: payloadText(p0) });
        setSummary(payloadText(d.executionConfig?.userMetadata?.summary));
        setDetails(payloadText(d.executionConfig?.userMetadata?.details));
        const fields = d.workflowExecutionInfo?.searchAttributes?.indexedFields ?? {};
        setAttrs(attributes.custom.filter((n) => fields[n]).map((n) => ({ name: n, value: payloadText(fields[n]) })));
        setWorkflowType(d.workflowExecutionInfo?.type?.name ?? '');
        setTaskQueue(d.executionConfig?.taskQueue?.name ?? '');
        setWorkflowId(`${wf}-copy`);
        setPrefill(null);
      },
      (err: unknown) => !cancelled && setPrefill(`Could not copy the original run: ${err instanceof Error ? err.message : String(err)}`),
    );
    return () => {
      cancelled = true;
    };
  }, [ns]);

  if (!canAll(['start'])) {
    return (
      <section class="page">
        <h1>Start a workflow</h1>
        <p class="alert">{deniedReason(['start'])}</p>
      </section>
    );
  }

  const canSignalWithStart = canAll(['start', 'signal']);

  const form = (payloads?: Payload[]): StartForm => {
    const delayMs = delay.trim() ? parseHumanDuration(delay) : null;
    if (delay.trim() && (delayMs === null || delayMs <= 0)) throw new Error('Start delay must be a duration such as 30s or 5m.');
    const searchAttrs: Record<string, Payload> = {};
    for (const a of attrs) {
      if (!a.name) continue;
      searchAttrs[a.name] = encodeValue(attributeValue(sa?.types[a.name] ?? 'Keyword', a.value));
    }
    return {
      ns,
      workflowId: workflowId.trim(),
      workflowType: workflowType.trim(),
      taskQueue: taskQueue.trim(),
      input: payloads,
      inputText: input.text,
      summary: summary.trim() ? textPayload(summary.trim()) : undefined,
      details: details.trim() ? textPayload(details.trim()) : undefined,
      searchAttributes: searchAttrs,
      startDelay: delayMs ? toProtoDuration(delayMs) : undefined,
    };
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!workflowId.trim() || !workflowType.trim() || !taskQueue.trim()) throw new Error('Workflow ID, type and task queue are required.');
      const payloads = await encodeForWrite(parseInput(input.text, input.encoding, input.messageType), ns);
      const wf = workflowId.trim();
      if (mode === 'signal-with-start') {
        const signalPayloads = await encodeForWrite(parseInput(signalInput.text, signalInput.encoding, signalInput.messageType), ns);
        const res = await sendAction<{ runId?: string }>(signalWithStartRequest({ ...form(payloads), signalName, signalInput: signalPayloads, signalInputText: signalInput.text }));
        showToast({ kind: 'success', text: `Signalled ${wf}${res.runId ? '' : ' (already running)'}.` });
        route(res.runId ? href(P.run, { ns, wf, run: res.runId }) : href(P.workflowLatest, { ns, wf }));
        return;
      }
      const res = await sendAction<{ runId?: string }>(startRequest(form(payloads)));
      if (mode === 'execute' && res.runId) {
        void waitForResult(wf, res.runId);
        setBusy(false);
        return;
      }
      showToast({ kind: 'success', text: `Started ${wf}.` });
      route(res.runId ? href(P.run, { ns, wf, run: res.runId }) : href(P.workflowLatest, { ns, wf }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  // Execute mode: long-poll for the close event only, as `temporal workflow execute` does.
  const waitForResult = async (wf: string, run: string) => {
    waiting.current?.abort();
    const controller = new AbortController();
    waiting.current = controller;
    setExecuted({ wf, run });
    let close: HistoryEvent | undefined;
    await runLivePoll({
      fetchPage: apiLongPollFetcher(ns, wf, run, true),
      onEvents: (events) => {
        close = events.find((e) => CLOSE_EVENT_TYPES.has(e.eventType)) ?? close;
        return events.length;
      },
      signal: controller.signal,
    });
    if (close && !controller.signal.aborted) setExecuted({ wf, run, close });
  };

  const cli = () => {
    try {
      const payloads = parseInput(input.text, input.encoding, input.messageType);
      if (mode === 'signal-with-start') {
        return signalWithStartRequest({ ...form(payloads), signalName, signalInput: parseInput(signalInput.text, signalInput.encoding, signalInput.messageType), signalInputText: signalInput.text }).cli;
      }
      return startRequest(form(payloads), mode === 'execute').cli;
    } catch (err) {
      return `# ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  return (
    <section class="page">
      <h1>
        Start a workflow <span class="muted">{ns}</span>
      </h1>
      {prefill && <p class="alert">{prefill}</p>}
      <form class="form-grid" onSubmit={submit}>
        {executed && (
          <section class="card card-pad stack form-wide" aria-live="polite">
            <h2>
              <a href={href(P.run, { ns, wf: executed.wf, run: executed.run })}>{executed.wf}</a>
            </h2>
            {executed.close ? (
              <CloseOutcome event={executed.close} ns={ns} wf={executed.wf} />
            ) : (
              <p class="muted">
                Started; waiting for the result…{' '}
                <button
                  type="button"
                  class="btn btn-sm"
                  onClick={() => {
                    waiting.current?.abort();
                    setExecuted(null);
                  }}
                >
                  Stop waiting
                </button>
              </p>
            )}
          </section>
        )}
        <fieldset class="field form-wide">
          <legend>Mode</legend>
          <label class="check">
            <input type="radio" name="start-mode" checked={mode === 'start'} onChange={() => setMode('start')} /> Start <span class="muted">and open the run</span>
          </label>
          <label class="check">
            <input type="radio" name="start-mode" checked={mode === 'execute'} onChange={() => setMode('execute')} /> Execute <span class="muted">start and wait here for the result</span>
          </label>
          {canSignalWithStart && (
            <label class="check">
              <input type="radio" name="start-mode" checked={mode === 'signal-with-start'} onChange={() => setMode('signal-with-start')} /> Signal with start{' '}
              <span class="muted">signal the workflow, starting it first if it is not running</span>
            </label>
          )}
        </fieldset>
        <label class="field">
          <span>Workflow ID</span>
          <span class="toolbar-group">
            <input class="input grow" required value={workflowId} onInput={(e) => setWorkflowId((e.currentTarget as HTMLInputElement).value)} />
            <button type="button" class="btn" onClick={() => setWorkflowId(crypto.randomUUID())}>
              Random
            </button>
          </span>
        </label>
        <label class="field">
          <span>Workflow type</span>
          <input class="input" required value={workflowType} onInput={(e) => setWorkflowType((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>Task queue</span>
          <input class="input" required value={taskQueue} onInput={(e) => setTaskQueue((e.currentTarget as HTMLInputElement).value)} />
          <PollerCheck ns={ns} taskQueue={taskQueue} />
        </label>
        <label class="field">
          <span>
            Start delay <span class="muted">(optional, e.g. 30s or 5m)</span>
          </span>
          <input class="input" value={delay} onInput={(e) => setDelay((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <div class="form-wide">
          <InputEditor value={input} onChange={setInput} />
        </div>
        {mode === 'signal-with-start' && (
          <>
            <label class="field">
              <span>Signal name</span>
              <input class="input" required value={signalName} onInput={(e) => setSignalName((e.currentTarget as HTMLInputElement).value)} />
            </label>
            <div class="form-wide">
              <InputEditor value={signalInput} onChange={setSignalInput} label="Signal input" />
            </div>
          </>
        )}
        <label class="field">
          <span>
            Summary <span class="muted">(optional)</span>
          </span>
          <input class="input" value={summary} onInput={(e) => setSummary((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>
            Details <span class="muted">(optional)</span>
          </span>
          <textarea class="input" rows={2} value={details} onInput={(e) => setDetails((e.currentTarget as HTMLTextAreaElement).value)} />
        </label>
        <fieldset class="field form-wide">
          <legend>Search attributes</legend>
          {attrs.map((a, i) => (
            <div key={i} class="toolbar-group">
              <select
                class="select"
                aria-label="Attribute"
                value={a.name}
                onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, name: (e.currentTarget as HTMLSelectElement).value } : x)))}
              >
                <option value="">Choose…</option>
                {(sa?.custom ?? []).map((n) => (
                  <option key={n} value={n}>
                    {n} ({sa?.types[n]})
                  </option>
                ))}
              </select>
              <input class="input" aria-label="Value" value={a.value} onInput={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, value: (e.currentTarget as HTMLInputElement).value } : x)))} />
              <button type="button" class="btn btn-ghost" aria-label="Remove attribute" onClick={() => setAttrs(attrs.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <div>
            <button type="button" class="btn btn-sm" disabled={!sa?.custom.length} onClick={() => setAttrs([...attrs, { name: '', value: '' }])}>
              Add search attribute
            </button>
            {sa && !sa.custom.length && <span class="muted"> This namespace has no custom search attributes.</span>}
          </div>
        </fieldset>
        {error && (
          <p class="alert alert-error form-wide" role="alert">
            {error}
          </p>
        )}
        <div class="dialog-footer form-wide">
          <CopyButton text={cli} label="Copy as temporal CLI" />
          <span class="toolbar-spacer" />
          <a class="btn" href={href(P.workflows, { ns })}>
            Cancel
          </a>
          <button type="submit" class="btn btn-primary" disabled={busy}>
            {busy ? 'Starting…' : mode === 'execute' ? 'Execute workflow' : mode === 'signal-with-start' ? 'Signal with start' : 'Start workflow'}
          </button>
        </div>
      </form>
    </section>
  );
}
