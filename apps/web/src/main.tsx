/**
 * React Application Entry Point — `apps/web/src/main.tsx`
 *
 * Bootstraps the Trading Intelligence web dashboard by mounting the React
 * component tree into the `#root` DOM element defined in `index.html`.
 *
 * Responsibility chain:
 *  1. Imports `globals.css` as a side-effect to inject all CSS custom
 *     properties (design tokens) into the document before any component
 *     renders. This ensures `var(--color-background)`, `var(--color-surface)`,
 *     `var(--sidebar-width)`, etc. are available to all components.
 *  2. Creates the React root using `createRoot()` (React 19 concurrent mode).
 *  3. Wraps the `<App />` component in `<StrictMode>` for development
 *     double-rendering checks and deprecation warnings.
 *  4. Wraps the tree in `<BrowserRouter>` to enable client-side routing —
 *     `<App />` defines `<Routes>` and `<Route>` elements but does NOT
 *     include a `<BrowserRouter>` itself (that responsibility belongs here).
 *
 * This file is referenced by `index.html`:
 * ```html
 * <script type="module" src="/src/main.tsx"></script>
 * ```
 *
 * Per AAP §0.5.1 Group 10:
 *   "CREATE: `apps/web/src/main.tsx` — React app bootstrap"
 *
 * Per AAP §0.5.3:
 *   "React + Vite + TypeScript SPA with dark theme"
 *
 * Per AAP §0.6.2:
 *   "No user authentication" — no auth providers wrapped here.
 *
 * @module apps/web/src/main
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App';
import './styles/globals.css';

// ---------------------------------------------------------------------------
// DOM Root Element — Validated at startup
// ---------------------------------------------------------------------------

/**
 * The root DOM element that React mounts into. Defined in `index.html` as:
 * ```html
 * <div id="root"></div>
 * ```
 *
 * The non-null assertion (`!`) is safe here because `index.html` is a
 * controlled file that always contains `<div id="root"></div>`. If this
 * element is missing, the application cannot function — a hard crash is
 * the correct behavior.
 */
const rootElement = document.getElementById('root')!;

// ---------------------------------------------------------------------------
// React Root Creation and Rendering
// ---------------------------------------------------------------------------

/**
 * Creates a concurrent React root and renders the full component tree.
 *
 * Component hierarchy:
 * ```
 * <StrictMode>
 *   <BrowserRouter>
 *     <App>
 *       <DashboardLayout>
 *         <Sidebar />
 *         <Routes>
 *           <Route path="/" → Navigate to="/news" />
 *           <Route path="/news" → <NewsFeed /> />
 *           <Route path="/opportunities" → <TradeOpportunities /> />
 *           <Route path="/performance" → <Performance /> />
 *           <Route path="/settings" → <Settings /> />
 *         </Routes>
 *       </DashboardLayout>
 *     </App>
 *   </BrowserRouter>
 * </StrictMode>
 * ```
 *
 * - `StrictMode` enables React development checks (double-rendering,
 *   deprecated API warnings) with zero production overhead.
 * - `BrowserRouter` provides HTML5 history-based client-side routing.
 *   The Vite dev server's historyApiFallback handles serving `index.html`
 *   for all paths, enabling direct URL access to any route.
 */
createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
