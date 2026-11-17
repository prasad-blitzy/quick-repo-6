/**
 * The Express application: the one place the routes are composed, and the last place a failure can
 * be turned into a response body.
 *
 * The mount order is the contract. The origin allowlist runs first, so a cross-origin call only
 * ever learns whether it is admitted; the JSON body cap runs before the routers, so a JSON
 * submission is refused by the parser and answered from the shared error table instead of travelling
 * on unbounded; the two routers are mounted under the shared API base path; and the shared error
 * handler is mounted last, so a domain error, a parser refusal and an unexpected throw all leave
 * through one place as `{ code, message }`. An unmatched path is deliberately left to the
 * framework's own 404: the closed error table has no code for it, so replacing it here would put a
 * second, drifting answer beside the table this build keeps closed.
 *
 * There is no authentication, by design, and the compensating controls are not in this file: the
 * bind address is loopback unless a deployment says otherwise (resolved once in `config/env.ts` and
 * applied by `index.ts`), and the allowlist below admits exactly the two origins the client dev
 * server answers on. It never reflects an arbitrary origin and never admits `*`, so a page this
 * application does not serve cannot read a response.
 *
 * The application is assembled from injected parts — the resolved configuration, the log and the two
 * ports — so this module opens no connection, reads no environment, touches no filesystem and holds
 * no global state. `index.ts` is the only caller that builds the real parts.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import { API_BASE_PATH, CLIENT_DEV_ORIGINS } from '@trade-read/shared';

import type { ServerConfig } from './config/env.js';
import { createAnalysisService } from './domain/analysis-service.js';
import type { Logger } from './observability/logger.js';
import type { AnalysisRepository } from './ports/analysis-repository.js';
import type { VisionProvider } from './ports/vision-provider.js';
import { createAnalysisRouter } from './routes/analysis-routes.js';
import { errorHandler } from './routes/error-handler.js';
import { createHealthRouter } from './routes/health-routes.js';

/**
 * The cap on a JSON request body.
 *
 * No route accepts a JSON body, so this bound exists for the one case it can still serve: a
 * submission posted as JSON carries no image file, and the parser's payload-too-large refusal is
 * answered `400 NO_IMAGES` by `routes/error-handler.ts` — the same row an empty submission takes.
 * Without the parser mounted, such a body would reach multer, which parses no multipart part and
 * leaves the route to answer from an empty file list anyway; the cap is what bounds the bytes read
 * before that happens.
 */
const JSON_BODY_LIMIT = '1mb';

/**
 * The path segment the analysis routes sit on, inside the shared API base path.
 *
 * The analysis router declares its paths relative to its mount point, so the base path itself comes
 * from the shared package and only this one segment is named here.
 */
const ANALYSES_MOUNT_PATH = '/analyses';

/** The methods a browser is told it may use on an admitted origin. */
const ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS';

/** The one request header a browser is told it may send: multipart submissions carry no other. */
const ALLOWED_HEADERS = 'Content-Type';

/**
 * The origins a browser may call from, built once from the shared list.
 *
 * Membership is tested with `has` rather than `includes` because the shared constant is a literal
 * tuple: a `ReadonlySet<string>` widens it to the plain comparison the header allows, without a cast
 * and without restating an origin here.
 */
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set<string>(CLIENT_DEV_ORIGINS);

/** The status a preflight request is answered with, whether or not its origin is admitted. */
const PREFLIGHT_NO_CONTENT = 204;

/**
 * Everything building the application needs: the resolved configuration, the log, and the two ports
 * every effect crosses.
 *
 * Both ports are injected rather than constructed here, so this module stays a composition of parts
 * it did not build: the model boundary and the persistence boundary each have one production
 * implementation, chosen by the composition root, and neither is visible from the other.
 */
export interface AppDependencies {
  /** The configuration, loaded once by the composition root; this file reads no environment. */
  readonly config: ServerConfig;

  /** The model port: the OpenRouter adapter, or the replay adapter when the stub is selected. */
  readonly visionProvider: VisionProvider;

  /** The persistence port: the store the routes and the domain service both write and read. */
  readonly repository: AnalysisRepository;

  /** The server's single writer, handed to the routes, the domain service and the store. */
  readonly logger: Logger;
}

/**
 * Answer the cross-origin headers for one request, and end a preflight.
 *
 * The allowlist is the shared `CLIENT_DEV_ORIGINS` and nothing else: an origin is echoed only when
 * it is a member, so a foreign origin is answered with no allow header at all and the browser
 * refuses the response. The absence of an `Origin` — a same-origin call, `curl`, `supertest` — is
 * not a refusal and needs no header, so the request simply continues.
 *
 * A preflight is answered `204` in both cases, because declining to advertise an origin is the
 * whole refusal: the closed error table defines no code for a disallowed origin, so this is not
 * turned into an error response.
 *
 * @param request - The incoming request, read only for its `Origin` header and its method.
 * @param response - The response the allow headers are set on.
 * @param next - The chain's continuation for a request that is not a preflight.
 */
function allowListedOrigin(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const origin = request.headers.origin;

  if (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    response.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  }

  if (request.method === 'OPTIONS') {
    response.status(PREFLIGHT_NO_CONTENT).end();
    return;
  }

  next();
}

/**
 * Builds the application.
 *
 * The returned application is a value, not a running server: nothing here binds a socket, so the
 * composition root decides the address and the suites can drive the routes without one.
 *
 * @param deps - The configuration, the two ports and the log.
 * @returns The Express application, ready to listen.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();

  // The framework's own advertisement is no part of this application's surface.
  app.disable('x-powered-by');

  // First, so no route is reached by an origin this application does not serve.
  app.use(allowListedOrigin);

  // Before the routers: a JSON submission is refused here, and the refusal is a `400 NO_IMAGES`
  // through the shared error handler rather than a body read without a bound.
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // The service is composed inside the application because it is the only orchestrator: the routes
  // and the reads below it share one instance, and the ports and the log are its only inputs.
  const analysisService = createAnalysisService({
    provider: deps.visionProvider,
    repository: deps.repository,
    logger: deps.logger,
    model: deps.config.model,
  });

  // The analysis routes also hold the persistence port, for the reads and the delete that bypass
  // the service: a stored document, the history page, the retained image bytes and a removal.
  app.use(
    `${API_BASE_PATH}${ANALYSES_MOUNT_PATH}`,
    createAnalysisRouter({ service: analysisService, repository: deps.repository }),
  );

  // Health reports configuration and nothing else, so it answers whether or not a model credential
  // is configured and never depends on the network.
  app.use(API_BASE_PATH, createHealthRouter({ config: deps.config }));

  // Last, and the only writer of an error body in the application.
  app.use(errorHandler);

  return app;
}
