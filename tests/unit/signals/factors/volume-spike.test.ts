/**
 * tests/unit/signals/factors/volume-spike.test.ts
 *
 * Unit tests for the volume spike detection factor module.
 * Verifies spike multiplier detection, minimum volume thresholds,
 * volume-to-market-cap bonus, score clamping, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scoreVolumeSpike } from '../../../../src/signals/factors/volume-spike';
import type { TokenAnalysisInput, FactorResult } from '../../../../src/signals/types';

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
    createdAt: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scoreVolumeSpike', () => {
  it('should return a FactorResult with name "volume-spike"', async () => {
    const input = createBaseInput();
    const result = await scoreVolumeSpike(input);
    expect(result.name).toBe('volumeSpike');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('weight');
    expect(result).toHaveProperty('metadata');
  });

  it('should return score 0 when volume5m is below $200 minimum', async () => {
    const input = createBaseInput({ volume5m: 100, volume1h: 3000 });
    const result = await scoreVolumeSpike(input);
    expect(result.score).toBe(0);
  });

  it('should return score 0 when volume1h is below $2,000 minimum', async () => {
    const input = createBaseInput({ volume5m: 500, volume1h: 1000 });
    const result = await scoreVolumeSpike(input);
    expect(result.score).toBe(0);
  });

  it('should return score 0 when both volume5m and volume1h are zero', async () => {
    const input = createBaseInput({ volume5m: 0, volume1h: 0 });
    const result = await scoreVolumeSpike(input);
    expect(result.score).toBe(0);
  });

  it('should score higher for 3-8x spike (AAP sweet spot)', async () => {
    // 5m MA estimated from 1h volume: 5000/12 ≈ 416.67
    // With volume5m = 2000: spike = 2000/416.67 ≈ 4.8x → high zone
    const input = createBaseInput({ volume5m: 2000, volume1h: 5000 });
    const result = await scoreVolumeSpike(input);
    expect(result.score).toBeGreaterThan(40);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should score very high for extreme spike (>8x)', async () => {
    // Estimated MA = 5000/12 ≈ 416.67, volume5m = 5000: spike ≈ 12x
    const input = createBaseInput({ volume5m: 5000, volume1h: 5000 });
    const result = await scoreVolumeSpike(input);
    expect(result.score).toBeGreaterThan(70);
  });

  it('should score low for mild increase (< 1.5x)', async () => {
    // Estimated MA = 5000/12 ≈ 416.67, volume5m = 500: spike ≈ 1.2x
    const input = createBaseInput({ volume5m: 500, volume1h: 5000 });
    const result = await scoreVolumeSpike(input);
    expect(result.score).toBeLessThan(25);
  });

  it('should use volume5mMA if provided', async () => {
    // Explicit MA = 200, volume5m = 1000: spike = 5x → high zone
    const input = createBaseInput({ volume5m: 1000, volume1h: 5000, volume5mMA: 200 });
    const result = await scoreVolumeSpike(input);
    expect(result.score).toBeGreaterThan(40);
  });

  it('should apply volume-to-market-cap bonus when ratio >= 100%', async () => {
    // volume24h = 150000, marketCap = 100000 → ratio = 150%
    const highVolInput = createBaseInput({
      volume5m: 2000,
      volume1h: 5000,
      volume24h: 150_000,
      marketCap: 100_000,
    });
    const highVolResult = await scoreVolumeSpike(highVolInput);

    // Same spike but lower volume/MC ratio
    const lowVolInput = createBaseInput({
      volume5m: 2000,
      volume1h: 5000,
      volume24h: 50_000,
      marketCap: 100_000,
    });
    const lowVolResult = await scoreVolumeSpike(lowVolInput);

    expect(highVolResult.score).toBeGreaterThanOrEqual(lowVolResult.score);
  });

  it('should clamp score to maximum of 100', async () => {
    // Extreme values to push score above 100 before clamping
    const input = createBaseInput({
      volume5m: 50000,
      volume1h: 5000,
      volume24h: 500_000,
      marketCap: 100_000,
    });
    const result = await scoreVolumeSpike(input);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should clamp score to minimum of 0', async () => {
    const input = createBaseInput({ volume5m: 0, volume1h: 0, volume24h: 0 });
    const result = await scoreVolumeSpike(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('should handle negative volume gracefully', async () => {
    const input = createBaseInput({ volume5m: -100, volume1h: -500 });
    const result = await scoreVolumeSpike(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should handle zero marketCap without crashing', async () => {
    const input = createBaseInput({ marketCap: 0, volume5m: 1000, volume1h: 5000 });
    const result = await scoreVolumeSpike(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('should return weight of 0 (weights are applied externally)', async () => {
    const input = createBaseInput();
    const result = await scoreVolumeSpike(input);
    expect(result.weight).toBe(0);
  });

  it('should include metadata in the result', async () => {
    const input = createBaseInput({ volume5m: 2000, volume1h: 5000 });
    const result = await scoreVolumeSpike(input);
    expect(result.metadata).toBeDefined();
  });
});
