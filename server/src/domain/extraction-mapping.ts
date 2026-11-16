/**
 * Translation of one validated extraction answer into the levels, the status and the current-price
 * evidence the rest of the domain reasons about.
 *
 * The model answers once per image with a line of compact JSON — `[price, code]` pairs, an
 * observation and a readability flag — and every later decision is made over what this module makes
 * of it: the level table a document shows, the status each submitted screenshot is reported with, and
 * the price each image reported as its own current one, which is what the timing decision is judged
 * against. The answer arrives already checked against the extraction schema by the layer that owns
 * the retry (see `adapters/openrouter/conformance.ts`), so nothing here is validated twice: the shape
 * and the vocabulary are settled, and this module decides only what the domain makes of them.
 *
 * Three properties are contractual:
 *
 * - A level's price is the number the model reported, exactly. A pair whose price is not a finite
 *   number is dropped and counted, never rounded, coerced or estimated (rule 6), because a price no
 *   image showed must not become a level a recommendation can cite.
 * - An image is `UNREADABLE` when the extraction reported no chart at all, and equally when nothing
 *   it reported survived as a level (D9). One unreadable image among readable ones is a normal
 *   outcome of a submission rather than an error.
 * - The observation's leading `LAST=` token is the only structure read out of it, and the only
 *   current-price evidence the build has (D8). No other number in the observation is consulted,
 *   whatever else the model wrote there.
 *
 * Each surviving level is minted an id, so a recommendation cites the level rather than restating its
 * price (rule 1), and the pairs keep the order the model reported them in, because resolution between
 * levels sharing a price falls back on extraction order (D6).
 *
 * It reads no environment, performs no I/O, reaches no network, consults no store and holds no state,
 * and the same input therefore always yields the same result apart from the ids it mints. Whether an
 * image holds a chart is never decided from its pixels here — that is the model's `r` field — and a
 * document's `Level` and `AnalysisImage` are assembled from this output by `document-builder.ts`.
 */

import {
  EXTRACTION_CODE_TO_LEVEL_TYPE,
  OBSERVATION_MAX_CHARS,
  type AcceptedImageMimeType,
  type ExtractionCode,
  type ImageStatus,
  type LevelType,
} from '@trade-read/shared';

import type { ExtractionAnswer } from '../ports/vision-provider.js';
import { levelId } from './ids.js';
import type { ValidatedImage } from './image-validation.js';

// The answer shape is the port's declaration — the model's own three keys — and the schema that
// admits it is built on that same declaration. It is imported rather than restated so a field added
// to the contract arrives here instead of leaving a second copy to drift, and re-exported because
// this module's callers and its suites name the type by this path.
export type { ExtractionAnswer };

/** One price a submitted image reported, labelled with the kind of level it is. */
export interface MappedLevel {
  /** The id minted for this level, which a recommendation cites in place of a price. */
  levelId: string;
  /** The price exactly as the extraction reported it: never rounded, rescaled or formatted. */
  price: number;
  /** The level type the extraction code stands for, looked up in the shared vocabulary. */
  type: LevelType;
  /** The image this price was reported from. */
  imageId: string;
  /**
   * A qualifier the level needs, such as the strike a gamma level sits at.
   *
   * No level mapped from an extraction answer carries one, because the answer line has no field for
   * it; the property exists so a mapped level has exactly the contract `Level`'s shape and a consumer
   * can take either.
   */
  note?: string;
}

/**
 * The price one image reported as its own current price, from the `LAST=` token of its observation.
 *
 * `price` is an explicit `null` — never a missing property — when the observation said `LAST=NA`,
 * carried no `LAST=` token at all, or carried a value that is not a number, so "this image reported
 * no current price" is representable rather than inferable (D8). The timing decision consumes only
 * the entries that carry a price, in the narrower form it declares itself.
 */
export interface CurrentPriceEvidence {
  /** The id of the image that reported the price. */
  imageId: string;
  /** The price the image reported as its current one, or null when it reported none. */
  price: number | null;
}

/** One submitted image as the domain carries it from the extraction onwards. */
export interface MappedImage {
  /** The id the server minted for this image, cited by the synthesis answer's `src` list. */
  imageId: string;
  /** The normalised name of the submitted file, for display beside the image. */
  fileName: string;
  /** The format sniffed from the received bytes, not the type the client declared. */
  contentType: AcceptedImageMimeType;
  /** The received byte length, as validated. */
  byteSize: number;
  /** Canvas width in pixels, read from the image header. */
  width: number;
  /** Canvas height in pixels, read from the image header. */
  height: number;
  /** `ANALYZED` when at least one level survived, `UNREADABLE` otherwise (D9). */
  status: ImageStatus;
  /** Present only when `status` is `"UNREADABLE"`, and says which of the two causes applied. */
  extractionError?: string;
  /** The levels that survived this image's reading, in the order the extraction reported them. */
  levels: MappedLevel[];
  /** What this image reported as its current price, whether or not it yielded a level. */
  currentPrice: CurrentPriceEvidence;
}

/** One image's reading as the domain holds it. */
export interface ExtractionMapResult {
  /** The image, its status and the levels the reading yielded. */
  image: MappedImage;
  /**
   * The reading's observation, clamped to the schema's 80-character cap defensively.
   *
   * A document does not carry it; it exists for logging and for the rule-4 evidence trail, and the
   * current price the timing decision needs has already been extracted from it.
   */
  observation: string;
  /**
   * How many reported pairs were dropped because their price was not a finite number.
   *
   * Reported rather than swallowed so the assumption rule 6 owes can be recorded from it without
   * walking the answer a second time. A reading discarded for reporting no chart contributes nothing
   * here: the image's `UNREADABLE` status and its reason already account for every level it carried.
   */
  droppedLevelCount: number;
}

/** Everything one mapping needs: the validated image part, its id and the answer about it. */
export interface ExtractionMapInput {
  /** The part as upload validation left it, carrying the geometry and format sniffed from its bytes. */
  validated: ValidatedImage;
  /** The id the server minted for this image; it becomes every level's `imageId`. */
  imageId: string;
  /** The answer the provider returned for this image, already validated against its schema. */
  answer: ExtractionAnswer;
}

/** The reason recorded when the extraction reported that the image holds no chart at all. */
const NO_CHART_REASON = 'The extraction reported that this image contains no readable chart.';

/** The reason recorded when the image held a chart but no reported price could be read. */
const NO_READABLE_PRICE_REASON =
  'No level the extraction reported for this image carried a readable price.';

/** The token an observation opens with when the image shows a current price, or `NA` for none. */
const LAST_TOKEN_PREFIX = 'LAST=';

/** The `LAST=` value an observation carries when the image shows no current price. */
const NO_CURRENT_PRICE_TOKEN = 'NA';

/** What one reading yielded: the surviving levels, in reported order, and the count dropped. */
interface Reading {
  /** The levels whose price could be read, in the order the extraction reported them. */
  levels: MappedLevel[];
  /** How many reported pairs were dropped for carrying no readable price. */
  droppedLevelCount: number;
}

/**
 * Whether a reported price is one a level can carry.
 *
 * The extraction schema admits finite numbers only, so this rejects what a schema cannot: a price
 * that is absent, `null`, a string, `NaN` or `Infinity`. Such a pair is dropped rather than repaired
 * (rule 6), because rounding or coercing it would invent a price no image showed.
 */
function isReadablePrice(price: unknown): price is number {
  return typeof price === 'number' && Number.isFinite(price);
}

/**
 * One reported pair as a level, or null when its price cannot be read.
 *
 * The code is looked up in the shared table and never translated by a copy of it (D4); the lookup
 * cannot miss, because the schema admits the twelve codes and that table covers all twelve. The id is
 * minted per level, so the level can be cited by id while its price stays the one reported.
 */
function toLevel(pair: readonly [number, ExtractionCode], imageId: string): MappedLevel | null {
  const [price, code] = pair;
  if (!isReadablePrice(price)) {
    return null;
  }
  return {
    levelId: levelId(),
    price,
    type: EXTRACTION_CODE_TO_LEVEL_TYPE[code],
    imageId,
  };
}

/** Every pair of one reading as levels, counted, keeping the extraction's own order (D6). */
function readLevels(
  pairs: ReadonlyArray<[number, ExtractionCode]>,
  imageId: string,
): Reading {
  const levels: MappedLevel[] = [];
  let droppedLevelCount = 0;

  for (const pair of pairs) {
    const level = toLevel(pair, imageId);
    if (level === null) {
      droppedLevelCount += 1;
      continue;
    }
    levels.push(level);
  }

  return { levels, droppedLevelCount };
}

/**
 * The value of an observation's leading `LAST=` token, or null when it carries none.
 *
 * Only the token's own value is returned: whitespace around the token and around its value is
 * accepted, and everything the model wrote after it is ignored, because this token is the only
 * structured content the observation is allowed to carry.
 */
function lastTokenValue(observation: string): string | null {
  const trimmed = observation.trimStart();
  if (!trimmed.startsWith(LAST_TOKEN_PREFIX)) {
    return null;
  }

  const remainder = trimmed.slice(LAST_TOKEN_PREFIX.length).trimStart();
  const separator = remainder.search(/\s/);
  return separator === -1 ? remainder : remainder.slice(0, separator);
}

/**
 * The current price an observation reports, or null when it reports none.
 *
 * `LAST=NA`, an absent `LAST=` token, an empty value and a value that is not a finite number all
 * mean the same thing to every consumer: this image offers no current-price evidence. A whole-number
 * parse is used rather than a prefix parse so `LAST=abc` and `LAST=5815abc` both yield null instead
 * of a number the model never wrote.
 */
function parseCurrentPrice(observation: string): number | null {
  const value = lastTokenValue(observation);
  if (value === null || value === NO_CURRENT_PRICE_TOKEN || value === '') {
    return null;
  }

  const price = Number(value);
  return Number.isFinite(price) ? price : null;
}

/** The sentence an unreadable image carries, distinguishing the two causes of unreadability. */
function unreadableReason(discarded: boolean): string {
  return discarded ? NO_CHART_REASON : NO_READABLE_PRICE_REASON;
}

/** The observation as it may be logged: at most the cap its schema allows. */
function clampObservation(observation: string): string {
  return observation.length > OBSERVATION_MAX_CHARS
    ? observation.slice(0, OBSERVATION_MAX_CHARS)
    : observation;
}

/**
 * Maps one validated extraction answer into a level set, an image status and its price evidence.
 *
 * An answer that reported no chart has its levels discarded outright, including any it still carried,
 * and its pairs are not counted as dropped prices: the image is unreadable because it held no chart,
 * which its own reason already states. Otherwise every pair with a readable price becomes a level in
 * reported order, and the image is `ANALYZED` only if at least one did (D9) — deciding
 * whether *every* image of a submission is unreadable, and refusing the analysis for it, is the
 * analysis service's work, not this module's.
 */
export function mapExtraction(input: ExtractionMapInput): ExtractionMapResult {
  const { validated, imageId, answer } = input;

  const discarded = answer.r === 'BLANK';
  const reading: Reading = discarded
    ? { levels: [], droppedLevelCount: 0 }
    : readLevels(answer.l, imageId);

  const submitted = {
    imageId,
    fileName: validated.fileName,
    contentType: validated.contentType,
    byteSize: validated.byteSize,
    width: validated.width,
    height: validated.height,
    levels: reading.levels,
    currentPrice: { imageId, price: parseCurrentPrice(answer.o) },
  };

  // The two statuses carry different fields, and the contract allows a reason only on the unreadable
  // one, so the branches are built separately rather than one shape with an optional reason.
  const image: MappedImage =
    discarded || reading.levels.length === 0
      ? { ...submitted, status: 'UNREADABLE', extractionError: unreadableReason(discarded) }
      : { ...submitted, status: 'ANALYZED' };

  return {
    image,
    observation: clampObservation(answer.o),
    droppedLevelCount: reading.droppedLevelCount,
  };
}
