/**
 * src/api/types.ts — Shared API Response Type Definitions
 *
 * Foundational type definitions for the entire src/api/ module.
 * Every API client imports types from this file.
 *
 * This file contains ONLY TypeScript interface and type declarations.
 * NO imports, NO runtime code, NO external dependencies.
 *
 * Consumers:
 *  - src/api/birdeye.ts       → BirdeyeTokenData, BirdeyeOHLCV, BirdeyeTopHolder, BirdeyeTransaction
 *  - src/api/pump-portal.ts   → PumpPortalEvent, PumpPortalNewToken, PumpPortalTrade, PumpPortalMigration
 *  - src/api/jupiter.ts       → JupiterQuote, JupiterPrice, JupiterRoutePlan
 *  - src/api/helius.ts        → HeliusParsedTx, HeliusNativeTransfer, HeliusTokenTransfer, HeliusAccountData
 *  - src/api/rugcheck.ts      → RugCheckReport, RugCheckRisk, RugCheckHolder, RugCheckMarket
 *  - src/api/goplus.ts        → GoPlusResult, GoPlusHolder, GoPlusLPHolder
 *  - src/api/dexscreener.ts   → DexScreenerPair, DexScreenerToken, DexScreenerTxns
 *  - src/signals/scoring-engine.ts — consumes types for signal analysis input
 *  - src/safety/checker.ts    — consumes RugCheckReport, GoPlusResult
 *  - src/store/token-store.ts — stores BirdeyeTokenData, DexScreenerPair data
 */

// =============================================================================
// Birdeye API Types
// =============================================================================

/**
 * Comprehensive token data from Birdeye's token overview and price endpoints.
 * Used by the scoring engine for volume spike detection, liquidity checks,
 * holder analysis, and market cap evaluation.
 */
export interface BirdeyeTokenData {
  /** Token mint address (Solana base58 public key) */
  address: string;
  /** Token ticker symbol (e.g., "SOL", "BONK") */
  symbol: string;
  /** Full token name */
  name: string;
  /** Token decimal places for amount display conversion */
  decimals: number;
  /** Current price in USD */
  price: number;
  /** 24-hour price change as a percentage (e.g., 5.2 = +5.2%) */
  priceChange24h: number;
  /** 24-hour trading volume in USD */
  volume24h: number;
  /** 1-hour trading volume in USD — used for volume threshold checks ($2,000 min) */
  volume1h: number;
  /** 5-minute trading volume in USD — used for volume spike detection ($200 min) */
  volume5m: number;
  /** Market capitalization in USD */
  marketCap: number;
  /** Total liquidity across all pools in USD — hard filter: min $3K */
  liquidity: number;
  /** Number of unique token holders */
  holderCount: number;
  /** Total token supply (raw, before decimal adjustment) */
  supply: number;
  /** Circulating supply (tokens not locked/vesting) */
  circulatingSupply: number;
  /** Unix timestamp (seconds) of the most recent trade */
  lastTradeUnixTime: number;
  /** Token logo image URL (optional — may not exist for new tokens) */
  logoURI?: string;
  /** Additional metadata extensions (e.g., website, social links) */
  extensions?: Record<string, unknown>;
}

/**
 * OHLCV candlestick data from Birdeye's chart endpoint.
 * Used for moving average calculations in volume spike detection
 * and price trend analysis.
 */
export interface BirdeyeOHLCV {
  /** Candle start time as Unix timestamp (seconds) */
  unixTime: number;
  /** Opening price in USD */
  open: number;
  /** Highest price in USD during the candle period */
  high: number;
  /** Lowest price in USD during the candle period */
  low: number;
  /** Closing price in USD */
  close: number;
  /** Trading volume in USD for the candle period */
  volume: number;
}

/**
 * Top token holder information from Birdeye's holder endpoint.
 * Used for holder concentration analysis — top 10 holders >50% triggers
 * the hard filter per AAP.
 */
export interface BirdeyeTopHolder {
  /** Holder wallet address (Solana base58 public key) */
  address: string;
  /** Raw token amount held (before decimal adjustment) */
  amount: number;
  /** Percentage of total supply held by this wallet */
  percentage: number;
  /** Human-readable token amount (with decimals applied) */
  uiAmount: number;
}

/**
 * Individual transaction record from Birdeye's transaction history endpoint.
 * Used for buy/sell ratio analysis and smart money trade tracking.
 */
export interface BirdeyeTransaction {
  /** Transaction hash / signature */
  txHash: string;
  /** Block timestamp as Unix time (seconds) */
  blockUnixTime: number;
  /** Trade direction: 'buy' or 'sell' */
  side: 'buy' | 'sell';
  /** Trader wallet address */
  address: string;
  /** Amount of tokens traded */
  tokenAmount: number;
  /** USD value of the trade */
  usdAmount: number;
  /** Price per token at the time of trade in USD */
  pricePerToken: number;
}

// =============================================================================
// PumpPortal WebSocket Event Types
// =============================================================================

/**
 * Discriminated union of all PumpPortal WebSocket event types.
 * The `type` field on each variant enables type narrowing in event handlers.
 *
 * Usage:
 *   if (event.type === 'newToken') { // event is PumpPortalNewToken }
 *   if (event.type === 'trade')    { // event is PumpPortalTrade }
 *   if (event.type === 'migration') { // event is PumpPortalMigration }
 */
export type PumpPortalEvent =
  | PumpPortalNewToken
  | PumpPortalTrade
  | PumpPortalMigration;

/**
 * New token creation event from PumpPortal's `subscribeNewToken` stream.
 * Fired when a new token is deployed on pump.fun's bonding curve.
 * Only ~0.4–1.8% of pump.fun tokens graduate to DEXes.
 */
export interface PumpPortalNewToken {
  /** Discriminant — always 'newToken' for new token creation events */
  type: 'newToken';
  /** Token mint address (Solana base58 public key) */
  mint: string;
  /** Token name from on-chain metadata */
  name: string;
  /** Token ticker symbol */
  symbol: string;
  /** Metadata URI (typically pointing to Arweave/IPFS JSON) */
  uri: string;
  /** Creator/deployer wallet address */
  traderPublicKey: string;
  /** Initial buy amount in SOL by the creator */
  initialBuy: number;
  /** Bonding curve program account address */
  bondingCurveKey: string;
  /** Virtual token reserve in the bonding curve */
  vTokensInBondingCurve: number;
  /** Virtual SOL reserve in the bonding curve */
  vSolInBondingCurve: number;
  /** Market capitalization denominated in SOL */
  marketCapSol: number;
  /** Token creation Unix timestamp (milliseconds) */
  timestamp: number;
}

/**
 * Trade event from PumpPortal's `subscribeTokenTrade` stream.
 * Captures buy/sell activity on pump.fun's bonding curve for specific tokens.
 */
export interface PumpPortalTrade {
  /** Discriminant — always 'trade' for trade events */
  type: 'trade';
  /** Transaction signature (Solana base58 encoded) */
  signature: string;
  /** Token mint address being traded */
  mint: string;
  /** Trader wallet address */
  traderPublicKey: string;
  /** Trade direction: 'buy' or 'sell' */
  txType: 'buy' | 'sell';
  /** Amount of tokens bought or sold */
  tokenAmount: number;
  /** Amount of SOL spent or received */
  solAmount: number;
  /** Trader's token balance after this trade */
  newTokenBalance: number;
  /** Bonding curve program account address */
  bondingCurveKey: string;
  /** Updated virtual token reserve after trade */
  vTokensInBondingCurve: number;
  /** Updated virtual SOL reserve after trade */
  vSolInBondingCurve: number;
  /** Updated market cap in SOL after trade */
  marketCapSol: number;
  /** Trade Unix timestamp (milliseconds) */
  timestamp: number;
}

/**
 * Token migration event from PumpPortal's `subscribeMigration` stream.
 * Fired when a pump.fun token graduates from the bonding curve to a DEX
 * (e.g., Raydium). This is a significant signal — only graduated tokens
 * have real liquidity pools.
 */
export interface PumpPortalMigration {
  /** Discriminant — always 'migration' for graduation events */
  type: 'migration';
  /** Token mint address that graduated */
  mint: string;
  /** New DEX liquidity pool address (e.g., Raydium AMM pool) */
  pool: string;
  /** Migration Unix timestamp (milliseconds) */
  timestamp: number;
}

// =============================================================================
// Jupiter API Types
// =============================================================================

/**
 * Token price data from Jupiter's Price API v3.
 * Used for quick price lookups and cross-referencing with Birdeye data.
 */
export interface JupiterPrice {
  /** Token mint address (acts as the unique identifier) */
  id: string;
  /** Token ticker symbol */
  mintSymbol: string;
  /** Quote token mint address (typically wrapped SOL) */
  vsToken: string;
  /** Quote token symbol (typically "SOL") */
  vsTokenSymbol: string;
  /** Price denominated in the quote token */
  price: number;
  /** Time taken for price calculation in milliseconds (optional) */
  timeTaken?: number;
}

/**
 * Swap quote from Jupiter's Quote API.
 * Critical for honeypot detection — a valid TOKEN→SOL quote proves
 * the token is sellable. Failed quotes indicate potential honeypots.
 *
 * Note: Amount fields are strings (lamports) for precision with large numbers.
 */
export interface JupiterQuote {
  /** Input token mint address */
  inputMint: string;
  /** Input amount in smallest units (lamports/raw token units) as string */
  inAmount: string;
  /** Output token mint address */
  outputMint: string;
  /** Expected output amount in smallest units as string */
  outAmount: string;
  /** Minimum output amount after slippage tolerance as string */
  otherAmountThreshold: string;
  /** Swap mode: ExactIn (known input) or ExactOut (known output) */
  swapMode: 'ExactIn' | 'ExactOut';
  /** Slippage tolerance in basis points (e.g., 50 = 0.5%) */
  slippageBps: number;
  /** Price impact as a percentage string (e.g., "0.12" = 0.12%) */
  priceImpactPct: string;
  /** Ordered list of swap route steps through different DEX pools */
  routePlan: JupiterRoutePlan[];
  /** Solana slot number when the quote was computed (optional) */
  contextSlot?: number;
  /** Time taken for quote computation in milliseconds (optional) */
  timeTaken?: number;
}

/**
 * Individual step in a Jupiter swap route.
 * Jupiter may split a swap across multiple DEXes for better pricing.
 */
export interface JupiterRoutePlan {
  /** Detailed swap information for this route step */
  swapInfo: {
    /** AMM/pool account key */
    ammKey: string;
    /** DEX name (e.g., "Raydium", "Orca", "Meteora") */
    label: string;
    /** Input token mint for this step */
    inputMint: string;
    /** Output token mint for this step */
    outputMint: string;
    /** Input amount for this step in smallest units */
    inAmount: string;
    /** Output amount for this step in smallest units */
    outAmount: string;
    /** Fee charged by this DEX in smallest units */
    feeAmount: string;
    /** Mint of the token used for fee payment */
    feeMint: string;
  };
  /** Percentage of total swap amount routed through this step (0–100) */
  percent: number;
}

// =============================================================================
// Helius Enhanced Transaction Types
// =============================================================================

/**
 * Parsed transaction from Helius Enhanced Transactions API.
 * Provides rich, human-readable transaction data with program-aware parsing
 * for Raydium, Jupiter, and Pump.fun interactions.
 */
export interface HeliusParsedTx {
  /** Transaction signature (Solana base58 encoded) */
  signature: string;
  /** Solana slot number where the transaction was confirmed */
  slot: number;
  /** Block timestamp as Unix time (seconds) */
  timestamp: number;
  /** Transaction type (e.g., "SWAP", "TRANSFER", "TOKEN_MINT") */
  type: string;
  /** Source program identifier (e.g., "JUPITER", "RAYDIUM", "PUMP_FUN") */
  source: string;
  /** Transaction fee in lamports */
  fee: number;
  /** Wallet address that paid the transaction fee */
  feePayer: string;
  /** Human-readable description of what the transaction did */
  description: string;
  /** SOL transfer records within this transaction */
  nativeTransfers: HeliusNativeTransfer[];
  /** SPL token transfer records within this transaction */
  tokenTransfers: HeliusTokenTransfer[];
  /** Account balance change data for all involved accounts */
  accountData: HeliusAccountData[];
  /** Additional parsed event data (DEX-specific events, etc.) */
  events?: Record<string, unknown>;
}

/**
 * Native SOL transfer within a Helius parsed transaction.
 * Tracks SOL movement between wallets.
 */
export interface HeliusNativeTransfer {
  /** Sender wallet address */
  fromUserAccount: string;
  /** Receiver wallet address */
  toUserAccount: string;
  /** Transfer amount in lamports (1 SOL = 1,000,000,000 lamports) */
  amount: number;
}

/**
 * SPL token transfer within a Helius parsed transaction.
 * Tracks token movement between wallets — critical for smart money tracking.
 */
export interface HeliusTokenTransfer {
  /** Sender wallet address (owner, not token account) */
  fromUserAccount: string;
  /** Receiver wallet address (owner, not token account) */
  toUserAccount: string;
  /** Sender's associated token account address */
  fromTokenAccount: string;
  /** Receiver's associated token account address */
  toTokenAccount: string;
  /** Amount of tokens transferred (human-readable, decimal-adjusted) */
  tokenAmount: number;
  /** Token mint address identifying which token was transferred */
  mint: string;
  /** Token standard (e.g., "Fungible", "NonFungible", "FungibleAsset") */
  tokenStandard: string;
}

/**
 * Account balance change data within a Helius parsed transaction.
 * Shows how account balances changed as a result of the transaction.
 */
export interface HeliusAccountData {
  /** Account address */
  account: string;
  /** Change in SOL balance (lamports, can be negative for debits) */
  nativeBalanceChange: number;
  /** Changes in SPL token balances for this account */
  tokenBalanceChanges: {
    /** Token mint address */
    mint: string;
    /** Raw token amount change with decimal metadata */
    rawTokenAmount: {
      /** String representation of the token amount for precision */
      tokenAmount: string;
      /** Token decimal places */
      decimals: number;
    };
    /** Owner wallet address of the token account */
    userAccount: string;
  }[];
}

// =============================================================================
// RugCheck API Types
// =============================================================================

/**
 * Comprehensive token safety report from RugCheck API.
 * Central data structure for the safety scoring factor.
 *
 * Scoring reference (per AAP):
 *  - score ≥ 300: Considered safe for the safety-score factor
 *  - Active mint/freeze authority: Major red flag
 *  - No LP lock/burn: Hard filter fail
 *  - Token-2022 with PermanentDelegate: Novel rug vector
 */
export interface RugCheckReport {
  /** Token mint address */
  mint: string;
  /** Safety score — higher is safer (≥300 threshold per AAP) */
  score: number;
  /** List of identified risk factors with severity levels */
  risks: RugCheckRisk[];
  /** Mint authority address (null = revoked, which is safe) */
  mintAuthority: string | null;
  /** Freeze authority address (null = revoked, which is safe) */
  freezeAuthority: string | null;
  /** Whether the token supply can be increased (active mint authority) */
  isMintable: boolean;
  /** Whether token accounts can be frozen (active freeze authority) */
  isFreezable: boolean;
  /** Top holder addresses with balance and insider status */
  topHolders: RugCheckHolder[];
  /** Whether liquidity pool tokens are locked in a vesting contract */
  lpLocked: boolean;
  /** Whether liquidity pool tokens are sent to a burn address */
  lpBurned: boolean;
  /** Percentage of LP tokens that are burned (0–100) */
  lpBurnPercentage: number;
  /** Whether the token uses Solana Token-2022 program extensions */
  isToken2022: boolean;
  /** Trading markets/pools where this token is listed */
  markets: RugCheckMarket[];
  /** Total liquidity across all markets in USD */
  totalMarketLiquidity: number;
  /** Token creation timestamp as ISO 8601 string (optional) */
  createdAt?: string;
}

/**
 * Individual risk factor identified by RugCheck.
 * Each risk has a severity level and score impact.
 */
export interface RugCheckRisk {
  /** Risk identifier name (e.g., "Mutable Metadata", "Low Liquidity") */
  name: string;
  /** Human-readable description of the risk */
  description: string;
  /** Severity level from critical (worst) to info (informational) */
  level: 'critical' | 'high' | 'medium' | 'low' | 'info';
  /** Numeric score impact — how much this risk reduces the safety score */
  score: number;
}

/**
 * Token holder entry from RugCheck's holder analysis.
 * Used for top holder concentration checks — top 10 >50% = hard filter fail.
 */
export interface RugCheckHolder {
  /** Holder wallet address */
  address: string;
  /** Raw token amount held */
  amount: number;
  /** Percentage of total supply held (0–100) */
  percentage: number;
  /** Whether RugCheck identifies this holder as an insider/related wallet */
  isInsider: boolean;
}

/**
 * Trading market/pool information from RugCheck.
 * Shows where the token has active liquidity.
 */
export interface RugCheckMarket {
  /** Unique market/pool identifier */
  marketId: string;
  /** DEX or protocol type (e.g., "raydium", "orca", "pump.fun") */
  marketType: string;
  /** Liquidity amount of token A in the pool */
  liquidityA: number;
  /** Liquidity amount of token B in the pool */
  liquidityB: number;
  /** Mint address of token A in the pool */
  liquidityAToken: string;
  /** Mint address of token B in the pool */
  liquidityBToken: string;
}

// =============================================================================
// GoPlus Security API Types
// =============================================================================

/**
 * Token security analysis result from GoPlus Security API.
 *
 * IMPORTANT: The raw GoPlus API returns '0'/'1' string booleans.
 * The goplus.ts client MUST parse these into proper booleans before
 * constructing this interface. This interface uses native boolean types.
 *
 * Called concurrently with RugCheck via Promise.allSettled per AAP.
 */
export interface GoPlusResult {
  /** Token contract/mint address */
  tokenAddress: string;
  /** Whether new tokens can be minted (parsed from GoPlus '0'/'1' strings) */
  isMintable: boolean;
  /** Whether token accounts can be frozen (parsed from GoPlus '0'/'1' strings) */
  isFreezable: boolean;
  /** Whether the contract source code is verified/open-source */
  isOpenSource: boolean;
  /** Number of unique token holders */
  holderCount: number;
  /** Total token supply as a string for large number precision */
  totalSupply: string;
  /** Top holder list with balance and classification data */
  topHolders: GoPlusHolder[];
  /** Liquidity pool token holders with lock status */
  lpHolders: GoPlusLPHolder[];
  /** Total LP token supply as a string */
  lpTotalSupply: string;
  /** Whether LP tokens are locked in a vesting/lock contract */
  isLpLocked: boolean;
  /** Token creator/deployer wallet address */
  creatorAddress: string;
  /** Current authority/owner wallet address */
  ownerAddress: string;
  /** Computed: sum of top 10 holder percentages (>50% = hard filter fail) */
  top10HolderPercent: number;
  /** Computed: largest single holder's percentage of total supply */
  largestHolderPercent: number;
}

/**
 * Individual token holder entry from GoPlus Security API.
 * Note: balance and percent are strings from GoPlus raw responses
 * to preserve precision for large balances.
 */
export interface GoPlusHolder {
  /** Holder wallet address */
  address: string;
  /** Token balance as string (preserves precision for large numbers) */
  balance: string;
  /** Percentage of total supply as string (e.g., "5.23") */
  percent: string;
  /** Whether this holder address is a smart contract */
  isContract: boolean;
  /** Optional label/tag for known addresses (e.g., "DEX Pool", "Team") */
  tag?: string;
}

/**
 * Liquidity pool token holder from GoPlus Security API.
 * Used to determine if LP tokens are locked, burned, or held by
 * suspicious addresses.
 */
export interface GoPlusLPHolder {
  /** LP token holder wallet address */
  address: string;
  /** LP token balance as string */
  balance: string;
  /** Percentage of total LP supply as string (e.g., "98.5") */
  percent: string;
  /** Whether these LP tokens are locked in a vesting contract */
  isLocked: boolean;
  /** Optional label for known addresses (e.g., "Burn Address", "Lock Contract") */
  tag?: string;
}

// =============================================================================
// DexScreener API Types
// =============================================================================

/**
 * Trading pair data from DexScreener API.
 * Used as a FALLBACK data source when Birdeye rate limits are hit.
 * Per AAP Section 0.7.4: "DexScreener must not be used as a primary
 * data source for tokens already covered by Birdeye."
 */
export interface DexScreenerPair {
  /** Blockchain identifier (e.g., "solana") */
  chainId: string;
  /** DEX identifier (e.g., "raydium", "orca", "meteora") */
  dexId: string;
  /** DexScreener web URL for this pair */
  url: string;
  /** DEX liquidity pool/pair address */
  pairAddress: string;
  /** Base token information (the memecoin being traded) */
  baseToken: DexScreenerToken;
  /** Quote token information (typically SOL or USDC) */
  quoteToken: DexScreenerToken;
  /** Price denominated in the quote token as string */
  priceNative: string;
  /** Price in USD as string */
  priceUsd: string;
  /** Transaction counts across multiple timeframes */
  txns: {
    /** 5-minute transaction counts */
    m5: DexScreenerTxns;
    /** 1-hour transaction counts */
    h1: DexScreenerTxns;
    /** 6-hour transaction counts */
    h6: DexScreenerTxns;
    /** 24-hour transaction counts */
    h24: DexScreenerTxns;
  };
  /** Volume in USD across multiple timeframes */
  volume: {
    /** 5-minute volume in USD */
    m5: number;
    /** 1-hour volume in USD */
    h1: number;
    /** 6-hour volume in USD */
    h6: number;
    /** 24-hour volume in USD */
    h24: number;
  };
  /** Price change percentage across multiple timeframes */
  priceChange: {
    /** 5-minute price change (%) */
    m5: number;
    /** 1-hour price change (%) */
    h1: number;
    /** 6-hour price change (%) */
    h6: number;
    /** 24-hour price change (%) */
    h24: number;
  };
  /** Liquidity data for the trading pair */
  liquidity: {
    /** Total liquidity in USD */
    usd: number;
    /** Liquidity of the base token (in token units) */
    base: number;
    /** Liquidity of the quote token (in token units) */
    quote: number;
  };
  /** Fully diluted valuation in USD */
  fdv: number;
  /** Market capitalization in USD */
  marketCap: number;
  /** Pair creation timestamp as Unix time (milliseconds) */
  pairCreatedAt: number;
  /** Optional metadata: image, website links, social links */
  info?: {
    /** Token logo/image URL */
    imageUrl?: string;
    /** Associated website URLs */
    websites?: { url: string }[];
    /** Social media links (type: "twitter", "telegram", etc.) */
    socials?: { type: string; url: string }[];
  };
}

/**
 * Basic token identifier from DexScreener.
 * Used as the baseToken and quoteToken within DexScreenerPair.
 */
export interface DexScreenerToken {
  /** Token mint/contract address */
  address: string;
  /** Full token name */
  name: string;
  /** Token ticker symbol */
  symbol: string;
}

/**
 * Transaction count breakdown from DexScreener.
 * Represents buy and sell transaction counts for a given timeframe.
 */
export interface DexScreenerTxns {
  /** Number of buy transactions in the timeframe */
  buys: number;
  /** Number of sell transactions in the timeframe */
  sells: number;
}

// =============================================================================
// Common / Shared Types
// =============================================================================

/**
 * Generic API response wrapper used by the BaseClient and API clients.
 * Provides a standardized envelope for all API responses with success/error
 * status and a timestamp for cache invalidation.
 *
 * @template T - The type of the response payload data
 */
export interface ApiResponse<T> {
  /** Whether the API call succeeded */
  success: boolean;
  /** Response payload (present when success is true) */
  data: T;
  /** Error message (present when success is false) */
  error?: string;
  /** Unix timestamp (milliseconds) when the response was received */
  timestamp: number;
}
