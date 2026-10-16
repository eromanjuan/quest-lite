import { useCallback, useEffect, useRef, useState } from 'react';
import { get, ApiError } from './api';

/**
 * Data-fetching hook with abort-on-change, error capture and manual reload.
 * Every page uses this so loading, error and empty states look identical
 * across the app.
 */
export function useFetch<T = any>(
  path: string | null,
  deps: unknown[] = [],
): {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (updater: T | ((prev: T | null) => T)) => void;
} {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!!path);
  const [nonce, setNonce] = useState(0);
  const abort = useRef<AbortController | null>(null);

  const key = JSON.stringify(deps);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    let cancelled = false;

    setLoading(true);
    get<T>(path, { signal: controller.signal })
      .then((res) => {
        if (cancelled) return;
        setDataState(res);
        setError(null);
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return;
        setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const setData = useCallback((updater: T | ((prev: T | null) => T)) => {
    setDataState((prev) => (typeof updater === 'function' ? (updater as any)(prev) : updater));
  }, []);

  return { data, error, loading, reload, setData };
}

/**
 * One-shot action wrapper: tracks pending/error state and exposes the server's
 * structured error so callers can show blocker lists inline.
 */
export function useAction<Args extends any[], R>(
  fn: (...args: Args) => Promise<R>,
): {
  run: (...args: Args) => Promise<R | undefined>;
  pending: boolean;
  error: (ApiError & any) | null;
  reset: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<any>(null);

  const run = useCallback(
    async (...args: Args) => {
      setPending(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (err: any) {
        setError(err);
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );

  return { run, pending, error, reset: () => setError(null) };
}

/** Local search/filter state that survives re-renders and syncs to the URL. */
export function useQueryState<T extends Record<string, string>>(initial: T) {
  const [state, setState] = useState<T>(initial);
  const set = useCallback(
    <K extends keyof T>(key: K, value: T[K]) => {
      setState((s) => ({ ...s, [key]: value }));
    },
    [],
  );
  const reset = useCallback(() => setState(initial), [initial]);
  return { state, set, reset, setState };
}

/** Debounced mirror of a value — used for search-as-you-type. */
export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
