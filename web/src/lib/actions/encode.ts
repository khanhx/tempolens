// Encoding user input for writes, as upstream does: one JSON value becomes
// one payload; a raw `{metadata, data}` payload is passed through; the codec
// `/encode` runs last when a codec is configured.
import { activeCodec, codecRequest } from '../payload/codec';
import type { CodecConfig } from '../payload/codec';
import { textToBase64 } from '../payload/base64';
import type { Payload } from '../payload/decode';
import { isPayload } from '../payload/decode';
import { parseJson, stringifyJson } from '../payload/json-bigint';

export type InputEncoding = 'json/plain' | 'json/protobuf';

export function encodeValue(value: unknown, encoding: InputEncoding = 'json/plain', messageType = ''): Payload {
  const metadata: Record<string, string> = { encoding: textToBase64(encoding) };
  if (encoding === 'json/protobuf') {
    if (!messageType.trim()) throw new Error('json/protobuf needs a message type, e.g. temporal.api.common.v1.Payload.');
    metadata.messageType = textToBase64(messageType.trim());
  }
  return { metadata, data: textToBase64(stringifyJson(value, 0)) };
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A payload the user pasted as-is: every metadata value and the data are base64. */
function isRawPayload(v: unknown): v is Payload {
  return isPayload(v) && Object.values(v.metadata ?? {}).every((m) => BASE64.test(m)) && (v.data === undefined || BASE64.test(v.data));
}

/**
 * Parses the input box. Empty input means no payload. Throws with a readable
 * message when the text is not JSON.
 */
export function parseInput(text: string, encoding: InputEncoding = 'json/plain', messageType = ''): Payload[] | undefined {
  if (!text.trim()) return undefined;
  let value: unknown;
  try {
    value = parseJson(text);
  } catch (err) {
    throw new Error(`Input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  return [isRawPayload(value) ? value : encodeValue(value, encoding, messageType)];
}

/** Runs the codec `/encode` over payloads when a codec is configured. */
export async function encodeForWrite(
  payloads: Payload[] | undefined,
  namespace: string,
  cfg: CodecConfig | null = activeCodec(),
  fetchFn?: typeof fetch,
): Promise<Payload[] | undefined> {
  if (!payloads?.length || !cfg) return payloads;
  return codecRequest('encode', payloads, namespace, cfg, fetchFn);
}

/** Plain text (summary, details, notes) as a json/plain payload. */
export const textPayload = (text: string): Payload => encodeValue(text);
