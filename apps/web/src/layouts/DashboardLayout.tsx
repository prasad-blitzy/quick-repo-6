/**
 * Dashboard Layout Shell — `apps/web/src/layouts/DashboardLayout.tsx`
 *
 * Primary layout component for the Trading Intelligence dashboard. Provides
 * a persistent left sidebar (via the {@link Sidebar} component) and a
 * scrollable main content area that renders the routed page content passed
 * as `children`.
 *
 * This is the **ONLY** layout component in the application — it wraps ALL
 * routes in `App.tsx`.
 *
 * **Desktop (≥ 769 px):**
 * - Sidebar is always visible at `var(--sidebar-width)` (260 px), fixed-position.
 * - Main content has `margin-left` offset equal to the sidebar width.
 *
 * **Mobile (≤ 768 px):**
 * - Sidebar is hidden off-screen and toggled via a hamburger button
 *   (managed internally by the Sidebar component).
 * - Main content takes the full viewport width — no margin offset.
 * - Extra top padding accommodates the hamburger toggle button.
 *
 * Per AAP §0.5.1 Group 10:
 *   "CREATE: `apps/web/src/layouts/DashboardLayout.tsx` — Sidebar + content
 *    area layout component"
 * Per AAP §0.5.3:
 *   "Sidebar collapses to hamburger menu on mobile breakpoints"
 *
 * Architecture:
 * - No component library — custom layout styled with dark-theme CSS custom
 *   properties defined in `globals.css`.
 * - Inline styles referencing CSS custom properties for structural layout.
 * - `window.matchMedia` for responsive viewport detection.
 * - Sidebar component self-manages mobile toggle state (`isOpen`), overlay,
 *   and hamburger button — DashboardLayout only handles content area offset.
 *
 * @module apps/web/src/layouts/DashboardLayout
 */

import {
  useState,
  useCallback,
  useEffect,
  type ReactNode,
  type CSSProperties,
} from 'react';
import Sidebar from '../components/Sidebar';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Media query string matching mobile viewports (≤ 768 px).
 *
 * This matches the sidebar collapse breakpoint defined in `globals.css`:
 * ```css
 * @media (max-width: 768px) { .sidebar { transform: translateX(-100%); } }
 * ```
 */
const MOBILE_BREAKPOINT = '(max-width: 768px)';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** Props accepted by the {@link DashboardLayout} component. */
interface DashboardLayoutProps {
  /**
   * Routed page content rendered inside the main content area.
   * Typically the current page component matched by React Router.
   */
  children: ReactNode;
}

// ---------------------------------------------------------------------------
// Static Styles (non-responsive — shared across all viewports)
// ---------------------------------------------------------------------------

/**
 * Root layout container styles.
 *
 * Uses `display: flex` as a semantic wrapper for sidebar + content, even
 * though the sidebar is `position: fixed` and doesn't participate in
 * flex flow.  The flex container ensures the main content fills the
 * remaining viewport height.
 */
const layoutStyles: CSSProperties = {
  display: 'flex',
  minHeight: '100vh',
  width: '100%',
  backgroundColor: 'var(--color-background)',
};

/**
 * Inner container constraining content width and centering it.
 *
 * `max-width: var(--content-max-width)` (1 400 px) prevents content from
 * stretching across ultra-wide monitors while `margin: 0 auto` centres
 * the constrained block.
 */
const containerStyles: CSSProperties = {
  maxWidth: 'var(--content-max-width)',
  margin: '0 auto',
  width: '100%',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * `DashboardLayout` renders the application shell: a fixed-position
 * {@link Sidebar} for navigation and a scrollable `<main>` region for
 * page content.
 *
 * Responsive inline styles are computed via `window.matchMedia` so that
 * the content area adjusts its `margin-left` and padding when the viewport
 * crosses the 768 px breakpoint.
 *
 * @param props — {@link DashboardLayoutProps}
 *
 * @example
 * ```tsx
 * // In App.tsx:
 * <DashboardLayout>
 *   <Routes>
 *     <Route path="/news" element={<NewsFeed />} />
 *     <Route path="/opportunities" element={<TradeOpportunities />} />
 *     <Route path="/performance" element={<Performance />} />
 *     <Route path="/settings" element={<Settings />} />
 *   </Routes>
 * </DashboardLayout>
 * ```
 */
export default function DashboardLayout({
  children,
}: DashboardLayoutProps): React.JSX.Element {
  // -----------------------------------------------------------------------
  // Responsive viewport detection
  // -----------------------------------------------------------------------

  /**
   * `isMobile` is `true` when the viewport width is ≤ 768 px.
   *
   * Initialised lazily from `window.matchMedia` (guarded for SSR safety).
   * Updated via a `change` event listener attached in the effect below.
   */
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return window.matchMedia(MOBILE_BREAKPOINT).matches;
  });

  /**
   * Stable event handler for the `MediaQueryList` `change` event.
   *
   * Wrapped in `useCallback` to maintain a consistent reference across
   * renders — prevents unnecessary effect re-runs that would add/remove
   * the listener on every render cycle.
   */
  const handleMediaChange = useCallback(
    (event: MediaQueryListEvent): void => {
      setIsMobile(event.matches);
    },
    [],
  );

  /**
   * Subscribe to the media query on mount and clean up on unmount.
   *
   * The initial `setIsMobile` call inside the effect synchronises state
   * in case the lazy initialiser ran in an SSR environment where `window`
   * was unavailable, and the hydrated client viewport differs.
   */
  useEffect(() => {
    const mql: MediaQueryList = window.matchMedia(MOBILE_BREAKPOINT);

    // Synchronise state with current viewport
    setIsMobile(mql.matches);

    mql.addEventListener('change', handleMediaChange);

    return () => {
      mql.removeEventListener('change', handleMediaChange);
    };
  }, [handleMediaChange]);

  // -----------------------------------------------------------------------
  // Responsive content area styles
  // -----------------------------------------------------------------------

  /**
   * Main content area styles — responsive to the `isMobile` flag.
   *
   * - **Desktop:** `margin-left: var(--sidebar-width)` offsets content to
   *   the right of the fixed sidebar; padding is `var(--spacing-6)`.
   * - **Mobile:** No margin offset (sidebar overlays on top); reduced
   *   padding `var(--spacing-4)` with extra `padding-top` to clear the
   *   fixed-position hamburger toggle button.
   * - A `transition` on `margin-left` provides a smooth visual shift when
   *   the viewport crosses the 768 px breakpoint.
   */
  const contentStyles: CSSProperties = {
    flex: 1,
    marginLeft: isMobile ? '0' : 'var(--sidebar-width)',
    padding: isMobile ? 'var(--spacing-4)' : 'var(--spacing-6)',
    paddingTop: isMobile
      ? 'calc(var(--spacing-4) + var(--header-height))'
      : undefined,
    minHeight: '100vh',
    overflowY: 'auto',
    overflowX: 'hidden',
    transition: 'margin-left var(--transition-slow)',
    backgroundColor: 'var(--color-background)',
  };

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div style={layoutStyles}>
      {/* Persistent sidebar navigation — manages its own mobile toggle */}
      <Sidebar />

      {/* Scrollable main content area — renders the routed page */}
      <main style={contentStyles}>
        <div style={containerStyles}>{children}</div>
      </main>
    </div>
  );
}
