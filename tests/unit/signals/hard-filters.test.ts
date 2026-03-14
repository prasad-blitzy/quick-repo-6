/**
 * tests/unit/signals/hard-filters.test.ts — Binary Pass/Fail Safety Gate Tests
 *
 * Comprehensive test suite for the hard filter safety gate module that verifies
 * binary pass/fail behavior for all 6 hard filter conditions:
 *
 * 1. Bundled launch with >10% sniper supply
 * 2. Active mint authority
 * 3. Active freeze authority
 * 4. No LP lock/burn
 * 5. Liquidity <$3K
 * 6. Top 10 holders >50% of supply
 *
 * Also tests: fail-open for missing data, multiple failure reporting,
 * human-readable failure reasons, and synchronous execution.
 *
 * Per AAP Section 0.7.3:
 * "Hard filters are absolute: If any hard filter fails, the token is immediately
 * classified as SKIP regardless of composite score — hard filters cannot be
 * overridden by high scores in other factors."
 *
 * Per AAP Section 0.1.1 (User Example — Signal Scoring Thresholds):
 * "Entry prevention (hard filters): Bundled launch with >10% sniper supply,
 * mint authority active, no LP lock, liquidity <$3K, top 10 holders >50%."
 *
 * @module tests/unit/signals/hard-filters
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TokenAnalysisInput, HardFilterResult } from '../../../src/signals/types';

// ---------------------------------------------------------------------------
// Module Mocks (hoisted by Vitest before any import resolution)
// ---------------------------------------------------------------------------

/**
 * Mock src/utils/config to provide deterministic threshold values for testing.
 * Prevents tests from depending on real configuration constants.
 *
 * Threshold values match AAP specifications:
 * - MAX_SNIPER_SUPPLY_PERCENT: 10 (>10% = FAIL)
 * - MIN_LIQUIDITY_USD: 3000 (<$3K = FAIL)
 * - MAX_TOP_10_HOLDER_PERCENT: 50 (>50% = FAIL)
 */
vi.mock('../../../src/utils/config', () => ({
  HARD_FILTER_THRESHOLDS: {
    MAX_SNIPER_SUPPLY_PERCENT: 10,
    MIN_LIQUIDITY_USD: 3000,
    MAX_TOP_10_HOLDER_PERCENT: 50,
    MIN_SAFETY_SCORE: 300,
    MAX_TOP_HOLDER_CONCENTRATION: 20,
  },
  // Provide other exports that might be referenced during module resolution
  API_BASE_URLS: {},
  DEFAULT_SCORING_WEIGHTS: {},
  SCORING_THRESHOLDS: {},
  RATE_LIMITS: {},
  DEFAULT_EXIT_STRATEGY: {},
  LLM_CONFIG: {},
  WEBSOCKET_CONFIG: {},
  EXTENSION_VERSION: '1.0.0',
}));

/**
 * Mock src/utils/logger to provide a no-op logger factory.
 * Prevents real console output during test execution and isolates tests
 * from logging side effects. Returns stubs for all log methods.
 */
vi.mock('../../../src/utils/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  LogLevel: {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  },
}));

// Import the function under test AFTER mocks are set up
// (Vitest hoists vi.mock() calls, but this ordering makes intent explicit)
import { runHardFilters } from '../../../src/signals/hard-filters';

// ---------------------------------------------------------------------------
// Mock Data Factory
// ---------------------------------------------------------------------------

/**
 * Creates a TokenAnalysisInput that passes ALL hard filters by default.
 *
 * All fields are set to safe values:
 * - sniperSupplyPercent: 5% (below 10% threshold)
 * - mintAuthorityActive: false (revoked — safe)
 * - freezeAuthorityActive: false (revoked — safe)
 * - lpBurned: true (burned — safe)
 * - lpLocked: true (locked — safe)
 * - liquidity: $25,000 (well above $3K minimum)
 * - topHolderPercent: 30% (below 50% threshold)
 *
 * Override specific fields to test individual filter failures.
 *
 * @param overrides - Partial<TokenAnalysisInput> fields to override safe defaults
 * @returns A fully-populated TokenAnalysisInput suitable for hard filter testing
 */
function createSafeTokenInput(overrides?: Partial<TokenAnalysisInput>): TokenAnalysisInput {
  return {
    // === Identity ===
    mint: 'SafeMint111111111111111111111111111111111111',
    symbol: 'SAFE',
    name: 'Safe Token',

    // === Price Data ===
    price: 0.0001,
    priceChange5m: 5.0,
    priceChange1h: 10.0,
    priceChange24h: 30.0,

    // === Market Data ===
    marketCap: 100000,
    volume5m: 500,
    volume1h: 5000,
    volume24h: 50000,
    liquidity: 25000,          // $25K — well above $3K minimum
    supply: 1000000000,

    // === Trading Activity ===
    buys1h: 50,
    sells1h: 20,
    buys24h: 500,
    sells24h: 200,

    // === Holder Data ===
    holderCount: 500,
    topHolderPercent: 30,      // 30% — below 50% threshold

    // === Smart Money ===
    smartMoneyCount: 3,

    // === Safety & Authority ===
    mintAuthorityActive: false,   // Revoked — SAFE
    freezeAuthorityActive: false, // Revoked — SAFE
    lpBurned: true,               // Burned — SAFE
    lpLocked: true,               // Locked — SAFE
    lpBurnPercent: 95,
    isHoneypot: false,
    safetyScore: 500,
    metadataMutable: false,

    // === Sniper & Bundle Detection ===
    sniperSupplyPercent: 5,    // 5% — below 10% threshold

    // === Developer Wallet ===
    devWalletAddress: 'Dev11111111111111111111111111111111111111111',
    devWalletSold: false,

    // === Token Age ===
    createdAt: Math.floor(Date.now() / 1000) - 3600,

    // Apply overrides last to allow selective field replacement
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle Hooks
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// Test Suites
// ===========================================================================

describe('runHardFilters', () => {
  // =========================================================================
  // Phase 3: All Filters Pass (Baseline Safe Token)
  // =========================================================================

  describe('all filters pass (baseline safe token)', () => {
    it('should return passed: true for a completely safe token', () => {
      const input = createSafeTokenInput();
      const result = runHardFilters(input);

      expect(result.passed).toBe(true);
      expect(result.failedFilters).toHaveLength(0);
      expect(result.failedReason).toBeNull();
    });

    it('should return a valid HardFilterResult structure', () => {
      const result = runHardFilters(createSafeTokenInput());

      // Verify all required properties exist on the result
      expect(result).toHaveProperty('passed');
      expect(result).toHaveProperty('failedFilters');
      expect(result).toHaveProperty('failedReason');
      expect(result).toHaveProperty('checkedAt');

      // checkedAt should be a positive Unix timestamp in milliseconds
      expect(typeof result.checkedAt).toBe('number');
      expect(result.checkedAt).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Phase 4: Bundled Launch — Sniper Supply >10% (CRITICAL)
  // =========================================================================

  describe('bundled launch — sniper supply >10%', () => {
    it('should FAIL when sniperSupplyPercent is 11%', () => {
      const input = createSafeTokenInput({ sniperSupplyPercent: 11 });
      const result = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toContain('bundled-launch');
    });

    it('should FAIL when sniperSupplyPercent is 50%', () => {
      const input = createSafeTokenInput({ sniperSupplyPercent: 50 });
      const result = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toContain('bundled-launch');
    });

    it('should PASS when sniperSupplyPercent is exactly 10% (boundary)', () => {
      // Boundary: 10% is <= threshold of 10%, so it should PASS
      const input = createSafeTokenInput({ sniperSupplyPercent: 10 });
      const result = runHardFilters(input);

      expect(result.passed).toBe(true);
      expect(result.failedFilters).not.toContain('bundled-launch');
    });

    it('should PASS when sniperSupplyPercent is 5%', () => {
      const input = createSafeTokenInput({ sniperSupplyPercent: 5 });
      const result = runHardFilters(input);

      expect(result.passed).toBe(true);
      expect(result.failedFilters).not.toContain('bundled-launch');
    });

    it('should PASS when sniperSupplyPercent is 0%', () => {
      const input = createSafeTokenInput({ sniperSupplyPercent: 0 });
      const result = runHardFilters(input);

      expect(result.passed).toBe(true);
      expect(result.failedFilters).not.toContain('bundled-launch');
    });
  });

  // =========================================================================
  // Phase 5: Active Mint Authority (CRITICAL)
  // =========================================================================

  describe('active mint authority', () => {
    it('should FAIL when mintAuthorityActive is true', () => {
      const input = createSafeTokenInput({ mintAuthorityActive: true });
      const result = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toContain('mint-authority-active');
    });

    it('should PASS when mintAuthorityActive is false', () => {
      const input = createSafeTokenInput({ mintAuthorityActive: false });
      const result = runHardFilters(input);

      // The mint-authority-active filter should NOT appear in failedFilters
      expect(result.failedFilters).not.toContain('mint-authority-active');
    });
  });

  // =========================================================================
  // Phase 6: Active Freeze Authority (CRITICAL)
  // =========================================================================

  describe('active freeze authority', () => {
    it('should FAIL when freezeAuthorityActive is true', () => {
      const input = createSafeTokenInput({ freezeAuthorityActive: true });
      const result = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toContain('freeze-authority-active');
    });

    it('should PASS when freezeAuthorityActive is false', () => {
      const input = createSafeTokenInput({ freezeAuthorityActive: false });
      const result = runHardFilters(input);

      // The freeze-authority-active filter should NOT appear in failedFilters
      expect(result.failedFilters).not.toContain('freeze-authority-active');
    });
  });

  // =========================================================================
  // Phase 7: No LP Lock/Burn (CRITICAL)
  // =========================================================================

  describe('no LP lock/burn', () => {
    it('should FAIL when neither LP burned NOR locked', () => {
      const input = createSafeTokenInput({ lpBurned: false, lpLocked: false });
      const result = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toContain('no-lp-lock-burn');
    });

    it('should PASS when LP is burned (even if not locked)', () => {
      const input = createSafeTokenInput({ lpBurned: true, lpLocked: false });
      const result = runHardFilters(input);

      // LP filter should NOT appear — burned LP is sufficient
      expect(result.failedFilters).not.toContain('no-lp-lock-burn');
    });

    it('should PASS when LP is locked (even if not burned)', () => {
      const input = createSafeTokenInput({ lpBurned: false, lpLocked: true });
      const result = runHardFilters(input);

      // LP filter should NOT appear — locked LP is sufficient
      expect(result.failedFilters).not.toContain('no-lp-lock-burn');
    });

    it('should PASS when LP is both burned AND locked', () => {
      const input = createSafeTokenInput({ lpBurned: true, lpLocked: true });
      const result = runHardFilters(input);

      // LP filter should NOT appear — both burned and locked is ideal
      expect(result.failedFilters).not.toContain('no-lp-lock-burn');
    });
  });

  // =========================================================================
  // Phase 8: Minimum Liquidity <$3K (CRITICAL)
  // =========================================================================

  describe('minimum liquidity <$3K', () => {
    it('should FAIL when liquidity is $2,999', () => {
      const input = createSafeTokenInput({ liquidity: 2999 });
      const result = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toContain('min-liquidity');
    });

    it('should FAIL when liquidity is $0', () => {
      const input = createSafeTokenInput({ liquidity: 0 });
      const result = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toContain('min-liquidity');
    });

    it('should PASS when liquidity is exactly $3,000 (boundary)', () => {
      // Boundary: $3,000 is >= threshold of $3,000, so it should PASS
      const input = createSafeTokenInput({ liquidity: 3000 });
      const result = runHardFilters(input);

      expect(result.passed).toBe(true);
      expect(result.failedFilters).not.toContain('min-liquidity');
    });

    it('should PASS when liquidity is $5,000', () => {
      const input = createSafeTokenInput({ liquidity: 5000 });
      const result = runHardFilters(input);

      expect(result.passed).toBe(true);
      expect(result.failedFilters).not.toContain('min-liquidity');
    });

    it('should PASS when liquidity is $100,000', () => {
      const input = createSafeTokenInput({ liquidity: 100000 });
      const result = runHardFilters(input);

      expect(result.passed).toBe(true);
      expect(result.failedFilters).not.toContain('min-liquidity');
    });
  });

  // =========================================================================
  // Phase 9: Top 10 Holder Concentration >50% (CRITICAL)
  // =========================================================================

  describe('top 10 holder concentration >50%', () => {
    it('should FAIL when topHolderPercent is 51%', () => {
      const input = createSafeTokenInput({ topHolderPercent: 51 });
      const result = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toContain('top-10-holder-concentration');
    });

    it('should FAIL when topHolderPercent is 80%', () => {
      const input = createSafeTokenInput({ topHolderPercent: 80 });
      const result = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toContain('top-10-holder-concentration');
    });

    it('should PASS when topHolderPercent is exactly 50% (boundary)', () => {
      // Boundary: 50% is <= threshold of 50%, so it should PASS
      const input = createSafeTokenInput({ topHolderPercent: 50 });
      const result = runHardFilters(input);

      expect(result.passed).toBe(true);
      expect(result.failedFilters).not.toContain('top-10-holder-concentration');
    });

    it('should PASS when topHolderPercent is 30%', () => {
      const input = createSafeTokenInput({ topHolderPercent: 30 });
      const result = runHardFilters(input);

      expect(result.passed).toBe(true);
      expect(result.failedFilters).not.toContain('top-10-holder-concentration');
    });
  });

  // =========================================================================
  // Phase 10: Fail-Open for Missing Data (CRITICAL)
  //
  // Per AAP: If a data field is undefined/null, the filter PASSES
  // (fail-open — can't verify = don't block). This applies to optional
  // numeric fields (sniperSupplyPercent, topHolderPercent) that may not
  // always be available from external API responses.
  // =========================================================================

  describe('fail-open for missing data', () => {
    it('should PASS when sniperSupplyPercent is undefined (fail-open)', () => {
      const input = createSafeTokenInput({ sniperSupplyPercent: undefined });
      const result = runHardFilters(input);

      // Bundled-launch filter should pass because data is unavailable
      expect(result.passed).toBe(true);
      expect(result.failedFilters).not.toContain('bundled-launch');
    });

    it('should PASS when sniperSupplyPercent is null (fail-open)', () => {
      const input = createSafeTokenInput({ sniperSupplyPercent: null as any });
      const result = runHardFilters(input);

      // Bundled-launch filter should pass because data is unavailable
      expect(result.failedFilters).not.toContain('bundled-launch');
    });

    it('should PASS when topHolderPercent is undefined (fail-open)', () => {
      const input = createSafeTokenInput({ topHolderPercent: undefined as any });
      const result = runHardFilters(input);

      // Holder concentration filter should pass because data is unavailable
      expect(result.failedFilters).not.toContain('top-10-holder-concentration');
    });

    it('should PASS when topHolderPercent is null (fail-open)', () => {
      const input = createSafeTokenInput({ topHolderPercent: null as any });
      const result = runHardFilters(input);

      // Holder concentration filter should pass because data is unavailable
      expect(result.failedFilters).not.toContain('top-10-holder-concentration');
    });

    it('fail-open applies ONLY to fields that may be unavailable, NOT to authority flags', () => {
      // mintAuthorityActive and freezeAuthorityActive are booleans that should
      // always be present. They use fail-close (blocking) for security because:
      // 1. Boolean flags have a natural safe default (false = revoked)
      // 2. Unknown authority status is a critical security risk
      // 3. These fields should always be populated from on-chain data
      //
      // This test verifies the design intent: when authority flags are explicitly
      // set to false (safe), they do not appear in failedFilters.
      const input = createSafeTokenInput({
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
      });
      const result = runHardFilters(input);

      expect(result.failedFilters).not.toContain('mint-authority-active');
      expect(result.failedFilters).not.toContain('freeze-authority-active');
    });
  });

  // =========================================================================
  // Phase 11: Multiple Filter Failures
  //
  // Per implementation: runHardFilters does NOT short-circuit — it evaluates
  // every filter regardless of prior failures, providing a complete report
  // of all failed conditions. This is critical for UI display and debugging.
  // =========================================================================

  describe('multiple filter failures', () => {
    it('should report ALL failed filters, not just the first', () => {
      const input = createSafeTokenInput({
        mintAuthorityActive: true,       // FAIL: mint-authority-active
        freezeAuthorityActive: true,     // FAIL: freeze-authority-active
        liquidity: 1000,                 // FAIL: min-liquidity
      });
      const result = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toHaveLength(3);
      expect(result.failedFilters).toContain('mint-authority-active');
      expect(result.failedFilters).toContain('freeze-authority-active');
      expect(result.failedFilters).toContain('min-liquidity');
    });

    it('should report ALL 6 failures when everything is bad', () => {
      const input = createSafeTokenInput({
        sniperSupplyPercent: 15,         // FAIL: >10%
        mintAuthorityActive: true,       // FAIL: active
        freezeAuthorityActive: true,     // FAIL: active
        lpBurned: false,                 // FAIL (combined):
        lpLocked: false,                 //   neither burned nor locked
        liquidity: 1000,                 // FAIL: <$3K
        topHolderPercent: 60,            // FAIL: >50%
      });
      const result = runHardFilters(input);

      expect(result.passed).toBe(false);
      expect(result.failedFilters).toHaveLength(6);

      // Verify all 6 filter names are present
      expect(result.failedFilters).toContain('bundled-launch');
      expect(result.failedFilters).toContain('mint-authority-active');
      expect(result.failedFilters).toContain('freeze-authority-active');
      expect(result.failedFilters).toContain('no-lp-lock-burn');
      expect(result.failedFilters).toContain('min-liquidity');
      expect(result.failedFilters).toContain('top-10-holder-concentration');
    });

    it('failedReason should be a human-readable string with all failure names', () => {
      const input = createSafeTokenInput({
        mintAuthorityActive: true,       // FAIL
        freezeAuthorityActive: true,     // FAIL
      });
      const result = runHardFilters(input);

      // failedReason should be a non-null string for failed tokens
      expect(result.failedReason).not.toBeNull();
      expect(typeof result.failedReason).toBe('string');

      // Should contain the count of failed filters
      expect(result.failedReason).toContain('Failed 2 hard filter(s)');

      // Should contain both failed filter names
      expect(result.failedReason!).toContain('mint-authority-active');
      expect(result.failedReason!).toContain('freeze-authority-active');
    });
  });

  // =========================================================================
  // Phase 12: Synchronous Execution
  //
  // runHardFilters must be synchronous — it reads local/cached data only
  // and should never perform async operations. This is critical for the
  // scoring engine's performance when processing many tokens.
  // =========================================================================

  describe('synchronous execution', () => {
    it('runHardFilters should be a synchronous function (not async)', () => {
      const result = runHardFilters(createSafeTokenInput());

      // Verify the result is NOT a Promise (synchronous return)
      expect(result).not.toBeInstanceOf(Promise);

      // Verify the result has the passed property immediately (no await needed)
      expect(result).toHaveProperty('passed');
      expect(typeof result.passed).toBe('boolean');
    });
  });
});
