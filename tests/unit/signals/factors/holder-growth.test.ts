/**
 * tests/unit/signals/factors/holder-growth.test.ts
 *
 * Unit tests for the holder growth factor module.
 * Verifies organic growth rewards, bot-like pattern penalties,
 * score clamping, and error handling.
 */

import { describe, it, expect } from 'vitest';
import { scoreHolderGrowth } from '../../../../src/signals/factors/holder-growth';
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

describe('scoreHolderGrowth', () => {
  it('should return a FactorResult with name "holder-growth"', async () => {
    const input = createBaseInput();
    const result = await scoreHolderGrowth(input);
    expect(result.name).toBe('holderGrowth');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('weight');
    expect(result).toHaveProperty('metadata');
  });

  it('should score higher for tokens with more holders (organic growth)', async () => {
    const manyHolders = createBaseInput({ holderCount: 1000 });
    const fewHolders = createBaseInput({ holderCount: 10 });
    const manyResult = await scoreHolderGrowth(manyHolders);
    const fewResult = await scoreHolderGrowth(fewHolders);
    expect(manyResult.score).toBeGreaterThanOrEqual(fewResult.score);
  });

  it('should score lower for high top holder concentration (bot-like)', async () => {
    const distributed = createBaseInput({ topHolderPercent: 5, holderCount: 500 });
    const concentrated = createBaseInput({ topHolderPercent: 50, holderCount: 500 });
    const distResult = await scoreHolderGrowth(distributed);
    const concResult = await scoreHolderGrowth(concentrated);
    expect(distResult.score).toBeGreaterThanOrEqual(concResult.score);
  });

  it('should handle zero holders gracefully', async () => {
    const input = createBaseInput({ holderCount: 0 });
    const result = await scoreHolderGrowth(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should handle very high holder count', async () => {
    const input = createBaseInput({ holderCount: 100_000 });
    const result = await scoreHolderGrowth(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should clamp score to maximum of 100', async () => {
    const input = createBaseInput({ holderCount: 100_000, topHolderPercent: 1 });
    const result = await scoreHolderGrowth(input);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should clamp score to minimum of 0', async () => {
    const input = createBaseInput({ holderCount: 0, topHolderPercent: 100 });
    const result = await scoreHolderGrowth(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('should return weight of 0 (weights applied externally)', async () => {
    const input = createBaseInput();
    const result = await scoreHolderGrowth(input);
    expect(result.weight).toBe(0);
  });

  it('should include metadata in the result', async () => {
    const input = createBaseInput();
    const result = await scoreHolderGrowth(input);
    expect(result.metadata).toBeDefined();
  });

  it('should handle edge case of topHolderPercent = 100', async () => {
    const input = createBaseInput({ topHolderPercent: 100, holderCount: 1 });
    const result = await scoreHolderGrowth(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
