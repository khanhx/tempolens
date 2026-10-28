import { useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import { href, P } from '../routes';

/** Task-queue index: Temporal cannot list task queues, so this is a name lookup. */
export default function TaskQueues() {
  const { params } = useRoute();
  const ns = params.ns ?? '';
  const { route } = useLocation();
  const [name, setName] = useState('');
  return (
    <section class="page">
      <h1>
        Task queues <span class="muted">{ns}</span>
      </h1>
      <p class="muted">Temporal has no API to list task queues. Enter a name to see its workers; task queue links on workflow pages lead here too.</p>
      <form
        class="raw-query"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) route(href(P.taskQueue, { ns, queue: name.trim() }));
        }}
      >
        <input class="input" data-shortcut-search aria-label="Task queue name" placeholder="Task queue name" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        <button type="submit" class="btn btn-primary">
          Show workers
        </button>
      </form>
    </section>
  );
}
