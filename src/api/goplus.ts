/**
 * src/api/goplus.ts — GoPlus Security API Client
 *
 * Provides the GoPlusClient class for querying the GoPlus Security API to
 * retrieve token security analysis data for Solana tokens. GoPlus is a free,
 * unauthenticated API that returns mint/freeze authority status, holder
 * concentration, LP lock/burn status, and other contract security metadata.
 *
 * Per AAP Section 0.5.1 Group 4:
 *   "GoPlus Security client; method: getTokenSecurity(address) via
 *    /api/v1/solana/token_security; returns parsed is_mintable, is_freezable,
 *    LP locked status, holder concentration; no auth (free)"
 *
 * Per AAP Section 0.7.3:
 *   "Concurrent safety checks: RugCheck and GoPlus must be called concurrently
 *    via Promise.allSettled, not sequentially — both results are merged with
 *    worst-case-wins logic"
 *
 * Per AAP Section 0.4.6:
 *   "GoPlus → src/api/goplus.ts → checker.ts → safety-score.ts. Trigger:
 *    Concurrent with RugCheck for every new token. Rate limit: Best-effort,
 *    free tier."
 *
 * CRITICAL — GoPlus returns string booleans ('0'/'1'), NOT native booleans.
 * All parsers in this module convert to proper TypeScript booleans.
 *
 * @module api/goplus
 */

import { BaseClient, ApiError } from './base-client';
import { RateLimiter } from './rate-limiter';
import type { GoPlusResult, GoPlusHolder, GoPlusLPHolder } from './types';
import { API_BASE_URLS, SOLANA } from '../utils/config';
import { createLogger, type Logger } from '../utils/logger';

// =============================================================================
// Section 1: GoPlus Raw API Response Types
// =============================================================================

/**
 * Raw GoPlus API response envelope.
 * GoPlus wraps all responses in a standard envelope with `code` and `result`.
 */
interface RawGoPlusResponse {
  /** GoPlus status code. 1 = success, other values indicate error. */
  code: number;
  /** Status message. 'OK' on success. */
  message: string;
  /** Result map keyed by lowercased contract address. */
  result: Record<string, RawGoPlusTokenData>;
}

/**
 * Raw GoPlus token security data before parsing.
 *
 * CRITICAL: GoPlus returns ALL boolean fields as string '0' or '1',
 * NOT native booleans. The parser must convert them.
 *
 * Field names use GoPlus's original snake_case naming convention.
 */
interface RawGoPlusTokenData {
  /** '0' = cannot mint, '1' = can mint new tokens */
  is_mintable?: string;
  /** '0' = not freezable, '1' = accounts can be frozen (GoPlus may use `can_take_back_ownership`) */
  can_take_back_ownership?: string;
  /** Freeze authority check. Some responses may report this directly. */
  is_freezable?: string;
  /** '0' = closed source, '1' = open/verified source (often not applicable to Solana) */
  is_open_source?: string;
  /** Number of token holders */
  holder_count?: string;
  /** Total supply as string for precision */
  total_supply?: string;
  /** Array of top holder objects with address, balance, percent, is_contract, tag */
  holders?: RawGoPlusHolder[];
  /** LP holder information (who holds the liquidity pool tokens) */
  lp_holders?: RawGoPlusLPHolder[];
  /** Total LP token supply as string */
  lp_total_supply?: string;
  /** '0' = LP not locked, '1' = LP locked */
  is_in_dex?: string;
  /** Creator/deployer wallet address */
  creator_address?: string;
  /** Token authority owner address */
  owner_address?: string;
  /** Additional undocumented fields GoPlus may return */
  [key: string]: unknown;
}

/**
 * Raw holder entry from GoPlus API response.
 */
interface RawGoPlusHolder {
  address?: string;
  balance?: string;
  percent?: string;
  is_contract?: number;
  tag?: string;
  is_locked?: number;
}

/**
 * Raw LP holder entry from GoPlus API response.
 */
interface RawGoPlusLPHolder {
  address?: string;
  balance?: string;
  percent?: string;
  tag?: string;
  is_locked?: number;
  NFT_list?: unknown[];
}

// =============================================================================
// Section 2: Constants
// =============================================================================

/** GoPlus Solana token security endpoint path */
const SOLANA_SECURITY_ENDPOINT = '/api/v1/solana/token_security';

/**
 * Maximum addresses per batch request.
 * GoPlus has practical limits on URL length; keep batches manageable.
 */
const MAX_BATCH_SIZE = 20;

// =============================================================================
// Section 3: GoPlusClient Class
// =============================================================================

/**
 * Client for the GoPlus Security API.
 *
 * Queries the GoPlus free-tier API for Solana token security analysis:
 * - Mint/freeze authority status
 * - Holder concentration and distribution
 * - LP lock/burn verification
 * - Creator and owner wallet identification
 *
 * No API key is required — GoPlus Security is a free, unauthenticated service.
 * All requests are rate-limited at 5 RPS (conservative for free tier) and
 * routed through the centralized RateLimiter with 'high' priority since
 * safety checks are critical per AAP Section 0.7.4.
 *
 * @example
 * ```typescript
 * import { GoPlusClient } from '@/api/goplus';
 * import { defaultRateLimiter } from '@/api/rate-limiter';
 *
 * const client = new GoPlusClient(defaultRateLimiter);
 * const result = await client.getTokenSecurity('TokenMintAddress...');
 * console.log(result.isMintable, result.isFreezable, result.top10HolderPercent);
 * ```
 */
export class GoPlusClient {
  /** BaseClient configured with the GoPlus API base URL and no auth headers. */
  private readonly baseClient: BaseClient;

  /** Rate limiter for enforcing 5 RPS on the GoPlus free tier. */
  private readonly rateLimiter: RateLimiter;

  /** Structured logger with 'goplus-api' context tag. */
  private readonly logger: Logger;

  /**
   * Creates a new GoPlusClient instance.
   *
   * No API key is required — GoPlus Security is a free service.
   * The rate limiter should be the shared application-wide instance
   * (defaultRateLimiter) to coordinate with other API clients.
   *
   * @param rateLimiter - Shared rate limiter instance for coordinated throttling.
   *   Defaults to a new RateLimiter instance if not provided.
   */
  constructor(rateLimiter?: RateLimiter) {
    this.baseClient = new BaseClient(API_BASE_URLS.GOPLUS, {
      loggerContext: 'goplus-api',
    });
    this.rateLimiter = rateLimiter ?? new RateLimiter();
    this.logger = createLogger('goplus-api');

    this.logger.info(
      `GoPlusClient initialized — base URL: ${API_BASE_URLS.GOPLUS}, no authentication`,
    );
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Retrieves token security analysis for a single Solana token address.
   *
   * Calls the GoPlus Solana token security endpoint, parses the raw
   * string-boolean response into typed GoPlusResult fields, and computes
   * derived metrics (top 10 holder concentration, largest holder percentage,
   * LP lock/burn status).
   *
   * Fail-safe: If the API is unavailable, returns an "unsafe" default result
   * per AAP worst-case-wins policy.
   *
   * @param address - Solana token mint address to analyze
   * @returns Parsed GoPlusResult with boolean security fields and computed metrics
   */
  async getTokenSecurity(address: string): Promise<GoPlusResult> {
    const normalizedAddress = address.trim();
    if (!normalizedAddress) {
      this.logger.warn('getTokenSecurity called with empty address, returning unsafe default');
      return this.createUnsafeDefault(address);
    }

    try {
      // Acquire rate limit token with 'high' priority for safety-critical checks
      await this.rateLimiter.acquire('goplus', 'high');

      // Build the endpoint URL with the contract address as query parameter
      const endpoint = `${SOLANA_SECURITY_ENDPOINT}?contract_addresses=${encodeURIComponent(normalizedAddress)}`;

      // Log the full URL for debugging using buildUrl
      const fullUrl = this.baseClient.buildUrl(endpoint);
      this.logger.debug(`Fetching token security: ${fullUrl}`);

      // Execute the GET request via BaseClient (includes retry + timeout)
      const rawResponse = await this.baseClient.get<RawGoPlusResponse>(endpoint);

      // Validate the response envelope
      if (!rawResponse || rawResponse.code !== 1 || !rawResponse.result) {
        this.logger.warn(
          `GoPlus returned non-success response for ${normalizedAddress}`,
          { code: rawResponse?.code, message: rawResponse?.message },
        );
        return this.createUnsafeDefault(normalizedAddress);
      }

      // GoPlus keys results by lowercased contract address
      const resultData = rawResponse.result[normalizedAddress.toLowerCase()];

      if (!resultData) {
        this.logger.warn(
          `GoPlus returned no data for address ${normalizedAddress} — token may not be indexed`,
        );
        return this.createUnsafeDefault(normalizedAddress);
      }

      // Parse the raw response into a typed GoPlusResult
      const parsed = this.parseTokenData(normalizedAddress, resultData);

      this.logger.info(
        `Token security fetched for ${normalizedAddress}: ` +
        `mintable=${parsed.isMintable}, freezable=${parsed.isFreezable}, ` +
        `top10=${parsed.top10HolderPercent.toFixed(1)}%, lpLocked=${parsed.isLpLocked}`,
      );

      return parsed;
    } catch (error: unknown) {
      // Handle specific API errors
      if (error instanceof ApiError) {
        this.logger.error(
          `GoPlus API error for ${normalizedAddress}: ` +
          `HTTP ${error.status} (${error.errorType}), retryable=${error.retryable}`,
        );
      } else if (error instanceof Error) {
        this.logger.error(
          `GoPlus request failed for ${normalizedAddress}: ${error.message}`,
        );
      } else {
        this.logger.error(
          `GoPlus unknown error for ${normalizedAddress}`,
          error,
        );
      }

      // Fail-safe: return unsafe default on any error (worst-case-wins per AAP)
      return this.createUnsafeDefault(normalizedAddress);
    }
  }

  /**
   * Retrieves token security analysis for multiple Solana token addresses in
   * a single API call. More efficient than calling getTokenSecurity individually
   * for batch safety checks.
   *
   * GoPlus supports comma-separated addresses in a single request:
   *   GET /api/v1/solana/token_security?contract_addresses=addr1,addr2,...
   *
   * Addresses that fail to return data receive unsafe defaults.
   *
   * @param addresses - Array of Solana token mint addresses to analyze
   * @returns Map of address → GoPlusResult for each requested address
   */
  async getTokenSecurityBatch(
    addresses: string[],
  ): Promise<Map<string, GoPlusResult>> {
    const results = new Map<string, GoPlusResult>();

    if (!addresses || addresses.length === 0) {
      this.logger.warn('getTokenSecurityBatch called with empty addresses array');
      return results;
    }

    // Deduplicate and normalize addresses
    const normalizedAll = addresses.map((addr) => addr.trim()).filter(Boolean);
    const uniqueAddresses = normalizedAll.filter(
      (addr, index) => normalizedAll.indexOf(addr) === index,
    );

    if (uniqueAddresses.length === 0) {
      this.logger.warn('getTokenSecurityBatch: all addresses were empty after normalization');
      return results;
    }

    // Process in chunks to respect URL length limits
    const chunks = this.chunkArray(uniqueAddresses, MAX_BATCH_SIZE);

    this.logger.info(
      `Batch security check: ${uniqueAddresses.length} addresses in ${chunks.length} chunk(s)`,
    );

    for (const chunk of chunks) {
      try {
        // Acquire rate limit token with 'high' priority for safety-critical checks
        await this.rateLimiter.acquire('goplus', 'high');

        // Join addresses with commas for the batch endpoint
        const addressParam = chunk
          .map((addr) => encodeURIComponent(addr))
          .join(',');
        const endpoint = `${SOLANA_SECURITY_ENDPOINT}?contract_addresses=${addressParam}`;

        // Log the full URL for debugging using buildUrl
        const fullUrl = this.baseClient.buildUrl(endpoint);
        this.logger.debug(`Batch fetching token security: ${fullUrl}`);

        const rawResponse = await this.baseClient.get<RawGoPlusResponse>(endpoint);

        // Validate the response envelope
        if (!rawResponse || rawResponse.code !== 1 || !rawResponse.result) {
          this.logger.warn(
            `GoPlus batch returned non-success response`,
            { code: rawResponse?.code, message: rawResponse?.message },
          );
          // Fill all addresses in this chunk with unsafe defaults
          for (const addr of chunk) {
            results.set(addr, this.createUnsafeDefault(addr));
          }
          continue;
        }

        // Parse each result from the response map
        for (const addr of chunk) {
          const resultData = rawResponse.result[addr.toLowerCase()];

          if (!resultData) {
            this.logger.warn(
              `GoPlus batch: no data for ${addr} — applying unsafe default`,
            );
            results.set(addr, this.createUnsafeDefault(addr));
          } else {
            results.set(addr, this.parseTokenData(addr, resultData));
          }
        }

        this.logger.info(
          `Batch chunk completed: ${chunk.length} addresses processed`,
        );
      } catch (error: unknown) {
        // On chunk failure, apply unsafe defaults for all addresses in this chunk
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `GoPlus batch chunk failed: ${errorMsg} — applying unsafe defaults for ${chunk.length} addresses`,
        );

        for (const addr of chunk) {
          if (!results.has(addr)) {
            results.set(addr, this.createUnsafeDefault(addr));
          }
        }
      }
    }

    return results;
  }

  // ===========================================================================
  // Private — Response Parsing
  // ===========================================================================

  /**
   * Parses raw GoPlus token data into a typed GoPlusResult.
   *
   * Handles the critical string-to-boolean conversion for GoPlus's
   * '0'/'1' string booleans, parses holder arrays, and computes
   * derived concentration and LP metrics.
   *
   * @param address - Original token address (preserved as-is in the result)
   * @param raw - Raw GoPlus token data with string booleans
   * @returns Fully typed GoPlusResult with proper booleans and computed metrics
   */
  private parseTokenData(address: string, raw: RawGoPlusTokenData): GoPlusResult {
    // Parse top holders into typed array
    const topHolders = this.parseHolders(raw.holders);

    // Parse LP holders into typed array
    const lpHolders = this.parseLPHolders(raw.lp_holders);

    // Compute holder concentration metrics
    const { top10Percent, largestPercent } = this.computeHolderConcentration(topHolders);

    // Determine LP lock status from LP holder data
    const isLpLocked = this.determineLPLockStatus(lpHolders);

    // Determine freezable status — GoPlus may use different field names
    const isFreezable = this.parseStringBoolean(raw.can_take_back_ownership) ||
      this.parseStringBoolean(raw.is_freezable);

    return {
      tokenAddress: address,
      isMintable: this.parseStringBoolean(raw.is_mintable),
      isFreezable,
      isOpenSource: this.parseStringBoolean(raw.is_open_source),
      holderCount: this.parseNumber(raw.holder_count, 0),
      totalSupply: raw.total_supply ?? '0',
      topHolders,
      lpHolders,
      lpTotalSupply: raw.lp_total_supply ?? '0',
      isLpLocked,
      creatorAddress: raw.creator_address ?? '',
      ownerAddress: raw.owner_address ?? '',
      top10HolderPercent: top10Percent,
      largestHolderPercent: largestPercent,
    };
  }

  /**
   * Parses an array of raw GoPlus holder entries into typed GoPlusHolder objects.
   *
   * Handles missing fields gracefully with safe defaults. GoPlus returns
   * `is_contract` as an integer (0 or 1), which is converted to boolean.
   *
   * @param rawHolders - Raw holder array from GoPlus response, or undefined
   * @returns Array of typed GoPlusHolder objects
   */
  private parseHolders(rawHolders?: RawGoPlusHolder[]): GoPlusHolder[] {
    if (!rawHolders || !Array.isArray(rawHolders)) {
      return [];
    }

    return rawHolders
      .filter((h) => h && typeof h === 'object')
      .map((h) => ({
        address: h.address ?? '',
        balance: h.balance ?? '0',
        percent: h.percent ?? '0',
        isContract: h.is_contract === 1,
        tag: h.tag,
      }));
  }

  /**
   * Parses an array of raw GoPlus LP holder entries into typed GoPlusLPHolder objects.
   *
   * LP holders represent who owns the liquidity pool tokens. The `is_locked`
   * field indicates whether their LP tokens are locked in a vesting contract.
   *
   * @param rawLPHolders - Raw LP holder array from GoPlus response, or undefined
   * @returns Array of typed GoPlusLPHolder objects
   */
  private parseLPHolders(rawLPHolders?: RawGoPlusLPHolder[]): GoPlusLPHolder[] {
    if (!rawLPHolders || !Array.isArray(rawLPHolders)) {
      return [];
    }

    return rawLPHolders
      .filter((h) => h && typeof h === 'object')
      .map((h) => ({
        address: h.address ?? '',
        balance: h.balance ?? '0',
        percent: h.percent ?? '0',
        isLocked: h.is_locked === 1,
        tag: h.tag,
      }));
  }

  /**
   * Computes holder concentration metrics from the parsed top holders array.
   *
   * Per AAP hard filters:
   *   - "top 10 holders >50%" = hard filter fail
   * Per AAP safety score:
   *   - "top holder concentration ≤20%" for high safety score
   *
   * @param holders - Parsed array of GoPlusHolder objects
   * @returns Object with top10Percent (sum of top 10) and largestPercent (single largest)
   */
  private computeHolderConcentration(
    holders: GoPlusHolder[],
  ): { top10Percent: number; largestPercent: number } {
    if (!holders || holders.length === 0) {
      // No holder data available — return pessimistic defaults
      // (assume worst-case per fail-safe policy)
      return { top10Percent: 100, largestPercent: 100 };
    }

    // Sort holders by percentage descending to identify top 10
    const sortedHolders = [...holders].sort((a, b) => {
      const aPercent = this.parsePercentString(a.percent);
      const bPercent = this.parsePercentString(b.percent);
      return bPercent - aPercent;
    });

    // Compute sum of top 10 holder percentages
    const top10 = sortedHolders.slice(0, 10);
    const top10Percent = top10.reduce(
      (sum, h) => sum + this.parsePercentString(h.percent),
      0,
    );

    // Identify the single largest holder
    const largestPercent = sortedHolders.length > 0
      ? this.parsePercentString(sortedHolders[0].percent)
      : 100; // Pessimistic default

    return {
      top10Percent: Math.min(top10Percent, 100), // Cap at 100%
      largestPercent: Math.min(largestPercent, 100),
    };
  }

  /**
   * Determines whether LP (Liquidity Pool) tokens are locked or burned.
   *
   * Checks two conditions:
   * 1. Whether any LP holder has `isLocked === true` (tokens in a locking contract)
   * 2. Whether the Solana burn address holds LP tokens (LP burned permanently)
   *
   * Per AAP hard filters:
   *   - "no LP lock/burn" = hard filter fail
   *
   * @param lpHolders - Parsed array of GoPlusLPHolder objects
   * @returns true if LP is either locked or burned; false otherwise
   */
  private determineLPLockStatus(lpHolders: GoPlusLPHolder[]): boolean {
    if (!lpHolders || lpHolders.length === 0) {
      // No LP holder data — conservatively report as not locked
      return false;
    }

    // Check if any LP holder has the isLocked flag set
    const hasLockedHolder = lpHolders.some((h) => h.isLocked);

    // Check if the Solana burn address holds LP tokens (LP burned)
    const burnAddress = SOLANA.LP_BURN_ADDRESS;
    const hasBurnedLP = lpHolders.some(
      (h) =>
        h.address.toLowerCase() === burnAddress.toLowerCase() &&
        this.parsePercentString(h.percent) > 0,
    );

    return hasLockedHolder || hasBurnedLP;
  }

  // ===========================================================================
  // Private — Parsing Utilities
  // ===========================================================================

  /**
   * Converts a GoPlus string boolean ('0'/'1') to a native boolean.
   *
   * CRITICAL: GoPlus returns '0'/'1' strings, NOT native booleans.
   * This method handles the conversion safely with a default of `false`
   * for missing or unexpected values.
   *
   * Fail-safe behavior: unknown/missing values default to the SAFER
   * assumption (false = not risky), EXCEPT when used in fail-safe defaults
   * where the caller explicitly sets unsafe values.
   *
   * @param value - Raw GoPlus string value: '0', '1', or undefined
   * @returns true if value === '1'; false otherwise
   */
  private parseStringBoolean(value: unknown): boolean {
    if (value === '1' || value === 1) {
      return true;
    }
    return false;
  }

  /**
   * Parses a GoPlus percentage string into a number.
   *
   * GoPlus returns holder percentages as strings like '0.05' (meaning 5%).
   * Some fields may be decimal fractions (0.0 to 1.0) or percentages (0 to 100).
   * We normalize to percentage (0 to 100).
   *
   * @param value - String percentage from GoPlus (e.g., '0.05' for 5%)
   * @returns Numeric percentage value (0–100)
   */
  private parsePercentString(value: string): number {
    const parsed = parseFloat(value);
    if (isNaN(parsed)) {
      return 0;
    }

    // GoPlus returns percentages as decimals (0.05 = 5%)
    // If the value is between 0 and 1 (exclusive of 1), assume it's a fraction
    // and convert to percentage. If it's >= 1, assume it's already a percentage.
    if (parsed >= 0 && parsed <= 1) {
      return parsed * 100;
    }

    return Math.max(0, parsed);
  }

  /**
   * Parses a string or unknown value into a number with a default fallback.
   *
   * @param value - Value to parse (string, number, or undefined)
   * @param defaultValue - Fallback value when parsing fails
   * @returns Parsed number or the default
   */
  private parseNumber(value: unknown, defaultValue: number): number {
    if (typeof value === 'number' && !isNaN(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      if (!isNaN(parsed)) {
        return parsed;
      }
    }
    return defaultValue;
  }

  // ===========================================================================
  // Private — Fail-Safe Defaults
  // ===========================================================================

  /**
   * Creates an "unsafe" default GoPlusResult for when the API is unavailable
   * or returns no data for a token address.
   *
   * Per AAP worst-case-wins policy:
   *   "If GoPlus is unavailable, return an 'unsafe' default result"
   *
   * All security flags are set to their most conservative (risky) values:
   * - isMintable: true (assume tokens can be minted — risky)
   * - isFreezable: true (assume accounts can be frozen — risky)
   * - top10HolderPercent: 100 (assume maximum concentration — risky)
   * - isLpLocked: false (assume LP is not locked — risky)
   *
   * This ensures that tokens with no GoPlus data are treated as potentially
   * unsafe and must pass other safety checks before being scored.
   *
   * @param address - Token address for the default result
   * @returns GoPlusResult with worst-case-wins default values
   */
  private createUnsafeDefault(address: string): GoPlusResult {
    this.logger.warn(
      `Creating unsafe default GoPlusResult for ${address} — worst-case-wins policy`,
    );

    return {
      tokenAddress: address,
      isMintable: true,
      isFreezable: true,
      isOpenSource: false,
      holderCount: 0,
      totalSupply: '0',
      topHolders: [],
      lpHolders: [],
      lpTotalSupply: '0',
      isLpLocked: false,
      creatorAddress: '',
      ownerAddress: '',
      top10HolderPercent: 100,
      largestHolderPercent: 100,
    };
  }

  // ===========================================================================
  // Private — Utility Helpers
  // ===========================================================================

  /**
   * Splits an array into chunks of a specified maximum size.
   *
   * Used for batch requests to prevent URL length limits from being exceeded.
   *
   * @param array - Array to chunk
   * @param size - Maximum size per chunk
   * @returns Array of chunked sub-arrays
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}
