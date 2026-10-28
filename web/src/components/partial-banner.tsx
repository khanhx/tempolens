import { useState } from 'preact/hooks';
import type { NamespaceError, SearchResponse } from '../lib/xapi';
import { namespaceErrorText, partialText } from '../lib/xapi';

/** Says why a bounded scan may be incomplete; renders nothing for a complete result. */
export function PartialBanner({ result }: { result: Pick<SearchResponse, 'partial' | 'partialReasons' | 'scanned' | 'candidates'> }) {
  const text = partialText(result);
  if (!text) return null;
  return (
    <p class="alert alert-warning" role="status">
      {text}
    </p>
  );
}

/** Namespaces that failed in a fan-out; the rest of the result is still shown. Dismissible. */
export function NamespaceErrorsBanner({ errors }: { errors: readonly NamespaceError[] }) {
  const key = errors.map((e) => `${e.namespace}:${e.code}`).join('|');
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (errors.length === 0 || dismissed === key) return null;
  return (
    <div class="alert alert-warning" role="status">
      <strong>
        {errors.length} namespace{errors.length === 1 ? '' : 's'} could not be read; their workflows are missing below.
      </strong>{' '}
      <button type="button" class="btn btn-sm" onClick={() => setDismissed(key)}>
        Dismiss
      </button>
      <ul class="list-plain">
        {namespaceErrorText(errors).map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}
