import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchNamespaces, namespaceName } from './namespaces';

const ns = (name: string) => ({ namespaceInfo: { name } });

afterEach(() => vi.unstubAllGlobals());

describe('fetchNamespaces', () => {
  it('follows page tokens, sorts, and hides temporal-system by default', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ namespaces: [ns('zeta'), ns('temporal-system')], nextPageToken: 'p2' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ namespaces: [ns('alpha')] })));
    vi.stubGlobal('fetch', fetchMock);

    const list = await fetchNamespaces(false);
    expect(list.map(namespaceName)).toEqual(['alpha', 'zeta']);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v1/namespaces?pageSize=200');
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('/api/v1/namespaces?pageSize=200&nextPageToken=p2');
  });

  it('keeps temporal-system when enabled and tolerates an empty body', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ namespaces: [ns('temporal-system')] }))));
    expect((await fetchNamespaces(true)).map(namespaceName)).toEqual(['temporal-system']);

    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('')));
    expect(await fetchNamespaces(false)).toEqual([]);
  });
});
