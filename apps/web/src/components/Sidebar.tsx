/**
 * Navigation Sidebar Component — `apps/web/src/components/Sidebar.tsx`
 *
 * Persistent left-hand navigation sidebar for the Trading Intelligence
 * dashboard. Renders four route links (News Feed, Trade Opportunities,
 * Performance, Settings) using react-router-dom `NavLink` with active
 * state highlighting. On mobile viewports (< 768 px) the sidebar
 * collapses behind a hamburger toggle button and slides in as an
 * overlay.
 *
 * Per AAP §0.5.3:
 * - "Persistent left sidebar with route links for News Feed, Trade
 *    Opportunities, Performance, and Settings"
 * - "Sidebar collapses to hamburger menu on mobile breakpoints"
 *
 * Architecture:
 * - No component library — custom styles via dark-theme CSS custom
 *   properties defined in `globals.css`
 * - `clsx` for conditional className composition
 * - `NavLink` className callback `({ isActive })` drives active styling
 * - `HealthIndicator` dot displayed in sidebar header for system status
 *
 * @module apps/web/src/components/Sidebar
 */

import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import clsx from 'clsx';
import type { SidebarNavItem } from '../types';
import HealthIndicator from './HealthIndicator';

// ---------------------------------------------------------------------------
// Navigation Items — Static route definitions
// ---------------------------------------------------------------------------

/**
 * Ordered list of sidebar navigation entries.
 *
 * Each entry maps to a top-level route defined in `App.tsx`.
 * Icons are emoji glyphs — intentionally simple to avoid pulling
 * in an icon library when no component library is in use.
 *
 * Per AAP §0.5.3 the routes are:
 *   /news, /opportunities, /performance, /settings
 */
const NAV_ITEMS: SidebarNavItem[] = [
  { path: '/news', label: 'News Feed', icon: '📰' },
  { path: '/opportunities', label: 'Trade Opportunities', icon: '📊' },
  { path: '/performance', label: 'Performance', icon: '📈' },
  { path: '/settings', label: 'Settings', icon: '⚙️' },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** Props accepted by the {@link Sidebar} component. */
interface SidebarProps {
  /** Additional CSS class name(s) merged onto the root `<aside>` via `clsx`. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * `Sidebar` renders a fixed-position navigation panel on the left edge
 * of the viewport.
 *
 * **Desktop (≥ 769 px):**
 * - Always visible, occupies `var(--sidebar-width)` (260 px).
 *
 * **Mobile (< 768 px):**
 * - Hidden off-screen via `transform: translateX(-100%)`.
 * - A fixed hamburger `<button>` appears at the top-left corner.
 * - Tapping the button toggles the `isOpen` state:
 *   - `true`  → sidebar slides in (`.sidebar-open`) and a backdrop overlay
 *              covers the rest of the page.
 *   - `false` → sidebar slides back off-screen, overlay disappears.
 * - Clicking a `NavLink` or the overlay automatically closes the sidebar.
 *
 * @param props - {@link SidebarProps}
 */
export default function Sidebar(props: SidebarProps): React.JSX.Element {
  const { className } = props;

  // Mobile toggle state — controls sidebar visibility on small viewports
  const [isOpen, setIsOpen] = useState(false);

  /**
   * Close the mobile sidebar.
   * Extracted as a named function so it can be passed to both NavLink
   * `onClick` handlers and the overlay `onClick`.
   */
  function closeSidebar(): void {
    setIsOpen(false);
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <>
      {/* ----------------------------------------------------------------- */}
      {/* Hamburger toggle — visible ONLY on mobile (< 768 px)              */}
      {/* ----------------------------------------------------------------- */}
      <button
        type="button"
        className="sidebar-toggle"
        onClick={() => { setIsOpen((prev) => !prev); }}
        aria-label="Toggle navigation"
        aria-expanded={isOpen}
      >
        {isOpen ? '✕' : '☰'}
      </button>

      {/* ----------------------------------------------------------------- */}
      {/* Sidebar panel                                                     */}
      {/* ----------------------------------------------------------------- */}
      <aside className={clsx('sidebar', isOpen && 'sidebar-open', className)}>
        {/* Header — branding + system health dot */}
        <div className="sidebar-header">
          <h2 className="sidebar-title">Trading Intelligence</h2>
          <HealthIndicator />
        </div>

        {/* Navigation links */}
        <nav className="sidebar-nav" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                clsx('sidebar-link', isActive && 'sidebar-link-active')
              }
              onClick={closeSidebar}
            >
              {item.icon != null && item.icon !== '' && (
                <span className="sidebar-link-icon" aria-hidden="true">
                  {item.icon}
                </span>
              )}
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* ----------------------------------------------------------------- */}
      {/* Backdrop overlay — visible ONLY when sidebar is open on mobile    */}
      {/* ----------------------------------------------------------------- */}
      {isOpen && (
        <div
          className="sidebar-overlay active"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}
    </>
  );
}
