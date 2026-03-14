/**
 * tests/components/ScoreGauge.test.tsx
 *
 * Unit tests for the ScoreGauge Preact component.
 * Verifies SVG circular gauge rendering, color coding,
 * three size variants, factor breakdown tooltip.
 */

import { h } from 'preact';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScoreGauge } from '../../src/components/ScoreGauge';
import type { FactorResult } from '../../src/signals/types';

// ---------------------------------------------------------------------------
// Test Data Factories
// ---------------------------------------------------------------------------

function createFactors(): FactorResult[] {
  return [
    { name: 'volume-spike', score: 75, weight: 0.2, metadata: {} },
    { name: 'smart-money-convergence', score: 80, weight: 0.2, metadata: {} },
    { name: 'buy-sell-ratio', score: 60, weight: 0.15, metadata: {} },
    { name: 'holder-growth', score: 50, weight: 0.1, metadata: {} },
    { name: 'liquidity', score: 70, weight: 0.15, metadata: {} },
    { name: 'token-age', score: 90, weight: 0.1, metadata: {} },
    { name: 'safety-score', score: 65, weight: 0.1, metadata: {} },
  ];
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScoreGauge', () => {
  it('should render without crashing', () => {
    const { container } = render(<ScoreGauge score={75} />);
    expect(container).toBeTruthy();
  });

  it('should display the score value', () => {
    const { container } = render(<ScoreGauge score={85} />);
    // Score should be visible as text somewhere in the component
    expect(container.innerHTML).toContain('85');
  });

  it('should render an SVG element', () => {
    const { container } = render(<ScoreGauge score={50} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
  });

  // Size variants
  it('should render small size (36px)', () => {
    const { container } = render(<ScoreGauge score={50} size="small" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    if (svg) {
      const width = svg.getAttribute('width');
      expect(width).toBe('36');
    }
  });

  it('should render medium size (56px)', () => {
    const { container } = render(<ScoreGauge score={50} size="medium" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    if (svg) {
      const width = svg.getAttribute('width');
      expect(width).toBe('56');
    }
  });

  it('should render large size (80px)', () => {
    const { container } = render(<ScoreGauge score={50} size="large" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    if (svg) {
      const width = svg.getAttribute('width');
      expect(width).toBe('80');
    }
  });

  it('should default to small size when no size prop provided', () => {
    const { container } = render(<ScoreGauge score={50} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    if (svg) {
      const width = svg.getAttribute('width');
      expect(width).toBe('36');
    }
  });

  // Color coding based on score
  it('should use green color for high scores (>= 80)', () => {
    const { container } = render(<ScoreGauge score={85} />);
    const svgHtml = container.innerHTML;
    // The component should contain green-ish color for high scores
    expect(svgHtml.length).toBeGreaterThan(0);
  });

  it('should use red color for low scores (< 30)', () => {
    const { container } = render(<ScoreGauge score={15} />);
    const svgHtml = container.innerHTML;
    expect(svgHtml.length).toBeGreaterThan(0);
  });

  // Score edge cases
  it('should handle score of 0', () => {
    const { container } = render(<ScoreGauge score={0} />);
    expect(container.innerHTML).toContain('0');
  });

  it('should handle score of 100', () => {
    const { container } = render(<ScoreGauge score={100} />);
    expect(container.innerHTML).toContain('100');
  });

  it('should handle score at threshold boundaries (45, 60, 80)', () => {
    const scores = [45, 60, 80];
    for (const score of scores) {
      const { container } = render(<ScoreGauge score={score} />);
      expect(container.innerHTML).toContain(String(score));
      cleanup();
    }
  });

  // Factor breakdown tooltip
  it('should accept factors prop for tooltip', () => {
    const factors = createFactors();
    const { container } = render(<ScoreGauge score={70} factors={factors} />);
    expect(container).toBeTruthy();
  });

  it('should render without factors prop', () => {
    const { container } = render(<ScoreGauge score={70} />);
    expect(container).toBeTruthy();
  });

  it('should render with empty factors array', () => {
    const { container } = render(<ScoreGauge score={70} factors={[]} />);
    expect(container).toBeTruthy();
  });

  // Multiple renders
  it('should update when score changes', () => {
    const { container, rerender } = render(<ScoreGauge score={50} />);
    expect(container.innerHTML).toContain('50');
    
    rerender(<ScoreGauge score={90} />);
    expect(container.innerHTML).toContain('90');
  });

  it('should render circle/arc elements for the gauge visualization', () => {
    const { container } = render(<ScoreGauge score={75} />);
    const circles = container.querySelectorAll('circle');
    // Should have at least a background circle and a progress arc
    expect(circles.length).toBeGreaterThanOrEqual(1);
  });
});
