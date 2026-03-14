/**
 * src/components/NewTokenFeed.tsx — Real-Time New Token Feed
 *
 * Displays a real-time feed of newly created tokens from PumpPortal's
 * `subscribeNewToken` WebSocket stream with initial safety screening
 * status and bonding curve progress.
 *
 * Per AAP §0.5.1 Group 11:
 *   "Real-time new token feed from PumpPortal — shows newly created tokens
 *    with initial safety screening result"
 *
 * Per AAP §0.5.1 Group 9 — PumpPortal WebSocket:
 *   "PumpPortal-specific stream handler — subscribes to `subscribeNewToken`,
 *    `subscribeTokenTrade`, `subscribeMigration`; emits typed events"
 *
 * Per AAP (Pump.fun Graduation Awareness):
 *   "Only 0.4%–1.8% of pump.fun tokens graduate to DEXes; the signal engine
 *    must account for extreme failure rates and filter for tokens at ≥30%
 *    bonding curve progress"
 *
 * Data sources:
 *   - PumpPortal `PumpPortalNewToken` events via token-store
 *   - Safety screening status from token-store `safetyReport` field
 *   - Bonding curve progress computed from `vTokensInBondingCurve` / `vSolInBondingCurve`
 *
 * @module components/NewTokenFeed
 */

import { h, type FunctionComponent } from 'preact';
import { useState, useMemo, useCallback } from 'preact/hooks';
import type { PumpPortalNewToken } from '../api/types';
import type { SafetyReport } from '../safety/types';

// =============================================================================
// Constants
// =============================================================================

/** Default maximum number of tokens displayed in the feed */
const DEFAULT_MAX_TOKENS = 20;

/** Bonding curve graduation threshold (30% per AAP) */
const GRADUATION_THRESHOLD_PERCENT = 30;

/** Bonding curve completion (100% = graduated to DEX) */
const GRADUATION_COMPLETE_PERCENT = 100;

/**
 * Approximate SOL amount at which pump.fun bonding curve is considered
 * "graduated" (reaches ~85 SOL in the curve). This is a rough estimate —
 * the exact amount depends on the specific bonding curve parameters.
 */
const GRADUATION_SOL_TARGET = 85;

/** Safety screening status values */
type SafetyStatus = 'safe' | 'warning' | 'danger' | 'pending' | 'unknown';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Computes bonding curve progress as a percentage (0–100).
 *
 * Pump.fun tokens graduate to DEXes when the bonding curve reaches a
 * threshold (~85 SOL). Progress is estimated from `vSolInBondingCurve`.
 */
function computeBondingCurveProgress(vSolInBondingCurve: number): number {
  if (vSolInBondingCurve <= 0 || GRADUATION_SOL_TARGET <= 0) return 0;
  const progress = (vSolInBondingCurve / GRADUATION_SOL_TARGET) * 100;
  return Math.min(GRADUATION_COMPLETE_PERCENT, Math.max(0, progress));
}

/**
 * Returns colour for bonding curve progress bar.
 */
function getProgressColor(percent: number): string {
  if (percent >= GRADUATION_THRESHOLD_PERCENT) return '#22c55e';
  if (percent >= 15) return '#f59e0b';
  return '#94a3b8';
}

/**
 * Derives a safety status from a SafetyReport (or null for pending).
 */
function deriveSafetyStatus(report: SafetyReport | null | undefined): SafetyStatus {
  if (report === undefined) return 'unknown';
  if (report === null) return 'pending';
  if (report.overallScore >= 300) return 'safe';
  if (report.overallScore >= 150) return 'warning';
  return 'danger';
}

/** Safety status badge configuration */
const SAFETY_CONFIG: Record<SafetyStatus, { icon: string; label: string; color: string }> = {
  safe: { icon: '✅', label: 'Safe', color: '#22c55e' },
  warning: { icon: '⚠️', label: 'Caution', color: '#f59e0b' },
  danger: { icon: '🚫', label: 'Danger', color: '#ef4444' },
  pending: { icon: '⏳', label: 'Checking...', color: '#94a3b8' },
  unknown: { icon: '❓', label: 'Unknown', color: '#64748b' },
};

/**
 * Formats a timestamp as a time-ago string.
 */
function formatTimeAgo(timestampMs: number): string {
  const seconds = Math.floor((Date.now() - timestampMs) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Truncates a Solana address for display.
 */
function truncateAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * Formats SOL amount for display.
 */
function formatSolAmount(sol: number): string {
  if (sol === 0) return '0 SOL';
  if (sol < 0.001) return '<0.001 SOL';
  if (sol < 1) return `${sol.toFixed(3)} SOL`;
  if (sol < 1000) return `${sol.toFixed(2)} SOL`;
  return `${(sol / 1000).toFixed(1)}K SOL`;
}

// =============================================================================
// Token Feed Entry Interface
// =============================================================================

/**
 * Enriched feed entry combining PumpPortal new token data with safety
 * screening results.
 */
export interface NewTokenFeedEntry {
  /** PumpPortal new token event data */
  token: PumpPortalNewToken;
  /** Safety report from concurrent RugCheck + GoPlus check (null if pending) */
  safetyReport?: SafetyReport | null;
}

// =============================================================================
// Sub-Components
// =============================================================================

/**
 * Bonding curve progress bar with graduation threshold marker.
 */
const BondingCurveBar: FunctionComponent<{
  vSolInBondingCurve: number;
}> = ({ vSolInBondingCurve }) => {
  const progress = useMemo(
    () => computeBondingCurveProgress(vSolInBondingCurve),
    [vSolInBondingCurve],
  );
  const color = useMemo(() => getProgressColor(progress), [progress]);

  return (
    <div class="ntf-bonding-bar-container" role="meter" aria-label={`Bonding curve: ${progress.toFixed(1)}%`}>
      <div class="ntf-bonding-bar">
        <div
          class="ntf-bonding-fill"
          style={{ width: `${progress}%`, backgroundColor: color }}
        />
        {/* Graduation threshold marker at 30% */}
        <div
          class="ntf-bonding-threshold"
          style={{ left: `${GRADUATION_THRESHOLD_PERCENT}%` }}
          title={`Graduation threshold: ${GRADUATION_THRESHOLD_PERCENT}%`}
          aria-hidden="true"
        />
      </div>
      <span class="ntf-bonding-label">{progress.toFixed(1)}%</span>
    </div>
  );
};

/**
 * Safety status badge for quick visual assessment.
 */
const SafetyStatusBadge: FunctionComponent<{
  status: SafetyStatus;
  score?: number;
}> = ({ status, score }) => {
  const config = SAFETY_CONFIG[status];

  return (
    <span
      class="ntf-safety-badge"
      style={{ color: config.color, borderColor: config.color }}
      title={score !== undefined ? `Safety score: ${score}` : config.label}
      aria-label={`Safety: ${config.label}${score !== undefined ? ` (score: ${score})` : ''}`}
    >
      <span aria-hidden="true">{config.icon}</span> {config.label}
    </span>
  );
};

/**
 * Individual token feed card displaying token info, safety status,
 * and bonding curve progress.
 */
const TokenFeedCard: FunctionComponent<{
  entry: NewTokenFeedEntry;
}> = ({ entry }) => {
  const { token, safetyReport } = entry;

  const safetyStatus = useMemo(
    () => deriveSafetyStatus(safetyReport),
    [safetyReport],
  );

  const creationTime = useMemo(
    () => formatTimeAgo(token.timestamp),
    [token.timestamp],
  );

  return (
    <div
      class="ntf-card"
      role="article"
      aria-label={`New token: ${token.name} (${token.symbol})`}
    >
      {/* Card Header: Token name, symbol, creation time */}
      <div class="ntf-card-header">
        <div class="ntf-token-info">
          <span class="ntf-token-name" title={token.name}>{token.name}</span>
          <span class="ntf-token-symbol">{token.symbol}</span>
        </div>
        <span class="ntf-creation-time" title={new Date(token.timestamp).toISOString()}>
          {creationTime}
        </span>
      </div>

      {/* Card Body: Safety, bonding curve, creator info */}
      <div class="ntf-card-body">
        <div class="ntf-row">
          <SafetyStatusBadge
            status={safetyStatus}
            score={safetyReport?.overallScore}
          />
          <span class="ntf-mcap" title="Market cap in SOL">
            MC: {formatSolAmount(token.marketCapSol)}
          </span>
        </div>

        <div class="ntf-row">
          <span class="ntf-label">Bonding Curve:</span>
          <BondingCurveBar vSolInBondingCurve={token.vSolInBondingCurve} />
        </div>

        <div class="ntf-row ntf-meta-row">
          <span class="ntf-creator" title={`Creator: ${token.traderPublicKey}`}>
            👤 {truncateAddress(token.traderPublicKey)}
          </span>
          {token.initialBuy > 0 && (
            <span class="ntf-initial-buy" title="Creator initial buy">
              💰 {formatSolAmount(token.initialBuy)}
            </span>
          )}
        </div>
      </div>

      {/* Mint address (for easy copy) */}
      <div class="ntf-card-footer">
        <span class="ntf-mint" title={token.mint}>
          {truncateAddress(token.mint)}
        </span>
      </div>
    </div>
  );
};

// =============================================================================
// NewTokenFeed Props
// =============================================================================

/**
 * Props for the NewTokenFeed component.
 */
export interface NewTokenFeedProps {
  /** Array of new token feed entries (newest first) */
  entries: NewTokenFeedEntry[];
  /** Maximum number of tokens to display (default: 20) */
  maxTokens?: number;
  /** Whether the feed is currently connected to PumpPortal WebSocket */
  isConnected?: boolean;
  /** Optional filter: only show tokens above this bonding curve progress % */
  minBondingCurvePercent?: number;
}

// =============================================================================
// NewTokenFeed Component
// =============================================================================

/**
 * Real-time new token feed component for the GMGN Signal Bot overlay.
 *
 * Displays a scrollable list of newly created pump.fun tokens from the
 * PumpPortal WebSocket stream. Each entry shows:
 * - Token name and symbol
 * - Creation timestamp
 * - Initial safety screening result (Safe/Caution/Danger/Pending)
 * - Bonding curve progress percentage with graduation threshold marker
 * - Creator wallet address and initial buy amount
 *
 * Supports filtering by minimum bonding curve progress (default: show all,
 * but per AAP only tokens at ≥30% bonding curve progress are scored).
 */
const NewTokenFeed: FunctionComponent<NewTokenFeedProps> = ({
  entries,
  maxTokens = DEFAULT_MAX_TOKENS,
  isConnected = false,
  minBondingCurvePercent = 0,
}) => {
  // ---------------------------------------------------------------------------
  // Filter Controls
  // ---------------------------------------------------------------------------

  const [showGraduationOnly, setShowGraduationOnly] = useState(false);

  const filteredEntries = useMemo(() => {
    let filtered = entries;

    // Apply bonding curve minimum filter
    if (minBondingCurvePercent > 0) {
      filtered = filtered.filter((e) => {
        const progress = computeBondingCurveProgress(e.token.vSolInBondingCurve);
        return progress >= minBondingCurvePercent;
      });
    }

    // Apply graduation-ready filter (≥30% bonding curve)
    if (showGraduationOnly) {
      filtered = filtered.filter((e) => {
        const progress = computeBondingCurveProgress(e.token.vSolInBondingCurve);
        return progress >= GRADUATION_THRESHOLD_PERCENT;
      });
    }

    return filtered.slice(0, maxTokens);
  }, [entries, maxTokens, minBondingCurvePercent, showGraduationOnly]);

  const handleGraduationToggle = useCallback(() => {
    setShowGraduationOnly((prev) => !prev);
  }, []);

  // ---------------------------------------------------------------------------
  // Empty State
  // ---------------------------------------------------------------------------

  if (entries.length === 0) {
    return (
      <div class="ntf-empty" role="status" aria-label="No new tokens">
        <span class="ntf-empty-icon" aria-hidden="true">🔍</span>
        <span class="ntf-empty-text">
          {isConnected
            ? 'Waiting for new tokens...'
            : 'Connecting to PumpPortal...'}
        </span>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div class="ntf-feed" role="feed" aria-label="New token feed">
      {/* Feed Header */}
      <div class="ntf-header">
        <div class="ntf-header-info">
          <span class="ntf-header-title">🆕 New Tokens</span>
          <span
            class="ntf-connection-status"
            style={{ color: isConnected ? '#22c55e' : '#ef4444' }}
            aria-label={isConnected ? 'Connected to PumpPortal' : 'Disconnected from PumpPortal'}
          >
            {isConnected ? '● Live' : '○ Offline'}
          </span>
        </div>
        <div class="ntf-filters">
          <label class="ntf-filter-label">
            <input
              type="checkbox"
              checked={showGraduationOnly}
              onChange={handleGraduationToggle}
            />
            ≥{GRADUATION_THRESHOLD_PERCENT}% bonding curve only
          </label>
        </div>
      </div>

      {/* Token Count */}
      <div class="ntf-count" role="status">
        {filteredEntries.length} of {entries.length} tokens
        {showGraduationOnly && ' (graduation-ready)'}
      </div>

      {/* Token Cards */}
      <div class="ntf-list" role="list">
        {filteredEntries.map((entry) => (
          <TokenFeedCard key={entry.token.mint} entry={entry} />
        ))}
      </div>

      {/* No results after filtering */}
      {filteredEntries.length === 0 && entries.length > 0 && (
        <div class="ntf-no-results" role="status">
          <span class="ntf-no-results-text">No tokens match current filters</span>
        </div>
      )}
    </div>
  );
};

export { NewTokenFeed };
