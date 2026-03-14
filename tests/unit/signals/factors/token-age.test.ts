/**
 * tests/unit/signals/factors/token-age.test.ts
 *
 * Unit tests for the token age factor module.
 * Verifies <=3h early accumulation mode, <=12h gem scanning mode,
 * >12h diminished score, >24h maximum age, and error handling.
 */

import { describe, it, expect } from 'vitest';
import { scoreTokenAge } from '../../../../src/signals/factors/token-age';
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
    createdAt: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scoreTokenAge', () => {
  it('should return a FactorResult with name "token-age"', async () => {
    const input = createBaseInput();
    const result = await scoreTokenAge(input);
    expect(result.name).toBe('tokenAge');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('weight');
    expect(result).toHaveProperty('metadata');
  });

  it('should score high for tokens <= 3 hours old (early accumulation)', async () => {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const input = createBaseInput({ createdAt: oneHourAgo });
    const result = await scoreTokenAge(input);
    expect(result.score).toBeGreaterThan(60);
  });

  it('should score very high for brand new tokens (< 30 min)', async () => {
    const thirtyMinAgo = Math.floor(Date.now() / 1000) - 1800;
    const input = createBaseInput({ createdAt: thirtyMinAgo });
    const result = await scoreTokenAge(input);
    expect(result.score).toBeGreaterThan(70);
  });

  it('should score moderate for tokens 3-12 hours old (gem scanning)', async () => {
    const sixHoursAgo = Math.floor(Date.now() / 1000) - 6 * 3600;
    const input = createBaseInput({ createdAt: sixHoursAgo });
    const result = await scoreTokenAge(input);
    expect(result.score).toBeGreaterThan(20);
    expect(result.score).toBeLessThan(80);
  });

  it('should score lower for tokens > 12 hours old', async () => {
    const eighteenHoursAgo = Math.floor(Date.now() / 1000) - 18 * 3600;
    const input = createBaseInput({ createdAt: eighteenHoursAgo });
    const result = await scoreTokenAge(input);
    expect(result.score).toBeLessThan(40);
  });

  it('should score 0 or very low for tokens > 24 hours old', async () => {
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 48 * 3600;
    const input = createBaseInput({ createdAt: twoDaysAgo });
    const result = await scoreTokenAge(input);
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it('should rank early accumulation higher than gem scanning higher than old', async () => {
    const early = createBaseInput({ createdAt: Math.floor(Date.now() / 1000) - 2 * 3600 });
    const gem = createBaseInput({ createdAt: Math.floor(Date.now() / 1000) - 8 * 3600 });
    const old = createBaseInput({ createdAt: Math.floor(Date.now() / 1000) - 20 * 3600 });

    const earlyResult = await scoreTokenAge(early);
    const gemResult = await scoreTokenAge(gem);
    const oldResult = await scoreTokenAge(old);

    expect(earlyResult.score).toBeGreaterThan(gemResult.score);
    expect(gemResult.score).toBeGreaterThan(oldResult.score);
  });

  it('should handle createdAt = 0 (epoch) gracefully', async () => {
    const input = createBaseInput({ createdAt: 0 });
    const result = await scoreTokenAge(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should handle future createdAt timestamps gracefully', async () => {
    const futureTimestamp = Math.floor(Date.now() / 1000) + 3600;
    const input = createBaseInput({ createdAt: futureTimestamp });
    const result = await scoreTokenAge(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should clamp score to [0, 100] range', async () => {
    const input = createBaseInput();
    const result = await scoreTokenAge(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should return weight of 0 (weights applied externally)', async () => {
    const input = createBaseInput();
    const result = await scoreTokenAge(input);
    expect(result.weight).toBe(0);
  });

  it('should include metadata in the result', async () => {
    const input = createBaseInput();
    const result = await scoreTokenAge(input);
    expect(result.metadata).toBeDefined();
  });
});
