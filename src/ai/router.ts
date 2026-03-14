/**
 * src/ai/router.ts — Three-Tier LLM Analysis Router
 *
 * Central dispatch module for the AI-enhanced token analysis pipeline.
 * Routes tokens to the appropriate LLM tier based on their initial
 * composite score from the 7-factor scoring engine:
 *
 *   - Composite score < 45  → FAST tier (llama-3.1-8b-instant) — 80% of calls
 *   - Composite score 45–80 → DETAILED tier (llama-3.3-70b-versatile) — 15% of calls
 *   - Composite score > 80  → PREMIUM tier (Claude Sonnet) — 5% of calls
 *
 * Key behaviors per AAP:
 *   - 5-minute TTL cache check BEFORE every LLM call (cache key: `llm:{mint}:{tier}`)
 *   - Structured JSON output from all tiers parsed via `response-parser.ts`
 *   - Graceful error handling: returns null on any failure — never crashes
 *     the signal pipeline
 *   - Cost optimization: the 80/15/5 distribution reduces LLM costs by ~60%
 *   - Tier distribution tracking with drift warnings
 *
 * Per AAP Section 0.5.1 Group 8:
 * "Three-tier dispatch logic; routes tokens based on initial composite score:
 *  score <45 → llama-3.1-8b-instant quick pass/fail;
 *  45–80 → llama-3.3-70b-versatile detailed analysis;
 *  >80 → Claude Sonnet narrative analysis;
 *  checks 5-minute TTL cache before every call"
 *
 * Per AAP Section 0.7.3:
 * "Safety checks before AI analysis: Never send a token to the LLM tier
 *  unless it has passed both hard filters and achieved a minimum composite
 *  score threshold"
 *
 * Per AAP Section 0.7.4:
 * "LLM response caching: All Groq/Claude LLM responses must be cached in
 *  chrome.storage.local with a 5-minute TTL keyed by token mint address +
 *  analysis tier"
 * "Three-tier LLM routing is cost-critical: Maintain the 80/15/5 distribution"
 *
 * Consumers:
 * - `src/signals/scoring-engine.ts` → primary consumer, calls `analyzeToken()`
 * - `entrypoints/background.ts` → instantiates `AIRouter` with `GroqClient`
 *
 * @module ai/router
 */

import type { AIAnalysisResult, LLMTier } from './types';
import { buildAnalysisPrompt, buildSystemPrompt } from './prompts';
import { parseAIResponse } from './response-parser';
import { GroqClient, GROQ_MODELS, CLAUDE_MODEL } from '../api/groq';
import { cache } from '../utils/cache';
import { LLM_CONFIG } from '../utils/config';
import { createLogger, type Logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Structured logger with 'ai-router' context tag for filtering in DevTools.
 */
const moduleLogger = createLogger('ai-router');

// ---------------------------------------------------------------------------
// Target Distribution Constants
// ---------------------------------------------------------------------------

/**
 * Target percentage distribution for the three LLM tiers.
 * Used by `getTierDistribution()` to detect drift from optimal cost allocation.
 *
 * Per AAP §0.7.4: "Maintain the 80/15/5 distribution"
 */
const TARGET_DISTRIBUTION = {
  fast: 80,
  detailed: 15,
  premium: 5,
} as const;

/**
 * Drift threshold (percentage points) beyond which a warning is emitted.
 * If any tier's actual usage deviates from target by more than this amount,
 * the router logs a warning to alert operators of potential cost overruns.
 */
const DISTRIBUTION_DRIFT_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// RouterConfig Interface
// ---------------------------------------------------------------------------

/**
 * Configuration for the AI analysis router.
 *
 * Controls tier selection thresholds, premium tier availability, and cache TTL.
 * Default values are sourced from `LLM_CONFIG` in `src/utils/config.ts`.
 */
export interface RouterConfig {
  /**
   * Score threshold below which the fast tier is used.
   * Tokens with compositeScore < fastThreshold → 'fast' tier.
   * Default: 45 (from LLM_CONFIG.FAST_THRESHOLD).
   */
  fastThreshold: number;

  /**
   * Score threshold above which the premium tier is used (if enabled).
   * Tokens with compositeScore >= detailedThreshold → 'premium' (or 'detailed' if disabled).
   * Tokens between fastThreshold and detailedThreshold → 'detailed' tier.
   * Default: 80 (from LLM_CONFIG.DETAILED_THRESHOLD).
   */
  detailedThreshold: number;

  /**
   * Whether to enable the Claude Sonnet premium tier.
   * Requires an Anthropic API key configured in the GroqClient.
   * When disabled, high-score tokens fall back to the 'detailed' tier.
   * Default: false.
   */
  enablePremiumTier: boolean;

  /**
   * Cache TTL in milliseconds for LLM analysis responses.
   * Per AAP §0.7.4: 5 minutes (300,000 ms).
   * Default: LLM_CONFIG.CACHE_TTL_MS (300000).
   */
  cacheTtlMs: number;
}

// ---------------------------------------------------------------------------
// TokenAnalysisInput Interface
// ---------------------------------------------------------------------------

/**
 * Input data for token analysis via the LLM router.
 *
 * Contains all token metrics, safety data, and smart money activity needed
 * to construct an LLM analysis prompt. Passed by the scoring engine
 * (`src/signals/scoring-engine.ts`) after a token passes hard filters and
 * achieves a minimum composite score threshold.
 *
 * This interface is structurally compatible with `TokenDataForPrompt` from
 * `src/ai/prompts.ts`, enabling direct passthrough to `buildAnalysisPrompt()`.
 */
export interface TokenAnalysisInput {
  /** Solana token mint address (base58-encoded public key). */
  mint: string;

  /** Token trading symbol (e.g., "BONK", "WIF", "POPCAT"). */
  symbol: string;

  /** Initial composite score from the 7-factor scoring engine (0–100). */
  compositeScore: number;

  /** Current token price in USD. */
  price: number;

  /** Market capitalization in USD. */
  marketCap: number;

  /** 24-hour trading volume in USD. */
  volume24h: number;

  /** Total liquidity depth in USD (LP pool value). */
  liquidity: number;

  /** Current number of unique token holders. */
  holderCount: number;

  /** Buy/sell transaction ratio over the last hour. */
  buySellRatio: number;

  /** Number of qualified smart money wallets that have entered this token. */
  smartMoneyCount: number;

  /** Token age in hours since creation on-chain. */
  tokenAgeHours: number;

  /** Aggregated safety score from RugCheck (0–1000 scale, higher is safer). */
  safetyScore: number;

  /** Whether the token failed Jupiter honeypot sell simulation. */
  isHoneypot: boolean;

  /** Whether the developer wallet has sold their holdings. */
  devWalletSold: boolean;

  /** Percentage of total supply held by the top holder (0–100). */
  topHolderPercent: number;

  /** Whether LP tokens have been burned (sent to burn address). */
  lpBurned: boolean;
}

// ---------------------------------------------------------------------------
// Standalone determineTier Function
// ---------------------------------------------------------------------------

/**
 * Determines the appropriate LLM tier for a given composite score.
 *
 * Exported as a standalone function for testing and external use without
 * needing to instantiate the full AIRouter class.
 *
 * Routing logic:
 *   - compositeScore < fastThreshold (45)         → 'fast'     (80% of calls)
 *   - fastThreshold ≤ compositeScore < detailedThreshold (80) → 'detailed' (15%)
 *   - compositeScore ≥ detailedThreshold (80)     → 'premium'  (5%, if enabled)
 *
 * If the premium tier is not enabled (default), scores ≥ detailedThreshold
 * fall back to 'detailed'.
 *
 * @param compositeScore - Initial composite score from the 7-factor engine (0–100).
 * @param config - Optional partial router config to override default thresholds.
 * @returns The selected LLM tier identifier.
 *
 * @example
 * ```typescript
 * determineTier(30);  // 'fast'
 * determineTier(60);  // 'detailed'
 * determineTier(85);  // 'detailed' (premium disabled by default)
 * determineTier(85, { enablePremiumTier: true });  // 'premium'
 * ```
 */
export function determineTier(
  compositeScore: number,
  config?: Partial<RouterConfig>,
): LLMTier {
  const fastThreshold = config?.fastThreshold ?? LLM_CONFIG.FAST_THRESHOLD;
  const detailedThreshold = config?.detailedThreshold ?? LLM_CONFIG.DETAILED_THRESHOLD;
  const enablePremium = config?.enablePremiumTier ?? false;

  if (compositeScore >= detailedThreshold) {
    return enablePremium ? 'premium' : 'detailed';
  }
  if (compositeScore >= fastThreshold) {
    return 'detailed';
  }
  return 'fast';
}

// ---------------------------------------------------------------------------
// AIRouter Class
// ---------------------------------------------------------------------------

/**
 * Three-tier LLM analysis router that dispatches token analysis requests
 * to the appropriate model based on composite score thresholds.
 *
 * Instantiate once in the service worker and reuse for all analysis requests.
 * The router manages its own caching layer (5-minute TTL per AAP §0.7.4),
 * tier distribution tracking (80/15/5 per AAP §0.7.4), and graceful error
 * handling (never crashes the signal pipeline).
 *
 * @example
 * ```typescript
 * const groqClient = new GroqClient(groqApiKey, anthropicApiKey);
 * const router = new AIRouter(groqClient, { enablePremiumTier: true });
 *
 * const result = await router.analyzeToken({
 *   mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
 *   symbol: 'BONK',
 *   compositeScore: 72,
 *   price: 0.00001234,
 *   marketCap: 500000,
 *   volume24h: 1200000,
 *   liquidity: 50000,
 *   holderCount: 3500,
 *   buySellRatio: 2.1,
 *   smartMoneyCount: 3,
 *   tokenAgeHours: 1.5,
 *   safetyScore: 450,
 *   isHoneypot: false,
 *   devWalletSold: false,
 *   topHolderPercent: 8.5,
 *   lpBurned: true,
 * });
 * ```
 */
export class AIRouter {
  /** Shared Groq/Claude LLM client instance. */
  private readonly groqClient: GroqClient;

  /** Router configuration with tier thresholds and cache settings. */
  private readonly config: RouterConfig;

  /** Structured logger instance with 'ai-router' context tag. */
  private readonly logger: Logger;

  /**
   * Running counts of analyses routed to each tier.
   * Used by `getTierDistribution()` to monitor the 80/15/5 cost allocation.
   * Reset periodically via `resetTierCounts()` (e.g., daily via chrome.alarms).
   */
  private tierCounts: { fast: number; detailed: number; premium: number };

  /**
   * Creates a new AIRouter instance.
   *
   * @param groqClient - Pre-configured `GroqClient` with API keys and rate
   *   limiting. Created in the service worker and passed to the router.
   * @param config - Optional partial configuration overrides. Unspecified
   *   fields use defaults from `LLM_CONFIG` in `src/utils/config.ts`.
   */
  constructor(groqClient: GroqClient, config?: Partial<RouterConfig>) {
    this.groqClient = groqClient;
    this.config = {
      fastThreshold: config?.fastThreshold ?? LLM_CONFIG.FAST_THRESHOLD,
      detailedThreshold: config?.detailedThreshold ?? LLM_CONFIG.DETAILED_THRESHOLD,
      enablePremiumTier: config?.enablePremiumTier ?? false,
      cacheTtlMs: config?.cacheTtlMs ?? LLM_CONFIG.CACHE_TTL_MS,
    };
    this.tierCounts = { fast: 0, detailed: 0, premium: 0 };
    this.logger = createLogger('ai-router');

    this.logger.info('AIRouter initialized', {
      fastThreshold: this.config.fastThreshold,
      detailedThreshold: this.config.detailedThreshold,
      enablePremiumTier: this.config.enablePremiumTier,
      cacheTtlMs: this.config.cacheTtlMs,
    });
  }

  // =========================================================================
  // Public — analyzeToken()
  // =========================================================================

  /**
   * Analyzes a single token through the three-tier LLM pipeline.
   *
   * Execution flow:
   *   1. Determine the appropriate LLM tier from the composite score.
   *   2. Generate a cache key (`llm:{mint}:{tier}`).
   *   3. Check the 5-minute TTL cache — return cached result on hit.
   *   4. Build the system and user prompts using `prompts.ts`.
   *   5. Send the combined prompt to the selected LLM tier.
   *   6. Parse the structured JSON response via `response-parser.ts`.
   *   7. Cache the parsed result with 5-minute TTL.
   *   8. Track tier usage for distribution monitoring.
   *   9. Return the typed `AIAnalysisResult`.
   *
   * On any failure (API error, parse error, timeout), returns `null` to
   * ensure the signal pipeline continues operating without crashing.
   *
   * @param input - Token analysis input containing all metrics, safety data,
   *   and smart money activity required for LLM prompt construction.
   * @returns Typed AI analysis result, or `null` if analysis failed.
   */
  async analyzeToken(input: TokenAnalysisInput): Promise<AIAnalysisResult | null> {
    const startTime = Date.now();

    try {
      // Step 1: Determine LLM tier based on composite score thresholds
      const tier = this.determineTier(input.compositeScore);
      const model = this.getModelForTier(tier);

      // Step 2: Generate cache key — format: `llm:{mint}:{tier}`
      const cacheKey = this.generateCacheKey(input.mint, tier);

      // Step 3: Check 5-minute TTL cache BEFORE making any LLM call
      // CRITICAL per AAP §0.7.4 — duplicate analyses within TTL MUST return cached results
      try {
        const cached = await cache.get<AIAnalysisResult>(cacheKey);
        if (cached !== null) {
          this.logger.debug('Cache hit for AI analysis', {
            mint: input.mint,
            symbol: input.symbol,
            tier,
            cacheKey,
          });
          return cached;
        }
        this.logger.debug('Cache miss for AI analysis', {
          mint: input.mint,
          tier,
          cacheKey,
        });
      } catch (cacheErr: unknown) {
        // Cache errors should NEVER block the analysis pipeline
        this.logger.warn('Cache read error in AI router, proceeding with LLM call', {
          mint: input.mint,
          tier,
          error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
        });
      }

      // Step 4: Build the structured prompt
      const systemPrompt = buildSystemPrompt(tier);
      const userPrompt = buildAnalysisPrompt(input);
      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

      this.logger.info('Routing AI analysis', {
        mint: input.mint,
        symbol: input.symbol,
        compositeScore: input.compositeScore,
        tier,
        model,
      });

      // Step 5: Call the appropriate LLM tier
      const rawResponse = await this.callLLM(tier, fullPrompt);

      // If LLM returned null, the call failed — return null
      if (rawResponse === null || rawResponse === undefined) {
        this.logger.warn('LLM returned null response', {
          mint: input.mint,
          tier,
          durationMs: Date.now() - startTime,
        });
        return null;
      }

      // Step 6: Parse the structured JSON response into typed AIAnalysisResult
      const parsedResult = parseAIResponse(rawResponse, tier);

      // Step 7: Cache the parsed result with configured TTL
      try {
        await cache.set(cacheKey, parsedResult, this.config.cacheTtlMs);
        this.logger.debug('Cached AI analysis result', {
          mint: input.mint,
          tier,
          cacheKey,
        });
      } catch (cacheWriteErr: unknown) {
        // Cache write failures should NOT block the response
        this.logger.warn('Failed to cache AI analysis result', {
          mint: input.mint,
          tier,
          error: cacheWriteErr instanceof Error ? cacheWriteErr.message : String(cacheWriteErr),
        });
      }

      // Step 8: Track tier usage for distribution monitoring
      this.trackTierUsage(tier);

      const durationMs = Date.now() - startTime;
      this.logger.info('AI analysis complete', {
        mint: input.mint,
        symbol: input.symbol,
        tier: parsedResult.tier,
        model,
        compositeAI: parsedResult.compositeAI,
        confidence: parsedResult.confidence,
        dimensionCount: parsedResult.dimensions.length,
        narrativePreview: parsedResult.narrative.substring(0, 80),
        timestamp: parsedResult.timestamp,
        durationMs,
      });

      // Step 9: Return the parsed result
      return parsedResult;
    } catch (err: unknown) {
      // Top-level catch: NEVER crash the signal pipeline
      this.logger.error('Unexpected error in analyzeToken', {
        mint: input.mint,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      });
      return null;
    }
  }

  // =========================================================================
  // Public — analyzeTokens()
  // =========================================================================

  /**
   * Analyzes multiple tokens through the LLM pipeline.
   *
   * Processes tokens sequentially to respect rate limits and avoid
   * overwhelming the LLM API. Each token goes through `analyzeToken()`
   * which includes its own cache check — cached tokens return instantly.
   *
   * @param inputs - Array of token analysis inputs to process.
   * @returns Map of token mint address → analysis result (or null on failure).
   */
  async analyzeTokens(
    inputs: TokenAnalysisInput[],
  ): Promise<Map<string, AIAnalysisResult | null>> {
    const results = new Map<string, AIAnalysisResult | null>();

    if (inputs.length === 0) {
      return results;
    }

    this.logger.info('Starting batch token analysis', {
      tokenCount: inputs.length,
    });

    // Process sequentially to respect rate limits across all API providers.
    // Each analyzeToken() call includes internal cache checking, so tokens
    // with cached results return instantly without hitting the API.
    for (const input of inputs) {
      try {
        const result = await this.analyzeToken(input);
        results.set(input.mint, result);
      } catch (err: unknown) {
        // Individual token failures should NOT abort the entire batch
        this.logger.error('Batch analysis failed for token', {
          mint: input.mint,
          error: err instanceof Error ? err.message : String(err),
        });
        results.set(input.mint, null);
      }
    }

    this.logger.info('Batch token analysis complete', {
      tokenCount: inputs.length,
      successCount: Array.from(results.values()).filter((r) => r !== null).length,
      failureCount: Array.from(results.values()).filter((r) => r === null).length,
    });

    return results;
  }

  // =========================================================================
  // Public — determineTier()
  // =========================================================================

  /**
   * Determines which LLM tier should be used based on the composite score.
   *
   * Routing thresholds (configurable via `RouterConfig`):
   *   - Score < fastThreshold (default 45)     → 'fast'     (llama-3.1-8b-instant, 80%)
   *   - fastThreshold ≤ score < detailedThreshold (default 80) → 'detailed' (llama-3.3-70b-versatile, 15%)
   *   - Score ≥ detailedThreshold (default 80)  → 'premium'  (Claude Sonnet, 5% — if enabled)
   *
   * When the premium tier is disabled (no Anthropic API key), scores ≥ detailedThreshold
   * are routed to the 'detailed' tier instead.
   *
   * @param compositeScore - The initial composite score from the 7-factor engine (0–100).
   * @returns The selected LLM tier identifier.
   */
  determineTier(compositeScore: number): LLMTier {
    if (compositeScore >= this.config.detailedThreshold) {
      return this.config.enablePremiumTier ? 'premium' : 'detailed';
    }
    if (compositeScore >= this.config.fastThreshold) {
      return 'detailed';
    }
    return 'fast';
  }

  // =========================================================================
  // Public — invalidateCache()
  // =========================================================================

  /**
   * Invalidates all cached AI analysis results for a specific token.
   *
   * Clears cached results across all three tiers (fast, detailed, premium)
   * to force fresh analysis on the next request. Useful when token data
   * changes significantly (e.g., safety status update, major price movement,
   * new smart money entry).
   *
   * @param mint - Solana token mint address to clear from cache.
   */
  async invalidateCache(mint: string): Promise<void> {
    const tiers: LLMTier[] = ['fast', 'detailed', 'premium'];

    const invalidationPromises = tiers.map(async (tier) => {
      const key = this.generateCacheKey(mint, tier);
      try {
        await cache.invalidate(key);
      } catch (err: unknown) {
        // Cache invalidation errors should not propagate
        this.logger.warn('Failed to invalidate cache entry', {
          mint,
          tier,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    await Promise.allSettled(invalidationPromises);
    this.logger.info('Invalidated AI analysis cache for token', { mint });
  }

  // =========================================================================
  // Public — getTierDistribution()
  // =========================================================================

  /**
   * Returns the current tier usage distribution as percentages.
   *
   * Calculates the percentage of total analyses routed to each tier
   * based on running counts tracked since the last `resetTierCounts()`.
   *
   * Used to monitor adherence to the target 80/15/5 distribution
   * per AAP §0.7.4. Drift beyond the threshold triggers a warning log.
   *
   * @returns Object with fast, detailed, and premium percentage values (0–100).
   *   Returns all zeros if no analyses have been performed yet.
   */
  getTierDistribution(): { fast: number; detailed: number; premium: number } {
    const total = this.tierCounts.fast + this.tierCounts.detailed + this.tierCounts.premium;

    if (total === 0) {
      return { fast: 0, detailed: 0, premium: 0 };
    }

    return {
      fast: Math.round((this.tierCounts.fast / total) * 100),
      detailed: Math.round((this.tierCounts.detailed / total) * 100),
      premium: Math.round((this.tierCounts.premium / total) * 100),
    };
  }

  // =========================================================================
  // Public — resetTierCounts()
  // =========================================================================

  /**
   * Resets the tier usage counters to zero.
   *
   * Should be called periodically (e.g., daily via `chrome.alarms`) to
   * maintain meaningful distribution tracking. After reset, `getTierDistribution()`
   * returns all zeros until new analyses are routed.
   */
  resetTierCounts(): void {
    this.tierCounts = { fast: 0, detailed: 0, premium: 0 };
    this.logger.info('Tier usage counts reset');
  }

  // =========================================================================
  // Private — generateCacheKey()
  // =========================================================================

  /**
   * Generates a standardized cache key for LLM response caching.
   *
   * Cache key format: `llm:{mint}:{tier}`
   * Per AAP §0.7.4: "keyed by token mint address + analysis tier"
   *
   * @param mint - Solana token mint address.
   * @param tier - LLM tier identifier ('fast', 'detailed', or 'premium').
   * @returns Formatted cache key string.
   */
  private generateCacheKey(mint: string, tier: LLMTier): string {
    return `llm:${mint}:${tier}`;
  }

  // =========================================================================
  // Private — callLLM()
  // =========================================================================

  /**
   * Dispatches the prompt to the appropriate LLM provider based on tier.
   *
   * - Fast and Detailed tiers → `GroqClient.analyze()` with the
   *   corresponding model identifier (`GROQ_MODELS.FAST` / `GROQ_MODELS.DETAILED`).
   * - Premium tier → `GroqClient.analyzeWithClaude()` for Anthropic Claude.
   *   If Claude fails or is unavailable, falls back to the detailed tier.
   *
   * The router does NOT pass a cacheKey to the GroqClient to avoid double-caching.
   * All caching is handled at the router level (see `analyzeToken()`).
   *
   * @param tier - LLM tier determining which provider/model to use.
   * @param prompt - Fully constructed prompt string (system + user combined).
   * @returns Raw LLM response (JSON object), or null on failure.
   */
  private async callLLM(
    tier: LLMTier,
    prompt: string,
  ): Promise<unknown | null> {
    const baseOptions = {
      responseFormat: 'json' as const,
      temperature: 0.1,
    };

    switch (tier) {
      case 'fast':
        return this.groqClient.analyze(prompt, GROQ_MODELS.FAST, {
          ...baseOptions,
          maxTokens: 1024,
        });

      case 'detailed':
        return this.groqClient.analyze(prompt, GROQ_MODELS.DETAILED, {
          ...baseOptions,
          maxTokens: 2048,
        });

      case 'premium': {
        // Premium tier uses Claude Sonnet via Anthropic API
        const claudeResult = await this.groqClient.analyzeWithClaude(prompt, {
          ...baseOptions,
          maxTokens: 2048,
        });

        if (claudeResult !== null) {
          return claudeResult;
        }

        // Fallback: if Claude is unavailable (no API key, rate limited, error),
        // downgrade to the detailed tier using Groq's 70B model
        this.logger.warn('Claude premium tier unavailable, falling back to detailed tier');
        return this.groqClient.analyze(prompt, GROQ_MODELS.DETAILED, {
          ...baseOptions,
          maxTokens: 2048,
        });
      }

      default:
        this.logger.error('Unknown LLM tier, defaulting to fast', { tier });
        return this.groqClient.analyze(prompt, GROQ_MODELS.FAST, {
          ...baseOptions,
          maxTokens: 1024,
        });
    }
  }

  // =========================================================================
  // Private — getModelForTier()
  // =========================================================================

  /**
   * Returns the model identifier string for a given LLM tier.
   * Used in logging to report which model was selected.
   *
   * @param tier - The LLM tier ('fast', 'detailed', or 'premium').
   * @returns Human-readable model identifier string.
   */
  private getModelForTier(tier: LLMTier): string {
    switch (tier) {
      case 'fast':
        return GROQ_MODELS.FAST;
      case 'detailed':
        return GROQ_MODELS.DETAILED;
      case 'premium':
        return CLAUDE_MODEL;
      default:
        return GROQ_MODELS.FAST;
    }
  }

  // =========================================================================
  // Private — trackTierUsage()
  // =========================================================================

  /**
   * Increments the usage counter for the specified tier and checks
   * for distribution drift against the target 80/15/5 allocation.
   *
   * If any tier's actual usage percentage deviates from its target by
   * more than `DISTRIBUTION_DRIFT_THRESHOLD` percentage points, a warning
   * is logged to alert operators of potential cost optimization issues.
   *
   * @param tier - The tier that was just used for an analysis.
   */
  private trackTierUsage(tier: LLMTier): void {
    this.tierCounts[tier]++;

    const total = this.tierCounts.fast + this.tierCounts.detailed + this.tierCounts.premium;

    // Only check distribution drift after a meaningful sample size
    if (total > 0 && total % 20 === 0) {
      const distribution = this.getTierDistribution();
      const drifts: string[] = [];

      if (Math.abs(distribution.fast - TARGET_DISTRIBUTION.fast) > DISTRIBUTION_DRIFT_THRESHOLD) {
        drifts.push(`fast: ${distribution.fast}% (target ${TARGET_DISTRIBUTION.fast}%)`);
      }
      if (Math.abs(distribution.detailed - TARGET_DISTRIBUTION.detailed) > DISTRIBUTION_DRIFT_THRESHOLD) {
        drifts.push(`detailed: ${distribution.detailed}% (target ${TARGET_DISTRIBUTION.detailed}%)`);
      }
      if (Math.abs(distribution.premium - TARGET_DISTRIBUTION.premium) > DISTRIBUTION_DRIFT_THRESHOLD) {
        drifts.push(`premium: ${distribution.premium}% (target ${TARGET_DISTRIBUTION.premium}%)`);
      }

      if (drifts.length > 0) {
        this.logger.warn('Tier distribution drift detected', {
          totalAnalyses: total,
          actual: distribution,
          target: TARGET_DISTRIBUTION,
          drifts,
        });
      }
    }
  }
}
