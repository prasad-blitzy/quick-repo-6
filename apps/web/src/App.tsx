/**
 * Root Application Component — `apps/web/src/App.tsx`
 *
 * Defines all client-side routes for the Trading Intelligence dashboard.
 * Maps URL paths to page components, all wrapped inside the
 * {@link DashboardLayout} shell which provides the persistent sidebar
 * navigation and main content area.
 *
 * This component is imported by `main.tsx` and rendered inside a
 * `<BrowserRouter>` provider. It does NOT include a `<BrowserRouter>`
 * itself — that responsibility belongs to the entry point.
 *
 * Route table:
 * | Path              | Component            | Purpose                          |
 * |-------------------|----------------------|----------------------------------|
 * | `/`               | `<Navigate>`         | Redirects to `/news`             |
 * | `/news`           | `<NewsFeed />`       | Live news feed with market tabs  |
 * | `/opportunities`  | `<TradeOpportunities />` | Trade board with filters     |
 * | `/performance`    | `<Performance />`    | Historical performance charts    |
 * | `/settings`       | `<Settings />`       | User notification preferences    |
 *
 * Per AAP §0.5.3:
 *   "defines <Routes> mapping paths (/, /news, /opportunities,
 *    /performance, /settings) to page components wrapped in DashboardLayout"
 *
 * Per AAP §0.6.2:
 *   "No user authentication and authorization" — all routes are public,
 *   no protected routes or auth guards.
 *
 * Per AAP §0.7.1:
 *   TypeScript strict mode — compiles under `strict: true` with no `any`.
 *
 * @module apps/web/src/App
 */

import { Routes, Route, Navigate } from 'react-router-dom';

import DashboardLayout from './layouts/DashboardLayout';
import NewsFeed from './pages/NewsFeed';
import TradeOpportunities from './pages/TradeOpportunities';
import Performance from './pages/Performance';
import Settings from './pages/Settings';

// ---------------------------------------------------------------------------
// Root Application Component
// ---------------------------------------------------------------------------

/**
 * Root application component that defines all client-side routes inside
 * the {@link DashboardLayout} shell.
 *
 * The root path (`/`) performs a declarative redirect to `/news` using
 * React Router's `<Navigate>` component with the `replace` prop to avoid
 * pushing a redundant history entry.
 *
 * @example
 * ```tsx
 * // In main.tsx:
 * import { BrowserRouter } from 'react-router-dom';
 * import App from './App';
 *
 * createRoot(document.getElementById('root')!).render(
 *   <BrowserRouter>
 *     <App />
 *   </BrowserRouter>
 * );
 * ```
 *
 * @returns The rendered application with routing and layout shell.
 */
export default function App(): React.JSX.Element {
  return (
    <DashboardLayout>
      <Routes>
        {/* Default landing page — redirect to news feed */}
        <Route path="/" element={<Navigate to="/news" replace />} />

        {/* Live news feed with market tabs and infinite scroll */}
        <Route path="/news" element={<NewsFeed />} />

        {/* Trade opportunities board with filters and card grid */}
        <Route path="/opportunities" element={<TradeOpportunities />} />

        {/* Historical performance charts and statistics */}
        <Route path="/performance" element={<Performance />} />

        {/* User notification preferences configuration */}
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </DashboardLayout>
  );
}
