/**
 * Dashboard Layout Shell — `apps/web/src/layouts/DashboardLayout.tsx`
 *
 * Root layout component for the Trading Intelligence dashboard. Wraps every
 * page with a persistent sidebar navigation and a scrollable content area.
 * On mobile viewports (< 768px), the sidebar collapses and is accessible
 * via a hamburger toggle in the Sidebar component.
 *
 * Architecture:
 * - Renders the {@link Sidebar} component for navigation with active route
 *   highlighting and a system health indicator.
 * - Uses React Router's `<Outlet />` to render the matched child page
 *   component inside the content area.
 * - All styling consumes CSS custom properties and utility classes from
 *   `globals.css` — no CSS modules, no CSS-in-JS, no component library.
 *
 * Per AAP §0.5.3:
 * - "Sidebar + content area layout component"
 * - "Persistent left sidebar with route links for News Feed, Trade
 *    Opportunities, Performance, and Settings"
 * - "Sidebar collapses to hamburger menu on mobile breakpoints"
 *
 * @module apps/web/src/layouts/DashboardLayout
 */

import { Outlet } from 'react-router-dom';
import Sidebar from '../components/Sidebar';

// ---------------------------------------------------------------------------
// DashboardLayout Component
// ---------------------------------------------------------------------------

/**
 * Dashboard layout shell that renders the sidebar navigation alongside
 * the currently matched route's page content.
 *
 * The layout uses a CSS Grid / Flexbox layout defined in `globals.css`:
 * - `.dashboard-layout` — The root container with sidebar + content columns.
 * - `.dashboard-content` — The scrollable main content area that receives
 *   the page component via React Router's `<Outlet />`.
 *
 * On desktop viewports (≥ 768px), the sidebar is always visible as a
 * fixed-width left column. On mobile viewports (< 768px), the sidebar
 * is hidden by default and toggled via the hamburger button managed
 * internally by the Sidebar component.
 *
 * @example
 * ```tsx
 * // In App.tsx route configuration:
 * <Route element={<DashboardLayout />}>
 *   <Route path="/news" element={<NewsFeed />} />
 *   <Route path="/opportunities" element={<TradeOpportunities />} />
 *   <Route path="/performance" element={<Performance />} />
 *   <Route path="/settings" element={<Settings />} />
 * </Route>
 * ```
 */
export default function DashboardLayout() {
  return (
    <div className="dashboard-layout">
      {/* Persistent sidebar navigation — handles its own mobile toggle */}
      <Sidebar />

      {/* Main content area — scrollable, receives the matched page via Outlet */}
      <main className="dashboard-content" role="main">
        <Outlet />
      </main>
    </div>
  );
}
