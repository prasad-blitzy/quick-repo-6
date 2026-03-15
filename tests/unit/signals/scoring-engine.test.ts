/**
 * @file tests/unit/signals/scoring-engine.test.ts
 * @description Comprehensive unit tests for the composite signal scoring engine.
 *
 * Covers:
 *  - Promise.allSettled parallelism across 7 factor modules
 *  - Failed/rejected factor handling with score-0 fail-safe
 *  - Weighted sum computation with configurable weights and normalization
 *  - Conservative (≥80) and aggressive (≥45) trading-mode threshold decisions
 *  - Hard filter gate execution before factor modules
 *  - CompositeSignal structure correctness
 *  - Edge cases and input validation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// Module Mocks — hoisted above all imports by Vitest
// ============================================================

vi.mock('../../../src/signals/hard-filters', () => ({
  runHardFilters: vi.fn(),
}));

vi.mock('../../../src/signals/factors/volume-spike', () => ({
  scoreVolumeSpike: vi.fn(),
}));

vi.mock('../../../src/signals/factors/smart-money-convergence', () => ({
  scoreSmartMoneyConvergence: vi.fn(),
}));

vi.mock('../../../src/signals/factors/buy-sell-ratio', () => ({
  scoreBuySellRatio: vi.fn(),
}));

vi.mock('../../../src/signals/factors/holder-growth', () => ({
  scoreHolderGrowth: vi.fn(),
}));

vi.mock('../../../src/signals/factors/liquidity', () => ({
  scoreLiquidity: vi.fn(),
}));

vi.mock('../../../src/signals/factors/token-age', () => ({
  scoreTokenAge: vi.fn(),
}));

vi.mock('../../../src/signals/factors/safety-score', () => ({
  scoreSafetyScore: vi.fn(),
}));

vi.mock('../../../src/utils/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../../../src/utils/config', () => ({
  DEFAULT_SCORING_WEIGHTS: {
    volumeSpike: 0.20,
    smartMoneyConvergence: 0.20,
    buySellRatio: 0.15,
    holderGrowth: 0.10,
    liquidity: 0.10,
    tokenAge: 0.10,
    safetyScore: 0.15,
  },
  SCORING_THRESHOLDS: {
    CONSERVATIVE_MIN: 80,
    AGGRESSIVE_MIN: 45,
  },
}));

// ============================================================
// Imports — module-under-test and mocked dependencies
// ============================================================

import { analyzeToken, createSkipSignal, normalizeWeights } from '../../../src/signals/scoring-engine';
import type {
  TokenAnalysisInput,
  CompositeSignal,
  FactorResult,
  ScoringWeights,
  TradingMode,
  HardFilterResult,
} from '../../../src/signals/types';

import { runHardFilters } from '../../../src/signals/hard-filters';
import { scoreVolumeSpike } from '../../../src/signals/factors/volume-spike';
import { scoreSmartMoneyConvergence } from '../../../src/signals/factors/smart-money-convergence';
import { scoreBuySellRatio } from '../../../src/signals/factors/buy-sell-ratio';
import { scoreHolderGrowth } from '../../../src/signals/factors/holder-growth';
import { scoreLiquidity } from '../../../src/signals/factors/liquidity';
import { scoreTokenAge } from '../../../src/signals/factors/token-age';
import { scoreSafetyScore } from '../../../src/signals/factors/safety-score';

// ============================================================
// Typed Mock References
// ============================================================

const mockedRunHardFilters = vi.mocked(runHardFilters);
const mockedScoreVolumeSpike = vi.mocked(scoreVolumeSpike);
const mockedScoreSmartMoneyConvergence = vi.mocked(scoreSmartMoneyConvergence);
const mockedScoreBuySellRatio = vi.mocked(scoreBuySellRatio);
const mockedScoreHolderGrowth = vi.mocked(scoreHolderGrowth);
const mockedScoreLiquidity = vi.mocked(scoreLiquidity);
const mockedScoreTokenAge = vi.mocked(scoreTokenAge);
const mockedScoreSafetyScore = vi.mocked(scoreSafetyScore);

// ============================================================
// Mock Data Factory
// ============================================================

/**
 * Creates a valid TokenAnalysisInput for testing with sensible defaults.
 * Override any field by passing a partial object.
 */
function createMockTokenInput(
  overrides?: Partial<TokenAnalysisInput>,
): TokenAnalysisInput {
  return {
    mint: 'TestMint111111111111111111111111111111111111',
    symbol: 'TEST',
    name: 'Test Token',
    price: 0.00001234,
    priceChange5m: 5.0,
    priceChange1h: 15.0,
    priceChange24h: 50.0,
    marketCap: 100000,
    volume5m: 500,
    volume1h: 5000,
    volume24h: 50000,
    liquidity: 25000,
    supply: 1000000000,
    buys1h: 50,
    sells1h: 20,
    buys24h: 500,
    sells24h: 200,
    holderCount: 500,
    topHolderPercent: 15,
    smartMoneyCount: 3,
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    lpBurned: true,
    lpLocked: true,
    lpBurnPercent: 95,
    isHoneypot: false,
    safetyScore: 500,
    metadataMutable: false,
    devWalletAddress: 'Dev11111111111111111111111111111111111111111',
    devWalletSold: false,
    createdAt: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    ...overrides,
  };
}

// ============================================================
// Helpers
// ============================================================

/**
 * Restores all factor mocks to their default resolved values
 * and hard-filters mock to a passing result.
 */
function setupDefaultFactorMocks(): void {
  mockedRunHardFilters.mockReturnValue({
    passed: true,
    failedFilters: [],
    failedReason: null,
    checkedAt: Date.now(),
  });

  mockedScoreVolumeSpike.mockResolvedValue({
    name: 'volumeSpike',
    score: 70,
    weight: 0,
    metadata: {},
  });

  mockedScoreSmartMoneyConvergence.mockResolvedValue({
    name: 'smartMoneyConvergence',
    score: 60,
    weight: 0,
    metadata: {},
  });

  mockedScoreBuySellRatio.mockResolvedValue({
    name: 'buySellRatio',
    score: 65,
    weight: 0,
    metadata: {},
  });

  mockedScoreHolderGrowth.mockResolvedValue({
    name: 'holderGrowth',
    score: 50,
    weight: 0,
    metadata: {},
  });

  mockedScoreLiquidity.mockResolvedValue({
    name: 'liquidity',
    score: 75,
    weight: 0,
    metadata: {},
  });

  mockedScoreTokenAge.mockResolvedValue({
    name: 'tokenAge',
    score: 90,
    weight: 0,
    metadata: {},
  });

  mockedScoreSafetyScore.mockResolvedValue({
    name: 'safetyScore',
    score: 80,
    weight: 0,
    metadata: {},
  });
}

/**
 * Sets every factor mock to resolve with the same score value.
 * Useful for threshold boundary tests where all factors must
 * agree to produce a predictable composite.
 */
function setAllFactorScores(score: number): void {
  mockedScoreVolumeSpike.mockResolvedValue({
    name: 'volumeSpike', score, weight: 0, metadata: {},
  });
  mockedScoreSmartMoneyConvergence.mockResolvedValue({
    name: 'smartMoneyConvergence', score, weight: 0, metadata: {},
  });
  mockedScoreBuySellRatio.mockResolvedValue({
    name: 'buySellRatio', score, weight: 0, metadata: {},
  });
  mockedScoreHolderGrowth.mockResolvedValue({
    name: 'holderGrowth', score, weight: 0, metadata: {},
  });
  mockedScoreLiquidity.mockResolvedValue({
    name: 'liquidity', score, weight: 0, metadata: {},
  });
  mockedScoreTokenAge.mockResolvedValue({
    name: 'tokenAge', score, weight: 0, metadata: {},
  });
  mockedScoreSafetyScore.mockResolvedValue({
    name: 'safetyScore', score, weight: 0, metadata: {},
  });
}

// ============================================================
// Test Suite
// ============================================================

describe('scoring-engine', () => {
  beforeEach(() => {
    setupDefaultFactorMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ----------------------------------------------------------
  // 1. Promise.allSettled Parallelism
  // ----------------------------------------------------------
  describe('Promise.allSettled parallelism', () => {
    it('should call all 7 factor modules when hard filters pass', async () => {
      await analyzeToken(createMockTokenInput());

      expect(mockedScoreVolumeSpike).toHaveBeenCalledTimes(1);
      expect(mockedScoreSmartMoneyConvergence).toHaveBeenCalledTimes(1);
      expect(mockedScoreBuySellRatio).toHaveBeenCalledTimes(1);
      expect(mockedScoreHolderGrowth).toHaveBeenCalledTimes(1);
      expect(mockedScoreLiquidity).toHaveBeenCalledTimes(1);
      expect(mockedScoreTokenAge).toHaveBeenCalledTimes(1);
      expect(mockedScoreSafetyScore).toHaveBeenCalledTimes(1);
    });

    it('should return CompositeSignal with all 7 factor results', async () => {
      const signal = await analyzeToken(createMockTokenInput());

      expect(signal.factors).toHaveLength(7);

      const factorNames = signal.factors.map((f) => f.name);
      expect(factorNames).toContain('volumeSpike');
      expect(factorNames).toContain('smartMoneyConvergence');
      expect(factorNames).toContain('buySellRatio');
      expect(factorNames).toContain('holderGrowth');
      expect(factorNames).toContain('liquidity');
      expect(factorNames).toContain('tokenAge');
      expect(factorNames).toContain('safetyScore');

      // Each name appears exactly once
      const uniqueNames = new Set(factorNames);
      expect(uniqueNames.size).toBe(7);
    });

    it('should pass the same TokenAnalysisInput to all 7 factors', async () => {
      const specificMint = 'SpecificMint22222222222222222222222222222222';
      const input = createMockTokenInput({ mint: specificMint });

      await analyzeToken(input);

      const matcher = expect.objectContaining({ mint: specificMint });
      expect(mockedScoreVolumeSpike).toHaveBeenCalledWith(matcher);
      expect(mockedScoreSmartMoneyConvergence).toHaveBeenCalledWith(matcher);
      expect(mockedScoreBuySellRatio).toHaveBeenCalledWith(matcher);
      expect(mockedScoreHolderGrowth).toHaveBeenCalledWith(matcher);
      expect(mockedScoreLiquidity).toHaveBeenCalledWith(matcher);
      expect(mockedScoreTokenAge).toHaveBeenCalledWith(matcher);
      expect(mockedScoreSafetyScore).toHaveBeenCalledWith(matcher);
    });

    it('should execute all 7 factors concurrently, not sequentially', async () => {
      const callTimestamps: number[] = [];

      const createTimedFactory = (name: string, score: number) => {
        return async (_input: TokenAnalysisInput): Promise<FactorResult> => {
          callTimestamps.push(Date.now());
          // Small async delay to simulate real work
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { name, score, weight: 0, metadata: {} };
        };
      };

      mockedScoreVolumeSpike.mockImplementation(
        createTimedFactory('volumeSpike', 70) as any,
      );
      mockedScoreSmartMoneyConvergence.mockImplementation(
        createTimedFactory('smartMoneyConvergence', 60) as any,
      );
      mockedScoreBuySellRatio.mockImplementation(
        createTimedFactory('buySellRatio', 65) as any,
      );
      mockedScoreHolderGrowth.mockImplementation(
        createTimedFactory('holderGrowth', 50) as any,
      );
      mockedScoreLiquidity.mockImplementation(
        createTimedFactory('liquidity', 75) as any,
      );
      mockedScoreTokenAge.mockImplementation(
        createTimedFactory('tokenAge', 90) as any,
      );
      mockedScoreSafetyScore.mockImplementation(
        createTimedFactory('safetyScore', 80) as any,
      );

      await analyzeToken(createMockTokenInput());

      expect(callTimestamps).toHaveLength(7);

      // If concurrent, all start timestamps should cluster within a few ms.
      // If sequential with 10ms delays, spread would be ≥70ms.
      const timeSpan =
        Math.max(...callTimestamps) - Math.min(...callTimestamps);
      expect(timeSpan).toBeLessThan(20);
    });
  });

  // ----------------------------------------------------------
  // 2. Failed Factor Handling
  // ----------------------------------------------------------
  describe('failed factor handling', () => {
    it('should handle a single rejected factor and still return a valid composite', async () => {
      mockedScoreVolumeSpike.mockRejectedValue(
        new Error('Volume data unavailable'),
      );

      const signal = await analyzeToken(createMockTokenInput());

      expect(signal).toBeDefined();
      expect(signal.factors).toHaveLength(7);

      // Rejected factor must still be represented with score 0
      const volumeFactor = signal.factors.find(
        (f) => f.name === 'volumeSpike',
      );
      expect(volumeFactor).toBeDefined();
      expect(volumeFactor!.score).toBe(0);
      expect(volumeFactor!.metadata).toHaveProperty('error');
    });

    it('should handle multiple rejected factors', async () => {
      mockedScoreVolumeSpike.mockRejectedValue(
        new Error('Volume API down'),
      );
      mockedScoreSmartMoneyConvergence.mockRejectedValue(
        new Error('Tracking unavailable'),
      );

      const signal = await analyzeToken(createMockTokenInput());

      expect(signal).toBeDefined();

      const volumeFactor = signal.factors.find(
        (f) => f.name === 'volumeSpike',
      );
      const smartMoneyFactor = signal.factors.find(
        (f) => f.name === 'smartMoneyConvergence',
      );

      expect(volumeFactor!.score).toBe(0);
      expect(smartMoneyFactor!.score).toBe(0);

      // Composite still computed from remaining 5 successful factors + 2 zeros
      expect(signal.composite).toBeGreaterThan(0);
    });

    it('should handle ALL 7 factors rejecting', async () => {
      mockedScoreVolumeSpike.mockRejectedValue(new Error('fail'));
      mockedScoreSmartMoneyConvergence.mockRejectedValue(new Error('fail'));
      mockedScoreBuySellRatio.mockRejectedValue(new Error('fail'));
      mockedScoreHolderGrowth.mockRejectedValue(new Error('fail'));
      mockedScoreLiquidity.mockRejectedValue(new Error('fail'));
      mockedScoreTokenAge.mockRejectedValue(new Error('fail'));
      mockedScoreSafetyScore.mockRejectedValue(new Error('fail'));

      const signal = await analyzeToken(createMockTokenInput());

      expect(signal).toBeDefined();
      expect(signal.composite).toBe(0);
      expect(signal.decision).toBe('SKIP');
      expect(signal.factors).toHaveLength(7);
      signal.factors.forEach((f) => {
        expect(f.score).toBe(0);
      });
    });

    it('should use Promise.allSettled NOT Promise.all for factor execution', async () => {
      // If Promise.all were used, this rejection would cause the entire call
      // to reject. Promise.allSettled handles it gracefully.
      mockedScoreVolumeSpike.mockRejectedValue(
        new Error('one factor fails'),
      );

      // Must NOT throw — resolves to a valid CompositeSignal
      const signal = await analyzeToken(createMockTokenInput());

      expect(signal).toBeDefined();
      expect(signal.decision).toBeDefined();
    });

    it('rejected factor should receive score 0 in the composite calculation', async () => {
      // Set all factors to exactly 50, then reject volumeSpike
      setAllFactorScores(50);
      mockedScoreVolumeSpike.mockRejectedValue(
        new Error('Volume data unavailable'),
      );

      const signal = await analyzeToken(createMockTokenInput());

      const volumeFactor = signal.factors.find(
        (f) => f.name === 'volumeSpike',
      );
      expect(volumeFactor!.score).toBe(0);

      // Expected composite INCLUDING zero:
      // Mocked weights: vs=0.20, smc=0.20, bsr=0.15, hg=0.10, liq=0.10, ta=0.10, ss=0.15
      // (0*0.20 + 50*0.20 + 50*0.15 + 50*0.10 + 50*0.10 + 50*0.10 + 50*0.15) / 1.0
      // = (0 + 10 + 7.5 + 5 + 5 + 5 + 7.5) = 40
      expect(signal.composite).toBe(40);
    });
  });

  // ----------------------------------------------------------
  // 3. Weighted Sum Computation
  // ----------------------------------------------------------
  describe('weighted sum computation', () => {
    it('should compute weighted average correctly with equal scores', async () => {
      setAllFactorScores(70);

      const signal = await analyzeToken(createMockTokenInput());

      // When all scores are identical, weighted average = that score
      expect(signal.composite).toBe(70);
    });

    it('should compute weighted average correctly with varying scores', async () => {
      mockedScoreVolumeSpike.mockResolvedValue({
        name: 'volumeSpike', score: 100, weight: 0, metadata: {},
      });
      mockedScoreSmartMoneyConvergence.mockResolvedValue({
        name: 'smartMoneyConvergence', score: 80, weight: 0, metadata: {},
      });
      mockedScoreBuySellRatio.mockResolvedValue({
        name: 'buySellRatio', score: 60, weight: 0, metadata: {},
      });
      mockedScoreHolderGrowth.mockResolvedValue({
        name: 'holderGrowth', score: 40, weight: 0, metadata: {},
      });
      mockedScoreLiquidity.mockResolvedValue({
        name: 'liquidity', score: 50, weight: 0, metadata: {},
      });
      mockedScoreTokenAge.mockResolvedValue({
        name: 'tokenAge', score: 90, weight: 0, metadata: {},
      });
      mockedScoreSafetyScore.mockResolvedValue({
        name: 'safetyScore', score: 70, weight: 0, metadata: {},
      });

      const signal = await analyzeToken(createMockTokenInput());

      // (100*0.20 + 80*0.20 + 60*0.15 + 40*0.10 + 50*0.10 + 90*0.10 + 70*0.15)
      // = 20 + 16 + 9 + 4 + 5 + 9 + 10.5 = 73.5 → round to 74
      expect(signal.composite).toBe(74);
    });

    it('should apply custom weights from settings-store', async () => {
      const customWeights: ScoringWeights = {
        volumeSpike: 0.50,
        smartMoneyConvergence: 0.10,
        buySellRatio: 0.10,
        holderGrowth: 0.05,
        liquidity: 0.05,
        tokenAge: 0.10,
        safetyScore: 0.10,
      };

      // First: composite with default weights
      const signalDefault = await analyzeToken(createMockTokenInput());

      // Reset call counts, keep implementations
      vi.clearAllMocks();
      setupDefaultFactorMocks();

      // Second: composite with custom weights
      const signalCustom = await analyzeToken(
        createMockTokenInput(),
        customWeights,
      );

      // Custom weights emphasize volumeSpike (0.50 vs 0.20),
      // producing a different composite
      expect(signalCustom.composite).not.toBe(signalDefault.composite);

      // The factor weights in the returned signal should reflect custom weights
      const vsFactor = signalCustom.factors.find(
        (f) => f.name === 'volumeSpike',
      );
      expect(vsFactor!.weight).toBeCloseTo(0.50);
    });

    it('should normalize weights that do not sum to 1.0', async () => {
      // Weights sum to 2.0 (double the defaults)
      const unnormalizedWeights: ScoringWeights = {
        volumeSpike: 0.40,
        smartMoneyConvergence: 0.40,
        buySellRatio: 0.30,
        holderGrowth: 0.20,
        liquidity: 0.20,
        tokenAge: 0.20,
        safetyScore: 0.30,
      };

      setAllFactorScores(70);

      const signal = await analyzeToken(
        createMockTokenInput(),
        unnormalizedWeights,
      );

      // After normalization, proportions are identical to defaults.
      // 70 * 1.0 / 1.0 = 70 regardless of absolute weight scale.
      expect(signal.composite).toBe(70);
    });

    it('should clamp composite score to 0-100 range', async () => {
      // Extreme high scores
      setAllFactorScores(100);
      const highSignal = await analyzeToken(createMockTokenInput());
      expect(highSignal.composite).toBeLessThanOrEqual(100);
      expect(highSignal.composite).toBeGreaterThanOrEqual(0);

      // Extreme low scores
      vi.clearAllMocks();
      setupDefaultFactorMocks();
      setAllFactorScores(0);
      const lowSignal = await analyzeToken(createMockTokenInput());
      expect(lowSignal.composite).toBeLessThanOrEqual(100);
      expect(lowSignal.composite).toBeGreaterThanOrEqual(0);
    });

    it('composite should always be an integer (rounded)', async () => {
      // Varying scores that produce a non-integer weighted average
      mockedScoreVolumeSpike.mockResolvedValue({
        name: 'volumeSpike', score: 73, weight: 0, metadata: {},
      });
      mockedScoreSmartMoneyConvergence.mockResolvedValue({
        name: 'smartMoneyConvergence', score: 61, weight: 0, metadata: {},
      });
      mockedScoreBuySellRatio.mockResolvedValue({
        name: 'buySellRatio', score: 54, weight: 0, metadata: {},
      });
      mockedScoreHolderGrowth.mockResolvedValue({
        name: 'holderGrowth', score: 48, weight: 0, metadata: {},
      });
      mockedScoreLiquidity.mockResolvedValue({
        name: 'liquidity', score: 82, weight: 0, metadata: {},
      });
      mockedScoreTokenAge.mockResolvedValue({
        name: 'tokenAge', score: 91, weight: 0, metadata: {},
      });
      mockedScoreSafetyScore.mockResolvedValue({
        name: 'safetyScore', score: 67, weight: 0, metadata: {},
      });

      const signal = await analyzeToken(createMockTokenInput());

      expect(Number.isInteger(signal.composite)).toBe(true);
    });

    it('should use DEFAULT_SCORING_WEIGHTS when no custom weights provided', async () => {
      const signal = await analyzeToken(createMockTokenInput());

      // Factor weights in the returned signal must match the mocked defaults
      const volumeFactor = signal.factors.find(
        (f) => f.name === 'volumeSpike',
      );
      const smartMoneyFactor = signal.factors.find(
        (f) => f.name === 'smartMoneyConvergence',
      );
      const buySellFactor = signal.factors.find(
        (f) => f.name === 'buySellRatio',
      );
      const holderFactor = signal.factors.find(
        (f) => f.name === 'holderGrowth',
      );
      const liquidityFactor = signal.factors.find(
        (f) => f.name === 'liquidity',
      );
      const ageFactor = signal.factors.find(
        (f) => f.name === 'tokenAge',
      );
      const safetyFactor = signal.factors.find(
        (f) => f.name === 'safetyScore',
      );

      expect(volumeFactor!.weight).toBeCloseTo(0.20);
      expect(smartMoneyFactor!.weight).toBeCloseTo(0.20);
      expect(buySellFactor!.weight).toBeCloseTo(0.15);
      expect(holderFactor!.weight).toBeCloseTo(0.10);
      expect(liquidityFactor!.weight).toBeCloseTo(0.10);
      expect(ageFactor!.weight).toBeCloseTo(0.10);
      expect(safetyFactor!.weight).toBeCloseTo(0.15);
    });
  });

  // ----------------------------------------------------------
  // 4. Conservative / Aggressive Mode Thresholds
  // ----------------------------------------------------------
  describe('conservative/aggressive mode thresholds', () => {
    it('conservative mode — score 79 should be SKIP', async () => {
      setAllFactorScores(79);

      const signal = await analyzeToken(
        createMockTokenInput(),
        undefined,
        'conservative',
      );

      expect(signal.decision).toBe('SKIP');
      expect(signal.composite).toBe(79);
    });

    it('conservative mode — score 80 should be BUY', async () => {
      setAllFactorScores(80);

      const signal = await analyzeToken(
        createMockTokenInput(),
        undefined,
        'conservative',
      );

      expect(signal.decision).toBe('BUY');
      expect(signal.composite).toBe(80);
    });

    it('conservative mode — score 90 should be BUY', async () => {
      setAllFactorScores(90);

      const signal = await analyzeToken(
        createMockTokenInput(),
        undefined,
        'conservative',
      );

      expect(signal.decision).toBe('BUY');
      expect(signal.composite).toBe(90);
    });

    it('aggressive mode — score 44 should be SKIP', async () => {
      setAllFactorScores(44);

      const signal = await analyzeToken(
        createMockTokenInput(),
        undefined,
        'aggressive',
      );

      expect(signal.decision).toBe('SKIP');
      expect(signal.composite).toBe(44);
    });

    it('aggressive mode — score 45 should be BUY', async () => {
      setAllFactorScores(45);

      const signal = await analyzeToken(
        createMockTokenInput(),
        undefined,
        'aggressive',
      );

      expect(signal.decision).toBe('BUY');
      expect(signal.composite).toBe(45);
    });

    it('aggressive mode — score 60 should be BUY', async () => {
      setAllFactorScores(60);

      const signal = await analyzeToken(
        createMockTokenInput(),
        undefined,
        'aggressive',
      );

      expect(signal.decision).toBe('BUY');
    });

    it('should default to conservative mode when no tradingMode specified', async () => {
      // 70 is below conservative threshold of 80
      setAllFactorScores(70);

      const signal = await analyzeToken(createMockTokenInput());

      expect(signal.decision).toBe('SKIP');
      expect(signal.tradingMode).toBe('conservative');
    });

    it('should record the tradingMode in the CompositeSignal', async () => {
      const signal = await analyzeToken(
        createMockTokenInput(),
        undefined,
        'aggressive',
      );

      expect(signal.tradingMode).toBe('aggressive');
    });
  });

  // ----------------------------------------------------------
  // 5. Hard Filters Running Before Factors
  // ----------------------------------------------------------
  describe('hard filters running before factors', () => {
    it('should run hard filters BEFORE any factor modules', async () => {
      const callOrder: string[] = [];

      mockedRunHardFilters.mockImplementation((() => {
        callOrder.push('hardFilters');
        return {
          passed: true,
          failedFilters: [],
          failedReason: null,
          checkedAt: Date.now(),
        };
      }) as any);

      mockedScoreVolumeSpike.mockImplementation((async () => {
        callOrder.push('volumeSpike');
        return { name: 'volumeSpike', score: 70, weight: 0, metadata: {} };
      }) as any);
      mockedScoreSmartMoneyConvergence.mockImplementation((async () => {
        callOrder.push('smartMoneyConvergence');
        return { name: 'smartMoneyConvergence', score: 60, weight: 0, metadata: {} };
      }) as any);
      mockedScoreBuySellRatio.mockImplementation((async () => {
        callOrder.push('buySellRatio');
        return { name: 'buySellRatio', score: 65, weight: 0, metadata: {} };
      }) as any);
      mockedScoreHolderGrowth.mockImplementation((async () => {
        callOrder.push('holderGrowth');
        return { name: 'holderGrowth', score: 50, weight: 0, metadata: {} };
      }) as any);
      mockedScoreLiquidity.mockImplementation((async () => {
        callOrder.push('liquidity');
        return { name: 'liquidity', score: 75, weight: 0, metadata: {} };
      }) as any);
      mockedScoreTokenAge.mockImplementation((async () => {
        callOrder.push('tokenAge');
        return { name: 'tokenAge', score: 90, weight: 0, metadata: {} };
      }) as any);
      mockedScoreSafetyScore.mockImplementation((async () => {
        callOrder.push('safetyScore');
        return { name: 'safetyScore', score: 80, weight: 0, metadata: {} };
      }) as any);

      await analyzeToken(createMockTokenInput());

      // Hard filters must be the first call
      expect(callOrder[0]).toBe('hardFilters');
      // All subsequent entries must be factor names, not hardFilters
      for (let i = 1; i < callOrder.length; i++) {
        expect(callOrder[i]).not.toBe('hardFilters');
      }
    });

    it('should return SKIP immediately when hard filters fail', async () => {
      mockedRunHardFilters.mockReturnValue({
        passed: false,
        failedFilters: ['mint-authority-active'],
        failedReason:
          'Failed 1 hard filter(s): mint-authority-active',
        checkedAt: Date.now(),
      });

      const signal = await analyzeToken(createMockTokenInput());

      expect(signal.decision).toBe('SKIP');
      expect(signal.composite).toBe(0);
    });

    it('should NOT call any factor modules when hard filters fail', async () => {
      mockedRunHardFilters.mockReturnValue({
        passed: false,
        failedFilters: ['mint-authority-active'],
        failedReason:
          'Failed 1 hard filter(s): mint-authority-active',
        checkedAt: Date.now(),
      });

      await analyzeToken(createMockTokenInput());

      expect(mockedScoreVolumeSpike).not.toHaveBeenCalled();
      expect(mockedScoreSmartMoneyConvergence).not.toHaveBeenCalled();
      expect(mockedScoreBuySellRatio).not.toHaveBeenCalled();
      expect(mockedScoreHolderGrowth).not.toHaveBeenCalled();
      expect(mockedScoreLiquidity).not.toHaveBeenCalled();
      expect(mockedScoreTokenAge).not.toHaveBeenCalled();
      expect(mockedScoreSafetyScore).not.toHaveBeenCalled();
    });

    it('should include hardFilterResult in the returned CompositeSignal', async () => {
      const checkedAt = 1234567890;
      mockedRunHardFilters.mockReturnValue({
        passed: true,
        failedFilters: [],
        failedReason: null,
        checkedAt,
      });

      const signal = await analyzeToken(createMockTokenInput());

      expect(signal.hardFilterResult.passed).toBe(true);
      expect(signal.hardFilterResult.checkedAt).toBe(checkedAt);
    });

    it('should include failed hard filter reason in SKIP signal', async () => {
      mockedRunHardFilters.mockReturnValue({
        passed: false,
        failedFilters: ['mint-authority-active', 'min-liquidity'],
        failedReason:
          'Failed 2 hard filter(s): mint-authority-active, min-liquidity',
        checkedAt: Date.now(),
      });

      const signal = await analyzeToken(createMockTokenInput());

      expect(signal.hardFilterResult.passed).toBe(false);
      expect(signal.hardFilterResult.failedReason).toContain(
        'mint-authority-active',
      );
      expect(signal.hardFilterResult.failedFilters).toContain(
        'mint-authority-active',
      );
      expect(signal.hardFilterResult.failedFilters).toContain(
        'min-liquidity',
      );
    });

    it('should pass TokenAnalysisInput to runHardFilters', async () => {
      const specificMint =
        'SpecificTestMint33333333333333333333333333333';

      await analyzeToken(createMockTokenInput({ mint: specificMint }));

      expect(mockedRunHardFilters).toHaveBeenCalledWith(
        expect.objectContaining({ mint: specificMint }),
      );
    });
  });

  // ----------------------------------------------------------
  // 6. CompositeSignal Structure Validation
  // ----------------------------------------------------------
  describe('CompositeSignal structure', () => {
    it('should return all required CompositeSignal fields', async () => {
      const signal = await analyzeToken(createMockTokenInput());

      expect(signal).toHaveProperty('tokenMint');
      expect(signal).toHaveProperty('composite');
      expect(signal).toHaveProperty('factors');
      expect(signal).toHaveProperty('decision');
      expect(signal).toHaveProperty('confidence');
      expect(signal).toHaveProperty('timestamp');
      expect(signal).toHaveProperty('tradingMode');
      expect(signal).toHaveProperty('hardFilterResult');
    });

    it('tokenMint should match input.mint', async () => {
      const mint = 'MyMint123456789012345678901234567890123456';
      const signal = await analyzeToken(createMockTokenInput({ mint }));

      expect(signal.tokenMint).toBe(mint);
    });

    it('timestamp should be a valid Unix timestamp in milliseconds', async () => {
      const before = Date.now();
      const signal = await analyzeToken(createMockTokenInput());
      const after = Date.now();

      expect(signal.timestamp).toBeGreaterThan(0);
      expect(signal.timestamp).toBeGreaterThanOrEqual(before);
      expect(signal.timestamp).toBeLessThanOrEqual(after);
    });

    it('confidence should be between 0 and 1', async () => {
      const signal = await analyzeToken(createMockTokenInput());

      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
    });
  });

  // ----------------------------------------------------------
  // 7. Edge Cases and Input Validation
  // ----------------------------------------------------------
  describe('edge cases and input validation', () => {
    it('should return SKIP for null input', async () => {
      const signal = await analyzeToken(
        null as unknown as TokenAnalysisInput,
      );

      expect(signal.decision).toBe('SKIP');
      expect(signal.composite).toBe(0);
    });

    it('should return SKIP for undefined input', async () => {
      const signal = await analyzeToken(
        undefined as unknown as TokenAnalysisInput,
      );

      expect(signal.decision).toBe('SKIP');
      expect(signal.composite).toBe(0);
    });

    it('should return SKIP for input with missing mint', async () => {
      const signal = await analyzeToken(
        { ...createMockTokenInput(), mint: '' } as TokenAnalysisInput,
      );

      expect(signal.decision).toBe('SKIP');
    });

    it('confidence should be lower when factors fail', async () => {
      // Baseline confidence — all 7 factors successful
      const fullSignal = await analyzeToken(createMockTokenInput());

      // Reset and re-run with 3 out of 7 factors rejected
      vi.clearAllMocks();
      setupDefaultFactorMocks();
      mockedScoreVolumeSpike.mockRejectedValue(new Error('fail'));
      mockedScoreSmartMoneyConvergence.mockRejectedValue(new Error('fail'));
      mockedScoreBuySellRatio.mockRejectedValue(new Error('fail'));

      const partialSignal = await analyzeToken(createMockTokenInput());

      // With incomplete data, confidence must decrease
      expect(partialSignal.confidence).toBeLessThan(
        fullSignal.confidence,
      );
      // Sanity: confidence is meaningfully reduced
      expect(partialSignal.confidence).toBeLessThan(0.80);
    });
  });
});
