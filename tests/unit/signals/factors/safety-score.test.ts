/**
 * tests/unit/signals/factors/safety-score.test.ts
 *
 * Comprehensive unit tests for the safety score factor module
 * (src/signals/factors/safety-score.ts).
 *
 * Tests multi-source safety aggregation: RugCheck score mapping (0-1000 → 0-100),
 * penalty application (mint authority -25, freeze authority -20, honeypot -50,
 * holder concentration >20% -15, mutable metadata -10, no LP lock/burn -15),
 * bonus application (all authorities revoked +15, LP burned +10, low concentration
 * ≤10% +5), FactorResult structure (name='safetyScore', weight=0, score 0-100
 * integer), metadata fields, missing data handling, and error handling.
 *
 * Per AAP Section 0.5.1 Group 5 and Section 0.7.3:
 * - Safety score integrates RugCheck + GoPlus safety data
 * - Maps RugCheck score ≥300 to safe baseline at score 50
 * - Hard filters are absolute (but not tested here — see hard-filters.test.ts)
 * - FactorResult.weight is always 0 — the scoring engine applies configurable weights
 *
 * @module tests/unit/signals/factors/safety-score
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { scoreSafetyScore } from '../../../../src/signals/factors/safety-score';
import type { TokenAnalysisInput, FactorResult } from '../../../../src/signals/types';
import type { SafetyReport } from '../../../../src/safety/types';

// ---------------------------------------------------------------------------
// Module Mocks (hoisted by Vitest)
// ---------------------------------------------------------------------------

/**
 * Mock the logger module to prevent console output during tests while
 * allowing the safety-score module to resolve its logger dependency.
 * Returns a factory that produces objects with no-op debug/info/warn/error.
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
 * Mock the config module with deterministic threshold values matching AAP
 * specifications. Includes MIN_SAFETY_SCORE (300) and MAX_TOP_HOLDER_CONCENTRATION
 * (20) which are used by the safety-score module internally.
 */
vi.mock('../../../../src/utils/config', () => ({
  HARD_FILTER_THRESHOLDS: {
    MAX_SNIPER_SUPPLY_PERCENT: 10,
    MIN_LIQUIDITY_USD: 3_000,
    MAX_TOP_10_HOLDER_PERCENT: 50,
    MIN_SAFETY_SCORE: 300,
    MAX_TOP_HOLDER_CONCENTRATION: 20,
  },
}));

// ---------------------------------------------------------------------------
// Test Data Factory
// ---------------------------------------------------------------------------

/**
 * Creates a mock TokenAnalysisInput with "safe" defaults.
 * All safety indicators are clean — overrides allow targeted mutation
 * for testing individual penalties and bonuses in isolation.
 *
 * Default config produces a base score of 64 (RugCheck 500 mapping)
 * plus bonuses (+15 auth, +10 LP burned) = 89 total.
 */
function createMockInput(
  overrides: Partial<TokenAnalysisInput> = {},
): TokenAnalysisInput {
  return {
    // === Identity ===
    mint: 'TestMint111111111111111111111111111111111111',
    symbol: 'SAFE',
    name: 'Safe Test Token',

    // === Price Data ===
    price: 0.001,
    priceChange5m: 5,
    priceChange1h: 10,
    priceChange24h: 20,

    // === Market Data ===
    marketCap: 100_000,
    volume5m: 500,
    volume1h: 5_000,
    volume24h: 50_000,
    liquidity: 30_000,
    supply: 1_000_000_000,

    // === Trading Activity ===
    buys1h: 100,
    sells1h: 50,
    buys24h: 1_000,
    sells24h: 500,

    // === Holder Data ===
    holderCount: 500,
    topHolderPercent: 12, // Between 10-20%: neutral (no bonus, no penalty)
    smartMoneyCount: 2,

    // === Safety & Authority — ALL CLEAN ===
    mintAuthorityActive: false,    // Revoked → no penalty, eligible for auth bonus
    freezeAuthorityActive: false,  // Revoked → no penalty, eligible for auth bonus
    lpBurned: true,                // Burned → no LP penalty, eligible for LP bonus
    lpLocked: false,
    lpBurnPercent: 95,
    isHoneypot: false,             // Not a honeypot → no penalty
    safetyScore: 500,              // Above 300 threshold → base score 64
    metadataMutable: false,        // Immutable → no penalty

    // === Developer Wallet ===
    devWalletAddress: 'DevWallet11111111111111111111111111111111111',
    devWalletSold: false,

    // === Token Age ===
    createdAt: Math.floor(Date.now() / 1000) - 3_600, // 1 hour ago

    // Apply any overrides
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('scoreSafetyScore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Phase 2: FactorResult Structure
  // =========================================================================

  describe('FactorResult structure', () => {
    it('returns a FactorResult with name exactly "safetyScore"', async () => {
      const input = createMockInput();
      const result: FactorResult = await scoreSafetyScore(input);

      expect(result.name).toBe('safetyScore');
    });

    it('returns a result with score, weight, and metadata fields', async () => {
      const input = createMockInput();
      const result = await scoreSafetyScore(input);

      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('weight');
      expect(result).toHaveProperty('metadata');
    });

    it('always returns weight of 0', async () => {
      const input = createMockInput();
      const result = await scoreSafetyScore(input);

      expect(result.weight).toBe(0);
    });

    it('returns score as an integer between 0 and 100 for multiple inputs', async () => {
      const testCases: Partial<TokenAnalysisInput>[] = [
        { safetyScore: 0 },
        { safetyScore: 150 },
        { safetyScore: 300 },
        { safetyScore: 500 },
        { safetyScore: 1000 },
        { isHoneypot: true, safetyScore: 100 },
        {
          mintAuthorityActive: true,
          freezeAuthorityActive: true,
          isHoneypot: true,
          metadataMutable: true,
          lpBurned: false,
          lpLocked: false,
          topHolderPercent: 40,
        },
      ];

      for (const overrides of testCases) {
        const input = createMockInput(overrides);
        const result = await scoreSafetyScore(input);

        expect(Number.isInteger(result.score)).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
      }
    });
  });

  // =========================================================================
  // Phase 3: RugCheck Score Mapping
  // =========================================================================

  describe('RugCheck score mapping', () => {
    it('maps RugCheck score ≥300 + all clean → high safety score (≥75)', async () => {
      // safetyScore=500 → base=64 (50 + round(200/700 * 50))
      // Bonuses: +15 (auth revoked) + 10 (LP burned) + 5 (low conc) = +30
      // Total: 94
      const input = createMockInput({
        safetyScore: 500,
        topHolderPercent: 8, // Gets low concentration bonus (+5)
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
        lpBurned: true,
      });
      const result = await scoreSafetyScore(input);

      expect(result.score).toBeGreaterThanOrEqual(75);
    });

    it('maps RugCheck score 200 (below 300) → lower score than ≥300', async () => {
      // safetyScore=200 → base=round(200/300 * 50)=33
      // + bonuses: +15 + 10 = 58
      const belowThreshold = createMockInput({ safetyScore: 200 });
      const aboveThreshold = createMockInput({ safetyScore: 500 });

      const belowResult = await scoreSafetyScore(belowThreshold);
      const aboveResult = await scoreSafetyScore(aboveThreshold);

      expect(belowResult.score).toBeLessThan(aboveResult.score);
      // Below-threshold base is under 50 before bonuses
      expect(belowResult.score).toBeLessThanOrEqual(60);
    });

    it('maps RugCheck score 0 → very low base score', async () => {
      // safetyScore=0 → base=0 (condition input.safetyScore > 0 is false)
      // + bonuses: +15 (auth) + 10 (LP) = 25
      const input = createMockInput({ safetyScore: 0 });
      const result = await scoreSafetyScore(input);

      expect(result.score).toBeLessThanOrEqual(30);
    });

    it('maps RugCheck score 1000 → maximum base score (clamped to 100)', async () => {
      // safetyScore=1000 → base=100 (50 + round(700/700 * 50))
      // + bonuses: +15 + 10 + 5 = +30, total 130, clamped to 100
      const input = createMockInput({
        safetyScore: 1000,
        topHolderPercent: 8, // Low concentration bonus
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
        lpBurned: true,
      });
      const result = await scoreSafetyScore(input);

      expect(result.score).toBeGreaterThanOrEqual(90);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('maintains RugCheck score in metadata', async () => {
      const input = createMockInput({ safetyScore: 750 });
      const result = await scoreSafetyScore(input);

      expect(result.metadata.rugCheckScore).toBe(750);
    });
  });

  // =========================================================================
  // Phase 4: Active Mint Authority Penalty
  // =========================================================================

  describe('mint authority penalty', () => {
    it('applies penalty for active mint authority (lower score)', async () => {
      const revoked = createMockInput({ mintAuthorityActive: false });
      const active = createMockInput({ mintAuthorityActive: true });

      const revokedResult = await scoreSafetyScore(revoked);
      const activeResult = await scoreSafetyScore(active);

      // Active mint: -25 penalty, plus loses +15 auth-revoked bonus = 40 difference
      expect(revokedResult.score).toBeGreaterThan(activeResult.score);
      expect(revokedResult.score - activeResult.score).toBeGreaterThanOrEqual(25);
    });

    it('records mint authority risk factor when active', async () => {
      const input = createMockInput({ mintAuthorityActive: true });
      const result = await scoreSafetyScore(input);

      const riskFactors = result.metadata.riskFactors as string[];
      expect(riskFactors.some((f) => f.toLowerCase().includes('mint'))).toBe(
        true,
      );
    });

    it('does not record mint risk factor when revoked', async () => {
      const input = createMockInput({ mintAuthorityActive: false });
      const result = await scoreSafetyScore(input);

      const riskFactors = result.metadata.riskFactors as string[];
      expect(
        riskFactors.some((f) => f.toLowerCase().includes('mint authority')),
      ).toBe(false);
    });
  });

  // =========================================================================
  // Phase 5: Active Freeze Authority Penalty
  // =========================================================================

  describe('freeze authority penalty', () => {
    it('applies penalty for active freeze authority', async () => {
      const revoked = createMockInput({ freezeAuthorityActive: false });
      const active = createMockInput({ freezeAuthorityActive: true });

      const revokedResult = await scoreSafetyScore(revoked);
      const activeResult = await scoreSafetyScore(active);

      // Active freeze: -20 penalty, plus loses +15 auth-revoked bonus = 35 difference
      expect(revokedResult.score).toBeGreaterThan(activeResult.score);
      expect(revokedResult.score - activeResult.score).toBeGreaterThanOrEqual(
        20,
      );
    });

    it('applies both mint AND freeze penalties when both active', async () => {
      const bothRevoked = createMockInput({
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
      });
      const bothActive = createMockInput({
        mintAuthorityActive: true,
        freezeAuthorityActive: true,
      });

      const revokedResult = await scoreSafetyScore(bothRevoked);
      const bothActiveResult = await scoreSafetyScore(bothActive);

      // Both active: -25-20 = -45 in penalties, plus loss of +15 auth bonus = 60 gap
      expect(revokedResult.score).toBeGreaterThan(bothActiveResult.score);
      expect(revokedResult.score - bothActiveResult.score).toBeGreaterThanOrEqual(
        45,
      );
    });

    it('records freeze authority risk factor when active', async () => {
      const input = createMockInput({ freezeAuthorityActive: true });
      const result = await scoreSafetyScore(input);

      const riskFactors = result.metadata.riskFactors as string[];
      expect(riskFactors.some((f) => f.toLowerCase().includes('freeze'))).toBe(
        true,
      );
    });
  });

  // =========================================================================
  // Phase 6: Holder Concentration Penalty
  // =========================================================================

  describe('holder concentration', () => {
    it('penalizes top holder concentration >20%', async () => {
      const low = createMockInput({ topHolderPercent: 10 });
      const high = createMockInput({ topHolderPercent: 25 });

      const lowResult = await scoreSafetyScore(low);
      const highResult = await scoreSafetyScore(high);

      // topHolderPercent=25 triggers -15 penalty (>20% threshold)
      expect(lowResult.score).toBeGreaterThan(highResult.score);
    });

    it('applies bonus for top holder concentration ≤10%', async () => {
      const lowConc = createMockInput({ topHolderPercent: 8 }); // Gets +5 bonus
      const midConc = createMockInput({ topHolderPercent: 15 }); // No bonus/penalty

      const lowResult = await scoreSafetyScore(lowConc);
      const midResult = await scoreSafetyScore(midConc);

      // topHolderPercent=8 gets +5 low concentration bonus
      expect(lowResult.score).toBeGreaterThan(midResult.score);
    });

    it('applies neutral treatment for concentration between 10-20%', async () => {
      const input = createMockInput({ topHolderPercent: 15 });
      const result = await scoreSafetyScore(input);

      // No concentration-related risk factors for 15% (between 10-20%)
      const riskFactors = result.metadata.riskFactors as string[];
      expect(
        riskFactors.some(
          (f) =>
            f.toLowerCase().includes('concentration') ||
            f.toLowerCase().includes('holder'),
        ),
      ).toBe(false);
    });

    it('records high concentration in risk factors when >20%', async () => {
      const input = createMockInput({ topHolderPercent: 25 });
      const result = await scoreSafetyScore(input);

      const riskFactors = result.metadata.riskFactors as string[];
      expect(
        riskFactors.some(
          (f) =>
            f.toLowerCase().includes('concentration') ||
            f.toLowerCase().includes('holder'),
        ),
      ).toBe(true);
    });

    it('includes concentration percentage in the risk factor description', async () => {
      const input = createMockInput({ topHolderPercent: 30 });
      const result = await scoreSafetyScore(input);

      const riskFactors = result.metadata.riskFactors as string[];
      expect(riskFactors.some((f) => f.includes('30.0%'))).toBe(true);
    });
  });

  // =========================================================================
  // Phase 7: Mutable Metadata Penalty
  // =========================================================================

  describe('mutable metadata penalty', () => {
    it('applies penalty for mutable metadata', async () => {
      const immutable = createMockInput({ metadataMutable: false });
      const mutable = createMockInput({ metadataMutable: true });

      const immutableResult = await scoreSafetyScore(immutable);
      const mutableResult = await scoreSafetyScore(mutable);

      // Mutable metadata incurs -10 penalty
      expect(immutableResult.score).toBeGreaterThan(mutableResult.score);
    });

    it('records mutable metadata in risk factors', async () => {
      const input = createMockInput({ metadataMutable: true });
      const result = await scoreSafetyScore(input);

      const riskFactors = result.metadata.riskFactors as string[];
      expect(
        riskFactors.some(
          (f) =>
            f.toLowerCase().includes('metadata') &&
            f.toLowerCase().includes('mutable'),
        ),
      ).toBe(true);
    });

    it('does not record mutable metadata risk when immutable', async () => {
      const input = createMockInput({ metadataMutable: false });
      const result = await scoreSafetyScore(input);

      const riskFactors = result.metadata.riskFactors as string[];
      expect(
        riskFactors.some(
          (f) =>
            f.toLowerCase().includes('metadata') &&
            f.toLowerCase().includes('mutable'),
        ),
      ).toBe(false);
    });
  });

  // =========================================================================
  // Phase 8: Honeypot Detection (Severe Penalty)
  // =========================================================================

  describe('honeypot detection', () => {
    it('applies severe -50 penalty for honeypot tokens', async () => {
      const safe = createMockInput({ isHoneypot: false });
      const honeypot = createMockInput({ isHoneypot: true });

      const safeResult = await scoreSafetyScore(safe);
      const honeypotResult = await scoreSafetyScore(honeypot);

      // Exact 50-point difference from honeypot penalty
      expect(safeResult.score - honeypotResult.score).toBe(50);
    });

    it('produces very low score (≤25) for honeypot with moderate RugCheck', async () => {
      // safetyScore=300 → base=50, -50(honeypot)=0, +15(auth)+10(LP)=25
      const input = createMockInput({ isHoneypot: true, safetyScore: 300 });
      const result = await scoreSafetyScore(input);

      expect(result.score).toBeLessThanOrEqual(25);
    });

    it('records honeypot in metadata risk factors', async () => {
      const input = createMockInput({ isHoneypot: true });
      const result = await scoreSafetyScore(input);

      const riskFactors = result.metadata.riskFactors as string[];
      expect(riskFactors.some((f) => f.toLowerCase().includes('honeypot'))).toBe(
        true,
      );
    });

    it('does not apply honeypot penalty when token is not a honeypot', async () => {
      const input = createMockInput({ isHoneypot: false });
      const result = await scoreSafetyScore(input);

      const riskFactors = result.metadata.riskFactors as string[];
      expect(riskFactors.some((f) => f.toLowerCase().includes('honeypot'))).toBe(
        false,
      );
    });

    it('reflects isHoneypot status in metadata', async () => {
      const honeypot = createMockInput({ isHoneypot: true });
      const safe = createMockInput({ isHoneypot: false });

      const honeypotResult = await scoreSafetyScore(honeypot);
      const safeResult = await scoreSafetyScore(safe);

      expect(honeypotResult.metadata.isHoneypot).toBe(true);
      expect(safeResult.metadata.isHoneypot).toBe(false);
    });
  });

  // =========================================================================
  // Phase 9: LP Status
  // =========================================================================

  describe('LP status', () => {
    it('applies bonus when LP is burned (+10)', async () => {
      const burned = createMockInput({ lpBurned: true, lpLocked: false });
      const locked = createMockInput({ lpBurned: false, lpLocked: true });

      const burnedResult = await scoreSafetyScore(burned);
      const lockedResult = await scoreSafetyScore(locked);

      // LP burned: +10 bonus. LP locked (not burned): no burn bonus
      // Neither triggers the no-LP penalty since at least one is true
      expect(burnedResult.score).toBeGreaterThan(lockedResult.score);
    });

    it('applies penalty when LP is neither burned nor locked (-15)', async () => {
      const protectedLP = createMockInput({ lpBurned: true, lpLocked: false });
      const unprotectedLP = createMockInput({ lpBurned: false, lpLocked: false });

      const protectedResult = await scoreSafetyScore(protectedLP);
      const unprotectedResult = await scoreSafetyScore(unprotectedLP);

      // Unprotected: -15 penalty AND no +10 LP burn bonus = 25 difference
      expect(protectedResult.score).toBeGreaterThan(unprotectedResult.score);
      expect(protectedResult.score - unprotectedResult.score).toBeGreaterThanOrEqual(
        15,
      );
    });

    it('records LP risk in metadata when neither burned nor locked', async () => {
      const input = createMockInput({ lpBurned: false, lpLocked: false });
      const result = await scoreSafetyScore(input);

      const riskFactors = result.metadata.riskFactors as string[];
      expect(riskFactors.some((f) => f.toLowerCase().includes('lp'))).toBe(
        true,
      );
    });

    it('does not record LP risk when LP is locked', async () => {
      const input = createMockInput({ lpBurned: false, lpLocked: true });
      const result = await scoreSafetyScore(input);

      const riskFactors = result.metadata.riskFactors as string[];
      expect(
        riskFactors.some((f) => f.toLowerCase().includes('lp not burned')),
      ).toBe(false);
    });
  });

  // =========================================================================
  // Phase 10: All Authorities Revoked Bonus
  // =========================================================================

  describe('all authorities revoked bonus', () => {
    it('applies +15 bonus when both mint and freeze are revoked', async () => {
      // Both revoked: gets +15 auth bonus
      const bothRevoked = createMockInput({
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
      });
      // Mint active: loses -25 penalty AND loses +15 bonus = 40-point gap
      const mintActive = createMockInput({
        mintAuthorityActive: true,
        freezeAuthorityActive: false,
      });

      const revokedResult = await scoreSafetyScore(bothRevoked);
      const activeResult = await scoreSafetyScore(mintActive);

      // Difference includes the 25-point mint penalty + 15-point bonus loss = 40
      expect(revokedResult.score - activeResult.score).toBe(40);
    });

    it('does not apply auth bonus when either authority is active', async () => {
      const freezeOnly = createMockInput({
        mintAuthorityActive: false,
        freezeAuthorityActive: true,
      });
      const bothRevoked = createMockInput({
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
      });

      const freezeResult = await scoreSafetyScore(freezeOnly);
      const revokedResult = await scoreSafetyScore(bothRevoked);

      // freeze active: -20 penalty, no auth bonus
      // both revoked: +15 bonus → difference = 20 + 15 = 35
      expect(revokedResult.score - freezeResult.score).toBe(35);
    });
  });

  // =========================================================================
  // Phase 11: Worst-Case-Wins / Accumulated Penalties
  // =========================================================================

  describe('accumulated penalties', () => {
    it('accumulates all penalties driving score to 0', async () => {
      const input = createMockInput({
        safetyScore: 500,              // base=64
        mintAuthorityActive: true,     // -25
        freezeAuthorityActive: true,   // -20
        topHolderPercent: 30,          // -15 (>20%)
        metadataMutable: true,         // -10
        lpBurned: false,               // loses LP burn bonus
        lpLocked: false,               // -15 (no LP protection)
        isHoneypot: false,             // no honeypot penalty
      });
      const result = await scoreSafetyScore(input);

      // 64 -25 -20 -15 -10 -15 = -21, clamped to 0
      // No bonuses: auth active, LP not burned, conc > 10%
      expect(result.score).toBe(0);
    });

    it('accumulates all penalties including honeypot to 0', async () => {
      const input = createMockInput({
        safetyScore: 500,
        isHoneypot: true,              // -50
        mintAuthorityActive: true,     // -25
        freezeAuthorityActive: true,   // -20
        topHolderPercent: 30,          // -15
        metadataMutable: true,         // -10
        lpBurned: false,
        lpLocked: false,               // -15
      });
      const result = await scoreSafetyScore(input);

      // 64 -50 -25 -20 -15 -10 -15 = -71, clamped to 0
      expect(result.score).toBe(0);
    });

    it('reports multiple risk factors for accumulated penalties', async () => {
      const input = createMockInput({
        mintAuthorityActive: true,
        freezeAuthorityActive: true,
        topHolderPercent: 30,
        metadataMutable: true,
        lpBurned: false,
        lpLocked: false,
        isHoneypot: true,
      });
      const result = await scoreSafetyScore(input);

      const riskFactors = result.metadata.riskFactors as string[];
      // Should have: honeypot, mint, freeze, concentration, metadata, LP = 6 factors
      expect(riskFactors.length).toBeGreaterThanOrEqual(5);
    });
  });

  // =========================================================================
  // Phase 12: Missing Data Handling
  // =========================================================================

  describe('missing data handling', () => {
    it('handles safetyScore=0 gracefully without crashing', async () => {
      const input = createMockInput({ safetyScore: 0 });
      const result = await scoreSafetyScore(input);

      expect(result.name).toBe('safetyScore');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(Number.isInteger(result.score)).toBe(true);
    });

    it('produces a high score with all safe defaults (≥70)', async () => {
      // Default mock: safetyScore=500, all clean, LP burned
      // Base=64, +15(auth) +10(LP) = 89
      const input = createMockInput();
      const result = await scoreSafetyScore(input);

      expect(result.score).toBeGreaterThanOrEqual(70);
    });

    it('handles safetyScore just below threshold (299)', async () => {
      const input = createMockInput({ safetyScore: 299 });
      const result = await scoreSafetyScore(input);

      // 299 < 300 → maps via [0,300) → [0,50) formula
      // round(299/300 * 50) = round(49.83) = 50
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.metadata.rugCheckSafe).toBe(false);
    });

    it('handles safetyScore exactly at threshold (300)', async () => {
      const input = createMockInput({ safetyScore: 300 });
      const result = await scoreSafetyScore(input);

      // 300 ≥ 300 → maps via [300,1000] → [50,100] formula
      // 50 + round((300-300)/(1000-300) * 50) = 50
      expect(result.metadata.rugCheckSafe).toBe(true);
    });
  });

  // =========================================================================
  // Phase 13: Metadata Validation
  // =========================================================================

  describe('metadata structure', () => {
    it('contains all expected metadata fields', async () => {
      const input = createMockInput();
      const result = await scoreSafetyScore(input);

      expect(result.metadata).toHaveProperty('rugCheckScore');
      expect(result.metadata).toHaveProperty('rugCheckSafe');
      expect(result.metadata).toHaveProperty('mintAuthorityActive');
      expect(result.metadata).toHaveProperty('freezeAuthorityActive');
      expect(result.metadata).toHaveProperty('topHolderPercent');
      expect(result.metadata).toHaveProperty('metadataMutable');
      expect(result.metadata).toHaveProperty('isHoneypot');
      expect(result.metadata).toHaveProperty('lpBurned');
      expect(result.metadata).toHaveProperty('lpLocked');
      expect(result.metadata).toHaveProperty('riskFactors');
    });

    it('riskFactors is an array of strings', async () => {
      const input = createMockInput({ mintAuthorityActive: true });
      const result = await scoreSafetyScore(input);

      expect(Array.isArray(result.metadata.riskFactors)).toBe(true);
      const riskFactors = result.metadata.riskFactors as string[];
      for (const factor of riskFactors) {
        expect(typeof factor).toBe('string');
      }
    });

    it('riskFactors is empty array when all indicators are safe', async () => {
      const input = createMockInput();
      const result = await scoreSafetyScore(input);

      const riskFactors = result.metadata.riskFactors as string[];
      expect(riskFactors).toEqual([]);
    });

    it('rugCheckSafe reflects the 300 threshold correctly', async () => {
      const aboveThreshold = createMockInput({ safetyScore: 500 });
      const belowThreshold = createMockInput({ safetyScore: 200 });

      const aboveResult = await scoreSafetyScore(aboveThreshold);
      const belowResult = await scoreSafetyScore(belowThreshold);

      expect(aboveResult.metadata.rugCheckSafe).toBe(true);
      expect(belowResult.metadata.rugCheckSafe).toBe(false);
    });

    it('accurately reflects all input values in metadata', async () => {
      const input = createMockInput({
        safetyScore: 750,
        mintAuthorityActive: true,
        freezeAuthorityActive: false,
        topHolderPercent: 18,
        metadataMutable: true,
        isHoneypot: false,
        lpBurned: false,
        lpLocked: true,
      });
      const result = await scoreSafetyScore(input);

      expect(result.metadata.rugCheckScore).toBe(750);
      expect(result.metadata.mintAuthorityActive).toBe(true);
      expect(result.metadata.freezeAuthorityActive).toBe(false);
      expect(result.metadata.topHolderPercent).toBe(18);
      expect(result.metadata.metadataMutable).toBe(true);
      expect(result.metadata.isHoneypot).toBe(false);
      expect(result.metadata.lpBurned).toBe(false);
      expect(result.metadata.lpLocked).toBe(true);
    });

    it('includes SafetyReport details when provided as second parameter', async () => {
      const input = createMockInput();
      const safetyReport: SafetyReport = {
        mint: input.mint,
        overallScore: 650,
        rugCheckScore: 500,
        goPlusResult: null,
        honeypotResult: { sellable: true, estimatedTax: 0 },
        lpStatus: { burned: true, burnPercent: 95, locked: false },
        authorityStatus: {
          mintRevoked: true,
          freezeRevoked: true,
          metadataMutable: false,
        },
        riskFactors: ['No significant risks detected'],
        isToken2022: false,
        checkedAt: Date.now(),
        rugCheckAvailable: true,
        goPlusAvailable: false,
        top10HolderPercent: 35,
        largestHolderPercent: 12,
      };

      const result = await scoreSafetyScore(input, safetyReport);

      expect(result.metadata.reportOverallScore).toBe(650);
      expect(result.metadata.reportRugCheckScore).toBe(500);
      expect(result.metadata.reportRiskFactors).toEqual([
        'No significant risks detected',
      ]);
    });

    it('does not include report fields when safetyReport is null', async () => {
      const input = createMockInput();
      const result = await scoreSafetyScore(input, null);

      expect(result.metadata).not.toHaveProperty('reportOverallScore');
      expect(result.metadata).not.toHaveProperty('reportRugCheckScore');
      expect(result.metadata).not.toHaveProperty('reportRiskFactors');
    });

    it('does not include report fields when safetyReport is undefined', async () => {
      const input = createMockInput();
      const result = await scoreSafetyScore(input);

      expect(result.metadata).not.toHaveProperty('reportOverallScore');
      expect(result.metadata).not.toHaveProperty('reportRugCheckScore');
      expect(result.metadata).not.toHaveProperty('reportRiskFactors');
    });
  });

  // =========================================================================
  // Phase 14: Error Handling
  // =========================================================================

  describe('error handling', () => {
    it('returns score 0 with error metadata on null input', async () => {
      const result = await scoreSafetyScore(
        null as unknown as TokenAnalysisInput,
      );

      expect(result.name).toBe('safetyScore');
      expect(result.score).toBe(0);
      expect(result.weight).toBe(0);
      expect(result.metadata).toHaveProperty('error');
    });

    it('returns score 0 with error metadata on undefined input', async () => {
      const result = await scoreSafetyScore(
        undefined as unknown as TokenAnalysisInput,
      );

      expect(result.name).toBe('safetyScore');
      expect(result.score).toBe(0);
      expect(result.weight).toBe(0);
      expect(result.metadata).toHaveProperty('error');
    });

    it('error metadata contains error description string', async () => {
      const result = await scoreSafetyScore(
        null as unknown as TokenAnalysisInput,
      );

      expect(typeof result.metadata.error).toBe('string');
      expect((result.metadata.error as string).length).toBeGreaterThan(0);
    });
  });
});
