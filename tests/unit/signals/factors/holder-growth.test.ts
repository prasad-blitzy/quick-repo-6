/**
 * tests/unit/signals/factors/holder-growth.test.ts
 *
 * Comprehensive unit tests for the holder growth factor module.
 *
 * Validates all scoring behaviors of `scoreHolderGrowth`:
 * - FactorResult structure (name='holderGrowth', weight=0, score 0-100 integer)
 * - Holder count tier scoring (10→50→200→500→1000+ progressive tiers)
 * - Concentration adjustment (+10 bonus for ≤10%, 0 for 10-20%, -15 for 20-50%, -25 for >50%)
 * - Smart money bonus (+10 when ≥2 qualified wallets)
 * - Distribution quality mapping (excellent / acceptable / poor)
 * - Organic growth rewarding vs bot-like pattern penalization
 * - Metadata field completeness
 * - Error handling (score 0 with error metadata on failure)
 *
 * @module tests/unit/signals/factors/holder-growth
 */

import { vi } from 'vitest';
import type { TokenAnalysisInput, FactorResult } from '../../../../src/signals/types';

// ---------------------------------------------------------------------------
// Module Mocks — must be hoisted before imports of the module under test
// ---------------------------------------------------------------------------

vi.mock('../../../../src/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../../src/utils/config', () => ({}));

// ---------------------------------------------------------------------------
// Import Module Under Test (after mocks are registered)
// ---------------------------------------------------------------------------

import { scoreHolderGrowth } from '../../../../src/signals/factors/holder-growth';

// ---------------------------------------------------------------------------
// Test Data Factory
// ---------------------------------------------------------------------------

/**
 * Creates a fully-typed TokenAnalysisInput with sensible defaults.
 * Override any field via the `overrides` parameter for targeted test scenarios.
 *
 * Defaults:
 * - holderCount: 200 (mid-tier)
 * - topHolderPercent: 15 (acceptable distribution)
 * - smartMoneyCount: 2 (at bonus threshold)
 */
function createMockInput(
  overrides: Partial<TokenAnalysisInput> = {},
): TokenAnalysisInput {
  return {
    // Identity
    mint: 'So11111111111111111111111111111111111111112',
    symbol: 'TEST',
    name: 'Test Token',

    // Price data
    price: 0.001,
    priceChange5m: 5,
    priceChange1h: 10,
    priceChange24h: 20,

    // Market data
    marketCap: 100_000,
    volume5m: 500,
    volume1h: 5_000,
    volume24h: 50_000,
    liquidity: 30_000,
    supply: 1_000_000_000,

    // Trading activity
    buys1h: 100,
    sells1h: 50,
    buys24h: 1_000,
    sells24h: 500,

    // Holder data — primary fields tested by this suite
    holderCount: 200,
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

    // Token age
    createdAt: Math.floor(Date.now() / 1000) - 3600,

    // Apply overrides last so they take precedence
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('scoreHolderGrowth', () => {
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
    it('returns a result with name "holderGrowth"', async () => {
      const input = createMockInput();
      const result = await scoreHolderGrowth(input);

      expect(result.name).toBe('holderGrowth');
    });

    it('returns weight of 0 (weights applied externally by scoring engine)', async () => {
      const input = createMockInput();
      const result = await scoreHolderGrowth(input);

      expect(result.weight).toBe(0);
    });

    it('returns a result with score and metadata fields', async () => {
      const input = createMockInput();
      const result = await scoreHolderGrowth(input);

      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('metadata');
      expect(typeof result.score).toBe('number');
      expect(typeof result.metadata).toBe('object');
    });

    it('score is always an integer between 0 and 100', async () => {
      const testCases: Partial<TokenAnalysisInput>[] = [
        { holderCount: 0 },
        { holderCount: 5 },
        { holderCount: 30, topHolderPercent: 8 },
        { holderCount: 100, topHolderPercent: 15 },
        { holderCount: 500, topHolderPercent: 5, smartMoneyCount: 3 },
        { holderCount: 2000, topHolderPercent: 3 },
        { holderCount: 100_000, topHolderPercent: 1 },
        { holderCount: 200, topHolderPercent: 55 },
        { holderCount: 10, topHolderPercent: 90 },
      ];

      for (const overrides of testCases) {
        const input = createMockInput(overrides);
        const result = await scoreHolderGrowth(input);

        expect(Number.isInteger(result.score)).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
      }
    });
  });

  // =========================================================================
  // Phase 3: Organic Growth (high holders + low concentration → rewarded)
  // =========================================================================

  describe('organic growth rewarding', () => {
    it('500 holders with 5% top holder concentration and 3 smart money → score ≥80', async () => {
      // 500 holders → tier 500-1000, holderCountScore = 70
      // topHolderPercent=5 → +10 bonus (excellent)
      // smartMoneyCount=3 → +10 bonus
      // Expected rawScore = 70 + 10 + 10 = 90
      const input = createMockInput({
        holderCount: 500,
        topHolderPercent: 5,
        smartMoneyCount: 3,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.score).toBeGreaterThanOrEqual(80);
      expect(result.metadata.distributionQuality).toBe('excellent');
    });

    it('100 holders with 8% top holder concentration → score ≥35', async () => {
      // 100 holders → tier 50-200, progress=(100-50)/(200-50)=0.333, score=25+8=33
      // topHolderPercent=8 → +10 bonus (excellent)
      // smartMoneyCount=2 → +10 bonus
      // Expected rawScore = 33 + 10 + 10 = 53
      const input = createMockInput({
        holderCount: 100,
        topHolderPercent: 8,
        smartMoneyCount: 2,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.score).toBeGreaterThanOrEqual(35);
      expect(result.metadata.distributionQuality).toBe('excellent');
    });

    it('200 holders with 12% concentration → score in range 40-65', async () => {
      // 200 holders → tier 200-500 boundary, holderCountScore = 50
      // topHolderPercent=12 → 0 adjustment (acceptable)
      // smartMoneyCount=2 → +10 bonus
      // Expected rawScore = 50 + 0 + 10 = 60
      const input = createMockInput({
        holderCount: 200,
        topHolderPercent: 12,
        smartMoneyCount: 2,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.score).toBeGreaterThanOrEqual(40);
      expect(result.score).toBeLessThanOrEqual(65);
    });
  });

  // =========================================================================
  // Phase 4: Bot-Like Patterns (high concentration → penalized)
  // =========================================================================

  describe('bot-like pattern penalization', () => {
    it('200 holders with 55% top holder concentration → penalized, concentrationAdjustment negative', async () => {
      // 200 holders → holderCountScore = 50
      // topHolderPercent=55 → -25 severe penalty
      // smartMoneyCount=2 → +10 bonus
      // Expected rawScore = 50 - 25 + 10 = 35
      const input = createMockInput({
        holderCount: 200,
        topHolderPercent: 55,
        smartMoneyCount: 2,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.metadata.concentrationAdjustment).toBeLessThan(0);
      expect(result.score).toBeLessThan(50);
    });

    it('high concentration (>20%) receives penalty — lower score than same holders with 10%', async () => {
      const lowConcentration = createMockInput({
        holderCount: 300,
        topHolderPercent: 10,
        smartMoneyCount: 0,
      });
      const highConcentration = createMockInput({
        holderCount: 300,
        topHolderPercent: 35,
        smartMoneyCount: 0,
      });

      const lowResult = await scoreHolderGrowth(lowConcentration);
      const highResult = await scoreHolderGrowth(highConcentration);

      expect(lowResult.score).toBeGreaterThan(highResult.score);
    });

    it('very high concentration (>50%) receives severe penalty — significant score difference vs 10%', async () => {
      const lowConcentration = createMockInput({
        holderCount: 150,
        topHolderPercent: 10,
        smartMoneyCount: 0,
      });
      const severeConcentration = createMockInput({
        holderCount: 150,
        topHolderPercent: 60,
        smartMoneyCount: 0,
      });

      const lowResult = await scoreHolderGrowth(lowConcentration);
      const severeResult = await scoreHolderGrowth(severeConcentration);

      // Expect a significant gap: excellent (+10) vs severe (-25) = 35-point swing
      const scoreDifference = lowResult.score - severeResult.score;
      expect(scoreDifference).toBeGreaterThanOrEqual(20);
    });

    it('concentration penalty at boundary 20% triggers the -15 penalty', async () => {
      const atBoundary = createMockInput({
        holderCount: 300,
        topHolderPercent: 20,
        smartMoneyCount: 0,
      });
      const justAbove = createMockInput({
        holderCount: 300,
        topHolderPercent: 21,
        smartMoneyCount: 0,
      });

      const atBoundaryResult = await scoreHolderGrowth(atBoundary);
      const justAboveResult = await scoreHolderGrowth(justAbove);

      // At 20%: acceptable (0 adj), at 21%: poor (-15 adj)
      expect(atBoundaryResult.score).toBeGreaterThan(justAboveResult.score);
    });
  });

  // =========================================================================
  // Phase 5: Minimum Holder Count
  // =========================================================================

  describe('minimum holder count', () => {
    it('token with 5 holders → very low score (5)', async () => {
      // Below MIN_HOLDERS (10) → returns fixed score of 5
      const input = createMockInput({ holderCount: 5 });
      const result = await scoreHolderGrowth(input);

      expect(result.score).toBe(5);
      expect(result.metadata.holderCountScore).toBe(0);
    });

    it('token with 0 holders → score ≤5', async () => {
      const input = createMockInput({ holderCount: 0 });
      const result = await scoreHolderGrowth(input);

      expect(result.score).toBeLessThanOrEqual(5);
    });

    it('token with 9 holders → still below threshold, score 5', async () => {
      const input = createMockInput({ holderCount: 9 });
      const result = await scoreHolderGrowth(input);

      expect(result.score).toBe(5);
    });

    it('token with exactly 10 holders → above threshold, enters tier scoring', async () => {
      const input = createMockInput({
        holderCount: 10,
        topHolderPercent: 15,
        smartMoneyCount: 0,
      });
      const result = await scoreHolderGrowth(input);

      // 10 holders is the start of the 10-50 tier: progress = 0, score = 10
      // concentration = 0, smart money = 0 → rawScore = 10
      expect(result.score).toBeGreaterThanOrEqual(10);
    });
  });

  // =========================================================================
  // Phase 6: Smart Money Bonus
  // =========================================================================

  describe('smart money bonus', () => {
    it('smart money count ≥2 adds bonus points', async () => {
      const withoutSmartMoney = createMockInput({
        holderCount: 200,
        topHolderPercent: 15,
        smartMoneyCount: 0,
      });
      const withSmartMoney = createMockInput({
        holderCount: 200,
        topHolderPercent: 15,
        smartMoneyCount: 3,
      });

      const withoutResult = await scoreHolderGrowth(withoutSmartMoney);
      const withResult = await scoreHolderGrowth(withSmartMoney);

      expect(withResult.score).toBeGreaterThan(withoutResult.score);
      expect(withResult.metadata.smartMoneyBonus).toBe(10);
      expect(withoutResult.metadata.smartMoneyBonus).toBe(0);
    });

    it('smart money count of exactly 2 triggers the bonus', async () => {
      const input = createMockInput({
        holderCount: 200,
        topHolderPercent: 15,
        smartMoneyCount: 2,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.metadata.smartMoneyBonus).toBe(10);
    });

    it('smart money count <2 does not add bonus', async () => {
      const input = createMockInput({
        holderCount: 200,
        topHolderPercent: 15,
        smartMoneyCount: 1,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.metadata.smartMoneyBonus).toBe(0);
    });

    it('smart money count of 0 receives no bonus', async () => {
      const input = createMockInput({
        holderCount: 200,
        topHolderPercent: 15,
        smartMoneyCount: 0,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.metadata.smartMoneyBonus).toBe(0);
    });
  });

  // =========================================================================
  // Phase 7: Holder Concentration Distribution Quality
  // =========================================================================

  describe('distribution quality mapping', () => {
    it('topHolderPercent ≤10% → "excellent" distributionQuality', async () => {
      const input = createMockInput({ topHolderPercent: 8, holderCount: 100 });
      const result = await scoreHolderGrowth(input);

      expect(result.metadata.distributionQuality).toBe('excellent');
    });

    it('topHolderPercent exactly 10% → "excellent" distributionQuality', async () => {
      const input = createMockInput({ topHolderPercent: 10, holderCount: 100 });
      const result = await scoreHolderGrowth(input);

      expect(result.metadata.distributionQuality).toBe('excellent');
    });

    it('topHolderPercent 11-20% → "acceptable" distributionQuality', async () => {
      const input = createMockInput({ topHolderPercent: 15, holderCount: 100 });
      const result = await scoreHolderGrowth(input);

      expect(result.metadata.distributionQuality).toBe('acceptable');
    });

    it('topHolderPercent exactly 20% → "acceptable" distributionQuality', async () => {
      const input = createMockInput({ topHolderPercent: 20, holderCount: 100 });
      const result = await scoreHolderGrowth(input);

      expect(result.metadata.distributionQuality).toBe('acceptable');
    });

    it('topHolderPercent >20% → "poor" distributionQuality', async () => {
      const input = createMockInput({ topHolderPercent: 25, holderCount: 100 });
      const result = await scoreHolderGrowth(input);

      expect(result.metadata.distributionQuality).toBe('poor');
    });

    it('topHolderPercent >50% → "poor" distributionQuality (extreme concentration)', async () => {
      const input = createMockInput({ topHolderPercent: 60, holderCount: 100 });
      const result = await scoreHolderGrowth(input);

      expect(result.metadata.distributionQuality).toBe('poor');
    });
  });

  // =========================================================================
  // Phase 8: Holder Count Tiers
  // =========================================================================

  describe('holder count tiers', () => {
    it('30 holders → early stage score (range 10-25)', async () => {
      // Tier 10-50: progress=(30-10)/(50-10)=0.5, holderCountScore=10+8=18
      // Use neutral concentration (15%) and no smart money for tier isolation
      const input = createMockInput({
        holderCount: 30,
        topHolderPercent: 15,
        smartMoneyCount: 0,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.score).toBeGreaterThanOrEqual(10);
      expect(result.score).toBeLessThanOrEqual(25);
    });

    it('150 holders → growing stage score (range 25-50)', async () => {
      // Tier 50-200: progress=(150-50)/(200-50)=0.667, holderCountScore=25+17=42
      // Neutral concentration (15%) and no smart money for tier isolation
      const input = createMockInput({
        holderCount: 150,
        topHolderPercent: 15,
        smartMoneyCount: 0,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.score).toBeGreaterThanOrEqual(25);
      expect(result.score).toBeLessThanOrEqual(50);
    });

    it('800 holders → strong stage score ≥70', async () => {
      // Tier 500-1000: progress=(800-500)/500=0.6, holderCountScore=70+9=79
      // Excellent concentration (8%) for +10 bonus = 89
      // With smartMoneyCount=2 → +10 = 99 → capped at 99 ≥ 70 ✓
      const input = createMockInput({
        holderCount: 800,
        topHolderPercent: 8,
        smartMoneyCount: 2,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.score).toBeGreaterThanOrEqual(70);
    });

    it('2000+ holders → high score ≥85 (with diminishing returns)', async () => {
      // 1000+ tier: holderCountScore = min(95, 85 + round(log10(2000/1000) * 10))
      //           = min(95, 85 + round(0.301 * 10)) = min(95, 88) = 88
      // topHolderPercent=5 → +10 bonus, smartMoney=2 → +10 = 108 → clamped 100
      const input = createMockInput({
        holderCount: 2000,
        topHolderPercent: 5,
        smartMoneyCount: 2,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.score).toBeGreaterThanOrEqual(85);
    });

    it('50 holders → boundary between tier 1 and tier 2 (score ~25)', async () => {
      // At 50: enters 50-200 tier, progress=0, holderCountScore=25
      const input = createMockInput({
        holderCount: 50,
        topHolderPercent: 15,
        smartMoneyCount: 0,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.score).toBeGreaterThanOrEqual(20);
      expect(result.score).toBeLessThanOrEqual(30);
    });

    it('1000 holders → boundary entering tier 5 (score ~85)', async () => {
      // At 1000: enters 1000+ tier, holderCountScore = min(95, 85 + round(log10(1) * 10)) = 85
      const input = createMockInput({
        holderCount: 1000,
        topHolderPercent: 15,
        smartMoneyCount: 0,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.score).toBeGreaterThanOrEqual(80);
      expect(result.score).toBeLessThanOrEqual(95);
    });

    it('increasing holders monotonically increases base score', async () => {
      const holderCounts = [15, 75, 300, 750, 5000];
      const scores: number[] = [];

      for (const holderCount of holderCounts) {
        const input = createMockInput({
          holderCount,
          topHolderPercent: 15,
          smartMoneyCount: 0,
        });
        const result = await scoreHolderGrowth(input);
        scores.push(result.score);
      }

      // Each score should be >= the previous one
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
      }
    });
  });

  // =========================================================================
  // Phase 9: Metadata Validation
  // =========================================================================

  describe('metadata validation', () => {
    it('metadata contains all expected fields for normal input', async () => {
      const input = createMockInput({
        holderCount: 300,
        topHolderPercent: 12,
        smartMoneyCount: 3,
      });
      const result = await scoreHolderGrowth(input);

      // All required metadata fields
      expect(result.metadata).toHaveProperty('holderCount');
      expect(result.metadata).toHaveProperty('topHolderPercent');
      expect(result.metadata).toHaveProperty('smartMoneyCount');
      expect(result.metadata).toHaveProperty('holderCountScore');
      expect(result.metadata).toHaveProperty('concentrationAdjustment');
      expect(result.metadata).toHaveProperty('smartMoneyBonus');
      expect(result.metadata).toHaveProperty('distributionQuality');
    });

    it('metadata reflects the input values correctly', async () => {
      const input = createMockInput({
        holderCount: 400,
        topHolderPercent: 7,
        smartMoneyCount: 5,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.metadata.holderCount).toBe(400);
      expect(result.metadata.topHolderPercent).toBe(7);
      expect(result.metadata.smartMoneyCount).toBe(5);
    });

    it('metadata holderCountScore reflects tier calculation', async () => {
      // 200 holders → tier 200-500 boundary, holderCountScore should be 50
      const input = createMockInput({
        holderCount: 200,
        topHolderPercent: 15,
        smartMoneyCount: 0,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.metadata.holderCountScore).toBe(50);
    });

    it('metadata concentrationAdjustment reflects concentration band', async () => {
      // ≤10% → +10
      const excellentInput = createMockInput({ topHolderPercent: 5, holderCount: 100 });
      const excellentResult = await scoreHolderGrowth(excellentInput);
      expect(excellentResult.metadata.concentrationAdjustment).toBe(10);

      // 10-20% → 0
      const acceptableInput = createMockInput({ topHolderPercent: 15, holderCount: 100 });
      const acceptableResult = await scoreHolderGrowth(acceptableInput);
      expect(acceptableResult.metadata.concentrationAdjustment).toBe(0);

      // 20-50% → -15
      const poorInput = createMockInput({ topHolderPercent: 35, holderCount: 100 });
      const poorResult = await scoreHolderGrowth(poorInput);
      expect(poorResult.metadata.concentrationAdjustment).toBe(-15);

      // >50% → -25
      const severeInput = createMockInput({ topHolderPercent: 60, holderCount: 100 });
      const severeResult = await scoreHolderGrowth(severeInput);
      expect(severeResult.metadata.concentrationAdjustment).toBe(-25);
    });

    it('metadata for below-minimum holders includes special fields', async () => {
      const input = createMockInput({ holderCount: 3 });
      const result = await scoreHolderGrowth(input);

      expect(result.metadata.reason).toBe('Very few holders');
      expect(result.metadata.holderCountScore).toBe(0);
      expect(result.metadata.concentrationAdjustment).toBe(0);
      expect(result.metadata.smartMoneyBonus).toBe(0);
      expect(result.metadata.distributionQuality).toBe('insufficient');
    });
  });

  // =========================================================================
  // Phase 10: Error Handling
  // =========================================================================

  describe('error handling', () => {
    it('returns score 0 with error metadata when scoring logic throws an Error', async () => {
      // Use a counter-based getter: throws on 1st access (in scoring logic),
      // returns a normal value on subsequent accesses (in catch's createResult).
      const errorInput = createMockInput();
      let holderAccessCount = 0;
      Object.defineProperty(errorInput, 'holderCount', {
        get() {
          holderAccessCount++;
          if (holderAccessCount === 1) {
            throw new Error('Test property access error');
          }
          return 200;
        },
        configurable: true,
      });

      const result = await scoreHolderGrowth(errorInput);

      expect(result.name).toBe('holderGrowth');
      expect(result.score).toBe(0);
      expect(result.weight).toBe(0);
      expect(result.metadata.error).toBe('Test property access error');
      expect(result.metadata.distributionQuality).toBe('error');
      expect(result.metadata.holderCountScore).toBe(0);
      expect(result.metadata.concentrationAdjustment).toBe(0);
      expect(result.metadata.smartMoneyBonus).toBe(0);
    });

    it('returns score 0 with stringified error for non-Error throws', async () => {
      // Throws a non-Error value when topHolderPercent is first accessed
      // (during concentration adjustment step), returns normally on 2nd access
      // (during catch block's createResult metadata construction).
      const errorInput = createMockInput();
      let topHolderAccessCount = 0;
      Object.defineProperty(errorInput, 'topHolderPercent', {
        get() {
          topHolderAccessCount++;
          if (topHolderAccessCount === 1) {
            throw 'string error thrown';
          }
          return 15;
        },
        configurable: true,
      });

      const result = await scoreHolderGrowth(errorInput);

      expect(result.name).toBe('holderGrowth');
      expect(result.score).toBe(0);
      expect(result.weight).toBe(0);
      expect(result.metadata.distributionQuality).toBe('error');
    });
  });

  // =========================================================================
  // Additional Edge Cases: Score Clamping
  // =========================================================================

  describe('score clamping', () => {
    it('clamps score to maximum of 100 for extremely high input combination', async () => {
      const input = createMockInput({
        holderCount: 100_000,
        topHolderPercent: 1,
        smartMoneyCount: 10,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('clamps score to minimum of 0 for extremely penalized input', async () => {
      // 10 holders (just above threshold) → low holderCountScore=10
      // topHolderPercent=80 → -25 severe penalty
      // smartMoneyCount=0 → no bonus
      // rawScore = 10 - 25 + 0 = -15 → clamped to 0
      const input = createMockInput({
        holderCount: 10,
        topHolderPercent: 80,
        smartMoneyCount: 0,
      });
      const result = await scoreHolderGrowth(input);

      expect(result.score).toBeGreaterThanOrEqual(0);
    });
  });
});
