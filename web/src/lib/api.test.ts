import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, MAX_QUERY_VALUE_LENGTH, api, buildUrl, loginUrl, parseRetryAfter, request, seg, sessionExpired } from './api';

const fetchMock = vi.fn<typeof fetch>();

function lastCall(): { url: string; init: RequestInit; headers: Record<string, string> } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  const init = call[1] ?? {};
  return { url: String(call[0]), init, headers: (init.headers ?? {}) as Record<string, string> };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the request to fail');
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  sessionExpired.value = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildUrl', () => {
  it('skips empty values and repeats array keys', () => {
    expect(buildUrl('/a', { q: 'x y', n: 5, b: false, skip: undefined, nil: null, arr: ['1', '2'] })).toBe(
      '/a?q=x+y&n=5&b=false&arr=1&arr=2',
    );
    expect(buildUrl('/a', {})).toBe('/a');
  });

  it('encodes path segments exactly once', () => {
    expect(seg('a/b c%')).toBe('a%2Fb%20c%25');
  });
});

describe('request', () => {
  it('sends GET without the CSRF header and with same-origin credentials', async () => {
    fetchMock.mockResolvedValue(json({ ok: 1 }));
    await expect(api.get('/api/v1/namespaces', { pageSize: 10 })).resolves.toEqual({ ok: 1 });
    const { url, init, headers } = lastCall();
    expect(url).toBe('/api/v1/namespaces?pageSize=10');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
    expect(headers['X-Tempolens']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('adds X-Tempolens and a JSON body on non-GET requests', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.post('/auth/logout')).resolves.toBeUndefined();
    expect(lastCall().headers['X-Tempolens']).toBe('1');
    expect(lastCall().headers['Content-Type']).toBeUndefined();

    fetchMock.mockResolvedValue(json({}));
    await api.post('/api/v1/x', { reason: 'r' });
    expect(lastCall().headers).toMatchObject({ 'X-Tempolens': '1', 'Content-Type': 'application/json' });
    expect(lastCall().init.body).toBe('{"reason":"r"}');

    fetchMock.mockResolvedValue(json({}));
    await api.delete('/api/v1/y');
    expect(lastCall().init.method).toBe('DELETE');
    expect(lastCall().headers['X-Tempolens']).toBe('1');
  });

  it('resolves an empty success body to an empty object', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    await expect(request('/api/v1/namespaces/n/workflows')).resolves.toEqual({});
  });

  it('short-circuits with a synthetic 414 when a query value is too long', async () => {
    const err = await rejection(api.get('/api/v1/w', { query: 'x'.repeat(MAX_QUERY_VALUE_LENGTH + 1) }));
    expect(err.status).toBe(414);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(json({}));
    await api.get('/api/v1/w', { query: 'x'.repeat(MAX_QUERY_VALUE_LENGTH) });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('parses google.rpc.Status errors', async () => {
    fetchMock.mockResolvedValue(json({ code: 7, message: 'permission denied', details: [] }, 403));
    const err = await rejection(api.post('/api/v1/t', {}));
    expect(err).toMatchObject({ status: 403, code: 7, message: 'permission denied', details: [] });
    expect(sessionExpired.value).toBe(false);
  });

  it('falls back to the status line when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    const err = await rejection(api.get('/api/v1/t'));
    expect(err).toMatchObject({ status: 502, code: undefined, message: '502 Bad Gateway' });
  });

  it('sets sessionExpired on 401', async () => {
    fetchMock.mockResolvedValue(json({ code: 16, message: 'unauthenticated', details: [] }, 401));
    const err = await rejection(api.get('/api/x/me'));
    expect(err.status).toBe(401);
    expect(sessionExpired.value).toBe(true);
  });

  it('exposes Retry-After on 429', async () => {
    fetchMock.mockResolvedValue(json({ code: 8, message: 'slow down', details: [] }, 429, { 'Retry-After': '3' }));
    const err = await rejection(api.get('/api/x/workflows'));
    expect(err).toMatchObject({ status: 429, code: 8, retryAfterMs: 3000 });
  });

  it('maps a transport failure to status 0 and rethrows aborts', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect((await rejection(api.get('/a'))).status).toBe(0);

    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(api.get('/a')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a success body that is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));
    expect((await rejection(api.get('/a'))).status).toBe(200);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('Tue, 27 Oct 2026 08:00:10 GMT', Date.parse('2026-10-27T08:00:00Z'))).toBe(10_000);
    expect(parseRetryAfter('Tue, 27 Oct 2026 07:00:00 GMT', Date.parse('2026-10-27T08:00:00Z'))).toBe(0);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('loginUrl', () => {
  it('keeps only pathname and search', () => {
    expect(loginUrl({ pathname: '/namespaces/a/workflows', search: '?query=WorkflowType%3D%22x%22' })).toBe(
      '/auth/sso?returnTo=%2Fnamespaces%2Fa%2Fworkflows%3Fquery%3DWorkflowType%253D%2522x%2522',
    );
    expect(loginUrl({ pathname: '/', search: '' })).toBe('/auth/sso?returnTo=%2F');
  });
});
