/**
 * Generic Data Fetching Hook — `apps/web/src/hooks/useApi.ts`
 *
 * Foundational, type-safe, SWR-like data fetching hook that all other hooks
 * (`useNews`, `useOpportunities`) build upon. Provides:
 *
 * - **Loading / error / data state management** via React `useState`
 * - **SWR-like polling** with a configurable `pollingInterval` (milliseconds)
 * - **AbortController** for automatic request cancellation on unmount or
 *   when parameters change, preventing race conditions and memory leaks
 * - **Automatic re-fetch** when the URL or query parameters change
 * - **TypeScript generics** (`useApi<T>`) for fully type-safe responses
 * - **Mounted-component guard** to prevent state updates after unmount
 *
 * This hook wraps the `apiGet` helper from `../lib/api-client`, which
 * returns the standard `ApiResponse<T>` envelope. The hook inspects the
 * `success` field of the envelope to route data into either the `data`
 * or `error` state slot.
 *
 * Per AAP §0.6.2 the frontend uses polling-based refresh — no WebSocket
 * or real-time subscriptions.
 *
 * @module apps/web/src/hooks/useApi
 */

import { useState, useEffect, useCallback, useRef } from 'react';

import { apiGet } from '../lib/api-client';
import type { ApiResponse } from '../types';

// ---------------------------------------------------------------------------
// Hook Configuration Interface
// ---------------------------------------------------------------------------

/**
 * Configuration options accepted by the `useApi` hook.
 *
 * All fields are optional; when omitted the hook fetches immediately
 * with no query parameters and no polling.
 *
 * @example
 * ```typescript
 * const options: UseApiOptions = {
 *   params: { market: 'US', page: 1, limit: 20 },
 *   pollingInterval: 30_000, // Re-fetch every 30 seconds
 *   enabled: true,
 * };
 * ```
 */
export interface UseApiOptions {
  /**
   * URL query parameters forwarded to `apiGet`.
   *
   * Keys with `undefined` values are automatically filtered out by Axios
   * so callers can safely pass optional filter values without pre-cleaning.
   */
  params?: Record<string, string | number | boolean | undefined>;

  /**
   * Auto-refresh interval in milliseconds.
   *
   * - `0` or `undefined` → no polling (single fetch only)
   * - Positive number → `setInterval` re-fetches at this cadence
   *
   * Per AAP §0.6.2 the dashboard uses polling-based refresh, not WebSocket.
   */
  pollingInterval?: number;

  /**
   * Whether to auto-fetch on mount and when dependencies change.
   *
   * Defaults to `true`. Set to `false` for conditional data loading
   * (e.g., wait until a prerequisite value is available).
   */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Hook Return Type
// ---------------------------------------------------------------------------

/**
 * Return value of the `useApi` hook.
 *
 * Matches the shape of `ApiHookResult<T>` defined in `../types/index.ts`
 * so that consuming components can destructure a uniform contract from
 * any data-fetching hook.
 *
 * @typeParam T - The type of the fetched data payload.
 */
export interface UseApiReturn<T> {
  /** Fetched data payload — `null` while loading or when an error occurs. */
  data: T | null;

  /** `true` while a network request is in-flight; `false` otherwise. */
  loading: boolean;

  /** Human-readable error message, or `null` when there is no error. */
  error: string | null;

  /** Callback to manually re-trigger the data fetch (e.g., pull-to-refresh). */
  refetch: () => void;
}

// ---------------------------------------------------------------------------
// Hook Implementation
// ---------------------------------------------------------------------------

/**
 * Generic, type-safe data fetching hook with SWR-like polling.
 *
 * Wraps `apiGet<T>` with React state management, automatic request
 * cancellation via `AbortController`, and optional interval-based
 * re-fetching.
 *
 * @typeParam T - The expected payload type inside `ApiResponse.data`.
 * @param url     - Endpoint path relative to `/api` (e.g., `'/news'`).
 * @param options - Optional configuration (query params, polling, enabled).
 * @returns An object with `data`, `loading`, `error`, and `refetch`.
 *
 * @example
 * ```tsx
 * const { data, loading, error, refetch } = useApi<NewsArticle[]>('/news', {
 *   params: { market: 'US', page: 1 },
 *   pollingInterval: 60_000,
 * });
 *
 * if (loading) return <Spinner />;
 * if (error) return <ErrorBanner message={error} />;
 * return <NewsList articles={data} onRefresh={refetch} />;
 * ```
 */
export function useApi<T>(
  url: string,
  options?: UseApiOptions,
): UseApiReturn<T> {
  // -----------------------------------------------------------------------
  // State — data, loading, error
  // -----------------------------------------------------------------------
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // -----------------------------------------------------------------------
  // Refs — AbortController and mounted flag
  // -----------------------------------------------------------------------

  /** Holds the AbortController for the current in-flight request. */
  const abortControllerRef = useRef<AbortController | null>(null);

  /** Tracks whether the owning component is still mounted. */
  const mountedRef = useRef<boolean>(true);

  // -----------------------------------------------------------------------
  // Serialised params key — ensures `useCallback` re-memoises when the
  // *contents* of `params` change rather than on referential identity.
  // -----------------------------------------------------------------------
  const paramsKey = JSON.stringify(options?.params);

  // -----------------------------------------------------------------------
  // Core fetch function (memoised)
  // -----------------------------------------------------------------------

  /**
   * Internal fetch routine.
   *
   * 1. Aborts any previously in-flight request to prevent race conditions.
   * 2. Creates a fresh `AbortController` for the new request.
   * 3. Calls `apiGet<T>` with the URL, query params, and abort signal.
   * 4. Routes the response into `data` or `error` based on `response.success`.
   * 5. Guards every `setState` call behind `mountedRef.current` to avoid
   *    React warnings about updates on unmounted components.
   */
  const fetchData = useCallback(async (): Promise<void> => {
    // Cancel any in-flight request to avoid stale data race conditions
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create a fresh AbortController for this request cycle
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      // Parse the serialised params back into an object for apiGet
      const parsedParams = paramsKey
        ? (JSON.parse(paramsKey) as Record<string, string | number | boolean | undefined>)
        : undefined;

      const response: ApiResponse<T> = await apiGet<T>(
        url,
        parsedParams,
        controller.signal,
      );

      // Only update state if the component is still mounted
      if (mountedRef.current) {
        if (response.success) {
          setData(response.data);
          setError(null);
        } else {
          setError(response.error ?? 'An unknown error occurred');
          setData(null);
        }
      }
    } catch (err: unknown) {
      // AbortError is expected when a request is intentionally cancelled
      // (e.g., on unmount or rapid param changes) — silently discard it.
      // The check must be environment-agnostic: DOMException may or may not
      // extend Error depending on the JS runtime (Node.js, jsdom, browser).
      const isAbortError =
        typeof err === 'object' &&
        err !== null &&
        'name' in err &&
        (err as { name: unknown }).name === 'AbortError';

      if (isAbortError) {
        return;
      }

      // For all other errors, update state if still mounted
      if (mountedRef.current) {
        const message =
          err instanceof Error
            ? err.message
            : 'An unexpected error occurred';
        setError(message);
        setData(null);
      }
    } finally {
      // Always clear loading when the request settles (if mounted)
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [url, paramsKey]);

  // -----------------------------------------------------------------------
  // Effect — Initial fetch and re-fetch on dependency changes
  // -----------------------------------------------------------------------

  useEffect(() => {
    mountedRef.current = true;

    // When `enabled` is explicitly `false`, skip fetching and reset loading
    if (options?.enabled === false) {
      setLoading(false);
      return;
    }

    fetchData();

    // Cleanup: mark unmounted and abort any in-flight request
    return () => {
      mountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [fetchData, options?.enabled]);

  // -----------------------------------------------------------------------
  // Effect — SWR-like polling interval
  // -----------------------------------------------------------------------

  useEffect(() => {
    // Guard: skip polling when interval is absent, non-positive, or disabled
    if (
      !options?.pollingInterval ||
      options.pollingInterval <= 0 ||
      options?.enabled === false
    ) {
      return;
    }

    const intervalId = setInterval((): void => {
      fetchData();
    }, options.pollingInterval);

    // Cleanup: clear the interval when deps change or component unmounts
    return () => {
      clearInterval(intervalId);
    };
  }, [fetchData, options?.pollingInterval, options?.enabled]);

  // -----------------------------------------------------------------------
  // Memoised refetch — stable function reference for consumers
  // -----------------------------------------------------------------------

  const refetch = useCallback((): void => {
    fetchData();
  }, [fetchData]);

  // -----------------------------------------------------------------------
  // Return value
  // -----------------------------------------------------------------------

  return {
    data,
    loading,
    error,
    refetch,
  };
}
