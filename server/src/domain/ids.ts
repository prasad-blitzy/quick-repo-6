import { randomUUID } from 'node:crypto';

/**
 * Identifier primitives for analyses, images and levels.
 *
 * Every id in the system is generated here, so no caller can choose a path
 * segment or overwrite another record, and the pattern that admits an id has a
 * single implementation for the store and the routes to share.
 */

/**
 * Canonical lowercase RFC 4122 version-4 UUID text, anchored at both ends so
 * only the bare identifier can match. A dot segment, path separator, percent
 * encoding, uppercase hex digit, `{...}` or `urn:uuid:` wrapper, trailing
 * whitespace or an over-long value therefore cannot satisfy it.
 */
const UUID_V4_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

/** Shape of every analysis id, which is also the directory name beneath `DATA_DIR`. */
export const ANALYSIS_ID_PATTERN: RegExp = new RegExp(`^${UUID_V4_SOURCE}$`);

/** Shape of every image id, which is also the stored file name of that image's bytes. */
export const IMAGE_ID_PATTERN: RegExp = new RegExp(`^${UUID_V4_SOURCE}$`);

/**
 * Creates an analysis id. `randomUUID()` supplies 122 random bits, so two
 * concurrent submissions never collide, and it reads neither the clock, the
 * environment nor a counter.
 */
export function analysisId(): string {
  return randomUUID();
}

/** Creates the id of one submitted image, unique within its analysis and within the store. */
export function imageId(): string {
  return randomUUID();
}

/**
 * Creates the id of one extracted price level. A recommendation refers to a
 * level by this id rather than by a price, so it has to be unique within the
 * document that holds it.
 */
export function levelId(): string {
  return randomUUID();
}

/**
 * Admits a value only when it is an analysis id this module generated.
 *
 * This is the compensating control for the open, unauthenticated API: the store
 * and the routes call it before any filesystem path is built, so a crafted id
 * cannot escape `DATA_DIR`. Never loosen the pattern or skip the call.
 */
export function isValidAnalysisId(value: unknown): value is string {
  return typeof value === 'string' && ANALYSIS_ID_PATTERN.test(value);
}

/**
 * Admits a value only when it is an image id this module generated, and for the
 * same reason as {@link isValidAnalysisId}: the guard runs before the id becomes
 * a file name beneath an analysis directory.
 */
export function isValidImageId(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_ID_PATTERN.test(value);
}
