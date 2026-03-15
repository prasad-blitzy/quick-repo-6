/**
 * src/api/rugcheck.ts — RugCheck REST API Client
 *
 * Production-grade REST client for the RugCheck token safety analysis API.
 * Provides comprehensive token safety reports, insider trading graph data,
 * and wallet risk ratings for the GMGN Signal Bot Chrome Extension.
 *
 * This module is a critical component in the safety analysis pipeline:
 *   src/api/rugcheck.ts → src/safety/checker.ts → src/signals/factors/safety-score.ts
 *
 * Key design decisions:
 *   - Fail-safe defaults: If RugCheck is unavailable, methods return null to
 *     signal the caller (src/safety/checker.ts) to assume the token is unsafe
 *     per the worst-case-wins policy (AAP Section 0.7.3)
 *   - High-priority rate limiting: Safety checks receive 'high' priority in the
 *     rate limiter queue since they are called concurrently with GoPlus via
 *     Promise.allSettled (AAP Section 0.7.3)
 *   - Conservative 5 RPS rate limit despite no documented strict limit
 *   - API key authentication via X-API-KEY header (never exposed to content scripts)
 *
 * Per AAP Section 0.5.1 Group 4:
 *   "RugCheck REST client; methods: getTokenReport(mint) via /tokens/{id}/report,
 *    getInsiderGraph(mint) via /tokens/{id}/insiders/graph; auth via X-API-KEY header"
 *
 * Per AAP Section 0.7.3:
 *   "Concurrent safety checks: RugCheck and GoPlus must be called concurrently
 *    via Promise.allSettled, not sequentially"
 *
 * @module api/rugcheck
 */

import { BaseClient, ApiError } from './base-client';
import { RateLimiter } from './rate-limiter';
import type {
  RugCheckReport,
  RugCheckRisk,
  RugCheckHolder,
  RugCheckMarket,
} from './types';
import { API_BASE_URLS } from '../utils/config';
import { createLogger, type Logger } from '../utils/logger';

// =============================================================================
// Section 1: Response Type Definitions for Insider Graph and Wallet Risk
// =============================================================================

/**
 * Insider trading graph data from RugCheck's insider analysis endpoint.
 *
 * Reveals connected wallets, funding paths, and bundle detection — wallets
 * funded from the same source that may indicate coordinated activity.
 *
 * Used by src/signals/hard-filters.ts to detect bundled launches with
 * >10% sniper supply (hard filter fail per AAP).
 */
export interface InsiderGraphData {
  /** Token mint address analyzed */
  mint: string;
  /** Array of graph nodes representing individual wallets */
  nodes: InsiderNode[];
  /** Array of edges representing funding/transfer connections between wallets */
  edges: InsiderEdge[];
  /** Total number of insider wallets detected */
  insiderCount: number;
  /** Percentage of total supply held by detected insiders (0–100) */
  insiderHoldingPercent: number;
  /** Whether a coordinated bundle (same funding source) was detected */
  bundleDetected: boolean;
  /** Percentage of supply acquired by snipers in the first block(s) (0–100) */
  sniperSupplyPercent: number;
}

/**
 * Individual node in the insider trading graph representing a wallet.
 */
export interface InsiderNode {
  /** Wallet address (Solana base58 public key) */
  address: string;
  /** Classification of the wallet's role */
  type: 'creator' | 'insider' | 'sniper' | 'whale' | 'normal';
  /** Token balance held by this wallet */
  balance: number;
  /** Percentage of total supply held (0–100) */
  percentage: number;
  /** Whether this wallet was funded by the token creator */
  fundedByCreator: boolean;
}

/**
 * Edge connecting two wallets in the insider graph, representing a
 * fund transfer or token transfer relationship.
 */
export interface InsiderEdge {
  /** Source wallet address (sender) */
  from: string;
  /** Target wallet address (receiver) */
  to: string;
  /** Type of relationship between wallets */
  type: 'funding' | 'token_transfer' | 'sol_transfer';
  /** Amount transferred (SOL or token units depending on type) */
  amount: number;
  /** Transaction signature for the transfer */
  signature?: string;
}

/**
 * Wallet risk rating from RugCheck's wallet risk analysis endpoint.
 *
 * Provides supplementary data for smart money wallet classification,
 * complementing the primary classification from GMGN's categorization data.
 */
export interface WalletRiskRating {
  /** Wallet address analyzed */
  address: string;
  /** Risk score (0–100, lower = safer) */
  riskScore: number;
  /** Human-readable risk level classification */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** Number of tokens created by this wallet */
  tokensCreated: number;
  /** Number of those tokens that were identified as rugs */
  rugCount: number;
  /** Historical rug rate percentage (0–100) */
  rugRate: number;
  /** Whether this wallet is flagged as a known scammer */
  isKnownScammer: boolean;
  /** Array of specific risk factors identified */
  riskFactors: string[];
}

// =============================================================================
// Section 3: RugCheckClient Class
// =============================================================================

/**
 * Production-grade REST API client for RugCheck token safety analysis.
 *
 * Provides three primary methods:
 *   - `getTokenReport(mint)`:       Comprehensive token safety report
 *   - `getInsiderGraph(mint)`:      Insider trading graph and bundle detection
 *   - `getWalletRiskRating(address)`: Wallet risk score and history
 *
 * All methods:
 *   - Acquire a rate limit token (5 RPS, 'high' priority) before each request
 *   - Authenticate via `X-API-KEY` header
 *   - Return `null` on failure instead of throwing (fail-safe pipeline design)
 *   - Log all requests, responses, and errors with structured context
 *
 * @example
 * ```typescript
 * const client = new RugCheckClient(decryptedApiKey);
 *
 * // Get token safety report (returns null on failure)
 * const report = await client.getTokenReport('So11111...');
 * if (report && report.score >= 300) {
 *   console.log('Token passes safety threshold');
 * }
 *
 * // Check insider trading patterns
 * const graph = await client.getInsiderGraph('So11111...');
 * if (graph && graph.sniperSupplyPercent > 10) {
 *   console.log('Hard filter: bundled launch detected');
 * }
 * ```
 */
export class RugCheckClient {
  /** HTTP client configured with RugCheck base URL and auth headers */
  private readonly baseClient: BaseClient;

  /** Token bucket rate limiter for enforcing 5 RPS limit */
  private readonly rateLimiter: RateLimiter;

  /** Structured logger with 'rugcheck-api' context tag */
  private readonly logger: Logger;

  /** Encrypted API key for X-API-KEY header authentication */
  private readonly apiKey: string;

  /**
   * Creates a new RugCheckClient instance.
   *
   * Initializes the HTTP client with the RugCheck base URL from the
   * centralized config, sets up X-API-KEY authentication headers,
   * and creates a rate limiter with conservative 5 RPS settings.
   *
   * @param apiKey - Decrypted RugCheck API key (from encrypted chrome.storage.local).
   *   This key is used in the X-API-KEY header for all requests.
   *   MUST only be called from the service worker context — never from content scripts.
   * @param rateLimiter - Optional pre-configured RateLimiter instance.
   *   If not provided, a new RateLimiter with default settings is created.
   *   Pass a shared instance to coordinate rate limiting across all API clients.
   */
  constructor(apiKey: string, rateLimiter?: RateLimiter) {
    this.apiKey = apiKey;
    this.logger = createLogger('rugcheck-api');

    // Initialize BaseClient with RugCheck base URL and X-API-KEY auth header
    this.baseClient = new BaseClient(API_BASE_URLS.RUGCHECK, {
      defaultHeaders: {
        'X-API-KEY': apiKey,
        Accept: 'application/json',
      },
      loggerContext: 'rugcheck-http',
    });

    // Use provided rate limiter or create a new one with default config
    this.rateLimiter = rateLimiter ?? new RateLimiter();

    this.logger.info('RugCheckClient initialized', {
      baseUrl: API_BASE_URLS.RUGCHECK,
      hasApiKey: apiKey.length > 0,
    });
  }

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Retrieves a comprehensive token safety report from RugCheck.
   *
   * This is the primary method used by the safety analysis pipeline
   * (src/safety/checker.ts) to evaluate token risk. The report includes:
   *   - Safety score (≥300 = passes AAP safety threshold)
   *   - Risk factors with severity levels
   *   - Mint/freeze authority status
   *   - Top holder concentration data
   *   - LP lock/burn status
   *   - Token-2022 extension detection
   *   - Market/pool information
   *
   * Called concurrently with GoPlus via Promise.allSettled in the safety
   * checker, so this method never throws — it returns null on failure.
   *
   * @param mint - Solana token mint address (base58 public key)
   * @returns Parsed RugCheckReport on success, or null if the token is not
   *   indexed, the API is unavailable, or an unrecoverable error occurs.
   *   Callers should treat null as "token is unsafe" per fail-safe policy.
   *
   * @example
   * ```typescript
   * const report = await client.getTokenReport('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
   * if (report) {
   *   console.log(`Safety score: ${report.score}`);
   *   console.log(`Mintable: ${report.isMintable}`);
   *   console.log(`LP burned: ${report.lpBurned} (${report.lpBurnPercentage}%)`);
   * }
   * ```
   */
  async getTokenReport(mint: string): Promise<RugCheckReport | null> {
    const endpoint = `/v1/tokens/${encodeURIComponent(mint)}/report`;
    const fullUrl = this.baseClient.buildUrl(endpoint);
    this.logger.debug(`Fetching token report for mint: ${mint}`, { url: fullUrl });

    try {
      // Acquire rate limit token with 'high' priority (safety-critical)
      await this.rateLimiter.acquire('rugcheck', 'high');

      // Make the API request — BaseClient handles retry and timeout
      const rawResponse = await this.baseClient.get<Record<string, unknown>>(
        endpoint,
      );

      // Parse the raw response into a typed RugCheckReport
      const report = this.parseTokenReport(mint, rawResponse);

      this.logger.info(`Token report retrieved for ${mint}`, {
        score: report.score,
        risksCount: report.risks.length,
        isMintable: report.isMintable,
        isFreezable: report.isFreezable,
        lpBurned: report.lpBurned,
        isToken2022: report.isToken2022,
        totalMarketLiquidity: report.totalMarketLiquidity,
      });

      return report;
    } catch (error: unknown) {
      return this.handleError<RugCheckReport | null>(
        error,
        'getTokenReport',
        mint,
        null,
      );
    }
  }

  /**
   * Retrieves the insider trading graph for a token from RugCheck.
   *
   * The insider graph reveals:
   *   - Connected wallets funded from the same source (bundle detection)
   *   - Funding paths between wallets (coordinated activity)
   *   - Sniper identification (first-block buyers)
   *   - Percentage of supply held by insiders
   *
   * This data is critical for the hard filter that blocks tokens with
   * >10% sniper supply (bundled launches) per AAP Section 0.7.3.
   *
   * @param mint - Solana token mint address (base58 public key)
   * @returns Parsed InsiderGraphData on success, or null on failure.
   *   Callers should treat null conservatively — if insider data is
   *   unavailable, the token may still be flagged by other safety checks.
   *
   * @example
   * ```typescript
   * const graph = await client.getInsiderGraph('EPjFWdd5...');
   * if (graph) {
   *   if (graph.sniperSupplyPercent > 10) {
   *     console.log('HARD FILTER: Bundled launch detected');
   *   }
   *   console.log(`Insider count: ${graph.insiderCount}`);
   * }
   * ```
   */
  async getInsiderGraph(mint: string): Promise<InsiderGraphData | null> {
    const endpoint = `/v1/tokens/${encodeURIComponent(mint)}/insiders/graph`;
    const fullUrl = this.baseClient.buildUrl(endpoint);
    this.logger.debug(`Fetching insider graph for mint: ${mint}`, { url: fullUrl });

    try {
      // Acquire rate limit token with 'high' priority (safety-critical)
      await this.rateLimiter.acquire('rugcheck', 'high');

      // Make the API request
      const rawResponse = await this.baseClient.get<Record<string, unknown>>(
        endpoint,
      );

      // Parse the raw response into a typed InsiderGraphData
      const graphData = this.parseInsiderGraph(mint, rawResponse);

      this.logger.info(`Insider graph retrieved for ${mint}`, {
        insiderCount: graphData.insiderCount,
        insiderHoldingPercent: graphData.insiderHoldingPercent,
        bundleDetected: graphData.bundleDetected,
        sniperSupplyPercent: graphData.sniperSupplyPercent,
        nodeCount: graphData.nodes.length,
        edgeCount: graphData.edges.length,
      });

      return graphData;
    } catch (error: unknown) {
      return this.handleError<InsiderGraphData | null>(
        error,
        'getInsiderGraph',
        mint,
        null,
      );
    }
  }

  /**
   * Retrieves the risk rating for a specific wallet address from RugCheck.
   *
   * Provides supplementary data for smart money wallet classification:
   *   - Historical rug rate (tokens created that turned out to be rugs)
   *   - Known scammer flag
   *   - Risk score (0–100, lower = safer)
   *   - Specific risk factors
   *
   * This data complements GMGN's wallet categorization (Smart Money, KOL,
   * Whale, Sniper, Insider, Developer) with historical safety analysis.
   *
   * @param address - Solana wallet address to evaluate (base58 public key)
   * @returns Parsed WalletRiskRating on success, or null on failure.
   *
   * @example
   * ```typescript
   * const rating = await client.getWalletRiskRating('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
   * if (rating) {
   *   console.log(`Risk level: ${rating.riskLevel}`);
   *   console.log(`Rug rate: ${rating.rugRate}%`);
   *   console.log(`Known scammer: ${rating.isKnownScammer}`);
   * }
   * ```
   */
  async getWalletRiskRating(
    address: string,
  ): Promise<WalletRiskRating | null> {
    const endpoint = `/v1/wallets/risk-rating/solana/${encodeURIComponent(address)}`;
    const fullUrl = this.baseClient.buildUrl(endpoint);
    this.logger.debug(`Fetching wallet risk rating for address: ${address}`, { url: fullUrl });

    try {
      // Acquire rate limit token with 'normal' priority (not as critical as token safety)
      await this.rateLimiter.acquire('rugcheck', 'normal');

      // Make the API request — uses Solana chain in URL path
      const rawResponse = await this.baseClient.get<Record<string, unknown>>(
        endpoint,
      );

      // Parse the raw response into a typed WalletRiskRating
      const rating = this.parseWalletRiskRating(address, rawResponse);

      this.logger.info(`Wallet risk rating retrieved for ${address}`, {
        riskScore: rating.riskScore,
        riskLevel: rating.riskLevel,
        rugRate: rating.rugRate,
        isKnownScammer: rating.isKnownScammer,
      });

      return rating;
    } catch (error: unknown) {
      return this.handleError<WalletRiskRating | null>(
        error,
        'getWalletRiskRating',
        address,
        null,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private Response Parsers
  // ---------------------------------------------------------------------------

  /**
   * Parses raw RugCheck API response into a typed RugCheckReport.
   *
   * Handles the variability of the RugCheck API response format by
   * providing safe defaults for missing or null fields. Field names
   * are mapped from the API's snake_case/camelCase format to the
   * standardized RugCheckReport interface.
   *
   * @param mint - Token mint address (used as fallback if response lacks it)
   * @param raw - Raw JSON response object from the RugCheck API
   * @returns Fully typed RugCheckReport with safe defaults for missing fields
   */
  private parseTokenReport(
    mint: string,
    raw: Record<string, unknown>,
  ): RugCheckReport {
    // Extract the score — RugCheck may use 'score', 'tokenScore', or 'risk_score'
    const score = this.safeNumber(
      raw.score ?? raw.tokenScore ?? raw.risk_score,
      0,
    );

    // Parse risk factors array
    const rawRisks = Array.isArray(raw.risks) ? raw.risks : [];
    const risks: RugCheckRisk[] = rawRisks.map(
      (r: Record<string, unknown>) => ({
        name: this.safeString(r.name ?? r.risk_name, 'Unknown Risk'),
        description: this.safeString(
          r.description ?? r.risk_description,
          'No description available',
        ),
        level: this.safeRiskLevel(r.level ?? r.severity),
        score: this.safeNumber(r.score ?? r.risk_score, 0),
      }),
    );

    // Parse authority status — null means revoked (safe), string means active
    const mintAuthority = this.safeNullableString(
      raw.mintAuthority ?? raw.mint_authority,
    );
    const freezeAuthority = this.safeNullableString(
      raw.freezeAuthority ?? raw.freeze_authority,
    );

    // Determine mintable/freezable status from authority presence or explicit flags
    const isMintable =
      this.safeBool(raw.isMintable ?? raw.is_mintable) ||
      mintAuthority !== null;
    const isFreezable =
      this.safeBool(raw.isFreezable ?? raw.is_freezable) ||
      freezeAuthority !== null;

    // Parse top holders array
    const rawHolders = Array.isArray(raw.topHolders ?? raw.top_holders)
      ? (raw.topHolders ?? raw.top_holders) as Record<string, unknown>[]
      : [];
    const topHolders: RugCheckHolder[] = rawHolders.map(
      (h: Record<string, unknown>) => ({
        address: this.safeString(h.address ?? h.wallet, ''),
        amount: this.safeNumber(h.amount ?? h.balance, 0),
        percentage: this.safeNumber(h.percentage ?? h.pct ?? h.percent, 0),
        isInsider: this.safeBool(h.isInsider ?? h.is_insider),
      }),
    );

    // Parse LP lock and burn status
    const lpLocked = this.safeBool(
      raw.lpLocked ?? raw.lp_locked ?? raw.liquidity_locked,
    );
    const lpBurned = this.safeBool(
      raw.lpBurned ?? raw.lp_burned ?? raw.liquidity_burned,
    );
    const lpBurnPercentage = this.safeNumber(
      raw.lpBurnPercentage ?? raw.lp_burn_percentage ?? raw.burn_pct,
      0,
    );

    // Parse Token-2022 flag
    const isToken2022 = this.safeBool(
      raw.isToken2022 ?? raw.is_token_2022 ?? raw.token2022,
    );

    // Parse markets array
    const rawMarkets = Array.isArray(raw.markets)
      ? raw.markets
      : [];
    const markets: RugCheckMarket[] = rawMarkets.map(
      (m: Record<string, unknown>) => ({
        marketId: this.safeString(
          m.marketId ?? m.market_id ?? m.pubkey,
          '',
        ),
        marketType: this.safeString(
          m.marketType ?? m.market_type ?? m.type,
          'unknown',
        ),
        liquidityA: this.safeNumber(m.liquidityA ?? m.liquidity_a, 0),
        liquidityB: this.safeNumber(m.liquidityB ?? m.liquidity_b, 0),
        liquidityAToken: this.safeString(
          m.liquidityAToken ?? m.liquidity_a_token ?? m.mintA,
          '',
        ),
        liquidityBToken: this.safeString(
          m.liquidityBToken ?? m.liquidity_b_token ?? m.mintB,
          '',
        ),
      }),
    );

    // Parse total market liquidity
    const totalMarketLiquidity = this.safeNumber(
      raw.totalMarketLiquidity ??
        raw.total_market_liquidity ??
        raw.totalLiquidity,
      0,
    );

    // Parse creation timestamp
    const createdAt = raw.createdAt ?? raw.created_at ?? raw.creationTime;
    const createdAtStr =
      typeof createdAt === 'string'
        ? createdAt
        : typeof createdAt === 'number'
          ? new Date(createdAt * 1000).toISOString()
          : undefined;

    return {
      mint: this.safeString(raw.mint ?? raw.tokenAddress, mint),
      score,
      risks,
      mintAuthority,
      freezeAuthority,
      isMintable,
      isFreezable,
      topHolders,
      lpLocked,
      lpBurned,
      lpBurnPercentage,
      isToken2022,
      markets,
      totalMarketLiquidity,
      createdAt: createdAtStr,
    };
  }

  /**
   * Parses raw RugCheck insider graph API response into typed InsiderGraphData.
   *
   * Handles variable response structures from the RugCheck API and computes
   * derived metrics (bundle detection, sniper supply percentage) from the
   * raw node and edge data.
   *
   * @param mint - Token mint address
   * @param raw - Raw JSON response from the insider graph endpoint
   * @returns Fully typed InsiderGraphData with safe defaults
   */
  private parseInsiderGraph(
    mint: string,
    raw: Record<string, unknown>,
  ): InsiderGraphData {
    // Parse nodes array
    const rawNodes = Array.isArray(raw.nodes ?? raw.wallets)
      ? ((raw.nodes ?? raw.wallets) as Record<string, unknown>[])
      : [];
    const nodes: InsiderNode[] = rawNodes.map(
      (n: Record<string, unknown>) => ({
        address: this.safeString(n.address ?? n.wallet, ''),
        type: this.safeNodeType(n.type ?? n.role ?? n.category),
        balance: this.safeNumber(n.balance ?? n.amount, 0),
        percentage: this.safeNumber(n.percentage ?? n.pct ?? n.percent, 0),
        fundedByCreator: this.safeBool(
          n.fundedByCreator ?? n.funded_by_creator,
        ),
      }),
    );

    // Parse edges array
    const rawEdges = Array.isArray(raw.edges ?? raw.connections ?? raw.links)
      ? ((raw.edges ?? raw.connections ?? raw.links) as Record<
          string,
          unknown
        >[])
      : [];
    const edges: InsiderEdge[] = rawEdges.map(
      (e: Record<string, unknown>) => ({
        from: this.safeString(e.from ?? e.source, ''),
        to: this.safeString(e.to ?? e.target, ''),
        type: this.safeEdgeType(e.type ?? e.relationship),
        amount: this.safeNumber(e.amount ?? e.value, 0),
        signature:
          typeof e.signature === 'string' ? e.signature : undefined,
      }),
    );

    // Compute derived metrics
    const insiderNodes = nodes.filter(
      (n) => n.type === 'insider' || n.type === 'sniper' || n.fundedByCreator,
    );
    const insiderCount = this.safeNumber(
      raw.insiderCount ?? raw.insider_count,
      insiderNodes.length,
    );
    const insiderHoldingPercent = this.safeNumber(
      raw.insiderHoldingPercent ?? raw.insider_holding_percent,
      insiderNodes.reduce((sum, n) => sum + n.percentage, 0),
    );

    // Detect bundles — wallets with the same funding source
    const bundleDetected = this.safeBool(
      raw.bundleDetected ?? raw.bundle_detected,
    ) || insiderNodes.filter((n) => n.fundedByCreator).length >= 2;

    // Calculate sniper supply percentage
    const sniperNodes = nodes.filter((n) => n.type === 'sniper');
    const sniperSupplyPercent = this.safeNumber(
      raw.sniperSupplyPercent ?? raw.sniper_supply_percent,
      sniperNodes.reduce((sum, n) => sum + n.percentage, 0),
    );

    return {
      mint,
      nodes,
      edges,
      insiderCount,
      insiderHoldingPercent,
      bundleDetected,
      sniperSupplyPercent,
    };
  }

  /**
   * Parses raw RugCheck wallet risk rating response into typed WalletRiskRating.
   *
   * @param address - Wallet address analyzed
   * @param raw - Raw JSON response from the wallet risk endpoint
   * @returns Fully typed WalletRiskRating with safe defaults
   */
  private parseWalletRiskRating(
    address: string,
    raw: Record<string, unknown>,
  ): WalletRiskRating {
    const riskScore = this.safeNumber(
      raw.riskScore ?? raw.risk_score ?? raw.score,
      50,
    );

    return {
      address: this.safeString(raw.address ?? raw.wallet, address),
      riskScore,
      riskLevel: this.safeRiskRatingLevel(
        raw.riskLevel ?? raw.risk_level,
        riskScore,
      ),
      tokensCreated: this.safeNumber(
        raw.tokensCreated ?? raw.tokens_created,
        0,
      ),
      rugCount: this.safeNumber(raw.rugCount ?? raw.rug_count, 0),
      rugRate: this.safeNumber(raw.rugRate ?? raw.rug_rate, 0),
      isKnownScammer: this.safeBool(
        raw.isKnownScammer ?? raw.is_known_scammer ?? raw.flagged,
      ),
      riskFactors: Array.isArray(raw.riskFactors ?? raw.risk_factors)
        ? ((raw.riskFactors ?? raw.risk_factors) as string[]).map(String)
        : [],
    };
  }

  // ---------------------------------------------------------------------------
  // Private Error Handler
  // ---------------------------------------------------------------------------

  /**
   * Centralized error handler for all RugCheck API methods.
   *
   * Classifies errors by type and logs appropriate context:
   *   - 404 (not-found): Token not yet indexed — common for very new tokens
   *   - 401/403 (auth-failed): Invalid or expired API key
   *   - 429 (rate-limited): Should not normally occur (rate limiter prevents this)
   *   - 5xx (server-error): RugCheck server issue — already retried by BaseClient
   *   - timeout: Request exceeded the 10s timeout
   *   - Other: Unexpected errors
   *
   * Per AAP fail-safe policy, all errors return the provided default value
   * rather than throwing, ensuring the safety pipeline continues to function.
   *
   * @typeParam T - Return type for the calling method
   * @param error - The caught error (may be ApiError or generic Error)
   * @param method - Name of the calling method (for log context)
   * @param identifier - Token mint or wallet address (for log context)
   * @param defaultValue - Value to return on error (typically null)
   * @returns The default value, allowing the caller to continue gracefully
   */
  private handleError<T>(
    error: unknown,
    method: string,
    identifier: string,
    defaultValue: T,
  ): T {
    if (error instanceof ApiError) {
      const { status, errorType } = error;

      switch (errorType) {
        case 'not-found':
          // 404 — Token not yet indexed by RugCheck (common for new tokens)
          this.logger.warn(
            `${method}: Token/wallet not found (404) — may not be indexed yet`,
            { identifier, status },
          );
          return defaultValue;

        case 'auth-failed':
          // 401/403 — Invalid or expired API key
          this.logger.error(
            `${method}: Authentication failed — check RugCheck API key configuration`,
            { identifier, status, errorType },
          );
          return defaultValue;

        case 'rate-limited':
          // 429 — Rate limit exceeded (should be rare with rate limiter)
          this.logger.warn(
            `${method}: Rate limited by RugCheck API — request was queued but still hit the limit`,
            { identifier, status },
          );
          return defaultValue;

        case 'server-error':
          // 5xx — RugCheck server error (BaseClient already retried)
          this.logger.error(
            `${method}: RugCheck server error after retries exhausted`,
            { identifier, status, errorType },
          );
          return defaultValue;

        case 'timeout':
          // Request timed out
          this.logger.warn(
            `${method}: Request timed out — RugCheck may be experiencing high latency`,
            { identifier },
          );
          return defaultValue;

        case 'network-error':
          // Network-level failure
          this.logger.warn(
            `${method}: Network error — unable to reach RugCheck API`,
            { identifier },
          );
          return defaultValue;

        case 'parse-error':
          // Response body could not be parsed
          this.logger.error(
            `${method}: Failed to parse RugCheck API response`,
            { identifier, responseBody: error.responseBody },
          );
          return defaultValue;

        default:
          // Unknown error type
          this.logger.error(
            `${method}: Unexpected API error from RugCheck`,
            { identifier, status, errorType, message: error.message },
          );
          return defaultValue;
      }
    }

    // Non-ApiError (unexpected runtime error)
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    this.logger.error(
      `${method}: Unexpected error during RugCheck API call`,
      { identifier, error: errorMessage },
    );
    return defaultValue;
  }

  // ---------------------------------------------------------------------------
  // Private Type-Safe Value Extractors
  // ---------------------------------------------------------------------------

  /**
   * Safely extracts a number from an unknown value, returning a default
   * if the value is null, undefined, NaN, or not a number.
   *
   * @param value - The value to extract a number from
   * @param defaultValue - Fallback value if extraction fails
   * @returns Extracted number or the default value
   */
  private safeNumber(value: unknown, defaultValue: number): number {
    if (typeof value === 'number' && !isNaN(value) && isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      if (!isNaN(parsed) && isFinite(parsed)) {
        return parsed;
      }
    }
    return defaultValue;
  }

  /**
   * Safely extracts a string from an unknown value.
   *
   * @param value - The value to extract a string from
   * @param defaultValue - Fallback value if extraction fails
   * @returns Extracted string or the default value
   */
  private safeString(value: unknown, defaultValue: string): string {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    return defaultValue;
  }

  /**
   * Safely extracts a nullable string from an unknown value.
   * Returns null for null/undefined/empty values (e.g., revoked authorities).
   *
   * @param value - The value to extract
   * @returns String value or null
   */
  private safeNullableString(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    return null;
  }

  /**
   * Safely extracts a boolean from an unknown value.
   * Handles string booleans ('true'/'false', '0'/'1') and numeric booleans.
   *
   * @param value - The value to extract a boolean from
   * @returns Boolean representation, defaulting to false for unrecognized values
   */
  private safeBool(value: unknown): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      return lower === 'true' || lower === '1' || lower === 'yes';
    }
    if (typeof value === 'number') {
      return value !== 0;
    }
    return false;
  }

  /**
   * Safely maps an unknown value to a RugCheckRisk level.
   *
   * @param value - The raw risk level value from the API
   * @returns Typed risk level string
   */
  private safeRiskLevel(
    value: unknown,
  ): 'critical' | 'high' | 'medium' | 'low' | 'info' {
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (
        lower === 'critical' ||
        lower === 'high' ||
        lower === 'medium' ||
        lower === 'low' ||
        lower === 'info'
      ) {
        return lower as 'critical' | 'high' | 'medium' | 'low' | 'info';
      }
      // Map alternative severity terms
      if (lower === 'danger' || lower === 'severe') return 'critical';
      if (lower === 'warning' || lower === 'warn') return 'high';
      if (lower === 'moderate') return 'medium';
      if (lower === 'minor' || lower === 'notice') return 'low';
      if (lower === 'informational' || lower === 'note') return 'info';
    }
    return 'medium'; // Default to medium for unknown levels
  }

  /**
   * Safely maps an unknown value to an InsiderNode type.
   *
   * @param value - The raw node type value from the API
   * @returns Typed node classification
   */
  private safeNodeType(
    value: unknown,
  ): 'creator' | 'insider' | 'sniper' | 'whale' | 'normal' {
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower === 'creator' || lower === 'deployer') return 'creator';
      if (lower === 'insider' || lower === 'related') return 'insider';
      if (lower === 'sniper' || lower === 'first_buyer') return 'sniper';
      if (lower === 'whale' || lower === 'large_holder') return 'whale';
    }
    return 'normal';
  }

  /**
   * Safely maps an unknown value to an InsiderEdge type.
   *
   * @param value - The raw edge type value from the API
   * @returns Typed edge relationship classification
   */
  private safeEdgeType(
    value: unknown,
  ): 'funding' | 'token_transfer' | 'sol_transfer' {
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower === 'funding' || lower === 'fund' || lower === 'funded') {
        return 'funding';
      }
      if (
        lower === 'token_transfer' ||
        lower === 'token' ||
        lower === 'spl_transfer'
      ) {
        return 'token_transfer';
      }
      if (
        lower === 'sol_transfer' ||
        lower === 'sol' ||
        lower === 'native_transfer'
      ) {
        return 'sol_transfer';
      }
    }
    return 'funding'; // Default to funding for unknown types
  }

  /**
   * Safely maps an unknown value to a WalletRiskRating risk level.
   * Falls back to computing the level from the numeric score.
   *
   * @param value - The raw risk level value from the API
   * @param score - The numeric risk score for fallback computation
   * @returns Typed risk level string
   */
  private safeRiskRatingLevel(
    value: unknown,
    score: number,
  ): 'low' | 'medium' | 'high' | 'critical' {
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (
        lower === 'low' ||
        lower === 'medium' ||
        lower === 'high' ||
        lower === 'critical'
      ) {
        return lower as 'low' | 'medium' | 'high' | 'critical';
      }
    }
    // Compute from score: 0–25 low, 26–50 medium, 51–75 high, 76–100 critical
    if (score <= 25) return 'low';
    if (score <= 50) return 'medium';
    if (score <= 75) return 'high';
    return 'critical';
  }

  // ---------------------------------------------------------------------------
  // Public Static Utilities
  // ---------------------------------------------------------------------------

  /**
   * Creates a fail-safe default RugCheckReport that assumes the token is unsafe.
   *
   * Returns a pessimistic safety report for use when RugCheck is unavailable,
   * times out, or returns an unrecoverable error. Per AAP Section 0.7.3,
   * the worst-case-wins policy requires that safety check failures result
   * in "cautious" defaults — effectively marking the token as dangerous.
   *
   * The default report:
   *   - Sets score to 0 (well below the ≥300 safety threshold)
   *   - Flags both mint and freeze authority as active (unsafe)
   *   - Reports no LP lock or burn
   *   - Includes an explanatory risk entry
   *
   * Callers (e.g., src/safety/checker.ts) can use this when `getTokenReport()`
   * returns null to provide a valid RugCheckReport to the scoring pipeline.
   *
   * @param mint - Token mint address for the fail-safe report
   * @returns A RugCheckReport with pessimistic safety defaults
   *
   * @example
   * ```typescript
   * const report = await rugCheckClient.getTokenReport(mint);
   * const safeReport = report ?? RugCheckClient.createFailSafeReport(mint);
   * // safeReport always has score = 0 if RugCheck was unavailable
   * ```
   */
  static createFailSafeReport(mint: string): RugCheckReport {
    return {
      mint,
      score: 0,
      risks: [
        {
          name: 'RugCheck Unavailable',
          description:
            'Safety data could not be retrieved from RugCheck. Assuming worst-case scenario per fail-safe policy.',
          level: 'critical' as const,
          score: 0,
        },
      ],
      mintAuthority: 'unknown',
      freezeAuthority: 'unknown',
      isMintable: true,
      isFreezable: true,
      topHolders: [],
      lpLocked: false,
      lpBurned: false,
      lpBurnPercentage: 0,
      isToken2022: false,
      markets: [],
      totalMarketLiquidity: 0,
    };
  }
}
