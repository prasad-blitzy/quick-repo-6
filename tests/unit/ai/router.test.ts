/**
 * tests/unit/ai/router.test.ts — Unit Tests for Three-Tier LLM Routing Logic
 *
 * Comprehensive test suite for the AIRouter class which dispatches token analysis
 * requests to the appropriate LLM tier based on composite score thresholds:
 *   - Score < 45   → 'fast'     (llama-3.1-8b-instant, 80% of calls)
 *   - Score 45–80  → 'detailed' (llama-3.3-70b-versatile, 15% of calls)
 *   - Score >= 80  → 'premium'  (Claude Sonnet, 5% of calls) — when enabled
 *
 * Tests verify:
 *   - Tier selection boundary conditions (0, 44, 45, 79, 80, 100)
 *   - 5-minute TTL cache check BEFORE every LLM call (AAP §0.7.4)
 *   - Cache key format: `llm:{mint}:{tier}`
 *   - Model selection per tier (Groq fast/detailed vs Claude premium)
 *   - Graceful error handling — returns null on any failure, never throws
 *   - Cache invalidation across all 3 tiers
 *   - Tier distribution tracking for 80/15/5 cost monitoring
 *   - Batch analysis with independent failure isolation
 *   - Router configuration (defaults, custom thresholds, premium toggle)
 *
 * All external dependencies are fully mocked — no real API calls, no real
 * chrome.storage operations. Tests execute in the happy-dom environment
 * configured by vitest.config.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock declarations — accessible inside vi.mock() factory functions
// vi.hoisted() ensures these are initialized BEFORE vi.mock() factories execute.
// ---------------------------------------------------------------------------

const {
  mockCacheGet,
  mockCacheSet,
  mockCacheInvalidate,
  mockParseAIResponse,
} = vi.hoisted(() => ({
  mockCacheGet: vi.fn(),
  mockCacheSet: vi.fn(),
  mockCacheInvalidate: vi.fn(),
  mockParseAIResponse: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Vitest before all imports
// ---------------------------------------------------------------------------

vi.mock('../../../src/utils/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../../src/utils/cache', () => ({
  cache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    set: (...args: unknown[]) => mockCacheSet(...args),
    invalidate: (...args: unknown[]) => mockCacheInvalidate(...args),
  },
  LLM_CACHE_TTL: 300000,
}));

vi.mock('../../../src/utils/config', () => ({
  LLM_CONFIG: {
    FAST_THRESHOLD: 45,
    DETAILED_THRESHOLD: 80,
    CACHE_TTL_MS: 300000,
    TIERS: {
      FAST: { model: 'llama-3.1-8b-instant', percentage: 80 },
      DETAILED: { model: 'llama-3.3-70b-versatile', percentage: 15 },
      PREMIUM: { model: 'claude-sonnet', percentage: 5 },
    },
  },
  SCORING_THRESHOLDS: {
    CONSERVATIVE_MIN: 80,
    AGGRESSIVE_MIN: 45,
  },
  API_BASE_URLS: {
    GROQ: 'https://api.groq.com',
    ANTHROPIC: 'https://api.anthropic.com',
  },
}));

vi.mock('../../../src/ai/prompts', () => ({
  buildAnalysisPrompt: vi.fn(() => 'mock user prompt with token data'),
  buildSystemPrompt: vi.fn(
    (tier: string) => `mock system prompt for ${tier} tier`,
  ),
}));

vi.mock('../../../src/ai/response-parser', () => ({
  parseAIResponse: (...args: unknown[]) => mockParseAIResponse(...args),
}));

vi.mock('../../../src/api/groq', () => ({
  GroqClient: vi.fn(),
  GROQ_MODELS: {
    FAST: 'llama-3.1-8b-instant',
    DETAILED: 'llama-3.3-70b-versatile',
  },
  CLAUDE_MODEL: 'claude-sonnet-4-20250514',
}));

// ---------------------------------------------------------------------------
// Module under test imports (AFTER mock setup — hoisting ensures order)
// ---------------------------------------------------------------------------

import {
  AIRouter,
  type RouterConfig,
  type TokenAnalysisInput,
} from '../../../src/ai/router';
import type { AIAnalysisResult, LLMTier } from '../../../src/ai/types';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

/**
 * Creates a standard TokenAnalysisInput with sensible defaults.
 * Composite score defaults to 60 (detailed tier range).
 */
const createTestInput = (
  overrides?: Partial<TokenAnalysisInput>,
): TokenAnalysisInput => ({
  mint: 'TestMint111111111111111111111111111111111111',
  symbol: 'TEST',
  compositeScore: 60,
  price: 0.001,
  marketCap: 500000,
  volume24h: 250000,
  liquidity: 30000,
  holderCount: 500,
  buySellRatio: 1.8,
  smartMoneyCount: 3,
  tokenAgeHours: 2.5,
  safetyScore: 350,
  isHoneypot: false,
  devWalletSold: false,
  topHolderPercent: 15,
  lpBurned: true,
  ...overrides,
});

/**
 * Creates a mock AIAnalysisResult for a given LLM tier.
 * Used to configure mock return values from parseAIResponse and cache.
 */
const createMockAnalysisResult = (tier: LLMTier): AIAnalysisResult => ({
  dimensions: [
    { name: 'on-chain momentum', score: 75, reasoning: 'Strong buy pressure.' },
    { name: 'social velocity', score: 60, reasoning: 'Moderate social buzz.' },
    {
      name: 'wallet intelligence',
      score: 85,
      reasoning: 'Smart money accumulating.',
    },
    { name: 'liquidity health', score: 70, reasoning: 'Healthy LP.' },
    { name: 'narrative fit', score: 55, reasoning: 'Generic theme.' },
  ],
  compositeAI: 69,
  confidence: 'medium',
  narrative: 'Mock AI analysis narrative for testing.',
  tier,
  timestamp: Date.now(),
});

// ---------------------------------------------------------------------------
// Shared Test State
// ---------------------------------------------------------------------------

let mockGroqClient: {
  analyze: ReturnType<typeof vi.fn>;
  analyzeWithClaude: ReturnType<typeof vi.fn>;
};

// ---------------------------------------------------------------------------
// Lifecycle Hooks
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockCacheGet.mockReset();
  mockCacheSet.mockReset();
  mockCacheInvalidate.mockReset();
  mockParseAIResponse.mockReset();

  // Fresh mock GroqClient per test
  mockGroqClient = {
    analyze: vi.fn(),
    analyzeWithClaude: vi.fn(),
  };

  // Default: cache miss
  mockCacheGet.mockResolvedValue(null);
  // Default: cache write succeeds
  mockCacheSet.mockResolvedValue(undefined);
  // Default: cache invalidation succeeds
  mockCacheInvalidate.mockResolvedValue(undefined);

  // Default: Groq returns raw JSON objects
  mockGroqClient.analyze.mockResolvedValue({ mock: 'raw-llm-response' });
  mockGroqClient.analyzeWithClaude.mockResolvedValue({
    mock: 'raw-claude-response',
  });

  // Default: parser returns a valid typed result matching the tier
  mockParseAIResponse.mockImplementation(
    (_raw: unknown, tier: LLMTier) => createMockAnalysisResult(tier),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Test Suites
// ===========================================================================

describe('AIRouter.determineTier', () => {
  it('returns "fast" for scores below 45', () => {
    const router = new AIRouter(mockGroqClient as any);
    expect(router.determineTier(0)).toBe('fast');
    expect(router.determineTier(10)).toBe('fast');
    expect(router.determineTier(30)).toBe('fast');
    expect(router.determineTier(44)).toBe('fast');
  });

  it('returns "detailed" for score exactly 45 (boundary)', () => {
    const router = new AIRouter(mockGroqClient as any);
    expect(router.determineTier(45)).toBe('detailed');
  });

  it('returns "detailed" for scores between 45 and 79', () => {
    const router = new AIRouter(mockGroqClient as any);
    expect(router.determineTier(50)).toBe('detailed');
    expect(router.determineTier(60)).toBe('detailed');
    expect(router.determineTier(79)).toBe('detailed');
  });

  it('returns "premium" for score exactly 80 when premium is enabled', () => {
    const router = new AIRouter(mockGroqClient as any, {
      enablePremiumTier: true,
    });
    expect(router.determineTier(80)).toBe('premium');
  });

  it('returns "premium" for scores above 80 when premium is enabled', () => {
    const router = new AIRouter(mockGroqClient as any, {
      enablePremiumTier: true,
    });
    expect(router.determineTier(85)).toBe('premium');
    expect(router.determineTier(100)).toBe('premium');
  });

  it('falls back to "detailed" for scores >= 80 when premium is disabled', () => {
    const router = new AIRouter(mockGroqClient as any, {
      enablePremiumTier: false,
    });
    expect(router.determineTier(80)).toBe('detailed');
    expect(router.determineTier(85)).toBe('detailed');
    expect(router.determineTier(100)).toBe('detailed');
  });

  it('uses default config (premium disabled) when no config is provided', () => {
    const router = new AIRouter(mockGroqClient as any);
    // Default enablePremiumTier is false
    expect(router.determineTier(90)).toBe('detailed');
  });

  it('respects custom thresholds that override defaults', () => {
    const router = new AIRouter(mockGroqClient as any, {
      fastThreshold: 30,
      detailedThreshold: 70,
      enablePremiumTier: true,
    });
    expect(router.determineTier(25)).toBe('fast');
    expect(router.determineTier(35)).toBe('detailed');
    expect(router.determineTier(69)).toBe('detailed');
    expect(router.determineTier(70)).toBe('premium');
    expect(router.determineTier(75)).toBe('premium');
  });

  it('handles negative scores by mapping to "fast"', () => {
    const router = new AIRouter(mockGroqClient as any);
    expect(router.determineTier(-10)).toBe('fast');
    expect(router.determineTier(-1)).toBe('fast');
  });

  it('returns "fast" for score of exactly 0', () => {
    const router = new AIRouter(mockGroqClient as any);
    expect(router.determineTier(0)).toBe('fast');
  });
});

// ===========================================================================
// Cache Behavior Tests
// ===========================================================================

describe('AIRouter.analyzeToken - cache behavior', () => {
  it('checks cache BEFORE making any LLM API call', async () => {
    const router = new AIRouter(mockGroqClient as any);
    const callOrder: string[] = [];

    mockCacheGet.mockImplementation(async () => {
      callOrder.push('cache.get');
      return null;
    });
    mockGroqClient.analyze.mockImplementation(async () => {
      callOrder.push('groq.analyze');
      return { mock: 'raw' };
    });

    await router.analyzeToken(createTestInput());

    expect(callOrder[0]).toBe('cache.get');
    expect(callOrder[1]).toBe('groq.analyze');
  });

  it('returns cached result immediately on cache hit (no API call)', async () => {
    const cachedResult = createMockAnalysisResult('detailed');
    mockCacheGet.mockResolvedValue(cachedResult);

    const router = new AIRouter(mockGroqClient as any);
    const result = await router.analyzeToken(
      createTestInput({ compositeScore: 60 }),
    );

    expect(result).toEqual(cachedResult);
    expect(mockGroqClient.analyze).not.toHaveBeenCalled();
    expect(mockGroqClient.analyzeWithClaude).not.toHaveBeenCalled();
    expect(mockParseAIResponse).not.toHaveBeenCalled();
    expect(mockCacheSet).not.toHaveBeenCalled();
  });

  it('uses cache key format llm:{mint}:{tier} for fast tier', async () => {
    const router = new AIRouter(mockGroqClient as any);
    await router.analyzeToken(
      createTestInput({ mint: 'ABC123', compositeScore: 30 }),
    );

    expect(mockCacheGet).toHaveBeenCalledWith('llm:ABC123:fast');
  });

  it('uses cache key format llm:{mint}:{tier} for detailed tier', async () => {
    const router = new AIRouter(mockGroqClient as any);
    await router.analyzeToken(
      createTestInput({ mint: 'DEF456', compositeScore: 60 }),
    );

    expect(mockCacheGet).toHaveBeenCalledWith('llm:DEF456:detailed');
  });

  it('uses cache key format llm:{mint}:{tier} for premium tier', async () => {
    const router = new AIRouter(mockGroqClient as any, {
      enablePremiumTier: true,
    });
    await router.analyzeToken(
      createTestInput({ mint: 'GHI789', compositeScore: 90 }),
    );

    expect(mockCacheGet).toHaveBeenCalledWith('llm:GHI789:premium');
  });

  it('caches result AFTER successful API call with 5-minute TTL', async () => {
    mockCacheGet.mockResolvedValue(null);
    const router = new AIRouter(mockGroqClient as any);

    await router.analyzeToken(
      createTestInput({
        mint: 'CachedMint123',
        compositeScore: 60,
      }),
    );

    expect(mockCacheSet).toHaveBeenCalledTimes(1);
    const [cacheKey, cachedValue, ttl] = mockCacheSet.mock.calls[0];
    expect(cacheKey).toBe('llm:CachedMint123:detailed');
    expect(ttl).toBe(300000); // 5 minutes in ms
    expect(cachedValue).toBeDefined();
    expect(cachedValue.tier).toBe('detailed');
  });

  it('does NOT cache result when LLM API call fails', async () => {
    mockGroqClient.analyze.mockRejectedValue(new Error('API timeout'));
    const router = new AIRouter(mockGroqClient as any);

    await router.analyzeToken(createTestInput());

    expect(mockCacheSet).not.toHaveBeenCalled();
  });

  it('uses different cache keys for different token mints', async () => {
    const router = new AIRouter(mockGroqClient as any);

    await router.analyzeToken(
      createTestInput({ mint: 'TOKEN_A', compositeScore: 60 }),
    );
    await router.analyzeToken(
      createTestInput({ mint: 'TOKEN_B', compositeScore: 60 }),
    );

    expect(mockCacheGet).toHaveBeenCalledWith('llm:TOKEN_A:detailed');
    expect(mockCacheGet).toHaveBeenCalledWith('llm:TOKEN_B:detailed');
    expect(mockCacheGet.mock.calls[0][0]).not.toBe(
      mockCacheGet.mock.calls[1][0],
    );
  });

  it('uses different cache keys for the same token at different tiers', async () => {
    const router = new AIRouter(mockGroqClient as any);

    await router.analyzeToken(
      createTestInput({ mint: 'SAME_TOKEN', compositeScore: 30 }),
    );
    await router.analyzeToken(
      createTestInput({ mint: 'SAME_TOKEN', compositeScore: 60 }),
    );

    expect(mockCacheGet).toHaveBeenCalledWith('llm:SAME_TOKEN:fast');
    expect(mockCacheGet).toHaveBeenCalledWith('llm:SAME_TOKEN:detailed');
  });
});

// ===========================================================================
// Model Selection Tests
// ===========================================================================

describe('AIRouter.analyzeToken - model selection', () => {
  it('fast tier calls groqClient.analyze with llama-3.1-8b-instant', async () => {
    const router = new AIRouter(mockGroqClient as any);

    await router.analyzeToken(createTestInput({ compositeScore: 30 }));

    expect(mockGroqClient.analyze).toHaveBeenCalledTimes(1);
    const callArgs = mockGroqClient.analyze.mock.calls[0];
    // Second arg is the model
    expect(callArgs[1]).toBe('llama-3.1-8b-instant');
    expect(mockGroqClient.analyzeWithClaude).not.toHaveBeenCalled();
  });

  it('detailed tier calls groqClient.analyze with llama-3.3-70b-versatile', async () => {
    const router = new AIRouter(mockGroqClient as any);

    await router.analyzeToken(createTestInput({ compositeScore: 60 }));

    expect(mockGroqClient.analyze).toHaveBeenCalledTimes(1);
    const callArgs = mockGroqClient.analyze.mock.calls[0];
    expect(callArgs[1]).toBe('llama-3.3-70b-versatile');
    expect(mockGroqClient.analyzeWithClaude).not.toHaveBeenCalled();
  });

  it('premium tier calls groqClient.analyzeWithClaude for Claude Sonnet', async () => {
    const router = new AIRouter(mockGroqClient as any, {
      enablePremiumTier: true,
    });

    await router.analyzeToken(createTestInput({ compositeScore: 90 }));

    expect(mockGroqClient.analyzeWithClaude).toHaveBeenCalledTimes(1);
    // When Claude succeeds, groq.analyze should NOT be called
    // (no fallback needed)
    expect(mockGroqClient.analyze).not.toHaveBeenCalled();
  });

  it('premium tier disabled falls back to detailed model', async () => {
    const router = new AIRouter(mockGroqClient as any, {
      enablePremiumTier: false,
    });

    await router.analyzeToken(createTestInput({ compositeScore: 90 }));

    expect(mockGroqClient.analyze).toHaveBeenCalledTimes(1);
    const callArgs = mockGroqClient.analyze.mock.calls[0];
    expect(callArgs[1]).toBe('llama-3.3-70b-versatile');
    expect(mockGroqClient.analyzeWithClaude).not.toHaveBeenCalled();
  });

  it('calls parseAIResponse with raw LLM response and correct tier', async () => {
    const rawResponse = { raw: 'structured-json-data' };
    mockGroqClient.analyze.mockResolvedValue(rawResponse);

    const router = new AIRouter(mockGroqClient as any);
    await router.analyzeToken(createTestInput({ compositeScore: 60 }));

    expect(mockParseAIResponse).toHaveBeenCalledTimes(1);
    expect(mockParseAIResponse).toHaveBeenCalledWith(rawResponse, 'detailed');
  });

  it('passes temperature and responseFormat options to the LLM', async () => {
    const router = new AIRouter(mockGroqClient as any);
    await router.analyzeToken(createTestInput({ compositeScore: 60 }));

    expect(mockGroqClient.analyze).toHaveBeenCalledTimes(1);
    const callArgs = mockGroqClient.analyze.mock.calls[0];
    // Third arg is the options object
    const options = callArgs[2];
    expect(options).toBeDefined();
    expect(options.responseFormat).toBe('json');
    expect(options.temperature).toBe(0.1);
    expect(typeof options.maxTokens).toBe('number');
  });

  it('premium tier falls back to detailed model when Claude returns null', async () => {
    mockGroqClient.analyzeWithClaude.mockResolvedValue(null);
    const router = new AIRouter(mockGroqClient as any, {
      enablePremiumTier: true,
    });

    await router.analyzeToken(createTestInput({ compositeScore: 90 }));

    // First called analyzeWithClaude, which returned null
    expect(mockGroqClient.analyzeWithClaude).toHaveBeenCalledTimes(1);
    // Then fell back to analyze with detailed model
    expect(mockGroqClient.analyze).toHaveBeenCalledTimes(1);
    const fallbackArgs = mockGroqClient.analyze.mock.calls[0];
    expect(fallbackArgs[1]).toBe('llama-3.3-70b-versatile');
  });
});

// ===========================================================================
// Error Handling Tests
// ===========================================================================

describe('AIRouter.analyzeToken - error handling', () => {
  it('returns null when groqClient.analyze throws', async () => {
    mockGroqClient.analyze.mockRejectedValue(
      new Error('Groq API rate limit exceeded'),
    );
    const router = new AIRouter(mockGroqClient as any);

    const result = await router.analyzeToken(createTestInput());

    expect(result).toBeNull();
  });

  it('returns null when groqClient.analyzeWithClaude throws', async () => {
    mockGroqClient.analyzeWithClaude.mockRejectedValue(
      new Error('Claude API error'),
    );
    const router = new AIRouter(mockGroqClient as any, {
      enablePremiumTier: true,
    });

    const result = await router.analyzeToken(
      createTestInput({ compositeScore: 90 }),
    );

    expect(result).toBeNull();
  });

  it('continues with LLM call when cache.get throws (graceful degradation)', async () => {
    // cache.get failure is caught internally; the router proceeds with the LLM call
    mockCacheGet.mockRejectedValue(new Error('Chrome storage read error'));
    const router = new AIRouter(mockGroqClient as any);

    const result = await router.analyzeToken(createTestInput());

    // The analysis should still succeed via the LLM call
    expect(result).not.toBeNull();
    expect(mockGroqClient.analyze).toHaveBeenCalled();
  });

  it('returns result even when cache.set throws (cache write failure)', async () => {
    mockCacheSet.mockRejectedValue(new Error('Storage write error'));
    const router = new AIRouter(mockGroqClient as any);

    const result = await router.analyzeToken(createTestInput());

    // Analysis succeeded; cache write failure is non-fatal
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('detailed');
  });

  it('returns null when parseAIResponse throws', async () => {
    mockParseAIResponse.mockImplementation(() => {
      throw new Error('Malformed JSON parse error');
    });
    const router = new AIRouter(mockGroqClient as any);

    const result = await router.analyzeToken(createTestInput());

    expect(result).toBeNull();
  });

  it('returns null on request timeout (simulated by rejection)', async () => {
    mockGroqClient.analyze.mockRejectedValue(new Error('Request timeout'));
    const router = new AIRouter(mockGroqClient as any);

    const result = await router.analyzeToken(createTestInput());

    expect(result).toBeNull();
  });

  it('does not crash the signal pipeline — always returns null on error', async () => {
    // Verify that no error type causes an unhandled rejection
    mockGroqClient.analyze.mockRejectedValue(
      new TypeError('Network failure'),
    );
    const router = new AIRouter(mockGroqClient as any);

    // This must NOT throw
    const result = await router.analyzeToken(createTestInput());
    expect(result).toBeNull();
  });
});

// ===========================================================================
// Cache Invalidation Tests
// ===========================================================================

describe('AIRouter.invalidateCache', () => {
  it('invalidates cache entries for all 3 tiers of a given token', async () => {
    const router = new AIRouter(mockGroqClient as any);

    await router.invalidateCache('TokenMint123');

    expect(mockCacheInvalidate).toHaveBeenCalledTimes(3);
    const invalidatedKeys = mockCacheInvalidate.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(invalidatedKeys).toContain('llm:TokenMint123:fast');
    expect(invalidatedKeys).toContain('llm:TokenMint123:detailed');
    expect(invalidatedKeys).toContain('llm:TokenMint123:premium');
  });

  it('does not throw if cache invalidation fails', async () => {
    mockCacheInvalidate.mockRejectedValue(
      new Error('Storage error during invalidation'),
    );
    const router = new AIRouter(mockGroqClient as any);

    // Should not throw despite the storage error
    await expect(
      router.invalidateCache('TokenMint123'),
    ).resolves.toBeUndefined();
  });
});

// ===========================================================================
// Tier Distribution Tracking Tests
// ===========================================================================

describe('AIRouter - tier distribution tracking', () => {
  it('returns all zeros before any analyses', () => {
    const router = new AIRouter(mockGroqClient as any);
    const dist = router.getTierDistribution();
    expect(dist).toEqual({ fast: 0, detailed: 0, premium: 0 });
  });

  it('tracks tier usage counts across multiple analyses', async () => {
    const router = new AIRouter(mockGroqClient as any);

    // 3 fast-tier analyses (compositeScore < 45)
    await router.analyzeToken(createTestInput({ compositeScore: 10 }));
    await router.analyzeToken(createTestInput({ compositeScore: 20 }));
    await router.analyzeToken(createTestInput({ compositeScore: 30 }));

    // 2 detailed-tier analyses (compositeScore 45–79)
    await router.analyzeToken(createTestInput({ compositeScore: 50 }));
    await router.analyzeToken(createTestInput({ compositeScore: 70 }));

    const dist = router.getTierDistribution();
    // 3/5 = 60% fast, 2/5 = 40% detailed, 0% premium
    expect(dist.fast).toBe(60);
    expect(dist.detailed).toBe(40);
    expect(dist.premium).toBe(0);
  });

  it('increments count after a single successful analysis', async () => {
    const router = new AIRouter(mockGroqClient as any);

    await router.analyzeToken(createTestInput({ compositeScore: 30 }));
    const dist = router.getTierDistribution();

    expect(dist.fast).toBe(100); // 1/1 = 100%
    expect(dist.detailed).toBe(0);
    expect(dist.premium).toBe(0);
  });

  it('resetTierCounts clears all counters to zero', async () => {
    const router = new AIRouter(mockGroqClient as any);

    await router.analyzeToken(createTestInput({ compositeScore: 30 }));
    await router.analyzeToken(createTestInput({ compositeScore: 60 }));

    router.resetTierCounts();

    const dist = router.getTierDistribution();
    expect(dist).toEqual({ fast: 0, detailed: 0, premium: 0 });
  });

  it('does not count cache hits toward tier distribution', async () => {
    // The implementation returns early on cache hit without calling trackTierUsage()
    const cachedResult = createMockAnalysisResult('fast');
    mockCacheGet.mockResolvedValue(cachedResult);

    const router = new AIRouter(mockGroqClient as any);
    await router.analyzeToken(createTestInput({ compositeScore: 30 }));

    const dist = router.getTierDistribution();
    // Cache hit means no tier tracking increment
    expect(dist).toEqual({ fast: 0, detailed: 0, premium: 0 });
  });

  it('only counts successful API calls (not failures) toward distribution', async () => {
    const router = new AIRouter(mockGroqClient as any);

    // First call succeeds
    await router.analyzeToken(createTestInput({ compositeScore: 30 }));

    // Second call fails — error caught, returns null, no trackTierUsage
    mockGroqClient.analyze.mockRejectedValueOnce(new Error('API error'));
    await router.analyzeToken(createTestInput({ compositeScore: 40 }));

    const dist = router.getTierDistribution();
    // Only one successful call was tracked
    expect(dist.fast).toBe(100);
    expect(dist.detailed).toBe(0);
  });
});

// ===========================================================================
// Batch Analysis Tests
// ===========================================================================

describe('AIRouter.analyzeTokens', () => {
  it('analyzes multiple tokens and returns a Map keyed by mint', async () => {
    const router = new AIRouter(mockGroqClient as any);
    const inputs = [
      createTestInput({ mint: 'MINT_A', compositeScore: 30 }),
      createTestInput({ mint: 'MINT_B', compositeScore: 60 }),
      createTestInput({ mint: 'MINT_C', compositeScore: 50 }),
    ];

    const results = await router.analyzeTokens(inputs);

    expect(results).toBeInstanceOf(Map);
    expect(results.size).toBe(3);
    expect(results.has('MINT_A')).toBe(true);
    expect(results.has('MINT_B')).toBe(true);
    expect(results.has('MINT_C')).toBe(true);
  });

  it('individual failures do not affect other token analyses', async () => {
    const router = new AIRouter(mockGroqClient as any);

    // Fail on second call only
    let callCount = 0;
    mockGroqClient.analyze.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error('Transient API failure');
      }
      return { mock: 'raw-response' };
    });

    const inputs = [
      createTestInput({ mint: 'MINT_1', compositeScore: 30 }),
      createTestInput({ mint: 'MINT_2', compositeScore: 35 }),
      createTestInput({ mint: 'MINT_3', compositeScore: 40 }),
    ];

    const results = await router.analyzeTokens(inputs);

    expect(results.get('MINT_1')).not.toBeNull();
    expect(results.get('MINT_2')).toBeNull(); // Failed
    expect(results.get('MINT_3')).not.toBeNull();
  });

  it('uses cache independently for each token', async () => {
    const cachedResult = createMockAnalysisResult('detailed');
    // Cache hit for TOKEN_A, miss for TOKEN_B
    mockCacheGet.mockImplementation(async (key: string) => {
      if (key === 'llm:TOKEN_A:detailed') return cachedResult;
      return null;
    });

    const router = new AIRouter(mockGroqClient as any);
    const inputs = [
      createTestInput({ mint: 'TOKEN_A', compositeScore: 60 }),
      createTestInput({ mint: 'TOKEN_B', compositeScore: 60 }),
    ];

    const results = await router.analyzeTokens(inputs);

    // TOKEN_A came from cache → no API call for it
    // TOKEN_B was a cache miss → API was called
    expect(results.get('TOKEN_A')).toEqual(cachedResult);
    expect(results.get('TOKEN_B')).not.toBeNull();
    // analyze should have been called only once (for TOKEN_B)
    expect(mockGroqClient.analyze).toHaveBeenCalledTimes(1);
  });

  it('returns empty Map for empty input array', async () => {
    const router = new AIRouter(mockGroqClient as any);
    const results = await router.analyzeTokens([]);

    expect(results).toBeInstanceOf(Map);
    expect(results.size).toBe(0);
  });
});

// ===========================================================================
// Router Configuration Tests
// ===========================================================================

describe('AIRouter constructor and configuration', () => {
  it('uses LLM_CONFIG default thresholds when no config is provided', () => {
    const router = new AIRouter(mockGroqClient as any);

    // Default FAST_THRESHOLD = 45
    expect(router.determineTier(44)).toBe('fast');
    expect(router.determineTier(45)).toBe('detailed');
    // Default DETAILED_THRESHOLD = 80
    expect(router.determineTier(79)).toBe('detailed');
    expect(router.determineTier(80)).toBe('detailed'); // premium disabled
  });

  it('accepts custom threshold overrides via config', () => {
    const router = new AIRouter(mockGroqClient as any, {
      fastThreshold: 30,
      detailedThreshold: 70,
    });

    expect(router.determineTier(25)).toBe('fast');
    expect(router.determineTier(30)).toBe('detailed');
    expect(router.determineTier(35)).toBe('detailed');
    expect(router.determineTier(69)).toBe('detailed');
    // Premium disabled by default
    expect(router.determineTier(70)).toBe('detailed');
    expect(router.determineTier(75)).toBe('detailed');
  });

  it('enablePremiumTier defaults to false', () => {
    const router = new AIRouter(mockGroqClient as any);
    expect(router.determineTier(90)).toBe('detailed');
  });

  it('enablePremiumTier: true enables Claude routing for high scores', () => {
    const router = new AIRouter(mockGroqClient as any, {
      enablePremiumTier: true,
    });
    expect(router.determineTier(90)).toBe('premium');
  });

  it('custom cacheTtlMs is used in cache.set calls', async () => {
    const customTtl = 600000; // 10 minutes
    const router = new AIRouter(mockGroqClient as any, {
      cacheTtlMs: customTtl,
    });

    await router.analyzeToken(createTestInput());

    expect(mockCacheSet).toHaveBeenCalledTimes(1);
    const setTtl = mockCacheSet.mock.calls[0][2];
    expect(setTtl).toBe(customTtl);
  });

  it('partial config only overrides specified fields', () => {
    // Only override fastThreshold; detailedThreshold and others use defaults
    const router = new AIRouter(mockGroqClient as any, {
      fastThreshold: 20,
    });

    expect(router.determineTier(15)).toBe('fast');
    expect(router.determineTier(25)).toBe('detailed');
    // detailedThreshold still defaults to 80
    expect(router.determineTier(80)).toBe('detailed'); // premium default false
  });
});

// ===========================================================================
// Full Analysis Flow Tests (Integration-Style)
// ===========================================================================

describe('full analysis flow', () => {
  it('complete flow: cache miss → API call → parse → cache write → result', async () => {
    const callSequence: string[] = [];
    const rawLLMResponse = { dimensions: [], compositeScore: 72 };

    mockCacheGet.mockImplementation(async () => {
      callSequence.push('cache.get');
      return null;
    });
    mockGroqClient.analyze.mockImplementation(async () => {
      callSequence.push('groq.analyze');
      return rawLLMResponse;
    });
    mockParseAIResponse.mockImplementation((_raw: unknown, tier: LLMTier) => {
      callSequence.push('parseAIResponse');
      return createMockAnalysisResult(tier);
    });
    mockCacheSet.mockImplementation(async () => {
      callSequence.push('cache.set');
    });

    const router = new AIRouter(mockGroqClient as any);
    const result = await router.analyzeToken(
      createTestInput({ compositeScore: 60 }),
    );

    // Verify execution order
    expect(callSequence).toEqual([
      'cache.get',
      'groq.analyze',
      'parseAIResponse',
      'cache.set',
    ]);

    // Verify result
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('detailed');
    expect(result!.compositeAI).toBe(69);
    expect(result!.confidence).toBe('medium');
    expect(result!.dimensions).toHaveLength(5);
  });

  it('cache hit short-circuits the entire flow (no API, no parse, no write)', async () => {
    const cachedResult = createMockAnalysisResult('detailed');
    mockCacheGet.mockResolvedValue(cachedResult);

    const router = new AIRouter(mockGroqClient as any);
    const result = await router.analyzeToken(createTestInput());

    // Only cache.get should have been called
    expect(mockCacheGet).toHaveBeenCalledTimes(1);
    expect(mockGroqClient.analyze).not.toHaveBeenCalled();
    expect(mockGroqClient.analyzeWithClaude).not.toHaveBeenCalled();
    expect(mockParseAIResponse).not.toHaveBeenCalled();
    expect(mockCacheSet).not.toHaveBeenCalled();

    // Returned result matches the cached value
    expect(result).toEqual(cachedResult);
  });

  it('constructs correct cache key based on determined tier', async () => {
    // Fast tier — compositeScore 30
    const routerDefault = new AIRouter(mockGroqClient as any);
    await routerDefault.analyzeToken(
      createTestInput({ mint: 'ABC', compositeScore: 30 }),
    );
    expect(mockCacheGet).toHaveBeenCalledWith('llm:ABC:fast');

    mockCacheGet.mockClear();

    // Detailed tier — compositeScore 60
    await routerDefault.analyzeToken(
      createTestInput({ mint: 'DEF', compositeScore: 60 }),
    );
    expect(mockCacheGet).toHaveBeenCalledWith('llm:DEF:detailed');

    mockCacheGet.mockClear();

    // Premium tier — compositeScore 90, premium enabled
    const routerPremium = new AIRouter(mockGroqClient as any, {
      enablePremiumTier: true,
    });
    await routerPremium.analyzeToken(
      createTestInput({ mint: 'GHI', compositeScore: 90 }),
    );
    expect(mockCacheGet).toHaveBeenCalledWith('llm:GHI:premium');
  });

  it('writes the parsed result (not raw LLM response) to cache', async () => {
    const rawResponse = { rawField: 'this-is-raw' };
    mockGroqClient.analyze.mockResolvedValue(rawResponse);

    const parsedResult = createMockAnalysisResult('detailed');
    mockParseAIResponse.mockReturnValue(parsedResult);

    const router = new AIRouter(mockGroqClient as any);
    await router.analyzeToken(createTestInput({ compositeScore: 60 }));

    // cache.set should receive the parsed result, not the raw response
    const cachedValue = mockCacheSet.mock.calls[0][1];
    expect(cachedValue).toEqual(parsedResult);
    expect(cachedValue).not.toEqual(rawResponse);
  });

  it('returns null without caching when LLM returns null response', async () => {
    mockGroqClient.analyze.mockResolvedValue(null);
    const router = new AIRouter(mockGroqClient as any);

    const result = await router.analyzeToken(createTestInput());

    expect(result).toBeNull();
    expect(mockCacheSet).not.toHaveBeenCalled();
    expect(mockParseAIResponse).not.toHaveBeenCalled();
  });
});
