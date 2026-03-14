/**
 * tests/unit/signals/exit-signals.test.ts
 *
 * Unit tests for the exit signals module.
 * Verifies TP ladder (50% at 2x, 25% at 5x, 25% at 10x),
 * stop-loss (-12% day-trade, -18% swing), 6 exit trigger types,
 * dev sell critical severity, smart money exit thresholds, volume decline.
 */

import { describe, it, expect } from 'vitest';
import {
  checkExitSignals,
  checkAllPositions,
  shouldActivateTrailingStop,
  getDefaultTpLevels,
  type PositionData,
  type TokenContext,
  type TpLevelConfig,
} from '../../../src/signals/exit-signals';

// ---------------------------------------------------------------------------
// Test Data Factories
// ---------------------------------------------------------------------------

function createPosition(overrides: Partial<PositionData> = {}): PositionData {
  return {
    tokenMint: 'So11111111111111111111111111111111111111112',
    tokenSymbol: 'TEST',
    entryPrice: 0.001,
    currentPrice: 0.001,
    entryTime: Date.now() - 3600_000,
    positionSize: 100,
    remainingPercent: 100,
    tpLevels: [
      { multiplier: 2, sellPercent: 50, triggered: false },
      { multiplier: 5, sellPercent: 25, triggered: false },
      { multiplier: 10, sellPercent: 25, triggered: false },
    ],
    stopLossPercent: -12,
    trailingStopActive: false,
    trailingStopHighPrice: 0,
    trailingStopPercent: 20,
    ...overrides,
  };
}

function createContext(overrides: Partial<TokenContext> = {}): TokenContext {
  return {
    currentPrice: 0.001,
    volume24h: 50_000,
    marketCap: 100_000,
    devWalletSold: false,
    smartMoneyExitPercent: 0,
    holderCount: 500,
    volume1h: 5_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: getDefaultTpLevels
// ---------------------------------------------------------------------------

describe('getDefaultTpLevels', () => {
  it('should return ladder profile with 50% at 2x, 25% at 5x, 25% at 10x', () => {
    const levels = getDefaultTpLevels(0.001, 'ladder');
    expect(levels).toHaveLength(3);
    expect(levels[0]).toMatchObject({ multiplier: 2, sellPercent: 50, triggered: false });
    expect(levels[1]).toMatchObject({ multiplier: 5, sellPercent: 25, triggered: false });
    expect(levels[2]).toMatchObject({ multiplier: 10, sellPercent: 25, triggered: false });
  });

  it('should return day-trade profile levels', () => {
    const levels = getDefaultTpLevels(0.001, 'day-trade');
    expect(levels.length).toBeGreaterThan(0);
    // Day-trade: +15%, +30%, +60% from entry
    expect(levels[0].multiplier).toBeCloseTo(1.15, 1);
  });

  it('should return swing-trade profile levels', () => {
    const levels = getDefaultTpLevels(0.001, 'swing-trade');
    expect(levels.length).toBeGreaterThan(0);
    // Swing: +40% → 1.40x
    expect(levels[0].multiplier).toBeCloseTo(1.40, 1);
  });

  it('should default to ladder profile', () => {
    const levels = getDefaultTpLevels(0.001);
    expect(levels).toHaveLength(3);
    expect(levels[0].multiplier).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: checkExitSignals
// ---------------------------------------------------------------------------

describe('checkExitSignals', () => {
  it('should return no triggers when no conditions are met', () => {
    const position = createPosition({ currentPrice: 0.001 });
    const context = createContext({ currentPrice: 0.001 });
    const result = checkExitSignals(position, context);
    expect(result.hasExitSignal).toBe(false);
    expect(result.triggers).toHaveLength(0);
    expect(result.recommendedAction).toBe('HOLD');
  });

  it('should trigger tp-ladder when price reaches 2x entry', () => {
    const position = createPosition({ entryPrice: 0.001 });
    const context = createContext({ currentPrice: 0.002 });
    const result = checkExitSignals(position, context);
    const tpTriggers = result.triggers.filter(t => t.type === 'tp-ladder');
    expect(tpTriggers.length).toBeGreaterThan(0);
    expect(result.hasExitSignal).toBe(true);
  });

  it('should trigger stop-loss when price drops below -12%', () => {
    const position = createPosition({ entryPrice: 0.001, stopLossPercent: -12 });
    // -15% drop from entry
    const context = createContext({ currentPrice: 0.00085 });
    const result = checkExitSignals(position, context);
    const slTriggers = result.triggers.filter(t => t.type === 'stop-loss');
    expect(slTriggers.length).toBeGreaterThan(0);
    expect(result.hasExitSignal).toBe(true);
    expect(result.recommendedAction).toBe('CLOSE_ALL');
  });

  it('should trigger dev-sell with critical severity', () => {
    const position = createPosition();
    const context = createContext({ devWalletSold: true, currentPrice: 0.001 });
    const result = checkExitSignals(position, context);
    const devTriggers = result.triggers.filter(t => t.type === 'dev-sell');
    expect(devTriggers.length).toBeGreaterThan(0);
    if (devTriggers.length > 0) {
      expect(devTriggers[0].severity).toBe('critical');
    }
    expect(result.recommendedAction).toBe('CLOSE_ALL');
  });

  it('should trigger smart-money-exit warning at 40-59%', () => {
    const position = createPosition();
    const context = createContext({ smartMoneyExitPercent: 50, currentPrice: 0.001 });
    const result = checkExitSignals(position, context);
    const smTriggers = result.triggers.filter(t => t.type === 'smart-money-exit');
    expect(smTriggers.length).toBeGreaterThan(0);
    if (smTriggers.length > 0) {
      expect(smTriggers[0].severity).toBe('warning');
    }
  });

  it('should trigger smart-money-exit critical at >= 60%', () => {
    const position = createPosition();
    const context = createContext({ smartMoneyExitPercent: 65, currentPrice: 0.001 });
    const result = checkExitSignals(position, context);
    const smTriggers = result.triggers.filter(t => t.type === 'smart-money-exit');
    expect(smTriggers.length).toBeGreaterThan(0);
    if (smTriggers.length > 0) {
      expect(smTriggers[0].severity).toBe('critical');
    }
  });

  it('should trigger volume-decline when vol/MC ratio < 10%', () => {
    const position = createPosition();
    const context = createContext({
      volume24h: 5_000,
      marketCap: 100_000,
      currentPrice: 0.001,
    }); // 5% ratio
    const result = checkExitSignals(position, context);
    const volTriggers = result.triggers.filter(t => t.type === 'volume-decline');
    expect(volTriggers.length).toBeGreaterThan(0);
  });

  it('should include a timestamp in the result', () => {
    const position = createPosition();
    const context = createContext({ currentPrice: 0.001 });
    const result = checkExitSignals(position, context);
    expect(result.timestamp).toBeTypeOf('number');
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('should include tokenMint in the result', () => {
    const position = createPosition();
    const context = createContext({ currentPrice: 0.001 });
    const result = checkExitSignals(position, context);
    expect(result.tokenMint).toBe(position.tokenMint);
  });

  it('should set highestSeverity correctly when multiple triggers fire', () => {
    const position = createPosition({ entryPrice: 0.001, stopLossPercent: -12 });
    const context = createContext({
      currentPrice: 0.0005, // -50% drop → stop-loss
      devWalletSold: true,  // dev sell → critical
    });
    const result = checkExitSignals(position, context);
    expect(result.highestSeverity).toBe('critical');
    expect(result.recommendedAction).toBe('CLOSE_ALL');
  });
});

// ---------------------------------------------------------------------------
// Tests: checkAllPositions
// ---------------------------------------------------------------------------

describe('checkAllPositions', () => {
  it('should check exit signals for all positions', () => {
    const positions = [
      createPosition({ tokenMint: 'token1' }),
      createPosition({ tokenMint: 'token2' }),
    ];
    const contexts = new Map<string, TokenContext>();
    contexts.set('token1', createContext({ currentPrice: 0.001 }));
    contexts.set('token2', createContext({ currentPrice: 0.001 }));

    const results = checkAllPositions(positions, contexts);
    expect(results).toHaveLength(2);
  });

  it('should return HOLD for positions with no context', () => {
    const positions = [createPosition({ tokenMint: 'token1' })];
    const contexts = new Map<string, TokenContext>();
    // No context for token1

    const results = checkAllPositions(positions, contexts);
    expect(results).toHaveLength(1);
    expect(results[0].recommendedAction).toBe('HOLD');
  });

  it('should skip closed positions (remainingPercent = 0)', () => {
    const positions = [
      createPosition({ tokenMint: 'token1', remainingPercent: 0 }),
      createPosition({ tokenMint: 'token2', remainingPercent: 50 }),
    ];
    const contexts = new Map<string, TokenContext>();
    contexts.set('token1', createContext());
    contexts.set('token2', createContext({ currentPrice: 0.001 }));

    const results = checkAllPositions(positions, contexts);
    // Only open positions should be checked
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: shouldActivateTrailingStop
// ---------------------------------------------------------------------------

describe('shouldActivateTrailingStop', () => {
  it('should return false when trailing stop is already active', () => {
    const position = createPosition({ trailingStopActive: true });
    expect(shouldActivateTrailingStop(position)).toBe(false);
  });

  it('should return false when no TP levels configured', () => {
    const position = createPosition({ tpLevels: [] });
    expect(shouldActivateTrailingStop(position)).toBe(false);
  });

  it('should return false when not all TP levels triggered', () => {
    const position = createPosition({
      tpLevels: [
        { multiplier: 2, sellPercent: 50, triggered: true },
        { multiplier: 5, sellPercent: 25, triggered: false },
        { multiplier: 10, sellPercent: 25, triggered: false },
      ],
    });
    expect(shouldActivateTrailingStop(position)).toBe(false);
  });

  it('should return true when all TP levels triggered and position still open', () => {
    const position = createPosition({
      remainingPercent: 25,
      tpLevels: [
        { multiplier: 2, sellPercent: 50, triggered: true },
        { multiplier: 5, sellPercent: 25, triggered: true },
        { multiplier: 10, sellPercent: 25, triggered: true },
      ],
    });
    expect(shouldActivateTrailingStop(position)).toBe(true);
  });

  it('should return false when all TP triggered but position is closed', () => {
    const position = createPosition({
      remainingPercent: 0,
      tpLevels: [
        { multiplier: 2, sellPercent: 50, triggered: true },
        { multiplier: 5, sellPercent: 25, triggered: true },
        { multiplier: 10, sellPercent: 25, triggered: true },
      ],
    });
    expect(shouldActivateTrailingStop(position)).toBe(false);
  });
});
