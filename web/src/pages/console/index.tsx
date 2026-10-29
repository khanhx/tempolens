import { useMemo, useRef, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { ActionDialog } from '../../components/modal';
import { ReasonField, reasonOk } from '../../components/reason-field';
import { confirmed, TypedConfirm } from '../../components/typed-confirm';
import { callDenied } from '../../lib/console/gate';
import { createHistory } from '../../lib/console/history';
import type { ConfirmSpec, Json } from '../../lib/console/methods';
import { shortName } from '../../lib/console/methods';
import { errorText } from '../../lib/console/output';
import type { ParsedCommand, Plan } from '../../lib/console/parse';
import { ParseError, parseCommand } from '../../lib/console/parse';
import { describePlan, invoke, runCall } from '../../lib/console/run';
import { me } from '../../lib/me';
import { namespaceName, namespaces } from '../../lib/namespaces';
import { stringifyJson } from '../../lib/payload/json-bigint';
import { CommandInput } from './command-input';
import { RawPanel } from './raw-panel';
import type { ConsoleResult } from './result-view';
import { ResultView } from './result-view';
import './console.css';

/** A call ready to run, from either mode. */
export interface Prepared {
  label: string;
  method: string;
  request: Json;
  plan: Plan;
  confirm: ConfirmSpec | null;
  /** Present when the method needs `X-Tempolens-Reason`; the value prefills the reason field. */
  reasonHeader?: string;
  cli?: string;
  output?: 'stack';
}

const history = createHistory();

type Parsed = { ok: true; cmd: ParsedCommand } | { ok: false; error: ParseError | Error };

function ConfirmDialog({ prepared, onCancel, onConfirm }: { prepared: Prepared; onCancel: () => void; onConfirm: (reason: string | undefined) => void }) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState(prepared.reasonHeader ?? '');
  const target = prepared.confirm?.target ?? '';
  const needsReason = prepared.reasonHeader !== undefined;
  return (
    <ActionDialog
      title={`Confirm ${shortName(prepared.method)}`}
      submitLabel="Confirm and run"
      danger
      canSubmit={(!prepared.confirm || confirmed(target, typed)) && reasonOk(reason, needsReason)}
      onClose={onCancel}
      onSubmit={() => {
        onConfirm(needsReason ? reason.trim() : undefined);
        return Promise.resolve();
      }}
    >
      <p class="alert alert-warning">
        This call changes or removes data and cannot be undone: <code>{prepared.label}</code>
      </p>
      {prepared.confirm &&
        (target ? (
          <TypedConfirm expected={target} value={typed} onInput={setTyped} what={prepared.confirm.what} />
        ) : (
          <p class="alert alert-error" role="alert">
            The request names no target to confirm; add it to the request first.
          </p>
        ))}
      {needsReason && <ReasonField value={reason} onInput={setReason} required />}
    </ActionDialog>
  );
}

/** Runs Temporal commands, as `temporal` CLI lines or raw gRPC requests, through the console endpoint. */
export default function Console() {
  const { params } = useRoute();
  const ns = params.ns ?? '';
  const [mode, setMode] = useState<'cli' | 'raw'>('cli');
  const [line, setLine] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState<Prepared | null>(null);
  const [result, setResult] = useState<ConsoleResult | null>(null);
  const [runId, setRunId] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const nsNames = (namespaces.value ?? []).map(namespaceName).filter(Boolean);

  const parsed: Parsed | null = useMemo(() => {
    if (!line.trim()) return null;
    try {
      return { ok: true, cmd: parseCommand(line, { namespace: ns }) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }, [line, ns]);
  const cliDenied = parsed?.ok ? callDenied(parsed.cmd.actions.length > 0, parsed.cmd.actions, me.value) : null;
  const busy = result?.state === 'running';

  const execute = async (p: Prepared, reason: string | undefined) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const started = performance.now();
    const base: ConsoleResult = { label: p.label, method: p.method, cli: p.cli, output: p.output, state: 'running', steps: [] };
    setRunId((n) => n + 1);
    setResult(base);
    const steps: ConsoleResult['steps'] = [];
    try {
      const res = await runCall({ ...p, confirm: p.confirm?.target, reason }, invoke, ctrl.signal, (s) => {
        steps.push(s);
        setResult({ ...base, steps: [...steps] });
      });
      setResult({ ...base, state: 'ok', response: res.response, steps: res.steps, ms: Math.round(performance.now() - started) });
    } catch (err) {
      const stopped = err instanceof DOMException && err.name === 'AbortError';
      setResult({ ...base, state: 'error', error: stopped ? 'Stopped.' : errorText(err), steps: [...steps], ms: Math.round(performance.now() - started) });
    } finally {
      if (abort.current === ctrl) abort.current = null;
    }
  };

  const run = (p: Prepared) => {
    if (p.confirm || p.reasonHeader !== undefined) setPending(p);
    else void execute(p, undefined);
  };

  const submitCli = (e: Event) => {
    e.preventDefault();
    setSubmitted(true);
    if (!parsed?.ok || cliDenied) return;
    history.push(line);
    const c = parsed.cmd;
    run({ label: c.cli, method: c.method, request: c.request, plan: c.plan, confirm: c.confirm, reasonHeader: c.reasonHeader, cli: c.cli, output: c.output });
  };

  const parseError = submitted && parsed && !parsed.ok ? parsed.error : null;

  return (
    <section class="page">
      <header class="page-head">
        <h1>Console</h1>
        <span class="muted">
          Namespace <code>{ns}</code> unless a command names another
        </span>
      </header>
      <div class="tabs" role="tablist" aria-label="Console mode">
        {(
          [
            ['cli', 'CLI'],
            ['raw', 'Raw gRPC'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`console-tab-${key}`}
            class="tab console-tab"
            aria-selected={mode === key}
            aria-controls="console-panel"
            onClick={() => setMode(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div class="stack" role="tabpanel" id="console-panel" aria-labelledby={`console-tab-${mode}`}>
        {mode === 'cli' ? (
          <form class="console-form" onSubmit={submitCli}>
            <div class="console-row">
              <CommandInput
                value={line}
                onInput={(v) => {
                  setLine(v);
                  setSubmitted(false);
                }}
                history={history}
                namespaces={nsNames}
              />
              <button type="submit" class="btn btn-primary" disabled={busy || cliDenied !== null} aria-describedby={cliDenied ? 'console-cli-denied' : undefined}>
                Run
              </button>
            </div>
            {parseError && (
              <p class="alert alert-error" role="alert">
                {parseError.message}
                {parseError instanceof ParseError && parseError.token !== undefined && (
                  <>
                    {' '}
                    Offending input: <span class="console-token">{parseError.token}</span>
                  </>
                )}
              </p>
            )}
            {cliDenied && (
              <p class="alert alert-warning" id="console-cli-denied">
                {cliDenied}
              </p>
            )}
            {parsed?.ok && (
              <details class="console-preview">
                <summary class="muted">
                  {describePlan(parsed.cmd).length > 1 ? `${describePlan(parsed.cmd).length} steps` : shortName(parsed.cmd.method)}: show the request
                </summary>
                <ol>
                  {describePlan(parsed.cmd).map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <pre class="code-block">{stringifyJson(parsed.cmd.request)}</pre>
              </details>
            )}
            <p class="muted">
              A subset of the <code>temporal</code> CLI: workflow, schedule, batch, task-queue, operator namespace, operator search-attribute and cluster commands. Tab completes; ↑ and ↓ recall
              earlier commands.
            </p>
          </form>
        ) : (
          <RawPanel ns={ns} onRun={run} busy={busy} />
        )}
        {result && <ResultView key={runId} result={result} onStop={() => abort.current?.abort()} />}
      </div>
      {pending && (
        <ConfirmDialog
          prepared={pending}
          onCancel={() => setPending(null)}
          onConfirm={(reason) => {
            const p = pending;
            setPending(null);
            void execute(p, reason);
          }}
        />
      )}
    </section>
  );
}
