/**
 * tests/unit/api/birdeye.test.ts — Birdeye API Client Unit Tests
 *
 * Comprehensive unit tests for the BirdeyeClient class covering:
 * - Response parsing for getTokenPrice (price, address, priceChange24h)
 * - Response parsing for getOHLCV (candle arrays, interval params, time ranges)
 * - Response parsing for getTokenOverview (full BirdeyeTokenData fields)
 * - Response parsing for getTopHolders (holder arrays, limit params, defaults)
 * - X-API-KEY header verification (CRITICAL — every request must include it)
 * - chain=solana query parameter verification (CRITICAL — every request)
 * - Error handling: 429 rate-limited, 401 auth-failed, 404 not-found, 5xx server-error
 * - Rate limiter integration (acquire('birdeye') called before every request)
 * - Constructor validation (empty API key rejection)
 * - API key security (key never exposed in error messages)
 *
 * Per AAP Section 0.5.1 Group 4:
 *   "Birdeye REST client; methods: getTokenPrice(mint), getOHLCV(mint, interval),
 *    getTokenTransactions(mint), getTokenOverview(mint), getTopHolders(mint);
 *    all requests include X-API-KEY header and chain=solana parameter"
 *
 * Per AAP Section 0.7.4:
 *   "Per-API rate limiting is mandatory: Every external API client must route
 *    requests through the centralized rate-limiter.ts — Birdeye: 15 RPS"
 *
 * @module tests/unit/api/birdeye
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// Hoisted mock variables — available before vi.mock factories run
// ============================================================

const {
  mockGet,
  mockBuildUrl,
  mockAcquire,
  mockLogger,
  MockApiError,
} = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  /**
   * Mock ApiError class that mirrors the real ApiError interface.
   * Both the test file and the module under test (birdeye.ts) will
   * reference this same class through the mocked base-client module,
   * so instanceof checks work correctly in catch blocks.
   */
  class MockApiError extends Error {
    public readonly status: number;
    public readonly errorType: string;
    public readonly retryable: boolean;
    public readonly responseBody?: unknown;

    constructor(
      message: string,
      status: number,
      errorType: string,
      retryable: boolean,
      responseBody?: unknown,
    ) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.errorType = errorType;
      this.retryable = retryable;
      this.responseBody = responseBody;
      Object.setPrototypeOf(this, MockApiError.prototype);
    }
  }

  return {
    mockGet: vi.fn(),
    mockBuildUrl: vi.fn().mockImplementation(
      (endpoint: string, params?: Record<string, string>) => {
        const base = 'https://public-api.birdeye.so';
        if (params && Object.keys(params).length > 0) {
          const search = new URLSearchParams(params).toString();
          return `${base}${endpoint}?${search}`;
        }
        return `${base}${endpoint}`;
      },
    ),
    mockAcquire: vi.fn().mockResolvedValue(undefined),
    mockLogger,
    MockApiError,
  };
});

// ============================================================
// Module mocks — vi.mock() is hoisted to top of file by Vitest
// ============================================================

/**
 * Mock BaseClient — BirdeyeClient creates a BaseClient instance in its constructor.
 * The mock captures constructor arguments for X-API-KEY header verification
 * and provides mockGet/mockBuildUrl for controlling API response data.
 * IMPORTANT: Must use regular function (not arrow) so vi.fn() can construct with `new`.
 */
vi.mock('@/api/base-client', () => ({
  BaseClient: vi.fn(function () {
    return {
      get: mockGet,
      buildUrl: mockBuildUrl,
    };
  }),
  ApiError: MockApiError,
}));

/**
 * Mock RateLimiter — acquire() resolves immediately (no throttling in tests).
 * Tests verify that acquire() is called with 'birdeye' provider name before
 * every API request per AAP Section 0.7.4 (15 RPS rate limit).
 * IMPORTANT: Must use regular function (not arrow) so vi.fn() can construct with `new`.
 */
vi.mock('@/api/rate-limiter', () => ({
  RateLimiter: vi.fn(function () {
    return {
      acquire: mockAcquire,
    };
  }),
}));

/**
 * Mock config — provides API base URLs, Solana chain ID, timing constants,
 * and rate limit configurations used during BirdeyeClient construction.
 */
vi.mock('@/utils/config', () => ({
  API_BASE_URLS: {
    BIRDEYE: 'https://public-api.birdeye.so',
  },
  SOLANA: {
    CHAIN_ID: 'solana',
    SOL_MINT: 'So11111111111111111111111111111111111111112',
    LP_BURN_ADDRESS: '1nc1nerator11111111111111111111111111111111',
  },
  RATE_LIMITS: {
    BIRDEYE: { requestsPerSecond: 15, burstSize: 15 },
  },
  TIMING: {
    API_DEFAULT_TIMEOUT_MS: 10_000,
    RECONNECT_BACKOFF_BASE_MS: 1_000,
  },
}));

/**
 * Mock logger — returns a no-op logger to prevent console output during tests.
 * BirdeyeClient calls createLogger('birdeye-api') during construction.
 * The mock allows assertion on logging behavior during error handling.
 */
vi.mock('@/utils/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

// ============================================================
// Imports — resolved AFTER module mocking is applied
// ============================================================

import { BirdeyeClient } from '@/api/birdeye';
import type {
  BirdeyeTokenData,
  BirdeyeOHLCV,
  BirdeyeTopHolder,
} from '@/api/types';
import { BaseClient } from '@/api/base-client';

// ============================================================
// Test Constants
// ============================================================

const TEST_API_KEY = 'test-birdeye-api-key';
const ALTERNATE_API_KEY = 'alternate-birdeye-key-456';
const TEST_MINT = 'TestMint111111111111111111111111111111111111';
const UNKNOWN_MINT = 'UnknownMint1111111111111111111111111111111';
const SECOND_MINT = 'SecondMint11111111111111111111111111111111';

// ============================================================
// Mock Data Factories
// ============================================================

/**
 * Creates a mock Birdeye price API raw response envelope.
 * Matches the BirdeyeApiResponse<BirdeyeRawPrice> shape that BaseClient.get()
 * would return for the /defi/price endpoint.
 */
function createMockPriceResponse(overrides?: Partial<{
  value: number;
  updateUnixTime: number;
  updateHumanTime: string;
  priceChange24h: number;
  success: boolean;
}>) {
  return {
    success: overrides?.success ?? true,
    data: {
      value: overrides?.value ?? 0.00001234,
      updateUnixTime: overrides?.updateUnixTime ?? Math.floor(Date.now() / 1000),
      updateHumanTime: overrides?.updateHumanTime ?? new Date().toISOString(),
      priceChange24h: overrides?.priceChange24h ?? 15.5,
    },
  };
}

/**
 * Creates a mock BirdeyeTokenData object with sensible defaults.
 * Used for typing assertions and comparison in getTokenOverview tests.
 */
function createMockTokenData(
  overrides?: Partial<BirdeyeTokenData>,
): BirdeyeTokenData {
  return {
    address: TEST_MINT,
    symbol: 'TEST',
    name: 'Test Token',
    decimals: 9,
    price: 0.00001234,
    priceChange24h: 15.5,
    volume24h: 50000,
    volume1h: 3000,
    volume5m: 500,
    marketCap: 100000,
    liquidity: 25000,
    holderCount: 1500,
    supply: 1000000000,
    circulatingSupply: 800000000,
    lastTradeUnixTime: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

/**
 * Creates a mock raw overview API response envelope.
 * Matches what BaseClient.get() would return for /defi/token_overview.
 */
function createMockOverviewResponse(overrides?: Partial<BirdeyeTokenData>) {
  const data = createMockTokenData(overrides);
  return {
    success: true,
    data,
  };
}

/**
 * Creates a mock BirdeyeOHLCV candle object with sensible defaults.
 * Used for OHLCV response array items.
 */
function createMockOHLCV(
  overrides?: Partial<BirdeyeOHLCV>,
): BirdeyeOHLCV {
  return {
    unixTime: Math.floor(Date.now() / 1000),
    open: 0.00001200,
    high: 0.00001500,
    low: 0.00001100,
    close: 0.00001400,
    volume: 5000,
    ...overrides,
  };
}

/**
 * Creates a mock OHLCV list API response envelope.
 * Matches what BaseClient.get() would return for /defi/ohlcv.
 */
function createMockOHLCVResponse(items: BirdeyeOHLCV[]) {
  return {
    success: true,
    data: { items },
  };
}

/**
 * Creates a mock BirdeyeTopHolder object with sensible defaults.
 * Used for top holder response array items.
 */
function createMockTopHolder(
  overrides?: Partial<BirdeyeTopHolder>,
): BirdeyeTopHolder {
  return {
    address: 'Holder111111111111111111111111111111111111111',
    amount: 50000000,
    percentage: 5.0,
    uiAmount: 50.0,
    ...overrides,
  };
}

/**
 * Creates a mock top holders list API response envelope.
 * Matches what BaseClient.get() would return for /defi/token_holder.
 */
function createMockTopHoldersResponse(items: BirdeyeTopHolder[]) {
  return {
    success: true,
    data: { items },
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('BirdeyeClient', () => {
  let client: BirdeyeClient;

  beforeEach(() => {
    // Create a fresh BirdeyeClient instance before each test with a test API key
    client = new BirdeyeClient(TEST_API_KEY);
  });

  afterEach(() => {
    // Reset all mock function call history and implementation between tests
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Constructor Validation
  // ===========================================================================

  describe('constructor', () => {
    it('should throw an error when API key is empty', () => {
      expect(() => new BirdeyeClient('')).toThrow(
        'Birdeye API key is required',
      );
    });

    it('should throw an error when API key is whitespace only', () => {
      expect(() => new BirdeyeClient('   ')).toThrow(
        'Birdeye API key is required',
      );
    });

    it('should create a BaseClient with the correct base URL', () => {
      const freshClient = new BirdeyeClient('valid-key');
      expect(BaseClient).toHaveBeenCalledWith(
        'https://public-api.birdeye.so',
        expect.objectContaining({
          loggerContext: 'birdeye-http',
        }),
      );
    });

    it('should pass the API key as X-API-KEY in default headers', () => {
      const freshClient = new BirdeyeClient('my-secret-key');
      expect(BaseClient).toHaveBeenCalledWith(
        'https://public-api.birdeye.so',
        expect.objectContaining({
          defaultHeaders: expect.objectContaining({
            'X-API-KEY': 'my-secret-key',
          }),
        }),
      );
    });

    it('should create a logger with birdeye-api context', async () => {
      const loggerModule = await import('@/utils/logger');
      const mockedCreateLogger = vi.mocked(loggerModule.createLogger);
      // Client was already created in beforeEach which calls createLogger
      expect(mockedCreateLogger).toHaveBeenCalledWith('birdeye-api');
    });
  });

  // ===========================================================================
  // getTokenPrice — Response Parsing
  // ===========================================================================

  describe('getTokenPrice', () => {
    it('should parse token price response correctly', async () => {
      mockGet.mockResolvedValueOnce(createMockPriceResponse({
        value: 0.00005678,
        priceChange24h: 22.3,
      }));

      const result = await client.getTokenPrice(TEST_MINT);

      expect(typeof result.price).toBe('number');
      expect(result.price).toBe(0.00005678);
      expect(result.address).toBe(TEST_MINT);
      expect(result.priceChange24h).toBe(22.3);
    });

    it('should call the correct endpoint with address parameter', async () => {
      mockGet.mockResolvedValueOnce(createMockPriceResponse());

      await client.getTokenPrice(TEST_MINT);

      // makeRequest builds: `/defi/price?address=<mint>&chain=solana`
      expect(mockGet).toHaveBeenCalledTimes(1);
      const callArgs = mockGet.mock.calls[0];
      const endpoint = callArgs[0] as string;
      expect(endpoint).toContain('/defi/price');
      expect(endpoint).toContain(`address=${TEST_MINT}`);
    });

    it('should include chain=solana in the request', async () => {
      mockGet.mockResolvedValueOnce(createMockPriceResponse());

      await client.getTokenPrice(TEST_MINT);

      const endpoint = mockGet.mock.calls[0][0] as string;
      expect(endpoint).toContain('chain=solana');
    });

    it('should return empty token data for unsuccessful response', async () => {
      mockGet.mockResolvedValueOnce({
        success: false,
        data: null,
      });

      const result = await client.getTokenPrice(UNKNOWN_MINT);

      expect(result).toBeDefined();
      expect(result.address).toBe(UNKNOWN_MINT);
      expect(result.price).toBe(0);
      expect(result.volume24h).toBe(0);
      expect(result.marketCap).toBe(0);
    });

    it('should return empty token data when response data is null', async () => {
      mockGet.mockResolvedValueOnce({
        success: true,
        data: null,
      });

      const result = await client.getTokenPrice(TEST_MINT);

      expect(result.price).toBe(0);
      expect(result.address).toBe(TEST_MINT);
    });

    it('should set non-price fields to zero in price response', async () => {
      mockGet.mockResolvedValueOnce(createMockPriceResponse({
        value: 0.001,
      }));

      const result = await client.getTokenPrice(TEST_MINT);

      expect(result.price).toBe(0.001);
      // Price endpoint only returns price — other fields default to zero
      expect(result.volume24h).toBe(0);
      expect(result.volume1h).toBe(0);
      expect(result.volume5m).toBe(0);
      expect(result.marketCap).toBe(0);
      expect(result.liquidity).toBe(0);
      expect(result.holderCount).toBe(0);
    });

    it('should handle missing priceChange24h gracefully', async () => {
      mockGet.mockResolvedValueOnce({
        success: true,
        data: {
          value: 0.001,
          updateUnixTime: 1700000000,
          updateHumanTime: '2023-11-14',
          // priceChange24h intentionally omitted
        },
      });

      const result = await client.getTokenPrice(TEST_MINT);

      expect(result.priceChange24h).toBe(0);
    });
  });

  // ===========================================================================
  // getOHLCV — Response Parsing
  // ===========================================================================

  describe('getOHLCV', () => {
    it('should parse OHLCV array correctly', async () => {
      const candle1 = createMockOHLCV({ open: 0.001, close: 0.002 });
      const candle2 = createMockOHLCV({ open: 0.002, close: 0.003 });
      mockGet.mockResolvedValueOnce(createMockOHLCVResponse([candle1, candle2]));

      const result = await client.getOHLCV(TEST_MINT, '5m');

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);

      // Verify each item has all required OHLCV fields as numbers
      for (const item of result) {
        expect(typeof item.open).toBe('number');
        expect(typeof item.high).toBe('number');
        expect(typeof item.low).toBe('number');
        expect(typeof item.close).toBe('number');
        expect(typeof item.volume).toBe('number');
        expect(typeof item.unixTime).toBe('number');
      }
    });

    it('should pass interval parameter correctly', async () => {
      mockGet.mockResolvedValueOnce(createMockOHLCVResponse([]));

      await client.getOHLCV(TEST_MINT, '1H');

      const endpoint = mockGet.mock.calls[0][0] as string;
      expect(endpoint).toContain('type=1H');
    });

    it('should pass optional timeFrom and timeTo parameters', async () => {
      mockGet.mockResolvedValueOnce(createMockOHLCVResponse([]));

      await client.getOHLCV(TEST_MINT, '5m', 1700000000, 1700003600);

      const endpoint = mockGet.mock.calls[0][0] as string;
      expect(endpoint).toContain('time_from=1700000000');
      expect(endpoint).toContain('time_to=1700003600');
    });

    it('should use default time range when timeFrom/timeTo not provided', async () => {
      mockGet.mockResolvedValueOnce(createMockOHLCVResponse([]));

      await client.getOHLCV(TEST_MINT, '15m');

      const endpoint = mockGet.mock.calls[0][0] as string;
      // Should contain time_from and time_to (defaults applied)
      expect(endpoint).toContain('time_from=');
      expect(endpoint).toContain('time_to=');
    });

    it('should return empty array for no data', async () => {
      mockGet.mockResolvedValueOnce(createMockOHLCVResponse([]));

      const result = await client.getOHLCV(TEST_MINT, '5m');

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it('should return empty array when response is unsuccessful', async () => {
      mockGet.mockResolvedValueOnce({
        success: false,
        data: null,
      });

      const result = await client.getOHLCV(TEST_MINT, '5m');

      expect(result).toEqual([]);
    });

    it('should call the correct /defi/ohlcv endpoint', async () => {
      mockGet.mockResolvedValueOnce(createMockOHLCVResponse([]));

      await client.getOHLCV(TEST_MINT, '5m');

      const endpoint = mockGet.mock.calls[0][0] as string;
      expect(endpoint).toContain('/defi/ohlcv');
    });

    it('should include chain=solana in OHLCV requests', async () => {
      mockGet.mockResolvedValueOnce(createMockOHLCVResponse([]));

      await client.getOHLCV(TEST_MINT, '5m');

      const endpoint = mockGet.mock.calls[0][0] as string;
      expect(endpoint).toContain('chain=solana');
    });

    it('should parse short-form OHLCV fields (o, h, l, c, v)', async () => {
      // Birdeye may return short-form field names; the parser should handle both
      mockGet.mockResolvedValueOnce({
        success: true,
        data: {
          items: [
            { time: 1700000000, o: 0.001, h: 0.002, l: 0.0005, c: 0.0015, v: 1000 },
          ],
        },
      });

      const result = await client.getOHLCV(TEST_MINT, '5m');

      expect(result).toHaveLength(1);
      expect(result[0].open).toBe(0.001);
      expect(result[0].high).toBe(0.002);
      expect(result[0].low).toBe(0.0005);
      expect(result[0].close).toBe(0.0015);
      expect(result[0].volume).toBe(1000);
      expect(result[0].unixTime).toBe(1700000000);
    });
  });

  // ===========================================================================
  // getTokenOverview — Response Parsing
  // ===========================================================================

  describe('getTokenOverview', () => {
    it('should parse comprehensive token overview response', async () => {
      const mockData = createMockTokenData({
        price: 0.0001,
        volume24h: 75000,
        marketCap: 250000,
        liquidity: 35000,
        holderCount: 2500,
        symbol: 'MOON',
        name: 'Moon Token',
      });
      mockGet.mockResolvedValueOnce({ success: true, data: mockData });

      const result = await client.getTokenOverview(TEST_MINT);

      expect(result.price).toBe(0.0001);
      expect(result.volume24h).toBe(75000);
      expect(result.marketCap).toBe(250000);
      expect(result.liquidity).toBe(35000);
      expect(result.holderCount).toBe(2500);
      expect(result.symbol).toBe('MOON');
      expect(result.name).toBe('Moon Token');
      expect(result.address).toBe(TEST_MINT);
    });

    it('should call the correct endpoint /defi/token_overview', async () => {
      mockGet.mockResolvedValueOnce(createMockOverviewResponse());

      await client.getTokenOverview(TEST_MINT);

      const endpoint = mockGet.mock.calls[0][0] as string;
      expect(endpoint).toContain('/defi/token_overview');
    });

    it('should include address parameter in the request', async () => {
      mockGet.mockResolvedValueOnce(createMockOverviewResponse());

      await client.getTokenOverview(TEST_MINT);

      const endpoint = mockGet.mock.calls[0][0] as string;
      expect(endpoint).toContain(`address=${TEST_MINT}`);
    });

    it('should return all expected fields from overview', async () => {
      const fullData = createMockTokenData();
      mockGet.mockResolvedValueOnce({ success: true, data: fullData });

      const result = await client.getTokenOverview(TEST_MINT);

      // Verify all key fields are present and typed correctly
      expect(typeof result.address).toBe('string');
      expect(typeof result.symbol).toBe('string');
      expect(typeof result.name).toBe('string');
      expect(typeof result.price).toBe('number');
      expect(typeof result.priceChange24h).toBe('number');
      expect(typeof result.volume24h).toBe('number');
      expect(typeof result.volume1h).toBe('number');
      expect(typeof result.volume5m).toBe('number');
      expect(typeof result.marketCap).toBe('number');
      expect(typeof result.liquidity).toBe('number');
      expect(typeof result.holderCount).toBe('number');
      expect(typeof result.supply).toBe('number');
      expect(typeof result.circulatingSupply).toBe('number');
      expect(typeof result.lastTradeUnixTime).toBe('number');
    });

    it('should return empty token data for unsuccessful response', async () => {
      mockGet.mockResolvedValueOnce({
        success: false,
        data: null,
      });

      const result = await client.getTokenOverview(UNKNOWN_MINT);

      expect(result.address).toBe(UNKNOWN_MINT);
      expect(result.price).toBe(0);
      expect(result.volume24h).toBe(0);
    });

    it('should handle missing optional fields with defaults', async () => {
      // Partial overview response — only some fields populated
      mockGet.mockResolvedValueOnce({
        success: true,
        data: {
          address: TEST_MINT,
          price: 0.005,
          // Most fields intentionally omitted
        },
      });

      const result = await client.getTokenOverview(TEST_MINT);

      expect(result.address).toBe(TEST_MINT);
      expect(result.price).toBe(0.005);
      // Missing fields default to zero/empty
      expect(result.symbol).toBe('');
      expect(result.volume24h).toBe(0);
      expect(result.holderCount).toBe(0);
    });
  });

  // ===========================================================================
  // getTopHolders — Response Parsing
  // ===========================================================================

  describe('getTopHolders', () => {
    it('should parse top holders array correctly', async () => {
      const holders = [
        createMockTopHolder({ address: 'Holder1', percentage: 10.0, amount: 100000000, uiAmount: 100.0 }),
        createMockTopHolder({ address: 'Holder2', percentage: 8.5, amount: 85000000, uiAmount: 85.0 }),
        createMockTopHolder({ address: 'Holder3', percentage: 5.2, amount: 52000000, uiAmount: 52.0 }),
      ];
      mockGet.mockResolvedValueOnce(createMockTopHoldersResponse(holders));

      const result = await client.getTopHolders(TEST_MINT);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(3);

      // Verify each holder has all required fields
      for (const holder of result) {
        expect(typeof holder.address).toBe('string');
        expect(typeof holder.amount).toBe('number');
        expect(typeof holder.percentage).toBe('number');
        expect(typeof holder.uiAmount).toBe('number');
      }

      // Verify specific holder data
      expect(result[0].address).toBe('Holder1');
      expect(result[0].percentage).toBe(10.0);
      expect(result[1].address).toBe('Holder2');
      expect(result[1].percentage).toBe(8.5);
    });

    it('should pass limit parameter', async () => {
      mockGet.mockResolvedValueOnce(createMockTopHoldersResponse([]));

      await client.getTopHolders(TEST_MINT, 10);

      const endpoint = mockGet.mock.calls[0][0] as string;
      expect(endpoint).toContain('limit=10');
    });

    it('should default to 20 holders when no limit specified', async () => {
      mockGet.mockResolvedValueOnce(createMockTopHoldersResponse([]));

      await client.getTopHolders(TEST_MINT);

      const endpoint = mockGet.mock.calls[0][0] as string;
      expect(endpoint).toContain('limit=20');
    });

    it('should call the correct /defi/token_holder endpoint', async () => {
      mockGet.mockResolvedValueOnce(createMockTopHoldersResponse([]));

      await client.getTopHolders(TEST_MINT);

      const endpoint = mockGet.mock.calls[0][0] as string;
      expect(endpoint).toContain('/defi/token_holder');
    });

    it('should return empty array when response is unsuccessful', async () => {
      mockGet.mockResolvedValueOnce({
        success: false,
        data: null,
      });

      const result = await client.getTopHolders(TEST_MINT);

      expect(result).toEqual([]);
    });

    it('should return empty array when items are null', async () => {
      mockGet.mockResolvedValueOnce({
        success: true,
        data: { items: null },
      });

      const result = await client.getTopHolders(TEST_MINT);

      expect(result).toEqual([]);
    });

    it('should handle holders with missing fields gracefully', async () => {
      // Holder with some fields missing — parser defaults to 0/empty
      mockGet.mockResolvedValueOnce({
        success: true,
        data: {
          items: [
            { address: 'SomeHolder', amount: 100 },
            { percentage: 3.5 },
          ],
        },
      });

      const result = await client.getTopHolders(TEST_MINT);

      expect(result).toHaveLength(2);
      expect(result[0].address).toBe('SomeHolder');
      expect(result[0].amount).toBe(100);
      expect(result[0].percentage).toBe(0); // Default for missing field
      expect(result[1].address).toBe(''); // Default for missing address
      expect(result[1].percentage).toBe(3.5);
    });
  });

  // ===========================================================================
  // X-API-KEY Authentication (CRITICAL)
  // ===========================================================================

  describe('X-API-KEY authentication', () => {
    it('should include X-API-KEY header in every request', async () => {
      const keyClient = new BirdeyeClient('my-test-key');
      mockGet.mockResolvedValueOnce(createMockPriceResponse());

      await keyClient.getTokenPrice(TEST_MINT);

      // The BaseClient was constructed with defaultHeaders containing X-API-KEY
      expect(BaseClient).toHaveBeenCalledWith(
        'https://public-api.birdeye.so',
        expect.objectContaining({
          defaultHeaders: expect.objectContaining({
            'X-API-KEY': 'my-test-key',
          }),
        }),
      );
    });

    it('should use the API key passed in constructor', async () => {
      // Clear mocks to track individual constructor calls
      vi.clearAllMocks();

      // Create two clients with different keys
      const client1 = new BirdeyeClient('first-api-key');
      const client2 = new BirdeyeClient('second-api-key');

      // Verify BaseClient was called with different keys
      const constructorCalls = vi.mocked(BaseClient).mock.calls;

      expect(constructorCalls).toHaveLength(2);

      // First client's headers
      const firstHeaders = (constructorCalls[0][1] as { defaultHeaders: Record<string, string> })
        .defaultHeaders;
      expect(firstHeaders['X-API-KEY']).toBe('first-api-key');

      // Second client's headers
      const secondHeaders = (constructorCalls[1][1] as { defaultHeaders: Record<string, string> })
        .defaultHeaders;
      expect(secondHeaders['X-API-KEY']).toBe('second-api-key');
    });

    it('should pass X-API-KEY in default headers for all method calls', async () => {
      vi.clearAllMocks();
      const authClient = new BirdeyeClient('persistent-key-789');

      // All methods should share the same BaseClient with the same API key
      expect(BaseClient).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          defaultHeaders: { 'X-API-KEY': 'persistent-key-789' },
        }),
      );
    });
  });

  // ===========================================================================
  // chain=solana Parameter (CRITICAL)
  // ===========================================================================

  describe('chain=solana parameter', () => {
    it('should include chain=solana in every request', async () => {
      // Test across multiple different methods to verify universal inclusion

      // getTokenPrice
      mockGet.mockResolvedValueOnce(createMockPriceResponse());
      await client.getTokenPrice(TEST_MINT);
      expect(mockGet.mock.calls[0][0]).toContain('chain=solana');

      // getOHLCV
      mockGet.mockResolvedValueOnce(createMockOHLCVResponse([]));
      await client.getOHLCV(TEST_MINT, '5m');
      expect(mockGet.mock.calls[1][0]).toContain('chain=solana');

      // getTokenOverview
      mockGet.mockResolvedValueOnce(createMockOverviewResponse());
      await client.getTokenOverview(TEST_MINT);
      expect(mockGet.mock.calls[2][0]).toContain('chain=solana');

      // getTopHolders
      mockGet.mockResolvedValueOnce(createMockTopHoldersResponse([]));
      await client.getTopHolders(TEST_MINT);
      expect(mockGet.mock.calls[3][0]).toContain('chain=solana');
    });

    it('should include chain=solana in getTokenPrice request', async () => {
      mockGet.mockResolvedValueOnce(createMockPriceResponse());

      await client.getTokenPrice(TEST_MINT);

      const endpoint = mockGet.mock.calls[0][0] as string;
      expect(endpoint).toContain('chain=solana');
    });

    it('should include chain=solana in getOHLCV request', async () => {
      mockGet.mockResolvedValueOnce(createMockOHLCVResponse([]));

      await client.getOHLCV(TEST_MINT, '15m');

      const endpoint = mockGet.mock.calls[0][0] as string;
      expect(endpoint).toContain('chain=solana');
    });

    it('should include chain=solana in getTokenOverview request', async () => {
      mockGet.mockResolvedValueOnce(createMockOverviewResponse());

      await client.getTokenOverview(TEST_MINT);

      const endpoint = mockGet.mock.calls[0][0] as string;
      expect(endpoint).toContain('chain=solana');
    });

    it('should include chain=solana in getTopHolders request', async () => {
      mockGet.mockResolvedValueOnce(createMockTopHoldersResponse([]));

      await client.getTopHolders(TEST_MINT);

      const endpoint = mockGet.mock.calls[0][0] as string;
      expect(endpoint).toContain('chain=solana');
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('error handling', () => {
    it('should handle 429 Too Many Requests (rate limited)', async () => {
      const rateLimitError = new MockApiError(
        'HTTP 429 Too Many Requests',
        429,
        'rate-limited',
        true,
      );
      mockGet.mockRejectedValueOnce(rateLimitError);

      await expect(client.getTokenPrice(TEST_MINT)).rejects.toThrow();

      // Verify the error is propagated with rate-limited classification
      try {
        mockGet.mockRejectedValueOnce(rateLimitError);
        await client.getTokenPrice(TEST_MINT);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(MockApiError);
        const apiErr = error as InstanceType<typeof MockApiError>;
        expect(apiErr.status).toBe(429);
        expect(apiErr.errorType).toBe('rate-limited');
        expect(apiErr.retryable).toBe(true);
      }
    });

    it('should handle 401 Unauthorized (invalid API key)', async () => {
      const authError = new MockApiError(
        'HTTP 401 Unauthorized',
        401,
        'auth-failed',
        false,
      );
      mockGet.mockRejectedValueOnce(authError);

      await expect(client.getTokenPrice(TEST_MINT)).rejects.toThrow();

      // Verify auth errors are NOT retryable
      try {
        mockGet.mockRejectedValueOnce(authError);
        await client.getTokenPrice(TEST_MINT);
      } catch (error: unknown) {
        const apiErr = error as InstanceType<typeof MockApiError>;
        expect(apiErr.status).toBe(401);
        expect(apiErr.errorType).toBe('auth-failed');
        expect(apiErr.retryable).toBe(false);
      }
    });

    it('should handle 404 Not Found gracefully for getTokenPrice', async () => {
      const notFoundError = new MockApiError(
        'HTTP 404 Not Found',
        404,
        'not-found',
        false,
      );
      mockGet.mockRejectedValueOnce(notFoundError);

      // 404 should NOT throw — returns empty data instead
      const result = await client.getTokenPrice('nonexistent-mint');

      expect(result).toBeDefined();
      expect(result.address).toBe('nonexistent-mint');
      expect(result.price).toBe(0);
    });

    it('should handle 404 Not Found gracefully for getOHLCV', async () => {
      const notFoundError = new MockApiError(
        'HTTP 404 Not Found',
        404,
        'not-found',
        false,
      );
      mockGet.mockRejectedValueOnce(notFoundError);

      // 404 returns empty array for list endpoints
      const result = await client.getOHLCV('nonexistent-mint', '5m');

      expect(result).toEqual([]);
    });

    it('should handle 404 Not Found gracefully for getTokenOverview', async () => {
      const notFoundError = new MockApiError(
        'HTTP 404 Not Found',
        404,
        'not-found',
        false,
      );
      mockGet.mockRejectedValueOnce(notFoundError);

      const result = await client.getTokenOverview('nonexistent-mint');

      expect(result.address).toBe('nonexistent-mint');
      expect(result.price).toBe(0);
    });

    it('should handle 404 Not Found gracefully for getTopHolders', async () => {
      const notFoundError = new MockApiError(
        'HTTP 404 Not Found',
        404,
        'not-found',
        false,
      );
      mockGet.mockRejectedValueOnce(notFoundError);

      const result = await client.getTopHolders('nonexistent-mint');

      expect(result).toEqual([]);
    });

    it('should handle 5xx Server Error by re-throwing', async () => {
      const serverError = new MockApiError(
        'HTTP 500 Internal Server Error',
        500,
        'server-error',
        true,
      );
      mockGet.mockRejectedValueOnce(serverError);

      // 5xx errors should be thrown (retried by BaseClient, then propagated)
      await expect(client.getTokenPrice(TEST_MINT)).rejects.toThrow();
    });

    it('should propagate 5xx errors with retryable=true', async () => {
      const serverError = new MockApiError(
        'HTTP 503 Service Unavailable',
        503,
        'server-error',
        true,
      );
      mockGet.mockRejectedValueOnce(serverError);

      try {
        await client.getTokenPrice(TEST_MINT);
        expect.fail('Should have thrown');
      } catch (error: unknown) {
        const apiErr = error as InstanceType<typeof MockApiError>;
        expect(apiErr.status).toBe(503);
        expect(apiErr.errorType).toBe('server-error');
        expect(apiErr.retryable).toBe(true);
      }
    });

    it('should never expose API key in error messages', async () => {
      const serverError = new MockApiError(
        'HTTP 500 Internal Server Error',
        500,
        'server-error',
        true,
      );
      mockGet.mockRejectedValueOnce(serverError);

      try {
        await client.getTokenPrice(TEST_MINT);
      } catch (error: unknown) {
        const errorMessage = (error as Error).message;
        // The API key MUST never appear in error messages — security requirement
        expect(errorMessage).not.toContain(TEST_API_KEY);
      }

      // Also verify logger calls don't contain the API key
      for (const logMethod of [mockLogger.warn, mockLogger.error, mockLogger.info, mockLogger.debug]) {
        for (const call of logMethod.mock.calls) {
          const callStr = JSON.stringify(call);
          expect(callStr).not.toContain(TEST_API_KEY);
        }
      }
    });

    it('should handle non-ApiError exceptions', async () => {
      // Non-API errors (e.g., network failures) should be re-thrown as-is
      const genericError = new Error('Network connection lost');
      mockGet.mockRejectedValueOnce(genericError);

      await expect(client.getTokenPrice(TEST_MINT)).rejects.toThrow(
        'Network connection lost',
      );
    });

    it('should log rate-limited errors as warnings', async () => {
      const rateLimitError = new MockApiError(
        'HTTP 429',
        429,
        'rate-limited',
        true,
      );
      mockGet.mockRejectedValueOnce(rateLimitError);

      try {
        await client.getTokenPrice(TEST_MINT);
      } catch {
        // Expected — error is re-thrown after logging
      }

      // Verify a warning was logged about rate limiting
      expect(mockLogger.warn).toHaveBeenCalled();
      const warnCalls = mockLogger.warn.mock.calls;
      const hasRateLimitWarn = warnCalls.some(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].toLowerCase().includes('rate limit'),
      );
      expect(hasRateLimitWarn).toBe(true);
    });

    it('should log auth-failed errors as errors', async () => {
      const authError = new MockApiError(
        'HTTP 401',
        401,
        'auth-failed',
        false,
      );
      mockGet.mockRejectedValueOnce(authError);

      try {
        await client.getTokenPrice(TEST_MINT);
      } catch {
        // Expected
      }

      // Verify an error was logged about authentication failure
      expect(mockLogger.error).toHaveBeenCalled();
      const errorCalls = mockLogger.error.mock.calls;
      const hasAuthError = errorCalls.some(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].toLowerCase().includes('authentication'),
      );
      expect(hasAuthError).toBe(true);
    });
  });

  // ===========================================================================
  // Rate Limiter Integration
  // ===========================================================================

  describe('rate limiter integration', () => {
    it('should call rate limiter acquire before getTokenPrice request', async () => {
      mockGet.mockResolvedValueOnce(createMockPriceResponse());

      await client.getTokenPrice(TEST_MINT);

      // Verify acquire was called with 'birdeye' provider
      expect(mockAcquire).toHaveBeenCalledWith('birdeye');
      expect(mockAcquire).toHaveBeenCalledTimes(1);
    });

    it('should call rate limiter acquire before getOHLCV request', async () => {
      mockGet.mockResolvedValueOnce(createMockOHLCVResponse([]));

      await client.getOHLCV(TEST_MINT, '5m');

      expect(mockAcquire).toHaveBeenCalledWith('birdeye');
      expect(mockAcquire).toHaveBeenCalledTimes(1);
    });

    it('should call rate limiter acquire before getTokenOverview request', async () => {
      mockGet.mockResolvedValueOnce(createMockOverviewResponse());

      await client.getTokenOverview(TEST_MINT);

      expect(mockAcquire).toHaveBeenCalledWith('birdeye');
      expect(mockAcquire).toHaveBeenCalledTimes(1);
    });

    it('should call rate limiter acquire before getTopHolders request', async () => {
      mockGet.mockResolvedValueOnce(createMockTopHoldersResponse([]));

      await client.getTopHolders(TEST_MINT);

      expect(mockAcquire).toHaveBeenCalledWith('birdeye');
      expect(mockAcquire).toHaveBeenCalledTimes(1);
    });

    it('should call rate limiter acquire BEFORE the BaseClient.get call', async () => {
      // Track the order of calls
      const callOrder: string[] = [];

      mockAcquire.mockImplementationOnce(() => {
        callOrder.push('acquire');
        return Promise.resolve();
      });

      mockGet.mockImplementationOnce(() => {
        callOrder.push('get');
        return Promise.resolve(createMockPriceResponse());
      });

      await client.getTokenPrice(TEST_MINT);

      // acquire MUST come before get in the execution order
      expect(callOrder).toEqual(['acquire', 'get']);
    });

    it('should wait for rate limiter token before proceeding', async () => {
      let acquireResolved = false;

      // Make acquire return a delayed promise
      mockAcquire.mockImplementationOnce(() => {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            acquireResolved = true;
            resolve();
          }, 10);
        });
      });

      mockGet.mockImplementationOnce(() => {
        // When get is called, acquire must have resolved
        expect(acquireResolved).toBe(true);
        return Promise.resolve(createMockPriceResponse());
      });

      await client.getTokenPrice(TEST_MINT);

      expect(acquireResolved).toBe(true);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('should propagate rate limiter errors', async () => {
      mockAcquire.mockRejectedValueOnce(
        new Error('Rate limiter queue timeout after 30000ms for birdeye'),
      );

      await expect(client.getTokenPrice(TEST_MINT)).rejects.toThrow(
        'Rate limiter queue timeout',
      );

      // BaseClient.get should NOT have been called since acquire failed
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('should acquire rate limit token for each independent call', async () => {
      mockGet.mockResolvedValue(createMockPriceResponse());

      await client.getTokenPrice(TEST_MINT);
      await client.getTokenPrice(SECOND_MINT);

      // Each call should independently acquire a token
      expect(mockAcquire).toHaveBeenCalledTimes(2);
      expect(mockAcquire).toHaveBeenCalledWith('birdeye');
    });
  });

  // ===========================================================================
  // Cache Key Generation
  // ===========================================================================

  describe('cache integration', () => {
    it('should pass cache key to BaseClient.get for getTokenPrice', async () => {
      mockGet.mockResolvedValueOnce(createMockPriceResponse());

      await client.getTokenPrice(TEST_MINT);

      // BaseClient.get should receive cacheKey and cacheTtlMs
      const options = mockGet.mock.calls[0][1] as { cacheKey?: string; cacheTtlMs?: number };
      expect(options).toBeDefined();
      expect(options.cacheKey).toBeDefined();
      expect(typeof options.cacheKey).toBe('string');
      expect(options.cacheKey).toContain('birdeye:');
      expect(typeof options.cacheTtlMs).toBe('number');
      expect(options.cacheTtlMs).toBeGreaterThan(0);
    });

    it('should use buildUrl for deterministic cache keys', async () => {
      mockGet.mockResolvedValueOnce(createMockPriceResponse());

      await client.getTokenPrice(TEST_MINT);

      // buildUrl should have been called to generate the cache key
      expect(mockBuildUrl).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Multiple Concurrent Method Calls
  // ===========================================================================

  describe('concurrent usage', () => {
    it('should handle multiple concurrent API calls correctly', async () => {
      mockGet
        .mockResolvedValueOnce(createMockPriceResponse({ value: 0.001 }))
        .mockResolvedValueOnce(createMockOverviewResponse({ price: 0.002 }))
        .mockResolvedValueOnce(createMockTopHoldersResponse([
          createMockTopHolder({ percentage: 15 }),
        ]));

      const [price, overview, holders] = await Promise.all([
        client.getTokenPrice(TEST_MINT),
        client.getTokenOverview(SECOND_MINT),
        client.getTopHolders(TEST_MINT),
      ]);

      expect(price.price).toBe(0.001);
      expect(overview.price).toBe(0.002);
      expect(holders).toHaveLength(1);
      expect(holders[0].percentage).toBe(15);

      // All three calls should have acquired rate limit tokens
      expect(mockAcquire).toHaveBeenCalledTimes(3);
    });
  });
});
