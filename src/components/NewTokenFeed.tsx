/**
 * src/components/NewTokenFeed.tsx — Real-Time New Token Feed from PumpPortal
 *
 * Renders a real-time streaming feed of newly detected tokens from the
 * PumpPortal WebSocket stream within the GMGN Signal Bot Chrome Extension
 * sidebar overlay. Reads token data reactively from the Zustand token store
 * via `useTokenStoreHook`.
 *
 * Per AAP Section 0.5.1 Group 11:
 *   "Real-time feed of new tokens from PumpPortal — shows newly created tokens
 *    with initial safety screening result"
 *
 * Per AAP Section 0.1.1 (Pump.fun Graduation Awareness):
 *   "Only 0.4%–1.8% of pump.fun tokens graduate to DEXes; the signal engine
 *    must account for extreme failure rates and filter for tokens at ≥30%
 *    bonding curve progress"
 *
 * Per AAP Section 0.4.4 (State Management Integration):
 *   NewTokenFeed reads from `token-store` via `useTokenStoreHook`.
 *
 * Data flow:
 *   PumpPortal WS → service worker → token-store → useTokenStoreHook → NewTokenFeed
 *
 * Features:
 *   - Streams new tokens sorted by creation time (newest first)
 *   - Bonding curve progress bar with color-coded fill (gray→amber→green→blue)
 *   - Initial safety screening indicator (🟢 safe / 🟡 moderate / 🟠 risky / 🔴 critical)
 *   - Filter controls: bonding curve progress threshold, safety level
 *   - Statistics bar: total tokens last hour, passing safety, ≥30% bonding
 *   - Pulsing LIVE indicator when feed is active
 *   - Auto-scroll to top on new token arrival (unless user scrolled down)
 *   - Max 50 items displayed (older pruned from view, not from store)
 *   - Empty state when no tokens detected
 *   - Dark theme styling via CSS classes in styles.css
 *
 * @module components/NewTokenFeed
 */

import { h, type FunctionComponent } from 'preact';
import { useState, useMemo, useRef, useEffect } from 'preact/hooks';
import { useTokenStoreHook, type TokenData } from '../store/index';
import type { SafetyRiskLevel, SafetyReport } from '../safety/types';
import { formatTimeAgo, formatPrice, formatMarketCap } from '../utils/formatting';
import { TOKEN_AGE } from '../utils/config';

// =============================================================================
// Constants
// =============================================================================

/** Maximum number of tokens displayed in the feed at once */
const MAX_FEED_ITEMS = 50;

/** Time window for "recent" tokens in the feed: 3 hours in milliseconds */
const RECENT_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Time window for feed statistics calculation: 1 hour in milliseconds */
const STATS_WINDOW_MS = 60 * 60 * 1000;

// =============================================================================
// Types
// =============================================================================

/**
 * Derived feed item for display, constructed from TokenData.
 *
 * Consolidates the fields needed for rendering each feed entry with
 * appropriate null handling for optional metric fields.
 */
interface FeedItem {
  /** Solana token mint address (base58 public key) */
  mint: string;
  /** Token ticker symbol */
  symbol: string;
  /** Full token name */
  name: string;
  /** Token creation timestamp (Unix seconds or milliseconds — auto-detected) */
  createdAt: number;
  /** Bonding curve completion progress 0–100 (0 if not available) */
  bondingCurveProgress: number;
  /** Derived safety risk level from SafetyReport, null if not yet checked */
  initialSafety: SafetyRiskLevel | null;
  /** Current price in USD, null if unavailable or zero */
  price: number | null;
  /** Market capitalization in USD, null if unavailable or zero */
  marketCap: number | null;
  /** Total liquidity in USD, null if unavailable or zero */
  liquidity: number | null;
}

/** Bonding curve filter preset options */
type BondingCurveFilter = 'all' | 'gte30' | 'gte50' | 'graduated';

/** Safety screening filter options */
type SafetyFilter = 'all' | 'safe-only' | 'hide-critical';

/** Computed feed statistics for the statistics bar */
interface FeedStats {
  /** Total tokens created in the last hour */
  totalLastHour: number;
  /** Tokens with safe or moderate safety classification */
  passingSafety: number;
  /** Tokens at or above the bonding curve minimum threshold (≥30%) */
  aboveBondingThreshold: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Derives a SafetyRiskLevel classification from a SafetyReport.
 *
 * Classification logic aligned with AAP Section 0.7.3 safety thresholds:
 * - overallScore ≥ 300: 'safe' (green) — all checks passed
 * - overallScore ≥ 150: 'moderate' (yellow) — partial concerns
 * - overallScore ≥ 50:  'risky' (orange) — multiple risk factors
 * - overallScore < 50:  'critical' (red) — hard filter failures
 *
 * @param report - SafetyReport from the token store, null if not yet checked
 * @returns Classified risk level, or null when no report is available
 */
function deriveSafetyRiskLevel(report: SafetyReport | null): SafetyRiskLevel | null {
  if (!report) {
    return null;
  }
  const score = report.overallScore;
  if (score >= 300) {
    return 'safe';
  }
  if (score >= 150) {
    return 'moderate';
  }
  if (score >= 50) {
    return 'risky';
  }
  return 'critical';
}

/**
 * Returns the emoji indicator for a given safety risk level.
 *
 * @param level - Safety risk classification
 * @returns Emoji character: 🟢 safe, 🟡 moderate, 🟠 risky, 🔴 critical
 */
function getSafetyEmoji(level: SafetyRiskLevel): string {
  switch (level) {
    case 'safe':
      return '\u{1F7E2}'; // 🟢
    case 'moderate':
      return '\u{1F7E1}'; // 🟡
    case 'risky':
      return '\u{1F7E0}'; // 🟠
    case 'critical':
      return '\u{1F534}'; // 🔴
    default:
      return '';
  }
}

/**
 * Returns the CSS color value for the bonding curve progress bar fill.
 *
 * Color coding per specification:
 *   0–29%:  gray/dim (too early, most will fail)
 *   30–69%: yellow/amber (approaching — meets minimum signal threshold)
 *   70–99%: green (likely to graduate)
 *   100%:   blue (graduated to DEX)
 *
 * Uses CSS custom properties for theme consistency, with fallback colors.
 *
 * @param progress - Bonding curve completion percentage 0–100
 * @returns CSS color string
 */
function getBondingCurveColor(progress: number): string {
  if (progress >= 100) {
    return 'var(--ntf-bonding-graduated, #3b82f6)';
  }
  if (progress >= 70) {
    return 'var(--ntf-bonding-likely, #22c55e)';
  }
  if (progress >= TOKEN_AGE.BONDING_CURVE_MIN_PERCENT) {
    return 'var(--ntf-bonding-approaching, #f59e0b)';
  }
  return 'var(--ntf-bonding-early, #6b7280)';
}

/**
 * Safely extracts the bonding curve progress from a TokenData object.
 *
 * The `bondingCurveProgress` field may be populated by the PumpPortal stream
 * handler or other data sources. Since the canonical TokenData interface may
 * not explicitly declare this field, we access it defensively at runtime.
 *
 * @param token - Token data from the store
 * @returns Bonding curve progress clamped to 0–100, or 0 if unavailable
 */
function extractBondingCurveProgress(token: TokenData): number {
  const raw = (token as unknown as Record<string, unknown>)['bondingCurveProgress'];
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, Math.min(100, raw));
  }
  return 0;
}

/**
 * Converts a Unix timestamp (seconds or milliseconds) to milliseconds.
 *
 * Uses the same heuristic as formatTimeAgo: timestamps below 10^12 are
 * treated as seconds and multiplied by 1000.
 *
 * @param timestamp - Unix timestamp in seconds or milliseconds
 * @returns Timestamp in milliseconds
 */
function toMilliseconds(timestamp: number): number {
  if (timestamp <= 0) {
    return 0;
  }
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

/**
 * Converts a TokenData object into a FeedItem for display.
 *
 * Maps store fields to presentation-ready values with appropriate null
 * handling for optional fields (price, marketCap, liquidity show as null
 * when zero or unavailable to avoid displaying misleading "$0" values).
 *
 * @param token - Raw token data from the Zustand store
 * @returns Derived FeedItem for rendering
 */
function tokenToFeedItem(token: TokenData): FeedItem {
  return {
    mint: token.mint,
    symbol: token.symbol || 'UNKNOWN',
    name: token.name || 'Unknown Token',
    createdAt: token.createdAt,
    bondingCurveProgress: extractBondingCurveProgress(token),
    initialSafety: deriveSafetyRiskLevel(token.safetyReport),
    price: token.price > 0 ? token.price : null,
    marketCap: token.marketCap > 0 ? token.marketCap : null,
    liquidity: token.liquidity > 0 ? token.liquidity : null,
  };
}

/**
 * Checks whether a token was created within a specified time window.
 *
 * @param token - Token data from the store
 * @param windowMs - Time window in milliseconds
 * @returns True if the token's createdAt falls within the window
 */
function isRecentToken(token: TokenData, windowMs: number): boolean {
  if (token.createdAt <= 0) {
    return false;
  }
  const createdAtMs = toMilliseconds(token.createdAt);
  return Date.now() - createdAtMs < windowMs;
}

/**
 * Checks whether a feed item passes the bonding curve filter.
 *
 * @param item - Feed item to check
 * @param filter - Active bonding curve filter preset
 * @returns True if the item should be displayed
 */
function passesBondingCurveFilter(item: FeedItem, filter: BondingCurveFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'gte30':
      return item.bondingCurveProgress >= TOKEN_AGE.BONDING_CURVE_MIN_PERCENT;
    case 'gte50':
      return item.bondingCurveProgress >= 50;
    case 'graduated':
      return item.bondingCurveProgress >= 100;
    default:
      return true;
  }
}

/**
 * Checks whether a feed item passes the safety filter.
 *
 * @param item - Feed item to check
 * @param filter - Active safety filter preset
 * @returns True if the item should be displayed
 */
function passesSafetyFilter(item: FeedItem, filter: SafetyFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'safe-only':
      return item.initialSafety === 'safe';
    case 'hide-critical':
      return item.initialSafety !== 'critical';
    default:
      return true;
  }
}

/**
 * Computes aggregated statistics from the full set of recent feed items.
 *
 * Used for the statistics bar at the top of the feed showing:
 * - Total tokens created in the last hour
 * - Number passing safety screening (safe or moderate)
 * - Number at or above the ≥30% bonding curve threshold
 *
 * @param items - All recent feed items (before user filtering)
 * @returns Computed feed statistics
 */
function computeStats(items: FeedItem[]): FeedStats {
  const now = Date.now();
  let totalLastHour = 0;
  let passingSafety = 0;
  let aboveBondingThreshold = 0;

  for (const item of items) {
    const createdAtMs = toMilliseconds(item.createdAt);
    if (createdAtMs > 0 && now - createdAtMs < STATS_WINDOW_MS) {
      totalLastHour++;
    }
    if (item.initialSafety === 'safe' || item.initialSafety === 'moderate') {
      passingSafety++;
    }
    if (item.bondingCurveProgress >= TOKEN_AGE.BONDING_CURVE_MIN_PERCENT) {
      aboveBondingThreshold++;
    }
  }

  return { totalLastHour, passingSafety, aboveBondingThreshold };
}

// =============================================================================
// NewTokenFeed Component
// =============================================================================

/**
 * Real-time new token feed component for the GMGN Signal Bot overlay.
 *
 * Reads token data from the Zustand token store via `useTokenStoreHook`,
 * filters to recently created tokens (within 3 hours), and renders a
 * scrollable feed with bonding curve progress bars, safety indicators,
 * price/market cap metrics, and filter controls.
 *
 * Performance considerations:
 * - `useMemo` memoizes the filtered/sorted feed list to avoid
 *   recomputing on every re-render
 * - Feed is capped at 50 items maximum to bound DOM node count
 * - Auto-scroll is disabled when the user has manually scrolled down
 * - Statistics are memoized from the full (unfiltered) item set
 *
 * Accessibility:
 * - Feed container uses role="feed" with aria-label
 * - Each item uses role="listitem"
 * - Bonding curve bar uses role="meter" with aria-valuenow/min/max
 * - Safety indicators have aria-label for screen readers
 * - LIVE indicator uses role="status" for announcement
 * - Empty state uses aria-live="polite" for dynamic updates
 */
const NewTokenFeed: FunctionComponent = () => {
  // ---------------------------------------------------------------------------
  // Store Access — reactive token data from Zustand via preact/compat
  // ---------------------------------------------------------------------------
  const tokens = useTokenStoreHook((state) => state.tokens);

  // ---------------------------------------------------------------------------
  // Filter State
  // ---------------------------------------------------------------------------
  const [bondingFilter, setBondingFilter] = useState<BondingCurveFilter>('all');
  const [safetyFilter, setSafetyFilter] = useState<SafetyFilter>('all');

  // ---------------------------------------------------------------------------
  // Refs for Auto-Scroll Behavior
  // ---------------------------------------------------------------------------
  const listRef = useRef<HTMLDivElement>(null);
  const userHasScrolled = useRef<boolean>(false);
  const previousTokenCount = useRef<number>(0);

  // ---------------------------------------------------------------------------
  // Memoized Feed Items — all recent tokens, sorted newest first
  // ---------------------------------------------------------------------------
  const allRecentItems: FeedItem[] = useMemo(() => {
    const tokenValues = Object.values(tokens);

    // Filter to tokens created within the last 3 hours
    const recent = tokenValues.filter((t) => isRecentToken(t, RECENT_WINDOW_MS));

    // Sort by creation time descending (newest first)
    recent.sort((a, b) => {
      const aMs = toMilliseconds(a.createdAt);
      const bMs = toMilliseconds(b.createdAt);
      return bMs - aMs;
    });

    return recent.map(tokenToFeedItem);
  }, [tokens]);

  // ---------------------------------------------------------------------------
  // Memoized Filtered Items — apply user filters, cap at 50
  // ---------------------------------------------------------------------------
  const filteredItems: FeedItem[] = useMemo(() => {
    return allRecentItems
      .filter((item) => passesBondingCurveFilter(item, bondingFilter))
      .filter((item) => passesSafetyFilter(item, safetyFilter))
      .slice(0, MAX_FEED_ITEMS);
  }, [allRecentItems, bondingFilter, safetyFilter]);

  // ---------------------------------------------------------------------------
  // Feed Statistics (computed from all recent items, before user filtering)
  // ---------------------------------------------------------------------------
  const stats: FeedStats = useMemo(
    () => computeStats(allRecentItems),
    [allRecentItems],
  );

  // ---------------------------------------------------------------------------
  // Auto-Scroll Effect — scroll to top when new tokens arrive
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const currentCount = allRecentItems.length;
    const hasNewTokens = currentCount > previousTokenCount.current;

    if (hasNewTokens && !userHasScrolled.current && listRef.current) {
      listRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }

    previousTokenCount.current = currentCount;
  }, [allRecentItems.length]);

  // ---------------------------------------------------------------------------
  // Scroll Tracking — detect manual user scroll to disable auto-scroll
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const el = listRef.current;
    if (!el) {
      return;
    }

    const handleScroll = (): void => {
      // Consider user as "scrolled" if more than 10px from top
      userHasScrolled.current = el.scrollTop > 10;
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------
  const handleBondingFilterChange = (e: Event): void => {
    const target = e.target as HTMLSelectElement;
    setBondingFilter(target.value as BondingCurveFilter);
  };

  const handleSafetyFilterChange = (e: Event): void => {
    const target = e.target as HTMLSelectElement;
    setSafetyFilter(target.value as SafetyFilter);
  };

  // ---------------------------------------------------------------------------
  // Determine whether feed has active data (for LIVE indicator)
  // ---------------------------------------------------------------------------
  const isLive = allRecentItems.length > 0;

  // ---------------------------------------------------------------------------
  // Empty State — no recent tokens detected
  // ---------------------------------------------------------------------------
  if (allRecentItems.length === 0) {
    return (
      <div class="ntf-container">
        <div class="ntf-header">
          <span class="ntf-title">New Tokens</span>
          <span class="ntf-live-badge ntf-live-badge--inactive" aria-hidden="true">
            ○ OFFLINE
          </span>
        </div>
        <div class="ntf-empty" role="status" aria-live="polite">
          <p class="ntf-empty-title">Waiting for new tokens...</p>
          <p class="ntf-empty-subtitle">
            New pump.fun tokens will appear here in real-time
          </p>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Main Render
  // ---------------------------------------------------------------------------
  return (
    <div class="ntf-container" role="feed" aria-label="New token feed">
      {/* === Feed Header with LIVE indicator === */}
      <div class="ntf-header">
        <span class="ntf-title">New Tokens</span>
        <span
          class={`ntf-live-badge ${isLive ? 'ntf-live-badge--active' : 'ntf-live-badge--inactive'}`}
          role="status"
          aria-label={isLive ? 'Live feed active' : 'Feed offline'}
        >
          {isLive ? '● LIVE' : '○ OFFLINE'}
        </span>
      </div>

      {/* === Statistics Bar === */}
      <div class="ntf-stats" role="status" aria-label="Feed statistics">
        <div class="ntf-stat">
          <span class="ntf-stat-value">{stats.totalLastHour}</span>
          <span class="ntf-stat-label">Last hour</span>
        </div>
        <div class="ntf-stat">
          <span class="ntf-stat-value">{stats.passingSafety}</span>
          <span class="ntf-stat-label">Safe</span>
        </div>
        <div class="ntf-stat">
          <span class="ntf-stat-value">{stats.aboveBondingThreshold}</span>
          <span class="ntf-stat-label">
            {'\u2265'}{TOKEN_AGE.BONDING_CURVE_MIN_PERCENT}%
          </span>
        </div>
      </div>

      {/* === Filter Controls === */}
      <div class="ntf-filters">
        <select
          class="ntf-filter-select"
          value={bondingFilter}
          onChange={handleBondingFilterChange}
          aria-label="Bonding curve progress filter"
        >
          <option value="all">All progress</option>
          <option value="gte30">
            {'\u2265'}{TOKEN_AGE.BONDING_CURVE_MIN_PERCENT}% bonding
          </option>
          <option value="gte50">{'\u2265'}50% bonding</option>
          <option value="graduated">Graduated (100%)</option>
        </select>

        <select
          class="ntf-filter-select"
          value={safetyFilter}
          onChange={handleSafetyFilterChange}
          aria-label="Safety screening filter"
        >
          <option value="all">All safety</option>
          <option value="safe-only">Safe only</option>
          <option value="hide-critical">Hide critical</option>
        </select>
      </div>

      {/* === Feed List === */}
      <div class="ntf-list" ref={listRef} role="list">
        {filteredItems.map((item) => (
          <div
            class="ntf-feed-item"
            key={item.mint}
            role="listitem"
            aria-label={`${item.symbol} — ${item.name}`}
          >
            {/* Token Header: symbol, name, age */}
            <div class="ntf-feed-item-header">
              <span class="ntf-token-symbol" title={item.mint}>
                {item.symbol}
              </span>
              <span class="ntf-token-name">{item.name}</span>
              <span class="ntf-token-age">{formatTimeAgo(item.createdAt)}</span>
            </div>

            {/* Token Metrics: price and market cap */}
            <div class="ntf-feed-item-metrics">
              {item.price !== null && (
                <span class="ntf-metric">
                  Price: {formatPrice(item.price)}
                </span>
              )}
              {item.marketCap !== null && (
                <span class="ntf-metric">
                  MCap: {formatMarketCap(item.marketCap)}
                </span>
              )}
            </div>

            {/* Status: bonding curve progress bar + safety indicator */}
            <div class="ntf-feed-item-status">
              <div
                class="ntf-bonding-curve-bar"
                role="meter"
                aria-label="Bonding curve progress"
                aria-valuenow={item.bondingCurveProgress}
                aria-valuemin={0}
                aria-valuemax={100}
                title="Bonding curve progress \u2014 tokens graduate to DEX at 100%"
              >
                <div
                  class="ntf-bonding-curve-fill"
                  style={{
                    width: `${item.bondingCurveProgress}%`,
                    backgroundColor: getBondingCurveColor(item.bondingCurveProgress),
                  }}
                />
                <span class="ntf-bonding-curve-text">
                  {item.bondingCurveProgress.toFixed(0)}% bonding
                </span>
              </div>

              {item.initialSafety !== null && (
                <span
                  class={`ntf-safety-indicator ntf-safety-${item.initialSafety}`}
                  title={`Safety: ${item.initialSafety}`}
                  aria-label={`Safety level: ${item.initialSafety}`}
                >
                  {getSafetyEmoji(item.initialSafety)}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* === No results after filtering === */}
      {filteredItems.length === 0 && (
        <div class="ntf-no-results" role="status" aria-live="polite">
          No tokens match current filters
        </div>
      )}
    </div>
  );
};

export { NewTokenFeed };
