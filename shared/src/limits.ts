/**
 * The single source of the shared contract's limits, fixed strings and origins.
 *
 * Server domain, route and adapter modules and the client upload, analysis and history
 * features all import these values, so each bound is declared once here instead of being
 * copied into the layer that enforces it. This module imports nothing and reads no
 * environment: it is the root of the shared package's dependency graph.
 */

// Image bounds.

/** Enforced on the parsed file count by server/src/domain/image-validation.ts, before any provider call. */
export const MAX_IMAGES = 6;

/** Enforced on each parsed buffer's length by server/src/domain/image-validation.ts. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Enforced on the sum of the parsed buffers by server/src/domain/image-validation.ts. */
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

/**
 * The client downscales to this long edge as a courtesy; the control is the dimension check in
 * server/src/domain/image-validation.ts, which re-reads the dimensions from the received bytes.
 */
export const MAX_LONG_EDGE_PX = 2048;

// Analysis bound.

/**
 * The whole-analysis budget, shared across every provider call of one submission and consumed by
 * server/src/domain/deadline.ts. A constant rather than configuration, so no deployment can drift
 * from the deadline the suite asserts.
 */
export const ANALYSIS_BUDGET_MS = 30_000;

// Completion ceilings declared on every outgoing model request.

/** Ceiling on the extraction answer, set per request by the provider adapter. */
export const MAX_TOKENS_EXTRACTION = 400;

/** Ceiling on the synthesis answer, set per request by the provider adapter. */
export const MAX_TOKENS_SYNTHESIS = 150;

// History paging, clamped in server/src/routes/analysis-routes.ts.

export const HISTORY_LIMIT_DEFAULT = 20;

export const HISTORY_LIMIT_MAX = 100;

// Submitted text field caps, clamped once in server/src/domain/analysis-service.ts.

export const INSTRUMENT_MAX_CHARS = 16;

export const CONTEXT_MAX_CHARS = 500;

// Model output caps, checked by server/src/domain/schemas.ts.

export const OBSERVATION_MAX_CHARS = 80;

export const SUMMARY_MAX_CHARS = 140;

// Upload content types, matched against magic-byte sniffing in server/src/domain/image-probe.ts.

export const ACCEPTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type AcceptedImageMimeType = (typeof ACCEPTED_IMAGE_MIME_TYPES)[number];

// Route mount point.

export const API_BASE_PATH = "/api/v1";

// The two origins the client dev server answers on, admitted by the CORS allowlist in
// server/src/app.ts. The IP form is listed because the dev server is reachable by IP while its
// API proxy targets 127.0.0.1.

export const CLIENT_DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
] as const;

// Rendered on every surface that shows a recommendation, and stored on every analysis document.

export const DISCLAIMER =
  "Analysis of the screenshots you provided. It is not investment advice and not a recommendation to trade any instrument.";
