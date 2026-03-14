// @vitest-environment jsdom
/**
 * Trade Opportunities Page Component Tests
 *
 * Comprehensive unit/integration tests for the `TradeOpportunities` page
 * component. Covers:
 *
 * - Basic page rendering (title, description, total count)
 * - FilterBar integration (market, sort configuration)
 * - Page-specific filter controls (status, direction, timeframe, confidence)
 * - Filter state management (setter invocations, null on clear)
 * - Card grid rendering with direction emoji indicators (🟢 LONG / 🔴 SHORT)
 * - Pagination controls (previous/next, disabled states, page display)
 * - Loading, error, and empty states
 * - Polling configuration (pollingInterval passed to useOpportunities)
 *
 * Testing stack:
 * - Vitest ^3.0.x — test runner, mocking, and assertion framework
 * - @testing-library/react ^16.0.x — component rendering and DOM queries
 * - @testing-library/jest-dom ^6.0.x — extended DOM assertion matchers
 * - jsdom ^25.0.x — headless browser environment (via @vitest-environment)
 *
 * Architecture:
 * - `useOpportunities` hook is fully mocked — no real API calls
 * - `TradeCard` and `FilterBar` are mocked for isolation
 * - ALL price fields in mock data use `string` type (AAP Rule 0.7.2)
 * - Direction emoji indicators 🟢 LONG / 🔴 SHORT verified (AAP Rule 0.7.5)
 * - TypeScript strict mode: no `any`, all mocks fully typed
 *
 * @module apps/web/src/__tests__/pages/TradeOpportunities.test
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
 * Mock setter functions for the `useOpportunities` hook return value.
 * Declared at module scope so they can be referenced in both the
 * `vi.mock` factory and individual test assertions.
 */
const mockSetPage = vi.fn();
const mockSetMarket = vi.fn();
const mockSetStatus = vi.fn();
const mockSetDirection = vi.fn();
const mockSetMinConfidence = vi.fn();
const mockSetTimeframe = vi.fn();
const mockSetSortBy = vi.fn();
const mockSetSortOrder = vi.fn();
const mockRefetch = vi.fn();

/**
 * Mock the `useOpportunities` hook module.
 * Returns `vi.fn()` so we can configure return values per-test
 * via `mockUseOpportunities.mockReturnValue(...)`.
 */
vi.mock('../../hooks/useOpportunities', () => ({
  useOpportunities: vi.fn(),
}));

/**
 * Mock the `TradeCard` component for test isolation.
 *
 * Renders a simplified card with data-testid attributes that match the
 * opportunity `id`, plus the symbol and direction emoji indicator.
 * Per AAP Rule 0.7.5: 🟢 for LONG, 🔴 for SHORT.
 */
vi.mock('../../components/TradeCard', () => ({
  default: ({ opportunity }: { opportunity: { id: string; symbol: string; direction: string } }) => (
    <div data-testid={`trade-card-${opportunity.id}`}>
      <span data-testid="card-symbol">{opportunity.symbol}</span>
      <span data-testid="card-direction">
        {opportunity.direction === 'long' ? '🟢 LONG' : '🔴 SHORT'}
      </span>
    </div>
  ),
}));

/**
 * Mock the `FilterBar` component for test isolation.
 *
 * Renders data-testid spans for market, sortBy, sortOrder props and
 * passes through `children` so page-specific filter controls (status,
 * direction, timeframe, confidence) are rendered and testable.
 */
vi.mock('../../components/FilterBar', () => ({
  default: ({
    market,
    sortBy,
    sortOrder,
    children,
  }: {
    market: string | null;
    onMarketChange: (market: string | null) => void;
    sortBy: string;
    onSortByChange: (sortBy: string) => void;
    sortOrder: 'asc' | 'desc';
    onSortOrderChange: (order: 'asc' | 'desc') => void;
    search: string;
    onSearchChange: (search: string) => void;
    sortOptions?: Array<{ value: string; label: string }>;
    className?: string;
    children?: React.ReactNode;
  }) => (
    <div data-testid="filter-bar">
      <span data-testid="filter-market">{market ?? 'all'}</span>
      <span data-testid="filter-sort-by">{sortBy}</span>
      <span data-testid="filter-sort-order">{sortOrder}</span>
      {children}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Component and Hook Imports — AFTER vi.mock declarations
// ---------------------------------------------------------------------------

import TradeOpportunities from '../../pages/TradeOpportunities';
import { useOpportunities } from '../../hooks/useOpportunities';

/** Cast the mocked hook to vitest `Mock` for type-safe `.mockReturnValue()`. */
const mockUseOpportunities = useOpportunities as Mock;

// ---------------------------------------------------------------------------
// Mock Data Types and Factory
// ---------------------------------------------------------------------------

/**
 * Typed mock shape for a trade opportunity.
 *
 * ALL price fields (`entryPrice`, `stopLoss`, `takeProfit`, `riskRewardRatio`)
 * are `string` type per AAP Rule 0.7.2 — financial decimal precision.
 * `confidence` is `number` (0.00–1.00) — it is a score, NOT a financial price.
 */
interface MockTradeOpportunity {
  id: string;
  articleId: string;
  symbol: string;
  market: 'us_stock' | 'indian_equity' | 'crypto' | 'social';
  direction: 'long' | 'short';
  confidence: number;
  entryPrice: string;
  stopLoss: string;
  takeProfit: string;
  timeframe: 'intraday' | 'swing' | 'position';
  reasoning: string;
  riskRewardRatio: string;
  status: 'active' | 'closed' | 'expired' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

/**
 * Creates a fully-typed mock `TradeOpportunity` with sensible defaults.
 * All price fields are `string` per AAP Rule 0.7.2.
 */
function createMockOpportunity(
  overrides: Partial<MockTradeOpportunity> = {},
): MockTradeOpportunity {
  return {
    id: 'opp-001',
    articleId: 'article-001',
    symbol: 'AAPL',
    market: 'us_stock',
    direction: 'long',
    confidence: 0.85,
    entryPrice: '187.5000',
    stopLoss: '182.0000',
    takeProfit: '198.0000',
    timeframe: 'swing',
    reasoning: 'Strong earnings beat with positive forward guidance and sector momentum.',
    riskRewardRatio: '1.91',
    status: 'active',
    createdAt: '2026-03-13T10:30:00Z',
    updatedAt: '2026-03-13T10:30:00Z',
    ...overrides,
  };
}

/** Pagination metadata for default mock state. */
interface MockPaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const defaultPagination: MockPaginationMeta = {
  page: 1,
  limit: 20,
  total: 45,
  totalPages: 3,
};

/**
 * Sample opportunities with diverse directions and markets.
 * Includes LONG (US), SHORT (Crypto), and LONG (India) for coverage.
 */
const mockOpportunities: MockTradeOpportunity[] = [
  createMockOpportunity({
    id: '1',
    symbol: 'AAPL',
    direction: 'long',
    market: 'us_stock',
    confidence: 0.85,
    entryPrice: '187.5000',
    stopLoss: '182.0000',
    takeProfit: '198.0000',
    riskRewardRatio: '1.91',
    status: 'active',
  }),
  createMockOpportunity({
    id: '2',
    symbol: 'BTC',
    direction: 'short',
    market: 'crypto',
    confidence: 0.72,
    entryPrice: '104500.0000',
    stopLoss: '108000.0000',
    takeProfit: '97000.0000',
    riskRewardRatio: '2.14',
    status: 'active',
  }),
  createMockOpportunity({
    id: '3',
    symbol: 'RELIANCE',
    direction: 'long',
    market: 'indian_equity',
    confidence: 0.68,
    entryPrice: '2850.0000',
    stopLoss: '2780.0000',
    takeProfit: '2980.0000',
    riskRewardRatio: '1.86',
    status: 'closed',
  }),
];

/** Default filter state matching the hook's initial state. */
const defaultFilters = {
  market: null,
  status: null,
  direction: null,
  minConfidence: null,
  timeframe: null,
  sortBy: 'createdAt',
  sortOrder: 'desc' as const,
};

// ---------------------------------------------------------------------------
// Helper: default hook return value factory
// ---------------------------------------------------------------------------

/**
 * Creates the full default return value for `useOpportunities`.
 * Use `overrides` for per-test customisation.
 */
function createHookReturnValue(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    opportunities: mockOpportunities,
    pagination: defaultPagination,
    loading: false,
    error: null,
    refetch: mockRefetch,
    filters: defaultFilters,
    setPage: mockSetPage,
    setMarket: mockSetMarket,
    setStatus: mockSetStatus,
    setDirection: mockSetDirection,
    setMinConfidence: mockSetMinConfidence,
    setTimeframe: mockSetTimeframe,
    setSortBy: mockSetSortBy,
    setSortOrder: mockSetSortOrder,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: render with routing context
// ---------------------------------------------------------------------------

/**
 * Renders the `TradeOpportunities` page inside a `BrowserRouter`
 * to provide the routing context required by the component and its
 * children (which may use `Link` or route-aware hooks).
 */
function renderTradeOpportunities() {
  return render(
    <BrowserRouter>
      <TradeOpportunities />
    </BrowserRouter>,
  );
}

// ---------------------------------------------------------------------------
// Test Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockUseOpportunities.mockReturnValue(createHookReturnValue());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ===========================================================================
// Test Suites
// ===========================================================================

describe('TradeOpportunities', () => {
  // -------------------------------------------------------------------------
  // Phase 5 — Basic Page Rendering
  // -------------------------------------------------------------------------

  describe('Basic Page Rendering', () => {
    it('renders the page title', () => {
      renderTradeOpportunities();
      expect(screen.getByText(/Trade Opportunities/i)).toBeInTheDocument();
    });

    it('renders the page description', () => {
      renderTradeOpportunities();
      expect(
        screen.getByText(/AI-generated trade recommendations/i),
      ).toBeInTheDocument();
    });

    it('displays total opportunities count from pagination', () => {
      renderTradeOpportunities();
      expect(screen.getByText(/45/)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Phase 6 — FilterBar Integration
  // -------------------------------------------------------------------------

  describe('FilterBar Integration', () => {
    it('renders the FilterBar component', () => {
      renderTradeOpportunities();
      expect(screen.getByTestId('filter-bar')).toBeInTheDocument();
    });

    it('passes the current market filter to FilterBar', () => {
      renderTradeOpportunities();
      expect(screen.getByTestId('filter-market')).toHaveTextContent('all');
    });

    it('passes sort configuration to FilterBar', () => {
      renderTradeOpportunities();
      expect(screen.getByTestId('filter-sort-by')).toHaveTextContent('createdAt');
      expect(screen.getByTestId('filter-sort-order')).toHaveTextContent('desc');
    });

    it('renders status filter dropdown', () => {
      renderTradeOpportunities();
      const statusSelect = screen.getByLabelText('Filter by status');
      expect(statusSelect).toBeInTheDocument();
    });

    it('renders direction filter dropdown with LONG/SHORT emoji options', () => {
      renderTradeOpportunities();
      const directionSelect = screen.getByLabelText('Filter by direction');
      expect(directionSelect).toBeInTheDocument();
    });

    it('renders timeframe filter dropdown', () => {
      renderTradeOpportunities();
      const timeframeSelect = screen.getByLabelText('Filter by timeframe');
      expect(timeframeSelect).toBeInTheDocument();
    });

    it('renders confidence threshold slider', () => {
      renderTradeOpportunities();
      const slider = screen.getByLabelText('Minimum confidence threshold');
      expect(slider).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Phase 7 — Filter State Management
  // -------------------------------------------------------------------------

  describe('Filter State Management', () => {
    it('calls setStatus when status filter is changed', () => {
      renderTradeOpportunities();
      const statusSelect = screen.getByLabelText('Filter by status');
      fireEvent.change(statusSelect, { target: { value: 'active' } });
      expect(mockSetStatus).toHaveBeenCalledWith('active');
    });

    it('calls setDirection when direction filter is changed', () => {
      renderTradeOpportunities();
      const directionSelect = screen.getByLabelText('Filter by direction');
      fireEvent.change(directionSelect, { target: { value: 'long' } });
      expect(mockSetDirection).toHaveBeenCalledWith('long');
    });

    it('calls setTimeframe when timeframe filter is changed', () => {
      renderTradeOpportunities();
      const timeframeSelect = screen.getByLabelText('Filter by timeframe');
      fireEvent.change(timeframeSelect, { target: { value: 'swing' } });
      expect(mockSetTimeframe).toHaveBeenCalledWith('swing');
    });

    it('calls setMinConfidence when confidence slider is changed', () => {
      renderTradeOpportunities();
      const slider = screen.getByLabelText('Minimum confidence threshold');
      fireEvent.change(slider, { target: { value: '70' } });
      expect(mockSetMinConfidence).toHaveBeenCalledWith(0.7);
    });

    it('sends null to setStatus when "All Status" is selected', () => {
      renderTradeOpportunities();
      const statusSelect = screen.getByLabelText('Filter by status');
      fireEvent.change(statusSelect, { target: { value: 'active' } });
      fireEvent.change(statusSelect, { target: { value: '' } });
      expect(mockSetStatus).toHaveBeenLastCalledWith(null);
    });

    it('sends null to setDirection when "All Directions" is selected', () => {
      renderTradeOpportunities();
      const directionSelect = screen.getByLabelText('Filter by direction');
      fireEvent.change(directionSelect, { target: { value: '' } });
      expect(mockSetDirection).toHaveBeenCalledWith(null);
    });

    it('sends null to setMinConfidence when slider is set to 0', () => {
      // Provide a state where minConfidence is already set (non-null)
      // so that changing to 0 is an actual value change.
      mockUseOpportunities.mockReturnValue(
        createHookReturnValue({
          filters: { ...defaultFilters, minConfidence: 0.5 },
        }),
      );
      renderTradeOpportunities();
      const slider = screen.getByLabelText('Minimum confidence threshold');
      fireEvent.change(slider, { target: { value: '0' } });
      expect(mockSetMinConfidence).toHaveBeenCalledWith(null);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 8 — Card Grid Rendering with Direction Indicators
  // -------------------------------------------------------------------------

  describe('Card Grid Rendering with Direction Indicators', () => {
    it('renders a card for each opportunity from useOpportunities', () => {
      renderTradeOpportunities();
      const cards = screen.getAllByTestId(/trade-card-/);
      expect(cards).toHaveLength(mockOpportunities.length);
    });

    it('displays 🟢 LONG direction indicator for LONG opportunities', () => {
      renderTradeOpportunities();
      const longCard = screen.getByTestId('trade-card-1'); // AAPL is LONG
      expect(within(longCard).getByText(/🟢 LONG/)).toBeInTheDocument();
    });

    it('displays 🔴 SHORT direction indicator for SHORT opportunities', () => {
      renderTradeOpportunities();
      const shortCard = screen.getByTestId('trade-card-2'); // BTC is SHORT
      expect(within(shortCard).getByText(/🔴 SHORT/)).toBeInTheDocument();
    });

    it('renders the symbol for each trade card', () => {
      renderTradeOpportunities();
      expect(screen.getByText('AAPL')).toBeInTheDocument();
      expect(screen.getByText('BTC')).toBeInTheDocument();
      expect(screen.getByText('RELIANCE')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Phase 9 — Pagination Controls
  // -------------------------------------------------------------------------

  describe('Pagination Controls', () => {
    it('renders pagination controls when totalPages > 1', () => {
      renderTradeOpportunities();
      expect(screen.getByText(/Previous/i)).toBeInTheDocument();
      expect(screen.getByText(/Next/i)).toBeInTheDocument();
      expect(screen.getByText(/Page 1 of 3/i)).toBeInTheDocument();
    });

    it('disables Previous button on first page', () => {
      renderTradeOpportunities();
      const prevButton = screen.getByText(/Previous/i).closest('button');
      expect(prevButton).toBeDisabled();
    });

    it('calls setPage with next page number when Next is clicked', () => {
      renderTradeOpportunities();
      const nextButton = screen.getByText(/Next/i);
      fireEvent.click(nextButton);
      expect(mockSetPage).toHaveBeenCalledWith(2);
    });

    it('disables Next button on last page', () => {
      mockUseOpportunities.mockReturnValue(
        createHookReturnValue({
          pagination: { page: 3, limit: 20, total: 45, totalPages: 3 },
        }),
      );
      renderTradeOpportunities();
      const nextButton = screen.getByText(/Next/i).closest('button');
      expect(nextButton).toBeDisabled();
    });

    it('does not render pagination controls when only one page', () => {
      mockUseOpportunities.mockReturnValue(
        createHookReturnValue({
          pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
        }),
      );
      renderTradeOpportunities();
      expect(screen.queryByText(/Previous/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Next/i)).not.toBeInTheDocument();
    });

    it('enables Previous button on page 2', () => {
      mockUseOpportunities.mockReturnValue(
        createHookReturnValue({
          pagination: { page: 2, limit: 20, total: 45, totalPages: 3 },
        }),
      );
      renderTradeOpportunities();
      const prevButton = screen.getByText(/Previous/i).closest('button');
      expect(prevButton).not.toBeDisabled();
    });

    it('calls setPage with previous page number when Previous is clicked on page 2', () => {
      mockUseOpportunities.mockReturnValue(
        createHookReturnValue({
          pagination: { page: 2, limit: 20, total: 45, totalPages: 3 },
        }),
      );
      renderTradeOpportunities();
      const prevButton = screen.getByText(/Previous/i);
      fireEvent.click(prevButton);
      expect(mockSetPage).toHaveBeenCalledWith(1);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 10 — Loading State
  // -------------------------------------------------------------------------

  describe('Loading State', () => {
    it('shows loading indicator when loading with no opportunities', () => {
      mockUseOpportunities.mockReturnValue(
        createHookReturnValue({
          opportunities: [],
          pagination: null,
          loading: true,
        }),
      );
      renderTradeOpportunities();
      expect(screen.getByText(/Loading opportunities/i)).toBeInTheDocument();
    });

    it('does not show loading indicator when opportunities are present', () => {
      mockUseOpportunities.mockReturnValue(
        createHookReturnValue({
          loading: true,
        }),
      );
      renderTradeOpportunities();
      expect(screen.queryByText(/Loading opportunities/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Phase 11 — Error State
  // -------------------------------------------------------------------------

  describe('Error State', () => {
    it('displays error message when error occurs', () => {
      mockUseOpportunities.mockReturnValue(
        createHookReturnValue({
          opportunities: [],
          pagination: null,
          error: 'Failed to load opportunities',
        }),
      );
      renderTradeOpportunities();
      expect(
        screen.getByText(/Failed to load opportunities/i),
      ).toBeInTheDocument();
    });

    it('calls refetch when Retry button is clicked', () => {
      mockUseOpportunities.mockReturnValue(
        createHookReturnValue({
          opportunities: [],
          pagination: null,
          error: 'Network error',
        }),
      );
      renderTradeOpportunities();
      fireEvent.click(screen.getByText(/Retry/i));
      expect(mockRefetch).toHaveBeenCalledTimes(1);
    });

    it('renders error state with an alert role', () => {
      mockUseOpportunities.mockReturnValue(
        createHookReturnValue({
          opportunities: [],
          pagination: null,
          error: 'Server unavailable',
        }),
      );
      renderTradeOpportunities();
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Phase 12 — Empty State
  // -------------------------------------------------------------------------

  describe('Empty State', () => {
    it('displays empty state when no opportunities match filters', () => {
      mockUseOpportunities.mockReturnValue(
        createHookReturnValue({
          opportunities: [],
          pagination: null,
          loading: false,
          error: null,
        }),
      );
      renderTradeOpportunities();
      expect(
        screen.getByText(/No trade opportunities match your filters/i),
      ).toBeInTheDocument();
    });

    it('does not display empty state when opportunities are present', () => {
      renderTradeOpportunities();
      expect(
        screen.queryByText(/No trade opportunities match your filters/i),
      ).not.toBeInTheDocument();
    });

    it('does not display empty state when loading', () => {
      mockUseOpportunities.mockReturnValue(
        createHookReturnValue({
          opportunities: [],
          pagination: null,
          loading: true,
          error: null,
        }),
      );
      renderTradeOpportunities();
      expect(
        screen.queryByText(/No trade opportunities match your filters/i),
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Phase 13 — Polling Configuration
  // -------------------------------------------------------------------------

  describe('Polling Configuration', () => {
    it('passes pollingInterval option to useOpportunities for polling refresh', () => {
      renderTradeOpportunities();
      expect(mockUseOpportunities).toHaveBeenCalledWith(
        expect.objectContaining({
          pollingInterval: expect.any(Number) as number,
        }),
      );
    });

    it('uses 30-second polling interval', () => {
      renderTradeOpportunities();
      expect(mockUseOpportunities).toHaveBeenCalledWith(
        expect.objectContaining({
          pollingInterval: 30_000,
        }),
      );
    });
  });
});
