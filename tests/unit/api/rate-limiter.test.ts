/**
 * tests/unit/api/rate-limiter.test.ts — Token Bucket Rate Limiter Unit Tests
 *
 * Comprehensive test suite for the centralized per-provider token bucket rate
 * limiter used by every external API client in the GMGN Signal Bot Chrome Extension.
 *
 * Tests cover:
 *   - Per-provider bucket configurations (Birdeye 15 RPS, Jupiter 1 RPS, etc.)
 *   - Token refill rates (linear refill, fractional tokens, burstSize cap)
 *   - Queue behavior (FIFO ordering, queuing when empty, resolution on refill)
 *   - Priority processing (high > normal > low, FIFO within same priority)
 *   - Queue timeout (rejection after timeout, cleanup, descriptive errors)
 *   - Status and monitoring (getStatus, getQueueLength, warning logs)
 *   - Edge cases (rapid calls, multi-provider independence, no negative tokens)
 *
 * @module tests/unit/api/rate-limiter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module Mocks — hoisted by Vitest before any imports are resolved
// ---------------------------------------------------------------------------

vi.mock('@/utils/config', () => ({
  RATE_LIMITS: {
    BIRDEYE: { requestsPerSecond: 15, burstSize: 15 },
    JUPITER: { requestsPerSecond: 1, burstSize: 1 },
    DEXSCREENER: { requestsPerSecond: 5, burstSize: 10 },
    HELIUS: { requestsPerSecond: 10, burstSize: 10 },
    RUGCHECK: { requestsPerSecond: 5, burstSize: 5 },
    GOPLUS: { requestsPerSecond: 5, burstSize: 5 },
    GROQ: { requestsPerSecond: 2, burstSize: 5 },
    GMGN_TRADING: { requestsPerSecond: 0.2, burstSize: 1 },
  },
}));

vi.mock('@/utils/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports — resolved AFTER mocks are in place
// ---------------------------------------------------------------------------

import {
  RateLimiter,
  type ApiProvider,
  type RateLimitConfig,
  type RequestPriority,
} from '@/api/rate-limiter';
import { createLogger } from '@/utils/logger';

// ---------------------------------------------------------------------------
// Helper Utilities
// ---------------------------------------------------------------------------

/**
 * Exhausts a provider's token bucket by rapidly acquiring all available tokens.
 * All calls should resolve immediately (bucket starts full).
 */
async function exhaustBucket(
  limiter: RateLimiter,
  provider: ApiProvider,
  count: number,
): Promise<void> {
  const promises: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    promises.push(limiter.acquire(provider));
  }
  await Promise.all(promises);
}

/**
 * Returns the mock Logger instance created by the most recent
 * RateLimiter constructor call. Used for asserting on logger.warn/error calls.
 */
function getMockLogger(): {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const mockedCreate = vi.mocked(createLogger);
  const lastResult = mockedCreate.mock.results.at(-1);
  return lastResult?.value as ReturnType<typeof getMockLogger>;
}

// =============================================================================
// Test Suite
// =============================================================================

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    limiter = new RateLimiter();
  });

  afterEach(() => {
    // Clear all pending timers/intervals BEFORE restoring real timers to prevent
    // leftover setInterval callbacks from the RateLimiter's timeout checker
    // firing and producing unhandled promise rejections during teardown.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // ===========================================================================
  // Per-Provider Bucket Configurations
  // ===========================================================================

  describe('per-provider bucket configurations', () => {
    it('should create Birdeye bucket with 15 RPS', async () => {
      const status = limiter.getStatus('birdeye');
      expect(status.available).toBe(15);
      expect(status.queueLength).toBe(0);

      // All 15 calls should resolve immediately
      await exhaustBucket(limiter, 'birdeye', 15);
      expect(limiter.getStatus('birdeye').available).toBe(0);

      // 16th call should be queued (bucket exhausted)
      const promise = limiter.acquire('birdeye');
      expect(limiter.getQueueLength('birdeye')).toBe(1);

      // Clean up: resolve the queued request
      await vi.advanceTimersByTimeAsync(1000);
      await promise;
    });

    it('should create Jupiter bucket with 1 RPS', async () => {
      const status = limiter.getStatus('jupiter');
      expect(status.available).toBe(1);

      // 1st call resolves immediately
      await limiter.acquire('jupiter');
      expect(limiter.getStatus('jupiter').available).toBe(0);

      // 2nd call should be queued (bucket exhausted after 1 token)
      const promise = limiter.acquire('jupiter');
      expect(limiter.getQueueLength('jupiter')).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      await promise;
    });

    it('should create DexScreener bucket with 5 RPS and burstSize 10', async () => {
      // DexScreener: requestsPerSecond=5, burstSize=10
      // Starts with burstSize (10) tokens
      const status = limiter.getStatus('dexscreener');
      expect(status.available).toBe(10);

      // 10 rapid calls resolve immediately (burstSize tokens)
      await exhaustBucket(limiter, 'dexscreener', 10);
      expect(limiter.getStatus('dexscreener').available).toBe(0);

      // 11th call should be queued
      const promise = limiter.acquire('dexscreener');
      expect(limiter.getQueueLength('dexscreener')).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      await promise;
    });

    it('should create Helius bucket with 10 RPS', async () => {
      const status = limiter.getStatus('helius');
      expect(status.available).toBe(10);

      // 10 calls resolve immediately
      await exhaustBucket(limiter, 'helius', 10);
      expect(limiter.getStatus('helius').available).toBe(0);

      // 11th call should be queued
      const promise = limiter.acquire('helius');
      expect(limiter.getQueueLength('helius')).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      await promise;
    });

    it('should create RugCheck bucket with 5 RPS', async () => {
      const status = limiter.getStatus('rugcheck');
      expect(status.available).toBe(5);

      await exhaustBucket(limiter, 'rugcheck', 5);
      expect(limiter.getStatus('rugcheck').available).toBe(0);
    });

    it('should create GoPlus bucket with 5 RPS', async () => {
      const status = limiter.getStatus('goplus');
      expect(status.available).toBe(5);

      await exhaustBucket(limiter, 'goplus', 5);
      expect(limiter.getStatus('goplus').available).toBe(0);
    });

    it('should create Groq bucket with 2 RPS and burstSize 5', async () => {
      // Groq: requestsPerSecond=2, burstSize=5
      const status = limiter.getStatus('groq');
      expect(status.available).toBe(5);

      await exhaustBucket(limiter, 'groq', 5);
      expect(limiter.getStatus('groq').available).toBe(0);
    });

    it('should throw error for unknown provider', async () => {
      await expect(
        limiter.acquire('unknown_provider' as ApiProvider),
      ).rejects.toThrow('No rate limit configuration for provider');
    });

    it('should accept custom configurations to override defaults', async () => {
      const customLimiter = new RateLimiter({
        birdeye: { requestsPerSecond: 30, burstSize: 30 },
      });

      // Birdeye should now have 30 tokens, not 15
      expect(customLimiter.getStatus('birdeye').available).toBe(30);

      // Other providers should still have default values
      expect(customLimiter.getStatus('jupiter').available).toBe(1);
      expect(customLimiter.getStatus('helius').available).toBe(10);

      // Verify 30 rapid calls resolve for birdeye
      await exhaustBucket(customLimiter, 'birdeye', 30);
      expect(customLimiter.getStatus('birdeye').available).toBe(0);
    });
  });

  // ===========================================================================
  // Token Refill Rates
  // ===========================================================================

  describe('token refill rates', () => {
    it('should refill tokens over time for Birdeye (15 RPS)', async () => {
      // Exhaust Birdeye bucket (15 tokens)
      await exhaustBucket(limiter, 'birdeye', 15);
      expect(limiter.getStatus('birdeye').available).toBe(0);

      // Advance 1 second: 15 RPS × 1s = 15 tokens refilled (capped at burstSize=15)
      vi.advanceTimersByTime(1000);
      expect(limiter.getStatus('birdeye').available).toBe(15);
    });

    it('should refill tokens over time for Jupiter (1 RPS)', async () => {
      // Exhaust Jupiter bucket (1 token)
      await limiter.acquire('jupiter');
      expect(limiter.getStatus('jupiter').available).toBe(0);

      // Advance 1 second: 1 RPS × 1s = 1 token
      vi.advanceTimersByTime(1000);
      expect(limiter.getStatus('jupiter').available).toBe(1);
    });

    it('should refill fractional tokens at correct rate', async () => {
      // Exhaust Jupiter bucket
      await limiter.acquire('jupiter');
      expect(limiter.getStatus('jupiter').available).toBe(0);

      // Advance 500ms: 1 RPS × 0.5s = 0.5 tokens (floored to 0 for display)
      vi.advanceTimersByTime(500);
      expect(limiter.getStatus('jupiter').available).toBe(0);

      // Advance another 500ms (total 1000ms): 1 full token available
      vi.advanceTimersByTime(500);
      expect(limiter.getStatus('jupiter').available).toBe(1);
    });

    it('should not exceed burstSize (bucket cap)', async () => {
      // Birdeye starts full at 15 tokens (burstSize=15)
      expect(limiter.getStatus('birdeye').available).toBe(15);

      // Advance 10 seconds — even though 15 RPS × 10s = 150 potential tokens,
      // the bucket should cap at burstSize (15)
      vi.advanceTimersByTime(10_000);
      expect(limiter.getStatus('birdeye').available).toBe(15);
    });

    it('should refill linearly based on elapsed time', async () => {
      // Exhaust Birdeye bucket completely
      await exhaustBucket(limiter, 'birdeye', 15);
      expect(limiter.getStatus('birdeye').available).toBe(0);

      // Advance 200ms: 15 RPS × 0.2s = 3 tokens
      vi.advanceTimersByTime(200);
      expect(limiter.getStatus('birdeye').available).toBe(3);
    });

    it('should refill DexScreener at 5 RPS up to burstSize 10', async () => {
      // Exhaust DexScreener (burstSize=10)
      await exhaustBucket(limiter, 'dexscreener', 10);
      expect(limiter.getStatus('dexscreener').available).toBe(0);

      // Advance 1 second: 5 RPS × 1s = 5 tokens
      vi.advanceTimersByTime(1000);
      expect(limiter.getStatus('dexscreener').available).toBe(5);

      // Advance another 1 second: 5 more tokens, total 10 = burstSize cap
      vi.advanceTimersByTime(1000);
      expect(limiter.getStatus('dexscreener').available).toBe(10);
    });
  });

  // ===========================================================================
  // Queue Behavior
  // ===========================================================================

  describe('queue behavior', () => {
    it('should queue requests when bucket is empty', async () => {
      // Exhaust Jupiter (1 RPS, burstSize=1)
      await limiter.acquire('jupiter');

      // Second request should be queued (bucket empty)
      const promise = limiter.acquire('jupiter');
      expect(limiter.getQueueLength('jupiter')).toBe(1);
      expect(limiter.getStatus('jupiter').queueLength).toBe(1);

      // Clean up
      await vi.advanceTimersByTimeAsync(1000);
      await promise;
    });

    it('should resolve queued requests when tokens become available', async () => {
      // Exhaust Jupiter bucket
      await limiter.acquire('jupiter');

      // Queue a request
      let resolved = false;
      const promise = limiter.acquire('jupiter').then(() => {
        resolved = true;
      });

      expect(limiter.getQueueLength('jupiter')).toBe(1);

      // Advance 1 second: 1 RPS refills 1 token → queued request resolves
      await vi.advanceTimersByTimeAsync(1000);

      expect(resolved).toBe(true);
      expect(limiter.getQueueLength('jupiter')).toBe(0);
      await promise;
    });

    it('should maintain FIFO ordering within same priority', async () => {
      // Exhaust Jupiter
      await limiter.acquire('jupiter');

      const order: string[] = [];
      const pA = limiter.acquire('jupiter', 'normal').then(() => order.push('A'));
      const pB = limiter.acquire('jupiter', 'normal').then(() => order.push('B'));
      const pC = limiter.acquire('jupiter', 'normal').then(() => order.push('C'));

      expect(limiter.getQueueLength('jupiter')).toBe(3);

      // Advance 1 second → 1 token → A resolves
      await vi.advanceTimersByTimeAsync(1000);
      expect(order).toEqual(['A']);

      // Advance another 1 second → 1 token → B resolves
      await vi.advanceTimersByTimeAsync(1000);
      expect(order).toEqual(['A', 'B']);

      // Advance another 1 second → 1 token → C resolves
      await vi.advanceTimersByTimeAsync(1000);
      expect(order).toEqual(['A', 'B', 'C']);

      await Promise.all([pA, pB, pC]);
    });

    it('should resolve immediately when tokens are available', async () => {
      // Fresh bucket — full tokens available
      const start = Date.now();
      await limiter.acquire('birdeye');
      const elapsed = Date.now() - start;

      // Should resolve with zero delay (no queuing)
      expect(elapsed).toBe(0);
      expect(limiter.getQueueLength('birdeye')).toBe(0);
    });

    it('should handle multiple concurrent acquire calls', async () => {
      // Exhaust all but 2 Birdeye tokens (use 13 of 15)
      await exhaustBucket(limiter, 'birdeye', 13);
      expect(limiter.getStatus('birdeye').available).toBe(2);

      // Fire 5 acquire calls concurrently
      const results: boolean[] = [];
      const promises = Array.from({ length: 5 }, (_, i) =>
        limiter.acquire('birdeye').then(() => {
          results.push(true);
        }),
      );

      // 2 should resolve immediately (tokens available), 3 queued
      // Flush microtasks to capture immediate resolutions
      await vi.advanceTimersByTimeAsync(0);
      expect(results.length).toBe(2);
      expect(limiter.getQueueLength('birdeye')).toBe(3);

      // Advance time to refill and resolve remaining 3
      // 15 RPS means 1 token every ~67ms. 3 tokens ≈ 200ms
      await vi.advanceTimersByTimeAsync(1000);
      expect(results.length).toBe(5);
      expect(limiter.getQueueLength('birdeye')).toBe(0);

      await Promise.all(promises);
    });
  });

  // ===========================================================================
  // Priority Processing
  // ===========================================================================

  describe('priority processing', () => {
    it('should process high-priority requests before normal-priority', async () => {
      // Exhaust Jupiter (1 token)
      await limiter.acquire('jupiter');

      const order: string[] = [];
      const pNormal = limiter
        .acquire('jupiter', 'normal')
        .then(() => order.push('normal'));
      const pHigh = limiter
        .acquire('jupiter', 'high')
        .then(() => order.push('high'));

      expect(limiter.getQueueLength('jupiter')).toBe(2);

      // Advance 1 second → 1 token → high priority resolves first
      await vi.advanceTimersByTimeAsync(1000);
      expect(order[0]).toBe('high');

      // Advance another second → normal resolves
      await vi.advanceTimersByTimeAsync(1000);
      expect(order).toEqual(['high', 'normal']);

      await Promise.all([pNormal, pHigh]);
    });

    it('should process normal-priority before low-priority', async () => {
      await limiter.acquire('jupiter');

      const order: string[] = [];
      const pLow = limiter
        .acquire('jupiter', 'low')
        .then(() => order.push('low'));
      const pNormal = limiter
        .acquire('jupiter', 'normal')
        .then(() => order.push('normal'));

      // Advance to resolve one at a time
      await vi.advanceTimersByTimeAsync(1000);
      expect(order[0]).toBe('normal');

      await vi.advanceTimersByTimeAsync(1000);
      expect(order).toEqual(['normal', 'low']);

      await Promise.all([pLow, pNormal]);
    });

    it('should process high before normal before low', async () => {
      await limiter.acquire('jupiter');

      const order: string[] = [];
      // Queue in reverse priority order: low → normal → high
      const pLow = limiter
        .acquire('jupiter', 'low')
        .then(() => order.push('low'));
      const pNormal = limiter
        .acquire('jupiter', 'normal')
        .then(() => order.push('normal'));
      const pHigh = limiter
        .acquire('jupiter', 'high')
        .then(() => order.push('high'));

      // High priority should be at the front of the queue despite being queued last
      expect(limiter.getQueueLength('jupiter')).toBe(3);

      // Resolve one by one
      await vi.advanceTimersByTimeAsync(1000);
      expect(order).toEqual(['high']);

      await vi.advanceTimersByTimeAsync(1000);
      expect(order).toEqual(['high', 'normal']);

      await vi.advanceTimersByTimeAsync(1000);
      expect(order).toEqual(['high', 'normal', 'low']);

      await Promise.all([pLow, pNormal, pHigh]);
    });

    it('should maintain FIFO within same priority level', async () => {
      await limiter.acquire('jupiter');

      const order: string[] = [];
      const pA = limiter
        .acquire('jupiter', 'normal')
        .then(() => order.push('A'));
      const pB = limiter
        .acquire('jupiter', 'normal')
        .then(() => order.push('B'));
      const pC = limiter
        .acquire('jupiter', 'normal')
        .then(() => order.push('C'));

      await vi.advanceTimersByTimeAsync(1000);
      expect(order[0]).toBe('A');

      await vi.advanceTimersByTimeAsync(1000);
      expect(order[1]).toBe('B');

      await vi.advanceTimersByTimeAsync(1000);
      expect(order).toEqual(['A', 'B', 'C']);

      await Promise.all([pA, pB, pC]);
    });

    it('safety-critical requests with high priority jump ahead in queue', async () => {
      // Simulate a scenario where RugCheck/GoPlus/Jupiter honeypot checks
      // (high priority) should jump ahead of normal API enrichment requests
      await limiter.acquire('jupiter');

      const order: string[] = [];
      // Queue several normal-priority requests first
      const pN1 = limiter
        .acquire('jupiter', 'normal')
        .then(() => order.push('enrichment-1'));
      const pN2 = limiter
        .acquire('jupiter', 'normal')
        .then(() => order.push('enrichment-2'));

      // Then queue a high-priority safety check
      const pHigh = limiter
        .acquire('jupiter', 'high')
        .then(() => order.push('safety-check'));

      // Safety check should resolve before the enrichment requests
      await vi.advanceTimersByTimeAsync(1000);
      expect(order[0]).toBe('safety-check');

      // Clean up remaining
      await vi.advanceTimersByTimeAsync(2000);
      await Promise.all([pN1, pN2, pHigh]);
    });
  });

  // ===========================================================================
  // Queue Timeout
  // ===========================================================================

  describe('queue timeout', () => {
    it('should reject queued request after timeout expires', async () => {
      // Create a limiter with a very slow refill and short timeout
      // so the request cannot be served before timeout
      const slowLimiter = new RateLimiter(
        { jupiter: { requestsPerSecond: 0.001, burstSize: 1 } },
        2000, // 2-second timeout
      );

      // Exhaust the single token
      await slowLimiter.acquire('jupiter');

      // Queue a request — refill won't produce a token for ~1,000,000ms
      // but timeout will fire at 2000ms
      const promise = slowLimiter.acquire('jupiter');

      // Attach rejection expectation BEFORE advancing timers to prevent
      // unhandled rejection warnings during timer advancement
      const expectation = expect(promise).rejects.toThrow(
        /rate limit queue timeout/i,
      );

      // Advance past the timeout (interval checks every 1000ms)
      await vi.advanceTimersByTimeAsync(3000);

      await expectation;
    });

    it('should clean up timed-out requests from the queue', async () => {
      const slowLimiter = new RateLimiter(
        { jupiter: { requestsPerSecond: 0.001, burstSize: 1 } },
        2000,
      );

      await slowLimiter.acquire('jupiter');

      // Queue 3 requests
      const p1 = slowLimiter.acquire('jupiter').catch(() => {});
      const p2 = slowLimiter.acquire('jupiter').catch(() => {});
      const p3 = slowLimiter.acquire('jupiter').catch(() => {});
      expect(slowLimiter.getQueueLength('jupiter')).toBe(3);

      // Advance past timeout — all 3 should be rejected and removed
      await vi.advanceTimersByTimeAsync(3000);
      expect(slowLimiter.getQueueLength('jupiter')).toBe(0);

      await Promise.all([p1, p2, p3]);
    });

    it('should not reject request that resolves before timeout', async () => {
      // Default timeout is 30s, Jupiter refills 1 token in 1 second
      await limiter.acquire('jupiter');

      const promise = limiter.acquire('jupiter');
      expect(limiter.getQueueLength('jupiter')).toBe(1);

      // Advance 1 second — token refills, request should resolve (well before 30s timeout)
      await vi.advanceTimersByTimeAsync(1000);

      // Should resolve successfully, NOT reject
      await expect(promise).resolves.toBeUndefined();
      expect(limiter.getQueueLength('jupiter')).toBe(0);
    });

    it('should timeout with descriptive error message', async () => {
      const slowLimiter = new RateLimiter(
        { jupiter: { requestsPerSecond: 0.001, burstSize: 1 } },
        2000,
      );

      await slowLimiter.acquire('jupiter');

      // Capture the rejection error via .catch() BEFORE advancing timers
      let caughtError: Error | null = null;
      const promise = slowLimiter.acquire('jupiter').catch((e: Error) => {
        caughtError = e;
      });

      await vi.advanceTimersByTimeAsync(3000);
      await promise;

      // Validate error details
      expect(caughtError).not.toBeNull();
      // Error message should contain provider name
      expect(caughtError!.message).toContain('jupiter');
      // Error message should contain timeout duration
      expect(caughtError!.message).toContain('2000');
      // Error message should mention rate limit
      expect(caughtError!.message.toLowerCase()).toContain('rate limit');
      // Error message should mention timeout
      expect(caughtError!.message.toLowerCase()).toContain('timeout');
    });
  });

  // ===========================================================================
  // Status and Monitoring
  // ===========================================================================

  describe('status and monitoring', () => {
    it('getStatus returns correct available tokens and queue length', async () => {
      // Fresh limiter — full Birdeye bucket
      let status = limiter.getStatus('birdeye');
      expect(status.available).toBe(15);
      expect(status.queueLength).toBe(0);

      // Use 5 tokens
      await exhaustBucket(limiter, 'birdeye', 5);
      status = limiter.getStatus('birdeye');
      expect(status.available).toBe(10);
      expect(status.queueLength).toBe(0);

      // Exhaust remaining 10 tokens
      await exhaustBucket(limiter, 'birdeye', 10);
      expect(limiter.getStatus('birdeye').available).toBe(0);

      // Queue 3 requests
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 3; i++) {
        promises.push(limiter.acquire('birdeye'));
      }
      status = limiter.getStatus('birdeye');
      expect(status.queueLength).toBe(3);

      // Clean up
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.all(promises);
    });

    it('getQueueLength returns correct count', async () => {
      // Fresh — no queue
      expect(limiter.getQueueLength('jupiter')).toBe(0);

      // Exhaust and queue 2 requests
      await limiter.acquire('jupiter');
      const p1 = limiter.acquire('jupiter');
      const p2 = limiter.acquire('jupiter');
      expect(limiter.getQueueLength('jupiter')).toBe(2);

      // Resolve one
      await vi.advanceTimersByTimeAsync(1000);
      expect(limiter.getQueueLength('jupiter')).toBe(1);

      // Resolve the other
      await vi.advanceTimersByTimeAsync(1000);
      expect(limiter.getQueueLength('jupiter')).toBe(0);

      await Promise.all([p1, p2]);
    });

    it('should log warnings when queue grows beyond threshold', async () => {
      const logger = getMockLogger();

      // Exhaust Jupiter
      await limiter.acquire('jupiter');

      // Queue more than QUEUE_WARNING_THRESHOLD (10) requests
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 12; i++) {
        promises.push(limiter.acquire('jupiter').catch(() => {}));
      }

      // Logger.warn should have been called when queue exceeded threshold
      expect(logger.warn).toHaveBeenCalled();
      const warnCalls = logger.warn.mock.calls.map(
        (args: unknown[]) => args[0] as string,
      );
      const queueWarning = warnCalls.find(
        (msg: string) => msg.includes('queue growing') || msg.includes('queued'),
      );
      expect(queueWarning).toBeDefined();
      expect(queueWarning).toContain('jupiter');

      // Clean up
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.allSettled(promises);
    });

    it('getStatus throws error for unknown provider', () => {
      expect(() => limiter.getStatus('unknown' as ApiProvider)).toThrow(
        'No rate limit configuration for provider',
      );
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle rapid successive acquire calls correctly', async () => {
      // Fire 100 rapid acquire calls for Birdeye (burstSize=15)
      const results: number[] = [];
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 100; i++) {
        promises.push(
          limiter.acquire('birdeye').then(() => {
            results.push(i);
          }),
        );
      }

      // Flush microtasks for immediate resolutions
      await vi.advanceTimersByTimeAsync(0);

      // First 15 should resolve immediately, 85 queued
      expect(results.length).toBe(15);
      expect(limiter.getQueueLength('birdeye')).toBe(85);

      // Advance time to process all remaining: 85 tokens at 15 RPS ≈ 6 seconds
      await vi.advanceTimersByTimeAsync(10_000);
      expect(results.length).toBe(100);
      expect(limiter.getQueueLength('birdeye')).toBe(0);

      await Promise.all(promises);
    });

    it('should handle acquire for multiple providers simultaneously', async () => {
      // Verify providers have independent buckets
      const birdeyeStatus = limiter.getStatus('birdeye');
      const jupiterStatus = limiter.getStatus('jupiter');
      const heliusStatus = limiter.getStatus('helius');

      expect(birdeyeStatus.available).toBe(15);
      expect(jupiterStatus.available).toBe(1);
      expect(heliusStatus.available).toBe(10);

      // Use all Jupiter tokens — should NOT affect Birdeye or Helius
      await limiter.acquire('jupiter');
      expect(limiter.getStatus('jupiter').available).toBe(0);
      expect(limiter.getStatus('birdeye').available).toBe(15);
      expect(limiter.getStatus('helius').available).toBe(10);

      // Concurrently acquire from all three
      const pBirdeye = limiter.acquire('birdeye');
      const pJupiter = limiter.acquire('jupiter'); // will queue
      const pHelius = limiter.acquire('helius');

      // Birdeye and Helius should resolve immediately, Jupiter queued
      await vi.advanceTimersByTimeAsync(0);
      expect(limiter.getQueueLength('birdeye')).toBe(0);
      expect(limiter.getQueueLength('jupiter')).toBe(1);
      expect(limiter.getQueueLength('helius')).toBe(0);

      await vi.advanceTimersByTimeAsync(1000);
      await Promise.all([pBirdeye, pJupiter, pHelius]);
    });

    it('should not allow negative token counts', async () => {
      // Even after exhausting and checking multiple times, available should be >= 0
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
        const status = limiter.getStatus(provider);
        // Exhaust all tokens
        await exhaustBucket(limiter, provider, status.available);
        expect(limiter.getStatus(provider).available).toBeGreaterThanOrEqual(0);
      }
    });

    it('should handle interleaved acquire and getStatus calls', async () => {
      // Interleave acquire and status checks to verify refill is consistent
      await limiter.acquire('birdeye');
      expect(limiter.getStatus('birdeye').available).toBe(14);

      await limiter.acquire('birdeye');
      expect(limiter.getStatus('birdeye').available).toBe(13);

      vi.advanceTimersByTime(1000);
      // After 1 second, 15 tokens refill but we used 2, so:
      // tokens = 13 + 15 = 28 → capped at burstSize 15
      expect(limiter.getStatus('birdeye').available).toBe(15);
    });

    it('should handle zero-delay acquire when bucket has exactly 1 token', async () => {
      // Exhaust all but 1 Birdeye token
      await exhaustBucket(limiter, 'birdeye', 14);
      expect(limiter.getStatus('birdeye').available).toBe(1);

      // Should resolve immediately (exactly 1 token remaining)
      const start = Date.now();
      await limiter.acquire('birdeye');
      const elapsed = Date.now() - start;
      expect(elapsed).toBe(0);
      expect(limiter.getStatus('birdeye').available).toBe(0);
    });

    it('should log error when requests time out', async () => {
      vi.clearAllMocks();
      const slowLimiter = new RateLimiter(
        { jupiter: { requestsPerSecond: 0.001, burstSize: 1 } },
        2000,
      );
      const logger = vi.mocked(createLogger).mock.results.at(-1)?.value as {
        error: ReturnType<typeof vi.fn>;
      };

      await slowLimiter.acquire('jupiter');
      // Attach catch handler immediately to prevent unhandled rejection
      const promise = slowLimiter.acquire('jupiter').catch(() => {});

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(3000);
      await promise;

      // Logger.error should have been called about the timeout
      expect(logger.error).toHaveBeenCalled();
      const errorCalls = logger.error.mock.calls.map(
        (args: unknown[]) => args[0] as string,
      );
      const timeoutMsg = errorCalls.find((msg: string) =>
        msg.toLowerCase().includes('timed out'),
      );
      expect(timeoutMsg).toBeDefined();
    });
  });

  // ===========================================================================
  // Constructor and Initialization
  // ===========================================================================

  describe('constructor and initialization', () => {
    it('should initialize all 7 provider buckets', () => {
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
        const status = limiter.getStatus(provider);
        expect(status).toBeDefined();
        expect(status.available).toBeGreaterThan(0);
        expect(status.queueLength).toBe(0);
      }
    });

    it('should call createLogger with rate-limiter context', () => {
      expect(createLogger).toHaveBeenCalledWith('rate-limiter');
    });

    it('should use custom queue timeout when provided', async () => {
      // Create limiter with very short timeout (500ms) and very slow refill
      const shortTimeoutLimiter = new RateLimiter(
        { jupiter: { requestsPerSecond: 0.001, burstSize: 1 } },
        500,
      );

      await shortTimeoutLimiter.acquire('jupiter');
      const promise = shortTimeoutLimiter.acquire('jupiter');

      // Attach rejection expectation BEFORE advancing timers
      const expectation = expect(promise).rejects.toThrow(/timeout/i);

      // Advance past the custom timeout
      await vi.advanceTimersByTimeAsync(2000);

      await expectation;
    });

    it('should partially override configs while keeping defaults for other providers', async () => {
      const partialLimiter = new RateLimiter({
        groq: { requestsPerSecond: 10, burstSize: 20 },
      });

      // Groq should be overridden
      expect(partialLimiter.getStatus('groq').available).toBe(20);

      // All others should use defaults
      expect(partialLimiter.getStatus('birdeye').available).toBe(15);
      expect(partialLimiter.getStatus('jupiter').available).toBe(1);
      expect(partialLimiter.getStatus('dexscreener').available).toBe(10);
      expect(partialLimiter.getStatus('helius').available).toBe(10);
      expect(partialLimiter.getStatus('rugcheck').available).toBe(5);
      expect(partialLimiter.getStatus('goplus').available).toBe(5);
    });
  });
});
