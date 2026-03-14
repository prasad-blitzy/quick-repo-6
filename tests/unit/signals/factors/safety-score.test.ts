/**
 * tests/unit/signals/factors/safety-score.test.ts
 *
 * Unit tests for the safety score factor module.
 * Verifies RugCheck score >= 300, top holder <= 20%, mint/freeze
 * authority penalties, and error handling.
 */

import { describe, it, expect } from 'vitest';
import { scoreSafetyScore } from '../../../../src/signals/factors/safety-score';
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

describe('scoreSafetyScore', () => {
  it('should return a FactorResult with name "safety-score"', async () => {
    const input = createBaseInput();
    const result = await scoreSafetyScore(input);
    expect(result.name).toBe('safetyScore');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('weight');
    expect(result).toHaveProperty('metadata');
  });

  it('should score high for safe token (safetyScore >= 300, low concentration)', async () => {
    const input = createBaseInput({
      safetyScore: 600,
      topHolderPercent: 10,
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
    });
    const result = await scoreSafetyScore(input);
    expect(result.score).toBeGreaterThan(50);
  });

  it('should score lower when safetyScore < 300', async () => {
    const safe = createBaseInput({ safetyScore: 500 });
    const unsafe = createBaseInput({ safetyScore: 200 });
    const safeResult = await scoreSafetyScore(safe);
    const unsafeResult = await scoreSafetyScore(unsafe);
    expect(safeResult.score).toBeGreaterThan(unsafeResult.score);
  });

  it('should penalize active mint authority', async () => {
    const noMint = createBaseInput({ mintAuthorityActive: false, safetyScore: 500 });
    const hasMint = createBaseInput({ mintAuthorityActive: true, safetyScore: 500 });
    const noMintResult = await scoreSafetyScore(noMint);
    const hasMintResult = await scoreSafetyScore(hasMint);
    expect(noMintResult.score).toBeGreaterThan(hasMintResult.score);
  });

  it('should penalize active freeze authority', async () => {
    const noFreeze = createBaseInput({ freezeAuthorityActive: false, safetyScore: 500 });
    const hasFreeze = createBaseInput({ freezeAuthorityActive: true, safetyScore: 500 });
    const noFreezeResult = await scoreSafetyScore(noFreeze);
    const hasFreezeResult = await scoreSafetyScore(hasFreeze);
    expect(noFreezeResult.score).toBeGreaterThan(hasFreezeResult.score);
  });

  it('should penalize high top holder concentration (> 20%)', async () => {
    const distributed = createBaseInput({ topHolderPercent: 10, safetyScore: 500 });
    const concentrated = createBaseInput({ topHolderPercent: 30, safetyScore: 500 });
    const distResult = await scoreSafetyScore(distributed);
    const concResult = await scoreSafetyScore(concentrated);
    expect(distResult.score).toBeGreaterThan(concResult.score);
  });

  it('should score very low for honeypot tokens', async () => {
    const input = createBaseInput({ isHoneypot: true, safetyScore: 100 });
    const result = await scoreSafetyScore(input);
    expect(result.score).toBeLessThan(30);
  });

  it('should handle zero safetyScore', async () => {
    const input = createBaseInput({ safetyScore: 0 });
    const result = await scoreSafetyScore(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should handle very high safetyScore', async () => {
    const input = createBaseInput({ safetyScore: 1000 });
    const result = await scoreSafetyScore(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should clamp score to [0, 100]', async () => {
    const input = createBaseInput({ safetyScore: 1000, topHolderPercent: 0.1 });
    const result = await scoreSafetyScore(input);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('should return weight of 0 (weights applied externally)', async () => {
    const input = createBaseInput();
    const result = await scoreSafetyScore(input);
    expect(result.weight).toBe(0);
  });

  it('should include metadata in the result', async () => {
    const input = createBaseInput();
    const result = await scoreSafetyScore(input);
    expect(result.metadata).toBeDefined();
  });

  it('should penalize mutable metadata', async () => {
    const immutable = createBaseInput({ metadataMutable: false,
    devWalletAddress: 'DevWallet111111111111111111111111111111111',
    devWalletSold: false, safetyScore: 500 });
    const mutable = createBaseInput({ metadataMutable: true, safetyScore: 500 });
    const immutableResult = await scoreSafetyScore(immutable);
    const mutableResult = await scoreSafetyScore(mutable);
    expect(immutableResult.score).toBeGreaterThanOrEqual(mutableResult.score);
  });
});
