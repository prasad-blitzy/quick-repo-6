/**
 * tests/unit/gmgn/parsers.test.ts — Unit Tests for GMGN Response Data Extraction
 *
 * Comprehensive test coverage for all 5 parser functions exported from
 * `src/gmgn/parsers.ts`:
 *   - parseTrendingTokens()
 *   - parseTokenDetail()
 *   - parseWalletActivity()
 *   - parseSmartMoneySignals()
 *   - parseInterceptedResponse()
 *
 * Test categories:
 * 1. snake_case → camelCase field normalization
 * 2. camelCase passthrough
 * 3. Alternative / aliased field names from varied GMGN endpoint versions
 * 4. Defensive null/undefined/empty/malformed input handling
 * 5. Edge cases: very large numbers, very small memecoin prices, zero values,
 *    negative price changes, string-encoded numbers, boolean coercion
 *
 * @module tests/unit/gmgn/parsers
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  GmgnTrendingToken,
  GmgnTokenDetail,
  GmgnWalletActivity,
  GmgnSmartMoneySignal,
} from '../../../src/gmgn/types';

// ---------------------------------------------------------------------------
// Mock the logger module to suppress console output during test execution
// and allow verification that parsers call logging on defensive paths.
// ---------------------------------------------------------------------------
vi.mock('../../../src/utils/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Import the module under test AFTER the mock is set up
import {
  parseTrendingTokens,
  parseTokenDetail,
  parseWalletActivity,
  parseSmartMoneySignals,
  parseInterceptedResponse,
} from '../../../src/gmgn/parsers';

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------
afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// parseTrendingTokens
// =============================================================================
describe('parseTrendingTokens', () => {
  it('parses standard GMGN trending response with snake_case fields', () => {
    const raw = {
      data: {
        rank: [
          {
            address: 'So11111111111111111111111111111111111111112',
            symbol: 'SOL',
            name: 'Solana',
            price: 145.23,
            price_change_1h: 2.5,
            price_change_24h: -1.8,
            volume_24h: 500000,
            volume_1h: 50000,
            swaps_24h: 12000,
            swaps_1h: 1200,
            market_cap: 65000000000,
            liquidity: 25000000,
            holder_count: 1500000,
            logo: 'https://img.gmgn.ai/sol.png',
            created_at: 1609459200,
          },
        ],
      },
    };

    const result = parseTrendingTokens(raw);

    expect(result).toHaveLength(1);
    const token = result[0];
    expect(token.address).toBe('So11111111111111111111111111111111111111112');
    expect(token.symbol).toBe('SOL');
    expect(token.name).toBe('Solana');
    expect(token.price).toBe(145.23);
    expect(token.priceChange1h).toBe(2.5);
    expect(token.priceChange24h).toBe(-1.8);
    expect(token.volume24h).toBe(500000);
    expect(token.volume1h).toBe(50000);
    expect(token.swaps24h).toBe(12000);
    expect(token.swaps1h).toBe(1200);
    expect(token.marketCap).toBe(65000000000);
    expect(token.liquidity).toBe(25000000);
    expect(token.holderCount).toBe(1500000);
    expect(token.logoUrl).toBe('https://img.gmgn.ai/sol.png');
    expect(token.createdAt).toBe(1609459200);
  });

  it('parses camelCase GMGN response format', () => {
    const raw = {
      data: {
        rank: [
          {
            address: 'abc123',
            symbol: 'TEST',
            name: 'Test Token',
            price: 0.001,
            priceChange1h: 5.0,
            priceChange24h: 10.0,
            volume24h: 1000,
            volume1h: 100,
            swaps24h: 50,
            swaps1h: 5,
            marketCap: 100000,
            liquidity: 5000,
            holderCount: 200,
            logoUrl: 'https://img.test.png',
            createdAt: 1700000000,
          },
        ],
      },
    };

    const result = parseTrendingTokens(raw);

    expect(result).toHaveLength(1);
    expect(result[0].address).toBe('abc123');
    expect(result[0].symbol).toBe('TEST');
    expect(result[0].priceChange1h).toBe(5.0);
    expect(result[0].priceChange24h).toBe(10.0);
    expect(result[0].volume24h).toBe(1000);
    expect(result[0].volume1h).toBe(100);
    expect(result[0].swaps24h).toBe(50);
    expect(result[0].swaps1h).toBe(5);
    expect(result[0].marketCap).toBe(100000);
    expect(result[0].liquidity).toBe(5000);
    expect(result[0].holderCount).toBe(200);
    expect(result[0].logoUrl).toBe('https://img.test.png');
    expect(result[0].createdAt).toBe(1700000000);
  });

  it('handles multiple tokens in the rank array', () => {
    const raw = {
      data: {
        rank: [
          { address: 'token1', symbol: 'T1', name: 'Token 1', price: 1.0 },
          { address: 'token2', symbol: 'T2', name: 'Token 2', price: 2.0 },
          { address: 'token3', symbol: 'T3', name: 'Token 3', price: 3.0 },
        ],
      },
    };

    const result = parseTrendingTokens(raw);

    expect(result).toHaveLength(3);
    expect(result[0].address).toBe('token1');
    expect(result[0].symbol).toBe('T1');
    expect(result[1].address).toBe('token2');
    expect(result[1].symbol).toBe('T2');
    expect(result[2].address).toBe('token3');
    expect(result[2].price).toBe(3.0);
  });

  it('handles string-encoded numeric values', () => {
    const raw = {
      data: {
        rank: [
          {
            address: 'strnum',
            symbol: 'STR',
            price: '0.00123',
            volume_24h: '50000',
            market_cap: '1000000',
            liquidity: '30000',
            holder_count: '450',
          },
        ],
      },
    };

    const result = parseTrendingTokens(raw);

    expect(result).toHaveLength(1);
    expect(result[0].price).toBe(0.00123);
    expect(result[0].volume24h).toBe(50000);
    expect(result[0].marketCap).toBe(1000000);
    expect(result[0].liquidity).toBe(30000);
    expect(result[0].holderCount).toBe(450);
  });

  it('filters out entries with empty addresses', () => {
    const raw = {
      data: {
        rank: [
          { address: 'valid_token', symbol: 'GOOD', price: 1.0 },
          { address: '', symbol: 'BAD', price: 2.0 },
        ],
      },
    };

    const result = parseTrendingTokens(raw);

    expect(result).toHaveLength(1);
    expect(result[0].address).toBe('valid_token');
  });

  it('returns empty array for null input', () => {
    const result = parseTrendingTokens(null);
    expect(result).toEqual([]);
  });

  it('returns empty array for undefined input', () => {
    const result = parseTrendingTokens(undefined);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty object', () => {
    const result = parseTrendingTokens({});
    expect(result).toEqual([]);
  });

  it('returns empty array for malformed data structure', () => {
    const result = parseTrendingTokens({ data: 'not-an-object' });
    expect(result).toEqual([]);
  });

  it('handles missing optional fields with defaults', () => {
    const raw = {
      data: {
        rank: [
          {
            address: 'minimal_token',
            symbol: 'MIN',
            name: 'Minimal',
            price: 0.5,
          },
        ],
      },
    };

    const result = parseTrendingTokens(raw);

    expect(result).toHaveLength(1);
    expect(result[0].logoUrl).toBe('');
    expect(result[0].holderCount).toBe(0);
    expect(result[0].swaps1h).toBe(0);
    expect(result[0].swaps24h).toBe(0);
    expect(result[0].volume1h).toBe(0);
    expect(result[0].volume24h).toBe(0);
    expect(result[0].marketCap).toBe(0);
    expect(result[0].liquidity).toBe(0);
    expect(result[0].priceChange1h).toBe(0);
    expect(result[0].priceChange24h).toBe(0);
    expect(result[0].createdAt).toBe(0);
  });

  it('resolves alternative field names (mint, ticker, mc)', () => {
    const raw = {
      data: {
        rank: [
          {
            mint: 'alt_addr_1',
            ticker: 'ALT',
            token_name: 'Alternative Token',
            current_price: 99.9,
            mc: 2000000,
            liq: 50000,
            holders: 300,
            image_url: 'https://alt.png',
            open_timestamp: 1710000000,
          },
        ],
      },
    };

    const result = parseTrendingTokens(raw);

    expect(result).toHaveLength(1);
    expect(result[0].address).toBe('alt_addr_1');
    expect(result[0].symbol).toBe('ALT');
    expect(result[0].name).toBe('Alternative Token');
    expect(result[0].price).toBe(99.9);
    expect(result[0].marketCap).toBe(2000000);
    expect(result[0].liquidity).toBe(50000);
    expect(result[0].holderCount).toBe(300);
    expect(result[0].logoUrl).toBe('https://alt.png');
    expect(result[0].createdAt).toBe(1710000000);
  });
});

// =============================================================================
// parseTokenDetail
// =============================================================================
describe('parseTokenDetail', () => {
  it('parses complete token detail with all fields (snake_case)', () => {
    const raw = {
      data: {
        address: 'PumpToken111111111111111111111111111111111',
        symbol: 'PUMP',
        name: 'Pump Token',
        price: 0.0005,
        price_change_5m: 15.0,
        price_change_1h: 45.0,
        price_change_24h: 200.0,
        market_cap: 500000,
        volume_24h: 250000,
        volume_1h: 50000,
        volume_5m: 10000,
        liquidity: 30000,
        holder_count: 500,
        smart_money: 5,
        buys_24h: 1000,
        sells_24h: 300,
        buys_1h: 200,
        sells_1h: 50,
        creator: 'DevWallet111111111111111111111111111111111',
        is_dev_sold: false,
        rug_probability: 25,
        is_honeypot: false,
        mint_authority: true,
        freeze_authority: false,
        top_holder_percent: 15.5,
        lp_burned: true,
        created_at: 1709000000,
        logo: 'https://img.pump.png',
        total_supply: 1000000000,
      },
    };

    const result = parseTokenDetail(raw);

    expect(result).not.toBeNull();
    const detail = result as GmgnTokenDetail;

    // Identity
    expect(detail.address).toBe('PumpToken111111111111111111111111111111111');
    expect(detail.symbol).toBe('PUMP');
    expect(detail.name).toBe('Pump Token');

    // Price data
    expect(detail.price).toBe(0.0005);
    expect(detail.priceChange5m).toBe(15.0);
    expect(detail.priceChange1h).toBe(45.0);
    expect(detail.priceChange24h).toBe(200.0);

    // Market data
    expect(detail.marketCap).toBe(500000);
    expect(detail.volume24h).toBe(250000);
    expect(detail.volume1h).toBe(50000);
    expect(detail.volume5m).toBe(10000);
    expect(detail.liquidity).toBe(30000);

    // Holder data
    expect(detail.holderCount).toBe(500);
    expect(detail.smartMoneyCount).toBe(5);

    // Trading activity
    expect(detail.buys24h).toBe(1000);
    expect(detail.sells24h).toBe(300);
    expect(detail.buys1h).toBe(200);
    expect(detail.sells1h).toBe(50);

    // Dev/creator wallet
    expect(detail.devWalletAddress).toBe('DevWallet111111111111111111111111111111111');
    expect(detail.devWalletSold).toBe(false);

    // Safety indicators
    expect(detail.rugProbability).toBe(25);
    expect(detail.isHoneypot).toBe(false);
    expect(detail.mintAuthorityActive).toBe(true);
    expect(detail.freezeAuthorityActive).toBe(false);
    expect(detail.topHolderPercent).toBe(15.5);
    expect(detail.lpBurned).toBe(true);

    // Metadata
    expect(detail.createdAt).toBe(1709000000);
    expect(detail.logoUrl).toBe('https://img.pump.png');
    expect(detail.supply).toBe(1000000000);
  });

  it('parses token detail with alternative field names', () => {
    const raw = {
      data: {
        address: 'abc',
        symbol: 'ALT',
        name: 'Alt Token',
        price: 1.0,
        priceChange5m: 5.0,
        buy_24h: 100,
        sell_24h: 50,
        dev_wallet: 'devAddr',
        dev_sold: true,
        mintAuthority: true,
        freezeAuthority: false,
        top10_holder_rate: 22,
        is_lp_burned: true,
        creation_timestamp: 1700000000,
        logo_url: 'http://alt.png',
        supply: 999999,
      },
    };

    const result = parseTokenDetail(raw);
    expect(result).not.toBeNull();
    const detail = result as GmgnTokenDetail;

    expect(detail.address).toBe('abc');
    expect(detail.priceChange5m).toBe(5.0);
    expect(detail.buys24h).toBe(100);
    expect(detail.sells24h).toBe(50);
    expect(detail.devWalletAddress).toBe('devAddr');
    expect(detail.devWalletSold).toBe(true);
    expect(detail.mintAuthorityActive).toBe(true);
    expect(detail.freezeAuthorityActive).toBe(false);
    expect(detail.topHolderPercent).toBe(22);
    expect(detail.lpBurned).toBe(true);
    expect(detail.createdAt).toBe(1700000000);
    expect(detail.logoUrl).toBe('http://alt.png');
    expect(detail.supply).toBe(999999);
  });

  it('parses token detail with data nested under response.token', () => {
    const raw = {
      token: {
        address: 'nested-token',
        symbol: 'NEST',
        name: 'Nested',
        price: 0.01,
      },
    };

    const result = parseTokenDetail(raw);
    expect(result).not.toBeNull();
    const detail = result as GmgnTokenDetail;
    expect(detail.address).toBe('nested-token');
    expect(detail.symbol).toBe('NEST');
    expect(detail.name).toBe('Nested');
    expect(detail.price).toBe(0.01);
  });

  it('returns null when address field is missing', () => {
    const raw = { data: { symbol: 'NO_ADDR', price: 1.0 } };
    const result = parseTokenDetail(raw);
    expect(result).toBeNull();
  });

  it('returns null for null input', () => {
    const result = parseTokenDetail(null);
    expect(result).toBeNull();
  });

  it('returns null for undefined input', () => {
    const result = parseTokenDetail(undefined);
    expect(result).toBeNull();
  });

  it('returns null for empty object', () => {
    // An empty object {} will be treated as the data container itself.
    // Since it has no address, it returns null.
    const result = parseTokenDetail({});
    expect(result).toBeNull();
  });

  it('handles boolean fields that come as strings ("true"/"false")', () => {
    const raw = {
      data: {
        address: 'x',
        is_dev_sold: 'true',
        is_honeypot: 'false',
        mint_authority: '1',
      },
    };

    const result = parseTokenDetail(raw);
    expect(result).not.toBeNull();
    const detail = result as GmgnTokenDetail;
    expect(detail.devWalletSold).toBe(true);
    expect(detail.isHoneypot).toBe(false);
    expect(detail.mintAuthorityActive).toBe(true);
  });

  it('handles boolean fields that come as numbers (0/1)', () => {
    const raw = {
      data: {
        address: 'x',
        is_honeypot: 0,
        lp_burned: 1,
      },
    };

    const result = parseTokenDetail(raw);
    expect(result).not.toBeNull();
    const detail = result as GmgnTokenDetail;
    expect(detail.isHoneypot).toBe(false);
    expect(detail.lpBurned).toBe(true);
  });

  it('missing numeric fields default to 0', () => {
    const raw = { data: { address: 'minimal', symbol: 'MIN' } };

    const result = parseTokenDetail(raw);
    expect(result).not.toBeNull();
    const detail = result as GmgnTokenDetail;

    expect(detail.price).toBe(0);
    expect(detail.priceChange5m).toBe(0);
    expect(detail.priceChange1h).toBe(0);
    expect(detail.priceChange24h).toBe(0);
    expect(detail.marketCap).toBe(0);
    expect(detail.volume24h).toBe(0);
    expect(detail.volume1h).toBe(0);
    expect(detail.volume5m).toBe(0);
    expect(detail.liquidity).toBe(0);
    expect(detail.holderCount).toBe(0);
    expect(detail.smartMoneyCount).toBe(0);
    expect(detail.buys24h).toBe(0);
    expect(detail.sells24h).toBe(0);
    expect(detail.buys1h).toBe(0);
    expect(detail.sells1h).toBe(0);
    expect(detail.rugProbability).toBe(0);
    expect(detail.topHolderPercent).toBe(0);
    expect(detail.createdAt).toBe(0);
    expect(detail.supply).toBe(0);
  });

  it('missing string fields default to empty string', () => {
    const raw = { data: { address: 'minimal' } };

    const result = parseTokenDetail(raw);
    expect(result).not.toBeNull();
    const detail = result as GmgnTokenDetail;

    expect(detail.symbol).toBe('');
    expect(detail.name).toBe('');
    expect(detail.devWalletAddress).toBe('');
    expect(detail.logoUrl).toBe('');
  });

  it('missing boolean fields default to false', () => {
    const raw = { data: { address: 'booltest' } };

    const result = parseTokenDetail(raw);
    expect(result).not.toBeNull();
    const detail = result as GmgnTokenDetail;

    expect(detail.devWalletSold).toBe(false);
    expect(detail.isHoneypot).toBe(false);
    expect(detail.mintAuthorityActive).toBe(false);
    expect(detail.freezeAuthorityActive).toBe(false);
    expect(detail.lpBurned).toBe(false);
  });
});

// =============================================================================
// parseWalletActivity
// =============================================================================
describe('parseWalletActivity', () => {
  it('parses standard wallet activity array with snake_case fields', () => {
    const raw = {
      data: [
        {
          wallet_address: 'WalletAddr111111111111111111111111111111111',
          token_address: 'TokenAddr111111111111111111111111111111111',
          action: 'buy',
          amount: 1000000,
          amount_usd: 500,
          price: 0.0005,
          timestamp: 1709000000,
          tx_hash: '5nT8GnFe_signature',
          token_symbol: 'PUMP',
        },
      ],
    };

    const result = parseWalletActivity(raw);

    expect(result).toHaveLength(1);
    expect(result[0].walletAddress).toBe('WalletAddr111111111111111111111111111111111');
    expect(result[0].tokenAddress).toBe('TokenAddr111111111111111111111111111111111');
    expect(result[0].action).toBe('buy');
    expect(result[0].amount).toBe(1000000);
    expect(result[0].amountUsd).toBe(500);
    expect(result[0].price).toBe(0.0005);
    expect(result[0].timestamp).toBe(1709000000);
    expect(result[0].txHash).toBe('5nT8GnFe_signature');
    expect(result[0].tokenSymbol).toBe('PUMP');
  });

  it('parses wallet activity with camelCase field names', () => {
    // The parser's fallback chain for USD amount uses `usdAmount` (not `amountUsd`)
    // because GMGN's camelCase variant is `usdAmount`.
    const raw = {
      data: [
        {
          walletAddress: 'wallet_camel',
          tokenAddress: 'token_camel',
          action: 'sell',
          amount: 2000,
          usdAmount: 1000,
          price: 0.5,
          timestamp: 1709100000,
          txHash: 'camelHash123',
          tokenSymbol: 'CAML',
        },
      ],
    };

    const result = parseWalletActivity(raw);

    expect(result).toHaveLength(1);
    expect(result[0].walletAddress).toBe('wallet_camel');
    expect(result[0].tokenAddress).toBe('token_camel');
    expect(result[0].action).toBe('sell');
    expect(result[0].amountUsd).toBe(1000);
    expect(result[0].txHash).toBe('camelHash123');
    expect(result[0].tokenSymbol).toBe('CAML');
  });

  it('parses alternative field names (signature, token, event_type, etc.)', () => {
    const raw = {
      activities: [
        {
          address: 'wallet1',
          token: 'token1',
          event_type: 'sell',
          token_amount: 500,
          usd_amount: 250,
          token_price: 0.5,
          block_time: 1709000000,
          signature: 'sigHash123',
          symbol: 'TEST',
        },
      ],
    };

    const result = parseWalletActivity(raw);

    expect(result).toHaveLength(1);
    expect(result[0].walletAddress).toBe('wallet1');
    expect(result[0].tokenAddress).toBe('token1');
    expect(result[0].action).toBe('sell');
    expect(result[0].amount).toBe(500);
    expect(result[0].amountUsd).toBe(250);
    expect(result[0].price).toBe(0.5);
    expect(result[0].timestamp).toBe(1709000000);
    expect(result[0].txHash).toBe('sigHash123');
    expect(result[0].tokenSymbol).toBe('TEST');
  });

  it('handles data nested under response.items', () => {
    const raw = {
      items: [
        {
          wallet_address: 'w1',
          token_address: 't1',
          action: 'buy',
          amount: 100,
          amount_usd: 50,
          price: 0.5,
          timestamp: 1700000000,
          tx_hash: 'hash1',
          token_symbol: 'ITEM',
        },
      ],
    };

    const result = parseWalletActivity(raw);

    expect(result).toHaveLength(1);
    expect(result[0].walletAddress).toBe('w1');
    expect(result[0].tokenAddress).toBe('t1');
  });

  it('filters out entries with empty wallet_address', () => {
    const raw = {
      data: [
        { wallet_address: 'valid_wallet', token_address: 'token1', action: 'buy' },
        { wallet_address: '', token_address: 'token2', action: 'sell' },
        { token_address: 'token3', action: 'buy' }, // missing wallet_address entirely
      ],
    };

    const result = parseWalletActivity(raw);
    expect(result).toHaveLength(1);
    expect(result[0].walletAddress).toBe('valid_wallet');
  });

  it('filters out entries with empty token_address', () => {
    const raw = {
      data: [
        { wallet_address: 'w1', token_address: 't1', action: 'buy' },
        { wallet_address: 'w2', token_address: '', action: 'sell' },
      ],
    };

    const result = parseWalletActivity(raw);
    expect(result).toHaveLength(1);
    expect(result[0].tokenAddress).toBe('t1');
  });

  it('handles multiple wallet activity entries', () => {
    const raw = {
      data: [
        { wallet_address: 'w1', token_address: 't1', action: 'buy' },
        { wallet_address: 'w2', token_address: 't2', action: 'sell' },
        { wallet_address: 'w3', token_address: 't3', action: 'buy' },
        { wallet_address: 'w4', token_address: 't4', action: 'sell' },
        { wallet_address: 'w5', token_address: 't5', action: 'buy' },
      ],
    };

    const result = parseWalletActivity(raw);
    expect(result).toHaveLength(5);
    expect(result[4].walletAddress).toBe('w5');
  });

  it('returns empty array for null input', () => {
    const result = parseWalletActivity(null);
    expect(result).toEqual([]);
  });

  it('returns empty array for undefined input', () => {
    const result = parseWalletActivity(undefined);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty object', () => {
    const result = parseWalletActivity({});
    expect(result).toEqual([]);
  });

  it('returns empty array for malformed data', () => {
    const result = parseWalletActivity({ data: 'not-an-array' });
    expect(result).toEqual([]);
  });

  it('normalizes action types (bought → buy, sold → sell)', () => {
    const raw = {
      data: [
        { wallet_address: 'w1', token_address: 't1', action: 'bought' },
        { wallet_address: 'w2', token_address: 't2', action: 'sold' },
        { wallet_address: 'w3', token_address: 't3', action: 'swap_buy' },
        { wallet_address: 'w4', token_address: 't4', action: 'swap_sell' },
        { wallet_address: 'w5', token_address: 't5', action: 'unknown_action' },
      ],
    };

    const result = parseWalletActivity(raw);
    expect(result[0].action).toBe('buy');
    expect(result[1].action).toBe('sell');
    expect(result[2].action).toBe('buy');
    expect(result[3].action).toBe('sell');
    expect(result[4].action).toBe('transfer');
  });
});

// =============================================================================
// parseSmartMoneySignals
// =============================================================================
describe('parseSmartMoneySignals', () => {
  it('parses standard smart money signal array with snake_case fields', () => {
    const raw = {
      data: [
        {
          wallet_address: 'SmartAddr111111111111111111111111111111111',
          wallet_tag: 'Degen Trader #42',
          wallet_type: 'smart_money',
          win_rate: 72.5,
          pnl: 150000,
          avg_hold_time: 3600,
          token_address: 'TokenAddr111111111111111111111111111111111',
          action: 'buy',
          amount: 5000000,
          amount_usd: 2500,
          timestamp: 1709000000,
          tx_hash: 'txSignature123',
        },
      ],
    };

    const result = parseSmartMoneySignals(raw);

    expect(result).toHaveLength(1);
    expect(result[0].walletAddress).toBe('SmartAddr111111111111111111111111111111111');
    expect(result[0].walletTag).toBe('Degen Trader #42');
    expect(result[0].walletType).toBe('smart_money');
    expect(result[0].winRate).toBe(72.5);
    expect(result[0].pnl).toBe(150000);
    expect(result[0].avgHoldTime).toBe(3600);
    expect(result[0].tokenAddress).toBe('TokenAddr111111111111111111111111111111111');
    expect(result[0].action).toBe('buy');
    expect(result[0].amount).toBe(5000000);
    expect(result[0].amountUsd).toBe(2500);
    expect(result[0].timestamp).toBe(1709000000);
    expect(result[0].txHash).toBe('txSignature123');
  });

  it('parses signals with camelCase field names', () => {
    const raw = {
      data: [
        {
          walletAddress: 'camelWallet',
          walletTag: 'Camel Whale',
          walletType: 'whale',
          winRate: 68.0,
          pnl: 80000,
          avgHoldTime: 7200,
          tokenAddress: 'camelToken',
          action: 'sell',
          amount: 1000,
          amountUsd: 500,
          timestamp: 1709100000,
          txHash: 'camelTxHash',
        },
      ],
    };

    const result = parseSmartMoneySignals(raw);

    expect(result).toHaveLength(1);
    expect(result[0].walletAddress).toBe('camelWallet');
    expect(result[0].walletTag).toBe('Camel Whale');
    // walletType is resolved through normalizeWalletType; 'whale' matches 'whale'
    expect(result[0].walletType).toBe('whale');
    expect(result[0].winRate).toBe(68.0);
    expect(result[0].avgHoldTime).toBe(7200);
    expect(result[0].action).toBe('sell');
    expect(result[0].txHash).toBe('camelTxHash');
  });

  it('parses alternative field names (classification, label, total_pnl, event, etc.)', () => {
    const raw = {
      smart_money: [
        {
          address: 'whale1',
          label: 'Whale Wallet',
          classification: 'whale',
          winRate: 65.0,
          total_pnl: 50000,
          avgHoldTime: 7200,
          token: 'token1',
          event: 'sell',
          token_amount: 1000,
          usdAmount: 500,
          blockTime: 1709000000,
          signature: 'sig123',
        },
      ],
    };

    const result = parseSmartMoneySignals(raw);

    expect(result).toHaveLength(1);
    expect(result[0].walletAddress).toBe('whale1');
    expect(result[0].walletTag).toBe('Whale Wallet');
    expect(result[0].walletType).toBe('whale');
    expect(result[0].pnl).toBe(50000);
    expect(result[0].action).toBe('sell');
    expect(result[0].tokenAddress).toBe('token1');
    expect(result[0].timestamp).toBe(1709000000);
    expect(result[0].txHash).toBe('sig123');
    expect(result[0].amount).toBe(1000);
    expect(result[0].amountUsd).toBe(500);
  });

  it('handles different wallet type classifications', () => {
    const types = ['smart_money', 'kol', 'whale', 'sniper', 'insider', 'developer'];
    const raw = {
      data: types.map((t, i) => ({
        wallet_address: `wallet_${i}`,
        wallet_type: t,
        token_address: `token_${i}`,
        action: 'buy',
      })),
    };

    const result = parseSmartMoneySignals(raw);

    expect(result).toHaveLength(6);
    types.forEach((expectedType, idx) => {
      expect(result[idx].walletType).toBe(expectedType);
    });
  });

  it('normalizes wallet type aliases', () => {
    const aliases: Array<[string, string]> = [
      ['smart', 'smart_money'],
      ['smartmoney', 'smart_money'],
      ['dev', 'developer'],
      ['deployer', 'developer'],
      ['influencer', 'kol'],
      ['large_holder', 'whale'],
      ['first_buyer', 'sniper'],
      ['team', 'insider'],
      ['unknown_label', 'unknown'],
    ];

    const raw = {
      data: aliases.map(([alias], i) => ({
        wallet_address: `wallet_${i}`,
        wallet_type: alias,
        token_address: `token_${i}`,
        action: 'buy',
      })),
    };

    const result = parseSmartMoneySignals(raw);

    expect(result).toHaveLength(aliases.length);
    aliases.forEach(([, expectedType], idx) => {
      expect(result[idx].walletType).toBe(expectedType);
    });
  });

  it('handles data nested under response.items', () => {
    const raw = {
      items: [
        {
          wallet_address: 'w1',
          wallet_type: 'kol',
          token_address: 't1',
          action: 'buy',
        },
      ],
    };

    const result = parseSmartMoneySignals(raw);

    expect(result).toHaveLength(1);
    expect(result[0].walletAddress).toBe('w1');
    expect(result[0].walletType).toBe('kol');
  });

  it('filters out entries with empty wallet_address', () => {
    const raw = {
      data: [
        { wallet_address: 'valid', wallet_type: 'whale', token_address: 't1', action: 'buy' },
        { wallet_address: '', wallet_type: 'kol', token_address: 't2', action: 'sell' },
      ],
    };

    const result = parseSmartMoneySignals(raw);
    expect(result).toHaveLength(1);
    expect(result[0].walletAddress).toBe('valid');
  });

  it('returns empty array for null input', () => {
    const result = parseSmartMoneySignals(null);
    expect(result).toEqual([]);
  });

  it('returns empty array for undefined input', () => {
    const result = parseSmartMoneySignals(undefined);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty object', () => {
    const result = parseSmartMoneySignals({});
    expect(result).toEqual([]);
  });

  it('normalizes smart money actions (sold → sell, default → buy)', () => {
    const raw = {
      data: [
        { wallet_address: 'w1', wallet_type: 'whale', token_address: 't1', action: 'sold' },
        { wallet_address: 'w2', wallet_type: 'kol', token_address: 't2', action: 'swap_sell' },
        { wallet_address: 'w3', wallet_type: 'sniper', token_address: 't3', action: 'anything_else' },
      ],
    };

    const result = parseSmartMoneySignals(raw);
    expect(result[0].action).toBe('sell');
    expect(result[1].action).toBe('sell');
    expect(result[2].action).toBe('buy'); // normalizeSmartMoneyAction defaults to 'buy'
  });
});

// =============================================================================
// Defensive parsing — null and missing fields
// =============================================================================
describe('defensive parsing - null and missing fields', () => {
  it('parseTrendingTokens handles null values in token fields', () => {
    const raw = {
      data: {
        rank: [
          { address: 'abc', symbol: null, price: null, volume_24h: null },
        ],
      },
    };

    const result = parseTrendingTokens(raw);

    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('');
    expect(result[0].price).toBe(0);
    expect(result[0].volume24h).toBe(0);
  });

  it('parseTokenDetail handles undefined values gracefully', () => {
    const raw = { data: { address: 'abc' } };

    const result = parseTokenDetail(raw);
    expect(result).not.toBeNull();
    const detail = result as GmgnTokenDetail;

    // All numeric fields should be 0
    expect(detail.price).toBe(0);
    expect(detail.volume24h).toBe(0);
    expect(detail.marketCap).toBe(0);
    expect(detail.liquidity).toBe(0);
    expect(detail.holderCount).toBe(0);
    expect(detail.smartMoneyCount).toBe(0);
    expect(detail.buys24h).toBe(0);
    expect(detail.sells24h).toBe(0);
    expect(detail.rugProbability).toBe(0);
    expect(detail.topHolderPercent).toBe(0);
    expect(detail.supply).toBe(0);
    expect(detail.createdAt).toBe(0);

    // All string fields should be ''
    expect(detail.symbol).toBe('');
    expect(detail.name).toBe('');
    expect(detail.devWalletAddress).toBe('');
    expect(detail.logoUrl).toBe('');

    // All boolean fields should be false
    expect(detail.devWalletSold).toBe(false);
    expect(detail.isHoneypot).toBe(false);
    expect(detail.mintAuthorityActive).toBe(false);
    expect(detail.freezeAuthorityActive).toBe(false);
    expect(detail.lpBurned).toBe(false);
  });

  it('parsers handle numeric fields passed as NaN', () => {
    const raw = {
      data: {
        rank: [{ address: 'nan_test', price: NaN, volume_24h: NaN }],
      },
    };

    const result = parseTrendingTokens(raw);
    expect(result).toHaveLength(1);
    expect(result[0].price).toBe(0);
    expect(result[0].volume24h).toBe(0);
  });

  it('parsers handle numeric fields passed as non-numeric strings', () => {
    const raw = {
      data: {
        rank: [{ address: 'str_test', price: 'not-a-number', volume_24h: 'abc' }],
      },
    };

    const result = parseTrendingTokens(raw);
    expect(result).toHaveLength(1);
    expect(result[0].price).toBe(0);
    expect(result[0].volume24h).toBe(0);
  });

  it('parsers handle deeply nested null structures', () => {
    expect(parseTrendingTokens({ data: null })).toEqual([]);
    expect(parseTokenDetail({ data: null })).toBeNull();
    expect(parseWalletActivity({ data: null })).toEqual([]);
    expect(parseSmartMoneySignals({ data: null })).toEqual([]);
  });

  it('parsers handle completely wrong data types', () => {
    // Number instead of object
    expect(parseTrendingTokens(42)).toEqual([]);
    // Array instead of object
    expect(parseTokenDetail([1, 2, 3])).toBeNull();
    // String instead of object
    expect(parseWalletActivity('string')).toEqual([]);
    // Boolean instead of object
    expect(parseSmartMoneySignals(true)).toEqual([]);
  });

  it('parseTrendingTokens skips non-object items in rank array', () => {
    const raw = {
      data: {
        rank: [
          'not-an-object',
          null,
          42,
          { address: 'valid', symbol: 'OK' },
        ],
      },
    };

    const result = parseTrendingTokens(raw);
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe('valid');
  });
});

// =============================================================================
// parseInterceptedResponse dispatcher
// =============================================================================
describe('parseInterceptedResponse', () => {
  it("routes 'trending_tokens' to parseTrendingTokens", () => {
    const raw = { data: { rank: [{ address: 'abc', symbol: 'ABC' }] } };
    const result = parseInterceptedResponse('trending_tokens', raw);

    expect(result.type).toBe('trending_tokens');
    expect(Array.isArray(result.data)).toBe(true);
    const data = result.data as GmgnTrendingToken[];
    expect(data).toHaveLength(1);
    expect(data[0].address).toBe('abc');
  });

  it("routes 'token_detail' to parseTokenDetail", () => {
    const raw = { data: { address: 'xyz', symbol: 'XYZ' } };
    const result = parseInterceptedResponse('token_detail', raw);

    expect(result.type).toBe('token_detail');
    expect(result.data).not.toBeNull();
    const data = result.data as GmgnTokenDetail;
    expect(data.address).toBe('xyz');
  });

  it("routes 'wallet_activity' to parseWalletActivity", () => {
    const raw = { data: [{ wallet_address: 'w1', token_address: 't1', action: 'buy' }] };
    const result = parseInterceptedResponse('wallet_activity', raw);

    expect(result.type).toBe('wallet_activity');
    expect(Array.isArray(result.data)).toBe(true);
    const data = result.data as GmgnWalletActivity[];
    expect(data).toHaveLength(1);
    expect(data[0].walletAddress).toBe('w1');
  });

  it("routes 'smart_money' to parseSmartMoneySignals", () => {
    const raw = {
      data: [{ wallet_address: 'sm1', wallet_type: 'smart_money', token_address: 'tok1', action: 'buy' }],
    };
    const result = parseInterceptedResponse('smart_money', raw);

    expect(result.type).toBe('smart_money');
    expect(Array.isArray(result.data)).toBe(true);
    const data = result.data as GmgnSmartMoneySignal[];
    expect(data).toHaveLength(1);
    expect(data[0].walletAddress).toBe('sm1');
  });

  it("returns null data for 'token_holders' (not yet implemented)", () => {
    const result = parseInterceptedResponse('token_holders', { data: [] });

    expect(result.type).toBe('token_holders');
    expect(result.data).toBeNull();
  });

  it('returns null data for unknown pattern types', () => {
    const result = parseInterceptedResponse('unknown_type', { data: [] });

    expect(result.type).toBe('unknown_type');
    expect(result.data).toBeNull();
  });

  it('handles empty string pattern type', () => {
    const result = parseInterceptedResponse('', {});

    expect(result.type).toBe('');
    expect(result.data).toBeNull();
  });
});

// =============================================================================
// Edge cases and regression prevention
// =============================================================================
describe('edge cases', () => {
  it('very large numeric values are parsed correctly', () => {
    const raw = {
      data: {
        address: 'large_mc',
        market_cap: 999999999999,
        volume_24h: 888888888888,
      },
    };

    const result = parseTokenDetail(raw);
    expect(result).not.toBeNull();
    expect(result!.marketCap).toBe(999999999999);
    expect(result!.volume24h).toBe(888888888888);
  });

  it('very small numeric values (memecoin prices) are parsed correctly', () => {
    const raw = {
      data: {
        address: 'small_price',
        price: 0.000000001234,
      },
    };

    const result = parseTokenDetail(raw);
    expect(result).not.toBeNull();
    expect(result!.price).toBe(0.000000001234);
  });

  it('zero values are preserved (not treated as missing)', () => {
    const raw = {
      data: {
        address: 'zero_vals',
        price: 0,
        volume_24h: 0,
        holder_count: 0,
        liquidity: 0,
        market_cap: 0,
      },
    };

    const result = parseTokenDetail(raw);
    expect(result).not.toBeNull();
    expect(result!.price).toBe(0);
    expect(result!.volume24h).toBe(0);
    expect(result!.holderCount).toBe(0);
    expect(result!.liquidity).toBe(0);
    expect(result!.marketCap).toBe(0);
  });

  it('negative price change values are preserved', () => {
    const raw = {
      data: {
        address: 'neg_change',
        price_change_5m: -30.0,
        price_change_1h: -55.5,
        price_change_24h: -95.5,
      },
    };

    const result = parseTokenDetail(raw);
    expect(result).not.toBeNull();
    expect(result!.priceChange5m).toBe(-30.0);
    expect(result!.priceChange1h).toBe(-55.5);
    expect(result!.priceChange24h).toBe(-95.5);
  });

  it('handles extra/unknown fields gracefully', () => {
    const raw = {
      data: {
        address: 'extra_fields',
        symbol: 'EX',
        unknown_field: 'ignore_me',
        extra: 123,
        nested_extra: { deep: true },
      },
    };

    const result = parseTokenDetail(raw);
    expect(result).not.toBeNull();
    expect(result!.address).toBe('extra_fields');
    expect(result!.symbol).toBe('EX');
    // Extra fields should simply not appear in the typed result
    expect((result as unknown as Record<string, unknown>)['unknown_field']).toBeUndefined();
  });

  it('handles response wrapped in nested API response structure', () => {
    const raw = {
      code: 0,
      msg: 'success',
      data: {
        address: 'wrapped_token',
        symbol: 'WRP',
        price: 0.123,
        liquidity: 50000,
      },
    };

    const result = parseTokenDetail(raw);
    expect(result).not.toBeNull();
    expect(result!.address).toBe('wrapped_token');
    expect(result!.symbol).toBe('WRP');
    expect(result!.price).toBe(0.123);
    expect(result!.liquidity).toBe(50000);
  });

  it('parseTrendingTokens handles data nested under data.tokens', () => {
    const raw = {
      data: {
        tokens: [
          { address: 'tok_alt', symbol: 'ALT', price: 1.5 },
        ],
      },
    };

    const result = parseTrendingTokens(raw);
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe('tok_alt');
  });

  it('parseTrendingTokens handles data nested under data.items', () => {
    const raw = {
      data: {
        items: [
          { address: 'item_tok', symbol: 'ITM', price: 2.0 },
        ],
      },
    };

    const result = parseTrendingTokens(raw);
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe('item_tok');
  });

  it('parseWalletActivity handles data nested under data.activities', () => {
    const raw = {
      data: {
        activities: [
          { wallet_address: 'w1', token_address: 't1', action: 'buy' },
        ],
      },
    };

    const result = parseWalletActivity(raw);
    expect(result).toHaveLength(1);
    expect(result[0].walletAddress).toBe('w1');
  });

  it('parseSmartMoneySignals handles data nested under data.signals', () => {
    const raw = {
      data: {
        signals: [
          { wallet_address: 'sw1', wallet_type: 'kol', token_address: 'st1', action: 'buy' },
        ],
      },
    };

    const result = parseSmartMoneySignals(raw);
    expect(result).toHaveLength(1);
    expect(result[0].walletAddress).toBe('sw1');
    expect(result[0].walletType).toBe('kol');
  });

  it('string-encoded booleans in token detail are correctly coerced', () => {
    const raw = {
      data: {
        address: 'bool_str',
        is_dev_sold: 'false',
        is_honeypot: 'true',
        mint_authority: '0',
        freeze_authority: '1',
        lp_burned: 'true',
      },
    };

    const result = parseTokenDetail(raw);
    expect(result).not.toBeNull();
    expect(result!.devWalletSold).toBe(false);
    expect(result!.isHoneypot).toBe(true);
    expect(result!.mintAuthorityActive).toBe(false); // '0' is not '1' and not 'true'
    expect(result!.freezeAuthorityActive).toBe(true);
    expect(result!.lpBurned).toBe(true);
  });

  it('parseTokenDetail with mint alternative field name', () => {
    const raw = {
      data: {
        mint: 'mint_address_alt',
        ticker: 'ALTMINT',
        token_name: 'Alt Mint Token',
        current_price: 0.77,
      },
    };

    const result = parseTokenDetail(raw);
    expect(result).not.toBeNull();
    expect(result!.address).toBe('mint_address_alt');
    expect(result!.symbol).toBe('ALTMINT');
    expect(result!.name).toBe('Alt Mint Token');
    expect(result!.price).toBe(0.77);
  });

  it('parseWalletActivity with wallet and mint alternative field names', () => {
    const raw = {
      data: [
        {
          wallet: 'wallet_alt',
          mint: 'token_mint',
          type: 'add',
          quantity: 777,
          value_usd: 388.5,
          unit_price: 0.5,
          time: 1710000000,
          transaction_hash: 'txhash_alt',
          tokenSymbol: 'ALT',
        },
      ],
    };

    const result = parseWalletActivity(raw);
    expect(result).toHaveLength(1);
    expect(result[0].walletAddress).toBe('wallet_alt');
    expect(result[0].tokenAddress).toBe('token_mint');
    expect(result[0].action).toBe('buy'); // 'add' normalizes to 'buy'
    expect(result[0].amount).toBe(777);
    expect(result[0].amountUsd).toBe(388.5);
    expect(result[0].price).toBe(0.5);
    expect(result[0].timestamp).toBe(1710000000);
    expect(result[0].txHash).toBe('txhash_alt');
  });

  it('parseSmartMoneySignals with name field as walletTag fallback', () => {
    const raw = {
      data: [
        {
          wallet_address: 'named_wallet',
          name: 'Named Wallet Tag',
          wallet_type: 'insider',
          token_address: 'tok1',
          action: 'buy',
        },
      ],
    };

    const result = parseSmartMoneySignals(raw);
    expect(result).toHaveLength(1);
    expect(result[0].walletTag).toBe('Named Wallet Tag');
    expect(result[0].walletType).toBe('insider');
  });
});
