/**
 * tests/unit/signals/factors/smart-money-convergence.test.ts
 *
 * Comprehensive unit tests for the smart money convergence factor module
 * (`src/signals/factors/smart-money-convergence.ts`).
 *
 * Validates all scoring behaviours defined in the AAP:
 *   - FactorResult structure (name, weight, score, metadata)
 *   - Basic mode scoring (0 wallets → 0, 1 → 10, 2 → 25, 3+ → 50)
 *   - Convergence event mode (3+ wallets in 2h window → base ≥60)
 *   - Wallet count bonus (5 pts per extra wallet, capped at 20)
 *   - Conviction multiplier (1.3× when position size ≥80% of historical avg)
 *   - Quality weight bonus (+5 when avgQualityWeight > 0.8)
 *   - Mixed wallet classification weighting
 *   - Null / undefined convergenceEvent fallback to basic mode
 *   - Metadata field completeness & correctness
 *   - Graceful error handling (score 0 + error metadata)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TokenAnalysisInput, FactorResult } from '../../../../src/signals/types';
import type { ConvergenceEvent } from '../../../../src/tracking/types';

// ---------------------------------------------------------------------------
// Module Mocks — hoisted by vitest before any imports
// ---------------------------------------------------------------------------

/**
 * Mock the logger so every `logger.debug()` / `logger.error()` call
 * inside the module under test becomes a silent no-op.
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
 * Mock the config module with deterministic values matching AAP specs:
 *   - 2-hour convergence window (7 200 000 ms)
 *   - Minimum 3 wallets for convergence
 *   - 80% conviction threshold
 */
vi.mock('../../../../src/utils/config', () => ({
  SMART_MONEY_CONFIG: {
    CONVERGENCE_WINDOW_MS: 2 * 60 * 60 * 1000,
    MIN_CONVERGENCE_WALLETS: 3,
    CONVICTION_THRESHOLD_PERCENT: 80,
  },
}));

// Import the function under test (mocks are applied first)
import { scoreSmartMoneyConvergence } from '../../../../src/signals/factors/smart-money-convergence';

// ---------------------------------------------------------------------------
// Test Data Factories
// ---------------------------------------------------------------------------

/**
 * Creates a fully-populated `TokenAnalysisInput` with sensible defaults.
 * Any field can be overridden via the `overrides` parameter.
 */
function createMockInput(
  overrides: Partial<TokenAnalysisInput> = {},
): TokenAnalysisInput {
  return {
    mint: 'MockMint111111111111111111111111111111111111',
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
    smartMoneyCount: 0,
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
    createdAt: Math.floor(Date.now() / 1000) - 3600,
    ...overrides,
  };
}

/**
 * Creates a valid `ConvergenceEvent` with sensible defaults.
 * Default values:
 *   - 3 smart_money wallets
 *   - convictionScore 85 (above 80 threshold → multiplier applies)
 *   - avgQualityWeight 0.9 (above 0.8 → quality bonus applies)
 */
function createMockConvergenceEvent(
  overrides: Partial<ConvergenceEvent> = {},
): ConvergenceEvent {
  const now = Date.now();
  return {
    token: 'MockMint111111111111111111111111111111111111',
    wallets: [
      { address: 'w1', classification: 'smart_money', positionSize: 1000, entryTimestamp: now - 1_800_000 },
      { address: 'w2', classification: 'smart_money', positionSize: 1200, entryTimestamp: now - 1_200_000 },
      { address: 'w3', classification: 'smart_money', positionSize: 1100, entryTimestamp: now - 600_000 },
    ],
    windowStart: now - 3_600_000,
    windowEnd: now,
    convictionScore: 85,
    walletCount: 3,
    avgQualityWeight: 0.9,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('scoreSmartMoneyConvergence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Phase 2: FactorResult Structure
  // =========================================================================

  describe('FactorResult structure', () => {
    it('returns name "smartMoneyConvergence"', async () => {
      const result = await scoreSmartMoneyConvergence(createMockInput());
      expect(result.name).toBe('smartMoneyConvergence');
    });

    it('returns weight of 0 (weight applied externally by scoring engine)', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 3 }),
      );
      expect(result.weight).toBe(0);
    });

    it('includes score and metadata fields', async () => {
      const result = await scoreSmartMoneyConvergence(createMockInput());
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('metadata');
      expect(typeof result.score).toBe('number');
      expect(typeof result.metadata).toBe('object');
    });

    it('always returns an integer score between 0 and 100', async () => {
      const basicConfigs: Partial<TokenAnalysisInput>[] = [
        { smartMoneyCount: 0 },
        { smartMoneyCount: 1 },
        { smartMoneyCount: 2 },
        { smartMoneyCount: 5 },
        { smartMoneyCount: 100 },
      ];

      for (const overrides of basicConfigs) {
        const result = await scoreSmartMoneyConvergence(createMockInput(overrides));
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
        expect(Number.isInteger(result.score)).toBe(true);
      }

      // Also verify with convergence events of varying intensity
      const events: ConvergenceEvent[] = [
        createMockConvergenceEvent({ walletCount: 3, convictionScore: 50, avgQualityWeight: 0.5 }),
        createMockConvergenceEvent({ walletCount: 7, convictionScore: 100, avgQualityWeight: 1.0 }),
        createMockConvergenceEvent({ walletCount: 10, convictionScore: 100, avgQualityWeight: 1.0 }),
      ];

      for (const event of events) {
        const result = await scoreSmartMoneyConvergence(
          createMockInput({ smartMoneyCount: event.walletCount }),
          event,
        );
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
        expect(Number.isInteger(result.score)).toBe(true);
      }
    });
  });

  // =========================================================================
  // Phase 3: Basic Mode (no ConvergenceEvent, using smartMoneyCount)
  // =========================================================================

  describe('basic mode (no convergence event)', () => {
    it('scores 0 for 0 smart money wallets', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 0 }),
      );
      expect(result.score).toBe(0);
      expect(result.metadata.convergenceDetected).toBe(false);
      expect(result.metadata.source).toBe('basic');
    });

    it('scores 10 for 1 smart money wallet (single whale bonus per AAP)', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 1 }),
      );
      expect(result.score).toBe(10);
    });

    it('scores 25 for 2 smart money wallets (multi whale bonus per AAP)', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 2 }),
      );
      expect(result.score).toBe(25);
    });

    it('scores 50 for 3+ smart money wallets in basic mode (unconfirmed convergence)', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 4 }),
      );
      expect(result.score).toBe(50);
    });

    it('scores 50 for exactly 3 smart money wallets in basic mode', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 3 }),
      );
      expect(result.score).toBe(50);
    });

    it('caps basic mode at 50 regardless of wallet count', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 20 }),
      );
      expect(result.score).toBe(50);
    });
  });

  // =========================================================================
  // Phase 4: Convergence Event Mode (3+ qualified wallets within 2h window)
  // =========================================================================

  describe('convergence event mode', () => {
    it('scores ≥60 with 3 wallets in convergence event', async () => {
      const event = createMockConvergenceEvent({
        walletCount: 3,
        convictionScore: 50,  // below conviction threshold
        avgQualityWeight: 0.5, // below quality threshold
      });
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 3 }),
        event,
      );

      // Expected: base 60 + 0 extra + 0 quality + no multiplier = 60
      expect(result.score).toBeGreaterThanOrEqual(60);
      expect(result.score).toBe(60);
      expect(result.metadata.convergenceDetected).toBe(true);
      expect(result.metadata.source).toBe('convergence-detector');
    });

    it('scores higher with 5 wallets than with 3 wallets', async () => {
      const input = createMockInput({ smartMoneyCount: 5 });

      const result3 = await scoreSmartMoneyConvergence(
        input,
        createMockConvergenceEvent({ walletCount: 3, convictionScore: 50, avgQualityWeight: 0.5 }),
      );
      // 60 + 0 extra = 60

      const result5 = await scoreSmartMoneyConvergence(
        input,
        createMockConvergenceEvent({ walletCount: 5, convictionScore: 50, avgQualityWeight: 0.5 }),
      );
      // 60 + (2*5)=10 extra = 70

      expect(result5.score).toBeGreaterThan(result3.score);
    });

    it('scores high with 7 wallets but caps at ≤100', async () => {
      const event = createMockConvergenceEvent({
        walletCount: 7,
        convictionScore: 100,
        avgQualityWeight: 1.0,
      });
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 7 }),
        event,
      );

      // 60 + 20 (cap) + 5 quality = 85, then *1.3 = 110.5 → clamped to 100
      expect(result.score).toBeGreaterThan(60);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.score).toBe(100);
    });

    it('adds 5 points per extra wallet above the minimum of 3', async () => {
      const input = createMockInput({ smartMoneyCount: 5 });

      const result3 = await scoreSmartMoneyConvergence(
        input,
        createMockConvergenceEvent({ walletCount: 3, convictionScore: 50, avgQualityWeight: 0.5 }),
      );
      const result5 = await scoreSmartMoneyConvergence(
        input,
        createMockConvergenceEvent({ walletCount: 5, convictionScore: 50, avgQualityWeight: 0.5 }),
      );

      // 3 wallets: 60, 5 wallets: 70, difference = 10 (2 extra × 5 points)
      expect(result5.score - result3.score).toBe(10);
    });

    it('caps extra wallet bonus at 20 points (4 extra wallets max bonus)', async () => {
      const input = createMockInput({ smartMoneyCount: 10 });

      // 7 wallets = (7-3)*5 = 20 (exactly at cap)
      const result7 = await scoreSmartMoneyConvergence(
        input,
        createMockConvergenceEvent({ walletCount: 7, convictionScore: 50, avgQualityWeight: 0.5 }),
      );

      // 10 wallets = (10-3)*5 = 35, capped at 20
      const result10 = await scoreSmartMoneyConvergence(
        input,
        createMockConvergenceEvent({ walletCount: 10, convictionScore: 50, avgQualityWeight: 0.5 }),
      );

      // Both should be 80 (60 + 20 + 0 quality + no multiplier)
      expect(result7.score).toBe(80);
      expect(result10.score).toBe(80);
      expect(result7.score).toBe(result10.score);
    });
  });

  // =========================================================================
  // Phase 5: Conviction Multiplier (position-size ≥ 80% of historical avg)
  // =========================================================================

  describe('conviction multiplier', () => {
    it('applies 1.3× multiplier when convictionScore ≥ 80', async () => {
      const input = createMockInput({ smartMoneyCount: 3 });

      // High conviction (90 ≥ 80 → multiplier applied)
      const highResult = await scoreSmartMoneyConvergence(
        input,
        createMockConvergenceEvent({ walletCount: 3, convictionScore: 90, avgQualityWeight: 0.9 }),
      );
      // (60 + 0 + 5) * 1.3 = 84.5 → 85

      // Low conviction (50 < 80 → no multiplier)
      const lowResult = await scoreSmartMoneyConvergence(
        input,
        createMockConvergenceEvent({ walletCount: 3, convictionScore: 50, avgQualityWeight: 0.9 }),
      );
      // 60 + 0 + 5 = 65

      expect(highResult.score).toBeGreaterThan(lowResult.score);
      expect(highResult.score).toBe(85);
      expect(lowResult.score).toBe(65);
    });

    it('does not apply multiplier when convictionScore < 80', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 3 }),
        createMockConvergenceEvent({ walletCount: 3, convictionScore: 50, avgQualityWeight: 0.5 }),
      );

      // 60 + 0 + 0 = 60 (no multiplier)
      expect(result.score).toBe(60);
      expect(result.metadata.convictionMultiplierApplied).toBe(false);
    });

    it('applies multiplier at exactly convictionScore = 80 (boundary)', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 3 }),
        createMockConvergenceEvent({ walletCount: 3, convictionScore: 80, avgQualityWeight: 0.9 }),
      );

      // (60 + 0 + 5) * 1.3 = 84.5 → 85
      expect(result.score).toBe(85);
      expect(result.metadata.convictionMultiplierApplied).toBe(true);
    });

    it('does not apply multiplier at convictionScore = 79 (just below boundary)', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 3 }),
        createMockConvergenceEvent({ walletCount: 3, convictionScore: 79, avgQualityWeight: 0.9 }),
      );

      // 60 + 0 + 5 = 65 (no multiplier at 79)
      expect(result.score).toBe(65);
      expect(result.metadata.convictionMultiplierApplied).toBe(false);
    });

    it('handles convictionScore = 100 (maximum conviction)', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 3 }),
        createMockConvergenceEvent({ walletCount: 3, convictionScore: 100, avgQualityWeight: 0.9 }),
      );

      // (60 + 0 + 5) * 1.3 = 84.5 → 85 (same formula as 90 or 80)
      expect(result.score).toBe(85);
    });
  });

  // =========================================================================
  // Phase 6: Quality Weight Impact
  // =========================================================================

  describe('quality weight impact', () => {
    it('adds +5 bonus when avgQualityWeight > 0.8', async () => {
      const input = createMockInput({ smartMoneyCount: 3 });

      // High quality weight (0.95 > 0.8 → +5 bonus)
      const highResult = await scoreSmartMoneyConvergence(
        input,
        createMockConvergenceEvent({ walletCount: 3, convictionScore: 50, avgQualityWeight: 0.95 }),
      );
      // 60 + 0 + 5 = 65

      // Low quality weight (0.5 ≤ 0.8 → no bonus)
      const lowResult = await scoreSmartMoneyConvergence(
        input,
        createMockConvergenceEvent({ walletCount: 3, convictionScore: 50, avgQualityWeight: 0.5 }),
      );
      // 60 + 0 + 0 = 60

      expect(highResult.score).toBeGreaterThan(lowResult.score);
      expect(highResult.score).toBe(65);
      expect(lowResult.score).toBe(60);
    });

    it('does not add bonus at exactly avgQualityWeight = 0.8 (not strictly greater)', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 3 }),
        createMockConvergenceEvent({ walletCount: 3, convictionScore: 50, avgQualityWeight: 0.8 }),
      );

      // 0.8 is NOT > 0.8, so no bonus
      // 60 + 0 + 0 = 60
      expect(result.score).toBe(60);
    });

    it('adds bonus at avgQualityWeight = 0.81 (just above threshold)', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 3 }),
        createMockConvergenceEvent({ walletCount: 3, convictionScore: 50, avgQualityWeight: 0.81 }),
      );

      // 0.81 > 0.8, so +5 bonus
      // 60 + 0 + 5 = 65
      expect(result.score).toBe(65);
    });
  });

  // =========================================================================
  // Phase 7: Mixed-Quality Wallet Classification Weighting
  // =========================================================================

  describe('mixed wallet classification weighting', () => {
    it('scores highest with all smart_money wallets (quality ~1.0)', async () => {
      const input = createMockInput({ smartMoneyCount: 3 });
      const allSmartMoney = createMockConvergenceEvent({
        wallets: [
          { address: 'w1', classification: 'smart_money', positionSize: 1000, entryTimestamp: Date.now() - 1_800_000 },
          { address: 'w2', classification: 'smart_money', positionSize: 1200, entryTimestamp: Date.now() - 1_200_000 },
          { address: 'w3', classification: 'smart_money', positionSize: 1100, entryTimestamp: Date.now() - 600_000 },
        ],
        walletCount: 3,
        avgQualityWeight: 1.0,
        convictionScore: 90,
      });
      const result = await scoreSmartMoneyConvergence(input, allSmartMoney);

      // (60 + 0 + 5) * 1.3 = 84.5 → 85
      expect(result.score).toBe(85);
    });

    it('scores lower with mixed wallet types (lower avgQualityWeight)', async () => {
      const input = createMockInput({ smartMoneyCount: 3 });

      const mixedWallets = createMockConvergenceEvent({
        wallets: [
          { address: 'w1', classification: 'smart_money', positionSize: 1000, entryTimestamp: Date.now() - 1_800_000 },
          { address: 'w2', classification: 'whale', positionSize: 2000, entryTimestamp: Date.now() - 1_200_000 },
          { address: 'w3', classification: 'sniper', positionSize: 500, entryTimestamp: Date.now() - 600_000 },
        ],
        walletCount: 3,
        avgQualityWeight: 0.6,  // lower quality due to mixed classifications
        convictionScore: 90,
      });
      const mixedResult = await scoreSmartMoneyConvergence(input, mixedWallets);
      // (60 + 0 + 0) * 1.3 = 78  (0.6 ≤ 0.8, no quality bonus)

      const allSmartResult = await scoreSmartMoneyConvergence(
        input,
        createMockConvergenceEvent({ walletCount: 3, avgQualityWeight: 1.0, convictionScore: 90 }),
      );
      // (60 + 0 + 5) * 1.3 = 84.5 → 85

      expect(allSmartResult.score).toBeGreaterThan(mixedResult.score);
      expect(mixedResult.score).toBe(78);
      expect(allSmartResult.score).toBe(85);
    });
  });

  // =========================================================================
  // Phase 8: Null / Undefined ConvergenceEvent Handling
  // =========================================================================

  describe('null/undefined convergenceEvent fallback', () => {
    it('falls back to basic scoring when convergenceEvent is null', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 2 }),
        null,
      );

      expect(result.score).toBe(25);
      expect(result.metadata.source).toBe('basic');
      expect(result.metadata.convergenceDetected).toBe(false);
    });

    it('falls back to basic scoring when convergenceEvent is undefined', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 1 }),
        undefined,
      );

      expect(result.score).toBe(10);
      expect(result.metadata.source).toBe('basic');
    });

    it('falls back to basic scoring when convergenceEvent parameter is omitted', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 2 }),
      );

      expect(result.score).toBe(25);
      expect(result.metadata.source).toBe('basic');
    });

    it('null convergenceEvent with 0 wallets returns score 0', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 0 }),
        null,
      );

      expect(result.score).toBe(0);
    });
  });

  // =========================================================================
  // Phase 9: Metadata Validation
  // =========================================================================

  describe('metadata validation', () => {
    it('includes all expected fields in basic mode', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 2 }),
      );

      expect(result.metadata).toHaveProperty('smartMoneyCount');
      expect(result.metadata).toHaveProperty('convergenceDetected');
      expect(result.metadata).toHaveProperty('convergenceWalletCount');
      expect(result.metadata).toHaveProperty('convictionScore');
      expect(result.metadata).toHaveProperty('avgQualityWeight');
      expect(result.metadata).toHaveProperty('source');
    });

    it('includes all expected fields in convergence mode', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 3 }),
        createMockConvergenceEvent(),
      );

      expect(result.metadata).toHaveProperty('smartMoneyCount');
      expect(result.metadata).toHaveProperty('convergenceDetected');
      expect(result.metadata).toHaveProperty('convergenceWalletCount');
      expect(result.metadata).toHaveProperty('convictionScore');
      expect(result.metadata).toHaveProperty('avgQualityWeight');
      expect(result.metadata).toHaveProperty('source');
      expect(result.metadata).toHaveProperty('extraWalletBonus');
      expect(result.metadata).toHaveProperty('convictionMultiplierApplied');
    });

    it('shows source="basic" in basic mode', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 1 }),
      );
      expect(result.metadata.source).toBe('basic');
    });

    it('shows source="convergence-detector" in convergence mode', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 3 }),
        createMockConvergenceEvent(),
      );
      expect(result.metadata.source).toBe('convergence-detector');
    });

    it('reports correct convergenceWalletCount in convergence metadata', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 5 }),
        createMockConvergenceEvent({ walletCount: 5 }),
      );
      expect(result.metadata.convergenceWalletCount).toBe(5);
    });

    it('reports correct convictionScore in convergence metadata', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 3 }),
        createMockConvergenceEvent({ convictionScore: 92 }),
      );
      expect(result.metadata.convictionScore).toBe(92);
    });

    it('reports correct avgQualityWeight in convergence metadata', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 3 }),
        createMockConvergenceEvent({ avgQualityWeight: 0.87 }),
      );
      expect(result.metadata.avgQualityWeight).toBe(0.87);
    });

    it('sets convergenceDetected=false and convergenceWalletCount=0 in basic mode', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 2 }),
      );
      expect(result.metadata.convergenceDetected).toBe(false);
      expect(result.metadata.convergenceWalletCount).toBe(0);
      expect(result.metadata.convictionScore).toBe(0);
      expect(result.metadata.avgQualityWeight).toBe(0);
    });

    it('sets convergenceDetected=true in convergence mode', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 3 }),
        createMockConvergenceEvent(),
      );
      expect(result.metadata.convergenceDetected).toBe(true);
    });

    it('reports smartMoneyCount from input in basic mode', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 7 }),
      );
      expect(result.metadata.smartMoneyCount).toBe(7);
    });

    it('reports smartMoneyCount from input in convergence mode', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 4 }),
        createMockConvergenceEvent(),
      );
      expect(result.metadata.smartMoneyCount).toBe(4);
    });
  });

  // =========================================================================
  // Phase 10: Error Handling
  // =========================================================================

  describe('error handling', () => {
    it('returns score 0 with error metadata when convergence scoring throws', async () => {
      const input = createMockInput({ smartMoneyCount: 2 });

      // Create a convergence event with a getter on walletCount that throws
      const badEvent: Partial<ConvergenceEvent> = {
        token: 'errorMint',
        wallets: [],
        windowStart: Date.now() - 3_600_000,
        windowEnd: Date.now(),
        convictionScore: 50,
        avgQualityWeight: 0.5,
      };
      Object.defineProperty(badEvent, 'walletCount', {
        get() {
          throw new Error('Simulated scoring failure');
        },
        configurable: true,
      });

      const result = await scoreSmartMoneyConvergence(
        input,
        badEvent as ConvergenceEvent,
      );

      expect(result.score).toBe(0);
      expect(result.name).toBe('smartMoneyConvergence');
      expect(result.weight).toBe(0);
      expect(result.metadata.error).toBeDefined();
      expect(String(result.metadata.error)).toContain('Simulated scoring failure');
      expect(result.metadata.convergenceDetected).toBe(false);
      expect(result.metadata.source).toBe('error-fallback');
    });

    it('preserves smartMoneyCount in error metadata when input is accessible', async () => {
      const input = createMockInput({ smartMoneyCount: 5 });

      const badEvent: Partial<ConvergenceEvent> = {
        token: 'errorMint',
        wallets: [],
        windowStart: 0,
        windowEnd: 0,
        convictionScore: 0,
        avgQualityWeight: 0,
      };
      Object.defineProperty(badEvent, 'walletCount', {
        get() {
          throw new Error('Access error');
        },
        configurable: true,
      });

      const result = await scoreSmartMoneyConvergence(
        input,
        badEvent as ConvergenceEvent,
      );

      expect(result.metadata.smartMoneyCount).toBe(5);
    });

    it('does not throw — always resolves the promise', async () => {
      const badEvent: Partial<ConvergenceEvent> = {
        token: 'err',
        wallets: [],
        windowStart: 0,
        windowEnd: 0,
        convictionScore: 0,
        avgQualityWeight: 0,
      };
      Object.defineProperty(badEvent, 'walletCount', {
        get() {
          throw new TypeError('Unexpected Proxy error');
        },
        configurable: true,
      });

      // Must not throw — should resolve to a valid FactorResult
      await expect(
        scoreSmartMoneyConvergence(createMockInput(), badEvent as ConvergenceEvent),
      ).resolves.toBeDefined();
    });
  });

  // =========================================================================
  // Composite scenario: Combined bonuses
  // =========================================================================

  describe('composite scoring scenarios', () => {
    it('combines wallet bonus + quality bonus + conviction multiplier', async () => {
      const result = await scoreSmartMoneyConvergence(
        createMockInput({ smartMoneyCount: 5 }),
        createMockConvergenceEvent({
          walletCount: 5,
          avgQualityWeight: 0.95,
          convictionScore: 90,
        }),
      );

      // Base 60 + extraWallets (2*5=10) + qualityBonus (5) = 75
      // Then × 1.3 = 97.5 → 98
      expect(result.score).toBe(98);
    });

    it('convergence event always scores higher than basic mode for same wallet count', async () => {
      const input3 = createMockInput({ smartMoneyCount: 3 });

      const basicResult = await scoreSmartMoneyConvergence(input3);
      // Basic: 50

      const convergenceResult = await scoreSmartMoneyConvergence(
        input3,
        createMockConvergenceEvent({ walletCount: 3, convictionScore: 50, avgQualityWeight: 0.5 }),
      );
      // Convergence: 60

      expect(convergenceResult.score).toBeGreaterThan(basicResult.score);
    });
  });
});
