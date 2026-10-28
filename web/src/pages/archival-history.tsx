import { useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { StaticHistory } from '../components/static-history';
import { apiPageFetcher } from '../lib/history/fetch';
import type { HistoryEvent } from '../lib/temporal';
import { href, P } from '../routes';

/** An archived run's history, fetched in full (ascending), shown with the history views. */
export default function ArchivalHistory() {
  const { params } = useRoute();
  const ns = params.ns ?? '';
  const wf = params.wf ?? '';
  const run = params.run ?? '';
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const fetchPage = apiPageFetcher(ns, wf, run);
      const all: HistoryEvent[] = [];
      let token: string | undefined;
      do {
        const page = await fetchPage('asc', token, controller.signal);
        all.push(...page.events);
        token = page.nextPageToken;
        setProgress(all.length);
      } while (token);
      setEvents(all);
    })().catch((err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    });
    return () => controller.abort();
  }, [ns, wf, run]);

  return (
    <section class="page">
      <p class="muted crumbs">
        <a href={href(P.archival, { ns })}>{ns} archival</a>
      </p>
      <h1 class="run-title">{wf}</h1>
      <p class="muted">
        Run <code>{run}</code>
      </p>
      {error && (
        <p class="alert alert-error" role="alert">
          {error}
        </p>
      )}
      {!events && !error && <p class="muted">Loading the archived history… {progress ? `${progress} events` : ''}</p>}
      {events && <StaticHistory events={events} ns={ns} />}
    </section>
  );
}
