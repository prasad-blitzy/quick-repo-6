/**
 * tests/unit/ai/response-parser.test.ts — Unit Tests for Structured JSON LLM Response Parser
 *
 * Comprehensive test suite for `src/ai/response-parser.ts` covering:
 * - Valid JSON → typed AIAnalysisResult (complete response, string response, all tiers)
 * - Malformed JSON → graceful error handling (null, undefined, invalid string, empty, wrong types)
 * - Dimension scores 0-100 extracted (5 dimensions, clamping, NaN, non-numeric)
 * - Confidence level and narrative summary parsed (normalization, fallbacks, truncation)
 *
 * Per AAP Section 0.2.3: "Tests structured JSON LLM response parsing"
 * Per AAP Section 0.5.1 Group 8: "handles malformed responses gracefully"
 *
 * Testing framework: Vitest 4.1.0 with happy-dom environment.
 * All tests are fully isolated via afterEach(vi.restoreAllMocks).
 *
 * @module tests/unit/ai/response-parser.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the logger BEFORE importing the module under test.
// The response-parser imports createLogger at module load time.
// ---------------------------------------------------------------------------
vi.mock('../../../src/utils/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import {
  parseAIResponse,
  parseAIResponseStrict,
  createFallbackResult,
  getDefaultDimensions,
  validateScore,
  validateConfidence,
  validateNarrative,
} from '../../../src/ai/response-parser';
import type { AIAnalysisResult, AnalysisDimension, LLMTier } from '../../../src/ai/types';

// ---------------------------------------------------------------------------
// Test Lifecycle Hooks
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

/**
 * Complete valid LLM response fixture matching the expected JSON schema
 * from the Groq API structured output. Uses `compositeScore` as the raw
 * field name (the parser maps it to `compositeAI` in the typed result).
 */
const VALID_LLM_RESPONSE = {
  dimensions: [
    { name: 'on-chain momentum', score: 75, reasoning: 'Strong buy/sell ratio of 2.1x with increasing volume.' },
    { name: 'social velocity', score: 60, reasoning: 'Moderate social buzz with steady tweet rate.' },
    { name: 'wallet intelligence', score: 85, reasoning: '4 known profitable wallets accumulating.' },
    { name: 'liquidity health', score: 70, reasoning: 'LP burned, adequate liquidity, no bundle detection.' },
    { name: 'narrative fit', score: 55, reasoning: 'Generic meme theme, no strong narrative catalyst.' },
  ],
  compositeScore: 69,
  confidence: 'medium',
  narrative: 'Token shows strong smart money interest and healthy on-chain metrics. Moderate social presence but lacking a compelling narrative catalyst.',
  recommendation: 'BUY',
};

/**
 * 5 canonical dimension names per AAP specification.
 */
const CANONICAL_NAMES = [
  'on-chain momentum',
  'social velocity',
  'wallet intelligence',
  'liquidity health',
  'narrative fit',
];

// ===========================================================================
// Tests — parseAIResponse() Main Parser
// ===========================================================================

describe('parseAIResponse', () => {
  it('parses a complete valid JSON response into typed AIAnalysisResult', () => {
    const result: AIAnalysisResult = parseAIResponse(VALID_LLM_RESPONSE, 'fast');

    expect(result).toBeDefined();
    expect(result.dimensions).toBeInstanceOf(Array);
    expect(result.dimensions).toHaveLength(5);
    expect(result.compositeAI).toBe(69);
    expect(result.confidence).toBe('medium');
    expect(result.narrative).toContain('strong smart money interest');
    expect(result.tier).toBe('fast');
    expect(typeof result.timestamp).toBe('number');
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('parses valid JSON passed as a string (some LLMs return stringified JSON)', () => {
    const jsonStr = JSON.stringify(VALID_LLM_RESPONSE);
    const result: AIAnalysisResult = parseAIResponse(jsonStr, 'detailed');

    expect(result.dimensions).toHaveLength(5);
    expect(result.compositeAI).toBe(69);
    expect(result.confidence).toBe('medium');
    expect(result.narrative).toContain('strong smart money interest');
    expect(result.tier).toBe('detailed');
  });

  it('returns fallback result for null input (never throws)', () => {
    const result: AIAnalysisResult = parseAIResponse(null, 'fast');

    expect(result.compositeAI).toBe(50);
    expect(result.confidence).toBe('low');
    expect(result.narrative).toMatch(/unable/i);
    expect(result.tier).toBe('fast');
    expect(result.dimensions).toHaveLength(5);
    for (const dim of result.dimensions) {
      expect(dim.score).toBe(50);
    }
  });

  it('returns fallback result for undefined input (never throws)', () => {
    const result: AIAnalysisResult = parseAIResponse(undefined, 'premium');

    expect(result.compositeAI).toBe(50);
    expect(result.confidence).toBe('low');
    expect(result.tier).toBe('premium');
    expect(result.dimensions).toHaveLength(5);
  });

  it('returns fallback result for invalid JSON string', () => {
    const result: AIAnalysisResult = parseAIResponse('this is not valid json {{', 'fast');

    expect(result.compositeAI).toBe(50);
    expect(result.confidence).toBe('low');
    expect(result.tier).toBe('fast');
  });

  it('returns fallback result for empty string', () => {
    const result: AIAnalysisResult = parseAIResponse('', 'detailed');

    expect(result.compositeAI).toBe(50);
    expect(result.confidence).toBe('low');
    expect(result.tier).toBe('detailed');
  });

  it('handles response with empty dimensions array', () => {
    const input = { dimensions: [], compositeScore: 70, confidence: 'high', narrative: 'test' };
    const result: AIAnalysisResult = parseAIResponse(input, 'fast');

    // Empty dimensions array triggers default dimensions fill
    expect(result.dimensions).toHaveLength(5);
    // Explicit compositeScore from the response is used (70, not the average 50)
    expect(result.compositeAI).toBe(70);
  });

  it('handles response with missing dimensions field entirely', () => {
    const input = { compositeScore: 65, confidence: 'high', narrative: 'test' };
    const result: AIAnalysisResult = parseAIResponse(input, 'fast');

    // Missing dimensions → 5 default dimensions
    expect(result.dimensions).toHaveLength(5);
    // Explicit compositeScore is used
    expect(result.compositeAI).toBe(65);
  });

  it('handles response with partial dimensions (fewer than 5)', () => {
    const partial = {
      dimensions: [
        { name: 'on-chain momentum', score: 80, reasoning: 'Good' },
        { name: 'social velocity', score: 60, reasoning: 'OK' },
        { name: 'wallet intelligence', score: 90, reasoning: 'Great' },
      ],
      compositeScore: 77,
      confidence: 'high',
      narrative: 'Partial analysis',
    };
    const result: AIAnalysisResult = parseAIResponse(partial, 'detailed');

    // The 3 provided dimensions should have their original scores
    const onChain = result.dimensions.find(d => d.name === 'on-chain momentum');
    const social = result.dimensions.find(d => d.name === 'social velocity');
    const wallet = result.dimensions.find(d => d.name === 'wallet intelligence');
    expect(onChain?.score).toBe(80);
    expect(social?.score).toBe(60);
    expect(wallet?.score).toBe(90);

    // Missing canonical dimensions should be filled with defaults
    const liquidity = result.dimensions.find(d => d.name === 'liquidity health');
    const narrative = result.dimensions.find(d => d.name === 'narrative fit');
    expect(liquidity?.score).toBe(50);
    expect(narrative?.score).toBe(50);

    // Total should have all 5+ dimensions
    expect(result.dimensions.length).toBeGreaterThanOrEqual(5);
  });

  it('preserves the LLMTier parameter correctly for each tier', () => {
    const tiers: LLMTier[] = ['fast', 'detailed', 'premium'];
    for (const tier of tiers) {
      const result = parseAIResponse(VALID_LLM_RESPONSE, tier);
      expect(result.tier).toBe(tier);
    }
  });

  it('timestamp is set to approximately Date.now()', () => {
    const before = Date.now();
    const result: AIAnalysisResult = parseAIResponse(VALID_LLM_RESPONSE, 'fast');
    const after = Date.now();

    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });

  it('handles LLM response with extra/unknown fields gracefully', () => {
    const input = {
      ...VALID_LLM_RESPONSE,
      extraField: 'ignored',
      anotherExtra: 123,
      deepNested: { a: { b: { c: true } } },
    };
    const result: AIAnalysisResult = parseAIResponse(input, 'fast');

    expect(result.compositeAI).toBe(69);
    expect(result.confidence).toBe('medium');
    expect(result.dimensions).toHaveLength(5);
  });
});

// ===========================================================================
// Tests — Dimension Parsing within parseAIResponse
// ===========================================================================

describe('dimension parsing within parseAIResponse', () => {
  it('all 5 canonical dimension names are present in default dimensions', () => {
    const dims: AnalysisDimension[] = getDefaultDimensions();
    const names = dims.map(d => d.name);

    for (const canonical of CANONICAL_NAMES) {
      expect(names).toContain(canonical);
    }
  });

  it('dimension scores are correctly extracted (0-100 range)', () => {
    const input = {
      dimensions: [
        { name: 'on-chain momentum', score: 0, reasoning: 'Worst' },
        { name: 'social velocity', score: 25, reasoning: 'Low' },
        { name: 'wallet intelligence', score: 50, reasoning: 'Mid' },
        { name: 'liquidity health', score: 75, reasoning: 'Good' },
        { name: 'narrative fit', score: 100, reasoning: 'Best' },
      ],
      compositeScore: 50,
      confidence: 'medium',
      narrative: 'Test',
    };
    const result = parseAIResponse(input, 'fast');

    const scores = result.dimensions.map(d => d.score);
    expect(scores).toContain(0);
    expect(scores).toContain(25);
    expect(scores).toContain(50);
    expect(scores).toContain(75);
    expect(scores).toContain(100);
  });

  it('dimension score above 100 is clamped to 100', () => {
    const input = {
      dimensions: [
        { name: 'on-chain momentum', score: 150, reasoning: 'Over max' },
        { name: 'social velocity', score: 60, reasoning: 'OK' },
        { name: 'wallet intelligence', score: 70, reasoning: 'OK' },
        { name: 'liquidity health', score: 80, reasoning: 'OK' },
        { name: 'narrative fit', score: 90, reasoning: 'OK' },
      ],
      compositeScore: 80,
      confidence: 'high',
      narrative: 'Test',
    };
    const result = parseAIResponse(input, 'fast');

    const onChain = result.dimensions.find(d => d.name === 'on-chain momentum');
    expect(onChain?.score).toBe(100);
  });

  it('dimension score below 0 is clamped to 0', () => {
    const input = {
      dimensions: [
        { name: 'on-chain momentum', score: -10, reasoning: 'Under min' },
        { name: 'social velocity', score: 50, reasoning: 'OK' },
        { name: 'wallet intelligence', score: 50, reasoning: 'OK' },
        { name: 'liquidity health', score: 50, reasoning: 'OK' },
        { name: 'narrative fit', score: 50, reasoning: 'OK' },
      ],
      compositeScore: 40,
      confidence: 'medium',
      narrative: 'Test',
    };
    const result = parseAIResponse(input, 'fast');

    const onChain = result.dimensions.find(d => d.name === 'on-chain momentum');
    expect(onChain?.score).toBe(0);
  });

  it('dimension with NaN score gets fallback value of 50', () => {
    const input = {
      dimensions: [
        { name: 'on-chain momentum', score: NaN, reasoning: 'Bad score' },
        { name: 'social velocity', score: 60, reasoning: 'OK' },
        { name: 'wallet intelligence', score: 70, reasoning: 'OK' },
        { name: 'liquidity health', score: 80, reasoning: 'OK' },
        { name: 'narrative fit', score: 55, reasoning: 'OK' },
      ],
      compositeScore: 50,
      confidence: 'medium',
      narrative: 'Test',
    };
    const result = parseAIResponse(input, 'fast');

    const onChain = result.dimensions.find(d => d.name === 'on-chain momentum');
    expect(onChain?.score).toBe(50);
  });

  it('dimension with non-numeric score (string) gets fallback value', () => {
    const input = {
      dimensions: [
        { name: 'on-chain momentum', score: 'high' as unknown as number, reasoning: 'Bad type' },
        { name: 'social velocity', score: 60, reasoning: 'OK' },
        { name: 'wallet intelligence', score: 70, reasoning: 'OK' },
        { name: 'liquidity health', score: 80, reasoning: 'OK' },
        { name: 'narrative fit', score: 55, reasoning: 'OK' },
      ],
      compositeScore: 50,
      confidence: 'medium',
      narrative: 'Test',
    };
    const result = parseAIResponse(input, 'fast');

    // 'high' is a non-numeric string that can't be parsed to a valid number
    // validateScore will return fallback since Number('high') is NaN
    const onChain = result.dimensions.find(d => d.name === 'on-chain momentum');
    expect(onChain?.score).toBe(50);
  });

  it('dimension with missing reasoning gets default fallback string', () => {
    const input = {
      dimensions: [
        { name: 'on-chain momentum', score: 75 },
        { name: 'social velocity', score: 60, reasoning: 'OK' },
        { name: 'wallet intelligence', score: 70, reasoning: 'OK' },
        { name: 'liquidity health', score: 80, reasoning: 'OK' },
        { name: 'narrative fit', score: 55, reasoning: 'OK' },
      ],
      compositeScore: 50,
      confidence: 'medium',
      narrative: 'Test',
    };
    const result = parseAIResponse(input, 'fast');

    const onChain = result.dimensions.find(d => d.name === 'on-chain momentum');
    expect(onChain?.reasoning).toMatch(/no data available/i);
  });

  it('dimension with empty name is skipped (extractDimensionName rejects empty)', () => {
    const input = {
      dimensions: [
        { name: '', score: 99, reasoning: 'Empty name' },
        { name: 'social velocity', score: 60, reasoning: 'OK' },
        { name: 'wallet intelligence', score: 70, reasoning: 'OK' },
        { name: 'liquidity health', score: 80, reasoning: 'OK' },
        { name: 'narrative fit', score: 55, reasoning: 'OK' },
      ],
      compositeScore: 50,
      confidence: 'medium',
      narrative: 'Test',
    };
    const result = parseAIResponse(input, 'fast');

    // Empty name dimension is rejected; missing canonical dimensions get defaults
    const emptyNameDim = result.dimensions.find(d => d.name === '');
    expect(emptyNameDim).toBeUndefined();

    // 'on-chain momentum' should be added as a default since it was missing
    const onChain = result.dimensions.find(d => d.name === 'on-chain momentum');
    expect(onChain).toBeDefined();
    expect(onChain?.score).toBe(50);
  });
});

// ===========================================================================
// Tests — validateScore()
// ===========================================================================

describe('validateScore', () => {
  it('returns the raw score when it is a valid number in range', () => {
    expect(validateScore(75, 50)).toBe(75);
  });

  it('clamps score above 100 to 100', () => {
    expect(validateScore(150, 50)).toBe(100);
  });

  it('clamps score below 0 to 0', () => {
    expect(validateScore(-20, 50)).toBe(0);
  });

  it('returns fallback for NaN', () => {
    expect(validateScore(NaN, 50)).toBe(50);
  });

  it('returns fallback for undefined', () => {
    expect(validateScore(undefined, 60)).toBe(60);
  });

  it('returns fallback for null', () => {
    expect(validateScore(null, 45)).toBe(45);
  });

  it('returns fallback for non-numeric string input', () => {
    expect(validateScore('high', 50)).toBe(50);
  });

  it('preserves 0 as a valid score (not treated as falsy)', () => {
    expect(validateScore(0, 50)).toBe(0);
  });

  it('preserves 100 as a valid score', () => {
    expect(validateScore(100, 50)).toBe(100);
  });

  it('handles float values correctly (rounds via Math.round in clampScore)', () => {
    // clampScore uses Math.round: 72.5 → 73
    expect(validateScore(72.5, 50)).toBe(73);
  });

  it('parses numeric string values correctly', () => {
    // String '75' → Number('75') = 75 → clampScore(75) = 75
    expect(validateScore('75', 50)).toBe(75);
  });

  it('returns fallback for empty string', () => {
    expect(validateScore('', 50)).toBe(50);
  });

  it('returns fallback for Infinity', () => {
    expect(validateScore(Infinity, 50)).toBe(50);
  });

  it('returns fallback for -Infinity', () => {
    expect(validateScore(-Infinity, 50)).toBe(50);
  });

  it('returns fallback for boolean true', () => {
    expect(validateScore(true, 50)).toBe(50);
  });

  it('returns fallback for object input', () => {
    expect(validateScore({}, 50)).toBe(50);
  });

  it('uses default fallback of 50 when no fallback provided', () => {
    expect(validateScore(null)).toBe(50);
  });
});

// ===========================================================================
// Tests — validateConfidence()
// ===========================================================================

describe('validateConfidence', () => {
  it('recognizes "high" as-is', () => {
    expect(validateConfidence('high')).toBe('high');
  });

  it('recognizes "medium" as-is', () => {
    expect(validateConfidence('medium')).toBe('medium');
  });

  it('recognizes "low" as-is', () => {
    expect(validateConfidence('low')).toBe('low');
  });

  it('normalizes uppercase "HIGH" to "high"', () => {
    expect(validateConfidence('HIGH')).toBe('high');
  });

  it('normalizes mixed case "Medium" to "medium"', () => {
    expect(validateConfidence('Medium')).toBe('medium');
  });

  it('normalizes "LOW" to "low"', () => {
    expect(validateConfidence('LOW')).toBe('low');
  });

  it('normalizes "moderate" to "medium"', () => {
    expect(validateConfidence('moderate')).toBe('medium');
  });

  it('normalizes "very high" to "high"', () => {
    expect(validateConfidence('very high')).toBe('high');
  });

  it('maps "uncertain" to "low" (via CONFIDENCE_MAP)', () => {
    // 'uncertain' is explicitly mapped to 'low' in the implementation's CONFIDENCE_MAP
    expect(validateConfidence('uncertain')).toBe('low');
  });

  it('returns "medium" for truly unrecognized string', () => {
    expect(validateConfidence('xyzzy')).toBe('medium');
  });

  it('returns "medium" for null input', () => {
    expect(validateConfidence(null)).toBe('medium');
  });

  it('returns "medium" for undefined input', () => {
    expect(validateConfidence(undefined)).toBe('medium');
  });

  it('returns "medium" for numeric input', () => {
    expect(validateConfidence(42)).toBe('medium');
  });

  it('returns "medium" for empty string', () => {
    expect(validateConfidence('')).toBe('medium');
  });

  it('normalizes "strong" to "high"', () => {
    expect(validateConfidence('strong')).toBe('high');
  });

  it('normalizes "weak" to "low"', () => {
    expect(validateConfidence('weak')).toBe('low');
  });

  it('normalizes "neutral" to "medium"', () => {
    expect(validateConfidence('neutral')).toBe('medium');
  });

  it('normalizes "confident" to "high"', () => {
    expect(validateConfidence('confident')).toBe('high');
  });

  it('returns "medium" for boolean input', () => {
    expect(validateConfidence(true)).toBe('medium');
  });
});

// ===========================================================================
// Tests — validateNarrative()
// ===========================================================================

describe('validateNarrative', () => {
  it('returns narrative when it is a non-empty string', () => {
    const result = validateNarrative('Token shows strong buy pressure.', undefined);
    expect(result).toBe('Token shows strong buy pressure.');
  });

  it('falls back to recommendation when narrative is missing (undefined)', () => {
    const result = validateNarrative(undefined, 'BUY');
    expect(result).toBe('BUY');
  });

  it('falls back to recommendation when narrative is null', () => {
    const result = validateNarrative(null, 'SKIP');
    expect(result).toBe('SKIP');
  });

  it('returns generic fallback when both narrative and recommendation are missing', () => {
    const result = validateNarrative(undefined, undefined);
    expect(result).toMatch(/analysis completed/i);
  });

  it('returns generic fallback for empty string narrative with no recommendation', () => {
    const result = validateNarrative('', undefined);
    expect(result).toMatch(/analysis completed/i);
  });

  it('truncates long narratives to max 500 characters', () => {
    const longText = 'A'.repeat(1000);
    const result = validateNarrative(longText, undefined);
    expect(result.length).toBeLessThanOrEqual(500);
    // Truncated strings end with '...'
    expect(result).toMatch(/\.\.\.$/);
  });

  it('handles null narrative and null recommendation gracefully', () => {
    const result = validateNarrative(null, null);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles non-string narrative input (number)', () => {
    const result = validateNarrative(123, undefined);
    expect(typeof result).toBe('string');
    expect(result).toMatch(/analysis completed/i);
  });

  it('handles non-string narrative input (boolean)', () => {
    const result = validateNarrative(true, undefined);
    expect(typeof result).toBe('string');
    expect(result).toMatch(/analysis completed/i);
  });

  it('preserves narrative of exactly 500 characters without truncation', () => {
    const exactText = 'B'.repeat(500);
    const result = validateNarrative(exactText, undefined);
    expect(result.length).toBe(500);
    expect(result).toBe(exactText);
  });

  it('uses recommendation when narrative is whitespace only', () => {
    const result = validateNarrative('   ', 'Fallback recommendation.');
    expect(result).toBe('Fallback recommendation.');
  });
});

// ===========================================================================
// Tests — createFallbackResult()
// ===========================================================================

describe('createFallbackResult', () => {
  it('returns AIAnalysisResult with neutral score 50', () => {
    const result: AIAnalysisResult = createFallbackResult('fast');
    expect(result.compositeAI).toBe(50);
  });

  it('returns confidence "low"', () => {
    const result: AIAnalysisResult = createFallbackResult('fast');
    expect(result.confidence).toBe('low');
  });

  it('returns narrative indicating analysis failed', () => {
    const result: AIAnalysisResult = createFallbackResult('fast');
    expect(result.narrative).toMatch(/unable/i);
  });

  it('returns 5 default dimensions each with score 50', () => {
    const result: AIAnalysisResult = createFallbackResult('detailed');
    expect(result.dimensions).toHaveLength(5);
    for (const dim of result.dimensions) {
      expect(dim.score).toBe(50);
    }
  });

  it('preserves the tier parameter for all tiers', () => {
    const tiers: LLMTier[] = ['fast', 'detailed', 'premium'];
    for (const tier of tiers) {
      const result = createFallbackResult(tier);
      expect(result.tier).toBe(tier);
    }
  });

  it('sets a valid timestamp close to Date.now()', () => {
    const before = Date.now();
    const result: AIAnalysisResult = createFallbackResult('fast');
    const after = Date.now();

    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });

  it('fallback dimensions contain all 5 canonical dimension names', () => {
    const result: AIAnalysisResult = createFallbackResult('fast');
    const names = result.dimensions.map(d => d.name);
    for (const canonical of CANONICAL_NAMES) {
      expect(names).toContain(canonical);
    }
  });

  it('fallback dimensions have reasoning text', () => {
    const result: AIAnalysisResult = createFallbackResult('fast');
    for (const dim of result.dimensions) {
      expect(typeof dim.reasoning).toBe('string');
      expect(dim.reasoning.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// Tests — getDefaultDimensions()
// ===========================================================================

describe('getDefaultDimensions', () => {
  it('returns exactly 5 dimensions', () => {
    const dims: AnalysisDimension[] = getDefaultDimensions();
    expect(dims).toHaveLength(5);
  });

  it('contains all 5 canonical dimension names per AAP', () => {
    const dims = getDefaultDimensions();
    const names = dims.map(d => d.name);

    expect(names).toContain('on-chain momentum');
    expect(names).toContain('social velocity');
    expect(names).toContain('wallet intelligence');
    expect(names).toContain('liquidity health');
    expect(names).toContain('narrative fit');
  });

  it('all default scores are 50', () => {
    const dims = getDefaultDimensions();
    for (const dim of dims) {
      expect(dim.score).toBe(50);
    }
  });

  it('all default reasoning is "No data available"', () => {
    const dims = getDefaultDimensions();
    for (const dim of dims) {
      expect(dim.reasoning).toBe('No data available');
    }
  });

  it('returns a new array each time (not the same reference)', () => {
    const a = getDefaultDimensions();
    const b = getDefaultDimensions();
    expect(a).not.toBe(b);
    // Also verify individual dimension objects are different references
    expect(a[0]).not.toBe(b[0]);
  });
});

// ===========================================================================
// Tests — parseAIResponseStrict()
// ===========================================================================

describe('parseAIResponseStrict', () => {
  it('returns valid AIAnalysisResult for valid input', () => {
    const result = parseAIResponseStrict(VALID_LLM_RESPONSE, 'fast');

    expect(result).not.toBeNull();
    expect(result!.dimensions).toHaveLength(5);
    expect(result!.compositeAI).toBe(69);
    expect(result!.confidence).toBe('medium');
    expect(result!.tier).toBe('fast');
    expect(result!.timestamp).toBeGreaterThan(0);
  });

  it('returns null for null input (strict mode)', () => {
    const result = parseAIResponseStrict(null, 'fast');
    expect(result).toBeNull();
  });

  it('returns null for undefined input', () => {
    const result = parseAIResponseStrict(undefined, 'fast');
    expect(result).toBeNull();
  });

  it('returns null for invalid JSON string', () => {
    const result = parseAIResponseStrict('invalid json {{{', 'fast');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = parseAIResponseStrict('', 'fast');
    expect(result).toBeNull();
  });

  it('returns null for missing critical fields (empty object)', () => {
    const result = parseAIResponseStrict({}, 'fast');
    expect(result).toBeNull();
  });

  it('returns null for empty dimensions array', () => {
    const input = { dimensions: [], compositeScore: 50, confidence: 'high', narrative: 'test' };
    const result = parseAIResponseStrict(input, 'fast');
    expect(result).toBeNull();
  });

  it('returns non-null for valid input passed as JSON string', () => {
    const jsonStr = JSON.stringify(VALID_LLM_RESPONSE);
    const result = parseAIResponseStrict(jsonStr, 'detailed');
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('detailed');
  });

  it('returns null for number input', () => {
    const result = parseAIResponseStrict(42, 'fast');
    expect(result).toBeNull();
  });

  it('returns null for boolean input', () => {
    const result = parseAIResponseStrict(true, 'fast');
    expect(result).toBeNull();
  });

  it('returns null for array input', () => {
    const result = parseAIResponseStrict([1, 2, 3], 'fast');
    expect(result).toBeNull();
  });
});

// ===========================================================================
// Tests — Edge Cases and Regression Prevention
// ===========================================================================

describe('edge cases', () => {
  it('number 0 for compositeScore is preserved (not treated as falsy)', () => {
    const input = { ...VALID_LLM_RESPONSE, compositeScore: 0 };
    const result: AIAnalysisResult = parseAIResponse(input, 'fast');

    // 0 is a valid score and should NOT be replaced by the fallback
    expect(result.compositeAI).toBe(0);
  });

  it('handles LLM response that is an array (wrong top-level type)', () => {
    const result: AIAnalysisResult = parseAIResponse([1, 2, 3], 'fast');

    // Arrays are objects in JS, but parseDimensions handles non-arrays;
    // the parser should treat this as an empty/invalid response
    expect(result).toBeDefined();
    expect(result.compositeAI).toBeGreaterThanOrEqual(0);
    expect(result.compositeAI).toBeLessThanOrEqual(100);
    expect(result.tier).toBe('fast');
  });

  it('handles LLM response that is a plain number', () => {
    const result: AIAnalysisResult = parseAIResponse(42, 'fast');

    expect(result.compositeAI).toBe(50);
    expect(result.confidence).toBe('low');
    expect(result.tier).toBe('fast');
  });

  it('handles LLM response that is a boolean', () => {
    const result: AIAnalysisResult = parseAIResponse(true, 'fast');

    expect(result.compositeAI).toBe(50);
    expect(result.confidence).toBe('low');
    expect(result.tier).toBe('fast');
  });

  it('dimension with score as string number is handled via validateScore', () => {
    const input = {
      dimensions: [
        { name: 'on-chain momentum', score: '75' as unknown as number, reasoning: 'OK' },
        { name: 'social velocity', score: 60, reasoning: 'OK' },
        { name: 'wallet intelligence', score: 70, reasoning: 'OK' },
        { name: 'liquidity health', score: 80, reasoning: 'OK' },
        { name: 'narrative fit', score: 55, reasoning: 'OK' },
      ],
      compositeScore: 68,
      confidence: 'medium',
      narrative: 'Test',
    };
    const result = parseAIResponse(input, 'fast');

    // validateScore parses '75' → 75
    const onChain = result.dimensions.find(d => d.name === 'on-chain momentum');
    expect(onChain?.score).toBe(75);
  });

  it('empty object response returns fallback with defaults', () => {
    const result: AIAnalysisResult = parseAIResponse({}, 'fast');

    expect(result.dimensions).toHaveLength(5);
    expect(result.compositeAI).toBe(50);
    expect(result.tier).toBe('fast');
  });

  it('no exceptions thrown for any input type', () => {
    const inputs: unknown[] = [null, undefined, '', 0, false, [], {}, NaN, Infinity];

    for (const input of inputs) {
      // parseAIResponse should NEVER throw
      expect(() => parseAIResponse(input, 'fast')).not.toThrow();

      // parseAIResponseStrict should NEVER throw either
      expect(() => parseAIResponseStrict(input, 'fast')).not.toThrow();
    }
  });

  it('handles response with alternative field name overall_score', () => {
    const input = {
      dimensions: VALID_LLM_RESPONSE.dimensions,
      overall_score: 72,
      confidence: 'high',
      narrative: 'Test with alternative field',
    };
    const result = parseAIResponse(input, 'fast');

    expect(result.compositeAI).toBe(72);
  });

  it('handles response with alternative field name composite_score', () => {
    const input = {
      dimensions: VALID_LLM_RESPONSE.dimensions,
      composite_score: 66,
      confidence: 'medium',
      narrative: 'Test with snake_case field',
    };
    const result = parseAIResponse(input, 'fast');

    expect(result.compositeAI).toBe(66);
  });

  it('handles deeply nested invalid dimension objects gracefully', () => {
    const input = {
      dimensions: [
        null,
        undefined,
        42,
        'not an object',
        { name: 'on-chain momentum', score: 80, reasoning: 'Valid one' },
      ],
      compositeScore: 60,
      confidence: 'medium',
      narrative: 'Mixed',
    };
    const result = parseAIResponse(input, 'fast');

    // Only the valid dimension should be parsed; missing canonicals filled with defaults
    const onChain = result.dimensions.find(d => d.name === 'on-chain momentum');
    expect(onChain?.score).toBe(80);
    expect(result.dimensions.length).toBeGreaterThanOrEqual(5);
  });

  it('handles dimension with alternative reasoning field names (explanation)', () => {
    const input = {
      dimensions: [
        { name: 'on-chain momentum', score: 70, explanation: 'Via explanation field' },
        { name: 'social velocity', score: 60, reasoning: 'OK' },
        { name: 'wallet intelligence', score: 70, reasoning: 'OK' },
        { name: 'liquidity health', score: 80, reasoning: 'OK' },
        { name: 'narrative fit', score: 55, reasoning: 'OK' },
      ],
      compositeScore: 67,
      confidence: 'medium',
      narrative: 'Test',
    };
    const result = parseAIResponse(input, 'fast');

    const onChain = result.dimensions.find(d => d.name === 'on-chain momentum');
    expect(onChain?.reasoning).toBe('Via explanation field');
  });

  it('handles dimension with alternative reasoning field names (analysis)', () => {
    const input = {
      dimensions: [
        { name: 'on-chain momentum', score: 70, analysis: 'Via analysis field' },
        { name: 'social velocity', score: 60, reasoning: 'OK' },
        { name: 'wallet intelligence', score: 70, reasoning: 'OK' },
        { name: 'liquidity health', score: 80, reasoning: 'OK' },
        { name: 'narrative fit', score: 55, reasoning: 'OK' },
      ],
      compositeScore: 67,
      confidence: 'medium',
      narrative: 'Test',
    };
    const result = parseAIResponse(input, 'fast');

    const onChain = result.dimensions.find(d => d.name === 'on-chain momentum');
    expect(onChain?.reasoning).toBe('Via analysis field');
  });

  it('score 100 at boundary is preserved exactly', () => {
    expect(validateScore(100, 50)).toBe(100);
  });

  it('score exactly at 0 boundary is preserved exactly', () => {
    expect(validateScore(0, 50)).toBe(0);
  });

  it('compositeScore prioritized over overall_score when both present', () => {
    const input = {
      dimensions: VALID_LLM_RESPONSE.dimensions,
      compositeScore: 80,
      overall_score: 60,
      confidence: 'high',
      narrative: 'Test priority',
    };
    const result = parseAIResponse(input, 'fast');

    // compositeScore should be used (it's checked first)
    expect(result.compositeAI).toBe(80);
  });
});
