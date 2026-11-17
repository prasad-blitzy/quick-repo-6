/**
 * The startup suite: the server comes up with no model credential.
 *
 * AAP §0.6.6 criterion 7 is the claim under test — the process starts, `GET /api/v1/health` reports
 * `providerConfigured: false`, and a submission is answered `503 PROVIDER_NOT_CONFIGURED` having
 * persisted nothing. Three further obligations are asserted here rather than assumed: no provider
 * call is attempted at all (AAP §0.4.1), the credential appears in no log line and no response body
 * (AAP §0.4.5), and the listener binds loopback (AAP D1). Configuration is pinned through
 * `loadConfig`'s override seam and this file never reads `process.env` itself (AAP D3); every
 * status, sentence, path and type comes from the shared contract instead of being restated
 * (AAP D4); and nothing here touches or times the analysis budget (AAP D11).
 *
 * The suite drives the real listening socket with the runtime's `fetch`. `supertest(app)` would
 * bypass the listener, and a server that actually binds is precisely what is being proved. It runs
 * with no credential and no network — the configured provider base is a dead loopback address, so
 * any accidental egress fails in milliseconds instead of reaching the gateway — and it proves that
 * no call was attempted by the absence of any log line carrying a call role, the one field only a
 * provider call sets.
 */

import { readdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  API_BASE_PATH,
  ERROR_CODES,
  ERROR_MESSAGES,
  ERROR_STATUS,
  type ApiErrorBody,
  type ErrorCode,
  type HealthResponse,
} from '@trade-read/shared';

import { loadConfig } from '../../src/config/env';
import { bootstrap, type BootstrappedServer } from '../../src/index';
import type { LogEvent } from '../../src/observability/logger';
import { createTempDataDir, type TempDataDir } from '../helpers/temp-data-dir';

// The three documented defaults this suite pins, recorded once here from AAP §0.9.1, which is the
// table of configuration defaults. They are asserted only against the configuration contract and the
// line the server logs — no socket is bound on the default port, so a development server running on
// it cannot collide with this suite.

/** `HOST` default: the loopback address the unauthenticated API binds unless a deployment sets one. */
const DEFAULT_HOST = '127.0.0.1';

/** `PORT` default; read from configuration only, never bound here. */
const DEFAULT_PORT = 3001;

/** `OPENROUTER_MODEL` default: the one vision-capable slug both calls use. */
const DEFAULT_MODEL = 'google/gemini-2.5-flash';

/**
 * The code a submission is answered with while no credential is configured, typed against the
 * shared union so a rename in the contract breaks this file instead of silently changing its
 * meaning.
 */
const PROVIDER_NOT_CONFIGURED: ErrorCode = 'PROVIDER_NOT_CONFIGURED';

/**
 * A provider base on a closed loopback port.
 *
 * The real adapter is constructed by this suite and must never be reached, so the base it would
 * call is pointed at a port nothing listens on: a call that escaped the credential check would fail
 * locally in milliseconds rather than travel to the gateway, which is what makes "this suite passes
 * with the network unavailable" structural rather than a hope.
 */
const UNREACHABLE_PROVIDER_BASE_URL = 'http://127.0.0.1:1/api/v1';

/**
 * A verified 1x1 PNG, submitted so the upload passes every bound and the request reaches the
 * provider-configuration failure instead of a validation rejection.
 *
 * The decoded buffer is 70 bytes: the eight-byte PNG signature, then the `IHDR` chunk whose length
 * at offset 8 is 13 and whose type at offset 12 is `IHDR`, with width at offset 16 and height at
 * offset 20 — the exact fields `server/src/domain/image-probe.ts` reads. An inline image keeps this
 * suite free of a fixture file, so success criterion 7 is provable on a clean checkout with no
 * browser and no generator run.
 */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The decoded bytes of {@link PNG_1X1_BASE64}. */
const PNG_BYTES = Buffer.from(PNG_1X1_BASE64, 'base64');

/**
 * The gateway's credential prefix, assembled from parts so this file carries no credential shape of
 * its own for a secret scanner to find. It is a shape detector for the log-secrecy assertions, never
 * a value: nothing in this suite sets, reads or infers a real key.
 */
const CREDENTIAL_SHAPE = new RegExp(['sk', 'or', ''].join('-'), 'i');

/**
 * Field names that would betray a credential or an auth header inside a captured log line. Their
 * absence, together with the shape detector above, is the whole of AAP §0.4.5's log half.
 */
const CREDENTIAL_FIELD_WORDS = ['apikey', 'api_key', 'authorization', 'bearer', 'credential'] as const;

/** One captured stdout line, as the logger serialised it: its fields plus the two it always prepends. */
type CapturedLine = Partial<LogEvent> & { ts?: string; level?: string };

// Module-scope state, because the server and its temporary store outlive a single test: one process
// start is the evidence for every assertion below, and the hooks own its whole lifetime.

/** The bootstrapped server, absent only when the start hook itself failed. */
let server: BootstrappedServer | undefined;

/** The isolated data directory this process was pointed at, absent only when its creation failed. */
let tempDir: TempDataDir | undefined;

/** Base URL of the bound loopback socket, built from the address the listener reported. */
let baseUrl = '';

/** The port the operating system assigned, read back from the listener rather than from configuration. */
let boundPort = 0;

/** Every JSON line the process wrote to stdout while the hook and tests ran. */
const captured: CapturedLine[] = [];

/** Restores the stdout spy; kept so teardown can undo the capture even after a failed start. */
let restoreStdout: (() => void) | undefined;

/**
 * Returns the bootstrapped server, or fails the calling test.
 *
 * A missing value means `beforeAll` never produced one, and every assertion below would then be
 * meaningless rather than merely wrong, so the test is failed with what actually went missing.
 */
function requireServer(): BootstrappedServer {
  if (server === undefined) {
    throw new Error('beforeAll produced no bootstrapped server, so no assertion in this suite applies.');
  }

  return server;
}

/** Returns the temporary data directory, or fails the calling test for the same reason. */
function requireTempDir(): TempDataDir {
  if (tempDir === undefined) {
    throw new Error('beforeAll produced no temporary data directory, so no assertion in this suite applies.');
  }

  return tempDir;
}

/**
 * Narrows the listening socket's address to the object form.
 *
 * `Server.address()` is a string for a pipe, the object form for an IP socket and `null` before the
 * bind settles; only the object form can occur for a TCP port, so anything else is reported rather
 * than cast away.
 *
 * @param target - The server whose address is being read.
 * @returns The bound `AddressInfo`.
 */
function listeningAddress(target: BootstrappedServer): AddressInfo {
  const address = target.httpServer.address();

  if (typeof address !== 'object' || address === null) {
    throw new Error(
      `Expected the listener to report an AddressInfo object for its TCP port, received ${String(address)}.`,
    );
  }

  return address;
}

/**
 * Records the JSON log lines in one stdout chunk.
 *
 * A chunk may carry several lines, a partial line, or text from the test reporter; only the lines
 * that parse as a JSON object are kept, and a parse failure is skipped rather than failing the
 * suite, because a reporter line is not evidence about the server.
 *
 * @param chunk - What the intercepted write was given: a string or a byte view of one.
 */
function recordChunk(chunk: string | Uint8Array): void {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');

  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed.startsWith('{')) {
      continue;
    }

    try {
      captured.push(JSON.parse(trimmed) as CapturedLine);
    } catch {
      // Not a log line: a reporter line, or half of a line split across two writes. Both are
      // ignored, because neither carries a field this suite asserts on.
    }
  }
}

/**
 * Intercepts the process's stdout, which is the sink `createLogger()` writes to by default.
 *
 * Every write is recorded and then passed to the original bound function, so the test runner's own
 * output below it keeps working while the server's lines are also captured.
 *
 * @returns A function that restores the original writer.
 */
function captureStdout(): () => void {
  const originalWrite = process.stdout.write.bind(process.stdout) as (
    chunk: unknown,
    ...rest: unknown[]
  ) => boolean;

  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      recordChunk(chunk);

      return originalWrite(chunk, ...rest);
    });

  return () => {
    spy.mockRestore();
  };
}

/**
 * The captured lines for one event name.
 *
 * @param event - The `event` field to match.
 * @returns The matching lines, in the order they were written.
 */
function logLines(event: string): CapturedLine[] {
  return captured.filter((line) => line.event === event);
}

/**
 * Issues one HTTP request against the bound socket.
 *
 * `connection: close` asks for a non-reused socket; it is set here rather than at each call site so
 * a later test cannot forget it and leave a keep-alive socket that makes teardown wait.
 *
 * @param path - Path below the base URL, which already carries the API base path.
 * @param init - Any further request options, such as a method and a body.
 * @returns The response, its body unread.
 */
function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { connection: 'close', ...(init?.headers ?? {}) },
  });
}

/**
 * The analysis directories currently on disk, if the store ever created one.
 *
 * A refused submission writes nothing at all, so the top-level directory may not exist; that absence
 * is the empty result this suite asserts on. Any other filesystem failure is rethrown rather than
 * reported as an empty store.
 *
 * @param dataDir - The data directory the process was pointed at.
 * @returns The entry names found, or an empty array when nothing was written.
 */
async function storedAnalyses(dataDir: string): Promise<string[]> {
  try {
    return await readdir(join(dataDir, 'analyses'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}


describe('bootstrap without a model credential', () => {
  beforeAll(async () => {
    tempDir = await createTempDataDir('startup-bootstrap-');
    restoreStdout = captureStdout();

    // Every one of the nine variables is pinned. `undefined` is the file's documented way of saying
    // "treat this variable as unset", so the caller's shell cannot leak a credential in, and the
    // replay provider the test configuration selects is switched off: the real adapter must be the
    // one constructed, and it must never be called.
    server = await bootstrap({
      OPENROUTER_API_KEY: undefined,
      OPENROUTER_MODEL: undefined,
      OPENROUTER_BASE_URL: UNREACHABLE_PROVIDER_BASE_URL,
      OPENROUTER_REFERER: undefined,
      OPENROUTER_APP_TITLE: undefined,
      DATA_DIR: tempDir.dataDir,
      PORT: '0',
      HOST: undefined,
      STUB_PROVIDER: undefined,
    });

    boundPort = listeningAddress(server).port;
    baseUrl = `http://${DEFAULT_HOST}:${boundPort}`;
  });

  afterAll(async () => {
    // The capture is restored first, so a failure while closing the listener is reported by the
    // runner rather than captured and swallowed.
    restoreStdout?.();
    restoreStdout = undefined;

    if (server !== undefined) {
      const httpServer = server.httpServer;

      // Idle keep-alive sockets would otherwise hold the listener open; closing them first makes
      // the close settle immediately instead of waiting for a timeout.
      httpServer.closeIdleConnections?.();

      if (httpServer.listening) {
        await new Promise<void>((resolveClose, rejectClose) => {
          httpServer.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
        });
      }

      // The listener is the one resource a failed suite could leak into the rest of the run.
      expect(httpServer.listening).toBe(false);
    }

    if (tempDir !== undefined) {
      await tempDir.cleanup();
      tempDir = undefined;
    }
  });

  it('starts with no credential, selects the real adapter and binds loopback on an ephemeral port', () => {
    const started = requireServer();
    const directory = requireTempDir();

    // The start itself is the deliverable: no credential, and the production adapter rather than
    // the replay one, which was constructed and never called.
    expect(started.config.providerConfigured).toBe(false);
    expect(started.config.stubProvider).toBe(false);

    // The configuration contract: the loopback default applied because HOST was unset, and the
    // ephemeral port this suite asked for rather than the documented default.
    expect(started.config.host).toBe(DEFAULT_HOST);
    expect(started.config.port).toBe(0);
    expect(resolve(started.config.dataDir)).toBe(resolve(directory.dataDir));

    expect(started.app).toBeDefined();
    expect(started.httpServer.listening).toBe(true);

    const address = listeningAddress(started);

    expect(address.address).toBe(DEFAULT_HOST);
    expect(address.family).toBe('IPv4');
    expect(Number.isInteger(address.port)).toBe(true);
    expect(address.port).toBeGreaterThan(0);
    expect(address.port).toBe(boundPort);
  });

  it('reports the documented host, port and model defaults when every variable is unset', () => {
    // Configuration is read, never applied: asserting the defaults through `loadConfig` keeps this
    // case off the network and off the documented port, so a development server already listening
    // on it cannot collide with this suite.
    const config = loadConfig({
      OPENROUTER_API_KEY: undefined,
      OPENROUTER_MODEL: undefined,
      OPENROUTER_BASE_URL: undefined,
      OPENROUTER_REFERER: undefined,
      OPENROUTER_APP_TITLE: undefined,
      DATA_DIR: undefined,
      PORT: undefined,
      HOST: undefined,
      STUB_PROVIDER: undefined,
    });

    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.model).toBe(DEFAULT_MODEL);
    expect(config.stubProvider).toBe(false);
    expect(config.providerConfigured).toBe(false);

    // The default store is anchored to the repository rather than to the working directory, so it is
    // always an absolute path.
    expect(isAbsolute(config.dataDir)).toBe(true);
  });

  it('logs exactly one server_started line with the bound address, the model and providerConfigured false', () => {
    const started = requireServer();
    const startedLines = logLines('server_started');

    expect(startedLines).toHaveLength(1);

    const line = startedLines[0];

    if (line === undefined) {
      throw new Error('The single server_started line could not be read back from the captured output.');
    }

    expect(line.host).toBe(DEFAULT_HOST);
    expect(line.providerConfigured).toBe(false);

    // Both directions: the line reports the configuration this process resolved, and that
    // configuration is the documented default, so neither a hard-coded expectation nor a
    // configuration-drifted one can pass unnoticed.
    expect(line.model).toBe(started.config.model);
    expect(started.config.model).toBe(DEFAULT_MODEL);

    // The line may report either the configured port or the one the operating system granted, and
    // both are bounded by what was asked for and what was bound.
    expect(typeof line.port).toBe('number');
    expect(line.port).toBeGreaterThanOrEqual(started.config.port);
    expect(line.port).toBeLessThanOrEqual(boundPort);
  });

  it('answers GET /api/v1/health with the documented body', async () => {
    const started = requireServer();
    const response = await request(`${API_BASE_PATH}/health`);

    expect(response.status).toBe(200);

    // The text is inspected before it is parsed, so a field outside the contract — a leaked key, for
    // one — is caught even if it sits somewhere the body type does not describe.
    const text = await response.text();

    expect(text).not.toMatch(CREDENTIAL_SHAPE);
    expect(text.toLowerCase()).not.toContain('apikey');

    const body = JSON.parse(text) as HealthResponse;

    // The whole body, because an extra field is a contract break even when every expected one
    // matches.
    expect(body).toEqual({
      status: 'ok',
      providerConfigured: false,
      model: started.config.model,
    });
    expect(body.model).toBe(DEFAULT_MODEL);
  });

  it('returns 503 PROVIDER_NOT_CONFIGURED for a submission, calls the provider not once and persists nothing', async () => {
    const directory = requireTempDir();

    // The code this case expects is one the closed table defines, so the expectation cannot outlive
    // the contract it belongs to.
    expect(ERROR_CODES).toContain(PROVIDER_NOT_CONFIGURED);

    // One inline 1x1 PNG, posted as multipart with no content type set by hand: `fetch` writes the
    // boundary, and the bytes themselves are what the server sniffs.
    const form = new FormData();
    form.append('images', new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' }), 'chart.png');

    const response = await request(`${API_BASE_PATH}/analyses`, { method: 'POST', body: form });

    expect(response.status).toBe(ERROR_STATUS.PROVIDER_NOT_CONFIGURED);

    const text = await response.text();
    const body = JSON.parse(text) as ApiErrorBody;

    expect(body.code).toBe(PROVIDER_NOT_CONFIGURED);
    expect(body.message).toBe(ERROR_MESSAGES.PROVIDER_NOT_CONFIGURED);

    // Exactly the shared error body: no stack, no cause, no extra field.
    expect(Object.keys(body).sort()).toEqual(['code', 'message']);

    // No filesystem path reaches a caller either.
    expect(text).not.toContain(resolve(directory.dataDir));

    // A log line carries a call role only when a provider call was made, so no such line is the
    // design-independent proof that the adapter refused before any request was built (AAP §0.4.1).
    // Which layer raised the 503 — the route's guard or the adapter itself — is deliberately not
    // asserted, because either is a conforming implementation.
    expect(captured.filter((line) => line.role !== undefined)).toEqual([]);

    // Nothing was persisted: the store creates its directories on the first write, so an absent
    // analysis directory and an empty one are the same answer.
    expect(await storedAnalyses(directory.dataDir)).toEqual([]);
  });

  it('keeps the credential out of every captured log line', () => {
    // Guards against a vacuous pass: the capture has to hold the line this process is known to write.
    expect(captured.length).toBeGreaterThan(0);
    expect(logLines('server_started')).toHaveLength(1);

    const serialised = JSON.stringify(captured);

    expect(serialised).not.toMatch(CREDENTIAL_SHAPE);

    const lowered = serialised.toLowerCase();

    for (const word of CREDENTIAL_FIELD_WORDS) {
      expect(lowered).not.toContain(word);
    }
  });
});
