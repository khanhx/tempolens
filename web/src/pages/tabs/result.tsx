import { useEffect } from 'preact/hooks';
import { CopyButton } from '../../components/copy-button';
import { PayloadView } from '../../components/payload-view';
import { StatusBadge } from '../../components/status-chips';
import { Timestamp } from '../../components/timestamp';
import { cliCommand } from '../../lib/actions/cli-command';
import type { Failure, HistoryEvent } from '../../lib/temporal';
import { CLOSE_EVENT_TYPES, eventAttributes, isRunning, shortEventType } from '../../lib/temporal';
import { href, P } from '../../routes';
import type { RunContext } from '../workflow-layout';

/** The failure chain, outermost first, with each level's type, source and stack trace. */
function FailureChain({ failure }: { failure: Failure }) {
  const chain: Failure[] = [];
  for (let f: Failure | undefined = failure, i = 0; f && i < 20; f = f.cause, i++) chain.push(f);
  return (
    <ol class="stack failure-chain">
      {chain.map((f, i) => {
        const info = Object.entries(f).find(([k]) => k.endsWith('FailureInfo'));
        const kind = info ? info[0].replace(/FailureInfo$/, '') : 'failure';
        const type = info && typeof (info[1] as { type?: unknown }).type === 'string' ? (info[1] as { type: string }).type : '';
        return (
          <li key={i}>
            <strong>{f.message || '(no message)'}</strong>{' '}
            <span class="muted">
              {kind}
              {type ? ` · ${type}` : ''}
              {f.source ? ` · ${f.source}` : ''}
            </span>
            {f.stackTrace && <pre class="code-block">{f.stackTrace}</pre>}
          </li>
        );
      })}
    </ol>
  );
}

/** The outcome of a closed run, as `temporal workflow result` reports it. */
export function ResultTab({ store, ns, wf, run }: RunContext) {
  useEffect(() => {
    // The close event is the last one; the reversed first page always has it.
    void store.history.init();
  }, [store]);
  const events = store.history.events.value;
  const last = events[events.length - 1];
  const info = store.describe.value?.workflowExecutionInfo;
  const cli = cliCommand(['workflow', 'result'], [
    ['namespace', ns],
    ['workflow-id', wf],
    ['run-id', run],
  ]);

  if (isRunning(info?.status) || !last || !CLOSE_EVENT_TYPES.has(last.eventType)) {
    return (
      <div class="stack">
        <p class="muted">{isRunning(info?.status) ? 'The workflow is still running; its result appears here when it closes.' : 'Loading…'}</p>
        <div>
          <CopyButton text={cli} label="Copy as temporal CLI" />
        </div>
      </div>
    );
  }
  return (
    <div class="stack">
      <div class="toolbar">
        <StatusBadge status={info?.status} />
        <span>
          closed <Timestamp value={last.eventTime} /> (event {last.eventId}, {shortEventType(last.eventType)})
        </span>
        <CopyButton text={cli} label="Copy as temporal CLI" />
      </div>
      <CloseOutcome event={last} ns={ns} wf={wf} />
    </div>
  );
}

/** What a close event says: the result, failure chain, termination reason or next run. */
export function CloseOutcome({ event, ns, wf }: { event: HistoryEvent; ns: string; wf: string }) {
  const a = eventAttributes(event);
  const type = shortEventType(event.eventType);
  const newRun = typeof a.newExecutionRunId === 'string' ? a.newExecutionRunId : undefined;
  return (
    <>
      {type === 'WorkflowExecutionCompleted' && (
        <section class="card card-pad">
          <h2>Result</h2>
          <PayloadView value={a.result ?? null} ns={ns} />
        </section>
      )}
      {(type === 'WorkflowExecutionFailed' || type === 'WorkflowExecutionTimedOut') && (
        <section class="card card-pad">
          <h2>{type === 'WorkflowExecutionFailed' ? 'Failure' : 'Timed out'}</h2>
          {a.failure ? <FailureChain failure={a.failure as Failure} /> : null}
          {typeof a.retryState === 'string' && <p class="muted">Retry state: {a.retryState.replace('RETRY_STATE_', '').toLowerCase().replace(/_/g, ' ')}</p>}
        </section>
      )}
      {type === 'WorkflowExecutionTerminated' && (
        <section class="card card-pad">
          <h2>Terminated</h2>
          <p>
            Reason: <strong>{typeof a.reason === 'string' && a.reason ? a.reason : '(none)'}</strong> {typeof a.identity === 'string' && <span class="muted">by {a.identity}</span>}
          </p>
          {a.details ? <PayloadView value={a.details} ns={ns} /> : null}
        </section>
      )}
      {type === 'WorkflowExecutionCanceled' && (
        <section class="card card-pad">
          <h2>Canceled</h2>
          <PayloadView value={a.details ?? null} ns={ns} />
        </section>
      )}
      {type === 'WorkflowExecutionContinuedAsNew' && (
        <section class="card card-pad">
          <h2>Continued as new</h2>
          {newRun && (
            <p>
              Next run: <a href={href(P.run, { ns, wf, run: newRun })}>{newRun}</a>
            </p>
          )}
          {a.failure ? <FailureChain failure={a.failure as Failure} /> : null}
          <h3>Input of the next run</h3>
          <PayloadView value={a.input ?? null} ns={ns} />
        </section>
      )}
    </>
  );
}
