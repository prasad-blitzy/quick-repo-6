/**
 * tests/unit/api/rugcheck.test.ts — RugCheck REST Client Unit Tests
 *
 * Comprehensive test suite for the RugCheckClient class (src/api/rugcheck.ts).
 * Validates:
 *   - Token report parsing: score, risks, authorities, LP status, Token-2022 detection
 *   - Insider graph parsing: nodes, edges, bundle detection, sniper supply
 *   - Wallet risk rating parsing: risk score, rug rate, scammer flag
 *   - X-API-KEY authentication header inclusion in every request
 *   - 404 handling for unindexed tokens (returns null, logs warning, no crash)
 *   - Error handling: 401/403, 429, 5xx, timeout, network errors
 *   - Rate limiter integration: acquire() called before every request
 *   - Fail-safe defaults: all failures return null per worst-case-wins policy
 *
 * All external dependencies (BaseClient, RateLimiter, Logger, Config) are mocked
 * to ensure zero real HTTP calls and deterministic test behavior.
 *
 * @module tests/unit/api/rugcheck
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  RugCheckReport,
  RugCheckRisk,
  RugCheckHolder,
  RugCheckMarket,
} from '../../../src/api/types';

// =============================================================================
// Hoisted mock variables — available to vi.mock() factories
// =============================================================================

const { mockGet, mockBuildUrl, mockAcquire, mockLogger, MockBaseClientConstructor, MockRateLimiterConstructor } = vi.hoisted(() => {
  const mockGet = vi.fn();
  const mockBuildUrl = vi.fn((endpoint: string) => `https://api.rugcheck.xyz${endpoint}`);
  const mockAcquire = vi.fn().mockResolvedValue(undefined);
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  // Must be a regular function (not arrow) so it works with `new`
  const MockBaseClientConstructor = vi.fn(function (this: Record<string, unknown>) {
    this.get = mockGet;
    this.buildUrl = mockBuildUrl;
    this.post = vi.fn();
    this.request = vi.fn();
    this.requestWithRetry = vi.fn();
  });

  const MockRateLimiterConstructor = vi.fn(function (this: Record<string, unknown>) {
    this.acquire = mockAcquire;
    this.getStatus = vi.fn();
    this.destroy = vi.fn();
  });

  return { mockGet, mockBuildUrl, mockAcquire, mockLogger, MockBaseClientConstructor, MockRateLimiterConstructor };
});

// =============================================================================
// Module Mocks
// =============================================================================

vi.mock('../../../src/utils/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
}));

vi.mock('../../../src/utils/config', () => ({
  API_BASE_URLS: {
    RUGCHECK: 'https://api.rugcheck.xyz',
    BIRDEYE: 'https://public-api.birdeye.so',
    GOPLUS: 'https://api.gopluslabs.io',
    JUPITER_PRICE: 'https://price.jup.ag',
    JUPITER_QUOTE: 'https://quote-api.jup.ag',
    HELIUS: 'https://api.helius.xyz',
    DEXSCREENER: 'https://api.dexscreener.com',
    GROQ: 'https://api.groq.com',
    ANTHROPIC: 'https://api.anthropic.com',
  },
  RATE_LIMITS: {
    BIRDEYE: { requestsPerSecond: 15, burstSize: 15 },
    JUPITER: { requestsPerSecond: 1, burstSize: 1 },
    DEXSCREENER: { requestsPerSecond: 5, burstSize: 10 },
    HELIUS: { requestsPerSecond: 10, burstSize: 10 },
    RUGCHECK: { requestsPerSecond: 5, burstSize: 5 },
    GOPLUS: { requestsPerSecond: 5, burstSize: 5 },
    GROQ: { requestsPerSecond: 2, burstSize: 5 },
    GMGN_TRADING: { requestsPerSecond: 0.2, burstSize: 1 },
  },
  TIMING: {
    API_DEFAULT_TIMEOUT_MS: 10_000,
    RECONNECT_BACKOFF_BASE_MS: 1000,
  },
}));

vi.mock('../../../src/api/base-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/api/base-client')>();
  return {
    ...actual,
    BaseClient: MockBaseClientConstructor,
  };
});

vi.mock('../../../src/api/rate-limiter', () => ({
  RateLimiter: MockRateLimiterConstructor,
}));

vi.mock('../../../src/utils/cache', () => ({
  cache: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
  },
}));

// Import module under test AFTER all mocks are registered
import { RugCheckClient } from '../../../src/api/rugcheck';
import { ApiError } from '../../../src/api/base-client';
import type { ApiErrorType } from '../../../src/api/base-client';

// =============================================================================
// Constants
// =============================================================================

const TEST_MINT = 'TestMint111111111111111111111111111111111111';
const TEST_API_KEY = 'test-rugcheck-api-key';
const TEST_WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

// =============================================================================
// Mock Data Factories
// =============================================================================

/**
 * Creates a mock RugCheck API raw response for a safe token report.
 * Score ≥300 indicates a safe token per AAP safety threshold.
 */
function createMockTokenReportResponse(
  overrides?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    mint: TEST_MINT,
    score: 500,
    risks: [],
    mintAuthority: null,
    freezeAuthority: null,
    isMintable: false,
    isFreezable: false,
    topHolders: [
      {
        address: 'Holder1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        amount: 50000000,
        percentage: 5,
        isInsider: false,
      },
      {
        address: 'Holder2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        amount: 30000000,
        percentage: 3,
        isInsider: false,
      },
    ],
    lpLocked: true,
    lpBurned: true,
    lpBurnPercentage: 95,
    isToken2022: false,
    markets: [
      {
        marketId: 'Market1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        marketType: 'raydium',
        liquidityA: 25000,
        liquidityB: 25000,
        liquidityAToken: 'So11111111111111111111111111111111111111112',
        liquidityBToken: TEST_MINT,
      },
    ],
    totalMarketLiquidity: 50000,
    createdAt: '2026-03-13T12:00:00.000Z',
    ...overrides,
  };
}

/**
 * Creates a mock RugCheck API response for a risky token (score <300).
 * Includes active mint authority, risk factors, and no LP lock/burn.
 */
function createMockRiskyReportResponse(
  overrides?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...createMockTokenReportResponse(),
    score: 150,
    risks: [
      {
        name: 'Mutable Metadata',
        description: 'Token metadata can be changed',
        level: 'high',
        score: -100,
      },
      {
        name: 'High Concentration',
        description: 'Top holders own >50%',
        level: 'critical',
        score: -200,
      },
    ],
    mintAuthority: 'SomeAuthority111111111111111111111111111111',
    isMintable: true,
    lpLocked: false,
    lpBurned: false,
    lpBurnPercentage: 0,
    ...overrides,
  };
}

/**
 * Creates a mock insider graph API response with nodes, edges, and
 * bundle detection indicators.
 */
function createMockInsiderGraphResponse(
  overrides?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    nodes: [
      {
        address: 'Wallet1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
        type: 'creator',
        balance: 10000000,
        percentage: 10,
        fundedByCreator: false,
      },
      {
        address: 'Wallet2EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
        type: 'insider',
        balance: 5000000,
        percentage: 5,
        fundedByCreator: true,
      },
      {
        address: 'Wallet3FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
        type: 'sniper',
        balance: 8000000,
        percentage: 8,
        fundedByCreator: true,
      },
    ],
    edges: [
      {
        from: 'Wallet1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
        to: 'Wallet2EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
        type: 'funding',
        amount: 10,
        signature: 'TxSig111111111111111111111111111111111111',
      },
    ],
    bundleDetected: true,
    sniperSupplyPercent: 12,
    insiderCount: 3,
    insiderHoldingPercent: 23,
    ...overrides,
  };
}

/**
 * Creates a mock wallet risk rating API response.
 */
function createMockWalletRiskRatingResponse(
  overrides?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    address: TEST_WALLET,
    riskScore: 75,
    riskLevel: 'high',
    tokensCreated: 12,
    rugCount: 8,
    rugRate: 66.7,
    isKnownScammer: false,
    riskFactors: ['High rug rate', 'Multiple token launches'],
    ...overrides,
  };
}

/**
 * Helper to create an ApiError for testing error handling paths.
 */
function createApiError(
  status: number,
  errorType: ApiErrorType,
  retryable: boolean,
  message?: string,
): ApiError {
  return new ApiError(
    message ?? `HTTP ${status} error`,
    status,
    errorType,
    retryable,
  );
}

// =============================================================================
// Test Suite
// =============================================================================

describe('RugCheckClient', () => {
  let client: RugCheckClient;

  beforeEach(() => {
    client = new RugCheckClient(TEST_API_KEY);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Section 1: Token Report Parsing (score / risks / authorities)
  // ===========================================================================

  describe('getTokenReport — report parsing', () => {
    it('should parse token report with all fields correctly', async () => {
      const mockResponse = createMockTokenReportResponse();
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.mint).toBe(TEST_MINT);
      expect(report!.score).toBe(500);
      expect(report!.isMintable).toBe(false);
      expect(report!.isFreezable).toBe(false);
      expect(report!.lpLocked).toBe(true);
      expect(report!.lpBurned).toBe(true);
      expect(report!.lpBurnPercentage).toBe(95);
      expect(report!.totalMarketLiquidity).toBe(50000);
      expect(report!.isToken2022).toBe(false);
      expect(report!.risks).toEqual([]);
      expect(report!.topHolders.length).toBe(2);
      expect(report!.markets.length).toBe(1);
    });

    it('should parse safety score as a number', async () => {
      const mockResponse = createMockTokenReportResponse({ score: 350 });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(typeof report!.score).toBe('number');
      expect(report!.score).toBe(350);
    });

    it('should correctly identify high-score safe token (score ≥300)', async () => {
      const mockResponse = createMockTokenReportResponse({ score: 500 });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.score).toBeGreaterThanOrEqual(300);
    });

    it('should correctly identify low-score risky token (score <300)', async () => {
      const mockResponse = createMockRiskyReportResponse({ score: 150 });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.score).toBeLessThan(300);
    });

    it('should parse risk factors array', async () => {
      const mockResponse = createMockRiskyReportResponse();
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.risks.length).toBe(2);

      const risk0: RugCheckRisk = report!.risks[0];
      expect(risk0.name).toBe('Mutable Metadata');
      expect(risk0.description).toBe('Token metadata can be changed');
      expect(['critical', 'high', 'medium', 'low', 'info']).toContain(risk0.level);
      expect(typeof risk0.score).toBe('number');

      const risk1: RugCheckRisk = report!.risks[1];
      expect(risk1.name).toBe('High Concentration');
      expect(risk1.level).toBe('critical');
    });

    it('should parse mint authority status — null means revoked (safe)', async () => {
      const mockResponse = createMockTokenReportResponse({
        mintAuthority: null,
        isMintable: false,
      });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.mintAuthority).toBeNull();
      expect(report!.isMintable).toBe(false);
    });

    it('should parse mint authority status — non-null means active (risky)', async () => {
      const mockResponse = createMockTokenReportResponse({
        mintAuthority: 'SomeAuthority111111111111111111111111111111',
        isMintable: true,
      });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.mintAuthority).toBe('SomeAuthority111111111111111111111111111111');
      expect(report!.isMintable).toBe(true);
    });

    it('should parse freeze authority status — null means revoked (safe)', async () => {
      const mockResponse = createMockTokenReportResponse({
        freezeAuthority: null,
        isFreezable: false,
      });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.freezeAuthority).toBeNull();
      expect(report!.isFreezable).toBe(false);
    });

    it('should parse freeze authority status — non-null means active (risky)', async () => {
      const mockResponse = createMockTokenReportResponse({
        freezeAuthority: 'FreezeAddr111111111111111111111111111111111',
        isFreezable: true,
      });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.freezeAuthority).toBe('FreezeAddr111111111111111111111111111111111');
      expect(report!.isFreezable).toBe(true);
    });

    it('should parse LP lock and burn status', async () => {
      const mockResponse = createMockTokenReportResponse({
        lpLocked: true,
        lpBurned: true,
        lpBurnPercentage: 95,
      });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.lpLocked).toBe(true);
      expect(report!.lpBurned).toBe(true);
      expect(report!.lpBurnPercentage).toBe(95);
    });

    it('should parse LP status as false when not locked or burned', async () => {
      const mockResponse = createMockRiskyReportResponse({
        lpLocked: false,
        lpBurned: false,
        lpBurnPercentage: 0,
      });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.lpLocked).toBe(false);
      expect(report!.lpBurned).toBe(false);
      expect(report!.lpBurnPercentage).toBe(0);
    });

    it('should parse top holders array', async () => {
      const mockResponse = createMockTokenReportResponse();
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.topHolders.length).toBe(2);

      const holder0: RugCheckHolder = report!.topHolders[0];
      expect(holder0.address).toBe('Holder1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(holder0.amount).toBe(50000000);
      expect(holder0.percentage).toBe(5);
      expect(holder0.isInsider).toBe(false);

      const holder1: RugCheckHolder = report!.topHolders[1];
      expect(holder1.address).toBe('Holder2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
      expect(holder1.amount).toBe(30000000);
      expect(holder1.percentage).toBe(3);
    });

    it('should parse markets and totalMarketLiquidity', async () => {
      const mockResponse = createMockTokenReportResponse();
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.markets.length).toBe(1);

      const market0: RugCheckMarket = report!.markets[0];
      expect(market0.marketId).toBe('Market1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC');
      expect(market0.marketType).toBe('raydium');
      expect(market0.liquidityA).toBe(25000);
      expect(market0.liquidityB).toBe(25000);
      expect(market0.liquidityAToken).toBe('So11111111111111111111111111111111111111112');
      expect(market0.liquidityBToken).toBe(TEST_MINT);

      expect(report!.totalMarketLiquidity).toBe(50000);
    });

    it('should detect Token-2022 extensions', async () => {
      const mockResponse = createMockTokenReportResponse({ isToken2022: true });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.isToken2022).toBe(true);
    });

    it('should parse Token-2022 as false by default', async () => {
      const mockResponse = createMockTokenReportResponse({ isToken2022: false });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.isToken2022).toBe(false);
    });

    it('should call the correct endpoint /v1/tokens/{mint}/report', async () => {
      mockGet.mockResolvedValueOnce(createMockTokenReportResponse());

      await client.getTokenReport(TEST_MINT);

      expect(mockGet).toHaveBeenCalledTimes(1);
      const calledEndpoint = mockGet.mock.calls[0][0] as string;
      expect(calledEndpoint).toContain('/v1/tokens/');
      expect(calledEndpoint).toContain(TEST_MINT);
      expect(calledEndpoint).toContain('/report');
    });

    it('should parse createdAt timestamp', async () => {
      const ts = '2026-03-13T12:00:00.000Z';
      const mockResponse = createMockTokenReportResponse({ createdAt: ts });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.createdAt).toBe(ts);
    });

    it('should handle empty risks array', async () => {
      const mockResponse = createMockTokenReportResponse({ risks: [] });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.risks).toEqual([]);
    });

    it('should handle empty top holders array', async () => {
      const mockResponse = createMockTokenReportResponse({ topHolders: [] });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.topHolders).toEqual([]);
    });

    it('should handle empty markets array', async () => {
      const mockResponse = createMockTokenReportResponse({
        markets: [],
        totalMarketLiquidity: 0,
      });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.markets).toEqual([]);
      expect(report!.totalMarketLiquidity).toBe(0);
    });

    it('should handle score of exactly 300 (boundary threshold)', async () => {
      const mockResponse = createMockTokenReportResponse({ score: 300 });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.score).toBe(300);
      expect(report!.score).toBeGreaterThanOrEqual(300);
    });

    it('should handle score of zero', async () => {
      const mockResponse = createMockTokenReportResponse({ score: 0 });
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.score).toBe(0);
    });
  });

  // ===========================================================================
  // Section 2: Insider Graph
  // ===========================================================================

  describe('getInsiderGraph', () => {
    it('should parse insider graph response', async () => {
      const mockResponse = createMockInsiderGraphResponse();
      mockGet.mockResolvedValueOnce(mockResponse);

      const graph = await client.getInsiderGraph(TEST_MINT);

      expect(graph).not.toBeNull();
      expect(graph!.nodes).toBeInstanceOf(Array);
      expect(graph!.edges).toBeInstanceOf(Array);
      expect(graph!.nodes.length).toBe(3);
      expect(graph!.edges.length).toBe(1);

      // Validate node fields
      const node0 = graph!.nodes[0];
      expect(node0.address).toBe('Wallet1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD');
      expect(node0.type).toBe('creator');
      expect(typeof node0.balance).toBe('number');
      expect(typeof node0.percentage).toBe('number');

      // Validate edge fields
      const edge0 = graph!.edges[0];
      expect(edge0.from).toBe('Wallet1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD');
      expect(edge0.to).toBe('Wallet2EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE');
      expect(edge0.type).toBe('funding');
      expect(typeof edge0.amount).toBe('number');
    });

    it('should call the correct endpoint /v1/tokens/{mint}/insiders/graph', async () => {
      mockGet.mockResolvedValueOnce(createMockInsiderGraphResponse());

      await client.getInsiderGraph(TEST_MINT);

      expect(mockGet).toHaveBeenCalledTimes(1);
      const calledEndpoint = mockGet.mock.calls[0][0] as string;
      expect(calledEndpoint).toContain('/v1/tokens/');
      expect(calledEndpoint).toContain(TEST_MINT);
      expect(calledEndpoint).toContain('/insiders/graph');
    });

    it('should detect bundled launch indicators', async () => {
      const mockResponse = createMockInsiderGraphResponse({
        bundleDetected: true,
        sniperSupplyPercent: 12,
      });
      mockGet.mockResolvedValueOnce(mockResponse);

      const graph = await client.getInsiderGraph(TEST_MINT);

      expect(graph).not.toBeNull();
      expect(graph!.bundleDetected).toBe(true);
      // AAP hard filter: "bundled launch >10% sniper supply"
      expect(graph!.sniperSupplyPercent).toBeGreaterThan(10);
      expect(graph!.sniperSupplyPercent).toBe(12);
    });

    it('should capture insider count and holding percentage', async () => {
      const mockResponse = createMockInsiderGraphResponse({
        insiderCount: 3,
        insiderHoldingPercent: 23,
      });
      mockGet.mockResolvedValueOnce(mockResponse);

      const graph = await client.getInsiderGraph(TEST_MINT);

      expect(graph).not.toBeNull();
      expect(graph!.insiderCount).toBe(3);
      expect(graph!.insiderHoldingPercent).toBe(23);
    });

    it('should handle insider graph 404 (token not indexed)', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(404, 'not-found', false, 'Not Found'),
      );

      const graph = await client.getInsiderGraph(TEST_MINT);

      expect(graph).toBeNull();
    });

    it('should handle insider graph with no bundle detected', async () => {
      const mockResponse = createMockInsiderGraphResponse({
        bundleDetected: false,
        sniperSupplyPercent: 0,
        nodes: [
          {
            address: 'WalletNormal11111111111111111111111111111111',
            type: 'normal',
            balance: 1000000,
            percentage: 1,
            fundedByCreator: false,
          },
        ],
        edges: [],
      });
      mockGet.mockResolvedValueOnce(mockResponse);

      const graph = await client.getInsiderGraph(TEST_MINT);

      expect(graph).not.toBeNull();
      expect(graph!.bundleDetected).toBe(false);
      expect(graph!.sniperSupplyPercent).toBe(0);
    });

    it('should parse edge signature when present', async () => {
      const mockResponse = createMockInsiderGraphResponse();
      mockGet.mockResolvedValueOnce(mockResponse);

      const graph = await client.getInsiderGraph(TEST_MINT);

      expect(graph).not.toBeNull();
      expect(graph!.edges[0].signature).toBe('TxSig111111111111111111111111111111111111');
    });
  });

  // ===========================================================================
  // Section 3: Wallet Risk Rating
  // ===========================================================================

  describe('getWalletRiskRating', () => {
    it('should parse wallet risk rating response', async () => {
      const mockResponse = createMockWalletRiskRatingResponse();
      mockGet.mockResolvedValueOnce(mockResponse);

      const rating = await client.getWalletRiskRating(TEST_WALLET);

      expect(rating).not.toBeNull();
      expect(rating!.address).toBe(TEST_WALLET);
      expect(rating!.riskScore).toBe(75);
      expect(rating!.riskLevel).toBe('high');
      expect(rating!.tokensCreated).toBe(12);
      expect(rating!.rugCount).toBe(8);
      expect(rating!.rugRate).toBe(66.7);
      expect(rating!.isKnownScammer).toBe(false);
      expect(rating!.riskFactors).toEqual(['High rug rate', 'Multiple token launches']);
    });

    it('should call the correct endpoint /v1/wallets/risk-rating/solana/{address}', async () => {
      mockGet.mockResolvedValueOnce(createMockWalletRiskRatingResponse());

      await client.getWalletRiskRating(TEST_WALLET);

      expect(mockGet).toHaveBeenCalledTimes(1);
      const calledEndpoint = mockGet.mock.calls[0][0] as string;
      expect(calledEndpoint).toContain('/v1/wallets/risk-rating/solana/');
      expect(calledEndpoint).toContain(TEST_WALLET);
    });

    it('should return null for 404 (wallet not indexed)', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(404, 'not-found', false, 'Wallet not found'),
      );

      const rating = await client.getWalletRiskRating(TEST_WALLET);

      expect(rating).toBeNull();
    });

    it('should detect known scammer flag', async () => {
      const mockResponse = createMockWalletRiskRatingResponse({
        isKnownScammer: true,
        riskLevel: 'critical',
        riskScore: 95,
      });
      mockGet.mockResolvedValueOnce(mockResponse);

      const rating = await client.getWalletRiskRating(TEST_WALLET);

      expect(rating).not.toBeNull();
      expect(rating!.isKnownScammer).toBe(true);
      expect(rating!.riskLevel).toBe('critical');
    });
  });

  // ===========================================================================
  // Section 4: X-API-KEY Authentication (CRITICAL)
  // ===========================================================================

  describe('X-API-KEY authentication', () => {
    it('should include X-API-KEY header in every request via BaseClient initialization', async () => {
      mockGet.mockResolvedValueOnce(createMockTokenReportResponse());

      await client.getTokenReport(TEST_MINT);

      // Verify BaseClient was constructed with the correct headers
      expect(MockBaseClientConstructor).toHaveBeenCalled();

      const calls = MockBaseClientConstructor.mock.calls as unknown as unknown[][];
      const lastCall = calls[calls.length - 1];
      const options = lastCall[1] as Record<string, Record<string, string>>;
      expect(options.defaultHeaders['X-API-KEY']).toBe(TEST_API_KEY);
    });

    it('should include X-API-KEY header in insider graph request', async () => {
      mockGet.mockResolvedValueOnce(createMockInsiderGraphResponse());

      await client.getInsiderGraph(TEST_MINT);

      expect(mockGet).toHaveBeenCalledTimes(1);

      const calls = MockBaseClientConstructor.mock.calls as unknown as unknown[][];
      const lastCall = calls[calls.length - 1];
      const options = lastCall[1] as Record<string, Record<string, string>>;
      expect(options.defaultHeaders['X-API-KEY']).toBe(TEST_API_KEY);
    });

    it('should use the API key provided in constructor', async () => {
      const customKey = 'specific-key-123';
      const customClient = new RugCheckClient(customKey);

      mockGet.mockResolvedValueOnce(createMockTokenReportResponse());
      await customClient.getTokenReport(TEST_MINT);

      const calls = MockBaseClientConstructor.mock.calls as unknown as unknown[][];
      const lastCall = calls[calls.length - 1];
      const options = lastCall[1] as Record<string, Record<string, string>>;
      expect(options.defaultHeaders['X-API-KEY']).toBe(customKey);
    });

    it('should also include Accept: application/json header', async () => {
      const calls = MockBaseClientConstructor.mock.calls as unknown as unknown[][];
      const lastCall = calls[calls.length - 1];
      const options = lastCall[1] as Record<string, Record<string, string>>;
      expect(options.defaultHeaders['Accept']).toBe('application/json');
    });
  });

  // ===========================================================================
  // Section 5: 404 Handling for Unindexed Tokens (CRITICAL)
  // ===========================================================================

  describe('404 handling for unindexed tokens', () => {
    it('should return null for 404 response (token not yet indexed)', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(404, 'not-found', false, 'Token not found'),
      );

      const report = await client.getTokenReport('BrandNewMint111111111111111111111111');

      expect(report).toBeNull();
    });

    it('should NOT throw error for 404 response', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(404, 'not-found', false, 'Token not found'),
      );

      await expect(
        client.getTokenReport('NewMint111111111111111111111111111'),
      ).resolves.toBeNull();
    });

    it('should log a warning for 404 (not an error)', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(404, 'not-found', false, 'Token not found'),
      );

      await client.getTokenReport('NewMint111111111111111111111111111');

      // 404s should trigger logger.warn, NOT logger.error
      expect(mockLogger.warn).toHaveBeenCalled();

      const warnCallArgs = mockLogger.warn.mock.calls[0];
      const warnMessage = warnCallArgs[0] as string;
      expect(warnMessage.toLowerCase()).toMatch(/not found|not.*indexed/);
    });

    it('should NOT call logger.error for 404 response', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(404, 'not-found', false, 'Token not found'),
      );

      await client.getTokenReport(TEST_MINT);

      // 404 should only trigger warn, never error for getTokenReport
      const errorCalls = mockLogger.error.mock.calls.filter(
        (call: unknown[]) => {
          const msg = String(call[0]);
          return msg.includes('getTokenReport');
        },
      );
      expect(errorCalls.length).toBe(0);
    });

    it('should differentiate 404 from 500 errors', async () => {
      // 404 → should log warn
      mockGet.mockRejectedValueOnce(
        createApiError(404, 'not-found', false, 'Not Found'),
      );
      await client.getTokenReport(TEST_MINT);
      expect(mockLogger.warn).toHaveBeenCalled();

      vi.clearAllMocks();

      // 500 → should log error
      mockGet.mockRejectedValueOnce(
        createApiError(500, 'server-error', true, 'Internal Server Error'),
      );
      await client.getTokenReport(TEST_MINT);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should return null for getInsiderGraph 404', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(404, 'not-found', false, 'Not Found'),
      );

      await expect(
        client.getInsiderGraph(TEST_MINT),
      ).resolves.toBeNull();
    });
  });

  // ===========================================================================
  // Section 6: Other Error Handling
  // ===========================================================================

  describe('error handling', () => {
    it('should handle 401 (invalid API key) and return null', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(401, 'auth-failed', false, 'Unauthorized'),
      );

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).toBeNull();
      expect(mockLogger.error).toHaveBeenCalled();
      const errorMsg = mockLogger.error.mock.calls[0][0] as string;
      expect(errorMsg.toLowerCase()).toContain('auth');
    });

    it('should handle 403 (forbidden) and return null', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(403, 'auth-failed', false, 'Forbidden'),
      );

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).toBeNull();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should handle 429 (rate limited) and return null', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(429, 'rate-limited', true, 'Too Many Requests'),
      );

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should handle 5xx server errors and return null', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(500, 'server-error', true, 'Internal Server Error'),
      );

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).toBeNull();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should handle 502 bad gateway and return null', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(502, 'server-error', true, 'Bad Gateway'),
      );

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).toBeNull();
    });

    it('should handle timeout gracefully and return null', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(0, 'timeout', true, 'Request timeout after 10000ms'),
      );

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should handle network errors gracefully and return null', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(0, 'network-error', true, 'Network error: DNS resolution failed'),
      );

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should handle parse errors and return null', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(200, 'parse-error', false, 'Failed to parse response as JSON'),
      );

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).toBeNull();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should handle non-ApiError exceptions and return null', async () => {
      mockGet.mockRejectedValueOnce(new Error('Unexpected runtime error'));

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).toBeNull();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should return cautious default (null) on any safety check failure', async () => {
      // Per AAP worst-case-wins: if RugCheck is unavailable, assume unsafe
      const errorScenarios: Array<[number, ApiErrorType, boolean]> = [
        [404, 'not-found', false],
        [401, 'auth-failed', false],
        [429, 'rate-limited', true],
        [500, 'server-error', true],
        [0, 'timeout', true],
        [0, 'network-error', true],
        [200, 'parse-error', false],
      ];

      for (const [status, errorType, retryable] of errorScenarios) {
        vi.clearAllMocks();
        mockGet.mockRejectedValueOnce(
          createApiError(status, errorType, retryable),
        );

        const result = await client.getTokenReport(TEST_MINT);
        expect(result).toBeNull();
      }
    });

    it('should return null for getInsiderGraph on server error', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(500, 'server-error', true, 'Server Error'),
      );

      const graph = await client.getInsiderGraph(TEST_MINT);

      expect(graph).toBeNull();
    });

    it('should return null for getWalletRiskRating on error', async () => {
      mockGet.mockRejectedValueOnce(
        createApiError(500, 'server-error', true, 'Server Error'),
      );

      const rating = await client.getWalletRiskRating(TEST_WALLET);

      expect(rating).toBeNull();
    });
  });

  // ===========================================================================
  // Section 7: Rate Limiter Integration
  // ===========================================================================

  describe('rate limiter', () => {
    it('should call rate limiter before getTokenReport request', async () => {
      mockGet.mockResolvedValueOnce(createMockTokenReportResponse());

      await client.getTokenReport(TEST_MINT);

      expect(mockAcquire).toHaveBeenCalledTimes(1);
      expect(mockAcquire).toHaveBeenCalledWith('rugcheck', 'high');
    });

    it('should call rate limiter before getInsiderGraph request', async () => {
      mockGet.mockResolvedValueOnce(createMockInsiderGraphResponse());

      await client.getInsiderGraph(TEST_MINT);

      expect(mockAcquire).toHaveBeenCalledTimes(1);
      expect(mockAcquire).toHaveBeenCalledWith('rugcheck', 'high');
    });

    it('should call rate limiter before getWalletRiskRating request', async () => {
      mockGet.mockResolvedValueOnce(createMockWalletRiskRatingResponse());

      await client.getWalletRiskRating(TEST_WALLET);

      expect(mockAcquire).toHaveBeenCalledTimes(1);
      expect(mockAcquire).toHaveBeenCalledWith('rugcheck', 'normal');
    });

    it('should use high priority for safety-critical token report requests', async () => {
      mockGet.mockResolvedValueOnce(createMockTokenReportResponse());

      await client.getTokenReport(TEST_MINT);

      expect(mockAcquire).toHaveBeenCalledWith('rugcheck', 'high');
    });

    it('should call rate limiter with rugcheck provider name', async () => {
      mockGet.mockResolvedValueOnce(createMockTokenReportResponse());

      await client.getTokenReport(TEST_MINT);

      const providerArg = mockAcquire.mock.calls[0][0];
      expect(providerArg).toBe('rugcheck');
    });

    it('should not make API call if rate limiter rejects', async () => {
      mockAcquire.mockRejectedValueOnce(
        new Error('Rate limiter timeout: request waited too long'),
      );

      const report = await client.getTokenReport(TEST_MINT);

      // Should return null (fail-safe) and NOT have called baseClient.get
      expect(report).toBeNull();
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Section 8: Static Utility Methods
  // ===========================================================================

  describe('createFailSafeReport', () => {
    it('should create a pessimistic fail-safe report', () => {
      const report = RugCheckClient.createFailSafeReport(TEST_MINT);

      expect(report.mint).toBe(TEST_MINT);
      expect(report.score).toBe(0);
      expect(report.isMintable).toBe(true);
      expect(report.isFreezable).toBe(true);
      expect(report.lpLocked).toBe(false);
      expect(report.lpBurned).toBe(false);
      expect(report.lpBurnPercentage).toBe(0);
      expect(report.topHolders).toEqual([]);
      expect(report.markets).toEqual([]);
      expect(report.totalMarketLiquidity).toBe(0);
    });

    it('should include an explanatory risk factor', () => {
      const report = RugCheckClient.createFailSafeReport(TEST_MINT);

      expect(report.risks.length).toBe(1);
      expect(report.risks[0].name).toBe('RugCheck Unavailable');
      expect(report.risks[0].level).toBe('critical');
    });

    it('should have score well below the ≥300 safety threshold', () => {
      const report = RugCheckClient.createFailSafeReport(TEST_MINT);

      expect(report.score).toBeLessThan(300);
    });
  });

  // ===========================================================================
  // Section 9: Edge Cases and Defensive Parsing
  // ===========================================================================

  describe('defensive parsing', () => {
    it('should handle API response with snake_case field names', async () => {
      const mockResponse = {
        mint: TEST_MINT,
        score: 400,
        risks: [],
        mint_authority: null,
        freeze_authority: null,
        is_mintable: false,
        is_freezable: false,
        top_holders: [],
        lp_locked: true,
        lp_burned: true,
        lp_burn_percentage: 90,
        is_token_2022: false,
        markets: [],
        total_market_liquidity: 30000,
        created_at: '2026-03-13T10:00:00.000Z',
      };
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.score).toBe(400);
      expect(report!.mintAuthority).toBeNull();
      expect(report!.lpLocked).toBe(true);
      expect(report!.lpBurnPercentage).toBe(90);
      expect(report!.totalMarketLiquidity).toBe(30000);
    });

    it('should handle missing optional fields with safe defaults', async () => {
      const mockResponse = {
        mint: TEST_MINT,
        score: 200,
      };
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport(TEST_MINT);

      expect(report).not.toBeNull();
      expect(report!.score).toBe(200);
      expect(report!.risks).toEqual([]);
      expect(report!.topHolders).toEqual([]);
      expect(report!.markets).toEqual([]);
      expect(report!.isMintable).toBe(false);
      expect(report!.isFreezable).toBe(false);
      expect(report!.lpLocked).toBe(false);
      expect(report!.lpBurned).toBe(false);
      expect(report!.lpBurnPercentage).toBe(0);
      expect(report!.totalMarketLiquidity).toBe(0);
    });

    it('should use mint parameter as fallback when response lacks mint field', async () => {
      const mockResponse = { score: 300 };
      mockGet.mockResolvedValueOnce(mockResponse);

      const report = await client.getTokenReport('FallbackMint1111111111111111111');

      expect(report).not.toBeNull();
      expect(report!.mint).toBe('FallbackMint1111111111111111111');
    });

    it('should URL-encode the mint address in the endpoint', async () => {
      mockGet.mockResolvedValueOnce(createMockTokenReportResponse());

      await client.getTokenReport(TEST_MINT);

      const calledEndpoint = mockGet.mock.calls[0][0] as string;
      expect(calledEndpoint).toContain(encodeURIComponent(TEST_MINT));
    });
  });
});
