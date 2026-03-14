/**
 * src/api/base-client.ts — Abstract HTTP Client with Retry, Timeout, and Caching
 *
 * The foundational HTTP transport layer for all REST API clients in the GMGN
 * Signal Bot Chrome Extension. Provides a production-grade fetch() wrapper with:
 *
 * - Configurable timeout via AbortController (default 10s per AAP)
 * - Exponential backoff retry (3 retries with 1s/2s/4s delays per AAP)
 * - Response caching via chrome.storage.local through src/utils/cache.ts
 * - Structured error classification (rate-limited, auth-failed, server-error, timeout, etc.)
 * - Typed generic request methods for compile-time safety
 * - Structured logging with per-client context tags
 *
 * Consumed by:
 * - src/api/birdeye.ts     — Birdeye token analytics REST client
 * - src/api/jupiter.ts     — Jupiter price/quote REST client
 * - src/api/helius.ts      — Helius enhanced transaction REST client
 * - src/api/dexscreener.ts — DexScreener fallback data REST client
 * - src/api/rugcheck.ts    — RugCheck safety report REST client
 * - src/api/goplus.ts      — GoPlus Security REST client
 *
 * Architecture constraints:
 * - Native fetch() only — no axios, ky, got, or other HTTP libraries
 * - AbortController for timeout — standard browser/service worker API
 * - TypeScript strict mode — generics on all request methods
 *
 * @module src/api/base-client
 */

import { cache } from '../utils/cache';
import { createLogger, type Logger } from '../utils/logger';
import { TIMING } from '../utils/config';

// =============================================================================
// Section 1: Error Type Classification
// =============================================================================

/**
 * Discriminated error type classification for API failures.
 *
 * Each type maps to specific HTTP status codes or network conditions:
 * - `rate-limited`:  429 Too Many Requests (retryable with backoff)
 * - `auth-failed`:   401/403 Unauthorized/Forbidden (NOT retryable — API key issue)
 * - `not-found`:     404 Not Found (NOT retryable)
 * - `server-error`:  5xx Server Errors (retryable)
 * - `timeout`:       Request timed out via AbortController (retryable)
 * - `network-error`: Network failure with no response (retryable)
 * - `parse-error`:   Response body could not be parsed as JSON (NOT retryable)
 * - `unknown`:       Unclassified error (NOT retryable)
 */
export type ApiErrorType =
  | 'rate-limited'
  | 'auth-failed'
  | 'not-found'
  | 'server-error'
  | 'timeout'
  | 'network-error'
  | 'parse-error'
  | 'unknown';

// =============================================================================
// Section 2: Request Options Interface
// =============================================================================

/**
 * Configuration options for a single HTTP request made through BaseClient.
 *
 * All properties are optional — sensible defaults are applied by the BaseClient
 * constructor and the request() method.
 */
export interface RequestOptions {
  /** HTTP method. Defaults to 'GET'. */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';

  /** Additional request headers merged with client default headers.
   *  Request-specific headers override default headers with the same key. */
  headers?: Record<string, string>;

  /** Request body. Automatically serialized to JSON if provided.
   *  A `Content-Type: application/json` header is added unless already present. */
  body?: unknown;

  /** Request timeout in milliseconds. Defaults to TIMING.API_DEFAULT_TIMEOUT_MS (10,000ms).
   *  When exceeded, the request is aborted via AbortController and an ApiError
   *  with errorType 'timeout' is thrown. */
  timeoutMs?: number;

  /** Maximum number of retry attempts after the initial request.
   *  Defaults to 3 (giving 4 total attempts: 1 initial + 3 retries).
   *  Retries use exponential backoff: 1s → 2s → 4s delays. */
  maxRetries?: number;

  /** Cache key for response caching via chrome.storage.local.
   *  When provided, the cache is checked before making the HTTP request.
   *  On a successful response, the result is written to cache with the TTL
   *  specified by cacheTtlMs. */
  cacheKey?: string;

  /** Time-to-live in milliseconds for the cached response.
   *  Only used when cacheKey is also provided. Required for cache writes. */
  cacheTtlMs?: number;

  /** Priority hint for the rate limiter (consumed by src/api/rate-limiter.ts).
   *  'high' priority requests (e.g., safety checks) skip to the front of the
   *  rate limiter queue. Defaults to 'normal'. */
  priority?: 'high' | 'normal' | 'low';
}

// =============================================================================
// Section 3: ApiError Class
// =============================================================================

/**
 * Structured error class for API failures with classification metadata.
 *
 * Extends the native Error class with additional properties that enable
 * callers to make informed decisions about error handling:
 * - `status`:       The HTTP status code (0 for network/timeout errors)
 * - `errorType`:    Classified error category for programmatic handling
 * - `retryable`:    Whether this error can be resolved by retrying the request
 * - `responseBody`: The parsed response body (if available) for debugging
 *
 * @example
 * ```typescript
 * try {
 *   const data = await client.get('/token/info');
 * } catch (error) {
 *   if (error instanceof ApiError) {
 *     if (error.errorType === 'rate-limited') {
 *       // Back off and retry later
 *     } else if (error.errorType === 'auth-failed') {
 *       // Prompt user to check API key
 *     }
 *   }
 * }
 * ```
 */
export class ApiError extends Error {
  /**
   * Creates a new ApiError instance.
   *
   * @param message      - Human-readable error description
   * @param status       - HTTP status code (0 for non-HTTP errors like timeout/network)
   * @param errorType    - Classified error category
   * @param retryable    - Whether the request can be safely retried
   * @param responseBody - The parsed response body, if available
   */
  constructor(
    message: string,
    public readonly status: number,
    public readonly errorType: ApiErrorType,
    public readonly retryable: boolean,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';

    // Maintain proper prototype chain for instanceof checks in strict TS
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

// =============================================================================
// Section 4: BaseClient Class
// =============================================================================

/**
 * Abstract HTTP client with retry, timeout, caching, and error classification.
 *
 * Designed to be instantiated by each API-specific client module with the
 * provider's base URL and default headers (e.g., API key headers):
 *
 * @example
 * ```typescript
 * // In src/api/birdeye.ts:
 * const client = new BaseClient('https://public-api.birdeye.so', {
 *   defaultHeaders: { 'X-API-KEY': apiKey },
 *   loggerContext: 'birdeye-api',
 * });
 *
 * const overview = await client.get<BirdeyeTokenData>(
 *   '/defi/token_overview',
 *   { cacheKey: `birdeye:overview:${mint}`, cacheTtlMs: 30_000 },
 * );
 * ```
 */
export class BaseClient {
  /** Base URL for all requests (protocol + host, no trailing slash). */
  private readonly baseUrl: string;

  /** Default headers applied to every request (e.g., API key, Accept). */
  private readonly defaultHeaders: Record<string, string>;

  /** Structured logger instance with client-specific context tag. */
  private readonly logger: Logger;

  /** Default request timeout in milliseconds. */
  private readonly defaultTimeoutMs: number;

  /** Default maximum retry attempts after the initial request. */
  private readonly maxRetries: number;

  /**
   * Creates a new BaseClient instance.
   *
   * @param baseUrl - The base URL for all requests (e.g., 'https://public-api.birdeye.so').
   *   Trailing slashes are automatically stripped.
   * @param options - Optional configuration overrides.
   * @param options.defaultHeaders - Headers applied to every request (e.g., `{ 'X-API-KEY': key }`).
   * @param options.timeoutMs - Default timeout per request. Defaults to TIMING.API_DEFAULT_TIMEOUT_MS (10s).
   * @param options.maxRetries - Default max retries. Defaults to 3 (1s/2s/4s backoff).
   * @param options.loggerContext - Context tag for the logger. Defaults to 'http-client'.
   */
  constructor(
    baseUrl: string,
    options?: {
      defaultHeaders?: Record<string, string>;
      timeoutMs?: number;
      maxRetries?: number;
      loggerContext?: string;
    },
  ) {
    // Strip trailing slashes from base URL for consistent concatenation
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.defaultHeaders = options?.defaultHeaders ?? {};
    this.defaultTimeoutMs = options?.timeoutMs ?? TIMING.API_DEFAULT_TIMEOUT_MS;
    this.maxRetries = options?.maxRetries ?? 3;
    this.logger = createLogger(options?.loggerContext ?? 'http-client');
  }

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Execute a single HTTP request with timeout, caching, and error classification.
   *
   * This is the core method — it performs exactly ONE attempt with no retries.
   * For automatic retry with backoff, use `requestWithRetry()` instead.
   *
   * Request lifecycle:
   * 1. Check cache (if cacheKey provided) — return cached result on hit
   * 2. Build URL by combining baseUrl + endpoint
   * 3. Merge default headers with request-specific headers
   * 4. Execute fetch() with AbortController timeout
   * 5. Classify and throw ApiError on non-2xx responses
   * 6. Parse response body as JSON
   * 7. Write result to cache (if cacheKey and cacheTtlMs provided)
   * 8. Return typed result
   *
   * @typeParam T - Expected response body type (must be JSON-deserializable)
   * @param endpoint - Request path appended to the base URL (e.g., '/defi/price')
   * @param options  - Optional request configuration overrides
   * @returns Parsed response body typed as T
   * @throws {ApiError} On HTTP errors, timeout, network failures, or parse errors
   */
  async request<T>(endpoint: string, options?: RequestOptions): Promise<T> {
    const method = options?.method ?? 'GET';
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;

    // ── Step 1: Cache check ──
    if (options?.cacheKey) {
      const cached = await cache.get<T>(options.cacheKey);
      if (cached !== null) {
        this.logger.debug(`Cache hit for key: ${options.cacheKey}`);
        return cached;
      }
    }

    // ── Step 2: Build URL ──
    const url = this.buildUrl(endpoint);

    // ── Step 3: Merge headers ──
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...(options?.headers ?? {}),
    };

    // Serialize body to JSON if provided
    let serializedBody: string | undefined;
    if (options?.body !== undefined && options?.body !== null) {
      // Only set Content-Type if not already specified by the caller
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
      serializedBody = JSON.stringify(options.body);
    }

    // ── Step 4: Execute with timeout via AbortController ──
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      this.logger.debug(`${method} ${url}`, { timeout: timeoutMs });

      response = await fetch(url, {
        method,
        headers,
        body: serializedBody,
        signal: controller.signal,
      });
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      // AbortError = timeout triggered by our AbortController
      if (
        error instanceof DOMException &&
        error.name === 'AbortError'
      ) {
        throw new ApiError(
          `Request timeout after ${timeoutMs}ms: ${method} ${url}`,
          0,
          'timeout',
          true,
        );
      }

      // TypeError typically indicates a network-level failure (DNS, CORS, etc.)
      if (error instanceof TypeError) {
        throw new ApiError(
          `Network error: ${method} ${url} — ${error.message}`,
          0,
          'network-error',
          true,
        );
      }

      // Unclassified fetch error
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new ApiError(
        `Request failed: ${method} ${url} — ${errorMessage}`,
        0,
        'unknown',
        false,
      );
    } finally {
      clearTimeout(timeoutId);
    }

    // ── Step 5: Handle non-2xx responses ──
    if (!response.ok) {
      const errorType = this.classifyHttpError(response.status);
      const retryable = this.isRetryable(errorType);

      // Attempt to read the response body for debugging context
      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        try {
          responseBody = await response.text();
        } catch {
          responseBody = undefined;
        }
      }

      this.logger.warn(
        `HTTP ${response.status} ${response.statusText}: ${method} ${url}`,
        { errorType, retryable, responseBody },
      );

      throw new ApiError(
        `HTTP ${response.status} ${response.statusText}: ${method} ${url}`,
        response.status,
        errorType,
        retryable,
        responseBody,
      );
    }

    // ── Step 6: Parse response body as JSON ──
    let result: T;
    try {
      result = (await response.json()) as T;
    } catch {
      throw new ApiError(
        `Failed to parse response as JSON: ${method} ${url}`,
        response.status,
        'parse-error',
        false,
      );
    }

    // ── Step 7: Cache write (only when both cacheKey and cacheTtlMs are provided) ──
    if (options?.cacheKey && options.cacheTtlMs !== undefined && options.cacheTtlMs > 0) {
      await cache.set(options.cacheKey, result, options.cacheTtlMs);
      this.logger.debug(
        `Cached response for key: ${options.cacheKey} (TTL: ${options.cacheTtlMs}ms)`,
      );
    }

    // ── Step 8: Return typed result ──
    this.logger.info(`${method} ${url} → ${response.status}`);
    return result;
  }

  /**
   * Execute an HTTP request with automatic retry and exponential backoff.
   *
   * Wraps the core `request()` method with retry logic per AAP specification:
   * - Up to 3 retry attempts after the initial request (4 total attempts)
   * - Exponential backoff delays: 1s → 2s → 4s (using TIMING.RECONNECT_BACKOFF_BASE_MS)
   * - Only retries retryable errors (rate-limited, server-error, timeout, network-error)
   * - Immediately throws non-retryable errors (auth-failed, not-found, parse-error)
   *
   * @typeParam T - Expected response body type
   * @param endpoint - Request path appended to the base URL
   * @param options  - Optional request configuration overrides
   * @returns Parsed response body typed as T
   * @throws {ApiError} On non-retryable errors or after all retries exhausted
   */
  async requestWithRetry<T>(
    endpoint: string,
    options?: RequestOptions,
  ): Promise<T> {
    const maxRetries = options?.maxRetries ?? this.maxRetries;
    let lastError: ApiError | Error = new Error(
      'Request failed: no attempts were made',
    );

    // Total attempts = 1 (initial) + maxRetries (retries)
    // With default maxRetries=3: attempt 0 (initial), 1 (retry 1), 2 (retry 2), 3 (retry 3)
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.request<T>(endpoint, options);
      } catch (error: unknown) {
        lastError =
          error instanceof Error ? error : new Error(String(error));

        // Non-retryable errors should fail immediately — no point retrying
        // auth failures (bad API key) or 404s (resource doesn't exist)
        if (error instanceof ApiError && !error.retryable) {
          throw error;
        }

        // Apply exponential backoff delay before the next retry attempt
        // Delay schedule: 1s (2^0), 2s (2^1), 4s (2^2)
        if (attempt < maxRetries) {
          const delay =
            TIMING.RECONNECT_BACKOFF_BASE_MS * Math.pow(2, attempt);

          this.logger.warn(
            `Retry ${attempt + 1}/${maxRetries} for ${endpoint} after ${delay}ms`,
            {
              error: lastError.message,
              attempt: attempt + 1,
              maxRetries,
              delayMs: delay,
            },
          );

          await this.sleep(delay);
        }
      }
    }

    // All retry attempts exhausted — throw the last captured error
    this.logger.error(
      `All ${maxRetries} retries exhausted for ${endpoint}`,
      { error: lastError.message },
    );
    throw lastError;
  }

  /**
   * Convenience method for GET requests with automatic retry.
   *
   * @typeParam T - Expected response body type
   * @param endpoint - Request path appended to the base URL
   * @param options  - Optional request configuration (method is forced to 'GET')
   * @returns Parsed response body typed as T
   * @throws {ApiError} On request failure after all retries
   */
  async get<T>(endpoint: string, options?: RequestOptions): Promise<T> {
    return this.requestWithRetry<T>(endpoint, {
      ...options,
      method: 'GET',
    });
  }

  /**
   * Convenience method for POST requests with automatic retry.
   *
   * @typeParam T - Expected response body type
   * @param endpoint - Request path appended to the base URL
   * @param body     - Request body (automatically serialized to JSON)
   * @param options  - Optional request configuration (method is forced to 'POST')
   * @returns Parsed response body typed as T
   * @throws {ApiError} On request failure after all retries
   */
  async post<T>(
    endpoint: string,
    body: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    return this.requestWithRetry<T>(endpoint, {
      ...options,
      method: 'POST',
      body,
    });
  }

  /**
   * Builds a fully-qualified URL from the base URL, endpoint path, and optional
   * query parameters.
   *
   * @param endpoint - Request path (e.g., '/defi/price'). Leading slash is
   *   automatically added if missing.
   * @param params   - Optional key-value pairs appended as URL query parameters.
   *   Values are automatically URL-encoded.
   * @returns Fully-qualified URL string
   *
   * @example
   * ```typescript
   * const client = new BaseClient('https://public-api.birdeye.so');
   * client.buildUrl('/defi/price', { address: 'SOL123', type: '1h' });
   * // → 'https://public-api.birdeye.so/defi/price?address=SOL123&type=1h'
   * ```
   */
  buildUrl(endpoint: string, params?: Record<string, string>): string {
    // Ensure endpoint starts with a forward slash for consistent concatenation
    const normalizedEndpoint = endpoint.startsWith('/')
      ? endpoint
      : `/${endpoint}`;

    const fullUrl = `${this.baseUrl}${normalizedEndpoint}`;

    // Append query parameters if provided
    if (params && Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        searchParams.set(key, value);
      }
      return `${fullUrl}?${searchParams.toString()}`;
    }

    return fullUrl;
  }

  // ---------------------------------------------------------------------------
  // Private Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Classifies an HTTP status code into an ApiErrorType category.
   *
   * Classification rules:
   * - 429        → 'rate-limited' (too many requests — backoff and retry)
   * - 401 / 403  → 'auth-failed' (bad API key — do NOT retry)
   * - 404        → 'not-found' (resource missing — do NOT retry)
   * - 500–599    → 'server-error' (provider issue — retry with backoff)
   * - Others     → 'unknown'
   *
   * @param status - HTTP response status code
   * @returns Classified error type
   */
  private classifyHttpError(status: number): ApiErrorType {
    if (status === 429) {
      return 'rate-limited';
    }
    if (status === 401 || status === 403) {
      return 'auth-failed';
    }
    if (status === 404) {
      return 'not-found';
    }
    if (status >= 500 && status <= 599) {
      return 'server-error';
    }
    return 'unknown';
  }

  /**
   * Determines whether an error type is retryable.
   *
   * Retryable errors are transient conditions that may resolve on subsequent
   * attempts: rate limiting, server errors, timeouts, and network failures.
   *
   * Non-retryable errors indicate permanent conditions: authentication failures
   * (bad API key), not-found (missing resource), parse errors, and unknown errors.
   *
   * @param errorType - The classified error type
   * @returns true if the error is retryable, false otherwise
   */
  private isRetryable(errorType: ApiErrorType): boolean {
    switch (errorType) {
      case 'rate-limited':
      case 'server-error':
      case 'timeout':
      case 'network-error':
        return true;
      case 'auth-failed':
      case 'not-found':
      case 'parse-error':
      case 'unknown':
      default:
        return false;
    }
  }

  /**
   * Asynchronous delay helper for retry backoff timing.
   *
   * @param ms - Duration to sleep in milliseconds
   * @returns Promise that resolves after the specified delay
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
