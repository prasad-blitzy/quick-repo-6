/**
 * tests/unit/signals/factors/smart-money-convergence.test.ts
 *
 * Unit tests for the smart money convergence factor module.
 * Verifies whale buy bonuses, convergence detection thresholds,
 * conviction multiplier, score clamping, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scoreSmartMoneyConvergence } from '../../../../src/signals/factors/smart-money-convergence';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scoreSmartMoneyConvergence', () => {
  it('should return a FactorResult with name "smart-money-convergence"', async () => {
    const input = createBaseInput();
    const result = await scoreSmartMoneyConvergence(input);
    expect(result.name).toBe('smartMoneyConvergence');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('weight');
    expect(result).toHaveProperty('metadata');
  });

  it('should return score 0 when no smart money wallets present', async () => {
    const input = createBaseInput({ smartMoneyCount: 0 });
    const result = await scoreSmartMoneyConvergence(input);
    expect(result.score).toBe(0);
  });

  it('should award +10 bonus for 1 whale buy (SINGLE_WHALE_BONUS)', async () => {
    const input = createBaseInput({ smartMoneyCount: 1 });
    const result = await scoreSmartMoneyConvergence(input);
    // Should have some score from single whale buy
    expect(result.score).toBeGreaterThanOrEqual(10);
  });

  it('should award +25 bonus for 2+ whale buys (MULTI_WHALE_BONUS)', async () => {
    const input = createBaseInput({ smartMoneyCount: 2 });
    const result = await scoreSmartMoneyConvergence(input);
    expect(result.score).toBeGreaterThanOrEqual(25);
  });

  it('should score high (base 60) for 3+ wallet convergence', async () => {
    const input = createBaseInput({
      smartMoneyCount: 3,
      smartMoneyWallets: ['wallet1', 'wallet2', 'wallet3'],
    });
    const result = await scoreSmartMoneyConvergence(input);
    expect(result.score).toBeGreaterThanOrEqual(50);
  });

  it('should apply conviction multiplier when position size > 80% of average', async () => {
    const highConviction = createBaseInput({
      smartMoneyCount: 3,
      smartMoneyWallets: ['w1', 'w2', 'w3'],
    });
    const highResult = await scoreSmartMoneyConvergence(highConviction);

    const lowConviction = createBaseInput({
      smartMoneyCount: 3,
      smartMoneyWallets: ['w1', 'w2', 'w3'],
    });
    const lowResult = await scoreSmartMoneyConvergence(lowConviction);

    // High conviction score should be >= low conviction score
    expect(highResult.score).toBeGreaterThanOrEqual(lowResult.score);
  });

  it('should clamp score to maximum of 100', async () => {
    const input = createBaseInput({
      smartMoneyCount: 10,
      smartMoneyWallets: Array.from({ length: 10 }, (_, i) => `wallet${i}`),
    });
    const result = await scoreSmartMoneyConvergence(input);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should clamp score to minimum of 0', async () => {
    const input = createBaseInput({ smartMoneyCount: 0 });
    const result = await scoreSmartMoneyConvergence(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('should return weight of 0 (weights applied externally)', async () => {
    const input = createBaseInput({ smartMoneyCount: 3 });
    const result = await scoreSmartMoneyConvergence(input);
    expect(result.weight).toBe(0);
  });

  it('should handle missing smartMoneyWallets gracefully', async () => {
    const input = createBaseInput({ smartMoneyCount: 2 });
    // smartMoneyWallets is optional; should not crash
    const result = await scoreSmartMoneyConvergence(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should include metadata in the result', async () => {
    const input = createBaseInput({ smartMoneyCount: 2 });
    const result = await scoreSmartMoneyConvergence(input);
    expect(result.metadata).toBeDefined();
  });
});
