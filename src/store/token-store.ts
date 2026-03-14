/**
 * src/store/token-store.ts — Zustand Store for Token Data
 *
 * Central token data repository for the GMGN Signal Bot Chrome Extension.
 * Every token the system encounters is stored here with its aggregated data
 * from all sources: GMGN interception, Birdeye API, PumpPortal WebSocket,
 * DexScreener fallback, safety checks (RugCheck + GoPlus), smart money
 * tracking, and AI/LLM analysis results.
 *
 * Per AAP Section 0.5.1 Group 10:
 * "Zustand store for token data; state includes `tokens: Map<string, TokenData>`
 * with price, safety report, metadata, and smart money activity per token;
 * actions: `upsertToken`, `getToken`, `clearStale`"
 *
 * Per AAP Section 0.4.4 (Store ↔ Component Bindings):
 * - Writers (Producers): `gmgn/parsers.ts`, `birdeye.ts`, `pump-portal-stream.ts`
 * - Readers (Consumers): `TokenCard.tsx`, `SafetyBadge.tsx`, `NewTokenFeed.tsx`
 * - Persistence: `chrome.storage.local` via chrome-storage-adapter middleware
 *
 * Implementation notes:
 * - Uses `Record<string, TokenData>` (not `Map`) for JSON serialization
 *   compatibility with chrome.storage.
 * - Enforces a `maxTokens` cap (default 200) to prevent chrome.storage bloat
 *   (5MB limit). When the cap is reached, the oldest token (by `lastUpdated`)
 *   is evicted before inserting a new one.
 * - All state mutations go through the `upsertToken` action, which merges
 *   partial updates and stamps `lastUpdated` on every write.
 * - Source-specific updaters (`updateFromGmgn`, `updateFromBirdeye`, etc.)
 *   provide typed field mapping from each data source's response structure.
 * - Persisted to `chrome.storage.local` via the `createChromeStorageMiddleware`
 *   adapter, enabling cross-context sync between service worker and content
 *   script via `chrome.storage.onChanged`.
 *
 * @module store/token-store
 */

import { createStore } from 'zustand/vanilla';
import { createChromeStorageMiddleware } from './chrome-storage-adapter';
import type { GmgnTokenDetail } from '../gmgn/types';
import type { BirdeyeTokenData } from '../api/types';
import type { SafetyReport } from '../safety/types';
import type { AIAnalysisResult } from '../ai/types';
import { createLogger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

const logger = createLogger('token-store');

// ---------------------------------------------------------------------------
// TokenData Interface
// ---------------------------------------------------------------------------

/**
 * Comprehensive per-token data structure that aggregates all source data.
 *
 * This is the canonical representation of a token within the extension.
 * Fields are populated incrementally as data arrives from different sources
 * (GMGN interception, Birdeye API, safety checks, AI analysis, etc.).
 *
 * The `mint` field is the primary key (Solana base58 public key).
 */
export interface TokenData {
  /** Token mint address (Solana base58 public key) — primary key */
  mint: string;
  /** Token ticker symbol (e.g., "SOL", "BONK", "WIF") */
  symbol: string;
  /** Full token name (e.g., "Wrapped SOL", "Bonk") */
  name: string;
  /** Token logo image URL (empty string if unavailable) */
  logoUrl: string;

  // === Price & Market Data ===

  /** Current price in USD */
  price: number;
  /** 5-minute price change percentage (e.g., 5.2 means +5.2%) */
  priceChange5m: number;
  /** 1-hour price change percentage */
  priceChange1h: number;
  /** 24-hour price change percentage */
  priceChange24h: number;
  /** Market capitalization in USD */
  marketCap: number;
  /** Total liquidity in USD across all DEX pools */
  liquidity: number;
  /** 5-minute trading volume in USD */
  volume5m: number;
  /** 1-hour trading volume in USD */
  volume1h: number;
  /** 24-hour trading volume in USD */
  volume24h: number;

  // === Holder Data ===

  /** Number of unique token holder wallets */
  holderCount: number;
  /** Top holder concentration percentage (0–100) */
  topHolderPercent: number;

  // === Trading Activity ===

  /** Buy transaction count in the last 1 hour */
  buys1h: number;
  /** Sell transaction count in the last 1 hour */
  sells1h: number;
  /** Buy transaction count in the last 24 hours */
  buys24h: number;
  /** Sell transaction count in the last 24 hours */
  sells24h: number;

  // === Smart Money ===

  /** Number of smart money wallets currently holding this token */
  smartMoneyCount: number;
  /** Smart money wallet addresses that have entered this token */
  smartMoneyWallets: string[];

  // === Safety ===

  /** Aggregated safety report from RugCheck + GoPlus (null if not yet checked) */
  safetyReport: SafetyReport | null;
  /** Whether token passed honeypot simulation (null if not yet checked) */
  isHoneypot: boolean | null;

  // === AI Analysis ===

  /** LLM-generated analysis result (null if not yet analyzed) */
  aiAnalysis: AIAnalysisResult | null;

  // === Dev Wallet ===

  /** Developer/creator wallet address (empty string if unknown) */
  devWalletAddress: string;
  /** Whether the developer has sold their token allocation */
  devWalletSold: boolean;

  // === Metadata ===

  /** Token creation timestamp (Unix seconds, NOT milliseconds) */
  createdAt: number;
  /** Whether LP (Liquidity Pool) tokens have been burned */
  lpBurned: boolean;
  /** Whether mint authority is still active (true = risky) */
  mintAuthorityActive: boolean;
  /** Whether freeze authority is still active (true = risky) */
  freezeAuthorityActive: boolean;

  // === Store Metadata ===

  /** When this entry was last updated (milliseconds since epoch) */
  lastUpdated: number;
  /** Data source that last updated this entry: 'gmgn' | 'birdeye' | 'pump-portal' | 'dexscreener' | 'unknown' */
  lastSource: string;
}

// ---------------------------------------------------------------------------
// TokenStoreState Interface
// ---------------------------------------------------------------------------

/**
 * Token store state — the data portion of the Zustand store.
 *
 * Uses `Record<string, TokenData>` instead of `Map` for JSON serialization
 * compatibility with `chrome.storage`.
 */
export interface TokenStoreState {
  /** Map of token mint address → TokenData */
  tokens: Record<string, TokenData>;
  /** Maximum number of tokens to track simultaneously (default 200) */
  maxTokens: number;
}

// ---------------------------------------------------------------------------
// TokenStoreActions Interface
// ---------------------------------------------------------------------------

/**
 * Token store actions — the methods available on the Zustand store.
 *
 * All mutations flow through `upsertToken` which handles merging, timestamping,
 * and cap enforcement. Source-specific updaters (`updateFromGmgn`, etc.) provide
 * typed field mapping from each data source's response structure.
 */
export interface TokenStoreActions {
  /** Insert or update token data — merges partial updates into existing data */
  upsertToken: (mint: string, data: Partial<TokenData>) => void;
  /** Get token data by mint address, returns undefined if not found */
  getToken: (mint: string) => TokenData | undefined;
  /** Remove tokens not updated within maxAgeMs (milliseconds) */
  clearStale: (maxAgeMs: number) => void;
  /** Remove a specific token by mint address */
  removeToken: (mint: string) => void;
  /** Get all tracked tokens as an array (sorted by lastUpdated descending) */
  getAllTokens: () => TokenData[];
  /** Update token from intercepted GMGN parsed data */
  updateFromGmgn: (detail: GmgnTokenDetail) => void;
  /** Update token from Birdeye API response */
  updateFromBirdeye: (mint: string, data: BirdeyeTokenData) => void;
  /** Update safety report for a token */
  updateSafetyReport: (mint: string, report: SafetyReport) => void;
  /** Update AI analysis result for a token */
  updateAIAnalysis: (mint: string, analysis: AIAnalysisResult) => void;
}

// ---------------------------------------------------------------------------
// TokenStore Combined Type
// ---------------------------------------------------------------------------

/**
 * Combined token store type — state plus actions.
 * This is the type parameter for the Zustand vanilla store.
 */
export type TokenStore = TokenStoreState & TokenStoreActions;

// ---------------------------------------------------------------------------
// Default Token Data Factory
// ---------------------------------------------------------------------------

/**
 * Creates a default TokenData object with all fields initialized to safe
 * zero/empty/null values.
 *
 * Used when `upsertToken` is called for a token mint that doesn't yet exist
 * in the store — the default data is created first, then the partial update
 * is merged on top.
 *
 * @param mint - Solana token mint address (base58 public key)
 * @returns A fully initialized TokenData with default values
 */
export function createDefaultTokenData(mint: string): TokenData {
  return {
    mint,
    symbol: '',
    name: '',
    logoUrl: '',
    price: 0,
    priceChange5m: 0,
    priceChange1h: 0,
    priceChange24h: 0,
    marketCap: 0,
    liquidity: 0,
    volume5m: 0,
    volume1h: 0,
    volume24h: 0,
    holderCount: 0,
    topHolderPercent: 0,
    buys1h: 0,
    sells1h: 0,
    buys24h: 0,
    sells24h: 0,
    smartMoneyCount: 0,
    smartMoneyWallets: [],
    safetyReport: null,
    isHoneypot: null,
    aiAnalysis: null,
    devWalletAddress: '',
    devWalletSold: false,
    createdAt: 0,
    lpBurned: false,
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    lastUpdated: Date.now(),
    lastSource: 'unknown',
  };
}

// ---------------------------------------------------------------------------
// Internal Helper — Evict Oldest Token
// ---------------------------------------------------------------------------

/**
 * Finds and removes the oldest token (by `lastUpdated` timestamp) from the
 * tokens record when the store exceeds its `maxTokens` capacity.
 *
 * This ensures chrome.storage doesn't grow unbounded (5MB default limit).
 * The eviction strategy is simple LRU-by-update-time: the token that hasn't
 * been updated for the longest time is dropped first.
 *
 * @param tokens - Current tokens record
 * @returns A new tokens record with the oldest entry removed, or the same
 *          record if it's already empty
 */
function evictOldestToken(tokens: Record<string, TokenData>): Record<string, TokenData> {
  const entries = Object.entries(tokens);
  if (entries.length === 0) {
    return tokens;
  }

  let oldestMint: string = entries[0][0];
  let oldestTime: number = entries[0][1].lastUpdated;

  for (let i = 1; i < entries.length; i++) {
    const [mint, token] = entries[i];
    if (token.lastUpdated < oldestTime) {
      oldestMint = mint;
      oldestTime = token.lastUpdated;
    }
  }

  const { [oldestMint]: _evicted, ...remaining } = tokens;
  logger.debug(`Evicted oldest token ${oldestMint} (lastUpdated: ${oldestTime}) to enforce maxTokens cap`);
  return remaining;
}

// ---------------------------------------------------------------------------
// Store Creator Function
// ---------------------------------------------------------------------------

/**
 * Creates a Zustand vanilla store for token data with chrome.storage persistence.
 *
 * The store is designed for use in the Chrome Extension service worker (non-React
 * context) using `zustand/vanilla`. State is automatically persisted to
 * `chrome.storage.local` via the `createChromeStorageMiddleware` and synced
 * across Extension contexts via `chrome.storage.onChanged`.
 *
 * @returns A Zustand `StoreApi<TokenStore>` instance
 *
 * @example
 * ```typescript
 * // In service worker (background.ts):
 * import { createTokenStore } from '../store/token-store';
 *
 * const tokenStore = createTokenStore();
 *
 * // Upsert from intercepted GMGN data:
 * tokenStore.getState().updateFromGmgn(parsedGmgnDetail);
 *
 * // Get a specific token:
 * const tokenData = tokenStore.getState().getToken('DezXAZ...');
 *
 * // Clean up old tokens (older than 1 hour):
 * tokenStore.getState().clearStale(3600000);
 * ```
 */
export function createTokenStore() {
  return createStore<TokenStore>()(
    createChromeStorageMiddleware<TokenStore>(
      'token-store',
      'local',
      (set, get) => ({
        // ---------------------------------------------------------------
        // Initial State
        // ---------------------------------------------------------------

        tokens: {},
        maxTokens: 200,

        // ---------------------------------------------------------------
        // Core Actions
        // ---------------------------------------------------------------

        upsertToken: (mint: string, data: Partial<TokenData>): void => {
          set((state) => {
            const existing = state.tokens[mint];
            const base = existing || createDefaultTokenData(mint);

            // Merge partial update onto existing/default data
            const updated: TokenData = {
              ...base,
              ...data,
              // Always preserve the mint — never allow overwriting the primary key
              mint,
              // Always stamp the update time
              lastUpdated: Date.now(),
            };

            let nextTokens = { ...state.tokens, [mint]: updated };

            // Enforce maxTokens cap — evict oldest if adding a brand-new token
            // that pushes us over the limit
            if (!existing && Object.keys(nextTokens).length > state.maxTokens) {
              nextTokens = evictOldestToken(nextTokens);
              logger.info(`Token count exceeded maxTokens (${state.maxTokens}), evicted oldest entry`);
            }

            return { tokens: nextTokens };
          });
        },

        getToken: (mint: string): TokenData | undefined => {
          return get().tokens[mint];
        },

        clearStale: (maxAgeMs: number): void => {
          const now = Date.now();
          set((state) => {
            const fresh: Record<string, TokenData> = {};
            let removedCount = 0;

            for (const [mint, token] of Object.entries(state.tokens)) {
              if (now - token.lastUpdated < maxAgeMs) {
                fresh[mint] = token;
              } else {
                removedCount++;
              }
            }

            if (removedCount > 0) {
              logger.info(`Cleared ${removedCount} stale token(s) (maxAge: ${maxAgeMs}ms)`);
            } else {
              logger.debug(`No stale tokens found (maxAge: ${maxAgeMs}ms)`);
            }

            return { tokens: fresh };
          });
        },

        removeToken: (mint: string): void => {
          set((state) => {
            if (!(mint in state.tokens)) {
              logger.debug(`removeToken: token ${mint} not found in store`);
              return state;
            }
            const { [mint]: _removed, ...rest } = state.tokens;
            logger.debug(`Removed token ${mint} from store`);
            return { tokens: rest };
          });
        },

        getAllTokens: (): TokenData[] => {
          const tokens = Object.values(get().tokens);
          // Return sorted by lastUpdated descending (most recently updated first)
          return tokens.sort((a, b) => b.lastUpdated - a.lastUpdated);
        },

        // ---------------------------------------------------------------
        // Source-Specific Updaters
        // ---------------------------------------------------------------

        updateFromGmgn: (detail: GmgnTokenDetail): void => {
          get().upsertToken(detail.address, {
            symbol: detail.symbol,
            name: detail.name,
            price: detail.price,
            priceChange5m: detail.priceChange5m,
            priceChange1h: detail.priceChange1h,
            priceChange24h: detail.priceChange24h,
            marketCap: detail.marketCap,
            liquidity: detail.liquidity,
            volume5m: detail.volume5m,
            volume1h: detail.volume1h,
            volume24h: detail.volume24h,
            holderCount: detail.holderCount,
            smartMoneyCount: detail.smartMoneyCount,
            buys1h: detail.buys1h,
            sells1h: detail.sells1h,
            buys24h: detail.buys24h,
            sells24h: detail.sells24h,
            devWalletAddress: detail.devWalletAddress,
            devWalletSold: detail.devWalletSold,
            isHoneypot: detail.isHoneypot,
            mintAuthorityActive: detail.mintAuthorityActive,
            freezeAuthorityActive: detail.freezeAuthorityActive,
            topHolderPercent: detail.topHolderPercent,
            lpBurned: detail.lpBurned,
            createdAt: detail.createdAt,
            logoUrl: detail.logoUrl,
            lastSource: 'gmgn',
          });
        },

        updateFromBirdeye: (mint: string, data: BirdeyeTokenData): void => {
          get().upsertToken(mint, {
            symbol: data.symbol,
            name: data.name,
            price: data.price,
            priceChange24h: data.priceChange24h,
            volume24h: data.volume24h,
            volume1h: data.volume1h,
            volume5m: data.volume5m,
            marketCap: data.marketCap,
            liquidity: data.liquidity,
            holderCount: data.holderCount,
            lastSource: 'birdeye',
          });
        },

        updateSafetyReport: (mint: string, report: SafetyReport): void => {
          get().upsertToken(mint, { safetyReport: report });
        },

        updateAIAnalysis: (mint: string, analysis: AIAnalysisResult): void => {
          get().upsertToken(mint, { aiAnalysis: analysis });
        },
      })
    )
  );
}
