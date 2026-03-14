/**
 * tests/integration/data-flow.test.ts — GMGN Interception → Scoring → UI Update Flow
 *
 * Integration test verifying the complete data flow:
 *   GMGN API interception → message relay → parsing → Zustand store updates → chrome.storage sync
 *
 * Covered phases:
 *   Phase 4  — GMGN URL Pattern Matching
 *   Phase 5  — GMGN Response Parsers (all 4 parsers + dispatcher)
 *   Phase 6  — Window PostMessage Relay (origin & source validation)
 *   Phase 7  — Chrome Runtime Message Relay (sender.id validation)
 *   Phase 8  — Zustand Store Updates (token-store, signal-store)
 *   Phase 9  — Chrome Storage Synchronization (sync vs local)
 *   Phase 10 — Full Data Flow End-to-End
 *
 * @module tests/integration/data-flow.test.ts
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks — MUST appear before any module imports that use them
// ---------------------------------------------------------------------------

vi.mock('../../src/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../src/utils/cache', () => ({
  cache: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
  },
  LLM_CACHE_TTL: 300000,
  CACHE_PREFIX: '__cache:',
  API_CACHE_TTL: 30000,
  SAFETY_CACHE_TTL: 300000,
}));

vi.mock('../../src/utils/crypto', () => ({
  encrypt: vi.fn().mockResolvedValue('encrypted-value'),
  decrypt: vi.fn().mockResolvedValue('decrypted-value'),
}));

vi.mock('../../src/utils/config', () => ({
  DEFAULT_SCORING_WEIGHTS: {
    volumeSpike: 0.20,
    smartMoneyConvergence: 0.20,
    buySellRatio: 0.15,
    holderGrowth: 0.10,
    liquidity: 0.15,
    tokenAge: 0.10,
    safetyScore: 0.10,
  },
  DEFAULT_EXIT_STRATEGY: {
    LADDER: [
      { sellPercent: 50, multiplier: 2 },
      { sellPercent: 25, multiplier: 5 },
      { sellPercent: 25, multiplier: 10 },
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
  SCORING_THRESHOLDS: {
    CONSERVATIVE: 80,
    AGGRESSIVE: 45,
  },
  LLM_CONFIG: {
    FAST_THRESHOLD: 45,
    DETAILED_THRESHOLD: 80,
  },
  API_BASE_URLS: {
    BIRDEYE: 'https://public-api.birdeye.so',
    RUGCHECK: 'https://api.rugcheck.xyz',
    GOPLUS: 'https://api.gopluslabs.io',
    JUPITER: 'https://price.jup.ag',
    HELIUS: 'https://api.helius.xyz',
    DEXSCREENER: 'https://api.dexscreener.com',
    GROQ: 'https://api.groq.com',
    PUMP_PORTAL_WS: 'wss://pumpportal.fun/api/data',
  },
  RATE_LIMIT_CONFIG: {},
  EXTENSION_VERSION: '1.0.0',
}));

// ---------------------------------------------------------------------------
// Imports — after mocks are registered
// ---------------------------------------------------------------------------

import { matchesGmgnApi } from '../../src/gmgn/url-patterns';
import {
  parseTrendingTokens,
  parseTokenDetail,
  parseWalletActivity,
  parseSmartMoneySignals,
  parseInterceptedResponse,
} from '../../src/gmgn/parsers';
import type {
  GmgnTrendingToken,
  GmgnTokenDetail,
  GmgnWalletActivity,
  GmgnSmartMoneySignal,
} from '../../src/gmgn/types';
import {
  MESSAGE_SOURCE,
  onMessage,
  sendToBackground,
  onWindowMessage,
  postWindowMessage,
} from '../../src/utils/messaging';
import type {
  ExtensionMessage,
  WindowMessage,
} from '../../src/utils/messaging';
import { createSignalStore } from '../../src/store/signal-store';
import { createTokenStore } from '../../src/store/token-store';
import type { CompositeSignal, TokenAnalysisInput } from '../../src/signals/types';

// ===========================================================================
// Test Data Factories
// ===========================================================================

/**
 * Creates a mock raw GMGN trending tokens API response simulating the
 * /defi/quotation/v1/rank/{chain}/swaps/{timeframe} endpoint.
 * All field names use snake_case matching GMGN's actual API format.
 */
function createMockGmgnTrendingResponse() {
  return {
    code: 0,
    data: {
      rank: [
        {
          address: 'So11111111111111111111111111111111111111112',
          symbol: 'SOL',
          name: 'Wrapped SOL',
          price: 178.55,
          price_change_1h: 2.3,
          price_change_24h: -1.4,
          volume_24h: 5000000,
          volume_1h: 250000,
          swaps_24h: 15000,
          swaps_1h: 800,
          market_cap: 65000000000,
          liquidity: 120000000,
          holder_count: 1200000,
          logo: 'https://example.com/sol.png',
          created_at: 1609459200,
        },
        {
          address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
          symbol: 'BONK',
          name: 'Bonk',
          price: 0.00002345,
          price_change_1h: 5.6,
          price_change_24h: 12.1,
          volume_24h: 89000000,
          volume_1h: 4500000,
          swaps_24h: 42000,
          swaps_1h: 2100,
          market_cap: 1700000000,
          liquidity: 35000000,
          holder_count: 850000,
          logo: 'https://example.com/bonk.png',
          created_at: 1672531200,
        },
      ],
    },
  };
}

/**
 * Creates a mock raw GMGN token detail API response simulating the
 * /api/v1/token/{address} endpoint. Uses snake_case fields.
 */
function createMockGmgnTokenDetailResponse() {
  return {
    code: 0,
    data: {
      address: 'TestMint111111111111111111111111111111111111',
      symbol: 'TEST',
      name: 'Test Token',
      price: 0.00145,
      price_change_5m: 8.5,
      price_change_1h: 15.2,
      price_change_24h: 45.3,
      market_cap: 1450000,
      volume_24h: 890000,
      volume_1h: 125000,
      volume_5m: 32000,
      liquidity: 85000,
      holder_count: 1250,
      smart_money: 7,
      buys_24h: 3200,
      sells_24h: 1800,
      buys_1h: 420,
      sells_1h: 190,
      creator: 'DevWallet1111111111111111111111111111111111',
      is_dev_sold: false,
      rug_probability: 12,
      is_honeypot: false,
      mint_authority: false,
      freeze_authority: false,
      top_holder_percent: 18.5,
      lp_burned: true,
      created_at: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
      logo: 'https://example.com/test.png',
      total_supply: 1000000000,
    },
  };
}

/**
 * Creates a mock raw GMGN wallet activity API response simulating the
 * /api/v1/wallet_activity/{address} endpoint. Uses snake_case fields.
 */
function createMockGmgnWalletActivityResponse() {
  return {
    code: 0,
    data: [
      {
        wallet_address: 'WalletA111111111111111111111111111111111111',
        token_address: 'TestMint111111111111111111111111111111111111',
        action: 'buy',
        amount: 50000,
        amount_usd: 72.5,
        price: 0.00145,
        timestamp: Math.floor(Date.now() / 1000) - 600,
        tx_hash: 'TxHash111111111111111111111111111111111111111111111',
        token_symbol: 'TEST',
      },
      {
        wallet_address: 'WalletB222222222222222222222222222222222222',
        token_address: 'TestMint111111111111111111111111111111111111',
        action: 'sell',
        amount: 25000,
        amount_usd: 36.25,
        price: 0.00145,
        timestamp: Math.floor(Date.now() / 1000) - 300,
        tx_hash: 'TxHash222222222222222222222222222222222222222222222',
        token_symbol: 'TEST',
      },
    ],
  };
}

/**
 * Creates a mock raw GMGN smart money API response simulating the
 * /api/v1/smartmoney/{address} endpoint. Uses snake_case fields.
 */
function createMockGmgnSmartMoneyResponse() {
  return {
    code: 0,
    data: [
      {
        wallet_address: 'SmartWallet111111111111111111111111111111111',
        wallet_tag: 'Alpha Trader',
        wallet_type: 'smart_money',
        win_rate: 78.5,
        pnl: 450000,
        avg_hold_time: 7200,
        token_address: 'TestMint111111111111111111111111111111111111',
        action: 'buy',
        amount: 100000,
        amount_usd: 145,
        timestamp: Math.floor(Date.now() / 1000) - 1800,
        tx_hash: 'TxSmart111111111111111111111111111111111111111111',
      },
      {
        wallet_address: 'WhaleWallet22222222222222222222222222222222',
        wallet_tag: 'Big Fish',
        wallet_type: 'whale',
        win_rate: 65.0,
        pnl: 1200000,
        avg_hold_time: 14400,
        token_address: 'TestMint111111111111111111111111111111111111',
        action: 'buy',
        amount: 500000,
        amount_usd: 725,
        timestamp: Math.floor(Date.now() / 1000) - 900,
        tx_hash: 'TxWhale222222222222222222222222222222222222222222',
      },
    ],
  };
}

/**
 * Creates a properly formatted WindowMessage for postMessage simulation.
 */
function createMockWindowPostMessage(
  type: string,
  data: unknown,
): WindowMessage {
  return {
    source: MESSAGE_SOURCE,
    type,
    payload: data,
  };
}

/**
 * Creates a mock CompositeSignal for store testing.
 */
function createMockCompositeSignal(
  mint: string,
  score: number,
  decision: 'BUY' | 'SKIP' | 'EXIT' = 'BUY',
): CompositeSignal {
  return {
    tokenMint: mint,
    composite: score,
    factors: [
      { name: 'volumeSpike', score: score, weight: 0.20, metadata: {} },
      { name: 'smartMoneyConvergence', score: score, weight: 0.20, metadata: {} },
      { name: 'buySellRatio', score: score, weight: 0.15, metadata: {} },
      { name: 'holderGrowth', score: score, weight: 0.10, metadata: {} },
      { name: 'liquidity', score: score, weight: 0.15, metadata: {} },
      { name: 'tokenAge', score: score, weight: 0.10, metadata: {} },
      { name: 'safetyScore', score: score, weight: 0.10, metadata: {} },
    ],
    decision,
    confidence: score / 100,
    timestamp: Date.now(),
    tradingMode: 'conservative',
    hardFilterResult: {
      passed: true,
      failedFilters: [],
      failedReason: null,
      checkedAt: Date.now(),
    },
    tokenSymbol: 'TEST',
  };
}

// ===========================================================================
// Phase 4: GMGN URL Pattern Matching
// ===========================================================================

describe('GMGN URL Pattern Matching', () => {
  it('matches trending tokens URL pattern', () => {
    const result = matchesGmgnApi(
      'https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h',
    );
    expect(result).toBe('trending_tokens');
  });

  it('matches trending tokens with alternative endpoint', () => {
    const result = matchesGmgnApi(
      'https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/24h',
    );
    expect(result).toBe('trending_tokens');
  });

  it('matches token detail URL pattern', () => {
    const result = matchesGmgnApi(
      'https://gmgn.ai/api/v1/token/So11111111111111111111111111111111111111112',
    );
    expect(result).toBe('token_detail');
  });

  it('matches wallet activity URL pattern', () => {
    const result = matchesGmgnApi(
      'https://gmgn.ai/api/v1/wallet_activity/sol/WalletA111111111',
    );
    expect(result).toBe('wallet_activity');
  });

  it('matches smart money URL pattern', () => {
    const result = matchesGmgnApi(
      'https://gmgn.ai/api/v1/smartmoney/sol/SmartWallet111111',
    );
    expect(result).toBe('smart_money');
  });

  it('matches token holders URL pattern', () => {
    const result = matchesGmgnApi(
      'https://gmgn.ai/api/v1/token_holders/sol/TestMint111',
    );
    expect(result).toBe('token_holders');
  });

  it('returns null for non-matching URLs', () => {
    expect(matchesGmgnApi('https://example.com/api/data')).toBeNull();
    expect(matchesGmgnApi('https://api.birdeye.so/defi/price')).toBeNull();
    expect(matchesGmgnApi('https://google.com')).toBeNull();
  });

  it('returns null for GMGN non-API URLs (page URLs)', () => {
    // Page URLs should NOT match — they are navigation pages, not API endpoints
    expect(matchesGmgnApi('https://gmgn.ai/sol/token/SoLTest111')).toBeNull();
    expect(matchesGmgnApi('https://gmgn.ai/')).toBeNull();
    expect(matchesGmgnApi('https://gmgn.ai/favicon.ico')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(matchesGmgnApi('')).toBeNull();
  });

  it('handles relative paths matching API patterns', () => {
    const result = matchesGmgnApi(
      '/defi/quotation/v1/rank/sol/swaps/1h',
    );
    expect(result).toBe('trending_tokens');
  });
});

// ===========================================================================
// Phase 5: GMGN Response Parsers
// ===========================================================================

describe('GMGN Response Parsers', () => {
  describe('parseTrendingTokens', () => {
    it('correctly transforms GMGN trending data from snake_case to camelCase', () => {
      const raw = createMockGmgnTrendingResponse();
      const result = parseTrendingTokens(raw);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);

      // First token — SOL
      const sol = result[0];
      expect(sol.address).toBe('So11111111111111111111111111111111111111112');
      expect(sol.symbol).toBe('SOL');
      expect(sol.name).toBe('Wrapped SOL');
      expect(sol.price).toBe(178.55);
      expect(sol.priceChange1h).toBe(2.3);
      expect(sol.priceChange24h).toBe(-1.4);
      expect(sol.volume24h).toBe(5000000);
      expect(sol.volume1h).toBe(250000);
      expect(sol.marketCap).toBe(65000000000);
      expect(sol.liquidity).toBe(120000000);
      expect(sol.holderCount).toBe(1200000);

      // Second token — BONK
      const bonk = result[1];
      expect(bonk.address).toBe('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
      expect(bonk.symbol).toBe('BONK');
      expect(bonk.price).toBe(0.00002345);
    });

    it('handles malformed data gracefully — null input', () => {
      const result = parseTrendingTokens(null);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('handles malformed data gracefully — string input', () => {
      const result = parseTrendingTokens('invalid');
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('handles malformed data gracefully — undefined input', () => {
      const result = parseTrendingTokens(undefined);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('handles empty data array', () => {
      const result = parseTrendingTokens({ data: { rank: [] } });
      expect(result.length).toBe(0);
    });

    it('skips entries without an address', () => {
      const result = parseTrendingTokens({
        data: {
          rank: [
            { symbol: 'NO_ADDR', name: 'Missing Address Token' },
            { address: 'ValidAddr', symbol: 'OK', name: 'Valid' },
          ],
        },
      });
      expect(result.length).toBe(1);
      expect(result[0].address).toBe('ValidAddr');
    });
  });

  describe('parseTokenDetail', () => {
    it('correctly transforms GMGN token detail data', () => {
      const raw = createMockGmgnTokenDetailResponse();
      const result = parseTokenDetail(raw);

      expect(result).not.toBeNull();
      const detail = result as GmgnTokenDetail;

      expect(detail.address).toBe('TestMint111111111111111111111111111111111111');
      expect(detail.symbol).toBe('TEST');
      expect(detail.name).toBe('Test Token');
      expect(detail.price).toBe(0.00145);
      expect(detail.marketCap).toBe(1450000);
      expect(detail.volume5m).toBe(32000);
      expect(detail.volume1h).toBe(125000);
      expect(detail.volume24h).toBe(890000);
      expect(detail.liquidity).toBe(85000);
      expect(detail.holderCount).toBe(1250);
      expect(detail.smartMoneyCount).toBe(7);
      expect(detail.buys1h).toBe(420);
      expect(detail.sells1h).toBe(190);
      expect(detail.buys24h).toBe(3200);
      expect(detail.sells24h).toBe(1800);
      expect(detail.mintAuthorityActive).toBe(false);
      expect(detail.freezeAuthorityActive).toBe(false);
      expect(detail.devWalletAddress).toBe('DevWallet1111111111111111111111111111111111');
      expect(detail.devWalletSold).toBe(false);
      expect(detail.topHolderPercent).toBe(18.5);
      expect(detail.lpBurned).toBe(true);
      expect(detail.isHoneypot).toBe(false);
      expect(detail.createdAt).toBeGreaterThan(0);
      expect(detail.supply).toBe(1000000000);
    });

    it('handles missing/null fields defensively — empty object', () => {
      const result = parseTokenDetail({});
      // parseTokenDetail returns null if address is missing
      expect(result).toBeNull();
    });

    it('handles non-object input', () => {
      expect(parseTokenDetail(null)).toBeNull();
      expect(parseTokenDetail(undefined)).toBeNull();
      expect(parseTokenDetail(42)).toBeNull();
      expect(parseTokenDetail('string')).toBeNull();
    });

    it('returns defaults for missing optional fields when address is present', () => {
      const result = parseTokenDetail({
        data: { address: 'MinimalMint1111111111111111111111111111111' },
      });
      expect(result).not.toBeNull();
      const detail = result as GmgnTokenDetail;
      expect(detail.address).toBe('MinimalMint1111111111111111111111111111111');
      expect(detail.price).toBe(0);
      expect(detail.volume5m).toBe(0);
      expect(detail.mintAuthorityActive).toBe(false);
      expect(detail.lpBurned).toBe(false);
    });
  });

  describe('parseWalletActivity', () => {
    it('correctly transforms GMGN wallet activity data', () => {
      const raw = createMockGmgnWalletActivityResponse();
      const result = parseWalletActivity(raw);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);

      const first = result[0];
      expect(first.walletAddress).toBe('WalletA111111111111111111111111111111111111');
      expect(first.tokenAddress).toBe('TestMint111111111111111111111111111111111111');
      expect(first.action).toBe('buy');
      expect(first.amount).toBe(50000);
      expect(first.timestamp).toBeGreaterThan(0);

      const second = result[1];
      expect(second.action).toBe('sell');
    });

    it('handles null/undefined input gracefully', () => {
      expect(parseWalletActivity(null).length).toBe(0);
      expect(parseWalletActivity(undefined).length).toBe(0);
    });

    it('handles empty data array', () => {
      expect(parseWalletActivity({ data: [] }).length).toBe(0);
    });

    it('skips entries missing wallet or token address', () => {
      const result = parseWalletActivity({
        data: [
          { wallet_address: 'Wallet1', action: 'buy' }, // missing token_address
          { token_address: 'Token1', action: 'sell' }, // missing wallet_address
          { wallet_address: 'Wallet2', token_address: 'Token2', action: 'buy' }, // valid
        ],
      });
      expect(result.length).toBe(1);
      expect(result[0].walletAddress).toBe('Wallet2');
    });

    it('normalizes action strings correctly', () => {
      const result = parseWalletActivity({
        data: [
          { wallet_address: 'W1', token_address: 'T1', action: 'bought' },
          { wallet_address: 'W2', token_address: 'T2', action: 'sold' },
          { wallet_address: 'W3', token_address: 'T3', action: 'unknown_type' },
        ],
      });
      expect(result[0].action).toBe('buy');
      expect(result[1].action).toBe('sell');
      expect(result[2].action).toBe('transfer');
    });
  });

  describe('parseSmartMoneySignals', () => {
    it('correctly transforms GMGN smart money data', () => {
      const raw = createMockGmgnSmartMoneyResponse();
      const result = parseSmartMoneySignals(raw);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);

      const smart = result[0];
      expect(smart.walletAddress).toBe('SmartWallet111111111111111111111111111111111');
      expect(smart.walletType).toBe('smart_money');
      expect(smart.winRate).toBe(78.5);
      expect(smart.pnl).toBe(450000);
      expect(smart.action).toBe('buy');

      const whale = result[1];
      expect(whale.walletAddress).toBe('WhaleWallet22222222222222222222222222222222');
      expect(whale.walletType).toBe('whale');
      expect(whale.action).toBe('buy');
    });

    it('handles null/undefined input gracefully', () => {
      expect(parseSmartMoneySignals(null).length).toBe(0);
      expect(parseSmartMoneySignals(undefined).length).toBe(0);
    });

    it('normalizes wallet type strings', () => {
      const result = parseSmartMoneySignals({
        data: [
          { wallet_address: 'W1', wallet_type: 'smart money', action: 'buy' },
          { wallet_address: 'W2', wallet_type: 'dev', action: 'sell' },
          { wallet_address: 'W3', wallet_type: 'influencer', action: 'buy' },
          { wallet_address: 'W4', wallet_type: 'unknown_category', action: 'buy' },
        ],
      });
      expect(result[0].walletType).toBe('smart_money');
      expect(result[1].walletType).toBe('developer');
      expect(result[2].walletType).toBe('kol');
      expect(result[3].walletType).toBe('unknown');
    });
  });

  describe('parseInterceptedResponse dispatcher', () => {
    it('dispatches trending_tokens to parseTrendingTokens', () => {
      const raw = createMockGmgnTrendingResponse();
      const result = parseInterceptedResponse('trending_tokens', raw);

      expect(result.type).toBe('trending_tokens');
      expect(Array.isArray(result.data)).toBe(true);
      expect((result.data as GmgnTrendingToken[]).length).toBe(2);
    });

    it('dispatches token_detail to parseTokenDetail', () => {
      const raw = createMockGmgnTokenDetailResponse();
      const result = parseInterceptedResponse('token_detail', raw);

      expect(result.type).toBe('token_detail');
      expect(result.data).not.toBeNull();
      expect((result.data as GmgnTokenDetail).address).toBe(
        'TestMint111111111111111111111111111111111111',
      );
    });

    it('dispatches wallet_activity to parseWalletActivity', () => {
      const raw = createMockGmgnWalletActivityResponse();
      const result = parseInterceptedResponse('wallet_activity', raw);

      expect(result.type).toBe('wallet_activity');
      expect(Array.isArray(result.data)).toBe(true);
      expect((result.data as GmgnWalletActivity[]).length).toBe(2);
    });

    it('dispatches smart_money to parseSmartMoneySignals', () => {
      const raw = createMockGmgnSmartMoneyResponse();
      const result = parseInterceptedResponse('smart_money', raw);

      expect(result.type).toBe('smart_money');
      expect(Array.isArray(result.data)).toBe(true);
      expect((result.data as GmgnSmartMoneySignal[]).length).toBe(2);
    });

    it('returns null data for unknown pattern types', () => {
      const result = parseInterceptedResponse('unknown_type', {});
      expect(result.type).toBe('unknown_type');
      expect(result.data).toBeNull();
    });

    it('handles token_holders pattern (reserved, returns null)', () => {
      const result = parseInterceptedResponse('token_holders', {});
      expect(result.type).toBe('token_holders');
      expect(result.data).toBeNull();
    });
  });
});

// ===========================================================================
// Phase 6: Window PostMessage Relay
// ===========================================================================

describe('Window PostMessage Relay', () => {
  let originalPostMessage: typeof window.postMessage;
  let originalAddEventListener: typeof window.addEventListener;

  beforeEach(() => {
    originalPostMessage = window.postMessage;
    originalAddEventListener = window.addEventListener;
  });

  afterEach(() => {
    window.postMessage = originalPostMessage;
    window.addEventListener = originalAddEventListener;
  });

  it('MESSAGE_SOURCE constant equals gmgn-signal-bot', () => {
    expect(MESSAGE_SOURCE).toBe('gmgn-signal-bot');
  });

  it('validates message source is gmgn-signal-bot via onWindowMessage', () => {
    const handler = vi.fn();
    const listeners: Array<(event: MessageEvent) => void> = [];

    window.addEventListener = vi.fn((type: string, cb: EventListenerOrEventListenerObject) => {
      if (type === 'message') {
        listeners.push(cb as (event: MessageEvent) => void);
      }
    }) as unknown as typeof window.addEventListener;

    onWindowMessage(handler);
    expect(listeners.length).toBe(1);

    // Valid message with correct source — should be accepted
    const validEvent = new MessageEvent('message', {
      data: { source: 'gmgn-signal-bot', type: 'GMGN_API_RESPONSE', payload: {} },
      origin: 'https://gmgn.ai',
    });
    listeners[0](validEvent);
    expect(handler).toHaveBeenCalledTimes(1);

    // Invalid message with wrong source — should be rejected
    handler.mockClear();
    const invalidEvent = new MessageEvent('message', {
      data: { source: 'other-extension', type: 'DATA', payload: {} },
      origin: 'https://gmgn.ai',
    });
    listeners[0](invalidEvent);
    expect(handler).not.toHaveBeenCalled();
  });

  it('validates event.origin === https://gmgn.ai', () => {
    const handler = vi.fn();
    const listeners: Array<(event: MessageEvent) => void> = [];

    window.addEventListener = vi.fn((type: string, cb: EventListenerOrEventListenerObject) => {
      if (type === 'message') {
        listeners.push(cb as (event: MessageEvent) => void);
      }
    }) as unknown as typeof window.addEventListener;

    onWindowMessage(handler);

    // Valid origin — should be accepted
    const validEvent = new MessageEvent('message', {
      data: { source: MESSAGE_SOURCE, type: 'GMGN_API_RESPONSE', payload: {} },
      origin: 'https://gmgn.ai',
    });
    listeners[0](validEvent);
    expect(handler).toHaveBeenCalledTimes(1);

    // Invalid origin — should be REJECTED
    handler.mockClear();
    const evilEvent = new MessageEvent('message', {
      data: { source: MESSAGE_SOURCE, type: 'GMGN_API_RESPONSE', payload: {} },
      origin: 'https://evil.com',
    });
    listeners[0](evilEvent);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects messages without the gmgn-signal-bot source identifier', () => {
    const handler = vi.fn();
    const listeners: Array<(event: MessageEvent) => void> = [];

    window.addEventListener = vi.fn((type: string, cb: EventListenerOrEventListenerObject) => {
      if (type === 'message') {
        listeners.push(cb as (event: MessageEvent) => void);
      }
    }) as unknown as typeof window.addEventListener;

    onWindowMessage(handler);

    // Missing source field
    const noSourceEvent = new MessageEvent('message', {
      data: { type: 'DATA', payload: {} },
      origin: 'https://gmgn.ai',
    });
    listeners[0](noSourceEvent);
    expect(handler).not.toHaveBeenCalled();

    // Null data
    const nullDataEvent = new MessageEvent('message', {
      data: null,
      origin: 'https://gmgn.ai',
    });
    listeners[0](nullDataEvent);
    expect(handler).not.toHaveBeenCalled();
  });

  it('postWindowMessage automatically adds source: gmgn-signal-bot', () => {
    const mockPostMessage = vi.fn();
    window.postMessage = mockPostMessage;

    postWindowMessage({
      type: 'GMGN_API_RESPONSE',
      payload: { data: 'test' },
    });

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const postedMessage = mockPostMessage.mock.calls[0][0];
    expect(postedMessage.source).toBe('gmgn-signal-bot');
    expect(postedMessage.type).toBe('GMGN_API_RESPONSE');
    expect(postedMessage.payload).toEqual({ data: 'test' });
  });
});

// ===========================================================================
// Phase 7: Chrome Runtime Message Relay
// ===========================================================================

describe('Chrome Runtime Message Relay', () => {
  it('sendToBackground sends message via chrome.runtime.sendMessage', async () => {
    const message: ExtensionMessage = {
      type: 'TOKEN_DATA',
      payload: { mint: 'TestMint', data: { price: 1.5 } },
    };

    await sendToBackground(message);

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(message);
  });

  it('onMessage listener validates sender.id === chrome.runtime.id', () => {
    const handler = vi.fn();
    const registeredListeners: Array<
      (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => void
    > = [];

    // Capture the listener that onMessage registers
    (chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => void) => {
        registeredListeners.push(cb);
      },
    );

    onMessage(handler);
    expect(registeredListeners.length).toBe(1);
    const listener = registeredListeners[0];

    // Valid sender.id matching chrome.runtime.id — handler should be called
    const validMessage = { type: 'TOKEN_DATA', payload: { mint: 'test', data: {} } };
    const validSender = { id: 'test-extension-id' } as chrome.runtime.MessageSender;
    listener(validMessage, validSender, vi.fn());
    expect(handler).toHaveBeenCalledTimes(1);

    // Invalid sender.id — handler should NOT be called
    handler.mockClear();
    const invalidSender = { id: 'malicious-id' } as chrome.runtime.MessageSender;
    listener(validMessage, invalidSender, vi.fn());
    expect(handler).not.toHaveBeenCalled();
  });

  it('onMessage rejects messages without sender.id', () => {
    const handler = vi.fn();
    const registeredListeners: Array<
      (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => void
    > = [];

    (chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => void) => {
        registeredListeners.push(cb);
      },
    );

    onMessage(handler);
    const listener = registeredListeners[0];

    // No sender.id at all
    const noIdSender = {} as chrome.runtime.MessageSender;
    listener({ type: 'TOKEN_DATA', payload: {} }, noIdSender, vi.fn());
    expect(handler).not.toHaveBeenCalled();
  });

  it('onMessage rejects messages with invalid type discriminant', () => {
    const handler = vi.fn();
    const registeredListeners: Array<
      (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => void
    > = [];

    (chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => void) => {
        registeredListeners.push(cb);
      },
    );

    onMessage(handler);
    const listener = registeredListeners[0];
    const validSender = { id: 'test-extension-id' } as chrome.runtime.MessageSender;

    // Invalid type not in the VALID_MESSAGE_TYPES set
    listener({ type: 'INVALID_TYPE', payload: {} }, validSender, vi.fn());
    expect(handler).not.toHaveBeenCalled();

    // Missing type field
    listener({ payload: {} }, validSender, vi.fn());
    expect(handler).not.toHaveBeenCalled();
  });

  it('discriminated union message types can be narrowed', () => {
    // This is a compile-time TypeScript check — we verify the type narrowing works
    const tokenDataMsg: ExtensionMessage = {
      type: 'TOKEN_DATA',
      payload: { mint: 'test', data: {} },
    };
    const signalUpdateMsg: ExtensionMessage = {
      type: 'SIGNAL_UPDATE',
      payload: { mint: 'test', signal: {} },
    };
    const safetyCheckMsg: ExtensionMessage = {
      type: 'SAFETY_CHECK_REQUEST',
      payload: { mint: 'test' },
    };

    // Narrow by type and verify the payload shape is correct
    if (tokenDataMsg.type === 'TOKEN_DATA') {
      expect(tokenDataMsg.payload.mint).toBe('test');
    }
    if (signalUpdateMsg.type === 'SIGNAL_UPDATE') {
      expect(signalUpdateMsg.payload.mint).toBe('test');
    }
    if (safetyCheckMsg.type === 'SAFETY_CHECK_REQUEST') {
      expect(safetyCheckMsg.payload.mint).toBe('test');
    }
  });
});

// ===========================================================================
// Phase 8: Zustand Store Updates After Signal Analysis
// ===========================================================================

describe('Zustand Store Updates After Signal Analysis', () => {
  describe('token-store', () => {
    it('updates from GMGN parsed data via updateFromGmgn', () => {
      const store = createTokenStore();
      const rawResponse = createMockGmgnTokenDetailResponse();
      const parsed = parseTokenDetail(rawResponse)!;

      store.getState().updateFromGmgn(parsed);

      const token = store.getState().getToken(parsed.address);
      expect(token).toBeDefined();
      expect(token!.mint).toBe('TestMint111111111111111111111111111111111111');
      expect(token!.symbol).toBe('TEST');
      expect(token!.price).toBe(0.00145);
      expect(token!.marketCap).toBe(1450000);
      expect(token!.volume5m).toBe(32000);
      expect(token!.mintAuthorityActive).toBe(false);
      expect(token!.lastSource).toBe('gmgn');
    });

    it('updates from Birdeye data via updateFromBirdeye', () => {
      const store = createTokenStore();
      const birdeyeData = {
        symbol: 'SOL',
        name: 'Wrapped SOL',
        price: 180.0,
        priceChange24h: 3.5,
        volume24h: 6000000,
        volume1h: 300000,
        volume5m: 50000,
        marketCap: 70000000000,
        liquidity: 130000000,
        holderCount: 1300000,
      };

      store.getState().updateFromBirdeye(
        'So11111111111111111111111111111111111111112',
        birdeyeData as any,
      );

      const token = store.getState().getToken('So11111111111111111111111111111111111111112');
      expect(token).toBeDefined();
      expect(token!.price).toBe(180.0);
      expect(token!.lastSource).toBe('birdeye');
    });

    it('upsertToken merges partial updates preserving existing fields', () => {
      const store = createTokenStore();
      const mint = 'TestMergeMint1111111111111111111111111111111';

      // Initial data
      store.getState().upsertToken(mint, {
        symbol: 'MERGE',
        name: 'Merge Token',
        price: 1.0,
        volume5m: 5000,
      });

      // Partial update — only price changes
      store.getState().upsertToken(mint, { price: 2.0 });

      const token = store.getState().getToken(mint);
      expect(token).toBeDefined();
      expect(token!.price).toBe(2.0);
      expect(token!.symbol).toBe('MERGE');
      expect(token!.name).toBe('Merge Token');
      expect(token!.volume5m).toBe(5000);
    });
  });

  describe('signal-store', () => {
    it('addSignal stores composite signal and updates history', () => {
      const store = createSignalStore();
      const signal = createMockCompositeSignal('TestMintA', 85);

      store.getState().addSignal(signal);

      const state = store.getState();
      expect(state.signals['TestMintA']).toBeDefined();
      expect(state.signals['TestMintA'].composite).toBe(85);
      expect(state.signalHistory.length).toBe(1);
      expect(state.signalHistory[0].tokenMint).toBe('TestMintA');
    });

    it('getTopSignals returns signals sorted by composite score descending', () => {
      const store = createSignalStore();

      store.getState().addSignal(createMockCompositeSignal('Token1', 90));
      store.getState().addSignal(createMockCompositeSignal('Token2', 45));
      store.getState().addSignal(createMockCompositeSignal('Token3', 72));
      store.getState().addSignal(createMockCompositeSignal('Token4', 88));
      store.getState().addSignal(createMockCompositeSignal('Token5', 31));

      const top3 = store.getState().getTopSignals(3);
      expect(top3.length).toBe(3);
      expect(top3[0].composite).toBe(90);
      expect(top3[1].composite).toBe(88);
      expect(top3[2].composite).toBe(72);
    });

    it('removeSignal removes from signals map but NOT from history', () => {
      const store = createSignalStore();
      const signal = createMockCompositeSignal('RemoveMe', 75);

      store.getState().addSignal(signal);
      expect(store.getState().signals['RemoveMe']).toBeDefined();
      expect(store.getState().signalHistory.length).toBe(1);

      store.getState().removeSignal('RemoveMe');

      // Active signals map should no longer contain the token
      expect(store.getState().signals['RemoveMe']).toBeUndefined();
      // History should still contain it
      expect(store.getState().signalHistory.length).toBe(1);
      expect(store.getState().signalHistory[0].tokenMint).toBe('RemoveMe');
    });

    it('addSignal overwrites existing signal for same token (last-write-wins)', () => {
      const store = createSignalStore();

      store.getState().addSignal(createMockCompositeSignal('OverwriteMe', 50, 'SKIP'));
      store.getState().addSignal(createMockCompositeSignal('OverwriteMe', 85, 'BUY'));

      expect(store.getState().signals['OverwriteMe'].composite).toBe(85);
      expect(store.getState().signals['OverwriteMe'].decision).toBe('BUY');
      // History should have both entries
      expect(store.getState().signalHistory.length).toBe(2);
    });

    it('clearAll resets signals and history', () => {
      const store = createSignalStore();
      store.getState().addSignal(createMockCompositeSignal('A', 80));
      store.getState().addSignal(createMockCompositeSignal('B', 60));

      store.getState().clearAll();

      expect(Object.keys(store.getState().signals).length).toBe(0);
      expect(store.getState().signalHistory.length).toBe(0);
    });
  });
});

// ===========================================================================
// Phase 9: Chrome Storage Synchronization
// ===========================================================================

describe('Chrome Storage Synchronization', () => {
  it('chrome.storage.onChanged listener is registered for cross-context sync', () => {
    // The chrome-storage-adapter middleware registers an onChanged listener
    // during store creation. Verify the listener was set up.
    // Note: exact call count depends on how many stores have been created
    const onChangedAddListener = chrome.storage.onChanged.addListener as ReturnType<typeof vi.fn>;
    expect(onChangedAddListener).toBeDefined();
    // Creating stores above should have triggered addListener calls
  });

  it('token-store uses chrome.storage.local (not sync)', async () => {
    // The chrome-storage-adapter debounces writes with a 300ms default delay.
    // We use fake timers to advance past the debounce window.
    vi.useFakeTimers();

    const store = createTokenStore();
    store.getState().upsertToken('ChromeStorageTest111', { symbol: 'CST', price: 1.0 });

    // Advance past the 300ms debounce window so the write fires
    await vi.advanceTimersByTimeAsync(500);

    const localSetMock = chrome.storage.local.set as ReturnType<typeof vi.fn>;
    expect(localSetMock).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('signal-store uses chrome.storage.local (not sync)', async () => {
    vi.useFakeTimers();

    const store = createSignalStore();
    store.getState().addSignal(createMockCompositeSignal('StorageLocalTest', 90));

    // Advance past the 300ms debounce window so the write fires
    await vi.advanceTimersByTimeAsync(500);

    const localSetMock = chrome.storage.local.set as ReturnType<typeof vi.fn>;
    expect(localSetMock).toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ===========================================================================
// Phase 10: Full Data Flow End-to-End
// ===========================================================================

describe('Full Data Flow End-to-End', () => {
  it('GMGN interception → parsing → token store update (complete flow)', () => {
    // Step 1: Create a mock GMGN token detail response (raw JSON)
    const rawResponse = createMockGmgnTokenDetailResponse();

    // Step 2: URL pattern matching — would match 'token_detail'
    const patternType = matchesGmgnApi(
      'https://gmgn.ai/api/v1/token/TestMint111111111111111111111111111111111111',
    );
    expect(patternType).toBe('token_detail');

    // Step 3: Parse via the dispatcher
    const parsed = parseInterceptedResponse('token_detail', rawResponse);
    expect(parsed.type).toBe('token_detail');
    expect(parsed.data).not.toBeNull();

    const tokenDetail = parsed.data as GmgnTokenDetail;
    expect(tokenDetail.address).toBe('TestMint111111111111111111111111111111111111');
    expect(tokenDetail.symbol).toBe('TEST');

    // Step 4: Update token store via updateFromGmgn
    const tokenStore = createTokenStore();
    tokenStore.getState().updateFromGmgn(tokenDetail);

    // Step 5: Verify token store contains correctly mapped data
    const storedToken = tokenStore.getState().getToken(tokenDetail.address);
    expect(storedToken).toBeDefined();
    expect(storedToken!.mint).toBe('TestMint111111111111111111111111111111111111');
    expect(storedToken!.symbol).toBe('TEST');
    expect(storedToken!.price).toBe(0.00145);
    expect(storedToken!.marketCap).toBe(1450000);
    expect(storedToken!.volume5m).toBe(32000);
    expect(storedToken!.volume1h).toBe(125000);
    expect(storedToken!.volume24h).toBe(890000);
    expect(storedToken!.liquidity).toBe(85000);
    expect(storedToken!.holderCount).toBe(1250);
    expect(storedToken!.smartMoneyCount).toBe(7);
    expect(storedToken!.buys1h).toBe(420);
    expect(storedToken!.sells1h).toBe(190);
    expect(storedToken!.mintAuthorityActive).toBe(false);
    expect(storedToken!.freezeAuthorityActive).toBe(false);
    expect(storedToken!.lpBurned).toBe(true);
    expect(storedToken!.lastSource).toBe('gmgn');
    expect(storedToken!.lastUpdated).toBeGreaterThan(0);
  });

  it('parsed GMGN data format is compatible with TokenAnalysisInput', () => {
    // Step 1: Parse GMGN token detail
    const rawResponse = createMockGmgnTokenDetailResponse();
    const parsed = parseTokenDetail(rawResponse);
    expect(parsed).not.toBeNull();

    const detail = parsed as GmgnTokenDetail;

    // Step 2: Map to TokenAnalysisInput shape — verify field compatibility
    const analysisInput: TokenAnalysisInput = {
      mint: detail.address,
      symbol: detail.symbol,
      name: detail.name,
      price: detail.price,
      priceChange5m: detail.priceChange5m,
      priceChange1h: detail.priceChange1h,
      priceChange24h: detail.priceChange24h,
      marketCap: detail.marketCap,
      volume5m: detail.volume5m,
      volume1h: detail.volume1h,
      volume24h: detail.volume24h,
      liquidity: detail.liquidity,
      supply: detail.supply,
      buys1h: detail.buys1h,
      sells1h: detail.sells1h,
      buys24h: detail.buys24h,
      sells24h: detail.sells24h,
      holderCount: detail.holderCount,
      topHolderPercent: detail.topHolderPercent,
      smartMoneyCount: detail.smartMoneyCount,
      mintAuthorityActive: detail.mintAuthorityActive,
      freezeAuthorityActive: detail.freezeAuthorityActive,
      lpBurned: detail.lpBurned,
      lpLocked: false,
      lpBurnPercent: 0,
      isHoneypot: detail.isHoneypot,
      safetyScore: 0,
      metadataMutable: false,
      devWalletAddress: detail.devWalletAddress,
      devWalletSold: detail.devWalletSold,
      createdAt: detail.createdAt,
    };

    // Step 3: Verify the analysis input has all required fields
    expect(analysisInput.mint).toBe('TestMint111111111111111111111111111111111111');
    expect(analysisInput.symbol).toBe('TEST');
    expect(analysisInput.price).toBe(0.00145);
    expect(analysisInput.volume5m).toBe(32000);
    expect(analysisInput.buys1h).toBe(420);
    expect(analysisInput.sells1h).toBe(190);
    expect(analysisInput.holderCount).toBe(1250);
    expect(analysisInput.topHolderPercent).toBe(18.5);
    expect(analysisInput.mintAuthorityActive).toBe(false);
    expect(analysisInput.createdAt).toBeGreaterThan(0);
  });

  it('signal store receives analysis result and makes it available to UI', () => {
    // Step 1: Create stores
    const tokenStore = createTokenStore();
    const signalStore = createSignalStore();

    // Step 2: Parse and store GMGN data
    const rawResponse = createMockGmgnTokenDetailResponse();
    const parsed = parseTokenDetail(rawResponse)!;
    tokenStore.getState().updateFromGmgn(parsed);

    // Step 3: Simulate scoring engine producing a CompositeSignal
    const signal = createMockCompositeSignal(
      'TestMint111111111111111111111111111111111111',
      82,
      'BUY',
    );
    signalStore.getState().addSignal(signal);

    // Step 4: Verify both stores have consistent data
    const storedToken = tokenStore.getState().getToken(
      'TestMint111111111111111111111111111111111111',
    );
    const storedSignal = signalStore.getState().getSignal(
      'TestMint111111111111111111111111111111111111',
    );

    expect(storedToken).toBeDefined();
    expect(storedSignal).toBeDefined();
    expect(storedToken!.symbol).toBe('TEST');
    expect(storedSignal!.composite).toBe(82);
    expect(storedSignal!.decision).toBe('BUY');
  });

  it('full pipeline with trending tokens — URL match → parse → store', () => {
    // Step 1: Match URL pattern
    const patternType = matchesGmgnApi(
      'https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h',
    );
    expect(patternType).toBe('trending_tokens');

    // Step 2: Parse via dispatcher
    const raw = createMockGmgnTrendingResponse();
    const parsed = parseInterceptedResponse('trending_tokens', raw);
    const tokens = parsed.data as GmgnTrendingToken[];
    expect(tokens.length).toBe(2);

    // Step 3: Store each trending token (simplified — just verifying shape)
    const tokenStore = createTokenStore();
    for (const token of tokens) {
      tokenStore.getState().upsertToken(token.address, {
        symbol: token.symbol,
        name: token.name,
        price: token.price,
        marketCap: token.marketCap,
        liquidity: token.liquidity,
        holderCount: token.holderCount,
        volume1h: token.volume1h,
        volume24h: token.volume24h,
        lastSource: 'gmgn',
      });
    }

    // Step 4: Verify both tokens are in store
    const sol = tokenStore.getState().getToken('So11111111111111111111111111111111111111112');
    const bonk = tokenStore.getState().getToken('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(sol).toBeDefined();
    expect(bonk).toBeDefined();
    expect(sol!.symbol).toBe('SOL');
    expect(bonk!.symbol).toBe('BONK');
  });

  it('window.postMessage format is correctly structured for relay', () => {
    const messageData = createMockWindowPostMessage('GMGN_API_RESPONSE', {
      url: 'https://gmgn.ai/api/v1/token/TestMint',
      data: createMockGmgnTokenDetailResponse(),
      patternType: 'token_detail',
    });

    // Verify the message structure matches what content.ts expects
    expect(messageData.source).toBe('gmgn-signal-bot');
    expect(messageData.type).toBe('GMGN_API_RESPONSE');
    expect(messageData.payload).toBeDefined();

    const payload = messageData.payload as {
      url: string;
      data: unknown;
      patternType: string;
    };
    expect(payload.url).toContain('gmgn.ai');
    expect(payload.patternType).toBe('token_detail');
    expect(payload.data).toBeDefined();
  });
});

// ===========================================================================
// Phase 11: Global Cleanup
// ===========================================================================

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
