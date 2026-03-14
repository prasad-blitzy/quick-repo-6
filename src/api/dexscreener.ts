/**
 * src/api/dexscreener.ts — DexScreener REST Client (FALLBACK ONLY)
 *
 * Provides a typed REST client for the DexScreener API, used exclusively as a
 * fallback data source when the primary Birdeye API is unavailable due to rate
 * limits or errors.
 *
 * Per AAP Section 0.7.4:
 * "DexScreener as fallback only: DexScreener must not be used as a primary
 *  data source for tokens already covered by Birdeye — it should only be
 *  queried when Birdeye rate limits are hit or Birdeye returns errors."
 *
 * Per AAP Section 0.4.6:
 * "DexScreener → src/api/dexscreener.ts → token-store. Trigger: Fallback
 *  when Birdeye rate limit hit. Rate limit: Token bucket 5 RPS (300/min)
 *  via rate-limiter.ts."
 *
 * Endpoints implemented:
 *   - GET /dex/tokens/{tokenAddress}       → getTokenPairs()
 *   - GET /dex/pairs/{chainId}/{pairAddress} → getPairByAddress()
 *   - GET /dex/search/?q={query}           → searchTokens()
 *
 * Key characteristics:
 *   - No authentication required — DexScreener is free and unauthenticated
 *   - All requests routed through RateLimiter at 5 RPS (300 req/min)
 *   - DexScreener requests use 'normal' priority (fallback, not safety-critical)
 *   - Every call logs the fallback reason for monitoring
 *   - Errors return null/empty arrays instead of throwing — graceful fallback
 *   - Multi-chain responses are filtered to Solana-only pairs
 *
 * @module api/dexscreener
 */

import { BaseClient, ApiError } from './base-client';
import { RateLimiter } from './rate-limiter';
import type { DexScreenerPair } from './types';
import { API_BASE_URLS, SOLANA } from '../utils/config';
import { createLogger, type Logger } from '../utils/logger';

// =============================================================================
// Internal DexScreener API Response Types
// =============================================================================

/**
 * Raw response shape from DexScreener's /dex/tokens/{address} endpoint.
 * DexScreener wraps all pair arrays in a `pairs` field. The pairs field
 * may be null if the token is not found on any DEX.
 */
interface DexScreenerTokensResponse {
  pairs: DexScreenerPair[] | null;
}

/**
 * Raw response shape from DexScreener's /dex/pairs/{chainId}/{pairAddress} endpoint.
 * Returns a single pair (or null if the pair does not exist).
 * DexScreener may return either `pair` (singular) or `pairs` (array with one item).
 */
interface DexScreenerPairResponse {
  pair?: DexScreenerPair | null;
  pairs?: DexScreenerPair[] | null;
}

/**
 * Raw response shape from DexScreener's /dex/search/?q={query} endpoint.
 * Returns an array of matching pairs across all supported chains.
 */
interface DexScreenerSearchResponse {
  pairs: DexScreenerPair[] | null;
}

// =============================================================================
// DexScreenerClient Class
// =============================================================================

/**
 * DexScreener REST API client — FALLBACK DATA SOURCE ONLY.
 *
 * Provides methods to query DexScreener for token pair data, used exclusively
 * when the primary Birdeye data source is unavailable. All requests are
 * rate-limited via the centralized RateLimiter and logged for monitoring.
 *
 * CRITICAL: This client must NEVER be used as a primary data source. Callers
 * should only invoke DexScreenerClient methods when Birdeye returns a rate
 * limit error (429) or a server error (5xx).
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter();
 * const dexscreener = new DexScreenerClient(limiter);
 *
 * // Fallback usage when Birdeye fails
 * try {
 *   const pairs = await birdeye.getTokenOverview(mint);
 * } catch (error) {
 *   if (error instanceof ApiError && error.errorType === 'rate-limited') {
 *     const fallbackPairs = await dexscreener.getTokenPairs(mint);
 *   }
 * }
 * ```
 */
export class DexScreenerClient {
  /**
   * HTTP client configured with the DexScreener base URL.
   * Provides retry logic, timeout handling, and error classification.
   * No authentication headers — DexScreener is free.
   */
  private readonly baseClient: BaseClient;

  /**
   * Centralized rate limiter enforcing 5 RPS for DexScreener requests.
   * Shared across all DexScreenerClient instances for accurate throttling.
   */
  private readonly rateLimiter: RateLimiter;

  /**
   * Structured logger with 'dexscreener-api' context tag.
   * Logs all fallback usage, errors, and Solana pair filtering activity.
   */
  private readonly logger: Logger;

  /**
   * Creates a new DexScreenerClient instance.
   *
   * No API key is required — DexScreener is a free, unauthenticated API.
   * The base URL is sourced from API_BASE_URLS.DEXSCREENER in config.ts.
   *
   * @param rateLimiter - Shared RateLimiter instance for per-provider throttling.
   *   DexScreener is configured at 5 RPS (300 req/min) with burst capacity of 10.
   */
  constructor(rateLimiter: RateLimiter) {
    this.baseClient = new BaseClient(API_BASE_URLS.DEXSCREENER, {
      loggerContext: 'dexscreener-http',
    });
    this.rateLimiter = rateLimiter;
    this.logger = createLogger('dexscreener-api');

    this.logger.info('DexScreenerClient initialized (fallback data source)');
  }

  // ---------------------------------------------------------------------------
  // Public API Methods
  // ---------------------------------------------------------------------------

  /**
   * Retrieves all trading pairs for a given token address from DexScreener.
   *
   * Endpoint: `GET /dex/tokens/{tokenAddress}`
   *
   * DexScreener returns pairs across ALL supported chains. This method
   * automatically filters results to Solana-only pairs using the chain
   * identifier from SOLANA.CHAIN_ID.
   *
   * FALLBACK ONLY: This method should only be called when Birdeye is
   * unavailable. Every invocation logs the fallback reason for monitoring.
   *
   * @param tokenAddress - The Solana token mint address (base58 public key)
   * @param fallbackReason - Reason why the fallback is being triggered
   *   (e.g., 'Birdeye rate limited', 'Birdeye server error'). Used for
   *   monitoring and debugging fallback frequency.
   * @returns Array of DexScreenerPair objects for Solana pairs, or an empty
   *   array if the token is not found or an error occurs
   *
   * @example
   * ```typescript
   * const pairs = await dexscreener.getTokenPairs(
   *   'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
   *   'Birdeye rate limited'
   * );
   * ```
   */
  async getTokenPairs(
    tokenAddress: string,
    fallbackReason: string = 'unspecified',
  ): Promise<DexScreenerPair[]> {
    this.logger.info(
      `DexScreener fallback triggered for ${tokenAddress}: ${fallbackReason}`,
    );

    try {
      // Enforce rate limit before making the request
      await this.rateLimiter.acquire('dexscreener', 'normal');

      const endpoint = `/dex/tokens/${encodeURIComponent(tokenAddress)}`;
      this.logger.debug(`Requesting token pairs: ${endpoint}`);

      const response = await this.baseClient.get<DexScreenerTokensResponse>(endpoint);

      // DexScreener returns null pairs if the token is not indexed
      if (!response || !response.pairs || !Array.isArray(response.pairs)) {
        this.logger.debug(
          `No pairs found for token ${tokenAddress} on DexScreener`,
        );
        return [];
      }

      // Filter to Solana-only pairs since DexScreener may return multi-chain results
      const solanaPairs = this.filterSolanaPairs(response.pairs);

      this.logger.info(
        `Retrieved ${solanaPairs.length} Solana pairs for ${tokenAddress} ` +
        `(${response.pairs.length} total across all chains)`,
      );

      return solanaPairs;
    } catch (error: unknown) {
      return this.handleError<DexScreenerPair[]>(
        error,
        'getTokenPairs',
        tokenAddress,
        [],
      );
    }
  }

  /**
   * Retrieves a specific trading pair by chain ID and pair address.
   *
   * Endpoint: `GET /dex/pairs/{chainId}/{pairAddress}`
   *
   * For Solana pairs, chainId should be 'solana' (available via SOLANA.CHAIN_ID).
   * Returns a single DexScreenerPair or null if the pair is not found.
   *
   * FALLBACK ONLY: This method should only be called when Birdeye is
   * unavailable. Every invocation logs the fallback reason for monitoring.
   *
   * @param chainId - Blockchain identifier (e.g., 'solana')
   * @param pairAddress - The DEX liquidity pool/pair address
   * @param fallbackReason - Reason why the fallback is being triggered
   * @returns DexScreenerPair data or null if the pair is not found or an error occurs
   *
   * @example
   * ```typescript
   * const pair = await dexscreener.getPairByAddress(
   *   'solana',
   *   'HWHvQhFmJB3NUcu1aihKmrKegfVxBEHzwVX6yZCKEsi1',
   *   'Birdeye server error'
   * );
   * ```
   */
  async getPairByAddress(
    chainId: string,
    pairAddress: string,
    fallbackReason: string = 'unspecified',
  ): Promise<DexScreenerPair | null> {
    this.logger.info(
      `DexScreener fallback triggered for pair ${pairAddress} on ${chainId}: ${fallbackReason}`,
    );

    try {
      // Enforce rate limit before making the request
      await this.rateLimiter.acquire('dexscreener', 'normal');

      const endpoint = `/dex/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`;
      this.logger.debug(`Requesting pair data: ${endpoint}`);

      const response = await this.baseClient.get<DexScreenerPairResponse>(endpoint);

      if (!response) {
        this.logger.debug(
          `No response for pair ${pairAddress} on ${chainId}`,
        );
        return null;
      }

      // DexScreener may return the pair in either `pair` (singular) or `pairs` (array)
      let pair: DexScreenerPair | null = null;

      if (response.pair) {
        pair = response.pair;
      } else if (
        response.pairs &&
        Array.isArray(response.pairs) &&
        response.pairs.length > 0
      ) {
        pair = response.pairs[0];
      }

      if (!pair) {
        this.logger.debug(
          `Pair not found: ${pairAddress} on chain ${chainId}`,
        );
        return null;
      }

      this.logger.info(
        `Retrieved pair ${pair.pairAddress} on ${pair.chainId} ` +
        `(${pair.baseToken.symbol}/${pair.quoteToken.symbol})`,
      );

      return pair;
    } catch (error: unknown) {
      return this.handleError<DexScreenerPair | null>(
        error,
        'getPairByAddress',
        pairAddress,
        null,
      );
    }
  }

  /**
   * Searches for tokens by name or symbol on DexScreener.
   *
   * Endpoint: `GET /dex/search/?q={query}`
   *
   * Useful as a fallback for looking up tokens by symbol when the mint address
   * is not known. Results are automatically filtered to Solana-only pairs.
   *
   * FALLBACK ONLY: This method should only be called when Birdeye is
   * unavailable. Every invocation logs the fallback reason for monitoring.
   *
   * @param query - Search query string (token name, symbol, or partial match)
   * @param fallbackReason - Reason why the fallback is being triggered
   * @returns Array of DexScreenerPair objects matching the query on Solana,
   *   or an empty array if no results or an error occurs
   *
   * @example
   * ```typescript
   * const pairs = await dexscreener.searchTokens('BONK', 'Birdeye rate limited');
   * ```
   */
  async searchTokens(
    query: string,
    fallbackReason: string = 'unspecified',
  ): Promise<DexScreenerPair[]> {
    this.logger.info(
      `DexScreener fallback search triggered for "${query}": ${fallbackReason}`,
    );

    // Validate query is non-empty to prevent unnecessary API calls
    if (!query || query.trim().length === 0) {
      this.logger.warn('Search query is empty — returning empty results');
      return [];
    }

    try {
      // Enforce rate limit before making the request
      await this.rateLimiter.acquire('dexscreener', 'normal');

      // Build the search endpoint path with encoded query parameter.
      // BaseClient.get() prepends the base URL, so we only provide the path portion.
      const searchPath = `/dex/search?q=${encodeURIComponent(query.trim())}`;
      this.logger.debug(`Searching tokens: ${searchPath}`);

      const response = await this.baseClient.get<DexScreenerSearchResponse>(searchPath);

      // DexScreener returns null pairs if no matches found
      if (!response || !response.pairs || !Array.isArray(response.pairs)) {
        this.logger.debug(
          `No search results for query "${query}" on DexScreener`,
        );
        return [];
      }

      // Filter to Solana-only pairs
      const solanaPairs = this.filterSolanaPairs(response.pairs);

      this.logger.info(
        `Search for "${query}" returned ${solanaPairs.length} Solana pairs ` +
        `(${response.pairs.length} total across all chains)`,
      );

      return solanaPairs;
    } catch (error: unknown) {
      return this.handleError<DexScreenerPair[]>(
        error,
        'searchTokens',
        query,
        [],
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Filters an array of DexScreener pairs to include only Solana pairs.
   *
   * DexScreener is a multi-chain aggregator that may return results for
   * Ethereum, BSC, Arbitrum, and other chains alongside Solana. This method
   * filters the response to only include pairs with `chainId === 'solana'`
   * (matching SOLANA.CHAIN_ID from config).
   *
   * @param pairs - Array of DexScreenerPair objects from any chain
   * @returns Array of DexScreenerPair objects with chainId matching SOLANA.CHAIN_ID
   */
  private filterSolanaPairs(pairs: DexScreenerPair[]): DexScreenerPair[] {
    const filtered = pairs.filter(
      (pair) => pair.chainId === SOLANA.CHAIN_ID,
    );

    if (filtered.length < pairs.length) {
      this.logger.debug(
        `Filtered ${pairs.length - filtered.length} non-Solana pairs ` +
        `(kept ${filtered.length} Solana pairs)`,
      );
    }

    return filtered;
  }

  /**
   * Centralized error handler for all DexScreenerClient methods.
   *
   * Since DexScreener is a fallback data source, errors are handled gracefully:
   * - 404 (not-found): Token/pair not indexed — return empty/null default
   * - 429 (rate-limited): Rate limiter should prevent this, but log a warning
   * - 5xx (server-error): DexScreener is down — return empty/null default
   * - timeout: DexScreener is slow — return empty/null default
   * - other errors: Log and return default value
   *
   * Unlike primary data source clients, DexScreenerClient NEVER throws errors
   * to callers. This ensures that fallback failures don't cascade into the
   * calling code's error handling.
   *
   * @typeParam T - The default value type (DexScreenerPair[], null, etc.)
   * @param error - The caught error object
   * @param methodName - Name of the calling method for log context
   * @param identifier - Token address, pair address, or query for log context
   * @param defaultValue - Value to return on error (empty array or null)
   * @returns The default value (never throws)
   */
  private handleError<T>(
    error: unknown,
    methodName: string,
    identifier: string,
    defaultValue: T,
  ): T {
    if (error instanceof ApiError) {
      switch (error.errorType) {
        case 'not-found':
          this.logger.debug(
            `${methodName}: Resource not found for "${identifier}" ` +
            `(HTTP ${error.status})`,
          );
          break;

        case 'rate-limited':
          this.logger.warn(
            `${methodName}: DexScreener rate limited for "${identifier}" ` +
            `(HTTP ${error.status}). Rate limiter may need adjustment.`,
          );
          break;

        case 'server-error':
          this.logger.error(
            `${methodName}: DexScreener server error for "${identifier}" ` +
            `(HTTP ${error.status})`,
            { responseBody: error.responseBody },
          );
          break;

        case 'timeout':
          this.logger.warn(
            `${methodName}: DexScreener request timed out for "${identifier}"`,
          );
          break;

        case 'network-error':
          this.logger.warn(
            `${methodName}: Network error reaching DexScreener for "${identifier}"`,
          );
          break;

        default:
          this.logger.error(
            `${methodName}: Unexpected API error for "${identifier}" ` +
            `(type: ${error.errorType}, HTTP ${error.status})`,
            { message: error.message, responseBody: error.responseBody },
          );
          break;
      }
    } else if (error instanceof Error) {
      this.logger.error(
        `${methodName}: Unexpected error for "${identifier}": ${error.message}`,
        { stack: error.stack },
      );
    } else {
      this.logger.error(
        `${methodName}: Unknown error for "${identifier}": ${String(error)}`,
      );
    }

    return defaultValue;
  }
}
