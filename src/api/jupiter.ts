/**
 * src/api/jupiter.ts — Jupiter API Client
 *
 * REST client for Jupiter's Price API v3 and Quote API v6. Jupiter is a
 * critical component of the GMGN Signal Bot Chrome Extension, providing:
 *
 * 1. **Token Price Lookups**: Real-time price data via `/price/v3/` for
 *    cross-referencing with Birdeye data and portfolio valuation.
 *
 * 2. **Honeypot Detection** (MANDATORY per AAP Section 0.7.3): Every new
 *    token must undergo a sell simulation via Jupiter's `/quote` endpoint.
 *    A successful TOKEN→SOL quote proves the token is sellable. A failed
 *    quote (timeout, error, no route) flags the token as a potential honeypot.
 *
 * Architecture:
 * - Two separate BaseClient instances:
 *   - Price API: `https://price.jup.ag` (via API_BASE_URLS.JUPITER_PRICE)
 *   - Quote API: `https://quote-api.jup.ag` (via API_BASE_URLS.JUPITER_QUOTE)
 * - No authentication required — Jupiter is a free, unauthenticated API
 * - Rate limited to 1 RPS (free tier) via RateLimiter with 'jupiter' provider
 * - All safety-critical requests use 'high' priority in the rate limiter queue
 *
 * Consumed by:
 * - src/safety/honeypot-detector.ts — simulateSell() for every new token
 * - src/store/token-store.ts — getPrice() / getPrices() for price enrichment
 * - src/signals/scoring-engine.ts — price data for signal analysis
 *
 * Per AAP Section 0.4.6:
 * "Jupiter → src/api/jupiter.ts → honeypot-detector.ts. Trigger: safety check
 *  for every new token. Rate limit: Token bucket 1 RPS (free tier) via
 *  rate-limiter.ts"
 *
 * @module api/jupiter
 */

import { BaseClient, ApiError } from './base-client';
import { RateLimiter } from './rate-limiter';
import type { JupiterQuote, JupiterPrice } from './types';
import { API_BASE_URLS, RATE_LIMITS, SOLANA } from '../utils/config';
import { createLogger, type Logger } from '../utils/logger';

// =============================================================================
// Constants
// =============================================================================

/**
 * Default test amount in token smallest units for sell simulation.
 * Set to 1,000,000 (1M smallest units) which is typically a very small
 * amount for most SPL tokens. This is sufficient to test whether the token
 * is sellable without needing to know the exact token decimals.
 *
 * For a token with 6 decimals: 1,000,000 = 1.0 token
 * For a token with 9 decimals: 1,000,000 = 0.001 token
 */
const DEFAULT_SELL_TEST_AMOUNT = 1_000_000;

/**
 * Cache TTL for price data: 15 seconds.
 * Price data changes rapidly in memecoin markets but 15-second caching
 * provides a balance between freshness and rate limit conservation at 1 RPS.
 */
const PRICE_CACHE_TTL_MS = 15_000;

/**
 * Cache TTL for quote data: 5 seconds.
 * Quotes are more time-sensitive than prices since they represent live
 * routing through DEX pools that can shift quickly.
 */
const QUOTE_CACHE_TTL_MS = 5_000;

// =============================================================================
// Internal Response Type Interfaces
// =============================================================================

/**
 * Raw response from Jupiter Price API v3.
 * The API wraps price data in a `data` object keyed by mint address.
 * Price values may be returned as strings from the API for precision.
 */
interface JupiterPriceApiResponse {
  data: Record<
    string,
    {
      /** Token mint address (acts as the unique identifier) */
      id: string;
      /** Token ticker symbol */
      mintSymbol: string;
      /** Quote token mint address (typically wrapped SOL) */
      vsToken: string;
      /** Quote token symbol (typically "SOL") */
      vsTokenSymbol: string;
      /** Price denominated in the quote token (may be string or number) */
      price: string | number;
    } | null
  >;
  /** Time taken for price calculation in milliseconds */
  timeTaken?: number;
}

// =============================================================================
// JupiterClient Class
// =============================================================================

/**
 * Jupiter API client for token price lookups and honeypot detection.
 *
 * Instantiates two separate BaseClient instances for the Price API and
 * Quote API, each with distinct base URLs. All requests are rate-limited
 * to 1 RPS (Jupiter free tier) via the centralized RateLimiter.
 *
 * @example
 * ```typescript
 * const rateLimiter = new RateLimiter();
 * const jupiter = new JupiterClient(rateLimiter);
 *
 * // Get token price
 * const price = await jupiter.getPrice('TokenMintAddress123');
 *
 * // Honeypot detection (MANDATORY for every new token)
 * const result = await jupiter.simulateSell('TokenMintAddress123');
 * if (!result.sellable) {
 *   console.warn('Token is a potential honeypot!');
 * }
 * ```
 */
export class JupiterClient {
  /** BaseClient for Jupiter Price API (https://price.jup.ag) */
  private readonly priceClient: BaseClient;

  /** BaseClient for Jupiter Quote API (https://quote-api.jup.ag) */
  private readonly quoteClient: BaseClient;

  /** Centralized per-API rate limiter — enforces 1 RPS for Jupiter free tier */
  private readonly rateLimiter: RateLimiter;

  /** Structured logger with 'jupiter-api' context tag */
  private readonly logger: Logger;

  /**
   * Creates a new JupiterClient instance.
   *
   * No API key is required — Jupiter's Price and Quote APIs are free and
   * unauthenticated. The rate limiter enforces the 1 RPS free tier limit.
   *
   * @param rateLimiter - Optional shared RateLimiter instance. If omitted,
   *   a new RateLimiter is created with default configurations from
   *   RATE_LIMITS (Jupiter: 1 RPS, burst size 1).
   */
  constructor(rateLimiter?: RateLimiter) {
    // Initialize Price API client — no auth headers needed
    this.priceClient = new BaseClient(API_BASE_URLS.JUPITER_PRICE, {
      loggerContext: 'jupiter-price',
    });

    // Initialize Quote API client — separate base URL, no auth headers
    this.quoteClient = new BaseClient(API_BASE_URLS.JUPITER_QUOTE, {
      loggerContext: 'jupiter-quote',
    });

    // Use shared rate limiter or create a new one with default config
    this.rateLimiter = rateLimiter ?? new RateLimiter();

    // Create structured logger with 'jupiter-api' context tag
    this.logger = createLogger('jupiter-api');

    this.logger.info(
      `Jupiter client initialized — Price API: ${API_BASE_URLS.JUPITER_PRICE}, ` +
        `Quote API: ${API_BASE_URLS.JUPITER_QUOTE}, ` +
        `Rate limit: ${RATE_LIMITS.JUPITER.requestsPerSecond} RPS`,
    );
  }

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Fetches the current price for a single token from Jupiter's Price API v3.
   *
   * Endpoint: `GET https://price.jup.ag/price/v3/?ids={mint}`
   *
   * Returns null if the token is not found or the API returns no price data
   * for the given mint address. Never throws on API errors — always returns
   * a typed result or null for graceful degradation.
   *
   * @param mint - Solana token mint address (base58 encoded public key)
   * @returns JupiterPrice object with id, price, mintSymbol, vsToken,
   *   vsTokenSymbol, or null if the token is not recognized by Jupiter
   *
   * @example
   * ```typescript
   * const price = await jupiter.getPrice('So11111111111111111111111111111111111111112');
   * if (price) {
   *   console.log(`SOL price: ${price.price} ${price.vsTokenSymbol}`);
   * }
   * ```
   */
  async getPrice(mint: string): Promise<JupiterPrice | null> {
    try {
      // Enforce Jupiter 1 RPS rate limit with high priority for pricing queries
      await this.rateLimiter.acquire('jupiter', 'high');

      const logUrl = this.priceClient.buildUrl('/price/v3/', { ids: mint });
      this.logger.debug(`Fetching price for ${mint}`, { url: logUrl });

      // Jupiter Price API v3 endpoint with mint as the ids parameter
      const response = await this.priceClient.get<JupiterPriceApiResponse>(
        `/price/v3/?ids=${encodeURIComponent(mint)}`,
        {
          cacheKey: `jupiter:price:${mint}`,
          cacheTtlMs: PRICE_CACHE_TTL_MS,
        },
      );

      // Extract the token's price data from the response data map
      const tokenData = response.data?.[mint];

      if (!tokenData) {
        this.logger.warn(`No price data returned for mint: ${mint}`);
        return null;
      }

      // Parse the price — API may return string or number
      const parsedPrice: JupiterPrice = {
        id: tokenData.id,
        mintSymbol: tokenData.mintSymbol,
        vsToken: tokenData.vsToken,
        vsTokenSymbol: tokenData.vsTokenSymbol,
        price: typeof tokenData.price === 'string'
          ? parseFloat(tokenData.price)
          : tokenData.price,
        timeTaken: response.timeTaken,
      };

      // Validate that price is a valid number
      if (isNaN(parsedPrice.price)) {
        this.logger.warn(`Invalid price value for mint ${mint}: ${tokenData.price}`);
        return null;
      }

      this.logger.info(
        `Price for ${parsedPrice.mintSymbol} (${mint}): ${parsedPrice.price} ${parsedPrice.vsTokenSymbol}`,
      );

      return parsedPrice;
    } catch (error: unknown) {
      // Handle specific API error types without crashing
      if (error instanceof ApiError) {
        if (error.errorType === 'rate-limited') {
          this.logger.warn(`Rate limited on price lookup for ${mint}`, {
            retryable: error.retryable,
          });
        } else if (error.errorType === 'timeout') {
          this.logger.warn(`Timeout on price lookup for ${mint}`);
        } else {
          this.logger.error(
            `API error on price lookup for ${mint}: ${error.message}`,
            { errorType: error.errorType, status: error.status },
          );
        }
      } else {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Unexpected error on price lookup for ${mint}: ${errorMessage}`,
        );
      }

      return null;
    }
  }

  /**
   * Fetches prices for multiple tokens in a single batched API call.
   *
   * Endpoint: `GET https://price.jup.ag/price/v3/?ids={mint1,mint2,...}`
   *
   * More efficient than calling getPrice() individually for multiple tokens
   * since the batch counts as a single request against the 1 RPS rate limit.
   *
   * @param mints - Array of Solana token mint addresses to look up
   * @returns Map of mint address → JupiterPrice. Tokens not found by Jupiter
   *   are omitted from the map (no null entries).
   *
   * @example
   * ```typescript
   * const prices = await jupiter.getPrices(['mint1', 'mint2', 'mint3']);
   * for (const [mint, price] of prices) {
   *   console.log(`${price.mintSymbol}: ${price.price}`);
   * }
   * ```
   */
  async getPrices(mints: string[]): Promise<Map<string, JupiterPrice>> {
    const result = new Map<string, JupiterPrice>();

    // Handle empty input gracefully
    if (mints.length === 0) {
      this.logger.debug('getPrices called with empty mints array');
      return result;
    }

    try {
      // Enforce rate limit — counts as a single request regardless of batch size
      await this.rateLimiter.acquire('jupiter', 'high');

      // Join mint addresses with commas for the batch query
      const idsParam = mints.join(',');

      const logUrl = this.priceClient.buildUrl('/price/v3/', { ids: idsParam });
      this.logger.debug(`Batch price lookup for ${mints.length} tokens`, {
        url: logUrl,
      });

      const response = await this.priceClient.get<JupiterPriceApiResponse>(
        `/price/v3/?ids=${encodeURIComponent(idsParam)}`,
        {
          cacheKey: `jupiter:prices:${mints.sort().join(',')}`,
          cacheTtlMs: PRICE_CACHE_TTL_MS,
        },
      );

      if (!response.data) {
        this.logger.warn('No data object in price API response');
        return result;
      }

      // Parse each token's price data from the response
      for (const mint of mints) {
        const tokenData = response.data[mint];

        if (!tokenData) {
          this.logger.debug(`No price data for mint in batch: ${mint}`);
          continue;
        }

        const price = typeof tokenData.price === 'string'
          ? parseFloat(tokenData.price)
          : tokenData.price;

        if (isNaN(price)) {
          this.logger.warn(`Invalid price value in batch for mint ${mint}: ${tokenData.price}`);
          continue;
        }

        const jupiterPrice: JupiterPrice = {
          id: tokenData.id,
          mintSymbol: tokenData.mintSymbol,
          vsToken: tokenData.vsToken,
          vsTokenSymbol: tokenData.vsTokenSymbol,
          price,
          timeTaken: response.timeTaken,
        };

        result.set(mint, jupiterPrice);
      }

      this.logger.info(
        `Batch price lookup complete: ${result.size}/${mints.length} tokens priced`,
      );

      return result;
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        if (error.errorType === 'rate-limited') {
          this.logger.warn(
            `Rate limited on batch price lookup (${mints.length} tokens)`,
            { retryable: error.retryable },
          );
        } else if (error.errorType === 'timeout') {
          this.logger.warn(
            `Timeout on batch price lookup (${mints.length} tokens)`,
          );
        } else {
          this.logger.error(
            `API error on batch price lookup: ${error.message}`,
            { errorType: error.errorType, status: error.status },
          );
        }
      } else {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Unexpected error on batch price lookup: ${errorMessage}`,
        );
      }

      return result;
    }
  }

  /**
   * Fetches a swap quote from Jupiter's Quote API v6.
   *
   * Endpoint: `GET https://quote-api.jup.ag/v6/quote?inputMint={inputMint}&
   *   outputMint={outputMint}&amount={amount}&swapMode={swapMode}`
   *
   * **CRITICAL for honeypot detection**: To test if a token is sellable,
   * call with `inputMint=tokenMint`, `outputMint=SOL_MINT`, `swapMode='ExactIn'`.
   * A valid quote proves the token can be sold. A failure indicates a potential
   * honeypot.
   *
   * @param inputMint - Mint address of the token being sold (input token)
   * @param outputMint - Mint address of the token being bought (output token).
   *   For sell simulation, this is `SOLANA.SOL_MINT`.
   * @param amount - Amount of input token in smallest units (lamports for SOL,
   *   raw token units for SPL tokens). Must be a positive integer.
   * @param swapMode - Swap mode: 'ExactIn' (known input amount, default) or
   *   'ExactOut' (known output amount). Use 'ExactIn' for sell simulation.
   * @returns Parsed JupiterQuote with route plan, price impact, and amounts
   * @throws {ApiError} On API errors (rate-limited, timeout, server error, no route)
   *
   * @example
   * ```typescript
   * // Sell simulation: can this token be sold for SOL?
   * const quote = await jupiter.getQuote(
   *   'TokenMintAddress',
   *   'So11111111111111111111111111111111111111112',
   *   1_000_000,
   *   'ExactIn',
   * );
   * console.log(`Output: ${quote.outAmount}, Impact: ${quote.priceImpactPct}%`);
   * ```
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    swapMode: 'ExactIn' | 'ExactOut' = 'ExactIn',
  ): Promise<JupiterQuote> {
    // Enforce Jupiter 1 RPS rate limit — high priority for safety-critical quotes
    await this.rateLimiter.acquire('jupiter', 'high');

    // Construct the query parameters for the Quote API v6
    const params: Record<string, string> = {
      inputMint,
      outputMint,
      amount: String(Math.floor(amount)),
      swapMode,
    };

    // Build URL for logging with proper URL encoding
    const logUrl = this.quoteClient.buildUrl('/v6/quote', params);
    this.logger.debug('Fetching swap quote', {
      inputMint,
      outputMint,
      amount: Math.floor(amount),
      swapMode,
      url: logUrl,
    });

    // Construct endpoint with query parameters
    const queryString = new URLSearchParams(params).toString();
    const endpoint = `/v6/quote?${queryString}`;

    const response = await this.quoteClient.get<JupiterQuote>(endpoint, {
      cacheKey: `jupiter:quote:${inputMint}:${outputMint}:${Math.floor(amount)}:${swapMode}`,
      cacheTtlMs: QUOTE_CACHE_TTL_MS,
      // Reduce retries for quote requests — faster failure for honeypot detection
      maxRetries: 2,
    });

    // Validate the response contains required fields from JupiterQuote
    if (!response.inputMint || !response.outputMint || !response.routePlan) {
      throw new ApiError(
        `Invalid quote response: missing required fields for ${inputMint} → ${outputMint}`,
        0,
        'parse-error',
        false,
        response,
      );
    }

    this.logger.info(
      `Quote obtained: ${response.inAmount} ${response.inputMint.slice(0, 8)}... → ` +
        `${response.outAmount} ${response.outputMint.slice(0, 8)}... ` +
        `(impact: ${response.priceImpactPct}%, mode: ${response.swapMode}, ` +
        `routes: ${response.routePlan.length})`,
    );

    return response;
  }

  /**
   * Simulates selling a token back to SOL for honeypot detection.
   *
   * This is the primary honeypot detection method. It wraps getQuote() with
   * TOKEN→SOL parameters and returns a structured result indicating whether
   * the token is sellable.
   *
   * Per AAP Section 0.7.3: "Every new token must undergo a sell simulation
   * via Jupiter's `/quote` endpoint before being scored — tokens that cannot
   * be sold are classified as honeypots and filtered out."
   *
   * Detection logic:
   * - Valid quote returned → `sellable: true` (token can be sold to SOL)
   * - No route found → `sellable: false` (no DEX liquidity or blocked)
   * - Timeout → `sellable: false` (fail-safe: treat as potential honeypot)
   * - Any error → `sellable: false` (fail-safe: assume worst case)
   *
   * @param tokenMint - Mint address of the token to test for sellability
   * @param amount - Optional test amount in token's smallest units.
   *   Defaults to 1,000,000 (1M smallest units), which is a safe small amount
   *   for most SPL tokens regardless of decimals.
   * @returns Object with:
   *   - `sellable`: Whether the token can be sold (true = NOT a honeypot)
   *   - `quote`: The JupiterQuote if sellable, null if not
   *   - `priceImpact`: Price impact as a number (0-100). 100 indicates
   *     unsellable or infinite price impact.
   *
   * @example
   * ```typescript
   * const result = await jupiter.simulateSell('NewTokenMint123');
   * if (!result.sellable) {
   *   console.warn('HONEYPOT DETECTED — token cannot be sold!');
   * } else {
   *   console.log(`Sellable with ${result.priceImpact}% price impact`);
   * }
   * ```
   */
  async simulateSell(
    tokenMint: string,
    amount?: number,
  ): Promise<{ sellable: boolean; quote: JupiterQuote | null; priceImpact: number }> {
    const testAmount = amount ?? DEFAULT_SELL_TEST_AMOUNT;
    const outputMint = SOLANA.SOL_MINT;

    this.logger.info(
      `Simulating sell: ${testAmount} units of ${tokenMint} → SOL (${outputMint})`,
    );

    try {
      // Attempt to get a TOKEN → SOL quote using ExactIn mode
      const quote = await this.getQuote(
        tokenMint,
        outputMint,
        testAmount,
        'ExactIn',
      );

      // Parse price impact from string to number
      const priceImpact = parseFloat(quote.priceImpactPct) || 0;
      const absoluteImpact = Math.abs(priceImpact);

      // Log the simulation result with relevant quote details
      this.logger.info(
        `Sell simulation SUCCESS for ${tokenMint}: sellable=true, ` +
          `priceImpact=${absoluteImpact}%, outAmount=${quote.outAmount}, ` +
          `routes=${quote.routePlan.length}`,
      );

      return {
        sellable: true,
        quote,
        priceImpact: absoluteImpact,
      };
    } catch (error: unknown) {
      // Classify the failure reason for logging and debugging
      let failureReason = 'unknown';

      if (error instanceof ApiError) {
        switch (error.errorType) {
          case 'rate-limited':
            failureReason = 'rate-limited';
            this.logger.warn(
              `Sell simulation RATE LIMITED for ${tokenMint} — ` +
                `treating as inconclusive, retryable: ${error.retryable}`,
            );
            break;

          case 'timeout':
            failureReason = 'timeout';
            this.logger.warn(
              `Sell simulation TIMEOUT for ${tokenMint} — ` +
                'treating as potential honeypot (fail-safe)',
            );
            break;

          case 'not-found':
            failureReason = 'no-route';
            this.logger.warn(
              `Sell simulation NO ROUTE for ${tokenMint} — ` +
                'no liquidity on Jupiter, potential honeypot',
            );
            break;

          case 'server-error':
            failureReason = 'server-error';
            this.logger.warn(
              `Sell simulation SERVER ERROR for ${tokenMint}: ${error.message}`,
            );
            break;

          default:
            failureReason = error.errorType;
            // Check for "no route found" in the error message or response body
            if (this.isNoRouteError(error)) {
              failureReason = 'no-route';
              this.logger.warn(
                `Sell simulation NO ROUTE (from response) for ${tokenMint}`,
              );
            } else {
              this.logger.error(
                `Sell simulation FAILED for ${tokenMint}: ${error.message}`,
                {
                  errorType: error.errorType,
                  status: error.status,
                  retryable: error.retryable,
                },
              );
            }
            break;
        }
      } else {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Sell simulation UNEXPECTED ERROR for ${tokenMint}: ${errorMessage}`,
        );
      }

      // Fail-safe: treat any failure as "not sellable" (potential honeypot)
      this.logger.info(
        `Sell simulation result for ${tokenMint}: sellable=false, ` +
          `reason=${failureReason}`,
      );

      return {
        sellable: false,
        quote: null,
        priceImpact: 100,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Private Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Checks whether an ApiError represents a "no route found" condition.
   *
   * Jupiter returns various error formats when no swap route exists:
   * - HTTP 400 with body `{ "error": "Could not find any route" }`
   * - HTTP 400 with body containing "NO_ROUTE" or "no route"
   *
   * This helper inspects both the error message and responseBody to detect
   * these conditions across different Jupiter API response formats.
   *
   * @param error - The ApiError to inspect
   * @returns true if the error indicates no swap route was found
   */
  private isNoRouteError(error: ApiError): boolean {
    // Check the error message for common "no route" indicators
    const messageLower = error.message.toLowerCase();
    if (
      messageLower.includes('no route') ||
      messageLower.includes('could not find')
    ) {
      return true;
    }

    // Check the response body for Jupiter's structured error format
    if (error.responseBody) {
      try {
        const body =
          typeof error.responseBody === 'string'
            ? error.responseBody
            : JSON.stringify(error.responseBody);

        const bodyLower = body.toLowerCase();
        if (
          bodyLower.includes('no route') ||
          bodyLower.includes('could not find') ||
          bodyLower.includes('no_route')
        ) {
          return true;
        }
      } catch {
        // If we can't parse the body, it's not a "no route" error
      }
    }

    return false;
  }
}
