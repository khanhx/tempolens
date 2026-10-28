// Payload decoding, phase 1: base64 metadata/data, then JSON with BigInt
// safety. Codec (phase 2) lives in codec.ts and runs before this.
import { tryBase64ToText } from './base64';
import { parseJson } from './json-bigint';

export interface Payload {
  metadata?: Record<string, string>;
  data?: string;
  [key: string]: unknown;
}

/** Payloads above this many bytes are not decoded until the user expands them. */
export const LARGE_PAYLOAD_BYTES = 64 * 1024;

/** Placeholder for a payload left undecoded because of its size. */
export class LargePayload {
  constructor(
    readonly payload: Payload,
    readonly encoding: string,
    readonly size: number,
  ) {}
  toJSON(): Payload {
    return this.payload;
  }
}

export type DecodedPayload =
  | { kind: 'value'; encoding: string; value: unknown }
  | { kind: 'raw'; encoding: string; payload: Payload }
  | { kind: 'large'; encoding: string; size: number; payload: Payload };

const PAYLOAD_KEYS = new Set(['metadata', 'data', 'externalPayloads']);

/** True for a `{metadata:{encoding}, data?}` object as the gateway emits it. */
export function isPayload(v: unknown): v is Payload {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = v as Payload;
  if (!p.metadata || typeof p.metadata !== 'object' || typeof p.metadata.encoding !== 'string') return false;
  if (p.data !== undefined && typeof p.data !== 'string') return false;
  return Object.keys(p).every((k) => PAYLOAD_KEYS.has(k));
}

export function payloadEncoding(p: Payload): string {
  return tryBase64ToText(p.metadata?.encoding) ?? '';
}

/** Decoded size in bytes, estimated from the base64 length. */
export function payloadSize(p: Payload): number {
  const len = p.data?.length ?? 0;
  const padding = p.data?.endsWith('==') ? 2 : p.data?.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

/**
 * Decodes one payload. `binary/null` → null; `json/*` → parsed JSON; a
 * payload that does not parse (encrypted, binary) is returned raw, as upstream
 * does. Payloads over 64 KB stay undecoded unless `force` is set.
 */
export function decodePayload(p: Payload, force = false): DecodedPayload {
  const encoding = payloadEncoding(p);
  if (encoding === 'binary/null') return { kind: 'value', encoding, value: null };
  const size = payloadSize(p);
  if (!force && size > LARGE_PAYLOAD_BYTES) return { kind: 'large', encoding, size, payload: p };
  if (encoding.startsWith('json/')) {
    const text = tryBase64ToText(p.data ?? '');
    if (text !== null) {
      try {
        return { kind: 'value', encoding, value: parseJson(text) };
      } catch {
        // Fall through to raw.
      }
    }
  }
  return { kind: 'raw', encoding, payload: p };
}

/** The value to show for a decoded payload inside a larger tree. */
export function decodedValue(d: DecodedPayload): unknown {
  if (d.kind === 'value') return d.value;
  if (d.kind === 'large') return new LargePayload(d.payload, d.encoding, d.size);
  return d.payload;
}

/** Subtrees whose payloads are base64-decoded only and never sent to the codec (upstream behaviour). */
export const BASE64_ONLY_KEYS: ReadonlySet<string> = new Set(['memo', 'header', 'searchAttributes']);

/**
 * Replaces every payload in `value` with its decoded form. `substitute` maps
 * an original payload to its codec-decoded version.
 */
export function decodeTree(value: unknown, substitute?: Map<Payload, Payload>, force = false): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (isPayload(v)) return decodedValue(decodePayload(substitute?.get(v) ?? v, force));
    if (v && typeof v === 'object' && !(v instanceof LargePayload)) {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v)) {
        if (k === '__proto__') continue;
        out[k] = walk(child);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

/** Payloads in `value` that the codec may decode: all except those under BASE64_ONLY_KEYS. */
export function codecEligiblePayloads(value: unknown): Payload[] {
  const out: Payload[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isPayload(v)) out.push(v);
    else if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) if (!BASE64_ONLY_KEYS.has(k)) walk(child);
    }
  };
  walk(value);
  return out;
}

/** Decodes a search-attribute or memo map (base64 only). */
export function decodeFields(fields: Record<string, Payload> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(fields ?? {})) out[k] = decodedValue(decodePayload(p));
  return out;
}
