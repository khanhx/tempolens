import { describe, expect, it, vi } from 'vitest';
import { base64ToText, textToBase64, tryBase64ToText } from './base64';
import { codecRequest, decodeWithCodec } from './codec';
import type { Payload } from './decode';
import { decodeFields, decodePayload, decodeTree, isPayload, LARGE_PAYLOAD_BYTES, LargePayload } from './decode';
import { parseJson, stringifyJson } from './json-bigint';

const json = (value: string): Payload => ({ metadata: { encoding: textToBase64('json/plain') }, data: textToBase64(value) });
const nullPayload: Payload = { metadata: { encoding: textToBase64('binary/null') } };

describe('base64', () => {
  it('round-trips UTF-8', () => {
    expect(base64ToText(textToBase64('xin chào ✓'))).toBe('xin chào ✓');
    expect(tryBase64ToText('%%%')).toBeNull();
  });
});

describe('json-bigint', () => {
  it('keeps integers beyond 2^53 exact', () => {
    const v = parseJson('{"id":9007199254740993,"small":42,"neg":-9007199254740993,"f":1.5,"e":1e400}') as Record<
      string,
      unknown
    >;
    expect(v.id).toBe(9007199254740993n);
    expect(v.neg).toBe(-9007199254740993n);
    expect(v.small).toBe(42);
    expect(v.f).toBe(1.5);
    expect(v.e).toBe(Infinity);
    expect(stringifyJson(v, 0)).toBe('{"id":9007199254740993,"small":42,"neg":-9007199254740993,"f":1.5,"e":null}');
  });

  it('parses the full grammar like JSON.parse', () => {
    const text = ' {"a":[1,true,false,null,"s\\n\\u00e9",{"b":{}}],"c":[] , "d":-0.5e-3} ';
    expect(parseJson(text)).toEqual(JSON.parse(text));
  });

  it('rejects invalid input', () => {
    for (const bad of ['', '{', '{"a":}', '[1,]', 'tru', '01', '"\u0001"', '{"a":1} x', "{'a':1}"]) {
      expect(() => parseJson(bad), bad).toThrow(SyntaxError);
    }
  });

  it('does not let __proto__ change the prototype', () => {
    const v = parseJson('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(v.__proto__).toEqual({ polluted: true });
  });

  it('stringifies with indentation', () => {
    expect(stringifyJson({ a: [1n, 'x'] })).toBe('{\n  "a": [\n    1,\n    "x"\n  ]\n}');
    expect(stringifyJson({ u: undefined, f: () => 1 }, 0)).toBe('{}');
  });
});

describe('decodePayload', () => {
  it('decodes json and binary/null', () => {
    expect(decodePayload(json('{"n":9007199254740993}'))).toEqual({
      kind: 'value',
      encoding: 'json/plain',
      value: { n: 9007199254740993n },
    });
    expect(decodePayload(nullPayload)).toEqual({ kind: 'value', encoding: 'binary/null', value: null });
  });

  it('returns non-JSON payloads raw', () => {
    const enc: Payload = { metadata: { encoding: textToBase64('binary/encrypted') }, data: 'AAEC' };
    expect(decodePayload(enc)).toEqual({ kind: 'raw', encoding: 'binary/encrypted', payload: enc });
    const broken = json('{not json');
    expect(decodePayload(broken).kind).toBe('raw');
  });

  it('defers large payloads unless forced', () => {
    const big = json(JSON.stringify('x'.repeat(LARGE_PAYLOAD_BYTES + 10)));
    const d = decodePayload(big);
    expect(d.kind).toBe('large');
    expect(decodePayload(big, true).kind).toBe('value');
  });
});

describe('decodeTree', () => {
  it('replaces nested payloads and keeps other values', () => {
    const tree = { input: { payloads: [json('{"a":1}'), nullPayload] }, eventId: '1', memo: { fields: { m: json('"x"') } } };
    expect(decodeTree(tree)).toEqual({ input: { payloads: [{ a: 1 }, null] }, eventId: '1', memo: { fields: { m: 'x' } } });
  });

  it('wraps large payloads as LargePayload', () => {
    const big = json(JSON.stringify('y'.repeat(LARGE_PAYLOAD_BYTES + 10)));
    const out = decodeTree({ result: { payloads: [big] } }) as { result: { payloads: unknown[] } };
    expect(out.result.payloads[0]).toBeInstanceOf(LargePayload);
  });

  it('detects payload objects strictly', () => {
    expect(isPayload(json('1'))).toBe(true);
    expect(isPayload({ metadata: { encoding: 'x' }, data: 'y', other: 1 })).toBe(false);
    expect(isPayload({ metadata: {} })).toBe(false);
  });

  it('decodes field maps', () => {
    expect(decodeFields({ SeedRun: json('"r1"'), SeedPriority: json('3') })).toEqual({ SeedRun: 'r1', SeedPriority: 3 });
    expect(decodeFields(undefined)).toEqual({});
  });
});

describe('codec', () => {
  const cfg = { endpoint: 'https://codec.example.test/', includeCredentials: true, defaultErrorMessage: '', defaultErrorLink: '' };

  it('sends the upstream request shape and maps the answer back', async () => {
    const encrypted: Payload = { metadata: { encoding: textToBase64('binary/encrypted') }, data: 'AAAA' };
    const memoPayload = json('"memo"');
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ payloads: [json('{"ok":true}')] })));
    const out = await decodeWithCodec({ input: { payloads: [encrypted] }, memo: { fields: { m: memoPayload } } }, 'ns-a', cfg, {
      fetchFn,
    });
    expect(out).toEqual({ input: { payloads: [{ ok: true }] }, memo: { fields: { m: 'memo' } } });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('https://codec.example.test/decode');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', 'X-Namespace': 'ns-a' });
    expect(JSON.parse(String(init?.body))).toEqual({ payloads: [encrypted] });
  });

  it('falls back to undecoded payloads when the codec fails', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 500 }));
    const out = await decodeWithCodec({ result: { payloads: [json('7')] } }, 'ns', cfg, { fetchFn });
    expect(out).toEqual({ result: { payloads: [7] } });
    const { codecError } = await import('./codec');
    expect(codecError.value).toMatch(/500/);
  });

  it('rejects a response with the wrong payload count', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ payloads: [] })));
    await expect(codecRequest('encode', [json('1')], 'ns', cfg, fetchFn)).rejects.toThrow(/0 payloads for 1/);
  });

  it('skips the codec without an endpoint', async () => {
    expect(await decodeWithCodec({ payloads: [json('1')] }, 'ns', null)).toEqual({ payloads: [1] });
  });
});
