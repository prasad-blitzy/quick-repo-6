/**
 * @fileoverview TypeScript type definitions for GMGN.ai data models.
 *
 * This is the foundational type definitions file for the entire `src/gmgn/` module.
 * It contains ZERO imports and ZERO runtime code — only exported interfaces and types.
 *
 * All other files in `src/gmgn/` import from this module, along with consumers
 * in `src/signals/`, `src/store/`, `src/tracking/`, and `src/utils/`.
 *
 * Data sources represented:
 * - `/defi/quotation/v1/rank/{chain}/swaps/{timeframe}` → GmgnTrendingToken
 * - `/api/v1/token/{address}` → GmgnTokenDetail
 * - `/api/v1/wallet_activity/{address}` → GmgnWalletActivity
 * - `/api/v1/smartmoney/{address}` → GmgnSmartMoneySignal
 *
 * @module src/gmgn/types
 */

// =============================================================================
// Wallet Classification
// =============================================================================

/**
 * GMGN wallet classification type.
 *
 * GMGN.ai classifies tracked wallets into categories based on their
 * on-chain trading behavior, win rate, and known associations.
 *
 * - `smart_money`  — 70%+ historical win rate, proven track record
 * - `kol`          — Key Opinion Leader / influencer
 * - `whale`        — Large position holder (significant capital)
 * - `sniper`       — First-block buyer (buys within the first block of token launch)
 * - `insider`      — Connected to project team / early access
 * - `developer`    — Token creator or deployer wallet
 * - `unknown`      — Unclassified wallet (default fallback)
 */
export type GmgnWalletType =
  | 'smart_money'
  | 'kol'
  | 'whale'
  | 'sniper'
  | 'insider'
  | 'developer'
  | 'unknown';

// =============================================================================
// GmgnTrendingToken
// =============================================================================

/**
 * Represents a token entry from GMGN's trending/rank endpoints.
 *
 * Source endpoint: `/defi/quotation/v1/rank/{chain}/swaps/{timeframe}`
 *
 * Used by:
 * - `parseTrendingTokens()` in `src/gmgn/parsers.ts`
 * - `src/store/token-store.ts` for populating trending token lists
 * - `src/components/NewTokenFeed.tsx` for display rendering
 */
export interface GmgnTrendingToken {
  /** Token mint address (Solana base58 public key) */
  address: string;

  /** Token ticker symbol (e.g., "SOL", "BONK", "WIF") */
  symbol: string;

  /** Full token name (e.g., "Wrapped SOL", "Bonk") */
  name: string;

  /** Current price in USD */
  price: number;

  /** 1-hour price change percentage (e.g., 5.2 means +5.2%) */
  priceChange1h: number;

  /** 24-hour price change percentage (e.g., -12.3 means -12.3%) */
  priceChange24h: number;

  /** 24-hour trading volume in USD */
  volume24h: number;

  /** 1-hour trading volume in USD */
  volume1h: number;

  /** Number of swap transactions in the last 24 hours */
  swaps24h: number;

  /** Number of swap transactions in the last 1 hour */
  swaps1h: number;

  /** Market capitalization in USD */
  marketCap: number;

  /** Total liquidity in USD across all DEX pools */
  liquidity: number;

  /** Number of unique token holder wallets */
  holderCount: number;

  /** Token logo image URL (if available, may be empty string) */
  logoUrl: string;

  /** Token creation timestamp (Unix timestamp in seconds, NOT milliseconds) */
  createdAt: number;
}

// =============================================================================
// GmgnTokenDetail
// =============================================================================

/**
 * Comprehensive token detail data from GMGN.
 *
 * This is the MOST IMPORTANT type in the GMGN module — it represents the
 * full token data that feeds into the 7-factor signal scoring engine.
 *
 * Source endpoint: `/api/v1/token/{address}`
 *
 * Used by:
 * - `parseTokenDetail()` in `src/gmgn/parsers.ts`
 * - `src/signals/scoring-engine.ts` as primary input for signal analysis
 * - `src/store/token-store.ts` for state management
 *
 * Field coverage for the 7-factor scoring engine:
 * - Volume data (volume5m, volume1h, volume24h) → `volume-spike.ts`
 * - Smart money count (smartMoneyCount) → `smart-money-convergence.ts`
 * - Buy/sell counts (buys1h, sells1h, buys24h, sells24h) → `buy-sell-ratio.ts`
 * - Holder count (holderCount) → `holder-growth.ts`
 * - Liquidity (liquidity) → `liquidity.ts`
 * - Creation timestamp (createdAt) → `token-age.ts`
 * - Safety indicators (rugProbability, isHoneypot, mintAuthorityActive,
 *   freezeAuthorityActive, topHolderPercent, lpBurned) → `safety-score.ts`
 */
export interface GmgnTokenDetail {
  /** Token mint address (Solana base58 public key) */
  address: string;

  /** Token ticker symbol */
  symbol: string;

  /** Full token name */
  name: string;

  // ===== Price Data =====

  /** Current price in USD */
  price: number;

  /** 5-minute price change percentage */
  priceChange5m: number;

  /** 1-hour price change percentage */
  priceChange1h: number;

  /** 24-hour price change percentage */
  priceChange24h: number;

  // ===== Market Data =====

  /** Market capitalization in USD */
  marketCap: number;

  /** 24-hour trading volume in USD */
  volume24h: number;

  /** 1-hour trading volume in USD */
  volume1h: number;

  /** 5-minute trading volume in USD */
  volume5m: number;

  /** Total liquidity in USD across all DEX pools */
  liquidity: number;

  // ===== Holder Data =====

  /** Number of unique token holder wallets */
  holderCount: number;

  /** Number of smart money wallets currently holding this token */
  smartMoneyCount: number;

  // ===== Trading Activity =====

  /** Number of buy transactions in the last 24 hours */
  buys24h: number;

  /** Number of sell transactions in the last 24 hours */
  sells24h: number;

  /** Number of buy transactions in the last 1 hour */
  buys1h: number;

  /** Number of sell transactions in the last 1 hour */
  sells1h: number;

  // ===== Dev/Creator Wallet =====

  /** Developer/creator wallet address (Solana base58 public key) */
  devWalletAddress: string;

  /** Whether the developer has sold their token allocation */
  devWalletSold: boolean;

  // ===== Safety Indicators =====

  /** GMGN's estimated rug probability score (0–100, higher is riskier) */
  rugProbability: number;

  /** Whether the token is flagged as a honeypot (cannot be sold) */
  isHoneypot: boolean;

  /** Whether mint authority is still active (true = risky, tokens can be minted) */
  mintAuthorityActive: boolean;

  /** Whether freeze authority is still active (true = risky, accounts can be frozen) */
  freezeAuthorityActive: boolean;

  /** Percentage of total supply held by top holders (0–100) */
  topHolderPercent: number;

  /** Whether LP (Liquidity Pool) tokens have been burned */
  lpBurned: boolean;

  // ===== Metadata =====

  /** Token creation timestamp (Unix timestamp in seconds, NOT milliseconds) */
  createdAt: number;

  /** Token logo image URL */
  logoUrl: string;

  /** Total token supply (raw amount, may include decimals) */
  supply: number;
}

// =============================================================================
// GmgnWalletActivity
// =============================================================================

/**
 * Represents an individual wallet trading activity entry from GMGN.
 *
 * Source endpoint: `/api/v1/wallet_activity/{address}`
 *
 * Used by:
 * - `parseWalletActivity()` in `src/gmgn/parsers.ts`
 * - `src/tracking/wallet-tracker.ts` for monitoring smart money wallets
 * - `src/signals/factors/smart-money-convergence.ts` for convergence detection
 */
export interface GmgnWalletActivity {
  /** Wallet address performing the action (Solana base58 public key) */
  walletAddress: string;

  /** Token address involved in the activity (Solana base58 public key) */
  tokenAddress: string;

  /** Type of activity: buy, sell, or transfer */
  action: 'buy' | 'sell' | 'transfer';

  /** Token amount involved in the transaction */
  amount: number;

  /** USD value of the activity at the time of transaction */
  amountUsd: number;

  /** Price per token in USD at the time of activity */
  price: number;

  /** Activity timestamp (Unix timestamp in seconds, NOT milliseconds) */
  timestamp: number;

  /** Transaction hash/signature for on-chain verification (Solana tx signature) */
  txHash: string;

  /** Token symbol for display purposes (e.g., "SOL", "BONK") */
  tokenSymbol: string;
}

// =============================================================================
// GmgnSmartMoneySignal
// =============================================================================

/**
 * Represents a smart money wallet signal from GMGN's classification system.
 *
 * GMGN classifies wallets into categories:
 * - Smart Money (70%+ win rate)
 * - KOL (Key Opinion Leader)
 * - Whale (large position holder)
 * - Sniper (first-block buyer)
 * - Insider (connected to project team)
 * - Developer (token creator/deployer)
 *
 * Source endpoint: `/api/v1/smartmoney/{address}`
 *
 * Used by:
 * - `parseSmartMoneySignals()` in `src/gmgn/parsers.ts`
 * - `src/tracking/wallet-classifier.ts` for wallet classification
 * - `src/tracking/convergence-detector.ts` for convergence analysis
 */
export interface GmgnSmartMoneySignal {
  /** Smart money wallet address (Solana base58 public key) */
  walletAddress: string;

  /** GMGN's tag/label for this wallet (e.g., wallet name, ENS name, or custom label) */
  walletTag: string;

  /** GMGN wallet classification type */
  walletType: GmgnWalletType;

  /** Historical win rate as a percentage (0–100, e.g., 72.5 means 72.5% wins) */
  winRate: number;

  /** Total profit and loss in USD (positive = profit, negative = loss) */
  pnl: number;

  /** Average hold time in seconds for completed trades */
  avgHoldTime: number;

  /** Token address being traded (Solana base58 public key) */
  tokenAddress: string;

  /** Trade action: buy or sell */
  action: 'buy' | 'sell';

  /** Token amount traded */
  amount: number;

  /** USD value of the trade at the time of execution */
  amountUsd: number;

  /** Trade timestamp (Unix timestamp in seconds, NOT milliseconds) */
  timestamp: number;

  /** Transaction hash/signature for on-chain verification (Solana tx signature) */
  txHash: string;
}

// =============================================================================
// Utility / Helper Types
// =============================================================================

/**
 * Generic parsed response wrapper for dispatching parsed GMGN data.
 *
 * Used by `parseInterceptedResponse()` in `src/gmgn/parsers.ts` as a
 * unified return type that allows downstream consumers to handle different
 * GMGN API response types through a single discriminated interface.
 */
export interface GmgnParsedResponse {
  /** The GMGN API pattern type identifier (e.g., 'trending_tokens', 'token_detail') */
  type: string;

  /**
   * Parsed data payload — the union of all possible parsed response types.
   * The consumer should narrow the type based on the `type` discriminator field.
   * - `GmgnTrendingToken[]` for 'trending_tokens'
   * - `GmgnTokenDetail` for 'token_detail'
   * - `GmgnWalletActivity[]` for 'wallet_activity'
   * - `GmgnSmartMoneySignal[]` for 'smart_money'
   * - `null` for unrecognized or unparseable responses
   */
  data:
    | GmgnTrendingToken[]
    | GmgnTokenDetail
    | GmgnWalletActivity[]
    | GmgnSmartMoneySignal[]
    | null;
}

/**
 * Raw intercepted message structure posted via `window.postMessage`
 * from the page-context injected script (`entrypoints/injected.ts`).
 *
 * The content script (`entrypoints/content.ts`) listens for these messages
 * and validates the `source` field before forwarding to the service worker.
 *
 * Per AAP Section 0.4.2:
 * - `source` must be `'gmgn-signal-bot'` for message filtering
 * - `type` must be `'GMGN_API_RESPONSE'` as a discriminated union tag
 * - `payload` contains the intercepted URL, raw data, and matched pattern type
 */
export interface GmgnInterceptedMessage {
  /** Constant source identifier for filtering in the content script */
  source: 'gmgn-signal-bot';

  /** Discriminated union tag identifying this as a GMGN API interception message */
  type: 'GMGN_API_RESPONSE';

  /** Intercepted API response payload */
  payload: {
    /** The full URL that was intercepted (e.g., '/api/v1/token/So111...') */
    url: string;

    /** Raw JSON response data from the GMGN API (untyped, needs parsing) */
    data: unknown;

    /** Matched GMGN API pattern type from url-patterns.ts (e.g., 'trending_tokens') */
    patternType: string;
  };
}
