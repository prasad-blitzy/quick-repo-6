/**
 * The provider failure table and the retry policy, asserted at the two seams that own them
 * (AAP §0.2.2, §0.4.1, §0.6.3; D4, D11).
 *
 * Three properties are proved here and nowhere else:
 *
 * - every provider HTTP status becomes exactly one code of the closed table, carrying the status
 *   `ERROR_STATUS` gives that code and the sentence `ERROR_MESSAGES` gives it, so neither the
 *   number nor the wording is restated in this file;
 * - the one row whose message names a configured value — `PROVIDER_MODEL_UNSUPPORTED` — names the
 *   configured slug and never the credential (AAP §0.4.5);
 * - the single silent retry is spent on a conformance failure and on nothing else, so an
 *   authentication refusal, a permission refusal, a quota refusal, an unsupported slug, a provider
 *   timeout, a rate limit and a network failure each cost exactly one attempt (D11).
 *
 * Nothing here reaches the network: every request goes through the client's injectable transport,
 * and a spy on the global `fetch` is asserted untouched after every case. No case asserts or
 * triggers a startup probe either, because support for a slug is discovered at the first
 * submission rather than at boot (AAP §0.3.1). The "one retry, then `502` over HTTP" outcome
 * belongs to `server/test/adapters/conformance-retry.test.ts`; this suite stops at the client's own
 * result.
 */

import {
  ANALYSIS_BUDGET_MS,
  ERROR_CODES,
  ERROR_MESSAGES,
  ERROR_STATUS,
  MAX_TOKENS_EXTRACTION,
  type ErrorCode,
} from '@trade-read/shared';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  isAbortError,
  mapProviderFailure,
  mapProviderStatus,
  type ProviderFailureContext,
} from '../../src/adapters/openrouter/error-map.js';
import {
  OpenRouterClient,
  type ChatMessage,
  type OpenRouterTransport,
} from '../../src/adapters/openrouter/openrouter-client.js';
import { loadConfig } from '../../src/config/env.js';
import { AppError, isAppError } from '../../src/domain/errors.js';
import { extractionAnswerSchema } from '../../src/domain/schemas.js';
import { createLogger } from '../../src/observability/logger.js';
import { recordedAnswerLine, recordedExtraction } from '../helpers/recorded.js';

/**
 * The only credential literal in this file. It is obviously fake and deliberately not shaped like
 * a gateway key, so no scanner finds a real one here and the redaction assertions below still have
 * a distinctive value to look for.
 */
const FAKE_API_KEY = 'test-fake-key-not-a-secret';

/** The analysis id every logged line of this suite should be tied to. */
const STUB_ANALYSIS_ID = 'test-analysis';

/** The completion-token figure the stubbed envelopes report, so cost provenance is checkable. */
const STUB_COMPLETION_TOKENS = 7;

/** The resolved configuration the subject runs under; the slug is the configured one, not a literal. */
const config = loadConfig({
  OPENROUTER_API_KEY: FAKE_API_KEY,
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
});

/** One row of the provider status table: the status the provider answered with and the code it maps to. */
interface StatusCase {
  readonly status: number;
  readonly code: ErrorCode;
}

/**
 * Every provider status that has a row of its own (§0.6.3). The expected HTTP status is
 * `ERROR_STATUS[code]` and the expected sentence is `ERROR_MESSAGES[code]`, so neither appears here.
 */
const STATUS_CASES: readonly StatusCase[] = [
  { status: 401, code: 'PROVIDER_NOT_CONFIGURED' },
  { status: 403, code: 'PROVIDER_NOT_CONFIGURED' },
  { status: 402, code: 'PROVIDER_QUOTA_EXCEEDED' },
  { status: 404, code: 'PROVIDER_MODEL_UNSUPPORTED' },
  { status: 408, code: 'ANALYSIS_TIMEOUT' },
  { status: 429, code: 'ANALYSIS_TIMEOUT' },
  { status: 400, code: 'ANALYSIS_FAILED' },
  { status: 422, code: 'ANALYSIS_FAILED' },
  { status: 500, code: 'ANALYSIS_FAILED' },
  { status: 503, code: 'ANALYSIS_FAILED' },
];

/** One row of the abort-detection table: a thrown value and whether it counts as a cancellation. */
interface AbortCase {
  readonly label: string;
  readonly value: unknown;
  readonly aborted: boolean;
}

/** The values `isAbortError` is asked about, including the ones it must refuse. */
const ABORT_CASES: readonly AbortCase[] = [
  {
    label: 'a DOMException named AbortError',
    value: new DOMException('aborted', 'AbortError'),
    aborted: true,
  },
  { label: 'an Error named AbortError', value: namedError('AbortError'), aborted: true },
  // The shared budget aborts under this name, so a spent deadline must not read as a plain failure.
  { label: 'an Error named TimeoutError', value: namedError('TimeoutError'), aborted: true },
  { label: 'an ordinary Error', value: new Error('boom'), aborted: false },
  { label: 'null', value: null, aborted: false },
  { label: 'undefined', value: undefined, aborted: false },
  { label: 'a plain object', value: {}, aborted: false },
  { label: 'the string "AbortError"', value: 'AbortError', aborted: false },
];

/** The instruction message of a call; prompt content is not this suite's subject. */
const INSTRUCTION_MESSAGE: ChatMessage = {
  role: 'system',
  content: [{ type: 'text', text: 'Instruction text for this call.' }],
};

/** Every log line the client under test emitted in the current case. */
const logLines: string[] = [];

/** The global `fetch` spy armed for the current case. */
let fetchSpy: MockInstance<typeof globalThis.fetch>;

beforeEach(() => {
  logLines.length = 0;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error(
      'this suite must not reach the network; every request goes through the transport seam',
    );
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

/** An error carrying a chosen `name`, which is how an abort and a spent deadline are recognised. */
function namedError(name: string): Error {
  const error = new Error(`thrown as ${name}`);
  error.name = name;
  return error;
}

/** The context every mapping call receives: the configured slug, and never the credential. */
function context(): ProviderFailureContext {
  return { model: config.model };
}

/** The logger the client under test writes through, capturing one line per event. */
function capturingLogger() {
  return createLogger({
    write: (line: string): void => {
      logLines.push(line);
    },
  });
}

/** A `200` chat-completions envelope carrying `content` as the answer text. */
function responseEnvelope(content: string, finishReason = 'stop'): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content }, finish_reason: finishReason }],
      usage: { completion_tokens: STUB_COMPLETION_TOKENS },
    }),
  } as unknown as Response;
}

/** A non-2xx provider response carrying the diagnostic text the client reads for the log. */
function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message: `status ${status}` } }),
    text: async () => `status ${status}`,
  } as unknown as Response;
}

/** A `200` response whose body cannot be read as JSON at all. */
function unparseableEnvelope(): Response {
  return {
    ok: true,
    status: 200,
    json: async (): Promise<unknown> => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;
}

/** A transport substitute that replays one scripted answer per call and counts the calls. */
interface StubbedTransport {
  readonly transport: OpenRouterTransport;
  readonly calls: () => number;
}

/**
 * Builds a transport that answers each call with the next scripted entry: a `Response` is
 * returned, an `Error` is thrown. A call past the end of the script fails loudly rather than
 * silently reusing an answer, so an extra attempt is visible in the case that provoked it.
 */
function stubTransport(...answers: ReadonlyArray<Response | Error>): StubbedTransport {
  let calls = 0;

  return {
    transport: async (): Promise<Response> => {
      const answer = answers[calls];
      calls += 1;

      if (answer === undefined) {
        throw new Error(
          `the transport was called ${calls} times, but this case scripted ${answers.length} answers`,
        );
      }

      if (answer instanceof Error) {
        throw answer;
      }

      return answer;
    },
    calls: () => calls,
  };
}

/** The client under test, over a scripted transport and the capturing logger. */
function clientOver(stub: StubbedTransport): OpenRouterClient {
  return new OpenRouterClient({
    apiKey: FAKE_API_KEY,
    baseUrl: config.openRouterBaseUrl,
    model: config.model,
    logger: capturingLogger(),
    fetch: stub.transport,
  });
}

/** One extraction call under the configured ceiling, with the shared budget still unspent. */
function extractionRequest() {
  return {
    messages: [INSTRUCTION_MESSAGE],
    maxTokens: MAX_TOKENS_EXTRACTION,
    schema: extractionAnswerSchema,
    role: 'extraction',
    remainingMs: ANALYSIS_BUDGET_MS,
    analysisId: STUB_ANALYSIS_ID,
  } as const;
}

/** Awaits a call that must fail and returns the `AppError` it rejected with. */
async function rejectionOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) {
      throw new Error(`expected an AppError rejection, received ${String(error)}`);
    }

    return error;
  }

  throw new Error('expected the call to reject, but it resolved');
}

/**
 * Asserts that `value` is an `AppError` of `code`, carrying the status the shared table gives that
 * code, and returns it so a case can go on to assert the message.
 */
function expectAppError(value: unknown, code: ErrorCode): AppError {
  expect(isAppError(value)).toBe(true);

  const error = value as AppError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(ERROR_STATUS[code]);

  return error;
}

describe('provider status to application code (§0.6.3)', () => {
  it.each(STATUS_CASES)('maps provider status $status to $code', ({ status, code }) => {
    const error = expectAppError(mapProviderStatus(status, context()), code);

    // A code that is not in the table would be a second vocabulary, so membership is asserted too.
    expect(ERROR_CODES).toContain(error.code);

    if (code === 'PROVIDER_MODEL_UNSUPPORTED') {
      // Observed factory shape: `AppError.providerModelUnsupported(slug)` keeps the shared sentence
      // as the prefix and appends ` Model: "<slug>".`, so provenance is containment here.
      expect(error.message.startsWith(ERROR_MESSAGES[code])).toBe(true);
      expect(error.message).toContain(config.model);
      expect(error.message).not.toContain(FAKE_API_KEY);
      return;
    }

    expect(error.message).toBe(ERROR_MESSAGES[code]);
  });

  it('keeps a provider body out of the message it returns', () => {
    const error = mapProviderStatus(500, {
      model: config.model,
      providerMessage: 'upstream exploded\nwhile reading the image',
    });

    // §0.4.5: the provider's own text is a log diagnostic, never a response body.
    expect(error.message).toBe(ERROR_MESSAGES.ANALYSIS_FAILED);
    expect(error.message).not.toContain('upstream exploded');
  });
});

describe('thrown failure to application code (§0.6.3, D11)', () => {
  it('maps a cancelled request to ANALYSIS_TIMEOUT', () => {
    const error = mapProviderFailure(
      new DOMException('The operation was aborted.', 'AbortError'),
      context(),
    );

    expect(error.code).toBe('ANALYSIS_TIMEOUT');
    expect(error.message).toBe(ERROR_MESSAGES.ANALYSIS_TIMEOUT);
  });

  it('maps an Error named AbortError to ANALYSIS_TIMEOUT', () => {
    expect(mapProviderFailure(namedError('AbortError'), context()).code).toBe('ANALYSIS_TIMEOUT');
  });

  it('maps a spent deadline to ANALYSIS_TIMEOUT rather than a generic failure', () => {
    // The budget aborts a request under this name, so recognising only AbortError would lose the
    // timeout the request defines for it (D11).
    expect(mapProviderFailure(namedError('TimeoutError'), context()).code).toBe('ANALYSIS_TIMEOUT');
  });

  it('maps a failed connection to ANALYSIS_FAILED', () => {
    const error = mapProviderFailure(new TypeError('fetch failed'), context());

    expect(error.code).toBe('ANALYSIS_FAILED');
    expect(error.status).toBe(ERROR_STATUS.ANALYSIS_FAILED);
    expect(error.message).toBe(ERROR_MESSAGES.ANALYSIS_FAILED);
  });

  it('returns an already mapped failure by identity instead of re-wrapping it', () => {
    const timeout = AppError.analysisTimeout();
    const quota = AppError.providerQuotaExceeded();

    // Re-wrapping would flatten a specific code into ANALYSIS_FAILED, which is why D4 keeps one
    // mapping owner and this branch returns the instance it was given.
    expect(mapProviderFailure(timeout, context())).toBe(timeout);
    expect(mapProviderFailure(quota, context())).toBe(quota);
  });
});

describe('abort detection (D11)', () => {
  it.each(ABORT_CASES)('isAbortError on $label is $aborted', ({ value, aborted }) => {
    expect(isAbortError(value)).toBe(aborted);
  });
});

describe('retry policy across the transport seam (D11)', () => {
  it.each(STATUS_CASES)(
    'spends one attempt on provider status $status ($code)',
    async ({ status, code }) => {
      const stub = stubTransport(errorResponse(status));
      const error = await rejectionOf(clientOver(stub).complete(extractionRequest()));

      expect(error.code).toBe(code);
      expect(error.status).toBe(ERROR_STATUS[code]);
      expect(stub.calls()).toBe(1);
    },
  );

  it('spends one attempt on a network failure', async () => {
    const stub = stubTransport(new TypeError('fetch failed'));
    const error = await rejectionOf(clientOver(stub).complete(extractionRequest()));

    expect(error.code).toBe('ANALYSIS_FAILED');
    expect(stub.calls()).toBe(1);
  });

  it('spends one attempt on a success status whose body is not JSON', async () => {
    const stub = stubTransport(unparseableEnvelope());
    const error = await rejectionOf(clientOver(stub).complete(extractionRequest()));

    // An unreadable envelope is not a malformed answer, so it is terminal on the first attempt.
    expect(error.code).toBe('ANALYSIS_FAILED');
    expect(stub.calls()).toBe(1);
  });

  it('retries a conformance failure exactly once and then fails the analysis', async () => {
    const stub = stubTransport(
      responseEnvelope('not json at all'),
      responseEnvelope('not json at all'),
    );
    const error = await rejectionOf(clientOver(stub).complete(extractionRequest()));

    expect(error.code).toBe('ANALYSIS_FAILED');
    expect(error.status).toBe(ERROR_STATUS.ANALYSIS_FAILED);
    expect(stub.calls()).toBe(2);
  });

  it('accepts an answer that comes back conforming on the retry', async () => {
    const recordedLine = recordedAnswerLine(recordedExtraction('footprint-es-5m'));
    const stub = stubTransport(responseEnvelope('not json at all'), responseEnvelope(recordedLine));

    const answer = await clientOver(stub).complete(extractionRequest());

    // The recorded answer is the retry's own answer, judged by the same schema the call supplied.
    const expected = extractionAnswerSchema.parse(JSON.parse(recordedLine) as unknown);

    expect(stub.calls()).toBe(2);
    expect(answer.value).toEqual(expected);
    expect(answer.callCount).toBe(2);
    expect(answer.completionTokens).toBe(STUB_COMPLETION_TOKENS);
  });

  it('records no credential, no authorization header and no image payload in any log line', async () => {
    const stub = stubTransport(
      errorResponse(402),
      responseEnvelope('not json at all'),
      responseEnvelope('not json at all'),
    );
    const client = clientOver(stub);

    // One mapped provider failure and one conformance failure, so both log paths run.
    expect((await rejectionOf(client.complete(extractionRequest()))).code).toBe(
      'PROVIDER_QUOTA_EXCEEDED',
    );
    expect((await rejectionOf(client.complete(extractionRequest()))).code).toBe('ANALYSIS_FAILED');

    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.some((line) => line.includes(STUB_ANALYSIS_ID))).toBe(true);

    for (const line of logLines) {
      // §0.4.5: neither the credential, nor the header that carries it, nor image bytes (a data
      // URI or its bare base64) may reach a line.
      expect(line).not.toContain(FAKE_API_KEY);
      expect(line.toLowerCase()).not.toContain('authorization');
      expect(line).not.toContain('data:image');
    }
  });
});

