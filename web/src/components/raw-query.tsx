import { useEffect, useState } from 'preact/hooks';

/** Raw visibility query input. Enter applies, Escape reverts; `/` focuses it. */
export function RawQuery({ query, onSubmit }: { query: string; onSubmit: (q: string) => void }) {
  const [draft, setDraft] = useState(query);
  useEffect(() => setDraft(query), [query]);
  const dirty = draft.trim() !== query.trim();
  return (
    <form
      class="raw-query"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(draft.trim());
      }}
    >
      <label class="visually-hidden" for="raw-query-input">
        Visibility query
      </label>
      <input
        id="raw-query-input"
        class="input input-mono"
        data-shortcut-search
        value={draft}
        placeholder='Visibility query, e.g. WorkflowType = "Order" AND ExecutionStatus = "Failed"'
        spellcheck={false}
        autocomplete="off"
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setDraft(query);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
      <button type="submit" class={dirty ? 'btn btn-primary' : 'btn'}>
        Apply
      </button>
      {query && (
        <button type="button" class="btn btn-ghost" onClick={() => onSubmit('')}>
          Clear
        </button>
      )}
    </form>
  );
}
