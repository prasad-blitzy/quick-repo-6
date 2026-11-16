/**
 * The document shapes and public vocabulary of the cross-package contract.
 *
 * This module is the single definition of what an analysis document is: the server builds and
 * validates every response against it and the client renders from it, so neither package may
 * restate a shape. The vocabulary is declared as `as const` tuples rather than as types alone,
 * so the server's schemas and the client's rendering iterate one list instead of repeating it.
 *
 * The structural rule the shapes carry is that a price exists only on a level. A recommendation
 * refers to levels by id, so no price reaches a consumer that a submitted image did not report.
 */

import type { ErrorCode } from "./errors.js";

// The level taxonomy, in the order every layer quotes it.

export const LEVEL_TYPES = [
  "GEX_CALL_WALL",
  "GEX_PUT_WALL",
  "GEX_ZERO_GAMMA",
  "GEX_POSITIVE_GAMMA_STRIKE",
  "GEX_NEGATIVE_GAMMA_STRIKE",
  "FOOTPRINT_VALUE_AREA_HIGH",
  "FOOTPRINT_VALUE_AREA_LOW",
  "FOOTPRINT_POC",
  "FOOTPRINT_IMBALANCE",
  "ABSORPTION",
  "LIQUIDITY_VOID",
  "OTHER",
] as const;

/** One of the twelve level kinds a level may carry. */
export type LevelType = (typeof LEVEL_TYPES)[number];

export const SIDES = ["LONG", "SHORT", "NO_TRADE"] as const;

/** The side a recommendation takes. `NO_TRADE` is a complete answer, not a failure. */
export type Side = (typeof SIDES)[number];

export const TIMINGS = ["NOW", "ON_RETEST", "ON_BREAK", "WAIT"] as const;

/** When the recommendation's trigger is expected to be actionable. */
export type Timing = (typeof TIMINGS)[number];

export const CONFIDENCES = ["HIGH", "MEDIUM", "LOW"] as const;

/** How much the recommendation's evidence supports it. */
export type Confidence = (typeof CONFIDENCES)[number];

export const IMAGE_STATUSES = ["ANALYZED", "UNREADABLE"] as const;

/** Whether a submitted image yielded any level at a readable price. */
export type ImageStatus = (typeof IMAGE_STATUSES)[number];

// Document shapes.

/** One submitted screenshot and what the analysis made of it. */
export interface AnalysisImage {
  imageId: string;
  fileName: string;
  /** The content type the stored bytes are served with. */
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  status: ImageStatus;
  /** Present only when `status` is `"UNREADABLE"`, and says why the image could not be read. */
  extractionError?: string;
}

/** One price reported from one submitted image, labelled with the kind of level it is. */
export interface Level {
  levelId: string;
  /** The price exactly as the analysis reported it: never rounded, estimated or formatted. */
  price: number;
  type: LevelType;
  /** The image this price was reported from. */
  imageId: string;
  /** Present only where the level needs a qualifier, such as the strike a gamma level sits at. */
  note?: string;
}

/**
 * The trade read, expressed entirely as references to levels so no price of its own can exist.
 * A `NO_TRADE`/`WAIT` read carries null references and no targets.
 */
export interface Recommendation {
  side: Side;
  timing: Timing;
  triggerLevelId: string | null;
  entryLevelId: string | null;
  invalidationLevelId: string | null;
  targetLevelIds: string[];
  confidence: Confidence;
  summary: string;
}

/** One entry of the evidence behind a recommendation, tied to the level ids and image it cites. */
export interface Rationale {
  claim: string;
  imageId: string;
  levelIds: string[];
}

/** What the analysis cost and which instructions produced it. */
export interface ModelUsage {
  provider: "openrouter";
  model: string;
  /**
   * The built-in instruction versions that produced this document, as the single string
   * `extraction@<extractionVersion>;synthesis@<synthesisVersion>`: the extraction version first,
   * the synthesis version second, joined by `;`. The server writes it from the prompt library at
   * request time, so splitting on `;` recovers both versions.
   */
  promptVersion: string;
  imageCallCount: number;
  synthesisCompletionTokens: number;
  latencyMs: number;
}

/** A completed analysis: the create response and the persisted record, byte for byte. */
export interface AnalysisDocument {
  analysisId: string;
  /** ISO-8601 UTC instant at which the analysis completed. */
  createdAt: string;
  /** Empty string when none was submitted. */
  instrument: string;
  /** Empty string when none was submitted. */
  context: string;
  images: AnalysisImage[];
  levels: Level[];
  recommendation: Recommendation;
  rationale: Rationale[];
  /** What had to be assumed or corrected, authored by the server rather than the analysis. */
  assumptions: string[];
  modelUsage: ModelUsage;
  disclaimer: string;
}

/** The service report: whether the process is up and whether a model credential is configured. */
export interface HealthResponse {
  status: "ok";
  providerConfigured: boolean;
  model: string;
}

/** The history page, ordered newest first. */
export interface AnalysisListResponse {
  items: AnalysisDocument[];
}

/** The body of every failed request. */
export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
}
