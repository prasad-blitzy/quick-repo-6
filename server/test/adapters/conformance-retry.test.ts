/**
 * The one-line conformance contract, the single silent retry it allows and the failure it ends in,
 * proved over HTTP against the replay provider (AAP §0.2.2, §0.4.3, §0.4.5, §0.6.3, §0.6.6
 * criterion 3; D4, D11).
 *
 * Five properties are pinned here and nowhere else:
 *
 * - each of the four recorded adversarial answers — a second line, a code fence, a trailing
 *   sentence and a truncation the provider flagged — is refused, retried exactly once and answered
 *   `502 ANALYSIS_FAILED` (§0.4.3, D11);
 * - the retry is one attempt and one attempt only, and it is spent on the synthesis call: the two
 *   extractions answer on their first attempt, and the failed synthesis appears exactly twice in the
 *   provider's capture carrying the identical message list and ceiling (§0.4.4, D11);
 * - the refusal stores nothing — no document, no image bytes, no analysis directory — and a second
 *   repository instance over the same directory agrees (D2);
 * - the log line names the failure, its reason and the raw answer it rejected, and carries no
 *   credential, no authorization header and no image bytes (§0.4.5);
 * - the response body is exactly the shared `{ code, message }` error, with no partial document, no
 *   stack and no filesystem path (§0.3.1).
 *
 * A control case submits the same two screenshots against a conforming recording, so a green
 * failure row cannot mean "every submission fails". Nothing here reaches the network: the replay
 * provider answers from `fixtures/recorded/**` through the production conformance check, the
 * production schema and the production retry policy (D4), and no case waits on a clock.
 */

import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  API_BASE_PATH,
  ERROR_CODES,
  ERROR_MESSAGES,
  ERROR_STATUS,
  MAX_TOKENS_SYNTHESIS,
  type AnalysisDocument,
  type ApiErrorBody,
} from '@trade-read/shared';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CONFORMANCE_REASONS,
  type ConformanceReason,
} from '../../src/adapters/openrouter/conformance.js';
import { buildTestApp, type TestApp } from '../helpers/build-test-app.js';
import {
  screenshotAttachment,
  type MultipartAttachment,
} from '../helpers/fixtures.js';
import {
  RECORDED_ADVERSARIAL_KINDS,
  recordedAdversarial,
  recordedAnswerLine,
  recordedSynthesis,
  type RecordedAdversarialKind,
  type RecordedChatCompletion,
} from '../helpers/recorded.js';

/**
 * The only credential literal in this file: obviously fake and deliberately not shaped like a
 * gateway key, so no scanner finds a real one here while the assertions below keep a distinctive
 * value to look for in every captured log line (§0.4.5).
 */
const FAKE_API_KEY = 'test-fake-key-not-a-secret';

/** The submission endpoint, built from the shared base path rather than restated (§0.3.1). */
const SUBMIT_URL = `${API_BASE_PATH}/analyses`;

/**
 * The store's on-disk layout, named here rather than imported from it (D2).
 *
 * The "nothing persisted" case must not ask the store to read back what the store itself would have
 * written: a repository that mislaid a document would then report an empty store and the case would
 * pass on a leftover file. These two names are the layout as stated, so the scan is independent of
 * the reader being tested beside it.
 */
const ANALYSES_DIR_NAME = 'analyses';
const DOCUMENT_FILE_NAME = 'document.json';

/**
 * The event `openrouter-client.ts` emits once per rejected answer, before the retry and again when
 * the second rejection ends the analysis (D11). The client does not export the name, so it is
 * stated once here and every assertion below reads it rather than a bare literal.
 */
const CONFORMANCE_FAILURE_EVENT = 'provider_conformance_failed';

/** The recording the control case replays: the baseline directional read (D10). */
const CONTROL_SYNTHESIS_SCRIPT = 'synthesis-long';

/** The two screenshots every case submits, the same pair the end-to-end suite drops. */
const PRIMARY_IMAGE: MultipartAttachment = screenshotAttachment('footprint-es-5m');
const SECONDARY_IMAGE: MultipartAttachment = screenshotAttachment('gex-es-levels');

/** The recorded answers the control case is asserted against, loaded once from their fixtures. */
const CONTROL_ANSWER: RecordedChatCompletion = recordedSynthesis('long');

/** The one-sentence summary the control document must reproduce byte for byte. */
const CONTROL_SUMMARY = recordedSummary(CONTROL_ANSWER);

/**
 * The substrings that would betray a value a log line may never carry (§0.4.5): the credential, the
 * header it travels in, and an image payload in either of the forms it is written in.
 */
const FORBIDDEN_IN_LOGS: readonly string[] = [
  FAKE_API_KEY,
  'authorization',
  'Authorization',
  'data:image',
  'base64,',
];

/** A bare base64 run, which is how image bytes appear once they are out of their URI wrapper. */
const BARE_BASE64_RUN = /[A-Za-z0-9+/]{64,}/;

/** What a leaked stack frame or filesystem path would look like inside a response body (§0.3.1). */
const FORBIDDEN_IN_BODIES: ReadonlyArray<RegExp> = [
  /\/tmp\//,
  /\.data/,
  /node_modules/,
  /\bat\s+\w+\s+\(/,
];

/** The reason each recorded adversarial answer earns, keyed so a new fixture cannot be forgotten. */
const EXPECTED_REASON: Readonly<Record<RecordedAdversarialKind, ConformanceReason>> = {
  'two-line': 'INTERNAL_NEWLINE',
  fenced: 'INTERNAL_NEWLINE',
  'trailing-sentence': 'SURROUNDING_TEXT',
  truncated: 'TRUNCATED',
};

/** The token that identifies each recorded adversarial answer as what its name claims. */
const MARKER: Readonly<Record<RecordedAdversarialKind, string>> = {
  'two-line': '\n',
  fenced: '```',
  'trailing-sentence': 'This read assumes the level holds',
  truncated: 'the footprint imb',
};

/** One adversarial answer, the reason the check records for it, and the token that identifies it. */
interface AdversarialCase {
  /** The recorded fixture replayed as the synthesis answer. */
  readonly kind: RecordedAdversarialKind;

  /** The conformance reason the check records for this answer (§0.4.3, D4). */
  readonly reason: ConformanceReason;

  /** What the recorded answer must contain, so the row proves it replayed the fixture it names. */
  readonly marker: string;
}

/**
 * The four adversarial answers and the reason each earns, one row per recorded fixture.
 *
 * `fenced` is refused as `INTERNAL_NEWLINE`, not `FENCE`: a markdown fence necessarily spans lines,
 * and the check tests the internal newline before the fence, so the fence branch can only ever be
 * reached by a single-line fence. What the row evidences is unchanged — a fenced answer is refused,
 * retried and answered `502` — and it additionally proves the fence token was really in the answer
 * it sent. The reason is the one the implementation produces, observed rather than assumed; the
 * fixtures and the check belong to other files and are not edited to match this table.
 */
const ADVERSARIAL_CASES: readonly AdversarialCase[] = RECORDED_ADVERSARIAL_KINDS.map((kind) => ({
  kind,
  reason: EXPECTED_REASON[kind],
  marker: MARKER[kind],
}));

/** Every app a case built, so a failing assertion still releases its temporary data directory. */
const builtApps: TestApp[] = [];

/** What one offline app is built with. */
interface OfflineAppOptions {
  /** The recording or recording name the synthesis call replays. */
  readonly synthesisScript: string;

  /**
   * A configured credential, so the log scan proves a credential the process holds never reaches a
   * line (§0.4.5). The replay provider answers regardless — no configured value reaches a socket.
   */
  readonly credential?: string;
}

/**
 * Builds one offline application over a fresh temporary data directory and remembers it for
 * teardown.
 */
async function buildOfflineApp(options: OfflineAppOptions): Promise<TestApp> {
  const testApp = await buildTestApp({
    config: options.credential === undefined ? {} : { OPENROUTER_API_KEY: options.credential },
    stub: { synthesisScript: options.synthesisScript },
  });

  builtApps.push(testApp);

  return testApp;
}

/** The replay provider of an offline app, which every case here builds with. */
function stubOf(testApp: TestApp): NonNullable<TestApp['stub']> {
  const { stub } = testApp;

  if (stub === null) {
    throw new Error('this suite builds every app with the replay provider, which this one lacks');
  }

  return stub;
}

/** The roles of the provider calls issued so far, in issue order, a retry included (D11, D14). */
function rolesOf(testApp: TestApp): string[] {
  return stubOf(testApp).calls.map((call) => call.role);
}

/** The name the replay provider resolves to one adversarial recording. */
function adversarialScript(kind: RecordedAdversarialKind): string {
  return `adversarial/${kind}`;
}

/** Submits both screenshots with an instrument label and no other text. */
async function submit(testApp: TestApp) {
  return await request(testApp.app)
    .post(SUBMIT_URL)
    .field('instrument', 'ES')
    .attach('images', PRIMARY_IMAGE.bytes, {
      filename: PRIMARY_IMAGE.fileName,
      contentType: PRIMARY_IMAGE.contentType,
    })
    .attach('images', SECONDARY_IMAGE.bytes, {
      filename: SECONDARY_IMAGE.fileName,
      contentType: SECONDARY_IMAGE.contentType,
    });
}

/** The one-sentence summary a recorded synthesis answer carries, read out of its own line. */
function recordedSummary(envelope: RecordedChatCompletion): string {
  const parsed: unknown = JSON.parse(recordedAnswerLine(envelope));

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('a recorded synthesis answer must hold exactly one JSON object');
  }

  const { w } = parsed as Record<string, unknown>;

  if (typeof w !== 'string') {
    throw new Error('a recorded synthesis answer must carry its summary sentence as "w"');
  }

  return w;
}

/** Whether a thrown value is Node's "this path does not exist" failure. */
function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Whether anything exists at `target`, whatever its type. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The analysis directories under `dataDir` that hold a document, read from the layout itself rather
 * than through the store (D2). A data directory with no `analyses` directory is the pristine state a
 * refused submission must leave behind, so it answers with no directories at all.
 */
async function dirsHoldingADocument(dataDir: string): Promise<string[]> {
  const analysesDir = join(dataDir, ANALYSES_DIR_NAME);

  let entries: Dirent[];

  try {
    entries = await readdir(analysesDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) {
      return [];
    }

    throw error;
  }

  const holders: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (await pathExists(join(analysesDir, entry.name, DOCUMENT_FILE_NAME))) {
      holders.push(entry.name);
    }
  }

  return holders;
}

afterEach(async () => {
  // Every app of the case, control apps included: a temporary directory that leaked would outlive
  // the run and confuse the next one.
  const released = builtApps.splice(0);

  await Promise.all(released.map(async (testApp) => testApp.cleanup()));
});

describe('a conforming answer: the control', () => {
  it('stores the read the recording describes without retrying anything', async () => {
    const controlApp = await buildOfflineApp({ synthesisScript: CONTROL_SYNTHESIS_SCRIPT });

    const response = await submit(controlApp);
    const document = response.body as AnalysisDocument;

    expect(response.status).toBe(200);
    expect(typeof document.analysisId).toBe('string');
    expect(document.recommendation).toBeTypeOf('object');
    // The summary is the recording's own sentence, so this document came from that answer rather
    // than from a default the harness supplied.
    expect(document.recommendation.summary).toBe(CONTROL_SUMMARY);
    expect(document.levels.length).toBeGreaterThan(0);

    // No retry on the conforming path: two extractions and one synthesis, once each.
    expect(rolesOf(controlApp)).toEqual(['extraction', 'extraction', 'synthesis']);

    // The same harness does persist a completed analysis, which is what makes the empty store of a
    // refused one an assertion about the refusal rather than about the harness.
    expect(await controlApp.repository.list(100)).toHaveLength(1);
    expect(await dirsHoldingADocument(controlApp.dataDir)).toHaveLength(1);
  });
});

describe('an answer that breaks the one-line contract', () => {
  for (const { kind, reason, marker } of ADVERSARIAL_CASES) {
    it(`refuses the "${kind}" answer, retries it once and answers 502`, async () => {
      const recorded = recordedAnswerLine(recordedAdversarial(kind));

      // The row replays the fixture it names: the token that makes this answer what it is.
      expect(recorded).toContain(marker);

      const analysisApp = await buildOfflineApp({
        synthesisScript: adversarialScript(kind),
        credential: FAKE_API_KEY,
      });

      const response = await submit(analysisApp);
      const body = response.body as ApiErrorBody;

      // The response contract (§0.3.1): the shared code and its shared sentence, and nothing beside
      // them — no stack, no cause, no filesystem path, no provider text.
      expect(response.status).toBe(ERROR_STATUS.ANALYSIS_FAILED);
      expect(body.code).toBe('ANALYSIS_FAILED');
      expect(ERROR_CODES).toContain(body.code);
      expect(body.message).toBe(ERROR_MESSAGES.ANALYSIS_FAILED);
      expect(Object.keys(body).sort()).toEqual(['code', 'message']);
      expect(body).not.toHaveProperty('stack');
      expect(body).not.toHaveProperty('cause');

      const serialisedBody = JSON.stringify(body);

      for (const leak of FORBIDDEN_IN_BODIES) {
        expect(serialisedBody).not.toMatch(leak);
      }

      // D11: exactly one retry, of the synthesis call and of nothing else. The count is the
      // assertion — not that a retry happened somewhere.
      const calls = stubOf(analysisApp).calls;

      expect(rolesOf(analysisApp)).toEqual([
        'extraction',
        'extraction',
        'synthesis',
        'synthesis',
      ]);

      const synthesisAttempts = calls.filter((call) => call.role === 'synthesis');

      expect(synthesisAttempts).toHaveLength(2);
      // The retry re-posts the request rather than re-reading the answer it already rejected, so
      // the second attempt carries the same message list and the same ceiling as the first.
      expect(synthesisAttempts[1]?.messages).toEqual(synthesisAttempts[0]?.messages);
      expect(synthesisAttempts[0]?.maxTokens).toBe(MAX_TOKENS_SYNTHESIS);
      expect(synthesisAttempts[1]?.maxTokens).toBe(MAX_TOKENS_SYNTHESIS);

      // Nothing persisted (D2): no document through the store the app writes with, none through a
      // second instance over the same directory, and none on disk.
      expect(await analysisApp.repository.list(100)).toEqual([]);
      expect(await analysisApp.newRepository().list(100)).toEqual([]);
      expect(await dirsHoldingADocument(analysisApp.dataDir)).toEqual([]);

      const failures = analysisApp.logEvents().filter(
        (event) => event.event === CONFORMANCE_FAILURE_EVENT,
      );

      // One line per failing attempt — the retry at `warn`, the attempt that ends the analysis at
      // `error` — so the retry's depth and its silence are both stated as facts.
      expect(failures.map((event) => event.level)).toEqual(['warn', 'error']);
      expect(failures.map((event) => event.reason)).toEqual([reason, reason]);

      for (const event of failures) {
        expect(CONFORMANCE_REASONS).toContain(event.reason);
        expect(event.role).toBe('synthesis');

        // The rejected answer travels in `message` alone, because a malformed answer cannot be
        // diagnosed without it (§0.4.5). It is the call the line is tied to by its role: the port's
        // request types carry no analysis id, so an id is asserted only when one is attached.
        expect(event.message).toContain(recorded);

        if (event.analysisId !== undefined) {
          expect(typeof event.analysisId).toBe('string');
        }
      }

      // No line of the analysis carries the configured credential, the header it would travel in or
      // an image payload in either form (§0.4.5).
      const logText = analysisApp.logLines.join('\n');

      for (const forbidden of FORBIDDEN_IN_LOGS) {
        expect(logText).not.toContain(forbidden);
      }

      expect(logText).not.toMatch(BARE_BASE64_RUN);

      // The failure leaves nothing behind that poisons the next submission: a fresh app, the
      // conforming recording and the same two screenshots store a document.
      const recoveryApp = await buildOfflineApp({ synthesisScript: CONTROL_SYNTHESIS_SCRIPT });
      const recovery = await submit(recoveryApp);

      expect(recovery.status).toBe(200);
      expect(typeof (recovery.body as AnalysisDocument).analysisId).toBe('string');
    });
  }
});

describe('the retry stays silent', () => {
  it('answers with the error body alone, never a partial document', async () => {
    const analysisApp = await buildOfflineApp({
      synthesisScript: adversarialScript('two-line'),
    });

    const response = await submit(analysisApp);
    const body = response.body as Record<string, unknown>;

    expect(response.status).toBe(ERROR_STATUS.ANALYSIS_FAILED);
    expect(Object.keys(body).sort()).toEqual(['code', 'message']);

    // No field of the document appears in whole or in part: the caller is told the analysis failed,
    // and is handed no read with pieces missing.
    const documentFields = [
      'analysisId',
      'createdAt',
      'instrument',
      'context',
      'images',
      'levels',
      'recommendation',
      'rationale',
      'assumptions',
      'modelUsage',
      'disclaimer',
    ];

    for (const field of documentFields) {
      expect(body[field]).toBeUndefined();
    }
  });
});
