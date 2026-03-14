// @vitest-environment jsdom
/**
 * NewsCard Component Unit Tests
 *
 * Comprehensive unit tests for the `NewsCard` React component, verifying
 * all rendering behaviours, prop handling, and visual states across all
 * four supported market types (US, India, Crypto, Social).
 *
 * Testing stack:
 * - Vitest ^3.0.x — test runner and assertion framework
 * - @testing-library/react ^16.0.x — component rendering and DOM queries
 * - @testing-library/jest-dom ^6.0.x — extended DOM assertion matchers
 * - jsdom ^25.0.x — headless browser environment
 *
 * @module apps/web/src/__tests__/components/NewsCard.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import NewsCard from '../../components/NewsCard';
import type { NewsArticle } from '../../types';
import { Market } from '../../types';

// ---------------------------------------------------------------------------
// Module Mocks — deterministic date formatting
// ---------------------------------------------------------------------------

/**
 * Mock the `date-fns` module so that `formatDistanceToNow` always returns
 * a fixed string regardless of when the test suite executes. The NewsCard
 * component calls `formatDistanceToNow(new Date(publishedAt), { addSuffix: true })`
 * to render relative timestamps; without this mock the output varies by
 * wall-clock time and would make assertions non-deterministic.
 */
vi.mock('date-fns', () => ({
  formatDistanceToNow: vi.fn(() => '5 minutes ago'),
}));

// ---------------------------------------------------------------------------
// Test Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Mock Data Factory
// ---------------------------------------------------------------------------

/**
 * Creates a fully-typed `NewsArticle` object with sensible defaults.
 * Any property can be overridden via the `overrides` partial.
 *
 * @param overrides - Partial properties to merge into the defaults.
 * @returns A complete `NewsArticle` suitable for rendering `<NewsCard />`.
 */
function createMockArticle(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: 'test-article-001',
    title: 'Test Article Title: Major Stock Movement',
    content:
      'This is a test article content that describes a significant market event with enough text to potentially trigger truncation behavior in the component display area.',
    url: 'https://example.com/article/test-001',
    source: 'finnhub',
    market: Market.US_STOCK,
    symbols: ['AAPL', 'TSLA'],
    publishedAt: '2026-03-13T10:30:00Z',
    metadata: {},
    isAnalyzed: true,
    sentimentScore: null,
    createdAt: '2026-03-13T10:35:00Z',
    updatedAt: '2026-03-13T10:35:00Z',
    ...overrides,
  };
}

// ===========================================================================
// Test Suites
// ===========================================================================

describe('NewsCard', () => {
  // -------------------------------------------------------------------------
  // Basic Rendering
  // -------------------------------------------------------------------------

  describe('basic rendering', () => {
    it('renders the article title', () => {
      render(<NewsCard article={createMockArticle()} />);
      expect(
        screen.getByText('Test Article Title: Major Stock Movement'),
      ).toBeInTheDocument();
    });

    it('renders the article content snippet', () => {
      render(<NewsCard article={createMockArticle()} />);
      expect(
        screen.getByText(/This is a test article content/),
      ).toBeInTheDocument();
    });

    it('applies additional className when provided', () => {
      const { container } = render(
        <NewsCard article={createMockArticle()} className="custom-class" />,
      );
      expect(container.firstChild).toHaveClass('custom-class');
    });

    it('renders without crashing when given minimal valid props', () => {
      const article = createMockArticle();
      const { container } = render(<NewsCard article={article} />);
      expect(container.firstChild).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Market Labels with Flag Emoji
  // -------------------------------------------------------------------------

  describe('market labels with flag emoji', () => {
    it('displays US market label with flag emoji', () => {
      render(
        <NewsCard
          article={createMockArticle({ market: Market.US_STOCK })}
        />,
      );
      expect(screen.getByText('🇺🇸 US')).toBeInTheDocument();
    });

    it('displays India market label with flag emoji', () => {
      render(
        <NewsCard
          article={createMockArticle({ market: Market.INDIAN_EQUITY })}
        />,
      );
      expect(screen.getByText('🇮🇳 India')).toBeInTheDocument();
    });

    it('displays Crypto market label with symbol', () => {
      render(
        <NewsCard
          article={createMockArticle({ market: Market.CRYPTO })}
        />,
      );
      expect(screen.getByText('₿ Crypto')).toBeInTheDocument();
    });

    it('displays Social market label with emoji', () => {
      render(
        <NewsCard
          article={createMockArticle({ market: Market.SOCIAL })}
        />,
      );
      expect(screen.getByText('💬 Social')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Source Badge Display
  // -------------------------------------------------------------------------

  describe('source badge display', () => {
    it('displays the finnhub source name as a badge', () => {
      render(
        <NewsCard article={createMockArticle({ source: 'finnhub' })} />,
      );
      // Component capitalises via formatSourceName: 'finnhub' → 'Finnhub'
      expect(screen.getByText('Finnhub')).toBeInTheDocument();
    });

    it('renders coingecko source badge', () => {
      render(
        <NewsCard article={createMockArticle({ source: 'coingecko' })} />,
      );
      expect(screen.getByText('Coingecko')).toBeInTheDocument();
    });

    it('renders reddit source badge', () => {
      render(
        <NewsCard article={createMockArticle({ source: 'reddit' })} />,
      );
      expect(screen.getByText('Reddit')).toBeInTheDocument();
    });

    it('renders RSS feed source badge with formatted name', () => {
      render(
        <NewsCard
          article={createMockArticle({ source: 'economic-times-rss' })}
        />,
      );
      // formatSourceName splits on '-' and capitalises each word:
      // 'economic-times-rss' → 'Economic Times Rss'
      expect(screen.getByText('Economic Times Rss')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Published Time Formatting
  // -------------------------------------------------------------------------

  describe('published time formatting', () => {
    it('displays the published time formatted with formatDistanceToNow', () => {
      render(<NewsCard article={createMockArticle()} />);
      expect(screen.getByText('5 minutes ago')).toBeInTheDocument();
    });

    it('renders the time inside a <time> element with datetime attribute', () => {
      render(
        <NewsCard
          article={createMockArticle({
            publishedAt: '2026-03-13T10:30:00Z',
          })}
        />,
      );
      const timeEl = screen.getByText('5 minutes ago');
      expect(timeEl.tagName).toBe('TIME');
      expect(timeEl).toHaveAttribute('datetime', '2026-03-13T10:30:00Z');
    });
  });

  // -------------------------------------------------------------------------
  // Analysis Status Indicator
  // -------------------------------------------------------------------------

  describe('analysis status indicator', () => {
    it('shows analyzed badge when article isAnalyzed is true', () => {
      render(
        <NewsCard article={createMockArticle({ isAnalyzed: true })} />,
      );
      expect(screen.getByText(/✓ Analyzed/)).toBeInTheDocument();
    });

    it('shows pending badge when article isAnalyzed is false', () => {
      render(
        <NewsCard article={createMockArticle({ isAnalyzed: false })} />,
      );
      expect(screen.getByText(/⏳ Pending/)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Symbol Badges
  // -------------------------------------------------------------------------

  describe('symbol badges', () => {
    it('renders symbol badges for each symbol', () => {
      render(
        <NewsCard
          article={createMockArticle({
            symbols: ['AAPL', 'TSLA', 'GOOGL'],
          })}
        />,
      );
      expect(screen.getByText('AAPL')).toBeInTheDocument();
      expect(screen.getByText('TSLA')).toBeInTheDocument();
      expect(screen.getByText('GOOGL')).toBeInTheDocument();
    });

    it('renders correctly with no symbols', () => {
      render(
        <NewsCard article={createMockArticle({ symbols: [] })} />,
      );
      // Component renders "No symbols" when array is empty
      expect(screen.getByText('No symbols')).toBeInTheDocument();
      // Article title should still render
      expect(
        screen.getByText('Test Article Title: Major Stock Movement'),
      ).toBeInTheDocument();
    });

    it('renders a single symbol badge correctly', () => {
      render(
        <NewsCard article={createMockArticle({ symbols: ['BTC'] })} />,
      );
      expect(screen.getByText('BTC')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // External URL Link
  // -------------------------------------------------------------------------

  describe('external URL link', () => {
    it('renders external link with target="_blank" and rel="noopener noreferrer"', () => {
      render(
        <NewsCard
          article={createMockArticle({
            url: 'https://example.com/news/article-123',
          })}
        />,
      );
      const link = screen.getByRole('link');
      expect(link).toHaveAttribute(
        'href',
        'https://example.com/news/article-123',
      );
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('renders the "Read →" link text', () => {
      render(<NewsCard article={createMockArticle()} />);
      const link = screen.getByRole('link');
      expect(link).toHaveTextContent('Read →');
    });
  });

  // -------------------------------------------------------------------------
  // Dark Theme CSS Classes
  // -------------------------------------------------------------------------

  describe('dark theme CSS classes', () => {
    it('applies card CSS class to the root element', () => {
      const { container } = render(
        <NewsCard article={createMockArticle()} />,
      );
      expect(container.firstChild).toHaveClass('card');
    });

    it('applies animate-fade-in class to the root element', () => {
      const { container } = render(
        <NewsCard article={createMockArticle()} />,
      );
      expect(container.firstChild).toHaveClass('animate-fade-in');
    });

    it('renders the root element as an <article> tag', () => {
      const { container } = render(
        <NewsCard article={createMockArticle()} />,
      );
      expect(
        (container.firstChild as HTMLElement).tagName,
      ).toBe('ARTICLE');
    });
  });

  // -------------------------------------------------------------------------
  // Content Truncation
  // -------------------------------------------------------------------------

  describe('content truncation', () => {
    it('applies line-clamp-3 class to content snippet', () => {
      const longContent = 'A'.repeat(500);
      render(
        <NewsCard article={createMockArticle({ content: longContent })} />,
      );
      const contentEl = screen.getByText(longContent);
      expect(contentEl).toHaveClass('line-clamp-3');
    });

    it('does not render content paragraph when content is empty', () => {
      const { container } = render(
        <NewsCard article={createMockArticle({ content: '' })} />,
      );
      // The component only renders <p> when content.length > 0
      const paragraphs = container.querySelectorAll('.line-clamp-3');
      expect(paragraphs.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Complete Article Rendering — Different Markets
  // -------------------------------------------------------------------------

  describe('complete article rendering by market', () => {
    it('renders a complete US stock article correctly', () => {
      const article = createMockArticle({
        title: 'Apple Reports Record Earnings',
        source: 'finnhub',
        market: Market.US_STOCK,
        symbols: ['AAPL'],
        isAnalyzed: true,
      });
      render(<NewsCard article={article} />);

      expect(
        screen.getByText('Apple Reports Record Earnings'),
      ).toBeInTheDocument();
      expect(screen.getByText('Finnhub')).toBeInTheDocument();
      expect(screen.getByText('🇺🇸 US')).toBeInTheDocument();
      expect(screen.getByText('AAPL')).toBeInTheDocument();
      expect(screen.getByText(/✓ Analyzed/)).toBeInTheDocument();
    });

    it('renders an Indian equities article correctly', () => {
      const article = createMockArticle({
        title: 'Sensex Hits All-Time High',
        source: 'economic-times-rss',
        market: Market.INDIAN_EQUITY,
        symbols: ['RELIANCE', 'TCS'],
        isAnalyzed: false,
      });
      render(<NewsCard article={article} />);

      expect(
        screen.getByText('Sensex Hits All-Time High'),
      ).toBeInTheDocument();
      expect(screen.getByText('🇮🇳 India')).toBeInTheDocument();
      expect(screen.getByText('RELIANCE')).toBeInTheDocument();
      expect(screen.getByText('TCS')).toBeInTheDocument();
      expect(screen.getByText(/⏳ Pending/)).toBeInTheDocument();
    });

    it('renders a crypto article correctly', () => {
      const article = createMockArticle({
        title: 'Bitcoin Surges Past $100K',
        source: 'coingecko',
        market: Market.CRYPTO,
        symbols: ['BTC'],
        isAnalyzed: true,
      });
      render(<NewsCard article={article} />);

      expect(
        screen.getByText('Bitcoin Surges Past $100K'),
      ).toBeInTheDocument();
      expect(screen.getByText('₿ Crypto')).toBeInTheDocument();
      expect(screen.getByText('BTC')).toBeInTheDocument();
      expect(screen.getByText(/✓ Analyzed/)).toBeInTheDocument();
    });

    it('renders a social sentiment article correctly', () => {
      const article = createMockArticle({
        title: 'WSB Bullish on GME',
        source: 'reddit',
        market: Market.SOCIAL,
        symbols: ['GME'],
        isAnalyzed: false,
      });
      render(<NewsCard article={article} />);

      expect(screen.getByText('WSB Bullish on GME')).toBeInTheDocument();
      expect(screen.getByText('💬 Social')).toBeInTheDocument();
      expect(screen.getByText('GME')).toBeInTheDocument();
      expect(screen.getByText(/⏳ Pending/)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Scoped Queries with `within`
  // -------------------------------------------------------------------------

  describe('scoped DOM queries', () => {
    it('renders source and market badges within the card header', () => {
      const { container } = render(
        <NewsCard
          article={createMockArticle({
            source: 'finnhub',
            market: Market.US_STOCK,
          })}
        />,
      );

      const header = container.querySelector('.card-header');
      expect(header).toBeTruthy();

      const headerScope = within(header as HTMLElement);
      expect(headerScope.getByText('Finnhub')).toBeInTheDocument();
      expect(headerScope.getByText('🇺🇸 US')).toBeInTheDocument();
      expect(headerScope.getByText('5 minutes ago')).toBeInTheDocument();
    });

    it('renders title within the card body', () => {
      const { container } = render(
        <NewsCard
          article={createMockArticle({
            title: 'Scoped Query Test Title',
          })}
        />,
      );

      const body = container.querySelector('.card-body');
      expect(body).toBeTruthy();

      const bodyScope = within(body as HTMLElement);
      expect(
        bodyScope.getByText('Scoped Query Test Title'),
      ).toBeInTheDocument();
    });

    it('renders symbols and analysis status within the card footer', () => {
      const { container } = render(
        <NewsCard
          article={createMockArticle({
            symbols: ['MSFT'],
            isAnalyzed: true,
          })}
        />,
      );

      const footer = container.querySelector('.card-footer');
      expect(footer).toBeTruthy();

      const footerScope = within(footer as HTMLElement);
      expect(footerScope.getByText('MSFT')).toBeInTheDocument();
      expect(footerScope.getByText(/✓ Analyzed/)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Accessibility
  // -------------------------------------------------------------------------

  describe('accessibility', () => {
    it('renders the root element with an aria-label containing the title', () => {
      render(
        <NewsCard
          article={createMockArticle({
            title: 'Accessible Article Title',
          })}
        />,
      );
      const articleEl = screen.getByLabelText(
        'News article: Accessible Article Title',
      );
      expect(articleEl).toBeInTheDocument();
    });

    it('renders the external link with an aria-label', () => {
      render(
        <NewsCard
          article={createMockArticle({ title: 'Link A11y Test' })}
        />,
      );
      const link = screen.getByLabelText('Read full article: Link A11y Test');
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('target', '_blank');
    });
  });
});
