/**
 * News Feed Page — `apps/web/src/pages/NewsFeed.tsx`
 *
 * Route-level page component rendered at `/news` inside DashboardLayout.
 * Displays a live, paginated feed of financial news articles aggregated
 * from 30+ sources across US stocks, Indian equities, crypto, and social
 * sentiment channels.
 *
 * Key features:
 * - **Market tab navigation** — Filter articles by market category
 *   (All, US Stocks, Indian Equities, Crypto, Social) via tab buttons
 * - **IntersectionObserver-based infinite scroll** — Automatically loads
 *   the next page of articles when the user scrolls near the bottom of
 *   the feed, using a sentinel element observed by IntersectionObserver
 * - **Polling-based refresh** — Auto-refreshes every 30 seconds per
 *   AAP §0.6.2 (no WebSocket — polling only)
 * - **NewsCard rendering** — Each article is rendered using the NewsCard
 *   component with source badge, market label, sentiment badge, symbol
 *   badges, analysis status, and relative timestamps
 *
 * Architecture:
 * - Composes `useNews` hook for paginated data fetching with market filter
 * - Uses IntersectionObserver API for infinite scroll triggering
 * - Dark theme CSS custom properties from globals.css
 * - TypeScript strict mode: no `any`, `exactOptionalPropertyTypes` enabled
 * - No component library — custom HTML + CSS
 *
 * Per AAP §0.5.3:
 * - "Live news feed page with infinite scroll"
 * - "Real-time news articles grouped by market with sentiment indicators,
 *    source badges, and infinite scroll pagination"
 *
 * @module apps/web/src/pages/NewsFeed
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import clsx from 'clsx';

import { useNews } from '../hooks/useNews';
import NewsCard from '../components/NewsCard';
import { Market } from '../types';
import type { NewsArticle } from '../types';

// ---------------------------------------------------------------------------
// Market Tab Configuration
// ---------------------------------------------------------------------------

/**
 * Tab definitions for the market filter navigation.
 *
 * The `null` value represents "All Markets" (no market filter applied).
 * Each tab maps to a Market enum value matching the PostgreSQL enum.
 */
const MARKET_TABS: Array<{ value: Market | null; label: string; icon: string }> = [
  { value: null, label: 'All', icon: '🌐' },
  { value: Market.US_STOCK, label: 'US Stocks', icon: '🇺🇸' },
  { value: Market.INDIAN_EQUITY, label: 'Indian Equities', icon: '🇮🇳' },
  { value: Market.CRYPTO, label: 'Crypto', icon: '₿' },
  { value: Market.SOCIAL, label: 'Social', icon: '💬' },
];

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
 */
export default function NewsFeed() {
  // -----------------------------------------------------------------------
  // Data hook — paginated news articles with market filter and polling
  // -----------------------------------------------------------------------

  const {
    articles,
    pagination,
    loading,
    error,
    refetch,
    setPage,
    setMarket,
  } = useNews({ pollingInterval: 30_000 });

  // -----------------------------------------------------------------------
  // Local state — market tab and accumulated articles for infinite scroll
  // -----------------------------------------------------------------------

  /** Currently active market tab. */
  const [activeTab, setActiveTab] = useState<Market | null>(null);

  /**
   * Accumulated articles across all loaded pages.
   * Reset when the market tab changes; appended when new pages load.
   */
  const [allArticles, setAllArticles] = useState<NewsArticle[]>([]);

  /** Current page being fetched (1-indexed). */
  const [currentPage, setCurrentPage] = useState<number>(1);

  // -----------------------------------------------------------------------
  // Ref — IntersectionObserver sentinel element
  // -----------------------------------------------------------------------

  /** Ref to the sentinel div at the bottom of the article list. */
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // -----------------------------------------------------------------------
  // Effect — Accumulate articles from paginated responses
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (articles.length > 0) {
      if (currentPage === 1) {
        // First page or tab change — replace all articles
        setAllArticles(articles);
      } else {
        // Subsequent pages — append, deduplicating by article ID
        setAllArticles((prev) => {
          const existingIds = new Set(prev.map((a) => a.id));
          const newArticles = articles.filter((a) => !existingIds.has(a.id));
          return [...prev, ...newArticles];
        });
      }
    }
  }, [articles, currentPage]);

  // -----------------------------------------------------------------------
  // Handler — Market tab selection
  // -----------------------------------------------------------------------

  /**
   * Handles market tab clicks. Resets the accumulated articles,
   * the page counter, and delegates to the useNews hook's setMarket.
   */
  const handleTabChange = useCallback(
    (market: Market | null): void => {
      setActiveTab(market);
      setCurrentPage(1);
      setAllArticles([]);
      setMarket(market);
    },
    [setMarket],
  );

  // -----------------------------------------------------------------------
  // Derived state — has more pages?
  // -----------------------------------------------------------------------

  const hasMore: boolean =
    pagination !== null && currentPage < pagination.totalPages;

  // -----------------------------------------------------------------------
  // IntersectionObserver — infinite scroll trigger
  // -----------------------------------------------------------------------

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry && entry.isIntersecting && hasMore && !loading) {
          const nextPage = currentPage + 1;
          setCurrentPage(nextPage);
          setPage(nextPage);
        }
      },
      {
        rootMargin: '200px',
        threshold: 0.1,
      },
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [hasMore, loading, currentPage, setPage]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="page-content">
      {/* Page header */}
      <div className="page-header">
        <h1 className="page-title">📰 News Feed</h1>
        <p className="text-secondary text-sm">
          Live financial news from 30+ sources across all markets
        </p>
      </div>

      {/* Market tab navigation */}
      <nav
        className="flex items-center gap-2 flex-wrap mb-4"
        role="tablist"
        aria-label="Market category filter"
      >
        {MARKET_TABS.map((tab) => (
          <button
            key={tab.label}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.value}
            className={clsx(
              'btn',
              activeTab === tab.value ? 'btn-primary' : 'btn-secondary',
            )}
            onClick={() => {
              handleTabChange(tab.value);
            }}
          >
            <span aria-hidden="true">{tab.icon}</span>{' '}
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Error state */}
      {error !== null && (
        <div className="card text-center py-8" role="alert">
          <p className="text-danger mb-3">{error}</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={refetch}
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading state — initial load only (not infinite scroll loading) */}
      {loading && allArticles.length === 0 && error === null && (
        <div className="card text-center py-8" role="status">
          <p className="text-secondary">Loading news articles...</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && allArticles.length === 0 && error === null && (
        <div className="card text-center py-8">
          <p className="text-secondary text-lg mb-2">No articles found</p>
          <p className="text-tertiary text-sm">
            {activeTab !== null
              ? 'Try selecting a different market category or check back later.'
              : 'News articles will appear here once the polling system starts fetching.'}
          </p>
        </div>
      )}

      {/* Article card grid */}
      {allArticles.length > 0 && (
        <div className="card-grid">
          {allArticles.map((article) => (
            <NewsCard key={article.id} article={article} />
          ))}
        </div>
      )}

      {/* Infinite scroll sentinel + loading indicator */}
      <div ref={sentinelRef} className="flex justify-center py-4">
        {loading && allArticles.length > 0 && (
          <p className="text-secondary text-sm" role="status">
            Loading more articles...
          </p>
        )}
        {!hasMore && allArticles.length > 0 && !loading && (
          <p className="text-tertiary text-sm">
            All articles loaded
            {pagination !== null ? ` (${String(pagination.total)} total)` : ''}
          </p>
        )}
      </div>
    </div>
  );
}
