/**
 * tests/unit/tracking/convergence-detector.test.ts
 *
 * Comprehensive unit tests for the ConvergenceDetector class.
 * Tests time-windowed multi-wallet convergence detection per AAP Section 0.1.1:
 *   "Detect convergence signals when 3+ qualified smart money wallets enter
 *    the same token within a 2-hour window, with position-size context analysis
 *    (entries above 80% of historical average indicating conviction)"
 *
 * Key behaviors tested:
 *   1. 3+ qualified wallets within 2-hour window → fires ConvergenceEvent
 *   2. Fewer than 3 wallets → no event fires
 *   3. Expired entries outside sliding window are cleaned up
 *   4. Position size above 80% of historical average → conviction boost
 *   5. Wallet quality weights applied to convergence scoring
 *
 * @module tests/unit/tracking/convergence-detector
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ConvergenceEvent,
  WalletClassification,
  PositionSizeContext,
} from '../../../src/tracking/types';

// ---------------------------------------------------------------------------
// Module Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

/**
 * Mock src/utils/logger to provide a no-op logger. Prevents actual console
 * output during tests and avoids import.meta.env issues in the test env.
 */
vi.mock('../../../src/utils/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

/**
 * Mock src/utils/config to provide deterministic SMART_MONEY_CONFIG defaults.
 * These match the AAP specification:
 *   - MIN_CONVERGENCE_WALLETS: 3
 *   - CONVERGENCE_WINDOW_MS: 7,200,000 ms (2 hours)
 *   - CONVICTION_THRESHOLD_PERCENT: 80
 */
vi.mock('../../../src/utils/config', () => ({
  SMART_MONEY_CONFIG: {
    MIN_CONVERGENCE_WALLETS: 3,
    CONVERGENCE_WINDOW_MS: 2 * 60 * 60 * 1000,
    CONVICTION_THRESHOLD_PERCENT: 80,
  },
}));

// ---------------------------------------------------------------------------
// Import Module Under Test (AFTER mocks)
// ---------------------------------------------------------------------------

import {
  ConvergenceDetector,
  QUALITY_WEIGHTS,
} from '../../../src/tracking/convergence-detector';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Two hours in milliseconds — the default convergence detection window. */
const TWO_HOURS_MS = 2 * 60 * 60 * 1000; // 7,200,000

/** One minute in milliseconds — used for small time offsets. */
const ONE_MINUTE_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a wallet entry object suitable for ConvergenceDetector.recordEntry().
 * All fields have sensible defaults that can be overridden.
 */
function createEntry(
  overrides: Partial<{
    walletAddress: string;
    classification: WalletClassification;
    timestamp: number;
    positionSize: number;
    historicalAvgSize: number;
    txHash: string;
  }> = {},
) {
  return {
    walletAddress:
      overrides.walletAddress ??
      'wallet-' + Math.random().toString(36).substring(2, 9),
    classification:
      overrides.classification ?? ('smart_money' as WalletClassification),
    timestamp: overrides.timestamp ?? Date.now(),
    positionSize: overrides.positionSize ?? 1000,
    historicalAvgSize: overrides.historicalAvgSize ?? 800,
    txHash:
      overrides.txHash ??
      'tx-' + Math.random().toString(36).substring(2, 9),
  };
}

/**
 * Records multiple unique wallet entries for a given token.
 * Returns the array of created entries for assertion use.
 */
function recordEntries(
  detector: ConvergenceDetector,
  tokenAddress: string,
  count: number,
  options?: {
    classification?: WalletClassification;
    positionSize?: number;
    historicalAvgSize?: number;
    timestampGap?: number;
  },
) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    const entry = createEntry({
      walletAddress: `wallet-${i}`,
      classification: options?.classification ?? 'smart_money',
      timestamp: Date.now() + (options?.timestampGap ?? 0) * i,
      positionSize: options?.positionSize ?? 1000,
      historicalAvgSize: options?.historicalAvgSize ?? 800,
    });
    detector.recordEntry(tokenAddress, entry);
    entries.push(entry);
  }
  return entries;
}

// ===========================================================================
// Main Test Suite
// ===========================================================================

describe('ConvergenceDetector', () => {
  let detector: ConvergenceDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new ConvergenceDetector();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Phase 2: Core Convergence Detection
  // =========================================================================

  describe('Core Convergence', () => {
    it('fires ConvergenceEvent when 3+ qualified wallets enter the same token within 2-hour window', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      const baseTime = Date.now();

      detector.recordEntry(
        'token-abc',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money',
          timestamp: baseTime,
        }),
      );
      detector.recordEntry(
        'token-abc',
        createEntry({
          walletAddress: 'w2',
          classification: 'whale',
          timestamp: baseTime + 1000,
        }),
      );
      detector.recordEntry(
        'token-abc',
        createEntry({
          walletAddress: 'w3',
          classification: 'insider',
          timestamp: baseTime + 2000,
        }),
      );

      // Callback should have been called exactly once (convergence detected on 3rd entry)
      expect(callback).toHaveBeenCalledTimes(1);

      const event = callback.mock.calls[0][0];
      expect(event.token).toBe('token-abc');
      expect(event.walletCount).toBe(3);
      expect(event.wallets).toHaveLength(3);

      // Verify wallet addresses are present
      const walletAddresses = event.wallets.map((w) => w.address);
      expect(walletAddresses).toContain('w1');
      expect(walletAddresses).toContain('w2');
      expect(walletAddresses).toContain('w3');

      // Window timestamps must be valid
      expect(event.windowEnd).toBeGreaterThanOrEqual(event.windowStart);

      // Conviction score should be a valid percentage (0–100)
      expect(event.convictionScore).toBeGreaterThanOrEqual(0);
      expect(event.convictionScore).toBeLessThanOrEqual(100);

      // Average quality weight should be positive
      expect(event.avgQualityWeight).toBeGreaterThan(0);
    });

    it('does NOT fire convergence event when fewer than 3 wallets are recorded', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      detector.recordEntry(
        'token-xyz',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money',
        }),
      );
      detector.recordEntry(
        'token-xyz',
        createEntry({
          walletAddress: 'w2',
          classification: 'whale',
        }),
      );

      // Only 2 wallets — below the threshold of 3
      expect(callback).not.toHaveBeenCalled();
    });

    it('fires exactly once when exactly 3 wallets are recorded, then again on 4th', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // Record 3 wallets — should fire once on the 3rd entry
      recordEntries(detector, 'token-exact', 3);
      expect(callback).toHaveBeenCalledTimes(1);

      // Record a 4th wallet — should fire again (still meets threshold)
      detector.recordEntry(
        'token-exact',
        createEntry({
          walletAddress: 'wallet-3',
          classification: 'smart_money',
        }),
      );
      expect(callback).toHaveBeenCalledTimes(2);

      // Verify the 2nd event has 4 wallets
      const secondEvent = callback.mock.calls[1][0];
      expect(secondEvent.walletCount).toBe(4);
    });

    it('tracks different tokens independently', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // 2 wallets on token A (no convergence)
      detector.recordEntry(
        'token-A',
        createEntry({ walletAddress: 'wA1', classification: 'smart_money' }),
      );
      detector.recordEntry(
        'token-A',
        createEntry({ walletAddress: 'wA2', classification: 'whale' }),
      );

      // 2 wallets on token B (no convergence)
      detector.recordEntry(
        'token-B',
        createEntry({ walletAddress: 'wB1', classification: 'smart_money' }),
      );
      detector.recordEntry(
        'token-B',
        createEntry({ walletAddress: 'wB2', classification: 'insider' }),
      );

      expect(callback).not.toHaveBeenCalled();

      // Add 3rd wallet on token A only → convergence on A only
      detector.recordEntry(
        'token-A',
        createEntry({ walletAddress: 'wA3', classification: 'kol' }),
      );

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].token).toBe('token-A');
    });

    it('counts duplicate wallet address as 1 unique wallet, not multiple', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      const baseTime = Date.now();

      // Same wallet address recorded 3 times — should count as 1 unique
      detector.recordEntry(
        'token-dup',
        createEntry({
          walletAddress: 'same-wallet',
          classification: 'smart_money',
          timestamp: baseTime,
        }),
      );
      detector.recordEntry(
        'token-dup',
        createEntry({
          walletAddress: 'same-wallet',
          classification: 'smart_money',
          timestamp: baseTime + 1000,
        }),
      );
      detector.recordEntry(
        'token-dup',
        createEntry({
          walletAddress: 'same-wallet',
          classification: 'smart_money',
          timestamp: baseTime + 2000,
        }),
      );

      // Only 1 unique wallet — below threshold of 3
      expect(callback).not.toHaveBeenCalled();
    });

    it('does not fire when only 1 wallet is recorded', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      detector.recordEntry(
        'token-solo',
        createEntry({ walletAddress: 'lone-wolf', classification: 'whale' }),
      );

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Phase 3: Sliding Window & Expiration
  // =========================================================================

  describe('Sliding Window & Expiration', () => {
    it('does NOT fire convergence when first entry has expired outside the 2-hour window', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // Record w1 at current time
      detector.recordEntry(
        'token-exp',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money',
          timestamp: Date.now(),
        }),
      );

      // Advance time by 2 hours + 1 minute (past the window)
      vi.advanceTimersByTime(TWO_HOURS_MS + ONE_MINUTE_MS);

      // Record w2 and w3 at the new current time
      detector.recordEntry(
        'token-exp',
        createEntry({
          walletAddress: 'w2',
          classification: 'whale',
          timestamp: Date.now(),
        }),
      );
      detector.recordEntry(
        'token-exp',
        createEntry({
          walletAddress: 'w3',
          classification: 'insider',
          timestamp: Date.now(),
        }),
      );

      // w1 expired → only 2 wallets in window → no convergence
      expect(callback).not.toHaveBeenCalled();
    });

    it('fires convergence when entries are within the window boundary', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // Record w1 at current time
      detector.recordEntry(
        'token-in',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money',
          timestamp: Date.now(),
        }),
      );

      // Advance time by 1 hour 59 minutes (just inside the 2-hour window)
      vi.advanceTimersByTime(TWO_HOURS_MS - ONE_MINUTE_MS);

      // Record w2 and w3
      detector.recordEntry(
        'token-in',
        createEntry({
          walletAddress: 'w2',
          classification: 'whale',
          timestamp: Date.now(),
        }),
      );
      detector.recordEntry(
        'token-in',
        createEntry({
          walletAddress: 'w3',
          classification: 'insider',
          timestamp: Date.now(),
        }),
      );

      // All 3 wallets still within window → convergence fires
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].walletCount).toBe(3);
    });

    it('expires entries at the exact window boundary (timestamp === cutoff is expired)', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // Record w1 at current time
      const startTime = Date.now();
      detector.recordEntry(
        'token-boundary',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money',
          timestamp: startTime,
        }),
      );

      // Advance time by EXACTLY 2 hours
      vi.advanceTimersByTime(TWO_HOURS_MS);

      // Now Date.now() = startTime + TWO_HOURS_MS
      // Cutoff = Date.now() - TWO_HOURS_MS = startTime
      // w1.timestamp (= startTime) is NOT > cutoff (= startTime) → expired

      detector.recordEntry(
        'token-boundary',
        createEntry({
          walletAddress: 'w2',
          classification: 'whale',
          timestamp: Date.now(),
        }),
      );
      detector.recordEntry(
        'token-boundary',
        createEntry({
          walletAddress: 'w3',
          classification: 'insider',
          timestamp: Date.now(),
        }),
      );

      // w1 expired at exact boundary → only 2 in window → no convergence
      expect(callback).not.toHaveBeenCalled();
    });

    it('cleanup() removes all expired entries across all tokens', () => {
      // Record entries for multiple tokens at T=0
      recordEntries(detector, 'token-clean-1', 2);
      recordEntries(detector, 'token-clean-2', 2);

      // Advance time past the 2-hour window
      vi.advanceTimersByTime(TWO_HOURS_MS + ONE_MINUTE_MS);

      // Call cleanup
      detector.cleanup();

      // All entries should be expired and removed
      const stats = detector.getStats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.tokenCount).toBe(0);
    });

    it('cleanup() preserves non-expired entries while removing expired ones', () => {
      // Record entries for token A at T=0
      recordEntries(detector, 'token-old', 2);

      // Advance time by 1 hour
      vi.advanceTimersByTime(60 * 60 * 1000);

      // Record entries for token B at T=1h
      recordEntries(detector, 'token-new', 2, {
        classification: 'whale',
      });

      // Advance time by 1h 10m more (total: 2h 10m from T=0, 1h 10m from token B)
      vi.advanceTimersByTime(70 * ONE_MINUTE_MS);

      // Call cleanup
      detector.cleanup();

      // Token A entries should be gone (2h 10m old > 2h window)
      // Token B entries should still exist (1h 10m old < 2h window)
      const stats = detector.getStats();
      expect(stats.tokenCount).toBe(1);
      expect(stats.totalEntries).toBe(2);
    });

    it('clear() removes all entries but preserves callbacks', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // Record entries for several tokens
      recordEntries(detector, 'token-1', 3);
      recordEntries(detector, 'token-2', 2);
      recordEntries(detector, 'token-3', 1);

      // Clear all data
      detector.clear();

      const stats = detector.getStats();
      expect(stats.tokenCount).toBe(0);
      expect(stats.totalEntries).toBe(0);
      expect(stats.activeConvergences).toBe(0);

      // Verify callbacks are preserved — new convergence after clear should fire
      callback.mockClear();
      recordEntries(detector, 'token-after-clear', 3);
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Phase 4: Conviction Score and Position Size
  // =========================================================================

  describe('Conviction Score', () => {
    it('assigns conviction score of 100 when all wallets invest above 80% of historical avg', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // 3 wallets all with positionSize >= 80% of historicalAvgSize
      // 1000/1000 = 100% >= 80% → conviction
      detector.recordEntry(
        'token-conv',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money',
          positionSize: 1000,
          historicalAvgSize: 1000,
        }),
      );
      detector.recordEntry(
        'token-conv',
        createEntry({
          walletAddress: 'w2',
          classification: 'whale',
          positionSize: 1200,
          historicalAvgSize: 1000,
        }),
      );
      detector.recordEntry(
        'token-conv',
        createEntry({
          walletAddress: 'w3',
          classification: 'insider',
          positionSize: 900,
          historicalAvgSize: 1000,
        }),
      );

      expect(callback).toHaveBeenCalledTimes(1);
      const event = callback.mock.calls[0][0];
      // 3/3 wallets show conviction = 100%
      expect(event.convictionScore).toBe(100);
    });

    it('reduces conviction score when some wallets are below the threshold', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // w1: 1000/1000 = 100% >= 80% → conviction ✓
      detector.recordEntry(
        'token-mixed',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money',
          positionSize: 1000,
          historicalAvgSize: 1000,
        }),
      );
      // w2: 500/1000 = 50% < 80% → no conviction ✗
      detector.recordEntry(
        'token-mixed',
        createEntry({
          walletAddress: 'w2',
          classification: 'whale',
          positionSize: 500,
          historicalAvgSize: 1000,
        }),
      );
      // w3: 900/1000 = 90% >= 80% → conviction ✓
      detector.recordEntry(
        'token-mixed',
        createEntry({
          walletAddress: 'w3',
          classification: 'insider',
          positionSize: 900,
          historicalAvgSize: 1000,
        }),
      );

      expect(callback).toHaveBeenCalledTimes(1);
      const event = callback.mock.calls[0][0];
      // 2 out of 3 wallets show conviction = 66.67%
      expect(event.convictionScore).toBeCloseTo(66.67, 0);
    });

    it('assigns conviction score of 0 when all wallets are below the threshold', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // All wallets: 100/1000 = 10% < 80% → no conviction
      detector.recordEntry(
        'token-weak',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money',
          positionSize: 100,
          historicalAvgSize: 1000,
        }),
      );
      detector.recordEntry(
        'token-weak',
        createEntry({
          walletAddress: 'w2',
          classification: 'whale',
          positionSize: 100,
          historicalAvgSize: 1000,
        }),
      );
      detector.recordEntry(
        'token-weak',
        createEntry({
          walletAddress: 'w3',
          classification: 'insider',
          positionSize: 100,
          historicalAvgSize: 1000,
        }),
      );

      expect(callback).toHaveBeenCalledTimes(1);
      const event = callback.mock.calls[0][0];
      expect(event.convictionScore).toBe(0);
    });

    it('handles zero historical average without division by zero', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // historicalAvgSize = 0 → percentOfAvg = 0 → no conviction
      detector.recordEntry(
        'token-zero-avg',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money',
          positionSize: 500,
          historicalAvgSize: 0,
        }),
      );
      detector.recordEntry(
        'token-zero-avg',
        createEntry({
          walletAddress: 'w2',
          classification: 'whale',
          positionSize: 1000,
          historicalAvgSize: 0,
        }),
      );
      detector.recordEntry(
        'token-zero-avg',
        createEntry({
          walletAddress: 'w3',
          classification: 'insider',
          positionSize: 2000,
          historicalAvgSize: 0,
        }),
      );

      expect(callback).toHaveBeenCalledTimes(1);
      const event = callback.mock.calls[0][0];
      // Zero historical avg → 0% → no conviction for any wallet
      expect(event.convictionScore).toBe(0);
      // Event should not contain NaN or Infinity
      expect(Number.isFinite(event.convictionScore)).toBe(true);
    });

    it('getPositionContext() returns correct PositionSizeContext', () => {
      const result: PositionSizeContext = detector.getPositionContext(
        'wallet1',
        1200,
        1000,
      );

      expect(result.currentSize).toBe(1200);
      expect(result.historicalAvg).toBe(1000);
      expect(result.percentOfAvg).toBe(120); // 1200/1000 * 100 = 120%
    });

    it('getPositionContext() returns percentOfAvg = 0 when historicalAvg is 0', () => {
      const result: PositionSizeContext = detector.getPositionContext(
        'wallet1',
        500,
        0,
      );

      expect(result.currentSize).toBe(500);
      expect(result.historicalAvg).toBe(0);
      expect(result.percentOfAvg).toBe(0); // Not Infinity or NaN
      expect(Number.isFinite(result.percentOfAvg)).toBe(true);
    });

    it('getPositionContext() handles zero position size', () => {
      const result: PositionSizeContext = detector.getPositionContext(
        'wallet1',
        0,
        1000,
      );

      expect(result.currentSize).toBe(0);
      expect(result.historicalAvg).toBe(1000);
      expect(result.percentOfAvg).toBe(0); // 0/1000 * 100 = 0%
    });
  });

  // =========================================================================
  // Phase 5: Wallet Quality Weights
  // =========================================================================

  describe('Quality Weights', () => {
    it('applies quality weights to avgQualityWeight in ConvergenceEvent', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // smart_money=1.0, whale=0.8, kol=0.7
      detector.recordEntry(
        'token-qw',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money',
        }),
      );
      detector.recordEntry(
        'token-qw',
        createEntry({
          walletAddress: 'w2',
          classification: 'whale',
        }),
      );
      detector.recordEntry(
        'token-qw',
        createEntry({
          walletAddress: 'w3',
          classification: 'kol',
        }),
      );

      expect(callback).toHaveBeenCalledTimes(1);
      const event = callback.mock.calls[0][0];

      // (1.0 + 0.8 + 0.7) / 3 = 2.5 / 3 ≈ 0.8333
      expect(event.avgQualityWeight).toBeCloseTo(0.8333, 3);
    });

    it('does NOT count wallets with quality weight below 0.5 toward convergence', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // smart_money (1.0) + whale (0.8) = 2 qualified wallets
      // developer (0.3) + developer (0.3) = 2 unqualified wallets
      detector.recordEntry(
        'token-unqual',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money',
        }),
      );
      detector.recordEntry(
        'token-unqual',
        createEntry({
          walletAddress: 'w2',
          classification: 'whale',
        }),
      );
      detector.recordEntry(
        'token-unqual',
        createEntry({
          walletAddress: 'w3',
          classification: 'developer',
        }),
      );
      detector.recordEntry(
        'token-unqual',
        createEntry({
          walletAddress: 'w4',
          classification: 'developer',
        }),
      );

      // Only 2 qualified wallets < 3 threshold → no convergence
      expect(callback).not.toHaveBeenCalled();
    });

    it('developer wallets (weight 0.3) do NOT count toward convergence', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // 3 developer wallets — all have weight 0.3 < 0.5 threshold
      detector.recordEntry(
        'token-dev',
        createEntry({
          walletAddress: 'dev1',
          classification: 'developer',
        }),
      );
      detector.recordEntry(
        'token-dev',
        createEntry({
          walletAddress: 'dev2',
          classification: 'developer',
        }),
      );
      detector.recordEntry(
        'token-dev',
        createEntry({
          walletAddress: 'dev3',
          classification: 'developer',
        }),
      );

      expect(callback).not.toHaveBeenCalled();
    });

    it('sniper wallets (weight 0.5) DO count toward convergence at boundary', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // 3 sniper wallets — weight 0.5 is exactly at the minimum threshold
      detector.recordEntry(
        'token-snipe',
        createEntry({
          walletAddress: 's1',
          classification: 'sniper',
        }),
      );
      detector.recordEntry(
        'token-snipe',
        createEntry({
          walletAddress: 's2',
          classification: 'sniper',
        }),
      );
      detector.recordEntry(
        'token-snipe',
        createEntry({
          walletAddress: 's3',
          classification: 'sniper',
        }),
      );

      // Sniper weight = 0.5 >= 0.5 → qualified → convergence fires
      expect(callback).toHaveBeenCalledTimes(1);
      const event = callback.mock.calls[0][0];
      expect(event.avgQualityWeight).toBeCloseTo(0.5, 3);
    });

    it('QUALITY_WEIGHTS constant matches the expected classification weights', () => {
      expect(QUALITY_WEIGHTS).toEqual({
        smart_money: 1.0,
        insider: 0.9,
        whale: 0.8,
        kol: 0.7,
        sniper: 0.5,
        developer: 0.3,
      });
    });

    it('computes avgQualityWeight using only qualified wallets', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // 3 qualified + 1 unqualified developer
      detector.recordEntry(
        'token-mix-qw',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money', // 1.0
        }),
      );
      detector.recordEntry(
        'token-mix-qw',
        createEntry({
          walletAddress: 'w2',
          classification: 'insider', // 0.9
        }),
      );
      detector.recordEntry(
        'token-mix-qw',
        createEntry({
          walletAddress: 'w3',
          classification: 'whale', // 0.8
        }),
      );
      detector.recordEntry(
        'token-mix-qw',
        createEntry({
          walletAddress: 'w4',
          classification: 'developer', // 0.3 — not qualified
        }),
      );

      // Callback fires on 3rd entry (threshold met) and again on 4th
      // (threshold still met with 3 qualified wallets), so total = 2 calls
      expect(callback).toHaveBeenCalledTimes(2);

      // Verify the latest event excludes the developer wallet
      const latestEvent = callback.mock.calls[1][0];

      // Only qualified wallets are in the event: w1, w2, w3
      // avgQualityWeight = (1.0 + 0.9 + 0.8) / 3 = 0.9
      expect(latestEvent.walletCount).toBe(3);
      expect(latestEvent.avgQualityWeight).toBeCloseTo(0.9, 3);

      // Verify developer wallet is NOT present in event wallets
      const addresses = latestEvent.wallets.map((w) => w.address);
      expect(addresses).not.toContain('w4');
      expect(addresses).toContain('w1');
      expect(addresses).toContain('w2');
      expect(addresses).toContain('w3');
    });
  });

  // =========================================================================
  // Phase 6: Query Methods
  // =========================================================================

  describe('Query Methods', () => {
    it('getConvergenceForToken() returns ConvergenceEvent when active', () => {
      recordEntries(detector, 'token-active', 3);

      const result = detector.getConvergenceForToken('token-active');
      expect(result).not.toBeNull();
      expect(result!.token).toBe('token-active');
      expect(result!.walletCount).toBe(3);
      expect(result!.convictionScore).toBeGreaterThanOrEqual(0);
      expect(result!.avgQualityWeight).toBeGreaterThan(0);
    });

    it('getConvergenceForToken() returns null when fewer than minWallets', () => {
      // Only 1 wallet recorded
      detector.recordEntry(
        'token-1-wallet',
        createEntry({
          walletAddress: 'lone',
          classification: 'smart_money',
        }),
      );

      const result = detector.getConvergenceForToken('token-1-wallet');
      expect(result).toBeNull();
    });

    it('getConvergenceForToken() returns null for unknown token', () => {
      const result =
        detector.getConvergenceForToken('completely-unknown-token');
      expect(result).toBeNull();
    });

    it('getConvergenceForToken() prunes expired entries before evaluating', () => {
      // Record 3 wallets at T=0 → convergence exists
      recordEntries(detector, 'token-expire-query', 3);

      // Advance time past the window
      vi.advanceTimersByTime(TWO_HOURS_MS + ONE_MINUTE_MS);

      // Now all entries are expired
      const result = detector.getConvergenceForToken('token-expire-query');
      expect(result).toBeNull();
    });

    it('getActiveConvergences() returns all tokens with active convergence', () => {
      // Set up convergence on 2 tokens
      recordEntries(detector, 'active-1', 3);
      recordEntries(detector, 'active-2', 4, { classification: 'whale' });

      // 3rd token with only 2 wallets — no convergence
      recordEntries(detector, 'not-active', 2);

      const activeEvents = detector.getActiveConvergences();
      expect(activeEvents).toHaveLength(2);

      const tokens = activeEvents.map((e) => e.token);
      expect(tokens).toContain('active-1');
      expect(tokens).toContain('active-2');
    });

    it('getActiveConvergences() returns empty array when no convergences exist', () => {
      recordEntries(detector, 'no-conv-1', 2);
      recordEntries(detector, 'no-conv-2', 1);

      const activeEvents = detector.getActiveConvergences();
      expect(activeEvents).toHaveLength(0);
    });

    it('getActiveConvergences() sorts by conviction score descending', () => {
      // Token with high conviction (all wallets above threshold)
      detector.recordEntry(
        'high-conv',
        createEntry({
          walletAddress: 'hc1',
          classification: 'smart_money',
          positionSize: 1000,
          historicalAvgSize: 1000,
        }),
      );
      detector.recordEntry(
        'high-conv',
        createEntry({
          walletAddress: 'hc2',
          classification: 'whale',
          positionSize: 1000,
          historicalAvgSize: 1000,
        }),
      );
      detector.recordEntry(
        'high-conv',
        createEntry({
          walletAddress: 'hc3',
          classification: 'insider',
          positionSize: 1000,
          historicalAvgSize: 1000,
        }),
      );

      // Token with low conviction (all wallets below threshold)
      detector.recordEntry(
        'low-conv',
        createEntry({
          walletAddress: 'lc1',
          classification: 'smart_money',
          positionSize: 100,
          historicalAvgSize: 1000,
        }),
      );
      detector.recordEntry(
        'low-conv',
        createEntry({
          walletAddress: 'lc2',
          classification: 'whale',
          positionSize: 100,
          historicalAvgSize: 1000,
        }),
      );
      detector.recordEntry(
        'low-conv',
        createEntry({
          walletAddress: 'lc3',
          classification: 'insider',
          positionSize: 100,
          historicalAvgSize: 1000,
        }),
      );

      const results = detector.getActiveConvergences();
      expect(results).toHaveLength(2);
      // First should have higher conviction score
      expect(results[0].convictionScore).toBeGreaterThanOrEqual(
        results[1].convictionScore,
      );
      expect(results[0].token).toBe('high-conv');
      expect(results[1].token).toBe('low-conv');
    });

    it('getEntryCount() returns unique qualified wallet count', () => {
      // 2 unique wallets, 1 duplicate
      detector.recordEntry(
        'token-count',
        createEntry({
          walletAddress: 'wA',
          classification: 'smart_money',
        }),
      );
      detector.recordEntry(
        'token-count',
        createEntry({
          walletAddress: 'wB',
          classification: 'whale',
        }),
      );
      detector.recordEntry(
        'token-count',
        createEntry({
          walletAddress: 'wA',
          classification: 'smart_money',
        }),
      );

      const count = detector.getEntryCount('token-count');
      expect(count).toBe(2); // wA and wB only
    });

    it('getEntryCount() excludes non-qualified wallets', () => {
      detector.recordEntry(
        'token-count-nq',
        createEntry({
          walletAddress: 'qualified1',
          classification: 'smart_money',
        }),
      );
      detector.recordEntry(
        'token-count-nq',
        createEntry({
          walletAddress: 'unqualified1',
          classification: 'developer',
        }),
      );

      const count = detector.getEntryCount('token-count-nq');
      expect(count).toBe(1); // Only qualified wallet counted
    });

    it('getEntryCount() returns 0 for unknown token', () => {
      const count = detector.getEntryCount('unknown-token');
      expect(count).toBe(0);
    });

    it('getStats() returns accurate statistics', () => {
      // Token 1: 3 wallets → convergence
      recordEntries(detector, 'stats-1', 3);
      // Token 2: 4 wallets → convergence
      recordEntries(detector, 'stats-2', 4, { classification: 'whale' });
      // Token 3: 2 wallets → no convergence
      recordEntries(detector, 'stats-3', 2, { classification: 'insider' });

      const stats = detector.getStats();
      expect(stats.tokenCount).toBe(3);
      expect(stats.totalEntries).toBe(9); // 3 + 4 + 2
      expect(stats.activeConvergences).toBe(2);
    });

    it('getStats() returns zeros when no entries exist', () => {
      const stats = detector.getStats();
      expect(stats.tokenCount).toBe(0);
      expect(stats.totalEntries).toBe(0);
      expect(stats.activeConvergences).toBe(0);
    });
  });

  // =========================================================================
  // Phase 7: Constructor Configuration
  // =========================================================================

  describe('Configuration', () => {
    it('uses SMART_MONEY_CONFIG default values when no options provided', () => {
      // Default detector should use: window=2h, minWallets=3, conviction=80%
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // Record only 2 wallets — should NOT converge with minWallets=3
      recordEntries(detector, 'token-default', 2);
      expect(callback).not.toHaveBeenCalled();

      // Record 3rd → should converge
      detector.recordEntry(
        'token-default',
        createEntry({
          walletAddress: 'wallet-2',
          classification: 'smart_money',
        }),
      );
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('custom windowMs overrides the default 2-hour window', () => {
      // Create detector with 30-minute window
      const shortDetector = new ConvergenceDetector({
        windowMs: 30 * ONE_MINUTE_MS,
      });
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      shortDetector.onConvergence(callback);

      // Record 3 wallets at T=0
      recordEntries(shortDetector, 'token-short', 3);
      expect(callback).toHaveBeenCalledTimes(1);
      callback.mockClear();

      // Advance time by 35 minutes (past 30-minute window)
      vi.advanceTimersByTime(35 * ONE_MINUTE_MS);

      // Record new wallet — old entries should be expired
      shortDetector.recordEntry(
        'token-short',
        createEntry({
          walletAddress: 'wallet-late',
          classification: 'smart_money',
          timestamp: Date.now(),
        }),
      );

      // Query: old entries expired, only 1 new wallet in window
      const result = shortDetector.getConvergenceForToken('token-short');
      expect(result).toBeNull();
    });

    it('custom minWallets overrides the default threshold of 3', () => {
      const lowThreshold = new ConvergenceDetector({ minWallets: 2 });
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      lowThreshold.onConvergence(callback);

      // Only 2 wallets — should converge with minWallets=2
      lowThreshold.recordEntry(
        'token-low',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money',
        }),
      );
      lowThreshold.recordEntry(
        'token-low',
        createEntry({
          walletAddress: 'w2',
          classification: 'whale',
        }),
      );

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].walletCount).toBe(2);
    });

    it('custom convictionThreshold overrides the default 80%', () => {
      // Lower threshold: 50%
      const lowConv = new ConvergenceDetector({
        convictionThreshold: 50,
      });
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      lowConv.onConvergence(callback);

      // wallets: positionSize=600, historicalAvgSize=1000
      // percentOfAvg = 60% → below default 80% but above custom 50%
      lowConv.recordEntry(
        'token-lowconv',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money',
          positionSize: 600,
          historicalAvgSize: 1000,
        }),
      );
      lowConv.recordEntry(
        'token-lowconv',
        createEntry({
          walletAddress: 'w2',
          classification: 'whale',
          positionSize: 600,
          historicalAvgSize: 1000,
        }),
      );
      lowConv.recordEntry(
        'token-lowconv',
        createEntry({
          walletAddress: 'w3',
          classification: 'insider',
          positionSize: 600,
          historicalAvgSize: 1000,
        }),
      );

      expect(callback).toHaveBeenCalledTimes(1);
      const event = callback.mock.calls[0][0];
      // 60% >= 50% → all 3 wallets show conviction → 100%
      expect(event.convictionScore).toBe(100);
    });

    it('with default threshold of 80%, 60% position size yields conviction score 0', () => {
      // Default detector (convictionThreshold=80)
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // 60% of avg < 80% default → no conviction
      detector.recordEntry(
        'token-defconv',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money',
          positionSize: 600,
          historicalAvgSize: 1000,
        }),
      );
      detector.recordEntry(
        'token-defconv',
        createEntry({
          walletAddress: 'w2',
          classification: 'whale',
          positionSize: 600,
          historicalAvgSize: 1000,
        }),
      );
      detector.recordEntry(
        'token-defconv',
        createEntry({
          walletAddress: 'w3',
          classification: 'insider',
          positionSize: 600,
          historicalAvgSize: 1000,
        }),
      );

      expect(callback).toHaveBeenCalledTimes(1);
      const event = callback.mock.calls[0][0];
      // 60% < 80% → 0 wallets show conviction → 0%
      expect(event.convictionScore).toBe(0);
    });
  });

  // =========================================================================
  // Phase 8: Callback Management
  // =========================================================================

  describe('Callbacks', () => {
    it('onConvergence() registers a callback that fires on convergence', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      recordEntries(detector, 'token-cb', 3);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].token).toBe('token-cb');
    });

    it('multiple callbacks all fire when convergence is detected', () => {
      const callback1 = vi.fn<(event: ConvergenceEvent) => void>();
      const callback2 = vi.fn<(event: ConvergenceEvent) => void>();
      const callback3 = vi.fn<(event: ConvergenceEvent) => void>();

      detector.onConvergence(callback1);
      detector.onConvergence(callback2);
      detector.onConvergence(callback3);

      recordEntries(detector, 'token-multi-cb', 3);

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback3).toHaveBeenCalledTimes(1);

      // All receive the same event
      expect(callback1.mock.calls[0][0].token).toBe('token-multi-cb');
      expect(callback2.mock.calls[0][0].token).toBe('token-multi-cb');
      expect(callback3.mock.calls[0][0].token).toBe('token-multi-cb');
    });

    it('removeCallback() stops the callback from firing', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // Remove the callback before triggering convergence
      detector.removeCallback(callback);

      recordEntries(detector, 'token-removed-cb', 3);

      expect(callback).not.toHaveBeenCalled();
    });

    it('removeCallback() only removes the specific callback, not others', () => {
      const keepCallback = vi.fn<(event: ConvergenceEvent) => void>();
      const removeCallback = vi.fn<(event: ConvergenceEvent) => void>();

      detector.onConvergence(keepCallback);
      detector.onConvergence(removeCallback);

      // Remove only one
      detector.removeCallback(removeCallback);

      recordEntries(detector, 'token-partial-rm', 3);

      expect(keepCallback).toHaveBeenCalledTimes(1);
      expect(removeCallback).not.toHaveBeenCalled();
    });

    it('removeCallback() is a no-op for unregistered callbacks', () => {
      const unregistered = vi.fn<(event: ConvergenceEvent) => void>();
      const registered = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(registered);

      // Removing an unregistered callback should not throw or affect registered ones
      detector.removeCallback(unregistered);

      recordEntries(detector, 'token-noop-rm', 3);
      expect(registered).toHaveBeenCalledTimes(1);
    });

    it('callback errors do not prevent other callbacks from firing', () => {
      const errorCallback = vi.fn(() => {
        throw new Error('Callback exploded');
      });
      const safeCallback = vi.fn<(event: ConvergenceEvent) => void>();

      detector.onConvergence(errorCallback);
      detector.onConvergence(safeCallback);

      // Should not throw — errors are caught internally
      recordEntries(detector, 'token-err-cb', 3);

      expect(errorCallback).toHaveBeenCalledTimes(1);
      expect(safeCallback).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Phase 9: Edge Cases and Error Handling
  // =========================================================================

  describe('Edge Cases', () => {
    it('handles recording entries for many different tokens', () => {
      const tokenCount = 100;
      for (let i = 0; i < tokenCount; i++) {
        detector.recordEntry(
          `token-${i}`,
          createEntry({
            walletAddress: `w-${i}-a`,
            classification: 'smart_money',
          }),
        );
        detector.recordEntry(
          `token-${i}`,
          createEntry({
            walletAddress: `w-${i}-b`,
            classification: 'whale',
          }),
        );
      }

      const stats = detector.getStats();
      expect(stats.tokenCount).toBe(tokenCount);
      expect(stats.totalEntries).toBe(tokenCount * 2);
      expect(stats.activeConvergences).toBe(0); // None reached 3
    });

    it('handles empty token address gracefully', () => {
      detector.recordEntry(
        '',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money',
        }),
      );

      // Should not crash, entry should be stored
      const stats = detector.getStats();
      expect(stats.tokenCount).toBe(1);
      expect(stats.totalEntries).toBe(1);
    });

    it('prunes entries with timestamps far in the past immediately on recording', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // Record entry with timestamp 3 hours in the past (outside 2h window)
      detector.recordEntry(
        'token-old-ts',
        createEntry({
          walletAddress: 'ancient',
          classification: 'smart_money',
          timestamp: Date.now() - 3 * 60 * 60 * 1000,
        }),
      );

      // The entry was added then immediately pruned
      // Entry count should be 0 for qualified wallets after pruning
      const count = detector.getEntryCount('token-old-ts');
      expect(count).toBe(0);
      expect(callback).not.toHaveBeenCalled();
    });

    it('handles recording the same token-wallet pair with different classifications', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // Same wallet address, different classifications — still treated as same wallet
      detector.recordEntry(
        'token-reclass',
        createEntry({
          walletAddress: 'chameleon',
          classification: 'smart_money',
        }),
      );
      detector.recordEntry(
        'token-reclass',
        createEntry({
          walletAddress: 'chameleon',
          classification: 'whale',
        }),
      );
      detector.recordEntry(
        'token-reclass',
        createEntry({
          walletAddress: 'chameleon',
          classification: 'insider',
        }),
      );

      // Only 1 unique wallet regardless of different classifications
      expect(callback).not.toHaveBeenCalled();
      expect(detector.getEntryCount('token-reclass')).toBe(1);
    });

    it('handles mix of expired and non-expired entries within a single token', () => {
      const callback = vi.fn<(event: ConvergenceEvent) => void>();
      detector.onConvergence(callback);

      // Record w1 at T=0
      detector.recordEntry(
        'token-mixed-exp',
        createEntry({
          walletAddress: 'w1',
          classification: 'smart_money',
          timestamp: Date.now(),
        }),
      );

      // Advance 1.5 hours
      vi.advanceTimersByTime(90 * ONE_MINUTE_MS);

      // Record w2 at T=1.5h
      detector.recordEntry(
        'token-mixed-exp',
        createEntry({
          walletAddress: 'w2',
          classification: 'whale',
          timestamp: Date.now(),
        }),
      );

      // Advance another 40 minutes (total T=2h10m from start)
      // w1 is now 2h10m old (expired), w2 is 40m old (valid)
      vi.advanceTimersByTime(40 * ONE_MINUTE_MS);

      // Record w3 and w4 at current time
      detector.recordEntry(
        'token-mixed-exp',
        createEntry({
          walletAddress: 'w3',
          classification: 'insider',
          timestamp: Date.now(),
        }),
      );
      detector.recordEntry(
        'token-mixed-exp',
        createEntry({
          walletAddress: 'w4',
          classification: 'kol',
          timestamp: Date.now(),
        }),
      );

      // w1 expired, w2+w3+w4 in window → 3 >= 3 → convergence fires
      expect(callback).toHaveBeenCalledTimes(1);
      const event = callback.mock.calls[0][0];
      expect(event.walletCount).toBe(3);

      // Verify w1 is NOT in the event wallets
      const addresses = event.wallets.map((w) => w.address);
      expect(addresses).not.toContain('w1');
      expect(addresses).toContain('w2');
      expect(addresses).toContain('w3');
      expect(addresses).toContain('w4');
    });

    it('getConvergenceForToken returns fresh data after new entries are added', () => {
      // Start with 2 wallets — no convergence
      recordEntries(detector, 'token-fresh', 2);
      expect(detector.getConvergenceForToken('token-fresh')).toBeNull();

      // Add 3rd wallet → convergence
      detector.recordEntry(
        'token-fresh',
        createEntry({
          walletAddress: 'wallet-2',
          classification: 'smart_money',
        }),
      );

      const result = detector.getConvergenceForToken('token-fresh');
      expect(result).not.toBeNull();
      expect(result!.walletCount).toBe(3);
    });
  });
});
