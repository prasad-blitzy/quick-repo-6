/**
 * Express Router Aggregator
 *
 * Central router module that creates the main API router instance, imports all
 * feature-specific sub-routers, and mounts them under the `/api` prefix. This
 * file is the single entry point for all REST API routes in the application.
 *
 * Route mounting strategy:
 *  - The `/api` prefix is applied HERE in the aggregator — not in individual
 *    route files or in the Express app entry point (`index.ts`).
 *  - Each sub-router defines its own path segment (e.g., `/news`, `/health`).
 *  - The aggregated router is consumed by `apps/api/src/index.ts` via:
 *    ```ts
 *    import { apiRouter } from "./routes/index.js";
 *    app.use(apiRouter);
 *    ```
 *
 * Complete endpoint map:
 *  | Method | Path                    | Handler                     |
 *  |--------|-------------------------|-----------------------------|
 *  | GET    | /api/news               | news.routes.ts              |
 *  | GET    | /api/opportunities      | opportunities.routes.ts     |
 *  | GET    | /api/performance        | performance.routes.ts       |
 *  | GET    | /api/settings/:chatId   | settings.routes.ts          |
 *  | PUT    | /api/settings/:chatId   | settings.routes.ts          |
 *  | GET    | /api/health             | health.routes.ts            |
 *
 * Adding a new route module:
 *  1. Create the route file under `apps/api/src/routes/`
 *  2. Import the named router constant here
 *  3. Mount it with `apiRouter.use("/api", newRouter);`
 *
 * Design decisions:
 *  - No middleware in aggregator — route-specific middleware belongs in
 *    individual route files
 *  - No catch-all 404 route — handled by the global error handler middleware
 *    in `apps/api/src/middleware/error-handler.ts`
 *  - Named export only — no default export for tree-shaking compatibility
 *
 * @module routes
 */

import { Router } from "express";

import { newsRouter } from "./news.routes.js";
import { opportunitiesRouter } from "./opportunities.routes.js";
import { performanceRouter } from "./performance.routes.js";
import { settingsRouter } from "./settings.routes.js";
import { healthRouter } from "./health.routes.js";

// ---------------------------------------------------------------------------
// Main API Router
// ---------------------------------------------------------------------------

/**
 * Aggregated Express Router that mounts all feature sub-routers under the
 * `/api` path prefix. This is the only router imported by the application
 * entry point (`apps/api/src/index.ts`).
 *
 * Usage in entry point:
 * ```ts
 * import { apiRouter } from "./routes/index.js";
 * app.use(apiRouter); // No additional prefix — /api is already applied
 * ```
 */
export const apiRouter: ReturnType<typeof Router> = Router();

// ---------------------------------------------------------------------------
// Sub-Router Mounting — All routes served under /api prefix
// ---------------------------------------------------------------------------

// News feed — GET /api/news (paginated, filterable by market/source/date)
apiRouter.use("/api", newsRouter);

// Trade opportunities — GET /api/opportunities (filterable, sortable)
apiRouter.use("/api", opportunitiesRouter);

// Performance tracking — GET /api/performance (aggregate P&L statistics)
apiRouter.use("/api", performanceRouter);

// User settings — GET/PUT /api/settings/:chatId (Telegram user preferences)
apiRouter.use("/api", settingsRouter);

// Health check — GET /api/health (PostgreSQL, Redis, API source status)
apiRouter.use("/api", healthRouter);
