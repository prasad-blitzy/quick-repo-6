/**
 * src/components/SignalPanel.tsx — Main Signal List Panel
 *
 * The primary view for displaying all active trading signals in the GMGN
 * Signal Bot Chrome Extension overlay sidebar. Renders a sortable, filterable
 * list of TokenCard components driven by Zustand stores.
 *
 * Per AAP Section 0.5.1 Group 11:
 *   "Main signal list; displays active signals sorted by composite score
 *    descending; provides filter controls (min score, trading mode, token age);
 *    auto-scrolls to new high-confidence signals."
 *
 * Per AAP Section 0.4.4 (State Management):
 *   - Reads from `signal-store` (signals, signalHistory)
 *   - Reads from `position-store` (positions for hasPosition status)
 *   - Reads from `settings-store` (tradingMode for threshold display)
 *
 * Per AAP Section 0.5.3 (UI Design):
 *   "Each TokenCard must surface composite score, safety status, smart money
 *    activity, and AI insight in a compact, scannable format — traders need
 *    to evaluate signals in seconds."
 *
 * Layout:
 *   1. Summary bar — active signal count, trading mode badge, threshold
 *   2. Filter toggle + filter controls (min score, max age, sort order)
 *   3. Scrollable signal list with TokenCard components
 *   4. Empty state when no signals match the current filters
 *
 * Performance:
 *   - Filtering and sorting are memoized with `useMemo` to prevent
 *     unnecessary re-computation on every render cycle.
 *   - Auto-scroll behavior detects new high-confidence signals and
 *     smoothly scrolls the list container, but only if the user has
 *     not manually scrolled away recently (debounce scroll tracking).
 *
 * @module components/SignalPanel
 */

import { h } from 'preact';
import type { FunctionComponent } from 'preact';
import { useState, useMemo, useRef, useEffect } from 'preact/hooks';

// Child component — renders individual token signal cards
import { TokenCard } from './TokenCard';

// Zustand store hooks — reactive Preact-compatible state access
import {
  useSignalStoreHook,
  useSettingsStoreHook,
  usePositionStoreHook,
} from '../store/index';

// Type imports — signal data structures
import type { CompositeSignal, TradingMode } from '../signals/types';

// Application constants — scoring thresholds
import { SCORING_THRESHOLDS } from '../utils/config';

// =============================================================================
// Types
// =============================================================================

/**
 * Sort order options for the signal list.
 * - `'score'`: Descending by composite score (highest first)
 * - `'time'`: Descending by timestamp (newest first)
 * - `'safety'`: By hard filter pass status (passed first, then by score)
 */
type SortBy = 'score' | 'time' | 'safety';

/**
 * Max-age filter values in hours for the token age dropdown.
 */
type MaxAgeHours = 3 | 6 | 12 | 24;

// =============================================================================
// Constants
// =============================================================================

/**
 * Auto-scroll cooldown period in milliseconds.
 * After the user manually scrolls, auto-scroll is disabled for this duration
 * to prevent fighting with user intent.
 */
const AUTO_SCROLL_COOLDOWN_MS = 5_000;

/**
 * Threshold for considering the user "scrolled away" from the top.
 * If scrollTop exceeds this value (in pixels), the user is considered to
 * have manually scrolled and auto-scroll will be suppressed.
 */
const SCROLL_TOP_THRESHOLD_PX = 50;

// =============================================================================
// Helper — Get Default Min Score from Trading Mode
// =============================================================================

/**
 * Returns the default minimum score filter value based on the active
 * trading mode. Conservative mode defaults to the higher threshold (80),
 * while aggressive mode defaults to the lower threshold (45).
 *
 * @param mode - Current trading mode from settings store
 * @returns Default minimum composite score threshold
 */
function getDefaultMinScore(mode: TradingMode): number {
  return mode === 'conservative'
    ? SCORING_THRESHOLDS.CONSERVATIVE_MIN
    : SCORING_THRESHOLDS.AGGRESSIVE_MIN;
}

/**
 * Returns a human-readable label for the trading mode badge.
 *
 * @param mode - Current trading mode
 * @returns Formatted mode label with threshold indicator
 */
function getModeBadgeLabel(mode: TradingMode): string {
  const threshold =
    mode === 'conservative'
      ? SCORING_THRESHOLDS.CONSERVATIVE_MIN
      : SCORING_THRESHOLDS.AGGRESSIVE_MIN;
  const label = mode === 'conservative' ? 'Conservative' : 'Aggressive';
  return `${label} Mode (≥${threshold})`;
}

/**
 * Determines the CSS class for the trading mode badge based on the mode.
 *
 * @param mode - Current trading mode
 * @returns CSS class name string
 */
function getModeBadgeClass(mode: TradingMode): string {
  return mode === 'conservative' ? 'decision-buy' : 'decision-exit';
}

// =============================================================================
// SignalPanel Component
// =============================================================================

/**
 * Main signal list panel component.
 *
 * Renders the full signal dashboard inside the Shadow DOM sidebar overlay.
 * Reads from three Zustand stores (signal, settings, position) and renders
 * a filtered, sorted list of TokenCard components.
 *
 * Features:
 * - Summary bar with active signal count and trading mode badge
 * - Toggleable filter controls (min score slider, max age dropdown, sort buttons)
 * - Memoized signal filtering and sorting for performance
 * - Auto-scroll to new high-confidence signals (with user-scroll detection)
 * - Empty state display when no signals match current filters
 *
 * @example
 * ```tsx
 * <SignalPanel />
 * ```
 */
const SignalPanel: FunctionComponent = () => {
  // ---------------------------------------------------------------------------
  // Store Subscriptions — Reactive State from Zustand
  // ---------------------------------------------------------------------------

  /**
   * Active signals keyed by token mint address.
   * Updated by the scoring engine in the service worker.
   */
  const signals = useSignalStoreHook(
    (state) => state.signals,
  );

  /**
   * Historical signals for reference display.
   */
  const signalHistory = useSignalStoreHook(
    (state) => state.signalHistory,
  );

  /**
   * Current trading mode from user settings.
   * Determines default min-score filter and badge display.
   */
  const tradingMode = useSettingsStoreHook(
    (state) => state.tradingMode,
  );

  /**
   * Active positions keyed by token mint address.
   * Used to determine hasPosition status for each TokenCard.
   */
  const positions = usePositionStoreHook(
    (state) => state.positions,
  );

  // ---------------------------------------------------------------------------
  // Local Filter State
  // ---------------------------------------------------------------------------

  /**
   * Minimum composite score filter (0-100).
   * Defaults to the trading mode's threshold (80 conservative, 45 aggressive).
   */
  const [minScore, setMinScore] = useState<number>(
    () => getDefaultMinScore(tradingMode),
  );

  /**
   * Maximum token age filter in hours.
   * Tokens older than this value are excluded from the list.
   */
  const [maxAge, setMaxAge] = useState<MaxAgeHours>(12);

  /**
   * Whether the filter controls panel is visible.
   * Toggled by the filter button in the summary bar.
   */
  const [showFilters, setShowFilters] = useState<boolean>(false);

  /**
   * Current sort order for the signal list.
   * Defaults to 'score' (highest composite score first).
   */
  const [sortBy, setSortBy] = useState<SortBy>('score');

  // ---------------------------------------------------------------------------
  // Refs — DOM and Scroll State Tracking
  // ---------------------------------------------------------------------------

  /**
   * Reference to the signal list scroll container element.
   * Used for auto-scroll behavior on new high-confidence signals.
   */
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * Tracks the last time the user manually scrolled the list.
   * Auto-scroll is suppressed for AUTO_SCROLL_COOLDOWN_MS after manual scroll.
   */
  const lastUserScrollRef = useRef<number>(0);

  /**
   * Tracks the previous signal count for detecting new arrivals.
   * Used by the auto-scroll effect to determine if new signals appeared.
   */
  const prevSignalCountRef = useRef<number>(0);

  /**
   * Tracks the highest composite score seen in the previous render.
   * Used to detect when a new high-confidence signal appears.
   */
  const prevTopScoreRef = useRef<number>(0);

  // ---------------------------------------------------------------------------
  // Effect — Update Default Min Score When Trading Mode Changes
  // ---------------------------------------------------------------------------

  useEffect(() => {
    setMinScore(getDefaultMinScore(tradingMode));
  }, [tradingMode]);

  // ---------------------------------------------------------------------------
  // Memoized — Signal Filtering and Sorting
  // ---------------------------------------------------------------------------

  /**
   * Filtered and sorted signal array.
   *
   * Filtering rules:
   * 1. Exclude signals with decision === 'SKIP'
   * 2. Require composite score >= minScore
   * 3. Require signal timestamp within maxAge hours
   *
   * Sorting rules:
   * - 'score': Descending by composite (highest first)
   * - 'time': Descending by timestamp (newest first)
   * - 'safety': Passed hard filters first, then by composite score
   */
  const filteredSignals = useMemo<CompositeSignal[]>(() => {
    const now = Date.now();
    const maxAgeMs = maxAge * 60 * 60 * 1000;
    const signalArray = Object.values(signals);

    // Phase 1: Filter
    const filtered = signalArray.filter((signal) => {
      // Exclude SKIP decisions — only show BUY and EXIT signals
      if (signal.decision === 'SKIP') {
        return false;
      }

      // Apply minimum composite score filter
      if (signal.composite < minScore) {
        return false;
      }

      // Apply maximum token age filter based on signal timestamp
      if (now - signal.timestamp > maxAgeMs) {
        return false;
      }

      return true;
    });

    // Phase 2: Sort
    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'score':
          // Descending by composite score
          return b.composite - a.composite;

        case 'time':
          // Descending by timestamp (newest first)
          return b.timestamp - a.timestamp;

        case 'safety': {
          // Passed hard filters first, then by composite score descending
          const aPassed = a.hardFilterResult.passed ? 1 : 0;
          const bPassed = b.hardFilterResult.passed ? 1 : 0;
          if (bPassed !== aPassed) {
            return bPassed - aPassed;
          }
          return b.composite - a.composite;
        }

        default:
          return b.composite - a.composite;
      }
    });

    return filtered;
  }, [signals, minScore, maxAge, sortBy]);

  // ---------------------------------------------------------------------------
  // Computed Values
  // ---------------------------------------------------------------------------

  /**
   * Total count of active (non-SKIP) signals before filtering.
   * Displayed in the summary bar as "N Active Signals".
   */
  const totalActiveCount = useMemo<number>(() => {
    return Object.values(signals).filter(
      (s) => s.decision !== 'SKIP',
    ).length;
  }, [signals]);

  /**
   * Count of BUY signals for the summary indicator.
   */
  const buySignalCount = useMemo<number>(() => {
    return Object.values(signals).filter(
      (s) => s.decision === 'BUY',
    ).length;
  }, [signals]);

  // ---------------------------------------------------------------------------
  // Effect — Auto-Scroll to New High-Confidence Signals
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const currentCount = filteredSignals.length;
    const currentTopScore =
      filteredSignals.length > 0 ? filteredSignals[0].composite : 0;

    // Detect new high-confidence signal:
    // 1. A new signal appeared (count increased)
    // 2. The top score exceeds the conservative threshold (≥80)
    // 3. The user hasn't manually scrolled recently
    const hasNewSignal = currentCount > prevSignalCountRef.current;
    const isHighConfidence =
      currentTopScore >= SCORING_THRESHOLDS.CONSERVATIVE_MIN;
    const timeSinceUserScroll = Date.now() - lastUserScrollRef.current;
    const userScrolledRecently = timeSinceUserScroll < AUTO_SCROLL_COOLDOWN_MS;

    if (
      hasNewSignal &&
      isHighConfidence &&
      !userScrolledRecently &&
      listRef.current
    ) {
      listRef.current.scrollTo({
        top: 0,
        behavior: 'smooth',
      });
    }

    // Update refs for next render cycle
    prevSignalCountRef.current = currentCount;
    prevTopScoreRef.current = currentTopScore;
  }, [filteredSignals]);

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  /**
   * Handles user scroll events on the signal list container.
   * Records the scroll timestamp to suppress auto-scroll.
   */
  const handleListScroll = (): void => {
    if (
      listRef.current &&
      listRef.current.scrollTop > SCROLL_TOP_THRESHOLD_PX
    ) {
      lastUserScrollRef.current = Date.now();
    }
  };

  /**
   * Handles changes to the minimum score range slider.
   *
   * @param e - Input event from the range slider
   */
  const handleMinScoreChange = (e: Event): void => {
    const target = e.currentTarget as HTMLInputElement;
    const value = parseInt(target.value, 10);
    if (!isNaN(value) && value >= 0 && value <= 100) {
      setMinScore(value);
    }
  };

  /**
   * Handles changes to the max age dropdown selector.
   *
   * @param e - Change event from the select element
   */
  const handleMaxAgeChange = (e: Event): void => {
    const target = e.currentTarget as HTMLSelectElement;
    const value = parseInt(target.value, 10) as MaxAgeHours;
    setMaxAge(value);
  };

  /**
   * Toggles the filter controls panel visibility.
   */
  const handleToggleFilters = (): void => {
    setShowFilters((prev) => !prev);
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <section class="signal-panel" aria-label="Trading Signals">
      {/* === Summary Bar === */}
      <div class="signal-summary" role="status" aria-live="polite">
        <span class="signal-count" aria-label={`${totalActiveCount} active signals`}>
          <strong>{totalActiveCount}</strong> Active Signal{totalActiveCount !== 1 ? 's' : ''}
        </span>
        {buySignalCount > 0 && (
          <span class="signal-count-buy" aria-label={`${buySignalCount} buy signals`}>
            ({buySignalCount} BUY)
          </span>
        )}
        <span>•</span>
        <span
          class={`decision-badge ${getModeBadgeClass(tradingMode)}`}
          aria-label={`Trading mode: ${getModeBadgeLabel(tradingMode)}`}
        >
          {getModeBadgeLabel(tradingMode)}
        </span>
        <button
          type="button"
          class={`sort-controls-btn ${showFilters ? 'active' : ''}`}
          onClick={handleToggleFilters}
          aria-expanded={showFilters}
          aria-controls="signal-filter-controls"
          aria-label={showFilters ? 'Hide filter controls' : 'Show filter controls'}
          title="Toggle filters"
        >
          ⚙
        </button>
      </div>

      {/* === Filter Controls (toggleable) === */}
      {showFilters && (
        <div
          id="signal-filter-controls"
          class="filter-controls"
          role="group"
          aria-label="Signal filter controls"
        >
          {/* Min Score Slider */}
          <label>
            Min Score:
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={minScore}
              onInput={handleMinScoreChange}
              aria-label="Minimum composite score"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={minScore}
            />
            <span aria-hidden="true">{minScore}</span>
          </label>

          {/* Max Age Dropdown */}
          <label>
            Max Age:
            <select
              value={maxAge}
              onChange={handleMaxAgeChange}
              aria-label="Maximum token age in hours"
            >
              <option value={3}>≤3h</option>
              <option value={6}>≤6h</option>
              <option value={12}>≤12h</option>
              <option value={24}>≤24h</option>
            </select>
          </label>

          {/* Sort Order Buttons */}
          <div class="sort-controls" role="group" aria-label="Sort order">
            <button
              type="button"
              class={sortBy === 'score' ? 'active' : ''}
              onClick={() => setSortBy('score')}
              aria-pressed={sortBy === 'score'}
              aria-label="Sort by score"
            >
              Score
            </button>
            <button
              type="button"
              class={sortBy === 'time' ? 'active' : ''}
              onClick={() => setSortBy('time')}
              aria-pressed={sortBy === 'time'}
              aria-label="Sort by time"
            >
              Time
            </button>
            <button
              type="button"
              class={sortBy === 'safety' ? 'active' : ''}
              onClick={() => setSortBy('safety')}
              aria-pressed={sortBy === 'safety'}
              aria-label="Sort by safety"
            >
              Safety
            </button>
          </div>
        </div>
      )}

      {/* === Signal List === */}
      <div
        class="signal-list"
        ref={listRef}
        onScroll={handleListScroll}
        role="list"
        aria-label={`${filteredSignals.length} trading signals displayed`}
      >
        {filteredSignals.length === 0 ? (
          <div class="empty-state" role="status">
            <div class="empty-state-icon" aria-hidden="true">📡</div>
            <p>No signals matching filters</p>
            <p>Adjust filters or wait for new tokens</p>
          </div>
        ) : (
          filteredSignals.map((signal) => (
            <TokenCard
              key={signal.tokenMint}
              signal={signal}
              hasPosition={
                positions !== undefined &&
                positions !== null &&
                signal.tokenMint in positions
              }
            />
          ))
        )}
      </div>

      {/* === History Summary (shown below list when signals exist) === */}
      {signalHistory.length > 0 && filteredSignals.length > 0 && (
        <div class="signal-summary" aria-label="Signal history summary">
          <span>
            {signalHistory.length} signal{signalHistory.length !== 1 ? 's' : ''} analyzed
          </span>
        </div>
      )}
    </section>
  );
};

// =============================================================================
// Exports
// =============================================================================

export { SignalPanel };
