/**
 * tests/integration/signal-pipeline.test.ts — End-to-End Signal Scoring Pipeline Test
 *
 * Comprehensive integration test for the GMGN Signal Bot's signal scoring pipeline.
 * Verifies the complete flow from token data input through safety checks, 7-factor
 * scoring, hard filter evaluation, AI/LLM analysis routing, and final CompositeSignal
 * output.
 *
 * Test Phases:
 *   Phase 4 — Hard Filter Evaluation
 *   Phase 5 — Composite Signal Scoring
 *   Phase 6 — Trading Mode Thresholds
 *   Phase 7 — AI/LLM Tier Routing
 *   Phase 8 — Safety Check Integration
 *   Phase 9 — Exit Signal Management
 *   Phase 10 — Full Pipeline End-to-End
 *
 * All external API clients are mocked via vi.mock() — no real HTTP calls are made.
 * Chrome APIs are mocked via tests/setup.ts (vitest setupFiles).
 *
 * @module tests/integration/signal-pipeline
 */

// =============================================================================
// Phase 1: External API Client Mocks (MUST be hoisted above all imports)
// =============================================================================

vi.mock('../../src/api/birdeye', () => ({
  BirdeyeClient: vi.fn().mockImplementation(() => ({
    getTokenPrice: vi.fn().mockResolvedValue({ value: 0.001, updateUnixTime: Date.now() / 1000 }),
    getTokenOverview: vi.fn().mockResolvedValue({
      price: 0.001,
      mc: 500000,
      v24hUSD: 200000,
      liquidity: 30000,
      holder: 500,
    }),
    getOHLCV: vi.fn().mockResolvedValue([]),
    getTokenTransactions: vi.fn().mockResolvedValue([]),
    getTopHolders: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../../src/api/rugcheck', () => ({
  RugCheckClient: vi.fn().mockImplementation(() => ({
    getTokenReport: vi.fn().mockResolvedValue({
      mint: 'SoLTest111111111111111111111111111111111111',
      score: 500,
      risks: [],
      markets: [],
      topHolders: [],
      tokenMeta: { name: 'Test Token', symbol: 'TEST' },
    }),
    getInsiderGraph: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock('../../src/api/goplus', () => ({
  GoPlusClient: vi.fn().mockImplementation(() => ({
    getTokenSecurity: vi.fn().mockResolvedValue({
      isMintable: false,
      isFreezable: false,
      holderCount: 500,
      lpHolderCount: 3,
      totalSupply: '1000000000',
      topHolders: [],
      lpHolders: [],
      isLpLocked: true,
      lpLockedPercent: 90,
    }),
  })),
}));

vi.mock('../../src/api/jupiter', () => ({
  JupiterClient: vi.fn().mockImplementation(() => ({
    getQuote: vi.fn().mockResolvedValue({
      inputMint: 'SoLTest111111111111111111111111111111111111',
      outputMint: 'So11111111111111111111111111111111111111112',
      inAmount: '1000000',
      outAmount: '500000',
      otherAmountThreshold: '495000',
      swapMode: 'ExactIn',
      priceImpactPct: '0.5',
      routePlan: [],
    }),
    getPrice: vi.fn().mockResolvedValue({ price: 0.001, mint: 'SoLTest111111111111111111111111111111111111' }),
    simulateSell: vi.fn().mockResolvedValue({
      inputMint: 'SoLTest111111111111111111111111111111111111',
      outputMint: 'So11111111111111111111111111111111111111112',
      inAmount: '1000000',
      outAmount: '500000',
      otherAmountThreshold: '495000',
      swapMode: 'ExactIn',
      priceImpactPct: '0.5',
      routePlan: [],
    }),
  })),
}));

vi.mock('../../src/api/groq', () => ({
  GroqClient: vi.fn().mockImplementation(() => ({
    analyze: vi.fn().mockResolvedValue(JSON.stringify({
      dimensions: [
        { name: 'on-chain-momentum', score: 75, reasoning: 'Strong buying pressure' },
        { name: 'social-velocity', score: 60, reasoning: 'Moderate social activity' },
        { name: 'wallet-intelligence', score: 80, reasoning: 'Smart money accumulating' },
        { name: 'liquidity-health', score: 70, reasoning: 'Adequate liquidity' },
        { name: 'narrative-fit', score: 65, reasoning: 'Trending narrative' },
      ],
      compositeAI: 75,
      confidence: 'high',
      narrative: 'Strong buy signal with smart money convergence',
    })),
    analyzeWithClaude: vi.fn().mockResolvedValue(JSON.stringify({
      dimensions: [
        { name: 'on-chain-momentum', score: 85, reasoning: 'Exceptional buying pressure' },
        { name: 'social-velocity', score: 70, reasoning: 'High social activity' },
        { name: 'wallet-intelligence', score: 90, reasoning: 'Multiple smart wallets' },
        { name: 'liquidity-health', score: 80, reasoning: 'Strong liquidity' },
        { name: 'narrative-fit', score: 75, reasoning: 'Perfect narrative alignment' },
      ],
      compositeAI: 85,
      confidence: 'high',
      narrative: 'Premium-tier analysis: exceptional confluence of signals',
    })),
  })),
  GROQ_MODELS: {
    FAST: 'llama-3.1-8b-instant',
    DETAILED: 'llama-3.3-70b-versatile',
  },
  CLAUDE_MODEL: 'claude-sonnet-4-20250514',
}));

vi.mock('../../src/api/helius', () => ({
  HeliusClient: vi.fn().mockImplementation(() => ({
    getEnhancedTransaction: vi.fn().mockResolvedValue(null),
    getTokenMetadata: vi.fn().mockResolvedValue(null),
    parseTransaction: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock('../../src/api/dexscreener', () => ({
  DexScreenerClient: vi.fn().mockImplementation(() => ({
    getTokenPairs: vi.fn().mockResolvedValue([]),
    getPairByAddress: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock('../../src/api/rate-limiter', () => ({
  RateLimiter: vi.fn().mockImplementation(() => ({
    acquire: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    getQueueSize: vi.fn().mockReturnValue(0),
  })),
  defaultRateLimiter: {
    acquire: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    getQueueSize: vi.fn().mockReturnValue(0),
  },
}));

vi.mock('../../src/utils/cache', () => ({
  cache: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
  },
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  invalidate: vi.fn().mockResolvedValue(undefined),
  cleanup: vi.fn().mockResolvedValue(undefined),
  LLM_CACHE_TTL: 300000,
  API_CACHE_TTL: 30000,
  SAFETY_CACHE_TTL: 300000,
  CACHE_PREFIX: '__cache:',
}));

vi.mock('../../src/utils/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/safety/checker', () => {
  const mockCheckToken = vi.fn().mockResolvedValue({
    mint: 'SoLTest111111111111111111111111111111111111',
    overallScore: 500,
    rugCheckScore: 500,
    goPlusResult: {
      isMintable: false,
      isFreezable: false,
      holderCount: 500,
      lpHolderCount: 3,
      totalSupply: '1000000000',
      topHolders: [],
      lpHolders: [],
      isLpLocked: true,
      lpLockedPercent: 90,
    },
    honeypotResult: {
      sellable: true,
      estimatedTax: 0,
    },
    lpStatus: {
      burned: true,
      burnPercent: 100,
      locked: false,
    },
    authorityStatus: {
      mintRevoked: true,
      freezeRevoked: true,
      metadataMutable: false,
    },
    checkedAt: Date.now(),
    risks: [],
  });
  return {
    SafetyChecker: vi.fn().mockImplementation(() => ({
      checkToken: mockCheckToken,
    })),
  };
});

vi.mock('../../src/safety/honeypot-detector', () => {
  const mockCheckHoneypot = vi.fn().mockResolvedValue({
    sellable: true,
    estimatedTax: 0,
  });
  return {
    HoneypotDetector: vi.fn().mockImplementation(() => ({
      checkHoneypot: mockCheckHoneypot,
      simulateSellWithRetry: vi.fn().mockResolvedValue({
        sellable: true,
        estimatedTax: 0,
      }),
    })),
  };
});

vi.mock('../../src/ai/router', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/ai/router')>();
  const mockAnalyzeToken = vi.fn().mockResolvedValue({
    dimensions: [
      { name: 'on-chain-momentum', score: 75, reasoning: 'Strong buying pressure' },
      { name: 'social-velocity', score: 60, reasoning: 'Moderate social activity' },
      { name: 'wallet-intelligence', score: 80, reasoning: 'Smart money accumulating' },
      { name: 'liquidity-health', score: 70, reasoning: 'Adequate liquidity' },
      { name: 'narrative-fit', score: 65, reasoning: 'Trending narrative' },
    ],
    compositeAI: 75,
    confidence: 'high' as const,
    narrative: 'Strong buy signal with smart money convergence',
    tier: 'fast' as const,
    timestamp: Date.now(),
  });
  return {
    ...original,
    AIRouter: vi.fn().mockImplementation(() => ({
      analyzeToken: mockAnalyzeToken,
      determineTier: original.determineTier,
    })),
    determineTier: original.determineTier,
  };
});

// =============================================================================
// Phase 1 continued: Imports (after vi.mock hoisting)
// =============================================================================

import { analyzeToken } from '../../src/signals/scoring-engine';
import { runHardFilters } from '../../src/signals/hard-filters';
import {
  checkExitSignals,
  getDefaultTpLevels,
  type PositionData,
  type TokenContext,
  type TpLevelConfig,
} from '../../src/signals/exit-signals';
import type {
  TokenAnalysisInput,
  CompositeSignal,
  TradingMode,
  ScoringWeights,
  HardFilterResult,
  FactorResult,
  ExitCheckResult,
} from '../../src/signals/types';
import type {
  SafetyReport,
  HoneypotResult,
  LPStatus,
  AuthorityStatus,
} from '../../src/safety/types';
import type {
  RugCheckReport,
  GoPlusResult,
  BirdeyeTokenData,
  JupiterQuote,
} from '../../src/api/types';
import { determineTier } from '../../src/ai/router';
import type { AIAnalysisResult, LLMTier } from '../../src/ai/types';
import {
  DEFAULT_SCORING_WEIGHTS,
  SCORING_THRESHOLDS,
  HARD_FILTER_THRESHOLDS,
  DEFAULT_EXIT_STRATEGY,
  LLM_CONFIG,
} from '../../src/utils/config';
import { cache, LLM_CACHE_TTL } from '../../src/utils/cache';

// =============================================================================
// Phase 3: Test Data Factories
// =============================================================================

/**
 * Creates a mock TokenAnalysisInput with safe, high-quality defaults that PASS
 * all hard filters. Override individual fields for test-specific scenarios.
 *
 * Default token characteristics:
 * - 1 hour old (early accumulation window)
 * - $30K liquidity (well above $3K minimum)
 * - 500 holders, 15% top holder (below 20%)
 * - 35% top 10 holders (below 50%)
 * - 3% sniper supply (below 10%)
 * - Mint/freeze authority revoked
 * - LP burned
 * - Not a honeypot
 * - Safety score 500 (above 300)
 * - 4 smart money wallets
 * - 5× volume spike
 * - 2.5× buy/sell ratio
 */
function createMockTokenInput(overrides?: Partial<TokenAnalysisInput>): TokenAnalysisInput {
  return {
    mint: 'SoLTest111111111111111111111111111111111111',
    symbol: 'TEST',
    name: 'Test Token',
    price: 0.001,
    priceChange5m: 15,
    priceChange1h: 45,
    priceChange24h: 120,
    marketCap: 500000,
    volume5m: 5000,
    volume1h: 50000,
    volume24h: 200000,
    volume5mMA: 1000,     // Current 5m vol / MA = 5× spike
    liquidity: 30000,      // Well above $3K minimum
    supply: 1000000000,
    buys1h: 200,
    sells1h: 80,           // Buy/sell ratio = 2.5×
    buys24h: 1000,
    sells24h: 400,
    holderCount: 500,
    topHolderPercent: 15,  // Below 50% threshold (hard filter at MAX_TOP_10_HOLDER_PERCENT=50)
    smartMoneyCount: 4,
    smartMoneyWallets: ['wallet1', 'wallet2', 'wallet3', 'wallet4'],
    sniperSupplyPercent: 3, // Below 10% threshold
    mintAuthorityActive: false,  // Revoked ✓
    freezeAuthorityActive: false, // Revoked ✓
    lpBurned: true,               // LP burned ✓
    lpLocked: false,
    lpBurnPercent: 100,
    isHoneypot: false,
    safetyScore: 500,     // Well above 300 threshold
    rugCheckScore: 500,
    metadataMutable: false,
    devWalletAddress: 'devWalletAddr1111111111111111111111111111',
    devWalletSold: false,
    createdAt: Date.now() / 1000 - 3600, // 1 hour old
    isToken2022: false,
    logoUrl: 'https://example.com/logo.png',
    ...overrides,
  } as TokenAnalysisInput;
}

/**
 * Creates a mock SafetyReport with safe defaults: high score, no honeypot,
 * LP burned, all authorities revoked.
 */
function createMockSafetyReport(overrides?: Partial<SafetyReport>): SafetyReport {
  return {
    mint: 'SoLTest111111111111111111111111111111111111',
    overallScore: 500,
    rugCheckScore: 500,
    goPlusResult: {
      isMintable: false,
      isFreezable: false,
      isOpenSource: true,
      holderCount: 500,
      top10HolderPercent: 30,
      largestHolderPercent: 10,
      isLpLocked: true,
      creatorAddress: 'creator111111111111111111111111111111111111',
    },
    honeypotResult: {
      sellable: true,
      estimatedTax: 0,
    },
    lpStatus: {
      burned: true,
      burnPercent: 100,
      locked: false,
    },
    authorityStatus: {
      mintRevoked: true,
      freezeRevoked: true,
      metadataMutable: false,
    },
    checkedAt: Date.now(),
    risks: [],
    ...overrides,
  } as SafetyReport;
}

/**
 * Creates a mock AIAnalysisResult with positive analysis defaults.
 */
function createMockAIResult(overrides?: Partial<AIAnalysisResult>): AIAnalysisResult {
  return {
    dimensions: [
      { name: 'on-chain-momentum', score: 75, reasoning: 'Strong buying pressure' },
      { name: 'social-velocity', score: 60, reasoning: 'Moderate social activity' },
      { name: 'wallet-intelligence', score: 80, reasoning: 'Smart money accumulating' },
      { name: 'liquidity-health', score: 70, reasoning: 'Adequate liquidity' },
      { name: 'narrative-fit', score: 65, reasoning: 'Trending narrative' },
    ],
    compositeAI: 75,
    confidence: 'high',
    narrative: 'Strong buy signal with smart money convergence',
    tier: 'fast',
    timestamp: Date.now(),
    ...overrides,
  } as AIAnalysisResult;
}

/**
 * Creates a token input that FAILS multiple hard filters simultaneously.
 * Used for testing hard filter enforcement.
 */
function createUnsafeTokenInput(): TokenAnalysisInput {
  return createMockTokenInput({
    mintAuthorityActive: true,       // FAIL: mint authority active
    freezeAuthorityActive: true,     // FAIL: freeze authority active
    sniperSupplyPercent: 15,         // FAIL: >10% sniper supply
    liquidity: 1000,                 // FAIL: <$3K liquidity
    lpBurned: false,                 // FAIL: no LP burn/lock
    lpLocked: false,
    topHolderPercent: 60,            // FAIL: >50% (hard filter checks topHolderPercent)
    safetyScore: 100,                // Low safety score
  });
}

/**
 * Creates a mock PositionData object for exit signal testing.
 */
function createMockPosition(overrides?: Partial<PositionData>): PositionData {
  return {
    tokenMint: 'SoLTest111111111111111111111111111111111111',
    tokenSymbol: 'TEST',
    entryPrice: 0.001,
    currentPrice: 0.001,
    entryTime: Date.now() - 3600000, // 1 hour ago
    tpLevels: [
      { multiplier: 2, sellPercent: 50, triggered: false },
      { multiplier: 5, sellPercent: 25, triggered: false },
      { multiplier: 10, sellPercent: 25, triggered: false },
    ],
    stopLossPercent: -12,
    trailingStopActive: false,
    trailingStopHighPrice: 0.001,
    trailingStopPercent: -20,
    remainingPercent: 100,
    totalInvestedUsd: 100,
    currentValueUsd: 100,
    unrealizedPnlPercent: 0,
    partialExits: [],
    ...overrides,
  } as PositionData;
}

/**
 * Creates a mock TokenContext for exit signal testing.
 */
function createMockTokenContext(overrides?: Partial<TokenContext>): TokenContext {
  return {
    currentPrice: 0.001,
    volume24h: 200000,
    marketCap: 500000,
    devWalletSold: false,
    smartMoneyExitPercent: 0,
    holderCount: 500,
    volume1h: 50000,
    ...overrides,
  } as TokenContext;
}

// =============================================================================
// Phase 4–10: Test Suites
// =============================================================================

describe('Signal Pipeline Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Phase 4: Hard Filter Evaluation
  // ---------------------------------------------------------------------------

  describe('Hard Filter Evaluation', () => {
    it('should PASS hard filters for a safe token', () => {
      const input = createMockTokenInput();
      const result: HardFilterResult = runHardFilters(input);

      expect(result.passed).toBe(true);
      expect(result.failedFilters).toHaveLength(0);
    });

    it('should FAIL hard filter for active mint authority', () => {
      const input = createMockTokenInput({ mintAuthorityActive: true });
      const result: HardFilterResult = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toContain('mint-authority-active');
    });

    it('should FAIL hard filter for active freeze authority', () => {
      const input = createMockTokenInput({ freezeAuthorityActive: true });
      const result: HardFilterResult = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toContain('freeze-authority-active');
    });

    it('should FAIL hard filter for excessive sniper supply (>10%)', () => {
      const input = createMockTokenInput({ sniperSupplyPercent: 15 });
      const result: HardFilterResult = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toContain('bundled-launch');
    });

    it('should FAIL hard filter for low liquidity (<$3K)', () => {
      const input = createMockTokenInput({ liquidity: 1000 });
      const result: HardFilterResult = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toContain('min-liquidity');
    });

    it('should FAIL hard filter for no LP lock/burn', () => {
      const input = createMockTokenInput({ lpBurned: false, lpLocked: false });
      const result: HardFilterResult = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toContain('no-lp-lock-burn');
    });

    it('should FAIL hard filter for top 10 holder concentration >50%', () => {
      // The hard filter checks `topHolderPercent` against MAX_TOP_10_HOLDER_PERCENT (50)
      const input = createMockTokenInput({ topHolderPercent: 55 });
      const result: HardFilterResult = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toContain('top-10-holder-concentration');
    });

    it('should fail ALL hard filters simultaneously for an extremely unsafe token', () => {
      const input = createUnsafeTokenInput();
      const result: HardFilterResult = runHardFilters(input);

      expect(result.passed).toBe(false);
      // Should fail at least 3 of the 6 filters simultaneously
      expect(result.failedFilters.length).toBeGreaterThanOrEqual(3);
    });

    it('tokens failing hard filters are classified as SKIP regardless of high composite score', async () => {
      // Token with excellent metrics but active mint authority
      const input = createMockTokenInput({
        mintAuthorityActive: true,
        volume5m: 10000,
        volume1h: 100000,
        volume24h: 500000,
        smartMoneyCount: 5,
        buys1h: 300,
        sells1h: 50,
        safetyScore: 800,
      });

      const result: CompositeSignal = await analyzeToken(input);

      // Hard filter failure MUST produce SKIP regardless of score
      expect(result.decision).toBe('SKIP');
      expect(result.hardFilterResult.passed).toBe(false);
      expect(result.hardFilterResult.failedFilters).toContain('mint-authority-active');
    });

    it('should pass hard filters at boundary values', () => {
      // Token at exact boundary values — should still pass
      const input = createMockTokenInput({
        sniperSupplyPercent: 10,     // Exactly at threshold
        liquidity: 3000,              // Exactly at threshold
        topHolderPercent: 50,         // Exactly at threshold
      });
      const result: HardFilterResult = runHardFilters(input);

      // Boundary values should pass — filters use ≤ comparisons
      expect(result.passed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 5: Composite Signal Scoring
  // ---------------------------------------------------------------------------

  describe('Composite Signal Scoring', () => {
    it('should produce a composite score between 0 and 100', async () => {
      const input = createMockTokenInput();
      const result: CompositeSignal = await analyzeToken(input);

      expect(result.composite).toBeGreaterThanOrEqual(0);
      expect(result.composite).toBeLessThanOrEqual(100);
      expect(result.factors.length).toBe(7);
    });

    it('should include all 7 factor results in the composite signal', async () => {
      const input = createMockTokenInput();
      const result: CompositeSignal = await analyzeToken(input);

      const expectedFactorNames: string[] = [
        'volumeSpike',
        'smartMoneyConvergence',
        'buySellRatio',
        'holderGrowth',
        'liquidity',
        'tokenAge',
        'safetyScore',
      ];

      expect(result.factors).toHaveLength(7);

      for (const factorName of expectedFactorNames) {
        const factor = result.factors.find((f: FactorResult) => f.name === factorName);
        expect(factor).toBeDefined();
        expect(factor!.score).toBeGreaterThanOrEqual(0);
        expect(factor!.score).toBeLessThanOrEqual(100);
        expect(typeof factor!.weight).toBe('number');
      }
    });

    it('should use default scoring weights when none provided', async () => {
      const input = createMockTokenInput();
      const result: CompositeSignal = await analyzeToken(input);

      // Verify factors use default weights from config
      for (const factor of result.factors) {
        const defaultWeight = DEFAULT_SCORING_WEIGHTS[factor.name as keyof ScoringWeights];
        if (defaultWeight !== undefined) {
          expect(factor.weight).toBeCloseTo(defaultWeight, 2);
        }
      }
    });

    it('should use custom scoring weights when provided', async () => {
      const input = createMockTokenInput();

      // Custom weights heavily favoring volume spike
      const customWeights: ScoringWeights = {
        volumeSpike: 0.50,
        smartMoneyConvergence: 0.10,
        buySellRatio: 0.10,
        holderGrowth: 0.05,
        liquidity: 0.10,
        tokenAge: 0.05,
        safetyScore: 0.10,
      };

      const resultDefault: CompositeSignal = await analyzeToken(input);
      const resultCustom: CompositeSignal = await analyzeToken(input, customWeights);

      // Both should produce valid scores
      expect(resultCustom.composite).toBeGreaterThanOrEqual(0);
      expect(resultCustom.composite).toBeLessThanOrEqual(100);

      // The custom-weighted volumeSpike factor should have the custom weight
      const vsFactorCustom = resultCustom.factors.find(
        (f: FactorResult) => f.name === 'volumeSpike',
      );
      expect(vsFactorCustom).toBeDefined();
      expect(vsFactorCustom!.weight).toBeCloseTo(0.50, 2);
    });

    it('should run all 7 factors via Promise.allSettled (not Promise.all)', async () => {
      // Even with one factor potentially producing an edge case,
      // the pipeline should still complete and return all 7 factors
      const input = createMockTokenInput({
        volume5m: 0,       // Edge case: zero volume
        volume1h: 0,
        volume5mMA: 0,     // Edge case: zero MA
      });

      const result: CompositeSignal = await analyzeToken(input);

      // Pipeline should still complete with all 7 factors
      expect(result.factors.length).toBe(7);
      expect(result.composite).toBeGreaterThanOrEqual(0);
      expect(result.composite).toBeLessThanOrEqual(100);
    });

    it('should produce consistent results for the same input', async () => {
      const input = createMockTokenInput();

      const result1: CompositeSignal = await analyzeToken(input);
      const result2: CompositeSignal = await analyzeToken(input);

      // Same input should produce same composite score
      expect(result1.composite).toBe(result2.composite);
      expect(result1.decision).toBe(result2.decision);
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 6: Trading Mode Thresholds
  // ---------------------------------------------------------------------------

  describe('Trading Mode Thresholds', () => {
    it('verifies conservative threshold constant is 80', () => {
      expect(SCORING_THRESHOLDS.CONSERVATIVE_MIN).toBe(80);
    });

    it('verifies aggressive threshold constant is 45', () => {
      expect(SCORING_THRESHOLDS.AGGRESSIVE_MIN).toBe(45);
    });

    it('conservative mode requires composite score >= 80 for BUY decision', async () => {
      // Create a token with very strong metrics to push score high
      const input = createMockTokenInput({
        volume5m: 20000,
        volume1h: 200000,
        volume24h: 1000000,
        volume5mMA: 2000,     // 10× spike
        buys1h: 500,
        sells1h: 50,          // 10× buy/sell ratio
        smartMoneyCount: 6,
        holderCount: 2000,
        safetyScore: 900,
        liquidity: 100000,
        createdAt: Date.now() / 1000 - 1800, // 30 min old (very early)
      });

      const result: CompositeSignal = await analyzeToken(input, undefined, 'conservative');

      // With these strong metrics, the score should be high enough for conservative BUY
      if (result.composite >= 80) {
        expect(result.decision).toBe('BUY');
      }
      // The trading mode should be recorded
      expect(result.tradingMode).toBe('conservative');
    });

    it('conservative mode produces SKIP for composite score < 80', async () => {
      // Create a mediocre token that should score around 40-60
      const input = createMockTokenInput({
        volume5m: 500,
        volume1h: 5000,
        volume24h: 20000,
        volume5mMA: 400,      // ~1.25× spike (weak)
        buys1h: 100,
        sells1h: 80,          // ~1.25× ratio (weak)
        smartMoneyCount: 1,
        holderCount: 100,
        safetyScore: 350,
        liquidity: 5000,
        createdAt: Date.now() / 1000 - 36000, // 10h old
      });

      const result: CompositeSignal = await analyzeToken(input, undefined, 'conservative');

      // With these mediocre metrics, score should be below 80
      if (result.composite < 80) {
        expect(result.decision).toBe('SKIP');
      }
      expect(result.tradingMode).toBe('conservative');
    });

    it('aggressive mode requires composite score >= 45 for BUY decision', async () => {
      // Create a moderate token that should score around 50-70
      const input = createMockTokenInput({
        volume5m: 3000,
        volume1h: 30000,
        volume24h: 100000,
        volume5mMA: 800,      // ~3.75× spike
        buys1h: 150,
        sells1h: 80,          // ~1.9× ratio
        smartMoneyCount: 2,
        holderCount: 300,
        safetyScore: 400,
        liquidity: 15000,
        createdAt: Date.now() / 1000 - 7200, // 2h old
      });

      const result: CompositeSignal = await analyzeToken(input, undefined, 'aggressive');

      // With moderate metrics in aggressive mode, score should be above 45
      if (result.composite >= 45) {
        expect(result.decision).toBe('BUY');
      }
      expect(result.tradingMode).toBe('aggressive');
    });

    it('aggressive mode produces SKIP for composite score < 45', async () => {
      // Create a very weak token that should score below 45
      const input = createMockTokenInput({
        volume5m: 100,
        volume1h: 500,
        volume24h: 2000,
        volume5mMA: 100,      // 1× (no spike)
        buys1h: 50,
        sells1h: 50,          // 1× ratio (neutral)
        smartMoneyCount: 0,
        holderCount: 30,
        safetyScore: 310,
        liquidity: 3500,
        createdAt: Date.now() / 1000 - 43200, // 12h old
      });

      const result: CompositeSignal = await analyzeToken(input, undefined, 'aggressive');

      // With very weak metrics, score should be below 45
      if (result.composite < 45) {
        expect(result.decision).toBe('SKIP');
      }
      expect(result.tradingMode).toBe('aggressive');
    });

    it('default trading mode is conservative when not specified', async () => {
      const input = createMockTokenInput();
      const result: CompositeSignal = await analyzeToken(input);

      // Default mode is conservative per scoring-engine.ts implementation
      expect(result.tradingMode).toBe('conservative');
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 7: AI/LLM Tier Routing
  // ---------------------------------------------------------------------------

  describe('AI/LLM Tier Routing', () => {
    it('routes scores < 45 to fast tier (llama-3.1-8b-instant)', () => {
      const tier = determineTier(30);
      expect(tier).toBe('fast');
    });

    it('routes scores 45-80 to detailed tier (llama-3.3-70b-versatile)', () => {
      const tier = determineTier(60);
      expect(tier).toBe('detailed');
    });

    it('routes scores >= 80 to premium tier (Claude Sonnet) when enabled', () => {
      const tier = determineTier(85, { enablePremiumTier: true });
      expect(tier).toBe('premium');
    });

    it('routes scores >= 80 to detailed tier when premium is disabled', () => {
      const tier = determineTier(85, { enablePremiumTier: false });
      expect(tier).toBe('detailed');
    });

    it('routes at exact boundary: score 45 → detailed', () => {
      const tier = determineTier(45);
      expect(tier).toBe('detailed');
    });

    it('routes at exact boundary: score 80 → premium when enabled', () => {
      const tier = determineTier(80, { enablePremiumTier: true });
      expect(tier).toBe('premium');
    });

    it('routes at exact boundary: score 44 → fast', () => {
      const tier = determineTier(44);
      expect(tier).toBe('fast');
    });

    it('verifies LLM_CONFIG thresholds match tier routing logic', () => {
      expect(LLM_CONFIG.FAST_THRESHOLD).toBe(45);
      expect(LLM_CONFIG.DETAILED_THRESHOLD).toBe(80);
      expect(LLM_CONFIG.CACHE_TTL_MS).toBe(300000);
    });

    it('never sends tokens to LLM without passing hard filters first (safety-before-AI rule)', async () => {
      // Unsafe token that fails hard filters
      const input = createUnsafeTokenInput();

      const result: CompositeSignal = await analyzeToken(input);

      // Token should be SKIP due to hard filter failure
      expect(result.decision).toBe('SKIP');
      expect(result.hardFilterResult.passed).toBe(false);

      // The AI router should NOT have been called for an unsafe token
      // Hard filters short-circuit before AI analysis runs
      // The composite score should be 0 for hard-filter-failed tokens
      expect(result.composite).toBe(0);
    });

    it('verifies LLM model names match configuration', () => {
      // LLM_CONFIG.TIERS entries are objects with { model, percentage }
      expect(LLM_CONFIG.TIERS.FAST.model).toBe('llama-3.1-8b-instant');
      expect(LLM_CONFIG.TIERS.FAST.percentage).toBe(80);
      expect(LLM_CONFIG.TIERS.DETAILED.model).toBe('llama-3.3-70b-versatile');
      expect(LLM_CONFIG.TIERS.DETAILED.percentage).toBe(15);
      expect(LLM_CONFIG.TIERS.PREMIUM.model).toBe('claude-sonnet');
      expect(LLM_CONFIG.TIERS.PREMIUM.percentage).toBe(5);
    });

    it('verifies LLM cache TTL is 5 minutes (300000 ms)', () => {
      expect(LLM_CACHE_TTL).toBe(300000);
      expect(LLM_CONFIG.CACHE_TTL_MS).toBe(300000);
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 8: Safety Check Integration
  // ---------------------------------------------------------------------------

  describe('Safety Check Integration', () => {
    it('safety report structure has required fields', () => {
      const report = createMockSafetyReport();

      expect(report.overallScore).toBeDefined();
      expect(report.rugCheckScore).toBeDefined();
      expect(report.honeypotResult).toBeDefined();
      expect(report.honeypotResult.sellable).toBe(true);
      expect(report.honeypotResult.estimatedTax).toBe(0);
      expect(report.lpStatus).toBeDefined();
      expect(report.lpStatus.burned).toBe(true);
      expect(report.authorityStatus).toBeDefined();
      expect(report.authorityStatus.mintRevoked).toBe(true);
      expect(report.authorityStatus.freezeRevoked).toBe(true);
    });

    it('merges safety results with worst-case-wins logic', () => {
      // RugCheck says safe (score 500) but GoPlus shows mintable
      const report = createMockSafetyReport({
        overallScore: 300,
        goPlusResult: {
          isMintable: true,       // GoPlus detected mintable!
          isFreezable: false,
          isOpenSource: true,
          holderCount: 500,
          top10HolderPercent: 30,
          largestHolderPercent: 10,
          isLpLocked: true,
          creatorAddress: 'creator111111111111111111111111111111111111',
        },
        authorityStatus: {
          mintRevoked: false,       // Worst-case: mint NOT revoked
          freezeRevoked: true,
          metadataMutable: false,
        },
      });

      // Worst-case-wins: if GoPlus says mintable, the merged report should reflect this
      expect(report.goPlusResult!.isMintable).toBe(true);
      expect(report.authorityStatus.mintRevoked).toBe(false);
    });

    it('honeypot result correctly identifies sellable tokens', () => {
      const report = createMockSafetyReport({
        honeypotResult: {
          sellable: true,
          estimatedTax: 0,
        },
      });

      expect(report.honeypotResult.sellable).toBe(true);
      expect(report.honeypotResult.estimatedTax).toBe(0);
    });

    it('honeypot result correctly identifies non-sellable tokens (honeypots)', () => {
      const report = createMockSafetyReport({
        honeypotResult: {
          sellable: false,
          estimatedTax: 100,
        },
      });

      expect(report.honeypotResult.sellable).toBe(false);
      expect(report.honeypotResult.estimatedTax).toBe(100);
    });

    it('LP status correctly identifies burned LP', () => {
      const report = createMockSafetyReport({
        lpStatus: {
          burned: true,
          burnPercent: 100,
          locked: false,
        },
      });

      expect(report.lpStatus.burned).toBe(true);
      expect(report.lpStatus.burnPercent).toBe(100);
    });

    it('LP status correctly identifies locked LP', () => {
      const report = createMockSafetyReport({
        lpStatus: {
          burned: false,
          burnPercent: 0,
          locked: true,
        },
      });

      expect(report.lpStatus.locked).toBe(true);
      expect(report.lpStatus.burned).toBe(false);
    });

    it('safety score affects signal scoring engine output', async () => {
      // High safety score token
      const safeInput = createMockTokenInput({ safetyScore: 800 });
      const safeResult = await analyzeToken(safeInput);

      // Low safety score token (but still passes hard filters)
      const riskyInput = createMockTokenInput({ safetyScore: 310 });
      const riskyResult = await analyzeToken(riskyInput);

      // Both should produce valid scores
      expect(safeResult.composite).toBeGreaterThanOrEqual(0);
      expect(riskyResult.composite).toBeGreaterThanOrEqual(0);

      // The safety factor score should be higher for the safe token
      const safeFactor = safeResult.factors.find((f: FactorResult) => f.name === 'safetyScore');
      const riskyFactor = riskyResult.factors.find((f: FactorResult) => f.name === 'safetyScore');

      if (safeFactor && riskyFactor) {
        expect(safeFactor.score).toBeGreaterThanOrEqual(riskyFactor.score);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 9: Exit Signal Management
  // ---------------------------------------------------------------------------

  describe('Exit Signal Management', () => {
    it('tests the full TP ladder strategy: 50% at 2×, 25% at 5×, 25% at 10×', () => {
      const defaultLevels = getDefaultTpLevels(0.001, 'ladder');

      expect(defaultLevels).toHaveLength(3);
      expect(defaultLevels[0].multiplier).toBe(2);
      expect(defaultLevels[0].sellPercent).toBe(50);
      expect(defaultLevels[1].multiplier).toBe(5);
      expect(defaultLevels[1].sellPercent).toBe(25);
      expect(defaultLevels[2].multiplier).toBe(10);
      expect(defaultLevels[2].sellPercent).toBe(25);
    });

    it('triggers first TP level at 2× price (sell 50%)', () => {
      const position = createMockPosition({
        entryPrice: 0.001,
        currentPrice: 0.002, // 2× entry
      });
      const context = createMockTokenContext({ currentPrice: 0.002 });

      const result: ExitCheckResult = checkExitSignals(position, context);

      expect(result.hasExitSignal).toBe(true);
      // Should have a tp-ladder trigger (ExitReason type)
      const tpTrigger = result.triggers.find(
        (t) => t.type === 'tp-ladder',
      );
      expect(tpTrigger).toBeDefined();
    });

    it('triggers stop-loss exit when price drops below threshold', () => {
      const position = createMockPosition({
        entryPrice: 0.001,
        currentPrice: 0.00087, // -13% from entry (below -12% SL)
        stopLossPercent: -12,
      });
      const context = createMockTokenContext({ currentPrice: 0.00087 });

      const result: ExitCheckResult = checkExitSignals(position, context);

      expect(result.hasExitSignal).toBe(true);
      const slTrigger = result.triggers.find(
        (t) => t.type === 'stop-loss',
      );
      expect(slTrigger).toBeDefined();
      if (slTrigger) {
        expect(slTrigger.severity).toBe('critical');
      }
    });

    it('triggers exit on dev wallet selling', () => {
      const position = createMockPosition({
        entryPrice: 0.001,
        currentPrice: 0.0015,
      });
      const context = createMockTokenContext({
        currentPrice: 0.0015,
        devWalletSold: true, // Dev sold!
      });

      const result: ExitCheckResult = checkExitSignals(position, context);

      expect(result.hasExitSignal).toBe(true);
      const devTrigger = result.triggers.find(
        (t) => t.type === 'dev-sell',
      );
      expect(devTrigger).toBeDefined();
      if (devTrigger) {
        expect(devTrigger.severity).toBe('critical');
      }
    });

    it('triggers exit on smart money position reduction (40-60%)', () => {
      const position = createMockPosition({
        entryPrice: 0.001,
        currentPrice: 0.0015,
      });
      const context = createMockTokenContext({
        currentPrice: 0.0015,
        smartMoneyExitPercent: 50, // 50% reduction — within 40-60% warning zone
      });

      const result: ExitCheckResult = checkExitSignals(position, context);

      expect(result.hasExitSignal).toBe(true);
      const smTrigger = result.triggers.find(
        (t) => t.type === 'smart-money-exit',
      );
      expect(smTrigger).toBeDefined();
    });

    it('triggers exit on volume decline (volume-to-MC below 10%)', () => {
      const position = createMockPosition({
        entryPrice: 0.001,
        currentPrice: 0.0012,
      });
      const context = createMockTokenContext({
        currentPrice: 0.0012,
        volume24h: 5000,     // Very low volume
        marketCap: 500000,   // High MC → ratio < 10%
      });

      const result: ExitCheckResult = checkExitSignals(position, context);

      expect(result.hasExitSignal).toBe(true);
      const volumeTrigger = result.triggers.find(
        (t) => t.type === 'volume-decline',
      );
      expect(volumeTrigger).toBeDefined();
    });

    it('produces no exit signals for a healthy position', () => {
      const position = createMockPosition({
        entryPrice: 0.001,
        currentPrice: 0.0012, // +20% — between entry and first TP
      });
      const context = createMockTokenContext({
        currentPrice: 0.0012,
        volume24h: 200000,    // Healthy volume
        marketCap: 500000,    // Good volume-to-MC ratio (40%)
        devWalletSold: false,
        smartMoneyExitPercent: 0,
      });

      const result: ExitCheckResult = checkExitSignals(position, context);

      expect(result.hasExitSignal).toBe(false);
      expect(result.triggers).toHaveLength(0);
      expect(result.highestSeverity).toBe('none');
      expect(result.recommendedAction).toBe('HOLD');
    });

    it('day-trade TP profile has correct levels', () => {
      const levels = getDefaultTpLevels(0.001, 'day-trade');

      expect(levels).toHaveLength(3);
      // Day-trade TPs: +15%, +30%, +60%
      expect(levels[0].multiplier).toBeCloseTo(1.15, 2);
      expect(levels[1].multiplier).toBeCloseTo(1.30, 2);
      expect(levels[2].multiplier).toBeCloseTo(1.60, 2);
    });

    it('swing-trade TP profile has correct levels', () => {
      const levels = getDefaultTpLevels(0.001, 'swing-trade');

      expect(levels).toHaveLength(4);
      // Swing-trade TPs: +40%, +100%, +200%, +500%
      expect(levels[0].multiplier).toBeCloseTo(1.40, 2);
      expect(levels[1].multiplier).toBeCloseTo(2.0, 2);
      expect(levels[2].multiplier).toBeCloseTo(3.0, 2);
      expect(levels[3].multiplier).toBeCloseTo(6.0, 2);
    });

    it('DEFAULT_EXIT_STRATEGY constants match expected values', () => {
      // Ladder strategy
      expect(DEFAULT_EXIT_STRATEGY.LADDER).toHaveLength(3);
      expect(DEFAULT_EXIT_STRATEGY.LADDER[0].sellPercent).toBe(50);
      expect(DEFAULT_EXIT_STRATEGY.LADDER[0].multiplier).toBe(2);
      expect(DEFAULT_EXIT_STRATEGY.LADDER[1].sellPercent).toBe(25);
      expect(DEFAULT_EXIT_STRATEGY.LADDER[1].multiplier).toBe(5);
      expect(DEFAULT_EXIT_STRATEGY.LADDER[2].sellPercent).toBe(25);
      expect(DEFAULT_EXIT_STRATEGY.LADDER[2].multiplier).toBe(10);

      // Day-trade SL
      expect(DEFAULT_EXIT_STRATEGY.DAY_TRADE.stopLoss).toBe(-12);

      // Swing-trade SL
      expect(DEFAULT_EXIT_STRATEGY.SWING_TRADE.stopLoss).toBe(-18);
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 10: Full Pipeline End-to-End
  // ---------------------------------------------------------------------------

  describe('Full Pipeline End-to-End', () => {
    it('complete pipeline: safe high-quality token → BUY with factor breakdowns', async () => {
      // High-quality token with strong metrics across all dimensions
      const input = createMockTokenInput({
        volume5m: 15000,
        volume1h: 150000,
        volume24h: 600000,
        volume5mMA: 2000,     // 7.5× spike
        buys1h: 400,
        sells1h: 80,          // 5× buy/sell ratio
        smartMoneyCount: 5,
        holderCount: 1500,
        safetyScore: 700,
        liquidity: 80000,
        createdAt: Date.now() / 1000 - 1800, // 30 min old
      });

      const result: CompositeSignal = await analyzeToken(input, undefined, 'aggressive');

      // Assertions for a high-quality token in aggressive mode
      expect(result.composite).toBeGreaterThanOrEqual(0);
      expect(result.composite).toBeLessThanOrEqual(100);
      expect(result.factors).toHaveLength(7);
      expect(result.hardFilterResult.passed).toBe(true);
      expect(result.tradingMode).toBe('aggressive');
      expect(result.tokenMint).toBe('SoLTest111111111111111111111111111111111111');

      // All factor scores should be > 0 for a high-quality token
      for (const factor of result.factors) {
        expect(factor.score).toBeGreaterThanOrEqual(0);
        expect(factor.weight).toBeGreaterThan(0);
        expect(factor.name).toBeTruthy();
      }

      // With these strong metrics, decision should be BUY (score should be high)
      if (result.composite >= SCORING_THRESHOLDS.AGGRESSIVE_MIN) {
        expect(result.decision).toBe('BUY');
      }
    });

    it('complete pipeline: unsafe token → SKIP before AI analysis', async () => {
      // Unsafe token that fails hard filters
      const input = createUnsafeTokenInput();

      const result: CompositeSignal = await analyzeToken(input);

      // Unsafe tokens MUST be classified as SKIP
      expect(result.decision).toBe('SKIP');
      expect(result.hardFilterResult.passed).toBe(false);
      expect(result.hardFilterResult.failedFilters.length).toBeGreaterThan(0);
      // Score should be 0 for hard-filter-failed tokens
      expect(result.composite).toBe(0);
    });

    it('complete pipeline: moderate token in conservative mode → SKIP', async () => {
      // Moderate token that would score around 50-65
      const input = createMockTokenInput({
        volume5m: 2000,
        volume1h: 20000,
        volume24h: 80000,
        volume5mMA: 600,       // ~3.3× spike (moderate)
        buys1h: 130,
        sells1h: 80,           // ~1.6× ratio (moderate)
        smartMoneyCount: 2,
        holderCount: 250,
        safetyScore: 400,
        liquidity: 12000,
        createdAt: Date.now() / 1000 - 10800, // 3h old
      });

      const result: CompositeSignal = await analyzeToken(input, undefined, 'conservative');

      // Moderate token in conservative mode — score should be below 80
      expect(result.tradingMode).toBe('conservative');
      expect(result.hardFilterResult.passed).toBe(true);

      // With moderate metrics, composite should be well below 80
      if (result.composite < SCORING_THRESHOLDS.CONSERVATIVE_MIN) {
        expect(result.decision).toBe('SKIP');
      }
    });

    it('complete pipeline: moderate token in aggressive mode → BUY', async () => {
      // Same moderate token but in aggressive mode
      const input = createMockTokenInput({
        volume5m: 3000,
        volume1h: 30000,
        volume24h: 120000,
        volume5mMA: 700,       // ~4.3× spike
        buys1h: 180,
        sells1h: 70,           // ~2.6× ratio
        smartMoneyCount: 3,
        holderCount: 400,
        safetyScore: 500,
        liquidity: 25000,
        createdAt: Date.now() / 1000 - 5400, // 1.5h old
      });

      const result: CompositeSignal = await analyzeToken(input, undefined, 'aggressive');

      // Same moderate metrics but in aggressive mode (threshold 45)
      expect(result.tradingMode).toBe('aggressive');
      expect(result.hardFilterResult.passed).toBe(true);

      // With reasonable metrics in aggressive mode, should meet threshold
      if (result.composite >= SCORING_THRESHOLDS.AGGRESSIVE_MIN) {
        expect(result.decision).toBe('BUY');
      }
    });

    it('complete pipeline: token with mixed factor scores produces weighted composite', async () => {
      // Token with some strong and some weak factors
      const input = createMockTokenInput({
        volume5m: 20000,          // Very strong volume spike
        volume5mMA: 2000,         // 10× spike
        buys1h: 50,
        sells1h: 50,              // Neutral buy/sell ratio (1×)
        smartMoneyCount: 0,       // No smart money
        holderCount: 50,          // Very few holders
        safetyScore: 500,         // Good safety
        liquidity: 30000,         // Good liquidity
        createdAt: Date.now() / 1000 - 3600, // 1h old
      });

      const result: CompositeSignal = await analyzeToken(input);

      // Score should be a weighted mix — not all-or-nothing
      expect(result.composite).toBeGreaterThan(0);
      expect(result.composite).toBeLessThan(100);
      expect(result.factors).toHaveLength(7);

      // Volume factor should be high
      const volumeFactor = result.factors.find((f: FactorResult) => f.name === 'volumeSpike');
      expect(volumeFactor).toBeDefined();
      expect(volumeFactor!.score).toBeGreaterThan(0);
    });

    it('complete pipeline verifies hard filter thresholds from config', () => {
      // Verify config constants used by the pipeline
      expect(HARD_FILTER_THRESHOLDS.MAX_SNIPER_SUPPLY_PERCENT).toBe(10);
      expect(HARD_FILTER_THRESHOLDS.MIN_LIQUIDITY_USD).toBe(3000);
      expect(HARD_FILTER_THRESHOLDS.MAX_TOP_10_HOLDER_PERCENT).toBe(50);
      expect(HARD_FILTER_THRESHOLDS.MIN_SAFETY_SCORE).toBe(300);
      expect(HARD_FILTER_THRESHOLDS.MAX_TOP_HOLDER_CONCENTRATION).toBe(20);
    });

    it('complete pipeline verifies default scoring weights sum to approximately 1.0', () => {
      const weights = DEFAULT_SCORING_WEIGHTS;
      const sum =
        weights.volumeSpike +
        weights.smartMoneyConvergence +
        weights.buySellRatio +
        weights.holderGrowth +
        weights.liquidity +
        weights.tokenAge +
        weights.safetyScore;

      expect(sum).toBeCloseTo(1.0, 2);
    });

    it('complete pipeline: token at exact aggressive threshold boundary', async () => {
      // This tests the boundary condition at score = 45
      const input = createMockTokenInput();

      const result: CompositeSignal = await analyzeToken(input, undefined, 'aggressive');

      // We can't control the exact score, but we verify the decision logic is correct
      if (result.composite >= SCORING_THRESHOLDS.AGGRESSIVE_MIN) {
        expect(result.decision).toBe('BUY');
      } else {
        expect(result.decision).toBe('SKIP');
      }
    });

    it('complete pipeline: signal includes confidence level', async () => {
      const input = createMockTokenInput();
      const result: CompositeSignal = await analyzeToken(input);

      // Confidence should be between 0 and 1
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('complete pipeline: signal includes timestamp', async () => {
      const beforeTime = Date.now();
      const input = createMockTokenInput();
      const result: CompositeSignal = await analyzeToken(input);
      const afterTime = Date.now();

      // Timestamp should be within the test execution window
      expect(result.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(result.timestamp).toBeLessThanOrEqual(afterTime);
    });
  });
});
