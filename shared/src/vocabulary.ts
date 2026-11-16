/**
 * The compact short codes the analysis answers with, the maps from those codes to the public
 * vocabulary, and the two level families the domain reasons about — the only definition of any
 * of them.
 *
 * The codes keep a model answer inside its declared completion ceiling, and they are an internal
 * detail: the server translates them through these tables while it assembles a document, so no
 * code reaches the client. Every consumer looks a code up here instead of restating a mapping,
 * which keeps the code space and the public vocabulary distinct — `H` is a confidence code,
 * `HIGH` is the public value it stands for, and the two are never interchangeable.
 *
 * This module imports only types from ./contract.js. It reads no environment, performs no I/O and
 * carries no dependency of its own.
 */

import type { Confidence, LevelType, Side, Timing } from "./contract.js";

// The code space. Each tuple below is the complete list of codes its role may answer with: the
// schemas check an answer against it, and the matching table must cover every member.

/** The twelve level codes an extraction answer may carry, in taxonomy order. */
export const EXTRACTION_CODES = [
  "GCW",
  "GPW",
  "GZG",
  "GPG",
  "GNG",
  "VAH",
  "VAL",
  "POC",
  "IMB",
  "ABS",
  "LV",
  "OTH",
] as const;

/** A level code exactly as the extraction writes it. */
export type ExtractionCode = (typeof EXTRACTION_CODES)[number];

/** The side codes a synthesis answer may carry. `NONE` is a complete read, not a failure. */
export const SYNTHESIS_SIDE_CODES = ["LONG", "SHORT", "NONE"] as const;

/** A side code exactly as the synthesis writes it. */
export type SynthesisSideCode = (typeof SYNTHESIS_SIDE_CODES)[number];

/** The timing codes a synthesis answer may carry, two of which are renamed on the way out. */
export const SYNTHESIS_TIMING_CODES = ["NOW", "RETEST", "BREAK", "WAIT"] as const;

/** A timing code exactly as the synthesis writes it. */
export type SynthesisTimingCode = (typeof SYNTHESIS_TIMING_CODES)[number];

/** The confidence codes a synthesis answer may carry. */
export const CONFIDENCE_CODES = ["H", "M", "L"] as const;

/** A confidence code exactly as the synthesis writes it. */
export type ConfidenceCode = (typeof CONFIDENCE_CODES)[number];

// The translations, one table per code space. Each is typed as a complete record over its own
// code union, so a code added to a tuple without a mapping stops the build, and a lookup of a
// known code cannot be undefined — no consumer needs a fallback value or a cast.

/**
 * The kind of level each extraction code names. A code added to EXTRACTION_CODES without an entry
 * here stops the build; that the twelve values cover the whole taxonomy, each exactly once, is
 * asserted by the suite that reads this table.
 */
export const EXTRACTION_CODE_TO_LEVEL_TYPE: Record<ExtractionCode, LevelType> = {
  GCW: "GEX_CALL_WALL",
  GPW: "GEX_PUT_WALL",
  GZG: "GEX_ZERO_GAMMA",
  GPG: "GEX_POSITIVE_GAMMA_STRIKE",
  GNG: "GEX_NEGATIVE_GAMMA_STRIKE",
  VAH: "FOOTPRINT_VALUE_AREA_HIGH",
  VAL: "FOOTPRINT_VALUE_AREA_LOW",
  POC: "FOOTPRINT_POC",
  IMB: "FOOTPRINT_IMBALANCE",
  ABS: "ABSORPTION",
  LV: "LIQUIDITY_VOID",
  OTH: "OTHER",
};

/** The side each side code names. */
export const SIDE_CODE_TO_SIDE: Record<SynthesisSideCode, Side> = {
  LONG: "LONG",
  SHORT: "SHORT",
  NONE: "NO_TRADE",
};

/** The timing each timing code names. */
export const TIMING_CODE_TO_TIMING: Record<SynthesisTimingCode, Timing> = {
  NOW: "NOW",
  RETEST: "ON_RETEST",
  BREAK: "ON_BREAK",
  WAIT: "WAIT",
};

/** The confidence each confidence code names. */
export const CONFIDENCE_CODE_TO_CONFIDENCE: Record<ConfidenceCode, Confidence> = {
  H: "HIGH",
  M: "MEDIUM",
  L: "LOW",
};

// The two level families. A read's timing turns on whether the image behind its trigger reported a
// footprint level, and a read resting on gamma-exposure levels alone has to say so in its
// assumptions; both questions are answered here, so one definition serves both and no consumer can
// form a different opinion. ABSORPTION, LIQUIDITY_VOID and OTHER belong to neither family.

/** The five gamma-exposure level types, in taxonomy order. */
export const GEX_LEVEL_TYPES = [
  "GEX_CALL_WALL",
  "GEX_PUT_WALL",
  "GEX_ZERO_GAMMA",
  "GEX_POSITIVE_GAMMA_STRIKE",
  "GEX_NEGATIVE_GAMMA_STRIKE",
] as const satisfies readonly LevelType[];

/** The four footprint level types, in taxonomy order. */
export const FOOTPRINT_LEVEL_TYPES = [
  "FOOTPRINT_VALUE_AREA_HIGH",
  "FOOTPRINT_VALUE_AREA_LOW",
  "FOOTPRINT_POC",
  "FOOTPRINT_IMBALANCE",
] as const satisfies readonly LevelType[];

// Membership tables, built once at module scope: a predicate is asked once per level of every
// analysis, and a set answers in constant time without allocating per call.
const GEX_LEVEL_TYPE_SET: ReadonlySet<LevelType> = new Set<LevelType>(GEX_LEVEL_TYPES);
const FOOTPRINT_LEVEL_TYPE_SET: ReadonlySet<LevelType> = new Set<LevelType>(
  FOOTPRINT_LEVEL_TYPES,
);

/** Whether a level type is a gamma-exposure level. False for the other family and the remainder. */
export function isGexLevelType(type: LevelType): boolean {
  return GEX_LEVEL_TYPE_SET.has(type);
}

/** Whether a level type is a footprint level. False for the other family and the remainder. */
export function isFootprintLevelType(type: LevelType): boolean {
  return FOOTPRINT_LEVEL_TYPE_SET.has(type);
}
