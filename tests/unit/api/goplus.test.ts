/**
 * tests/unit/api/goplus.test.ts — GoPlus Security Client Unit Tests
 *
 * Comprehensive unit tests for the GoPlusClient class that queries the GoPlus
 * Security API for Solana token security analysis.
 *
 * Test coverage areas (per AAP Section 0.2.3):
 * - String-to-boolean '0'/'1' conversion (isMintable, isFreezable, isOpenSource, isLpLocked)
 * - Top holder concentration computation (top10HolderPercent, largestHolderPercent)
 * - LP status parsing (locked, burned via burn address)
 * - No authentication headers (GoPlus is free tier)
 * - Fail-safe defaults on API failure (worst-case-wins policy)
 * - Correct endpoint and parameter construction
 * - Rate limiter integration ('goplus' provider, 'high' priority)
 * - Batch security check (getTokenSecurityBatch)
 *
 * All dependencies (BaseClient, RateLimiter, config, logger) are fully mocked
 * to ensure zero real HTTP calls and complete test isolation.
 */

import { GoPlusClient } from '../../../src/api/goplus';
import type { GoPlusResult, GoPlusHolder, GoPlusLPHolder } from '../../../src/api/types';

// =============================================================================
// Hoisted mock variables — accessible within vi.mock() factory functions
// =============================================================================

const { mockGet, mockBuildUrl, mockAcquire, mockLogger, baseClientConstructorArgs } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockBuildUrl: vi.fn((endpoint: string) => `https://api.gopluslabs.io${endpoint}`),
  mockAcquire: vi.fn().mockResolvedValue(undefined),
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  /** Captures every BaseClient constructor invocation for auth header verification */
  baseClientConstructorArgs: [] as Array<{ baseUrl: string; options?: Record<string, unknown> }>,
}));

// =============================================================================
// Module-level mocks
// =============================================================================

/**
 * Mock BaseClient — replaces the real HTTP client with a controllable stub.
 * GoPlusClient creates a BaseClient instance in its constructor via `new BaseClient(...)`,
 * so the mock must provide a proper class constructor (not an arrow function).
 */
vi.mock('../../../src/api/base-client', () => {
  class MockBaseClient {
    get = mockGet;
    buildUrl = mockBuildUrl;
    baseUrl: string;
    defaultHeaders: Record<string, string>;
    constructor(baseUrl: string, options?: Record<string, unknown>) {
      this.baseUrl = baseUrl;
      this.defaultHeaders = (options?.defaultHeaders as Record<string, string>) ?? {};
      baseClientConstructorArgs.push({ baseUrl, options });
    }
  }

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
    BaseClient: MockBaseClient,
    ApiError: MockApiError,
  };
});

/**
 * Mock RateLimiter — acquire() immediately resolves (no throttling in tests).
 * Tests verify acquire() is called with correct provider name and priority.
 * Uses a class constructor so `new RateLimiter()` works correctly.
 */
vi.mock('../../../src/api/rate-limiter', () => {
  class MockRateLimiter {
    acquire = mockAcquire;
  }
  return {
    RateLimiter: MockRateLimiter,
  };
});

/**
 * Mock config — provides API_BASE_URLS.GOPLUS, SOLANA.LP_BURN_ADDRESS, and
 * TIMING constants required by GoPlusClient and its transitive dependencies.
 */
vi.mock('../../../src/utils/config', () => ({
  API_BASE_URLS: {
    GOPLUS: 'https://api.gopluslabs.io',
  },
  SOLANA: {
    LP_BURN_ADDRESS: '1nc1nerator11111111111111111111111111111111',
    CHAIN_ID: 'solana',
    SOL_MINT: 'So11111111111111111111111111111111111111112',
  },
  TIMING: {
    API_DEFAULT_TIMEOUT_MS: 10_000,
    RECONNECT_BACKOFF_BASE_MS: 1_000,
  },
  RATE_LIMITS: {
    GOPLUS: { requestsPerSecond: 5, burstSize: 5 },
  },
}));

/**
 * Mock logger — prevents console output during tests and allows assertion
 * on logging behavior (e.g., warn() called during fail-safe scenarios).
 */
vi.mock('../../../src/utils/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
}));

// =============================================================================
// Test Helpers — Raw GoPlus API Response Factories
// =============================================================================

/** Default test mint address used across all test cases */
const TEST_MINT = 'TestMint111111111111111111111111111111111111';

/**
 * Creates a raw GoPlus API response envelope with string '0'/'1' booleans
 * as returned by the actual GoPlus API. This is the UNPARSED format.
 *
 * @param address - Token mint address (used as the result map key, lowercased)
 * @param overrides - Optional field overrides for the token data within the result
 */
function createRawGoPlusResponse(
  address: string,
  overrides?: Record<string, unknown>,
) {
  return {
    code: 1,
    message: 'OK',
    result: {
      [address.toLowerCase()]: {
        is_mintable: '0',
        is_open_source: '1',
        can_take_back_ownership: '0',
        is_freezable: '0',
        owner_change_balance: '0',
        hidden_owner: '0',
        selfdestruct: '0',
        external_call: '0',
        holder_count: '500',
        total_supply: '1000000000',
        holders: [
          { address: 'Holder1AAA', balance: '50000000', percent: '0.05', is_contract: 0, tag: '' },
          { address: 'Holder2BBB', balance: '30000000', percent: '0.03', is_contract: 0, tag: '' },
        ],
        lp_holders: [
          { address: 'LPHolder1CCC', balance: '100000', percent: '0.95', is_locked: 1, tag: 'lock' },
        ],
        lp_total_supply: '100000',
        creator_address: 'Creator111',
        owner_address: 'Owner111',
        ...overrides,
      },
    },
  };
}

/**
 * Creates holders array with specific percentage values for concentration tests.
 * GoPlus returns percent as decimal fractions (e.g., '0.05' = 5%).
 *
 * @param count - Number of holders to create
 * @param percentEach - Percent each holder owns as a decimal string (e.g., '0.05' for 5%)
 */
function createHolders(count: number, percentEach: string) {
  return Array.from({ length: count }, (_, i) => ({
    address: `Holder${i}`,
    balance: '10000000',
    percent: percentEach,
    is_contract: 0,
    tag: '',
  }));
}

// =============================================================================
// Test Suites
// =============================================================================

describe('GoPlusClient', () => {
  let client: GoPlusClient;

  beforeEach(() => {
    // Create a fresh client for each test — no API key required (GoPlus is free)
    client = new GoPlusClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
    baseClientConstructorArgs.length = 0;
  });

  // ===========================================================================
  // Suite 1: String-to-Boolean '0'/'1' Conversion (MOST CRITICAL)
  // ===========================================================================

  describe('string-to-boolean parsing', () => {
    it('should parse is_mintable "0" as isMintable: false', async () => {
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { is_mintable: '0' }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isMintable).toBe(false);
      expect(typeof result.isMintable).toBe('boolean');
    });

    it('should parse is_mintable "1" as isMintable: true', async () => {
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { is_mintable: '1' }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isMintable).toBe(true);
      expect(typeof result.isMintable).toBe('boolean');
    });

    it('should parse can_take_back_ownership "0" as isFreezable: false', async () => {
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, {
          can_take_back_ownership: '0',
          is_freezable: '0',
        }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isFreezable).toBe(false);
      expect(typeof result.isFreezable).toBe('boolean');
    });

    it('should parse can_take_back_ownership "1" as isFreezable: true', async () => {
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, {
          can_take_back_ownership: '1',
          is_freezable: '0',
        }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isFreezable).toBe(true);
      expect(typeof result.isFreezable).toBe('boolean');
    });

    it('should parse is_freezable "1" as isFreezable: true when can_take_back_ownership is "0"', async () => {
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, {
          can_take_back_ownership: '0',
          is_freezable: '1',
        }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isFreezable).toBe(true);
    });

    it('should parse is_open_source "1" as isOpenSource: true', async () => {
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { is_open_source: '1' }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isOpenSource).toBe(true);
      expect(typeof result.isOpenSource).toBe('boolean');
    });

    it('should parse is_open_source "0" as isOpenSource: false', async () => {
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { is_open_source: '0' }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isOpenSource).toBe(false);
      expect(typeof result.isOpenSource).toBe('boolean');
    });

    it('should handle missing boolean fields with parseStringBoolean default (false)', async () => {
      // When is_mintable is completely absent from the raw response,
      // parseStringBoolean(undefined) returns false.
      // The truly "unsafe" defaults only apply via createUnsafeDefault
      // on complete API failure — not on missing individual fields.
      const rawResponse = createRawGoPlusResponse(TEST_MINT);
      const tokenData = rawResponse.result[TEST_MINT.toLowerCase()] as Record<string, unknown>;
      delete tokenData.is_mintable;
      mockGet.mockResolvedValueOnce(rawResponse);

      const result = await client.getTokenSecurity(TEST_MINT);

      // parseStringBoolean(undefined) returns false
      expect(result.isMintable).toBe(false);
      expect(typeof result.isMintable).toBe('boolean');
    });

    it('should never return string values for any boolean field', async () => {
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, {
          is_mintable: '1',
          can_take_back_ownership: '0',
          is_freezable: '0',
          is_open_source: '1',
        }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      // Every boolean field must be a native boolean, never a string
      expect(typeof result.isMintable).toBe('boolean');
      expect(typeof result.isFreezable).toBe('boolean');
      expect(typeof result.isOpenSource).toBe('boolean');
      expect(typeof result.isLpLocked).toBe('boolean');
    });

    it('should parse numeric 1 as true (in addition to string "1")', async () => {
      // GoPlus may also return integer 1 instead of string '1' for some fields
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { is_mintable: 1 as unknown as string }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isMintable).toBe(true);
      expect(typeof result.isMintable).toBe('boolean');
    });
  });

  // ===========================================================================
  // Suite 2: Top Holder Concentration Computation (CRITICAL)
  // ===========================================================================

  describe('top holder concentration computation', () => {
    it('should compute top10HolderPercent from top 10 holders', async () => {
      // 10 holders each holding 5% (percent: '0.05' as decimal fraction → 5%)
      const holders = createHolders(10, '0.05');

      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { holders }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      // 10 × 5% = 50%
      expect(result.top10HolderPercent).toBe(50);
    });

    it('should compute largestHolderPercent correctly', async () => {
      const holders = [
        { address: 'Whale1', balance: '100000000', percent: '0.15', is_contract: 0, tag: '' },
        { address: 'Holder2', balance: '50000000', percent: '0.05', is_contract: 0, tag: '' },
        { address: 'Holder3', balance: '30000000', percent: '0.03', is_contract: 0, tag: '' },
      ];

      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { holders }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      // Largest holder has 15% (0.15 × 100)
      expect(result.largestHolderPercent).toBe(15);
    });

    it('should detect dangerous concentration (>50% top 10 holders)', async () => {
      // 10 holders each holding 5.5% → total 55%
      const holders = createHolders(10, '0.055');

      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { holders }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      // 10 × 5.5% = 55% — triggers AAP hard filter "top 10 holders >50%"
      expect(result.top10HolderPercent).toBe(55);
    });

    it('should handle fewer than 10 holders correctly', async () => {
      const holders = [
        { address: 'H1', balance: '100', percent: '0.10', is_contract: 0, tag: '' },
        { address: 'H2', balance: '50', percent: '0.05', is_contract: 0, tag: '' },
        { address: 'H3', balance: '30', percent: '0.03', is_contract: 0, tag: '' },
      ];

      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { holders }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      // 10% + 5% + 3% = 18% — sums only the holders that exist
      expect(result.top10HolderPercent).toBe(18);
      expect(result.largestHolderPercent).toBe(10);
    });

    it('should handle empty holders array with pessimistic defaults', async () => {
      // Per the GoPlus client implementation: empty holders → worst-case defaults
      // to ensure tokens with no holder data are treated as potentially unsafe
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { holders: [] }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      // Empty holders → pessimistic defaults {top10: 100, largest: 100}
      expect(result.top10HolderPercent).toBe(100);
      expect(result.largestHolderPercent).toBe(100);
    });

    it('should parse holder percent from string to number', async () => {
      // GoPlus returns percent as string decimal fraction: '0.15' = 15%
      const holders = [
        { address: 'H1', balance: '100', percent: '0.15', is_contract: 0, tag: '' },
      ];

      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { holders }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      // '0.15' → parsePercentString → 0.15 × 100 = 15
      expect(result.largestHolderPercent).toBe(15);
      expect(typeof result.largestHolderPercent).toBe('number');
    });

    it('should cap top10HolderPercent at 100', async () => {
      // Create scenario where sum could theoretically exceed 100
      const holders = createHolders(10, '0.12');

      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { holders }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      // 10 × 12% = 120% → capped at 100
      expect(result.top10HolderPercent).toBeLessThanOrEqual(100);
    });

    it('should only sum top 10 holders even when more exist', async () => {
      // 15 holders, but only top 10 should be summed
      const holders = createHolders(15, '0.04');

      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { holders }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      // Top 10 × 4% = 40% (not 15 × 4% = 60%)
      expect(result.top10HolderPercent).toBe(40);
    });
  });

  // ===========================================================================
  // Suite 3: LP Status Parsing
  // ===========================================================================

  describe('LP status parsing', () => {
    it('should detect LP locked from lp_holders data', async () => {
      const lp_holders = [
        { address: 'LPHolder1', balance: '100000', percent: '0.95', is_locked: 1, tag: 'lock' },
      ];

      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { lp_holders }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isLpLocked).toBe(true);
      expect(typeof result.isLpLocked).toBe('boolean');
    });

    it('should detect LP NOT locked', async () => {
      const lp_holders = [
        { address: 'LPHolder1', balance: '100000', percent: '0.95', is_locked: 0, tag: '' },
      ];

      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { lp_holders }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isLpLocked).toBe(false);
    });

    it('should detect LP burned when burn address holds LP tokens', async () => {
      const lp_holders = [
        {
          address: '1nc1nerator11111111111111111111111111111111',
          balance: '95000',
          percent: '0.95',
          is_locked: 0,
          tag: 'burn',
        },
      ];

      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { lp_holders }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      // Burn address holds LP tokens → isLpLocked = true (LP burned = effectively locked)
      expect(result.isLpLocked).toBe(true);
    });

    it('should parse lp_total_supply correctly', async () => {
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { lp_total_supply: '500000' }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.lpTotalSupply).toBe('500000');
    });

    it('should return isLpLocked: false when lp_holders is empty', async () => {
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { lp_holders: [] }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isLpLocked).toBe(false);
    });

    it('should return isLpLocked: false when lp_holders is undefined', async () => {
      const raw = createRawGoPlusResponse(TEST_MINT);
      const tokenData = raw.result[TEST_MINT.toLowerCase()] as Record<string, unknown>;
      delete tokenData.lp_holders;
      mockGet.mockResolvedValueOnce(raw);

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isLpLocked).toBe(false);
    });

    it('should parse LP holders into typed GoPlusLPHolder objects', async () => {
      const lp_holders = [
        { address: 'LPAddr1', balance: '50000', percent: '0.50', is_locked: 1, tag: 'lock' },
        { address: 'LPAddr2', balance: '50000', percent: '0.50', is_locked: 0, tag: '' },
      ];

      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { lp_holders }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.lpHolders).toHaveLength(2);
      expect(result.lpHolders[0].address).toBe('LPAddr1');
      expect(result.lpHolders[0].isLocked).toBe(true);
      expect(result.lpHolders[1].isLocked).toBe(false);
    });
  });

  // ===========================================================================
  // Suite 4: No Authentication (CRITICAL)
  // ===========================================================================

  describe('no authentication', () => {
    it('should NOT include any authentication headers', async () => {
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT),
      );

      await client.getTokenSecurity(TEST_MINT);

      // Access the captured BaseClient constructor args
      expect(baseClientConstructorArgs.length).toBeGreaterThan(0);
      const lastCall = baseClientConstructorArgs[baseClientConstructorArgs.length - 1];
      const options = lastCall.options;

      // Verify no auth-related defaultHeaders were passed to BaseClient
      if (options && 'defaultHeaders' in options) {
        const headers = options.defaultHeaders as Record<string, string>;
        expect(headers).not.toHaveProperty('X-API-KEY');
        expect(headers).not.toHaveProperty('Authorization');
        expect(headers).not.toHaveProperty('x-api-key');
        expect(headers).not.toHaveProperty('Bearer');
      }

      // Also verify that get() was called with just the endpoint, no extra auth options
      expect(mockGet).toHaveBeenCalledTimes(1);
      const getArgs = mockGet.mock.calls[0];
      // Only 1 argument (the endpoint string) — no options object with headers
      expect(getArgs).toHaveLength(1);
    });

    it('should NOT require an API key in constructor', () => {
      // GoPlusClient constructor takes an optional RateLimiter, NOT an API key
      expect(() => new GoPlusClient()).not.toThrow();
    });

    it('should create a valid client without any constructor arguments', () => {
      const noArgClient = new GoPlusClient();

      // The client should exist and have the expected public methods
      expect(noArgClient).toBeDefined();
      expect(typeof noArgClient.getTokenSecurity).toBe('function');
      expect(typeof noArgClient.getTokenSecurityBatch).toBe('function');
    });
  });

  // ===========================================================================
  // Suite 5: Fail-Safe Defaults (CRITICAL)
  // ===========================================================================

  describe('fail-safe defaults', () => {
    it('should return unsafe defaults when API is unavailable (network error)', async () => {
      mockGet.mockRejectedValueOnce(new TypeError('fetch failed'));

      const result = await client.getTokenSecurity(TEST_MINT);

      // Per AAP worst-case-wins policy: assume the worst when data is unavailable
      expect(result.isMintable).toBe(true);
      expect(result.isFreezable).toBe(true);
      expect(result.isOpenSource).toBe(false);
      expect(result.isLpLocked).toBe(false);
      expect(result.top10HolderPercent).toBe(100);
      expect(result.largestHolderPercent).toBe(100);
      expect(result.tokenAddress).toBe(TEST_MINT);
    });

    it('should return fail-safe defaults on 5xx server error', async () => {
      const { ApiError } = await import('../../../src/api/base-client');
      mockGet.mockRejectedValueOnce(
        new ApiError('Internal Server Error', 500, 'server-error', true),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isMintable).toBe(true);
      expect(result.isFreezable).toBe(true);
      expect(result.isLpLocked).toBe(false);
      expect(result.top10HolderPercent).toBe(100);
    });

    it('should return fail-safe defaults on timeout', async () => {
      const { ApiError } = await import('../../../src/api/base-client');
      mockGet.mockRejectedValueOnce(
        new ApiError('Request timeout after 10000ms', 0, 'timeout', true),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isMintable).toBe(true);
      expect(result.isFreezable).toBe(true);
      expect(result.isLpLocked).toBe(false);
      expect(result.top10HolderPercent).toBe(100);
    });

    it('should never crash or throw on API failure', async () => {
      // Test with various error types — all must resolve, never reject
      const errors = [
        new TypeError('Network error'),
        new Error('Unknown error'),
        new RangeError('Out of range'),
        'string error',
        null,
      ];

      for (const error of errors) {
        mockGet.mockRejectedValueOnce(error);
        // Must resolve with a valid GoPlusResult, never throw
        await expect(client.getTokenSecurity(TEST_MINT)).resolves.toBeDefined();
      }
    });

    it('should return fail-safe defaults when response structure is unexpected', async () => {
      // Response has no data for the requested address
      mockGet.mockResolvedValueOnce({
        code: 1,
        message: 'OK',
        result: {},
      });

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isMintable).toBe(true);
      expect(result.isFreezable).toBe(true);
      expect(result.isLpLocked).toBe(false);
      expect(result.top10HolderPercent).toBe(100);
    });

    it('should return fail-safe defaults when result for address is null', async () => {
      mockGet.mockResolvedValueOnce({
        code: 1,
        message: 'OK',
        result: { [TEST_MINT.toLowerCase()]: null },
      });

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isMintable).toBe(true);
      expect(result.isFreezable).toBe(true);
      expect(result.isLpLocked).toBe(false);
      expect(result.top10HolderPercent).toBe(100);
    });

    it('should return fail-safe defaults when response code is not 1', async () => {
      mockGet.mockResolvedValueOnce({
        code: 0,
        message: 'Error',
        result: null,
      });

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.isMintable).toBe(true);
      expect(result.isFreezable).toBe(true);
      expect(result.isLpLocked).toBe(false);
      expect(result.top10HolderPercent).toBe(100);
    });

    it('should return fail-safe defaults for empty address input', async () => {
      const result = await client.getTokenSecurity('');

      expect(result.isMintable).toBe(true);
      expect(result.isFreezable).toBe(true);
      expect(result.isLpLocked).toBe(false);
      expect(result.top10HolderPercent).toBe(100);
    });

    it('should log a warning when returning fail-safe defaults', async () => {
      mockGet.mockRejectedValueOnce(new Error('API down'));

      await client.getTokenSecurity(TEST_MINT);

      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should log an error when API call fails', async () => {
      mockGet.mockRejectedValueOnce(new Error('Connection refused'));

      await client.getTokenSecurity(TEST_MINT);

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Suite 6: Correct Endpoint and Parameters
  // ===========================================================================

  describe('endpoint and parameters', () => {
    it('should call the correct GoPlus endpoint', async () => {
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT),
      );

      await client.getTokenSecurity(TEST_MINT);

      // Verify get() was called with the Solana token security endpoint
      expect(mockGet).toHaveBeenCalledTimes(1);
      const callEndpoint = mockGet.mock.calls[0][0] as string;
      expect(callEndpoint).toContain('/api/v1/solana/token_security');
      expect(callEndpoint).toContain(`contract_addresses=${encodeURIComponent(TEST_MINT)}`);
    });

    it('should extract result using lowercase address key', async () => {
      const mixedCaseAddress = 'TestMintMixedCase111111111111111111111111';
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(mixedCaseAddress),
      );

      const result = await client.getTokenSecurity(mixedCaseAddress);

      // GoPlus keys results by lowercased address, client must look up correctly
      expect(result.tokenAddress).toBe(mixedCaseAddress);
      expect(result.isMintable).toBe(false); // parsed from the keyed data, not fail-safe
    });

    it('should URL-encode the contract address in the endpoint', async () => {
      const addressWithSpecialChars = 'Test+Mint/Special';
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(addressWithSpecialChars),
      );

      await client.getTokenSecurity(addressWithSpecialChars);

      const callEndpoint = mockGet.mock.calls[0][0] as string;
      expect(callEndpoint).toContain(encodeURIComponent(addressWithSpecialChars));
    });
  });

  // ===========================================================================
  // Suite 7: Rate Limiter Integration
  // ===========================================================================

  describe('rate limiter', () => {
    it('should call rate limiter before each request', async () => {
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT),
      );

      await client.getTokenSecurity(TEST_MINT);

      // Verify acquire was called with 'goplus' provider and 'high' priority
      expect(mockAcquire).toHaveBeenCalledTimes(1);
      expect(mockAcquire).toHaveBeenCalledWith('goplus', 'high');
    });

    it('should call rate limiter before the BaseClient.get call', async () => {
      const callOrder: string[] = [];

      mockAcquire.mockImplementationOnce(async () => {
        callOrder.push('acquire');
      });
      mockGet.mockImplementationOnce(async () => {
        callOrder.push('get');
        return createRawGoPlusResponse(TEST_MINT);
      });

      await client.getTokenSecurity(TEST_MINT);

      expect(callOrder).toEqual(['acquire', 'get']);
    });

    it('should call rate limiter for batch requests', async () => {
      const addresses = ['Addr1', 'Addr2', 'Addr3'];
      mockGet.mockResolvedValue({
        code: 1,
        message: 'OK',
        result: {
          addr1: { is_mintable: '0', holders: [], lp_holders: [] },
          addr2: { is_mintable: '0', holders: [], lp_holders: [] },
          addr3: { is_mintable: '0', holders: [], lp_holders: [] },
        },
      });

      await client.getTokenSecurityBatch(addresses);

      // Rate limiter should be called at least once for the batch
      expect(mockAcquire).toHaveBeenCalledWith('goplus', 'high');
    });
  });

  // ===========================================================================
  // Suite 8: Batch Security Check
  // ===========================================================================

  describe('getTokenSecurityBatch', () => {
    it('should return results for multiple addresses', async () => {
      const addresses = ['Mint1', 'Mint2'];
      mockGet.mockResolvedValueOnce({
        code: 1,
        message: 'OK',
        result: {
          mint1: {
            is_mintable: '0', is_open_source: '1', can_take_back_ownership: '0',
            is_freezable: '0', holder_count: '100', total_supply: '1000000',
            holders: [], lp_holders: [], lp_total_supply: '0',
            creator_address: 'C1', owner_address: 'O1',
          },
          mint2: {
            is_mintable: '1', is_open_source: '0', can_take_back_ownership: '1',
            is_freezable: '0', holder_count: '50', total_supply: '500000',
            holders: [], lp_holders: [], lp_total_supply: '0',
            creator_address: 'C2', owner_address: 'O2',
          },
        },
      });

      const results = await client.getTokenSecurityBatch(addresses);

      expect(results).toBeInstanceOf(Map);
      expect(results.size).toBe(2);

      const mint1Result = results.get('Mint1');
      expect(mint1Result).toBeDefined();
      expect(mint1Result!.isMintable).toBe(false);

      const mint2Result = results.get('Mint2');
      expect(mint2Result).toBeDefined();
      expect(mint2Result!.isMintable).toBe(true);
      expect(mint2Result!.isFreezable).toBe(true);
    });

    it('should return empty map for empty addresses array', async () => {
      const results = await client.getTokenSecurityBatch([]);

      expect(results).toBeInstanceOf(Map);
      expect(results.size).toBe(0);
    });

    it('should apply fail-safe defaults for addresses missing from response', async () => {
      const addresses = ['KnownMint', 'UnknownMint'];
      mockGet.mockResolvedValueOnce({
        code: 1,
        message: 'OK',
        result: {
          knownmint: {
            is_mintable: '0', is_open_source: '1', can_take_back_ownership: '0',
            is_freezable: '0', holder_count: '200', total_supply: '1000000',
            holders: [], lp_holders: [], lp_total_supply: '0',
            creator_address: 'C', owner_address: 'O',
          },
          // UnknownMint is NOT in the result
        },
      });

      const results = await client.getTokenSecurityBatch(addresses);

      // Known address should have parsed data
      const known = results.get('KnownMint');
      expect(known).toBeDefined();
      expect(known!.isMintable).toBe(false);

      // Unknown address should have fail-safe defaults
      const unknown = results.get('UnknownMint');
      expect(unknown).toBeDefined();
      expect(unknown!.isMintable).toBe(true);
      expect(unknown!.isFreezable).toBe(true);
      expect(unknown!.isLpLocked).toBe(false);
      expect(unknown!.top10HolderPercent).toBe(100);
    });

    it('should apply fail-safe defaults for all addresses on batch error', async () => {
      const addresses = ['Addr1', 'Addr2'];
      mockGet.mockRejectedValueOnce(new Error('Batch request failed'));

      const results = await client.getTokenSecurityBatch(addresses);

      for (const addr of addresses) {
        const result = results.get(addr);
        expect(result).toBeDefined();
        expect(result!.isMintable).toBe(true);
        expect(result!.isFreezable).toBe(true);
        expect(result!.top10HolderPercent).toBe(100);
      }
    });

    it('should deduplicate addresses before making the request', async () => {
      const addresses = ['Dup1', 'Dup1', 'Dup2'];
      mockGet.mockResolvedValueOnce({
        code: 1,
        message: 'OK',
        result: {
          dup1: {
            is_mintable: '0', is_open_source: '1', can_take_back_ownership: '0',
            is_freezable: '0', holder_count: '100', total_supply: '1000000',
            holders: [], lp_holders: [], lp_total_supply: '0',
            creator_address: 'C', owner_address: 'O',
          },
          dup2: {
            is_mintable: '0', is_open_source: '1', can_take_back_ownership: '0',
            is_freezable: '0', holder_count: '100', total_supply: '1000000',
            holders: [], lp_holders: [], lp_total_supply: '0',
            creator_address: 'C', owner_address: 'O',
          },
        },
      });

      const results = await client.getTokenSecurityBatch(addresses);

      // Should not crash or duplicate results
      expect(results.size).toBe(2);
    });
  });

  // ===========================================================================
  // Suite 9: Parsed GoPlusHolder and GoPlusLPHolder Types
  // ===========================================================================

  describe('holder type parsing', () => {
    it('should parse topHolders into GoPlusHolder objects', async () => {
      const holders = [
        { address: 'Wallet1', balance: '50000', percent: '0.05', is_contract: 1, tag: 'DEX Pool' },
        { address: 'Wallet2', balance: '30000', percent: '0.03', is_contract: 0, tag: '' },
      ];

      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { holders }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.topHolders).toHaveLength(2);

      // First holder
      expect(result.topHolders[0].address).toBe('Wallet1');
      expect(result.topHolders[0].balance).toBe('50000');
      expect(result.topHolders[0].percent).toBe('0.05');
      expect(result.topHolders[0].isContract).toBe(true);
      expect(result.topHolders[0].tag).toBe('DEX Pool');

      // Second holder
      expect(result.topHolders[1].address).toBe('Wallet2');
      expect(result.topHolders[1].isContract).toBe(false);
    });

    it('should parse holderCount from string to number', async () => {
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { holder_count: '1234' }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.holderCount).toBe(1234);
      expect(typeof result.holderCount).toBe('number');
    });

    it('should preserve creator and owner addresses', async () => {
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, {
          creator_address: 'CreatorWallet123',
          owner_address: 'OwnerWallet456',
        }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.creatorAddress).toBe('CreatorWallet123');
      expect(result.ownerAddress).toBe('OwnerWallet456');
    });

    it('should preserve totalSupply as string', async () => {
      mockGet.mockResolvedValueOnce(
        createRawGoPlusResponse(TEST_MINT, { total_supply: '999999999999' }),
      );

      const result = await client.getTokenSecurity(TEST_MINT);

      expect(result.totalSupply).toBe('999999999999');
    });
  });

  // ===========================================================================
  // Suite 10: Complete Integration Scenario
  // ===========================================================================

  describe('complete integration scenario', () => {
    it('should correctly parse a fully populated safe token response', async () => {
      const safeTokenResponse = createRawGoPlusResponse(TEST_MINT, {
        is_mintable: '0',
        is_open_source: '1',
        can_take_back_ownership: '0',
        is_freezable: '0',
        holder_count: '5000',
        total_supply: '1000000000',
        holders: [
          { address: 'H1', balance: '50000', percent: '0.03', is_contract: 0, tag: '' },
          { address: 'H2', balance: '40000', percent: '0.02', is_contract: 0, tag: '' },
          { address: 'H3', balance: '30000', percent: '0.015', is_contract: 0, tag: '' },
        ],
        lp_holders: [
          { address: '1nc1nerator11111111111111111111111111111111', balance: '98000', percent: '0.98', is_locked: 0, tag: 'burn' },
        ],
        lp_total_supply: '100000',
        creator_address: 'SafeCreator',
        owner_address: 'SafeOwner',
      });

      mockGet.mockResolvedValueOnce(safeTokenResponse);

      const result = await client.getTokenSecurity(TEST_MINT);

      // Security flags
      expect(result.isMintable).toBe(false);
      expect(result.isFreezable).toBe(false);
      expect(result.isOpenSource).toBe(true);

      // Holder concentration: 3% + 2% + 1.5% = 6.5%
      expect(result.top10HolderPercent).toBe(6.5);
      expect(result.largestHolderPercent).toBe(3);

      // LP is burned (burn address holds LP tokens)
      expect(result.isLpLocked).toBe(true);

      // Metadata
      expect(result.tokenAddress).toBe(TEST_MINT);
      expect(result.holderCount).toBe(5000);
      expect(result.creatorAddress).toBe('SafeCreator');
      expect(result.ownerAddress).toBe('SafeOwner');
    });

    it('should correctly parse a fully populated risky token response', async () => {
      const riskyTokenResponse = createRawGoPlusResponse(TEST_MINT, {
        is_mintable: '1',
        is_open_source: '0',
        can_take_back_ownership: '1',
        is_freezable: '1',
        holder_count: '50',
        total_supply: '1000000000',
        holders: [
          { address: 'Whale', balance: '600000000', percent: '0.60', is_contract: 0, tag: '' },
        ],
        lp_holders: [
          { address: 'RandomAddr', balance: '100000', percent: '1.0', is_locked: 0, tag: '' },
        ],
        lp_total_supply: '100000',
        creator_address: 'ShadyCreator',
        owner_address: 'ShadyOwner',
      });

      mockGet.mockResolvedValueOnce(riskyTokenResponse);

      const result = await client.getTokenSecurity(TEST_MINT);

      // All security flags are risky
      expect(result.isMintable).toBe(true);
      expect(result.isFreezable).toBe(true);
      expect(result.isOpenSource).toBe(false);

      // Dangerous concentration: single whale at 60%
      expect(result.largestHolderPercent).toBe(60);
      expect(result.top10HolderPercent).toBe(60);

      // LP not locked or burned
      expect(result.isLpLocked).toBe(false);
    });
  });
});
