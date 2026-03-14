/**
 * src/components/SmartMoneyIndicator.tsx — Smart Money Activity Indicator
 *
 * Displays smart money wallet count entering a token, convergence status
 * (active/inactive), and average position size context for the GMGN Signal
 * Bot Chrome Extension overlay.
 *
 * Per AAP §0.5.1 Group 11:
 *   "Displays smart money wallet count, convergence status (active/inactive),
 *    and average position size context"
 *
 * Per AAP §0.5.1 Group 5 — Smart Money Convergence:
 *   "Detects convergence signals when 3+ qualified smart money wallets enter
 *    the same token within a 2-hour window, with position-size context analysis
 *    (entries above 80% of historical average indicating conviction)"
 *
 * Per AAP §0.5.1 Group 7 — Wallet Classification:
 *   "Classifies wallets by type: Smart Money, KOL, Whale, Sniper, Insider,
 *    Developer based on GMGN categorization data"
 *
 * Data source:
 *   Reads convergence events and smart money data from the Zustand
 *   token-store and signal-store via `useTokenStoreHook` and
 *   `useSignalStoreHook` from `src/store/index.ts`.
 *
 * @module components/SmartMoneyIndicator
 */

import { h, type FunctionComponent } from 'preact';
import { useMemo } from 'preact/hooks';
import type { ConvergenceEvent, WalletClassification, PositionSizeContext } from '../tracking/types';

// =============================================================================
// Constants
// =============================================================================

/** Minimum wallet count for active convergence per AAP (3+ wallets) */
const CONVERGENCE_MIN_WALLETS = 3;

/** Position size percentage threshold for conviction signal per AAP (≥80%) */
const CONVICTION_THRESHOLD = 80;

/** Colour map for convergence status */
const STATUS_COLORS = {
  active: '#22c55e',
  inactive: '#94a3b8',
  building: '#f59e0b',
} as const;

/** Icons for wallet classification types per AAP §0.5.1 Group 7 */
const CLASSIFICATION_ICONS: Record<WalletClassification, string> = {
  smart_money: '🧠',
  kol: '📣',
  whale: '🐋',
  sniper: '🎯',
  insider: '🕵️',
  developer: '👨‍💻',
};

/** Human-readable labels for wallet classification types */
const CLASSIFICATION_LABELS: Record<WalletClassification, string> = {
  smart_money: 'Smart Money',
  kol: 'KOL',
  whale: 'Whale',
  sniper: 'Sniper',
  insider: 'Insider',
  developer: 'Developer',
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Determines the convergence status label and colour based on wallet count.
 *
 * - ≥3 wallets = "Active" (green) — convergence threshold met per AAP
 * - 1–2 wallets = "Building" (amber) — early accumulation signals
 * - 0 wallets = "Inactive" (grey) — no smart money activity detected
 */
function getConvergenceStatus(walletCount: number): {
  label: string;
  color: string;
  icon: string;
} {
  if (walletCount >= CONVERGENCE_MIN_WALLETS) {
    return { label: 'Active', color: STATUS_COLORS.active, icon: '🟢' };
  }
  if (walletCount > 0) {
    return { label: 'Building', color: STATUS_COLORS.building, icon: '🟡' };
  }
  return { label: 'Inactive', color: STATUS_COLORS.inactive, icon: '⚪' };
}

/**
 * Formats a SOL amount for display (e.g., 12.5 SOL, <0.01 SOL).
 */
function formatSol(amount: number): string {
  if (amount === 0) return '0 SOL';
  if (amount < 0.01) return '<0.01 SOL';
  if (amount < 1) return `${amount.toFixed(3)} SOL`;
  if (amount < 1000) return `${amount.toFixed(2)} SOL`;
  return `${(amount / 1000).toFixed(1)}K SOL`;
}

/**
 * Computes a human-readable time window description.
 */
function formatTimeWindow(startMs: number, endMs: number): string {
  const durationMin = Math.floor((endMs - startMs) / 60_000);
  if (durationMin < 60) return `${durationMin}m window`;
  const hours = Math.floor(durationMin / 60);
  const mins = durationMin % 60;
  return mins > 0 ? `${hours}h ${mins}m window` : `${hours}h window`;
}

/**
 * Determines the conviction level from position size percentage of
 * historical average. Per AAP: entries ≥80% of historical average
 * indicate conviction.
 */
function getConvictionLevel(positionSizeContext: PositionSizeContext | null): {
  label: string;
  color: string;
  isConviction: boolean;
} {
  if (!positionSizeContext || positionSizeContext.historicalAvg === 0) {
    return { label: 'Unknown', color: '#94a3b8', isConviction: false };
  }
  const pct = positionSizeContext.percentOfAvg;
  if (pct >= CONVICTION_THRESHOLD) {
    return { label: 'High Conviction', color: '#22c55e', isConviction: true };
  }
  if (pct >= 50) {
    return { label: 'Medium', color: '#f59e0b', isConviction: false };
  }
  return { label: 'Exploratory', color: '#94a3b8', isConviction: false };
}

// =============================================================================
// Sub-Components
// =============================================================================

/**
 * Compact wallet entry row showing classification icon, address snippet,
 * and position size.
 */
const WalletRow: FunctionComponent<{
  address: string;
  classification: WalletClassification;
  positionSize?: number;
}> = ({ address, classification, positionSize }) => {
  const truncatedAddr = useMemo(
    () => `${address.slice(0, 4)}...${address.slice(-4)}`,
    [address],
  );

  return (
    <div class="sm-wallet-row" role="listitem" aria-label={`${CLASSIFICATION_LABELS[classification]} wallet ${truncatedAddr}`}>
      <span class="sm-wallet-icon" aria-hidden="true">{CLASSIFICATION_ICONS[classification]}</span>
      <span class="sm-wallet-type">{CLASSIFICATION_LABELS[classification]}</span>
      <span class="sm-wallet-addr" title={address}>{truncatedAddr}</span>
      {positionSize !== undefined && positionSize > 0 && (
        <span class="sm-wallet-size">{formatSol(positionSize)}</span>
      )}
    </div>
  );
};

/**
 * Convergence status header with wallet count and status badge.
 */
const ConvergenceHeader: FunctionComponent<{
  walletCount: number;
  convictionScore: number;
}> = ({ walletCount, convictionScore }) => {
  const status = useMemo(() => getConvergenceStatus(walletCount), [walletCount]);

  return (
    <div class="sm-convergence-header" role="status" aria-label={`Convergence: ${status.label} — ${walletCount} wallets`}>
      <div class="sm-status-badge" style={{ borderColor: status.color }}>
        <span class="sm-status-icon" aria-hidden="true">{status.icon}</span>
        <span class="sm-status-label" style={{ color: status.color }}>{status.label}</span>
      </div>
      <div class="sm-counts">
        <span class="sm-wallet-count">{walletCount} wallets</span>
        {convictionScore > 0 && (
          <span class="sm-conviction-score" title="Convergence conviction score">
            Score: {convictionScore.toFixed(0)}
          </span>
        )}
      </div>
    </div>
  );
};

// =============================================================================
// SmartMoneyIndicator Props
// =============================================================================

/**
 * Props for the SmartMoneyIndicator component.
 */
export interface SmartMoneyIndicatorProps {
  /** Number of smart money wallets that have entered the token */
  walletCount: number;

  /** Array of wallet addresses with their classifications */
  wallets?: Array<{
    address: string;
    classification: WalletClassification;
    positionSize?: number;
  }>;

  /** Convergence event data (null if no convergence detected) */
  convergenceEvent?: ConvergenceEvent | null;

  /** Average position size context for conviction analysis */
  positionSizeContext?: PositionSizeContext | null;

  /** Whether to show the expanded wallet list (compact by default) */
  expanded?: boolean;
}

// =============================================================================
// SmartMoneyIndicator Component
// =============================================================================

/**
 * Smart money activity indicator component for the GMGN Signal Bot overlay.
 *
 * Displays:
 * 1. Smart money wallet count entering the token
 * 2. Convergence status: Active (≥3 wallets, green), Building (1–2, amber),
 *    Inactive (0, grey)
 * 3. Average position size context with conviction analysis (≥80% = conviction)
 * 4. Optional expanded wallet list with classification icons
 */
const SmartMoneyIndicator: FunctionComponent<SmartMoneyIndicatorProps> = ({
  walletCount,
  wallets = [],
  convergenceEvent = null,
  positionSizeContext = null,
  expanded = false,
}) => {
  // ---------------------------------------------------------------------------
  // Derived State
  // ---------------------------------------------------------------------------

  const conviction = useMemo(
    () => getConvictionLevel(positionSizeContext),
    [positionSizeContext],
  );

  const convergenceScore = useMemo(
    () => convergenceEvent?.convictionScore ?? 0,
    [convergenceEvent],
  );

  const timeWindow = useMemo(() => {
    if (!convergenceEvent) return null;
    return formatTimeWindow(convergenceEvent.windowStart, convergenceEvent.windowEnd);
  }, [convergenceEvent]);

  const avgQualityWeight = useMemo(
    () => convergenceEvent?.avgQualityWeight ?? 0,
    [convergenceEvent],
  );

  // ---------------------------------------------------------------------------
  // Empty State
  // ---------------------------------------------------------------------------

  if (walletCount === 0 && !convergenceEvent) {
    return (
      <div class="sm-indicator sm-empty" role="status" aria-label="No smart money activity">
        <span class="sm-empty-icon" aria-hidden="true">🧠</span>
        <span class="sm-empty-text">No smart money activity</span>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div class="sm-indicator" role="region" aria-label="Smart money indicator">
      {/* Convergence Status Header */}
      <ConvergenceHeader
        walletCount={walletCount}
        convictionScore={convergenceScore}
      />

      {/* Position Size Context */}
      {positionSizeContext && positionSizeContext.historicalAvg > 0 && (
        <div class="sm-position-context" role="group" aria-label="Position size context">
          <div class="sm-position-row">
            <span class="sm-position-label">Avg Position:</span>
            <span class="sm-position-value">{formatSol(positionSizeContext.currentSize)}</span>
          </div>
          <div class="sm-position-row">
            <span class="sm-position-label">Historical Avg:</span>
            <span class="sm-position-value">{formatSol(positionSizeContext.historicalAvg)}</span>
          </div>
          <div class="sm-position-row">
            <span class="sm-position-label">Conviction:</span>
            <span class="sm-conviction-badge" style={{ color: conviction.color }}>
              {conviction.isConviction ? '🔥 ' : ''}{conviction.label}
              {' '}({positionSizeContext.percentOfAvg.toFixed(0)}%)
            </span>
          </div>
        </div>
      )}

      {/* Convergence Details */}
      {convergenceEvent && (
        <div class="sm-convergence-detail" role="group" aria-label="Convergence details">
          {timeWindow && (
            <span class="sm-time-window">⏱ {timeWindow}</span>
          )}
          {avgQualityWeight > 0 && (
            <span class="sm-quality-weight" title="Average wallet quality weight">
              Quality: {avgQualityWeight.toFixed(2)}
            </span>
          )}
        </div>
      )}

      {/* Wallet List (expanded view) */}
      {expanded && wallets.length > 0 && (
        <div class="sm-wallet-list" role="list" aria-label="Smart money wallets">
          {wallets.map((wallet) => (
            <WalletRow
              key={wallet.address}
              address={wallet.address}
              classification={wallet.classification}
              positionSize={wallet.positionSize}
            />
          ))}
        </div>
      )}

      {/* Compact wallet type summary (non-expanded view) */}
      {!expanded && wallets.length > 0 && (
        <div class="sm-type-summary" role="group" aria-label="Wallet type summary">
          {Object.entries(
            wallets.reduce<Record<WalletClassification, number>>((acc, w) => {
              acc[w.classification] = (acc[w.classification] || 0) + 1;
              return acc;
            }, {} as Record<WalletClassification, number>),
          ).map(([type, count]) => (
            <span key={type} class="sm-type-badge" title={`${count} ${CLASSIFICATION_LABELS[type as WalletClassification]}`}>
              {CLASSIFICATION_ICONS[type as WalletClassification]} {count}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export { SmartMoneyIndicator };
