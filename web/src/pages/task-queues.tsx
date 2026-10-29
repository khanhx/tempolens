import './task-queues.css';
import { useEffect, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import type { ComboOption } from '../components/combobox';
import { Combobox } from '../components/combobox';
import type { QueueSuggestion, QueueSuggestions } from '../lib/task-queues';
import { filterQueues, loadQueueSuggestions, recordRecentQueue } from '../lib/task-queues';
import { href, P } from '../routes';

/** At most this many suggestions are listed; typing narrows the rest. */
const SHOWN = 100;

function hint(q: QueueSuggestion, runningComplete: boolean): string | undefined {
  if (q.running > 0) return `${q.running}${runningComplete ? '' : '+'} running`;
  if (q.sources.includes('recent')) return 'recent';
  if (q.sources.includes('schedule')) return 'schedule';
  return undefined;
}

/** Task-queue index: Temporal cannot list task queues, so names are suggested from what the UI can see. */
export default function TaskQueues() {
  const { params } = useRoute();
  const ns = params.ns ?? '';
  const { route } = useLocation();
  const [name, setName] = useState('');
  const [data, setData] = useState<QueueSuggestions | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    void loadQueueSuggestions(ns).then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, [ns]);

  const open = (queue: string) => {
    const q = queue.trim();
    if (!q) return;
    recordRecentQueue(ns, q);
    route(href(P.taskQueue, { ns, queue: q }));
  };

  const options: ComboOption[] = filterQueues(data?.items ?? [], name)
    .slice(0, SHOWN)
    .map((q) => ({ value: q.name, hint: hint(q, data?.runningComplete ?? true) }));

  return (
    <section class="page">
      <h1>
        Task queues <span class="muted">{ns}</span>
      </h1>
      <p class="muted">Temporal has no API to list task queues. Pick a suggestion or enter a name to see its workers; task queue links on workflow pages lead here too.</p>
      <form
        class="tq-form"
        onSubmit={(e) => {
          e.preventDefault();
          open(name);
        }}
      >
        <Combobox
          id="task-queue-name"
          label="Task queue name"
          placeholder="Task queue name"
          value={name}
          onInput={setName}
          options={options}
          onPick={open}
          shortcutSearch
        />
        <button type="submit" class="btn btn-primary">
          Show workers
        </button>
      </form>
      <p class="muted tq-note" role="status">
        Suggestions come from recent workflows, schedules and queues you opened; the list may be incomplete.
        {!data && ' Loading suggestions…'}
        {data?.error && <span class="tq-error"> Some suggestions could not be loaded: {data.error}</span>}
      </p>
    </section>
  );
}
