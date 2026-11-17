/**
 * Suite for the two properties that keep a repeated write from being mistaken for a single write: the
 * store commits each save atomically under its own analysis id, and nothing in the system collapses two
 * identical submissions into one analysis.
 *
 * What this file is the evidence for, clause by clause:
 *
 * - AAP §0.6.5 names "Analysis deduplication" as a required absence, and this suite is the proof: two
 *   identical saves, and two identical concurrent submissions, both leave two separate records.
 * - AAP §0.6.3's error-table row — "Two identical submissions → `200` for each, never deduplicated, each
 *   with its own `analysisId`" — names this file as its proof, so the app-level block below drives the
 *   composed application through Supertest rather than asserting on the store alone.
 * - D2 fixes the write order this suite observes: image bytes first, the document last, under a temporary
 *   name renamed into place, so a half-written analysis is never observable and two concurrent submissions
 *   cannot collide.
 *
 * Two levels are proven, and neither substitutes for the other. The store-level block hands documents
 * straight to the port, which is where `Promise.all` over two `save` calls is the interleaving: the writes
 * share one event loop turn order with no timer, no poll and no artificial delay, and every assertion runs
 * after both have settled. The app-level block posts the same multipart body twice concurrently through
 * `buildTestApp`, which is the only path that can show the *service* mints a fresh id per submission
 * instead of reusing one.
 *
 * The suite is offline by construction: `vitest.config.ts` selects the replay provider, `buildTestApp`
 * forces the model credential unset, and the store takes an already-built document through the port, so
 * nothing here reads the environment, reaches the network or needs a credential. Documents are typed from
 * the shared contract and gated by the domain's own schema, so a contract drift fails here rather than
 * producing a record the store would persist and a consumer could not read.
 */
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import {
  API_BASE_PATH,
  DISCLAIMER,
  HISTORY_LIMIT_DEFAULT,
  type AnalysisDocument,
  type AnalysisImage,
} from '@trade-read/shared';

import { analysisId, imageId, isValidAnalysisId, levelId } from '../../src/domain/ids.js';
import { analysisDocumentSchema } from '../../src/domain/schemas.js';
import { createLogger, type LogEvent } from '../../src/observability/logger.js';
import type { StoredImage } from '../../src/ports/analysis-repository.js';
import { DOCUMENT_FILE_NAME, analysesRoot } from '../../src/store/data-paths.js';
import { FileSystemAnalysisRepository } from '../../src/store/file-system-analysis-repository.js';
import { buildTestApp, type TestApp } from '../helpers/build-test-app.js';
import { screenshotAttachment } from '../helpers/fixtures.js';
import { createTempDataDir, type TempDataDir } from '../helpers/temp-data-dir.js';

/** PNG's eight-byte signature: the prefix of every payload this suite stores. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Bytes of pseudo-chunk appended to the signature, so two payloads differ by their content alone. */
const PNG_BODY_LENGTH = 8;

/** The content type the stored payloads are served with; the store itself never sniffs the bytes. */
const PNG_CONTENT_TYPE = 'image/png';

/** The suffix a document is written under before its rename into place, asserted absent from a store. */
const TEMP_FILE_SUFFIX = '.tmp';

/** The event word the store logs once per committed write. */
const SAVE_EVENT = 'analysis_saved';

/**
 * The instant every store-level fixture carries.
 *
 * It is fixed rather than read from the clock so that two fixtures built in one test are identical in
 * their timestamp as well as in their content, which is what makes the deduplication case literal, and so
 * that a listing assertion never depends on how far apart two saves happened to run.
 */
const FIXED_CREATED_AT = '2024-06-03T12:00:00.000Z';

/**
 * Every field `LogEvent` declares, as a runtime-recognisable key set.
 *
 * `logger.ts` exports its allowlist as a type rather than as a runtime list, so this record is how the
 * suite reads it: the annotation is exhaustive over `keyof LogEvent`, which turns a field added to or
 * removed from the emitted set into a compile error here instead of an assertion that quietly stops
 * covering it. `server/test/store/persistence.test.ts` reads the same allowlist the same way.
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
const ALLOWED_LOG_KEYS: ReadonlySet<string> = new Set<string>([
  ...LOG_ENVELOPE_KEYS,
  ...Object.keys(LOG_EVENT_FIELDS),
]);

/**
 * Keys that must never reach a log line (AAP §0.4.5): image payloads, request or response bodies and
 * credential-bearing headers. None is a field of `LogEvent`, and this list proves the emitted lines carry
 * none of them under any name.
 */
const FORBIDDEN_LOG_KEYS = ['bytes', 'headers', 'body', 'authorization', 'apiKey'] as const;

/**
 * A payload of the shape the store keeps: a PNG signature followed by a short body that differs per seed.
 *
 * The bytes stay far below the length at which the logger's bare-base64 heuristic redacts a value, so the
 * "no payload in a log line" assertion below compares against text that could actually have appeared.
 * The store writes and returns these bytes verbatim and never decodes them, so nothing here needs to be a
 * picture: the app-level block submits real screenshots instead.
 */
function pngBytes(seed = 0): Uint8Array {
  const body = Array.from({ length: PNG_BODY_LENGTH }, (_unused, index) => (seed + index) % 256);

  return new Uint8Array([...PNG_SIGNATURE, ...body]);
}

/**
 * A complete, schema-valid analysis document.
 *
 * The fixture is built here rather than by the domain's document builder because the store is handed an
 * already-built document through the port (D3, D10) and persists it verbatim, so a typed document the real
 * schema accepts is the correct fixture for this layer; `buildAnalysisDocument` is deliberately not called.
 * The `analysisDocumentSchema.parse` inside this function is what makes a contract change fail here with
 * the schema's own message instead of producing a document the store would accept and a consumer could not
 * read.
 */
function makeDocument(overrides: Partial<AnalysisDocument> = {}): AnalysisDocument {
  const cited = imageId();
  const bytes = pngBytes();

  const document: AnalysisDocument = {
    analysisId: analysisId(),
    createdAt: FIXED_CREATED_AT,
    instrument: '',
    context: '',
    images: [
      {
        imageId: cited,
        fileName: 'footprint-es-5m.png',
        contentType: PNG_CONTENT_TYPE,
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

/** One document's body — every field but its id — so two documents can be compared for identity. */
function withoutAnalysisId(document: AnalysisDocument): Omit<AnalysisDocument, 'analysisId'> {
  const { analysisId: id, ...body } = document;

  void id;

  return body;
}

/**
 * The single body two documents share in the deduplication case.
 *
 * Built once and spread into both fixtures, so the two saves differ in their analysis id and in nothing
 * else: not the timestamp, the image, the level, the recommendation or the usage figures. That is what
 * makes the case a deduplication proof rather than a proof that two distinct records can coexist.
 */
function identicalBody(): Omit<AnalysisDocument, 'analysisId'> {
  return withoutAnalysisId(makeDocument());
}

/** The `StoredImage` one image of a document is persisted as, with payload bytes the caller controls. */
function makeImage(targetImageId: string, bytes: Uint8Array): StoredImage {
  return { imageId: targetImageId, contentType: PNG_CONTENT_TYPE, bytes };
}

/** The first image a document cites; a fixture that cites none is a defect in this suite. */
function firstImage(document: AnalysisDocument): AnalysisImage {
  const [image] = document.images;

  if (image === undefined) {
    throw new Error('the document fixture must cite at least one image');
  }

  return image;
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

/**
 * Every stored `document.json` in the store beneath `dataDir`.
 *
 * The paths are found by walking the store and matching the file name `data-paths.ts` owns, rather than
 * by joining an id the suite expects, so a third document written under any id is still found.
 */
async function storedDocumentPaths(dataDir: string): Promise<string[]> {
  const files = await walkFiles(analysesRoot(dataDir));

  return files.filter((path) => basename(path) === DOCUMENT_FILE_NAME);
}

/** One stored document file as the JSON it holds; a truncated file fails here rather than reading as one. */
async function readJsonDocument(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

/**
 * Every stored document beneath `dataDir`, validated as the shared contract's document.
 *
 * Validating rather than merely parsing is what makes "every stored document is intact" checkable: a
 * document cut short on disk, or written in a shape the contract does not admit, throws here.
 */
async function storedContracts(dataDir: string): Promise<AnalysisDocument[]> {
  const paths = await storedDocumentPaths(dataDir);

  return Promise.all(
    paths.map(async (path) => analysisDocumentSchema.parse(await readJsonDocument(path))),
  );
}

/** Parses one captured log line, refusing anything that is not a JSON object. */
function parseLogLine(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`a log line must be a JSON object, received: ${line}`);
  }

  return parsed as Record<string, unknown>;
}

/** The analysis ids recorded on the save lines among `records`, in emission order. */
function savedAnalysisIds(records: ReadonlyArray<Record<string, unknown>>): string[] {
  const ids: string[] = [];

  for (const record of records) {
    if (record['event'] === SAVE_EVENT && typeof record['analysisId'] === 'string') {
      ids.push(record['analysisId']);
    }
  }

  return ids;
}

/**
 * One isolated data directory and one repository per test, over the same logger seam the application
 * uses, so a write's log line is observable here exactly as it is in production.
 *
 * The directory is created outside the checkout by the helper and removed in `afterEach`, which runs even
 * when an assertion throws, so no test depends on another's directory or on execution order.
 */
let temp: TempDataDir;
let logLines: string[];
let repository: FileSystemAnalysisRepository;

describe('two simultaneous saves leave two intact documents — D2', () => {
  beforeEach(async () => {
    temp = await createTempDataDir('store-concurrency-');
    logLines = [];
    repository = new FileSystemAnalysisRepository({
      dataDir: temp.dataDir,
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

  // AAP §0.6.5 — two simultaneous writes, two intact analyses and no partially written third thing.
  it('Promise.all over two saves leaves two intact, independently readable documents', async () => {
    const firstDocument = makeDocument();
    const secondDocument = makeDocument();
    const firstCited = firstImage(firstDocument);
    const secondCited = firstImage(secondDocument);
    const firstBytes = pngBytes(1);
    const secondBytes = pngBytes(2);

    // `Promise.all` is the interleaving: both saves are started before either is awaited, and the
    // assertions below run only once both have settled.
    await Promise.all([
      repository.save(firstDocument, [makeImage(firstCited.imageId, firstBytes)]),
      repository.save(secondDocument, [makeImage(secondCited.imageId, secondBytes)]),
    ]);

    expect(firstDocument.analysisId).not.toBe(secondDocument.analysisId);

    // Each id serves its own document, unchanged: the store persisted what it was handed, verbatim.
    expect(await repository.findById(firstDocument.analysisId)).toEqual(firstDocument);
    expect(await repository.findById(secondDocument.analysisId)).toEqual(secondDocument);

    // The listing holds both and collapses neither. Both fixtures carry the same instant, so the order is
    // the store's id tie-break; membership is asserted rather than an index that would depend on it.
    const listed = await repository.list(HISTORY_LIMIT_DEFAULT);

    expect(listed).toHaveLength(2);
    expect([...new Set(listed.map((item) => item.analysisId))].sort()).toEqual(
      [firstDocument.analysisId, secondDocument.analysisId].sort(),
    );

    const firstRead = await repository.readImage(firstDocument.analysisId, firstCited.imageId);
    const secondRead = await repository.readImage(secondDocument.analysisId, secondCited.imageId);

    expect(firstRead).not.toBeNull();
    expect(secondRead).not.toBeNull();

    if (firstRead === null || secondRead === null) {
      return;
    }

    // Each analysis returns its own payload, so neither write overwrote the other's bytes.
    expect(Array.from(firstRead.bytes)).toEqual(Array.from(firstBytes));
    expect(Array.from(secondRead.bytes)).toEqual(Array.from(secondBytes));
    expect(Array.from(firstRead.bytes)).not.toEqual(Array.from(secondRead.bytes));
    expect(firstRead.contentType).toBe(PNG_CONTENT_TYPE);

    // Reading stays scoped to one analysis: one analysis's id never serves another analysis's image.
    expect(await repository.readImage(firstDocument.analysisId, secondCited.imageId)).toBeNull();

    // No partially written document is observable. Every `document.json` in the store is one of the two
    // documents in full — a third, a truncated one or a stray copy fails here — and the temporary file each
    // was written under has been renamed away.
    const stored = await storedContracts(temp.dataDir);

    expect(stored).toHaveLength(2);

    for (const document of stored) {
      expect([firstDocument, secondDocument]).toContainEqual(document);
    }

    expect(
      (await walkFiles(analysesRoot(temp.dataDir))).filter((path) => path.endsWith(TEMP_FILE_SUFFIX)),
    ).toEqual([]);
  });

  // AAP §0.6.5 — identical content is still two records, because the id is what tells them apart.
  it('identical content is never deduplicated at the store', async () => {
    const body = identicalBody();
    const firstDocument = makeDocument({ ...body });
    const secondDocument = makeDocument({ ...body });

    // "Identical" is literal: one body spread into both documents, and only the id differs.
    expect(withoutAnalysisId(firstDocument)).toEqual(withoutAnalysisId(secondDocument));
    expect(firstDocument.analysisId).not.toBe(secondDocument.analysisId);

    const cited = firstImage(firstDocument);
    const payload = pngBytes(3);

    await Promise.all([
      repository.save(firstDocument, [makeImage(cited.imageId, payload)]),
      repository.save(secondDocument, [makeImage(cited.imageId, payload)]),
    ]);

    // Two analysis directories, each holding its own document, even though both documents cite the same
    // image id and the same prices.
    const analysisDirectories = (await readdir(analysesRoot(temp.dataDir), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(analysisDirectories.sort()).toEqual(
      [firstDocument.analysisId, secondDocument.analysisId].sort(),
    );
    expect(await storedDocumentPaths(temp.dataDir)).toHaveLength(2);

    // Each id answers with a document carrying that id, not with the other's.
    const firstFound = await repository.findById(firstDocument.analysisId);
    const secondFound = await repository.findById(secondDocument.analysisId);

    expect(firstFound).not.toBeNull();
    expect(secondFound).not.toBeNull();

    if (firstFound === null || secondFound === null) {
      return;
    }

    expect(firstFound.analysisId).toBe(firstDocument.analysisId);
    expect(secondFound.analysisId).toBe(secondDocument.analysisId);
    expect(await repository.list(HISTORY_LIMIT_DEFAULT)).toHaveLength(2);

    // The ids come from the caller here — the store is told which analysis to write — so this case proves
    // the store keeps both and deduplicates nothing. The app-level block below is what proves the service
    // never reuses an id in the first place.
  });

  // AAP §0.6.5 — a third simultaneous write neither joins nor disturbs the first two.
  it('a third concurrent save does not disturb the first two', async () => {
    const saves = [makeDocument(), makeDocument(), makeDocument()].map((document, index) => ({
      document,
      cited: firstImage(document),
      bytes: pngBytes(10 + index),
    }));

    await Promise.all(
      saves.map((save) => repository.save(save.document, [makeImage(save.cited.imageId, save.bytes)])),
    );

    const ids = saves.map((save) => save.document.analysisId);

    expect(new Set(ids).size).toBe(3);
    expect(await storedDocumentPaths(temp.dataDir)).toHaveLength(3);

    const stored = await storedContracts(temp.dataDir);

    expect(stored.map((document) => document.analysisId).sort()).toEqual([...ids].sort());

    for (const save of saves) {
      const storedImage = await repository.readImage(save.document.analysisId, save.cited.imageId);

      expect(storedImage).not.toBeNull();

      if (storedImage === null) {
        return;
      }

      expect(Array.from(storedImage.bytes)).toEqual(Array.from(save.bytes));
    }
  });

  /**
   * AAP §0.4.5 — what a concurrent write reports, and what it must never report.
   *
   * Nested inside the store block because it observes those writes' log lines. The app-level block's
   * capture of the same logger is `buildTestApp().logLines` and `logEvents()`.
   */
  describe('observability — §0.4.5', () => {
    it('each concurrent save logs its own line and logs nothing sensitive', async () => {
      const firstDocument = makeDocument();
      const secondDocument = makeDocument();
      const firstBytes = pngBytes(4);
      const secondBytes = pngBytes(5);

      await Promise.all([
        repository.save(firstDocument, [
          makeImage(firstImage(firstDocument).imageId, firstBytes),
        ]),
        repository.save(secondDocument, [
          makeImage(firstImage(secondDocument).imageId, secondBytes),
        ]),
      ]);

      expect(logLines.length).toBeGreaterThanOrEqual(2);

      for (const line of logLines) {
        // One complete line per event: the writer is handed the trailing newline and no internal one.
        expect(line.endsWith('\n')).toBe(true);
        expect(line.slice(0, -1)).not.toContain('\n');
      }

      const records = logLines.map(parseLogLine);

      // Every field is one the logger declares, and no field is one that could carry an image, a body or
      // a credential-bearing header.
      for (const record of records) {
        for (const key of Object.keys(record)) {
          expect(ALLOWED_LOG_KEYS.has(key), `unexpected log field "${key}"`).toBe(true);
        }

        for (const forbidden of FORBIDDEN_LOG_KEYS) {
          expect(record).not.toHaveProperty(forbidden);
        }
      }

      // Both writes are reported, each against its own id, so two concurrent saves stay distinguishable.
      expect([...new Set(savedAnalysisIds(records))].sort()).toEqual(
        [firstDocument.analysisId, secondDocument.analysisId].sort(),
      );

      // Neither payload reaches a line, neither encoded as base64 nor as its own characters.
      const joined = logLines.join('');

      expect(joined).not.toContain(Buffer.from(firstBytes).toString('base64'));
      expect(joined).not.toContain(Buffer.from(secondBytes).toString('base64'));
      expect(joined).not.toContain('data:image');
      expect(joined).not.toContain(Array.from(firstBytes).join(','));
    });
  });
});


/** One response, in the shape Supertest hands back. */
type SubmissionResponse = request.Response;

/** The footprint screenshot: the image whose value-area and imbalance levels the read is built from. */
const FOOTPRINT_SCREENSHOT = 'footprint-es-5m';

/** The GEX screenshot: the image whose gamma levels supply the invalidation and a target. */
const GEX_SCREENSHOT = 'gex-es-levels';

/**
 * One submission of the same body every time: the two screenshots, no instrument, no context and no prompt
 * field of any kind. Two of these started together are what the block below proves is never collapsed.
 *
 * The fixtures are the real screenshots rather than the synthetic payloads used above, because the server
 * sniffs the magic bytes and reads the dimensions from the received buffer: a stub image would be rejected
 * before the analysis ran, and the case would prove nothing about submission.
 */
async function postIdenticalSubmission(target: TestApp): Promise<SubmissionResponse> {
  const footprint = screenshotAttachment(FOOTPRINT_SCREENSHOT);
  const gex = screenshotAttachment(GEX_SCREENSHOT);

  return request(target.app)
    .post(`${API_BASE_PATH}/analyses`)
    .attach('images', footprint.bytes, {
      filename: footprint.fileName,
      contentType: footprint.contentType,
    })
    .attach('images', gex.bytes, { filename: gex.fileName, contentType: gex.contentType });
}

/** One response's status and body, for an assertion message that reports what actually came back. */
function describeResponse(response: SubmissionResponse): string {
  return `expected 200, received ${response.status} with body ${JSON.stringify(response.body as unknown)}`;
}

/** The document a create or get response carries, validated against the shared contract. */
function documentOf(response: SubmissionResponse): AnalysisDocument {
  return analysisDocumentSchema.parse(response.body as unknown);
}

/** The documents a list response carries, each validated against the shared contract. */
function listedDocuments(response: SubmissionResponse): AnalysisDocument[] {
  const body: unknown = response.body;

  if (typeof body !== 'object' || body === null || !('items' in body)) {
    throw new Error(
      `a list response must be an object holding items, received: ${JSON.stringify(body)}`,
    );
  }

  const items: unknown = body.items;

  if (!Array.isArray(items)) {
    throw new Error(`a list response must hold an items array, received: ${JSON.stringify(body)}`);
  }

  return items.map((item: unknown) => analysisDocumentSchema.parse(item));
}

/** The ids a list response carries, as a set: two analyses made in one millisecond cannot affect membership. */
function listedAnalysisIds(response: SubmissionResponse): Set<string> {
  return new Set(listedDocuments(response).map((document) => document.analysisId));
}

/** The composed application for one case, over its own temporary data directory. */
let app: TestApp;

/**
 * AAP §0.6.5 and §0.6.3 — the service never deduplicates, proven by posting the same body concurrently.
 *
 * The block drives the composed application rather than the store, so what it proves is the whole system's
 * behaviour: two identical submissions were answered twice, stored twice and listed twice. The application
 * is built by the shared helper, which selects the replay provider and forces the model credential unset, so
 * no case here reaches the network or needs one.
 */
describe('identical submissions are never deduplicated — AAP §0.6.5 / §0.6.3', () => {
  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.cleanup();
  });

  // AAP §0.6.3 — two identical submissions, `200` for each, each with its own `analysisId`.
  it('two identical submissions fired concurrently each return 200 with their own analysisId', async () => {
    const [first, second] = await Promise.all([
      postIdenticalSubmission(app),
      postIdenticalSubmission(app),
    ]);

    expect(first.status, describeResponse(first)).toBe(200);
    expect(second.status, describeResponse(second)).toBe(200);

    // Both bodies are the shared contract's document, so neither response is a look-alike of it.
    const firstDocument = documentOf(first);
    const secondDocument = documentOf(second);

    expect(firstDocument.analysisId).not.toBe(secondDocument.analysisId);
    // Both ids are ids this system generated, so neither could have been chosen by the caller.
    expect(isValidAnalysisId(firstDocument.analysisId)).toBe(true);
    expect(isValidAnalysisId(secondDocument.analysisId)).toBe(true);

    // Two submissions, two analyses: the store was written twice rather than once.
    expect(await storedDocumentPaths(app.dataDir)).toHaveLength(2);
  });

  // AAP §0.6.3 — both are retrievable on their own and both appear in the history page.
  it('both submissions are independently retrievable and both are listed', async () => {
    const [first, second] = await Promise.all([
      postIdenticalSubmission(app),
      postIdenticalSubmission(app),
    ]);

    expect(first.status, describeResponse(first)).toBe(200);
    expect(second.status, describeResponse(second)).toBe(200);

    const firstDocument = documentOf(first);
    const secondDocument = documentOf(second);

    const firstRetrieved = await request(app.app).get(
      `${API_BASE_PATH}/analyses/${firstDocument.analysisId}`,
    );
    const secondRetrieved = await request(app.app).get(
      `${API_BASE_PATH}/analyses/${secondDocument.analysisId}`,
    );

    expect(firstRetrieved.status, describeResponse(firstRetrieved)).toBe(200);
    expect(secondRetrieved.status, describeResponse(secondRetrieved)).toBe(200);
    expect(documentOf(firstRetrieved)).toEqual(firstDocument);
    expect(documentOf(secondRetrieved)).toEqual(secondDocument);

    const listed = await request(app.app).get(`${API_BASE_PATH}/analyses`);

    expect(listed.status, describeResponse(listed)).toBe(200);

    // Membership rather than an index: the list is newest first, and two analyses created in the same
    // millisecond are ordered by the store's id tie-break rather than by which one finished first.
    const listedIds = listedAnalysisIds(listed);

    expect(listedIds.size).toBe(2);
    expect(listedIds.has(firstDocument.analysisId)).toBe(true);
    expect(listedIds.has(secondDocument.analysisId)).toBe(true);

    // Two distinct files on disk, so neither id is a second name for one record.
    expect(await storedDocumentPaths(app.dataDir)).toHaveLength(2);
  });

  // AAP §0.6.5 — the "no partially written document observable" half, over the application's own store.
  it('no partial analysis exists after the concurrent submissions', async () => {
    const [first, second] = await Promise.all([
      postIdenticalSubmission(app),
      postIdenticalSubmission(app),
    ]);

    expect(first.status, describeResponse(first)).toBe(200);
    expect(second.status, describeResponse(second)).toBe(200);

    const firstDocument = documentOf(first);
    const secondDocument = documentOf(second);

    const stored = await storedContracts(app.dataDir);

    expect(stored).toHaveLength(2);
    expect(stored.map((document) => document.analysisId).sort()).toEqual(
      [firstDocument.analysisId, secondDocument.analysisId].sort(),
    );

    // No `.tmp` residue: each document was renamed into place, so nothing was left half-written.
    expect(
      (await walkFiles(analysesRoot(app.dataDir))).filter((path) => path.endsWith(TEMP_FILE_SUFFIX)),
    ).toEqual([]);
  });
});

