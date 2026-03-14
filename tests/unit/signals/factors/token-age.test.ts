/**
 * tests/unit/signals/factors/token-age.test.ts — Unit Tests for Token Age Factor
 *
 * Comprehensive test suite for the scoreTokenAge function that evaluates tokens
 * using a three-tier linear-decay scoring system:
 *
 * | Tier               | Age Range   | Score Range | Description                    |
 * |--------------------|-------------|-------------|--------------------------------|
 * | Early Accumulation | 0–3 hours   | 100–75      | Highest score, primary alpha   |
 * | Gem Scanning       | 3–12 hours  | 75–40       | Moderate, still viable         |
 * | Aged               | 12–24 hours | 40–10       | Diminished upside potential    |
 * | Stale              | 24–72 hours | 10–0        | Very low signal value          |
 * | Expired            | >72 hours   | 0           | No signal value                |
 *
 * Uses vi.useFakeTimers() with vi.setSystemTime() for deterministic timestamp-based
 * testing so that all assertions are independent of the real wall clock.
 *
 * Covers: tier boundary transitions (30m, 1h, 2h, 3h, 6h, 11h, 12h, 18h, 48h, 96h),
 * edge cases (zero-age, future timestamps, createdAt=0, negative timestamps),
 * monotonic score decay, FactorResult structure correctness, metadata fields, and
 * error handling.
 */

import { scoreTokenAge } from '../../../../src/signals/factors/token-age';
import type { TokenAnalysisInput, FactorResult } from '../../../../src/signals/types';

// ---------------------------------------------------------------------------
// Module Mocks — prevent real side effects and provide deterministic config
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
  TOKEN_AGE: {
    EARLY_ACCUMULATION_MAX_MS: 3 * 60 * 60 * 1000, // 10,800,000 ms = 3 hours
    GEM_SCANNING_MAX_MS: 12 * 60 * 60 * 1000,      // 43,200,000 ms = 12 hours
  },
}));

// ---------------------------------------------------------------------------
// Deterministic Time Constants
// ---------------------------------------------------------------------------

/**
 * Fixed reference point for all timestamp-based tests.
 * Chosen to be a clean UTC boundary so that FIXED_NOW_MS is exactly
 * divisible by 1000 — which means FIXED_NOW_SEC * 1000 === FIXED_NOW_MS,
 * giving perfectly clean ageMs calculations.
 */
const FIXED_TIME = new Date('2026-03-13T12:00:00Z');
const FIXED_NOW_MS = FIXED_TIME.getTime();
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);

/** One hour expressed in seconds, matching Unix timestamp granularity */
const HOUR_S = 3600;

// ---------------------------------------------------------------------------
// Test Data Factory
// ---------------------------------------------------------------------------

/**
 * Creates a fully populated TokenAnalysisInput with sensible defaults.
 * The default `createdAt` places the token 1 hour in the past (early accumulation tier).
 * Override any field via the `overrides` parameter.
 */
function createMockInput(
  overrides: Partial<TokenAnalysisInput> = {},
): TokenAnalysisInput {
  return {
    mint: 'TestMint111111111111111111111111111111111111',
    symbol: 'TEST',
    name: 'Test Token',
    price: 0.001,
    priceChange5m: 5,
    priceChange1h: 10,
    priceChange24h: 20,
    marketCap: 100_000,
    volume5m: 500,
    volume1h: 5_000,
    volume24h: 50_000,
    liquidity: 30_000,
    supply: 1_000_000_000,
    buys1h: 100,
    sells1h: 50,
    buys24h: 1_000,
    sells24h: 500,
    holderCount: 500,
    topHolderPercent: 15,
    smartMoneyCount: 2,
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    lpBurned: true,
    lpLocked: false,
    lpBurnPercent: 95,
    isHoneypot: false,
    safetyScore: 500,
    metadataMutable: false,
    devWalletAddress: 'DevWallet111111111111111111111111111111111',
    devWalletSold: false,
    createdAt: FIXED_NOW_SEC - HOUR_S, // 1 hour ago (early accumulation)
    ...overrides,
  };
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe('scoreTokenAge', () => {
  // -------------------------------------------------------------------------
  // Lifecycle — deterministic timers for every test
  // -------------------------------------------------------------------------

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TIME);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // FactorResult Structure
  // =========================================================================

  describe('FactorResult structure', () => {
    it('returns a FactorResult with name "tokenAge"', async () => {
      const input = createMockInput();
      const result: FactorResult = await scoreTokenAge(input);

      expect(result.name).toBe('tokenAge');
    });

    it('returns weight of 0 (weights applied externally by scoring-engine)', async () => {
      const input = createMockInput();
      const result = await scoreTokenAge(input);

      expect(result.weight).toBe(0);
    });

    it('includes score and metadata fields', async () => {
      const input = createMockInput();
      const result = await scoreTokenAge(input);

      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('metadata');
    });

    it('score is always an integer between 0 and 100 across all tiers', async () => {
      const hoursToTest = [0, 0.5, 1, 2, 3, 6, 11, 12, 18, 24, 48, 96];

      for (const h of hoursToTest) {
        const input = createMockInput({
          createdAt: FIXED_NOW_SEC - h * HOUR_S,
        });
        const result = await scoreTokenAge(input);

        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
        expect(Number.isInteger(result.score)).toBe(true);
      }
    });
  });

  // =========================================================================
  // ≤3 Hours — Early Accumulation Mode (Highest Score: 75–100)
  // =========================================================================

  describe('≤3 hours: early accumulation mode', () => {
    it('token created 30 minutes ago → score ≥ 90', async () => {
      // 30 min = 0.5h. progress = 0.5/3 ≈ 0.167. score = 100 - round(0.167*25) = 96
      const input = createMockInput({
        createdAt: FIXED_NOW_SEC - 0.5 * HOUR_S,
      });
      const result = await scoreTokenAge(input);

      expect(result.score).toBeGreaterThanOrEqual(90);
      expect(result.metadata.ageTier).toBe('early-accumulation');
      expect(result.metadata.isEarlyAccumulation).toBe(true);
    });

    it('token created 1 hour ago → score ≥ 80', async () => {
      // 1h. progress = 1/3 ≈ 0.333. score = 100 - round(0.333*25) = 92
      const input = createMockInput({
        createdAt: FIXED_NOW_SEC - HOUR_S,
      });
      const result = await scoreTokenAge(input);

      expect(result.score).toBeGreaterThanOrEqual(80);
      expect(result.metadata.ageTier).toBe('early-accumulation');
      expect(result.metadata.isEarlyAccumulation).toBe(true);
    });

    it('token created 2 hours ago → score ≥ 75', async () => {
      // 2h. progress = 2/3 ≈ 0.667. score = 100 - round(0.667*25) = 83
      const input = createMockInput({
        createdAt: FIXED_NOW_SEC - 2 * HOUR_S,
      });
      const result = await scoreTokenAge(input);

      expect(result.score).toBeGreaterThanOrEqual(75);
      expect(result.metadata.ageTier).toBe('early-accumulation');
    });

    it('token created exactly 3 hours ago → boundary case, score ≥ 75 and isEarlyAccumulation', async () => {
      // 3h = boundary. progress = 1.0. score = 100 - round(1.0*25) = 75
      const input = createMockInput({
        createdAt: FIXED_NOW_SEC - 3 * HOUR_S,
      });
      const result = await scoreTokenAge(input);

      expect(result.score).toBeGreaterThanOrEqual(75);
      expect(result.metadata.isEarlyAccumulation).toBe(true);
      expect(result.metadata.ageTier).toBe('early-accumulation');
    });
  });

  // =========================================================================
  // ≤12 Hours — Gem Scanning Mode (Moderate Score: 40–75)
  // =========================================================================

  describe('≤12 hours: gem scanning mode', () => {
    it('token created 6 hours ago → score in range 45–65', async () => {
      // 6h. gem progress = (6-3)/(12-3) = 1/3. score = 75 - round(0.333*35) = 63
      const input = createMockInput({
        createdAt: FIXED_NOW_SEC - 6 * HOUR_S,
      });
      const result = await scoreTokenAge(input);

      expect(result.score).toBeGreaterThanOrEqual(45);
      expect(result.score).toBeLessThanOrEqual(65);
      expect(result.metadata.ageTier).toBe('gem-scanning');
      expect(result.metadata.isGemScanning).toBe(true);
      expect(result.metadata.isEarlyAccumulation).toBe(false);
    });

    it('token created 11 hours ago → score in range 35–50 (near end of gem scanning)', async () => {
      // 11h. gem progress = (11-3)/(12-3) = 8/9 ≈ 0.889. score = 75 - round(0.889*35) = 44
      const input = createMockInput({
        createdAt: FIXED_NOW_SEC - 11 * HOUR_S,
      });
      const result = await scoreTokenAge(input);

      expect(result.score).toBeGreaterThanOrEqual(35);
      expect(result.score).toBeLessThanOrEqual(50);
      expect(result.metadata.ageTier).toBe('gem-scanning');
    });

    it('token created exactly 12 hours ago → boundary case at lower end of gem scanning', async () => {
      // 12h = boundary. gem progress = 1.0. score = 75 - round(1.0*35) = 40
      const input = createMockInput({
        createdAt: FIXED_NOW_SEC - 12 * HOUR_S,
      });
      const result = await scoreTokenAge(input);

      expect(result.score).toBe(40);
      expect(result.metadata.isGemScanning).toBe(true);
      expect(result.metadata.ageTier).toBe('gem-scanning');
    });
  });

  // =========================================================================
  // >12 Hours — Diminished Score (0–40)
  // =========================================================================

  describe('>12 hours: diminished score', () => {
    it('token created 18 hours ago → score in range 10–30 (aged tier)', async () => {
      // 18h. aged progress = (18-12)/(24-12) = 0.5. score = 40 - round(0.5*30) = 25
      const input = createMockInput({
        createdAt: FIXED_NOW_SEC - 18 * HOUR_S,
      });
      const result = await scoreTokenAge(input);

      expect(result.score).toBeGreaterThanOrEqual(10);
      expect(result.score).toBeLessThanOrEqual(30);
      expect(result.metadata.ageTier).toBe('aged');
      expect(result.metadata.isEarlyAccumulation).toBe(false);
      expect(result.metadata.isGemScanning).toBe(false);
    });

    it('token created 48 hours ago → score ≤ 10 (stale)', async () => {
      // 48h. stale progress = (48-24)/(72-24) = 0.5. score = 10 - round(0.5*10) = 5
      const input = createMockInput({
        createdAt: FIXED_NOW_SEC - 48 * HOUR_S,
      });
      const result = await scoreTokenAge(input);

      expect(result.score).toBeLessThanOrEqual(10);
      expect(result.metadata.isEarlyAccumulation).toBe(false);
      expect(result.metadata.isGemScanning).toBe(false);
    });

    it('token created 96 hours ago → score === 0 (expired, beyond 72h stale boundary)', async () => {
      // 96h > 72h → expired tier, score = 0
      const input = createMockInput({
        createdAt: FIXED_NOW_SEC - 96 * HOUR_S,
      });
      const result = await scoreTokenAge(input);

      expect(result.score).toBe(0);
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================

  describe('edge cases', () => {
    it('zero-age (just created) token → maximum score of 100', async () => {
      // createdAt = exactly now. ageMs = 0, progress = 0, score = 100
      const input = createMockInput({ createdAt: FIXED_NOW_SEC });
      const result = await scoreTokenAge(input);

      expect(result.score).toBe(100);
      expect(result.metadata.isEarlyAccumulation).toBe(true);
      expect(result.metadata.ageTier).toBe('early-accumulation');
    });

    it('future timestamp → score 0 (invalid, clock skew / corrupted data)', async () => {
      // 10 hours in the future → negative ageMs → error result
      const input = createMockInput({
        createdAt: FIXED_NOW_SEC + 10 * HOUR_S,
      });
      const result = await scoreTokenAge(input);

      expect(result.score).toBe(0);
      expect(result.metadata).toHaveProperty('reason');
      expect(typeof result.metadata.reason).toBe('string');
    });

    it('createdAt = 0 → score 0 (invalid epoch timestamp)', async () => {
      const input = createMockInput({ createdAt: 0 });
      const result = await scoreTokenAge(input);

      expect(result.score).toBe(0);
      expect(result.metadata.ageTier).toBe('invalid');
    });

    it('negative createdAt → score 0 (invalid timestamp)', async () => {
      const input = createMockInput({ createdAt: -1000 });
      const result = await scoreTokenAge(input);

      expect(result.score).toBe(0);
      expect(result.metadata.ageTier).toBe('invalid');
    });
  });

  // =========================================================================
  // Score Decay Verification — monotonic decrease across all tiers
  // =========================================================================

  describe('score decay', () => {
    it('score decreases monotonically as token age increases', async () => {
      const ages = [1, 3, 6, 12, 18, 24, 48];
      const scores: number[] = [];

      for (const ageHours of ages) {
        const input = createMockInput({
          createdAt: FIXED_NOW_SEC - ageHours * HOUR_S,
        });
        const result = await scoreTokenAge(input);
        scores.push(result.score);
      }

      // Verify each subsequent score is less than or equal to the previous
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
      }
    });

    it('scores at tier boundaries form a continuous non-increasing sequence', async () => {
      // Test the exact tier boundaries: 3h, 12h, 24h, 72h
      const boundaryAges = [3, 12, 24, 72];
      const boundaryScores: number[] = [];

      for (const ageHours of boundaryAges) {
        const input = createMockInput({
          createdAt: FIXED_NOW_SEC - ageHours * HOUR_S,
        });
        const result = await scoreTokenAge(input);
        boundaryScores.push(result.score);
      }

      // 3h=75, 12h=40, 24h=10, 72h=0
      for (let i = 1; i < boundaryScores.length; i++) {
        expect(boundaryScores[i]).toBeLessThanOrEqual(boundaryScores[i - 1]);
      }
    });
  });

  // =========================================================================
  // Metadata Validation
  // =========================================================================

  describe('metadata', () => {
    it('contains all expected fields for a valid token', async () => {
      const input = createMockInput({
        createdAt: FIXED_NOW_SEC - HOUR_S,
      });
      const result = await scoreTokenAge(input);

      expect(result.metadata).toHaveProperty('ageMs');
      expect(result.metadata).toHaveProperty('ageHours');
      expect(result.metadata).toHaveProperty('ageTier');
      expect(result.metadata).toHaveProperty('isEarlyAccumulation');
      expect(result.metadata).toHaveProperty('isGemScanning');
    });

    it('ageMs reflects the correct age in milliseconds', async () => {
      // Token 2 hours old: ageMs should be 2 * 3600 * 1000 = 7,200,000
      const input = createMockInput({
        createdAt: FIXED_NOW_SEC - 2 * HOUR_S,
      });
      const result = await scoreTokenAge(input);

      expect(result.metadata.ageMs).toBe(2 * 60 * 60 * 1000);
    });

    it('ageHours is properly rounded to 1 decimal precision', async () => {
      // 90 minutes = 1.5 hours → should be exactly 1.5 after rounding
      const input = createMockInput({
        createdAt: FIXED_NOW_SEC - 1.5 * HOUR_S,
      });
      const result = await scoreTokenAge(input);

      const ageHours = result.metadata.ageHours as number;
      expect(typeof ageHours).toBe('number');
      // Verify the value equals its 1-decimal rounded form
      expect(ageHours).toBe(Math.round(ageHours * 10) / 10);
      expect(ageHours).toBe(1.5);
    });

    it('ageHours precision holds for non-clean fractions', async () => {
      // 2 hours 15 minutes = 2.25 hours → round(2.25 * 10) / 10 = 2.3
      // (Math.round(22.5) = 23 in JavaScript)
      const input = createMockInput({
        createdAt: FIXED_NOW_SEC - Math.round(2.25 * HOUR_S),
      });
      const result = await scoreTokenAge(input);

      const ageHours = result.metadata.ageHours as number;
      expect(ageHours).toBe(Math.round(ageHours * 10) / 10);
    });

    it('ageTier correctly identifies each scoring tier', async () => {
      const cases: Array<{ ageH: number; expectedTier: string }> = [
        { ageH: 1, expectedTier: 'early-accumulation' },
        { ageH: 6, expectedTier: 'gem-scanning' },
        { ageH: 18, expectedTier: 'aged' },
        { ageH: 48, expectedTier: 'stale' },
        { ageH: 96, expectedTier: 'expired' },
      ];

      for (const { ageH, expectedTier } of cases) {
        const input = createMockInput({
          createdAt: FIXED_NOW_SEC - ageH * HOUR_S,
        });
        const result = await scoreTokenAge(input);
        expect(result.metadata.ageTier).toBe(expectedTier);
      }
    });

    it('isEarlyAccumulation is true only for tokens ≤ 3h old', async () => {
      // Just inside boundary
      const inside = createMockInput({
        createdAt: FIXED_NOW_SEC - 2 * HOUR_S,
      });
      const insideResult = await scoreTokenAge(inside);
      expect(insideResult.metadata.isEarlyAccumulation).toBe(true);

      // Just outside boundary (3h + 1 second)
      const outside = createMockInput({
        createdAt: FIXED_NOW_SEC - (3 * HOUR_S + 1),
      });
      const outsideResult = await scoreTokenAge(outside);
      expect(outsideResult.metadata.isEarlyAccumulation).toBe(false);
    });

    it('isGemScanning is true only for tokens between 3h and 12h old', async () => {
      // Inside gem scanning (6h)
      const inside = createMockInput({
        createdAt: FIXED_NOW_SEC - 6 * HOUR_S,
      });
      const insideResult = await scoreTokenAge(inside);
      expect(insideResult.metadata.isGemScanning).toBe(true);

      // Below gem scanning (2h — in early accumulation)
      const below = createMockInput({
        createdAt: FIXED_NOW_SEC - 2 * HOUR_S,
      });
      const belowResult = await scoreTokenAge(below);
      expect(belowResult.metadata.isGemScanning).toBe(false);

      // Above gem scanning (18h — in aged tier)
      const above = createMockInput({
        createdAt: FIXED_NOW_SEC - 18 * HOUR_S,
      });
      const aboveResult = await scoreTokenAge(above);
      expect(aboveResult.metadata.isGemScanning).toBe(false);
    });
  });

  // =========================================================================
  // Error Handling
  // =========================================================================

  describe('error handling', () => {
    it('handles unexpected runtime error gracefully → returns score 0 with error metadata', async () => {
      // Force a runtime TypeError by passing null as input
      const result = await scoreTokenAge(
        null as unknown as TokenAnalysisInput,
      );

      expect(result.score).toBe(0);
      expect(result.name).toBe('tokenAge');
      expect(result.weight).toBe(0);
      expect(result.metadata).toHaveProperty('reason');
      expect(result.metadata.ageTier).toBe('invalid');
      expect(result.metadata.isEarlyAccumulation).toBe(false);
      expect(result.metadata.isGemScanning).toBe(false);
    });

    it('error result contains descriptive error information', async () => {
      const result = await scoreTokenAge(
        undefined as unknown as TokenAnalysisInput,
      );

      expect(result.score).toBe(0);
      expect(result.metadata.reason).toBeDefined();
      expect(typeof result.metadata.reason).toBe('string');
    });
  });
});
