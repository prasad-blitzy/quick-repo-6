/**
 * src/gmgn/parsers.ts — Response-to-Model Transformers for GMGN API Data
 *
 * Transforms raw JSON data intercepted from GMGN's internal API responses
 * (via `interceptor.ts`) into strongly-typed domain objects defined in `types.ts`.
 *
 * Data Flow:
 *   interceptor.ts captures raw JSON
 *   → content.ts forwards to background.ts
 *   → background.ts calls parsers.ts to transform raw data
 *   → scoring-engine.ts consumes typed data
 *
 * Consumers:
 * - `entrypoints/background.ts` — calls parsers to transform intercepted GMGN data
 * - `src/signals/scoring-engine.ts` — receives the parsed, typed output
 * - `src/store/token-store.ts` — receives parsed token data for state management
 *
 * Design principles:
 * - Defensive parsing: every field access handles null, undefined, and wrong types
 * - Never throws exceptions: returns default values (empty array, null) on errors
 * - Normalizes field names: GMGN uses snake_case/camelCase/abbreviated naming
 * - Type safety: all return types match interfaces in ./types.ts
 *
 * @module src/gmgn/parsers
 */

import type {
  GmgnTrendingToken,
  GmgnTokenDetail,
  GmgnWalletActivity,
  GmgnSmartMoneySignal,
  GmgnParsedResponse,
} from './types';
import { createLogger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Logger Instance
// ---------------------------------------------------------------------------

/**
 * Module-scoped structured logger with 'gmgn-parsers' context tag.
 * Uses warn level for parse failures, debug level for missing optional data.
 */
const logger = createLogger('gmgn-parsers');

// ---------------------------------------------------------------------------
// Safe Value Extraction Helpers (Internal)
// ---------------------------------------------------------------------------

/**
 * Safely converts an unknown value to a number with a fallback default.
 *
 * Handles:
 * - null / undefined → fallback
 * - Number values → direct pass-through
 * - String numbers (e.g., "1234.56") → Number conversion
 * - NaN results → fallback
 * - All other types → fallback
 *
 * @param value - The unknown value to convert
 * @param fallback - Default value if conversion fails (defaults to 0)
 * @returns A valid number, or the fallback
 */
function safeNumber(value: unknown, fallback: number = 0): number {
  if (value === null || value === undefined) return fallback;
  const num = Number(value);
  return isNaN(num) ? fallback : num;
}

/**
 * Safely converts an unknown value to a string with a fallback default.
 *
 * Handles:
 * - null / undefined → fallback
 * - Primitives → String() conversion
 * - Objects → fallback (avoids "[object Object]")
 *
 * @param value - The unknown value to convert
 * @param fallback - Default value if conversion fails (defaults to '')
 * @returns A valid string, or the fallback
 */
function safeString(value: unknown, fallback: string = ''): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return fallback;
  return String(value);
}

/**
 * Safely converts an unknown value to a boolean with a fallback default.
 *
 * Handles:
 * - null / undefined → fallback
 * - Boolean values → direct pass-through
 * - String "true"/"1" → true, all others → false
 * - Number 0 → false, non-zero → true
 * - All other types → fallback
 *
 * @param value - The unknown value to convert
 * @param fallback - Default value if conversion fails (defaults to false)
 * @returns A valid boolean, or the fallback
 */
function safeBoolean(value: unknown, fallback: boolean = false): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1';
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

/**
 * Safely extracts an array from an unknown value with a fallback default.
 *
 * @param value - The unknown value to validate as an array
 * @param fallback - Default array if the value is not an array (defaults to [])
 * @returns The value if it's an array, otherwise the fallback
 */
function safeArray<T>(value: unknown, fallback: T[] = []): T[] {
  return Array.isArray(value) ? value : fallback;
}

/**
 * Normalizes a wallet activity action string to one of the valid union members.
 *
 * GMGN's API may return various action labels. This function normalizes them
 * to the typed union: 'buy' | 'sell' | 'transfer'.
 *
 * @param raw - The raw action string from the API
 * @returns Normalized action type
 */
function normalizeAction(raw: string): 'buy' | 'sell' | 'transfer' {
  const lower = raw.toLowerCase().trim();
  if (lower === 'buy' || lower === 'bought' || lower === 'swap_buy' || lower === 'add') {
    return 'buy';
  }
  if (lower === 'sell' || lower === 'sold' || lower === 'swap_sell' || lower === 'remove') {
    return 'sell';
  }
  return 'transfer';
}

/**
 * Normalizes a smart money action string to one of the valid union members.
 *
 * @param raw - The raw action string from the API
 * @returns Normalized action type for smart money signals (buy or sell only)
 */
function normalizeSmartMoneyAction(raw: string): 'buy' | 'sell' {
  const lower = raw.toLowerCase().trim();
  if (lower === 'sell' || lower === 'sold' || lower === 'swap_sell' || lower === 'remove') {
    return 'sell';
  }
  return 'buy';
}

/**
 * Normalizes a wallet type string to one of the valid GmgnWalletType union members.
 *
 * Handles GMGN's various classification labels and maps them to the canonical
 * wallet type values: 'smart_money', 'kol', 'whale', 'sniper', 'insider',
 * 'developer', 'unknown'.
 *
 * @param raw - The raw wallet type string from the API
 * @returns Normalized wallet type
 */
function normalizeWalletType(
  raw: string,
): 'smart_money' | 'kol' | 'whale' | 'sniper' | 'insider' | 'developer' | 'unknown' {
  const lower = raw.toLowerCase().trim();
  const validTypes = ['smart_money', 'kol', 'whale', 'sniper', 'insider', 'developer'] as const;
  for (const validType of validTypes) {
    if (lower === validType || lower === validType.replace('_', '')) {
      return validType;
    }
  }
  // Handle aliases
  if (lower === 'smart' || lower === 'smartmoney' || lower === 'smart money') {
    return 'smart_money';
  }
  if (lower === 'dev' || lower === 'deployer' || lower === 'creator') {
    return 'developer';
  }
  if (lower === 'influencer' || lower === 'key_opinion_leader') {
    return 'kol';
  }
  if (lower === 'large_holder' || lower === 'big_player') {
    return 'whale';
  }
  if (lower === 'first_buyer' || lower === 'first_block') {
    return 'sniper';
  }
  if (lower === 'team' || lower === 'connected') {
    return 'insider';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Parser: Trending Tokens
// ---------------------------------------------------------------------------

/**
 * Parses GMGN's trending/rank endpoint response into typed GmgnTrendingToken objects.
 *
 * Source endpoint: `/defi/quotation/v1/rank/{chain}/swaps/{timeframe}`
 *
 * GMGN returns trending tokens in a response structure like:
 * ```json
 * { "code": 0, "data": { "rank": [ { "address": "...", "symbol": "...", ... } ] } }
 * ```
 *
 * The response structure may also use `data.data` or `data.tokens` arrays
 * depending on the exact GMGN endpoint version.
 *
 * @param raw - Raw JSON response from the intercepted GMGN API call
 * @returns Array of parsed GmgnTrendingToken objects; empty array on error
 */
export function parseTrendingTokens(raw: unknown): GmgnTrendingToken[] {
  try {
    if (raw === null || raw === undefined || typeof raw !== 'object') {
      logger.debug('parseTrendingTokens received non-object input');
      return [];
    }

    const response = raw as Record<string, unknown>;
    const dataObj = response.data as Record<string, unknown> | undefined;

    // GMGN may use different array field names depending on the endpoint version
    const rank = safeArray(
      dataObj?.rank ?? dataObj?.data ?? dataObj?.tokens ?? dataObj?.items ?? response.rank,
    );

    if (rank.length === 0) {
      logger.debug('No trending token data found in response');
      return [];
    }

    const tokens: GmgnTrendingToken[] = [];

    for (let i = 0; i < rank.length; i++) {
      const item = rank[i] as Record<string, unknown> | null | undefined;
      if (!item || typeof item !== 'object') {
        continue;
      }

      const address = safeString(item.address ?? item.mint ?? item.token_address);
      if (address.length === 0) {
        // Skip entries without an address — they're malformed
        continue;
      }

      tokens.push({
        address,
        symbol: safeString(item.symbol ?? item.ticker),
        name: safeString(item.name ?? item.token_name),
        price: safeNumber(item.price ?? item.current_price),
        priceChange1h: safeNumber(item.price_change_1h ?? item.priceChange1h ?? item.price_change_percent_1h),
        priceChange24h: safeNumber(item.price_change_24h ?? item.priceChange24h ?? item.price_change_percent_24h),
        volume24h: safeNumber(item.volume_24h ?? item.volume24h ?? item.v24hUSD),
        volume1h: safeNumber(item.volume_1h ?? item.volume1h ?? item.v1hUSD),
        swaps24h: safeNumber(item.swaps_24h ?? item.swaps24h ?? item.swap_count_24h),
        swaps1h: safeNumber(item.swaps_1h ?? item.swaps1h ?? item.swap_count_1h),
        marketCap: safeNumber(item.market_cap ?? item.marketCap ?? item.mc),
        liquidity: safeNumber(item.liquidity ?? item.liq ?? item.total_liquidity),
        holderCount: safeNumber(item.holder_count ?? item.holderCount ?? item.holders),
        logoUrl: safeString(item.logo ?? item.logo_url ?? item.logoUrl ?? item.image_url),
        createdAt: safeNumber(item.created_at ?? item.createdAt ?? item.creation_timestamp ?? item.open_timestamp),
      });
    }

    logger.debug(`Parsed ${tokens.length} trending tokens from ${rank.length} raw entries`);
    return tokens;
  } catch (err) {
    logger.warn('Failed to parse trending tokens', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Parser: Token Detail
// ---------------------------------------------------------------------------

/**
 * Parses GMGN's token detail endpoint response into a typed GmgnTokenDetail object.
 *
 * Source endpoint: `/api/v1/token/{address}`
 *
 * This is the MOST CRITICAL parser — its output feeds directly into the 7-factor
 * signal scoring engine. Every field maps to one or more scoring factors:
 *
 * - volume5m, volume1h, volume24h → volume-spike.ts
 * - smartMoneyCount → smart-money-convergence.ts
 * - buys1h, sells1h, buys24h, sells24h → buy-sell-ratio.ts
 * - holderCount → holder-growth.ts
 * - liquidity → liquidity.ts
 * - createdAt → token-age.ts
 * - rugProbability, isHoneypot, mintAuthorityActive, freezeAuthorityActive,
 *   topHolderPercent, lpBurned → safety-score.ts
 *
 * @param raw - Raw JSON response from the intercepted GMGN API call
 * @returns Parsed GmgnTokenDetail object, or null if parsing fails or critical data is missing
 */
export function parseTokenDetail(raw: unknown): GmgnTokenDetail | null {
  try {
    if (raw === null || raw === undefined || typeof raw !== 'object') {
      logger.debug('parseTokenDetail received non-object input');
      return null;
    }

    const response = raw as Record<string, unknown>;

    // GMGN wraps token data in various structures — try common patterns
    const data = (
      response.data ??
      response.token ??
      (response as Record<string, unknown>)
    ) as Record<string, unknown>;

    if (!data || typeof data !== 'object') {
      logger.debug('Token detail missing data wrapper');
      return null;
    }

    // Extract the address — this is the critical field
    const address = safeString(data.address ?? data.mint ?? data.token_address);
    if (address.length === 0) {
      logger.debug('Token detail missing address field');
      return null;
    }

    return {
      // Identity
      address,
      symbol: safeString(data.symbol ?? data.ticker),
      name: safeString(data.name ?? data.token_name),

      // Price data
      price: safeNumber(data.price ?? data.current_price),
      priceChange5m: safeNumber(data.price_change_5m ?? data.priceChange5m ?? data.price_change_percent_5m),
      priceChange1h: safeNumber(data.price_change_1h ?? data.priceChange1h ?? data.price_change_percent_1h),
      priceChange24h: safeNumber(data.price_change_24h ?? data.priceChange24h ?? data.price_change_percent_24h),

      // Market data
      marketCap: safeNumber(data.market_cap ?? data.marketCap ?? data.mc),
      volume24h: safeNumber(data.volume_24h ?? data.volume24h ?? data.v24hUSD),
      volume1h: safeNumber(data.volume_1h ?? data.volume1h ?? data.v1hUSD),
      volume5m: safeNumber(data.volume_5m ?? data.volume5m ?? data.v5mUSD),
      liquidity: safeNumber(data.liquidity ?? data.liq ?? data.total_liquidity),

      // Holder data
      holderCount: safeNumber(data.holder_count ?? data.holderCount ?? data.holders),
      smartMoneyCount: safeNumber(data.smart_money ?? data.smartMoney ?? data.smart_money_count ?? data.smartMoneyCount),

      // Trading activity
      buys24h: safeNumber(data.buys_24h ?? data.buys24h ?? data.buy_24h ?? data.buy_count_24h),
      sells24h: safeNumber(data.sells_24h ?? data.sells24h ?? data.sell_24h ?? data.sell_count_24h),
      buys1h: safeNumber(data.buys_1h ?? data.buys1h ?? data.buy_1h ?? data.buy_count_1h),
      sells1h: safeNumber(data.sells_1h ?? data.sells1h ?? data.sell_1h ?? data.sell_count_1h),

      // Dev/creator wallet
      devWalletAddress: safeString(data.creator ?? data.dev_wallet ?? data.devWallet ?? data.dev_address ?? data.deployer),
      devWalletSold: safeBoolean(data.is_dev_sold ?? data.dev_sold ?? data.devSold ?? data.devWalletSold),

      // Safety indicators
      rugProbability: safeNumber(data.rug_probability ?? data.rugProbability ?? data.rug_prob ?? data.rug_score),
      isHoneypot: safeBoolean(data.is_honeypot ?? data.isHoneypot ?? data.honeypot),
      mintAuthorityActive: safeBoolean(data.mint_authority ?? data.mintAuthority ?? data.mintAuthorityActive ?? data.is_mint_authority),
      freezeAuthorityActive: safeBoolean(data.freeze_authority ?? data.freezeAuthority ?? data.freezeAuthorityActive ?? data.is_freeze_authority),
      topHolderPercent: safeNumber(data.top_holder_percent ?? data.topHolderPercent ?? data.top10_holder_rate ?? data.top_holders_pct),
      lpBurned: safeBoolean(data.lp_burned ?? data.lpBurned ?? data.is_lp_burned ?? data.lp_burn),

      // Metadata
      createdAt: safeNumber(data.created_at ?? data.createdAt ?? data.creation_timestamp ?? data.open_timestamp),
      logoUrl: safeString(data.logo ?? data.logo_url ?? data.logoUrl ?? data.image_url),
      supply: safeNumber(data.total_supply ?? data.supply ?? data.totalSupply ?? data.token_supply),
    };
  } catch (err) {
    logger.warn('Failed to parse token detail', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parser: Wallet Activity
// ---------------------------------------------------------------------------

/**
 * Parses GMGN's wallet activity endpoint response into typed GmgnWalletActivity objects.
 *
 * Source endpoint: `/api/v1/wallet_activity/{address}`
 *
 * GMGN returns wallet activity in a response structure like:
 * ```json
 * { "code": 0, "data": [ { "wallet_address": "...", "token_address": "...", ... } ] }
 * ```
 *
 * Or as `{ "data": { "activities": [...] } }` in some endpoint versions.
 *
 * The `action` field is normalized to one of: 'buy', 'sell', 'transfer'.
 *
 * @param raw - Raw JSON response from the intercepted GMGN API call
 * @returns Array of parsed GmgnWalletActivity objects; empty array on error
 */
export function parseWalletActivity(raw: unknown): GmgnWalletActivity[] {
  try {
    if (raw === null || raw === undefined || typeof raw !== 'object') {
      logger.debug('parseWalletActivity received non-object input');
      return [];
    }

    const response = raw as Record<string, unknown>;

    // GMGN may nest the array in different structures
    const dataField = response.data;
    let items: unknown[];
    if (Array.isArray(dataField)) {
      items = dataField;
    } else if (dataField && typeof dataField === 'object') {
      const nested = dataField as Record<string, unknown>;
      items = safeArray(nested.activities ?? nested.items ?? nested.data ?? nested.list);
    } else {
      items = safeArray(response.activities ?? response.items);
    }

    if (items.length === 0) {
      logger.debug('No wallet activity data found in response');
      return [];
    }

    const activities: GmgnWalletActivity[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i] as Record<string, unknown> | null | undefined;
      if (!item || typeof item !== 'object') {
        continue;
      }

      const walletAddress = safeString(item.wallet_address ?? item.walletAddress ?? item.address ?? item.wallet);
      const tokenAddress = safeString(item.token_address ?? item.tokenAddress ?? item.token ?? item.mint);

      // Both wallet and token addresses are required
      if (walletAddress.length === 0 || tokenAddress.length === 0) {
        continue;
      }

      const rawAction = safeString(item.action ?? item.type ?? item.event_type ?? item.event);

      activities.push({
        walletAddress,
        tokenAddress,
        action: normalizeAction(rawAction),
        amount: safeNumber(item.amount ?? item.token_amount ?? item.quantity),
        amountUsd: safeNumber(item.amount_usd ?? item.usd_amount ?? item.usdAmount ?? item.value_usd),
        price: safeNumber(item.price ?? item.token_price ?? item.unit_price),
        timestamp: safeNumber(item.timestamp ?? item.block_time ?? item.blockTime ?? item.time),
        txHash: safeString(item.tx_hash ?? item.txHash ?? item.signature ?? item.transaction_hash),
        tokenSymbol: safeString(item.token_symbol ?? item.symbol ?? item.tokenSymbol),
      });
    }

    logger.debug(`Parsed ${activities.length} wallet activities from ${items.length} raw entries`);
    return activities;
  } catch (err) {
    logger.warn('Failed to parse wallet activity', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Parser: Smart Money Signals
// ---------------------------------------------------------------------------

/**
 * Parses GMGN's smart money endpoint response into typed GmgnSmartMoneySignal objects.
 *
 * Source endpoint: `/api/v1/smartmoney/{address}`
 *
 * GMGN classifies wallets into categories (per AAP Section 0.8.4):
 * - Smart Money: 70%+ historical win rate
 * - KOL: Key Opinion Leader / influencer
 * - Whale: Large position holder
 * - Sniper: First-block buyer
 * - Insider: Connected to project team
 * - Developer: Token creator/deployer
 *
 * The `walletType` field is normalized to one of these canonical types.
 * The `action` field is normalized to 'buy' or 'sell'.
 *
 * @param raw - Raw JSON response from the intercepted GMGN API call
 * @returns Array of parsed GmgnSmartMoneySignal objects; empty array on error
 */
export function parseSmartMoneySignals(raw: unknown): GmgnSmartMoneySignal[] {
  try {
    if (raw === null || raw === undefined || typeof raw !== 'object') {
      logger.debug('parseSmartMoneySignals received non-object input');
      return [];
    }

    const response = raw as Record<string, unknown>;

    // GMGN may nest the array in different structures
    const dataField = response.data;
    let items: unknown[];
    if (Array.isArray(dataField)) {
      items = dataField;
    } else if (dataField && typeof dataField === 'object') {
      const nested = dataField as Record<string, unknown>;
      items = safeArray(nested.smart_money ?? nested.items ?? nested.data ?? nested.signals);
    } else {
      items = safeArray(response.smart_money ?? response.items);
    }

    if (items.length === 0) {
      logger.debug('No smart money signal data found in response');
      return [];
    }

    const signals: GmgnSmartMoneySignal[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i] as Record<string, unknown> | null | undefined;
      if (!item || typeof item !== 'object') {
        continue;
      }

      const walletAddress = safeString(item.wallet_address ?? item.walletAddress ?? item.address ?? item.wallet);

      // Wallet address is required
      if (walletAddress.length === 0) {
        continue;
      }

      const rawAction = safeString(item.action ?? item.event ?? item.type ?? item.event_type);
      const rawWalletType = safeString(item.wallet_type ?? item.type ?? item.classification ?? item.walletType ?? item.category);

      signals.push({
        walletAddress,
        walletTag: safeString(item.wallet_tag ?? item.tag ?? item.label ?? item.walletTag ?? item.name),
        walletType: normalizeWalletType(rawWalletType),
        winRate: safeNumber(item.win_rate ?? item.winRate ?? item.win_ratio),
        pnl: safeNumber(item.pnl ?? item.total_pnl ?? item.totalPnl ?? item.profit),
        avgHoldTime: safeNumber(item.avg_hold_time ?? item.avgHoldTime ?? item.average_hold_time),
        tokenAddress: safeString(item.token_address ?? item.tokenAddress ?? item.token ?? item.mint),
        action: normalizeSmartMoneyAction(rawAction),
        amount: safeNumber(item.amount ?? item.token_amount ?? item.quantity),
        amountUsd: safeNumber(item.amount_usd ?? item.usdAmount ?? item.value_usd ?? item.usd_amount),
        timestamp: safeNumber(item.timestamp ?? item.block_time ?? item.blockTime ?? item.time),
        txHash: safeString(item.tx_hash ?? item.txHash ?? item.signature ?? item.transaction_hash),
      });
    }

    logger.debug(`Parsed ${signals.length} smart money signals from ${items.length} raw entries`);
    return signals;
  } catch (err) {
    logger.warn('Failed to parse smart money signals', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main Dispatcher: parseInterceptedResponse
// ---------------------------------------------------------------------------

/**
 * Routes raw intercepted GMGN API data to the appropriate parser based on
 * the matched URL pattern type.
 *
 * This is the primary interface called by the service worker (`background.ts`)
 * when processing data intercepted by the injected script. The `patternType`
 * parameter comes from `matchesGmgnApi()` in `url-patterns.ts`.
 *
 * Supported pattern types:
 * - `'trending_tokens'` → parseTrendingTokens()
 * - `'token_detail'` → parseTokenDetail()
 * - `'wallet_activity'` → parseWalletActivity()
 * - `'smart_money'` → parseSmartMoneySignals()
 * - `'token_holders'` → reserved for future extension (returns null)
 * - All other types → returns null with debug logging
 *
 * @param patternType - The GMGN API pattern type identifier from url-patterns.ts
 * @param raw - The raw JSON response data intercepted from the GMGN API
 * @returns A GmgnParsedResponse object with the pattern type and parsed data
 */
export function parseInterceptedResponse(patternType: string, raw: unknown): GmgnParsedResponse {
  switch (patternType) {
    case 'trending_tokens':
      return { type: 'trending_tokens', data: parseTrendingTokens(raw) };

    case 'token_detail':
      return { type: 'token_detail', data: parseTokenDetail(raw) };

    case 'wallet_activity':
      return { type: 'wallet_activity', data: parseWalletActivity(raw) };

    case 'smart_money':
      return { type: 'smart_money', data: parseSmartMoneySignals(raw) };

    case 'token_holders':
      // Reserved for future extension — holder data parsing
      logger.debug('token_holders pattern matched but parser not yet implemented');
      return { type: 'token_holders', data: null };

    default:
      logger.debug(`Unknown GMGN API pattern type: ${patternType}`);
      return { type: patternType, data: null };
  }
}
