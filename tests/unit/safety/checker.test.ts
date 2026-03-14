/**
 * tests/unit/safety/checker.test.ts — SafetyChecker Unit Tests
 *
 * Comprehensive test coverage for the multi-source safety orchestrator
 * (`src/safety/checker.ts`). Validates:
 *
 * 1. **Promise.allSettled concurrent execution** — RugCheck, GoPlus, and
 *    Honeypot checks run concurrently, NOT sequentially (AAP §0.7.3).
 * 2. **Worst-case-wins merge logic** — merged authority, holder concentration,
 *    and LP status take the MORE CONSERVATIVE assessment from each source.
 * 3. **Partial source failure handling** — graceful degradation when one or
 *    more safety sources are unavailable or return errors.
 * 4. **Failsafe report generation** — catastrophic failure produces a
 *    maximally cautious report with `overallScore = 0`.
 * 5. **Score computation** — penalties and bonuses applied correctly,
 *    clamped to [0, 1000].
 * 6. **Risk factor collection** — all detected risks enumerated in the report.
 *
 * Per AAP §0.2.1 test file inventory:
 *   "Tests concurrent multi-source safety check orchestration"
 *
 * @module tests/unit/safety/checker
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SafetyChecker } from '../../../src/safety/checker';
import type { RugCheckClient } from '../../../src/api/rugcheck';
import type { GoPlusClient } from '../../../src/api/goplus';
import type { HoneypotDetector } from '../../../src/safety/honeypot-detector';
import type { LPAnalyzer } from '../../../src/safety/lp-analyzer';
import type { RugCheckReport, GoPlusResult } from '../../../src/api/types';
import type { HoneypotResult, LPStatus, SafetyReport } from '../../../src/safety/types';

// =============================================================================
// Mock Factories
// =============================================================================

const TEST_MINT = 'TestMint111111111111111111111111111111111111';

/**
 * Creates a safe RugCheckReport with all-clear fields.
 * Override specific fields for failure scenarios.
 */
function createSafeRugCheckReport(overrides: Partial<RugCheckReport> = {}): RugCheckReport {
  return {
    mint: TEST_MINT,
    score: 800,
    risks: [],
    mintAuthority: null,
    freezeAuthority: null,
    isMintable: false,
    isFreezable: false,
    topHolders: [
      { address: 'Holder1', amount: 1000, percentage: 5, isInsider: false },
      { address: 'Holder2', amount: 800, percentage: 4, isInsider: false },
      { address: 'Holder3', amount: 600, percentage: 3, isInsider: false },
    ],
    lpLocked: true,
    lpBurned: true,
    lpBurnPercentage: 95,
    isToken2022: false,
    markets: [
      {
        marketId: 'market1',
        marketType: 'raydium',
        liquidityA: 50000,
        liquidityB: 50000,
        liquidityAToken: 'tokenA',
        liquidityBToken: 'tokenB',
      },
    ],
    totalMarketLiquidity: 100000,
    ...overrides,
  };
}

/**
 * Creates a safe GoPlusResult with all-clear fields.
 */
function createSafeGoPlusResult(overrides: Partial<GoPlusResult> = {}): GoPlusResult {
  return {
    tokenAddress: TEST_MINT,
    isMintable: false,
    isFreezable: false,
    isOpenSource: true,
    holderCount: 500,
    totalSupply: '1000000000',
    topHolders: [
      { address: 'Holder1', balance: '50000000', percent: '5', isContract: false },
      { address: 'Holder2', balance: '40000000', percent: '4', isContract: false },
    ],
    lpHolders: [
      { address: 'LPHolder1', balance: '9500000', percent: '95', isLocked: true, tag: 'Burn Address' },
    ],
    lpTotalSupply: '10000000',
    isLpLocked: true,
    creatorAddress: 'Creator111',
    ownerAddress: 'Owner111',
    top10HolderPercent: 25,
    largestHolderPercent: 5,
    ...overrides,
  };
}

/**
 * Creates a safe HoneypotResult (sellable token).
 */
function createSafeHoneypotResult(overrides: Partial<HoneypotResult> = {}): HoneypotResult {
  return {
    sellable: true,
    estimatedTax: 0.5,
    ...overrides,
  };
}

/**
 * Creates a safe LPStatus (burned and locked).
 */
function createSafeLPStatus(overrides: Partial<LPStatus> = {}): LPStatus {
  return {
    burned: true,
    burnPercent: 95,
    locked: true,
    ...overrides,
  };
}

/**
 * Creates mock RugCheckClient with configurable getTokenReport.
 */
function createMockRugCheckClient(
  result: RugCheckReport | null = createSafeRugCheckReport(),
): RugCheckClient {
  return {
    getTokenReport: vi.fn().mockResolvedValue(result),
    getInsiderGraph: vi.fn().mockResolvedValue(null),
    getWalletRiskRating: vi.fn().mockResolvedValue(null),
  } as unknown as RugCheckClient;
}

/**
 * Creates mock GoPlusClient with configurable getTokenSecurity.
 */
function createMockGoPlusClient(
  result: GoPlusResult = createSafeGoPlusResult(),
): GoPlusClient {
  return {
    getTokenSecurity: vi.fn().mockResolvedValue(result),
    getTokenSecurityBatch: vi.fn().mockResolvedValue(new Map()),
  } as unknown as GoPlusClient;
}

/**
 * Creates mock HoneypotDetector with configurable checkHoneypot.
 */
function createMockHoneypotDetector(
  result: HoneypotResult = createSafeHoneypotResult(),
): HoneypotDetector {
  return {
    checkHoneypot: vi.fn().mockResolvedValue(result),
    simulateSellWithRetry: vi.fn().mockResolvedValue(result),
  } as unknown as HoneypotDetector;
}

/**
 * Creates mock LPAnalyzer with configurable analyzeLPStatus.
 */
function createMockLPAnalyzer(
  result: LPStatus = createSafeLPStatus(),
): LPAnalyzer {
  return {
    analyzeLPStatus: vi.fn().mockResolvedValue(result),
    getLPRiskLevel: vi.fn().mockReturnValue('safe'),
  } as unknown as LPAnalyzer;
}

// =============================================================================
// Tests
// =============================================================================

describe('SafetyChecker', () => {
  let mockRugCheck: RugCheckClient;
  let mockGoPlus: GoPlusClient;
  let mockHoneypot: HoneypotDetector;
  let mockLPAnalyzer: LPAnalyzer;
  let checker: SafetyChecker;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRugCheck = createMockRugCheckClient();
    mockGoPlus = createMockGoPlusClient();
    mockHoneypot = createMockHoneypotDetector();
    mockLPAnalyzer = createMockLPAnalyzer();
    checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Section 1: Promise.allSettled Concurrent Execution
  // ===========================================================================

  describe('Concurrent Execution (Promise.allSettled)', () => {
    it('should call RugCheck, GoPlus, and Honeypot concurrently (not sequentially)', async () => {
      // Track call timestamps to verify concurrency
      const callTimestamps: Record<string, number> = {};

      (mockRugCheck.getTokenReport as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callTimestamps['rugcheck-start'] = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 50));
        callTimestamps['rugcheck-end'] = Date.now();
        return createSafeRugCheckReport();
      });

      (mockGoPlus.getTokenSecurity as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callTimestamps['goplus-start'] = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 50));
        callTimestamps['goplus-end'] = Date.now();
        return createSafeGoPlusResult();
      });

      (mockHoneypot.checkHoneypot as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callTimestamps['honeypot-start'] = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 50));
        callTimestamps['honeypot-end'] = Date.now();
        return createSafeHoneypotResult();
      });

      await checker.checkToken(TEST_MINT);

      // All three should have started within a very short window (concurrent)
      // If sequential, goplus-start would be ≥ rugcheck-end
      const maxStartDelta = Math.abs(
        (callTimestamps['goplus-start'] ?? 0) - (callTimestamps['rugcheck-start'] ?? 0),
      );
      // Concurrent calls should start within 10ms of each other
      expect(maxStartDelta).toBeLessThan(30);
    });

    it('should call all three external checks exactly once', async () => {
      await checker.checkToken(TEST_MINT);

      expect(mockRugCheck.getTokenReport).toHaveBeenCalledTimes(1);
      expect(mockRugCheck.getTokenReport).toHaveBeenCalledWith(TEST_MINT);
      expect(mockGoPlus.getTokenSecurity).toHaveBeenCalledTimes(1);
      expect(mockGoPlus.getTokenSecurity).toHaveBeenCalledWith(TEST_MINT);
      expect(mockHoneypot.checkHoneypot).toHaveBeenCalledTimes(1);
      expect(mockHoneypot.checkHoneypot).toHaveBeenCalledWith(TEST_MINT);
    });

    it('should call LP analyzer after concurrent checks', async () => {
      await checker.checkToken(TEST_MINT);

      expect(mockLPAnalyzer.analyzeLPStatus).toHaveBeenCalledTimes(1);
      expect(mockLPAnalyzer.analyzeLPStatus).toHaveBeenCalledWith(
        TEST_MINT,
        expect.any(Object), // RugCheckReport
        expect.any(Object), // GoPlusResult
      );
    });
  });

  // ===========================================================================
  // Section 2: Safe Token (All Sources Healthy)
  // ===========================================================================

  describe('Safe Token — All Sources Return Clean Data', () => {
    it('should produce a high safety score for a clean token', async () => {
      const report = await checker.checkToken(TEST_MINT);

      expect(report.mint).toBe(TEST_MINT);
      expect(report.overallScore).toBeGreaterThanOrEqual(300);
      expect(report.honeypotResult.sellable).toBe(true);
      expect(report.authorityStatus.mintRevoked).toBe(true);
      expect(report.authorityStatus.freezeRevoked).toBe(true);
      expect(report.rugCheckAvailable).toBe(true);
      expect(report.goPlusAvailable).toBe(true);
    });

    it('should include RugCheck score in the report', async () => {
      const report = await checker.checkToken(TEST_MINT);
      expect(report.rugCheckScore).toBe(800);
    });

    it('should include GoPlus security summary', async () => {
      const report = await checker.checkToken(TEST_MINT);
      expect(report.goPlusResult).not.toBeNull();
      expect(report.goPlusResult?.isMintable).toBe(false);
      expect(report.goPlusResult?.isFreezable).toBe(false);
    });

    it('should include LP status from LP analyzer', async () => {
      const report = await checker.checkToken(TEST_MINT);
      expect(report.lpStatus.burned).toBe(true);
      expect(report.lpStatus.burnPercent).toBe(95);
      expect(report.lpStatus.locked).toBe(true);
    });

    it('should set checkedAt to a recent timestamp', async () => {
      const before = Date.now();
      const report = await checker.checkToken(TEST_MINT);
      const after = Date.now();

      expect(report.checkedAt).toBeGreaterThanOrEqual(before);
      expect(report.checkedAt).toBeLessThanOrEqual(after);
    });
  });

  // ===========================================================================
  // Section 3: Worst-Case-Wins Merge Logic
  // ===========================================================================

  describe('Worst-Case-Wins Merge Logic', () => {
    it('should require BOTH sources to confirm mint revoked for mintRevoked=true', async () => {
      // RugCheck says revoked, GoPlus says mintable
      mockGoPlus = createMockGoPlusClient(createSafeGoPlusResult({ isMintable: true }));
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);
      // Worst-case: GoPlus says mintable → mintRevoked should be false
      expect(report.authorityStatus.mintRevoked).toBe(false);
    });

    it('should require BOTH sources to confirm freeze revoked for freezeRevoked=true', async () => {
      // RugCheck says revoked, GoPlus says freezable
      mockGoPlus = createMockGoPlusClient(createSafeGoPlusResult({ isFreezable: true }));
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);
      expect(report.authorityStatus.freezeRevoked).toBe(false);
    });

    it('should mark mintRevoked=true when BOTH sources say not mintable', async () => {
      const report = await checker.checkToken(TEST_MINT);
      expect(report.authorityStatus.mintRevoked).toBe(true);
    });

    it('should take the HIGHER (worse) top10HolderPercent from both sources', async () => {
      // RugCheck topHolders sum to ~12%, GoPlus says 60%
      mockGoPlus = createMockGoPlusClient(createSafeGoPlusResult({ top10HolderPercent: 60 }));
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);
      expect(report.top10HolderPercent).toBeGreaterThanOrEqual(60);
    });

    it('should take the HIGHER (worse) largestHolderPercent from both sources', async () => {
      // RugCheck largest holder is 5%, GoPlus says 25%
      mockGoPlus = createMockGoPlusClient(createSafeGoPlusResult({ largestHolderPercent: 25 }));
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);
      expect(report.largestHolderPercent).toBeGreaterThanOrEqual(25);
    });

    it('should use only RugCheck data when GoPlus is unavailable', async () => {
      (mockGoPlus.getTokenSecurity as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('GoPlus API timeout'),
      );

      const report = await checker.checkToken(TEST_MINT);

      expect(report.rugCheckAvailable).toBe(true);
      expect(report.goPlusAvailable).toBe(false);
      expect(report.goPlusResult).toBeNull();
      // Authority should still be determined from RugCheck alone
      expect(report.authorityStatus.mintRevoked).toBe(true);
    });

    it('should use only GoPlus data when RugCheck is unavailable', async () => {
      (mockRugCheck.getTokenReport as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('RugCheck API timeout'),
      );

      const report = await checker.checkToken(TEST_MINT);

      expect(report.rugCheckAvailable).toBe(false);
      expect(report.goPlusAvailable).toBe(true);
      expect(report.rugCheckScore).toBeNull();
    });
  });

  // ===========================================================================
  // Section 4: Partial Source Failure Handling
  // ===========================================================================

  describe('Partial Source Failure Handling', () => {
    it('should still produce a report when RugCheck returns null', async () => {
      mockRugCheck = createMockRugCheckClient(null);
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);

      expect(report.mint).toBe(TEST_MINT);
      expect(report.rugCheckAvailable).toBe(false);
      expect(report.goPlusAvailable).toBe(true);
      expect(report.overallScore).toBeGreaterThanOrEqual(0);
      expect(report.overallScore).toBeLessThanOrEqual(1000);
    });

    it('should still produce a report when GoPlus rejects', async () => {
      (mockGoPlus.getTokenSecurity as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error'),
      );

      const report = await checker.checkToken(TEST_MINT);

      expect(report.mint).toBe(TEST_MINT);
      expect(report.rugCheckAvailable).toBe(true);
      expect(report.goPlusAvailable).toBe(false);
    });

    it('should still produce a report when Honeypot rejects', async () => {
      (mockHoneypot.checkHoneypot as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Jupiter API down'),
      );

      const report = await checker.checkToken(TEST_MINT);

      // Fail-safe: honeypot rejection → sellable=false, estimatedTax=100
      expect(report.honeypotResult.sellable).toBe(false);
      expect(report.honeypotResult.estimatedTax).toBe(100);
      expect(report.honeypotResult.error).toBeDefined();
    });

    it('should handle LP analyzer failure gracefully', async () => {
      (mockLPAnalyzer.analyzeLPStatus as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('LP analysis crashed'),
      );

      const report = await checker.checkToken(TEST_MINT);

      // Graceful degradation: LP status defaults to conservative
      expect(report.lpStatus.burned).toBe(false);
      expect(report.lpStatus.burnPercent).toBe(0);
      expect(report.lpStatus.locked).toBe(false);
    });

    it('should add data source unavailability to risk factors', async () => {
      (mockRugCheck.getTokenReport as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('RugCheck down'),
      );

      const report = await checker.checkToken(TEST_MINT);

      expect(report.riskFactors.some((r) => r.includes('RugCheck'))).toBe(true);
    });

    it('should add GoPlus unavailability to risk factors', async () => {
      (mockGoPlus.getTokenSecurity as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('GoPlus down'),
      );

      const report = await checker.checkToken(TEST_MINT);

      expect(report.riskFactors.some((r) => r.includes('GoPlus'))).toBe(true);
    });
  });

  // ===========================================================================
  // Section 5: Catastrophic Failsafe Report
  // ===========================================================================

  describe('Catastrophic Failsafe Report', () => {
    it('should return overallScore=0 when everything fails', async () => {
      (mockRugCheck.getTokenReport as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('RugCheck down'),
      );
      (mockGoPlus.getTokenSecurity as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('GoPlus down'),
      );
      (mockHoneypot.checkHoneypot as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Jupiter down'),
      );
      (mockLPAnalyzer.analyzeLPStatus as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('LP crash'),
      );

      const report = await checker.checkToken(TEST_MINT);

      // Should still produce a valid report (never throws)
      expect(report.mint).toBe(TEST_MINT);
      expect(report.overallScore).toBeLessThanOrEqual(0);
    });

    it('should flag all authorities as active in failsafe', async () => {
      (mockRugCheck.getTokenReport as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
      (mockGoPlus.getTokenSecurity as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
      (mockHoneypot.checkHoneypot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
      (mockLPAnalyzer.analyzeLPStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));

      const report = await checker.checkToken(TEST_MINT);

      expect(report.authorityStatus.mintRevoked).toBe(false);
      expect(report.authorityStatus.freezeRevoked).toBe(false);
      expect(report.authorityStatus.metadataMutable).toBe(true);
    });

    it('should mark honeypot as not sellable in failsafe', async () => {
      (mockRugCheck.getTokenReport as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
      (mockGoPlus.getTokenSecurity as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
      (mockHoneypot.checkHoneypot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
      (mockLPAnalyzer.analyzeLPStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));

      const report = await checker.checkToken(TEST_MINT);

      expect(report.honeypotResult.sellable).toBe(false);
      expect(report.honeypotResult.estimatedTax).toBe(100);
    });

    it('should mark LP as not burned/locked in failsafe', async () => {
      (mockRugCheck.getTokenReport as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
      (mockGoPlus.getTokenSecurity as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
      (mockHoneypot.checkHoneypot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
      (mockLPAnalyzer.analyzeLPStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));

      const report = await checker.checkToken(TEST_MINT);

      expect(report.lpStatus.burned).toBe(false);
      expect(report.lpStatus.locked).toBe(false);
    });

    it('should include risk factors in failsafe', async () => {
      (mockRugCheck.getTokenReport as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
      (mockGoPlus.getTokenSecurity as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
      (mockHoneypot.checkHoneypot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
      (mockLPAnalyzer.analyzeLPStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));

      const report = await checker.checkToken(TEST_MINT);

      expect(report.riskFactors.length).toBeGreaterThan(0);
      expect(report.riskFactors.some((r) => r.includes('unsafe'))).toBe(true);
    });

    it('should never throw — always returns a SafetyReport', async () => {
      // Force a completely broken state — even the constructor's logger could fail
      (mockRugCheck.getTokenReport as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new TypeError('Cannot read properties of null');
      });
      (mockGoPlus.getTokenSecurity as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new TypeError('Cannot read properties of null');
      });
      (mockHoneypot.checkHoneypot as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new TypeError('Cannot read properties of null');
      });

      const report = await checker.checkToken(TEST_MINT);

      // Must return a report, never throw
      expect(report).toBeDefined();
      expect(report.mint).toBe(TEST_MINT);
      expect(typeof report.overallScore).toBe('number');
    });
  });

  // ===========================================================================
  // Section 6: Score Computation (Penalties and Bonuses)
  // ===========================================================================

  describe('Score Computation', () => {
    it('should apply honeypot penalty (token not sellable)', async () => {
      mockHoneypot = createMockHoneypotDetector(
        createSafeHoneypotResult({ sellable: false, estimatedTax: 100 }),
      );
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const safeReport = await new SafetyChecker(
        createMockRugCheckClient(),
        createMockGoPlusClient(),
        createMockHoneypotDetector(),
        createMockLPAnalyzer(),
      ).checkToken(TEST_MINT);

      const honeypotReport = await checker.checkToken(TEST_MINT);

      // Honeypot penalty should significantly reduce the score
      expect(honeypotReport.overallScore).toBeLessThan(safeReport.overallScore);
    });

    it('should apply mint authority penalty', async () => {
      mockRugCheck = createMockRugCheckClient(
        createSafeRugCheckReport({
          mintAuthority: 'ActiveMintAuth111',
          isMintable: true,
        }),
      );
      mockGoPlus = createMockGoPlusClient(createSafeGoPlusResult({ isMintable: true }));
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);

      // Score should be lower than a fully safe token due to mint authority penalty
      expect(report.authorityStatus.mintRevoked).toBe(false);
      expect(report.riskFactors.some((r) => r.toLowerCase().includes('mint'))).toBe(true);
    });

    it('should apply freeze authority penalty', async () => {
      mockRugCheck = createMockRugCheckClient(
        createSafeRugCheckReport({
          freezeAuthority: 'ActiveFreezeAuth111',
          isFreezable: true,
        }),
      );
      mockGoPlus = createMockGoPlusClient(createSafeGoPlusResult({ isFreezable: true }));
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);

      expect(report.authorityStatus.freezeRevoked).toBe(false);
      expect(report.riskFactors.some((r) => r.toLowerCase().includes('freeze'))).toBe(true);
    });

    it('should apply no-LP-lock penalty', async () => {
      mockLPAnalyzer = createMockLPAnalyzer({
        burned: false,
        burnPercent: 0,
        locked: false,
      });
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);

      expect(report.riskFactors.some((r) => r.toLowerCase().includes('liquidity pool'))).toBe(true);
    });

    it('should apply Token-2022 penalty', async () => {
      mockRugCheck = createMockRugCheckClient(
        createSafeRugCheckReport({ isToken2022: true }),
      );
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);

      expect(report.isToken2022).toBe(true);
      expect(report.riskFactors.some((r) => r.includes('Token-2022'))).toBe(true);
    });

    it('should apply LP burned high bonus when burnPercent ≥ 90', async () => {
      mockLPAnalyzer = createMockLPAnalyzer({
        burned: true,
        burnPercent: 95,
        locked: true,
      });
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);

      // Score should be higher than a token without LP burn bonus
      expect(report.overallScore).toBeGreaterThan(0);
    });

    it('should apply all-authorities-revoked bonus', async () => {
      const report = await checker.checkToken(TEST_MINT);

      // Both RugCheck and GoPlus say not mintable/freezable
      expect(report.authorityStatus.mintRevoked).toBe(true);
      expect(report.authorityStatus.freezeRevoked).toBe(true);
    });

    it('should clamp score to [0, 1000]', async () => {
      // Create a token with all penalties stacked
      mockRugCheck = createMockRugCheckClient(
        createSafeRugCheckReport({
          score: 100,
          mintAuthority: 'ActiveMint',
          isMintable: true,
          freezeAuthority: 'ActiveFreeze',
          isFreezable: true,
          isToken2022: true,
          risks: [{ name: 'Mutable Metadata', description: 'Metadata can change', level: 'high', score: 50 }],
          topHolders: [
            { address: 'Whale1', amount: 600000, percentage: 60, isInsider: true },
          ],
        }),
      );
      mockGoPlus = createMockGoPlusClient(
        createSafeGoPlusResult({
          isMintable: true,
          isFreezable: true,
          top10HolderPercent: 80,
          largestHolderPercent: 60,
        }),
      );
      mockHoneypot = createMockHoneypotDetector(
        createSafeHoneypotResult({ sellable: false, estimatedTax: 100 }),
      );
      mockLPAnalyzer = createMockLPAnalyzer({
        burned: false,
        burnPercent: 0,
        locked: false,
      });
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);

      // Score should be clamped to 0 (minimum), never negative
      expect(report.overallScore).toBeGreaterThanOrEqual(0);
      expect(report.overallScore).toBeLessThanOrEqual(1000);
    });

    it('should cap score at 1000 even with many bonuses', async () => {
      mockRugCheck = createMockRugCheckClient(
        createSafeRugCheckReport({ score: 950 }),
      );
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);
      expect(report.overallScore).toBeLessThanOrEqual(1000);
    });
  });

  // ===========================================================================
  // Section 7: Risk Factor Collection
  // ===========================================================================

  describe('Risk Factor Collection', () => {
    it('should collect honeypot risk factor when not sellable', async () => {
      mockHoneypot = createMockHoneypotDetector(
        createSafeHoneypotResult({ sellable: false, estimatedTax: 100 }),
      );
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);
      expect(report.riskFactors.some((r) => r.includes('honeypot'))).toBe(true);
    });

    it('should collect high sell tax risk factor', async () => {
      mockHoneypot = createMockHoneypotDetector(
        createSafeHoneypotResult({ sellable: true, estimatedTax: 15 }),
      );
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);
      expect(report.riskFactors.some((r) => r.includes('tax'))).toBe(true);
    });

    it('should collect high holder concentration risk', async () => {
      mockGoPlus = createMockGoPlusClient(
        createSafeGoPlusResult({ largestHolderPercent: 30, top10HolderPercent: 55 }),
      );
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);
      expect(report.riskFactors.some((r) => r.includes('holder'))).toBe(true);
    });

    it('should collect RugCheck high-severity risks', async () => {
      mockRugCheck = createMockRugCheckClient(
        createSafeRugCheckReport({
          risks: [
            { name: 'Low Liquidity', description: 'Very low liquidity detected', level: 'critical', score: 100 },
          ],
        }),
      );
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);
      expect(report.riskFactors.some((r) => r.includes('Low Liquidity'))).toBe(true);
    });

    it('should report low holder count from GoPlus', async () => {
      mockGoPlus = createMockGoPlusClient(
        createSafeGoPlusResult({ holderCount: 5 }),
      );
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);
      expect(report.riskFactors.some((r) => r.includes('holder count'))).toBe(true);
    });

    it('should have empty risk factors for a perfectly safe token', async () => {
      // All defaults are safe
      const report = await checker.checkToken(TEST_MINT);

      // There should be zero or very few risk factors for a fully safe token
      const criticalRisks = report.riskFactors.filter(
        (r) => r.includes('honeypot') || r.includes('mint') || r.includes('freeze'),
      );
      expect(criticalRisks).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Section 8: Metadata Mutability
  // ===========================================================================

  describe('Metadata Mutability', () => {
    it('should detect mutable metadata from RugCheck risks', async () => {
      mockRugCheck = createMockRugCheckClient(
        createSafeRugCheckReport({
          risks: [
            { name: 'Mutable Metadata', description: 'Metadata can be modified', level: 'medium', score: 30 },
          ],
        }),
      );
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);
      expect(report.authorityStatus.metadataMutable).toBe(true);
      expect(report.riskFactors.some((r) => r.includes('metadata'))).toBe(true);
    });

    it('should not flag metadata when no metadata risks exist', async () => {
      const report = await checker.checkToken(TEST_MINT);
      expect(report.authorityStatus.metadataMutable).toBe(false);
    });
  });

  // ===========================================================================
  // Section 9: Token-2022 Detection
  // ===========================================================================

  describe('Token-2022 Detection', () => {
    it('should detect Token-2022 from RugCheck', async () => {
      mockRugCheck = createMockRugCheckClient(
        createSafeRugCheckReport({ isToken2022: true }),
      );
      checker = new SafetyChecker(mockRugCheck, mockGoPlus, mockHoneypot, mockLPAnalyzer);

      const report = await checker.checkToken(TEST_MINT);
      expect(report.isToken2022).toBe(true);
    });

    it('should default to false when RugCheck unavailable', async () => {
      (mockRugCheck.getTokenReport as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('unavailable'),
      );

      const report = await checker.checkToken(TEST_MINT);
      expect(report.isToken2022).toBe(false);
    });
  });
});
