/**
 * tests/unit/signals/factors/buy-sell-ratio.test.ts
 *
 * Comprehensive unit tests for the buy/sell ratio factor module.
 *
 * Tests cover:
 * 1. FactorResult structure correctness (name='buySellRatio', weight=0, score 0-100)
 * 2. Core ratio thresholds (≥1.3× accumulation, ≥2.0× strong accumulation per AAP)
 * 3. Score range validation (always integer 0-100)
 * 4. Edge cases with zero transactions
 * 5. Time window weighting (70% 1h / 30% 24h)
 * 6. Confidence adjustment based on transaction count
 * 7. Metadata field completeness
 * 8. Error handling for malformed inputs
 *
 * @module tests/unit/signals/factors/buy-sell-ratio
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TokenAnalysisInput, FactorResult } from '../../../../src/signals/types';

// ---------------------------------------------------------------------------
// Module Mocks (hoisted before all imports by Vitest)
// ---------------------------------------------------------------------------

/**
 * Mock src/utils/logger to prevent actual console logging during test execution.
 * Returns a factory function producing objects with no-op debug/info/warn/error methods.
 */
vi.mock('../../../../src/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

/**
 * Defensive mock for src/utils/config — provides deterministic LIQUIDITY threshold
 * values in case the buy-sell-ratio module is refactored to import from config.
 * The current implementation defines constants inline, but this mock prevents
 * future test breakage if imports are added.
 */
vi.mock('../../../../src/utils/config', () => ({
  LIQUIDITY: { MIN_5M_VOLUME_USD: 200, MIN_1H_VOLUME_USD: 2000 },
}));

// Import the module under test AFTER mocks are set up
import { scoreBuySellRatio } from '../../../../src/signals/factors/buy-sell-ratio';

// ---------------------------------------------------------------------------
// Test Data Factory
// ---------------------------------------------------------------------------

/**
 * Creates a complete valid TokenAnalysisInput with sensible defaults for
 * buy-sell-ratio testing. All required fields are populated with non-zero
 * values. Overrides can be provided for any subset of fields.
 *
 * Default ratios:
 * - 1h: buys=50, sells=20 → ratio 2.5:1 (strong accumulation)
 * - 24h: buys=500, sells=200 → ratio 2.5:1
 * - Total 1h txns: 70 (sufficient for meaningful analysis)
 *
 * @param overrides - Partial field overrides to customize the input
 * @returns A fully populated TokenAnalysisInput object
 */
function createMockInput(overrides?: Partial<TokenAnalysisInput>): TokenAnalysisInput {
  return {
    // Identity
    mint: 'TestMint111111111111111111111111111111111111',
    symbol: 'TEST',
    name: 'Test Token',

    // Price Data
    price: 0.001,
    priceChange5m: 5.0,
    priceChange1h: 12.0,
    priceChange24h: 25.0,

    // Market Data
    marketCap: 100_000,
    volume5m: 500,
    volume1h: 5_000,
    volume24h: 50_000,
    liquidity: 30_000,
    supply: 1_000_000_000,

    // Trading Activity (defaults for buy-sell-ratio testing)
    buys1h: 50,
    sells1h: 20,
    buys24h: 500,
    sells24h: 200,

    // Holder Data
    holderCount: 500,
    topHolderPercent: 15,
    smartMoneyCount: 2,

    // Safety & Authority
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    lpBurned: true,
    lpLocked: false,
    lpBurnPercent: 95,
    isHoneypot: false,
    safetyScore: 500,
    metadataMutable: false,

    // Developer Wallet
    devWalletAddress: 'DevWallet111111111111111111111111111111111',
    devWalletSold: false,

    // Token Age
    createdAt: Math.floor(Date.now() / 1000) - 3600, // 1 hour old

    // Apply overrides
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('scoreBuySellRatio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Phase 2: FactorResult Structure
  // =========================================================================

  describe('FactorResult structure', () => {
    it('returns correct FactorResult structure with all required fields', async () => {
      const input = createMockInput();
      const result = await scoreBuySellRatio(input);

      // Assert all required FactorResult fields exist
      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('weight');
      expect(result).toHaveProperty('metadata');

      // Assert correct types
      expect(typeof result.name).toBe('string');
      expect(typeof result.score).toBe('number');
      expect(typeof result.weight).toBe('number');
      expect(typeof result.metadata).toBe('object');
    });

    it('returns name exactly equal to "buySellRatio"', async () => {
      const input = createMockInput();
      const result = await scoreBuySellRatio(input);
      expect(result.name).toBe('buySellRatio');
    });

    it('returns weight exactly equal to 0', async () => {
      const input = createMockInput();
      const result = await scoreBuySellRatio(input);
      expect(result.weight).toBe(0);
    });

    it('returns metadata as a non-null object', async () => {
      const input = createMockInput();
      const result = await scoreBuySellRatio(input);
      expect(result.metadata).toBeDefined();
      expect(result.metadata).not.toBeNull();
      expect(typeof result.metadata).toBe('object');
    });
  });

  // =========================================================================
  // Phase 3: Score Range Validation
  // =========================================================================

  describe('score range validation', () => {
    it('score is always between 0 and 100 inclusive for high ratio', async () => {
      const result = await scoreBuySellRatio(
        createMockInput({ buys1h: 10000, sells1h: 1, buys24h: 10000, sells24h: 1 }),
      );
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('score is always between 0 and 100 inclusive for low ratio', async () => {
      const result = await scoreBuySellRatio(
        createMockInput({ buys1h: 1, sells1h: 10000, buys24h: 1, sells24h: 10000 }),
      );
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('score is always between 0 and 100 inclusive for zero transactions', async () => {
      const result = await scoreBuySellRatio(
        createMockInput({ buys1h: 0, sells1h: 0, buys24h: 0, sells24h: 0 }),
      );
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('score is always between 0 and 100 inclusive for balanced ratio', async () => {
      const result = await scoreBuySellRatio(
        createMockInput({ buys1h: 50, sells1h: 50, buys24h: 200, sells24h: 200 }),
      );
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('score is always an integer for various inputs', async () => {
      const scenarios = [
        { buys1h: 50, sells1h: 20, buys24h: 500, sells24h: 200 },
        { buys1h: 33, sells1h: 17, buys24h: 333, sells24h: 167 },
        { buys1h: 0, sells1h: 0, buys24h: 0, sells24h: 0 },
        { buys1h: 100, sells1h: 0, buys24h: 200, sells24h: 0 },
        { buys1h: 7, sells1h: 3, buys24h: 70, sells24h: 30 },
        { buys1h: 1000, sells1h: 1, buys24h: 1000, sells24h: 1 },
      ];

      for (const scenario of scenarios) {
        const result = await scoreBuySellRatio(createMockInput(scenario));
        expect(Number.isInteger(result.score)).toBe(true);
      }
    });
  });

  // =========================================================================
  // Phase 4: Core Ratio Thresholds (per AAP)
  // =========================================================================

  describe('core ratio thresholds', () => {
    it('≥1.3× ratio produces moderate score (≥40) and isAccumulating=true', async () => {
      // Set both 1h and 24h to exactly 1.3× ratio with sufficient transactions
      // buys1h=65, sells1h=50 → ratio 1.3, totalTxns1h=115 (full confidence)
      // buys24h=130, sells24h=100 → ratio 1.3
      // effectiveRatio = 1.3*0.7 + 1.3*0.3 = 1.3
      const input = createMockInput({
        buys1h: 65,
        sells1h: 50,
        buys24h: 130,
        sells24h: 100,
      });
      const result = await scoreBuySellRatio(input);

      expect(result.score).toBeGreaterThanOrEqual(40);
      expect(result.metadata.isAccumulating).toBe(true);
    });

    it('≥2.0× ratio produces strong score (≥65) and isStrongAccumulation=true', async () => {
      // buys1h=100, sells1h=50 → ratio 2.0, totalTxns1h=150 (full confidence)
      // buys24h=200, sells24h=100 → ratio 2.0
      // effectiveRatio = 2.0*0.7 + 2.0*0.3 = 2.0
      const input = createMockInput({
        buys1h: 100,
        sells1h: 50,
        buys24h: 200,
        sells24h: 100,
      });
      const result = await scoreBuySellRatio(input);

      expect(result.score).toBeGreaterThanOrEqual(65);
      expect(result.metadata.isStrongAccumulation).toBe(true);
    });

    it('high buy/sell ratio (5:1) produces high score (≥85)', async () => {
      // buys1h=100, sells1h=20 → ratio 5.0, totalTxns1h=120 (full confidence)
      // buys24h=500, sells24h=100 → ratio 5.0
      // effectiveRatio = 5.0 → maps to score range 85-100
      const input = createMockInput({
        buys1h: 100,
        sells1h: 20,
        buys24h: 500,
        sells24h: 100,
      });
      const result = await scoreBuySellRatio(input);

      expect(result.score).toBeGreaterThanOrEqual(85);
    });

    it('sub-1.0 ratio (more sells than buys) produces low score (≤25)', async () => {
      // buys1h=25, sells1h=50 → ratio 0.5, totalTxns1h=75
      // buys24h=50, sells24h=100 → ratio 0.5
      // effectiveRatio = 0.5 → score = round(0.5 * 25) = 13
      const input = createMockInput({
        buys1h: 25,
        sells1h: 50,
        buys24h: 50,
        sells24h: 100,
      });
      const result = await scoreBuySellRatio(input);

      expect(result.score).toBeLessThanOrEqual(25);
      expect(result.metadata.isAccumulating).toBe(false);
    });

    it('equal buys/sells (1:1 ratio) produces neutral/low-moderate score (~25)', async () => {
      // buys1h=50, sells1h=50 → ratio 1.0, totalTxns1h=100 (full confidence)
      // buys24h=200, sells24h=200 → ratio 1.0
      // effectiveRatio = 1.0 → score = 25 (start of 1.0-1.3 range)
      const input = createMockInput({
        buys1h: 50,
        sells1h: 50,
        buys24h: 200,
        sells24h: 200,
      });
      const result = await scoreBuySellRatio(input);

      // At ratio 1.0, score should be around 25
      expect(result.score).toBeGreaterThanOrEqual(20);
      expect(result.score).toBeLessThanOrEqual(35);
      expect(result.metadata.isAccumulating).toBe(false);
    });

    it('scores increase monotonically as ratio increases', async () => {
      // Test with consistent ratios across both windows, all with full confidence
      const ratioConfigs = [
        { buys1h: 25, sells1h: 50, buys24h: 50, sells24h: 100 },   // 0.5×
        { buys1h: 50, sells1h: 50, buys24h: 200, sells24h: 200 },  // 1.0×
        { buys1h: 65, sells1h: 50, buys24h: 130, sells24h: 100 },  // 1.3×
        { buys1h: 100, sells1h: 50, buys24h: 200, sells24h: 100 }, // 2.0×
        { buys1h: 150, sells1h: 50, buys24h: 300, sells24h: 100 }, // 3.0×
        { buys1h: 100, sells1h: 20, buys24h: 500, sells24h: 100 }, // 5.0×
      ];

      const scores: number[] = [];
      for (const config of ratioConfigs) {
        const result = await scoreBuySellRatio(createMockInput(config));
        scores.push(result.score);
      }

      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
      }
    });
  });

  // =========================================================================
  // Phase 5: Edge Cases with Zero Transactions
  // =========================================================================

  describe('edge cases with zero transactions', () => {
    it('zero total transactions in both 1h and 24h returns score 0', async () => {
      const input = createMockInput({
        buys1h: 0,
        sells1h: 0,
        buys24h: 0,
        sells24h: 0,
      });
      const result = await scoreBuySellRatio(input);

      expect(result.score).toBe(0);
      // Metadata should indicate insufficient transactions
      expect(result.metadata.isAccumulating).toBe(false);
      expect(result.metadata.isStrongAccumulation).toBe(false);
    });

    it('zero sells with some buys returns high score (capped at MAX_MEANINGFUL_RATIO effect)', async () => {
      // buys1h=50, sells1h=0 → ratio capped at 5.0 (MAX_MEANINGFUL_RATIO)
      // buys24h=200, sells24h=0 → ratio capped at 5.0
      // totalTxns1h=50, effectiveRatio=5.0 → score in 85-100 range
      const input = createMockInput({
        buys1h: 50,
        sells1h: 0,
        buys24h: 200,
        sells24h: 0,
      });
      const result = await scoreBuySellRatio(input);

      expect(result.score).toBeGreaterThanOrEqual(85);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('zero buys with some sells returns zero or very low score', async () => {
      // buys1h=0, sells1h=50 → ratio 0
      // buys24h=0, sells24h=200 → ratio 0
      // effectiveRatio=0 → score = round(0 * 25) = 0
      const input = createMockInput({
        buys1h: 0,
        sells1h: 50,
        buys24h: 0,
        sells24h: 200,
      });
      const result = await scoreBuySellRatio(input);

      expect(result.score).toBeLessThanOrEqual(5);
    });

    it('insufficient 1h transactions but enough 24h → uses 24h data', async () => {
      // buys1h=3, sells1h=2 → totalTxns1h=5 (<10, insufficient)
      // buys24h=300, sells24h=100 → totalTxns24h=400 (≥50, sufficient)
      // effectiveRatio = ratio24h = 300/100 = 3.0
      // Score based on 24h ratio with confidence penalty from low 1h txns
      const input = createMockInput({
        buys1h: 3,
        sells1h: 2,
        buys24h: 300,
        sells24h: 100,
      });
      const result = await scoreBuySellRatio(input);

      // Score should be positive (reflecting 3:1 24h ratio), but reduced by
      // confidence penalty (txnConfidence = 5/100 = 0.05)
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('small non-zero 1h transactions below threshold with zero 24h returns 0', async () => {
      // buys1h=3, sells1h=2 → totalTxns1h=5 (<10)
      // buys24h=0, sells24h=0 → totalTxns24h=0 (<50)
      // Both insufficient → score 0
      const input = createMockInput({
        buys1h: 3,
        sells1h: 2,
        buys24h: 0,
        sells24h: 0,
      });
      const result = await scoreBuySellRatio(input);

      expect(result.score).toBe(0);
    });
  });

  // =========================================================================
  // Phase 6: Time Window Weighting
  // =========================================================================

  describe('time window weighting', () => {
    it('1h data is weighted 70% when sufficient transactions', async () => {
      // 1h: buys=100, sells=20 → ratio 5.0 (very strong buying)
      // 24h: buys=100, sells=100 → ratio 1.0 (neutral)
      // totalTxns1h=120 (sufficient, full confidence)
      // effectiveRatio = 5.0*0.7 + 1.0*0.3 = 3.5 + 0.3 = 3.8
      // This should produce a high score reflecting the strong 1h signal,
      // not the neutral 24h signal
      const input = createMockInput({
        buys1h: 100,
        sells1h: 20,
        buys24h: 100,
        sells24h: 100,
      });
      const result = await scoreBuySellRatio(input);

      // Score should be high (reflecting 1h buying pressure dominance)
      // effectiveRatio 3.8 → score in the 85-100 range
      expect(result.score).toBeGreaterThanOrEqual(85);

      // Compare: if pure 24h (ratio 1.0) were used, score would be ~25
      // The actual score should be far above 25, confirming 1h weight dominance
      expect(result.score).toBeGreaterThan(50);
    });

    it('only 24h data used when 1h transactions insufficient', async () => {
      // 1h: buys=3, sells=2 → totalTxns1h=5 (<10, insufficient)
      // 24h: buys=200, sells=100 → ratio 2.0, totalTxns24h=300 (sufficient)
      // effectiveRatio = ratio24h = 2.0 (100% 24h since 1h is insufficient)
      const input = createMockInput({
        buys1h: 3,
        sells1h: 2,
        buys24h: 200,
        sells24h: 100,
      });
      const result = await scoreBuySellRatio(input);

      // The score reflects the 2:1 24h ratio but with confidence penalty
      // The key assertion is that it's > 0 (valid 24h data exists)
      expect(result.score).toBeGreaterThan(0);
    });

    it('divergent 1h and 24h ratios produce blended score', async () => {
      // 1h: buys=50, sells=50 → ratio 1.0 (neutral)
      // 24h: buys=500, sells=100 → ratio 5.0 (very strong)
      // totalTxns1h=100 (sufficient, full confidence)
      // effectiveRatio = 1.0*0.7 + 5.0*0.3 = 0.7 + 1.5 = 2.2
      const input = createMockInput({
        buys1h: 50,
        sells1h: 50,
        buys24h: 500,
        sells24h: 100,
      });
      const result = await scoreBuySellRatio(input);

      // Score should reflect the blended ratio (2.2) which is in the strong range
      // 2.2 is in 2.0-3.0 range → base 65 + some progress
      expect(result.score).toBeGreaterThanOrEqual(65);
      expect(result.score).toBeLessThanOrEqual(85);
    });
  });

  // =========================================================================
  // Phase 7: Confidence Adjustment
  // =========================================================================

  describe('confidence adjustment', () => {
    it('low transaction count reduces score compared to high transaction count', async () => {
      // Same ratio (1.5:1) but different transaction volumes:
      // Low: buys1h=9, sells1h=6, total=15
      // High: buys1h=60, sells1h=40, total=100

      const lowTxnInput = createMockInput({
        buys1h: 9,
        sells1h: 6,
        buys24h: 90,
        sells24h: 60,
      });
      const highTxnInput = createMockInput({
        buys1h: 60,
        sells1h: 40,
        buys24h: 600,
        sells24h: 400,
      });

      const lowResult = await scoreBuySellRatio(lowTxnInput);
      const highResult = await scoreBuySellRatio(highTxnInput);

      // Higher transaction count should produce higher or equal score for same ratio
      expect(highResult.score).toBeGreaterThan(lowResult.score);
    });

    it('full confidence (100+ txns) produces no penalty', async () => {
      // 100 total 1h transactions → txnConfidence = 1.0 → no penalty
      const input = createMockInput({
        buys1h: 60,
        sells1h: 40,
        buys24h: 600,
        sells24h: 400,
      });
      const result = await scoreBuySellRatio(input);

      // ratio 1.5 with full confidence should produce unpenalized score
      // 1.5 is in 1.3-2.0 range: 40 + round(progress * 25)
      // progress = (1.5-1.3)/(2.0-1.3) = 0.2/0.7 ≈ 0.286
      // score = 40 + round(7.14) = 47
      expect(result.score).toBeGreaterThanOrEqual(40);
    });

    it('very low transaction count (< 50 total 1h) applies confidence penalty', async () => {
      // buys1h=12, sells1h=8 → ratio 1.5, totalTxns1h=20
      // txnConfidence = 20/100 = 0.2 (< 0.5 threshold → penalty applies)
      // penalty: rawScore * (0.5 + 0.2) = rawScore * 0.7
      const input = createMockInput({
        buys1h: 12,
        sells1h: 8,
        buys24h: 120,
        sells24h: 80,
      });
      const result = await scoreBuySellRatio(input);

      // Same ratio (1.5) with full confidence would give ~47
      // With penalty: ~47 * 0.7 = ~33
      expect(result.score).toBeLessThan(47);
      expect(result.score).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Phase 8: Metadata Validation
  // =========================================================================

  describe('metadata validation', () => {
    it('metadata contains all expected fields', async () => {
      const input = createMockInput({
        buys1h: 50,
        sells1h: 20,
        buys24h: 500,
        sells24h: 200,
      });
      const result = await scoreBuySellRatio(input);

      // Assert all expected metadata fields are present
      expect(result.metadata).toHaveProperty('buys1h');
      expect(result.metadata).toHaveProperty('sells1h');
      expect(result.metadata).toHaveProperty('buys24h');
      expect(result.metadata).toHaveProperty('sells24h');
      expect(result.metadata).toHaveProperty('ratio1h');
      expect(result.metadata).toHaveProperty('ratio24h');
      expect(result.metadata).toHaveProperty('effectiveRatio');
      expect(result.metadata).toHaveProperty('totalTxns1h');
      expect(result.metadata).toHaveProperty('totalTxns24h');
      expect(result.metadata).toHaveProperty('isAccumulating');
      expect(result.metadata).toHaveProperty('isStrongAccumulation');
    });

    it('metadata reflects the input transaction counts accurately', async () => {
      const input = createMockInput({
        buys1h: 42,
        sells1h: 18,
        buys24h: 350,
        sells24h: 150,
      });
      const result = await scoreBuySellRatio(input);

      expect(result.metadata.buys1h).toBe(42);
      expect(result.metadata.sells1h).toBe(18);
      expect(result.metadata.buys24h).toBe(350);
      expect(result.metadata.sells24h).toBe(150);
      expect(result.metadata.totalTxns1h).toBe(60);
      expect(result.metadata.totalTxns24h).toBe(500);
    });

    it('metadata ratios are rounded to 2 decimal places', async () => {
      // buys1h=70, sells1h=30 → ratio = 2.33333... → rounded to 2.33
      const input = createMockInput({
        buys1h: 70,
        sells1h: 30,
        buys24h: 700,
        sells24h: 300,
      });
      const result = await scoreBuySellRatio(input);

      const ratio1h = result.metadata.ratio1h as number;
      const ratio24h = result.metadata.ratio24h as number;
      const effectiveRatio = result.metadata.effectiveRatio as number;

      // Check that ratios are rounded to 2 decimal places
      // Multiplying by 100, rounding, then dividing by 100 should yield the same value
      expect(ratio1h).toBe(Math.round(ratio1h * 100) / 100);
      expect(ratio24h).toBe(Math.round(ratio24h * 100) / 100);
      expect(effectiveRatio).toBe(Math.round(effectiveRatio * 100) / 100);

      // Verify expected ratio value: 70/30 = 2.333... → 2.33
      expect(ratio1h).toBe(2.33);
      expect(ratio24h).toBe(2.33);
    });

    it('metadata isAccumulating is true when effectiveRatio >= 1.3', async () => {
      const input = createMockInput({
        buys1h: 65,
        sells1h: 50,
        buys24h: 130,
        sells24h: 100,
      });
      const result = await scoreBuySellRatio(input);

      expect(result.metadata.isAccumulating).toBe(true);
    });

    it('metadata isAccumulating is false when effectiveRatio < 1.3', async () => {
      const input = createMockInput({
        buys1h: 50,
        sells1h: 50,
        buys24h: 200,
        sells24h: 200,
      });
      const result = await scoreBuySellRatio(input);

      expect(result.metadata.isAccumulating).toBe(false);
    });

    it('metadata isStrongAccumulation is true when effectiveRatio >= 2.0', async () => {
      const input = createMockInput({
        buys1h: 100,
        sells1h: 50,
        buys24h: 200,
        sells24h: 100,
      });
      const result = await scoreBuySellRatio(input);

      expect(result.metadata.isStrongAccumulation).toBe(true);
    });

    it('metadata isStrongAccumulation is false when effectiveRatio < 2.0', async () => {
      const input = createMockInput({
        buys1h: 65,
        sells1h: 50,
        buys24h: 130,
        sells24h: 100,
      });
      const result = await scoreBuySellRatio(input);

      expect(result.metadata.isStrongAccumulation).toBe(false);
    });

    it('metadata for zero transactions contains reason field', async () => {
      const input = createMockInput({
        buys1h: 0,
        sells1h: 0,
        buys24h: 0,
        sells24h: 0,
      });
      const result = await scoreBuySellRatio(input);

      // When both windows have insufficient transactions, a reason is included
      expect(result.metadata).toHaveProperty('reason');
      expect(typeof result.metadata.reason).toBe('string');
    });
  });

  // =========================================================================
  // Phase 9: Error Handling
  // =========================================================================

  describe('error handling', () => {
    it('handles undefined/NaN inputs gracefully without throwing', async () => {
      // Create a malformed input that may cause NaN propagation
      const malformed = {
        mint: 'test-malformed',
        symbol: 'MAL',
        name: 'Malformed',
        price: NaN,
        priceChange5m: NaN,
        priceChange1h: NaN,
        priceChange24h: NaN,
        marketCap: NaN,
        volume5m: NaN,
        volume1h: NaN,
        volume24h: NaN,
        liquidity: NaN,
        supply: NaN,
        buys1h: NaN,
        sells1h: NaN,
        buys24h: NaN,
        sells24h: NaN,
        holderCount: NaN,
        topHolderPercent: NaN,
        smartMoneyCount: NaN,
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
        lpBurned: false,
        lpLocked: false,
        lpBurnPercent: NaN,
        isHoneypot: false,
        safetyScore: NaN,
        metadataMutable: false,
        devWalletAddress: '',
        devWalletSold: false,
        createdAt: NaN,
      } as unknown as TokenAnalysisInput;

      // Should NOT throw — error handling returns score 0
      const result = await scoreBuySellRatio(malformed);
      expect(result).toBeDefined();
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.name).toBe('buySellRatio');
      expect(result.weight).toBe(0);
    });

    it('returns score 0 with error metadata when input causes errors', async () => {
      // Use a Proxy that throws on property access to trigger the catch block
      const throwingInput = new Proxy({} as TokenAnalysisInput, {
        get(_target, prop) {
          if (prop === 'mint') return 'error-test';
          throw new Error('Property access failed');
        },
      });

      const result = await scoreBuySellRatio(throwingInput);
      expect(result.score).toBe(0);
      expect(result.name).toBe('buySellRatio');
      expect(result.weight).toBe(0);
      expect(result.metadata).toBeDefined();
      // Error metadata should contain the error field
      expect(result.metadata).toHaveProperty('error');
    });

    it('handles negative values in buys/sells gracefully', async () => {
      const input = createMockInput({
        buys1h: -10,
        sells1h: -5,
        buys24h: 500,
        sells24h: 200,
      });

      // Should not throw — negative values are unusual but the function handles them
      const result = await scoreBuySellRatio(input);
      expect(result).toBeDefined();
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.name).toBe('buySellRatio');
    });

    it('weight is always 0 regardless of error state', async () => {
      const throwingInput = new Proxy({} as TokenAnalysisInput, {
        get(_target, prop) {
          if (prop === 'mint') return 'weight-test';
          throw new Error('Test error');
        },
      });

      const result = await scoreBuySellRatio(throwingInput);
      expect(result.weight).toBe(0);
    });
  });

  // =========================================================================
  // Additional Integration-Style Assertions
  // =========================================================================

  describe('realistic trading scenarios', () => {
    it('pump.fun token with explosive buying → high score', async () => {
      // Simulates a new pump.fun token with heavy buying and minimal selling
      const input = createMockInput({
        buys1h: 200,
        sells1h: 30,
        buys24h: 200,
        sells24h: 30,
      });
      const result = await scoreBuySellRatio(input);

      expect(result.score).toBeGreaterThanOrEqual(75);
      expect(result.metadata.isAccumulating).toBe(true);
      expect(result.metadata.isStrongAccumulation).toBe(true);
    });

    it('dying token with heavy selling → low score', async () => {
      // Simulates a token dump with heavy selling
      const input = createMockInput({
        buys1h: 10,
        sells1h: 80,
        buys24h: 100,
        sells24h: 800,
      });
      const result = await scoreBuySellRatio(input);

      expect(result.score).toBeLessThanOrEqual(15);
      expect(result.metadata.isAccumulating).toBe(false);
      expect(result.metadata.isStrongAccumulation).toBe(false);
    });

    it('gradual accumulation with moderate buying → moderate score', async () => {
      // Simulates a token in gradual accumulation phase (~1.5× ratio)
      const input = createMockInput({
        buys1h: 75,
        sells1h: 50,
        buys24h: 750,
        sells24h: 500,
      });
      const result = await scoreBuySellRatio(input);

      expect(result.score).toBeGreaterThanOrEqual(35);
      expect(result.score).toBeLessThanOrEqual(65);
      expect(result.metadata.isAccumulating).toBe(true);
    });
  });
});
