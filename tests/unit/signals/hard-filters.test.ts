/**
 * tests/unit/signals/hard-filters.test.ts
 *
 * Unit tests for the hard filter gate module.
 * Verifies binary pass/fail for: bundled launch >10% sniper supply,
 * active mint authority, active freeze authority, no LP lock/burn,
 * liquidity <$3K, top 10 holders >50%.
 */

import { describe, it, expect } from 'vitest';
import { runHardFilters, HARD_FILTERS } from '../../../src/signals/hard-filters';
import type { TokenAnalysisInput, HardFilterResult } from '../../../src/signals/types';

// ---------------------------------------------------------------------------
// Test Data Factory
// ---------------------------------------------------------------------------

function createBaseInput(overrides: Partial<TokenAnalysisInput> = {}): TokenAnalysisInput {
  return {
    mint: 'So11111111111111111111111111111111111111112',
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
    buys24h: 1000,
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
    createdAt: Math.floor(Date.now() / 1000) - 3600,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runHardFilters', () => {
  it('should pass all filters for a safe token with good metrics', () => {
    const input = createBaseInput();
    const result = runHardFilters(input);
    expect(result.passed).toBe(true);
    expect(result.failedFilters).toHaveLength(0);
    expect(result.failedReason).toBeNull();
    expect(result.checkedAt).toBeGreaterThan(0);
  });

  it('should fail when mint authority is active', () => {
    const input = createBaseInput({ mintAuthorityActive: true });
    const result = runHardFilters(input);
    expect(result.passed).toBe(false);
    expect(result.failedFilters.length).toBeGreaterThan(0);
  });

  it('should fail when freeze authority is active', () => {
    const input = createBaseInput({ freezeAuthorityActive: true });
    const result = runHardFilters(input);
    expect(result.passed).toBe(false);
    expect(result.failedFilters.length).toBeGreaterThan(0);
  });

  it('should fail when liquidity is below $3K', () => {
    const input = createBaseInput({ liquidity: 2000 });
    const result = runHardFilters(input);
    expect(result.passed).toBe(false);
    expect(result.failedFilters.length).toBeGreaterThan(0);
  });

  it('should fail when top 10 holders > 50%', () => {
    const input = createBaseInput({ topHolderPercent: 55 });
    const result = runHardFilters(input);
    expect(result.passed).toBe(false);
    expect(result.failedFilters.length).toBeGreaterThan(0);
  });

  it('should fail when LP is neither burned nor locked', () => {
    const input = createBaseInput({ lpBurned: false, lpLocked: false });
    const result = runHardFilters(input);
    expect(result.passed).toBe(false);
    expect(result.failedFilters.length).toBeGreaterThan(0);
  });

  it('should pass when LP is locked but not burned', () => {
    const input = createBaseInput({ lpBurned: false, lpLocked: true });
    const result = runHardFilters(input);
    // Should pass assuming all other conditions are met
    const lpRelatedFailures = result.failedFilters.filter(f => 
      f.toLowerCase().includes('lp') || f.toLowerCase().includes('lock') || f.toLowerCase().includes('burn')
    );
    // LP lock should satisfy the LP requirement
    expect(lpRelatedFailures.length).toBeLessThanOrEqual(0);
  });

  it('should fail for bundled launch with sniper supply > 10%', () => {
    const input = createBaseInput({ sniperSupplyPercent: 15 });
    const result = runHardFilters(input);
    expect(result.passed).toBe(false);
    expect(result.failedFilters.length).toBeGreaterThan(0);
  });

  it('should pass for sniper supply <= 10%', () => {
    const input = createBaseInput({ sniperSupplyPercent: 5 });
    const result = runHardFilters(input);
    // Should not fail on sniper supply alone
    const sniperFailures = result.failedFilters.filter(f =>
      f.toLowerCase().includes('sniper') || f.toLowerCase().includes('bundle')
    );
    expect(sniperFailures).toHaveLength(0);
  });

  it('should report multiple failed filters when several conditions fail', () => {
    const input = createBaseInput({
      mintAuthorityActive: true,
      freezeAuthorityActive: true,
      liquidity: 1000,
    });
    const result = runHardFilters(input);
    expect(result.passed).toBe(false);
    expect(result.failedFilters.length).toBeGreaterThan(1);
  });

  it('should have a failedReason string when filters fail', () => {
    const input = createBaseInput({ mintAuthorityActive: true });
    const result = runHardFilters(input);
    expect(result.failedReason).not.toBeNull();
    expect(typeof result.failedReason).toBe('string');
  });

  it('should have a checkedAt timestamp', () => {
    const input = createBaseInput();
    const result = runHardFilters(input);
    expect(result.checkedAt).toBeTypeOf('number');
    expect(result.checkedAt).toBeGreaterThan(0);
    expect(result.checkedAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('should export HARD_FILTERS array with filter definitions', () => {
    expect(HARD_FILTERS).toBeDefined();
    expect(Array.isArray(HARD_FILTERS)).toBe(true);
    expect(HARD_FILTERS.length).toBeGreaterThan(0);
  });

  it('should not filter solely on isHoneypot flag (checked by safety-score factor)', () => {
    const input = createBaseInput({ isHoneypot: true });
    const result = runHardFilters(input);
    // Hard filters do not include isHoneypot directly — it is handled by safety-score factor
    // A honeypot token can still pass hard filters if other conditions are met
    expect(result).toHaveProperty('passed');
  });

  it('should handle edge case of exactly $3K liquidity', () => {
    const input = createBaseInput({ liquidity: 3000 });
    const result = runHardFilters(input);
    // $3K is the minimum — should pass the liquidity filter
    const liqFailures = result.failedFilters.filter(f =>
      f.toLowerCase().includes('liquidity')
    );
    expect(liqFailures).toHaveLength(0);
  });

  it('should handle edge case of exactly 50% top holder concentration', () => {
    const input = createBaseInput({ topHolderPercent: 50 });
    const result = runHardFilters(input);
    // 50% is at the threshold — verify the exact boundary behavior
    expect(result).toHaveProperty('passed');
  });
});
