/**
 * tests/components/SignalPanel.test.tsx — Main Signal List Panel Component Tests
 *
 * Comprehensive tests for the SignalPanel Preact component verifying:
 * - Empty state rendering when no signals match filters
 * - Active signals displayed sorted by composite score descending
 * - Correct active signal count in the summary bar
 * - Trading mode badge display (Conservative / Aggressive)
 * - Filter controls: min score slider, sort order toggle
 * - SKIP decision exclusion from the visible signal list
 * - Position integration via hasPosition prop on TokenCard
 * - Signal history summary display
 *
 * All Zustand store hooks are mocked to provide deterministic test state.
 * TokenCard child component is mocked for isolation.
 *
 * Preact 10.29.0 ONLY — NO React imports per AAP Section 0.7.5.
 * Vitest 4.1.0 with happy-dom environment.
 * @testing-library/preact 3.2.4 for render, screen, fireEvent.
 */

import { h } from 'preact';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Type-only imports for test data factories
import type { CompositeSignal, FactorResult, TradingMode } from '../../src/signals/types';

// ============================================================================
// Module Mocks (hoisted by vitest before all imports)
// ============================================================================

/**
 * Mock Zustand store hooks — provide controllable state without real
 * chrome.storage or Zustand stores. Each mock accepts a selector function
 * and returns the selected slice from a configurable mock state object.
 */
vi.mock('../../src/store/index', () => ({
  useSignalStoreHook: vi.fn(),
  useSettingsStoreHook: vi.fn(),
  usePositionStoreHook: vi.fn(),
}));

/**
 * Mock TokenCard child component — renders a minimal div with data attributes
 * for asserting signal rendering order, count, and filter behavior without
 * testing TokenCard's own rendering logic.
 */
vi.mock('../../src/components/TokenCard', () => ({
  TokenCard: ({ signal, hasPosition }: any) => (
    <div
      data-testid={`token-card-${signal.tokenMint}`}
      data-score={signal.composite}
      data-has-position={String(hasPosition)}
    >
      {signal.tokenSymbol}
    </div>
  ),
}));

/**
 * Mock application config constants — provide controlled threshold values
 * for testing trading mode badge display and default minScore filter values.
 */
vi.mock('../../src/utils/config', () => ({
  SCORING_THRESHOLDS: {
    CONSERVATIVE_MIN: 80,
    AGGRESSIVE_MIN: 45,
  },
  UI_CONFIG: {
    SIDEBAR_WIDTH_PX: 350,
  },
}));

// Import mocked store hooks for controlling return values per test
import {
  useSignalStoreHook,
  useSettingsStoreHook,
  usePositionStoreHook,
} from '../../src/store/index';

// Import component under test (NOT mocked — rendered directly)
import { SignalPanel } from '../../src/components/SignalPanel';

// ============================================================================
// Test Data Factory
// ============================================================================

/** Counter for generating unique token mints and symbols in test data. */
let signalIdCounter = 0;

/**
 * Creates a realistic mock CompositeSignal with all 7 factor results.
 * Accepts partial overrides for any field. Timestamps default to now
 * so signals pass the default maxAge (12h) filter.
 */
function createMockSignal(
  overrides: Partial<CompositeSignal> = {},
): CompositeSignal {
  signalIdCounter += 1;
  const defaultMint = `mock-mint-${signalIdCounter}`;

  const defaultFactors: FactorResult[] = [
    { name: 'volumeSpike', score: 80, weight: 0.2, metadata: {} },
    { name: 'smartMoneyConvergence', score: 70, weight: 0.2, metadata: {} },
    { name: 'buySellRatio', score: 65, weight: 0.15, metadata: {} },
    { name: 'holderGrowth', score: 60, weight: 0.1, metadata: {} },
    { name: 'liquidity', score: 85, weight: 0.15, metadata: {} },
    { name: 'tokenAge', score: 90, weight: 0.1, metadata: {} },
    { name: 'safetyScore', score: 75, weight: 0.1, metadata: {} },
  ];

  return {
    tokenMint: defaultMint,
    composite: 75,
    factors: defaultFactors,
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
    tokenSymbol: `TKN${signalIdCounter}`,
    ...overrides,
  };
}

// ============================================================================
// Store Mock Setup Helper
// ============================================================================

/**
 * Configures all three Zustand store hook mocks with the given state slices.
 * Each hook is called with a selector: `useHook((state) => state.field)`.
 * The mock implementation calls the selector with the provided mock state.
 */
function setupStoreMocks(
  opts: {
    signals?: Record<string, CompositeSignal>;
    signalHistory?: CompositeSignal[];
    tradingMode?: TradingMode;
    positions?: Record<string, unknown>;
  } = {},
): void {
  const {
    signals = {},
    signalHistory = [],
    tradingMode = 'conservative',
    positions = {},
  } = opts;

  const mockedSignalHook = useSignalStoreHook as unknown as ReturnType<typeof vi.fn>;
  mockedSignalHook.mockImplementation(
    (selector: (state: any) => any) => selector({ signals, signalHistory }),
  );

  const mockedSettingsHook = useSettingsStoreHook as unknown as ReturnType<typeof vi.fn>;
  mockedSettingsHook.mockImplementation(
    (selector: (state: any) => any) => selector({ tradingMode }),
  );

  const mockedPositionHook = usePositionStoreHook as unknown as ReturnType<typeof vi.fn>;
  mockedPositionHook.mockImplementation(
    (selector: (state: any) => any) => selector({ positions }),
  );
}

/**
 * Builds a Record<string, CompositeSignal> from an array of signals,
 * keyed by each signal's tokenMint.
 */
function toRecord(...signals: CompositeSignal[]): Record<string, CompositeSignal> {
  const rec: Record<string, CompositeSignal> = {};
  for (const sig of signals) {
    rec[sig.tokenMint] = sig;
  }
  return rec;
}

/**
 * Helper to query all mocked TokenCard elements from the rendered container.
 * Returns an array of Elements matching the data-testid prefix pattern.
 * Accepts Element (from render().container) rather than HTMLElement for compat.
 */
function getRenderedCards(container: Element): Element[] {
  return Array.from(container.querySelectorAll('[data-testid^="token-card-"]'));
}

/**
 * Extracts data-score values as numbers from rendered token card elements.
 */
function getCardScores(container: Element): number[] {
  return getRenderedCards(container).map(
    (el) => Number(el.getAttribute('data-score')),
  );
}

/**
 * Extracts data-testid values from rendered token card elements.
 */
function getCardTestIds(container: Element): string[] {
  return getRenderedCards(container).map(
    (el) => el.getAttribute('data-testid') ?? '',
  );
}

// ============================================================================
// Test Suite
// ============================================================================

describe('SignalPanel', () => {
  beforeEach(() => {
    signalIdCounter = 0;
    setupStoreMocks();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Rendering Tests
  // --------------------------------------------------------------------------

  describe('rendering', () => {
    it('shows empty state when no signals exist', () => {
      setupStoreMocks({ signals: {} });
      const { container } = render(<SignalPanel />);

      // Empty state message should be visible
      expect(screen.getByText('No signals matching filters')).toBeTruthy();
      expect(screen.getByText('Adjust filters or wait for new tokens')).toBeTruthy();

      // No TokenCard components should be rendered
      const cards = getRenderedCards(container);
      expect(cards.length).toBe(0);
    });

    it('shows empty state when all signals are below default minScore threshold', () => {
      // Conservative mode default minScore = 80. Signal composite = 50 < 80.
      const lowSignal = createMockSignal({
        tokenMint: 'low-score',
        composite: 50,
        tokenSymbol: 'LOW',
      });

      setupStoreMocks({
        signals: toRecord(lowSignal),
        tradingMode: 'conservative',
      });

      const { container } = render(<SignalPanel />);

      // Empty state should appear since signal is below minScore
      expect(screen.getByText('No signals matching filters')).toBeTruthy();
      expect(getRenderedCards(container).length).toBe(0);
    });

    it('renders active signals sorted by composite score descending', () => {
      // Use aggressive mode so lower-scored signals (>= 45) pass the default filter
      const sigA = createMockSignal({
        tokenMint: 'mint-a',
        composite: 45,
        tokenSymbol: 'AAA',
      });
      const sigB = createMockSignal({
        tokenMint: 'mint-b',
        composite: 85,
        tokenSymbol: 'BBB',
      });
      const sigC = createMockSignal({
        tokenMint: 'mint-c',
        composite: 62,
        tokenSymbol: 'CCC',
      });

      setupStoreMocks({
        signals: toRecord(sigA, sigB, sigC),
        tradingMode: 'aggressive',
      });

      const { container } = render(<SignalPanel />);
      const cards = getRenderedCards(container);

      // Verify all 3 signals are rendered
      expect(cards.length).toBe(3);

      // Verify sorted by composite score descending: 85, 62, 45
      const scores = getCardScores(container);
      expect(scores).toEqual([85, 62, 45]);
    });

    it('displays correct active signal count in summary bar', () => {
      // Create 5 BUY signals all above conservative threshold (80)
      const signals = toRecord(
        createMockSignal({ tokenMint: 's1', composite: 90 }),
        createMockSignal({ tokenMint: 's2', composite: 85 }),
        createMockSignal({ tokenMint: 's3', composite: 92 }),
        createMockSignal({ tokenMint: 's4', composite: 88 }),
        createMockSignal({ tokenMint: 's5', composite: 91 }),
      );

      setupStoreMocks({ signals });
      render(<SignalPanel />);

      // Summary bar shows the total active count (non-SKIP signals)
      // The text is "<strong>5</strong> Active Signals"
      expect(screen.getByText('5')).toBeTruthy();
      expect(screen.getByText(/Active Signal/)).toBeTruthy();
    });

    it('displays BUY signal count in summary', () => {
      const buySig1 = createMockSignal({
        tokenMint: 'b1',
        composite: 90,
        decision: 'BUY',
      });
      const buySig2 = createMockSignal({
        tokenMint: 'b2',
        composite: 85,
        decision: 'BUY',
      });
      const exitSig = createMockSignal({
        tokenMint: 'e1',
        composite: 88,
        decision: 'EXIT',
      });

      setupStoreMocks({ signals: toRecord(buySig1, buySig2, exitSig) });
      render(<SignalPanel />);

      // Summary shows "(2 BUY)" for the count of BUY-decision signals
      expect(screen.getByText(/2 BUY/)).toBeTruthy();
    });

    it('displays Conservative mode badge when trading mode is conservative', () => {
      setupStoreMocks({ tradingMode: 'conservative' });
      render(<SignalPanel />);

      // Badge label generated by getModeBadgeLabel: "Conservative Mode (≥80)"
      expect(screen.getByText('Conservative Mode (≥80)')).toBeTruthy();
    });

    it('displays Aggressive mode badge when trading mode is aggressive', () => {
      setupStoreMocks({ tradingMode: 'aggressive' });
      render(<SignalPanel />);

      // Badge label: "Aggressive Mode (≥45)"
      expect(screen.getByText('Aggressive Mode (≥45)')).toBeTruthy();
    });
  });

  // --------------------------------------------------------------------------
  // Filter Control Tests
  // --------------------------------------------------------------------------

  describe('filter controls', () => {
    it('filter toggle button shows and hides filter controls', () => {
      setupStoreMocks();
      render(<SignalPanel />);

      // Filter controls should be hidden initially
      expect(screen.queryByLabelText('Minimum composite score')).toBeNull();

      // Click the toggle to show filters
      const showBtn = screen.getByLabelText('Show filter controls');
      fireEvent.click(showBtn);

      // Filter controls should now be visible
      expect(screen.getByLabelText('Minimum composite score')).toBeTruthy();

      // Click toggle again to hide filters
      const hideBtn = screen.getByLabelText('Hide filter controls');
      fireEvent.click(hideBtn);

      // Filter controls should be hidden again
      expect(screen.queryByLabelText('Minimum composite score')).toBeNull();
    });

    it('min score filter excludes signals below the set threshold', () => {
      // Use aggressive mode: default minScore = 45
      const sig40 = createMockSignal({
        tokenMint: 'm40',
        composite: 40,
        tokenSymbol: 'T40',
      });
      const sig55 = createMockSignal({
        tokenMint: 'm55',
        composite: 55,
        tokenSymbol: 'T55',
      });
      const sig70 = createMockSignal({
        tokenMint: 'm70',
        composite: 70,
        tokenSymbol: 'T70',
      });
      const sig85 = createMockSignal({
        tokenMint: 'm85',
        composite: 85,
        tokenSymbol: 'T85',
      });

      setupStoreMocks({
        signals: toRecord(sig40, sig55, sig70, sig85),
        tradingMode: 'aggressive',
      });

      const { container } = render(<SignalPanel />);

      // Initial: default min = 45, so sig40 (40 < 45) excluded; 3 cards shown
      expect(getRenderedCards(container).length).toBe(3);

      // Open filter controls
      fireEvent.click(screen.getByLabelText('Show filter controls'));

      // Set min score to 60 via the range slider
      const slider = screen.getByLabelText(
        'Minimum composite score',
      ) as HTMLInputElement;
      fireEvent.input(slider, { target: { value: '60' } });

      // Now sig40 (40 < 60) and sig55 (55 < 60) excluded; only sig70 and sig85
      const cards = getRenderedCards(container);
      expect(cards.length).toBe(2);

      // Verify the remaining signals are sorted descending: 85, 70
      const scores = getCardScores(container);
      expect(scores).toEqual([85, 70]);
    });

    it('sort by time orders signals by timestamp newest first', () => {
      const now = Date.now();

      const oldSig = createMockSignal({
        tokenMint: 'old',
        composite: 95,
        tokenSymbol: 'OLD',
        timestamp: now - 3 * 3600 * 1000, // 3 hours ago
      });
      const recentSig = createMockSignal({
        tokenMint: 'recent',
        composite: 82,
        tokenSymbol: 'NEW',
        timestamp: now - 1 * 3600 * 1000, // 1 hour ago
      });
      const midSig = createMockSignal({
        tokenMint: 'mid',
        composite: 88,
        tokenSymbol: 'MID',
        timestamp: now - 2 * 3600 * 1000, // 2 hours ago
      });

      setupStoreMocks({
        signals: toRecord(oldSig, recentSig, midSig),
        tradingMode: 'conservative', // all scores > 80
      });

      const { container } = render(<SignalPanel />);

      // Default sort = score descending: 95 (old), 88 (mid), 82 (recent)
      let testIds = getCardTestIds(container);
      expect(testIds).toEqual([
        'token-card-old',
        'token-card-mid',
        'token-card-recent',
      ]);

      // Open filter controls and click "Time" sort button
      fireEvent.click(screen.getByLabelText('Show filter controls'));
      fireEvent.click(screen.getByText('Time'));

      // Now sorted by timestamp newest first: recent (1h), mid (2h), old (3h)
      testIds = getCardTestIds(container);
      expect(testIds).toEqual([
        'token-card-recent',
        'token-card-mid',
        'token-card-old',
      ]);
    });

    it('excludes signals with SKIP decision from the list', () => {
      const buySignal = createMockSignal({
        tokenMint: 'buy-mint',
        composite: 90,
        decision: 'BUY',
        tokenSymbol: 'BUY',
      });
      const skipSignal = createMockSignal({
        tokenMint: 'skip-mint',
        composite: 95,
        decision: 'SKIP',
        tokenSymbol: 'SKIP',
      });
      const exitSignal = createMockSignal({
        tokenMint: 'exit-mint',
        composite: 88,
        decision: 'EXIT',
        tokenSymbol: 'EXIT',
      });

      setupStoreMocks({
        signals: toRecord(buySignal, skipSignal, exitSignal),
        tradingMode: 'conservative',
      });

      const { container } = render(<SignalPanel />);

      // Only BUY and EXIT signals should render (SKIP is excluded)
      const cards = getRenderedCards(container);
      expect(cards.length).toBe(2);

      // SKIP signal must not be rendered
      expect(
        container.querySelector('[data-testid="token-card-skip-mint"]'),
      ).toBeNull();

      // BUY and EXIT signals must be rendered
      expect(
        container.querySelector('[data-testid="token-card-buy-mint"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="token-card-exit-mint"]'),
      ).not.toBeNull();
    });

    it('sort by safety orders signals with passed filters first', () => {
      const passedSig = createMockSignal({
        tokenMint: 'safe',
        composite: 82,
        tokenSymbol: 'SAFE',
        hardFilterResult: {
          passed: true,
          failedFilters: [],
          failedReason: null,
          checkedAt: Date.now(),
        },
      });
      const failedSig = createMockSignal({
        tokenMint: 'risky',
        composite: 95,
        tokenSymbol: 'RISKY',
        hardFilterResult: {
          passed: false,
          failedFilters: ['mintAuthority'],
          failedReason: 'Active mint authority',
          checkedAt: Date.now(),
        },
      });

      setupStoreMocks({
        signals: toRecord(passedSig, failedSig),
        tradingMode: 'conservative',
      });

      const { container } = render(<SignalPanel />);

      // Default sort by score: risky (95) first, safe (82) second
      let testIds = getCardTestIds(container);
      expect(testIds).toEqual(['token-card-risky', 'token-card-safe']);

      // Switch to safety sort
      fireEvent.click(screen.getByLabelText('Show filter controls'));
      fireEvent.click(screen.getByText('Safety'));

      // Safety sort: passed first (safe), then failed (risky)
      testIds = getCardTestIds(container);
      expect(testIds).toEqual(['token-card-safe', 'token-card-risky']);
    });
  });

  // --------------------------------------------------------------------------
  // Position Integration Tests
  // --------------------------------------------------------------------------

  describe('position integration', () => {
    it('passes hasPosition=true to TokenCard for tokens with active positions', () => {
      const signal = createMockSignal({
        tokenMint: 'MINT-A',
        composite: 90,
        tokenSymbol: 'MINTA',
      });

      setupStoreMocks({
        signals: toRecord(signal),
        tradingMode: 'conservative',
        positions: {
          'MINT-A': { entryPrice: 0.001, entryTime: Date.now(), status: 'open' },
        },
      });

      const { container } = render(<SignalPanel />);

      const card = container.querySelector('[data-testid="token-card-MINT-A"]');
      expect(card).not.toBeNull();
      expect(card?.getAttribute('data-has-position')).toBe('true');
    });

    it('passes hasPosition=false to TokenCard for tokens without positions', () => {
      const signal = createMockSignal({
        tokenMint: 'MINT-B',
        composite: 90,
        tokenSymbol: 'MINTB',
      });

      setupStoreMocks({
        signals: toRecord(signal),
        tradingMode: 'conservative',
        positions: {},
      });

      const { container } = render(<SignalPanel />);

      const card = container.querySelector('[data-testid="token-card-MINT-B"]');
      expect(card).not.toBeNull();
      expect(card?.getAttribute('data-has-position')).toBe('false');
    });

    it('differentiates position status across multiple signals', () => {
      const sigWithPos = createMockSignal({
        tokenMint: 'WITH-POS',
        composite: 92,
        tokenSymbol: 'WITHPOS',
      });
      const sigWithoutPos = createMockSignal({
        tokenMint: 'WITHOUT-POS',
        composite: 88,
        tokenSymbol: 'NOPOS',
      });

      setupStoreMocks({
        signals: toRecord(sigWithPos, sigWithoutPos),
        tradingMode: 'conservative',
        positions: {
          'WITH-POS': { entryPrice: 0.01, entryTime: Date.now(), status: 'open' },
        },
      });

      const { container } = render(<SignalPanel />);

      const withCard = container.querySelector(
        '[data-testid="token-card-WITH-POS"]',
      );
      const withoutCard = container.querySelector(
        '[data-testid="token-card-WITHOUT-POS"]',
      );

      expect(withCard?.getAttribute('data-has-position')).toBe('true');
      expect(withoutCard?.getAttribute('data-has-position')).toBe('false');
    });
  });

  // --------------------------------------------------------------------------
  // Signal History Display Tests
  // --------------------------------------------------------------------------

  describe('signal history', () => {
    it('displays signal history count when filtered signals and history both exist', () => {
      const activeSig = createMockSignal({
        composite: 90,
        tokenMint: 'active-1',
      });
      const histSig1 = createMockSignal({ tokenMint: 'hist-1' });
      const histSig2 = createMockSignal({ tokenMint: 'hist-2' });

      setupStoreMocks({
        signals: toRecord(activeSig),
        signalHistory: [histSig1, histSig2],
      });

      render(<SignalPanel />);

      // History summary shows "N signal(s) analyzed"
      expect(screen.getByText(/2 signals analyzed/)).toBeTruthy();
    });

    it('hides history summary when no filtered signals are displayed', () => {
      // Conservative mode min = 80; signal composite = 50 won't pass filter
      const lowSig = createMockSignal({
        composite: 50,
        tokenMint: 'low',
      });
      const histSig = createMockSignal({ tokenMint: 'hist' });

      setupStoreMocks({
        signals: toRecord(lowSig),
        signalHistory: [histSig],
        tradingMode: 'conservative',
      });

      render(<SignalPanel />);

      // History should not show when filteredSignals is empty
      expect(screen.queryByText(/analyzed/)).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Max Age Filter Tests
  // --------------------------------------------------------------------------

  describe('max age filter', () => {
    it('filters out signals older than the selected max age', () => {
      const now = Date.now();

      const recentSig = createMockSignal({
        tokenMint: 'recent',
        composite: 90,
        tokenSymbol: 'RECENT',
        timestamp: now - 2 * 3600 * 1000, // 2 hours ago
      });
      const oldSig = createMockSignal({
        tokenMint: 'old',
        composite: 92,
        tokenSymbol: 'OLD',
        timestamp: now - 5 * 3600 * 1000, // 5 hours ago
      });

      setupStoreMocks({
        signals: toRecord(recentSig, oldSig),
        tradingMode: 'conservative',
      });

      const { container } = render(<SignalPanel />);

      // Default maxAge = 12h, both signals should be visible
      expect(getRenderedCards(container).length).toBe(2);

      // Open filter controls and set max age to 3 hours
      fireEvent.click(screen.getByLabelText('Show filter controls'));
      const ageSelect = screen.getByLabelText(
        'Maximum token age in hours',
      ) as HTMLSelectElement;
      fireEvent.change(ageSelect, { target: { value: '3' } });

      // Now only the 2-hour-old signal should pass (5h > 3h excluded)
      const cards = getRenderedCards(container);
      expect(cards.length).toBe(1);
      expect(
        container.querySelector('[data-testid="token-card-recent"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="token-card-old"]'),
      ).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Component Accessibility & Structure Tests
  // --------------------------------------------------------------------------

  describe('accessibility and structure', () => {
    it('renders with aria-label "Trading Signals" on root section', () => {
      setupStoreMocks();
      render(<SignalPanel />);

      const section = screen.getByLabelText('Trading Signals');
      expect(section).toBeTruthy();
      expect(section.tagName).toBe('SECTION');
    });

    it('renders summary bar with role="status" for screen readers', () => {
      // With no signals, both the summary bar and empty state have role="status"
      setupStoreMocks();
      render(<SignalPanel />);

      const statusElements = screen.getAllByRole('status');
      // Expect at least 1 status element (summary bar); with empty signals, 2 exist
      expect(statusElements.length).toBeGreaterThanOrEqual(1);

      // The summary bar should be the first one with class "signal-summary"
      const summaryBar = statusElements.find(
        (el) => el.classList.contains('signal-summary'),
      );
      expect(summaryBar).toBeTruthy();
    });
  });
});
