/**
 * News Feed Data Hook — `apps/web/src/hooks/useNews.ts`
 *
 * Custom React hook that wraps the generic {@link useApi} hook specifically
 * for the `GET /api/news` endpoint. Provides paginated news articles with
 * market filtering, automatic polling-based refresh, and convenient state
 * setters for page navigation and market selection.
 *
 * Key behaviours:
 * - **Polling-based refresh** (NOT WebSocket) — per AAP §0.6.2: "the
 *   dashboard uses polling-based refresh". Default polling interval is
 *   30 000 ms (30 seconds).
 * - **Market filter with page reset** — when the user changes the market
 *   filter, pagination automatically resets to page 1 to avoid showing
 *   an out-of-range page for the new result set.
 * - **Composes `useApi`** — delegates all HTTP fetching, abort-controller
 *   management, loading/error state, and SWR-like polling to the generic
 *   base hook, passing `/news` as the endpoint with pagination and filter
 *   query parameters.
 *
 * Consumed by: `NewsFeed.tsx` page component.
 *
 * @module apps/web/src/hooks/useNews
 */

import { useState, useCallback } from 'react';

import { useApi } from './useApi';
import type {
  NewsArticle,
  PaginatedResponse,
  PaginationMeta,
  Market,
} from '../types';

// ---------------------------------------------------------------------------
// Hook Configuration Interface
// ---------------------------------------------------------------------------

/**
 * Configuration options accepted by the {@link useNews} hook.
 *
 * All fields are optional. When omitted, sensible defaults are applied:
 * - `page` defaults to `1`
 * - `limit` defaults to `20`
 * - `market` defaults to `null` (all markets)
 * - `pollingInterval` defaults to `30000` (30 seconds)
 *
 * @example
 * ```typescript
 * const news = useNews({ page: 1, limit: 10, market: Market.CRYPTO });
 * ```
 */
export interface UseNewsParams {
  /** Current page number (1-indexed). Defaults to `1`. */
  page?: number;

  /** Maximum items per page. Defaults to `20`. */
  limit?: number;

  /**
   * Market filter.
   * - A {@link Market} enum value filters articles to that market only.
   * - `null` means "all markets" — no market constraint applied.
   *
   * Defaults to `null`.
   */
  market?: Market | null;

  /**
   * Auto-refresh interval in milliseconds.
   * - `0` or `undefined` → use the default of `30000` (30 s).
   * - Positive number → `setInterval` re-fetches at this cadence.
   *
   * Per AAP §0.6.2 the dashboard uses polling-based refresh, not WebSocket.
   * Defaults to `30000`.
   */
  pollingInterval?: number;
}

// ---------------------------------------------------------------------------
// Hook Return Type
// ---------------------------------------------------------------------------

/**
 * Return value of the {@link useNews} hook.
 *
 * Provides the fetched news articles, pagination metadata, loading / error
 * state, a manual re-fetch trigger, and state setters for page navigation
 * and market filtering.
 *
 * @example
 * ```typescript
 * const {
 *   articles,
 *   pagination,
 *   loading,
 *   error,
 *   refetch,
 *   setPage,
 *   setMarket,
 * } = useNews();
 * ```
 */
export interface UseNewsReturn {
  /** Array of news articles for the current page. Empty array while loading. */
  articles: NewsArticle[];

  /**
   * Pagination metadata (page, limit, total, totalPages).
   * `null` while data has not yet been fetched.
   */
  pagination: PaginationMeta | null;

  /** `true` while a network request is in flight; `false` otherwise. */
  loading: boolean;

  /** Human-readable error message, or `null` when there is no error. */
  error: string | null;

  /** Callback to manually re-trigger the data fetch (e.g., pull-to-refresh). */
  refetch: () => void;

  /**
   * Page navigation setter.
   * Updates the internal page state which triggers a re-fetch via `useApi`.
   */
  setPage: (page: number) => void;

  /**
   * Market filter setter.
   * When the market changes, pagination automatically resets to page 1
   * to prevent displaying an invalid page index for the new result set.
   */
  setMarket: (market: Market | null) => void;
}

// ---------------------------------------------------------------------------
// Default Constants
// ---------------------------------------------------------------------------

/** Default number of items per page when `limit` is not provided. */
const DEFAULT_LIMIT = 20;

/** Default polling interval in milliseconds (30 seconds). */
const DEFAULT_POLLING_INTERVAL = 30_000;

/** Default starting page number. */
const DEFAULT_PAGE = 1;

// ---------------------------------------------------------------------------
// Hook Implementation
// ---------------------------------------------------------------------------

/**
 * News feed data hook composing {@link useApi} for the `/api/news` endpoint.
 *
 * Manages internal state for page number and market filter, builds the
 * appropriate query parameters, and delegates HTTP fetching to the generic
 * `useApi` hook. Provides a `setMarket` callback that resets pagination
 * to page 1 whenever the market filter changes.
 *
 * @param params - Optional configuration for pagination, market filter, and
 *                 polling interval. All fields have sensible defaults.
 * @returns An object with articles, pagination metadata, loading/error state,
 *          a refetch trigger, and state setters for page and market.
 *
 * @example
 * ```tsx
 * function NewsFeed() {
 *   const { articles, pagination, loading, error, setPage, setMarket } = useNews();
 *
 *   if (loading) return <Spinner />;
 *   if (error) return <ErrorBanner message={error} />;
 *
 *   return (
 *     <>
 *       <MarketTabs onSelect={setMarket} />
 *       {articles.map((a) => <NewsCard key={a.id} article={a} />)}
 *       <Pagination meta={pagination} onPageChange={setPage} />
 *     </>
 *   );
 * }
 * ```
 */
export function useNews(params?: UseNewsParams): UseNewsReturn {
  // -------------------------------------------------------------------------
  // Internal state — page number and market filter
  // -------------------------------------------------------------------------

  const [page, setPage] = useState<number>(params?.page ?? DEFAULT_PAGE);
  const [market, setMarket] = useState<Market | null>(
    params?.market ?? null,
  );

  // -------------------------------------------------------------------------
  // Derived configuration (non-state, re-computed on each render)
  // -------------------------------------------------------------------------

  const limit: number = params?.limit ?? DEFAULT_LIMIT;
  const pollingInterval: number =
    params?.pollingInterval ?? DEFAULT_POLLING_INTERVAL;

  // -------------------------------------------------------------------------
  // Build query parameters for the API request
  // -------------------------------------------------------------------------

  const queryParams: Record<string, string | number | boolean | undefined> = {
    page,
    limit,
    ...(market !== null ? { market } : {}),
  };

  // -------------------------------------------------------------------------
  // Delegate to the generic useApi hook
  // -------------------------------------------------------------------------

  const { data, loading, error, refetch } = useApi<
    PaginatedResponse<NewsArticle>
  >('/news', {
    params: queryParams,
    pollingInterval,
  });

  // -------------------------------------------------------------------------
  // Extract articles and pagination from the paginated response envelope
  // -------------------------------------------------------------------------

  const articles: NewsArticle[] = data?.data ?? [];
  const pagination: PaginationMeta | null = data?.pagination ?? null;

  // -------------------------------------------------------------------------
  // Market filter setter — resets to page 1 on change
  // -------------------------------------------------------------------------

  /**
   * Memoised market filter handler that also resets the page to 1.
   *
   * When the market category changes, the total number of results changes
   * as well, so the current page index may become invalid. Resetting to
   * page 1 guarantees the user always sees a valid first page of results.
   */
  const handleSetMarket = useCallback(
    (newMarket: Market | null): void => {
      setMarket(newMarket);
      setPage(DEFAULT_PAGE);
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Return the hook interface
  // -------------------------------------------------------------------------

  return {
    articles,
    pagination,
    loading,
    error,
    refetch,
    setPage,
    setMarket: handleSetMarket,
  };
}
