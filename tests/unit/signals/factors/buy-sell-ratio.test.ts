/**
 * tests/unit/signals/factors/buy-sell-ratio.test.ts
 *
 * Unit tests for the buy/sell ratio factor module.
 * Verifies ratio threshold scoring (>=1.3x, >=2.0x, >=3.0x),
 * score clamping, and error handling.
 */

import { describe, it, expect } from 'vitest';
import { scoreBuySellRatio } from '../../../../src/signals/factors/buy-sell-ratio';
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

describe('scoreBuySellRatio', () => {
  it('should return a FactorResult with name "buy-sell-ratio"', async () => {
    const input = createBaseInput();
    const result = await scoreBuySellRatio(input);
    expect(result.name).toBe('buySellRatio');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('weight');
    expect(result).toHaveProperty('metadata');
  });

  it('should score low when buy/sell ratio is below 1.3x', async () => {
    // ratio = 60/50 = 1.2x — below the accumulation signal threshold
    const input = createBaseInput({ buys1h: 60, sells1h: 50 });
    const result = await scoreBuySellRatio(input);
    expect(result.score).toBeLessThan(60);
  });

  it('should score moderate for ratio at the 1.3x accumulation threshold', async () => {
    // ratio = 65/50 = 1.3x — base accumulation signal
    const input = createBaseInput({ buys1h: 65, sells1h: 50 });
    const result = await scoreBuySellRatio(input);
    expect(result.score).toBeGreaterThan(0);
  });

  it('should score higher for ratio >= 2.0x (strong accumulation)', async () => {
    // ratio = 100/50 = 2.0x
    const input = createBaseInput({ buys1h: 100, sells1h: 50 });
    const result = await scoreBuySellRatio(input);
    expect(result.score).toBeGreaterThan(30);
  });

  it('should score very high for ratio >= 3.0x (extreme accumulation)', async () => {
    // ratio = 150/50 = 3.0x
    const input = createBaseInput({ buys1h: 150, sells1h: 50 });
    const result = await scoreBuySellRatio(input);
    expect(result.score).toBeGreaterThan(50);
  });

  it('should handle zero sells without crashing', async () => {
    const input = createBaseInput({ buys1h: 100, sells1h: 0 });
    const result = await scoreBuySellRatio(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should handle zero buys', async () => {
    const input = createBaseInput({ buys1h: 0, sells1h: 100 });
    const result = await scoreBuySellRatio(input);
    expect(result.score).toBeLessThanOrEqual(20);
  });

  it('should handle both buys and sells being zero', async () => {
    const input = createBaseInput({ buys1h: 0, sells1h: 0 });
    const result = await scoreBuySellRatio(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('should clamp score to maximum of 100', async () => {
    const input = createBaseInput({ buys1h: 10000, sells1h: 1 });
    const result = await scoreBuySellRatio(input);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should clamp score to minimum of 0', async () => {
    const input = createBaseInput({ buys1h: 1, sells1h: 10000 });
    const result = await scoreBuySellRatio(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('should return weight of 0 (weights applied externally)', async () => {
    const input = createBaseInput();
    const result = await scoreBuySellRatio(input);
    expect(result.weight).toBe(0);
  });

  it('should include metadata in the result', async () => {
    const input = createBaseInput();
    const result = await scoreBuySellRatio(input);
    expect(result.metadata).toBeDefined();
  });

  it('should increase score monotonically as ratio increases', async () => {
    const ratios = [
      { buys1h: 50, sells1h: 50 },   // 1.0x
      { buys1h: 65, sells1h: 50 },   // 1.3x
      { buys1h: 100, sells1h: 50 },  // 2.0x
      { buys1h: 150, sells1h: 50 },  // 3.0x
    ];
    
    const scores: number[] = [];
    for (const r of ratios) {
      const result = await scoreBuySellRatio(createBaseInput(r));
      scores.push(result.score);
    }

    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
  });
});
