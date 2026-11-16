/**
 * The client's Vite configuration: the dev origin, the single API proxy entry, and the
 * `@trade-read/shared` source alias.
 *
 * Two numbers here are contracts with the rest of the build rather than local preferences. The dev
 * port is the port `CLIENT_DEV_ORIGINS` admits (the server's CORS allowlist) and the port
 * `playwright.config.ts` derives its `baseURL` from, so it may not drift. The proxy prefix covers
 * the API base path, and the proxy target is the only network destination the client may use.
 *
 * Both are overridable from the environment because a checkout that reserves its own port block
 * runs the client and the API on that block: `VITE_PORT` moves the dev server, `VITE_API_TARGET`
 * moves the API origin behind the proxy, and unset they are the documented defaults below. The
 * values are read rather than hard-coded so the client, the orchestrator that announces the URLs
 * (`scripts/dev.mjs`) and the end-to-end `baseURL` cannot end up on three different ports.
 */
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Dev and preview port; must stay the port `CLIENT_DEV_ORIGINS` lists, i.e. 5173. */
const DEFAULT_DEV_PORT = 5173;

/** API origin the server binds with its own `HOST`/`PORT` defaults, i.e. `127.0.0.1:3001`. */
const DEFAULT_API_PROXY_TARGET = 'http://127.0.0.1:3001';

/** Reads an override, treating an unset or blank value as absent. */
function readOverride(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The dev port. A value that is not a real TCP port is refused here rather than silently replaced,
 * because binding an unintended port would leave the browser, the `baseURL` and the CORS allowlist
 * pointing at an origin nothing is serving.
 */
function resolveDevPort(): number {
  const override = readOverride('VITE_PORT');

  if (override === undefined) {
    return DEFAULT_DEV_PORT;
  }

  const port = Number(override);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`VITE_PORT must be an integer between 1 and 65535, received "${override}"`);
  }

  return port;
}

/** Parses an absolute URL, naming the variable that held the invalid value. */
function parseAbsoluteUrl(name: string, raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL, received "${raw}"`);
  }
}

/**
 * The origin the `/api` proxy forwards to. A trailing slash is dropped so it is never joined onto
 * the forwarded request path as a doubled separator.
 */
function resolveApiProxyTarget(): string {
  const override = readOverride('VITE_API_TARGET');

  if (override === undefined) {
    return DEFAULT_API_PROXY_TARGET;
  }

  const { protocol } = parseAbsoluteUrl('VITE_API_TARGET', override);

  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`VITE_API_TARGET must be an http or https URL, received "${override}"`);
  }

  return override.replace(/\/+$/, '');
}

export default defineConfig({
  plugins: [react()],

  // The bundler half of the `@trade-read/shared` mapping that client/tsconfig.json declares in
  // `paths`: dev, build and the type checker all read ../shared/src/index.ts, so the contract,
  // vocabulary, limits and error codes have one implementation rather than a copy. The target is
  // an absolute path resolved from this file's own location, which keeps it correct whatever
  // directory Vite is invoked from.
  resolve: {
    alias: {
      '@trade-read/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },

  // The dev server answers on the origin `CLIENT_DEV_ORIGINS` admits (http://localhost:5173) and on
  // the port `playwright.config.ts` builds its `baseURL` from; `/api` must keep covering the API
  // base path `/api/v1`, and it is the only proxy entry, because the client reaches no other host.
  // `strictPort` turns an occupied port into a loud failure instead of a server drifting to 5174
  // that no browser, test or allowlist entry is pointed at.
  server: {
    port: resolveDevPort(),
    strictPort: true,
    proxy: {
      // Same-origin through the proxy, so the dev browser needs no CORS preflight and no credential,
      // cookie or header is attached to the forwarded request.
      '/api': {
        target: resolveApiProxyTarget(),
        changeOrigin: true,
      },
    },
  },

  // A production preview stays on the origin the allowlist names.
  preview: {
    port: DEFAULT_DEV_PORT,
    strictPort: true,
  },

  // `client/dist` is the artefact the client bundle scan reads: the default relative `base` and the
  // index.html entry stay as they are, and no `define` may inline a value into the bundle.
  build: {
    outDir: 'dist',
    sourcemap: false,
    emptyOutDir: true,
  },
});
