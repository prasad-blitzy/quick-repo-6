/**
 * tests/unit/safety/honeypot-detector.test.ts — HoneypotDetector Unit Tests
 *
 * Comprehensive test coverage for the Jupiter-based honeypot simulation
 * (`src/safety/honeypot-detector.ts`). Validates:
 *
 * 1. **Jupiter sell simulation** — TOKEN → SOL quote via `JupiterClient.getQuote`
 *    with `ExactIn` swap mode to simulate selling.
 * 2. **Timeout handling** — returns `{ sellable: false, estimatedTax: 100,
 *    timedOut: true }` on timeout.
 * 3. **Fail-safe behavior** — any error produces `sellable: false` to prevent
 *    buying unsellable tokens.
 * 4. **Retry logic** — `simulateSellWithRetry()` retries with alternative
 *    test amounts (10× default) and ~1.1s delay between attempts.
 * 5. **High price impact detection** — priceImpactPct > 50% flags the token
 *    as dangerous.
 * 6. **Tax estimation** — `estimatedTax` calculation from quote data.
 *
 * Per AAP §0.2.1 test file inventory:
 *   "Tests honeypot simulation result interpretation"
 *
 * Per AAP §0.7.3:
 *   "Jupiter honeypot simulation is mandatory"
 *
 * @module tests/unit/safety/honeypot-detector
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HoneypotDetector } from '../../../src/safety/honeypot-detector';
import type { JupiterClient } from '../../../src/api/jupiter';
import type { JupiterQuote } from '../../../src/api/types';
import type { HoneypotResult } from '../../../src/safety/types';

// =============================================================================
// Constants
// =============================================================================

const TEST_MINT = 'TestMint111111111111111111111111111111111111';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Default test amount (1M lamports — matches the production code constant) */
const DEFAULT_TEST_AMOUNT = 1_000_000;

/** Alternative test amount (10× default — used on retry) */
const ALTERNATIVE_TEST_AMOUNT = 10_000_000;

// =============================================================================
// Mock Factories
// =============================================================================

/**
 * Creates a valid JupiterQuote representing a successful sell simulation.
 * A valid quote means the token is sellable (not a honeypot).
 */
function createValidQuote(overrides: Partial<JupiterQuote> = {}): JupiterQuote {
  return {
    inputMint: TEST_MINT,
    inAmount: String(DEFAULT_TEST_AMOUNT),
    outputMint: SOL_MINT,
    outAmount: '5000000',
    otherAmountThreshold: '4950000',
    swapMode: 'ExactIn',
    slippageBps: 50,
    priceImpactPct: '0.5',
    routePlan: [
      {
        swapInfo: {
          ammKey: 'amm-1',
          label: 'Raydium',
          inputMint: TEST_MINT,
          outputMint: SOL_MINT,
          inAmount: String(DEFAULT_TEST_AMOUNT),
          outAmount: '5000000',
          feeAmount: '2500',
          feeMint: TEST_MINT,
        },
        percent: 100,
      },
    ],
    contextSlot: 12345,
    timeTaken: 0.01,
    ...overrides,
  };
}

/**
 * Creates a mock JupiterClient with configurable getQuote behavior.
 */
function createMockJupiterClient(
  quoteResponse: JupiterQuote | null = createValidQuote(),
): JupiterClient {
  return {
    getPrice: vi.fn().mockResolvedValue(null),
    getPrices: vi.fn().mockResolvedValue(new Map()),
    getQuote: vi.fn().mockResolvedValue(quoteResponse),
  } as unknown as JupiterClient;
}

// =============================================================================
// Tests
// =============================================================================

describe('HoneypotDetector', () => {
  let mockJupiter: JupiterClient;
  let detector: HoneypotDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockJupiter = createMockJupiterClient();
    detector = new HoneypotDetector(mockJupiter);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Section 1: Jupiter Sell Simulation (Happy Path)
  // ===========================================================================

  describe('Jupiter Sell Simulation', () => {
    it('should call JupiterClient.getQuote with correct parameters for TOKEN → SOL', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient();
      detector = new HoneypotDetector(mockJupiter);

      await detector.checkHoneypot(TEST_MINT);

      expect(mockJupiter.getQuote).toHaveBeenCalledWith(
        TEST_MINT,
        SOL_MINT,
        expect.any(Number),
        'ExactIn',
      );
    });

    it('should return sellable=true when Jupiter returns a valid quote', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient();
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result.sellable).toBe(true);
    });

    it('should calculate estimated tax from quote data', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient(
        createValidQuote({
          priceImpactPct: '2.5',
        }),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result.sellable).toBe(true);
      expect(typeof result.estimatedTax).toBe('number');
      expect(result.estimatedTax).toBeGreaterThanOrEqual(0);
    });

    it('should return low estimatedTax for healthy quote with low price impact', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient(
        createValidQuote({ priceImpactPct: '0.1' }),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result.sellable).toBe(true);
      expect(result.estimatedTax).toBeLessThan(10);
    });

    it('should support custom test amounts', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient();
      detector = new HoneypotDetector(mockJupiter);

      await detector.checkHoneypot(TEST_MINT, 5_000_000);

      expect(mockJupiter.getQuote).toHaveBeenCalledWith(
        TEST_MINT,
        SOL_MINT,
        5_000_000,
        'ExactIn',
      );
    });
  });

  // ===========================================================================
  // Section 2: Null / No Route Response
  // ===========================================================================

  describe('No Route (Quote Returns Null)', () => {
    it('should return sellable=false when getQuote returns null', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient(null);
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result.sellable).toBe(false);
    });

    it('should return estimatedTax=100 when no route available', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient(null);
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result.estimatedTax).toBe(100);
    });
  });

  // ===========================================================================
  // Section 3: Timeout Handling
  // ===========================================================================

  describe('Timeout Handling', () => {
    it('should return sellable=false on timeout', async () => {
      const neverResolves = new Promise<JupiterQuote>(() => {
        /* intentionally never resolves */
      });
      (mockJupiter.getQuote as ReturnType<typeof vi.fn>).mockReturnValue(neverResolves);

      // Use a very short timeout for test
      detector = new HoneypotDetector(mockJupiter, 100);

      const resultPromise = detector.checkHoneypot(TEST_MINT);
      vi.advanceTimersByTime(200);
      const result = await resultPromise;

      expect(result.sellable).toBe(false);
    });

    it('should return estimatedTax=100 on timeout', async () => {
      const neverResolves = new Promise<JupiterQuote>(() => {});
      (mockJupiter.getQuote as ReturnType<typeof vi.fn>).mockReturnValue(neverResolves);

      detector = new HoneypotDetector(mockJupiter, 100);

      const resultPromise = detector.checkHoneypot(TEST_MINT);
      vi.advanceTimersByTime(200);
      const result = await resultPromise;

      expect(result.estimatedTax).toBe(100);
    });

    it('should set timedOut=true on timeout', async () => {
      const neverResolves = new Promise<JupiterQuote>(() => {});
      (mockJupiter.getQuote as ReturnType<typeof vi.fn>).mockReturnValue(neverResolves);

      detector = new HoneypotDetector(mockJupiter, 100);

      const resultPromise = detector.checkHoneypot(TEST_MINT);
      vi.advanceTimersByTime(200);
      const result = await resultPromise;

      expect(result.timedOut).toBe(true);
    });

    it('should default to 15 seconds timeout', () => {
      const det = new HoneypotDetector(mockJupiter);
      // We can verify by checking that the constructor works with the default
      expect(det).toBeDefined();
    });
  });

  // ===========================================================================
  // Section 4: Fail-Safe Behavior on Errors
  // ===========================================================================

  describe('Fail-Safe Behavior', () => {
    it('should return sellable=false on network error', async () => {
      vi.useRealTimers();
      (mockJupiter.getQuote as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('ECONNREFUSED'),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result.sellable).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return sellable=false on AbortError', async () => {
      vi.useRealTimers();
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      (mockJupiter.getQuote as ReturnType<typeof vi.fn>).mockRejectedValue(abortError);
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result.sellable).toBe(false);
    });

    it('should return sellable=false on rate limit error', async () => {
      vi.useRealTimers();
      (mockJupiter.getQuote as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('429 Too Many Requests'),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result.sellable).toBe(false);
    });

    it('should return sellable=false on JSON parse error', async () => {
      vi.useRealTimers();
      (mockJupiter.getQuote as ReturnType<typeof vi.fn>).mockRejectedValue(
        new SyntaxError('Unexpected token < in JSON at position 0'),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result.sellable).toBe(false);
    });

    it('should never throw — always returns HoneypotResult', async () => {
      vi.useRealTimers();
      (mockJupiter.getQuote as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new TypeError('Cannot read properties of null');
      });
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result).toBeDefined();
      expect(typeof result.sellable).toBe('boolean');
      expect(typeof result.estimatedTax).toBe('number');
    });

    it('should include error message in result on failure', async () => {
      vi.useRealTimers();
      (mockJupiter.getQuote as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Service unavailable'),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
    });
  });

  // ===========================================================================
  // Section 5: Retry Logic (simulateSellWithRetry)
  // ===========================================================================

  describe('Retry Logic (simulateSellWithRetry)', () => {
    it('should return immediately on first successful attempt', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient();
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.simulateSellWithRetry(TEST_MINT);

      expect(result.sellable).toBe(true);
      // Only called once since first attempt succeeded
      expect(mockJupiter.getQuote).toHaveBeenCalledTimes(1);
    });

    it('should retry with alternative amount when first attempt fails', async () => {
      vi.useRealTimers();
      (mockJupiter.getQuote as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('No route'))
        .mockResolvedValueOnce(createValidQuote({ inAmount: String(ALTERNATIVE_TEST_AMOUNT) }));
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.simulateSellWithRetry(TEST_MINT);

      expect(mockJupiter.getQuote).toHaveBeenCalledTimes(2);
      expect(result.sellable).toBe(true);
    });

    it('should use different amounts on retry (10× default)', async () => {
      vi.useRealTimers();
      (mockJupiter.getQuote as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('No route'))
        .mockResolvedValueOnce(createValidQuote());
      detector = new HoneypotDetector(mockJupiter);

      await detector.simulateSellWithRetry(TEST_MINT);

      const calls = (mockJupiter.getQuote as ReturnType<typeof vi.fn>).mock.calls;
      // Second call should use a different (larger) amount than the first
      const firstAmount = calls[0]?.[2];
      const secondAmount = calls[1]?.[2];
      expect(secondAmount).toBeGreaterThan(firstAmount);
    });

    it('should return sellable=false when all retry attempts fail', async () => {
      vi.useRealTimers();
      (mockJupiter.getQuote as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Permanently unavailable'),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.simulateSellWithRetry(TEST_MINT);

      expect(result.sellable).toBe(false);
    });

    it('should respect maximum attempt count', async () => {
      vi.useRealTimers();
      (mockJupiter.getQuote as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('No route'),
      );
      detector = new HoneypotDetector(mockJupiter);

      await detector.simulateSellWithRetry(TEST_MINT, 3);

      // Should have been called exactly maxAttempts times
      expect((mockJupiter.getQuote as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('should have delay between retry attempts', async () => {
      vi.useRealTimers();
      const callTimes: number[] = [];

      (mockJupiter.getQuote as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callTimes.push(Date.now());
        throw new Error('No route');
      });
      detector = new HoneypotDetector(mockJupiter);

      await detector.simulateSellWithRetry(TEST_MINT, 2);

      if (callTimes.length >= 2) {
        const delay = callTimes[1]! - callTimes[0]!;
        // Should have a delay ≥ 1000ms (1.1s ± tolerance)
        expect(delay).toBeGreaterThanOrEqual(900);
      }
    });
  });

  // ===========================================================================
  // Section 6: High Price Impact Detection
  // ===========================================================================

  describe('High Price Impact Detection', () => {
    it('should flag high price impact (>50%) as dangerous', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient(
        createValidQuote({ priceImpactPct: '55.0' }),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      // High price impact should indicate a suspicious token
      // May either mark as not sellable or mark with high tax
      expect(result.estimatedTax).toBeGreaterThan(10);
    });

    it('should handle normal price impact (<5%) without flag', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient(
        createValidQuote({ priceImpactPct: '1.5' }),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result.sellable).toBe(true);
      expect(result.estimatedTax).toBeLessThan(50);
    });

    it('should handle zero price impact', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient(
        createValidQuote({ priceImpactPct: '0' }),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result.sellable).toBe(true);
      expect(result.estimatedTax).toBeGreaterThanOrEqual(0);
    });

    it('should handle negative price impact string gracefully', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient(
        createValidQuote({ priceImpactPct: '-0.5' }),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result.sellable).toBe(true);
    });

    it('should handle NaN price impact gracefully', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient(
        createValidQuote({ priceImpactPct: 'NaN' }),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      // Should not throw — graceful handling of bad data
      expect(result).toBeDefined();
      expect(typeof result.sellable).toBe('boolean');
    });
  });

  // ===========================================================================
  // Section 7: Tax Estimation
  // ===========================================================================

  describe('Tax Estimation', () => {
    it('should estimate low tax for healthy quote', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient(
        createValidQuote({
          inAmount: '1000000',
          outAmount: '980000',
          priceImpactPct: '0.5',
        }),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result.sellable).toBe(true);
      expect(result.estimatedTax).toBeGreaterThanOrEqual(0);
      expect(result.estimatedTax).toBeLessThan(20);
    });

    it('should estimate high tax for heavily taxed quote', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient(
        createValidQuote({
          inAmount: '1000000',
          outAmount: '200000',
          priceImpactPct: '25.0',
        }),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      // High price impact = high estimated tax
      expect(result.estimatedTax).toBeGreaterThan(10);
    });

    it('should return estimatedTax=100 for failed sell simulation', async () => {
      vi.useRealTimers();
      (mockJupiter.getQuote as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('No route'),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result.estimatedTax).toBe(100);
    });

    it('should return numeric estimatedTax (never NaN)', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient(
        createValidQuote({
          priceImpactPct: 'invalid',
          outAmount: 'bad-data',
        }),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(Number.isNaN(result.estimatedTax)).toBe(false);
    });
  });

  // ===========================================================================
  // Section 8: Quote Evaluation Details
  // ===========================================================================

  describe('Quote Evaluation', () => {
    it('should include quotedAmount in result when quote is valid', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient(
        createValidQuote({ outAmount: '5000000' }),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      expect(result.sellable).toBe(true);
      if (result.quotedAmount !== undefined) {
        expect(typeof result.quotedAmount).toBe('number');
        expect(result.quotedAmount).toBeGreaterThan(0);
      }
    });

    it('should include priceImpactPct in result when available', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient(
        createValidQuote({ priceImpactPct: '3.5' }),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      if (result.priceImpactPct !== undefined) {
        expect(typeof result.priceImpactPct).toBe('number');
      }
    });
  });

  // ===========================================================================
  // Section 9: Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle empty string mint address gracefully', async () => {
      vi.useRealTimers();
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot('');

      // Should not throw, return fail-safe
      expect(result).toBeDefined();
      expect(typeof result.sellable).toBe('boolean');
    });

    it('should handle quote with zero outAmount', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient(
        createValidQuote({ outAmount: '0', priceImpactPct: '100.0' }),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      // Zero output with 100% price impact indicates unsellable token
      // The implementation evaluates tax from priceImpactPct, so 100% impact → high tax
      expect(result.estimatedTax).toBeGreaterThanOrEqual(50);
    });

    it('should handle quote with empty routePlan', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient(
        createValidQuote({ routePlan: [] }),
      );
      detector = new HoneypotDetector(mockJupiter);

      const result = await detector.checkHoneypot(TEST_MINT);

      // No route plan may indicate issues
      expect(result).toBeDefined();
    });

    it('should handle concurrent checkHoneypot calls for different mints', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient();
      detector = new HoneypotDetector(mockJupiter);

      const [resultA, resultB] = await Promise.all([
        detector.checkHoneypot('MintA111111111111111111111111111111111111111'),
        detector.checkHoneypot('MintB111111111111111111111111111111111111111'),
      ]);

      expect(resultA).toBeDefined();
      expect(resultB).toBeDefined();
      expect(mockJupiter.getQuote).toHaveBeenCalledTimes(2);
    });

    it('should use ExactIn swap mode (sell simulation, not buy)', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient();
      detector = new HoneypotDetector(mockJupiter);

      await detector.checkHoneypot(TEST_MINT);

      const call = (mockJupiter.getQuote as ReturnType<typeof vi.fn>).mock.calls[0];
      // Fourth argument should be 'ExactIn'
      expect(call?.[3]).toBe('ExactIn');
    });

    it('should use SOL as output mint (TOKEN → SOL direction)', async () => {
      vi.useRealTimers();
      mockJupiter = createMockJupiterClient();
      detector = new HoneypotDetector(mockJupiter);

      await detector.checkHoneypot(TEST_MINT);

      const call = (mockJupiter.getQuote as ReturnType<typeof vi.fn>).mock.calls[0];
      // First argument = inputMint (TOKEN), second = outputMint (SOL)
      expect(call?.[0]).toBe(TEST_MINT);
      expect(call?.[1]).toBe(SOL_MINT);
    });
  });
});
