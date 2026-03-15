/**
 * src/api/birdeye.ts — Birdeye REST API Client
 *
 * Production-grade Birdeye REST API client for the GMGN Signal Bot Chrome
 * Extension. Provides typed access to Birdeye's Solana token analytics endpoints
 * including price data, OHLCV candlesticks, transaction history, token overview,
 * and top holder concentration analysis.
 *
 * Architecture:
 *   - All HTTP requests route through BaseClient (retry, timeout, caching)
 *   - Every request acquires a rate-limit token via RateLimiter (15 RPS Starter plan)
 *   - Every request includes `X-API-KEY` header and `chain=solana` query parameter
 *   - Runs EXCLUSIVELY in the service worker context — API key never exposed to content scripts
 *
 * Per AAP Section 0.5.1 Group 4:
 *   "Birdeye REST client; methods: getTokenPrice(mint), getOHLCV(mint, interval),
 *    getTokenTransactions(mint), getTokenOverview(mint), getTopHolders(mint);
 *    all requests include X-API-KEY header and chain=solana parameter"
 *
 * Per AAP Section 0.7.4:
 *   "Per-API rate limiting is mandatory: Every external API client must route
 *    requests through the centralized rate-limiter.ts — Birdeye: 15 RPS"
 *
 * Consumers:
 *   - src/signals/scoring-engine.ts — token data enrichment for composite scoring
 *   - src/store/token-store.ts — token price and metadata updates
 *   - src/signals/factors/volume-spike.ts — OHLCV and volume data
 *   - src/signals/factors/buy-sell-ratio.ts — transaction history analysis
 *   - src/signals/factors/holder-growth.ts — holder count tracking
 *   - src/signals/factors/liquidity.ts — liquidity threshold validation
 *
 * @module api/birdeye
 */

import { BaseClient, ApiError } from './base-client';
import { RateLimiter } from './rate-limiter';
import type {
  BirdeyeTokenData,
  BirdeyeOHLCV,
  BirdeyeTopHolder,
  BirdeyeTransaction,
} from './types';
import { API_BASE_URLS, SOLANA } from '../utils/config';
import { createLogger, type Logger } from '../utils/logger';

// =============================================================================
// Section 1: Internal Birdeye API Response Types
// =============================================================================

/**
 * Generic wrapper for all Birdeye REST API JSON responses.
 * The Birdeye API consistently returns `{ data: T, success: boolean }` on
 * successful responses. The `success` field is checked before parsing `data`.
 */
interface BirdeyeApiResponse<T> {
  data: T;
  success: boolean;
}

/**
 * Generic wrapper for Birdeye list/collection endpoints.
 * Endpoints returning arrays (OHLCV, transactions, holders) nest items
 * under `data.items` with an optional `total` count.
 */
interface BirdeyeListResponse<T> {
  data: {
    items: T[];
    total?: number;
  };
  success: boolean;
}

/**
 * Raw price data from the `/defi/price` endpoint.
 * Contains only price-related fields — less comprehensive than token_overview.
 */
interface BirdeyeRawPrice {
  value: number;
  updateUnixTime: number;
  updateHumanTime: string;
  priceChange24h?: number;
}

/**
 * Raw OHLCV candle data from the `/defi/ohlcv` endpoint.
 * Birdeye may return short-form (o, h, l, c, v) or long-form field names;
 * the parser handles both variants.
 */
interface BirdeyeRawOHLCVItem {
  unixTime?: number;
  time?: number;
  o?: number;
  open?: number;
  h?: number;
  high?: number;
  l?: number;
  low?: number;
  c?: number;
  close?: number;
  v?: number;
  volume?: number;
}

/**
 * Raw transaction record from the `/defi/txs/token` endpoint.
 * Field names vary between Birdeye API versions; the parser normalizes them.
 */
interface BirdeyeRawTxItem {
  txHash?: string;
  blockUnixTime?: number;
  side?: string;
  owner?: string;
  address?: string;
  tokenAmount?: number;
  uiAmount?: number;
  usdAmount?: number;
  tokenPrice?: number;
}

/**
 * Raw holder data from the `/defi/token_holder` endpoint.
 */
interface BirdeyeRawHolderItem {
  address?: string;
  amount?: number;
  percentage?: number;
  uiAmount?: number;
}

/**
 * Raw token overview from the `/defi/token_overview` endpoint.
 * The most comprehensive single-call Birdeye endpoint for token metadata.
 */
interface BirdeyeRawOverview {
  address?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  price?: number;
  priceChange24h?: number;
  volume24h?: number;
  volume1h?: number;
  volume5m?: number;
  marketCap?: number;
  liquidity?: number;
  holderCount?: number;
  supply?: number;
  circulatingSupply?: number;
  lastTradeUnixTime?: number;
  logoURI?: string;
  extensions?: Record<string, unknown>;
}

// =============================================================================
// Section 2: Cache TTL Constants
// =============================================================================

/**
 * Cache time-to-live durations for each Birdeye endpoint.
 * Shorter TTLs for volatile data (price, transactions), longer for slower-changing
 * data (holders, overview). All values in milliseconds.
 */

/** 15-second TTL for price data — prices change rapidly in memecoin markets */
const PRICE_CACHE_TTL_MS = 15_000;

/** 30-second TTL for comprehensive token overview data */
const OVERVIEW_CACHE_TTL_MS = 30_000;

/** 60-second TTL for OHLCV candles — chart data changes at candle boundaries */
const OHLCV_CACHE_TTL_MS = 60_000;

/** 15-second TTL for transaction lists — frequent buy/sell activity */
const TXS_CACHE_TTL_MS = 15_000;

/** 2-minute TTL for holder data — holder distribution changes slowly */
const HOLDERS_CACHE_TTL_MS = 120_000;

// =============================================================================
// Section 3: Default Parameters
// =============================================================================

/** Default number of transactions to retrieve per request */
const DEFAULT_TX_LIMIT = 50;

/** Default number of top holders to retrieve per request */
const DEFAULT_HOLDER_LIMIT = 20;

/** Number of seconds in 24 hours — for default OHLCV time range */
const SECONDS_IN_24H = 86_400;

// =============================================================================
// Section 4: BirdeyeClient Class
// =============================================================================

/**
 * Birdeye REST API client for Solana token analytics.
 *
 * Provides typed methods for all five Birdeye endpoints used by the signal
 * scoring engine. Every method:
 *   1. Acquires a rate-limit token (15 RPS Birdeye Starter plan)
 *   2. Includes `X-API-KEY` header (set on BaseClient construction)
 *   3. Includes `chain=solana` query parameter
 *   4. Parses raw Birdeye responses into typed interfaces from `./types.ts`
 *   5. Handles errors with structured logging and graceful fallbacks
 *
 * @example
 * ```typescript
 * const birdeye = new BirdeyeClient(decryptedApiKey, sharedRateLimiter);
 *
 * // Get comprehensive token data
 * const overview = await birdeye.getTokenOverview('SoMint123...');
 * console.log(overview.price, overview.volume24h, overview.liquidity);
 *
 * // Check holder concentration (hard filter: top 10 > 50% = SKIP)
 * const holders = await birdeye.getTopHolders('SoMint123...');
 * const top10Pct = holders.slice(0, 10).reduce((s, h) => s + h.percentage, 0);
 * ```
 */
export class BirdeyeClient {
  /** BaseClient instance configured with Birdeye base URL and API key header */
  private readonly baseClient: BaseClient;

  /** Shared rate limiter enforcing 15 RPS for Birdeye Starter plan */
  private readonly rateLimiter: RateLimiter;

  /** Structured logger with 'birdeye-api' context tag */
  private readonly logger: Logger;

  /**
   * Creates a new BirdeyeClient instance.
   *
   * @param apiKey - Decrypted Birdeye API key (from encrypted chrome.storage.local).
   *   Must be non-empty. The key is set as the `X-API-KEY` header on all requests
   *   via the BaseClient's defaultHeaders configuration.
   * @param rateLimiter - Optional shared RateLimiter instance. When provided, the
   *   client uses the shared instance for centralized rate limiting across all API
   *   clients. When omitted, a new RateLimiter is created with default config.
   * @throws Error if apiKey is empty or contains only whitespace
   */
  constructor(apiKey: string, rateLimiter?: RateLimiter) {
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        'Birdeye API key is required — configure via the extension settings panel',
      );
    }

    this.baseClient = new BaseClient(API_BASE_URLS.BIRDEYE, {
      defaultHeaders: { 'X-API-KEY': apiKey },
      loggerContext: 'birdeye-http',
    });

    this.rateLimiter = rateLimiter ?? new RateLimiter();
    this.logger = createLogger('birdeye-api');

    this.logger.info('BirdeyeClient initialized successfully');
  }

  // ---------------------------------------------------------------------------
  // Public API Methods
  // ---------------------------------------------------------------------------

  /**
   * Fetches the current price and basic price metrics for a Solana token.
   *
   * Endpoint: `GET /defi/price?address={mint}&chain=solana`
   *
   * Returns a `BirdeyeTokenData` object with price-related fields populated.
   * Non-price fields (volume, marketCap, holderCount, etc.) are set to zero;
   * use `getTokenOverview()` for comprehensive data.
   *
   * On 404 (token not indexed): Returns a default empty BirdeyeTokenData
   * with price=0 — the token may be too new for Birdeye to have indexed it.
   *
   * @param mint - Solana token mint address (base58 public key)
   * @returns Token data with price fields populated
   * @throws {ApiError} On auth failure (401/403), rate limit (429), or server error (5xx)
   */
  async getTokenPrice(mint: string): Promise<BirdeyeTokenData> {
    this.logger.info('Fetching token price', { mint });

    try {
      const response = await this.makeRequest<BirdeyeApiResponse<BirdeyeRawPrice>>(
        '/defi/price',
        { address: mint },
        PRICE_CACHE_TTL_MS,
      );

      if (!response.success || !response.data) {
        this.logger.warn('Birdeye price response unsuccessful', { mint });
        return this.createEmptyTokenData(mint);
      }

      const raw = response.data;

      return {
        address: mint,
        symbol: '',
        name: '',
        decimals: 0,
        price: raw.value ?? 0,
        priceChange24h: raw.priceChange24h ?? 0,
        volume24h: 0,
        volume1h: 0,
        volume5m: 0,
        marketCap: 0,
        liquidity: 0,
        holderCount: 0,
        supply: 0,
        circulatingSupply: 0,
        lastTradeUnixTime: raw.updateUnixTime ?? 0,
      };
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        if (error.errorType === 'not-found') {
          this.logger.debug('Token not indexed in Birdeye price endpoint', { mint });
          return this.createEmptyTokenData(mint);
        }
        this.logApiError(error, '/defi/price', mint);
      }
      throw error;
    }
  }

  /**
   * Fetches OHLCV candlestick data for a Solana token.
   *
   * Endpoint: `GET /defi/ohlcv?address={mint}&type={interval}&time_from={from}&time_to={to}&chain=solana`
   *
   * Used by the volume spike detection factor to compute moving averages
   * and identify 3–8× volume increases over the 5-minute MA.
   *
   * @param mint - Solana token mint address (base58 public key)
   * @param interval - Candle interval: '1m', '5m', '15m', '1H', '4H', '1D'
   * @param timeFrom - Start of time range as Unix timestamp (seconds).
   *   Defaults to 24 hours ago if not specified.
   * @param timeTo - End of time range as Unix timestamp (seconds).
   *   Defaults to current time if not specified.
   * @returns Array of OHLCV candle data, empty array on error or no data
   * @throws {ApiError} On auth failure (401/403) or server error (5xx)
   */
  async getOHLCV(
    mint: string,
    interval: string,
    timeFrom?: number,
    timeTo?: number,
  ): Promise<BirdeyeOHLCV[]> {
    this.logger.info('Fetching OHLCV data', { mint, interval });

    const now = Math.floor(Date.now() / 1000);
    const params: Record<string, string> = {
      address: mint,
      type: interval,
      time_from: String(timeFrom ?? now - SECONDS_IN_24H),
      time_to: String(timeTo ?? now),
    };

    try {
      const response = await this.makeRequest<BirdeyeListResponse<BirdeyeRawOHLCVItem>>(
        '/defi/ohlcv',
        params,
        OHLCV_CACHE_TTL_MS,
      );

      if (!response.success || !response.data?.items) {
        this.logger.warn('No OHLCV data returned from Birdeye', { mint, interval });
        return [];
      }

      return response.data.items.map(this.parseOHLCVItem);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        if (error.errorType === 'not-found') {
          this.logger.debug('Token not found for OHLCV data', { mint });
          return [];
        }
        this.logApiError(error, '/defi/ohlcv', mint);
      }
      throw error;
    }
  }

  /**
   * Fetches recent token transactions for buy/sell ratio analysis.
   *
   * Endpoint: `GET /defi/txs/token?address={mint}&limit={limit}&chain=solana`
   *
   * Used by the buy/sell ratio factor to evaluate accumulation pressure
   * (≥1.3× buy/sell ratio for base signal, ≥2.0× for day-trade amplification).
   *
   * @param mint - Solana token mint address (base58 public key)
   * @param limit - Maximum number of transactions to retrieve (default: 50)
   * @returns Array of typed transaction records, empty array on error or no data
   * @throws {ApiError} On auth failure (401/403) or server error (5xx)
   */
  async getTokenTransactions(
    mint: string,
    limit: number = DEFAULT_TX_LIMIT,
  ): Promise<BirdeyeTransaction[]> {
    this.logger.info('Fetching token transactions', { mint, limit });

    try {
      const response = await this.makeRequest<BirdeyeListResponse<BirdeyeRawTxItem>>(
        '/defi/txs/token',
        { address: mint, limit: String(limit) },
        TXS_CACHE_TTL_MS,
      );

      if (!response.success || !response.data?.items) {
        this.logger.warn('No transaction data returned from Birdeye', { mint });
        return [];
      }

      return response.data.items.map(this.parseTxItem);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        if (error.errorType === 'not-found') {
          this.logger.debug('Token not found for transaction data', { mint });
          return [];
        }
        this.logApiError(error, '/defi/txs/token', mint);
      }
      throw error;
    }
  }

  /**
   * Fetches comprehensive token overview data from Birdeye.
   *
   * Endpoint: `GET /defi/token_overview?address={mint}&chain=solana`
   *
   * This is the richest single-call endpoint — returns price, volume (24h/1h/5m),
   * market cap, liquidity, holder count, supply, and metadata. Used as the primary
   * token data enrichment call by the scoring engine.
   *
   * @param mint - Solana token mint address (base58 public key)
   * @returns Fully populated BirdeyeTokenData, or empty defaults on 404
   * @throws {ApiError} On auth failure (401/403) or server error (5xx)
   */
  async getTokenOverview(mint: string): Promise<BirdeyeTokenData> {
    this.logger.info('Fetching token overview', { mint });

    try {
      const response = await this.makeRequest<BirdeyeApiResponse<BirdeyeRawOverview>>(
        '/defi/token_overview',
        { address: mint },
        OVERVIEW_CACHE_TTL_MS,
      );

      if (!response.success || !response.data) {
        this.logger.warn('Birdeye token overview response unsuccessful', { mint });
        return this.createEmptyTokenData(mint);
      }

      return this.mapOverviewToTokenData(mint, response.data);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        if (error.errorType === 'not-found') {
          this.logger.debug('Token not indexed in Birdeye overview', { mint });
          return this.createEmptyTokenData(mint);
        }
        this.logApiError(error, '/defi/token_overview', mint);
      }
      throw error;
    }
  }

  /**
   * Fetches the top token holders and their concentration percentages.
   *
   * Endpoint: `GET /defi/token_holder?address={mint}&limit={limit}&chain=solana`
   *
   * Critical for the hard filter gate: if the top 10 holders control >50% of
   * total supply, the token is automatically classified as SKIP per AAP Section
   * 0.7.3. Also used by the safety score factor for holder concentration analysis
   * (single holder >20% = penalized).
   *
   * @param mint - Solana token mint address (base58 public key)
   * @param limit - Maximum number of holders to retrieve (default: 20)
   * @returns Array of top holder records with address, amount, and percentage
   * @throws {ApiError} On auth failure (401/403) or server error (5xx)
   */
  async getTopHolders(
    mint: string,
    limit: number = DEFAULT_HOLDER_LIMIT,
  ): Promise<BirdeyeTopHolder[]> {
    this.logger.info('Fetching top holders', { mint, limit });

    try {
      const response = await this.makeRequest<BirdeyeListResponse<BirdeyeRawHolderItem>>(
        '/defi/token_holder',
        { address: mint, limit: String(limit) },
        HOLDERS_CACHE_TTL_MS,
      );

      if (!response.success || !response.data?.items) {
        this.logger.warn('No holder data returned from Birdeye', { mint });
        return [];
      }

      return response.data.items.map(this.parseHolderItem);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        if (error.errorType === 'not-found') {
          this.logger.debug('Token not found for holder data', { mint });
          return [];
        }
        this.logApiError(error, '/defi/token_holder', mint);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Private — Core Request Helper
  // ---------------------------------------------------------------------------

  /**
   * Executes a rate-limited, cached GET request to the Birdeye API.
   *
   * Request lifecycle:
   *   1. Acquire rate-limit token from the shared limiter (`birdeye` provider, 15 RPS)
   *   2. Build query params including mandatory `chain=solana`
   *   3. Construct cache key using `BaseClient.buildUrl()` for deterministic keys
   *   4. Execute GET via `BaseClient.get()` (with retry, timeout, caching)
   *   5. Return parsed JSON response as type T
   *
   * @typeParam T - Expected Birdeye API response type
   * @param endpoint - API path (e.g., '/defi/price')
   * @param params - Additional query parameters (address, limit, etc.)
   * @param cacheTtlMs - Optional cache TTL in milliseconds. When provided, the
   *   response is cached via BaseClient's cache integration.
   * @returns Parsed API response
   * @throws {ApiError} On HTTP or network errors after retries
   */
  private async makeRequest<T>(
    endpoint: string,
    params: Record<string, string> = {},
    cacheTtlMs?: number,
  ): Promise<T> {
    // Step 1: Enforce rate limiting before every Birdeye API call
    await this.rateLimiter.acquire('birdeye');

    // Step 2: Merge endpoint-specific params with mandatory chain=solana
    const allParams: Record<string, string> = {
      ...params,
      chain: SOLANA.CHAIN_ID,
    };

    // Step 3: Build a deterministic cache key from the full URL
    const cacheKeyUrl = this.baseClient.buildUrl(endpoint, allParams);

    // Step 4: Build the endpoint string with query params for the GET request
    const searchParams = new URLSearchParams(allParams);
    const fullEndpoint = `${endpoint}?${searchParams.toString()}`;

    this.logger.debug('Birdeye API request', { endpoint, params: allParams });

    // Step 5: Execute via BaseClient with retry, timeout, and optional caching
    return this.baseClient.get<T>(fullEndpoint, {
      cacheKey: cacheTtlMs !== undefined ? `birdeye:${cacheKeyUrl}` : undefined,
      cacheTtlMs,
    });
  }

  // ---------------------------------------------------------------------------
  // Private — Response Parsers
  // ---------------------------------------------------------------------------

  /**
   * Parses a raw OHLCV item from the Birdeye API into a typed BirdeyeOHLCV object.
   * Handles both short-form (o, h, l, c, v) and long-form field names.
   *
   * @param item - Raw OHLCV data from the Birdeye API response
   * @returns Normalized BirdeyeOHLCV object
   */
  private parseOHLCVItem = (item: BirdeyeRawOHLCVItem): BirdeyeOHLCV => {
    return {
      unixTime: item.unixTime ?? item.time ?? 0,
      open: item.o ?? item.open ?? 0,
      high: item.h ?? item.high ?? 0,
      low: item.l ?? item.low ?? 0,
      close: item.c ?? item.close ?? 0,
      volume: item.v ?? item.volume ?? 0,
    };
  };

  /**
   * Parses a raw transaction item from the Birdeye API into a typed BirdeyeTransaction.
   * Normalizes field names across Birdeye API versions.
   *
   * @param item - Raw transaction data from the Birdeye API response
   * @returns Normalized BirdeyeTransaction object
   */
  private parseTxItem = (item: BirdeyeRawTxItem): BirdeyeTransaction => {
    return {
      txHash: item.txHash ?? '',
      blockUnixTime: item.blockUnixTime ?? 0,
      side: item.side === 'buy' ? 'buy' : 'sell',
      address: item.owner ?? item.address ?? '',
      tokenAmount: item.tokenAmount ?? 0,
      usdAmount: item.uiAmount ?? item.usdAmount ?? 0,
      pricePerToken: item.tokenPrice ?? 0,
    };
  };

  /**
   * Parses a raw holder item from the Birdeye API into a typed BirdeyeTopHolder.
   *
   * @param item - Raw holder data from the Birdeye API response
   * @returns Normalized BirdeyeTopHolder object
   */
  private parseHolderItem = (item: BirdeyeRawHolderItem): BirdeyeTopHolder => {
    return {
      address: item.address ?? '',
      amount: item.amount ?? 0,
      percentage: item.percentage ?? 0,
      uiAmount: item.uiAmount ?? 0,
    };
  };

  /**
   * Maps a raw Birdeye token overview response to the typed BirdeyeTokenData
   * interface. All fields are defensively defaulted to zero/empty values for
   * tokens with incomplete metadata.
   *
   * @param mint - Token mint address (fallback for address field)
   * @param raw - Raw overview data from the Birdeye API
   * @returns Fully populated BirdeyeTokenData object
   */
  private mapOverviewToTokenData(
    mint: string,
    raw: BirdeyeRawOverview,
  ): BirdeyeTokenData {
    return {
      address: raw.address ?? mint,
      symbol: raw.symbol ?? '',
      name: raw.name ?? '',
      decimals: raw.decimals ?? 0,
      price: raw.price ?? 0,
      priceChange24h: raw.priceChange24h ?? 0,
      volume24h: raw.volume24h ?? 0,
      volume1h: raw.volume1h ?? 0,
      volume5m: raw.volume5m ?? 0,
      marketCap: raw.marketCap ?? 0,
      liquidity: raw.liquidity ?? 0,
      holderCount: raw.holderCount ?? 0,
      supply: raw.supply ?? 0,
      circulatingSupply: raw.circulatingSupply ?? 0,
      lastTradeUnixTime: raw.lastTradeUnixTime ?? 0,
      logoURI: raw.logoURI,
      extensions: raw.extensions,
    };
  }

  // ---------------------------------------------------------------------------
  // Private — Error Handling Helpers
  // ---------------------------------------------------------------------------

  /**
   * Logs structured error context for Birdeye API failures.
   *
   * Classifies errors by type and logs at the appropriate severity level:
   *   - rate-limited (429): WARN — the rate limiter should prevent this
   *   - auth-failed (401/403): ERROR — invalid API key configuration
   *   - server-error (5xx): WARN — transient Birdeye service issues
   *   - other: ERROR — unexpected failure
   *
   * CRITICAL: Never logs the API key value in any error message.
   *
   * @param error - The ApiError from BaseClient
   * @param endpoint - The API endpoint that failed
   * @param mint - The token mint address being queried
   */
  private logApiError(error: ApiError, endpoint: string, mint: string): void {
    const context = {
      endpoint,
      mint,
      status: error.status,
      errorType: error.errorType,
      retryable: error.retryable,
    };

    switch (error.errorType) {
      case 'rate-limited':
        this.logger.warn(
          'Birdeye rate limit exceeded — rate limiter should prevent this; check configuration',
          context,
        );
        break;

      case 'auth-failed':
        this.logger.error(
          'Birdeye authentication failed — verify API key in extension settings',
          context,
        );
        break;

      case 'server-error':
        this.logger.warn(
          'Birdeye server error — service may be experiencing issues',
          context,
        );
        break;

      case 'timeout':
        this.logger.warn(
          'Birdeye request timed out — network latency or service degradation',
          context,
        );
        break;

      case 'network-error':
        this.logger.warn(
          'Birdeye network error — check internet connectivity',
          context,
        );
        break;

      default:
        this.logger.error(
          'Unexpected Birdeye API error',
          context,
        );
    }
  }

  /**
   * Creates a default empty BirdeyeTokenData object for graceful degradation.
   *
   * Used when a token is not found (404) or the API returns an unsuccessful
   * response. All numeric fields default to 0, strings to empty.
   *
   * @param mint - Token mint address to populate the address field
   * @returns BirdeyeTokenData with all fields set to default values
   */
  private createEmptyTokenData(mint: string): BirdeyeTokenData {
    return {
      address: mint,
      symbol: '',
      name: '',
      decimals: 0,
      price: 0,
      priceChange24h: 0,
      volume24h: 0,
      volume1h: 0,
      volume5m: 0,
      marketCap: 0,
      liquidity: 0,
      holderCount: 0,
      supply: 0,
      circulatingSupply: 0,
      lastTradeUnixTime: 0,
    };
  }
}
