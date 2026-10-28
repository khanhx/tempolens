// Payload decoding, phase 2: the remote codec server (/decode, /encode),
// called from the browser as upstream does. Only payloads outside memo,
// header and search attributes are sent.
import { signal } from '@preact/signals';
import { me } from '../me';
import type { Payload } from './decode';
import { codecEligiblePayloads, decodeTree } from './decode';

export interface CodecConfig {
  endpoint: string;
  includeCredentials: boolean;
  defaultErrorMessage: string;
  defaultErrorLink: string;
}

/** Last codec failure, shown as a banner; null after a success. */
export const codecError = signal<string | null>(null);

/** Browser-side codec override, kept under upstream's localStorage keys. */
export interface CodecOverride {
  endpoint: string;
  includeCredentials: boolean;
  /** `overrideRemoteCodecConfiguration`: use the local endpoint instead of the server's. */
  override: boolean;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
const OVERRIDE_KEYS = { endpoint: 'endpoint', includeCredentials: 'includeCredentials', override: 'overrideRemoteCodecConfiguration' } as const;

function storage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readCodecOverride(store: StorageLike | undefined = storage()): CodecOverride {
  const get = (k: string): unknown => {
    try {
      return JSON.parse(store?.getItem(k) ?? 'null');
    } catch {
      return null;
    }
  };
  const endpoint = get(OVERRIDE_KEYS.endpoint);
  return {
    endpoint: typeof endpoint === 'string' ? endpoint : '',
    includeCredentials: get(OVERRIDE_KEYS.includeCredentials) === true,
    override: get(OVERRIDE_KEYS.override) === true,
  };
}

export const codecOverride = signal<CodecOverride>(readCodecOverride());

export function saveCodecOverride(o: CodecOverride, store: StorageLike | undefined = storage()): void {
  if (!store) throw new Error('Browser storage is not available.');
  store.setItem(OVERRIDE_KEYS.endpoint, JSON.stringify(o.endpoint.trim()));
  store.setItem(OVERRIDE_KEYS.includeCredentials, JSON.stringify(o.includeCredentials));
  store.setItem(OVERRIDE_KEYS.override, JSON.stringify(o.override));
  codecOverride.value = { ...o, endpoint: o.endpoint.trim() };
}

/** The local endpoint wins only when the override flag is set and the endpoint is not empty (upstream rule). */
export function resolveCodec(server: CodecConfig | undefined, o: CodecOverride): CodecConfig | null {
  if (o.override && o.endpoint.trim()) {
    return {
      endpoint: o.endpoint.trim(),
      includeCredentials: o.includeCredentials,
      defaultErrorMessage: server?.defaultErrorMessage ?? '',
      defaultErrorLink: server?.defaultErrorLink ?? '',
    };
  }
  return server?.endpoint ? server : null;
}

/** The codec in effect, or null when none is configured. */
export function activeCodec(): CodecConfig | null {
  return resolveCodec(me.value?.settings.codec, codecOverride.value);
}

const BATCH = 100;

/** POSTs payloads to `{endpoint}/{kind}`; the response must hold the same number of payloads. */
export async function codecRequest(
  kind: 'decode' | 'encode',
  payloads: Payload[],
  namespace: string,
  cfg: CodecConfig,
  fetchFn: typeof fetch = fetch,
): Promise<Payload[]> {
  const out: Payload[] = [];
  for (let i = 0; i < payloads.length; i += BATCH) {
    const chunk = payloads.slice(i, i + BATCH);
    const res = await fetchFn(`${cfg.endpoint.replace(/\/+$/, '')}/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Namespace': namespace },
      credentials: cfg.includeCredentials ? 'include' : 'omit',
      body: JSON.stringify({ payloads: chunk }),
    });
    if (!res.ok) throw new Error(`codec ${kind} returned HTTP ${res.status}`);
    const body = (await res.json()) as { payloads?: unknown };
    if (!Array.isArray(body.payloads) || body.payloads.length !== chunk.length) {
      throw new Error(`codec ${kind} returned ${Array.isArray(body.payloads) ? body.payloads.length : 'no'} payloads for ${chunk.length}`);
    }
    out.push(...(body.payloads as Payload[]));
  }
  return out;
}

/**
 * Decodes every payload in `value`: codec first (when configured), then
 * base64 + JSON. A codec failure sets `codecError` and falls back to the
 * undecoded payloads, so the view still renders.
 */
export async function decodeWithCodec(
  value: unknown,
  namespace: string,
  cfg: CodecConfig | null = activeCodec(),
  opts: { force?: boolean; fetchFn?: typeof fetch } = {},
): Promise<unknown> {
  let substitute: Map<Payload, Payload> | undefined;
  if (cfg) {
    const originals = codecEligiblePayloads(value);
    if (originals.length > 0) {
      try {
        const decoded = await codecRequest('decode', originals, namespace, cfg, opts.fetchFn);
        substitute = new Map(originals.map((p, i) => [p, decoded[i] ?? p]));
        codecError.value = null;
      } catch (err) {
        codecError.value = err instanceof Error ? err.message : String(err);
      }
    }
  }
  return decodeTree(value, substitute, opts.force);
}
