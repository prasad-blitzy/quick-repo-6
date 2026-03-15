/// <reference types="vitest/globals" />
/**
 * tests/components/TokenCard.test.tsx — Individual Token Signal Card Component Tests
 *
 * Comprehensive tests for the TokenCard Preact component verifying:
 * - Token name/symbol display from store data and signal props
 * - Composite score gauge rendering via mocked ScoreGauge child
 * - Safety badge rendering via mocked SafetyBadge child
 * - Smart money indicator rendering in expanded view
 * - AI insight summary rendering when analysis data is available
 * - Quick-action button interactions (copy address to clipboard)
 * - Expandable/collapsible card behavior (compact ↔ expanded toggle)
 * - Decision badge text and color-coding for BUY/SKIP/EXIT decisions
 * - Graceful handling of missing/null token data (loading state)
 * - Conditional exit strategy display based on hasPosition prop
 *
 * Per AAP Section 0.6.1 Test Files:
 *   tests/components -- Preact component rendering tests
 *   (SignalPanel, TokenCard, SafetyBadge, ScoreGauge, SettingsPanel)
 *
 * Environment: Vitest 4.1.0 + happy-dom + @testing-library/preact 3.2.4
 * Framework:   Preact 10.29.0 — NO React imports
 *
 * @module tests/components/TokenCard.test
 */

import { h } from 'preact';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Type-only imports — used for factory function type annotations
import type { CompositeSignal, FactorResult } from '../../src/signals/types';
import type { SafetyReport } from '../../src/safety/types';
import type { AIAnalysisResult } from '../../src/ai/types';

// =============================================================================
// Hoisted Mock References
// =============================================================================
// vi.hoisted() runs before any vi.mock factory, making these references
// accessible inside vi.mock() calls without scope/hoisting issues.
// All real implementations are set in beforeEach() where `h` is available.

const mocks = vi.hoisted(() => ({
  // Child component mocks
  SafetyBadge: vi.fn(),
  ScoreGauge: vi.fn(),
  AIInsight: vi.fn(),
  SmartMoneyIndicator: vi.fn(),
  ExitStrategy: vi.fn(),

  // Store hook mocks
  useTokenStoreHook: vi.fn(),
  useSignalStoreHook: vi.fn(),
  usePositionStoreHook: vi.fn(),

  // Formatting utility mocks
  formatPrice: vi.fn(),
  formatMarketCap: vi.fn(),
  formatPercent: vi.fn(),
  formatTimeAgo: vi.fn(),
  formatVolume: vi.fn(),
}));

// =============================================================================
// Module Mocks (hoisted by vitest before imports)
// =============================================================================

// --- Child components (isolated via mocks to test TokenCard in isolation) ---

vi.mock('../../src/components/SafetyBadge', () => ({
  SafetyBadge: mocks.SafetyBadge,
}));

vi.mock('../../src/components/ScoreGauge', () => ({
  ScoreGauge: mocks.ScoreGauge,
}));

vi.mock('../../src/components/AIInsight', () => ({
  AIInsight: mocks.AIInsight,
}));

vi.mock('../../src/components/SmartMoneyIndicator', () => ({
  SmartMoneyIndicator: mocks.SmartMoneyIndicator,
}));

vi.mock('../../src/components/ExitStrategy', () => ({
  ExitStrategy: mocks.ExitStrategy,
}));

// --- Store hooks (mocked to provide controlled test data) ---

vi.mock('../../src/store/index', () => ({
  useTokenStoreHook: mocks.useTokenStoreHook,
  useSignalStoreHook: mocks.useSignalStoreHook,
  usePositionStoreHook: mocks.usePositionStoreHook,
}));

// --- Formatting utilities (deterministic output for assertions) ---

vi.mock('../../src/utils/formatting', () => ({
  formatPrice: mocks.formatPrice,
  formatMarketCap: mocks.formatMarketCap,
  formatPercent: mocks.formatPercent,
  formatTimeAgo: mocks.formatTimeAgo,
  formatVolume: mocks.formatVolume,
}));

// =============================================================================
// Component Under Test (imported after all mocks are registered)
// =============================================================================

import { TokenCard } from '../../src/components/TokenCard';

// =============================================================================
// Constants
// =============================================================================

/** Standard Solana mint address used across all test fixtures. */
const MOCK_MINT = 'So11111111111111111111111111111111111111112';

// =============================================================================
// Test Data Factories
// =============================================================================

/**
 * Creates a mock CompositeSignal with sensible defaults for a BUY signal.
 * All 7 factor names per AAP are included: volumeSpike, smartMoneyConvergence,
 * buySellRatio, holderGrowth, liquidity, tokenAge, safetyScore.
 *
 * @param overrides - Partial overrides to merge into the default signal
 * @returns A complete CompositeSignal object
 */
function createMockSignal(overrides: Partial<CompositeSignal> = {}): CompositeSignal {
  return {
    tokenMint: MOCK_MINT,
    composite: 78,
    factors: [
      { name: 'volumeSpike', score: 80, weight: 0.2, metadata: {} },
      { name: 'smartMoneyConvergence', score: 70, weight: 0.2, metadata: {} },
      { name: 'buySellRatio', score: 65, weight: 0.15, metadata: {} },
      { name: 'holderGrowth', score: 60, weight: 0.1, metadata: {} },
      { name: 'liquidity', score: 85, weight: 0.15, metadata: {} },
      { name: 'tokenAge', score: 90, weight: 0.1, metadata: {} },
      { name: 'safetyScore', score: 75, weight: 0.1, metadata: {} },
    ],
    decision: 'BUY',
    confidence: 0.85,
    timestamp: Date.now(),
    tradingMode: 'conservative',
    hardFilterResult: {
      passed: true,
      failedFilters: [],
      failedReason: null,
      checkedAt: Date.now(),
    },
    tokenSymbol: 'BONK',
    ...overrides,
  };
}

/**
 * Creates mock token data matching the shape expected by the token store.
 * Includes all fields that TokenCard reads via useTokenStoreHook selector.
 *
 * @param overrides - Field overrides merged into default token data
 * @returns Token data object for the mock store
 */
function createMockTokenData(overrides: Record<string, unknown> = {}) {
  return {
    mint: MOCK_MINT,
    symbol: 'BONK',
    name: 'Bonk',
    price: 0.00001234,
    priceChange24h: 145.5,
    marketCap: 850000,
    volume24h: 1200000,
    volume5m: 15000,
    liquidity: 45000,
    holderCount: 12500,
    top10HolderPercent: 22.5,
    safetyReport: null,
    aiAnalysis: null,
    smartMoneyCount: 3,
    smartMoneyWallets: [] as string[],
    devWalletAddress: 'dev-wallet-address',
    devWalletSold: false,
    createdAt: Date.now() / 1000 - 3600,
    logoUrl: '',
    ...overrides,
  };
}

/**
 * Creates a mock SafetyReport with safe defaults for testing badge rendering.
 * Returns a partial object that satisfies the TokenCard's SafetyBadge prop.
 */
function createMockSafetyReport(): Record<string, unknown> {
  return {
    mint: MOCK_MINT,
    overallScore: 450,
    rugCheckScore: 500,
    goPlusResult: null,
    honeypotResult: { sellable: true, estimatedTax: 0 },
    lpStatus: { burned: true, burnPercent: 95, locked: false },
    authorityStatus: { mintRevoked: true, freezeRevoked: true, metadataMutable: false },
    riskFactors: [],
    isToken2022: false,
    checkedAt: Date.now(),
    rugCheckAvailable: true,
    goPlusAvailable: false,
    top10HolderPercent: 15,
    largestHolderPercent: 8,
  };
}

/**
 * Creates a mock AIAnalysisResult for testing AI insight rendering.
 * Contains all 5 analysis dimensions per AAP specification.
 */
function createMockAIAnalysis(): Record<string, unknown> {
  return {
    dimensions: [
      { name: 'on-chain momentum', score: 82, reasoning: 'Strong buy pressure detected in initial 5 minutes' },
      { name: 'social velocity', score: 65, reasoning: 'Growing social mentions with moderate acceleration' },
      { name: 'wallet intelligence', score: 78, reasoning: 'Three known profitable wallets accumulating' },
      { name: 'liquidity health', score: 70, reasoning: 'LP burned with healthy depth' },
      { name: 'narrative fit', score: 55, reasoning: 'Moderate meme appeal, aligns with current trends' },
    ],
    compositeAI: 70,
    confidence: 'high',
    narrative: 'Strong early momentum with smart money convergence detected.',
    tier: 'detailed',
    timestamp: Date.now(),
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('TokenCard', () => {
  // ---------------------------------------------------------------------------
  // Setup & Teardown
  // ---------------------------------------------------------------------------

  beforeEach(() => {
    // ── Child component mock implementations ──
    // Each mock renders a div with a data-testid for assertion queries.
    // The `h` function from preact is available here (not in vi.mock factories).

    mocks.SafetyBadge.mockImplementation((props: Record<string, unknown>) =>
      h('div', { 'data-testid': 'safety-badge' }, props.report ? 'loaded' : 'pending'),
    );

    mocks.ScoreGauge.mockImplementation((props: Record<string, unknown>) =>
      h('div', {
        'data-testid': 'score-gauge',
        'data-score': String(props.score),
      }, String(props.score)),
    );

    mocks.AIInsight.mockImplementation((props: Record<string, unknown>) => {
      const analysis = props.analysis as Record<string, unknown> | null | undefined;
      return h('div', { 'data-testid': 'ai-insight' }, (analysis?.narrative as string) || '');
    });

    mocks.SmartMoneyIndicator.mockImplementation((props: Record<string, unknown>) =>
      h('div', { 'data-testid': 'smart-money' }, String(props.tokenMint)),
    );

    mocks.ExitStrategy.mockImplementation((props: Record<string, unknown>) =>
      h('div', { 'data-testid': 'exit-strategy' }, String(props.tokenMint)),
    );

    // ── Formatting utility mock implementations ──
    // Deterministic formatters for predictable test assertions.

    mocks.formatPrice.mockImplementation(
      (n: number) => `$${Number(n).toFixed(6)}`,
    );

    mocks.formatMarketCap.mockImplementation(
      (n: number) => `$${(Number(n) / 1000).toFixed(0)}K`,
    );

    mocks.formatPercent.mockImplementation((n: number) => ({
      text: `${n >= 0 ? '+' : ''}${Number(n).toFixed(1)}%`,
      colorHint: n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral',
    }));

    mocks.formatTimeAgo.mockImplementation(() => '2h ago');

    mocks.formatVolume.mockImplementation(
      (n: number) => `$${(Number(n) / 1000).toFixed(0)}K`,
    );

    // ── Store hook mock implementations ──
    // Default: token store returns valid mock data for MOCK_MINT.

    mocks.useTokenStoreHook.mockImplementation(
      (selector: (state: Record<string, unknown>) => unknown) =>
        selector({ tokens: { [MOCK_MINT]: createMockTokenData() } }),
    );

    mocks.useSignalStoreHook.mockImplementation(() => ({}));
    mocks.usePositionStoreHook.mockImplementation(() => ({}));

    // ── Clipboard mock ──
    // Provides navigator.clipboard.writeText for copy-address tests.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Helper: expand the card by clicking its header
  // ---------------------------------------------------------------------------

  /**
   * Clicks the card header button to toggle from collapsed to expanded view.
   * Finds the header via its aria-label containing "Click to expand".
   */
  function expandCard(): void {
    const header = screen.getByRole('button', { name: /click to expand/i });
    fireEvent.click(header);
  }

  // ---------------------------------------------------------------------------
  // Test 1: Displays token name/symbol correctly
  // ---------------------------------------------------------------------------

  it('displays token name and symbol correctly from store data', () => {
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));

    // Token symbol should be visible in compact card view
    expect(screen.getByText('BONK')).toBeTruthy();

    // Token name should be visible
    expect(screen.getByText('Bonk')).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Test 2: Shows composite score gauge
  // ---------------------------------------------------------------------------

  it('renders ScoreGauge with the correct composite score', () => {
    render(h(TokenCard, {
      signal: createMockSignal({ composite: 78 }),
      hasPosition: false,
    }));

    // ScoreGauge mock should render with data-testid and data-score
    const gauge = screen.getByTestId('score-gauge');
    expect(gauge).toBeTruthy();
    expect(gauge.getAttribute('data-score')).toBe('78');
    expect(gauge.textContent).toBe('78');
  });

  // ---------------------------------------------------------------------------
  // Test 3: Renders safety badge
  // ---------------------------------------------------------------------------

  it('renders safety badge with loaded state when report exists', () => {
    // Override token store to include a safety report
    mocks.useTokenStoreHook.mockImplementation(
      (selector: (state: Record<string, unknown>) => unknown) =>
        selector({
          tokens: {
            [MOCK_MINT]: createMockTokenData({
              safetyReport: createMockSafetyReport(),
            }),
          },
        }),
    );

    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));

    const badge = screen.getByTestId('safety-badge');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe('loaded');
  });

  it('renders safety badge with pending state when no report', () => {
    // Default mock token data has safetyReport: null
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));

    const badge = screen.getByTestId('safety-badge');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe('pending');
  });

  // ---------------------------------------------------------------------------
  // Test 4: Shows smart money indicators (expanded view)
  // ---------------------------------------------------------------------------

  it('shows smart money indicator component in expanded view only', () => {
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));

    // SmartMoneyIndicator should NOT be in collapsed view
    expect(screen.queryByTestId('smart-money')).toBeNull();

    // Expand the card
    expandCard();

    // SmartMoneyIndicator should now be visible with the token mint
    const indicator = screen.getByTestId('smart-money');
    expect(indicator).toBeTruthy();
    expect(indicator.textContent).toBe(MOCK_MINT);
  });

  // ---------------------------------------------------------------------------
  // Test 5: AI insight summary rendering (expanded view)
  // ---------------------------------------------------------------------------

  it('renders AI insight when analysis data is available in expanded view', () => {
    // Override token store to include AI analysis
    mocks.useTokenStoreHook.mockImplementation(
      (selector: (state: Record<string, unknown>) => unknown) =>
        selector({
          tokens: {
            [MOCK_MINT]: createMockTokenData({
              aiAnalysis: createMockAIAnalysis(),
            }),
          },
        }),
    );

    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));

    // AI insight should NOT be visible in collapsed view
    expect(screen.queryByTestId('ai-insight')).toBeNull();

    // Expand the card
    expandCard();

    // AI insight should now render with the narrative text
    const insight = screen.getByTestId('ai-insight');
    expect(insight).toBeTruthy();
    expect(insight.textContent).toBe(
      'Strong early momentum with smart money convergence detected.',
    );
  });

  it('does not render AI insight when no analysis data exists', () => {
    // Default mock token data has aiAnalysis: null
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));
    expandCard();

    // AIInsight should not be rendered when aiAnalysis is null
    expect(screen.queryByTestId('ai-insight')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Test 6: Quick-action button interactions (copy address)
  // ---------------------------------------------------------------------------

  it('copies token mint address to clipboard on copy button click', async () => {
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));

    // Expand the card to access quick-action buttons
    expandCard();

    // Find the copy button by its accessible name
    const copyBtn = screen.getByRole('button', { name: /copy token mint address/i });
    expect(copyBtn).toBeTruthy();

    // Click the copy button
    fireEvent.click(copyBtn);

    // Verify clipboard.writeText was called with the correct mint address
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(MOCK_MINT);
    });

    // Verify feedback text appears after successful copy
    await waitFor(() => {
      expect(screen.getByText(/Copied/)).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // Test 7: Expandable card behavior
  // ---------------------------------------------------------------------------

  it('toggles between collapsed and expanded views on header click', () => {
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));

    // === Collapsed state assertions ===
    // Factor breakdown, market data, quick actions should NOT be visible
    expect(screen.queryByRole('list', { name: /signal factor breakdown/i })).toBeNull();
    expect(screen.queryByRole('list', { name: /market metrics/i })).toBeNull();
    expect(screen.queryByRole('group', { name: /quick actions/i })).toBeNull();

    // Click header to expand
    expandCard();

    // === Expanded state assertions ===
    // Factor breakdown SHOULD be visible
    expect(screen.getByRole('list', { name: /signal factor breakdown/i })).toBeTruthy();
    // Market data SHOULD be visible
    expect(screen.getByRole('list', { name: /market metrics/i })).toBeTruthy();
    // Quick-action buttons SHOULD be visible
    expect(screen.getByRole('group', { name: /quick actions/i })).toBeTruthy();
    // Decision badge SHOULD be visible
    expect(screen.getByRole('status', { name: /decision/i })).toBeTruthy();

    // Click header again to collapse
    const collapseHeader = screen.getByRole('button', { name: /click to collapse/i });
    fireEvent.click(collapseHeader);

    // === Back to collapsed state ===
    expect(screen.queryByRole('list', { name: /signal factor breakdown/i })).toBeNull();
    expect(screen.queryByRole('list', { name: /market metrics/i })).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Test 8: Decision badge color-coding
  // ---------------------------------------------------------------------------

  it('renders correct decision badge for BUY decision', () => {
    render(h(TokenCard, {
      signal: createMockSignal({ decision: 'BUY', confidence: 0.85 }),
      hasPosition: false,
    }));
    expandCard();

    const badge = screen.getByRole('status', { name: /decision: buy/i });
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('BUY');
    expect(badge.textContent).toContain('85%');
  });

  it('renders correct decision badge for SKIP decision', () => {
    render(h(TokenCard, {
      signal: createMockSignal({ decision: 'SKIP', confidence: 0.3 }),
      hasPosition: false,
    }));
    expandCard();

    const badge = screen.getByRole('status', { name: /decision: skip/i });
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('SKIP');
    expect(badge.textContent).toContain('30%');
  });

  it('renders correct decision badge for EXIT decision', () => {
    render(h(TokenCard, {
      signal: createMockSignal({ decision: 'EXIT', confidence: 0.92 }),
      hasPosition: true,
    }));
    expandCard();

    const badge = screen.getByRole('status', { name: /decision: exit/i });
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('EXIT');
    expect(badge.textContent).toContain('92%');
  });

  // ---------------------------------------------------------------------------
  // Test 9: Handles null tokenData gracefully (loading state)
  // ---------------------------------------------------------------------------

  it('renders loading state without crashing when token data is unavailable', () => {
    // Override store to return undefined for the token (empty tokens map)
    mocks.useTokenStoreHook.mockImplementation(
      (selector: (state: Record<string, unknown>) => unknown) =>
        selector({ tokens: {} }),
    );

    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));

    // Should NOT crash — rendering completes
    // Token symbol from signal.tokenSymbol should be visible
    expect(screen.getByText('BONK')).toBeTruthy();

    // Loading indicator text should be visible
    expect(screen.getByText('Loading…')).toBeTruthy();

    // ScoreGauge should still render with the signal's composite score
    const gauge = screen.getByTestId('score-gauge');
    expect(gauge).toBeTruthy();
    expect(gauge.getAttribute('data-score')).toBe('78');

    // Safety pending indicator should be visible
    expect(screen.getByRole('status', { name: /safety check pending/i })).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Test 10: Exit strategy shown when hasPosition is true
  // ---------------------------------------------------------------------------

  it('shows ExitStrategy component when user has an active position', () => {
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: true }));
    expandCard();

    const exitStrategy = screen.getByTestId('exit-strategy');
    expect(exitStrategy).toBeTruthy();
    expect(exitStrategy.textContent).toBe(MOCK_MINT);
  });

  // ---------------------------------------------------------------------------
  // Test 11: Exit strategy NOT shown when hasPosition is false
  // ---------------------------------------------------------------------------

  it('does not show ExitStrategy when user has no position', () => {
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));
    expandCard();

    expect(screen.queryByTestId('exit-strategy')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Additional coverage: position badge in compact view
  // ---------------------------------------------------------------------------

  it('shows position badge in compact view when hasPosition is true', () => {
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: true }));

    // Position badge icon + text should be visible in compact card
    expect(screen.getByText(/POS/)).toBeTruthy();
  });

  it('does not show position badge when hasPosition is false', () => {
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));

    // Position badge should NOT be in collapsed view without a position
    expect(screen.queryByText(/📍 POS/)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Additional coverage: GMGN link button
  // ---------------------------------------------------------------------------

  it('renders GMGN quick-action link button in expanded view', () => {
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));
    expandCard();

    const gmgnBtn = screen.getByRole('button', { name: /open token on gmgn/i });
    expect(gmgnBtn).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Additional coverage: Track button conditionality
  // ---------------------------------------------------------------------------

  it('shows Track button only when user has no position', () => {
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));
    expandCard();

    const trackBtn = screen.getByRole('button', { name: /track position/i });
    expect(trackBtn).toBeTruthy();
  });

  it('hides Track button when user already has a position', () => {
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: true }));
    expandCard();

    expect(screen.queryByRole('button', { name: /track position/i })).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Additional coverage: all 7 factor bars in expanded breakdown
  // ---------------------------------------------------------------------------

  it('renders all 7 factor bars in the expanded factor breakdown', () => {
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));
    expandCard();

    // Per AAP: factor display labels are mapped from camelCase names
    const expectedLabels = [
      'Volume',    // volumeSpike
      'Smart $',   // smartMoneyConvergence
      'Buy/Sell',  // buySellRatio
      'Holders',   // holderGrowth
      'Liquidity', // liquidity
      'Age',       // tokenAge
      'Safety',    // safetyScore
    ];

    for (const label of expectedLabels) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  // ---------------------------------------------------------------------------
  // Additional coverage: market data display
  // ---------------------------------------------------------------------------

  it('displays formatted market data in the expanded view', () => {
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));
    expandCard();

    // Market data labels should be rendered
    expect(screen.getByText(/MCap:/)).toBeTruthy();
    expect(screen.getByText(/Vol:/)).toBeTruthy();
    expect(screen.getByText(/Liq:/)).toBeTruthy();
    expect(screen.getByText(/Holders:/)).toBeTruthy();
    expect(screen.getByText(/Age:/)).toBeTruthy();

    // Verify formatting mocks were called with correct data
    expect(mocks.formatMarketCap).toHaveBeenCalledWith(850000);
    expect(mocks.formatVolume).toHaveBeenCalledWith(1200000);
    expect(mocks.formatTimeAgo).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Additional coverage: symbol fallback chain
  // ---------------------------------------------------------------------------

  it('falls back to signal tokenSymbol when store has no symbol', () => {
    // Token store returns data with empty symbol and name
    mocks.useTokenStoreHook.mockImplementation(
      (selector: (state: Record<string, unknown>) => unknown) =>
        selector({
          tokens: {
            [MOCK_MINT]: createMockTokenData({ symbol: '', name: '' }),
          },
        }),
    );

    render(h(TokenCard, {
      signal: createMockSignal({ tokenSymbol: 'PEPE' }),
      hasPosition: false,
    }));

    // Should display the signal's tokenSymbol as fallback
    expect(screen.getByText('PEPE')).toBeTruthy();
  });

  it('shows "???" when neither store nor signal provides a symbol', () => {
    // Token store returns data with empty symbol
    mocks.useTokenStoreHook.mockImplementation(
      (selector: (state: Record<string, unknown>) => unknown) =>
        selector({
          tokens: {
            [MOCK_MINT]: createMockTokenData({ symbol: '', name: '' }),
          },
        }),
    );

    render(h(TokenCard, {
      signal: createMockSignal({ tokenSymbol: undefined }),
      hasPosition: false,
    }));

    // Should display the fallback "???"
    expect(screen.getByText('???')).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Additional coverage: smart money compact count
  // ---------------------------------------------------------------------------

  it('shows smart money compact count when smartMoneyCount > 0', () => {
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));

    // In compact view, the smart money count shows as "🧠3"
    expect(screen.getByText(/🧠3/)).toBeTruthy();
  });

  it('hides smart money compact count when smartMoneyCount is 0', () => {
    mocks.useTokenStoreHook.mockImplementation(
      (selector: (state: Record<string, unknown>) => unknown) =>
        selector({
          tokens: {
            [MOCK_MINT]: createMockTokenData({ smartMoneyCount: 0 }),
          },
        }),
    );

    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));

    // Smart money emoji count should not be rendered
    expect(screen.queryByText(/🧠/)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Additional coverage: price display
  // ---------------------------------------------------------------------------

  it('displays formatted token price in compact view', () => {
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));

    // formatPrice mock returns "$0.000012"
    expect(mocks.formatPrice).toHaveBeenCalledWith(0.00001234);
  });

  // ---------------------------------------------------------------------------
  // Additional coverage: price change display
  // ---------------------------------------------------------------------------

  it('displays formatted price change percentage', () => {
    render(h(TokenCard, { signal: createMockSignal(), hasPosition: false }));

    // formatPercent mock should be called with the token's priceChange24h
    expect(mocks.formatPercent).toHaveBeenCalledWith(145.5);

    // The formatted text should appear in the DOM
    expect(screen.getByText('+145.5%')).toBeTruthy();
  });
});
