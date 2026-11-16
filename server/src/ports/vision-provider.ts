/**
 * The model boundary of the server: the single declaration every model effect crosses.
 *
 * A provider offers exactly two operations — read one image into price levels, and synthesise a
 * trade read from those readings — and every call the product makes to a model goes through them.
 * The OpenRouter adapter is the production implementation, the replay adapter beside it is the
 * offline one, and no module above this boundary knows a host, a URL, an HTTP status or a provider
 * library. The domain hands over an image frame, the operator's values and a schema, and receives an
 * answer that already satisfies that schema.
 *
 * The request types below carry no field that could hold instruction text, a system message or a
 * model name, and they carry no index signature through which one could arrive: the instructions are
 * the fixed, versioned pair of prompts the adapter applies from `adapters/prompts/`, while the model
 * slug and the completion ceilings come from configuration. A caller therefore cannot substitute,
 * extend or suppress the instructions, which is what keeps the prompts the system's rather than the
 * request's.
 *
 * This module is declarations only. It performs no I/O, holds no clock, opens no connection, imports
 * no schema and defines no error type: the schema travels as a value the caller supplies, and a
 * failure is the domain's `AppError`, raised by the implementation.
 */

import type { z } from 'zod';

import {
  CONFIDENCE_CODES,
  EXTRACTION_CODES,
  SYNTHESIS_SIDE_CODES,
  SYNTHESIS_TIMING_CODES,
} from '@trade-read/shared';

// The code aliases are derived here from the shared tuples rather than restated as literals, so the
// code space has exactly one definition and a code added to a tuple widens these unions in step.

/** A level code exactly as an extraction answer writes it. */
export type ExtractionCode = (typeof EXTRACTION_CODES)[number];

/** A side code exactly as a synthesis answer writes it. `NONE` is a complete read, not a failure. */
export type SynthesisSideCode = (typeof SYNTHESIS_SIDE_CODES)[number];

/** A timing code exactly as a synthesis answer writes it. */
export type SynthesisTimingCode = (typeof SYNTHESIS_TIMING_CODES)[number];

/** A confidence code exactly as a synthesis answer writes it. */
export type ConfidenceCode = (typeof CONFIDENCE_CODES)[number];

/** The two values the model's readability field may hold: a chart was read, or there was none. */
export type ExtractionReadability = 'OK' | 'BLANK';

// The two answer shapes, field for field as the provider contract states them. Their field names
// are the model's, so a schema the domain supplies can mirror the contract without translating.

/**
 * One image's reading: the prices it shows, an observation, and whether it held a chart at all.
 *
 * The arrays are mutable on purpose: an answer is the output of `schema.parse`, and the parsed value
 * reaches the caller without a copy.
 */
export interface ExtractionAnswer {
  /**
   * The price levels the image shows, each as a `[price, code]` pair.
   *
   * Prices are bare numbers exactly as the model reported them — never formatted, rescaled or
   * rounded at this boundary — and the codes are the model's short codes, translated into the
   * public level taxonomy later by the shared vocabulary tables, never before.
   */
  readonly l: Array<[number, ExtractionCode]>;

  /**
   * The reading's observation, capped at 80 characters by the schema.
   *
   * It opens with `LAST=<price>`, the price visible at the image's final bar, which is the
   * current-price evidence the timing decision rests on, or with `LAST=NA` when the image shows no
   * current price.
   */
  readonly o: string;

  /**
   * Whether the image held a chart. `BLANK` means it did not, and the image's levels are then
   * discarded; that is a normal outcome for a submitted screenshot, not an error.
   */
  readonly r: ExtractionReadability;
}

/**
 * The trade read: a side, a timing, the prices it proposes and the evidence it claims.
 *
 * The proposed prices are references in the making. Each one resolves to an entry in the extracted
 * levels only by exact numeric equality, so a price the model invented has no level to attach to and
 * voids the read.
 */
export interface SynthesisAnswer {
  /** The side code. The public value is mapped from it afterwards; `NONE` becomes `NO_TRADE`. */
  readonly s: SynthesisSideCode;

  /** The timing code the read proposes. The domain tests it against the level evidence (D8). */
  readonly t: SynthesisTimingCode;

  /** The proposed entry price, or null when the read proposes none. */
  readonly e: number | null;

  /** The proposed invalidation price, or null when the read proposes none. */
  readonly x: number | null;

  /** The proposed target prices, possibly empty. */
  readonly k: number[];

  /** The confidence code. The public value is mapped from it afterwards. */
  readonly c: ConfidenceCode;

  /** The ids of the images the read claims to rest on. */
  readonly src: string[];

  /** One supporting sentence, capped at 140 characters by the schema. */
  readonly w: string;
}

// What a caller supplies to a call. Every member is something only the caller knows: the image, the
// operator's values, the deadline it owns and the schema it owns.

/** One submitted image as the adapter receives it. */
export interface ImageFrame {
  /** The id the server generated for this image; the synthesis line cites images by it (D1). */
  readonly imageId: string;

  /** The name the operator's file carried, used to label the image and nothing else. */
  readonly fileName: string;

  /** The content type sniffed from the bytes themselves, not the type the client declared. */
  readonly contentType: string;

  /**
   * The image bytes themselves: never a `data:` URL and never base64, whose encoding is the
   * adapter's work.
   */
  readonly bytes: Uint8Array;
}

/**
 * One analysed image together with its reading, so the synthesis call can label each reading by the
 * image it came from.
 */
export interface ImageExtraction {
  /** The id of the image the reading belongs to. */
  readonly imageId: string;

  /** The reading, already validated against the extraction schema. */
  readonly answer: ExtractionAnswer;
}

/**
 * Everything one extraction call needs.
 *
 * `instrument` and `context` are the operator's values, already clamped to their 16- and
 * 500-character bounds by the analysis service (D12) and empty when the operator supplied nothing.
 * They reach the model as labelled data appended after the instructions, never as instructions.
 */
export interface ExtractionRequest {
  /** The single image to read. */
  readonly image: ImageFrame;

  /** The operator's instrument label, as data. */
  readonly instrument: string;

  /** The operator's free-text context, as data. */
  readonly context: string;

  /**
   * The budget remaining on the one shared analysis deadline when the call starts; the
   * implementation aborts at it (D11). The port holds no clock of its own.
   */
  readonly remainingMs: number;

  /** The abort signal for this call, derived from that same deadline. */
  readonly signal: AbortSignal;

  /** The extraction schema the domain owns, which the returned answer must satisfy. */
  readonly schema: z.ZodType<ExtractionAnswer>;
}

/**
 * Everything one synthesis call needs.
 *
 * The readings arrive in submission order and are rendered as labelled data beneath the built-in
 * synthesis instructions, in the same way the extraction call receives the operator's values.
 */
export interface SynthesisRequest {
  /** Every analysed image's reading, in the order the images were submitted. */
  readonly extractions: ReadonlyArray<ImageExtraction>;

  /** The operator's instrument label, as data. */
  readonly instrument: string;

  /** The operator's free-text context, as data. */
  readonly context: string;

  /** The budget remaining on the shared analysis deadline; the implementation aborts at it (D11). */
  readonly remainingMs: number;

  /** The abort signal for this call, derived from that same deadline. */
  readonly signal: AbortSignal;

  /** The synthesis schema the domain owns, which the returned answer must satisfy. */
  readonly schema: z.ZodType<SynthesisAnswer>;
}

// What a call returns. Both results report cost, because the document records it.

/** One image's reading as the port returns it. */
export interface ExtractionResult {
  /** The answer, already validated against the request's schema; the domain never re-validates it. */
  readonly answer: ExtractionAnswer;

  /**
   * Whether the image yielded a chart, mirroring `answer.r === 'OK'`. It is the fact the domain turns
   * into the image's status, and `false` is a normal result rather than an error (D9).
   */
  readonly readable: boolean;

  /** The provider's `usage.completion_tokens` for this call, absent when it reports no usage (D14). */
  readonly completionTokens?: number;

  /**
   * The extraction calls actually issued for this image, the one silent retry included, so the cost
   * the document records is the cost the provider charged. Always at least one.
   */
  readonly callCount: number;
}

/** The synthesised read as the port returns it. */
export interface SynthesisResult {
  /** The answer, already validated against the request's schema; the domain never re-validates it. */
  readonly answer: SynthesisAnswer;

  /**
   * The provider's `usage.completion_tokens` for the synthesis call, absent when it reports no
   * usage; this figure becomes the document's synthesis completion count (D14).
   */
  readonly completionTokens?: number;

  /** The synthesis calls actually issued, the one silent retry included. Always at least one. */
  readonly callCount: number;
}

/**
 * The model boundary itself.
 *
 * An implementation applies the built-in, versioned instructions from `adapters/prompts/` to every
 * call, and no request field can add to, replace or suppress them. It returns an object that already
 * satisfies the request's schema, or throws a domain `AppError`: this module defines no error type
 * and imports none.
 *
 * A conformance failure earns exactly one silent retry of that call, and then the analysis fails.
 * Conformance covers a malformed line, a code fence, text around the object, invalid JSON, a
 * `finish_reason: "length"` truncation, and a schema or vocabulary violation. Authentication, quota,
 * unsupported-model and timeout failures are never retried; each maps straight to its own code
 * (D11).
 *
 * An implementation takes the completion ceilings — 400 for an extraction, 150 for the synthesis —
 * and the model slug from configuration, never from the caller. It aborts at `remainingMs` on
 * `signal`, and it neither persists nor logs image bytes.
 */
export interface VisionProvider {
  /** Reads one image into price levels, retrying the call once if its answer does not conform. */
  extract(request: ExtractionRequest): Promise<ExtractionResult>;

  /** Synthesises the trade read from every reading, retrying once if its answer does not conform. */
  synthesize(request: SynthesisRequest): Promise<SynthesisResult>;
}
