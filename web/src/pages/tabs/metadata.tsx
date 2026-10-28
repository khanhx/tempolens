import { useEffect } from 'preact/hooks';
import { JsonView } from '../../components/json-view';
import { PayloadView } from '../../components/payload-view';
import { decodeFields } from '../../lib/payload/decode';
import type { RunContext } from '../workflow-layout';

/**
 * User metadata (summary, details, current details), search attributes and
 * memo. Search attributes and memo are base64-decoded only, as upstream does.
 * The legacy routes `user-metadata`, `search-attributes` and `memo` scroll to
 * their section.
 */
export function MetadataTab({ store, ns, focus }: RunContext & { focus: string }) {
  useEffect(() => {
    document.getElementById(focus)?.scrollIntoView({ block: 'start' });
  }, [focus]);

  const d = store.describe.value;
  if (!d) return <p class="muted">Loading…</p>;
  const info = d.workflowExecutionInfo;
  const meta = d.executionConfig?.userMetadata;
  const current = store.metadata.value?.currentDetails;
  const attributes = decodeFields(info?.searchAttributes?.indexedFields);
  const memo = decodeFields(info?.memo?.fields);

  return (
    <div class="stack">
      <section id="user-metadata" class="card card-pad">
        <h2>User metadata</h2>
        <h3>Summary</h3>
        {meta?.summary ? <PayloadView value={meta.summary} ns={ns} /> : <p class="muted">None</p>}
        <h3>Details</h3>
        {meta?.details ? <PayloadView value={meta.details} ns={ns} /> : <p class="muted">None</p>}
        <h3>Current details</h3>
        {current ? <pre class="code-block">{current}</pre> : <p class="muted">None reported by the workflow.</p>}
      </section>
      <section id="search-attributes" class="card card-pad">
        <h2>Search attributes</h2>
        {Object.keys(attributes).length ? <JsonView value={attributes} /> : <p class="muted">None</p>}
      </section>
      <section id="memo" class="card card-pad">
        <h2>Memo</h2>
        {Object.keys(memo).length ? <JsonView value={memo} /> : <p class="muted">None</p>}
      </section>
    </div>
  );
}
