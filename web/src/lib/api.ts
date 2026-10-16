/**
 * Thin typed fetch wrapper for the Quest Lite API.
 *
 * Every failure becomes an ApiError carrying the server's structured payload,
 * so components can distinguish 403 (show a permission message) from 409
 * (show the blocker list) from a network failure.
 */

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload.code;
    this.details = payload.details ?? null;
  }

  /** Field-level errors from a 422, keyed by dotted path. */
  get fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    const out: Record<string, string> = {};
    for (const d of this.details as Array<{ path?: string; message?: string }>) {
      if (d?.path) out[d.path] = d.message ?? 'Invalid value';
    }
    return out;
  }

  /** Structured gate/blocker details returned with 409/422. */
  get blockers(): Array<{ key?: string; label: string; detail?: string }> {
    const d = this.details as any;
    if (Array.isArray(d?.blockers)) return d.blockers;
    if (Array.isArray(d?.checks)) return d.checks;
    if (Array.isArray(d)) return d;
    return [];
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Where the Express API lives.
 *
 * - Same origin (default): the SPA and the API are served together, or a dev
 *   server proxies `/api` (see `vite.config.ts`).
 * - Cross origin: set `VITE_API_BASE_URL` at build time to the deployed API
 *   origin, e.g. `https://quest-lite-api.onrender.com`. Used when the SPA is
 *   hosted on Firebase Hosting (static, Spark plan) and the API runs
 *   elsewhere. See `docs/deployment.md`.
 */
const API_BASE: string = (import.meta.env?.VITE_API_BASE_URL as string | undefined) ?? '';

function buildUrl(path: string): string {
  if (path.startsWith('/api')) {
    return `${API_BASE}${path}`;
  }
  return `${API_BASE}/api${path}`;
}

export async function request<T = any>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: API_BASE ? 'include' : 'same-origin',
    headers: { Accept: 'application/json' },
    signal: opts.signal,
  };
  if (opts.body !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path), init);
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, {
      code: 'network',
      message: API_BASE
        ? `Could not reach the API at ${API_BASE}. Check that it is running and that its origin allows this site.`
        : 'Could not reach the server. Check your connection and try again.',
    });
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const body: ApiErrorPayload = payload?.error ?? {
      code: res.status === 401 ? 'unauthorized' : 'error',
      message:
        res.status === 401
          ? 'Your session has expired. Please sign in again.'
          : `Request failed (${res.status}).`,
    };
    const error = new ApiError(res.status, body);
    // A 401 anywhere means the session is gone — let the app react once.
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('ql:unauthorized'));
    }
    throw error;
  }

  return payload as T;
}

export const get = <T = any>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts);
export const post = <T = any>(path: string, body?: unknown, opts?: RequestOptions) =>
  request<T>('POST', path, { ...opts, body });
export const patch = <T = any>(path: string, body?: unknown, opts?: RequestOptions) =>
  request<T>('PATCH', path, { ...opts, body });
export const put = <T = any>(path: string, body?: unknown, opts?: RequestOptions) =>
  request<T>('PUT', path, { ...opts, body });
export const del = <T = any>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts);

/** Serialises a query object, dropping empty values. */
export function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
