/**
 * tests/unit/signals/factors/liquidity.test.ts — Unit Tests for Liquidity Factor
 *
 * Comprehensive test suite for the `scoreLiquidity` function from
 * `src/signals/factors/liquidity.ts`. Validates:
 *
 *   1. FactorResult structure (name, weight, score, metadata)
 *   2. Minimum liquidity threshold ($3K pump.fun minimum)
 *   3. Tiered liquidity depth scoring ($3K → $200K+)
 *   4. LP burn/lock status bonus/penalty (+10/+5/-10)
 *   5. Volume-to-liquidity ratio adjustments (±5)
 *   6. Boundary value testing at $3K and $30K
 *   7. Metadata field completeness and tier label correctness
 *   8. Error handling — graceful degradation to score 0
 *
 * Dependencies mocked:
 *   - src/utils/logger.ts → createLogger returns no-op Logger stubs
 *   - src/utils/config.ts → LIQUIDITY returns controlled threshold values
 *
 * @module tests/unit/signals/factors/liquidity
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Dependency Mocks — MUST be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('../../../../src/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../../src/utils/config', () => ({
  LIQUIDITY: {
    MIN_PUMP_FUN_USD: 3000,
    MIN_ESTABLISHED_USD: 30000,
    VOLUME_POSITION_RATIO: 10,
    MIN_5M_VOLUME_USD: 200,
    MIN_1H_VOLUME_USD: 2000,
  },
}));

// ---------------------------------------------------------------------------
// Module Under Test
// ---------------------------------------------------------------------------

import { scoreLiquidity } from '../../../../src/signals/factors/liquidity';
import type { TokenAnalysisInput, FactorResult } from '../../../../src/signals/types';

// ---------------------------------------------------------------------------
// Test Data Factory
// ---------------------------------------------------------------------------

/**
 * Creates a complete `TokenAnalysisInput` with sensible defaults for
 * liquidity testing. Override any field to test specific scenarios.
 *
 * Defaults:
 *   liquidity: 25000  (moderate tier)
 *   volume24h: 50000  (healthy volume)
 *   lpBurned: true    (LP committed)
 *   lpLocked: false
 *   lpBurnPercent: 95
 */
function createMockInput(overrides: Partial<TokenAnalysisInput> = {}): TokenAnalysisInput {
  return {
    // Identity
    mint: 'TestMint111111111111111111111111111111111111',
    symbol: 'TEST',
    name: 'Test Token',

    // Price data
    price: 0.001,
    priceChange5m: 5.0,
    priceChange1h: 10.0,
    priceChange24h: 20.0,

    // Market data
    marketCap: 100_000,
    volume5m: 500,
    volume1h: 5_000,
    volume24h: 50_000,
    liquidity: 25_000,
    supply: 1_000_000_000,

    // Trading activity
    buys1h: 100,
    sells1h: 50,
    buys24h: 1_000,
    sells24h: 500,

    // Holder data
    holderCount: 500,
    topHolderPercent: 15,
    smartMoneyCount: 2,

    // Safety & authority
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    lpBurned: true,
    lpLocked: false,
    lpBurnPercent: 95,
    isHoneypot: false,
    safetyScore: 500,
    metadataMutable: false,

    // Developer wallet
    devWalletAddress: 'DevWallet111111111111111111111111111111111',
    devWalletSold: false,

    // Token age — 1 hour old
    createdAt: Math.floor(Date.now() / 1000) - 3600,

    // Apply overrides last to allow any field to be customized
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('scoreLiquidity', () => {
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
    it('returns a FactorResult with name "liquidity"', async () => {
      const input = createMockInput();
      const result = await scoreLiquidity(input);
      expect(result.name).toBe('liquidity');
    });

    it('returns weight of 0 (weights are applied externally by the scoring engine)', async () => {
      const input = createMockInput();
      const result = await scoreLiquidity(input);
      expect(result.weight).toBe(0);
    });

    it('returns result with score and metadata fields', async () => {
      const input = createMockInput();
      const result = await scoreLiquidity(input);
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('metadata');
      expect(typeof result.score).toBe('number');
      expect(typeof result.metadata).toBe('object');
    });

    it('returns score as an integer between 0 and 100', async () => {
      const inputs = [
        createMockInput({ liquidity: 0 }),
        createMockInput({ liquidity: 2000 }),
        createMockInput({ liquidity: 3000 }),
        createMockInput({ liquidity: 15000 }),
        createMockInput({ liquidity: 50000 }),
        createMockInput({ liquidity: 250000 }),
        createMockInput({ liquidity: 10_000_000 }),
      ];

      for (const input of inputs) {
        const result = await scoreLiquidity(input);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
        expect(Number.isInteger(result.score)).toBe(true);
      }
    });
  });

  // =========================================================================
  // Phase 3: Minimum Liquidity Threshold ($3K)
  // =========================================================================

  describe('minimum liquidity threshold ($3K)', () => {
    it('scores 0 when liquidity is $2K (below minimum)', async () => {
      const input = createMockInput({ liquidity: 2000 });
      const result = await scoreLiquidity(input);
      expect(result.score).toBe(0);
      expect(result.metadata).toHaveProperty('reason');
      expect(String(result.metadata.reason).toLowerCase()).toContain('minimum');
    });

    it('scores > 0 when liquidity is exactly $3K (at boundary)', async () => {
      const input = createMockInput({ liquidity: 3000 });
      const result = await scoreLiquidity(input);
      expect(result.score).toBeGreaterThan(0);
    });

    it('scores 0 when liquidity is $2,999 (just below boundary)', async () => {
      const input = createMockInput({ liquidity: 2999 });
      const result = await scoreLiquidity(input);
      expect(result.score).toBe(0);
    });

    it('scores 0 when liquidity is $0', async () => {
      const input = createMockInput({ liquidity: 0 });
      const result = await scoreLiquidity(input);
      expect(result.score).toBe(0);
    });

    it('scores 0 when liquidity is negative', async () => {
      const input = createMockInput({ liquidity: -1000 });
      const result = await scoreLiquidity(input);
      expect(result.score).toBe(0);
    });

    it('scores 0 when liquidity is $1 (far below minimum)', async () => {
      const input = createMockInput({ liquidity: 1 });
      const result = await scoreLiquidity(input);
      expect(result.score).toBe(0);
    });
  });

  // =========================================================================
  // Phase 4: Liquidity Depth Tiers
  // =========================================================================

  describe('liquidity depth tiers', () => {
    it('$5K liquidity with LP burned → score in range 20-35', async () => {
      // At $5K (TIER_LOW boundary), depth score = 20, LP burned = +10
      // vol/liq = 50000/5000 = 10 → borderline (exactly 10, not >10) → adj 0
      // Total: 20 + 0 + 10 = 30
      const input = createMockInput({ liquidity: 5000, lpBurned: true });
      const result = await scoreLiquidity(input);
      expect(result.score).toBeGreaterThanOrEqual(20);
      expect(result.score).toBeLessThanOrEqual(35);
    });

    it('$15K liquidity → moderate base score (depth tier 40+)', async () => {
      // At $15K (TIER_MID boundary), depth score = 40
      // With default vol24h=50000 and liquidity=15000:
      //   ratio = 50000/15000 ≈ 3.33 → healthy → +5
      //   LP burned = +10 → total = 55
      const input = createMockInput({ liquidity: 15000 });
      const result = await scoreLiquidity(input);
      expect(result.score).toBeGreaterThanOrEqual(40);
      expect(result.score).toBeLessThanOrEqual(70);
    });

    it('$50K liquidity with LP burned and healthy volume → score ≥ 65', async () => {
      // At $50K (TIER_HIGH boundary), depth score = 60
      // ratio = 100000/50000 = 2.0 → healthy → +5
      // LP burned = +10 → total = 75
      const input = createMockInput({
        liquidity: 50000,
        lpBurned: true,
        volume24h: 100000,
      });
      const result = await scoreLiquidity(input);
      expect(result.score).toBeGreaterThanOrEqual(65);
    });

    it('$200K+ liquidity with LP burned → score ≥ 85', async () => {
      // At $250K, deep tier: log10(250000/200000) ≈ 0.097
      // depth = min(90, 80 + round(0.097 * 10)) = 81
      // vol/liq = 50000/250000 = 0.2 → borderline → adj 0
      // LP burned = +10 → total = 91
      const input = createMockInput({
        liquidity: 250000,
        lpBurned: true,
      });
      const result = await scoreLiquidity(input);
      expect(result.score).toBeGreaterThanOrEqual(85);
    });

    it('scores increase monotonically with liquidity depth (same LP/volume)', async () => {
      const liquidityLevels = [3000, 5000, 15000, 50000, 200000, 500000];
      const scores: number[] = [];

      for (const liq of liquidityLevels) {
        const input = createMockInput({
          liquidity: liq,
          lpBurned: true,
          lpLocked: false,
          volume24h: liq * 2, // ratio of 2.0 → healthy for all levels
        });
        const result = await scoreLiquidity(input);
        scores.push(result.score);
      }

      // Each successive score should be ≥ the previous
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
      }
    });

    it('$3.5K liquidity is in minimal tier with low depth score', async () => {
      // $3.5K: between MIN_PUMP_FUN_USD ($3K) and TIER_LOW ($5K) = minimal
      // proportion = (3500-3000)/(5000-3000) = 0.25
      // depth = 10 + round(0.25 * 10) = 10 + 3 = 13
      const input = createMockInput({
        liquidity: 3500,
        lpBurned: false,
        lpLocked: false,
        volume24h: 7000, // ratio=2.0 → healthy → +5
      });
      const result = await scoreLiquidity(input);
      // depth 13 + vol +5 + LP penalty -10 = 8
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(25);
    });

    it('$100K liquidity is in healthy tier', async () => {
      // $100K: between TIER_HIGH ($50K) and TIER_DEEP ($200K) = healthy
      // proportion = (100000-50000)/(200000-50000) = 0.333
      // depth = 60 + round(0.333 * 20) = 60 + 7 = 67
      const input = createMockInput({
        liquidity: 100000,
        volume24h: 200000, // ratio=2.0 → healthy → +5
        lpBurned: true,
      });
      const result = await scoreLiquidity(input);
      expect(result.score).toBeGreaterThanOrEqual(70);
      expect(result.score).toBeLessThanOrEqual(90);
    });
  });

  // =========================================================================
  // Phase 5: LP Burn/Lock Status Bonus/Penalty
  // =========================================================================

  describe('LP burn/lock status bonus/penalty', () => {
    it('LP burned adds bonus points compared to neither burned nor locked', async () => {
      const baseParams = {
        liquidity: 15000,
        volume24h: 30000, // ratio=2.0 → healthy → +5
      };

      const burnedResult = await scoreLiquidity(
        createMockInput({ ...baseParams, lpBurned: true, lpLocked: false }),
      );
      const neitherResult = await scoreLiquidity(
        createMockInput({ ...baseParams, lpBurned: false, lpLocked: false }),
      );

      expect(burnedResult.score).toBeGreaterThan(neitherResult.score);
    });

    it('LP locked adds smaller bonus than LP burned', async () => {
      const baseParams = {
        liquidity: 15000,
        volume24h: 30000,
      };

      const burnedResult = await scoreLiquidity(
        createMockInput({ ...baseParams, lpBurned: true, lpLocked: false }),
      );
      const lockedResult = await scoreLiquidity(
        createMockInput({ ...baseParams, lpBurned: false, lpLocked: true }),
      );

      // Burned (+10) should produce higher score than locked (+5)
      expect(burnedResult.score).toBeGreaterThan(lockedResult.score);
    });

    it('neither LP burned nor locked receives negative penalty', async () => {
      const input = createMockInput({
        liquidity: 15000,
        lpBurned: false,
        lpLocked: false,
      });
      const result = await scoreLiquidity(input);
      expect(result.metadata.lpAdjustment).toBeLessThan(0);
    });

    it('LP burned has positive lpAdjustment in metadata', async () => {
      const input = createMockInput({
        liquidity: 15000,
        lpBurned: true,
        lpLocked: false,
      });
      const result = await scoreLiquidity(input);
      expect(result.metadata.lpAdjustment).toBeGreaterThan(0);
    });

    it('LP locked has positive lpAdjustment in metadata', async () => {
      const input = createMockInput({
        liquidity: 15000,
        lpBurned: false,
        lpLocked: true,
      });
      const result = await scoreLiquidity(input);
      expect(result.metadata.lpAdjustment).toBeGreaterThan(0);
    });

    it('LP burned adjustment (+10) is exactly twice the LP locked adjustment (+5)', async () => {
      const burnedInput = createMockInput({
        liquidity: 15000,
        lpBurned: true,
        lpLocked: false,
      });
      const lockedInput = createMockInput({
        liquidity: 15000,
        lpBurned: false,
        lpLocked: true,
      });

      const burnedResult = await scoreLiquidity(burnedInput);
      const lockedResult = await scoreLiquidity(lockedInput);

      const burnedAdj = burnedResult.metadata.lpAdjustment as number;
      const lockedAdj = lockedResult.metadata.lpAdjustment as number;

      expect(burnedAdj).toBe(10);
      expect(lockedAdj).toBe(5);
      expect(burnedAdj).toBe(lockedAdj * 2);
    });

    it('LP burned takes priority over LP locked (burned=true, locked=true → burned bonus)', async () => {
      const input = createMockInput({
        liquidity: 15000,
        lpBurned: true,
        lpLocked: true,
      });
      const result = await scoreLiquidity(input);
      // When both are true, burned (+10) takes priority
      expect(result.metadata.lpAdjustment).toBe(10);
    });
  });

  // =========================================================================
  // Phase 6: Volume-to-Liquidity Ratio
  // =========================================================================

  describe('volume-to-liquidity ratio', () => {
    it('healthy ratio (0.5-5.0) adds positive adjustment', async () => {
      // ratio = 100000/50000 = 2.0 → healthy → +5
      const input = createMockInput({
        liquidity: 50000,
        volume24h: 100000,
      });
      const result = await scoreLiquidity(input);
      expect(result.metadata.volumeRatioAdjustment).toBeGreaterThan(0);
    });

    it('very low ratio (<0.1) → dead token negative adjustment', async () => {
      // ratio = 1000/50000 = 0.02 → dead → -5
      const input = createMockInput({
        liquidity: 50000,
        volume24h: 1000,
      });
      const result = await scoreLiquidity(input);
      expect(result.metadata.volumeRatioAdjustment).toBeLessThan(0);
    });

    it('suspiciously high ratio (>10) → wash trading negative adjustment', async () => {
      // ratio = 100000/5000 = 20 → suspicious → -5
      const input = createMockInput({
        liquidity: 5000,
        volume24h: 100000,
      });
      const result = await scoreLiquidity(input);
      expect(result.metadata.volumeRatioAdjustment).toBeLessThan(0);
    });

    it('borderline ratio (0.1 to 0.5) has neutral adjustment (0)', async () => {
      // ratio = 10000/50000 = 0.2 → borderline → 0
      const input = createMockInput({
        liquidity: 50000,
        volume24h: 10000,
      });
      const result = await scoreLiquidity(input);
      expect(result.metadata.volumeRatioAdjustment).toBe(0);
    });

    it('borderline ratio (5.0 to 10.0) has neutral adjustment (0)', async () => {
      // ratio = 350000/50000 = 7.0 → between healthy max (5) and suspicious (10) → 0
      const input = createMockInput({
        liquidity: 50000,
        volume24h: 350000,
      });
      const result = await scoreLiquidity(input);
      expect(result.metadata.volumeRatioAdjustment).toBe(0);
    });

    it('exact ratio of 0.5 (lower healthy bound) gets positive adjustment', async () => {
      // ratio = 25000/50000 = 0.5 → exactly at healthy min → +5
      const input = createMockInput({
        liquidity: 50000,
        volume24h: 25000,
      });
      const result = await scoreLiquidity(input);
      expect(result.metadata.volumeRatioAdjustment).toBeGreaterThan(0);
    });

    it('exact ratio of 5.0 (upper healthy bound) gets positive adjustment', async () => {
      // ratio = 250000/50000 = 5.0 → exactly at healthy max → +5
      const input = createMockInput({
        liquidity: 50000,
        volume24h: 250000,
      });
      const result = await scoreLiquidity(input);
      expect(result.metadata.volumeRatioAdjustment).toBeGreaterThan(0);
    });

    it('zero volume with valid liquidity gets penalty adjustment', async () => {
      // ratio = 0/50000 = 0.0 → below dead threshold → -5
      const input = createMockInput({
        liquidity: 50000,
        volume24h: 0,
      });
      const result = await scoreLiquidity(input);
      expect(result.metadata.volumeRatioAdjustment).toBeLessThan(0);
    });
  });

  // =========================================================================
  // Phase 7: Boundary Value Testing at $3K and $30K
  // =========================================================================

  describe('boundary value testing at $3K and $30K', () => {
    it('exact boundary at $3,000 → passes minimum (score > 0)', async () => {
      const input = createMockInput({ liquidity: 3000 });
      const result = await scoreLiquidity(input);
      expect(result.score).toBeGreaterThan(0);
    });

    it('$30K boundary → established token tier with moderate-to-high score', async () => {
      // $30K: between TIER_MID ($15K) and TIER_HIGH ($50K) → moderate tier
      // proportion = (30000-15000)/(50000-15000) ≈ 0.4286
      // depth = 40 + round(0.4286 * 20) = 40 + 9 = 49
      const input = createMockInput({
        liquidity: 30000,
        lpBurned: false,
        lpLocked: true,
        volume24h: 60000, // ratio = 2.0 → healthy → +5
      });
      const result = await scoreLiquidity(input);
      // depth 49 + vol +5 + LP locked +5 = 59
      expect(result.score).toBeGreaterThanOrEqual(40);
      expect(result.score).toBeLessThanOrEqual(70);
    });

    it('$29,999 is still in moderate tier (just below $30K established)', async () => {
      const input = createMockInput({ liquidity: 29999 });
      const result = await scoreLiquidity(input);
      expect(result.metadata.liquidityTier).toBe('moderate');
    });

    it('$30,000 is still in moderate tier (below $50K tier boundary)', async () => {
      const input = createMockInput({ liquidity: 30000 });
      const result = await scoreLiquidity(input);
      expect(result.metadata.liquidityTier).toBe('moderate');
    });

    it('$3K yields lower score than $30K', async () => {
      const lowResult = await scoreLiquidity(
        createMockInput({ liquidity: 3000, volume24h: 6000 }),
      );
      const highResult = await scoreLiquidity(
        createMockInput({ liquidity: 30000, volume24h: 60000 }),
      );
      expect(highResult.score).toBeGreaterThan(lowResult.score);
    });
  });

  // =========================================================================
  // Phase 8: Metadata Validation
  // =========================================================================

  describe('metadata validation', () => {
    it('contains all expected metadata fields for normal tokens', async () => {
      const input = createMockInput({ liquidity: 25000, volume24h: 50000 });
      const result = await scoreLiquidity(input);

      // Core metadata fields from the createResult function
      expect(result.metadata).toHaveProperty('liquidityUsd');
      expect(result.metadata).toHaveProperty('volume24h');
      expect(result.metadata).toHaveProperty('volumeToLiqRatio');
      expect(result.metadata).toHaveProperty('lpBurned');
      expect(result.metadata).toHaveProperty('lpLocked');
      expect(result.metadata).toHaveProperty('lpBurnPercent');
      expect(result.metadata).toHaveProperty('liquidityTier');
      expect(result.metadata).toHaveProperty('liquidityScore');
      expect(result.metadata).toHaveProperty('volumeRatioAdjustment');
      expect(result.metadata).toHaveProperty('lpAdjustment');
    });

    it('metadata reflects input values correctly', async () => {
      const input = createMockInput({
        liquidity: 25000,
        volume24h: 50000,
        lpBurned: true,
        lpLocked: false,
        lpBurnPercent: 95,
      });
      const result = await scoreLiquidity(input);

      expect(result.metadata.liquidityUsd).toBe(25000);
      expect(result.metadata.volume24h).toBe(50000);
      expect(result.metadata.lpBurned).toBe(true);
      expect(result.metadata.lpLocked).toBe(false);
      expect(result.metadata.lpBurnPercent).toBe(95);
    });

    it('volumeToLiqRatio is correctly computed and rounded to 2 decimal places', async () => {
      const input = createMockInput({
        liquidity: 30000,
        volume24h: 50000,
      });
      const result = await scoreLiquidity(input);
      // 50000 / 30000 = 1.6667 → rounded to 1.67
      expect(result.metadata.volumeToLiqRatio).toBe(1.67);
    });

    it('volumeToLiqRatio is 0 when liquidity is 0 or below minimum', async () => {
      const input = createMockInput({ liquidity: 0, volume24h: 50000 });
      const result = await scoreLiquidity(input);
      expect(result.metadata.volumeToLiqRatio).toBe(0);
    });

    it('liquidityTier "below-minimum" for tokens under $3K', async () => {
      const input = createMockInput({ liquidity: 2000 });
      const result = await scoreLiquidity(input);
      expect(result.metadata.liquidityTier).toBe('below-minimum');
    });

    it('liquidityTier "minimal" for tokens $3K-$5K', async () => {
      const input = createMockInput({ liquidity: 4000 });
      const result = await scoreLiquidity(input);
      expect(result.metadata.liquidityTier).toBe('minimal');
    });

    it('liquidityTier "growing" for tokens $5K-$15K', async () => {
      const input = createMockInput({ liquidity: 10000 });
      const result = await scoreLiquidity(input);
      expect(result.metadata.liquidityTier).toBe('growing');
    });

    it('liquidityTier "moderate" for tokens $15K-$50K', async () => {
      const input = createMockInput({ liquidity: 25000 });
      const result = await scoreLiquidity(input);
      expect(result.metadata.liquidityTier).toBe('moderate');
    });

    it('liquidityTier "healthy" for tokens $50K-$200K', async () => {
      const input = createMockInput({ liquidity: 100000 });
      const result = await scoreLiquidity(input);
      expect(result.metadata.liquidityTier).toBe('healthy');
    });

    it('liquidityTier "deep" for tokens above $200K', async () => {
      const input = createMockInput({ liquidity: 250000 });
      const result = await scoreLiquidity(input);
      expect(result.metadata.liquidityTier).toBe('deep');
    });

    it('meetsEstablishedLiquidity is true when liquidity >= $30K', async () => {
      const input = createMockInput({ liquidity: 30000 });
      const result = await scoreLiquidity(input);
      expect(result.metadata.meetsEstablishedLiquidity).toBe(true);
    });

    it('meetsEstablishedLiquidity is false when liquidity < $30K', async () => {
      const input = createMockInput({ liquidity: 29999 });
      const result = await scoreLiquidity(input);
      expect(result.metadata.meetsEstablishedLiquidity).toBe(false);
    });

    it('below-minimum metadata includes a reason string', async () => {
      const input = createMockInput({ liquidity: 1000 });
      const result = await scoreLiquidity(input);
      expect(result.metadata).toHaveProperty('reason');
      expect(typeof result.metadata.reason).toBe('string');
    });
  });

  // =========================================================================
  // Phase 9: Error Handling
  // =========================================================================

  describe('error handling', () => {
    it('handles unexpected errors gracefully and returns score 0', async () => {
      // Create a proxy input that throws on certain property access
      // to simulate an unexpected runtime error
      const errorInput = new Proxy(createMockInput(), {
        get(target, prop) {
          if (prop === 'liquidity') {
            throw new Error('Simulated property access error');
          }
          return Reflect.get(target, prop);
        },
      });

      const result = await scoreLiquidity(errorInput as TokenAnalysisInput);
      expect(result.score).toBe(0);
      expect(result.name).toBe('liquidity');
      expect(result.weight).toBe(0);
      expect(result.metadata).toHaveProperty('error');
    });

    it('error metadata contains the error message', async () => {
      const errorInput = new Proxy(createMockInput(), {
        get(target, prop) {
          if (prop === 'liquidity') {
            throw new Error('Test error message');
          }
          return Reflect.get(target, prop);
        },
      });

      const result = await scoreLiquidity(errorInput as TokenAnalysisInput);
      expect(result.metadata.error).toBe('Test error message');
    });

    it('error result still has valid metadata structure', async () => {
      const errorInput = new Proxy(createMockInput(), {
        get(target, prop) {
          if (prop === 'liquidity') {
            throw new Error('Structural test');
          }
          return Reflect.get(target, prop);
        },
      });

      const result = await scoreLiquidity(errorInput as TokenAnalysisInput);
      expect(result.metadata).toHaveProperty('liquidityUsd');
      expect(result.metadata).toHaveProperty('volume24h');
      expect(result.metadata).toHaveProperty('liquidityTier');
      expect(result.metadata).toHaveProperty('liquidityScore');
      expect(result.metadata).toHaveProperty('volumeRatioAdjustment');
      expect(result.metadata).toHaveProperty('lpAdjustment');
    });
  });

  // =========================================================================
  // Additional: Score Clamping
  // =========================================================================

  describe('score clamping', () => {
    it('clamps score to maximum of 100 for extremely deep liquidity', async () => {
      const input = createMockInput({
        liquidity: 10_000_000,
        lpBurned: true,
        lpLocked: true,
        volume24h: 20_000_000, // ratio=2.0 → healthy → +5
      });
      const result = await scoreLiquidity(input);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('clamps score to minimum of 0 (no negative scores)', async () => {
      const input = createMockInput({ liquidity: 0 });
      const result = await scoreLiquidity(input);
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('score with all negative adjustments stays above 0', async () => {
      // $3K has depth score ~10, with LP penalty -10 and vol penalty -5 → raw -5 → clamp 0
      const input = createMockInput({
        liquidity: 3000,
        lpBurned: false,
        lpLocked: false,
        volume24h: 0, // ratio = 0 → dead → -5
      });
      const result = await scoreLiquidity(input);
      expect(result.score).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // Additional: Combined Scenario Tests
  // =========================================================================

  describe('combined scenario tests', () => {
    it('high-quality token: $50K liq, LP burned, healthy volume → high score', async () => {
      const input = createMockInput({
        liquidity: 50000,
        volume24h: 100000, // ratio=2.0 → healthy
        lpBurned: true,
        lpLocked: false,
      });
      const result = await scoreLiquidity(input);
      // depth 60 + vol +5 + LP +10 = 75
      expect(result.score).toBeGreaterThanOrEqual(70);
    });

    it('risky token: $5K liq, no LP protection, dead volume → low score', async () => {
      const input = createMockInput({
        liquidity: 5000,
        volume24h: 100, // ratio = 0.02 → dead
        lpBurned: false,
        lpLocked: false,
      });
      const result = await scoreLiquidity(input);
      // depth 20 + vol -5 + LP -10 = 5
      expect(result.score).toBeLessThanOrEqual(15);
    });

    it('wash-traded token: $10K liq, LP locked, suspicious volume → moderate with penalty', async () => {
      const input = createMockInput({
        liquidity: 10000,
        volume24h: 200000, // ratio = 20 → suspicious
        lpBurned: false,
        lpLocked: true,
      });
      const result = await scoreLiquidity(input);
      // depth: proportion = (10000-5000)/(15000-5000) = 0.5
      //        score = 20 + round(0.5 * 20) = 30
      // vol -5 + LP +5 = 30
      expect(result.score).toBeLessThanOrEqual(40);
    });
  });
});
