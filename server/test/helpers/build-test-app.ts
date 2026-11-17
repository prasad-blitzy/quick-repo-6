/**
 * The one place a suite obtains an application to drive.
 *
 * Every Supertest suite asks this helper for its app rather than assembling one, so all of them
 * exercise the same object the product runs: `createApp` is the composition root of the server, and
 * calling it here — with the replay provider, the real filesystem store over a fresh temporary data
 * directory, and a logger whose lines a test can read — is what keeps a suite honest about the app
 * under test. Nothing is re-created beside it: no router is mounted, no service is built, no path is
 * joined and no instruction text is written here (D3, D4).
 *
 * Two properties matter more than the rest:
 *
 * - The app never listens. Supertest binds an ephemeral socket of its own, so a helper that called
 *   `listen` would leak a handle into every suite that used it.
 * - The helper never reads the environment. `loadConfig` is the single reader of the process
 *   environment, and the overrides this file hands it are the only way a suite's configuration is
 *   pinned. In stub mode the model credential is explicitly unset, so a developer's exported key can
 *   neither flip `providerConfigured` nor let a submission reach the network during the offline suite.
 *
 * The provider is chosen by the caller's options rather than by configuration: no `visionProvider`
 * means the replay adapter, and one supplied means the caller's own adapter, which is how the live
 * suite drives the real provider without this file ever knowing a credential exists.
 */
import type { Express } from 'express';

import {
  StubVisionProvider,
  type StubVisionProviderOptions,
} from '../../src/adapters/stub/stub-vision-provider.js';
import { createApp } from '../../src/app.js';
import { loadConfig, type ServerConfig } from '../../src/config/env.js';
import { createLogger, type CreateLoggerOptions } from '../../src/observability/logger.js';
import type { VisionProvider } from '../../src/ports/vision-provider.js';
import { FileSystemAnalysisRepository } from '../../src/store/file-system-analysis-repository.js';
import { createTempDataDir } from './temp-data-dir.js';

/**
 * One captured log line, typed from the logger's own writer rather than restated here.
 *
 * The seam's parameter is today a single serialised line with its trailing newline, but the type is
 * taken from `CreateLoggerOptions` so a change at the seam is felt here as a compile error instead
 * of as a captured value nothing parses.
 */
export type TestLogLine = Parameters<NonNullable<CreateLoggerOptions['write']>>[0];

/**
 * Everything a suite may vary about the application it builds.
 *
 * Every member is optional: with none supplied the helper builds the offline application the whole
 * server suite runs against — the replay provider, a fresh temporary data directory, no credential.
 */
export interface BuildTestAppOptions {
  /**
   * Overrides handed to `loadConfig`, which takes precedence over the process environment.
   *
   * An explicit `undefined` means "unset" — that is the documented seam, and it is how the default
   * stub-mode configuration clears the credential. A key left out of this object entirely falls
   * through to the environment, so a suite overrides only what its case is about.
   */
  config?: Partial<Record<string, string | undefined>>;

  /**
   * Forwarded unchanged to the replay provider, which is the only route to the states a provider
   * produces without a network: a different synthesis recording, an adversarial answer that earns
   * the single retry, a scripted status, or an abort that must arrive as `504 ANALYSIS_TIMEOUT`
   * immediately rather than after the 30 000 ms budget (D11).
   *
   * Ignored when {@link BuildTestAppOptions.visionProvider} is supplied, because no replay adapter
   * is then built.
   */
  stub?: Partial<StubVisionProviderOptions>;

  /**
   * The live suite's seam: a real provider replaces the replay adapter, and the credential and slug
   * are left to the ambient environment, which `loadConfig` reads.
   */
  visionProvider?: VisionProvider;

  /**
   * Reuse an existing data directory, as the restart case needs: a second app built over a directory
   * the first one wrote to must find its analyses.
   *
   * The caller owns a directory it supplies, so {@link TestApp.cleanup} leaves it in place; without
   * this option the helper creates a fresh directory outside the checkout and removes it on cleanup.
   */
  dataDir?: string;
}

/** One built application and the parts a suite needs to drive and observe it. */
export interface TestApp {
  /** The application itself, ready for Supertest and never listening. */
  app: Express;

  /** The configuration the application was composed with, as `loadConfig` resolved it. */
  config: ServerConfig;

  /**
   * The replay provider `createApp` received, so `stub.calls` and `stub.resetCalls()` are the
   * capture surface; `null` when the caller supplied its own provider.
   */
  stub: StubVisionProvider | null;

  /** The store the application writes through, over {@link TestApp.dataDir}. */
  repository: FileSystemAnalysisRepository;

  /** Absolute path of the data directory in use. */
  dataDir: string;

  /**
   * Every line the application has logged, in order, captured as the logger wrote it.
   *
   * The list is live: a line emitted during an assertion appears here, which is what lets a case
   * assert on what a request logged without reaching into the logger.
   */
  logLines: TestLogLine[];

  /** The captured lines as structured records, computed on every call rather than snapshotted. */
  logEvents(): Array<Record<string, unknown>>;

  /**
   * A second store instance over the same data directory with the same logger.
   *
   * It is the restart case in one call: a repository built after the app wrote a document must find
   * it, because persistence outlives the process that wrote it.
   */
  newRepository(): FileSystemAnalysisRepository;

  /**
   * Releases the temporary data directory. Safe to call any number of times, and a no-op for a
   * directory the caller supplied, whose lifetime the caller owns.
   */
  cleanup(): Promise<void>;
}

/**
 * The `STUB_PROVIDER` value that selects the replay adapter.
 *
 * `config/env.ts` treats exactly this one value as on, so the helper states it once here rather than
 * handing the adapter's selection to whatever the environment happens to hold.
 */
const STUB_PROVIDER_ENABLED = '1';

/** The data directory in use and the call that releases it, whether or not it is this helper's. */
interface DataDirLease {
  readonly dataDir: string;
  cleanup(): Promise<void>;
}

/** True for a plain object: the shape one parsed log line may take, and nothing else. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One serialised log line as the record it encodes, or `null` when it is not one JSON object. */
function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);

    return isJsonObject(parsed) ? parsed : null;
  } catch {
    // A line that is not JSON is still reported rather than dropped, and a log call must never make
    // a completed operation look like a failed one.
    return null;
  }
}

/**
 * One captured line as a record for assertion.
 *
 * The writer's parameter is taken as it is declared, so a seam that later hands over a structured
 * record keeps working here; a line that cannot be read as one object is returned under `raw` rather
 * than thrown away.
 */
function logEventOf(entry: TestLogLine): Record<string, unknown> {
  if (typeof entry !== 'string') {
    return isJsonObject(entry) ? entry : { raw: String(entry) };
  }

  return parseJsonObject(entry) ?? { raw: entry };
}

/**
 * Builds an application a suite can drive, with the parts it can also observe.
 *
 * @param options - What to vary about the configuration, the replay provider and the data directory.
 * @returns The built app together with its configuration, provider capture, store, log lines and
 *   cleanup.
 */
export async function buildTestApp(options: BuildTestAppOptions = {}): Promise<TestApp> {
  const dir: DataDirLease =
    options.dataDir === undefined
      ? await createTempDataDir()
      : { dataDir: options.dataDir, cleanup: async (): Promise<void> => undefined };

  const overrides: Partial<Record<string, string | undefined>> =
    options.visionProvider === undefined
      ? {
          DATA_DIR: dir.dataDir,
          STUB_PROVIDER: STUB_PROVIDER_ENABLED,
          // Last word on the credential for the offline suite: a key exported in the developer's
          // shell is treated as unset unless the case itself asks for it through `config`, so no
          // suite reaches the network and `providerConfigured` means what the case set it to.
          OPENROUTER_API_KEY: undefined,
          ...options.config,
        }
      : {
          // The live seam: only the store is pinned, so the credential, the base and the slug come
          // from the environment exactly as they would for an operator running the server.
          DATA_DIR: dir.dataDir,
          ...options.config,
        };

  const config = loadConfig(overrides);

  const logLines: TestLogLine[] = [];
  const logger = createLogger({
    write: (line: TestLogLine): void => {
      logLines.push(line);
    },
  });

  let stub: StubVisionProvider | null = null;
  let visionProvider: VisionProvider;

  if (options.visionProvider === undefined) {
    stub = new StubVisionProvider({ logger, ...options.stub });
    visionProvider = stub;
  } else {
    visionProvider = options.visionProvider;
  }

  // The production store, over the temporary directory: a suite that saves a document writes real
  // files, so durability, the atomic rename and deletion are exercised rather than simulated.
  const repository = new FileSystemAnalysisRepository({ dataDir: config.dataDir, logger });

  const app = createApp({ config, visionProvider, repository, logger });

  let released: Promise<void> | null = null;

  return {
    app,
    config,
    stub,
    repository,
    // The resolved path the store actually uses, so a caller-supplied relative directory is reported
    // as the absolute one the documents land in.
    dataDir: config.dataDir,
    logLines,
    logEvents(): Array<Record<string, unknown>> {
      return logLines.map(logEventOf);
    },
    newRepository(): FileSystemAnalysisRepository {
      return new FileSystemAnalysisRepository({ dataDir: config.dataDir, logger });
    },
    cleanup(): Promise<void> {
      // One release per app: a second call awaits the first rather than removing a directory twice,
      // and a lease the caller owns is a no-op because its creator still owns it.
      released ??= dir.cleanup();

      return released;
    },
  };
}
