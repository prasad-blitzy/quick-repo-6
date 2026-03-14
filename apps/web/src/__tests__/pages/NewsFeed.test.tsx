// @vitest-environment jsdom
/**
 * News Feed Page Component Tests
 *
 * Comprehensive unit/integration tests for the `NewsFeed` page component.
 * Covers:
 *
 * - Basic page rendering (title, subtitle, total count)
 * - Market tab navigation (All, US, India, Crypto, Social) with emoji icons
 * - Market tab click behaviour calling setMarket with correct Market enum values
 * - Article card grid rendering with correct articles from useNews
 * - IntersectionObserver-based infinite scroll (sentinel setup, page triggers)
 * - Loading states (initial and "loading more" during infinite scroll)
 * - Error state with retry button invoking refetch
 * - Empty state when no articles are available
 * - Polling-based refresh configuration (pollingInterval passed to useNews)
 * - Pagination info display (total article count)
 *
 * Testing stack:
 * - Vitest ^3.0.x — test runner, mocking, and assertion framework
 * - @testing-library/react ^16.0.x — component rendering and DOM queries
 * - @testing-library/jest-dom ^6.0.x — extended DOM assertion matchers
 * - jsdom ^25.0.x — headless browser environment (via @vitest-environment)
 *
 * Architecture:
 * - `useNews` hook is fully mocked — no real API calls
 * - `NewsCard` component is mocked for isolation
 * - Mock data follows TypeScript strict mode types (no `any`, Record<string, unknown>)
 * - Market enum values match the PostgreSQL enum definitions exactly
 * - Polling (NOT WebSocket) verified per AAP Section 0.6.2
 *
 * @module apps/web/src/__tests__/pages/NewsFeed.test
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { BrowserRouter } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Module Mocks — MUST precede component imports (vitest hoists vi.mock calls)
// ---------------------------------------------------------------------------

/**
 * Mock setter functions for the `useNews` hook return value.
 * Declared at module scope so they can be referenced in both the
 * `vi.mock` factory and individual test assertions.
 */
const mockSetPage = vi.fn();
const mockSetMarket = vi.fn();
const mockRefetch = vi.fn();

/**
 * Mock the `useNews` hook module.
 * Returns `vi.fn()` so we can configure return values per-test
 * via `mockUseNews.mockReturnValue(...)`.
 */
vi.mock('../../hooks/useNews', () => ({
  useNews: vi.fn(),
}));

/**
 * Mock the `NewsCard` component for test isolation.
 *
 * Renders a simplified card with data-testid attributes that match
 * the article `id`, plus the article title text for content assertions.
 * This isolates NewsFeed page tests from NewsCard rendering internals.
 */
vi.mock('../../components/NewsCard', () => ({
  default: ({ article }: { article: { id: string; title: string } }) => (
    <div data-testid={`news-card-${article.id}`}>{article.title}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Post-mock imports — component under test and mocked modules
// ---------------------------------------------------------------------------

import NewsFeed from '../../pages/NewsFeed';
import { useNews } from '../../hooks/useNews';

/** Cast the mocked hook to vitest Mock type for typed mock control. */
const mockUseNews = useNews as Mock;

// ---------------------------------------------------------------------------
// IntersectionObserver Mock
// ---------------------------------------------------------------------------

/**
 * Captured IntersectionObserver callback for simulating sentinel visibility
 * in infinite scroll tests. Set by the mock constructor in `beforeEach`.
 */
let intersectionCallback: IntersectionObserverCallback | null = null;

/**
 * Mock IntersectionObserver constructor that captures the callback.
 * Returns an object with observe/unobserve/disconnect stubs.
 */
const mockIntersectionObserver = vi.fn((callback: IntersectionObserverCallback) => {
  intersectionCallback = callback;
  return {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
    root: null,
    rootMargin: '0px',
    thresholds: [0],
    takeRecords: vi.fn(() => []),
  };
});

// ---------------------------------------------------------------------------
// Mock Data Factory
// ---------------------------------------------------------------------------

/**
 * Shape of a mock news article matching the shared `NewsArticle` interface.
 * Uses `Record<string, unknown>` for metadata (per AAP Rule 0.7.1 — no `any`).
 */
interface MockNewsArticle {
  id: string;
  title: string;
  content: string;
  url: string;
  source: string;
  market: 'us_stock' | 'indian_equity' | 'crypto' | 'social';
  symbols: string[];
  publishedAt: string;
  metadata: Record<string, unknown>;
  isAnalyzed: boolean;
  sentimentScore: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Creates a mock news article with sensible defaults.
 * Override any field via the `overrides` parameter.
 *
 * @param overrides - Partial article fields to customise.
 * @returns A fully-populated mock article object.
 */
function createMockArticle(overrides: Partial<MockNewsArticle> = {}): MockNewsArticle {
  return {
    id: 'article-001',
    title: 'Test Article: Major Stock Movement',
    content: 'This is test article content describing a significant market event.',
    url: 'https://example.com/article/001',
    source: 'finnhub',
    market: 'us_stock',
    symbols: ['AAPL', 'TSLA'],
    publishedAt: '2026-03-13T10:30:00Z',
    metadata: {},
    isAnalyzed: true,
    sentimentScore: '0.450',
    createdAt: '2026-03-13T10:35:00Z',
    updatedAt: '2026-03-13T10:35:00Z',
    ...overrides,
  };
}

/**
 * Shape of the pagination metadata returned by the useNews hook.
 */
interface MockPaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Default pagination metadata — page 1 of 3 with 50 total articles. */
const defaultPagination: MockPaginationMeta = {
  page: 1,
  limit: 20,
  total: 50,
  totalPages: 3,
};

/** Sample articles spanning all four market categories. */
const mockArticles: MockNewsArticle[] = [
  createMockArticle({
    id: '1',
    title: 'Apple Earnings Beat Expectations',
    market: 'us_stock',
    source: 'finnhub',
    symbols: ['AAPL'],
  }),
  createMockArticle({
    id: '2',
    title: 'Sensex Rally Continues',
    market: 'indian_equity',
    source: 'economic-times-rss',
    symbols: ['RELIANCE'],
  }),
  createMockArticle({
    id: '3',
    title: 'Bitcoin Hits New ATH',
    market: 'crypto',
    source: 'coingecko',
    symbols: ['BTC'],
  }),
  createMockArticle({
    id: '4',
    title: 'WSB Goes Bullish on GME',
    market: 'social',
    source: 'reddit',
    symbols: ['GME'],
  }),
];

// ---------------------------------------------------------------------------
// Render Helper
// ---------------------------------------------------------------------------

/**
 * Renders the NewsFeed component wrapped in BrowserRouter.
 * BrowserRouter is required because NewsFeed is rendered inside a routed
 * context in the application (DashboardLayout / App.tsx routes).
 */
function renderNewsFeed() {
  return render(
    <BrowserRouter>
      <NewsFeed />
    </BrowserRouter>,
  );
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('NewsFeed', () => {
  // -------------------------------------------------------------------------
  // Setup / Teardown
  // -------------------------------------------------------------------------

  beforeEach(() => {
    // Install the IntersectionObserver mock on the global scope
    global.IntersectionObserver = mockIntersectionObserver as unknown as typeof IntersectionObserver;

    // Reset the captured intersection callback
    intersectionCallback = null;

    // Set default useNews mock return value — happy path with articles
    mockUseNews.mockReturnValue({
      articles: mockArticles,
      pagination: defaultPagination,
      loading: false,
      error: null,
      refetch: mockRefetch,
      setPage: mockSetPage,
      setMarket: mockSetMarket,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // =========================================================================
  // Basic Page Rendering
  // =========================================================================

  describe('basic page rendering', () => {
    it('renders the page title', () => {
      renderNewsFeed();
      expect(screen.getByText(/News Feed/i)).toBeInTheDocument();
    });

    it('renders the page subtitle description', () => {
      renderNewsFeed();
      expect(screen.getByText(/Live financial news from 30\+ sources/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Market Tabs Rendering and Switching
  // =========================================================================

  describe('market tabs', () => {
    it('renders all market tabs including All', () => {
      renderNewsFeed();
      expect(screen.getByText('All')).toBeInTheDocument();
      expect(screen.getByText('US')).toBeInTheDocument();
      expect(screen.getByText('India')).toBeInTheDocument();
      expect(screen.getByText('Crypto')).toBeInTheDocument();
      expect(screen.getByText('Social')).toBeInTheDocument();
    });

    it('renders market tabs with correct emoji icons', () => {
      renderNewsFeed();
      expect(screen.getByText('🌐')).toBeInTheDocument(); // All
      expect(screen.getByText('🇺🇸')).toBeInTheDocument(); // US
      expect(screen.getByText('🇮🇳')).toBeInTheDocument(); // India
      expect(screen.getByText('₿')).toBeInTheDocument();  // Crypto
      expect(screen.getByText('💬')).toBeInTheDocument();  // Social
    });

    it('calls setMarket with us_stock when US tab is clicked', () => {
      renderNewsFeed();
      fireEvent.click(screen.getByText('US'));
      expect(mockSetMarket).toHaveBeenCalledWith('us_stock');
    });

    it('calls setMarket with null when All tab is clicked', () => {
      renderNewsFeed();
      fireEvent.click(screen.getByText('All'));
      expect(mockSetMarket).toHaveBeenCalledWith(null);
    });

    it('calls setMarket with indian_equity when India tab is clicked', () => {
      renderNewsFeed();
      fireEvent.click(screen.getByText('India'));
      expect(mockSetMarket).toHaveBeenCalledWith('indian_equity');
    });

    it('calls setMarket with crypto when Crypto tab is clicked', () => {
      renderNewsFeed();
      fireEvent.click(screen.getByText('Crypto'));
      expect(mockSetMarket).toHaveBeenCalledWith('crypto');
    });

    it('calls setMarket with social when Social tab is clicked', () => {
      renderNewsFeed();
      fireEvent.click(screen.getByText('Social'));
      expect(mockSetMarket).toHaveBeenCalledWith('social');
    });

    it('renders a tablist role element for accessibility', () => {
      renderNewsFeed();
      expect(screen.getByRole('tablist')).toBeInTheDocument();
    });

    it('renders tab buttons with tab role', () => {
      renderNewsFeed();
      const tabs = screen.getAllByRole('tab');
      expect(tabs.length).toBe(5); // All + 4 markets
    });
  });

  // =========================================================================
  // Article Card Grid Rendering
  // =========================================================================

  describe('article card grid rendering', () => {
    it('renders a card for each article from useNews', () => {
      renderNewsFeed();
      for (const article of mockArticles) {
        expect(screen.getByText(article.title)).toBeInTheDocument();
      }
    });

    it('renders the correct number of news cards', () => {
      renderNewsFeed();
      const cards = screen.getAllByTestId(/news-card-/);
      expect(cards).toHaveLength(mockArticles.length);
    });

    it('renders each card with the correct testid based on article id', () => {
      renderNewsFeed();
      for (const article of mockArticles) {
        expect(screen.getByTestId(`news-card-${article.id}`)).toBeInTheDocument();
      }
    });
  });

  // =========================================================================
  // Infinite Scroll Behaviour via IntersectionObserver
  // =========================================================================

  describe('infinite scroll via IntersectionObserver', () => {
    it('sets up IntersectionObserver for infinite scroll', () => {
      renderNewsFeed();
      expect(mockIntersectionObserver).toHaveBeenCalled();
    });

    it('calls setPage when sentinel becomes visible and more pages exist', async () => {
      renderNewsFeed();

      // Simulate the sentinel becoming visible
      if (intersectionCallback) {
        intersectionCallback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      }

      await waitFor(() => {
        expect(mockSetPage).toHaveBeenCalledWith(2); // Next page
      });
    });

    it('does not call setPage when already on last page', () => {
      // The component tracks currentPage internally starting at 1.
      // Setting totalPages to 1 means hasMore = (1 < 1) = false.
      mockUseNews.mockReturnValue({
        articles: mockArticles,
        pagination: { page: 1, limit: 20, total: 4, totalPages: 1 },
        loading: false,
        error: null,
        refetch: mockRefetch,
        setPage: mockSetPage,
        setMarket: mockSetMarket,
      });
      renderNewsFeed();

      if (intersectionCallback) {
        intersectionCallback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      }

      expect(mockSetPage).not.toHaveBeenCalled();
    });

    it('does not call setPage when loading is true', () => {
      mockUseNews.mockReturnValue({
        articles: mockArticles,
        pagination: defaultPagination,
        loading: true,
        error: null,
        refetch: mockRefetch,
        setPage: mockSetPage,
        setMarket: mockSetMarket,
      });
      renderNewsFeed();

      if (intersectionCallback) {
        intersectionCallback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      }

      expect(mockSetPage).not.toHaveBeenCalled();
    });

    it('does not call setPage when sentinel is not intersecting', () => {
      renderNewsFeed();

      if (intersectionCallback) {
        intersectionCallback(
          [{ isIntersecting: false } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      }

      expect(mockSetPage).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Loading States
  // =========================================================================

  describe('loading states', () => {
    it('shows loading indicator when loading with no articles', () => {
      mockUseNews.mockReturnValue({
        articles: [],
        pagination: null,
        loading: true,
        error: null,
        refetch: mockRefetch,
        setPage: mockSetPage,
        setMarket: mockSetMarket,
      });
      renderNewsFeed();
      expect(screen.getByText(/Loading news/i)).toBeInTheDocument();
    });

    it('shows loading more indicator when loading with existing articles', () => {
      mockUseNews.mockReturnValue({
        articles: mockArticles,
        pagination: defaultPagination,
        loading: true,
        error: null,
        refetch: mockRefetch,
        setPage: mockSetPage,
        setMarket: mockSetMarket,
      });
      renderNewsFeed();
      expect(screen.getByText(/Loading more/i)).toBeInTheDocument();
    });

    it('does not show initial loading when articles are present', () => {
      mockUseNews.mockReturnValue({
        articles: mockArticles,
        pagination: defaultPagination,
        loading: true,
        error: null,
        refetch: mockRefetch,
        setPage: mockSetPage,
        setMarket: mockSetMarket,
      });
      renderNewsFeed();
      expect(screen.queryByText(/Loading news/i)).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Error State
  // =========================================================================

  describe('error state', () => {
    it('displays error message when error occurs', () => {
      mockUseNews.mockReturnValue({
        articles: [],
        pagination: null,
        loading: false,
        error: 'Failed to fetch news',
        refetch: mockRefetch,
        setPage: mockSetPage,
        setMarket: mockSetMarket,
      });
      renderNewsFeed();
      expect(screen.getByText(/Failed to fetch news/i)).toBeInTheDocument();
    });

    it('calls refetch when retry button is clicked', () => {
      mockUseNews.mockReturnValue({
        articles: [],
        pagination: null,
        loading: false,
        error: 'Network error',
        refetch: mockRefetch,
        setPage: mockSetPage,
        setMarket: mockSetMarket,
      });
      renderNewsFeed();
      fireEvent.click(screen.getByText(/Retry/i));
      expect(mockRefetch).toHaveBeenCalledTimes(1);
    });

    it('renders error banner with alert role for accessibility', () => {
      mockUseNews.mockReturnValue({
        articles: [],
        pagination: null,
        loading: false,
        error: 'Something went wrong',
        refetch: mockRefetch,
        setPage: mockSetPage,
        setMarket: mockSetMarket,
      });
      renderNewsFeed();
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Empty State
  // =========================================================================

  describe('empty state', () => {
    it('displays empty state when no articles are available', () => {
      mockUseNews.mockReturnValue({
        articles: [],
        pagination: null,
        loading: false,
        error: null,
        refetch: mockRefetch,
        setPage: mockSetPage,
        setMarket: mockSetMarket,
      });
      renderNewsFeed();
      expect(screen.getByText(/No news articles found/i)).toBeInTheDocument();
    });

    it('shows helpful suggestion in empty state', () => {
      mockUseNews.mockReturnValue({
        articles: [],
        pagination: null,
        loading: false,
        error: null,
        refetch: mockRefetch,
        setPage: mockSetPage,
        setMarket: mockSetMarket,
      });
      renderNewsFeed();
      expect(
        screen.getByText(/Try selecting a different market or check back later/i),
      ).toBeInTheDocument();
    });

    it('does not show empty state when loading', () => {
      mockUseNews.mockReturnValue({
        articles: [],
        pagination: null,
        loading: true,
        error: null,
        refetch: mockRefetch,
        setPage: mockSetPage,
        setMarket: mockSetMarket,
      });
      renderNewsFeed();
      expect(screen.queryByText(/No news articles found/i)).not.toBeInTheDocument();
    });

    it('does not show empty state when error is present', () => {
      mockUseNews.mockReturnValue({
        articles: [],
        pagination: null,
        loading: false,
        error: 'Something went wrong',
        refetch: mockRefetch,
        setPage: mockSetPage,
        setMarket: mockSetMarket,
      });
      renderNewsFeed();
      // The empty state check is only shown when error === null
      // When there IS an error, the error banner is shown instead
      expect(screen.queryByText(/No news articles found/i)).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Polling-Based Refresh (NOT WebSocket) — AAP §0.6.2
  // =========================================================================

  describe('polling-based refresh', () => {
    it('passes pollingInterval option to useNews for polling refresh', () => {
      renderNewsFeed();
      expect(mockUseNews).toHaveBeenCalledWith(
        expect.objectContaining({
          pollingInterval: expect.any(Number),
        }),
      );
    });

    it('uses a positive pollingInterval for periodic data refresh', () => {
      renderNewsFeed();
      const callArgs = mockUseNews.mock.calls[0]?.[0] as
        | { pollingInterval?: number }
        | undefined;
      expect(callArgs?.pollingInterval).toBeGreaterThan(0);
    });

    it('uses 30000ms (30 seconds) polling interval', () => {
      renderNewsFeed();
      const callArgs = mockUseNews.mock.calls[0]?.[0] as
        | { pollingInterval?: number }
        | undefined;
      expect(callArgs?.pollingInterval).toBe(30_000);
    });
  });

  // =========================================================================
  // Pagination Info
  // =========================================================================

  describe('pagination info', () => {
    it('displays the total article count from pagination', () => {
      renderNewsFeed();
      expect(screen.getByText(/50/)).toBeInTheDocument();
    });

    it('displays the current article count', () => {
      renderNewsFeed();
      // allArticles.length is shown in the pagination info
      expect(screen.getByText(new RegExp(String(mockArticles.length)))).toBeInTheDocument();
    });

    it('does not display pagination info when no articles', () => {
      mockUseNews.mockReturnValue({
        articles: [],
        pagination: null,
        loading: false,
        error: null,
        refetch: mockRefetch,
        setPage: mockSetPage,
        setMarket: mockSetMarket,
      });
      renderNewsFeed();
      expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
    });
  });
});
