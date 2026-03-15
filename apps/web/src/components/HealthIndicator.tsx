/**
 * System Health Status Indicator — `apps/web/src/components/HealthIndicator.tsx`
 *
 * Displays a colored dot (green/yellow/red) based on the `/api/health` endpoint
 * data. Designed for display in the dashboard header or sidebar. On hover, a
 * tooltip reveals detailed dependency status for PostgreSQL and Redis connections.
 *
 * Per AAP Section 0.5.3: "Global status dot in the header showing system health
 * (green/yellow/red) based on the `/api/health` endpoint"
 *
 * Architecture:
 * - No component library — custom HTML/CSS tooltip implementation
 * - Dark theme tokens from globals.css (--color-success, --color-warning, --color-danger)
 * - Polls health endpoint at a configurable interval (default 30 s)
 * - AbortController-based cleanup on unmount to prevent stale setState calls
 * - Pulse animation on unhealthy status for visual urgency
 *
 * @module apps/web/src/components/HealthIndicator
 */

import { useState, useEffect } from 'react';
import clsx from 'clsx';
import type { HealthStatus, HealthStatusLevel } from '../types';
import { apiGet } from '../lib/api-client';

// ---------------------------------------------------------------------------
// Constants — Status-to-visual mappings
// ---------------------------------------------------------------------------

/**
 * Maps each health status level to the CSS custom property that
 * controls the dot's background color.
 *
 * - `healthy`   → green  (`--color-success`)
 * - `degraded`  → yellow (`--color-warning`)
 * - `unhealthy` → red    (`--color-danger`)
 */
const statusColors: Record<HealthStatusLevel, string> = {
  healthy: 'var(--color-success)',
  degraded: 'var(--color-warning)',
  unhealthy: 'var(--color-danger)',
};

/**
 * Maps each health status level to a human-readable status label
 * displayed in the tooltip header.
 */
const statusLabels: Record<HealthStatusLevel, string> = {
  healthy: 'All Systems Operational',
  degraded: 'Partial Degradation',
  unhealthy: 'System Unavailable',
};

/**
 * Maps each health status level to a subtle glow box-shadow so the
 * dot colour bleeds outward, reinforcing the severity signal.
 * The unhealthy state receives no glow (the pulse animation provides
 * sufficient visual weight).
 */
const statusGlows: Record<HealthStatusLevel, string> = {
  healthy: '0 0 6px var(--color-success)',
  degraded: '0 0 6px var(--color-warning)',
  unhealthy: 'none',
};

// ---------------------------------------------------------------------------
// Fallback state — used when the health endpoint is unreachable
// ---------------------------------------------------------------------------

/** Produces a fallback HealthStatus snapshot representing total failure. */
function createUnhealthyFallback(): HealthStatus {
  return {
    status: 'unhealthy',
    postgres: false,
    redis: false,
    lastChecked: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helper — Relative-time formatter for the "Last checked" tooltip line
// ---------------------------------------------------------------------------

/**
 * Converts an ISO 8601 timestamp into a human-readable "time ago" string.
 * Avoids pulling in `date-fns` just for this single use; keeps the
 * component self-contained.
 *
 * @param isoString - ISO 8601 date-time string (e.g. from `lastChecked`)
 * @returns A relative time label such as "just now", "2 min ago", etc.
 */
function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (Number.isNaN(diffMs) || diffMs < 0) {
    return 'just now';
  }

  const diffSeconds = Math.floor(diffMs / 1_000);
  if (diffSeconds < 60) {
    return 'just now';
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${String(diffMinutes)} min ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${String(diffHours)}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${String(diffDays)}d ago`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** Props accepted by the {@link HealthIndicator} component. */
interface HealthIndicatorProps {
  /** Additional CSS class name(s) merged onto the root container via `clsx`. */
  className?: string | undefined;

  /**
   * Polling interval in milliseconds for the `/health` endpoint.
   * Defaults to `30_000` (30 seconds).
   */
  pollInterval?: number | undefined;
}

// ---------------------------------------------------------------------------
// Default poll interval (30 s)
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL = 30_000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * `HealthIndicator` renders a small coloured dot whose colour reflects the
 * overall system health status. On mouse-enter a tooltip reveals detailed
 * PostgreSQL and Redis connection status plus the last-checked timestamp.
 *
 * **Data flow:**
 * 1. On mount, fetches `GET /api/health` via `apiGet<HealthStatus>`.
 * 2. Starts a `setInterval` that repeats the fetch every `pollInterval` ms.
 * 3. Each response updates the `health` state; on error, falls back to an
 *    `'unhealthy'` snapshot so the dot always renders.
 * 4. On unmount the interval is cleared and any in-flight request is aborted.
 *
 * @param props - {@link HealthIndicatorProps}
 */
export default function HealthIndicator(
  props: HealthIndicatorProps,
): React.JSX.Element {
  const { className, pollInterval } = props;
  const interval = pollInterval ?? DEFAULT_POLL_INTERVAL;

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [showTooltip, setShowTooltip] = useState(false);

  // -----------------------------------------------------------------------
  // Data fetching — initial + periodic polling
  // -----------------------------------------------------------------------

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | null = null;

    /** Fetch health status, gracefully falling back on failure. */
    async function fetchHealth(): Promise<void> {
      try {
        const response = await apiGet<HealthStatus>(
          '/health',
          undefined,
          controller.signal,
        );

        // Guard: the API envelope may contain null data on error responses
        if (response.success && response.data != null) {
          setHealth(response.data);
        } else {
          setHealth(createUnhealthyFallback());
        }
      } catch {
        // Network failure, timeout, or request cancelled via AbortController
        // — present an unhealthy state rather than leaving health as null
        if (!controller.signal.aborted) {
          setHealth(createUnhealthyFallback());
        }
      }
    }

    // Initial fetch on mount
    void fetchHealth();

    // Periodic polling
    timer = setInterval(() => {
      void fetchHealth();
    }, interval);

    // Cleanup on unmount
    return () => {
      controller.abort();
      if (timer !== null) {
        clearInterval(timer);
      }
    };
  }, [interval]);

  // -----------------------------------------------------------------------
  // Derived values
  // -----------------------------------------------------------------------

  const currentStatus: HealthStatusLevel = health?.status ?? 'unhealthy';
  const dotColor = statusColors[currentStatus];
  const dotGlow = statusGlows[currentStatus];
  const label = statusLabels[currentStatus];
  const isUnhealthy = currentStatus === 'unhealthy';

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div
      className={clsx('health-indicator', className)}
      style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={() => { setShowTooltip(true); }}
      onMouseLeave={() => { setShowTooltip(false); }}
    >
      {/* Coloured status dot */}
      <button
        type="button"
        className={clsx(isUnhealthy && 'animate-pulse')}
        aria-label={`System health: ${label}`}
        onClick={() => { setShowTooltip((prev) => !prev); }}
        style={{
          width: '10px',
          height: '10px',
          borderRadius: 'var(--radius-full)',
          backgroundColor: dotColor,
          display: 'inline-block',
          cursor: 'pointer',
          border: 'none',
          padding: 0,
          boxShadow: dotGlow,
          transition: 'box-shadow var(--transition-fast)',
        }}
      />

      {/* Tooltip — conditionally rendered */}
      {showTooltip && (
        <div
          role="status"
          aria-live="polite"
          className="animate-fade-in"
          style={{
            position: 'absolute',
            top: 'calc(100% + var(--spacing-2))',
            right: 0,
            minWidth: '200px',
            padding: 'var(--spacing-3)',
            backgroundColor: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 50,
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-primary)',
            lineHeight: 'var(--line-height-normal)',
            whiteSpace: 'nowrap',
          }}
        >
          {/* Status label */}
          <div
            style={{
              fontWeight: 'var(--font-weight-semibold)',
              marginBlockEnd: 'var(--spacing-2)',
              color: dotColor,
            }}
          >
            {label}
          </div>

          {/* Dependency statuses */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--spacing-1)',
            }}
          >
            <span>
              {health?.postgres ? '✅' : '❌'}{' '}
              <span style={{ color: 'var(--color-text-secondary)' }}>
                PostgreSQL
              </span>
            </span>
            <span>
              {health?.redis ? '✅' : '❌'}{' '}
              <span style={{ color: 'var(--color-text-secondary)' }}>
                Redis
              </span>
            </span>
          </div>

          {/* Last checked timestamp */}
          <div
            style={{
              marginBlockStart: 'var(--spacing-2)',
              color: 'var(--color-text-tertiary)',
            }}
          >
            Last checked:{' '}
            {health != null
              ? formatRelativeTime(health.lastChecked)
              : 'never'}
          </div>
        </div>
      )}
    </div>
  );
}
