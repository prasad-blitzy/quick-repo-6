/**
 * tests/unit/api/jupiter.test.ts — Jupiter API Client Unit Tests
 *
 * Comprehensive unit tests for the JupiterClient class covering:
 * - Price API response parsing (getPrice, getPrices)
 * - Quote API response parsing (getQuote)
 * - Honeypot detection via sell simulation (simulateSell) — CRITICAL
 * - SOL mint address correctness (So11111111111111111111111111111111111111112)
 * - ExactIn swap mode enforcement for sell simulation
 * - 1 RPS rate limit enforcement via rate-limiter
 * - No authentication requirement (Jupiter is free)
 * - Error handling for rate limits, timeouts, and no-route scenarios
 */

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
   * Both the test file and the module under test (jupiter.ts) will
   * reference this same class through the mocked base-client module,
   * so instanceof checks work correctly.
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
      (endpoint: string, _params?: Record<string, string>) =>
        `https://mock${endpoint}`,
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
 * Mock BaseClient — JupiterClient creates two instances (priceClient, quoteClient).
 * Both instances share the same mockGet/mockBuildUrl for simplicity since tests
 * exercise one method at a time and mocks are reset between tests.
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
 * Tests verify that acquire() is called with 'jupiter' provider name before
 * every API request per AAP Section 0.7.4 (1 RPS rate limit).
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
 * Mock config — provides API base URLs, rate limits, and SOL mint address.
 * RATE_LIMITS.JUPITER is referenced by the constructor's log message.
 */
vi.mock('@/utils/config', () => ({
  API_BASE_URLS: {
    JUPITER_PRICE: 'https://price.jup.ag',
    JUPITER_QUOTE: 'https://quote-api.jup.ag',
  },
  RATE_LIMITS: {
    JUPITER: { requestsPerSecond: 1, burstSize: 1 },
  },
  SOLANA: {
    SOL_MINT: 'So11111111111111111111111111111111111111112',
  },
}));

/**
 * Mock logger — returns a no-op logger to prevent console output during tests.
 * JupiterClient calls createLogger('jupiter-api') during construction.
 */
vi.mock('@/utils/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

// ============================================================
// Imports — resolved AFTER module mocking is applied
// ============================================================
import { JupiterClient } from '@/api/jupiter';
import type { JupiterPrice, JupiterQuote } from '@/api/types';
import { BaseClient } from '@/api/base-client';

// ============================================================
// Test Constants
// ============================================================
const TEST_MINT = 'TestMint111111111111111111111111111111111111';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const UNKNOWN_MINT = 'UnknownMint1111111111111111111111111111111';
const SECOND_MINT = 'SecondMint11111111111111111111111111111111';

// ============================================================
// Mock Data Factories
// ============================================================

/**
 * Creates a mock JupiterPrice object with sensible defaults.
 * Matches the JupiterPrice interface: { id, mintSymbol, vsToken, vsTokenSymbol, price, timeTaken? }
 */
function createMockJupiterPrice(
  overrides?: Partial<JupiterPrice>,
): JupiterPrice {
  return {
    id: TEST_MINT,
    mintSymbol: 'TEST',
    vsToken: SOL_MINT,
    vsTokenSymbol: 'SOL',
    price: 0.00001234,
    timeTaken: 50,
    ...overrides,
  };
}

/**
 * Creates a mock JupiterQuote object with a single Raydium route.
 * Matches the JupiterQuote interface with routePlan containing JupiterRoutePlan entries.
 * swapMode defaults to 'ExactIn' per AAP requirements.
 */
function createMockJupiterQuote(
  overrides?: Partial<JupiterQuote>,
): JupiterQuote {
  return {
    inputMint: TEST_MINT,
    inAmount: '100000000',
    outputMint: SOL_MINT,
    outAmount: '95000000',
    otherAmountThreshold: '90000000',
    swapMode: 'ExactIn',
    slippageBps: 500,
    priceImpactPct: '2.5',
    routePlan: [
      {
        swapInfo: {
          ammKey: 'RaydiumAMMKey11111111111111111111111111111',
          label: 'Raydium',
          inputMint: TEST_MINT,
          outputMint: SOL_MINT,
          inAmount: '100000000',
          outAmount: '95000000',
          feeAmount: '500000',
          feeMint: SOL_MINT,
        },
        percent: 100,
      },
    ],
    contextSlot: 123456789,
    timeTaken: 150,
    ...overrides,
  };
}

/**
 * Creates a mock Jupiter Price API response envelope.
 * The Price API wraps token data in { data: { [mint]: priceData }, timeTaken? }.
 * JupiterClient.getPrice() extracts the inner data by mint address.
 */
function createMockPriceApiResponse(
  mint: string,
  price: JupiterPrice,
): { data: Record<string, unknown>; timeTaken?: number } {
  return {
    data: {
      [mint]: {
        id: price.id,
        mintSymbol: price.mintSymbol,
        vsToken: price.vsToken,
        vsTokenSymbol: price.vsTokenSymbol,
        price: price.price,
      },
    },
    timeTaken: price.timeTaken,
  };
}

// ============================================================
// Test Suite
// ============================================================

describe('JupiterClient', () => {
  let client: JupiterClient;

  beforeEach(() => {
    // Create a fresh JupiterClient for each test.
    // This triggers: new BaseClient() x2, new RateLimiter() x1, createLogger() x1
    client = new JupiterClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────
  // Phase 3: Price API Response Parsing — getPrice
  // ─────────────────────────────────────────────────────────
  describe('getPrice', () => {
    it('should parse Jupiter price response correctly', async () => {
      const mockPrice = createMockJupiterPrice();
      mockGet.mockResolvedValueOnce(
        createMockPriceApiResponse(TEST_MINT, mockPrice),
      );

      const result = await client.getPrice(TEST_MINT);

      expect(result).not.toBeNull();
      expect(result!.price).toBe(0.00001234);
      expect(result!.id).toBe(TEST_MINT);
      expect(result!.mintSymbol).toBe('TEST');
      expect(result!.vsToken).toBe(SOL_MINT);
      expect(result!.vsTokenSymbol).toBe('SOL');
    });

    it('should call the correct price endpoint', async () => {
      const mockPrice = createMockJupiterPrice();
      mockGet.mockResolvedValueOnce(
        createMockPriceApiResponse(TEST_MINT, mockPrice),
      );

      await client.getPrice(TEST_MINT);

      expect(mockGet).toHaveBeenCalledTimes(1);
      const calledEndpoint = mockGet.mock.calls[0][0] as string;
      expect(calledEndpoint).toContain('/price/v3/');
      expect(calledEndpoint).toContain(
        `ids=${encodeURIComponent(TEST_MINT)}`,
      );
    });

    it('should handle unknown token (no price data)', async () => {
      // Jupiter returns { data: {} } when token is not found
      mockGet.mockResolvedValueOnce({ data: {} });

      const result = await client.getPrice(UNKNOWN_MINT);

      expect(result).toBeNull();
    });

    it('should parse price as a number type', async () => {
      const mockPrice = createMockJupiterPrice({ price: 0.005 });
      mockGet.mockResolvedValueOnce(
        createMockPriceApiResponse(TEST_MINT, mockPrice),
      );

      const result = await client.getPrice(TEST_MINT);

      expect(result).not.toBeNull();
      expect(typeof result!.price).toBe('number');
      expect(result!.price).toBe(0.005);
    });

    it('should handle string price values from Jupiter API', async () => {
      // Jupiter API sometimes returns price as a string
      mockGet.mockResolvedValueOnce({
        data: {
          [TEST_MINT]: {
            id: TEST_MINT,
            mintSymbol: 'TEST',
            vsToken: SOL_MINT,
            vsTokenSymbol: 'SOL',
            price: '0.00001234',
          },
        },
        timeTaken: 50,
      });

      const result = await client.getPrice(TEST_MINT);

      expect(result).not.toBeNull();
      expect(typeof result!.price).toBe('number');
      expect(result!.price).toBeCloseTo(0.00001234);
    });

    it('should return null for NaN price values', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          [TEST_MINT]: {
            id: TEST_MINT,
            mintSymbol: 'TEST',
            vsToken: SOL_MINT,
            vsTokenSymbol: 'SOL',
            price: 'not-a-number',
          },
        },
      });

      const result = await client.getPrice(TEST_MINT);

      expect(result).toBeNull();
    });

    it('should return null when API throws an error', async () => {
      mockGet.mockRejectedValueOnce(new Error('Network error'));

      const result = await client.getPrice(TEST_MINT);

      // getPrice handles errors gracefully by returning null
      expect(result).toBeNull();
    });

    it('should return null when response data entry is null', async () => {
      mockGet.mockResolvedValueOnce({
        data: { [TEST_MINT]: null },
      });

      const result = await client.getPrice(TEST_MINT);

      expect(result).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────
  // Batch Price Tests — getPrices
  // ─────────────────────────────────────────────────────────
  describe('getPrices', () => {
    it('should return prices for multiple tokens', async () => {
      const price1 = createMockJupiterPrice();
      const price2 = createMockJupiterPrice({
        id: SECOND_MINT,
        mintSymbol: 'SEC',
        price: 0.005,
      });

      mockGet.mockResolvedValueOnce({
        data: {
          [TEST_MINT]: {
            id: price1.id,
            mintSymbol: price1.mintSymbol,
            vsToken: price1.vsToken,
            vsTokenSymbol: price1.vsTokenSymbol,
            price: price1.price,
          },
          [SECOND_MINT]: {
            id: price2.id,
            mintSymbol: price2.mintSymbol,
            vsToken: price2.vsToken,
            vsTokenSymbol: price2.vsTokenSymbol,
            price: price2.price,
          },
        },
        timeTaken: 60,
      });

      const result = await client.getPrices([TEST_MINT, SECOND_MINT]);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(2);
      expect(result.get(TEST_MINT)!.price).toBe(0.00001234);
      expect(result.get(SECOND_MINT)!.price).toBe(0.005);
    });

    it('should return empty map for empty input', async () => {
      const result = await client.getPrices([]);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it('should skip tokens with no price data in batch response', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          [TEST_MINT]: {
            id: TEST_MINT,
            mintSymbol: 'TEST',
            vsToken: SOL_MINT,
            vsTokenSymbol: 'SOL',
            price: 0.001,
          },
          [UNKNOWN_MINT]: null,
        },
        timeTaken: 60,
      });

      const result = await client.getPrices([TEST_MINT, UNKNOWN_MINT]);

      expect(result.has(TEST_MINT)).toBe(true);
      expect(result.has(UNKNOWN_MINT)).toBe(false);
    });

    it('should return empty map when API throws an error', async () => {
      mockGet.mockRejectedValueOnce(new Error('Server down'));

      const result = await client.getPrices([TEST_MINT]);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Phase 4: Quote API Response Parsing — getQuote
  // ─────────────────────────────────────────────────────────
  describe('getQuote', () => {
    it('should parse Jupiter quote response correctly', async () => {
      const mockQuote = createMockJupiterQuote();
      mockGet.mockResolvedValueOnce(mockQuote);

      const result = await client.getQuote(TEST_MINT, SOL_MINT, 100000000);

      expect(result.inputMint).toBe(TEST_MINT);
      expect(result.outputMint).toBe(SOL_MINT);
      expect(result.inAmount).toBe('100000000');
      expect(result.outAmount).toBe('95000000');
      expect(result.swapMode).toBe('ExactIn');
    });

    it('should call the correct quote endpoint with all parameters', async () => {
      const mockQuote = createMockJupiterQuote();
      mockGet.mockResolvedValueOnce(mockQuote);

      await client.getQuote(TEST_MINT, SOL_MINT, 100000000, 'ExactIn');

      expect(mockGet).toHaveBeenCalledTimes(1);
      const calledEndpoint = mockGet.mock.calls[0][0] as string;
      expect(calledEndpoint).toContain('/v6/quote');
      expect(calledEndpoint).toContain(`inputMint=${TEST_MINT}`);
      expect(calledEndpoint).toContain(`outputMint=${SOL_MINT}`);
      expect(calledEndpoint).toContain('amount=100000000');
      expect(calledEndpoint).toContain('swapMode=ExactIn');
    });

    it('should parse routePlan with DEX labels', async () => {
      const multiRouteQuote = createMockJupiterQuote({
        routePlan: [
          {
            swapInfo: {
              ammKey: 'RaydiumKey111111111111111111111111111111',
              label: 'Raydium',
              inputMint: TEST_MINT,
              outputMint: 'IntermediateMint1111111111111111111111',
              inAmount: '60000000',
              outAmount: '55000000',
              feeAmount: '300000',
              feeMint: 'IntermediateMint1111111111111111111111',
            },
            percent: 60,
          },
          {
            swapInfo: {
              ammKey: 'OrcaKey111111111111111111111111111111111',
              label: 'Orca',
              inputMint: TEST_MINT,
              outputMint: SOL_MINT,
              inAmount: '40000000',
              outAmount: '40000000',
              feeAmount: '200000',
              feeMint: SOL_MINT,
            },
            percent: 40,
          },
        ],
      });
      mockGet.mockResolvedValueOnce(multiRouteQuote);

      const result = await client.getQuote(TEST_MINT, SOL_MINT, 100000000);

      expect(result.routePlan).toBeInstanceOf(Array);
      expect(result.routePlan).toHaveLength(2);
      expect(result.routePlan[0].swapInfo.label).toBe('Raydium');
      expect(result.routePlan[0].percent).toBe(60);
      expect(result.routePlan[1].swapInfo.label).toBe('Orca');
      expect(result.routePlan[1].percent).toBe(40);
    });

    it('should parse priceImpactPct as string', async () => {
      const mockQuote = createMockJupiterQuote({ priceImpactPct: '3.14' });
      mockGet.mockResolvedValueOnce(mockQuote);

      const result = await client.getQuote(TEST_MINT, SOL_MINT, 100000000);

      expect(result.priceImpactPct).toBe('3.14');
      expect(typeof result.priceImpactPct).toBe('string');
    });

    it('should handle "no route found" response gracefully', async () => {
      mockGet.mockRejectedValueOnce(
        new MockApiError(
          'Could not find any route',
          400,
          'not-found',
          false,
        ),
      );

      // getQuote THROWS errors (unlike getPrice which returns null)
      await expect(
        client.getQuote(TEST_MINT, SOL_MINT, 100000000),
      ).rejects.toThrow();
    });

    it('should throw on invalid quote response missing required fields', async () => {
      // Response missing outputMint and routePlan
      mockGet.mockResolvedValueOnce({
        inputMint: TEST_MINT,
        outputMint: undefined,
        routePlan: undefined,
      });

      await expect(
        client.getQuote(TEST_MINT, SOL_MINT, 100000000),
      ).rejects.toThrow();
    });

    it('should floor the amount to an integer', async () => {
      const mockQuote = createMockJupiterQuote();
      mockGet.mockResolvedValueOnce(mockQuote);

      await client.getQuote(TEST_MINT, SOL_MINT, 1234567.89);

      const calledEndpoint = mockGet.mock.calls[0][0] as string;
      expect(calledEndpoint).toContain('amount=1234567');
    });
  });

  // ─────────────────────────────────────────────────────────
  // Phase 5: Sell Simulation — Honeypot Detection (CRITICAL)
  // ─────────────────────────────────────────────────────────
  describe('simulateSell — honeypot detection', () => {
    it('should return sellable: true when Jupiter returns a valid quote', async () => {
      const mockQuote = createMockJupiterQuote({
        outAmount: '95000000',
        priceImpactPct: '2.5',
      });
      mockGet.mockResolvedValueOnce(mockQuote);

      const result = await client.simulateSell(TEST_MINT);

      expect(result.sellable).toBe(true);
      expect(result.quote).not.toBeNull();
      expect(result.quote!.inputMint).toBe(TEST_MINT);
      expect(result.quote!.outputMint).toBe(SOL_MINT);
      expect(result.quote!.outAmount).toBe('95000000');
    });

    it('should return sellable: false when Jupiter quote fails', async () => {
      mockGet.mockRejectedValueOnce(
        new MockApiError('No route found', 0, 'not-found', false),
      );

      const result = await client.simulateSell(TEST_MINT);

      expect(result.sellable).toBe(false);
      expect(result.quote).toBeNull();
      expect(result.priceImpact).toBe(100);
    });

    it('should return sellable: false on timeout', async () => {
      // Per AAP: timeout means potential honeypot — fail-safe behavior
      mockGet.mockRejectedValueOnce(
        new MockApiError('Request timeout', 0, 'timeout', true),
      );

      const result = await client.simulateSell(TEST_MINT);

      expect(result.sellable).toBe(false);
      expect(result.quote).toBeNull();
    });

    it('should capture priceImpact from the quote', async () => {
      const mockQuote = createMockJupiterQuote({ priceImpactPct: '12.5' });
      mockGet.mockResolvedValueOnce(mockQuote);

      const result = await client.simulateSell(TEST_MINT);

      // priceImpact is parsed from string to number via parseFloat + Math.abs
      expect(result.priceImpact).toBe(12.5);
    });

    it('should accept custom test amount', async () => {
      const mockQuote = createMockJupiterQuote();
      mockGet.mockResolvedValueOnce(mockQuote);

      await client.simulateSell(TEST_MINT, 500000000);

      const calledEndpoint = mockGet.mock.calls[0][0] as string;
      expect(calledEndpoint).toContain('amount=500000000');
    });

    it('should use default test amount when none specified', async () => {
      const mockQuote = createMockJupiterQuote();
      mockGet.mockResolvedValueOnce(mockQuote);

      await client.simulateSell(TEST_MINT);

      const calledEndpoint = mockGet.mock.calls[0][0] as string;
      // DEFAULT_SELL_TEST_AMOUNT = 1_000_000 in jupiter.ts
      expect(calledEndpoint).toContain('amount=1000000');
    });

    it('should return sellable: false when generic error occurs', async () => {
      mockGet.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await client.simulateSell(TEST_MINT);

      expect(result.sellable).toBe(false);
      expect(result.quote).toBeNull();
      expect(result.priceImpact).toBe(100);
    });

    it('should handle negative priceImpactPct with Math.abs', async () => {
      const mockQuote = createMockJupiterQuote({ priceImpactPct: '-5.75' });
      mockGet.mockResolvedValueOnce(mockQuote);

      const result = await client.simulateSell(TEST_MINT);

      expect(result.sellable).toBe(true);
      expect(result.priceImpact).toBe(5.75);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Phase 6: SOL Mint Address (CRITICAL)
  // ─────────────────────────────────────────────────────────
  describe('SOL mint address', () => {
    it('should use correct SOL mint address for sell simulation', async () => {
      const mockQuote = createMockJupiterQuote();
      mockGet.mockResolvedValueOnce(mockQuote);

      await client.simulateSell(TEST_MINT);

      const calledEndpoint = mockGet.mock.calls[0][0] as string;
      // THE canonical Solana native SOL wrapped mint address
      expect(calledEndpoint).toContain(
        `outputMint=${SOL_MINT}`,
      );
    });

    it('should use SOL mint as outputMint (selling TOKEN → SOL)', async () => {
      const mockQuote = createMockJupiterQuote();
      mockGet.mockResolvedValueOnce(mockQuote);

      await client.simulateSell(TEST_MINT);

      const calledEndpoint = mockGet.mock.calls[0][0] as string;
      // TOKEN is the input (being sold)
      expect(calledEndpoint).toContain(`inputMint=${TEST_MINT}`);
      // SOL is the output (being received)
      expect(calledEndpoint).toContain(
        `outputMint=So11111111111111111111111111111111111111112`,
      );
      // Direction must NOT be reversed (not SOL → TOKEN)
      expect(calledEndpoint).not.toContain(
        `inputMint=So11111111111111111111111111111111111111112`,
      );
      expect(calledEndpoint).not.toContain(
        `outputMint=${TEST_MINT}`,
      );
    });
  });

  // ─────────────────────────────────────────────────────────
  // Phase 7: ExactIn Swap Mode (CRITICAL)
  // ─────────────────────────────────────────────────────────
  describe('ExactIn swap mode', () => {
    it('should use ExactIn mode for sell simulation', async () => {
      const mockQuote = createMockJupiterQuote();
      mockGet.mockResolvedValueOnce(mockQuote);

      await client.simulateSell(TEST_MINT);

      const calledEndpoint = mockGet.mock.calls[0][0] as string;
      expect(calledEndpoint).toContain('swapMode=ExactIn');
    });

    it('should default to ExactIn when no swapMode specified in getQuote', async () => {
      const mockQuote = createMockJupiterQuote();
      mockGet.mockResolvedValueOnce(mockQuote);

      // Call getQuote WITHOUT explicit swapMode (4th parameter omitted)
      await client.getQuote(TEST_MINT, SOL_MINT, 1000);

      const calledEndpoint = mockGet.mock.calls[0][0] as string;
      expect(calledEndpoint).toContain('swapMode=ExactIn');
    });

    it('should allow ExactOut when explicitly specified', async () => {
      const mockQuote = createMockJupiterQuote({ swapMode: 'ExactOut' });
      mockGet.mockResolvedValueOnce(mockQuote);

      await client.getQuote(TEST_MINT, SOL_MINT, 1000, 'ExactOut');

      const calledEndpoint = mockGet.mock.calls[0][0] as string;
      expect(calledEndpoint).toContain('swapMode=ExactOut');
    });
  });

  // ─────────────────────────────────────────────────────────
  // Phase 8: 1 RPS Rate Limit (CRITICAL)
  // ─────────────────────────────────────────────────────────
  describe('rate limiting — 1 RPS', () => {
    it('should call rate limiter with "jupiter" provider before getPrice', async () => {
      const mockPrice = createMockJupiterPrice();
      mockGet.mockResolvedValueOnce(
        createMockPriceApiResponse(TEST_MINT, mockPrice),
      );

      await client.getPrice(TEST_MINT);

      expect(mockAcquire).toHaveBeenCalledWith(
        'jupiter',
        expect.any(String),
      );
    });

    it('should call rate limiter before getQuote requests', async () => {
      const mockQuote = createMockJupiterQuote();
      mockGet.mockResolvedValueOnce(mockQuote);

      await client.getQuote(TEST_MINT, SOL_MINT, 1000);

      expect(mockAcquire).toHaveBeenCalledWith(
        'jupiter',
        expect.any(String),
      );
    });

    it('should call rate limiter before simulateSell requests', async () => {
      const mockQuote = createMockJupiterQuote();
      mockGet.mockResolvedValueOnce(mockQuote);

      await client.simulateSell(TEST_MINT);

      // simulateSell internally calls getQuote, which calls rateLimiter.acquire
      expect(mockAcquire).toHaveBeenCalledWith(
        'jupiter',
        expect.any(String),
      );
    });

    it('should wait for rate limiter token before making request', async () => {
      // Track call order to verify acquire happens BEFORE get
      const callOrder: string[] = [];
      mockAcquire.mockImplementation(() => {
        callOrder.push('acquire');
        return Promise.resolve(undefined);
      });
      const mockPrice = createMockJupiterPrice();
      mockGet.mockImplementation(() => {
        callOrder.push('get');
        return Promise.resolve(
          createMockPriceApiResponse(TEST_MINT, mockPrice),
        );
      });

      await client.getPrice(TEST_MINT);

      // acquire MUST be called before get — enforces the 1 RPS gate
      expect(callOrder[0]).toBe('acquire');
      expect(callOrder[1]).toBe('get');
    });

    it('should propagate rate limiter rejection for getPrice', async () => {
      mockAcquire.mockRejectedValueOnce(
        new Error('Rate limit queue timeout'),
      );

      // getPrice catches errors and returns null
      const result = await client.getPrice(TEST_MINT);

      expect(result).toBeNull();
    });

    it('should call rate limiter before getPrices batch request', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          [TEST_MINT]: {
            id: TEST_MINT,
            mintSymbol: 'TEST',
            vsToken: SOL_MINT,
            vsTokenSymbol: 'SOL',
            price: 0.001,
          },
        },
        timeTaken: 50,
      });

      await client.getPrices([TEST_MINT]);

      expect(mockAcquire).toHaveBeenCalledWith(
        'jupiter',
        expect.any(String),
      );
    });
  });

  // ─────────────────────────────────────────────────────────
  // Phase 9: No Authentication
  // ─────────────────────────────────────────────────────────
  describe('no authentication', () => {
    it('should NOT include any authentication headers in BaseClient construction', () => {
      // Verify BaseClient was constructed WITHOUT defaultHeaders containing auth keys
      const constructorCalls = vi.mocked(BaseClient).mock.calls;
      expect(constructorCalls.length).toBeGreaterThan(0);

      for (const call of constructorCalls) {
        const options = call[1] as
          | Record<string, unknown>
          | undefined;
        // The options object should not have defaultHeaders with auth keys
        if (options && 'defaultHeaders' in options) {
          const headers = options.defaultHeaders as Record<
            string,
            string
          >;
          expect(headers).not.toHaveProperty('X-API-KEY');
          expect(headers).not.toHaveProperty('Authorization');
          expect(headers).not.toHaveProperty('x-api-key');
        }
      }
    });

    it('should NOT require API key in constructor', () => {
      // JupiterClient constructor takes zero required arguments
      const newClient = new JupiterClient();
      expect(newClient).toBeInstanceOf(JupiterClient);
    });

    it('should NOT pass auth-related request options to get()', async () => {
      const mockPrice = createMockJupiterPrice();
      mockGet.mockResolvedValueOnce(
        createMockPriceApiResponse(TEST_MINT, mockPrice),
      );

      await client.getPrice(TEST_MINT);

      expect(mockGet).toHaveBeenCalledTimes(1);
      const requestOptions = mockGet.mock.calls[0][1] as
        | Record<string, unknown>
        | undefined;
      // No headers property in request options
      expect(requestOptions).not.toHaveProperty('headers');
    });
  });

  // ─────────────────────────────────────────────────────────
  // Phase 10: Error Handling
  // ─────────────────────────────────────────────────────────
  describe('error handling', () => {
    it('should handle rate limit (429) gracefully for getPrice', async () => {
      mockGet.mockRejectedValueOnce(
        new MockApiError('Too Many Requests', 429, 'rate-limited', true),
      );

      // getPrice catches all errors and returns null
      const result = await client.getPrice(TEST_MINT);

      expect(result).toBeNull();
    });

    it('should propagate rate limit error from getQuote', async () => {
      mockGet.mockRejectedValueOnce(
        new MockApiError('Too Many Requests', 429, 'rate-limited', true),
      );

      // getQuote throws ApiErrors directly (does not catch them)
      await expect(
        client.getQuote(TEST_MINT, SOL_MINT, 1000),
      ).rejects.toThrow();
    });

    it('should handle server errors (5xx) gracefully for getPrice', async () => {
      mockGet.mockRejectedValueOnce(
        new MockApiError(
          'Internal Server Error',
          500,
          'server-error',
          true,
        ),
      );

      const result = await client.getPrice(TEST_MINT);

      expect(result).toBeNull();
    });

    it('should handle "no route found" without crashing for simulateSell', async () => {
      mockGet.mockRejectedValueOnce(
        new MockApiError(
          'Could not find any route',
          400,
          'unknown',
          false,
          { error: 'Could not find any route' },
        ),
      );

      const result = await client.simulateSell(TEST_MINT);

      expect(result.sellable).toBe(false);
      expect(result.quote).toBeNull();
      expect(result.priceImpact).toBe(100);
    });

    it('should handle timeout errors for getPrice', async () => {
      mockGet.mockRejectedValueOnce(
        new MockApiError('Request timeout', 0, 'timeout', true),
      );

      const result = await client.getPrice(TEST_MINT);

      expect(result).toBeNull();
    });

    it('should handle generic JavaScript errors for getPrice', async () => {
      mockGet.mockRejectedValueOnce(
        new TypeError('Failed to fetch'),
      );

      const result = await client.getPrice(TEST_MINT);

      expect(result).toBeNull();
    });

    it('should handle rate-limited error in simulateSell', async () => {
      mockGet.mockRejectedValueOnce(
        new MockApiError('Rate limited', 429, 'rate-limited', true),
      );

      const result = await client.simulateSell(TEST_MINT);

      expect(result.sellable).toBe(false);
      expect(result.priceImpact).toBe(100);
    });

    it('should handle server error in simulateSell', async () => {
      mockGet.mockRejectedValueOnce(
        new MockApiError(
          'Server Error',
          500,
          'server-error',
          true,
        ),
      );

      const result = await client.simulateSell(TEST_MINT);

      expect(result.sellable).toBe(false);
    });

    it('should handle network errors in getPrices', async () => {
      mockGet.mockRejectedValueOnce(
        new MockApiError(
          'Network error',
          0,
          'network-error',
          true,
        ),
      );

      const result = await client.getPrices([TEST_MINT]);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });
});
