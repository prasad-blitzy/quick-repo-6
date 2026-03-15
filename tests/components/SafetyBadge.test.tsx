/**
 * @fileoverview SafetyBadge Component Tests
 *
 * Comprehensive test suite for the SafetyBadge Preact component that renders
 * color-coded safety indicators (green/yellow/orange/red) based on aggregated
 * SafetyReport data from RugCheck and GoPlus sources.
 *
 * Test coverage:
 * - Safety level classification: green (safe), yellow (moderate), orange (risky), red (critical)
 * - Detail breakdown panel: RugCheck score, honeypot test, authority status, LP status, holders
 * - Risk factor display and Token-2022 extension warnings
 * - Edge cases: null/undefined reports (pending state)
 * - Compact mode rendering with tooltip
 * - Accessibility: aria-labels, aria-expanded, role attributes
 *
 * Per AAP Section 0.6.1 Test Files:
 * "tests/components/ — Preact component rendering tests"
 *
 * @module tests/components/SafetyBadge.test
 */

import { h } from 'preact';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { SafetyBadge } from '../../src/components/SafetyBadge';
import type { SafetyReport } from '../../src/safety/types';

// ---------------------------------------------------------------------------
// Test Data Factory
// ---------------------------------------------------------------------------

/**
 * Creates a fully-populated SafetyReport with sensible "safe" defaults.
 *
 * The default report represents a healthy token:
 * - overallScore 500 (well above the 300 safe threshold)
 * - Both mint and freeze authorities revoked
 * - Sellable (not a honeypot) with minimal tax
 * - LP burned at 98%
 * - Low holder concentration (15% top-10, 5% largest)
 * - No risk factors, not Token-2022
 *
 * Override any field via the `overrides` parameter to create specific
 * test scenarios (e.g., honeypot, active mint authority, critical score).
 */
function createSafeReport(overrides: Partial<SafetyReport> = {}): SafetyReport {
  return {
    mint: 'test-mint-So11111111111111111111111111111111111112',
    overallScore: 500,
    rugCheckScore: 450,
    goPlusResult: null,
    honeypotResult: { sellable: true, estimatedTax: 0.01 },
    lpStatus: { burned: true, burnPercent: 98, locked: false },
    authorityStatus: {
      mintRevoked: true,
      freezeRevoked: true,
      metadataMutable: false,
    },
    riskFactors: [],
    isToken2022: false,
    checkedAt: Date.now(),
    rugCheckAvailable: true,
    goPlusAvailable: false,
    top10HolderPercent: 15,
    largestHolderPercent: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle Hooks
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Test Suites
// ---------------------------------------------------------------------------

describe('SafetyBadge', () => {
  // =======================================================================
  // Safety Level Classification Tests
  // =======================================================================

  describe('Safety Level — Green / Safe', () => {
    it('renders green badge for safe tokens (score ≥300, all authorities revoked)', () => {
      const report = createSafeReport({
        overallScore: 500,
        authorityStatus: {
          mintRevoked: true,
          freezeRevoked: true,
          metadataMutable: false,
        },
      });

      const { container } = render(<SafetyBadge report={report} />);

      // Verify the badge wrapper has the "safety-safe" class
      expect(container.querySelector('.safety-safe')).toBeTruthy();

      // Verify "Safe" label text is displayed
      expect(screen.getByText('Safe')).toBeTruthy();

      // Verify the score is displayed as "500/1000"
      expect(screen.getByText('500/1000')).toBeTruthy();

      // Verify the green dot emoji is rendered
      expect(screen.getByText('🟢')).toBeTruthy();
    });

    it('classifies score exactly at 300 boundary as safe when authorities revoked', () => {
      const report = createSafeReport({ overallScore: 300 });

      const { container } = render(<SafetyBadge report={report} />);

      expect(container.querySelector('.safety-safe')).toBeTruthy();
      expect(screen.getByText('Safe')).toBeTruthy();
      expect(screen.getByText('300/1000')).toBeTruthy();
    });

    it('classifies maximum score 1000 as safe', () => {
      const report = createSafeReport({ overallScore: 1000 });

      const { container } = render(<SafetyBadge report={report} />);

      expect(container.querySelector('.safety-safe')).toBeTruthy();
      expect(screen.getByText('1000/1000')).toBeTruthy();
    });
  });

  describe('Safety Level — Yellow / Moderate', () => {
    it('renders yellow badge for tokens with partial concerns', () => {
      // overallScore 250: fails safe check (< 300)
      // Passes critical: >= 100, sellable, top10 ≤ 50, < 3 risk factors
      // Passes risky: >= 200, both authorities revoked
      // Falls through to moderate
      const report = createSafeReport({
        overallScore: 250,
        riskFactors: ['mutable metadata'],
      });

      const { container } = render(<SafetyBadge report={report} />);

      expect(container.querySelector('.safety-moderate')).toBeTruthy();
      expect(screen.getByText('Caution')).toBeTruthy();
      expect(screen.getByText('🟡')).toBeTruthy();
      expect(screen.getByText('250/1000')).toBeTruthy();
    });

    it('classifies score 299 with revoked authorities as moderate (just below safe)', () => {
      const report = createSafeReport({
        overallScore: 299,
        riskFactors: [],
      });

      const { container } = render(<SafetyBadge report={report} />);

      // 299 < 300 → not safe
      // 299 >= 100, sellable, top10 ≤ 50, 0 risk factors → not critical
      // 299 >= 200, both revoked → not risky
      // → moderate
      expect(container.querySelector('.safety-moderate')).toBeTruthy();
      expect(screen.getByText('Caution')).toBeTruthy();
    });
  });

  describe('Safety Level — Orange / Risky', () => {
    it('renders orange badge when mint authority is active', () => {
      // overallScore 250: fails safe check (< 300)
      // sellable, top10 OK, < 3 risk factors → not critical
      // !mintRevoked → risky
      const report = createSafeReport({
        overallScore: 250,
        authorityStatus: {
          mintRevoked: false,
          freezeRevoked: true,
          metadataMutable: false,
        },
      });

      const { container } = render(<SafetyBadge report={report} />);

      expect(container.querySelector('.safety-risky')).toBeTruthy();
      expect(screen.getByText('Risky')).toBeTruthy();
      expect(screen.getByText('🟠')).toBeTruthy();
    });

    it('renders orange badge when freeze authority is active', () => {
      const report = createSafeReport({
        overallScore: 250,
        authorityStatus: {
          mintRevoked: true,
          freezeRevoked: false,
          metadataMutable: false,
        },
      });

      const { container } = render(<SafetyBadge report={report} />);

      expect(container.querySelector('.safety-risky')).toBeTruthy();
      expect(screen.getByText('Risky')).toBeTruthy();
    });

    it('renders orange badge when score is below 200 (above critical at 100)', () => {
      // overallScore 150: fails safe (< 300), not critical (>= 100, sellable, top10 OK)
      // score < 200 → risky
      const report = createSafeReport({
        overallScore: 150,
      });

      const { container } = render(<SafetyBadge report={report} />);

      expect(container.querySelector('.safety-risky')).toBeTruthy();
      expect(screen.getByText('Risky')).toBeTruthy();
    });
  });

  describe('Safety Level — Red / Critical', () => {
    it('renders red badge for tokens with very low score (< 100)', () => {
      const report = createSafeReport({
        overallScore: 50,
        honeypotResult: { sellable: false, estimatedTax: 1.0 },
        riskFactors: ['honeypot', 'high concentration', 'mint authority'],
      });

      const { container } = render(<SafetyBadge report={report} />);

      expect(container.querySelector('.safety-critical')).toBeTruthy();
      expect(screen.getByText('Critical Risk')).toBeTruthy();
      expect(screen.getByText('🔴')).toBeTruthy();
      expect(screen.getByText('50/1000')).toBeTruthy();
    });

    it('renders red badge when token is a honeypot (not sellable)', () => {
      // overallScore 250 bypasses safe check (< 300)
      // !sellable triggers critical
      const report = createSafeReport({
        overallScore: 250,
        honeypotResult: { sellable: false, estimatedTax: 1.0 },
      });

      const { container } = render(<SafetyBadge report={report} />);

      expect(container.querySelector('.safety-critical')).toBeTruthy();
      expect(screen.getByText('Critical Risk')).toBeTruthy();
    });

    it('renders red badge when top 10 holders exceed 50%', () => {
      // overallScore 250 bypasses safe check (< 300)
      // top10HolderPercent > 50 triggers critical
      const report = createSafeReport({
        overallScore: 250,
        top10HolderPercent: 65,
      });

      const { container } = render(<SafetyBadge report={report} />);

      expect(container.querySelector('.safety-critical')).toBeTruthy();
      expect(screen.getByText('Critical Risk')).toBeTruthy();
    });

    it('renders red badge when 3 or more risk factors present', () => {
      const report = createSafeReport({
        overallScore: 250,
        riskFactors: ['risk-factor-alpha', 'risk-factor-beta', 'risk-factor-gamma'],
      });

      const { container } = render(<SafetyBadge report={report} />);

      expect(container.querySelector('.safety-critical')).toBeTruthy();
      expect(screen.getByText('Critical Risk')).toBeTruthy();
    });

    it('renders red badge when score is exactly 0', () => {
      const report = createSafeReport({ overallScore: 0 });

      const { container } = render(<SafetyBadge report={report} />);

      expect(container.querySelector('.safety-critical')).toBeTruthy();
      expect(screen.getByText('0/1000')).toBeTruthy();
    });
  });

  // =======================================================================
  // Tooltip / Detail Breakdown Panel Tests
  // =======================================================================

  describe('Detail Breakdown', () => {
    it('shows RugCheck + safety detail breakdown on click', () => {
      const report = createSafeReport({
        rugCheckScore: 450,
        honeypotResult: { sellable: true, estimatedTax: 0.01 },
        lpStatus: { burned: true, burnPercent: 98, locked: false },
        authorityStatus: {
          mintRevoked: true,
          freezeRevoked: true,
          metadataMutable: false,
        },
        top10HolderPercent: 15,
        largestHolderPercent: 5,
      });

      render(<SafetyBadge report={report} />);

      // Click the badge button to expand details
      const button = screen.getByRole('button');
      fireEvent.click(button);

      // Verify RugCheck Score row
      expect(screen.getByText('RugCheck Score:')).toBeTruthy();
      expect(screen.getByText('450')).toBeTruthy();

      // Verify Honeypot Test row
      expect(screen.getByText('Honeypot Test:')).toBeTruthy();
      expect(screen.getByText('✅ Sellable')).toBeTruthy();

      // Verify Estimated Tax (0.01 * 100 = 1.0%)
      expect(screen.getByText('Estimated Tax:')).toBeTruthy();
      expect(screen.getByText('1.0%')).toBeTruthy();

      // Verify Mint Authority
      expect(screen.getByText('Mint Authority:')).toBeTruthy();

      // Verify Freeze Authority
      expect(screen.getByText('Freeze Authority:')).toBeTruthy();

      // Both authorities revoked — two instances of "✅ Revoked"
      const revokedElements = screen.getAllByText('✅ Revoked');
      expect(revokedElements.length).toBe(2);

      // Verify LP Status (burned at 98%)
      expect(screen.getByText('LP Status:')).toBeTruthy();
      expect(screen.getByText('🔥 Burned (98%)')).toBeTruthy();

      // Verify Top 10 Holders
      expect(screen.getByText('Top 10 Holders:')).toBeTruthy();
      expect(screen.getByText('15.0%')).toBeTruthy();

      // Verify Largest Holder
      expect(screen.getByText('Largest Holder:')).toBeTruthy();
      expect(screen.getByText('5.0%')).toBeTruthy();
    });

    it('shows risk factors in the detail view', () => {
      const report = createSafeReport({
        overallScore: 250,
        riskFactors: ['mutable metadata', 'high concentration'],
      });

      render(<SafetyBadge report={report} />);
      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('Risk Factors:')).toBeTruthy();
      expect(screen.getByText('mutable metadata')).toBeTruthy();
      expect(screen.getByText('high concentration')).toBeTruthy();
    });

    it('shows Token-2022 warning when applicable (per AAP Section 0.1.1)', () => {
      const report = createSafeReport({ isToken2022: true });

      render(<SafetyBadge report={report} />);
      fireEvent.click(screen.getByRole('button'));

      // Token-2022 extension risk warning
      expect(screen.getByText('⚠️ Token-2022 Extensions')).toBeTruthy();
      expect(screen.getByText('PermanentDelegate / Freeze risk')).toBeTruthy();
    });

    it('does not show risk factors section when list is empty', () => {
      const report = createSafeReport({ riskFactors: [] });

      render(<SafetyBadge report={report} />);
      fireEvent.click(screen.getByRole('button'));

      expect(screen.queryByText('Risk Factors:')).toBeNull();
    });

    it('does not show Token-2022 warning for standard SPL tokens', () => {
      const report = createSafeReport({ isToken2022: false });

      render(<SafetyBadge report={report} />);
      fireEvent.click(screen.getByRole('button'));

      expect(screen.queryByText('⚠️ Token-2022 Extensions')).toBeNull();
    });

    it('shows active authority warnings in detail view', () => {
      const report = createSafeReport({
        overallScore: 250,
        authorityStatus: {
          mintRevoked: false,
          freezeRevoked: false,
          metadataMutable: true,
        },
      });

      render(<SafetyBadge report={report} />);
      fireEvent.click(screen.getByRole('button'));

      // Both authorities active — two instances of "⚠️ Active"
      const activeElements = screen.getAllByText('⚠️ Active');
      expect(activeElements.length).toBe(2);
    });

    it('displays LP locked status correctly', () => {
      const report = createSafeReport({
        lpStatus: { burned: false, burnPercent: 0, locked: true },
      });

      render(<SafetyBadge report={report} />);
      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('🔒 Locked')).toBeTruthy();
    });

    it('displays LP unlocked status correctly', () => {
      const report = createSafeReport({
        lpStatus: { burned: false, burnPercent: 0, locked: false },
      });

      render(<SafetyBadge report={report} />);
      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('⚠️ Unlocked')).toBeTruthy();
    });

    it('displays honeypot "Not Sellable" with high estimated tax in detail', () => {
      const report = createSafeReport({
        overallScore: 250,
        honeypotResult: { sellable: false, estimatedTax: 0.5 },
      });

      render(<SafetyBadge report={report} />);
      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('❌ Not Sellable')).toBeTruthy();
      // 0.5 * 100 = 50.0%
      expect(screen.getByText('50.0%')).toBeTruthy();
    });

    it('shows RugCheck "N/A" when rugCheckScore is null', () => {
      const report = createSafeReport({ rugCheckScore: null });

      render(<SafetyBadge report={report} />);
      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('N/A')).toBeTruthy();
    });

    it('toggles detail panel visibility on successive clicks', () => {
      const report = createSafeReport();
      render(<SafetyBadge report={report} />);

      const button = screen.getByRole('button');

      // Initially collapsed — no detail content visible
      expect(screen.queryByText('RugCheck Score:')).toBeNull();

      // First click expands the detail panel
      fireEvent.click(button);
      expect(screen.getByText('RugCheck Score:')).toBeTruthy();

      // Second click collapses the detail panel
      fireEvent.click(button);
      expect(screen.queryByText('RugCheck Score:')).toBeNull();
    });

    it('sets aria-expanded correctly on the badge button', () => {
      const report = createSafeReport();
      render(<SafetyBadge report={report} />);

      const button = screen.getByRole('button');

      // Initially collapsed
      expect(button.getAttribute('aria-expanded')).toBe('false');

      // After click — expanded
      fireEvent.click(button);
      expect(button.getAttribute('aria-expanded')).toBe('true');

      // After second click — collapsed again
      fireEvent.click(button);
      expect(button.getAttribute('aria-expanded')).toBe('false');
    });

    it('has a descriptive aria-label on the badge button', () => {
      const report = createSafeReport({ overallScore: 500 });
      render(<SafetyBadge report={report} />);

      const button = screen.getByRole('button');
      const ariaLabel = button.getAttribute('aria-label') ?? '';

      expect(ariaLabel).toContain('Safe');
      expect(ariaLabel).toContain('500');
    });

    it('displays high holder concentration with fail styling class', () => {
      const report = createSafeReport({
        overallScore: 250,
        top10HolderPercent: 55,
        largestHolderPercent: 25,
      });

      const { container } = render(<SafetyBadge report={report} />);
      fireEvent.click(screen.getByRole('button'));

      // Top 10 > 50% should have "fail" class
      expect(screen.getByText('55.0%')).toBeTruthy();
      const top10Element = screen.getByText('55.0%');
      expect(top10Element.className).toContain('fail');

      // Largest > 20% should have "fail" class
      expect(screen.getByText('25.0%')).toBeTruthy();
      const largestElement = screen.getByText('25.0%');
      expect(largestElement.className).toContain('fail');
    });
  });

  // =======================================================================
  // Edge Cases — Null / Undefined Report (Pending State)
  // =======================================================================

  describe('Pending State', () => {
    it('renders pending state for null report', () => {
      const { container } = render(<SafetyBadge report={null} />);

      // Pending class should be applied
      expect(container.querySelector('.safety-pending')).toBeTruthy();

      // Hourglass emoji displayed
      expect(screen.getByText('⏳')).toBeTruthy();

      // Accessible pending label
      expect(screen.getByLabelText('Safety check pending')).toBeTruthy();

      // Role status for screen readers
      expect(screen.getByRole('status')).toBeTruthy();
    });

    it('renders pending state for undefined report', () => {
      const { container } = render(<SafetyBadge report={undefined} />);

      expect(container.querySelector('.safety-pending')).toBeTruthy();
      expect(screen.getByText('⏳')).toBeTruthy();
      expect(screen.getByLabelText('Safety check pending')).toBeTruthy();
    });

    it('pending state has correct title attribute', () => {
      const { container } = render(<SafetyBadge report={null} />);

      const pendingDot = container.querySelector('.safety-pending');
      expect(pendingDot).toBeTruthy();
      expect(pendingDot!.getAttribute('title')).toBe('Safety check pending');
    });

    it('does not render a clickable button in pending state', () => {
      render(<SafetyBadge report={null} />);

      // No button should exist in pending state
      expect(screen.queryByRole('button')).toBeNull();
    });
  });

  // =======================================================================
  // Compact Mode
  // =======================================================================

  describe('Compact Mode', () => {
    it('renders only a dot with title tooltip in compact mode', () => {
      const report = createSafeReport();
      const { container } = render(
        <SafetyBadge report={report} compact={true} />,
      );

      // Should have a safety-dot span element
      const dot = container.querySelector('.safety-dot');
      expect(dot).toBeTruthy();

      // Title attribute should contain safety level and score
      const title = dot!.getAttribute('title') ?? '';
      expect(title).toContain('Safe');
      expect(title).toContain('500/1000');

      // Should NOT have the full badge wrapper (no expandable panel)
      expect(container.querySelector('.safety-badge-wrapper')).toBeNull();

      // Should NOT have label or score text elements
      expect(container.querySelector('.safety-label')).toBeNull();
      expect(container.querySelector('.safety-score')).toBeNull();
    });

    it('renders correct level class in compact mode for critical tokens', () => {
      const report = createSafeReport({
        overallScore: 50,
        honeypotResult: { sellable: false, estimatedTax: 1.0 },
      });

      const { container } = render(
        <SafetyBadge report={report} compact={true} />,
      );

      const dot = container.querySelector('.safety-dot.safety-critical');
      expect(dot).toBeTruthy();

      const title = dot!.getAttribute('title') ?? '';
      expect(title).toContain('Critical Risk');
    });

    it('includes honeypot warning in compact tooltip', () => {
      const report = createSafeReport({
        overallScore: 250,
        honeypotResult: { sellable: false, estimatedTax: 1.0 },
      });

      const { container } = render(
        <SafetyBadge report={report} compact={true} />,
      );

      const dot = container.querySelector('.safety-dot');
      const title = dot!.getAttribute('title') ?? '';
      expect(title).toContain('Honeypot');
    });

    it('includes active authority warnings in compact tooltip', () => {
      const report = createSafeReport({
        overallScore: 250,
        authorityStatus: {
          mintRevoked: false,
          freezeRevoked: false,
          metadataMutable: true,
        },
      });

      const { container } = render(
        <SafetyBadge report={report} compact={true} />,
      );

      const dot = container.querySelector('.safety-dot');
      const title = dot!.getAttribute('title') ?? '';
      expect(title).toContain('Mint authority active');
      expect(title).toContain('Freeze authority active');
    });

    it('includes Token-2022 warning in compact tooltip', () => {
      const report = createSafeReport({
        isToken2022: true,
      });

      const { container } = render(
        <SafetyBadge report={report} compact={true} />,
      );

      const dot = container.querySelector('.safety-dot');
      const title = dot!.getAttribute('title') ?? '';
      expect(title).toContain('Token-2022');
    });

    it('includes LP unlocked warning in compact tooltip', () => {
      const report = createSafeReport({
        lpStatus: { burned: false, burnPercent: 0, locked: false },
      });

      const { container } = render(
        <SafetyBadge report={report} compact={true} />,
      );

      const dot = container.querySelector('.safety-dot');
      const title = dot!.getAttribute('title') ?? '';
      expect(title).toContain('LP unlocked');
    });

    it('includes high holder concentration warning in compact tooltip', () => {
      const report = createSafeReport({
        overallScore: 250,
        top10HolderPercent: 65,
      });

      const { container } = render(
        <SafetyBadge report={report} compact={true} />,
      );

      const dot = container.querySelector('.safety-dot');
      const title = dot!.getAttribute('title') ?? '';
      expect(title).toContain('Top 10 holders');
      expect(title).toContain('65.0%');
    });

    it('renders pending state in compact mode for null report', () => {
      const { container } = render(
        <SafetyBadge report={null} compact={true} />,
      );

      expect(container.querySelector('.safety-pending')).toBeTruthy();
      expect(screen.getByText('⏳')).toBeTruthy();
    });

    it('has correct accessible aria-label in compact mode', () => {
      const report = createSafeReport();
      render(<SafetyBadge report={report} compact={true} />);

      const element = screen.getByRole('img');
      const ariaLabel = element.getAttribute('aria-label') ?? '';
      expect(ariaLabel).toContain('Safe');
    });
  });

  // =======================================================================
  // Classification Priority Tests — Verifying Safety Level Order
  // =======================================================================

  describe('Classification Priority', () => {
    it('safe check takes priority over all other levels', () => {
      // Even with risk factors, score >= 300 with both authorities revoked = safe
      const report = createSafeReport({
        overallScore: 400,
        riskFactors: ['mutable metadata', 'suspicious activity'],
        authorityStatus: {
          mintRevoked: true,
          freezeRevoked: true,
          metadataMutable: true,
        },
      });

      const { container } = render(<SafetyBadge report={report} />);
      expect(container.querySelector('.safety-safe')).toBeTruthy();
    });

    it('critical check takes priority over risky and moderate', () => {
      // Score 250 (fails safe), with >= 3 risk factors triggers critical
      // Even though score >= 200 with revoked authorities (would be moderate)
      const report = createSafeReport({
        overallScore: 250,
        riskFactors: ['risk-a', 'risk-b', 'risk-c'],
      });

      const { container } = render(<SafetyBadge report={report} />);
      expect(container.querySelector('.safety-critical')).toBeTruthy();
    });

    it('risky check takes priority over moderate', () => {
      // Score 250 (fails safe), no critical triggers
      // But mint not revoked → risky overrides moderate
      const report = createSafeReport({
        overallScore: 250,
        authorityStatus: {
          mintRevoked: false,
          freezeRevoked: true,
          metadataMutable: false,
        },
        riskFactors: [],
      });

      const { container } = render(<SafetyBadge report={report} />);
      expect(container.querySelector('.safety-risky')).toBeTruthy();
    });
  });
});
