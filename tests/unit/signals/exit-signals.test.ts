/**
 * tests/unit/signals/exit-signals.test.ts — Exit Signal Detection Unit Tests
 *
 * Comprehensive unit tests for the exit signals module covering:
 * - Take-profit ladder (50% at 2×, 25% at 5×, 25% at 10×)
 * - Day-trade stop-loss (-12%)
 * - Swing-trade stop-loss (-18%)
 * - Dev wallet sell detection (critical)
 * - Smart money exit (40% warning, 60% critical)
 * - Volume decline (volume/MC ratio < 10%)
 * - Trailing stop (% drop from highest observed price)
 * - Batch position checking (checkAllPositions)
 * - Trailing stop activation logic (shouldActivateTrailingStop)
 * - Default TP level generation (getDefaultTpLevels: ladder, day-trade, swing-trade)
 * - Multiple simultaneous exit triggers
 *
 * Per AAP Section 0.1.1 (User Example — Exit Strategy):
 *   "The ladder strategy: Sell 50% at 2×, 25% at 5×, 25% at 10×, let remainder
 *    ride with trailing stop. Day-trade TP/SL: +15%/+30%/+60%, SL -12%.
 *    Swing trade: +40%/+100%/+200%/+500%, SL -18%."
 *
 * @module tests/unit/signals/exit-signals
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module Mocks — MUST be declared before module imports (vitest hoists them)
// ---------------------------------------------------------------------------

/**
 * Mock src/utils/logger to prevent console output during tests.
 * Returns a no-op logger factory that satisfies the module's dependency.
 */
vi.mock('../../../src/utils/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

/**
 * Mock src/utils/config to provide deterministic exit strategy configuration.
 * Values match AAP specifications exactly:
 *   - LADDER: 50% at 2×, 25% at 5×, 25% at 10×
 *   - DAY_TRADE: +15%/+30%/+60% TP, -12% SL
 *   - SWING_TRADE: +40%/+100%/+200%/+500% TP, -18% SL
 */
vi.mock('../../../src/utils/config', () => ({
  DEFAULT_EXIT_STRATEGY: {
    LADDER: [
      { multiplier: 2, sellPercent: 50 },
      { multiplier: 5, sellPercent: 25 },
      { multiplier: 10, sellPercent: 25 },
    ],
    DAY_TRADE: {
      takeProfitLevels: [15, 30, 60],
      stopLoss: -12,
    },
    SWING_TRADE: {
      takeProfitLevels: [40, 100, 200, 500],
      stopLoss: -18,
    },
  },
}));

// ---------------------------------------------------------------------------
// Module Under Test — imports resolved AFTER mocks are hoisted
// ---------------------------------------------------------------------------

import {
  checkExitSignals,
  checkAllPositions,
  shouldActivateTrailingStop,
  getDefaultTpLevels,
  type PositionData,
  type TokenContext,
  type TpLevelConfig,
} from '../../../src/signals/exit-signals';

import type {
  ExitTrigger,
  ExitCheckResult,
  ExitReason,
} from '../../../src/signals/types';

// ---------------------------------------------------------------------------
// Lifecycle Hooks
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Mock Data Factories
// ---------------------------------------------------------------------------

/**
 * Creates a default open position for testing.
 * Defaults: entry price $0.001, full position (100%), day-trade SL -12%,
 * standard 3-level ladder TP, no trailing stop.
 */
function createMockPosition(overrides: Partial<PositionData> = {}): PositionData {
  return {
    tokenMint: 'TestMint111111111111111111111111111111111111',
    tokenSymbol: 'TEST',
    entryPrice: 0.001,
    currentPrice: 0.001,
    entryTime: Date.now() - 3_600_000, // 1 hour ago
    positionSize: 100,                  // $100 USD
    remainingPercent: 100,              // Full position
    tpLevels: [
      { multiplier: 2, sellPercent: 50, triggered: false },
      { multiplier: 5, sellPercent: 25, triggered: false },
      { multiplier: 10, sellPercent: 25, triggered: false },
    ],
    stopLossPercent: -12,               // Day-trade default
    trailingStopActive: false,
    trailingStopHighPrice: 0,
    trailingStopPercent: 20,
    ...overrides,
  };
}

/**
 * Creates a default healthy market context for testing.
 * Defaults: stable price, healthy volume/MC ratio (50%), no dev sell,
 * no smart money exit, 500 holders.
 */
function createMockContext(overrides: Partial<TokenContext> = {}): TokenContext {
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

// ===========================================================================
// Phase 3: TP Ladder Tests (50% at 2×, 25% at 5×, 25% at 10×)
// ===========================================================================

describe('take-profit ladder', () => {
  it('should trigger first TP level (50% sell) when price reaches 2× entry', () => {
    const position = createMockPosition({ entryPrice: 0.001 });
    const context = createMockContext({ currentPrice: 0.002 });

    const result = checkExitSignals(position, context);

    expect(result.hasExitSignal).toBe(true);
    const tpTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'tp-ladder',
    );
    expect(tpTriggers.length).toBeGreaterThanOrEqual(1);

    const firstTp = tpTriggers.find((t: ExitTrigger) => t.multiplier === 2);
    expect(firstTp).toBeDefined();
    expect(firstTp!.sellPercent).toBe(50);
    expect(firstTp!.multiplier).toBe(2);
  });

  it('should trigger second TP level (25% sell) when price reaches 5× entry', () => {
    const position = createMockPosition({
      entryPrice: 0.001,
      tpLevels: [
        { multiplier: 2, sellPercent: 50, triggered: true },  // Already triggered
        { multiplier: 5, sellPercent: 25, triggered: false },  // Should trigger
        { multiplier: 10, sellPercent: 25, triggered: false },
      ],
    });
    const context = createMockContext({ currentPrice: 0.005 });

    const result = checkExitSignals(position, context);

    const tpTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'tp-ladder',
    );
    expect(tpTriggers.length).toBeGreaterThanOrEqual(1);

    const secondTp = tpTriggers.find((t: ExitTrigger) => t.multiplier === 5);
    expect(secondTp).toBeDefined();
    expect(secondTp!.sellPercent).toBe(25);
    expect(secondTp!.multiplier).toBe(5);
  });

  it('should trigger third TP level (25% sell) when price reaches 10× entry', () => {
    const position = createMockPosition({
      entryPrice: 0.001,
      tpLevels: [
        { multiplier: 2, sellPercent: 50, triggered: true },
        { multiplier: 5, sellPercent: 25, triggered: true },
        { multiplier: 10, sellPercent: 25, triggered: false }, // Should trigger
      ],
    });
    const context = createMockContext({ currentPrice: 0.01 });

    const result = checkExitSignals(position, context);

    const tpTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'tp-ladder',
    );
    expect(tpTriggers.length).toBeGreaterThanOrEqual(1);

    const thirdTp = tpTriggers.find((t: ExitTrigger) => t.multiplier === 10);
    expect(thirdTp).toBeDefined();
    expect(thirdTp!.sellPercent).toBe(25);
    expect(thirdTp!.multiplier).toBe(10);
  });

  it('should NOT re-trigger already triggered TP levels', () => {
    const position = createMockPosition({
      entryPrice: 0.001,
      tpLevels: [
        { multiplier: 2, sellPercent: 50, triggered: true },  // Already triggered
        { multiplier: 5, sellPercent: 25, triggered: false },
        { multiplier: 10, sellPercent: 25, triggered: false },
      ],
    });
    // Price at 3× — above the 2× level but below 5×
    const context = createMockContext({ currentPrice: 0.003 });

    const result = checkExitSignals(position, context);

    const tpTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'tp-ladder',
    );
    // The 2× level should NOT appear since it's already triggered
    const retriggered2x = tpTriggers.find(
      (t: ExitTrigger) => t.multiplier === 2,
    );
    expect(retriggered2x).toBeUndefined();
  });

  it('should trigger MULTIPLE TP levels if price jumps past several', () => {
    const position = createMockPosition({
      entryPrice: 0.001,
      tpLevels: [
        { multiplier: 2, sellPercent: 50, triggered: false },
        { multiplier: 5, sellPercent: 25, triggered: false },
        { multiplier: 10, sellPercent: 25, triggered: false },
      ],
    });
    // Price jumped to 6× — should trigger both 2× and 5× levels
    const context = createMockContext({ currentPrice: 0.006 });

    const result = checkExitSignals(position, context);

    const tpTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'tp-ladder',
    );
    expect(tpTriggers.length).toBe(2);

    const multipliers = tpTriggers.map((t: ExitTrigger) => t.multiplier);
    expect(multipliers).toContain(2);
    expect(multipliers).toContain(5);
  });

  it('should NOT trigger any TP when price is below first level', () => {
    const position = createMockPosition({ entryPrice: 0.001 });
    // Price at 1.5× — below the 2× threshold
    const context = createMockContext({ currentPrice: 0.0015 });

    const result = checkExitSignals(position, context);

    const tpTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'tp-ladder',
    );
    expect(tpTriggers.length).toBe(0);
  });

  it('TP ladder trigger severity should be warning (not critical)', () => {
    const position = createMockPosition({ entryPrice: 0.001 });
    const context = createMockContext({ currentPrice: 0.002 });

    const result = checkExitSignals(position, context);

    const tpTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'tp-ladder',
    );
    expect(tpTriggers.length).toBeGreaterThan(0);
    for (const trigger of tpTriggers) {
      expect(trigger.severity).toBe('warning');
    }
  });
});

// ===========================================================================
// Phase 4: Day-Trade Stop-Loss -12%
// ===========================================================================

describe('day-trade stop-loss -12%', () => {
  it('should trigger stop-loss when price drops -12% from entry', () => {
    const position = createMockPosition({
      entryPrice: 0.001,
      stopLossPercent: -12,
    });
    // 0.001 * 0.875 = 0.000875 → -12.5% (clearly below -12% threshold)
    const context = createMockContext({ currentPrice: 0.000875 });

    const result = checkExitSignals(position, context);

    expect(result.hasExitSignal).toBe(true);
    const slTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'stop-loss',
    );
    expect(slTriggers.length).toBe(1);
    expect(slTriggers[0].sellPercent).toBe(100);
    expect(slTriggers[0].severity).toBe('critical');
  });

  it('should NOT trigger SL when price drops -11% (above threshold)', () => {
    const position = createMockPosition({
      entryPrice: 0.001,
      stopLossPercent: -12,
    });
    // 0.001 * 0.89 = 0.00089 → -11%
    const context = createMockContext({ currentPrice: 0.00089 });

    const result = checkExitSignals(position, context);

    const slTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'stop-loss',
    );
    expect(slTriggers.length).toBe(0);
  });

  it('should trigger SL when price drops exactly -12%', () => {
    // Use integer-friendly prices to avoid IEEE 754 floating-point rounding:
    // entry=100, price=88 → PnL = ((88-100)/100)*100 = -12.0 exactly
    const position = createMockPosition({
      entryPrice: 100,
      stopLossPercent: -12,
    });
    const context = createMockContext({ currentPrice: 88 });

    const result = checkExitSignals(position, context);

    const slTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'stop-loss',
    );
    expect(slTriggers.length).toBe(1);
  });

  it('should trigger SL when price drops -20% (well below threshold)', () => {
    const position = createMockPosition({
      entryPrice: 0.001,
      stopLossPercent: -12,
    });
    // 0.001 * 0.80 = 0.0008 → -20%
    const context = createMockContext({ currentPrice: 0.0008 });

    const result = checkExitSignals(position, context);

    const slTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'stop-loss',
    );
    expect(slTriggers.length).toBe(1);
    expect(slTriggers[0].sellPercent).toBe(100);
  });

  it('stop-loss should recommend closing entire position (sellPercent: 100)', () => {
    const position = createMockPosition({
      entryPrice: 0.001,
      stopLossPercent: -12,
    });
    const context = createMockContext({ currentPrice: 0.00085 });

    const result = checkExitSignals(position, context);

    const slTrigger = result.triggers.find(
      (t: ExitTrigger) => t.type === 'stop-loss',
    );
    expect(slTrigger).toBeDefined();
    expect(slTrigger!.sellPercent).toBe(100);
  });

  it('stop-loss should have critical severity', () => {
    const position = createMockPosition({
      entryPrice: 0.001,
      stopLossPercent: -12,
    });
    const context = createMockContext({ currentPrice: 0.00085 });

    const result = checkExitSignals(position, context);

    const slTrigger = result.triggers.find(
      (t: ExitTrigger) => t.type === 'stop-loss',
    );
    expect(slTrigger).toBeDefined();
    expect(slTrigger!.severity).toBe('critical');
  });
});

// ===========================================================================
// Phase 5: Swing-Trade Stop-Loss -18%
// ===========================================================================

describe('swing-trade stop-loss -18%', () => {
  it('should trigger stop-loss at -18% for swing-trade profile', () => {
    const position = createMockPosition({
      entryPrice: 0.001,
      stopLossPercent: -18,
    });
    // 0.001 * 0.82 = 0.00082 → -18%
    const context = createMockContext({ currentPrice: 0.00082 });

    const result = checkExitSignals(position, context);

    const slTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'stop-loss',
    );
    expect(slTriggers.length).toBe(1);
    expect(slTriggers[0].severity).toBe('critical');
    expect(slTriggers[0].sellPercent).toBe(100);
  });

  it('should NOT trigger SL at -17% for swing-trade', () => {
    const position = createMockPosition({
      entryPrice: 0.001,
      stopLossPercent: -18,
    });
    // 0.001 * 0.83 = 0.00083 → -17%
    const context = createMockContext({ currentPrice: 0.00083 });

    const result = checkExitSignals(position, context);

    const slTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'stop-loss',
    );
    expect(slTriggers.length).toBe(0);
  });

  it('should trigger SL at -18% exactly', () => {
    const position = createMockPosition({
      entryPrice: 0.001,
      stopLossPercent: -18,
    });
    // Exactly -18%: 0.001 * 0.82 = 0.00082
    const context = createMockContext({ currentPrice: 0.00082 });

    const result = checkExitSignals(position, context);

    const slTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'stop-loss',
    );
    expect(slTriggers.length).toBe(1);
  });
});

// ===========================================================================
// Phase 6: Dev Wallet Sell Detection
// ===========================================================================

describe('dev wallet sell detection', () => {
  it('should trigger exit when dev wallet has sold tokens', () => {
    const position = createMockPosition();
    const context = createMockContext({
      devWalletSold: true,
      currentPrice: 0.001,
    });

    const result = checkExitSignals(position, context);

    expect(result.hasExitSignal).toBe(true);
    const devTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'dev-sell',
    );
    expect(devTriggers.length).toBe(1);
    expect(devTriggers[0].severity).toBe('critical');
    expect(devTriggers[0].sellPercent).toBe(100);
  });

  it('should NOT trigger dev-sell when devWalletSold is false', () => {
    const position = createMockPosition();
    const context = createMockContext({
      devWalletSold: false,
      currentPrice: 0.001,
    });

    const result = checkExitSignals(position, context);

    const devTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'dev-sell',
    );
    expect(devTriggers.length).toBe(0);
  });

  it('dev-sell reason should mention developer or rug pull', () => {
    const position = createMockPosition();
    const context = createMockContext({
      devWalletSold: true,
      currentPrice: 0.001,
    });

    const result = checkExitSignals(position, context);

    const devTrigger = result.triggers.find(
      (t: ExitTrigger) => t.type === 'dev-sell',
    );
    expect(devTrigger).toBeDefined();
    // The reason should reference developer selling or rug pull
    const reasonLower = devTrigger!.reason.toLowerCase();
    const mentionsDev =
      reasonLower.includes('developer') ||
      reasonLower.includes('dev') ||
      reasonLower.includes('rug');
    expect(mentionsDev).toBe(true);
  });

  it('dev-sell should be highest severity (critical)', () => {
    const position = createMockPosition();
    const context = createMockContext({
      devWalletSold: true,
      currentPrice: 0.001,
    });

    const result = checkExitSignals(position, context);

    const devTrigger = result.triggers.find(
      (t: ExitTrigger) => t.type === 'dev-sell',
    );
    expect(devTrigger).toBeDefined();
    expect(devTrigger!.severity).toBe('critical');
  });
});

// ===========================================================================
// Phase 7: Smart Money Exit Detection
// ===========================================================================

describe('smart money exit detection', () => {
  it('should trigger WARNING when 40% of smart money has exited', () => {
    const position = createMockPosition();
    const context = createMockContext({
      smartMoneyExitPercent: 40,
      currentPrice: 0.001,
    });

    const result = checkExitSignals(position, context);

    const smTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'smart-money-exit',
    );
    expect(smTriggers.length).toBe(1);
    expect(smTriggers[0].severity).toBe('warning');
    expect(smTriggers[0].sellPercent).toBe(50);
  });

  it('should trigger CRITICAL when 60%+ of smart money has exited', () => {
    const position = createMockPosition();
    const context = createMockContext({
      smartMoneyExitPercent: 60,
      currentPrice: 0.001,
    });

    const result = checkExitSignals(position, context);

    const smTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'smart-money-exit',
    );
    expect(smTriggers.length).toBe(1);
    expect(smTriggers[0].severity).toBe('critical');
    expect(smTriggers[0].sellPercent).toBe(100);
  });

  it('should trigger CRITICAL when 80% of smart money has exited', () => {
    const position = createMockPosition();
    const context = createMockContext({
      smartMoneyExitPercent: 80,
      currentPrice: 0.001,
    });

    const result = checkExitSignals(position, context);

    const smTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'smart-money-exit',
    );
    expect(smTriggers.length).toBe(1);
    expect(smTriggers[0].severity).toBe('critical');
    expect(smTriggers[0].sellPercent).toBe(100);
  });

  it('should NOT trigger when smartMoneyExitPercent is 30% (below threshold)', () => {
    const position = createMockPosition();
    const context = createMockContext({
      smartMoneyExitPercent: 30,
      currentPrice: 0.001,
    });

    const result = checkExitSignals(position, context);

    const smTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'smart-money-exit',
    );
    expect(smTriggers.length).toBe(0);
  });

  it('should NOT trigger when smartMoneyExitPercent is 0%', () => {
    const position = createMockPosition();
    const context = createMockContext({
      smartMoneyExitPercent: 0,
      currentPrice: 0.001,
    });

    const result = checkExitSignals(position, context);

    const smTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'smart-money-exit',
    );
    expect(smTriggers.length).toBe(0);
  });
});

// ===========================================================================
// Phase 8: Volume Decline Detection
// ===========================================================================

describe('volume decline detection', () => {
  it('should trigger when volume/MC ratio drops below 10%', () => {
    const position = createMockPosition();
    // volume24h/marketCap = 5000/100000 = 5% (below 10% threshold)
    const context = createMockContext({
      volume24h: 5_000,
      marketCap: 100_000,
      currentPrice: 0.001,
    });

    const result = checkExitSignals(position, context);

    const volTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'volume-decline',
    );
    expect(volTriggers.length).toBe(1);
    expect(volTriggers[0].severity).toBe('warning');
    expect(volTriggers[0].sellPercent).toBe(50);
  });

  it('should NOT trigger when volume/MC ratio is 15%', () => {
    const position = createMockPosition();
    // 15000/100000 = 15% (above 10% threshold)
    const context = createMockContext({
      volume24h: 15_000,
      marketCap: 100_000,
      currentPrice: 0.001,
    });

    const result = checkExitSignals(position, context);

    const volTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'volume-decline',
    );
    expect(volTriggers.length).toBe(0);
  });

  it('should NOT trigger when volume/MC ratio is exactly 10%', () => {
    const position = createMockPosition();
    // 10000/100000 = 10% (at threshold — condition is BELOW 10%, not at 10%)
    const context = createMockContext({
      volume24h: 10_000,
      marketCap: 100_000,
      currentPrice: 0.001,
    });

    const result = checkExitSignals(position, context);

    const volTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'volume-decline',
    );
    expect(volTriggers.length).toBe(0);
  });

  it('should handle marketCap of 0 without dividing by zero', () => {
    const position = createMockPosition();
    const context = createMockContext({
      volume24h: 5_000,
      marketCap: 0,
      currentPrice: 0.001,
    });

    // Should not crash
    const result = checkExitSignals(position, context);

    // No volume-decline trigger when marketCap is 0 (ratio cannot be computed)
    const volTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'volume-decline',
    );
    expect(volTriggers.length).toBe(0);
  });
});

// ===========================================================================
// Phase 9: Trailing Stop
// ===========================================================================

describe('trailing stop', () => {
  it('should trigger when price drops trailingStopPercent from high', () => {
    const position = createMockPosition({
      trailingStopActive: true,
      trailingStopHighPrice: 0.01,  // Highest observed price
      trailingStopPercent: 20,       // Trigger at 20% drop from high
    });
    // 30% drop from $0.01 high → $0.007 (exceeds 20% threshold)
    const context = createMockContext({ currentPrice: 0.007 });

    const result = checkExitSignals(position, context);

    const trailingTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'trailing-stop',
    );
    expect(trailingTriggers.length).toBe(1);
    expect(trailingTriggers[0].severity).toBe('critical');
    expect(trailingTriggers[0].sellPercent).toBe(100);
  });

  it('should NOT trigger when price is only 15% below high (threshold 20%)', () => {
    const position = createMockPosition({
      trailingStopActive: true,
      trailingStopHighPrice: 0.01,
      trailingStopPercent: 20,
    });
    // 15% drop from high → $0.0085 (below 20% threshold)
    const context = createMockContext({ currentPrice: 0.0085 });

    const result = checkExitSignals(position, context);

    const trailingTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'trailing-stop',
    );
    expect(trailingTriggers.length).toBe(0);
  });

  it('should NOT trigger when trailingStopActive is false', () => {
    const position = createMockPosition({
      trailingStopActive: false,
      trailingStopHighPrice: 0.01,
      trailingStopPercent: 20,
    });
    // Even with a massive price drop, inactive trailing stop shouldn't trigger
    const context = createMockContext({ currentPrice: 0.001 });

    const result = checkExitSignals(position, context);

    const trailingTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'trailing-stop',
    );
    expect(trailingTriggers.length).toBe(0);
  });

  it('should NOT trigger when trailingStopHighPrice is 0', () => {
    const position = createMockPosition({
      trailingStopActive: true,
      trailingStopHighPrice: 0,  // No reference price established
      trailingStopPercent: 20,
    });
    const context = createMockContext({ currentPrice: 0.001 });

    const result = checkExitSignals(position, context);

    const trailingTriggers = result.triggers.filter(
      (t: ExitTrigger) => t.type === 'trailing-stop',
    );
    expect(trailingTriggers.length).toBe(0);
  });

  it('trailing stop reason should mention the drop percentage and high price', () => {
    const position = createMockPosition({
      trailingStopActive: true,
      trailingStopHighPrice: 0.01,
      trailingStopPercent: 20,
    });
    const context = createMockContext({ currentPrice: 0.007 }); // 30% drop

    const result = checkExitSignals(position, context);

    const trailingTrigger = result.triggers.find(
      (t: ExitTrigger) => t.type === 'trailing-stop',
    );
    expect(trailingTrigger).toBeDefined();
    // Reason should reference the drop percentage and/or the high price
    const reason = trailingTrigger!.reason;
    expect(reason).toContain('30.0');
    expect(reason).toContain('0.01');
  });
});

// ===========================================================================
// Phase 10: ExitCheckResult Structure
// ===========================================================================

describe('ExitCheckResult structure', () => {
  it('should return correct highestSeverity when only warnings', () => {
    const position = createMockPosition();
    // Volume decline → warning severity
    const context = createMockContext({
      volume24h: 5_000,
      marketCap: 100_000,
      currentPrice: 0.001,
    });

    const result = checkExitSignals(position, context);

    expect(result.highestSeverity).toBe('warning');
  });

  it('should return correct highestSeverity when critical trigger exists', () => {
    const position = createMockPosition();
    const context = createMockContext({
      devWalletSold: true,
      currentPrice: 0.001,
    });

    const result = checkExitSignals(position, context);

    expect(result.highestSeverity).toBe('critical');
  });

  it('should return none when no triggers', () => {
    const position = createMockPosition();
    // Healthy context — no exit conditions met
    const context = createMockContext({ currentPrice: 0.001 });

    const result = checkExitSignals(position, context);

    expect(result.highestSeverity).toBe('none');
    expect(result.hasExitSignal).toBe(false);
    expect(result.triggers).toHaveLength(0);
  });

  it('should recommend CLOSE_ALL for critical triggers', () => {
    const position = createMockPosition();
    const context = createMockContext({
      devWalletSold: true,
      currentPrice: 0.001,
    });

    const result = checkExitSignals(position, context);

    expect(result.recommendedAction).toBe('CLOSE_ALL');
  });

  it('should recommend PARTIAL_EXIT for warning-only triggers', () => {
    const position = createMockPosition();
    // Only a volume decline warning (no critical triggers)
    const context = createMockContext({
      volume24h: 5_000,
      marketCap: 100_000,
      currentPrice: 0.001,
    });

    const result = checkExitSignals(position, context);

    expect(result.recommendedAction).toBe('PARTIAL_EXIT');
  });

  it('should recommend HOLD when no triggers', () => {
    const position = createMockPosition();
    const context = createMockContext({ currentPrice: 0.001 });

    const result = checkExitSignals(position, context);

    expect(result.recommendedAction).toBe('HOLD');
  });

  it('should include tokenMint in the result', () => {
    const position = createMockPosition();
    const context = createMockContext({ currentPrice: 0.001 });

    const result = checkExitSignals(position, context);

    expect(result.tokenMint).toBe(position.tokenMint);
  });

  it('should include a valid timestamp in the result', () => {
    const position = createMockPosition();
    const context = createMockContext({ currentPrice: 0.001 });

    const result = checkExitSignals(position, context);

    expect(result.timestamp).toBeTypeOf('number');
    expect(result.timestamp).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Phase 11: checkAllPositions
// ===========================================================================

describe('checkAllPositions', () => {
  it('should check all active positions', () => {
    const positions = [
      createMockPosition({ tokenMint: 'token1' }),
      createMockPosition({ tokenMint: 'token2' }),
      createMockPosition({ tokenMint: 'token3' }),
    ];
    const contexts = new Map<string, TokenContext>([
      ['token1', createMockContext({ currentPrice: 0.001 })],
      ['token2', createMockContext({ currentPrice: 0.001 })],
      ['token3', createMockContext({ currentPrice: 0.001 })],
    ]);

    const results = checkAllPositions(positions, contexts);

    expect(results).toHaveLength(3);
  });

  it('should skip positions with remainingPercent === 0 (closed)', () => {
    const positions = [
      createMockPosition({ tokenMint: 'token1', remainingPercent: 0 }),
      createMockPosition({ tokenMint: 'token2', remainingPercent: 50 }),
      createMockPosition({ tokenMint: 'token3', remainingPercent: 100 }),
    ];
    const contexts = new Map<string, TokenContext>([
      ['token1', createMockContext()],
      ['token2', createMockContext({ currentPrice: 0.001 })],
      ['token3', createMockContext({ currentPrice: 0.001 })],
    ]);

    const results = checkAllPositions(positions, contexts);

    // Only token2 and token3 should be checked (token1 has remainingPercent 0)
    expect(results).toHaveLength(2);
  });

  it('should return HOLD result for positions without matching context', () => {
    const positions = [
      createMockPosition({ tokenMint: 'token-no-context' }),
    ];
    // Empty context map — no matching context
    const contexts = new Map<string, TokenContext>();

    const results = checkAllPositions(positions, contexts);

    expect(results).toHaveLength(1);
    expect(results[0].hasExitSignal).toBe(false);
    expect(results[0].recommendedAction).toBe('HOLD');
    expect(results[0].triggers).toHaveLength(0);
  });
});

// ===========================================================================
// Phase 12: shouldActivateTrailingStop
// ===========================================================================

describe('shouldActivateTrailingStop', () => {
  it('should return true when all TP levels are triggered and position is open', () => {
    const position = createMockPosition({
      remainingPercent: 25,
      trailingStopActive: false,
      tpLevels: [
        { multiplier: 2, sellPercent: 50, triggered: true },
        { multiplier: 5, sellPercent: 25, triggered: true },
        { multiplier: 10, sellPercent: 25, triggered: true },
      ],
    });

    expect(shouldActivateTrailingStop(position)).toBe(true);
  });

  it('should return false when not all TP levels are triggered', () => {
    const position = createMockPosition({
      trailingStopActive: false,
      tpLevels: [
        { multiplier: 2, sellPercent: 50, triggered: true },
        { multiplier: 5, sellPercent: 25, triggered: true },
        { multiplier: 10, sellPercent: 25, triggered: false }, // Not yet
      ],
    });

    expect(shouldActivateTrailingStop(position)).toBe(false);
  });

  it('should return false when trailing stop is already active', () => {
    const position = createMockPosition({
      trailingStopActive: true, // Already active
      tpLevels: [
        { multiplier: 2, sellPercent: 50, triggered: true },
        { multiplier: 5, sellPercent: 25, triggered: true },
        { multiplier: 10, sellPercent: 25, triggered: true },
      ],
    });

    expect(shouldActivateTrailingStop(position)).toBe(false);
  });

  it('should return false when remainingPercent is 0', () => {
    const position = createMockPosition({
      remainingPercent: 0, // Position fully closed
      trailingStopActive: false,
      tpLevels: [
        { multiplier: 2, sellPercent: 50, triggered: true },
        { multiplier: 5, sellPercent: 25, triggered: true },
        { multiplier: 10, sellPercent: 25, triggered: true },
      ],
    });

    expect(shouldActivateTrailingStop(position)).toBe(false);
  });
});

// ===========================================================================
// Phase 13: getDefaultTpLevels
// ===========================================================================

describe('getDefaultTpLevels', () => {
  it('ladder profile should return 3 levels: 2×/50%, 5×/25%, 10×/25%', () => {
    const levels = getDefaultTpLevels(0.001, 'ladder');

    expect(levels).toHaveLength(3);
    expect(levels[0]).toMatchObject({
      multiplier: 2,
      sellPercent: 50,
      triggered: false,
    });
    expect(levels[1]).toMatchObject({
      multiplier: 5,
      sellPercent: 25,
      triggered: false,
    });
    expect(levels[2]).toMatchObject({
      multiplier: 10,
      sellPercent: 25,
      triggered: false,
    });
  });

  it('day-trade profile should return levels for +15%/+30%/+60%', () => {
    const levels = getDefaultTpLevels(0.001, 'day-trade');

    expect(levels).toHaveLength(3);
    // +15% → multiplier 1.15
    expect(levels[0].multiplier).toBeCloseTo(1.15, 2);
    // +30% → multiplier 1.30
    expect(levels[1].multiplier).toBeCloseTo(1.30, 2);
    // +60% → multiplier 1.60
    expect(levels[2].multiplier).toBeCloseTo(1.60, 2);
  });

  it('swing-trade profile should return levels for +40%/+100%/+200%/+500%', () => {
    const levels = getDefaultTpLevels(0.001, 'swing-trade');

    expect(levels).toHaveLength(4);
    // +40% → multiplier 1.40
    expect(levels[0].multiplier).toBeCloseTo(1.40, 2);
    // +100% → multiplier 2.00
    expect(levels[1].multiplier).toBeCloseTo(2.00, 2);
    // +200% → multiplier 3.00
    expect(levels[2].multiplier).toBeCloseTo(3.00, 2);
    // +500% → multiplier 6.00
    expect(levels[3].multiplier).toBeCloseTo(6.00, 2);
  });

  it('should default to ladder profile when no profile specified', () => {
    const levels = getDefaultTpLevels(0.001);

    expect(levels).toHaveLength(3);
    expect(levels[0].multiplier).toBe(2);
    expect(levels[0].sellPercent).toBe(50);
    expect(levels[1].multiplier).toBe(5);
    expect(levels[2].multiplier).toBe(10);
  });

  it('all levels should have triggered: false', () => {
    const ladderLevels = getDefaultTpLevels(0.001, 'ladder');
    const dayTradeLevels = getDefaultTpLevels(0.001, 'day-trade');
    const swingLevels = getDefaultTpLevels(0.001, 'swing-trade');

    for (const level of [...ladderLevels, ...dayTradeLevels, ...swingLevels]) {
      expect(level.triggered).toBe(false);
    }
  });
});

// ===========================================================================
// Phase 14: Multiple Simultaneous Exit Triggers
// ===========================================================================

describe('multiple simultaneous exit triggers', () => {
  it('should detect both TP and dev-sell simultaneously', () => {
    const position = createMockPosition({ entryPrice: 0.001 });
    // Price at 2× entry AND devWalletSold: true
    const context = createMockContext({
      currentPrice: 0.002,
      devWalletSold: true,
    });

    const result = checkExitSignals(position, context);

    expect(result.hasExitSignal).toBe(true);

    const triggerTypes = result.triggers.map((t: ExitTrigger) => t.type);
    expect(triggerTypes).toContain('tp-ladder');
    expect(triggerTypes).toContain('dev-sell');
    // Dev-sell is critical → highest severity should be critical
    expect(result.highestSeverity).toBe('critical');
  });

  it('should detect TP, smart-money-exit, and volume-decline simultaneously', () => {
    const position = createMockPosition({ entryPrice: 0.001 });
    // Price at 2× entry, smart money exiting at 45%, volume/MC ratio at 5%
    const context = createMockContext({
      currentPrice: 0.002,
      smartMoneyExitPercent: 45,
      volume24h: 5_000,
      marketCap: 100_000,
    });

    const result = checkExitSignals(position, context);

    expect(result.hasExitSignal).toBe(true);

    const triggerTypes = result.triggers.map((t: ExitTrigger) => t.type);
    expect(triggerTypes).toContain('tp-ladder');
    expect(triggerTypes).toContain('smart-money-exit');
    expect(triggerTypes).toContain('volume-decline');
    expect(result.triggers.length).toBeGreaterThanOrEqual(3);
  });
});
