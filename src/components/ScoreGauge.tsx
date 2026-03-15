/**
 * @fileoverview ScoreGauge — Circular Composite Score Gauge Component
 *
 * Renders a composite signal score (0–100) as an SVG circular gauge with a
 * color gradient that maps score ranges to visual urgency:
 *
 *   - 🟢 Green  (≥80): High-confidence signal — conservative mode threshold.
 *   - 🟢 Lime   (≥60): Good signal — approaching conservative threshold.
 *   - 🟡 Yellow (≥45): Moderate signal — aggressive mode threshold.
 *   - 🟠 Orange (≥30): Weak signal — below aggressive threshold.
 *   - 🔴 Red    (<30): Low/skip — hard-filter likely failure territory.
 *
 * On hover or tap the gauge displays a factor-by-factor breakdown tooltip
 * showing each of the 7 scoring factors: Volume Spike, Smart Money
 * Convergence, Buy/Sell Ratio, Holder Growth, Liquidity, Token Age, and
 * Safety Score — each with a mini progress bar, numeric score, and weight.
 *
 * Three render sizes are supported for different layout contexts:
 *   - `small`  (36 px): Inline use in compact TokenCard rows.
 *   - `medium` (56 px): Expanded TokenCard view.
 *   - `large`  (80 px): Detail/full-screen panel view.
 *
 * Per AAP Section 0.5.1 Group 11: "Circular gauge rendering composite score
 * 0–100 with color gradient (red → yellow → green); hover/tap shows
 * factor-by-factor breakdown."
 *
 * Per AAP Section 0.4.4: ScoreGauge receives data via props from parent
 * TokenCard — it does not read from the signal store directly.
 *
 * @module components/ScoreGauge
 */

import { h, FunctionComponent } from 'preact';
import { useState, useMemo } from 'preact/hooks';

import type { FactorResult } from '../signals/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Props accepted by the {@link ScoreGauge} component.
 *
 * @property score   - Composite signal score from 0 to 100.
 * @property factors - Optional array of individual factor results for the
 *                     hover/tap breakdown tooltip.
 * @property size    - Render size variant (`'small'` | `'medium'` | `'large'`).
 *                     Defaults to `'small'` when omitted.
 */
interface ScoreGaugeProps {
  /** Composite signal score from 0 to 100 (clamped internally). */
  score: number;

  /** Optional array of factor breakdown results for tooltip display. */
  factors?: FactorResult[];

  /** Render size — 'small' (36px), 'medium' (56px), or 'large' (80px). */
  size?: 'small' | 'medium' | 'large';
}

// ---------------------------------------------------------------------------
// Constants — Size & Stroke Maps
// ---------------------------------------------------------------------------

/**
 * Diameter in pixels for each gauge size variant.
 * Chosen to fit naturally into TokenCard layouts:
 *   - small  (36): fits a single compact card row without overflow.
 *   - medium (56): balanced for an expanded card header.
 *   - large  (80): prominent gauge for a detail/fullscreen view.
 */
const SIZE_MAP: Readonly<Record<NonNullable<ScoreGaugeProps['size']>, number>> = {
  small: 36,
  medium: 56,
  large: 80,
};

/**
 * Stroke width in pixels for each gauge size variant.
 * Proportional to diameter to maintain visual balance.
 */
const STROKE_MAP: Readonly<Record<NonNullable<ScoreGaugeProps['size']>, number>> = {
  small: 3,
  medium: 4,
  large: 5,
};

// ---------------------------------------------------------------------------
// Helper — Score → Color
// ---------------------------------------------------------------------------

/**
 * Maps a numeric composite score to a hex color string.
 *
 * Thresholds align with AAP scoring modes:
 *   - ≥80 → #22c55e (green-500)  — conservative mode BUY threshold.
 *   - ≥60 → #84cc16 (lime-500)   — approaching conservative threshold.
 *   - ≥45 → #eab308 (yellow-500) — aggressive mode BUY threshold.
 *   - ≥30 → #f97316 (orange-500) — below aggressive threshold.
 *   - <30 → #ef4444 (red-500)    — low/skip territory.
 *
 * @param score - Numeric score (0–100).
 * @returns CSS hex color string.
 */
function getScoreColor(score: number): string {
  if (score >= 80) return '#22c55e';
  if (score >= 60) return '#84cc16';
  if (score >= 45) return '#eab308';
  if (score >= 30) return '#f97316';
  return '#ef4444';
}

// ---------------------------------------------------------------------------
// Helper — Factor Name Formatter
// ---------------------------------------------------------------------------

/**
 * Converts a camelCase factor identifier into a short, human-readable label
 * suitable for display inside the compact tooltip row.
 *
 * All 7 scoring factor names from the signal engine are covered:
 *   - volumeSpike → "Volume"
 *   - smartMoneyConvergence → "Smart $"
 *   - buySellRatio → "Buy/Sell"
 *   - holderGrowth → "Holders"
 *   - liquidity → "Liquidity"
 *   - tokenAge → "Age"
 *   - safetyScore → "Safety"
 *
 * Unknown names fall through unchanged as a defensive measure.
 *
 * @param name - The `FactorResult.name` string.
 * @returns Short display label.
 */
function formatFactorName(name: string): string {
  const labels: Readonly<Record<string, string>> = {
    volumeSpike: 'Volume',
    smartMoneyConvergence: 'Smart $',
    buySellRatio: 'Buy/Sell',
    holderGrowth: 'Holders',
    liquidity: 'Liquidity',
    tokenAge: 'Age',
    safetyScore: 'Safety',
  };
  return labels[name] ?? name;
}

// ---------------------------------------------------------------------------
// Helper — Clamp
// ---------------------------------------------------------------------------

/**
 * Clamps a numeric value to the [0, 100] range to guard against invalid
 * or out-of-range score values propagated from upstream modules.
 *
 * @param value - Raw numeric value.
 * @returns Value clamped to [0, 100].
 */
function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

// ---------------------------------------------------------------------------
// Component — ScoreGauge
// ---------------------------------------------------------------------------

/**
 * Circular SVG gauge that visualises a composite signal score (0–100).
 *
 * Features:
 * - Proportional arc fill driven by stroke-dashoffset.
 * - Score-dependent color from red → yellow → green.
 * - Three size variants (small / medium / large).
 * - Hover/tap reveals a factor-by-factor breakdown tooltip when `factors`
 *   are supplied.
 * - Fully accessible: ARIA role "meter" with value semantics, keyboard-
 *   operable tooltip toggle.
 *
 * @example
 * ```tsx
 * <ScoreGauge score={82} factors={factorResults} size="medium" />
 * ```
 */
const ScoreGauge: FunctionComponent<ScoreGaugeProps> = ({
  score,
  factors,
  size = 'small',
}) => {
  // -- Local state: tooltip visibility toggled on hover / click / keyboard.
  const [showBreakdown, setShowBreakdown] = useState<boolean>(false);

  // -- Clamp the incoming score to a safe [0, 100] integer.
  const clampedScore = useMemo(() => clampScore(score), [score]);

  // -- Memoised SVG dimension calculations (depend only on `size`).
  const dimensions = useMemo(() => {
    const diameter = SIZE_MAP[size];
    const stroke = STROKE_MAP[size];
    const radius = (diameter - stroke * 2) / 2;
    const circumference = 2 * Math.PI * radius;

    return { diameter, stroke, radius, circumference };
  }, [size]);

  // -- Derived arc offset (depends on clamped score + circumference).
  const arcOffset = useMemo(() => {
    return dimensions.circumference - (clampedScore / 100) * dimensions.circumference;
  }, [clampedScore, dimensions.circumference]);

  // -- Derived color (depends on clamped score).
  const arcColor = useMemo(() => getScoreColor(clampedScore), [clampedScore]);

  // -- Font size for the center score text scales with diameter.
  const fontSize = useMemo(() => dimensions.diameter * 0.3, [dimensions.diameter]);

  // -- Center point for SVG elements.
  const center = useMemo(() => dimensions.diameter / 2, [dimensions.diameter]);

  // -- Whether factor breakdown data is available for tooltip rendering.
  const hasFactors = Array.isArray(factors) && factors.length > 0;

  // -- Event handlers for tooltip visibility.
  const handleMouseEnter = (): void => {
    setShowBreakdown(true);
  };

  const handleMouseLeave = (): void => {
    setShowBreakdown(false);
  };

  const handleClick = (): void => {
    setShowBreakdown((prev) => !prev);
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setShowBreakdown((prev) => !prev);
    }
    if (event.key === 'Escape') {
      setShowBreakdown(false);
    }
  };

  return (
    <div
      class={`score-gauge-container gauge-${size}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="meter"
      aria-label={`Composite signal score: ${clampedScore} out of 100`}
      aria-valuenow={clampedScore}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={hasFactors ? 0 : -1}
    >
      {/* ------ SVG Circular Gauge ------ */}
      <svg
        width={dimensions.diameter}
        height={dimensions.diameter}
        class="score-gauge"
        viewBox={`0 0 ${dimensions.diameter} ${dimensions.diameter}`}
        aria-hidden="true"
      >
        {/* Background track circle */}
        <circle
          cx={center}
          cy={center}
          r={dimensions.radius}
          stroke="rgba(255,255,255,0.1)"
          stroke-width={dimensions.stroke}
          fill="none"
        />

        {/* Score arc — rotated -90° so the arc starts from 12-o'clock */}
        <circle
          cx={center}
          cy={center}
          r={dimensions.radius}
          stroke={arcColor}
          stroke-width={dimensions.stroke}
          fill="none"
          stroke-dasharray={dimensions.circumference}
          stroke-dashoffset={arcOffset}
          stroke-linecap="round"
          transform={`rotate(-90 ${center} ${center})`}
          style={{
            transition: 'stroke-dashoffset 300ms ease, stroke 300ms ease',
          }}
        />

        {/* Center score text */}
        <text
          x={center}
          y={center}
          text-anchor="middle"
          dominant-baseline="central"
          fill="white"
          font-size={fontSize}
          font-weight="bold"
          font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        >
          {clampedScore}
        </text>
      </svg>

      {/* ------ Factor Breakdown Tooltip ------ */}
      {showBreakdown && hasFactors && (
        <div class="factor-tooltip" role="tooltip">
          <div class="tooltip-header">Factor Breakdown</div>
          {(factors as FactorResult[]).map((factor) => {
            const factorScore = clampScore(factor.score);
            return (
              <div class="tooltip-row" key={factor.name}>
                <span class="factor-name">{formatFactorName(factor.name)}</span>
                <div class="factor-mini-bar" aria-hidden="true">
                  <div
                    class="factor-fill"
                    style={{
                      width: `${factorScore}%`,
                      background: getScoreColor(factorScore),
                    }}
                  />
                </div>
                <span class="factor-value">{factorScore}</span>
                <span class="factor-weight">×{factor.weight.toFixed(2)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { ScoreGauge };
