/**
 * CORS Configuration Middleware
 *
 * Configures and exports Express CORS middleware for the Trading Intelligence
 * API. Uses the validated `FRONTEND_URL` environment variable to allow
 * cross-origin requests from the React web dashboard.
 *
 * In development, `FRONTEND_URL` defaults to `http://localhost:5173` (Vite dev
 * server). In production, set `FRONTEND_URL` to the deployed Vercel frontend
 * URL to restrict cross-origin access.
 *
 * The `cors` package automatically handles preflight OPTIONS requests when
 * registered with Express via `app.use(corsMiddleware)`.
 *
 * @module middleware/cors
 */

import cors from "cors";
import { env } from "../config/env.js";

/**
 * CORS options configured for the Trading Intelligence API.
 *
 * - `origin` — Restricts requests to the React frontend URL only.
 * - `credentials` — Enables cookies and Authorization header forwarding.
 * - `methods` — Whitelist of allowed HTTP methods for REST API endpoints.
 * - `allowedHeaders` — Whitelist of request headers the client may send.
 */
const corsOptions: cors.CorsOptions = {
  origin: env.FRONTEND_URL,
  credentials: true,
  methods: ["GET", "PUT", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

/**
 * Pre-configured Express CORS middleware instance.
 *
 * Register in the Express middleware chain after `helmet()` and before route
 * handlers:
 *
 * ```ts
 * import { corsMiddleware } from "./middleware/cors.js";
 * app.use(corsMiddleware);
 * ```
 */
export const corsMiddleware = cors(corsOptions);
