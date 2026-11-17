/**
 * The composition root: the one file that builds the real parts of the server and starts it.
 *
 * Everything the application is made of is assembled here and nowhere else — the configuration is
 * read once, the single logger is created, the model port is chosen from configuration, the store is
 * placed beneath the configured data directory, and the Express application is built around them —
 * so no module below this one decides which provider runs, where state is written, or which address
 * is bound. `createApp` receives the parts as ports it did not build; this file is its only caller
 * that supplies the production implementations.
 *
 * The server starts with no credential at all. `providerConfigured` is reported as a fact rather
 * than treated as a precondition, because the whole offline surface — health, history, retrieval and
 * deletion — is useful without a key, and a submission without one is answered
 * `503 PROVIDER_NOT_CONFIGURED` by the adapter rather than taking the process down here.
 *
 * The bind address defaults to loopback in `config/env.ts`, which is a compensating control rather
 * than an accident: the API is unauthenticated, so it is reachable from the machine running it only
 * unless a deployment sets `HOST` explicitly. No authentication is added here or anywhere else.
 *
 * Importing this module does nothing: it defines the boot function and compares this file's URL with
 * the process's entry path, so the suites can import it without a socket opening, an environment
 * value being read or a line being logged.
 */

import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';

import type { Express } from 'express';

import { createOpenRouterVisionProvider } from './adapters/openrouter/openrouter-vision-provider.js';
import { createStubVisionProvider } from './adapters/stub/stub-vision-provider.js';
import { createApp } from './app.js';
import { loadConfig, type ServerConfig } from './config/env.js';
import { createLogger, type Logger } from './observability/logger.js';
import type { AnalysisRepository } from './ports/analysis-repository.js';
import type { VisionProvider } from './ports/vision-provider.js';
import { FileSystemAnalysisRepository } from './store/file-system-analysis-repository.js';

/**
 * The environment values a caller may pin instead of the process environment.
 *
 * The type is derived from `loadConfig`'s own parameter rather than restated, so the closed set of
 * variable names — and the rule that an explicitly `undefined` value means "treat as unset" — stays
 * owned by `config/env.ts`, the build's only reader of the process environment. A suite uses this to
 * point the store at a temporary directory and ask the operating system for an ephemeral port
 * without mutating the environment its own process shares with every other suite.
 */
export type BootstrapOverrides = Parameters<typeof loadConfig>[0];

/** The address a bootstrapped server actually answers on. */
export interface BoundAddress {
  /** The configured bind host; loopback unless a deployment sets `HOST`. */
  readonly host: string;

  /**
   * The port the listener bound.
   *
   * The configured port in every normal start, and the port the operating system assigned when
   * `PORT` was `0`, which is why it is read back from the listener rather than echoed from
   * configuration.
   */
  readonly port: number;
}

/**
 * A started server and the parts it was built from.
 *
 * Returned rather than kept private so a caller can drive the application without a socket
 * (`app`), report the address a request can reach (`address`), shut the listener down
 * (`httpServer`), and read back the configuration the process resolved (`config`).
 */
export interface BootstrappedServer {
  /** The Express application, the same value `createApp` returned. */
  readonly app: Express;

  /** The HTTP listener, already accepting connections when this value is handed over. */
  readonly httpServer: Server;

  /** The configuration this process resolved, including whether a model credential is present. */
  readonly config: ServerConfig;

  /** The bound address, for logging and for a caller that has to reach the server. */
  readonly address: BoundAddress;
}

/**
 * Chooses the model port for this process.
 *
 * `STUB_PROVIDER=1` selects the replay adapter, which answers from the committed recorded envelopes
 * and performs no network I/O; every other configuration gets the OpenRouter adapter, which carries
 * the credential and refuses to call anything at all while none is configured. Configuration is the
 * only input to the decision — never an inspection of the key, never a second flag, never a
 * reach into the environment — so exactly one place in the build decides which implementation of
 * the port exists.
 *
 * The slug is passed to the replay adapter too, so a captured call reports the model the process is
 * actually configured with instead of the adapter's own default.
 *
 * @param config - The resolved configuration, read for `stubProvider` and the slug.
 * @param logger - The server's single writer, handed to whichever adapter is built.
 * @returns The model boundary backed by the configured provider.
 */
function selectVisionProvider(config: ServerConfig, logger: Logger): VisionProvider {
  return config.stubProvider
    ? createStubVisionProvider({ logger, model: config.model })
    : createOpenRouterVisionProvider({ config, logger });
}

/**
 * Resolves once the listener is accepting connections.
 *
 * A bind that fails — a port another process holds, an address this host does not own — arrives as
 * an `error` event rather than a rejected call, so it is turned into a rejection here and the start
 * is reported once, by the caller, instead of escaping as an unhandled event on the next tick.
 * Both one-shot listeners are removed before this settles, so the permanent error handler the caller
 * attaches afterwards is the only one left on the listener.
 *
 * @param httpServer - The listener returned by `listen`, not yet known to be bound.
 * @returns A promise that settles when the bind succeeds or fails.
 */
function awaitListening(httpServer: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const listening = (): void => {
      httpServer.off('error', failed);
      resolve();
    };

    const failed = (error: Error): void => {
      httpServer.off('listening', listening);
      reject(error);
    };

    httpServer.once('listening', listening);
    httpServer.once('error', failed);
  });
}

/**
 * Reads the address the listener actually bound.
 *
 * `Server.address()` is a string for a pipe or a Unix socket, an `AddressInfo` object for an IP
 * socket, and `null` before the bind completes; only the object form can occur here, since a TCP
 * port was requested. The configured host is reported rather than the resolved IP so the log names
 * the address an operator asked for, while the port is the one the operating system granted — the
 * distinction that makes `PORT=0` observable.
 *
 * @param httpServer - The listener, already bound.
 * @param config - The resolved configuration, for the configured host and port.
 * @returns The host and the actual port.
 */
function boundAddress(httpServer: Server, config: ServerConfig): BoundAddress {
  const address = httpServer.address();

  return {
    host: config.host,
    port: typeof address === 'object' && address !== null ? address.port : config.port,
  };
}

/**
 * Builds the server and starts listening.
 *
 * The order is the contract: configuration, then the log, then the two port implementations, then
 * the application composed around them, then the bind. Nothing is created on disk here — the
 * repository creates its directories on the first write, so a server whose data directory does not
 * exist yet starts and answers health and an empty history all the same.
 *
 * Exactly one line is logged once the listener is up, carrying the bound address, the configured
 * slug and whether a credential is present. The credential itself, the attribution values and every
 * request and response body stay out of it, because the logger's field set cannot hold them and this
 * call passes only the fields below.
 *
 * @param overrides - Values that take precedence over the process environment, for a suite that has
 *   to isolate its store, its port and its provider without mutating the environment its own process
 *   shares with its siblings.
 * @returns The listening server and the parts it was built from.
 */
export async function bootstrap(overrides?: BootstrapOverrides): Promise<BootstrappedServer> {
  const config = loadConfig(overrides);
  const logger = createLogger();

  const repository: AnalysisRepository = new FileSystemAnalysisRepository({
    dataDir: config.dataDir,
    logger,
  });

  const visionProvider = selectVisionProvider(config, logger);

  const app = createApp({ config, logger, visionProvider, repository });

  const httpServer = app.listen(config.port, config.host);

  await awaitListening(httpServer);

  const address = boundAddress(httpServer, config);

  logger.info({
    event: 'server_started',
    host: address.host,
    port: address.port,
    providerConfigured: config.providerConfigured,
    model: config.model,
  });

  // A listener that fails after it bound — the socket this process owns going away, a descriptor
  // exhausted — leaves a server nobody can reach, so it is reported on one line and the process is
  // left to exit non-zero rather than continuing as if it were serving.
  httpServer.on('error', (error: Error) => {
    logger.error({
      event: 'server_error',
      host: address.host,
      port: address.port,
      reason: error.name,
      message: error.message,
    });

    process.exitCode = 1;
  });

  return { app, httpServer, config, address };
}

/**
 * Whether this module is the process's entry point.
 *
 * `node server/dist/index.js` and `npm run start -w @trade-read/server` both put the module's path in
 * `process.argv[1]`, which compares equal to this module's own URL; an import from a suite, from
 * `node -e` or from any other module does not. That comparison is what keeps the start a deliberate
 * act instead of an import side effect.
 *
 * @returns `true` only when this file was invoked directly.
 */
function isProcessEntry(): boolean {
  const invokedPath = process.argv[1];

  return invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href;
}

/**
 * Reports a start that failed before the server could serve.
 *
 * A port another process holds or an address this host does not own arrives here as a rejection from
 * the bind, as does any failure raised while the parts are constructed. It is logged once, at
 * `error`, and the process is given a non-zero exit code so a supervising shell sees the failure;
 * nothing is retried and nothing is served, because a server that did not bind is not a running
 * server.
 *
 * @param error - The rejection value, which is an `Error` for every failure this path produces.
 */
function reportStartFailure(error: unknown): void {
  createLogger().error({
    event: 'server_start_failed',
    reason: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });

  process.exitCode = 1;
}

if (isProcessEntry()) {
  void bootstrap().catch(reportStartFailure);
}
