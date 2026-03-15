/**
 * @fileoverview AIInsight — AI Analysis Display Component
 *
 * Renders the LLM-generated analysis for a token within a TokenCard.
 * Displays:
 *   - **Tier badge**: Which LLM tier produced the analysis (⚡ Quick Screen,
 *     🔍 Detailed, 🌟 Premium).
 *   - **Confidence badge**: Color-coded confidence level (high / medium / low).
 *   - **Composite AI score**: Numeric 0–100 score from the LLM pipeline.
 *   - **5-dimension bar chart**: Horizontal bars for on-chain momentum, social
 *     velocity, wallet intelligence, liquidity health, and narrative fit —
 *     each with color-coding (green ≥70, yellow 40–69, red <40) and
 *     expandable reasoning on click.
 *   - **Narrative summary**: LLM-generated narrative truncated to 3 lines by
 *     default, expandable on click.
 *
 * Per AAP Section 0.5.1 Group 11: "Displays LLM-generated narrative with
 * confidence badge; shows 5 dimension scores as a compact bar chart;
 * indicates which LLM tier produced the analysis."
 *
 * Per AAP Section 0.1.1 Three-Tier AI/LLM Analysis:
 *   - fast  (80%) → llama-3.1-8b-instant
 *   - detailed (15%) → llama-3.3-70b-versatile
 *   - premium  (5%) → Claude Sonnet
 *
 * @module components/AIInsight
 */

import { h, FunctionComponent } from 'preact';
import { useState } from 'preact/hooks';

import type { AIAnalysisResult, AnalysisDimension, LLMTier } from '../ai/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Props for the AIInsight component.
 *
 * @property analysis - The complete AI analysis result containing dimension
 *   scores, composite AI score, confidence level, narrative, and tier.
 */
interface AIInsightProps {
  analysis: AIAnalysisResult;
}

// ---------------------------------------------------------------------------
// Helper — LLM Tier Label
// ---------------------------------------------------------------------------

/**
 * Returns the user-facing label for an LLM tier.
 *
 * Tier mapping (per AAP three-tier routing):
 *   - `'fast'`     → "⚡ Quick Screen"  (llama-3.1-8b-instant, 80% of calls)
 *   - `'detailed'` → "🔍 Detailed"     (llama-3.3-70b-versatile, 15%)
 *   - `'premium'`  → "🌟 Premium"      (Claude Sonnet, 5%)
 */
function getTierLabel(tier: LLMTier): string {
  switch (tier) {
    case 'fast':
      return '⚡ Quick Screen';
    case 'detailed':
      return '🔍 Detailed';
    case 'premium':
      return '🌟 Premium';
    default: {
      // Defensive: exhaustive check — if a new tier is added this warns
      const _exhaustive: never = tier;
      return String(_exhaustive);
    }
  }
}

// ---------------------------------------------------------------------------
// Helper — Confidence Label
// ---------------------------------------------------------------------------

/**
 * Returns a capitalised, user-facing confidence label.
 *
 * @param confidence - One of `'high'`, `'medium'`, or `'low'`.
 * @returns Formatted string (e.g. "High Confidence").
 */
function getConfidenceLabel(confidence: AIAnalysisResult['confidence']): string {
  switch (confidence) {
    case 'high':
      return 'High Confidence';
    case 'medium':
      return 'Medium Confidence';
    case 'low':
      return 'Low Confidence';
    default:
      return 'Unknown';
  }
}

// ---------------------------------------------------------------------------
// Helper — Score Color Class
// ---------------------------------------------------------------------------

/**
 * Maps a 0–100 score to one of three CSS colour classes defined in
 * `styles.css`:
 *   - `'score-high'`   — green  (score ≥ 70)
 *   - `'score-medium'` — yellow (score 40–69)
 *   - `'score-low'`    — red    (score < 40)
 */
function getScoreClass(score: number): string {
  if (score >= 70) return 'score-high';
  if (score >= 40) return 'score-medium';
  return 'score-low';
}

// ---------------------------------------------------------------------------
// Helper — Clamp Score
// ---------------------------------------------------------------------------

/**
 * Clamps a score to the valid 0–100 range for defensive rendering.
 */
function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ---------------------------------------------------------------------------
// Sub-component — Dimension Row
// ---------------------------------------------------------------------------

/**
 * Renders a single analysis dimension row within the 5-dimension bar chart.
 *
 * Shows dimension name, horizontal fill bar (0–100 with colour), numeric
 * score, and an expandable reasoning block on click.
 */
const DimensionRow: FunctionComponent<{
  dimension: AnalysisDimension;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ dimension, isExpanded, onToggle }) => {
  const safeScore = clampScore(dimension.score);

  return (
    <div class="dimension-row-wrapper">
      <div
        class="dimension-row"
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-label={`${dimension.name}: ${safeScore} out of 100. ${isExpanded ? 'Click to collapse reasoning' : 'Click to expand reasoning'}`}
        onClick={onToggle}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span class="dim-name">{dimension.name}</span>
        <div class="dim-bar-container">
          <div
            class={`dim-bar ${getScoreClass(safeScore)}`}
            style={{ width: `${safeScore}%` }}
          />
        </div>
        <span class="dim-score">{safeScore}</span>
      </div>
      {isExpanded && dimension.reasoning && (
        <div
          class="dim-reasoning"
          style={{
            fontSize: 'var(--font-size-xs, 10px)',
            color: 'var(--text-muted, #5f6368)',
            paddingInlineStart: '70px',
            paddingBlockEnd: '4px',
            lineHeight: '1.3',
          }}
        >
          {dimension.reasoning}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// AIInsight Component
// ---------------------------------------------------------------------------

/**
 * AI Analysis display component.
 *
 * Renders tier badge, confidence badge, composite AI score, a compact
 * 5-dimension horizontal bar chart, and an expandable LLM narrative summary.
 *
 * Uses CSS classes from `src/components/styles.css` loaded inside the
 * Shadow DOM.
 *
 * @example
 * ```tsx
 * <AIInsight analysis={tokenData.aiAnalysis} />
 * ```
 */
export const AIInsight: FunctionComponent<AIInsightProps> = ({ analysis }) => {
  // State: narrative expanded/collapsed toggle
  const [narrativeExpanded, setNarrativeExpanded] = useState(false);

  // State: per-dimension reasoning expansion (track by index for O(1) toggle)
  const [expandedDimension, setExpandedDimension] = useState<number | null>(null);

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------
  const compositeDisplay = clampScore(analysis.compositeAI);

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------
  const handleNarrativeToggle = (): void => {
    setNarrativeExpanded((prev) => !prev);
  };

  const handleNarrativeKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleNarrativeToggle();
    }
  };

  const handleDimensionToggle = (index: number): void => {
    setExpandedDimension((prev) => (prev === index ? null : index));
  };

  // -------------------------------------------------------------------------
  // Guard: empty / malformed analysis
  // -------------------------------------------------------------------------
  if (!analysis) {
    return null;
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div class="ai-insight" role="region" aria-label="AI Analysis">
      {/* ── Header: tier badge + confidence badge + composite score ──── */}
      <div class="ai-header">
        <span class={`tier-badge tier-${analysis.tier}`}>
          {getTierLabel(analysis.tier)}
        </span>
        <span class={`confidence-badge confidence-${analysis.confidence}`}>
          {getConfidenceLabel(analysis.confidence)}
        </span>
        <span class="ai-score" aria-label={`AI Score: ${compositeDisplay} out of 100`}>
          {compositeDisplay}/100
        </span>
      </div>

      {/* ── 5-Dimension Bar Chart ───────────────────────────────────── */}
      {analysis.dimensions && analysis.dimensions.length > 0 && (
        <div class="dimension-chart" role="list" aria-label="Analysis dimensions">
          {analysis.dimensions.map((dim: AnalysisDimension, index: number) => (
            <DimensionRow
              key={dim.name || index}
              dimension={dim}
              isExpanded={expandedDimension === index}
              onToggle={() => handleDimensionToggle(index)}
            />
          ))}
        </div>
      )}

      {/* ── Narrative Summary ───────────────────────────────────────── */}
      {analysis.narrative && (
        <div
          class="ai-narrative"
          role="button"
          tabIndex={0}
          aria-expanded={narrativeExpanded}
          aria-label={narrativeExpanded ? 'Collapse AI narrative' : 'Expand AI narrative'}
          onClick={handleNarrativeToggle}
          onKeyDown={handleNarrativeKeyDown}
        >
          <p class={narrativeExpanded ? 'expanded' : 'truncated'}>
            {analysis.narrative}
          </p>
          {!narrativeExpanded && (
            <span class="read-more" aria-hidden="true">
              Read more
            </span>
          )}
        </div>
      )}
    </div>
  );
};
