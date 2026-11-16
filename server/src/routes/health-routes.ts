import { Router } from 'express';

import type { HealthResponse } from '@trade-read/shared';

import type { ServerConfig } from '../config/env.js';

/**
 * The health route.
 *
 * `GET /health` echoes configuration and nothing else: it reports that the process is up, whether a
 * model credential is configured, and the configured model slug. It performs no provider call, so the
 * endpoint never depends on the network: this is what lets the whole offline suite run with no
 * credential and no egress, and it keeps `providerConfigured: false` a state the client can render as
 * "provider not configured" instead of a failed request.
 *
 * The body is the shared `HealthResponse` and carries no field beyond it. The credential, any prefix
 * of it, the provider base URL and every header stay out of the response: the boolean is the only fact
 * the client ever learns about the key.
 *
 * `app.ts` mounts this router at `API_BASE_PATH`, so the path declared below is relative to that mount
 * point and must never repeat the prefix.
 */

/** What the health router needs. Configuration is injected, so this module reads no environment. */
export interface HealthRouterDeps {
  /** The resolved server configuration, loaded once by the composition root. */
  readonly config: ServerConfig;
}

/**
 * Builds the health router.
 *
 * The handler is synchronous and reads nothing but the injected configuration — no port, no store and
 * no network — so it cannot fail while the process is up and needs no error path.
 *
 * @param deps - The resolved configuration to echo, including the derived key-presence boolean.
 * @returns A router serving `GET /health` relative to the mount point `app.ts` chooses.
 */
export function createHealthRouter(deps: HealthRouterDeps): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const body = {
      status: 'ok',
      providerConfigured: deps.config.providerConfigured,
      model: deps.config.model,
    } satisfies HealthResponse;

    res.status(200).json(body);
  });

  return router;
}
