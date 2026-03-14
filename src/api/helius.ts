/**
 * src/api/helius.ts — Helius RPC Client
 *
 * Production-grade Helius Enhanced Transactions API client for the GMGN Signal
 * Bot Chrome Extension. Provides rich, program-aware transaction parsing for
 * smart money wallet activity monitoring and convergence detection.
 *
 * Helius Developer plan ($49/mo) capabilities used:
 *   - Enhanced Transactions API: POST /v0/transactions
 *   - Token Metadata API: GET /v0/token-metadata
 *   - Address Transactions: GET /v0/addresses/{address}/transactions
 *
 * Authentication: API key is embedded in URL query parameters as
 * `?api-key={apiKey}` (Helius convention — NOT in headers).
 *
 * Rate limit: 10 RPS enforced via the centralized RateLimiter per AAP Section 0.7.4.
 *
 * Consumers:
 *   - src/tracking/wallet-tracker.ts   — monitors smart money wallet activity
 *   - src/tracking/convergence-detector.ts — detects multi-wallet convergence
 *   - entrypoints/background.ts        — orchestrates wallet monitoring
 *
 * @module api/helius
 */

import { BaseClient, ApiError } from './base-client';
import { RateLimiter } from './rate-limiter';
import type { HeliusParsedTx } from './types';
import { API_BASE_URLS, RATE_LIMITS } from '../utils/config';
import { createLogger, type Logger } from '../utils/logger';

// =============================================================================
// Constants
// =============================================================================

/**
 * Known Solana program identifiers used by Helius in the `source` field
 * of parsed transactions. These enable program-aware parsing to identify
 * which DEX or protocol a transaction interacted with.
 */
const PROGRAM_SOURCES = {
  /** Jupiter aggregator — multi-hop swap routing */
  JUPITER: 'JUPITER',
  /** Raydium AMM — primary Solana DEX for graduated tokens */
  RAYDIUM: 'RAYDIUM',
  /** Pump.fun bonding curve — new token launch platform */
  PUMP_FUN: 'PUMP_FUN',
  /** Pump.fun alternative source identifiers seen in Helius responses */
  PUMP_DOT_FUN: 'PUMP.FUN',
} as const;

/**
 * Program type classification for parsed transactions.
 * Enables smart money tracking to understand the *type* of trade.
 */
export type ProgramType = 'raydium' | 'jupiter' | 'pump.fun' | 'unknown';

/**
 * Extended parsed transaction with program-aware classification.
 * Adds a `programType` field to the standard HeliusParsedTx interface
 * for enriched smart money analysis.
 */
export interface EnhancedParsedTx extends HeliusParsedTx {
  /** Classified program type based on the transaction source field */
  programType: ProgramType;
}

/**
 * Token metadata response from Helius Token Metadata API.
 * Contains on-chain and off-chain metadata for a Solana token.
 */
export interface HeliusTokenMetadata {
  /** Token mint address */
  account: string;
  /** On-chain metadata from the Metaplex Token Metadata program */
  onChainMetadata?: {
    /** Metadata account data */
    metadata?: {
      /** Token name from on-chain metadata */
      name?: string;
      /** Token ticker symbol */
      symbol?: string;
      /** URI pointing to off-chain metadata JSON (Arweave/IPFS) */
      uri?: string;
      /** Seller fee basis points (for NFTs) */
      sellerFeeBasisPoints?: number;
      /** Token standard (e.g., "Fungible", "NonFungible") */
      tokenStandard?: string;
      /** Update authority — can modify metadata (null = immutable) */
      updateAuthority?: string;
    };
    /** Mint account data */
    mint?: {
      /** Current mint authority address (null = revoked) */
      mintAuthority?: string | null;
      /** Current freeze authority address (null = revoked) */
      freezeAuthority?: string | null;
      /** Token supply in raw units */
      supply?: string;
      /** Token decimal places */
      decimals?: number;
    };
  };
  /** Off-chain metadata fetched from the URI */
  offChainMetadata?: {
    /** Token name from off-chain JSON */
    name?: string;
    /** Token symbol from off-chain JSON */
    symbol?: string;
    /** Token description */
    description?: string;
    /** Token logo image URL */
    image?: string;
    /** Additional metadata attributes */
    attributes?: Array<{ trait_type: string; value: string }>;
  };
  /** Helius-provided legacy token list data */
  legacyMetadata?: {
    /** Token logo URI from legacy token list */
    logoURI?: string;
    /** Token name from legacy token list */
    name?: string;
    /** Token symbol from legacy token list */
    symbol?: string;
  };
}

// =============================================================================
// HeliusClient Class
// =============================================================================

/**
 * Helius Enhanced Transactions API client for smart money wallet monitoring.
 *
 * Provides program-aware transaction parsing that distinguishes between
 * Raydium, Jupiter, and Pump.fun interactions — critical for understanding
 * *what* a smart money wallet did (swap, add liquidity, buy on curve, etc.).
 *
 * All requests are:
 *   1. Rate-limited via the centralized RateLimiter (10 RPS Helius Developer plan)
 *   2. Retried with exponential backoff via BaseClient (3 retries: 1s/2s/4s)
 *   3. Authenticated via URL query parameter `?api-key={apiKey}`
 *
 * @example
 * ```typescript
 * const helius = new HeliusClient('your-api-key');
 *
 * // Get enhanced transaction details
 * const tx = await helius.getEnhancedTransaction('5abc...');
 *
 * // Get parsed transaction with program classification
 * const parsed = await helius.parseTransaction('5abc...');
 * if (parsed.programType === 'jupiter') {
 *   // Smart money used Jupiter aggregator for this swap
 * }
 *
 * // Monitor wallet activity
 * const txs = await helius.getAddressTransactions('wallet123...');
 * ```
 */
export class HeliusClient {
  /** BaseClient instance configured with Helius API base URL */
  private readonly baseClient: BaseClient;

  /** Centralized rate limiter enforcing 10 RPS for Helius API */
  private readonly rateLimiter: RateLimiter;

  /** Structured logger with 'helius-api' context tag */
  private readonly logger: Logger;

  /** Decrypted API key (never logged, never exposed to content scripts) */
  private readonly apiKey: string;

  /**
   * Creates a new HeliusClient instance.
   *
   * @param apiKey - Decrypted Helius API key from the service worker's
   *   encrypted storage. This key is embedded in URL query parameters
   *   (`?api-key={apiKey}`) for all requests — NOT in headers.
   * @param rateLimiter - Optional pre-configured RateLimiter instance.
   *   If not provided, a new instance is created with default configs
   *   from RATE_LIMITS.HELIUS (10 RPS, burst 10).
   */
  constructor(apiKey: string, rateLimiter?: RateLimiter) {
    this.apiKey = apiKey;
    this.logger = createLogger('helius-api');

    // Initialize BaseClient with Helius base URL — no default auth headers
    // since Helius authenticates via URL query params, not headers
    this.baseClient = new BaseClient(API_BASE_URLS.HELIUS, {
      loggerContext: 'helius-api',
    });

    // Use provided rate limiter or create a new one with Helius config
    this.rateLimiter = rateLimiter ?? new RateLimiter({
      helius: {
        requestsPerSecond: RATE_LIMITS.HELIUS.requestsPerSecond,
        burstSize: RATE_LIMITS.HELIUS.burstSize,
      },
    });

    this.logger.info('HeliusClient initialized', {
      baseUrl: API_BASE_URLS.HELIUS,
      rateLimit: `${RATE_LIMITS.HELIUS.requestsPerSecond} RPS`,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API Methods
  // ---------------------------------------------------------------------------

  /**
   * Retrieves enhanced transaction data for a single transaction signature.
   *
   * Uses Helius Enhanced Transactions API (POST /v0/transactions) which returns
   * richly parsed transaction data including:
   *   - Token transfers with amounts and directions
   *   - Program interactions (which DEX, which program)
   *   - Account balance changes
   *   - Human-readable descriptions
   *
   * Useful for understanding exactly what a smart money wallet did
   * (buy, sell, add liquidity, etc.).
   *
   * @param signature - Solana transaction signature (base58 encoded)
   * @returns Parsed transaction data, or null if the transaction was not found
   * @throws {ApiError} On rate limit, auth failure, or server error
   *
   * @example
   * ```typescript
   * const tx = await helius.getEnhancedTransaction('5abc...');
   * if (tx) {
   *   console.log(tx.description);      // "User swapped 100 SOL for 1M BONK"
   *   console.log(tx.source);           // "JUPITER"
   *   console.log(tx.tokenTransfers);   // [{ mint, amount, from, to }]
   * }
   * ```
   */
  async getEnhancedTransaction(signature: string): Promise<HeliusParsedTx | null> {
    this.logger.debug('getEnhancedTransaction called', { signature });

    try {
      // Enforce Helius 10 RPS rate limit before making the request
      await this.rateLimiter.acquire('helius');

      // Helius Enhanced Transactions API: POST with array of signatures
      const endpoint = this.buildAuthenticatedPath('/v0/transactions');

      const response = await this.baseClient.post<HeliusParsedTx[]>(
        endpoint,
        { transactions: [signature] },
      );

      // Helius returns an array — extract the first (and only) result
      if (!response || !Array.isArray(response) || response.length === 0) {
        this.logger.warn('No transaction data returned from Helius', { signature });
        return null;
      }

      const tx = response[0];
      this.logger.info('Enhanced transaction retrieved', {
        signature: tx.signature,
        type: tx.type,
        source: tx.source,
        fee: tx.fee,
      });

      return tx;
    } catch (error: unknown) {
      return this.handleError<HeliusParsedTx | null>('getEnhancedTransaction', error, null);
    }
  }

  /**
   * Retrieves on-chain and off-chain metadata for a Solana token.
   *
   * Uses Helius Token Metadata API (GET /v0/token-metadata) which returns:
   *   - Token name, symbol, logo URI
   *   - On-chain metadata (Metaplex Token Metadata program)
   *   - Update authority, mint authority, freeze authority
   *   - Off-chain metadata from Arweave/IPFS
   *
   * Useful for verifying token metadata and checking if authorities are revoked.
   *
   * @param mint - Token mint address (Solana base58 public key)
   * @returns Token metadata, or null if the token was not found
   * @throws {ApiError} On rate limit, auth failure, or server error
   *
   * @example
   * ```typescript
   * const metadata = await helius.getTokenMetadata('TokenMint123...');
   * if (metadata?.onChainMetadata?.mint?.mintAuthority === null) {
   *   console.log('Mint authority is revoked — safe');
   * }
   * ```
   */
  async getTokenMetadata(mint: string): Promise<HeliusTokenMetadata | null> {
    this.logger.debug('getTokenMetadata called', { mint });

    try {
      // Enforce rate limit
      await this.rateLimiter.acquire('helius');

      // Build GET endpoint with mint address as query parameter
      const endpoint = this.buildAuthenticatedPath(
        '/v0/token-metadata',
        { 'mint_accounts': mint },
      );

      const response = await this.baseClient.get<HeliusTokenMetadata[]>(endpoint);

      // Helius returns an array of metadata results
      if (!response || !Array.isArray(response) || response.length === 0) {
        this.logger.warn('No token metadata returned from Helius', { mint });
        return null;
      }

      const metadata = response[0];
      this.logger.info('Token metadata retrieved', {
        mint,
        name: metadata.onChainMetadata?.metadata?.name ?? metadata.legacyMetadata?.name ?? 'unknown',
        hasOffChain: !!metadata.offChainMetadata,
      });

      return metadata;
    } catch (error: unknown) {
      return this.handleError<HeliusTokenMetadata | null>('getTokenMetadata', error, null);
    }
  }

  /**
   * Retrieves and enriches a transaction with program-aware parsing.
   *
   * Similar to `getEnhancedTransaction` but adds a `programType` classification
   * field that identifies which DEX/protocol the transaction interacted with:
   *   - `'raydium'`  — Raydium AMM DEX swap/LP operations
   *   - `'jupiter'`  — Jupiter aggregator multi-hop swaps
   *   - `'pump.fun'` — Pump.fun bonding curve buy/sell
   *   - `'unknown'`  — Unrecognized or non-DEX transaction
   *
   * This enriched parsing enables smart money tracking to understand the *type*
   * of trade, not just the raw transfers.
   *
   * @param signature - Solana transaction signature (base58 encoded)
   * @returns Enhanced parsed transaction with program classification, or null
   * @throws {ApiError} On rate limit, auth failure, or server error
   *
   * @example
   * ```typescript
   * const parsed = await helius.parseTransaction('5abc...');
   * if (parsed?.programType === 'pump.fun') {
   *   // Smart money bought on pump.fun bonding curve
   * }
   * ```
   */
  async parseTransaction(signature: string): Promise<EnhancedParsedTx | null> {
    this.logger.debug('parseTransaction called', { signature });

    try {
      // Enforce rate limit
      await this.rateLimiter.acquire('helius');

      // Use the same Enhanced Transactions endpoint
      const endpoint = this.buildAuthenticatedPath('/v0/transactions');

      const response = await this.baseClient.post<HeliusParsedTx[]>(
        endpoint,
        { transactions: [signature] },
      );

      if (!response || !Array.isArray(response) || response.length === 0) {
        this.logger.warn('No transaction data for parsing', { signature });
        return null;
      }

      const tx = response[0];

      // Classify the transaction by its source program
      const programType = this.classifyProgramSource(tx.source);

      const enhancedTx: EnhancedParsedTx = {
        ...tx,
        programType,
      };

      this.logger.info('Transaction parsed with program classification', {
        signature: tx.signature,
        type: tx.type,
        source: tx.source,
        programType,
        tokenTransferCount: tx.tokenTransfers?.length ?? 0,
        nativeTransferCount: tx.nativeTransfers?.length ?? 0,
      });

      return enhancedTx;
    } catch (error: unknown) {
      return this.handleError<EnhancedParsedTx | null>('parseTransaction', error, null);
    }
  }

  /**
   * Retrieves recent parsed transactions for a specific wallet address.
   *
   * Uses Helius Address Transactions API (GET /v0/addresses/{address}/transactions)
   * which returns a list of enhanced parsed transactions for the wallet.
   *
   * Critical for monitoring smart money wallet activity — detects new buys, sells,
   * liquidity additions, and other on-chain actions by tracked wallets.
   *
   * @param address - Solana wallet address to query (base58 public key)
   * @param type - Optional filter by transaction type (e.g., "SWAP", "TRANSFER")
   * @param before - Optional pagination cursor — transaction signature to start
   *   fetching before (for backward pagination through history)
   * @returns Array of parsed transactions (may be empty)
   * @throws {ApiError} On rate limit, auth failure, or server error
   *
   * @example
   * ```typescript
   * // Get recent swaps by a smart money wallet
   * const txs = await helius.getAddressTransactions(
   *   'SmartWallet123...',
   *   'SWAP',
   * );
   * for (const tx of txs) {
   *   console.log(`${tx.type}: ${tx.description}`);
   * }
   * ```
   */
  async getAddressTransactions(
    address: string,
    type?: string,
    before?: string,
  ): Promise<HeliusParsedTx[]> {
    this.logger.debug('getAddressTransactions called', { address, type, before });

    try {
      // Enforce rate limit
      await this.rateLimiter.acquire('helius');

      // Build query parameters — only include defined values
      const queryParams: Record<string, string> = {};
      if (type) {
        queryParams['type'] = type;
      }
      if (before) {
        queryParams['before'] = before;
      }

      const endpoint = this.buildAuthenticatedPath(
        `/v0/addresses/${encodeURIComponent(address)}/transactions`,
        queryParams,
      );

      const response = await this.baseClient.get<HeliusParsedTx[]>(endpoint);

      // Validate response is an array
      if (!response || !Array.isArray(response)) {
        this.logger.warn('Invalid response format for address transactions', {
          address,
          responseType: typeof response,
        });
        return [];
      }

      this.logger.info('Address transactions retrieved', {
        address,
        count: response.length,
        type: type ?? 'all',
        oldestSlot: response.length > 0 ? response[response.length - 1].slot : undefined,
      });

      return response;
    } catch (error: unknown) {
      return this.handleError<HeliusParsedTx[]>('getAddressTransactions', error, []);
    }
  }

  // ---------------------------------------------------------------------------
  // Private Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Builds an authenticated API path by appending the API key as a query parameter.
   *
   * Helius uses API key in the URL (`?api-key={key}`) rather than in headers.
   * Additional query parameters are merged into the URL string.
   *
   * @param path - API endpoint path (e.g., '/v0/transactions')
   * @param additionalParams - Optional additional query parameters to include
   * @returns Full endpoint path with api-key and any additional query params
   */
  private buildAuthenticatedPath(
    path: string,
    additionalParams?: Record<string, string>,
  ): string {
    // Build the URL using BaseClient's buildUrl for consistent formatting,
    // then extract just the endpoint + query string portion
    const allParams: Record<string, string> = {
      'api-key': this.apiKey,
      ...(additionalParams ?? {}),
    };

    // Use BaseClient's buildUrl which handles the full URL construction
    // We need to construct the endpoint with query params
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(allParams)) {
      searchParams.set(key, value);
    }

    return `${normalizedPath}?${searchParams.toString()}`;
  }

  /**
   * Classifies a Helius transaction source string into a ProgramType.
   *
   * Helius returns a `source` field on parsed transactions that identifies
   * which program/protocol processed the transaction. This method maps
   * those identifiers to our simplified ProgramType enum.
   *
   * @param source - The `source` field from a HeliusParsedTx (e.g., "JUPITER", "RAYDIUM")
   * @returns Classified ProgramType: 'raydium' | 'jupiter' | 'pump.fun' | 'unknown'
   */
  private classifyProgramSource(source: string): ProgramType {
    if (!source) {
      return 'unknown';
    }

    const normalizedSource = source.toUpperCase().trim();

    if (normalizedSource === PROGRAM_SOURCES.JUPITER) {
      return 'jupiter';
    }

    if (normalizedSource === PROGRAM_SOURCES.RAYDIUM) {
      return 'raydium';
    }

    if (
      normalizedSource === PROGRAM_SOURCES.PUMP_FUN ||
      normalizedSource === PROGRAM_SOURCES.PUMP_DOT_FUN ||
      normalizedSource.includes('PUMP')
    ) {
      return 'pump.fun';
    }

    return 'unknown';
  }

  /**
   * Centralized error handler for all HeliusClient API methods.
   *
   * Classifies errors by type and logs appropriate messages without
   * ever exposing the API key. Returns the specified fallback value
   * for recoverable errors, and re-throws for critical failures.
   *
   * @typeParam T - The fallback return type
   * @param method - Name of the calling method (for log context)
   * @param error - The caught error (may be ApiError or generic Error)
   * @param fallback - Value to return for recoverable errors
   * @returns The fallback value for recoverable errors
   * @throws {ApiError} Re-throws auth failures (API key issues require user attention)
   */
  private handleError<T>(method: string, error: unknown, fallback: T): T {
    if (error instanceof ApiError) {
      const safeMessage = this.sanitizeErrorMessage(error.message);

      switch (error.errorType) {
        case 'rate-limited':
          this.logger.warn(`[${method}] Rate limited by Helius API (429)`, {
            status: error.status,
            errorType: error.errorType,
          });
          return fallback;

        case 'auth-failed':
          this.logger.error(
            `[${method}] Helius API authentication failed — check API key configuration`,
            { status: error.status, errorType: error.errorType },
          );
          // Re-throw auth failures — the caller (service worker) needs to
          // surface this to the user via the settings panel
          throw error;

        case 'not-found':
          this.logger.warn(`[${method}] Resource not found on Helius`, {
            status: error.status,
            message: safeMessage,
          });
          return fallback;

        case 'server-error':
          this.logger.error(`[${method}] Helius server error`, {
            status: error.status,
            message: safeMessage,
          });
          return fallback;

        case 'timeout':
          this.logger.warn(`[${method}] Helius request timed out`, {
            errorType: error.errorType,
          });
          return fallback;

        case 'network-error':
          this.logger.warn(`[${method}] Network error connecting to Helius`, {
            errorType: error.errorType,
          });
          return fallback;

        case 'parse-error':
          this.logger.error(`[${method}] Failed to parse Helius response`, {
            errorType: error.errorType,
            message: safeMessage,
          });
          return fallback;

        default:
          this.logger.error(`[${method}] Unexpected Helius API error`, {
            status: error.status,
            errorType: error.errorType,
            message: safeMessage,
          });
          return fallback;
      }
    }

    // Non-ApiError (unexpected exceptions)
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.logger.error(`[${method}] Unexpected error in HeliusClient`, {
      error: this.sanitizeErrorMessage(errorMessage),
    });
    return fallback;
  }

  /**
   * Sanitizes error messages to prevent API key leakage.
   *
   * Replaces any occurrence of the API key in error messages with a
   * redacted placeholder. This prevents sensitive credentials from
   * appearing in logs, error reports, or console output.
   *
   * @param message - The raw error message that may contain the API key
   * @returns Sanitized message with API key redacted
   */
  private sanitizeErrorMessage(message: string): string {
    if (!this.apiKey || this.apiKey.length === 0) {
      return message;
    }

    // Replace any occurrence of the API key with a redacted placeholder
    return message.replaceAll(this.apiKey, '[REDACTED_API_KEY]');
  }
}
