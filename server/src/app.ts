/**
 * The Express application: the one place the routes are composed, and the last place a failure can
 * be turned into a response body.
 *
 * The mount order is the contract. The origin allowlist runs first, so a browser on an origin the
 * application does not serve is answered without reaching a route; a JSON body cap is mounted even
 * though no route accepts one, so a future JSON route cannot be added without a bound; the two
 * routers are mounted under the shared API base path; an unmatched path is answered as `NOT_FOUND`
 * in the same body shape as every other failure; and the shared error handler is mounted last, so it
 * sees every rejection — a domain error, a parser error and an unexpected throw alike.
 *
 * The application is built from injected parts: the configuration, the log, the model port and the
 * persistence port all arrive as arguments, so this module opens no connection and holds no global
 * state. `index.ts` is the only caller that builds the real parts.
 */

import express, { type Express } from 'express';

import { API_BASE_PATH, CLIENT_DEV_ORIGINS } from '@trade-read/shared';

import type { ServerConfig } from './config/env.js';
import { createAnalysisService } from './domain/analysis-service.js';
import { AppError } from './domain/errors.js';
import type { Logger } from './observability/logger.js';
import type { AnalysisRepository } from './ports/analysis-repository.js';
import type { VisionProvider } from './ports/vision-provider.js';
import { createAnalysisRouter } from './routes/analysis-routes.js';
import { errorHandler } from './routes/error-handler.js';
import { createHealthRouter } from './routes/health-routes.js';
import { FileSystemAnalysisRepository } from './store/file-system-analysis-repository.js';

/** The JSON body cap. No route accepts a JSON body; the bound keeps one from arriving unbounded. */
const JSON_BODY_LIMIT = '1mb';

/** The path the analysis routes are mounted on, beside the health route under the API base path. */
const ANALYSES_MOUNT_PATH = '/analyses';

/** What building the application needs: configuration, the log and the two ports. */
export interface CreateAppDeps {
  /** The resolved server configuration, read once by the composition root. */
  readonly config: ServerConfig;

  /** The server's single writer, handed to the routes, the service and the store. */
  readonly logger: Logger;

  /** The model port: the production adapter, or the replay adapter when the stub is selected. */
  readonly provider: VisionProvider;

  /**
   * The persistence port. Defaulted to the filesystem store beneath the configured data directory,
   * because that is the only implementation the product ships.
   */
  readonly repository?: AnalysisRepository;
}

/**
 * The origins the browser may call from: the two documented dev origins, plus the port a checkout
 * that reserves its own port block serves the dev client on.
 *
 * The second half is read from the environment here because it belongs to the run rather than to the
 * application: a clone on its own port range serves the client from an origin the fixed list does not
 * name, and the API is loopback-only and unauthenticated, so admitting a loopback origin the run
 * itself declares adds no reach. No pattern, wildcard or credentials are admitted, and an origin that
 * is neither listed nor declared is refused.
 */
function allowedOrigins(): ReadonlySet<string> {
  const origins = new Set<string>(CLIENT_DEV_ORIGINS);
  const declaredPort = process.env['VITE_PORT']?.trim() ?? '';

  if (/^\d{1,5}$/.test(declaredPort)) {
    origins.add(`http://localhost:${declaredPort}`);
    origins.add(`http://127.0.0.1:${declaredPort}`);
  }

  return origins;
}

/**
 * Builds the application.
 *
 * @param deps - The configuration, the log and the two ports.
 * @returns The Express application, ready to listen.
 */
export function createApp(deps: CreateAppDeps): Express {
  const app = express();
  const origins = allowedOrigins();
  const repository =
    deps.repository ??
    new FileSystemAnalysisRepository({ dataDir: deps.config.dataDir, logger: deps.logger });

  // The framework's own advertisement is no part of this application's surface.
  app.disable('x-powered-by');

  app.use((request, response, next) => {
    const origin = request.get('origin');

    if (origin !== undefined && origins.has(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }

    next();
  });

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use(API_BASE_PATH, createHealthRouter({ config: deps.config }));
  app.use(
    `${API_BASE_PATH}${ANALYSES_MOUNT_PATH}`,
    createAnalysisRouter({
      service: createAnalysisService({
        provider: deps.provider,
        repository,
        logger: deps.logger,
        model: deps.config.model,
      }),
      repository,
    }),
  );

  // An unmatched path is a missing resource, answered in the one body shape every failure uses.
  app.use((_request, _response, next) => {
    next(AppError.notFound());
  });

  app.use(errorHandler);

  return app;
}
