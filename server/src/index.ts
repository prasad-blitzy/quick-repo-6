/**
 * The composition root: the one file that builds the real parts of the server and starts it.
 *
 * Everything the application is made of is constructed here and nowhere else — the configuration is
 * read once, the single logger is created, the model port is chosen from configuration, and the
 * Express application is built around them — so no module below this one decides which provider
 * runs.
 *
 * The server starts with no credential at all. `providerConfigured` is reported and logged as a fact
 * rather than treated as a precondition, because the whole offline surface — health, history,
 * retrieval and deletion — is useful without a key, and a submission without one is answered
 * `503 PROVIDER_NOT_CONFIGURED` rather than taking the process down.
 *
 * The bind address defaults to loopback, so an unauthenticated API is reachable only from the
 * machine running it unless a deployment says otherwise.
 */

import type { Server } from 'node:http';

import { API_BASE_PATH } from '@trade-read/shared';

import { createOpenRouterVisionProvider } from './adapters/openrouter/openrouter-vision-provider.js';
import { createStubVisionProvider } from './adapters/stub/stub-vision-provider.js';
import { createApp } from './app.js';
import { loadConfig, type ServerConfig } from './config/env.js';
import { createLogger, type Logger } from './observability/logger.js';
import type { VisionProvider } from './ports/vision-provider.js';

/**
 * Chooses the model port for this process.
 *
 * `STUB_PROVIDER=1` selects the replay adapter, which answers from the committed recorded envelopes
 * and performs no network I/O; every other configuration gets the OpenRouter adapter, which refuses
 * to call anything at all while no credential is configured.
 */
function buildProvider(config: ServerConfig, logger: Logger): VisionProvider {
  return config.stubProvider
    ? createStubVisionProvider({ logger })
    : createOpenRouterVisionProvider({ config, logger });
}

/** The address the listener actually bound, so the log names the port a request can reach. */
function boundPort(server: Server, configuredPort: number): number {
  const address = server.address();

  return typeof address === 'object' && address !== null ? address.port : configuredPort;
}

/**
 * Starts the server.
 *
 * @returns The listening server, once it is accepting connections.
 */
export function startServer(): Server {
  const config = loadConfig();
  const logger = createLogger();
  const app = createApp({ config, logger, provider: buildProvider(config, logger) });

  const server = app.listen(config.port, config.host, () => {
    const port = boundPort(server, config.port);

    logger.info({
      event: 'server_started',
      host: config.host,
      port,
      providerConfigured: config.providerConfigured,
      model: config.model,
      message: `API listening at http://${config.host}:${String(port)}${API_BASE_PATH}`,
    });
  });

  // A bind that fails — a port already in use, an address this host does not own — is reported on
  // one line, because a server nobody can reach is not a running server.
  server.on('error', (error: Error) => {
    logger.error({
      event: 'server_start_failed',
      host: config.host,
      port: config.port,
      reason: error.name,
      message: error.message,
    });
    process.exitCode = 1;
  });

  return server;
}

startServer();
