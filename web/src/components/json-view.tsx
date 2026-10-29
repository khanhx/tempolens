import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { decodePayload, decodedValue, LargePayload } from '../lib/payload/decode';
import { stringifyJson } from '../lib/payload/json-bigint';
import { CopyButton } from './copy-button';

/** Children shown before a "show more" button, so huge arrays stay cheap. */
const CHILD_LIMIT = 200;

/** Rows "Expand all" may add; a bigger document opens breadth first up to this many. */
export const EXPAND_ALL_BUDGET = 2000;

/** Decides whether a branch starts open; `depth` is 0 at the root. */
type IsOpen = (value: object, depth: number) => boolean;

const isBranch = (v: unknown): v is object => !!v && typeof v === 'object' && !(v instanceof LargePayload);

const childValues = (v: object): unknown[] => (Array.isArray(v) ? v : Object.values(v));

/**
 * The branches "Expand all" opens: breadth first, stopping before the
 * rendered rows would exceed `budget`, so a huge payload cannot freeze the
 * tab. `shown` counts the rows the opened branches render.
 */
export function expandPlan(value: unknown, budget = EXPAND_ALL_BUDGET): { open: Set<object>; shown: number; truncated: boolean } {
  const open = new Set<object>();
  let shown = 0;
  const queue: unknown[] = [value];
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i];
    if (!isBranch(v) || open.has(v)) continue;
    const children = childValues(v).slice(0, CHILD_LIMIT);
    if (children.length === 0) continue;
    if (shown + children.length > budget) return { open, shown, truncated: true };
    open.add(v);
    shown += children.length;
    queue.push(...children);
  }
  return { open, shown, truncated: false };
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

function LargeValue({ value }: { value: LargePayload }) {
  const [decoded, setDecoded] = useState<{ v: unknown } | null>(null);
  if (decoded) return <Value value={decoded.v} depth={1} isOpen={(_, d) => d < 1} />;
  return (
    <button type="button" class="btn btn-sm" onClick={() => setDecoded({ v: decodedValue(decodePayload(value.payload, true)) })}>
      Large payload ({kb(value.size)}, {value.encoding || 'unknown encoding'}): decode
    </button>
  );
}

function Scalar({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span class="jv-null">null</span>;
  if (typeof value === 'string') {
    return <span class={value.includes('\n') ? 'jv-str jv-multiline' : 'jv-str'}>{value.includes('\n') ? `"${value}"` : JSON.stringify(value)}</span>;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return <span class="jv-num">{String(value)}</span>;
  if (typeof value === 'boolean') return <span class="jv-bool">{String(value)}</span>;
  return <span>{String(value)}</span>;
}

function Value({ value, depth, isOpen }: { value: unknown; depth: number; isOpen: IsOpen }) {
  if (value instanceof LargePayload) return <LargeValue value={value} />;
  if (value && typeof value === 'object') return <Branch value={value} depth={depth} isOpen={isOpen} />;
  return <Scalar value={value} />;
}

function Branch({ value, depth, isOpen }: { value: object; depth: number; isOpen: IsOpen }) {
  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray ? (value as unknown[]).map((v, i) => [String(i), v]) : Object.entries(value);
  const [open, setOpen] = useState(() => isOpen(value, depth));
  const [limit, setLimit] = useState(CHILD_LIMIT);
  const [o, c] = isArray ? ['[', ']'] : ['{', '}'];
  if (entries.length === 0) return <span class="jv-punct">{o + c}</span>;
  if (!open) {
    return (
      <button type="button" class="jv-toggle" aria-expanded="false" onClick={() => setOpen(true)}>
        {o}… {entries.length} {isArray ? 'items' : 'keys'} {c}
      </button>
    );
  }
  const shown = entries.slice(0, limit);
  return (
    <>
      <button type="button" class="jv-toggle" aria-expanded="true" onClick={() => setOpen(false)}>
        {o}
      </button>
      <div class="jv-children">
        {shown.map(([k, v]) => (
          <div key={k} class="jv-row">
            {!isArray && <span class="jv-key">{JSON.stringify(k)}: </span>}
            <Value value={v} depth={depth + 1} isOpen={isOpen} />
          </div>
        ))}
        {entries.length > limit && (
          <button type="button" class="btn btn-sm" onClick={() => setLimit(limit + CHILD_LIMIT * 5)}>
            Show more ({entries.length - limit} left)
          </button>
        )}
      </div>
      <span class="jv-punct">{c}</span>
    </>
  );
}

/**
 * Collapsible JSON tree. BigInt values print exactly; large payloads decode
 * on demand. "Expand all" and "Collapse all" rebuild the tree with every
 * branch open (within EXPAND_ALL_BUDGET) or only the root open.
 */
export function JsonView({ value, openDepth = 3, actions }: { value: unknown; openDepth?: number; actions?: ComponentChildren }) {
  // `gen` remounts the tree so every branch takes its open state from the new
  // `isOpen`; `source` drops that state when a different value comes in.
  const [view, setView] = useState<{ gen: number; source: unknown; isOpen: IsOpen; notice: string } | null>(null);
  const current = view?.source === value ? view : null;
  const expandAll = () => {
    const plan = expandPlan(value);
    const notice = plan.truncated ? `Large document: expanded the first ${plan.shown.toLocaleString('en-US')} values. Open the rest by hand.` : '';
    setView({ gen: (view?.gen ?? 0) + 1, source: value, isOpen: (v) => plan.open.has(v), notice });
  };
  const collapseAll = () => setView({ gen: (view?.gen ?? 0) + 1, source: value, isOpen: (_, d) => d < 1, notice: '' });
  const nested = isBranch(value) && childValues(value).length > 0;
  return (
    <div class="jv">
      <div class="jv-actions">
        {actions}
        {nested && (
          <>
            <button type="button" class="btn btn-ghost btn-sm" aria-label="Expand all JSON nodes" onClick={expandAll}>
              Expand all
            </button>
            <button type="button" class="btn btn-ghost btn-sm" aria-label="Collapse all JSON nodes" onClick={collapseAll}>
              Collapse all
            </button>
          </>
        )}
        <CopyButton text={() => stringifyJson(value)} label="Copy JSON" />
      </div>
      <div class="jv-body" key={current?.gen ?? 0}>
        {current?.notice && (
          <p class="muted" role="status">
            {current.notice}
          </p>
        )}
        <Value value={value} depth={0} isOpen={current?.isOpen ?? ((_, d) => d < openDepth)} />
      </div>
    </div>
  );
}

/** Plain pretty-printed JSON for very large documents: the first `maxLines` lines, then on demand. */
export function JsonText({ value, maxLines = 2000 }: { value: unknown; maxLines?: number }) {
  const [all, setAll] = useState(false);
  const text = stringifyJson(value);
  const lines = all ? null : text.split('\n', maxLines + 1);
  const truncated = lines !== null && lines.length > maxLines;
  return (
    <div class="jv">
      <div class="jv-actions">
        <CopyButton text={text} label="Copy JSON" />
      </div>
      <pre class="jv-pre">{truncated ? lines.slice(0, maxLines).join('\n') : text}</pre>
      {truncated && (
        <button type="button" class="btn btn-sm" onClick={() => setAll(true)}>
          Show everything ({(text.length / 1024).toFixed(0)} KB)
        </button>
      )}
    </div>
  );
}
