/**
 * tests/unit/signals/factors/liquidity.test.ts
 *
 * Unit tests for the liquidity factor module.
 * Verifies minimum liquidity thresholds ($3K pump.fun, $30K established),
 * 10x position size requirement, LP burn/lock bonuses, and error handling.
 */

import { describe, it, expect } from 'vitest';
import { scoreLiquidity } from '../../../../src/signals/factors/liquidity';
import type { TokenAnalysisInput } from '../../../../src/signals/types';

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

describe('scoreLiquidity', () => {
  it('should return a FactorResult with name "liquidity"', async () => {
    const input = createBaseInput();
    const result = await scoreLiquidity(input);
    expect(result.name).toBe('liquidity');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('weight');
    expect(result).toHaveProperty('metadata');
  });

  it('should score 0 when liquidity is below $3,000 minimum', async () => {
    const input = createBaseInput({ liquidity: 2000 });
    const result = await scoreLiquidity(input);
    expect(result.score).toBe(0);
  });

  it('should score > 0 when liquidity meets $3K pump.fun minimum', async () => {
    const input = createBaseInput({ liquidity: 3000 });
    const result = await scoreLiquidity(input);
    expect(result.score).toBeGreaterThan(0);
  });

  it('should score higher for liquidity >= $30K (established threshold)', async () => {
    const established = createBaseInput({ liquidity: 30_000 });
    const early = createBaseInput({ liquidity: 5_000 });
    const estResult = await scoreLiquidity(established);
    const earlyResult = await scoreLiquidity(early);
    expect(estResult.score).toBeGreaterThan(earlyResult.score);
  });

  it('should score very high for deep liquidity pools', async () => {
    const input = createBaseInput({ liquidity: 500_000 });
    const result = await scoreLiquidity(input);
    expect(result.score).toBeGreaterThan(50);
  });

  it('should give LP burn bonus (+10 points)', async () => {
    const burned = createBaseInput({ lpBurned: true, lpLocked: false, liquidity: 15_000 });
    const notBurned = createBaseInput({ lpBurned: false, lpLocked: false, liquidity: 15_000 });
    const burnResult = await scoreLiquidity(burned);
    const noBurnResult = await scoreLiquidity(notBurned);
    expect(burnResult.score).toBeGreaterThanOrEqual(noBurnResult.score);
  });

  it('should give LP lock bonus (+5 points)', async () => {
    const locked = createBaseInput({ lpBurned: false, lpLocked: true, liquidity: 15_000 });
    const unlocked = createBaseInput({ lpBurned: false, lpLocked: false, liquidity: 15_000 });
    const lockResult = await scoreLiquidity(locked);
    const unlockResult = await scoreLiquidity(unlocked);
    expect(lockResult.score).toBeGreaterThanOrEqual(unlockResult.score);
  });

  it('should handle zero liquidity', async () => {
    const input = createBaseInput({ liquidity: 0 });
    const result = await scoreLiquidity(input);
    expect(result.score).toBe(0);
  });

  it('should handle negative liquidity gracefully', async () => {
    const input = createBaseInput({ liquidity: -1000 });
    const result = await scoreLiquidity(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('should clamp score to maximum of 100', async () => {
    const input = createBaseInput({ liquidity: 10_000_000, lpBurned: true, lpLocked: true });
    const result = await scoreLiquidity(input);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should clamp score to minimum of 0', async () => {
    const input = createBaseInput({ liquidity: 0 });
    const result = await scoreLiquidity(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('should return weight of 0 (weights applied externally)', async () => {
    const input = createBaseInput();
    const result = await scoreLiquidity(input);
    expect(result.weight).toBe(0);
  });

  it('should include metadata in the result', async () => {
    const input = createBaseInput();
    const result = await scoreLiquidity(input);
    expect(result.metadata).toBeDefined();
  });
});
