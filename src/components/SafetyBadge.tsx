/**
 * @fileoverview SafetyBadge — Color-Coded Safety Indicator Component
 *
 * Renders a compact, color-coded safety badge within TokenCard.
 * Supports two display modes:
 *   - **Compact**: A single dot emoji for inline use in compact TokenCard rows.
 *   - **Normal**: An expanded badge with label, score, and clickable detail breakdown
 *     showing RugCheck + GoPlus aggregated safety data.
 *
 * Safety level classification (per AAP Section 0.5.1 Group 11):
 *   - 🟢 Green  ("Safe"):     overallScore ≥ 300, mint revoked, freeze revoked.
 *   - 🟡 Yellow ("Caution"):  Partial concerns, no critical issues.
 *   - 🟠 Orange ("Risky"):    Score < 200 or an active mint/freeze authority.
 *   - 🔴 Red    ("Critical"): Honeypot, high holder concentration, very low score.
 *
 * Token-2022 extension risk warning is displayed when applicable (per AAP Section 0.1.1).
 *
 * @module components/SafetyBadge
 */

import { h, FunctionComponent } from 'preact';
import { useState } from 'preact/hooks';

import type { SafetyReport, SafetyRiskLevel } from '../safety/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Props for the SafetyBadge component.
 *
 * @property report  - Aggregated safety report (may be null while safety check is pending).
 * @property compact - When `true`, renders a minimal dot badge for compact card rows.
 */
interface SafetyBadgeProps {
  report: SafetyReport | null | undefined;
  compact?: boolean;
}

// ---------------------------------------------------------------------------
// Helper — Safety Level Classification
// ---------------------------------------------------------------------------

/**
 * Determines the safety risk level from a {@link SafetyReport}.
 *
 * Classification order (first match wins):
 * 1. **safe**     — score ≥ 300 AND mint revoked AND freeze revoked.
 * 2. **critical** — score < 100, honeypot detected, top-10 holder > 50%, or ≥ 3 risk factors.
 * 3. **risky**    — score < 200, or mint/freeze authority still active.
 * 4. **moderate** — everything else (partial concerns without critical risks).
 */
function getSafetyLevel(report: SafetyReport): SafetyRiskLevel {
  // Green: score ≥300, mint revoked, freeze revoked
  if (
    report.overallScore >= 300 &&
    report.authorityStatus.mintRevoked &&
    report.authorityStatus.freezeRevoked
  ) {
    return 'safe';
  }

  // Red: critical risks — any one of these triggers critical
  if (
    report.overallScore < 100 ||
    !report.honeypotResult.sellable ||
    report.top10HolderPercent > 50 ||
    report.riskFactors.length >= 3
  ) {
    return 'critical';
  }

  // Orange: risky — score too low or authority still active
  if (
    report.overallScore < 200 ||
    !report.authorityStatus.mintRevoked ||
    !report.authorityStatus.freezeRevoked
  ) {
    return 'risky';
  }

  // Yellow: moderate concerns remaining
  return 'moderate';
}

// ---------------------------------------------------------------------------
// Helper — Label Text
// ---------------------------------------------------------------------------

/**
 * Maps a {@link SafetyRiskLevel} to a human-readable label for the badge.
 */
function getLabelText(level: SafetyRiskLevel): string {
  switch (level) {
    case 'safe':
      return 'Safe';
    case 'moderate':
      return 'Caution';
    case 'risky':
      return 'Risky';
    case 'critical':
      return 'Critical Risk';
  }
}

// ---------------------------------------------------------------------------
// Helper — Icon Emoji
// ---------------------------------------------------------------------------

/**
 * Returns the colour-coded dot emoji for each risk level.
 */
function getIcon(level: SafetyRiskLevel): string {
  switch (level) {
    case 'safe':
      return '🟢';
    case 'moderate':
      return '🟡';
    case 'risky':
      return '🟠';
    case 'critical':
      return '🔴';
  }
}

// ---------------------------------------------------------------------------
// Helper — Tooltip Text (compact mode title attribute)
// ---------------------------------------------------------------------------

/**
 * Generates a concise tooltip summary for compact mode `title` attribute.
 */
function getTooltipText(report: SafetyReport): string {
  const level = getSafetyLevel(report);
  const parts: string[] = [`Safety: ${getLabelText(level)} (${report.overallScore}/1000)`];

  if (!report.honeypotResult.sellable) {
    parts.push('⚠ Honeypot detected');
  }
  if (!report.authorityStatus.mintRevoked) {
    parts.push('⚠ Mint authority active');
  }
  if (!report.authorityStatus.freezeRevoked) {
    parts.push('⚠ Freeze authority active');
  }
  if (report.top10HolderPercent > 50) {
    parts.push(`⚠ Top 10 holders: ${report.top10HolderPercent.toFixed(1)}%`);
  }
  if (report.isToken2022) {
    parts.push('⚠ Token-2022 extensions');
  }
  if (!report.lpStatus.burned && !report.lpStatus.locked) {
    parts.push('⚠ LP unlocked');
  }

  return parts.join(' | ');
}

// ---------------------------------------------------------------------------
// Helper — Format LP Status
// ---------------------------------------------------------------------------

/**
 * Produces the LP status display string with appropriate emoji.
 */
function formatLPStatus(lp: SafetyReport['lpStatus']): string {
  if (lp.burned) {
    return `🔥 Burned (${lp.burnPercent}%)`;
  }
  if (lp.locked) {
    return '🔒 Locked';
  }
  return '⚠️ Unlocked';
}

// ---------------------------------------------------------------------------
// Helper — RugCheck score display
// ---------------------------------------------------------------------------

/**
 * Formats the RugCheck score for display, handling the nullable case.
 */
function formatRugCheckScore(score: number | null): string {
  if (score === null) {
    return 'N/A';
  }
  return String(score);
}

// ---------------------------------------------------------------------------
// SafetyBadge Component
// ---------------------------------------------------------------------------

/**
 * Color-coded safety indicator badge.
 *
 * Renders in two modes:
 * - **Compact** (`compact={true}`): A single emoji dot with a tooltip.
 * - **Normal** (default): A styled badge with icon, label, score, and an
 *   expandable detail breakdown showing RugCheck, GoPlus, honeypot,
 *   authority, LP, holder concentration, Token-2022, and risk factor data.
 */
const SafetyBadge: FunctionComponent<SafetyBadgeProps> = ({ report, compact = false }) => {
  const [showDetail, setShowDetail] = useState(false);

  // ── Pending / Loading state ──────────────────────────────────────────
  if (!report) {
    return (
      <span
        class="safety-dot safety-pending"
        title="Safety check pending"
        role="status"
        aria-label="Safety check pending"
      >
        ⏳
      </span>
    );
  }

  const level = getSafetyLevel(report);

  // ── Compact mode ─────────────────────────────────────────────────────
  if (compact) {
    return (
      <span
        class={`safety-dot safety-${level}`}
        title={getTooltipText(report)}
        role="img"
        aria-label={`Safety: ${getLabelText(level)}`}
      >
        {getIcon(level)}
      </span>
    );
  }

  // ── Normal / Expanded mode ───────────────────────────────────────────
  return (
    <div class={`safety-badge-wrapper safety-${level}`}>
      {/* Badge header — clickable to expand/collapse detail */}
      <button
        type="button"
        class={`safety-badge safety-${level}`}
        onClick={() => setShowDetail((prev) => !prev)}
        aria-expanded={showDetail}
        aria-label={`Safety: ${getLabelText(level)}. Score ${report.overallScore} out of 1000. Click to ${showDetail ? 'hide' : 'show'} details.`}
      >
        <span class="safety-icon" aria-hidden="true">
          {getIcon(level)}
        </span>
        <span class="safety-label">{getLabelText(level)}</span>
        <span class="safety-score">{report.overallScore}/1000</span>
      </button>

      {/* Detail breakdown panel */}
      {showDetail && (
        <div class="safety-detail" role="region" aria-label="Safety detail breakdown">
          {/* RugCheck Score */}
          <div class="detail-row">
            <span>RugCheck Score:</span>
            <span>{formatRugCheckScore(report.rugCheckScore)}</span>
          </div>

          {/* Honeypot Test */}
          <div class="detail-row">
            <span>Honeypot Test:</span>
            <span class={report.honeypotResult.sellable ? 'pass' : 'fail'}>
              {report.honeypotResult.sellable ? '✅ Sellable' : '❌ Not Sellable'}
            </span>
          </div>

          {/* Estimated Tax */}
          <div class="detail-row">
            <span>Estimated Tax:</span>
            <span>{(report.honeypotResult.estimatedTax * 100).toFixed(1)}%</span>
          </div>

          {/* Mint Authority */}
          <div class="detail-row">
            <span>Mint Authority:</span>
            <span class={report.authorityStatus.mintRevoked ? 'pass' : 'fail'}>
              {report.authorityStatus.mintRevoked ? '✅ Revoked' : '⚠️ Active'}
            </span>
          </div>

          {/* Freeze Authority */}
          <div class="detail-row">
            <span>Freeze Authority:</span>
            <span class={report.authorityStatus.freezeRevoked ? 'pass' : 'fail'}>
              {report.authorityStatus.freezeRevoked ? '✅ Revoked' : '⚠️ Active'}
            </span>
          </div>

          {/* LP Status */}
          <div class="detail-row">
            <span>LP Status:</span>
            <span>{formatLPStatus(report.lpStatus)}</span>
          </div>

          {/* Top 10 Holders */}
          <div class="detail-row">
            <span>Top 10 Holders:</span>
            <span
              class={
                report.top10HolderPercent > 50
                  ? 'fail'
                  : report.top10HolderPercent > 30
                    ? 'warn'
                    : 'pass'
              }
            >
              {report.top10HolderPercent.toFixed(1)}%
            </span>
          </div>

          {/* Largest Holder */}
          <div class="detail-row">
            <span>Largest Holder:</span>
            <span
              class={
                report.largestHolderPercent > 20
                  ? 'fail'
                  : report.largestHolderPercent > 10
                    ? 'warn'
                    : 'pass'
              }
            >
              {report.largestHolderPercent.toFixed(1)}%
            </span>
          </div>

          {/* Token-2022 Warning */}
          {report.isToken2022 && (
            <div class="detail-row warn">
              <span>⚠️ Token-2022 Extensions</span>
              <span class="warn">PermanentDelegate / Freeze risk</span>
            </div>
          )}

          {/* Risk Factors */}
          {report.riskFactors.length > 0 && (
            <div class="risk-factors">
              <span>Risk Factors:</span>
              <ul>
                {report.riskFactors.map((factor) => (
                  <li key={factor}>{factor}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { SafetyBadge };
