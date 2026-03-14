/**
 * src/api/rate-limiter.ts — Token Bucket Per-API Rate Limiter
 *
 * Implements a centralized, per-provider token bucket rate limiter with priority
 * queue support for the GMGN Signal Bot Chrome Extension. Every external API
 * client (Birdeye, Jupiter, DexScreener, Helius, RugCheck, GoPlus, Groq) MUST
 * route requests through this module before making HTTP calls.
 *
 * Key features:
 *   - Token bucket algorithm with time-based refill for precise rate control
 *   - Per-provider independent buckets with configurable RPS and burst capacity
 *   - Priority queue: safety-critical checks (RugCheck, GoPlus, Jupiter honeypot)
 *     receive 'high' priority and jump ahead in the queue
 *   - 30-second queue timeout prevents indefinite blocking when APIs are overwhelmed
 *   - Structured logging with queue growth warnings and timeout error reporting
 *   - Service worker compatible: uses setTimeout for short scheduling bursts
 *
 * Per AAP Section 0.7.4: "Per-API rate limiting is mandatory: Every external API
 * client must route requests through the centralized rate-limiter.ts with
 * provider-specific token bucket configurations."
 *
 * Default rate limits (from src/utils/config.ts RATE_LIMITS):
 *   - Birdeye:     15 RPS (Starter plan)
 *   - Jupiter:      1 RPS (free tier)
 *   - DexScreener:  5 RPS (300 req/min sustained)
 *   - Helius:      10 RPS (Developer plan)
 *   - RugCheck:     5 RPS (best-effort)
 *   - GoPlus:       5 RPS (free tier)
 *   - Groq:         2 RPS (conservative default)
 *
 * @module api/rate-limiter
 */

import { RATE_LIMITS } from '../utils/config';
import { createLogger, type Logger } from '../utils/logger';

// =============================================================================
// Exported Types
// =============================================================================

/**
 * Supported external API provider identifiers.
 *
 * Each provider has an independent token bucket with its own rate limit
 * configuration. Providers map to uppercase keys in the RATE_LIMITS constant
 * from src/utils/config.ts.
 */
export type ApiProvider =
  | 'birdeye'
  | 'jupiter'
  | 'dexscreener'
  | 'helius'
  | 'rugcheck'
  | 'goplus'
  | 'groq';

/**
 * Configuration for a single provider's token bucket rate limiter.
 *
 * @property requestsPerSecond - Sustained token refill rate (tokens added per second)
 * @property burstSize - Maximum tokens the bucket can hold (allows short bursts
 *   above the sustained rate). The bucket starts full at initialization.
 */
export interface RateLimitConfig {
  requestsPerSecond: number;
  burstSize: number;
}

/**
 * Priority levels for queued rate-limited requests.
 *
 * - 'high': Safety-critical checks (RugCheck, GoPlus, Jupiter honeypot detection)
 *   jump to the front of the queue ahead of normal and low priority requests.
 * - 'normal': Standard API calls (token data enrichment, price queries).
 * - 'low': Background/non-urgent requests (fallback data, periodic refreshes).
 *
 * Within the same priority level, requests are processed in FIFO order.
 */
export type RequestPriority = 'high' | 'normal' | 'low';

// =============================================================================
// Internal Types
// =============================================================================

/**
 * Maps request priority string values to numeric weights for sorting.
 * Higher numeric value = higher priority = processed first.
 */
const PRIORITY_WEIGHT: Record<RequestPriority, number> = {
  high: 3,
  normal: 2,
  low: 1,
} as const;

/**
 * Represents a single queued request waiting for a rate limit token.
 */
interface QueuedRequest {
  /** Resolves the caller's Promise<void> when a token is acquired */
  resolve: () => void;
  /** Rejects the caller's Promise<void> on timeout or cancellation */
  reject: (error: Error) => void;
  /** Request priority for queue ordering */
  priority: RequestPriority;
  /** Timestamp (ms) when the request was enqueued — used for timeout tracking */
  enqueuedAt: number;
}

/**
 * Maps lowercase ApiProvider names to uppercase RATE_LIMITS keys.
 */
const PROVIDER_KEY_MAP: Record<ApiProvider, keyof typeof RATE_LIMITS> = {
  birdeye: 'BIRDEYE',
  jupiter: 'JUPITER',
  dexscreener: 'DEXSCREENER',
  helius: 'HELIUS',
  rugcheck: 'RUGCHECK',
  goplus: 'GOPLUS',
  groq: 'GROQ',
} as const;

// =============================================================================
// Token Bucket Implementation
// =============================================================================

/**
 * Token bucket rate limiter for a single API provider.
 *
 * Implements the standard token bucket algorithm:
 *   - Tokens are refilled continuously at `requestsPerSecond / 1000` per ms
 *   - Maximum tokens capped at `burstSize` (bucket cannot overflow)
 *   - Each request consumes exactly 1 token
 *   - When empty, callers must wait until the next token is refilled
 *
 * This class is NOT exported — consumers interact through the RateLimiter class.
 */
class TokenBucket {
  /** Current number of available tokens (may be fractional during refill) */
  private tokens: number;
  /** Maximum tokens the bucket can hold */
  private readonly maxTokens: number;
  /** Token refill rate in tokens per millisecond */
  private readonly refillRate: number;
  /** Timestamp of the last token refill calculation */
  private lastRefillTime: number;

  /**
   * Creates a new TokenBucket with the specified configuration.
   * The bucket starts full (tokens = burstSize).
   *
   * @param config - Rate limit configuration with requestsPerSecond and burstSize
   */
  constructor(config: RateLimitConfig) {
    this.maxTokens = config.burstSize;
    this.tokens = config.burstSize; // Start full
    this.refillRate = config.requestsPerSecond / 1000; // Convert to tokens per ms
    this.lastRefillTime = Date.now();
  }

  /**
   * Refills the bucket based on elapsed time since the last refill.
   * Called internally before every token check to maintain accurate counts.
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;

    if (elapsed > 0) {
      this.tokens = Math.min(
        this.maxTokens,
        this.tokens + elapsed * this.refillRate,
      );
      this.lastRefillTime = now;
    }
  }

  /**
   * Attempts to acquire a single token from the bucket.
   *
   * Refills the bucket based on elapsed time, then checks if a token is
   * available. If available, consumes one token and returns true.
   * Otherwise returns false without modifying the bucket state.
   *
   * @returns true if a token was acquired, false if the bucket is empty
   */
  tryAcquire(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Calculates the time in milliseconds until the next token becomes available.
   *
   * Used by the queue processor to schedule the next processing attempt with
   * minimal delay. Returns 0 if a token is currently available.
   *
   * @returns Milliseconds until the next token is refilled (minimum 1ms)
   */
  timeUntilAvailable(): number {
    this.refill();

    if (this.tokens >= 1) {
      return 0;
    }

    // Calculate ms needed to refill to 1 token
    const deficit = 1 - this.tokens;
    const waitMs = Math.ceil(deficit / this.refillRate);
    return Math.max(1, waitMs); // Minimum 1ms to prevent tight loops
  }

  /**
   * Returns the current number of available tokens (after refill).
   * Used for monitoring/status reporting.
   *
   * @returns Current available token count (floored to integer for display)
   */
  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

// =============================================================================
// RateLimiter Class
// =============================================================================

/** Default timeout for queued requests: 30 seconds */
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;

/** Queue size threshold for logging warnings */
const QUEUE_WARNING_THRESHOLD = 10;

/** Delay threshold (ms) for logging slow queue warnings */
const SLOW_QUEUE_THRESHOLD_MS = 5_000;

/**
 * Centralized per-API token bucket rate limiter with priority queue support.
 *
 * Usage pattern — every API client calls `acquire()` before making a request:
 * ```typescript
 * const limiter = new RateLimiter();
 * await limiter.acquire('birdeye');         // Normal priority
 * await limiter.acquire('rugcheck', 'high'); // Safety-critical, high priority
 * // Make the API call after acquire resolves
 * ```
 *
 * The `acquire()` method:
 *   - Returns immediately if a token is available (zero delay)
 *   - Queues the request and waits if the bucket is empty
 *   - Rejects with an error after 30 seconds of waiting (timeout protection)
 *   - Processes high-priority requests before normal and low priority ones
 *
 * @example
 * ```typescript
 * import { defaultRateLimiter, type ApiProvider } from '@/api/rate-limiter';
 *
 * async function fetchBirdeyeData(mint: string): Promise<Response> {
 *   await defaultRateLimiter.acquire('birdeye');
 *   return fetch(`https://public-api.birdeye.so/defi/price?address=${mint}`);
 * }
 * ```
 */
export class RateLimiter {
  /** Per-provider token buckets keyed by provider name */
  private readonly buckets: Map<ApiProvider, TokenBucket>;

  /** Per-provider priority queues of pending requests */
  private readonly queues: Map<ApiProvider, QueuedRequest[]>;

  /** Active processing timers per provider — prevents duplicate scheduling */
  private readonly processingTimers: Map<ApiProvider, ReturnType<typeof setTimeout>>;

  /** Timeout check intervals per provider — handles queue expiration */
  private readonly timeoutIntervals: Map<ApiProvider, ReturnType<typeof setInterval>>;

  /** Structured logger instance with 'rate-limiter' context tag */
  private readonly logger: Logger;

  /** Maximum time (ms) a request can wait in the queue before rejection */
  private readonly queueTimeoutMs: number;

  /**
   * Creates a new RateLimiter instance with per-provider token buckets.
   *
   * Initializes buckets from the default RATE_LIMITS configuration (imported
   * from src/utils/config.ts), optionally overridden by the `configs` parameter.
   *
   * @param configs - Optional partial map of provider-specific rate limit
   *   overrides. Unspecified providers use defaults from RATE_LIMITS.
   * @param queueTimeoutMs - Maximum wait time for queued requests in ms.
   *   Defaults to 30,000ms (30 seconds).
   */
  constructor(
    configs?: Partial<Record<ApiProvider, RateLimitConfig>>,
    queueTimeoutMs: number = DEFAULT_QUEUE_TIMEOUT_MS,
  ) {
    this.buckets = new Map<ApiProvider, TokenBucket>();
    this.queues = new Map<ApiProvider, QueuedRequest[]>();
    this.processingTimers = new Map<ApiProvider, ReturnType<typeof setTimeout>>();
    this.timeoutIntervals = new Map<ApiProvider, ReturnType<typeof setInterval>>();
    this.logger = createLogger('rate-limiter');
    this.queueTimeoutMs = queueTimeoutMs;

    // Initialize each provider's bucket with defaults from RATE_LIMITS,
    // allowing per-provider overrides via the configs parameter
    const providers: ApiProvider[] = [
      'birdeye',
      'jupiter',
      'dexscreener',
      'helius',
      'rugcheck',
      'goplus',
      'groq',
    ];

    for (const provider of providers) {
      const configKey = PROVIDER_KEY_MAP[provider];
      const defaultConfig = RATE_LIMITS[configKey];
      const overrideConfig = configs?.[provider];

      const finalConfig: RateLimitConfig = {
        requestsPerSecond: overrideConfig?.requestsPerSecond ?? defaultConfig.requestsPerSecond,
        burstSize: overrideConfig?.burstSize ?? defaultConfig.burstSize,
      };

      this.buckets.set(provider, new TokenBucket(finalConfig));
      this.queues.set(provider, []);

      this.logger.debug(
        `Initialized bucket for ${provider}: ${finalConfig.requestsPerSecond} RPS, burst ${finalConfig.burstSize}`,
      );
    }

    this.logger.info('RateLimiter initialized with all provider buckets');
  }

  /**
   * Acquires a rate limit token for the specified API provider.
   *
   * This is the primary public API — every API client must call this method
   * and await it before making an external HTTP request. If a token is
   * immediately available, the method resolves instantly with zero delay.
   * If the bucket is empty, the request is queued by priority and resolved
   * when a token becomes available.
   *
   * Rejects with an Error if the request waits longer than the configured
   * queue timeout (default 30 seconds).
   *
   * @param provider - The API provider to acquire a rate limit token for
   * @param priority - Request priority level. Defaults to 'normal'.
   *   Use 'high' for safety-critical checks (RugCheck, GoPlus, Jupiter honeypot).
   * @returns Promise that resolves when a rate limit token has been acquired
   * @throws Error if the provider is not configured
   * @throws Error if the request times out waiting in the queue
   *
   * @example
   * ```typescript
   * // Normal priority (most API calls)
   * await rateLimiter.acquire('birdeye');
   *
   * // High priority for safety checks
   * await rateLimiter.acquire('rugcheck', 'high');
   *
   * // Low priority for background/fallback requests
   * await rateLimiter.acquire('dexscreener', 'low');
   * ```
   */
  async acquire(
    provider: ApiProvider,
    priority: RequestPriority = 'normal',
  ): Promise<void> {
    const bucket = this.buckets.get(provider);
    if (!bucket) {
      throw new Error(`No rate limit configuration for provider: ${provider}`);
    }

    // Fast path: try immediate acquisition without queuing
    if (bucket.tryAcquire()) {
      this.logger.debug(`Token acquired immediately for ${provider}`);
      return;
    }

    // Slow path: bucket is empty, enqueue and wait
    this.logger.debug(
      `Bucket empty for ${provider}, queuing request with priority '${priority}'`,
    );

    return new Promise<void>((resolve, reject) => {
      const request: QueuedRequest = {
        resolve,
        reject,
        priority,
        enqueuedAt: Date.now(),
      };

      this.enqueue(provider, request);
      this.scheduleProcessing(provider);
      this.ensureTimeoutChecker(provider);
    });
  }

  /**
   * Returns the current status of a provider's rate limiter.
   *
   * Useful for monitoring dashboards, debugging rate limit issues, and
   * adaptive request scheduling.
   *
   * @param provider - The API provider to check status for
   * @returns Object with available token count and current queue length
   * @throws Error if the provider is not configured
   */
  getStatus(provider: ApiProvider): { available: number; queueLength: number } {
    const bucket = this.buckets.get(provider);
    if (!bucket) {
      throw new Error(`No rate limit configuration for provider: ${provider}`);
    }

    const queue = this.queues.get(provider) ?? [];

    return {
      available: bucket.getAvailableTokens(),
      queueLength: queue.length,
    };
  }

  /**
   * Returns the number of requests currently waiting in the queue for
   * the specified provider.
   *
   * @param provider - The API provider to check queue length for
   * @returns Number of queued requests (0 if no queue or provider not found)
   */
  getQueueLength(provider: ApiProvider): number {
    const queue = this.queues.get(provider);
    return queue ? queue.length : 0;
  }

  // ===========================================================================
  // Private — Queue Management
  // ===========================================================================

  /**
   * Inserts a request into the provider's priority queue in the correct
   * position. Higher priority requests are placed before lower priority ones.
   * Within the same priority, FIFO ordering is preserved.
   *
   * @param provider - The API provider queue to insert into
   * @param request - The queued request to insert
   */
  private enqueue(provider: ApiProvider, request: QueuedRequest): void {
    const queue = this.queues.get(provider);
    if (!queue) {
      return;
    }

    const requestWeight = PRIORITY_WEIGHT[request.priority];

    // Find insertion index: insert before the first item with lower priority
    // This maintains FIFO within the same priority level
    let insertIndex = queue.length; // Default: append to end
    for (let i = 0; i < queue.length; i++) {
      const existingWeight = PRIORITY_WEIGHT[queue[i].priority];
      if (existingWeight < requestWeight) {
        insertIndex = i;
        break;
      }
    }

    queue.splice(insertIndex, 0, request);

    // Log warning if queue is growing large
    if (queue.length > QUEUE_WARNING_THRESHOLD) {
      this.logger.warn(
        `Rate limiter queue growing for ${provider}: ${queue.length} requests queued`,
      );
    }
  }

  /**
   * Schedules queue processing for a provider after the next token becomes
   * available. Prevents duplicate timers by checking if a processing timer
   * is already active for the provider.
   *
   * @param provider - The API provider to schedule processing for
   */
  private scheduleProcessing(provider: ApiProvider): void {
    // Prevent duplicate timers for the same provider
    if (this.processingTimers.has(provider)) {
      return;
    }

    const bucket = this.buckets.get(provider);
    if (!bucket) {
      return;
    }

    const delay = bucket.timeUntilAvailable();

    const timer = setTimeout(() => {
      this.processingTimers.delete(provider);
      this.processQueue(provider);
    }, delay);

    this.processingTimers.set(provider, timer);
  }

  /**
   * Processes the provider's queue by attempting to acquire tokens and
   * resolving waiting requests. Processes as many requests as possible
   * in a single pass (draining available tokens), then schedules the
   * next processing if requests remain.
   *
   * @param provider - The API provider queue to process
   */
  private processQueue(provider: ApiProvider): void {
    const bucket = this.buckets.get(provider);
    const queue = this.queues.get(provider);

    if (!bucket || !queue || queue.length === 0) {
      this.cleanupTimeoutChecker(provider);
      return;
    }

    // Process as many queued requests as possible with available tokens
    while (queue.length > 0 && bucket.tryAcquire()) {
      const request = queue.shift()!;
      const waitTime = Date.now() - request.enqueuedAt;

      if (waitTime > SLOW_QUEUE_THRESHOLD_MS) {
        this.logger.warn(
          `Request for ${provider} waited ${waitTime}ms in queue (priority: ${request.priority})`,
        );
      }

      this.logger.debug(
        `Token acquired for queued ${provider} request after ${waitTime}ms (priority: ${request.priority})`,
      );
      request.resolve();
    }

    // If more requests remain, schedule next processing round
    if (queue.length > 0) {
      this.scheduleProcessing(provider);
    } else {
      this.cleanupTimeoutChecker(provider);
    }
  }

  // ===========================================================================
  // Private — Timeout Management
  // ===========================================================================

  /**
   * Ensures a periodic timeout checker is running for the specified provider.
   * The checker scans the queue every second and rejects any requests that
   * have exceeded the configured queue timeout.
   *
   * @param provider - The API provider to monitor for timeouts
   */
  private ensureTimeoutChecker(provider: ApiProvider): void {
    if (this.timeoutIntervals.has(provider)) {
      return; // Already monitoring
    }

    const interval = setInterval(() => {
      this.checkTimeouts(provider);
    }, 1000); // Check every second

    this.timeoutIntervals.set(provider, interval);
  }

  /**
   * Cleans up the timeout checker interval for a provider when its queue
   * is empty (no more requests to monitor).
   *
   * @param provider - The API provider to stop monitoring
   */
  private cleanupTimeoutChecker(provider: ApiProvider): void {
    const interval = this.timeoutIntervals.get(provider);
    if (interval) {
      clearInterval(interval);
      this.timeoutIntervals.delete(provider);
    }
  }

  /**
   * Scans the provider's queue and rejects any requests that have exceeded
   * the configured queue timeout. Expired requests are removed from the queue
   * and rejected with a descriptive error message.
   *
   * @param provider - The API provider queue to check for timeouts
   */
  private checkTimeouts(provider: ApiProvider): void {
    const queue = this.queues.get(provider);
    if (!queue || queue.length === 0) {
      this.cleanupTimeoutChecker(provider);
      return;
    }

    const now = Date.now();
    let expiredCount = 0;

    // Iterate in reverse to safely remove expired items during iteration
    for (let i = queue.length - 1; i >= 0; i--) {
      const request = queue[i];
      const elapsed = now - request.enqueuedAt;

      if (elapsed >= this.queueTimeoutMs) {
        // Remove the expired request from the queue
        queue.splice(i, 1);
        expiredCount++;

        // Reject the caller's promise with a timeout error
        const error = new Error(
          `Rate limit queue timeout for ${provider} after ${elapsed}ms ` +
          `(priority: ${request.priority}, timeout: ${this.queueTimeoutMs}ms)`,
        );
        request.reject(error);
      }
    }

    if (expiredCount > 0) {
      this.logger.error(
        `Rate limiter timed out ${expiredCount} request(s) for ${provider} ` +
        `(remaining in queue: ${queue.length})`,
      );
    }

    // Clean up if queue is now empty
    if (queue.length === 0) {
      this.cleanupTimeoutChecker(provider);
    }
  }
}

// =============================================================================
// Default Singleton Instance
// =============================================================================

/**
 * Pre-configured singleton RateLimiter instance using default rate limits
 * from RATE_LIMITS in src/utils/config.ts.
 *
 * Import this for standard use across all API clients:
 * ```typescript
 * import { defaultRateLimiter } from '@/api/rate-limiter';
 *
 * await defaultRateLimiter.acquire('birdeye');
 * // Make API call...
 * ```
 *
 * Create a custom RateLimiter instance only when overriding default configs:
 * ```typescript
 * const customLimiter = new RateLimiter({ birdeye: { requestsPerSecond: 30, burstSize: 30 } });
 * ```
 */
export const defaultRateLimiter = new RateLimiter();
