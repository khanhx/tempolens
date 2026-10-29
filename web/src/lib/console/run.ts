// Runs a console call, including the client-side step plans, through
// POST /api/x/console/invoke. Every step is a separate invoke, so each one
// passes the server's authorization on its own.
import { ApiError, request } from '../api';
import type { Call, Json } from './methods';
import type { Plan } from './parse';

export const INVOKE_PATH = '/api/x/console/invoke';

export interface InvokeOptions {
  confirm?: string;
  reason?: string;
  signal?: AbortSignal;
}

export type Invoke = (call: Call, opts: InvokeOptions) => Promise<unknown>;

/** The real transport: `{method, request}` in, the protojson response out. */
export const invoke: Invoke = (call, opts) =>
  request<unknown>(INVOKE_PATH, { method: 'POST', body: { method: call.method, request: call.request }, confirm: opts.confirm, reason: opts.reason, signal: opts.signal });

export interface StepResult extends Call {
  response: unknown;
}

export interface RunResult {
  /** The response to show: the main call's, or the close event for `execute`. */
  response: unknown;
  steps: StepResult[];
}

export interface Runnable extends Call {
  plan: Plan;
  confirm?: string;
  reason?: string;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Pages through a history lookup before giving up on finding a workflow task. */
const MAX_LOOKUP_PAGES = 20;
const WFT_COMPLETED = 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

function events(response: unknown): Json[] {
  const list = isObj(response) && isObj(response.history) ? response.history.events : undefined;
  return Array.isArray(list) ? list.filter(isObj) : [];
}

const pageToken = (response: unknown): string | undefined =>
  isObj(response) && typeof response.nextPageToken === 'string' && response.nextPageToken ? response.nextPageToken : undefined;

/**
 * Runs `r`. The confirmation and reason go with the main call only. `execute`
 * long-polls for the close event until it arrives or `signal` aborts;
 * `reset-to-task` finds the first or last completed workflow task first.
 * `onStep` reports each finished step, for progress.
 */
export async function runCall(r: Runnable, call: Invoke, signal?: AbortSignal, onStep?: (s: StepResult) => void): Promise<RunResult> {
  const steps: StepResult[] = [];
  const step = async (c: Call, opts: InvokeOptions = {}): Promise<unknown> => {
    const response = await call(c, { ...opts, signal });
    const s = { ...c, response };
    steps.push(s);
    onStep?.(s);
    return response;
  };
  const main = (req: Json) => step({ method: r.method, request: req }, { confirm: r.confirm, reason: r.reason });

  if (r.plan.kind === 'call') return { response: await main(r.request), steps };

  if (r.plan.kind === 'execute') {
    const started = await main(r.request);
    const runId = isObj(started) && typeof started.runId === 'string' ? started.runId : '';
    if (!runId) throw new Error('The start response has no run ID, so the result cannot be awaited.');
    const base = r.plan.wait.request;
    let token: string | undefined;
    for (;;) {
      const req: Json = { ...base, execution: { ...(isObj(base.execution) ? base.execution : {}), runId }, ...(token ? { nextPageToken: token } : {}) };
      let res: unknown;
      try {
        res = await step({ method: r.plan.wait.method, request: req });
      } catch (err) {
        // The server bounds each call; a 504 means the workflow is still running.
        if (err instanceof ApiError && err.status === 504) continue;
        throw err;
      }
      const close = events(res).at(-1);
      if (close) return { response: close, steps };
      token = pageToken(res);
      // A wait that returns nothing and no token would spin; back off instead.
      if (!token) await sleep(1000, signal);
    }
  }

  const { lookup, which } = r.plan;
  let token: string | undefined;
  for (let page = 0; page < MAX_LOOKUP_PAGES; page++) {
    const res = await step({ method: lookup.method, request: { ...lookup.request, ...(token ? { nextPageToken: token } : {}) } });
    const found = events(res).find((e) => e.eventType === WFT_COMPLETED);
    if (found && (typeof found.eventId === 'string' || typeof found.eventId === 'number')) {
      return { response: await main({ ...r.request, workflowTaskFinishEventId: String(found.eventId) }), steps };
    }
    token = pageToken(res);
    if (!token) break;
  }
  throw new Error(`No completed workflow task found to reset to the ${which} one.`);
}

/** One line per step, for the plan preview. */
export function describePlan(r: Call & { plan: Plan }): string[] {
  const name = (m: string) => m.slice(m.lastIndexOf('/') + 1);
  if (r.plan.kind === 'call') return [name(r.method)];
  if (r.plan.kind === 'execute') return [name(r.method), `${name(r.plan.wait.method)}, waiting for the close event`];
  return [`${name(r.plan.lookup.method)}, finding the ${r.plan.which} completed workflow task`, `${name(r.method)} to that event`];
}
