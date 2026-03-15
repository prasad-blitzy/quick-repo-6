// ---------------------------------------------------------------------------
// ScoreGauge Component — Comprehensive Test Suite
//
// Tests for the ScoreGauge Preact component verifying:
// - Composite score rendering across the full 0-100 range (boundary values)
// - Color gradient mapping across all 5 threshold bands with boundary checks
// - Three size variants (small / medium / large) with correct SVG dimensions
// - Factor-by-factor breakdown tooltip on hover, click, and keyboard interaction
// - ARIA accessibility attributes (role="meter", value semantics, tabIndex)
// - Edge cases: empty/missing factors, score clamping, NaN/Infinity, re-renders
//
// Per AAP Section 0.6.1 Test Files: Preact component rendering tests
// covering ScoreGauge alongside SignalPanel, TokenCard, SafetyBadge,
// and SettingsPanel.
//
// Uses Preact 10.29.0 (NOT React) per AAP Section 0.7.5.
// Uses @testing-library/preact 3.2.4 for render / screen / fireEvent / cleanup.
// Uses Vitest 4.1.0 with happy-dom environment.
// ---------------------------------------------------------------------------

import { h } from 'preact';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScoreGauge } from '../../src/components/ScoreGauge';
import type { FactorResult } from '../../src/signals/types';

// ---------------------------------------------------------------------------
// Test Data Factories
// ---------------------------------------------------------------------------

/**
 * Default weights keyed by factor name — mirrors the signal scoring engine's
 * default weight profile per AAP Section 0.5.1 Group 5.
 */
const FACTOR_WEIGHTS: Readonly<Record<string, number>> = {
  volumeSpike: 0.2,
  smartMoneyConvergence: 0.2,
  buySellRatio: 0.15,
  holderGrowth: 0.1,
  liquidity: 0.15,
  tokenAge: 0.1,
  safetyScore: 0.1,
};

/**
 * Standard mock FactorResult[] covering all 7 scoring factors with realistic
 * scores. Uses camelCase names matching signal engine factor module identifiers.
 */
const mockFactors: FactorResult[] = [
  { name: 'volumeSpike', score: 80, weight: 0.2, metadata: {} },
  { name: 'smartMoneyConvergence', score: 70, weight: 0.2, metadata: {} },
  { name: 'buySellRatio', score: 65, weight: 0.15, metadata: {} },
  { name: 'holderGrowth', score: 60, weight: 0.1, metadata: {} },
  { name: 'liquidity', score: 85, weight: 0.15, metadata: {} },
  { name: 'tokenAge', score: 90, weight: 0.1, metadata: {} },
  { name: 'safetyScore', score: 75, weight: 0.1, metadata: {} },
];

/**
 * Creates a mock FactorResult array with optional per-factor score overrides.
 * Always produces all 7 factors with their default weights.
 *
 * @param overrides - Map of factorName → overridden score value.
 * @returns Complete FactorResult[] with 7 entries.
 */
function createMockFactors(
  overrides: Record<string, number> = {},
): FactorResult[] {
  const defaults: Record<string, number> = {
    volumeSpike: 80,
    smartMoneyConvergence: 70,
    buySellRatio: 65,
    holderGrowth: 60,
    liquidity: 85,
    tokenAge: 90,
    safetyScore: 75,
  };
  const merged: Record<string, number> = { ...defaults, ...overrides };
  return Object.entries(merged).map(([name, score]) => ({
    name,
    score,
    weight: FACTOR_WEIGHTS[name] ?? 0.1,
    metadata: {},
  }));
}

/**
 * Returns the SVG score arc circle element from the rendered container.
 *
 * The component renders two `<circle>` elements:
 *   [0] = background track (rgba fill, no dasharray)
 *   [1] = score arc (colored stroke, stroke-dasharray)
 *
 * @param container - The rendered DOM container (Element from @testing-library/preact).
 * @returns The score arc `<circle>` element, or null if not found.
 */
function getScoreArc(container: Element): Element | null {
  const circles = container.querySelectorAll('circle');
  return circles.length >= 2 ? circles[1] : null;
}

/**
 * Helper to get the gauge wrapper element (the outermost div with role="meter").
 *
 * @param container - The rendered DOM container (Element from @testing-library/preact).
 * @returns The gauge container element, or null if not found.
 */
function getGaugeContainer(container: Element): Element | null {
  return container.querySelector('.score-gauge-container');
}

// ---------------------------------------------------------------------------
// Lifecycle — Cleanup After Each Test
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('ScoreGauge', () => {
  // =========================================================================
  // 1. Score Rendering
  // =========================================================================

  describe('score rendering', () => {
    it('renders the composite score value 75 as center text', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} />,
      );
      const textEl = container.querySelector('text');
      expect(textEl).toBeTruthy();
      expect(textEl!.textContent).toBe('75');
    });

    it('renders score 0 correctly at the minimum boundary', () => {
      const factors = createMockFactors({
        volumeSpike: 0,
        smartMoneyConvergence: 0,
        buySellRatio: 0,
        holderGrowth: 0,
        liquidity: 0,
        tokenAge: 0,
        safetyScore: 0,
      });
      const { container } = render(
        <ScoreGauge score={0} factors={factors} />,
      );
      const textEl = container.querySelector('text');
      expect(textEl).toBeTruthy();
      expect(textEl!.textContent).toBe('0');
    });

    it('renders score 100 correctly at the maximum boundary', () => {
      const factors = createMockFactors({
        volumeSpike: 100,
        smartMoneyConvergence: 100,
        buySellRatio: 100,
        holderGrowth: 100,
        liquidity: 100,
        tokenAge: 100,
        safetyScore: 100,
      });
      const { container } = render(
        <ScoreGauge score={100} factors={factors} />,
      );
      const textEl = container.querySelector('text');
      expect(textEl).toBeTruthy();
      expect(textEl!.textContent).toBe('100');
    });

    it('renders an SVG element for the gauge', () => {
      const { container } = render(
        <ScoreGauge score={50} factors={mockFactors} />,
      );
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('renders two circle elements — background track and score arc', () => {
      const { container } = render(
        <ScoreGauge score={60} factors={mockFactors} />,
      );
      const circles = container.querySelectorAll('circle');
      expect(circles.length).toBe(2);
    });

    it('updates the displayed score when re-rendered with a new value', () => {
      const { container, rerender } = render(
        <ScoreGauge score={50} factors={mockFactors} />,
      );
      expect(container.querySelector('text')!.textContent).toBe('50');

      rerender(<ScoreGauge score={90} factors={mockFactors} />);
      expect(container.querySelector('text')!.textContent).toBe('90');
    });

    it('renders score text inside the SVG element', () => {
      const { container } = render(
        <ScoreGauge score={42} factors={mockFactors} />,
      );
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
      const textEl = svg!.querySelector('text');
      expect(textEl).toBeTruthy();
      expect(textEl!.textContent).toBe('42');
    });
  });

  // =========================================================================
  // 2. Color Gradient Mapping
  // =========================================================================

  describe('color gradient mapping', () => {
    it('uses green (#22c55e) for score 85 (≥80 threshold)', () => {
      const { container } = render(
        <ScoreGauge score={85} factors={mockFactors} />,
      );
      const arc = getScoreArc(container);
      expect(arc).toBeTruthy();
      expect(arc!.getAttribute('stroke')).toBe('#22c55e');
    });

    it('uses lime (#84cc16) for score 65 (60–79 range)', () => {
      const { container } = render(
        <ScoreGauge score={65} factors={mockFactors} />,
      );
      const arc = getScoreArc(container);
      expect(arc).toBeTruthy();
      expect(arc!.getAttribute('stroke')).toBe('#84cc16');
    });

    it('uses yellow (#eab308) for score 50 (45–59 range)', () => {
      const { container } = render(
        <ScoreGauge score={50} factors={mockFactors} />,
      );
      const arc = getScoreArc(container);
      expect(arc).toBeTruthy();
      expect(arc!.getAttribute('stroke')).toBe('#eab308');
    });

    it('uses orange (#f97316) for score 35 (30–44 range)', () => {
      const { container } = render(
        <ScoreGauge score={35} factors={mockFactors} />,
      );
      const arc = getScoreArc(container);
      expect(arc).toBeTruthy();
      expect(arc!.getAttribute('stroke')).toBe('#f97316');
    });

    it('uses red (#ef4444) for score 15 (<30 range)', () => {
      const { container } = render(
        <ScoreGauge score={15} factors={mockFactors} />,
      );
      const arc = getScoreArc(container);
      expect(arc).toBeTruthy();
      expect(arc!.getAttribute('stroke')).toBe('#ef4444');
    });

    it('boundary: score exactly 80 is green (#22c55e)', () => {
      const { container } = render(
        <ScoreGauge score={80} factors={mockFactors} />,
      );
      const arc = getScoreArc(container);
      expect(arc).toBeTruthy();
      expect(arc!.getAttribute('stroke')).toBe('#22c55e');
    });

    it('boundary: score exactly 60 is lime (#84cc16)', () => {
      const { container } = render(
        <ScoreGauge score={60} factors={mockFactors} />,
      );
      const arc = getScoreArc(container);
      expect(arc).toBeTruthy();
      expect(arc!.getAttribute('stroke')).toBe('#84cc16');
    });

    it('boundary: score exactly 45 is yellow (#eab308)', () => {
      const { container } = render(
        <ScoreGauge score={45} factors={mockFactors} />,
      );
      const arc = getScoreArc(container);
      expect(arc).toBeTruthy();
      expect(arc!.getAttribute('stroke')).toBe('#eab308');
    });

    it('boundary: score exactly 30 is orange (#f97316) — not red', () => {
      const { container } = render(
        <ScoreGauge score={30} factors={mockFactors} />,
      );
      const arc = getScoreArc(container);
      expect(arc).toBeTruthy();
      expect(arc!.getAttribute('stroke')).toBe('#f97316');
    });

    it('boundary: score 29 is red (#ef4444)', () => {
      const { container } = render(
        <ScoreGauge score={29} factors={mockFactors} />,
      );
      const arc = getScoreArc(container);
      expect(arc).toBeTruthy();
      expect(arc!.getAttribute('stroke')).toBe('#ef4444');
    });

    it('boundary: score 79 is lime (#84cc16) — not green', () => {
      const { container } = render(
        <ScoreGauge score={79} factors={mockFactors} />,
      );
      const arc = getScoreArc(container);
      expect(arc).toBeTruthy();
      expect(arc!.getAttribute('stroke')).toBe('#84cc16');
    });

    it('score 0 renders with red color', () => {
      const { container } = render(
        <ScoreGauge score={0} factors={mockFactors} />,
      );
      const arc = getScoreArc(container);
      expect(arc).toBeTruthy();
      expect(arc!.getAttribute('stroke')).toBe('#ef4444');
    });

    it('score 100 renders with green color', () => {
      const { container } = render(
        <ScoreGauge score={100} factors={mockFactors} />,
      );
      const arc = getScoreArc(container);
      expect(arc).toBeTruthy();
      expect(arc!.getAttribute('stroke')).toBe('#22c55e');
    });

    it('updates color when score changes across thresholds', () => {
      const { container, rerender } = render(
        <ScoreGauge score={85} factors={mockFactors} />,
      );
      expect(getScoreArc(container)!.getAttribute('stroke')).toBe('#22c55e');

      rerender(<ScoreGauge score={25} factors={mockFactors} />);
      expect(getScoreArc(container)!.getAttribute('stroke')).toBe('#ef4444');
    });
  });

  // =========================================================================
  // 3. Size Variants
  // =========================================================================

  describe('size variants', () => {
    it('renders small size with 36px SVG dimensions', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} size="small" />,
      );
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
      expect(svg!.getAttribute('width')).toBe('36');
      expect(svg!.getAttribute('height')).toBe('36');
    });

    it('renders medium size with 56px SVG dimensions', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} size="medium" />,
      );
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
      expect(svg!.getAttribute('width')).toBe('56');
      expect(svg!.getAttribute('height')).toBe('56');
    });

    it('renders large size with 80px SVG dimensions', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} size="large" />,
      );
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
      expect(svg!.getAttribute('width')).toBe('80');
      expect(svg!.getAttribute('height')).toBe('80');
    });

    it('defaults to small size (36px) when size prop is omitted', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} />,
      );
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
      expect(svg!.getAttribute('width')).toBe('36');
      expect(svg!.getAttribute('height')).toBe('36');
    });

    it('applies gauge-small CSS class for small size', () => {
      const { container } = render(
        <ScoreGauge score={50} factors={mockFactors} size="small" />,
      );
      expect(container.querySelector('.gauge-small')).toBeTruthy();
    });

    it('applies gauge-medium CSS class for medium size', () => {
      const { container } = render(
        <ScoreGauge score={50} factors={mockFactors} size="medium" />,
      );
      expect(container.querySelector('.gauge-medium')).toBeTruthy();
    });

    it('applies gauge-large CSS class for large size', () => {
      const { container } = render(
        <ScoreGauge score={50} factors={mockFactors} size="large" />,
      );
      expect(container.querySelector('.gauge-large')).toBeTruthy();
    });

    it('displays score text in all three size variants', () => {
      for (const size of ['small', 'medium', 'large'] as const) {
        const { container } = render(
          <ScoreGauge score={42} factors={mockFactors} size={size} />,
        );
        const textEl = container.querySelector('text');
        expect(textEl).toBeTruthy();
        expect(textEl!.textContent).toBe('42');
        cleanup();
      }
    });

    it('uses proportional stroke widths per size (small=3, medium=4, large=5)', () => {
      const strokeExpected: Record<string, string> = {
        small: '3',
        medium: '4',
        large: '5',
      };
      for (const size of ['small', 'medium', 'large'] as const) {
        const { container } = render(
          <ScoreGauge score={50} factors={mockFactors} size={size} />,
        );
        const arc = getScoreArc(container);
        expect(arc).toBeTruthy();
        expect(arc!.getAttribute('stroke-width')).toBe(strokeExpected[size]);
        cleanup();
      }
    });

    it('matches SVG viewBox to the size dimension', () => {
      const sizeMap: Record<string, string> = {
        small: '0 0 36 36',
        medium: '0 0 56 56',
        large: '0 0 80 80',
      };
      for (const size of ['small', 'medium', 'large'] as const) {
        const { container } = render(
          <ScoreGauge score={50} factors={mockFactors} size={size} />,
        );
        const svg = container.querySelector('svg');
        expect(svg).toBeTruthy();
        expect(svg!.getAttribute('viewBox')).toBe(sizeMap[size]);
        cleanup();
      }
    });
  });

  // =========================================================================
  // 4. Factor Breakdown Tooltip
  // =========================================================================

  describe('factor breakdown tooltip', () => {
    it('does not show tooltip initially', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} size="medium" />,
      );
      expect(container.querySelector('.factor-tooltip')).toBeNull();
    });

    it('shows tooltip on mouseEnter when factors are provided', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} size="medium" />,
      );
      const gauge = getGaugeContainer(container)!;
      expect(gauge).toBeTruthy();

      fireEvent.mouseEnter(gauge);

      const tooltip = container.querySelector('.factor-tooltip');
      expect(tooltip).toBeTruthy();
    });

    it('hides tooltip on mouseLeave', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} size="medium" />,
      );
      const gauge = getGaugeContainer(container)!;

      fireEvent.mouseEnter(gauge);
      expect(container.querySelector('.factor-tooltip')).toBeTruthy();

      fireEvent.mouseLeave(gauge);
      expect(container.querySelector('.factor-tooltip')).toBeNull();
    });

    it('toggles tooltip on click (show then hide)', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} size="medium" />,
      );
      const gauge = getGaugeContainer(container)!;

      // Initially hidden
      expect(container.querySelector('.factor-tooltip')).toBeNull();

      // First click: show
      fireEvent.click(gauge);
      expect(container.querySelector('.factor-tooltip')).toBeTruthy();

      // Second click: hide
      fireEvent.click(gauge);
      expect(container.querySelector('.factor-tooltip')).toBeNull();
    });

    it('displays "Factor Breakdown" header in the tooltip', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} size="medium" />,
      );
      const gauge = getGaugeContainer(container)!;
      fireEvent.mouseEnter(gauge);

      const header = container.querySelector('.tooltip-header');
      expect(header).toBeTruthy();
      expect(header!.textContent).toBe('Factor Breakdown');
    });

    it('displays exactly 7 factor rows in the tooltip', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} size="medium" />,
      );
      const gauge = getGaugeContainer(container)!;
      fireEvent.mouseEnter(gauge);

      const rows = container.querySelectorAll('.tooltip-row');
      expect(rows.length).toBe(7);
    });

    it('shows all formatted factor names: Volume, Smart $, Buy/Sell, Holders, Liquidity, Age, Safety', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} size="medium" />,
      );
      const gauge = getGaugeContainer(container)!;
      fireEvent.mouseEnter(gauge);

      const nameElements = container.querySelectorAll('.factor-name');
      const names = Array.from(nameElements).map((el) => el.textContent);

      expect(names).toContain('Volume');
      expect(names).toContain('Smart $');
      expect(names).toContain('Buy/Sell');
      expect(names).toContain('Holders');
      expect(names).toContain('Liquidity');
      expect(names).toContain('Age');
      expect(names).toContain('Safety');
    });

    it('shows correct numeric score values for each factor', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} size="medium" />,
      );
      const gauge = getGaugeContainer(container)!;
      fireEvent.mouseEnter(gauge);

      const valueElements = container.querySelectorAll('.factor-value');
      const values = Array.from(valueElements).map((el) => el.textContent);

      // Expected scores from mockFactors: 80, 70, 65, 60, 85, 90, 75
      expect(values).toContain('80');
      expect(values).toContain('70');
      expect(values).toContain('65');
      expect(values).toContain('60');
      expect(values).toContain('85');
      expect(values).toContain('90');
      expect(values).toContain('75');
    });

    it('shows weight values in the format ×{weight.toFixed(2)}', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} size="medium" />,
      );
      const gauge = getGaugeContainer(container)!;
      fireEvent.mouseEnter(gauge);

      const weightElements = container.querySelectorAll('.factor-weight');
      const weights = Array.from(weightElements).map((el) => el.textContent);

      // Expected weights: ×0.20, ×0.20, ×0.15, ×0.10, ×0.15, ×0.10, ×0.10
      expect(weights).toContain('×0.20');
      expect(weights).toContain('×0.15');
      expect(weights).toContain('×0.10');
    });

    it('renders mini progress bar elements for each factor', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} size="medium" />,
      );
      const gauge = getGaugeContainer(container)!;
      fireEvent.mouseEnter(gauge);

      const bars = container.querySelectorAll('.factor-mini-bar');
      expect(bars.length).toBe(7);

      const fills = container.querySelectorAll('.factor-fill');
      expect(fills.length).toBe(7);
    });

    it('does not show tooltip when factors array is empty', () => {
      const { container } = render(
        <ScoreGauge score={50} factors={[]} />,
      );
      const gauge = getGaugeContainer(container)!;

      fireEvent.mouseEnter(gauge);
      expect(container.querySelector('.factor-tooltip')).toBeNull();
    });

    it('does not show tooltip when factors prop is omitted', () => {
      const { container } = render(<ScoreGauge score={60} />);
      const gauge = getGaugeContainer(container)!;

      fireEvent.mouseEnter(gauge);
      expect(container.querySelector('.factor-tooltip')).toBeNull();
    });

    it('tooltip has role="tooltip" attribute for accessibility', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} size="medium" />,
      );
      const gauge = getGaugeContainer(container)!;
      fireEvent.mouseEnter(gauge);

      const tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip).toBeTruthy();
    });

    it('shows tooltip with custom factor scores when overridden', () => {
      const customFactors = createMockFactors({
        volumeSpike: 10,
        safetyScore: 95,
      });
      const { container } = render(
        <ScoreGauge score={55} factors={customFactors} size="medium" />,
      );
      const gauge = getGaugeContainer(container)!;
      fireEvent.mouseEnter(gauge);

      const valueElements = container.querySelectorAll('.factor-value');
      const values = Array.from(valueElements).map((el) => el.textContent);

      expect(values).toContain('10');
      expect(values).toContain('95');
    });
  });

  // =========================================================================
  // 5. ARIA Accessibility Attributes
  // =========================================================================

  describe('ARIA accessibility', () => {
    it('sets role="meter" on the container element', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} />,
      );
      const meter = container.querySelector('[role="meter"]');
      expect(meter).toBeTruthy();
    });

    it('sets aria-valuenow to the clamped score value', () => {
      const { container } = render(
        <ScoreGauge score={82} factors={mockFactors} />,
      );
      const meter = container.querySelector('[role="meter"]');
      expect(meter).toBeTruthy();
      expect(meter!.getAttribute('aria-valuenow')).toBe('82');
    });

    it('sets aria-valuemin to 0', () => {
      const { container } = render(
        <ScoreGauge score={50} factors={mockFactors} />,
      );
      const meter = container.querySelector('[role="meter"]');
      expect(meter).toBeTruthy();
      expect(meter!.getAttribute('aria-valuemin')).toBe('0');
    });

    it('sets aria-valuemax to 100', () => {
      const { container } = render(
        <ScoreGauge score={50} factors={mockFactors} />,
      );
      const meter = container.querySelector('[role="meter"]');
      expect(meter).toBeTruthy();
      expect(meter!.getAttribute('aria-valuemax')).toBe('100');
    });

    it('includes a descriptive aria-label containing the score value', () => {
      const { container } = render(
        <ScoreGauge score={67} factors={mockFactors} />,
      );
      const meter = container.querySelector('[role="meter"]');
      expect(meter).toBeTruthy();
      const label = meter!.getAttribute('aria-label');
      expect(label).toBeTruthy();
      expect(label).toContain('67');
      expect(label).toContain('100');
    });

    it('sets tabIndex=0 when factors are provided (keyboard accessible)', () => {
      const { container } = render(
        <ScoreGauge score={50} factors={mockFactors} />,
      );
      const meter = container.querySelector('[role="meter"]');
      expect(meter).toBeTruthy();
      expect(meter!.getAttribute('tabindex')).toBe('0');
    });

    it('sets tabIndex=-1 when no factors are provided (not keyboard focusable)', () => {
      const { container } = render(<ScoreGauge score={50} />);
      const meter = container.querySelector('[role="meter"]');
      expect(meter).toBeTruthy();
      expect(meter!.getAttribute('tabindex')).toBe('-1');
    });

    it('marks SVG as aria-hidden="true"', () => {
      const { container } = render(
        <ScoreGauge score={50} factors={mockFactors} />,
      );
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
      expect(svg!.getAttribute('aria-hidden')).toBe('true');
    });
  });

  // =========================================================================
  // 6. Edge Cases
  // =========================================================================

  describe('edge cases', () => {
    it('clamps negative score to 0', () => {
      const { container } = render(
        <ScoreGauge score={-10} factors={mockFactors} />,
      );
      const textEl = container.querySelector('text');
      expect(textEl).toBeTruthy();
      expect(textEl!.textContent).toBe('0');
    });

    it('clamps score above 100 to 100', () => {
      const { container } = render(
        <ScoreGauge score={150} factors={mockFactors} />,
      );
      const textEl = container.querySelector('text');
      expect(textEl).toBeTruthy();
      expect(textEl!.textContent).toBe('100');
    });

    it('handles NaN score gracefully — clamps to 0', () => {
      const { container } = render(
        <ScoreGauge score={NaN} factors={mockFactors} />,
      );
      const textEl = container.querySelector('text');
      expect(textEl).toBeTruthy();
      expect(textEl!.textContent).toBe('0');
    });

    it('handles Infinity score gracefully — clamps to 0 (not finite)', () => {
      const { container } = render(
        <ScoreGauge score={Infinity} factors={mockFactors} />,
      );
      const textEl = container.querySelector('text');
      expect(textEl).toBeTruthy();
      // Infinity is not finite → clampScore returns 0
      expect(textEl!.textContent).toBe('0');
    });

    it('handles -Infinity score gracefully — clamps to 0 (not finite)', () => {
      const { container } = render(
        <ScoreGauge score={-Infinity} factors={mockFactors} />,
      );
      const textEl = container.querySelector('text');
      expect(textEl).toBeTruthy();
      expect(textEl!.textContent).toBe('0');
    });

    it('rounds fractional score 72.7 to 73', () => {
      const { container } = render(
        <ScoreGauge score={72.7} factors={mockFactors} />,
      );
      const textEl = container.querySelector('text');
      expect(textEl).toBeTruthy();
      expect(textEl!.textContent).toBe('73');
    });

    it('rounds fractional score 44.4 to 44', () => {
      const { container } = render(
        <ScoreGauge score={44.4} factors={mockFactors} />,
      );
      const textEl = container.querySelector('text');
      expect(textEl).toBeTruthy();
      expect(textEl!.textContent).toBe('44');
    });

    it('renders without crashing when factors prop is undefined', () => {
      const { container } = render(<ScoreGauge score={60} />);
      expect(container.querySelector('svg')).toBeTruthy();
      expect(container.querySelector('text')!.textContent).toBe('60');
    });

    it('renders without crashing when factors is an empty array', () => {
      const { container } = render(
        <ScoreGauge score={50} factors={[]} />,
      );
      expect(container.querySelector('svg')).toBeTruthy();
      expect(container.querySelector('text')!.textContent).toBe('50');
    });

    it('handles hover/click interactions on empty factors without crash', () => {
      const { container } = render(
        <ScoreGauge score={50} factors={[]} />,
      );
      const gauge = getGaugeContainer(container)!;
      expect(gauge).toBeTruthy();

      // Should not throw
      fireEvent.mouseEnter(gauge);
      fireEvent.mouseLeave(gauge);
      fireEvent.click(gauge);

      // Component should remain intact
      expect(container.querySelector('svg')).toBeTruthy();
      expect(container.querySelector('text')!.textContent).toBe('50');
    });

    it('handles rapid hover/leave cycles without state corruption', () => {
      const { container } = render(
        <ScoreGauge score={75} factors={mockFactors} size="medium" />,
      );
      const gauge = getGaugeContainer(container)!;

      // Rapid hover/leave cycles
      for (let i = 0; i < 5; i++) {
        fireEvent.mouseEnter(gauge);
        fireEvent.mouseLeave(gauge);
      }

      // Should end without tooltip visible
      expect(container.querySelector('.factor-tooltip')).toBeNull();
      // Score should still be correct
      expect(container.querySelector('text')!.textContent).toBe('75');
    });

    it('clamped score of negative produces red arc color', () => {
      const { container } = render(
        <ScoreGauge score={-5} factors={mockFactors} />,
      );
      const arc = getScoreArc(container);
      expect(arc).toBeTruthy();
      // -5 clamps to 0, which is < 30 → red
      expect(arc!.getAttribute('stroke')).toBe('#ef4444');
    });

    it('aria-valuenow reflects clamped score for out-of-range input', () => {
      const { container } = render(
        <ScoreGauge score={200} factors={mockFactors} />,
      );
      const meter = container.querySelector('[role="meter"]');
      expect(meter).toBeTruthy();
      expect(meter!.getAttribute('aria-valuenow')).toBe('100');
    });
  });
});
