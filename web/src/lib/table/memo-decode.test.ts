import { afterEach, describe, expect, it, vi } from 'vitest';
import { textToBase64 } from '../payload/base64';
import type { CodecConfig } from '../payload/codec';
import { codecError } from '../payload/codec';
import type { Payload } from '../payload/decode';
import { LARGE_PAYLOAD_BYTES } from '../payload/decode';
import type { MemoRow } from './memo-decode';
import { decodeMemos, inferSortType, memoCellValue, memoReady, memoValue } from './memo-decode';

const json = (value: string): Payload => ({ metadata: { encoding: textToBase64('json/plain') }, data: textToBase64(value) });
const encrypted = (value: string): Payload => ({ metadata: { encoding: textToBase64('binary/encrypted') }, data: textToBase64(value) });
const row = (ns: string, fields: Record<string, Payload>): MemoRow & { ns: string } => ({ ns, memo: { fields } });
const cfg: CodecConfig = { endpoint: 'https://codec.example/', includeCredentials: false, defaultErrorMessage: '', defaultErrorLink: '' };

/** A codec that "decrypts" binary/encrypted payloads into json/plain with the same data. */
function fakeCodec() {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { payloads: Payload[] };
    const payloads = body.payloads.map((p) => ({ ...p, metadata: { encoding: textToBase64('json/plain') } }));
    return new Response(JSON.stringify({ payloads }), { status: 200 });
  });
}

afterEach(() => {
  codecError.value = null;
});

describe('memoCellValue', () => {
  it('decodes JSON values and binary/null', () => {
    expect(memoCellValue(json('{"env":"dev","n":9007199254740993}'))).toEqual({ env: 'dev', n: 9007199254740993n });
    expect(memoCellValue(json('"text"'))).toBe('text');
    expect(memoCellValue({ metadata: { encoding: textToBase64('binary/null') } })).toBeNull();
  });

  it('shows a short note for payloads that are not JSON', () => {
    expect(memoCellValue(encrypted('secret'))).toBe('[binary/encrypted payload]');
    expect(memoCellValue(json('{not json'))).toBe('[json/plain payload]');
    expect(memoCellValue({ metadata: { encoding: textToBase64('binary/protobuf') }, data: 'AAEC' })).toBe('[binary/protobuf payload]');
    expect(memoCellValue(json(JSON.stringify('x'.repeat(LARGE_PAYLOAD_BYTES + 10))))).toMatch(/^\[json\/plain, [\d,]+ B, not decoded\]$/);
  });
});

describe('decodeMemos', () => {
  it('decodes without a codec and caches each payload', async () => {
    const first = row('a', { owner: json('"alice"'), priority: json('2') });
    const second = row('a', { owner: json('"bob"') });
    const rows = [first, second];
    expect(memoReady(first, 'owner')).toBe(false);
    expect(memoReady(second, 'priority')).toBe(true);
    expect(await decodeMemos(rows, ['owner', 'priority'], (r) => r.ns, null)).toBe(3);
    expect(rows.map((r) => memoValue(r, 'owner'))).toEqual(['alice', 'bob']);
    expect(memoValue(first, 'priority')).toBe(2);
    expect(memoValue(second, 'priority')).toBeUndefined();
    expect(memoReady(first, 'owner')).toBe(true);
    expect(await decodeMemos(rows, ['owner', 'priority'], (r) => r.ns, null)).toBe(0);
  });

  it('decodes only the requested keys', async () => {
    const r = row('a', { owner: json('"x"'), other: json('"y"') });
    await decodeMemos([r], ['owner'], () => 'a', null);
    expect(memoReady(r, 'owner')).toBe(true);
    expect(memoReady(r, 'other')).toBe(false);
  });

  it('sends one codec request per namespace and none for payloads already decoded', async () => {
    const fetchFn = fakeCodec();
    const rows = [row('a', { owner: encrypted('"alice"') }), row('b', { owner: encrypted('"bob"') }), row('a', { owner: encrypted('"carol"'), tag: encrypted('"t"') })];
    expect(await decodeMemos(rows, ['owner', 'tag'], (r) => r.ns, cfg, fetchFn)).toBe(4);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const calls = fetchFn.mock.calls.map(([url, init]) => ({ url, ns: (init?.headers as Record<string, string>)['X-Namespace'], n: (JSON.parse(String(init?.body)) as { payloads: unknown[] }).payloads.length }));
    expect(calls).toEqual(
      expect.arrayContaining([
        { url: 'https://codec.example/decode', ns: 'a', n: 3 },
        { url: 'https://codec.example/decode', ns: 'b', n: 1 },
      ]),
    );
    expect(rows.map((r) => memoValue(r, 'owner'))).toEqual(['alice', 'bob', 'carol']);
    expect(codecError.value).toBeNull();

    await decodeMemos(rows, ['owner', 'tag'], (r) => r.ns, cfg, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not send a payload twice while a request is in flight', async () => {
    const fetchFn = fakeCodec();
    const rows = [row('a', { owner: encrypted('"alice"') })];
    const [first, second] = await Promise.all([decodeMemos(rows, ['owner'], () => 'a', cfg, fetchFn), decodeMemos(rows, ['owner'], () => 'a', cfg, fetchFn)]);
    expect(first + second).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('falls back to the undecoded payload and reports a codec failure', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 502 }));
    const r = row('a', { owner: encrypted('"alice"'), plain: json('"p"') });
    expect(await decodeMemos([r], ['owner', 'plain'], () => 'a', cfg, fetchFn)).toBe(2);
    expect(memoValue(r, 'owner')).toBe('[binary/encrypted payload]');
    expect(memoValue(r, 'plain')).toBe('p');
    expect(codecError.value).toMatch(/502/);
  });
});

describe('inferSortType', () => {
  it('sorts numeric memo columns as numbers and everything else as text', () => {
    expect(inferSortType([2, 10, undefined, 1n, null])).toBe('number');
    expect(inferSortType([2, '10'])).toBe('keyword');
    expect(inferSortType([undefined, ''])).toBe('keyword');
    expect(inferSortType([{ a: 1 }])).toBe('keyword');
  });
});
