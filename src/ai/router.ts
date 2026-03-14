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
 *   - 5-minute TTL cache check before every LLM call (cache key: `llm:{mint}:{tier}`)
 *   - Structured JSON output from all tiers parsed via `response-parser.ts`
 *   - Graceful fallback: if a higher tier fails, returns a fallback result
 *     rather than crashing the signal pipeline
 *   - Cost optimization: the 80/15/5 distribution reduces costs by ~60%
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
 *
 * Consumers:
 * - `src/signals/scoring-engine.ts` → primary consumer, calls `analyzeToken()`
 * - `entrypoints/background.ts` → instantiates `AIRouter` with `GroqClient`
 *
 * @module ai/router
 */

import type {
  AIAnalysisResult,
  AIAnalysisRequest,
  LLMTier,
} from './types';
import { buildFullPrompt, type TokenDataForPrompt } from './prompts';
import { parseAIResponse, createFallbackResult } from './response-parser';
import { GroqClient, GROQ_MODELS } from '../api/groq';
import { cache } from '../utils/cache';
import { LLM_CONFIG } from '../utils/config';
import { createLogger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Structured logger with 'ai-router' context tag for filtering in DevTools.
 */
const logger = createLogger('ai-router');

// ---------------------------------------------------------------------------
// AIRouter Class
// ---------------------------------------------------------------------------

/**
 * Three-tier LLM analysis router that dispatches token analysis requests
 * to the appropriate model based on composite score thresholds.
 *
 * Instantiate once in the service worker and reuse for all analysis requests.
 * The router holds a reference to the shared `GroqClient` which manages
 * API authentication, rate limiting, and caching at the transport level.
 *
 * @example
 * ```typescript
 * const groqClient = new GroqClient(groqApiKey, anthropicApiKey);
 * const router = new AIRouter(groqClient);
 *
 * const result = await router.analyzeToken({
 *   mint: 'So11111111111111111111111111111111111111112',
 *   symbol: 'BONK',
 *   compositeScore: 72,
 *   tokenData: { price: 0.00001, volume24h: 1200000, ... },
 * });
 * ```
 */
export class AIRouter {
  /** Shared Groq/Claude LLM client instance */
  private readonly client: GroqClient;

  /**
   * Creates a new AIRouter instance.
   *
   * @param client - Pre-configured `GroqClient` with API keys and rate limiting.
   *   The client is created in the service worker and passed to the router.
   */
  constructor(client: GroqClient) {
    this.client = client;
    logger.info('AIRouter initialized');
  }

  // =========================================================================
  // Public — analyzeToken()
  // =========================================================================

  /**
   * Analyzes a token through the three-tier LLM pipeline.
   *
   * Execution flow:
   *   1. Determine the appropriate LLM tier from the composite score.
   *   2. Generate a cache key (`llm:{mint}:{tier}`).
   *   3. Check the 5-minute TTL cache — return cached result on hit.
   *   4. Build the structured prompt using `prompts.ts`.
   *   5. Send the prompt to the selected LLM tier.
   *   6. Parse the structured JSON response via `response-parser.ts`.
   *   7. Cache the parsed result with 5-minute TTL.
   *   8. Return the typed `AIAnalysisResult`.
   *
   * If the LLM call fails at any step, a neutral fallback result is returned
   * (score 50, confidence 'low') so the signal pipeline continues operating
   * without crashing.
   *
   * @param request - Token analysis request containing mint, symbol,
   *   compositeScore, and all available tokenData for prompt construction.
   * @returns Typed AI analysis result with dimension scores, composite AI
   *   score, confidence level, narrative summary, and tier identification.
   */
  async analyzeToken(request: AIAnalysisRequest): Promise<AIAnalysisResult> {
    const { mint, symbol, compositeScore, tokenData } = request;

    // Step 1: Determine LLM tier based on composite score thresholds
    const tier = this.determineTier(compositeScore);

    // Step 2: Generate cache key
    const cacheKey = this.client.generateCacheKey(mint, tier);

    // Step 3: Check 5-minute TTL cache before making any LLM call
    try {
      const cached = await cache.get<AIAnalysisResult>(cacheKey);
      if (cached !== null) {
        logger.debug('Cache hit for AI analysis', { mint, tier, cacheKey });
        return cached;
      }
      logger.debug('Cache miss for AI analysis', { mint, tier, cacheKey });
    } catch (cacheErr: unknown) {
      // Cache errors should never block the analysis pipeline
      logger.warn('Cache read error in AI router, proceeding with LLM call', {
        mint,
        tier,
        error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
      });
    }

    // Step 4: Build the structured prompt using prompts.ts
    const promptData = this.buildPromptData(request);
    const promptTemplate = buildFullPrompt(promptData, tier);
    const fullPrompt = `${promptTemplate.system}\n\n${promptTemplate.user}\n\n${promptTemplate.expectedSchema}`;

    logger.info('Routing AI analysis', {
      mint,
      symbol,
      compositeScore,
      tier,
      model: this.getModelForTier(tier),
    });

    // Step 5: Send to the appropriate LLM tier
    let rawResponse: unknown | null;
    try {
      rawResponse = await this.callLLM(tier, fullPrompt, cacheKey);
    } catch (llmErr: unknown) {
      logger.error('LLM call failed, returning fallback result', {
        mint,
        tier,
        error: llmErr instanceof Error ? llmErr.message : String(llmErr),
      });
      return createFallbackResult(tier);
    }

    // Step 6: Parse the structured JSON response
    if (rawResponse === null || rawResponse === undefined) {
      logger.warn('LLM returned null response, returning fallback result', {
        mint,
        tier,
      });
      return createFallbackResult(tier);
    }

    const parsedResult = parseAIResponse(rawResponse, tier);

    // Step 7: Cache the parsed result with 5-minute TTL
    try {
      await cache.set(cacheKey, parsedResult, LLM_CONFIG.CACHE_TTL_MS);
      logger.debug('Cached AI analysis result', { mint, tier, cacheKey });
    } catch (cacheWriteErr: unknown) {
      logger.warn('Failed to cache AI analysis result', {
        mint,
        tier,
        error: cacheWriteErr instanceof Error ? cacheWriteErr.message : String(cacheWriteErr),
      });
    }

    logger.info('AI analysis complete', {
      mint,
      symbol,
      tier,
      compositeAI: parsedResult.compositeAI,
      confidence: parsedResult.confidence,
      dimensionCount: parsedResult.dimensions.length,
    });

    return parsedResult;
  }

  // =========================================================================
  // Public — determineTier()
  // =========================================================================

  /**
   * Determines which LLM tier should be used based on the composite score.
   *
   * Routing thresholds (from `LLM_CONFIG` in `src/utils/config.ts`):
   *   - Score < 45 (FAST_THRESHOLD)    → `'fast'`     (llama-3.1-8b-instant, 80%)
   *   - Score 45–80 (DETAILED_THRESHOLD) → `'detailed'` (llama-3.3-70b-versatile, 15%)
   *   - Score > 80                       → `'premium'`  (Claude Sonnet, 5%)
   *
   * @param compositeScore - The initial composite score from the 7-factor engine (0–100).
   * @returns The selected LLM tier identifier.
   */
  determineTier(compositeScore: number): LLMTier {
    if (compositeScore > LLM_CONFIG.DETAILED_THRESHOLD) {
      return 'premium';
    }
    if (compositeScore >= LLM_CONFIG.FAST_THRESHOLD) {
      return 'detailed';
    }
    return 'fast';
  }

  // =========================================================================
  // Public — getModelForTier()
  // =========================================================================

  /**
   * Returns the model identifier string for a given LLM tier.
   *
   * @param tier - The LLM tier ('fast', 'detailed', or 'premium').
   * @returns Model identifier string used in API calls.
   */
  getModelForTier(tier: LLMTier): string {
    switch (tier) {
      case 'fast':
        return GROQ_MODELS.FAST;
      case 'detailed':
        return GROQ_MODELS.DETAILED;
      case 'premium':
        return LLM_CONFIG.TIERS.PREMIUM.model;
      default:
        return GROQ_MODELS.FAST;
    }
  }

  // =========================================================================
  // Public — invalidateCache()
  // =========================================================================

  /**
   * Invalidates all cached AI analysis results for a specific token.
   *
   * Delegates to `GroqClient.clearCacheForToken()` which clears cached
   * results across all three tiers (fast, detailed, premium).
   *
   * @param mint - Solana token mint address to clear from cache.
   */
  async invalidateCache(mint: string): Promise<void> {
    await this.client.clearCacheForToken(mint);
    logger.info('Invalidated AI analysis cache for token', { mint });
  }

  // =========================================================================
  // Private — callLLM()
  // =========================================================================

  /**
   * Dispatches the prompt to the appropriate LLM provider based on tier.
   *
   * - Fast and Detailed tiers → `GroqClient.analyze()` with the
   *   corresponding model identifier.
   * - Premium tier → `GroqClient.analyzeWithClaude()` for Anthropic Claude.
   *
   * The `GroqClient` internally handles:
   * - Rate limiting (2 RPS for Groq)
   * - Transport-level caching (via `cacheKey` option)
   * - Structured JSON output format
   * - Error classification and retry logic
   *
   * @param tier - LLM tier determining which provider/model to use.
   * @param prompt - Fully constructed prompt string.
   * @param cacheKey - Cache key for the GroqClient's internal cache layer.
   * @returns Raw LLM response (JSON object or null on failure).
   */
  private async callLLM(
    tier: LLMTier,
    prompt: string,
    cacheKey: string,
  ): Promise<unknown | null> {
    const options = {
      cacheKey,
      responseFormat: 'json' as const,
      temperature: tier === 'premium' ? 0.3 : 0.1,
      maxTokens: tier === 'premium' ? 2048 : 1024,
    };

    switch (tier) {
      case 'fast':
        return this.client.analyze(prompt, GROQ_MODELS.FAST, options);

      case 'detailed':
        return this.client.analyze(prompt, GROQ_MODELS.DETAILED, options);

      case 'premium': {
        // Premium tier uses Claude Sonnet via Anthropic API
        const claudeResult = await this.client.analyzeWithClaude(prompt, options);
        if (claudeResult !== null) {
          return claudeResult;
        }
        // Fallback: if Claude is unavailable (no API key, rate limited, error),
        // downgrade to detailed tier using Groq's 70B model
        logger.warn(
          'Claude premium tier unavailable, falling back to detailed tier',
        );
        return this.client.analyze(prompt, GROQ_MODELS.DETAILED, {
          ...options,
          // Generate a distinct cache key for the fallback to avoid
          // caching a detailed-tier result under the premium key
          cacheKey: `${cacheKey}:fallback`,
        });
      }

      default:
        logger.error('Unknown LLM tier, defaulting to fast', { tier });
        return this.client.analyze(prompt, GROQ_MODELS.FAST, options);
    }
  }

  // =========================================================================
  // Private — buildPromptData()
  // =========================================================================

  /**
   * Converts an `AIAnalysisRequest` into the `TokenDataForPrompt` shape
   * expected by the prompt builder in `src/ai/prompts.ts`.
   *
   * Maps the open-ended `tokenData: Record<string, unknown>` from the
   * request into the typed fields that the prompt builder uses for
   * structured interpolation. Missing fields default to safe neutral values.
   *
   * @param request - The analysis request containing token identification
   *   and all available data.
   * @returns Typed prompt data object ready for `buildFullPrompt()`.
   */
  private buildPromptData(request: AIAnalysisRequest): TokenDataForPrompt {
    const data = request.tokenData;

    // Compute derived fields the prompt interface expects
    const buys1h = this.safeNumber(data.buys1h, 0);
    const sells1h = this.safeNumber(data.sells1h, 0);
    const buySellRatio = sells1h > 0 ? buys1h / sells1h : buys1h > 0 ? 10 : 1;

    // Compute token age in hours from createdAt timestamp
    const createdAt = this.safeNumber(data.createdAt, Math.floor(Date.now() / 1000));
    const tokenAgeHours = Math.max(0, (Date.now() / 1000 - createdAt) / 3600);

    return {
      mint: request.mint,
      symbol: request.symbol,
      price: this.safeNumber(data.price, 0),
      marketCap: this.safeNumber(data.marketCap, 0),
      volume24h: this.safeNumber(data.volume24h, 0),
      liquidity: this.safeNumber(data.liquidity, 0),
      holderCount: this.safeNumber(data.holderCount, 0),
      buySellRatio,
      smartMoneyCount: this.safeNumber(data.smartMoneyCount, 0),
      tokenAgeHours,
      safetyScore: this.safeNumber(data.safetyScore, 0),
      isHoneypot: this.safeBoolean(data.isHoneypot, false),
      devWalletSold: this.safeBoolean(data.devWalletSold, false),
      topHolderPercent: this.safeNumber(data.topHolderPercent, 0),
      lpBurned: this.safeBoolean(data.lpBurned, false),
      compositeScore: request.compositeScore,
    };
  }

  // =========================================================================
  // Private — Type-Safe Field Extractors
  // =========================================================================

  /**
   * Safely extracts a number from an unknown value.
   * Returns the fallback if the value is not a finite number.
   *
   * @param value - Value to extract a number from.
   * @param fallback - Default value if extraction fails.
   * @returns The extracted number or the fallback.
   */
  private safeNumber(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return fallback;
  }

  /**
   * Safely extracts a boolean from an unknown value.
   * Returns the fallback if the value is not a boolean.
   *
   * @param value - Value to extract a boolean from.
   * @param fallback - Default value if extraction fails.
   * @returns The extracted boolean or the fallback.
   */
  private safeBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    return fallback;
  }
}
