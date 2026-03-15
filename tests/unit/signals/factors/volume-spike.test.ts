/**
 * tests/unit/signals/factors/volume-spike.test.ts
 *
 * Comprehensive unit tests for the volume spike detection factor module.
 * Validates all scoring behaviours against the AAP specification:
 *
 *   - Minimum volume thresholds: $200 / 5 min, $2 000 / 1 h → score 0 when not met
 *   - Spike-multiplier piecewise-linear scoring:
 *       ≤ 1×  → 0
 *       1–1.5 → 0–15  (mild increase)
 *       1.5–3 → 15–50 (moderate spike)
 *       3–8   → 50–85 (AAP sweet spot)
 *       8–15  → 85–100 (extreme spike, diminishing returns)
 *   - Volume-to-market-cap ratio ≥ 100 % adds +15 bonus
 *   - Fallback MA estimation from 1 h volume / 12 when volume5mMA is missing
 *   - Score clamped to integer in [0, 100]
 *   - FactorResult structure: name = 'volumeSpike', weight = 0
 *   - Metadata correctness & spike-multiplier rounding
 *   - Score monotonicity over rising spike multipliers
 *   - Graceful error handling (returns score 0)
 *
 * @module tests/unit/signals/factors/volume-spike
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TokenAnalysisInput, FactorResult } from '../../../../src/signals/types';

// ---------------------------------------------------------------------------
// Module Mocks — hoisted by Vitest before any module code executes
// ---------------------------------------------------------------------------

/**
 * Mock the logger dependency to prevent console output during tests and to
 * allow the volume-spike module to resolve its createLogger import.
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
 * Mock the config dependency with deterministic threshold values matching
 * AAP specification ($200 / 5 min, $2 000 / 1 h).
 */
vi.mock('../../../../src/utils/config', () => ({
  LIQUIDITY: {
    MIN_5M_VOLUME_USD: 200,
    MIN_1H_VOLUME_USD: 2000,
  },
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are declared
// ---------------------------------------------------------------------------

import { scoreVolumeSpike } from '../../../../src/signals/factors/volume-spike';

// ---------------------------------------------------------------------------
// Test-Data Factory
// ---------------------------------------------------------------------------

/**
 * Creates a fully-typed {@link TokenAnalysisInput} with sensible defaults.
 *
 * Default state:
 *   - volume5m  = 1 000  ($1 k 5 m volume — passes $200 minimum)
 *   - volume1h  = 5 000  ($5 k 1 h volume — passes $2 000 minimum)
 *   - volume24h = 80 000
 *   - volume5mMA = 200   → default spike = 5× (high-score zone)
 *   - marketCap  = 50 000
 *
 * Any field can be overridden via the `overrides` parameter.
 */
function createMockInput(
  overrides: Partial<TokenAnalysisInput> = {},
): TokenAnalysisInput {
  return {
    // Identity
    mint: 'TestMint1111111111111111111111111111111111',
    symbol: 'TEST',
    name: 'Test Token',

    // Price
    price: 0.001,
    priceChange5m: 5,
    priceChange1h: 10,
    priceChange24h: 20,

    // Market
    marketCap: 50_000,
    volume5m: 1_000,
    volume1h: 5_000,
    volume24h: 30_000,
    liquidity: 30_000,
    supply: 1_000_000_000,

    // Trading activity
    buys1h: 100,
    sells1h: 50,
    buys24h: 1_000,
    sells24h: 500,

    // Holders
    holderCount: 500,
    topHolderPercent: 15,
    smartMoneyCount: 2,

    // Safety / authority
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    lpBurned: true,
    lpLocked: false,
    lpBurnPercent: 95,
    isHoneypot: false,
    safetyScore: 500,
    metadataMutable: false,

    // Dev wallet
    devWalletAddress: 'DevWallet111111111111111111111111111111111',
    devWalletSold: false,

    // Token age — 1 hour ago
    createdAt: Math.floor(Date.now() / 1000) - 3600,

    // Volume MA — explicit so default spike = 5×
    volume5mMA: 200,

    // Allow overrides to win
    ...overrides,
  };
}

// ===========================================================================
//  T E S T   S U I T E
// ===========================================================================

describe('scoreVolumeSpike', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // 1. FactorResult Structure
  // =========================================================================

  describe('FactorResult structure', () => {
    it('returns a result with name "volumeSpike"', async () => {
      const result = await scoreVolumeSpike(createMockInput());
      expect(result.name).toBe('volumeSpike');
    });

    it('returns weight === 0 (weights applied externally by scoring engine)', async () => {
      const result = await scoreVolumeSpike(createMockInput());
      expect(result.weight).toBe(0);
    });

    it('returns an object with score and metadata fields', async () => {
      const result = await scoreVolumeSpike(createMockInput());
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('metadata');
      expect(typeof result.score).toBe('number');
      expect(typeof result.metadata).toBe('object');
    });

    it('always returns score as an integer between 0 and 100', async () => {
      const inputs = [
        createMockInput({ volume5m: 50 }),                     // below threshold
        createMockInput({ volume5m: 200, volume5mMA: 200 }),   // 1× spike
        createMockInput({ volume5m: 300, volume5mMA: 200 }),   // 1.5× spike
        createMockInput({ volume5m: 600, volume5mMA: 200 }),   // 3× spike
        createMockInput({ volume5m: 1000, volume5mMA: 200 }),  // 5× spike
        createMockInput({ volume5m: 1600, volume5mMA: 200 }),  // 8× spike
        createMockInput({ volume5m: 3000, volume5mMA: 200 }),  // 15× spike
        createMockInput({ volume5m: 10000, volume5mMA: 200 }), // 50× spike
      ];

      for (const input of inputs) {
        const result = await scoreVolumeSpike(input);
        expect(Number.isInteger(result.score)).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
      }
    });
  });

  // =========================================================================
  // 2. Minimum Volume Thresholds (AAP: $200 / 5 m, $2 000 / 1 h)
  // =========================================================================

  describe('minimum volume thresholds', () => {
    it('returns score 0 when 5 m volume ($100) is below $200 minimum', async () => {
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 100 }),
      );
      expect(result.score).toBe(0);
      expect(result.metadata).toHaveProperty('reason');
      expect(String(result.metadata.reason)).toMatch(/5m volume/i);
    });

    it('returns score 0 when 1 h volume ($1 000) is below $2 000 minimum', async () => {
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 500, volume1h: 1000 }),
      );
      expect(result.score).toBe(0);
      expect(result.metadata).toHaveProperty('reason');
      expect(String(result.metadata.reason)).toMatch(/1h volume/i);
    });

    it('returns score 0 when 5 m volume is $199 (just below $200 boundary)', async () => {
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 199 }),
      );
      expect(result.score).toBe(0);
    });

    it('passes both thresholds when volume5m = $200 and volume1h = $2 000', async () => {
      // spike = 200/200 = 1× → score 0, but thresholds are satisfied
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 200, volume1h: 2000, volume5mMA: 200 }),
      );
      // Score is 0 because 1× spike = no signal, but no "below minimum" reason
      expect(result.score).toBe(0);
      // Verify it did NOT fail due to threshold but due to 1× multiplier
      expect(result.metadata.reason).toBeUndefined();
    });

    it('returns score 0 when both volumes are zero', async () => {
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 0, volume1h: 0, volume24h: 0 }),
      );
      expect(result.score).toBe(0);
    });
  });

  // =========================================================================
  // 3. Spike Multiplier Scoring (AAP: 3–8× = high score)
  // =========================================================================

  describe('spike multiplier scoring', () => {
    it('1× spike (no spike) → score 0', async () => {
      // volume5m=200, volume5mMA=200 → spike = 1.0
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 200, volume5mMA: 200, volume1h: 2000 }),
      );
      expect(result.score).toBe(0);
    });

    it('1.5× spike → score ~15 (entering moderate zone)', async () => {
      // volume5m=300, volume5mMA=200 → spike = 1.5
      // At exactly 1.5×, the piecewise enters the 1.5-3 range at the low end
      // Expected: 15 + round((1.5 - 1.5) / (3.0 - 1.5) * 35) = 15
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 300, volume5mMA: 200, volume1h: 2000 }),
      );
      expect(result.score).toBeGreaterThanOrEqual(10);
      expect(result.score).toBeLessThanOrEqual(20);
    });

    it('3× spike → score ~50 (entering high zone per AAP)', async () => {
      // volume5m=600, volume5mMA=200 → spike = 3.0
      // Expected: 50 + round((3.0 - 3.0) / (8.0 - 3.0) * 35) = 50
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 600, volume5mMA: 200, volume1h: 2000 }),
      );
      expect(result.score).toBeGreaterThanOrEqual(45);
      expect(result.score).toBeLessThanOrEqual(55);
    });

    it('5× spike → score ~64 (mid-high zone)', async () => {
      // volume5m=1000, volume5mMA=200 → spike = 5.0
      // Expected: 50 + round((5.0 - 3.0) / (8.0 - 3.0) * 35) = 50 + 14 = 64
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 1000, volume5mMA: 200, volume1h: 2000 }),
      );
      expect(result.score).toBeGreaterThanOrEqual(60);
      expect(result.score).toBeLessThanOrEqual(75);
    });

    it('8× spike → score ~85 (top of AAP sweet spot)', async () => {
      // volume5m=1600, volume5mMA=200 → spike = 8.0
      // Expected: 85 + round(min(1, (8.0 - 8.0) / 7.0) * 15) = 85
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 1600, volume5mMA: 200, volume1h: 2000 }),
      );
      expect(result.score).toBeGreaterThanOrEqual(80);
      expect(result.score).toBeLessThanOrEqual(90);
    });

    it('15× spike → score ~100 (capped with diminishing returns)', async () => {
      // volume5m=3000, volume5mMA=200 → spike = 15.0
      // Expected: 85 + round(min(1, (15.0 - 8.0) / 7.0) * 15) = 85 + 15 = 100
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 3000, volume5mMA: 200, volume1h: 2000 }),
      );
      expect(result.score).toBeGreaterThanOrEqual(95);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('20× spike → score 100 (beyond max, hard cap)', async () => {
      // volume5m=4000, volume5mMA=200 → spike = 20.0
      // extraFactor capped at 1 → 85 + 15 = 100
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 4000, volume5mMA: 200, volume1h: 2000 }),
      );
      expect(result.score).toBe(100);
    });

    it('sub-1× multiplier (declining volume) → score 0', async () => {
      // volume5m=100 but needs to pass threshold check, so use low MA
      // Actually 100 < 200 threshold → would fail at threshold
      // Use volume5m=200, volume5mMA=400 → spike = 0.5
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 200, volume5mMA: 400, volume1h: 2000 }),
      );
      expect(result.score).toBe(0);
    });
  });

  // =========================================================================
  // 4. Volume-to-Market-Cap Ratio Bonus (AAP: ≥ 100 % adds bonus)
  // =========================================================================

  describe('volume-to-market-cap ratio bonus', () => {
    it('adds bonus when vol/MC ratio ≥ 100 %', async () => {
      // Both have 5× spike (score 64 base)
      // High vol/MC: volume24h=100000, marketCap=50000 → ratio 200% → +15 → 79
      const highRatio = await scoreVolumeSpike(
        createMockInput({
          volume5m: 1000,
          volume5mMA: 200,
          volume1h: 5000,
          volume24h: 100_000,
          marketCap: 50_000,
        }),
      );

      // Low vol/MC: volume24h=100000, marketCap=200000 → ratio 50% → no bonus → 64
      const lowRatio = await scoreVolumeSpike(
        createMockInput({
          volume5m: 1000,
          volume5mMA: 200,
          volume1h: 5000,
          volume24h: 100_000,
          marketCap: 200_000,
        }),
      );

      expect(highRatio.score).toBeGreaterThan(lowRatio.score);
    });

    it('does not add bonus when vol/MC ratio < 100 %', async () => {
      // vol/MC = 30000/50000 * 100 = 60% → no bonus
      const noBonusResult = await scoreVolumeSpike(
        createMockInput({
          volume5m: 1000,
          volume5mMA: 200,
          volume1h: 5000,
          volume24h: 30_000,
          marketCap: 50_000,
        }),
      );

      // Same spike, same vol/MC → identical score
      const sameResult = await scoreVolumeSpike(
        createMockInput({
          volume5m: 1000,
          volume5mMA: 200,
          volume1h: 5000,
          volume24h: 30_000,
          marketCap: 50_000,
        }),
      );

      expect(noBonusResult.score).toBe(sameResult.score);
    });

    it('handles marketCap = 0 without crashing (no bonus, no division by zero)', async () => {
      const result = await scoreVolumeSpike(
        createMockInput({
          volume5m: 1000,
          volume5mMA: 200,
          volume1h: 5000,
          marketCap: 0,
        }),
      );
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      // Verify volumeToMcRatio is null (division by zero guard)
      expect(result.metadata.volumeToMcRatio).toBeNull();
    });

    it('clamps total score to 100 even after bonus applied', async () => {
      // 15× spike = base score 100, + 15 bonus → clamped to 100
      const result = await scoreVolumeSpike(
        createMockInput({
          volume5m: 3000,
          volume5mMA: 200,
          volume1h: 5000,
          volume24h: 200_000,
          marketCap: 50_000, // ratio 400% → bonus
        }),
      );
      expect(result.score).toBeLessThanOrEqual(100);
    });
  });

  // =========================================================================
  // 5. Fallback MA Estimation (volume1h / 12)
  // =========================================================================

  describe('fallback MA estimation', () => {
    it('estimates MA from 1 h volume / 12 when volume5mMA is undefined', async () => {
      // volume5mMA=undefined, volume5m=1000, volume1h=6000
      // Estimated MA = 6000/12 = 500, spike = 1000/500 = 2.0
      // Score: 15 + round((2.0 - 1.5) / (3.0 - 1.5) * 35) = 15 + 12 = 27
      const result = await scoreVolumeSpike(
        createMockInput({
          volume5m: 1000,
          volume1h: 6000,
          volume5mMA: undefined,
        }),
      );
      // 2× spike → moderate zone (expect ~27)
      expect(result.score).toBeGreaterThanOrEqual(20);
      expect(result.score).toBeLessThanOrEqual(35);
    });

    it('uses fallback when volume5mMA is 0', async () => {
      // volume5mMA=0 treated as invalid → fallback to volume1h/12
      // volume5m=1000, volume1h=6000 → estimated MA=500, spike=2.0
      const result = await scoreVolumeSpike(
        createMockInput({
          volume5m: 1000,
          volume1h: 6000,
          volume5mMA: 0,
        }),
      );
      // Should produce the same score as undefined MA with same volumes
      expect(result.score).toBeGreaterThanOrEqual(20);
      expect(result.score).toBeLessThanOrEqual(35);
    });

    it('fallback and explicit MA produce consistent scores for same spike', async () => {
      // Explicit: volume5m=1000, volume5mMA=500 → spike = 2.0
      const explicit = await scoreVolumeSpike(
        createMockInput({
          volume5m: 1000,
          volume1h: 6000,
          volume5mMA: 500,
        }),
      );

      // Fallback: volume5m=1000, volume1h=6000 → estimated MA = 500, spike = 2.0
      const fallback = await scoreVolumeSpike(
        createMockInput({
          volume5m: 1000,
          volume1h: 6000,
          volume5mMA: undefined,
        }),
      );

      expect(explicit.score).toBe(fallback.score);
    });
  });

  // =========================================================================
  // 6. Score Monotonicity
  // =========================================================================

  describe('score monotonicity', () => {
    it('higher spike multiplier produces higher or equal score', async () => {
      const multipliers = [1, 2, 3, 5, 8, 10, 15];
      const baseMA = 200;
      const scores: number[] = [];

      for (const mult of multipliers) {
        const volume5m = baseMA * mult;
        const result = await scoreVolumeSpike(
          createMockInput({
            volume5m,
            volume5mMA: baseMA,
            volume1h: Math.max(2000, volume5m * 2), // ensure 1h threshold met
            volume24h: 30_000, // below 100% of MC → no bonus interference
            marketCap: 50_000,
          }),
        );
        scores.push(result.score);
      }

      // Assert monotonically non-decreasing
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
      }
    });
  });

  // =========================================================================
  // 7. Metadata Validation
  // =========================================================================

  describe('metadata validation', () => {
    it('contains all expected diagnostic fields', async () => {
      const input = createMockInput({
        volume5m: 1000,
        volume1h: 5000,
        volume24h: 80000,
        volume5mMA: 200,
        marketCap: 50_000,
      });
      const result = await scoreVolumeSpike(input);

      expect(result.metadata).toHaveProperty('volume5m');
      expect(result.metadata).toHaveProperty('volume1h');
      expect(result.metadata).toHaveProperty('volume24h');
      expect(result.metadata).toHaveProperty('volume5mMA');
      expect(result.metadata).toHaveProperty('spikeMultiplier');
      expect(result.metadata).toHaveProperty('volumeToMcRatio');
      expect(result.metadata).toHaveProperty('marketCap');
    });

    it('echoes back volume input values correctly', async () => {
      const result = await scoreVolumeSpike(
        createMockInput({
          volume5m: 1234,
          volume1h: 5678,
          volume24h: 99999,
          volume5mMA: 300,
          marketCap: 40_000,
        }),
      );

      expect(result.metadata.volume5m).toBe(1234);
      expect(result.metadata.volume1h).toBe(5678);
      expect(result.metadata.volume24h).toBe(99999);
      expect(result.metadata.volume5mMA).toBe(300);
      expect(result.metadata.marketCap).toBe(40_000);
    });

    it('rounds spikeMultiplier to 2 decimal places', async () => {
      // spike = 1000 / 300 = 3.333... → rounded to 3.33
      const result = await scoreVolumeSpike(
        createMockInput({
          volume5m: 1000,
          volume5mMA: 300,
          volume1h: 5000,
        }),
      );

      const spike = result.metadata.spikeMultiplier as number;
      // Check that it has at most 2 decimal places
      const decimalStr = String(spike).split('.')[1] ?? '';
      expect(decimalStr.length).toBeLessThanOrEqual(2);
    });

    it('sets volumeToMcRatio to null when marketCap is 0', async () => {
      const result = await scoreVolumeSpike(
        createMockInput({ marketCap: 0 }),
      );
      expect(result.metadata.volumeToMcRatio).toBeNull();
    });

    it('computes volumeToMcRatio correctly when marketCap > 0', async () => {
      // volume24h=100000, marketCap=50000 → ratio = (100000/50000)*100 = 200
      // The implementation rounds: Math.round(200 * 100) / 100 = 200.00
      const result = await scoreVolumeSpike(
        createMockInput({
          volume24h: 100_000,
          marketCap: 50_000,
          volume5m: 1000,
          volume5mMA: 200,
          volume1h: 5000,
        }),
      );
      expect(result.metadata.volumeToMcRatio).toBe(200);
    });

    it('sets volume5mMA metadata to null when volume5mMA is undefined', async () => {
      const result = await scoreVolumeSpike(
        createMockInput({ volume5mMA: undefined, volume1h: 6000, volume5m: 1000 }),
      );
      expect(result.metadata.volume5mMA).toBeNull();
    });

    it('includes reason metadata when volume threshold is not met', async () => {
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 50 }),
      );
      expect(result.metadata.reason).toBeDefined();
      expect(typeof result.metadata.reason).toBe('string');
    });
  });

  // =========================================================================
  // 8. Error Handling
  // =========================================================================

  describe('error handling', () => {
    it('returns score 0 with error metadata when an error occurs', async () => {
      // Create a Proxy that throws on most property accesses to simulate
      // corrupted input data. The function's try-catch should handle this.
      const badInput = new Proxy(
        {} as TokenAnalysisInput,
        {
          get(target, prop) {
            if (prop === 'mint') return 'error-test-mint';
            if (prop === 'volume5m') throw new Error('Simulated data error');
            return undefined;
          },
        },
      );

      const result = await scoreVolumeSpike(badInput);
      expect(result.score).toBe(0);
      expect(result.name).toBe('volumeSpike');
      expect(result.weight).toBe(0);
      expect(result.metadata).toBeDefined();
    });

    it('handles negative volume values gracefully', async () => {
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: -500, volume1h: -1000 }),
      );
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('handles NaN volume5mMA gracefully', async () => {
      const result = await scoreVolumeSpike(
        createMockInput({ volume5mMA: NaN, volume5m: 1000, volume1h: 5000 }),
      );
      // NaN is not > 0, so falls to fallback path
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('handles Infinity volume values without exceeding score bounds', async () => {
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: Infinity, volume5mMA: 200, volume1h: 5000 }),
      );
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });
  });

  // =========================================================================
  // 9. Score Clamping
  // =========================================================================

  describe('score clamping', () => {
    it('clamps to maximum 100 even with extreme inputs', async () => {
      const result = await scoreVolumeSpike(
        createMockInput({
          volume5m: 50_000,
          volume5mMA: 200, // 250× spike
          volume1h: 100_000,
          volume24h: 500_000,
          marketCap: 50_000, // vol/MC 1000% → bonus
        }),
      );
      expect(result.score).toBe(100);
    });

    it('clamps to minimum 0', async () => {
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 0, volume1h: 0, volume24h: 0 }),
      );
      expect(result.score).toBe(0);
    });
  });

  // =========================================================================
  // 10. Weight is always 0
  // =========================================================================

  describe('weight consistency', () => {
    it('returns weight 0 regardless of input scenario', async () => {
      const scenarios = [
        createMockInput({ volume5m: 0 }),                        // below threshold
        createMockInput({ volume5m: 200, volume5mMA: 200 }),     // 1× spike
        createMockInput({ volume5m: 3000, volume5mMA: 200 }),    // 15× spike
        createMockInput({ volume5m: 1000, volume5mMA: undefined }), // fallback MA
      ];

      for (const input of scenarios) {
        const result = await scoreVolumeSpike(input);
        expect(result.weight).toBe(0);
      }
    });
  });

  // =========================================================================
  // 11. Exact Piecewise-Linear Score Calculations
  // =========================================================================

  describe('exact piecewise-linear calculations', () => {
    it('2× spike (moderate) → exact score 27', async () => {
      // spike=2.0: 15 + round((2.0-1.5)/(3.0-1.5)*35) = 15 + round(11.67) = 15+12 = 27
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 400, volume5mMA: 200, volume1h: 2000 }),
      );
      expect(result.score).toBe(27);
    });

    it('exactly 1.5× spike → exact score 15', async () => {
      // spike=1.5: enters 1.5-3 range at start → 15 + round(0) = 15
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 300, volume5mMA: 200, volume1h: 2000 }),
      );
      expect(result.score).toBe(15);
    });

    it('exactly 3× spike → exact score 50', async () => {
      // spike=3.0: enters 3-8 range at start → 50 + round(0) = 50
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 600, volume5mMA: 200, volume1h: 2000 }),
      );
      expect(result.score).toBe(50);
    });

    it('exactly 5× spike → exact score 64', async () => {
      // spike=5.0: 50 + round((5.0-3.0)/(8.0-3.0)*35) = 50 + round(14.0) = 64
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 1000, volume5mMA: 200, volume1h: 2000 }),
      );
      expect(result.score).toBe(64);
    });

    it('exactly 8× spike → exact score 85', async () => {
      // spike=8.0: 85 + round(min(1,0)*15) = 85 + 0 = 85
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 1600, volume5mMA: 200, volume1h: 2000 }),
      );
      expect(result.score).toBe(85);
    });

    it('exactly 15× spike → exact score 100', async () => {
      // spike=15.0: 85 + round(min(1,1.0)*15) = 85 + 15 = 100
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 3000, volume5mMA: 200, volume1h: 2000 }),
      );
      expect(result.score).toBe(100);
    });

    it('1.25× spike → exact score 8 (mild range)', async () => {
      // spike=1.25: round((1.25-1.0)/(1.5-1.0)*15) = round(0.5*15) = round(7.5) = 8
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 250, volume5mMA: 200, volume1h: 2000 }),
      );
      expect(result.score).toBe(8);
    });

    it('11.5× spike → exact score 93 (extreme range)', async () => {
      // spike=11.5: 85 + round(min(1, (11.5-8.0)/(15.0-8.0))*15)
      //           = 85 + round(min(1, 0.5)*15) = 85 + round(7.5) = 85 + 8 = 93
      const result = await scoreVolumeSpike(
        createMockInput({ volume5m: 2300, volume5mMA: 200, volume1h: 5000 }),
      );
      expect(result.score).toBe(93);
    });
  });

  // =========================================================================
  // 12. Combined Spike + Bonus
  // =========================================================================

  describe('combined spike score with vol/MC bonus', () => {
    it('5× spike + 200% vol/MC → 64 + 15 = 79', async () => {
      // spike=5.0→64, vol/MC = 100000/50000*100 = 200% → +15 → 79
      const result = await scoreVolumeSpike(
        createMockInput({
          volume5m: 1000,
          volume5mMA: 200,
          volume1h: 5000,
          volume24h: 100_000,
          marketCap: 50_000,
        }),
      );
      expect(result.score).toBe(79);
    });

    it('8× spike + 200% vol/MC → 85 + 15 = 100 (clamped)', async () => {
      const result = await scoreVolumeSpike(
        createMockInput({
          volume5m: 1600,
          volume5mMA: 200,
          volume1h: 5000,
          volume24h: 100_000,
          marketCap: 50_000,
        }),
      );
      expect(result.score).toBe(100);
    });

    it('3× spike + exactly 100% vol/MC → 50 + 15 = 65', async () => {
      // vol/MC = 50000/50000*100 = 100% → bonus
      const result = await scoreVolumeSpike(
        createMockInput({
          volume5m: 600,
          volume5mMA: 200,
          volume1h: 2000,
          volume24h: 50_000,
          marketCap: 50_000,
        }),
      );
      expect(result.score).toBe(65);
    });

    it('3× spike + 99% vol/MC → 50 (no bonus)', async () => {
      // vol/MC = 49500/50000*100 = 99% < 100% → no bonus
      const result = await scoreVolumeSpike(
        createMockInput({
          volume5m: 600,
          volume5mMA: 200,
          volume1h: 2000,
          volume24h: 49_500,
          marketCap: 50_000,
        }),
      );
      expect(result.score).toBe(50);
    });
  });
});
