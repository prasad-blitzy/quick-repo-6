/**
 * src/components/TokenCard.tsx — Individual Token Signal Card
 *
 * The most information-dense component in the GMGN Signal Bot overlay.
 * Displays a compact, scannable summary of a trading signal for a single
 * token, expandable on click to reveal full details: market data, safety
 * status, factor breakdown, smart money activity, AI analysis, exit
 * strategy, and quick-action buttons.
 *
 * Per AAP §0.5.1 Group 11:
 *   "Individual token signal card; shows token name/symbol, composite score
 *    gauge, safety badge, smart money indicators, AI insight summary, and
 *    quick-action buttons."
 *
 * Per AAP §0.5.3:
 *   "Each TokenCard must surface composite score, safety status, smart money
 *    activity, and AI insight in a compact, scannable format — traders need
 *    to evaluate signals in seconds."
 *
 * Per AAP §0.4.4 (State Management):
 *   TokenCard reads from token-store (via useTokenStoreHook) and receives
 *   signal data from props (CompositeSignal).
 *
 * Layout modes:
 *   - **Compact** (default): Single-row card with score gauge, symbol,
 *     price, price change, safety dot, smart money count, and position badge.
 *   - **Expanded** (on click): Full detail breakdown — market data row,
 *     decision badge, factor breakdown bar chart, smart money indicator,
 *     AI insight, exit strategy (if position), and quick-action buttons.
 *
 * @module components/TokenCard
 */

import { h } from 'preact';
import type { FunctionComponent } from 'preact';
import { useState, useMemo } from 'preact/hooks';

// Child components
import { SafetyBadge } from './SafetyBadge';
import { ScoreGauge } from './ScoreGauge';
import { AIInsight } from './AIInsight';
import { SmartMoneyIndicator } from './SmartMoneyIndicator';
import { ExitStrategy } from './ExitStrategy';

// Store hooks
import { useTokenStoreHook } from '../store/index';

// Type imports
import type { CompositeSignal, FactorResult } from '../signals/types';
import type { SafetyReport } from '../safety/types';
import type { AIAnalysisResult } from '../ai/types';

// Formatting utilities
import {
  formatPrice,
  formatMarketCap,
  formatPercent,
  formatTimeAgo,
  formatVolume,
} from '../utils/formatting';

// =============================================================================
// Constants
// =============================================================================

/**
 * Base URL for opening token pages on GMGN.ai.
 * Used by the "Open on GMGN" quick-action button.
 */
const GMGN_TOKEN_BASE_URL = 'https://gmgn.ai/sol/token/';

/**
 * Factor name display labels for the factor breakdown bar chart.
 * Maps camelCase factor identifiers to short human-readable labels.
 */
const FACTOR_LABELS: Readonly<Record<string, string>> = {
  volumeSpike: 'Volume',
  smartMoneyConvergence: 'Smart $',
  buySellRatio: 'Buy/Sell',
  holderGrowth: 'Holders',
  liquidity: 'Liquidity',
  tokenAge: 'Age',
  safetyScore: 'Safety',
};

// =============================================================================
// Props Interface
// =============================================================================

/**
 * Props for the TokenCard component.
 *
 * @property signal      - The complete CompositeSignal object with composite
 *                         score, factors, decision, confidence, tokenMint, etc.
 * @property hasPosition - Whether the user has an active tracked position on
 *                         this token. When true, the ExitStrategy sub-component
 *                         is rendered in expanded view.
 */
interface TokenCardProps {
  signal: CompositeSignal;
  hasPosition: boolean;
}

// =============================================================================
// Helper — Factor Label
// =============================================================================

/**
 * Converts a camelCase factor name to a short display label.
 * Falls back to the raw name for unknown factors.
 *
 * @param name - Factor name from FactorResult.name
 * @returns Short display label
 */
function getFactorLabel(name: string): string {
  return FACTOR_LABELS[name] ?? name;
}

/**
 * Returns a CSS color class for a factor bar based on its score.
 * Used for visual differentiation in the factor breakdown chart.
 *
 * @param score - Factor score (0-100)
 * @returns Inline style color string
 */
function getFactorBarColor(score: number): string {
  if (score >= 70) return 'var(--green)';
  if (score >= 45) return 'var(--yellow)';
  if (score >= 25) return 'var(--orange)';
  return 'var(--red)';
}

/**
 * Copies text to the clipboard using the Clipboard API with a graceful
 * fallback for environments where the API is unavailable.
 *
 * @param text - The text string to copy
 * @returns Promise that resolves when copying is complete
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback: create a temporary textarea for older environments
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

// =============================================================================
// TokenCard Component
// =============================================================================

/**
 * Individual token signal card component.
 *
 * Renders in two modes:
 * - **Compact** (default): A dense single-row card showing the most critical
 *   signal metrics: score gauge, token symbol, price, 24h change, safety dot,
 *   smart money count, and position badge. Designed for rapid scanning.
 * - **Expanded** (on click): Full detail view with market data, decision badge,
 *   factor breakdown chart, smart money indicator, AI insight, exit strategy,
 *   and quick-action buttons.
 *
 * Uses CSS classes defined in `src/components/styles.css` (loaded in Shadow DOM).
 *
 * @example
 * ```tsx
 * <TokenCard signal={compositeSignal} hasPosition={false} />
 * ```
 */
const TokenCard: FunctionComponent<TokenCardProps> = ({ signal, hasPosition }) => {
  // ---------------------------------------------------------------------------
  // Local State — Expanded/Collapsed Toggle
  // ---------------------------------------------------------------------------
  const [expanded, setExpanded] = useState<boolean>(false);
  const [copyFeedback, setCopyFeedback] = useState<boolean>(false);

  // ---------------------------------------------------------------------------
  // Store Data — Read Token Data by Mint Address
  // ---------------------------------------------------------------------------
  const tokenData = useTokenStoreHook(
    (state) => state.tokens[signal.tokenMint],
  );

  // ---------------------------------------------------------------------------
  // Memoized Derived Values
  // ---------------------------------------------------------------------------

  /**
   * Price change formatted result with text and color hint.
   * Memoized because formatPercent creates a new object each call.
   */
  const priceChangeFormatted = useMemo(
    () => formatPercent(tokenData?.priceChange24h ?? 0),
    [tokenData?.priceChange24h],
  );

  /**
   * CSS class for the price change display based on positive/negative.
   */
  const priceChangeClass = useMemo(() => {
    if (!tokenData) return 'price-change';
    return `price-change ${priceChangeFormatted.colorHint === 'positive' ? 'positive' : priceChangeFormatted.colorHint === 'negative' ? 'negative' : ''}`;
  }, [tokenData, priceChangeFormatted.colorHint]);

  /**
   * Display symbol: prefer token store data, fall back to signal's tokenSymbol.
   */
  const displaySymbol = useMemo(
    () => tokenData?.symbol || signal.tokenSymbol || '???',
    [tokenData?.symbol, signal.tokenSymbol],
  );

  /**
   * Display name: prefer token store data, show empty string if unavailable.
   */
  const displayName = useMemo(
    () => tokenData?.name || '',
    [tokenData?.name],
  );

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  /**
   * Toggles the expanded/collapsed state of the card.
   */
  const handleToggleExpand = (): void => {
    setExpanded((prev) => !prev);
  };

  /**
   * Handles keyboard interaction for card header accessibility.
   * Enter or Space toggles expansion, matching native button behavior.
   */
  const handleHeaderKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleToggleExpand();
    }
  };

  /**
   * Copies the token mint address to clipboard and shows brief feedback.
   */
  const handleCopyAddress = (e: MouseEvent): void => {
    e.stopPropagation();
    copyToClipboard(signal.tokenMint).then(() => {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    });
  };

  /**
   * Opens the token page on GMGN.ai in a new tab.
   */
  const handleOpenOnGmgn = (e: MouseEvent): void => {
    e.stopPropagation();
    window.open(`${GMGN_TOKEN_BASE_URL}${signal.tokenMint}`, '_blank', 'noopener');
  };

  /**
   * Placeholder handler for tracking position.
   * Sends a message to the service worker to mark this token as tracked.
   */
  const handleTrackPosition = (e: MouseEvent): void => {
    e.stopPropagation();
    // Send message to service worker to open a position tracker for this token
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'TRACK_POSITION',
        payload: {
          tokenMint: signal.tokenMint,
          symbol: displaySymbol,
          entryPrice: tokenData?.price ?? 0,
        },
      });
    }
  };

  // ---------------------------------------------------------------------------
  // Render — Loading State
  // ---------------------------------------------------------------------------

  /**
   * When tokenData has not yet been populated in the store, render a
   * skeleton placeholder with the signal's basic info.
   */
  if (!tokenData) {
    return (
      <div
        class="token-card"
        role="article"
        aria-label={`Signal card for ${displaySymbol} — loading data`}
      >
        <div
          class="card-header"
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={handleToggleExpand}
          onKeyDown={handleHeaderKeyDown}
        >
          <ScoreGauge score={signal.composite} size="small" />
          <div class="token-info">
            <span class="token-symbol">{displaySymbol}</span>
            <span class="token-price" style={{ color: 'var(--text-muted)' }}>
              Loading…
            </span>
          </div>
          <span
            class="safety-dot safety-pending"
            title="Safety check pending"
            role="status"
            aria-label="Safety check pending"
          >
            ⏳
          </span>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render — Compact View (Default)
  // ---------------------------------------------------------------------------

  /**
   * Compact single-row layout:
   * [ScoreGauge] TOKEN_SYM  $price  ±change%  [SafetyDot] [SM:N] [POS]
   */
  if (!expanded) {
    return (
      <div
        class="token-card"
        role="article"
        aria-label={`Signal card for ${displaySymbol}: score ${signal.composite}, ${signal.decision}`}
      >
        <div
          class="card-header"
          role="button"
          tabIndex={0}
          aria-expanded={false}
          aria-label={`${displaySymbol} — score ${signal.composite}, ${signal.decision}. Click to expand details.`}
          onClick={handleToggleExpand}
          onKeyDown={handleHeaderKeyDown}
        >
          {/* Composite score gauge — small inline variant */}
          <ScoreGauge score={signal.composite} size="small" />

          {/* Token identity and price info */}
          <div class="token-info">
            <span class="token-symbol">{displaySymbol}</span>
            {displayName && (
              <span class="token-name">{displayName}</span>
            )}
            <span class="token-price">
              {formatPrice(tokenData.price)}
            </span>
            <span class={priceChangeClass}>
              {priceChangeFormatted.text}
            </span>
          </div>

          {/* Safety badge — compact dot mode */}
          <SafetyBadge report={tokenData.safetyReport} compact={true} />

          {/* Smart money count — compact inline */}
          {tokenData.smartMoneyCount > 0 && (
            <span
              class="sm-compact-count"
              title={`${tokenData.smartMoneyCount} smart money wallet${tokenData.smartMoneyCount === 1 ? '' : 's'}`}
              aria-label={`${tokenData.smartMoneyCount} smart money wallets`}
              style={{
                fontSize: 'var(--font-size-xs)',
                color: tokenData.smartMoneyCount >= 3 ? 'var(--green)' : 'var(--text-secondary)',
                fontWeight: tokenData.smartMoneyCount >= 3 ? '600' : '400',
                whiteSpace: 'nowrap',
              }}
            >
              🧠{tokenData.smartMoneyCount}
            </span>
          )}

          {/* Position badge — shown if user has an active position */}
          {hasPosition && (
            <span class="position-badge" aria-label="Active position">
              📍 POS
            </span>
          )}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render — Expanded View
  // ---------------------------------------------------------------------------

  return (
    <div
      class="token-card expanded"
      role="article"
      aria-label={`Expanded signal card for ${displaySymbol}: score ${signal.composite}, ${signal.decision}`}
    >
      {/* ================================================================== */}
      {/* Header Row — Clickable to Collapse                                  */}
      {/* ================================================================== */}
      <div
        class="card-header"
        role="button"
        tabIndex={0}
        aria-expanded={true}
        aria-label={`${displaySymbol} — score ${signal.composite}, ${signal.decision}. Click to collapse.`}
        onClick={handleToggleExpand}
        onKeyDown={handleHeaderKeyDown}
      >
        {/* Composite score gauge — medium variant with factor tooltip */}
        <ScoreGauge
          score={signal.composite}
          size="medium"
          factors={signal.factors}
        />

        {/* Token identity and price block */}
        <div class="token-info">
          <span class="token-symbol">{displaySymbol}</span>
          {displayName && (
            <span class="token-name">{displayName}</span>
          )}
          <span class="token-price">
            {formatPrice(tokenData.price)}
          </span>
          <span class={priceChangeClass}>
            {priceChangeFormatted.text}
          </span>
        </div>

        {/* Safety badge — expanded mode */}
        <SafetyBadge report={tokenData.safetyReport} />

        {/* Position badge — shown if user has an active position */}
        {hasPosition && (
          <span class="position-badge" aria-label="Active position">
            📍 POS
          </span>
        )}
      </div>

      {/* ================================================================== */}
      {/* Market Data Row                                                     */}
      {/* ================================================================== */}
      <div class="market-data" role="list" aria-label="Market metrics">
        <span role="listitem">
          MCap: {formatMarketCap(tokenData.marketCap)}
        </span>
        <span role="listitem">
          Vol: {formatVolume(tokenData.volume24h)}
        </span>
        <span role="listitem">
          Liq: {formatMarketCap(tokenData.liquidity)}
        </span>
        <span role="listitem">
          Holders: {tokenData.holderCount.toLocaleString()}
        </span>
        <span role="listitem">
          Age: {formatTimeAgo(tokenData.createdAt)}
        </span>
      </div>

      {/* ================================================================== */}
      {/* Signal Decision Badge                                               */}
      {/* ================================================================== */}
      <div
        class={`decision-badge decision-${signal.decision.toLowerCase()}`}
        role="status"
        aria-label={`Decision: ${signal.decision}, Confidence: ${(signal.confidence * 100).toFixed(0)}%`}
      >
        {signal.decision} • Confidence: {(signal.confidence * 100).toFixed(0)}%
      </div>

      {/* ================================================================== */}
      {/* Factor Breakdown Bar Chart                                          */}
      {/* ================================================================== */}
      <div
        class="factor-breakdown"
        role="list"
        aria-label="Signal factor breakdown"
      >
        {signal.factors.map((factor: FactorResult) => (
          <div class="factor-row" key={factor.name} role="listitem">
            <span class="factor-name" title={factor.name}>
              {getFactorLabel(factor.name)}
            </span>
            <div class="factor-bar-container">
              <div
                class="factor-bar"
                style={{
                  width: `${Math.max(0, Math.min(100, factor.score))}%`,
                  background: getFactorBarColor(factor.score),
                }}
                role="meter"
                aria-valuenow={factor.score}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${getFactorLabel(factor.name)}: ${factor.score} out of 100`}
              />
            </div>
            <span class="factor-score">{factor.score}</span>
          </div>
        ))}
      </div>

      {/* ================================================================== */}
      {/* Smart Money Indicator                                               */}
      {/* ================================================================== */}
      <SmartMoneyIndicator tokenMint={signal.tokenMint} />

      {/* ================================================================== */}
      {/* AI Analysis (conditional — shown when LLM analysis is available)    */}
      {/* ================================================================== */}
      {tokenData.aiAnalysis && (
        <AIInsight analysis={tokenData.aiAnalysis} />
      )}

      {/* ================================================================== */}
      {/* Exit Strategy (conditional — shown only when user has a position)   */}
      {/* ================================================================== */}
      {hasPosition && <ExitStrategy tokenMint={signal.tokenMint} />}

      {/* ================================================================== */}
      {/* Quick-Action Buttons                                                */}
      {/* ================================================================== */}
      <div class="card-actions" role="group" aria-label="Quick actions">
        <button
          type="button"
          onClick={handleCopyAddress}
          aria-label={copyFeedback ? 'Address copied!' : 'Copy token mint address'}
        >
          {copyFeedback ? '✓ Copied' : '📋 Copy'}
        </button>
        <button
          type="button"
          onClick={handleOpenOnGmgn}
          aria-label="Open token on GMGN.ai"
        >
          🔗 GMGN
        </button>
        {!hasPosition && (
          <button
            type="button"
            onClick={handleTrackPosition}
            aria-label="Track position for this token"
          >
            📍 Track
          </button>
        )}
      </div>
    </div>
  );
};

// =============================================================================
// Named Export
// =============================================================================

export { TokenCard };
