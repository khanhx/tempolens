// Memo columns: decodes the memo payloads of loaded rows, through the codec
// when one is configured, then base64 + JSON. Loaded lazily, only while a
// memo column is visible. Each payload is decoded once (cached by object), and
// a load sends one codec request per namespace, never one per cell.
import type { CodecConfig } from '../payload/codec';
import { activeCodec, codecError, codecRequest } from '../payload/codec';
import type { Payload } from '../payload/decode';
import { decodePayload } from '../payload/decode';
import type { SortType } from '../sort';

/** Re-exported so the list page can show codec failures without loading codec.ts up front. */
export { codecError };

export interface MemoRow {
  memo?: { fields?: Record<string, Payload> };
}

const decoded = new WeakMap<Payload, unknown>();
const inflight = new WeakSet<Payload>();

/** Cell value of a payload: its JSON value, or a short note for a payload that is not JSON. */
export function memoCellValue(p: Payload): unknown {
  const d = decodePayload(p);
  if (d.kind === 'value') return d.value;
  if (d.kind === 'large') return `[${d.encoding || 'payload'}, ${d.size.toLocaleString('en-US')} B, not decoded]`;
  return `[${d.encoding || 'binary'} payload]`;
}

/** True when the row has no `key` memo or it has been decoded. */
export function memoReady(row: MemoRow, key: string): boolean {
  const p = row.memo?.fields?.[key];
  return !p || decoded.has(p);
}

/** Decoded `key` memo of a row; undefined when absent or not decoded yet. */
export function memoValue(row: MemoRow, key: string): unknown {
  const p = row.memo?.fields?.[key];
  return p ? decoded.get(p) : undefined;
}

/**
 * Decodes the `keys` memos of `rows` that are not decoded yet and returns how
 * many it decoded. A codec failure sets `codecError` and falls back to the
 * undecoded payloads, as the payload views do.
 */
export async function decodeMemos<R extends MemoRow>(
  rows: readonly R[],
  keys: readonly string[],
  namespaceOf: (row: R) => string,
  cfg: CodecConfig | null = activeCodec(),
  fetchFn?: typeof fetch,
): Promise<number> {
  const byNamespace = new Map<string, Payload[]>();
  for (const row of rows) {
    for (const key of keys) {
      const p = row.memo?.fields?.[key];
      if (!p || decoded.has(p) || inflight.has(p)) continue;
      inflight.add(p);
      const ns = namespaceOf(row);
      byNamespace.set(ns, [...(byNamespace.get(ns) ?? []), p]);
    }
  }
  const counts = await Promise.all(
    [...byNamespace].map(async ([ns, originals]) => {
      let out = originals;
      if (cfg) {
        try {
          out = await codecRequest('decode', originals, ns, cfg, fetchFn);
          codecError.value = null;
        } catch (err) {
          codecError.value = err instanceof Error ? err.message : String(err);
        }
      }
      originals.forEach((p, i) => {
        decoded.set(p, memoCellValue(out[i] ?? p));
        inflight.delete(p);
      });
      return originals.length;
    }),
  );
  return counts.reduce((a, b) => a + b, 0);
}

/** `number` when every present value is numeric, else `keyword`. */
export function inferSortType(values: readonly unknown[]): SortType {
  const present = values.filter((v) => v !== undefined && v !== null && v !== '');
  return present.length > 0 && present.every((v) => typeof v === 'bigint' || (typeof v === 'number' && Number.isFinite(v))) ? 'number' : 'keyword';
}
