/**
 * Suite for the health report, and the HTTP-layer evidence for three requirements.
 *
 * - AAP §0.6.1, the health row: `GET ${API_BASE_PATH}/health` answers `200` with `status`,
 *   `providerConfigured` and `model`, and never fails while the process is up.
 * - AAP §0.6.3, the provider-not-configured row: the server starts with no credential, health reports
 *   `providerConfigured: false`, and the credential stays out of the body.
 * - AAP §0.6.6 criterion 7 — "runs without a key" — at the highest layer the build can observe it.
 *
 * It honours D1 (the API is unauthenticated: no request here carries an `Authorization` header), D4
 * (the path, the error table and the response type come from `@trade-read/shared`, so no path
 * segment, status, code or slug is restated in this file) and §0.4.5 (no credential, credential
 * shape or base64 payload appears here, in a fixture or in an assertion).
 *
 * Every case drives the composed application `buildTestApp` returns rather than a router assembled
 * for the test, so the mount point, the body cap, the origin allowlist and the error handler are all
 * in the path being exercised. Nothing here reaches the network: the helper selects the replay
 * provider and leaves the credential unset unless a case configures one through `buildTestApp`.
 */
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import {
  API_BASE_PATH,
  ERROR_CODES,
  ERROR_MESSAGES,
  ERROR_STATUS,
  type HealthResponse,
} from '@trade-read/shared';

import {
  buildTestApp,
  type BuildTestAppOptions,
  type TestApp,
} from '../helpers/build-test-app.js';

/** The health path, composed from the shared mount point so no path segment is restated here (D4). */
const HEALTH_PATH = `${API_BASE_PATH}/health`;

/**
 * The one status this suite names: the health row's success.
 *
 * The shared error table holds failure statuses alone and so has none for it, which is why the
 * number is declared once here instead of appearing at each assertion.
 */
const HEALTH_SUCCESS_STATUS = 200;

/**
 * The credential of the configured case.
 *
 * It is a placeholder rather than a key: it carries no provider credential format, so this file
 * holds nothing a leak scan would match and nothing that could reach a provider if it were ever sent
 * (§0.4.5).
 */
const PLACEHOLDER_CREDENTIAL = 'place-holder-not-a-real-credential';

/**
 * The slug of the echo case — a slug, never a vendor hostname, so this file names no provider.
 *
 * The default slug is owned by `server/src/config/env.ts` and is deliberately not restated here: the
 * default case compares the body against the resolved configuration instead.
 */
const NEUTRAL_MODEL_SLUG = 'fixture/vision-test-model';

/**
 * The keys a health body carries, in the order `Object.keys(body).sort()` yields them.
 *
 * Key names only, so this is the contract's field set rather than a restatement of any value the
 * server decides; a field added to the body fails here instead of passing unnoticed.
 */
const HEALTH_BODY_KEYS = ['model', 'providerConfigured', 'status'] as const;

/** The app the current case built, released once the case ends. */
let testApp: TestApp | null = null;

afterEach(async (): Promise<void> => {
  const built = testApp;
  testApp = null;
  await built?.cleanup();
});

/**
 * Builds a fresh application for the calling case, over the temporary data directory the helper
 * creates and removes for it.
 *
 * Only configuration overrides are passed, and only in the helper's own terms: `buildTestApp` owns
 * the data directory, selects the replay provider and clears the credential of the default case, so
 * no case here reads or writes `process.env` and no case can reach the network.
 *
 * @param config - Environment-variable-keyed overrides, or omitted for the default offline
 *   configuration.
 * @returns The built app, its resolved configuration and its provider capture.
 */
async function buildApp(config?: BuildTestAppOptions['config']): Promise<TestApp> {
  const built = await buildTestApp(config === undefined ? {} : { config });

  testApp = built;

  return built;
}

/**
 * The replay provider of an app this suite built.
 *
 * `buildTestApp` always builds one unless the caller supplies its own provider, so a null capture
 * surface means this suite's own precondition broke rather than a state a case expects. It is
 * reported as a failure here rather than silenced with a non-null assertion.
 *
 * @param app - An app returned by {@link buildApp}.
 * @returns The provider whose `calls` list records every request issued.
 */
function replayProviderOf(app: TestApp): NonNullable<TestApp['stub']> {
  const provider = app.stub;

  if (provider === null) {
    throw new Error(
      'The offline app is built with the replay provider, so it must expose its captured calls.',
    );
  }

  return provider;
}

describe('the health route reports configuration', () => {
  it('answers 200 with status ok and providerConfigured false when no credential is configured', async () => {
    const app = await buildApp();

    const response = await request(app.app).get(HEALTH_PATH);
    const body: HealthResponse = response.body;

    expect(response.status).toBe(HEALTH_SUCCESS_STATUS);
    expect(app.config.providerConfigured).toBe(false);
    expect(body.status).toBe('ok');
    expect(body.providerConfigured).toBe(false);
  });

  it('reports the resolved model slug rather than one of its own', async () => {
    const app = await buildApp();

    const response = await request(app.app).get(HEALTH_PATH);
    const body: HealthResponse = response.body;

    // The slug is compared to the resolved configuration, so the default this build documents is
    // stated once, in `server/src/config/env.ts`, and never again here.
    expect(body.model).toBe(app.config.model);
  });

  it('answers exactly the status, providerConfigured and model keys', async () => {
    const app = await buildApp();

    const response = await request(app.app).get(HEALTH_PATH);
    const body: HealthResponse = response.body;

    expect(Object.keys(body).sort()).toEqual([...HEALTH_BODY_KEYS]);
  });

  it('answers as JSON', async () => {
    const app = await buildApp();

    const response = await request(app.app).get(HEALTH_PATH);
    const contentType = response.headers['content-type'] ?? '';

    expect(contentType.startsWith('application/json')).toBe(true);
  });

  it('reports providerConfigured true when a credential is configured', async () => {
    const app = await buildApp({ OPENROUTER_API_KEY: PLACEHOLDER_CREDENTIAL });

    const response = await request(app.app).get(HEALTH_PATH);
    const body: HealthResponse = response.body;

    // The boolean is derived from configuration rather than set independently: the resolved value is
    // what the case configured, and the body only reports its presence.
    expect(app.config.openRouterApiKey).toBe(PLACEHOLDER_CREDENTIAL);
    expect(app.config.providerConfigured).toBe(true);
    expect(body.providerConfigured).toBe(true);
  });

  it('keeps the configured credential out of the health body', async () => {
    const app = await buildApp({ OPENROUTER_API_KEY: PLACEHOLDER_CREDENTIAL });
    const configuredCredential = app.config.openRouterApiKey;

    if (configuredCredential === null) {
      throw new Error('The configured case sets a credential, so the resolved configuration holds one.');
    }

    const response = await request(app.app).get(HEALTH_PATH);

    // The configured value and the placeholder are the same string, so one assertion covers both:
    // neither the raw text nor the parsed body carries the credential (§0.4.5).
    expect(configuredCredential).toBe(PLACEHOLDER_CREDENTIAL);
    expect(response.text).not.toContain(configuredCredential);
    expect(JSON.stringify(response.body)).not.toContain(configuredCredential);
  });

  it('echoes a configured slug unchanged', async () => {
    const app = await buildApp({ OPENROUTER_MODEL: NEUTRAL_MODEL_SLUG });

    const response = await request(app.app).get(HEALTH_PATH);
    const body: HealthResponse = response.body;

    expect(app.config.model).toBe(NEUTRAL_MODEL_SLUG);
    expect(body.model).toBe(app.config.model);
  });

  it('answers every call without issuing a provider request', async () => {
    const app = await buildApp();
    const provider = replayProviderOf(app);

    expect(provider.calls).toHaveLength(0);

    const first = await request(app.app).get(HEALTH_PATH);
    const second = await request(app.app).get(HEALTH_PATH);

    // Health reports configuration only (AAP §0.6.3): it holds no port call, so the endpoint cannot
    // fail while the process is up (AAP §0.6.1) and a key-less run is still a green run.
    expect([first.status, second.status]).toEqual([HEALTH_SUCCESS_STATUS, HEALTH_SUCCESS_STATUS]);
    expect(provider.calls).toHaveLength(0);
  });

  it('answers without an Authorization header', async () => {
    const app = await buildApp();

    // No authentication exists (D1), so this request carries no credential of any kind and is
    // answered on the same terms as any other.
    const response = await request(app.app).get(HEALTH_PATH).unset('authorization');

    expect(response.status).toBe(HEALTH_SUCCESS_STATUS);
  });

  it('answers a status no error-table row uses, carrying no error sentence', async () => {
    const app = await buildApp();

    const response = await request(app.app).get(HEALTH_PATH);
    const failureStatuses: number[] = ERROR_CODES.map((code) => ERROR_STATUS[code]);

    expect(failureStatuses).not.toContain(response.status);

    for (const message of Object.values(ERROR_MESSAGES)) {
      expect(response.text).not.toContain(message);
    }
  });
});
