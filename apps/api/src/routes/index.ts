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
 *  - Catch-all 404 handler at the END of all route registrations returns
 *    JSON `{"error":{"message":"Not Found","code":"NOT_FOUND"}}` instead
 *    of Express's default HTML error page
 *  - Named export only — no default export for tree-shaking compatibility
 *
 * @module routes
 */

import { Router, type Request, type Response } from "express";

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

// ---------------------------------------------------------------------------
// Catch-All 404 Handler — MUST be after all route registrations
// ---------------------------------------------------------------------------

/**
 * Catches all requests that did not match any registered route above and
 * returns a JSON 404 response instead of Express's default HTML error page.
 *
 * This handler covers two scenarios:
 *  1. Unmatched paths — e.g., `GET /api/nonexistent`
 *  2. Unsupported methods — e.g., `DELETE /api/health` (only GET is defined)
 *
 * CRITICAL: This middleware MUST remain at the END of all route registrations.
 * Any routes added after this handler will be unreachable.
 */
apiRouter.use("/api", (_req: Request, res: Response): void => {
  res.status(404).json({
    error: {
      message: "Not Found",
      code: "NOT_FOUND",
    },
  });
});
