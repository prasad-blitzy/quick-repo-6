/**
 * src/components/SmartMoneyIndicator.tsx — Smart Money Activity Indicator
 *
 * Displays smart money wallet count entering a token, convergence status
 * (active/inactive), average position size context, and an expandable
 * wallet detail list for the GMGN Signal Bot Chrome Extension overlay.
 *
 * Per AAP §0.5.1 Group 11:
 *   "Displays smart money wallet count entering the token, convergence
 *    status (active/inactive), and average position size context"
 *
 * Per AAP §0.1.1:
 *   "Smart Money and Whale Tracking: Detect convergence signals when 3+
 *    qualified smart money wallets enter the same token within a 2-hour
 *    window, with position-size context analysis (entries above 80% of
 *    historical average indicating conviction)"
 *
 * Per AAP §0.5.1 Group 7 — Wallet Classification:
 *   "Classifies wallets by type: Smart Money (70%+ win rate), KOL, Whale,
 *    Sniper, Insider, Developer based on GMGN categorization data"
 *
 * Data source:
 *   Reads smart money data from the Zustand token-store via
 *   `useTokenStoreHook` from `src/store/index.ts`. The token store
 *   provides `smartMoneyCount` and `smartMoneyWallets` per token.
 *
 * @module components/SmartMoneyIndicator
 */

import { h, type FunctionComponent } from 'preact';
import { useState } from 'preact/hooks';
import { useTokenStoreHook } from '../store/index';
import type { WalletClassification } from '../tracking/types';
import { formatPrice, formatTimeAgo } from '../utils/formatting';

// =============================================================================
// Constants
// =============================================================================

/**
 * Minimum wallet count for active convergence per AAP (3+ wallets).
 * When 3 or more qualified smart money wallets enter the same token
 * within the detection window, convergence is considered ACTIVE.
 */
const CONVERGENCE_THRESHOLD = 3;

/**
 * Position size percentage threshold for conviction signal per AAP.
 * When a wallet's entry position is ≥80% of its historical average,
 * it indicates strong conviction in the trade.
 */
const CONVICTION_PERCENT_THRESHOLD = 0.8;

// =============================================================================
// Classification Display Mappings
// =============================================================================

/**
 * Emoji icons for each wallet classification type per AAP §0.5.1 Group 7.
 * Uses the snake_case `WalletClassification` union type from tracking/types.
 */
const CLASSIFICATION_EMOJI: Record<WalletClassification, string> = {
  smart_money: '🧠',
  kol: '📢',
  whale: '🐋',
  sniper: '⚡',
  insider: '🔍',
  developer: '👨‍💻',
};

/**
 * Human-readable labels for each wallet classification type.
 */
const CLASSIFICATION_LABEL: Record<WalletClassification, string> = {
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
 * Truncates a Solana wallet address for compact display.
 * Shows first 4 and last 4 characters with ellipsis.
 *
 * @param address - Full base58 Solana wallet address
 * @returns Truncated address string (e.g., "7xKX...9fGh")
 */
function truncateAddress(address: string): string {
  if (!address || address.length <= 10) {
    return address || '';
  }
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * Returns the emoji icon for a given wallet classification.
 * Falls back to a generic person icon for unknown types.
 *
 * @param type - Wallet classification string (snake_case per WalletClassification type)
 * @returns Emoji string for the classification
 */
function classificationEmoji(type: WalletClassification | string): string {
  return CLASSIFICATION_EMOJI[type as WalletClassification] || '👤';
}

/**
 * Returns the human-readable label for a given wallet classification.
 * Falls back to the raw type string for unknown classifications.
 *
 * @param type - Wallet classification string
 * @returns Human-readable label string
 */
function classificationLabel(type: WalletClassification | string): string {
  return CLASSIFICATION_LABEL[type as WalletClassification] || String(type);
}

/**
 * Determines the conviction level label and color from position size
 * ratio relative to historical average.
 *
 * Per AAP: entries ≥80% of historical average indicate conviction.
 *
 * @param entrySize - Current position size in USD
 * @param historicalAvgSize - Historical average position size in USD
 * @returns Object with label, color, and conviction boolean
 */
function getConvictionLevel(entrySize: number, historicalAvgSize: number): {
  label: string;
  color: string;
  isConviction: boolean;
} {
  if (historicalAvgSize <= 0) {
    return { label: 'Unknown', color: '#94a3b8', isConviction: false };
  }

  const ratio = entrySize / historicalAvgSize;

  if (ratio >= CONVICTION_PERCENT_THRESHOLD) {
    return { label: 'High Conviction', color: '#22c55e', isConviction: true };
  }
  if (ratio >= 0.5) {
    return { label: 'Normal', color: '#94a3b8', isConviction: false };
  }
  return { label: 'Small Position', color: '#5f6368', isConviction: false };
}

// =============================================================================
// Local Type — Enriched Wallet Detail
// =============================================================================

/**
 * Enriched wallet detail structure for rich display mode.
 *
 * The token store currently provides `smartMoneyWallets: string[]` (addresses only).
 * This interface defines the enriched wallet data model for when per-wallet
 * classification, position size, and timing data is available through
 * store evolution or additional data sources.
 */
interface SmartMoneyWalletDetail {
  /** Solana wallet address (base58-encoded public key) */
  address: string;
  /** Wallet classification from GMGN categorization */
  classification: WalletClassification;
  /** Position entry size in USD */
  entrySize: number;
  /** Entry timestamp (Unix milliseconds) */
  entryTime: number;
  /** Wallet's historical average position size in USD */
  historicalAvgSize: number;
}

// =============================================================================
// Props Interface
// =============================================================================

/**
 * Props for the SmartMoneyIndicator component.
 *
 * The component reads smart money data from the Zustand token store
 * using the `tokenMint` address as the lookup key.
 */
interface SmartMoneyIndicatorProps {
  /** Solana token mint address to display smart money data for */
  tokenMint: string;
}

// =============================================================================
// SmartMoneyIndicator Component
// =============================================================================

/**
 * Smart money activity indicator component for the GMGN Signal Bot overlay.
 *
 * Displays:
 * 1. Total smart money wallet count entering the token
 * 2. Convergence status: Active (≥3 wallets, green) or Inactive (grey)
 * 3. Token price context with last-updated timestamp
 * 4. Expandable wallet address list (collapsed by default)
 *
 * Reads reactive data from the Zustand token store via `useTokenStoreHook`.
 * The component re-renders when the selected token's smart money data changes.
 *
 * Per AAP convergence threshold: ≥3 qualified wallets = Active.
 * Per AAP conviction threshold: entry ≥80% of historical average = High Conviction.
 */
const SmartMoneyIndicator: FunctionComponent<SmartMoneyIndicatorProps> = ({
  tokenMint,
}) => {
  // ---------------------------------------------------------------------------
  // Local State — Expandable Wallet Detail List Toggle
  // ---------------------------------------------------------------------------
  const [expanded, setExpanded] = useState(false);

  // ---------------------------------------------------------------------------
  // Store Data — Read Smart Money Data from Token Store
  // ---------------------------------------------------------------------------
  const tokenData = useTokenStoreHook(
    (state) => state.tokens[tokenMint],
  );

  // ---------------------------------------------------------------------------
  // Null Guard — No Data Available
  // ---------------------------------------------------------------------------
  if (!tokenData || !tokenData.smartMoneyCount) {
    return (
      <div
        class="sm-indicator empty"
        role="status"
        aria-label="No smart money data available"
      >
        No smart money data
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Destructure Token Data
  // ---------------------------------------------------------------------------
  const {
    smartMoneyCount,
    smartMoneyWallets,
    price,
    lastUpdated,
  } = tokenData;

  // ---------------------------------------------------------------------------
  // Derived State
  // ---------------------------------------------------------------------------

  /** Convergence is active when 3+ wallets are tracked per AAP */
  const isConvergenceActive = smartMoneyCount >= CONVERGENCE_THRESHOLD;

  /** Wallet addresses available for display */
  const walletAddresses: string[] = smartMoneyWallets ?? [];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div class="sm-indicator" role="region" aria-label="Smart money indicator">
      {/* Wallet Count with Icon */}
      <div class="sm-count">
        <span class="sm-icon" aria-hidden="true">
          🐋
        </span>
        <span>
          {smartMoneyCount} Smart Money Wallet
          {smartMoneyCount !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Convergence Status Badge */}
      <div
        class={`convergence-status ${isConvergenceActive ? 'active' : 'inactive'}`}
        role="status"
        aria-label={`Convergence ${isConvergenceActive ? 'active' : 'inactive'}: ${smartMoneyCount} wallets`}
      >
        {isConvergenceActive
          ? '🔥 Convergence Active'
          : 'No Convergence'}
      </div>

      {/* Price Context — shows current price and last update time */}
      {price > 0 && (
        <div class="wallet-row wallet-row--no-border">
          <span class="wallet-entry">
            {formatPrice(price)}
          </span>
          {lastUpdated > 0 && (
            <span class="wallet-time">
              {formatTimeAgo(lastUpdated)}
            </span>
          )}
        </div>
      )}

      {/* Classification Summary — shows emoji badges for known types */}
      {smartMoneyCount > 0 && (
        <div
          class="wallet-row wallet-row--no-border wallet-row--wrap"
          role="group"
          aria-label="Wallet classification summary"
        >
          {(
            [
              'smart_money',
              'kol',
              'whale',
              'sniper',
              'insider',
              'developer',
            ] as WalletClassification[]
          ).map((classification) => (
            <span
              key={classification}
              class="wallet-badge"
              title={classificationLabel(classification)}
              aria-label={classificationLabel(classification)}
            >
              {classificationEmoji(classification)}
            </span>
          ))}
        </div>
      )}

      {/* Expandable Wallet Address List */}
      {walletAddresses.length > 0 && (
        <div class="sm-wallet-section">
          <button
            class="sm-expand-btn"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-controls="sm-wallet-list"
          >
            <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
            <span>
              {walletAddresses.length} wallet
              {walletAddresses.length !== 1 ? 's' : ''}
            </span>
          </button>

          {expanded && (
            <div
              id="sm-wallet-list"
              role="list"
              aria-label="Smart money wallet addresses"
            >
              {walletAddresses.map((address) => (
                <div class="wallet-row" key={address} role="listitem">
                  <span class="wallet-badge" aria-hidden="true">
                    👤
                  </span>
                  <span class="wallet-address" title={address}>
                    {truncateAddress(address)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// =============================================================================
// Exports
// =============================================================================

export {
  SmartMoneyIndicator,
  getConvictionLevel,
  CONVERGENCE_THRESHOLD,
  CONVICTION_PERCENT_THRESHOLD,
};
export type { SmartMoneyIndicatorProps, SmartMoneyWalletDetail };
