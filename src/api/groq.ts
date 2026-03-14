/**
 * src/api/groq.ts — Groq LLM Client with Anthropic Claude Fallback
 *
 * Provides a unified LLM inference client for the GMGN Signal Bot Chrome Extension.
 * Supports two provider backends:
 *   1. Groq Cloud (primary) — llama-3.1-8b-instant and llama-3.3-70b-versatile
 *      via the official groq-sdk package with structured JSON output
 *   2. Anthropic Claude (premium fallback) — Claude Sonnet for top-5% narrative
 *      analysis, called via native fetch() to minimize bundle size
 *
 * Key behaviors:
 *   - MANDATORY 5-minute TTL caching of ALL LLM responses (AAP §0.7.4)
 *   - Cache check BEFORE every API call to avoid redundant inference costs
 *   - Rate limiting via centralized RateLimiter (conservative 2 RPS for Groq)
 *   - Structured JSON output via response_format: { type: 'json_object' }
 *   - Graceful handling of malformed JSON, rate limits, timeouts, and API errors
 *   - API keys NEVER exposed in logs or error messages (service worker only)
 *   - Cost-awareness logging: model name + estimated token count per call
 *
 * Three-tier routing (handled by src/ai/router.ts, supported here via model selection):
 *   - 80% → GROQ_MODELS.FAST (llama-3.1-8b-instant) — routine screening
 *   - 15% → GROQ_MODELS.DETAILED (llama-3.3-70b-versatile) — detailed analysis
 *   -  5% → CLAUDE_MODEL (claude-sonnet) — narrative analysis via analyzeWithClaude()
 *
 * @module api/groq
 */

import Groq from 'groq-sdk';
import { RateLimiter } from './rate-limiter';
import { createLogger, type Logger } from '../utils/logger';
import { cache, LLM_CACHE_TTL } from '../utils/cache';
import { LLM_CONFIG, API_BASE_URLS } from '../utils/config';

// =============================================================================
// Constants — Model Identifiers
// =============================================================================

/**
 * Groq-hosted model identifiers for the two primary LLM tiers.
 *
 * FAST (llama-3.1-8b-instant): Used for 80% of all analyses — quick
 *   pass/fail screening of low-score tokens. Cheapest per-token cost.
 *
 * DETAILED (llama-3.3-70b-versatile): Used for 15% of analyses —
 *   comprehensive evaluation of mid-score tokens requiring deeper reasoning.
 */
export const GROQ_MODELS = {
  /** 80% of calls — routine screening, cheapest tier */
  FAST: 'llama-3.1-8b-instant',
  /** 15% of calls — detailed analysis, moderate cost */
  DETAILED: 'llama-3.3-70b-versatile',
} as const;

/**
 * TypeScript union type of all supported Groq model identifiers.
 * Enables type-safe model selection in the analyze() method.
 */
export type GroqModel = (typeof GROQ_MODELS)[keyof typeof GROQ_MODELS];

/**
 * Anthropic Claude model identifier for the premium narrative analysis tier.
 * Used for top 5% highest-confidence signals only via analyzeWithClaude().
 * Called through native fetch() — no separate Anthropic SDK dependency.
 */
export const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

// =============================================================================
// Types — Analysis Options
// =============================================================================

/**
 * Configuration options for a single LLM analysis request.
 *
 * @property temperature - Sampling temperature (0.0–2.0). Lower values produce
 *   more deterministic, consistent responses. Default: 0.1 for structured analysis.
 * @property maxTokens - Maximum output tokens the model may generate.
 *   Default: 1024 for Groq, 2048 for Claude.
 * @property cacheKey - Optional cache key for TTL-based response caching.
 *   Format convention: `llm:{mint}:{tier}` (e.g., `llm:SOL123abc:fast`).
 *   If provided, the cache is checked before the API call and written after.
 * @property responseFormat - Output format requested from the model.
 *   'json' sends response_format: { type: 'json_object' } to Groq.
 *   'text' requests plain text output. Default: 'json'.
 */
export interface AnalyzeOptions {
  temperature?: number;
  maxTokens?: number;
  cacheKey?: string;
  responseFormat?: 'json' | 'text';
}

// =============================================================================
// Internal Types
// =============================================================================

/**
 * Shape of a successful Anthropic Claude Messages API response.
 * Only the fields we actually consume are typed here.
 */
interface ClaudeMessagesResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{
    type: string;
    text: string;
  }>;
  model: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Shape of an Anthropic API error response body.
 */
interface ClaudeErrorResponse {
  type: string;
  error: {
    type: string;
    message: string;
  };
}

// =============================================================================
// GroqClient Class
// =============================================================================

/**
 * Unified LLM inference client supporting Groq (primary) and Claude (premium).
 *
 * Every public method enforces:
 *   1. Cache check before API call (saves cost on duplicate analyses)
 *   2. Rate limiter acquisition before network request
 *   3. Result caching after successful API call (5-minute TTL)
 *   4. Structured error handling without exposing API keys
 *
 * Instantiate once in the service worker (entrypoints/background.ts) and
 * pass to src/ai/router.ts for three-tier dispatch.
 *
 * @example
 * ```typescript
 * const client = new GroqClient(groqApiKey, anthropicApiKey);
 * const result = await client.analyze(prompt, GROQ_MODELS.FAST, {
 *   cacheKey: client.generateCacheKey(mint, 'fast'),
 * });
 * ```
 */
export class GroqClient {
  /** Official Groq SDK client instance for Groq-hosted models */
  private readonly groq: Groq;

  /** Centralized rate limiter enforcing 2 RPS for Groq API calls */
  private readonly rateLimiter: RateLimiter;

  /** Structured logger with 'groq-api' context tag */
  private readonly logger: Logger;

  /** Optional Anthropic API key for Claude premium tier */
  private readonly anthropicApiKey: string | undefined;

  /** Anthropic API base URL from centralized config */
  private readonly anthropicBaseUrl: string;

  /**
   * Creates a new GroqClient instance.
   *
   * @param groqApiKey - Groq API key for authenticating LLM inference requests.
   *   Must be stored encrypted and retrieved only in the service worker context.
   * @param anthropicApiKey - Optional Anthropic API key for Claude Sonnet
   *   narrative analysis (top 5% signals). If not provided, analyzeWithClaude()
   *   returns null gracefully.
   */
  constructor(groqApiKey: string, anthropicApiKey?: string) {
    // Initialize the official Groq SDK client.
    // dangerouslyAllowBrowser is set to true because this runs in a Chrome
    // Extension service worker, which is a privileged browser context where
    // the API key is stored encrypted — NOT in a public-facing web page.
    this.groq = new Groq({
      apiKey: groqApiKey,
      dangerouslyAllowBrowser: true,
    });

    // Initialize rate limiter — conservative 2 RPS for Groq per AAP §0.7.4
    this.rateLimiter = new RateLimiter();

    // Create a structured logger with 'groq-api' context tag
    this.logger = createLogger('groq-api');

    // Store Anthropic key for optional Claude fallback
    this.anthropicApiKey = anthropicApiKey;

    // Read Anthropic base URL from centralized config
    this.anthropicBaseUrl = API_BASE_URLS.ANTHROPIC;

    this.logger.info(
      'GroqClient initialized',
      { hasAnthropicKey: !!anthropicApiKey },
    );
  }

  // ===========================================================================
  // Public — analyze() — Primary Groq LLM Analysis
  // ===========================================================================

  /**
   * Sends a prompt to a Groq-hosted LLM for analysis and returns the parsed result.
   *
   * Execution flow:
   *   1. Check cache (if cacheKey provided) → return cached result on hit
   *   2. Acquire rate limiter token for 'groq' provider
   *   3. Call Groq API with structured JSON output format
   *   4. Parse response content as JSON (or return raw text)
   *   5. Cache the result with 5-minute TTL
   *   6. Return parsed result
   *
   * @param prompt - The analysis prompt to send to the model
   * @param model - Groq model identifier (use GROQ_MODELS.FAST or GROQ_MODELS.DETAILED)
   * @param options - Optional configuration (temperature, maxTokens, cacheKey, responseFormat)
   * @returns Parsed JSON response object, raw text string, or null on error
   */
  async analyze(
    prompt: string,
    model: GroqModel | string,
    options?: AnalyzeOptions,
  ): Promise<unknown | null> {
    const cacheKey = options?.cacheKey;
    const responseFormat = options?.responseFormat ?? 'json';
    const temperature = options?.temperature ?? 0.1;
    const maxTokens = options?.maxTokens ?? 1024;

    // -----------------------------------------------------------------------
    // Step 1: Cache check — CRITICAL per AAP §0.7.4
    // -----------------------------------------------------------------------
    if (cacheKey) {
      try {
        const cached = await cache.get<unknown>(cacheKey);
        if (cached !== null) {
          this.logger.debug('Cache hit for Groq analysis', { cacheKey, model });
          return cached;
        }
        this.logger.debug('Cache miss for Groq analysis', { cacheKey, model });
      } catch (cacheErr: unknown) {
        // Cache errors should never block the analysis pipeline
        this.logger.warn(
          'Cache read error, proceeding with API call',
          { cacheKey, error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr) },
        );
      }
    }

    // -----------------------------------------------------------------------
    // Step 2: Rate limiter acquisition
    // -----------------------------------------------------------------------
    try {
      await this.rateLimiter.acquire('groq');
    } catch (rateLimitErr: unknown) {
      this.logger.error(
        'Rate limiter timeout for Groq — request dropped',
        { model, error: rateLimitErr instanceof Error ? rateLimitErr.message : String(rateLimitErr) },
      );
      return null;
    }

    // -----------------------------------------------------------------------
    // Step 3: Groq API call
    // -----------------------------------------------------------------------
    try {
      this.logger.debug('Sending Groq API request', { model, temperature, maxTokens, responseFormat });

      // Build the non-streaming request with explicit stream: false.
      // This selects the ChatCompletionCreateParamsNonStreaming overload,
      // ensuring the response type is ChatCompletion (not Stream).
      const response = await this.groq.chat.completions.create({
        model,
        messages: [{ role: 'user' as const, content: prompt }],
        temperature,
        max_tokens: maxTokens,
        stream: false as const,
        // Per AAP: all Groq calls request structured JSON output when responseFormat is 'json'
        ...(responseFormat === 'json'
          ? { response_format: { type: 'json_object' as const } }
          : {}),
      });

      // -----------------------------------------------------------------------
      // Step 4: Parse response
      // -----------------------------------------------------------------------
      const content = response.choices[0]?.message?.content;

      if (!content) {
        this.logger.warn('Groq API returned empty content', { model });
        return null;
      }

      // Log cost-awareness metrics
      const usage = response.usage;
      if (usage) {
        this.logger.info('Groq API usage', {
          model,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        });
      }

      let result: unknown;

      if (responseFormat === 'json') {
        try {
          result = JSON.parse(content);
        } catch (parseErr: unknown) {
          // Malformed JSON despite json_object format — handle gracefully
          this.logger.error(
            'Groq returned malformed JSON despite json_object format',
            {
              model,
              contentPreview: content.substring(0, 200),
              error: parseErr instanceof Error ? parseErr.message : String(parseErr),
            },
          );
          return null;
        }
      } else {
        result = content;
      }

      // -----------------------------------------------------------------------
      // Step 5: Cache the result with 5-minute TTL
      // -----------------------------------------------------------------------
      if (cacheKey && result !== null && result !== undefined) {
        try {
          await cache.set(cacheKey, result, LLM_CACHE_TTL);
          this.logger.debug('Cached Groq analysis result', { cacheKey });
        } catch (cacheWriteErr: unknown) {
          // Cache write failures should not block the response
          this.logger.warn(
            'Failed to cache Groq analysis result',
            { cacheKey, error: cacheWriteErr instanceof Error ? cacheWriteErr.message : String(cacheWriteErr) },
          );
        }
      }

      return result;
    } catch (apiErr: unknown) {
      // Classify and log the error without exposing API keys
      this.handleGroqError(apiErr, model);
      return null;
    }
  }

  // ===========================================================================
  // Public — analyzeWithClaude() — Premium Tier Anthropic Claude Analysis
  // ===========================================================================

  /**
   * Sends a prompt to Anthropic's Claude Sonnet model for premium narrative analysis.
   *
   * Used exclusively for top-5% highest-confidence signals. Called via native
   * fetch() to the Anthropic Messages API — no separate SDK dependency needed.
   *
   * Execution flow:
   *   1. Validate Anthropic API key is configured
   *   2. Check cache (if cacheKey provided) → return cached result on hit
   *   3. Acquire rate limiter token for 'groq' provider (shared bucket)
   *   4. Call Anthropic Messages API via fetch()
   *   5. Parse Claude's response content
   *   6. Cache the result with 5-minute TTL
   *   7. Return parsed result
   *
   * @param prompt - The narrative analysis prompt to send to Claude
   * @param options - Optional configuration (temperature, maxTokens, cacheKey, responseFormat)
   * @returns Parsed response object, raw text string, or null on error/no API key
   */
  async analyzeWithClaude(
    prompt: string,
    options?: AnalyzeOptions,
  ): Promise<unknown | null> {
    // -----------------------------------------------------------------------
    // Step 1: Validate Anthropic API key
    // -----------------------------------------------------------------------
    if (!this.anthropicApiKey) {
      this.logger.warn('Claude analysis requested but no Anthropic API key configured');
      return null;
    }

    const cacheKey = options?.cacheKey;
    const responseFormat = options?.responseFormat ?? 'json';
    const temperature = options?.temperature ?? 0.1;
    const maxTokens = options?.maxTokens ?? 2048;

    // -----------------------------------------------------------------------
    // Step 2: Cache check — CRITICAL per AAP §0.7.4
    // -----------------------------------------------------------------------
    if (cacheKey) {
      try {
        const cached = await cache.get<unknown>(cacheKey);
        if (cached !== null) {
          this.logger.debug('Cache hit for Claude analysis', { cacheKey });
          return cached;
        }
        this.logger.debug('Cache miss for Claude analysis', { cacheKey });
      } catch (cacheErr: unknown) {
        this.logger.warn(
          'Cache read error for Claude, proceeding with API call',
          { cacheKey, error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr) },
        );
      }
    }

    // -----------------------------------------------------------------------
    // Step 3: Rate limiter acquisition (shares the 'groq' bucket for simplicity)
    // -----------------------------------------------------------------------
    try {
      await this.rateLimiter.acquire('groq');
    } catch (rateLimitErr: unknown) {
      this.logger.error(
        'Rate limiter timeout for Claude — request dropped',
        { error: rateLimitErr instanceof Error ? rateLimitErr.message : String(rateLimitErr) },
      );
      return null;
    }

    // -----------------------------------------------------------------------
    // Step 4: Anthropic Messages API call via native fetch()
    // -----------------------------------------------------------------------
    try {
      this.logger.debug('Sending Claude API request', { model: CLAUDE_MODEL, temperature, maxTokens });

      // Build the prompt with JSON instruction if json format is requested
      let effectivePrompt = prompt;
      if (responseFormat === 'json') {
        effectivePrompt = `${prompt}\n\nIMPORTANT: Respond with valid JSON only. Do not include any text outside the JSON object.`;
      }

      const apiUrl = `${this.anthropicBaseUrl}/v1/messages`;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: maxTokens,
          temperature,
          messages: [{ role: 'user', content: effectivePrompt }],
        }),
      });

      // -----------------------------------------------------------------------
      // Step 4a: Handle HTTP errors
      // -----------------------------------------------------------------------
      if (!response.ok) {
        const errorBody = await this.safeReadResponseBody(response);
        this.handleClaudeHttpError(response.status, errorBody);
        return null;
      }

      // -----------------------------------------------------------------------
      // Step 5: Parse Claude's response
      // -----------------------------------------------------------------------
      const responseData = (await response.json()) as ClaudeMessagesResponse;

      // Extract text content from Claude's content blocks
      const textContent = responseData.content?.find(
        (block) => block.type === 'text',
      );

      if (!textContent?.text) {
        this.logger.warn('Claude API returned empty content', { model: CLAUDE_MODEL });
        return null;
      }

      const rawText = textContent.text;

      // Log cost-awareness metrics
      if (responseData.usage) {
        this.logger.info('Claude API usage', {
          model: CLAUDE_MODEL,
          inputTokens: responseData.usage.input_tokens,
          outputTokens: responseData.usage.output_tokens,
        });
      }

      let result: unknown;

      if (responseFormat === 'json') {
        try {
          result = JSON.parse(rawText);
        } catch (parseErr: unknown) {
          // Claude may wrap JSON in markdown code fences — attempt extraction
          const extracted = this.extractJsonFromText(rawText);
          if (extracted !== null) {
            result = extracted;
          } else {
            this.logger.error(
              'Claude returned malformed JSON',
              {
                contentPreview: rawText.substring(0, 200),
                error: parseErr instanceof Error ? parseErr.message : String(parseErr),
              },
            );
            return null;
          }
        }
      } else {
        result = rawText;
      }

      // -----------------------------------------------------------------------
      // Step 6: Cache the result with 5-minute TTL
      // -----------------------------------------------------------------------
      if (cacheKey && result !== null && result !== undefined) {
        try {
          await cache.set(cacheKey, result, LLM_CACHE_TTL);
          this.logger.debug('Cached Claude analysis result', { cacheKey });
        } catch (cacheWriteErr: unknown) {
          this.logger.warn(
            'Failed to cache Claude analysis result',
            { cacheKey, error: cacheWriteErr instanceof Error ? cacheWriteErr.message : String(cacheWriteErr) },
          );
        }
      }

      return result;
    } catch (fetchErr: unknown) {
      // Network errors, DNS failures, etc.
      this.logger.error(
        'Claude API fetch error',
        {
          error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
          model: CLAUDE_MODEL,
        },
      );
      return null;
    }
  }

  // ===========================================================================
  // Public — Cache Helpers
  // ===========================================================================

  /**
   * Generates a standardized cache key for LLM response caching.
   *
   * Cache keys follow the format `llm:{mint}:{tier}` where:
   *   - mint: Solana token mint address
   *   - tier: LLM analysis tier (e.g., 'fast', 'detailed', 'premium')
   *
   * @param mint - Solana token mint address
   * @param tier - Analysis tier identifier (e.g., 'fast', 'detailed', 'premium')
   * @returns Formatted cache key string
   *
   * @example
   * ```typescript
   * const key = client.generateCacheKey('SOL123abc', 'fast');
   * // Returns: 'llm:SOL123abc:fast'
   * ```
   */
  generateCacheKey(mint: string, tier: string): string {
    return `llm:${mint}:${tier}`;
  }

  /**
   * Invalidates all cached LLM analyses for a specific token mint address.
   *
   * Clears cached results for all three tiers (fast, detailed, premium) to
   * force fresh analysis on the next request. Useful when token data changes
   * significantly (e.g., safety status update, major price movement).
   *
   * @param mint - Solana token mint address whose cached analyses should be cleared
   */
  async clearCacheForToken(mint: string): Promise<void> {
    const tiers = ['fast', 'detailed', 'premium'];

    const invalidationPromises = tiers.map(async (tier) => {
      const key = this.generateCacheKey(mint, tier);
      try {
        await cache.invalidate(key);
        this.logger.debug('Invalidated cache for token analysis', { mint, tier });
      } catch (err: unknown) {
        // Cache invalidation errors should not propagate
        this.logger.warn(
          'Failed to invalidate cache entry',
          { mint, tier, error: err instanceof Error ? err.message : String(err) },
        );
      }
    });

    await Promise.allSettled(invalidationPromises);
    this.logger.info('Cleared all cached analyses for token', { mint });
  }

  // ===========================================================================
  // Private — Error Handling
  // ===========================================================================

  /**
   * Classifies and logs Groq API errors without exposing sensitive information.
   *
   * Handles known Groq SDK error types:
   *   - RateLimitError: Logs warning about exceeded rate limits
   *   - AuthenticationError: Logs error about invalid API key (without the key)
   *   - APIConnectionError: Logs network connectivity issues
   *   - APIConnectionTimeoutError: Logs request timeout
   *   - Other errors: Logged as generic API errors
   *
   * @param error - The caught error from the Groq SDK
   * @param model - The model that was being called (for logging context)
   */
  private handleGroqError(error: unknown, model: string): void {
    if (error instanceof Error) {
      const errorName = error.constructor.name;
      const errorMessage = error.message;

      // Classify by Groq SDK error type name (avoids importing all error classes)
      if (errorName === 'RateLimitError' || errorMessage.includes('rate_limit')) {
        this.logger.warn('Groq API rate limit exceeded', { model, errorType: errorName });
      } else if (errorName === 'AuthenticationError' || errorMessage.includes('authentication')) {
        this.logger.error('Groq API authentication failed — check API key configuration', { model });
      } else if (errorName === 'APIConnectionTimeoutError' || errorMessage.includes('timeout')) {
        this.logger.warn('Groq API request timed out', { model });
      } else if (errorName === 'APIConnectionError' || errorMessage.includes('connection')) {
        this.logger.error('Groq API connection error — network issue', { model });
      } else {
        this.logger.error('Groq API error', {
          model,
          errorType: errorName,
          message: errorMessage,
        });
      }
    } else {
      this.logger.error('Unknown Groq API error', { model, error: String(error) });
    }
  }

  /**
   * Handles Claude HTTP error responses with specific error classification.
   *
   * @param status - HTTP status code from the Anthropic API response
   * @param body - Parsed error response body (if readable)
   */
  private handleClaudeHttpError(status: number, body: string | null): void {
    // Attempt to parse structured error from Anthropic
    let errorType = 'unknown';
    let errorMessage = 'Unknown Claude API error';

    if (body) {
      try {
        const parsed = JSON.parse(body) as ClaudeErrorResponse;
        errorType = parsed.error?.type ?? 'unknown';
        errorMessage = parsed.error?.message ?? body;
      } catch {
        errorMessage = body.substring(0, 200);
      }
    }

    switch (status) {
      case 401:
        this.logger.error('Claude API authentication failed — check Anthropic API key', { errorType });
        break;
      case 429:
        this.logger.warn('Claude API rate limit exceeded', { errorType, errorMessage });
        break;
      case 500:
      case 502:
      case 503:
        this.logger.error('Claude API server error', { status, errorType, errorMessage });
        break;
      case 400:
        this.logger.error('Claude API bad request', { errorType, errorMessage });
        break;
      default:
        this.logger.error('Claude API HTTP error', { status, errorType, errorMessage });
    }
  }

  /**
   * Safely reads an HTTP response body as text, returning null on failure.
   * Used for error response parsing where the body may be unreadable.
   *
   * @param response - The fetch Response object to read
   * @returns Response body text or null if unreadable
   */
  private async safeReadResponseBody(response: Response): Promise<string | null> {
    try {
      return await response.text();
    } catch {
      return null;
    }
  }

  /**
   * Attempts to extract a JSON object from text that may contain markdown
   * code fences or other surrounding text. Claude sometimes wraps JSON
   * in ```json ... ``` blocks despite explicit instructions.
   *
   * @param text - Raw text that may contain embedded JSON
   * @returns Parsed JSON object or null if extraction fails
   */
  private extractJsonFromText(text: string): unknown | null {
    // Try to find JSON within markdown code fences
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeBlockMatch?.[1]) {
      try {
        return JSON.parse(codeBlockMatch[1].trim());
      } catch {
        // Code block content was not valid JSON
      }
    }

    // Try to find a JSON object by locating first { and last }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.substring(firstBrace, lastBrace + 1));
      } catch {
        // Extracted substring was not valid JSON
      }
    }

    return null;
  }
}
