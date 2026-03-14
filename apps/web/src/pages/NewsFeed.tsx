/**
 * News Feed Page — `apps/web/src/pages/NewsFeed.tsx`
 *
 * Route-level page component rendered at `/news` inside DashboardLayout.
 * This is the default landing page of the Trading Intelligence dashboard.
 * Displays a live, paginated feed of financial news articles aggregated
 * from 30+ sources across US stocks, Indian equities, cryptocurrency,
 * and social sentiment channels.
 *
 * Key features:
 * - **Market tab navigation** — Filter articles by market category
 *   (All, US, India, Crypto, Social) via pill-style tab buttons that
 *   apply market filters through the {@link useNews} hook.
 * - **IntersectionObserver-based infinite scroll** — Automatically loads
 *   the next page of articles when the user scrolls near the bottom of
 *   the feed, using a 1px sentinel element observed by IntersectionObserver.
 * - **Polling-based refresh** — Auto-refreshes every 30 seconds per
 *   AAP §0.6.2 (NO WebSocket — polling only).
 * - **Article accumulation** — Successive pages are appended to a local
 *   accumulator with deduplication by article ID, enabling seamless
 *   infinite scroll without losing previously loaded content.
 * - **NewsCard rendering** — Each article is rendered using the NewsCard
 *   component with source badge, market label, sentiment badge, symbol
 *   badges, analysis status, and relative timestamps.
 *
 * Architecture:
 * - Composes `useNews` hook for paginated data fetching with market filter
 * - Uses IntersectionObserver API for performant infinite scroll triggering
 * - Dark theme CSS custom properties from globals.css
 * - TypeScript strict mode: no `any`, `exactOptionalPropertyTypes` enabled
 * - No component library — custom HTML + CSS custom properties only
 *
 * @module apps/web/src/pages/NewsFeed
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import clsx from 'clsx';

import { useNews } from '../hooks/useNews';
import NewsCard from '../components/NewsCard';
import { Market } from '../types';
import type { NewsArticle } from '../types';

// ---------------------------------------------------------------------------
// Market Tab Configuration
// ---------------------------------------------------------------------------

/**
 * Tab definitions for the market filter navigation bar.
 *
 * The `null` value represents "All Markets" — no market filter is applied.
 * Each non-null tab maps to a {@link Market} enum value matching the
 * PostgreSQL enum definitions in the backend schema.
 *
 * Per AAP §0.5.3: "Real-time news articles grouped by market
 * (US, India, Crypto, Social)"
 */
const MARKET_TABS: ReadonlyArray<{
  readonly value: Market | null;
  readonly label: string;
  readonly icon: string;
}> = [
  { value: null, label: 'All', icon: '🌐' },
  { value: Market.US_STOCK, label: 'US', icon: '🇺🇸' },
  { value: Market.INDIAN_EQUITY, label: 'India', icon: '🇮🇳' },
  { value: Market.CRYPTO, label: 'Crypto', icon: '₿' },
  { value: Market.SOCIAL, label: 'Social', icon: '💬' },
] as const;

// ---------------------------------------------------------------------------
// NewsFeed Page Component
// ---------------------------------------------------------------------------

/**
 * Live news feed page with market tabs and IntersectionObserver-based
 * infinite scroll.
 *
 * The component maintains a local `allArticles` accumulator that appends
 * new pages of articles as the user scrolls. When the market tab changes,
 * the accumulator resets to show only articles from the selected market.
 *
 * The IntersectionObserver watches a sentinel `<div>` at the bottom of
 * the article list. When the sentinel enters the viewport and more pages
 * are available, the hook's `setPage` is called to fetch the next page.
 *
 * Polling via the `useNews` hook refreshes the current page every
 * 30 seconds — per AAP §0.6.2, NO WebSocket is used.
 */
export default function NewsFeed() {
  // -------------------------------------------------------------------------
  // Data hook — paginated news articles with market filter and 30s polling
  // -------------------------------------------------------------------------

  const {
    articles,
    pagination,
    loading,
    error,
    refetch,
    setPage,
    setMarket,
  } = useNews({ pollingInterval: 30_000 });

  // -------------------------------------------------------------------------
  // Local state — active market tab + accumulated articles for infinite scroll
  // -------------------------------------------------------------------------

  /** Currently active market tab filter. `null` = All Markets. */
  const [activeMarket, setActiveMarket] = useState<Market | null>(null);

  /**
   * Accumulated articles across all loaded pages for infinite scroll.
   * Reset when the market tab changes; appended when new pages load.
   */
  const [allArticles, setAllArticles] = useState<NewsArticle[]>([]);

  /** Current page being displayed (1-indexed), tracked locally for accumulation. */
  const [currentPage, setCurrentPage] = useState<number>(1);

  // -------------------------------------------------------------------------
  // Ref — IntersectionObserver sentinel element
  // -------------------------------------------------------------------------

  /** Ref to the invisible sentinel div at the bottom of the article list. */
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // -------------------------------------------------------------------------
  // Effect — Accumulate articles from paginated API responses
  // -------------------------------------------------------------------------

  /**
   * Whenever the `articles` array from the hook updates, append new articles
   * to the accumulator. On page 1 (initial load or tab change), replace the
   * accumulator entirely. On subsequent pages, deduplicate by article ID
   * before appending to prevent duplicates from polling refreshes.
   */
  useEffect(() => {
    if (articles.length === 0) return;

    if (currentPage === 1) {
      /* First page or tab change — replace all articles */
      setAllArticles(articles);
    } else {
      /* Subsequent pages — append, deduplicating by article ID */
      setAllArticles((prev) => {
        const existingIds = new Set(prev.map((a) => a.id));
        const newArticles = articles.filter((a) => !existingIds.has(a.id));
        return [...prev, ...newArticles];
      });
    }
  }, [articles, currentPage]);

  // -------------------------------------------------------------------------
  // Handler — Market tab selection
  // -------------------------------------------------------------------------

  /**
   * Handles market tab clicks. Resets the accumulated articles, the local
   * page counter, and delegates to the useNews hook's setMarket which also
   * resets the hook's internal page to 1.
   */
  const handleMarketChange = useCallback(
    (market: Market | null): void => {
      setActiveMarket(market);
      setCurrentPage(1);
      setAllArticles([]);
      setMarket(market);
    },
    [setMarket],
  );

  // -------------------------------------------------------------------------
  // Derived state — whether more pages are available
  // -------------------------------------------------------------------------

  const hasMore: boolean =
    pagination !== null && currentPage < pagination.totalPages;

  // -------------------------------------------------------------------------
  // Effect — IntersectionObserver-based infinite scroll
  // -------------------------------------------------------------------------

  /**
   * Observes the sentinel element at the bottom of the article list.
   * When the sentinel enters the viewport and more pages are available,
   * increments the page counter and triggers the next page fetch.
   *
   * Uses IntersectionObserver API for performant scroll detection,
   * avoiding expensive scroll event listeners.
   */
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !loading && hasMore) {
          const nextPage = currentPage + 1;
          setCurrentPage(nextPage);
          setPage(nextPage);
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [loading, hasMore, currentPage, setPage]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div>
      {/* ── Page Header ───────────────────────────────────────────── */}
      <div className="page-header">
        <h1 className="page-title">📰 News Feed</h1>
        <p className="text-secondary text-sm">
          Live financial news from 30+ sources
        </p>
      </div>

      {/* ── Market Tab Navigation ─────────────────────────────────── */}
      <div className="market-tabs" role="tablist" aria-label="Filter by market">
        {MARKET_TABS.map((tab) => (
          <button
            key={tab.label}
            type="button"
            role="tab"
            aria-selected={activeMarket === tab.value}
            className={clsx(
              'tab-button',
              activeMarket === tab.value && 'tab-button-active',
            )}
            onClick={() => {
              handleMarketChange(tab.value);
            }}
          >
            <span aria-hidden="true">{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* ── Error State ───────────────────────────────────────────── */}
      {error !== null && (
        <div className="error-banner" role="alert">
          <p>Failed to load news: {error}</p>
          <button type="button" className="btn btn-outline" onClick={refetch}>
            Retry
          </button>
        </div>
      )}

      {/* ── Loading State (initial load only) ─────────────────────── */}
      {loading && allArticles.length === 0 && error === null && (
        <div className="loading-container">
          <div className="animate-pulse">Loading news...</div>
        </div>
      )}

      {/* ── Empty State ───────────────────────────────────────────── */}
      {!loading && allArticles.length === 0 && error === null && (
        <div className="empty-state">
          <p className="text-secondary">No news articles found</p>
          <p className="text-xs text-secondary">
            Try selecting a different market or check back later
          </p>
        </div>
      )}

      {/* ── Articles Card Grid ────────────────────────────────────── */}
      {allArticles.length > 0 && (
        <div className="card-grid">
          {allArticles.map((article) => (
            <NewsCard key={article.id} article={article} />
          ))}
        </div>
      )}

      {/* ── Infinite Scroll Sentinel ──────────────────────────────── */}
      <div ref={sentinelRef} className="sentinel" />

      {/* ── Loading More Indicator (during infinite scroll) ───────── */}
      {loading && allArticles.length > 0 && (
        <div className="loading-more">
          <div className="animate-pulse">Loading more...</div>
        </div>
      )}

      {/* ── Pagination Info ───────────────────────────────────────── */}
      {pagination !== null && allArticles.length > 0 && (
        <div className="pagination-info text-xs text-secondary">
          Showing {String(allArticles.length)} of{' '}
          {String(pagination.total)} articles
        </div>
      )}
    </div>
  );
}
