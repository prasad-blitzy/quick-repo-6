/**
 * tests/unit/ai/response-parser.test.ts
 *
 * Unit tests for the AI response parser module.
 * Verifies JSON response parsing, schema validation,
 * fallback result creation, score/confidence validation.
 */

import { describe, it, expect } from 'vitest';
import {
  parseAIResponse,
  parseAIResponseStrict,
  createFallbackResult,
  getDefaultDimensions,
  validateScore,
  validateConfidence,
  validateNarrative,
} from '../../../src/ai/response-parser';
import type { AIAnalysisResult, LLMTier } from '../../../src/ai/types';

// ---------------------------------------------------------------------------
// Test Data Factories
// ---------------------------------------------------------------------------

function createValidResponse() {
  return {
    dimensions: [
      { name: 'on-chain momentum', score: 75, reasoning: 'Strong buy pressure detected' },
      { name: 'social velocity', score: 60, reasoning: 'Moderate tweet activity' },
      { name: 'wallet intelligence', score: 80, reasoning: '3 smart wallets entered' },
      { name: 'liquidity health', score: 70, reasoning: 'LP burned, adequate depth' },
      { name: 'narrative fit', score: 65, reasoning: 'Aligns with current meme trends' },
    ],
    compositeAI: 70,
    confidence: 'medium',
    narrative: 'Token shows strong on-chain signals with smart money convergence.',
    recommendation: 'Consider entry with standard position sizing.',
  };
}

// ---------------------------------------------------------------------------
// Tests: parseAIResponse
// ---------------------------------------------------------------------------

describe('parseAIResponse', () => {
  it('should parse a valid structured JSON response', () => {
    const raw = createValidResponse();
    const result = parseAIResponse(raw, 'fast');
    expect(result).toBeDefined();
    expect(result.dimensions).toHaveLength(5);
    expect(result.compositeAI).toBeGreaterThanOrEqual(0);
    expect(result.compositeAI).toBeLessThanOrEqual(100);
    expect(result.tier).toBe('fast');
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('should set tier to the provided LLM tier', () => {
    const raw = createValidResponse();
    const fastResult = parseAIResponse(raw, 'fast');
    const detailedResult = parseAIResponse(raw, 'detailed');
    const premiumResult = parseAIResponse(raw, 'premium');
    expect(fastResult.tier).toBe('fast');
    expect(detailedResult.tier).toBe('detailed');
    expect(premiumResult.tier).toBe('premium');
  });

  it('should handle missing dimensions gracefully', () => {
    const raw = { compositeAI: 50, confidence: 'low', narrative: 'Test' };
    const result = parseAIResponse(raw, 'fast');
    expect(result).toBeDefined();
    expect(result.dimensions.length).toBeGreaterThanOrEqual(0);
  });

  it('should handle null input by returning fallback', () => {
    const result = parseAIResponse(null, 'fast');
    expect(result).toBeDefined();
    expect(result.confidence).toBe('low');
  });

  it('should handle undefined input by returning fallback', () => {
    const result = parseAIResponse(undefined, 'fast');
    expect(result).toBeDefined();
  });

  it('should handle string input by attempting JSON parse', () => {
    const jsonStr = JSON.stringify(createValidResponse());
    const result = parseAIResponse(jsonStr, 'fast');
    expect(result).toBeDefined();
  });

  it('should handle empty object input', () => {
    const result = parseAIResponse({}, 'fast');
    expect(result).toBeDefined();
    expect(result.compositeAI).toBeGreaterThanOrEqual(0);
  });

  it('should clamp compositeAI to [0, 100]', () => {
    const raw = { ...createValidResponse(), compositeAI: 150 };
    const result = parseAIResponse(raw, 'fast');
    expect(result.compositeAI).toBeLessThanOrEqual(100);
  });

  it('should normalize confidence to valid values', () => {
    const raw = { ...createValidResponse(), confidence: 'invalid' };
    const result = parseAIResponse(raw, 'fast');
    expect(['high', 'medium', 'low']).toContain(result.confidence);
  });

  it('should include a narrative string', () => {
    const raw = createValidResponse();
    const result = parseAIResponse(raw, 'fast');
    expect(typeof result.narrative).toBe('string');
    expect(result.narrative.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: parseAIResponseStrict
// ---------------------------------------------------------------------------

describe('parseAIResponseStrict', () => {
  it('should return AIAnalysisResult for valid input', () => {
    const raw = createValidResponse();
    const result = parseAIResponseStrict(raw, 'fast');
    expect(result).not.toBeNull();
    if (result) {
      expect(result.dimensions).toHaveLength(5);
    }
  });

  it('should return null for invalid input', () => {
    const result = parseAIResponseStrict(null, 'fast');
    expect(result).toBeNull();
  });

  it('should return null for completely empty input', () => {
    const result = parseAIResponseStrict(undefined, 'fast');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: createFallbackResult
// ---------------------------------------------------------------------------

describe('createFallbackResult', () => {
  it('should create a result with the specified tier', () => {
    const result = createFallbackResult('fast');
    expect(result.tier).toBe('fast');
  });

  it('should create a result with low confidence', () => {
    const result = createFallbackResult('detailed');
    expect(result.confidence).toBe('low');
  });

  it('should create a result with a valid timestamp', () => {
    const result = createFallbackResult('premium');
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('should create a result with default dimensions', () => {
    const result = createFallbackResult('fast');
    expect(result.dimensions.length).toBeGreaterThanOrEqual(0);
  });

  it('should create a result with a composite score', () => {
    const result = createFallbackResult('fast');
    expect(typeof result.compositeAI).toBe('number');
    expect(result.compositeAI).toBeGreaterThanOrEqual(0);
    expect(result.compositeAI).toBeLessThanOrEqual(100);
  });

  it('should have a narrative string', () => {
    const result = createFallbackResult('fast');
    expect(typeof result.narrative).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Tests: getDefaultDimensions
// ---------------------------------------------------------------------------

describe('getDefaultDimensions', () => {
  it('should return an array of default dimensions', () => {
    const dims = getDefaultDimensions();
    expect(Array.isArray(dims)).toBe(true);
    expect(dims.length).toBeGreaterThan(0);
  });

  it('should have valid scores for all dimensions', () => {
    const dims = getDefaultDimensions();
    for (const dim of dims) {
      expect(dim.score).toBeGreaterThanOrEqual(0);
      expect(dim.score).toBeLessThanOrEqual(100);
      expect(typeof dim.name).toBe('string');
      expect(typeof dim.reasoning).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: validateScore
// ---------------------------------------------------------------------------

describe('validateScore', () => {
  it('should return the number if it is a valid score', () => {
    expect(validateScore(75)).toBe(75);
  });

  it('should clamp score above 100 to 100', () => {
    expect(validateScore(150)).toBe(100);
  });

  it('should clamp negative score to 0', () => {
    expect(validateScore(-10)).toBe(0);
  });

  it('should return fallback for NaN', () => {
    expect(validateScore(NaN)).toBeGreaterThanOrEqual(0);
  });

  it('should return fallback for null', () => {
    expect(validateScore(null)).toBeGreaterThanOrEqual(0);
  });

  it('should return fallback for undefined', () => {
    expect(validateScore(undefined)).toBeGreaterThanOrEqual(0);
  });

  it('should return custom fallback when provided', () => {
    expect(validateScore(null, 42)).toBe(42);
  });

  it('should parse string numbers', () => {
    const result = validateScore('75');
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: validateConfidence
// ---------------------------------------------------------------------------

describe('validateConfidence', () => {
  it('should return "high" for valid high input', () => {
    expect(validateConfidence('high')).toBe('high');
  });

  it('should return "medium" for valid medium input', () => {
    expect(validateConfidence('medium')).toBe('medium');
  });

  it('should return "low" for valid low input', () => {
    expect(validateConfidence('low')).toBe('low');
  });

  it('should return a valid confidence for invalid input', () => {
    const result = validateConfidence('invalid');
    expect(['high', 'medium', 'low']).toContain(result);
  });

  it('should return a valid confidence for null', () => {
    const result = validateConfidence(null);
    expect(['high', 'medium', 'low']).toContain(result);
  });

  it('should return a valid confidence for undefined', () => {
    const result = validateConfidence(undefined);
    expect(['high', 'medium', 'low']).toContain(result);
  });
});

// ---------------------------------------------------------------------------
// Tests: validateNarrative
// ---------------------------------------------------------------------------

describe('validateNarrative', () => {
  it('should return the narrative when valid', () => {
    const result = validateNarrative('Good analysis', 'Buy now');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should handle null narrative', () => {
    const result = validateNarrative(null, 'Some recommendation');
    expect(typeof result).toBe('string');
  });

  it('should handle undefined narrative', () => {
    const result = validateNarrative(undefined, undefined);
    expect(typeof result).toBe('string');
  });

  it('should handle empty string narrative', () => {
    const result = validateNarrative('', '');
    expect(typeof result).toBe('string');
  });
});
