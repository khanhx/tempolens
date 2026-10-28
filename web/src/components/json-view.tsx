import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { decodePayload, decodedValue, LargePayload } from '../lib/payload/decode';
import { stringifyJson } from '../lib/payload/json-bigint';
import { CopyButton } from './copy-button';

/** Children shown before a "show more" button, so huge arrays stay cheap. */
const CHILD_LIMIT = 200;

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

function LargeValue({ value }: { value: LargePayload }) {
  const [decoded, setDecoded] = useState<{ v: unknown } | null>(null);
  if (decoded) return <Value value={decoded.v} depth={1} openDepth={1} />;
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

function Value({ value, depth, openDepth }: { value: unknown; depth: number; openDepth: number }) {
  if (value instanceof LargePayload) return <LargeValue value={value} />;
  if (value && typeof value === 'object') return <Branch value={value as object} depth={depth} openDepth={openDepth} />;
  return <Scalar value={value} />;
}

function Branch({ value, depth, openDepth }: { value: object; depth: number; openDepth: number }) {
  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray ? (value as unknown[]).map((v, i) => [String(i), v]) : Object.entries(value);
  const [open, setOpen] = useState(depth < openDepth);
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
            <Value value={v} depth={depth + 1} openDepth={openDepth} />
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

/** Collapsible JSON tree. BigInt values print exactly; large payloads decode on demand. */
export function JsonView({ value, openDepth = 3, actions }: { value: unknown; openDepth?: number; actions?: ComponentChildren }) {
  return (
    <div class="jv">
      <div class="jv-actions">
        {actions}
        <CopyButton text={() => stringifyJson(value)} label="Copy JSON" />
      </div>
      <div class="jv-body">
        <Value value={value} depth={0} openDepth={openDepth} />
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
