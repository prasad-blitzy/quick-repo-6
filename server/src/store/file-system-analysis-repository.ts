import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';

import type { AnalysisDocument } from '@trade-read/shared';

import { AppError, isAppError } from '../domain/errors.js';
import { isValidAnalysisId } from '../domain/ids.js';
import type { Logger } from '../observability/logger.js';
import type {
  AnalysisRepository,
  StoredImage,
  StoredImageBytes,
} from '../ports/analysis-repository.js';
import {
  analysesRoot,
  analysisDir,
  documentPath,
  documentTempPath,
  imagePath,
  imagesDir,
} from './data-paths.js';

/**
 * The filesystem implementation of the persistence port: one UTF-8 JSON document per analysis,
 * beside the bytes of every image that document cites, beneath the configured data directory.
 *
 * The layout is the one `./data-paths.ts` builds and this module never composes a segment of its own:
 *
 *     <dataDir>/analyses/<analysisId>/document.json
 *     <dataDir>/analyses/<analysisId>/images/<imageId>
 *
 * Two rules the port states are what this file exists to honour.
 *
 * - Write order. Every image's bytes are written first and the document last, under a temporary name
 *   that is renamed into place inside the same directory, so the rename cannot cross a filesystem
 *   boundary and a reader sees either a complete analysis or none of it. Two concurrent submissions
 *   cannot collide: each document is written under its own `randomUUID()` suffix and each analysis
 *   owns its directory. Deletion removes the document, then the bytes.
 * - Id guard. An analysis id becomes a directory name and an image id a file name, and both arrive
 *   from a URL, so every path is resolved through `./data-paths.ts`, which refuses an id this system
 *   did not generate with the port's `404 NOT_FOUND` before any segment is joined. That refusal
 *   propagates: it is never caught and re-presented as an unreadable store.
 *
 * The instance holds the data directory and the logger and nothing else — no index, no cache, no
 * memoised listing. A freshly constructed repository on the same directory therefore sees everything
 * a previous one wrote, which is what makes a completed analysis survive a restart and a deletion
 * take effect for the next instance without an invalidation step.
 *
 * Nothing here reads the environment, performs network I/O, decodes an image, holds a price or
 * applies a rule of the domain. Image bytes are written and returned as `Uint8Array`s and are never
 * encoded into text, so no image or document content can leave this module through a log line or a
 * response body.
 */

/** The errno code Node reports for a path that does not exist. */
const MISSING_PATH_CODE = 'ENOENT';

/** Cause recorded when a stored document is not valid JSON. */
const REASON_INVALID_JSON = 'invalid_json';

/** Cause recorded when a stored document parses but is not a JSON object. */
const REASON_NOT_A_DOCUMENT = 'not_a_document';

/** Cause recorded for a thrown value that carries neither an errno code nor a syntax failure. */
const REASON_UNEXPECTED = 'unexpected_error';

/**
 * Reads the errno code off a thrown value, structurally rather than by class, because Node's
 * filesystem errors are plain `Error` objects carrying a `code`.
 *
 * The same read also serves an {@link AppError}, whose `code` is one of the shared vocabulary's
 * codes: both are short machine-readable causes, which is what a log line's `reason` field holds.
 *
 * @param value - The value a `catch` clause caught.
 * @returns The code, or `undefined` when the value carries no usable one.
 */
function errnoCodeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) {
    return undefined;
  }

  const { code } = value;

  return typeof code === 'string' && code !== '' ? code : undefined;
}

/**
 * Renders the short, machine-readable cause of a failure for a log line's `reason` field.
 *
 * The thrown value's own code is preferred — `ENOSPC` and `EACCES` from the filesystem, `NOT_FOUND`
 * from the id guard — because it is what an operator can filter on. A parse failure and an
 * unrecognised throw get a fixed token each, so `reason` never carries free text.
 */
function failureReasonOf(value: unknown): string {
  const code = errnoCodeOf(value);

  if (code !== undefined) {
    return code;
  }

  return value instanceof SyntaxError ? REASON_INVALID_JSON : REASON_UNEXPECTED;
}

/**
 * Renders the diagnostic detail of a failure for a log line's `message` field, which is the only
 * field that may carry free text.
 *
 * It is the thrown value's own message — a filesystem error's description, or the shared sentence of
 * an {@link AppError} — and never a request body, a header, a document or an image's bytes.
 */
function failureMessageOf(value: unknown): string {
  return value instanceof Error && value.message !== '' ? value.message : REASON_UNEXPECTED;
}

/**
 * Reports whether anything exists at `target`, whatever its type.
 *
 * A failure to stat means there is nothing to remove: a missing file, a missing parent directory and
 * an unreadable one are all "not here" for the caller that only asks whether a deletion has anything
 * to do.
 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Orders documents newest first, with a deterministic tie-break.
 *
 * `createdAt` is an ISO-8601 UTC instant, so comparing the strings compares the instants. Two
 * analyses can share a millisecond, and the id descending as the second key keeps a listing stable
 * across calls instead of leaving that order to the directory's own.
 */
function compareNewestFirst(left: AnalysisDocument, right: AnalysisDocument): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? 1 : -1;
  }

  if (left.analysisId === right.analysisId) {
    return 0;
  }

  return left.analysisId < right.analysisId ? 1 : -1;
}

/** What the repository needs to reach its store and to report what it did there. */
export interface FileSystemAnalysisRepositoryDeps {
  /** Absolute directory the layout above is built beneath; never read from the environment here. */
  readonly dataDir: string;
  /** The server's single writer, used for one line per write, per delete and per stored failure. */
  readonly logger: Logger;
}

/**
 * Stores analyses on the local filesystem behind the persistence port.
 *
 * Nothing is created in the constructor: a repository may be constructed before its data directory
 * exists, so the first `save` creates the directories it needs and every read treats a missing store
 * as empty.
 */
export class FileSystemAnalysisRepository implements AnalysisRepository {
  readonly #dataDir: string;

  readonly #logger: Logger;

  constructor(deps: FileSystemAnalysisRepositoryDeps) {
    this.#dataDir = deps.dataDir;
    this.#logger = deps.logger;
  }

  /**
   * Writes one completed analysis and the image bytes its `images[]` cite.
   *
   * Image bytes are written in the order they were submitted, then the document is written under a
   * temporary name inside the analysis directory and renamed onto `document.json`. The rename is the
   * commit point: it is atomic within one directory, so a reader sees either no document or a
   * complete one, even if the process dies mid-write or two submissions run at once.
   *
   * A failure part-way through leaves no document behind — the partial one is removed best effort —
   * so a later listing never reports an analysis whose images are incomplete.
   *
   * @throws {AppError} The id guard's `404 NOT_FOUND` unchanged for a malformed id, and
   *   `500 INTERNAL_ERROR` for any other failure, so no stack or filesystem path reaches a body.
   */
  async save(document: AnalysisDocument, images: ReadonlyArray<StoredImage>): Promise<void> {
    const analysisId = document.analysisId;
    let temporaryPath: string | undefined;

    try {
      // The analysis directory is resolved and created first, so the id guard in the path builders
      // has already refused a malformed id before a directory or a file exists, and the images
      // directory is then created inside the directory that is known to be sound.
      await mkdir(analysisDir(this.#dataDir, analysisId), { recursive: true });
      await mkdir(imagesDir(this.#dataDir, analysisId), { recursive: true });

      // Bytes before the document: the document's presence is what tells a reader the analysis and
      // everything it cites are complete.
      for (const image of images) {
        await writeFile(imagePath(this.#dataDir, analysisId, image.imageId), image.bytes);
      }

      temporaryPath = documentTempPath(this.#dataDir, analysisId, randomUUID());
      await writeFile(temporaryPath, JSON.stringify(document), 'utf8');
      await rename(temporaryPath, documentPath(this.#dataDir, analysisId));
      temporaryPath = undefined;

      this.#logger.info({
        event: 'analysis_saved',
        analysisId,
        outcome: 'saved',
        imageCount: images.length,
      });
    } catch (error) {
      await this.#discardTemporaryDocument(temporaryPath);

      this.#logger.error({
        event: 'analysis_save_failed',
        analysisId,
        outcome: 'error',
        reason: failureReasonOf(error),
        message: failureMessageOf(error),
      });

      throw isAppError(error) ? error : AppError.internal(error);
    }
  }

  /**
   * Returns the stored analysis with this id, or `null` when none exists.
   *
   * A missing document is `null` rather than an error, and so is a file that is not parseable JSON or
   * does not hold a JSON object: a hand-mangled record degrades to "no such analysis" with one logged
   * cause, instead of failing a request with a 500 the operator cannot act on.
   *
   * @throws {AppError} The id guard's `404 NOT_FOUND` for a malformed id — the path is resolved
   *   outside the read's `try`, so that refusal is never mistaken for an unreadable store — and
   *   `500 INTERNAL_ERROR` when the document exists but cannot be read at all.
   */
  async findById(analysisId: string): Promise<AnalysisDocument | null> {
    const path = documentPath(this.#dataDir, analysisId);

    let text: string;

    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (errnoCodeOf(error) === MISSING_PATH_CODE) {
        return null;
      }

      this.#logger.error({
        event: 'analysis_read_failed',
        analysisId,
        reason: failureReasonOf(error),
        message: failureMessageOf(error),
      });

      throw AppError.internal(error);
    }

    return this.#parseDocument(text, analysisId);
  }

  /**
   * Returns up to `limit` stored analyses, newest first.
   *
   * Every analysis directory is read in turn rather than through an index: a single operator keeps a
   * few hundred analyses at most, and an index would be a second copy of the truth to keep in step
   * with a deletion made outside the application.
   *
   * One unreadable or corrupt document is skipped with its cause logged, so a single bad file can
   * never fail the whole history. An empty store, or one whose data directory does not exist yet,
   * yields an empty array.
   *
   * @param limit - Page size. The route clamps it to the documented default and cap; this method only
   *   guarantees it never returns more rows than it was asked for.
   */
  async list(limit: number): Promise<AnalysisDocument[]> {
    let entries: Dirent[];

    try {
      entries = await readdir(analysesRoot(this.#dataDir), { withFileTypes: true });
    } catch (error) {
      if (errnoCodeOf(error) === MISSING_PATH_CODE) {
        return [];
      }

      this.#logger.error({
        event: 'analysis_list_failed',
        reason: failureReasonOf(error),
        message: failureMessageOf(error),
      });

      throw AppError.internal(error);
    }

    const documents: AnalysisDocument[] = [];

    for (const entry of entries) {
      // Anything that is not a directory named with an id this system generated was not written by
      // this store, so it is not an analysis to read.
      if (!entry.isDirectory() || !isValidAnalysisId(entry.name)) {
        continue;
      }

      const document = await this.#readStoredDocument(entry.name);

      if (document !== null) {
        documents.push(document);
      }
    }

    documents.sort(compareNewestFirst);

    const effectiveLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;

    return documents.slice(0, effectiveLimit);
  }

  /**
   * Removes one stored analysis together with its image bytes.
   *
   * The document and the bytes always go together: the document is removed first, because it is the
   * file whose presence means the analysis is complete, then the images directory. Removing the
   * analysis directory that is left empty afterwards is cleanup rather than part of the contract, so
   * a failure there still resolves `true` — the record and its bytes are gone, which is what the
   * route's `204` reports.
   *
   * @returns `true` when a record was removed, `false` when there was nothing to remove.
   * @throws {AppError} The id guard's `404 NOT_FOUND` for a malformed id, and `500 INTERNAL_ERROR`
   *   when a removal failed for any other reason.
   */
  async delete(analysisId: string): Promise<boolean> {
    // All three paths are resolved before anything is touched, so a crafted id is refused while the
    // store is still untouched — the same answer `findById` gives for it.
    const document = documentPath(this.#dataDir, analysisId);
    const images = imagesDir(this.#dataDir, analysisId);
    const directory = analysisDir(this.#dataDir, analysisId);

    const [holdsDocument, holdsImages] = await Promise.all([
      pathExists(document),
      pathExists(images),
    ]);

    if (!holdsDocument && !holdsImages) {
      this.#logger.info({ event: 'analysis_deleted', analysisId, outcome: 'missing' });

      return false;
    }

    try {
      await rm(document, { force: true });
      await rm(images, { recursive: true, force: true });
    } catch (error) {
      this.#logger.error({
        event: 'analysis_delete_failed',
        analysisId,
        outcome: 'error',
        reason: failureReasonOf(error),
        message: failureMessageOf(error),
      });

      throw isAppError(error) ? error : AppError.internal(error);
    }

    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // Cleanup only, so it cannot change the answer: the document and the bytes are already gone.
      // Reported nowhere on purpose — a deletion emits exactly one line, and it has been written.
    }

    this.#logger.info({ event: 'analysis_deleted', analysisId, outcome: 'deleted' });

    return true;
  }

  /**
   * Returns the stored bytes of one image and the content type they were saved with.
   *
   * Both ids are resolved before the document is read, so a crafted id is refused even for an
   * analysis that was never stored, and the answer is `null` for an unknown analysis, for an image
   * id the document does not cite, and for bytes that are already gone. The content type comes from
   * that analysis's stored document, which is why no sidecar metadata file exists: images are written
   * before the document, so a document that cites an image means its bytes are complete.
   *
   * Reading is not logged; only writes and deletes emit a line.
   *
   * @throws {AppError} The id guard's `404 NOT_FOUND` for a malformed id, and `500 INTERNAL_ERROR`
   *   when stored bytes exist but cannot be read.
   */
  async readImage(analysisId: string, imageId: string): Promise<StoredImageBytes | null> {
    const path = imagePath(this.#dataDir, analysisId, imageId);

    const document = await this.findById(analysisId);

    if (document === null) {
      return null;
    }

    const image = document.images.find((candidate) => candidate.imageId === imageId);

    if (image === undefined) {
      return null;
    }

    let stored: Uint8Array;

    try {
      stored = await readFile(path);
    } catch (error) {
      if (errnoCodeOf(error) === MISSING_PATH_CODE) {
        return null;
      }

      this.#logger.error({
        event: 'analysis_image_read_failed',
        analysisId,
        reason: failureReasonOf(error),
        message: failureMessageOf(error),
      });

      throw AppError.internal(error);
    }

    // The copy is deliberate: `readFile` hands back a Node-specific typed-array view, and the port
    // promises a plain `Uint8Array`, so the caller is given neither that view nor any memory shared
    // with the read result. The bytes are never encoded into text either: an image's content never
    // enters a string.
    return { bytes: new Uint8Array(stored), contentType: image.contentType };
  }

  /**
   * Reads and parses one stored document for a listing, skipping it on any failure.
   *
   * A listing reports what it can rather than failing: an analysis whose document cannot be read is
   * left out and its cause logged, so one damaged file does not hide every other analysis.
   */
  async #readStoredDocument(analysisId: string): Promise<AnalysisDocument | null> {
    let text: string;

    try {
      text = await readFile(documentPath(this.#dataDir, analysisId), 'utf8');
    } catch (error) {
      this.#logger.error({
        event: 'analysis_read_failed',
        analysisId,
        reason: failureReasonOf(error),
        message: failureMessageOf(error),
      });

      return null;
    }

    return this.#parseDocument(text, analysisId);
  }

  /**
   * Parses a stored document's text, answering `null` with the cause logged when it is not one.
   *
   * The check is deliberately structural only — parseable JSON that is an object — because the
   * document's full schema belongs to the domain that builds it. Validating meaning is not the store's
   * work, and a store that rejected a field would become a second, drifting definition of the
   * contract.
   */
  #parseDocument(text: string, analysisId: string): AnalysisDocument | null {
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch {
      this.#logger.error({
        event: 'analysis_read_failed',
        analysisId,
        reason: REASON_INVALID_JSON,
      });

      return null;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.#logger.error({
        event: 'analysis_read_failed',
        analysisId,
        reason: REASON_NOT_A_DOCUMENT,
      });

      return null;
    }

    return parsed as AnalysisDocument;
  }

  /**
   * Removes the temporary file a failed `save` was writing, if it got that far.
   *
   * Best effort by design: the failure that produced the temporary file is the one worth reporting, so
   * a second failure while cleaning up is swallowed rather than allowed to replace it.
   */
  async #discardTemporaryDocument(temporaryPath: string | undefined): Promise<void> {
    if (temporaryPath === undefined) {
      return;
    }

    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // See above: the report of the original failure must survive this one.
    }
  }
}

