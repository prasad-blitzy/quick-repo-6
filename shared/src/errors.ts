/**
 * The closed error table: every code the API can answer with, its HTTP status and its
 * user-facing sentence.
 *
 * The table is closed on purpose. A condition outside it is handled by clamping or dropping the
 * value that caused it rather than by inventing a code, so no consumer may add one here without
 * also changing the response contract the server and the client both validate against.
 * INTERNAL_ERROR is the fallback for an unexpected throw — it keeps the `{ code, message }` body
 * shape true and is not another trigger of its own.
 *
 * Each message is a complete sentence read by the operator, so it names the limit it hit and
 * never a path, a stack, a credential or a provider model. Where a sentence cites a number, the
 * number is derived from the bound in ./limits.js so the two cannot drift apart.
 */

import {
  ANALYSIS_BUDGET_MS,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_LONG_EDGE_PX,
  MAX_TOTAL_BYTES,
} from "./limits.js";

/** Every code the API can answer with, in the order the error table lists them. */
export const ERROR_CODES = [
  "NO_IMAGES",
  "TOO_MANY_IMAGES",
  "UNSUPPORTED_IMAGE_TYPE",
  "IMAGE_TOO_LARGE",
  "IMAGE_TOO_LARGE_DIMENSIONS",
  "NO_READABLE_IMAGES",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_QUOTA_EXCEEDED",
  "PROVIDER_MODEL_UNSUPPORTED",
  "ANALYSIS_TIMEOUT",
  "ANALYSIS_FAILED",
  "NOT_FOUND",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The HTTP status each code is answered with. Typed as a complete record, so a code added to
 * ERROR_CODES without a status stops the build instead of answering with a missing status.
 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  NO_IMAGES: 400,
  TOO_MANY_IMAGES: 400,
  UNSUPPORTED_IMAGE_TYPE: 400,
  IMAGE_TOO_LARGE: 400,
  IMAGE_TOO_LARGE_DIMENSIONS: 400,
  NO_READABLE_IMAGES: 422,
  PROVIDER_NOT_CONFIGURED: 503,
  PROVIDER_QUOTA_EXCEEDED: 503,
  PROVIDER_MODEL_UNSUPPORTED: 503,
  ANALYSIS_TIMEOUT: 504,
  ANALYSIS_FAILED: 502,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
};

/**
 * The default sentence returned with each code, shown to the operator as-is. Typed as a complete
 * record for the same reason as ERROR_STATUS, so no code can be answered without one.
 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  NO_IMAGES: `Submit at least one chart screenshot, up to ${MAX_IMAGES} per analysis.`,
  TOO_MANY_IMAGES: `Submit at most ${MAX_IMAGES} images per analysis.`,
  UNSUPPORTED_IMAGE_TYPE: "Only PNG, JPEG and WebP images are accepted.",
  IMAGE_TOO_LARGE: `Each image must be at most ${
    MAX_IMAGE_BYTES / (1024 * 1024)
  } MiB, and all images together at most ${MAX_TOTAL_BYTES / (1024 * 1024)} MiB.`,
  IMAGE_TOO_LARGE_DIMENSIONS: `Each image must be at most ${MAX_LONG_EDGE_PX} pixels on its long edge.`,
  NO_READABLE_IMAGES: "None of the submitted images could be read as a chart.",
  PROVIDER_NOT_CONFIGURED: "The analysis provider is not configured.",
  PROVIDER_QUOTA_EXCEEDED:
    "The analysis provider rejected the request for insufficient credits.",
  PROVIDER_MODEL_UNSUPPORTED:
    "The configured analysis model is unavailable or does not accept images.",
  ANALYSIS_TIMEOUT: `The analysis did not finish within ${
    ANALYSIS_BUDGET_MS / 1000
  } seconds.`,
  ANALYSIS_FAILED:
    "The analysis provider returned an answer that could not be used.",
  NOT_FOUND: "That analysis does not exist.",
  INTERNAL_ERROR: "Something went wrong while handling the request.",
};
