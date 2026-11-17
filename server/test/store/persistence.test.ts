/**
 * Suite for the filesystem store behind the `AnalysisRepository` port: the store-layer evidence for
 * AAP §0.6.6 criterion 8 — an analysis completed before a restart is still returned and still
 * listed, and a deletion leaves neither the document nor its image bytes.
 *
 * Three properties are what this file pins, each against real directories under the system temporary
 * root rather than a mocked `node:fs`:
 *
 * - Durability (AAP §0.6.6 #8). A second repository instance constructed over the same data directory
 *   serves exactly what the first one wrote. The instance holds that directory and a logger and
 *   nothing else — no index, no cache — so a second instance is the whole model of a restart: no
 *   process is restarted and no module state is reset between the two.
 * - Write order and crash safety (D2). Image bytes are written first and the document last, under a
 *   temporary name inside the analysis directory that is renamed onto `document.json`; deletion
 *   removes the document and then the bytes. A failure while the bytes are being written therefore
 *   leaves no document at all, which is what keeps a half-written analysis from being observable.
 * - The id guard (D1). Every builder in `src/store/data-paths.ts` refuses an id this system did not
 *   generate before it joins a path segment, so a crafted id is answered exactly as a record that was
 *   never stored — `404 NOT_FOUND` — and never as a filesystem error carrying a path.
 *
 * Documents are built from the shared contract's own types and gated by the domain's own schema, so
 * drift in either fails here instead of producing a record the store would happily persist. Image
 * payloads are a PNG signature plus a few bytes of body: the store never decodes an image, so this
 * suite does not depend on the generated screenshots existing, and every payload stays far below the
 * length at which the logger's bare-base64 heuristic would redact a value.
 *
 * Nothing here reads the environment, reaches the network or needs a credential: `vitest.config.ts`
 * selects the stub provider, aliases `@trade-read/shared` to the shared sources, and the store has no
 * provider dependency to reach in the first place.
 */
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DISCLAIMER,
  HISTORY_LIMIT_DEFAULT,
  type AnalysisDocument,
  type AnalysisImage,
} from '@trade-read/shared';

import { AppError, isAppError } from '../../src/domain/errors.js';
import { analysisId, imageId, levelId } from '../../src/domain/ids.js';
import { analysisDocumentSchema } from '../../src/domain/schemas.js';
import { createLogger, type LogEvent } from '../../src/observability/logger.js';
import type { StoredImage } from '../../src/ports/analysis-repository.js';
import {
  DOCUMENT_FILE_NAME,
  analysesRoot,
  documentPath,
  documentTempPath,
  imagePath,
  imagesDir,
} from '../../src/store/data-paths.js';
import { FileSystemAnalysisRepository } from '../../src/store/file-system-analysis-repository.js';
import { createTempDataDir, type TempDataDir } from '../helpers/temp-data-dir.js';

/**
 * Repository root, derived from this file's own URL with a three-level ascent
 * (`server/test/store/` → checkout root) rather than from `process.cwd()`, which vitest does not
 * guarantee. It is read only by the assertion that the temporary data directory sits outside the
 * checkout, so the suite can never write the repository's own store.
 */
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

/** The directory the suite must never touch: the repository's own store (D1). */
const REPOSITORY_DATA_DIR = join(REPO_ROOT, '.data');

/** PNG's eight-byte signature, the prefix that identifies the payloads this suite writes. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Bytes of pseudo-chunk appended to the signature, so two payloads are distinguishable by content. */
const PNG_BODY_LENGTH = 8;

/**
 * Every field `LogEvent` declares, as a runtime-recognisable key set.
 *
 * `logger.ts` exports its allowlist as a type only, so this record is how the suite reads it: the
 * annotation is exhaustive over `keyof LogEvent`, which makes a field added to or removed from the
 * logger's allowlist a compile error here rather than an assertion that silently stops covering it.
 */
const LOG_EVENT_FIELDS: Record<keyof LogEvent, true> = {
  event: true,
  analysisId: true,
  role: true,
  tokens: true,
  durationMs: true,
  status: true,
  providerConfigured: true,
  model: true,
  host: true,
  port: true,
  imageCount: true,
  outcome: true,
  reason: true,
  message: true,
};

/** The two keys `createLogger` adds around the allowlisted fields of every line. */
const LOG_ENVELOPE_KEYS = ['ts', 'level'] as const;

/** Every key a log line may carry, derived from the logger's own field set rather than restated. */
const ALLOWED_LOG_KEYS: ReadonlySet<string> = new Set([
  ...LOG_ENVELOPE_KEYS,
  ...Object.keys(LOG_EVENT_FIELDS),
]);

/**
 * Keys that must never reach a log line (AAP §0.4.5): image payloads, request or response bodies and
 * credential-bearing headers. None of them is a field of `LogEvent`, and this list proves the emitted
 * lines carry none of them under any name.
 */
const FORBIDDEN_LOG_KEYS = ['bytes', 'headers', 'body', 'authorization', 'apiKey'] as const;

/**
 * A payload of the shape the store keeps: a PNG signature followed by a short body that differs per
 * seed. The store writes and returns these bytes verbatim and never decodes them, so nothing here
 * needs to be a decodable picture.
 */
function pngBytes(seed = 0): Uint8Array {
  const body = Array.from({ length: PNG_BODY_LENGTH }, (_unused, index) => (seed + index) % 256);

  return new Uint8Array([...PNG_SIGNATURE, ...body]);
}

/**
 * A complete, schema-valid analysis document.
 *
 * The fixture is built here rather than by the domain's document builder because the store receives
 * an already-built document through the port (D3, D10) and persists it verbatim; a typed document
 * that the real schema accepts is the correct fixture for this layer. `analysisDocumentSchema.parse`
 * runs inside this function, so a contract change fails here with the schema's own message instead of
 * producing a document the store would accept and a consumer could not read.
 */
function makeDocument(overrides: Partial<AnalysisDocument> = {}): AnalysisDocument {
  const bytes = pngBytes();
  const cited = imageId();

  const document: AnalysisDocument = {
    analysisId: analysisId(),
    createdAt: new Date().toISOString(),
    instrument: '',
    context: '',
    images: [
      {
        imageId: cited,
        fileName: 'footprint-es-5m.png',
        contentType: 'image/png',
        byteSize: bytes.length,
        width: 1600,
        height: 1000,
        status: 'ANALYZED',
      },
    ],
    levels: [{ levelId: levelId(), price: 5843.5, type: 'FOOTPRINT_POC', imageId: cited }],
    recommendation: {
      side: 'NO_TRADE',
      timing: 'WAIT',
      triggerLevelId: null,
      entryLevelId: null,
      invalidationLevelId: null,
      targetLevelIds: [],
      confidence: 'LOW',
      summary: 'No directional edge across the supplied levels; waiting for price to reach a level.',
    },
    rationale: [{ claim: 'No level is used by this read.', imageId: cited, levelIds: [] }],
    assumptions: [],
    modelUsage: {
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
      promptVersion: 'extraction@1;synthesis@1',
      imageCallCount: 1,
      synthesisCompletionTokens: 12,
      latencyMs: 5,
    },
    disclaimer: DISCLAIMER,
  };

  return analysisDocumentSchema.parse({ ...document, ...overrides });
}

/**
 * The same document citing two images, so a listing assertion covers "every `images[]` entry" rather
 * than a single-entry array. Both levels stay on the first image, which the schema does not constrain.
 */
function makeTwoImageDocument(): AnalysisDocument {
  const document = makeDocument();
  const cited = firstImage(document);
  const extra: AnalysisImage = { ...cited, imageId: imageId(), fileName: 'gex-es-levels.png' };

  return analysisDocumentSchema.parse({ ...document, images: [cited, extra] });
}

/** The first image a document cites; a fixture with no images is a defect in this suite. */
function firstImage(document: AnalysisDocument): AnalysisImage {
  const [image] = document.images;

  if (image === undefined) {
    throw new Error('the document fixture must cite at least one image');
  }

  return image;
}

/** The `StoredImage` the store is asked to persist for a document's first image, with given bytes. */
function makeStoredImage(document: AnalysisDocument, bytes: Uint8Array = pngBytes()): StoredImage {
  const image = firstImage(document);

  return { imageId: image.imageId, contentType: image.contentType, bytes };
}

/** One `StoredImage` per image a document cites, each with distinct bytes. */
function storedImagesFor(document: AnalysisDocument, seed = 0): StoredImage[] {
  return document.images.map((image, index) => ({
    imageId: image.imageId,
    contentType: image.contentType,
    bytes: pngBytes(seed + index),
  }));
}

/** Reports whether anything exists at `target`, so an absence is an assertion rather than a throw. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Every file beneath `dir`, recursively, answering an empty list for a directory that is not there. */
async function walkFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path)));
    } else {
      files.push(path);
    }
  }

  return files;
}

/** The parsed contents of a stored document, read as text and parsed as JSON. */
async function readJsonDocument(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

/** Parses one log line, refusing anything that is not a JSON object. */
function parseLogLine(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`a log line must be a JSON object, received: ${line}`);
  }

  return parsed as Record<string, unknown>;
}

/** Runs `run` and returns whatever it threw, so an assertion can inspect the thrown value itself. */
function captureThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  throw new Error('expected the call to throw');
}

/** Awaits `run` and returns its rejection reason, so an assertion can inspect it rather than a class. */
async function captureRejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }

  throw new Error('expected the call to reject');
}

let temp: TempDataDir;
let dataDir: string;
let logLines: string[];
let repository: FileSystemAnalysisRepository;

beforeEach(async () => {
  temp = await createTempDataDir('store-persistence-');
  dataDir = temp.dataDir;
  logLines = [];
  repository = new FileSystemAnalysisRepository({
    dataDir,
    logger: createLogger({
      write: (line) => {
        logLines.push(line);
      },
    }),
  });
});

afterEach(async () => {
  await temp.cleanup();
});

describe('durability across a restart — AAP §0.6.6 #8', () => {
  it('save then findById returns the document unchanged and lays out the documented paths', async () => {
    const document = makeDocument();
    const bytes = pngBytes(1);
    const image = firstImage(document);

    await repository.save(document, [makeStoredImage(document, bytes)]);

    expect(await repository.findById(document.analysisId)).toEqual(document);

    // The layout is asserted through the builders alone, so a path this suite asserts on and a path
    // the store writes cannot become two different strings.
    expect(await pathExists(analysesRoot(dataDir))).toBe(true);
    expect(await pathExists(documentPath(dataDir, document.analysisId))).toBe(true);
    expect(await pathExists(imagePath(dataDir, document.analysisId, image.imageId))).toBe(true);
  });

  it('a fresh repository over the same directory serves what the first instance saved', async () => {
    const document = makeDocument();
    const bytes = pngBytes(2);
    const image = firstImage(document);

    await repository.save(document, [makeStoredImage(document, bytes)]);

    const restarted = new FileSystemAnalysisRepository({
      dataDir,
      logger: createLogger({ write: () => undefined }),
    });

    expect(await restarted.findById(document.analysisId)).toEqual(document);
    expect(await restarted.list(HISTORY_LIMIT_DEFAULT)).toEqual([document]);

    const reread = await restarted.readImage(document.analysisId, image.imageId);

    expect(reread).not.toBeNull();
    if (reread === null) {
      return;
    }

    expect(reread.bytes).toBeInstanceOf(Uint8Array);
    // The port promises the bytes themselves, not the view `readFile` returns and not the base64 text
    // an image travels to the provider as (AAP §0.4.5).
    expect(Buffer.isBuffer(reread.bytes)).toBe(false);
    expect(Array.from(reread.bytes)).toEqual(Array.from(bytes));
    expect(Array.from(reread.bytes).join(',')).not.toBe(Buffer.from(bytes).toString('base64'));
    // The content type is the one recorded on the stored document, so a disagreement is a real defect.
    expect(reread.contentType).toBe(image.contentType);

    // The same three reads through the original instance: both instances see the same on-disk state,
    // not an in-memory copy that one of them happens to hold.
    expect(await repository.findById(document.analysisId)).toEqual(document);
    expect(await repository.list(HISTORY_LIMIT_DEFAULT)).toEqual([document]);

    const original = await repository.readImage(document.analysisId, image.imageId);

    expect(original).not.toBeNull();
    if (original === null) {
      return;
    }

    expect(original.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(original.bytes)).toEqual(Array.from(bytes));
    expect(original.contentType).toBe(image.contentType);
  });

  it('list returns the newest analysis first, whatever order the saves happened in', async () => {
    const newer = makeDocument({ createdAt: '2024-05-02T10:00:00.000Z' });
    const older = makeDocument({ createdAt: '2024-05-01T10:00:00.000Z' });

    // The older analysis is saved second, so a listing that returned its directory order rather than
    // its `createdAt` order would fail here.
    await repository.save(newer, [makeStoredImage(newer, pngBytes(3))]);
    await repository.save(older, [makeStoredImage(older, pngBytes(4))]);

    expect((await repository.list(HISTORY_LIMIT_DEFAULT)).map((item) => item.analysisId)).toEqual([
      newer.analysisId,
      older.analysisId,
    ]);
    expect((await repository.list(1)).map((item) => item.analysisId)).toEqual([newer.analysisId]);
    expect(await repository.list(HISTORY_LIMIT_DEFAULT)).toHaveLength(2);
  });

  it('delete removes the document and the image bytes', async () => {
    const document = makeDocument();
    const image = firstImage(document);

    await repository.save(document, [makeStoredImage(document, pngBytes(5))]);

    expect(await repository.delete(document.analysisId)).toBe(true);

    // The document and the bytes are asserted separately, so a partial deletion fails this test.
    expect(await pathExists(documentPath(dataDir, document.analysisId))).toBe(false);
    expect(await pathExists(imagePath(dataDir, document.analysisId, image.imageId))).toBe(false);
    expect(await pathExists(imagesDir(dataDir, document.analysisId))).toBe(false);
    // Nothing readable survives anywhere in the store. The `analyses/` root itself is not part of the
    // record and may stand empty after a deletion, which is why the assertion is on its files.
    expect(await walkFiles(analysesRoot(dataDir))).toEqual([]);

    // A re-read after the deletion answers nothing, which is what makes the image and document routes
    // answer `404 NOT_FOUND`: `findById` resolving `null` and `readImage` resolving `null` are the
    // inputs `routes/analysis-routes.ts` turns into that code.
    expect(await repository.findById(document.analysisId)).toBeNull();
    expect(await repository.readImage(document.analysisId, image.imageId)).toBeNull();
  });

  it('delete of an id that was never stored answers false, creates nothing and is idempotent', async () => {
    const absent = analysisId();
    const absentImage = imageId();

    expect(await repository.delete(absent)).toBe(false);
    expect(await pathExists(analysesRoot(dataDir))).toBe(false);

    expect(await repository.findById(absent)).toBeNull();
    expect(await repository.readImage(absent, absentImage)).toBeNull();

    // A repeated deletion of the same id is the same answer, never an error.
    expect(await repository.delete(absent)).toBe(false);
    expect(await pathExists(analysesRoot(dataDir))).toBe(false);
  });
});

describe('write order and crash safety — D2', () => {
  it('leaves no document behind when the image bytes cannot be written', async () => {
    const document = makeDocument();
    const unwritable = { ...makeStoredImage(document), bytes: null as unknown as Uint8Array };

    // Technique: the bytes are made unwritable by handing the writer `null` in place of a payload, so
    // the write of the first image rejects inside `save`. What this proves is the documented order —
    // bytes first, document last — because a document written first would survive the failure and be
    // observable, while here the analysis exists nowhere at all.
    await expect(repository.save(document, [unwritable])).rejects.toThrow();

    expect(await pathExists(documentPath(dataDir, document.analysisId))).toBe(false);
    expect(await repository.findById(document.analysisId)).toBeNull();
    expect(await repository.list(HISTORY_LIMIT_DEFAULT)).toEqual([]);
  });

  it('writes an earlier image before the document, and no document when a later image id is refused', async () => {
    const document = makeDocument();
    const first = makeStoredImage(document, pngBytes(6));
    const refused = { ...first, imageId: '../../escape' };

    // The second image's id fails the guard, so its path is never joined. By then the first image's
    // bytes are already on disk: that is the positive evidence of "bytes before the document", and the
    // absent document is what keeps the sample unobservable.
    const rejection = await captureRejection(() => repository.save(document, [first, refused]));

    expect(isAppError(rejection)).toBe(true);
    if (!isAppError(rejection)) {
      return;
    }

    expect(rejection.code).toBe('NOT_FOUND');
    expect(await pathExists(imagePath(dataDir, document.analysisId, first.imageId))).toBe(true);
    expect(await pathExists(documentPath(dataDir, document.analysisId))).toBe(false);
    expect(await repository.findById(document.analysisId)).toBeNull();
  });

  it('renames the document into place from a temporary name and leaves no temporary residue', async () => {
    const document = makeDocument();

    await repository.save(document, [makeStoredImage(document, pngBytes(7))]);

    const temporary = documentTempPath(dataDir, document.analysisId, randomUUID());
    const committed = documentPath(dataDir, document.analysisId);

    // A rename is atomic only within one directory, which is why the temporary file is a sibling of
    // the document rather than a sibling of the data directory.
    expect(dirname(temporary)).toBe(dirname(committed));
    expect(temporary).not.toBe(committed);

    const files = await walkFiles(analysesRoot(dataDir));

    expect(files.filter((file) => file.endsWith('.tmp'))).toEqual([]);

    const storedDocuments = files.filter((file) => basename(file) === DOCUMENT_FILE_NAME);

    expect(storedDocuments).toHaveLength(1);

    // Nothing partial is left behind — no temporary sibling survives the commit — and every stored
    // document parses and equals the document that was saved, so a reader never sees a half-written one.
    for (const storedDocument of storedDocuments) {
      expect(await readJsonDocument(storedDocument)).toEqual(document);
    }
  });

  it('every listed analysis has all of the bytes its document cites', async () => {
    const documents = [
      makeTwoImageDocument(),
      makeDocument({ createdAt: '2024-06-01T09:30:00.000Z' }),
    ];

    for (const [index, document] of documents.entries()) {
      await repository.save(document, storedImagesFor(document, index * 10));
    }

    const listed = await repository.list(HISTORY_LIMIT_DEFAULT);

    expect(listed).toHaveLength(documents.length);

    for (const document of listed) {
      expect(document.images.length).toBeGreaterThan(0);

      for (const image of document.images) {
        const stored = await repository.readImage(document.analysisId, image.imageId);

        expect(stored).not.toBeNull();
        if (stored === null) {
          continue;
        }

        expect(stored.bytes).toBeInstanceOf(Uint8Array);
        expect(Array.from(stored.bytes).length).toBeGreaterThan(0);
        expect(stored.contentType).toBe(image.contentType);
      }
    }
  });
});

describe('id guard before any path is built — D1', () => {
  it('refuses a malformed id in the path builders with NOT_FOUND, never a filesystem error', () => {
    const traversal = '../../etc/passwd';

    const traversalError = captureThrown(() => documentPath(dataDir, traversal));

    expect(isAppError(traversalError)).toBe(true);
    if (!isAppError(traversalError)) {
      return;
    }

    // The refusal is the shared table's `NOT_FOUND`, and its sentence names neither the rejected id
    // nor the data directory, so probing ids cannot teach a caller the on-disk layout.
    expect(traversalError.code).toBe('NOT_FOUND');
    expect(traversalError.message).not.toContain('passwd');
    expect(traversalError.message).not.toContain(dataDir);

    // The guard is not specific to one builder: an analysis id, an image id and the temporary-file
    // builder each refuse a value this system did not generate.
    expect(() => documentPath(dataDir, 'not-an-id')).toThrow(AppError);
    expect(() => imagePath(dataDir, analysisId(), traversal)).toThrow(AppError);
    expect(() => documentTempPath(dataDir, traversal, randomUUID())).toThrow(AppError);
  });

  it('the repository rejects a malformed id with the same NOT_FOUND and leaves the store untouched', async () => {
    const traversal = '../../etc/passwd';
    const absentImage = imageId();

    // What the store actually does, pinned: every method that takes an id from a URL rejects with the
    // guard's `AppError` before any path is built — it does not resolve `null`/`false`, and it never
    // surfaces the `ENOENT`/`EACCES` a filesystem call would raise for a crafted path.
    const guardedCalls: ReadonlyArray<{
      readonly name: string;
      readonly run: () => Promise<unknown>;
    }> = [
      { name: 'findById', run: () => repository.findById(traversal) },
      { name: 'delete', run: () => repository.delete('not-an-id') },
      { name: 'readImage', run: () => repository.readImage(traversal, absentImage) },
    ];

    for (const call of guardedCalls) {
      const rejection = await captureRejection(call.run);

      expect(
        isAppError(rejection),
        `${call.name} must refuse a malformed id with the domain's AppError`,
      ).toBe(true);
      if (!isAppError(rejection)) {
        continue;
      }

      expect(rejection.code).toBe('NOT_FOUND');
    }

    // A refused id never became a path segment, so the analyses root was never created.
    expect(await walkFiles(analysesRoot(dataDir))).toEqual([]);
    expect(await pathExists(analysesRoot(dataDir))).toBe(false);
  });

  it('the temporary data directory is outside the checkout', () => {
    const resolved = resolve(dataDir);

    // The helper refuses a directory inside the checkout; the assertion keeps that intent visible in
    // the suite, so a change to the helper cannot quietly start writing the repository's own store.
    expect(resolved).not.toBe(REPOSITORY_DATA_DIR);
    expect(resolved.startsWith(`${REPOSITORY_DATA_DIR}${sep}`)).toBe(false);
    expect(resolved.startsWith(`${REPO_ROOT}${sep}`)).toBe(false);
  });
});

describe('observability — §0.4.5', () => {
  it('logs one JSON line per write and per delete, holding allowlisted fields and nothing sensitive', async () => {
    const document = makeDocument();
    const bytes = pngBytes(8);

    await repository.save(document, [makeStoredImage(document, bytes)]);

    const linesAfterSave = logLines.length;

    expect(linesAfterSave).toBeGreaterThan(0);

    await repository.delete(document.analysisId);

    expect(logLines.length).toBeGreaterThan(linesAfterSave);

    for (const line of logLines) {
      // One complete line per event: the writer is handed the trailing newline and no internal one.
      expect(line.endsWith('\n')).toBe(true);
      expect(line.slice(0, -1)).not.toContain('\n');

      const parsed = parseLogLine(line);

      for (const key of Object.keys(parsed)) {
        expect(ALLOWED_LOG_KEYS.has(key), `unexpected log field "${key}"`).toBe(true);
      }

      for (const forbidden of FORBIDDEN_LOG_KEYS) {
        expect(Object.keys(parsed)).not.toContain(forbidden);
      }
    }

    const parsedLines = logLines.map(parseLogLine);
    const saved = parsedLines.find((line) => line.event === 'analysis_saved');
    const deleted = parsedLines.find((line) => line.event === 'analysis_deleted');

    expect(saved).toBeDefined();
    expect(deleted).toBeDefined();
    expect(saved?.analysisId).toBe(document.analysisId);
    expect(deleted?.analysisId).toBe(document.analysisId);
    expect(deleted?.outcome).toBe('deleted');

    const joined = logLines.join('');

    // The stored payload never reaches a line, neither encoded as base64 nor as its own characters.
    expect(joined).not.toContain(Buffer.from(bytes).toString('base64'));
    expect(joined).not.toContain(Array.from(bytes).join(','));
  });
});

