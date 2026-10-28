import { signal } from '@preact/signals';

/** Upstream's limit: any single query-string value above this short-circuits with 414. */
export const MAX_QUERY_VALUE_LENGTH = 15_000;

/** Set when any API call answers 401; the app redirects to login (contract §1.3). */
export const sessionExpired = signal(false);

export type QueryValue = string | number | boolean | null | undefined | readonly string[];
export type Query = Record<string, QueryValue>;
type Method = 'GET' | 'POST' | 'DELETE';

export interface RequestOptions {
  method?: Method;
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  /** Typed confirmation for destructive writes, sent percent-encoded as `X-Tempolens-Confirm`. */
  confirm?: string;
  /** Reason for writes whose request has no reason field, sent percent-encoded as `X-Tempolens-Reason`. */
  reason?: string;
}

/**
 * An HTTP or transport failure. `status` is the HTTP status (0 for a network
 * failure, 414 for the client-side query length guard); `code` is the gRPC
 * code from the google.rpc.Status body when the server sent one.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  readonly details: readonly unknown[];
  readonly retryAfterMs: number | undefined;

  constructor(
    status: number,
    message: string,
    opts: { code?: number; details?: readonly unknown[]; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = opts.code;
    this.details = opts.details ?? [];
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Encodes one path segment exactly once (contract §2 rule 1). */
export const seg = (value: string): string => encodeURIComponent(value);

/** Builds `path?query`; undefined and null values are skipped, arrays repeat the key. */
export function buildUrl(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function oversizedQueryKey(query: Query): string | undefined {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [String(value)];
    if (values.some((v) => v.length > MAX_QUERY_VALUE_LENGTH)) return key;
  }
  return undefined;
}

/** Parses `Retry-After` (delta seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

interface RpcStatus {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

async function errorFromResponse(res: Response): Promise<ApiError> {
  let status: RpcStatus = {};
  try {
    const parsed: unknown = JSON.parse(await res.text());
    if (parsed && typeof parsed === 'object') status = parsed as RpcStatus;
  } catch {
    // Not a google.rpc.Status body (for example a proxy error page).
  }
  const retryAfterMs = res.status === 429 ? parseRetryAfter(res.headers.get('Retry-After')) : undefined;
  const message =
    typeof status.message === 'string' && status.message
      ? status.message
      : `${res.status} ${res.statusText || 'Request failed'}`.trim();
  return new ApiError(res.status, message, {
    code: typeof status.code === 'number' ? status.code : undefined,
    details: Array.isArray(status.details) ? status.details : [],
    retryAfterMs,
  });
}

/**
 * Same-origin JSON request. Non-GET requests carry `X-Tempolens: 1` (the
 * server's CSRF check also needs the browser's Origin header). A 401 sets
 * `sessionExpired`. An empty success body resolves to `{}`, because the
 * gateway omits empty fields, and 204 resolves to undefined.
 */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query = {}, body, signal: abortSignal, confirm, reason } = opts;

  const tooLong = oversizedQueryKey(query);
  if (tooLong !== undefined) {
    throw new ApiError(414, `The "${tooLong}" value is longer than ${MAX_QUERY_VALUE_LENGTH} characters.`);
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Tempolens'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Header values must be ASCII; the server decodes them (contract §1.6).
  if (confirm !== undefined) headers['X-Tempolens-Confirm'] = encodeURIComponent(confirm);
  if (reason !== undefined) headers['X-Tempolens-Reason'] = encodeURIComponent(reason);

  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: abortSignal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, `Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    if (res.status === 401) sessionExpired.value = true;
    throw await errorFromResponse(res);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, 'The server returned a response that is not valid JSON.');
  }
}

export const api = {
  get: <T>(path: string, query?: Query, abortSignal?: AbortSignal) =>
    request<T>(path, { query, signal: abortSignal }),
  post: <T>(path: string, body?: unknown, query?: Query) => request<T>(path, { method: 'POST', body, query }),
  delete: <T>(path: string, query?: Query) => request<T>(path, { method: 'DELETE', query }),
};

/** Login URL that returns to the current page; only pathname and search are kept (contract §4.1). */
export function loginUrl(loc: Pick<Location, 'pathname' | 'search'> = window.location): string {
  return buildUrl('/auth/sso', { returnTo: loc.pathname + loc.search });
}
